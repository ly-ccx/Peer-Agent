use super::*;
use peer_store::{GoalPublication, OrdinaryGoalDraft};

pub(super) const CAPABILITY: &str = "local.goal.create_plan";

pub(super) struct CreateGoal {
    args: Value,
    draft: Result<OrdinaryGoalDraft, HostError>,
    home: PathBuf,
    workspace: PathBuf,
    kind: OrdinaryGoalKind,
    admission: Option<EffectAdmission>,
}

impl CreateGoal {
    pub(super) fn prepare(
        args: Value,
        workspace: &Path,
        home: &Path,
        kind: OrdinaryGoalKind,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if !args.is_object() {
            return Err(HostError("tool_arguments_invalid"));
        }
        let draft = OrdinaryGoalDraft::parse(&args, workspace).map_err(HostError::from);
        Ok(Box::new(Self {
            args,
            draft,
            home: home.into(),
            workspace: workspace.into(),
            kind,
            admission: None,
        }))
    }
}

impl PreparedEffect for CreateGoal {
    fn admission(&mut self, port: EffectAdmission) {
        self.admission = Some(port);
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::ConversationGoal
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        mut self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .admission
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        let projector = TuiGoalProjector::new(call.started_at()).map_err(HostError)?;
        let Self {
            draft,
            home,
            workspace,
            kind,
            ..
        } = *self;
        Ok(Box::pin(async move {
            let draft = match draft {
                Ok(draft) => draft,
                Err(error) => return EffectOutcome::not_dispatched(error.0),
            };
            let Some(plan_id) = call
                .tool_call_id()
                .strip_prefix("call-")
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .map(str::to_owned)
            else {
                return EffectOutcome::not_dispatched("execution_identity_invalid");
            };
            if let Err(error) = port.check().await {
                return EffectOutcome::not_dispatched(error.0);
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let flag = cancelled.clone();
            let runtime = tokio::runtime::Handle::current();
            let mut worker = tokio::task::spawn_blocking(move || {
                GoalStore::new(home).publish_ordinary_goal(
                    &draft,
                    GoalPublication {
                        plan_id: &plan_id,
                        conversation: call.conversation_id(),
                        workspace: &workspace,
                        kind,
                        at: call.started_at(),
                    },
                    &projector,
                    Some(&flag),
                    || runtime.block_on(port.check()).map_err(|error| error.0),
                )
            });
            let observed = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    cancelled.store(true, Ordering::Release);
                    worker.await
                }
                outcome = &mut worker => outcome,
            };
            match observed {
                Ok(Ok(output)) => EffectOutcome {
                    status: "success",
                    output,
                    error: None,
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                },
                Ok(Err(peer_store::GoalError::Store(StoreError::CommitUncertain))) | Err(_) => {
                    EffectOutcome::failed("execution_outcome_unknown")
                }
                Ok(Err(peer_store::GoalError::Store(StoreError::Cancelled))) => {
                    EffectOutcome::not_dispatched("CANCELLED")
                }
                Ok(Err(error)) => EffectOutcome::not_dispatched(error.code()),
            }
        }))
    }
}
