use super::*;
use peer_store::{GoalPublication, OrdinaryGoalDraft};

pub(crate) const CAPABILITY: &str = "local.goal.create_plan";

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
        let Self {
            draft,
            home,
            workspace,
            kind,
            ..
        } = *self;
        goal_mutation(port, call, cancel, move |call, projector, flag, admit| {
            let draft = draft.map_err(|error| GoalError::Projection(error.0))?;
            let plan_id = call
                .tool_call_id()
                .strip_prefix("call-")
                .filter(|id| uuid::Uuid::parse_str(id).is_ok())
                .ok_or(GoalError::Projection("execution_identity_invalid"))?;
            GoalStore::new(home).publish_ordinary_goal(
                &draft,
                GoalPublication {
                    plan_id,
                    conversation: call.conversation_id(),
                    workspace: &workspace,
                    kind,
                    at: call.started_at(),
                },
                projector,
                Some(flag),
                admit,
            )
        })
    }
}
