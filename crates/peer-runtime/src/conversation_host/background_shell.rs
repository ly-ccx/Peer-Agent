//! A published Shell startup remains owned by the original ordinary execution.
use super::*;
use crate::{
    live_execution::{HandleStop, LiveError},
    providers::{EffectFuture, EffectOutcome},
};
use peer_protocol::{NativeOwnedProcess, NativeProcessState};

const MAX_BACKGROUND_SHELLS: usize = 32;

pub(super) struct BackgroundShell {
    args: Value,
    grant: permission::ToolGrant,
    cancel: CancellationToken,
    _cancel_if_host_drops: tokio_util::sync::DropGuard,
    completion: Completion,
    startup_committed: bool,
}

enum Completion {
    Waiting(EffectFuture),
    Observed(EffectOutcome),
}

impl Host<'_> {
    pub(super) fn can_start_background_shell(&self) -> bool {
        self.background_shells.len() + self.completed_shells.len() < MAX_BACKGROUND_SHELLS
    }

    pub(super) fn verify_background_start(
        &self,
        process: &NativeOwnedProcess,
        observation: &EffectOutcome,
    ) -> Result<(), HostError> {
        let expected_artifact = format!("local-shell-artifact://{}", process.handle_id);
        if process.state != NativeProcessState::Running
            || process.child.is_none()
            || process.owner != *self.run.owner()
            || !process.valid_conversation(&self.identity)
            || observation.status != "success"
            || observation.ended
            || observation.output["toolCallId"] != process.tool_call_id
            || observation.output["taskId"] != process.handle_id
            || observation.output["status"] != "running"
            || observation.output["artifactRef"] != expected_artifact
        {
            return Err(HostError("shell_background_start_unproven"));
        }
        Ok(())
    }

    pub(super) fn track_background_shell(
        &mut self,
        handle: String,
        grant: permission::ToolGrant,
        args: Value,
        cancel: CancellationToken,
        completion: EffectFuture,
    ) {
        self.background_shells.insert(
            handle,
            BackgroundShell {
                args,
                grant,
                _cancel_if_host_drops: cancel.clone().drop_guard(),
                cancel,
                completion: Completion::Waiting(completion),
                startup_committed: false,
            },
        );
    }

    pub(super) fn acknowledge_background_start(&mut self, call: &str) -> Result<(), HostError> {
        let running = self
            .background_shells
            .values_mut()
            .find(|running| running.grant.call == call)
            .ok_or(HostError("shell_background_start_unproven"))?;
        running.startup_committed = true;
        Ok(())
    }

    pub(super) fn check_background_shells(&self) {
        if self.background_shells.is_empty() {
            return;
        }
        let current = match &self.cognition_source {
            Some(source) => self.source_matches(&source.revision, source.content_revision),
            None => self.source_current(),
        };
        for running in self.background_shells.values() {
            if !running.cancel.is_cancelled()
                && (current.is_err()
                    || self
                        .validate_grant_binding(&running.grant, &running.args)
                        .is_err())
            {
                running.cancel.cancel();
            }
        }
    }

    pub(super) async fn reap_background_shells(&mut self, advance: bool) -> Result<(), HostError> {
        if self.background_shells.is_empty() {
            return Ok(());
        }
        let observations = self
            .live
            .handle_observations(&self.identity)
            .map_err(|_| HostError("native_execution_stop_unproven"))?;
        for (handle, call, state) in observations {
            if state != "ended" {
                continue;
            }
            let Some(running) = self.background_shells.get_mut(&handle) else {
                continue;
            };
            if call != running.grant.call {
                return Err(HostError("native_execution_stop_unproven"));
            }
            // An ended registry entry requires the same worker's returned
            // outcome. The worker delivers it before dropping the guard.
            if let Completion::Waiting(future) = &mut running.completion {
                running.completion = Completion::Observed(future.await);
            }
            let Completion::Observed(outcome) = &running.completion else {
                return Err(HostError("native_execution_stop_unproven"));
            };
            let may_settle = running.startup_committed
                && outcome.ended
                && outcome.error != Some("execution_outcome_unknown");
            self.record_command_end(&call, advance)?;
            let receipt = if may_settle {
                let message = self
                    .store
                    .read_conversation_execution(&self.identity.conversation_id)?
                    .and_then(|run| {
                        run.pending_tools
                            .into_iter()
                            .find(|tool| tool.tool_call_id == call)
                    })
                    .ok_or(HostError("conversation_execution_changed"))?
                    .message_id;
                self.store
                    .settle_conversation_tool(&mut self.run, &call, &message, &now())?
            } else {
                // The process can be cleaned up even when the original
                // effect or its canonical startup result remains unresolved.
                self.store
                    .end_conversation_handle(&mut self.run, &handle, &now())?
            };
            self.live
                .acknowledge_ended_handle(&self.identity, &handle)
                .map_err(|_| HostError("native_execution_stop_unproven"))?;
            let Some(BackgroundShell {
                completion: Completion::Observed(mut outcome),
                ..
            }) = self.background_shells.remove(&handle)
            else {
                return Err(HostError("native_execution_stop_unproven"));
            };
            outcome.output["toolCallId"] = json!(call);
            self.completed_shells.insert(handle, outcome);
            if advance {
                self.factual_publication(receipt)?;
            }
        }
        Ok(())
    }

    pub(super) async fn stop_background_shell(
        &mut self,
        handle: &str,
        grant: &permission::ToolGrant,
        args: &Value,
    ) -> Result<EffectOutcome, HostError> {
        self.reap_background_shells(true).await?;
        self.validate_grant(grant, args)?;
        let mut stopped = false;
        if let Some(running) = self.background_shells.get(handle) {
            let call = running.grant.call.clone();
            let live = self.live.clone();
            let identity = self.identity.clone();
            let target = handle.to_owned();
            let stop = self
                .wait_owned(async move {
                    live.stop_owned_handle(&identity, &target, &call, Duration::from_secs(4))
                        .await
                })
                .await
                .map_err(|_| HostError("execution_outcome_unknown"))?;
            match stop {
                Ok(observation) => stopped = observation == HandleStop::Stopped,
                Err(LiveError::StopUnconfirmed) => {
                    return Err(HostError("execution_outcome_unknown"));
                }
                Err(_) => return Err(HostError("shell_task_not_found")),
            }
            self.reap_background_shells(true)
                .await
                .map_err(|_| HostError("execution_outcome_unknown"))?;
        }
        let Some(outcome) = self.completed_shells.get(handle) else {
            let mut missing = EffectOutcome::not_dispatched("shell_task_not_found");
            missing.output = json!({"taskId":handle, "found":false, "stopped":false});
            return Ok(missing);
        };
        if outcome.error == Some("execution_outcome_unknown") {
            return Err(HostError("execution_outcome_unknown"));
        }
        let reason = if stopped {
            args["reason"]
                .as_str()
                .map(str::trim)
                .filter(|reason| !reason.is_empty())
                .unwrap_or("cancelled")
        } else {
            "already_ended"
        };
        let status = match (outcome.status, outcome.output["timedOut"].as_bool()) {
            ("success", _) => "completed",
            (_, Some(true)) => "timeout",
            (status, _) => status,
        };
        Ok(EffectOutcome {
            status: "success",
            output: json!({
                "taskId":handle, "stopped":stopped, "status":status, "reason":reason,
                "originalToolCallId":outcome.output["toolCallId"],
                "artifactRef":format!("local-shell-artifact://{handle}"), "artifactRefs":outcome.artifacts,
                "task":outcome.output,
            }),
            error: None,
            artifacts: outcome.artifacts.clone(),
            ended: true,
            materialization: None,
            not_dispatched: false,
        })
    }
}
