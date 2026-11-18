//! Ordinary model access to the current Conversation's Goal read model.
use super::*;
use crate::goal_facts::TuiGoalProjector;
use peer_protocol::javascript_trim;
use peer_store::{GoalStore, StoreError};
use std::sync::atomic::{AtomicBool, Ordering};

const ALIAS: &str = "goal_get_plan";
const CAPABILITY: &str = "local.goal.get_plan";
pub(super) struct GoalReadProvider;

struct ReadGoal {
    args: Value,
    plan_id: Option<String>,
    home: PathBuf,
    admission: Option<EffectAdmission>,
}

impl CapabilityProvider for GoalReadProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/goal-read-tool.json"
        ))
        .expect("compiled Goal read manifest");
        vec![(ALIAS.into(), fixture["manifest"].clone())]
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
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
