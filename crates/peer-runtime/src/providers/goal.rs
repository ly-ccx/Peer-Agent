//! Ordinary model access to the current Conversation's Goal read model.
use super::*;
use crate::goal_facts::TuiGoalProjector;
use peer_protocol::javascript_trim;
use peer_store::{GoalError, GoalStore, GoalTaskPublication, OrdinaryGoalKind, StoreError};
use std::sync::atomic::{AtomicBool, Ordering};

mod create;
pub(crate) mod explorer;
pub(crate) use create::CAPABILITY as CREATE_CAPABILITY;

const ALIAS: &str = "goal_get_plan";
const CAPABILITY: &str = "local.goal.get_plan";
pub(super) struct GoalProvider(pub(super) RuntimeMode);

struct ReadGoal {
    args: Value,
    plan_id: Option<String>,
    home: PathBuf,
    admission: Option<EffectAdmission>,
}

struct UpdateGoal {
    args: Value,
    home: PathBuf,
    workspace: PathBuf,
    admission: Option<EffectAdmission>,
}

impl CapabilityProvider for GoalProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/goal-read-tool.json"
        ))
        .expect("compiled Goal read manifest");
        vec![
            (ALIAS.into(), fixture["manifest"].clone()),
            ("goal_create_plan".into(), fixture["createManifest"].clone()),
            ("goal_update_task".into(), fixture["updateManifest"].clone()),
            (
                "request_explorer".into(),
                fixture["explorerManifest"].clone(),
            ),
        ]
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability == create::CAPABILITY {
            let kind = match self.0 {
                RuntimeMode::Chat => OrdinaryGoalKind::Chat,
                RuntimeMode::Plan => OrdinaryGoalKind::Plan,
                RuntimeMode::Goal => OrdinaryGoalKind::SelfDriven,
                _ => return Err(HostError("tool_not_projected")),
            };
            return create::CreateGoal::prepare(args, workspace, home, kind);
        }
        if capability == "local.goal.update_task" {
            if !args.is_object() {
                return Err(HostError("tool_arguments_invalid"));
            }
            return Ok(Box::new(UpdateGoal {
                args,
                home: home.into(),
                workspace: workspace.into(),
                admission: None,
            }));
        }
        if capability == explorer::CAPABILITY {
            return Ok(explorer::RegisterExplorer::prepare(args));
        }
        if capability != CAPABILITY {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(&args, &["planId"])?;
        let plan_id = args
            .get("planId")
            .map(|id| id.as_str().ok_or(HostError("tool_arguments_invalid")))
            .transpose()?
            .map(javascript_trim)
            .filter(|id| !id.is_empty())
            .map(str::to_owned);
        Ok(Box::new(ReadGoal {
            args,
            plan_id,
            home: home.into(),
            admission: None,
        }))
    }
}

impl PreparedEffect for UpdateGoal {
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
        goal_mutation(port, call, cancel, move |call, projector, flag, admit| {
            GoalStore::new(self.home).publish_ordinary_task_change(
                &self.args,
                GoalTaskPublication {
                    conversation: call.conversation_id(),
                    workspace: &self.workspace,
                    tool_call_id: call.tool_call_id(),
                    at: call.started_at(),
                    runner: call.goal_runner.as_ref(),
                },
                projector,
                Some(flag),
                admit,
            )
        })
    }
}

fn goal_mutation(
    port: EffectAdmission,
    call: ProviderCall,
    cancel: CancellationToken,
    publish: impl FnOnce(
        &ProviderCall,
        &TuiGoalProjector,
        &AtomicBool,
        &dyn Fn() -> Result<(), &'static str>,
    ) -> Result<Value, GoalError>
    + Send
    + 'static,
) -> Result<EffectFuture, HostError> {
    let projector = TuiGoalProjector::new(call.started_at()).map_err(HostError)?;
    Ok(Box::pin(async move {
        if let Err(error) = port.check().await {
            return EffectOutcome::not_dispatched(error.0);
        }
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = cancelled.clone();
        let runtime = tokio::runtime::Handle::current();
        let mut worker = tokio::task::spawn_blocking(move || {
            publish(&call, &projector, &flag, &|| {
                runtime.block_on(port.check()).map_err(|error| error.0)
            })
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
            Ok(Err(GoalError::Store(StoreError::CommitUncertain))) | Err(_) => {
                EffectOutcome::failed("execution_outcome_unknown")
            }
            Ok(Err(GoalError::Store(StoreError::Cancelled))) => {
                EffectOutcome::not_dispatched("CANCELLED")
            }
            Ok(Err(error)) => EffectOutcome::not_dispatched(error.code()),
        }
    }))
}

impl PreparedEffect for ReadGoal {
    fn admission(&mut self, port: EffectAdmission) {
        self.admission = Some(port);
    }

    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
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
        Ok(Box::pin(async move {
            if let Err(error) = port.check().await {
                return EffectOutcome::not_dispatched(error.0);
            }
            let cancelled = Arc::new(AtomicBool::new(false));
            let flag = cancelled.clone();
            let mut worker = tokio::task::spawn_blocking(move || {
                GoalStore::new(self.home).read_tool_view(
                    call.conversation_id(),
                    self.plan_id.as_deref(),
                    &projector,
                    Some(&flag),
                )
            });
            let outcome = tokio::select! {
                biased;
                _ = cancel.cancelled() => {
                    cancelled.store(true, Ordering::Release);
                    let _ = worker.await;
                    return EffectOutcome::not_dispatched("CANCELLED");
                }
                outcome = &mut worker => outcome,
            };
            match outcome {
                Ok(Ok(output)) => {
                    if let Err(error) = port.check().await {
                        return EffectOutcome::not_dispatched(error.0);
                    }
                    EffectOutcome {
                        status: "success",
                        output,
                        error: None,
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: false,
                    }
                }
                Ok(Err(peer_store::GoalError::Store(StoreError::Cancelled))) => {
                    EffectOutcome::not_dispatched("CANCELLED")
                }
                Ok(Err(error)) => EffectOutcome::failed(error.code()),
                Err(_) => EffectOutcome::failed("goal_read_unavailable"),
            }
        }))
    }
}
