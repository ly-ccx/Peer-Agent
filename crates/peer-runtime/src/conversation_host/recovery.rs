//! Management recovery over the original ordinary execution. No model, tool
//! dispatch, provider discovery or credential loading is admitted here.
use super::*;
use crate::{live_execution::Ownership, recorder};
use peer_protocol::{ConversationExecution, NativeProcessState as Process, NativeProcessStop};
use peer_store::{ConversationRecovery, EvidenceIndexStore, HostToolEvidence};
use std::time::Instant;

impl NativeConversationRuntime {
    pub async fn recover(
        &self,
        conversation: &str,
        cancel: &CancellationToken,
    ) -> Result<ConversationExecution, HostError> {
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let deadline = Instant::now() + Duration::from_secs(15);
        let store = ConversationStore::new(&self.home);
        let mut guard = store.try_conversation_recovery(conversation)?;
        #[cfg(feature = "test-fixtures")]
        if self.home.join(".native-cli-fixture").is_file()
            && std::env::var("PEER_NATIVE_ORDINARY_FAULT").as_deref() == Ok("hold_recovery")
        {
            std::fs::write(self.home.join("recovery-ready"), "guard acquired")
                .map_err(|_| HostError("fixture_unavailable"))?;
            loop {
                control(cancel, deadline)?;
                if self.home.join("recovery-release").exists() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        }
        let initial = guard.current(&store)?;
        if initial.engine != "peer-native" {
            return Err(HostError("native_execution_owner_unknown"));
        }
        // A canonical stop can repair billing after the old foreground ended,
        // even if its enclosing Host process is alive serving another stream.
        if initial.stop.is_some() {
            if !initial.handles.is_empty()
                || initial.pending_tools.iter().any(|p| {
                    p.native_process
                        .as_ref()
                        .is_some_and(|p| p.state != Process::Ended)
                })
            {
                return Err(HostError("native_execution_stop_unproven"));
            }
            self.cancel_prepared(&store, &mut guard, &initial, cancel, deadline)
                .await?;
            self.settle_confirmed(&store, &mut guard, cancel, deadline)
                .await?;
            guard.commit_usage(&store, &now())?;
            return Ok(guard.current(&store)?);
        }
        if self.live.ownership(&initial.identity).ok() == Some(Ownership::Live) {
            return Err(HostError("native_execution_owner_live"));
        }
        let proof = recorder::prove(&initial.owner).await;
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if !proof.allows_settlement() {
            return Err(HostError(if proof == recorder::RecorderProof::Alive {
                "native_execution_owner_live"
            } else {
                "native_execution_owner_unknown"
            }));
        }
        guard.close_admission(&store, &now())?;
        // Cognition ended with its original owner. Known fees are accountable
        // even if a separate child cannot be proved stopped. This ack does not
        // clear any pending tool, handle, unknown outcome or permission.
        guard.commit_usage(&store, &now())?;
        for pending in &initial.pending_tools {
            tokio::task::yield_now().await;
            control(cancel, deadline)?;
            guard.current(&store)?;
            let Some(process) = &pending.native_process else {
                continue;
            };
            let observation = match process.state {
                Process::NotStarted => Some(NativeProcessStop::OwnerDeadNotStarted),
                Process::Running => {
                    let Some(child) = &process.child else {
                        continue;
                    };
                    recorder::stop_recorded_group(&initial.owner, child, cancel)
                        .await
                        .then_some(NativeProcessStop::OwnerDeadGroupAbsent)
                }
                Process::Starting | Process::Ended => None,
            };
            if let Some(observation) = observation {
                guard.process_ended(&store, process, observation, &now())?;
            }
        }
        for handle in &initial.handles {
            tokio::task::yield_now().await;
            control(cancel, deadline)?;
            let current = guard.current(&store)?;
            if handle["metadata"]["kind"] == "hook" {
                let Some(process) = peer_store::conversation_hook_process(handle) else {
                    continue;
                };
                if process.owner != initial.owner || !process.valid_conversation(&initial.identity)
                {
                    continue;
                }
                match process.state {
                    Process::NotStarted => guard.handle_ended(&store, handle, &now())?,
                    Process::Running => {
                        if let Some(child) = &process.child
                            && recorder::stop_recorded_group(&initial.owner, child, cancel).await
                        {
                            guard.hook_group_ended(&store, handle, &now())?;
                        }
                    }
                    Process::Starting | Process::Ended => {}
                }
                continue;
            }
            if handle["metadata"]["kind"] == "shell_background" {
                // The pending process has already been reaped or retained as
                // unproven above. Only its matching terminal mirror may go.
                if let Some(done) = current.handles.iter().find(|sample| {
                    sample["handleId"] == handle["handleId"]
                        && sample["toolCallId"] == handle["toolCallId"]
                        && peer_protocol::background_shell_process(sample)
                            .is_some_and(|p| p.state == Process::Ended)
                }) {
                    guard.handle_ended(&store, done, &now())?;
                }
                continue;
            }
            if handle_stopped(&initial, &current, handle, cancel).await {
                guard.handle_ended(&store, handle, &now())?;
            }
        }
        let current = guard.current(&store)?;
        self.cancel_prepared(&store, &mut guard, &current, cancel, deadline)
            .await?;
        self.settle_confirmed(&store, &mut guard, cancel, deadline)
            .await?;
        let current = guard.current(&store)?;
        if current.handles.is_empty()
            && current.pending_tools.iter().all(|p| {
                p.native_process
                    .as_ref()
                    .is_none_or(|p| p.state == Process::Ended)
            })
        {
            guard.finish_stop(&store, &now())?;
        }
        Ok(guard.current(&store)?)
    }
    async fn cancel_prepared(
        &self,
        store: &ConversationStore,
        guard: &mut ConversationRecovery,
        run: &ConversationExecution,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), HostError> {
        for pending in &run.pending_tools {
            if pending.phase != peer_protocol::ConversationDispatchPhase::Prepared
                || run.handles.iter().any(|h| {
                    h["toolCallId"] == pending.tool_call_id
                        && peer_store::conversation_hook_observation(h).is_none()
                })
            {
                continue;
            }
            tokio::task::yield_now().await;
            control(cancel, deadline)?;
            guard.cancel_prepared(store, &pending.tool_call_id, &now())?;
            let approvals = peer_store::ApprovalStore::new(&self.home);
            for row in approvals.list(None, None)? {
                control(cancel, deadline)?;
                if row["state"] == "open"
                    && row["approvalId"]
                        .as_str()
                        .and_then(|id| {
                            id.strip_prefix(&format!("approval-{}-", pending.tool_call_id))
                        })
                        .is_some_and(|suffix| uuid::Uuid::parse_str(suffix).is_ok())
                    && row["conversationId"] == run.identity.conversation_id
                    && row["streamId"] == run.identity.stream_id
                    && row["capabilityId"] == pending.capability_id
                    && row["argsDigest"] == pending.args_digest
                {
                    guard.current(store)?;
                    approvals.decide(
                        &row,
                        peer_store::ApprovalState::Cancelled,
                        peer_store::ApprovalDecision::Policy,
                        &now(),
                        Some("permission_cancelled"),
                        None,
                    )?;
                }
            }
        }
        Ok(())
    }
    async fn settle_confirmed(
        &self,
        store: &ConversationStore,
        guard: &mut ConversationRecovery,
        cancel: &CancellationToken,
        deadline: Instant,
    ) -> Result<(), HostError> {
        let run = guard.current(store)?;
        for pending in &run.pending_tools {
            tokio::task::yield_now().await;
            control(cancel, deadline)?;
            guard.current(store)?;
            let history =
                store.read_committed(&run.identity.conversation_id, None, 8 * 1024 * 1024)?;
            let Some(message) =
                history.history.messages.iter().find(|m| {
                    m["id"] == pending.message_id && m["streamId"] == run.identity.stream_id
                })
            else {
                continue;
            };
            let Some(segment) = message["segments"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|s| s["type"] == "tool-call" && s["toolCallId"] == pending.tool_call_id)
            else {
                continue;
            };
            let Some(grant) = message["permissionGrants"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|g| g["toolCallId"] == pending.tool_call_id)
            else {
                continue;
            };
            let result = &segment["result"];
            if result["toolCallId"] != pending.tool_call_id
                || result["capabilityId"] != pending.capability_id
                || result["error"]["code"] == "execution_outcome_unknown"
                || pending.capability_id == "local.shell.exec"
                    && segment["args"]["background"] == true
                    && result["status"] == "success"
                || !matches!(
                    result["status"].as_str(),
                    Some("success" | "failed" | "denied" | "cancelled")
                )
                || result["status"] == "success" && grant["granted"] != true
                || result["status"] == "success"
                    && pending.phase == peer_protocol::ConversationDispatchPhase::Prepared
                || grant
                    .get("capabilityId")
                    .is_some_and(|c| c != &pending.capability_id)
                || peer_protocol::approval_args_digest(&segment["args"])
                    .ok()
                    .as_deref()
                    != Some(pending.args_digest.as_str())
            {
                continue;
            }
            let current = guard.current(store)?;
            if current.handles.iter().any(|h| {
                h["toolCallId"] == pending.tool_call_id
                    && peer_store::conversation_hook_observation(h).is_none_or(|record| {
                        !result["evidence"]["hooks"]
                            .as_array()
                            .is_some_and(|facts| facts.contains(record))
                    })
            }) || current
                .pending_tools
                .iter()
                .find(|p| p.tool_call_id == pending.tool_call_id)
                .and_then(|p| p.native_process.as_ref())
                .is_some_and(|p| p.state != Process::Ended)
            {
                continue;
            }
            EvidenceIndexStore::new(&self.home).register(
                &HostToolEvidence {
                    conversation_id: &run.identity.conversation_id,
                    plan_id: None,
                    stream_id: Some(&run.identity.stream_id),
                    tool_name: segment["tool"]
                        .as_str()
                        .ok_or(HostError("conversation_execution_invalid"))?,
                    capability_id: &pending.capability_id,
                    tool_call_id: &pending.tool_call_id,
                    grant,
                    result,
                },
                None,
            )?;
            guard.settle_tool(store, &pending.tool_call_id, &pending.message_id, &now())?;
        }
        Ok(())
    }
}
fn control(cancel: &CancellationToken, deadline: Instant) -> Result<(), HostError> {
    if cancel.is_cancelled() {
        Err(HostError("CANCELLED"))
    } else if Instant::now() >= deadline {
        Err(HostError("native_recovery_observation_limit"))
    } else {
        Ok(())
    }
}
async fn handle_stopped(
    initial: &ConversationExecution,
    current: &ConversationExecution,
    handle: &Value,
    cancel: &CancellationToken,
) -> bool {
    if handle["state"] == "ended" {
        return true;
    }
    if handle["metadata"]["kind"] == "effect"
        && current.pending_tools.iter().any(|p| {
            p.native_process.as_ref().is_some_and(|process| {
                process.handle_id == handle["handleId"]
                    && process.tool_call_id == handle["toolCallId"]
                    && process.state == Process::Ended
            })
        })
    {
        return true;
    }
    let meta = &handle["metadata"]["nativeMcp"];
    let role = meta["role"].as_str();
    if meta["schemaVersion"] != 1
        || !matches!(role, Some("rpc" | "connection"))
        || (role == Some("connection") && handle["metadata"]["kind"] != "mcp_connection")
        || (role == Some("rpc") && handle["metadata"]["kind"] != "effect")
        || meta["ownerRecorder"] != json!(initial.owner)
        || meta["registryRevision"].as_str().is_none_or(str::is_empty)
        || !matches!(
            meta["transport"].as_str(),
            Some("stdio" | "streamable_http" | "sse")
        )
    {
        return false;
    }
    if role == Some("connection") && meta["transport"] == "stdio" {
        let Ok(child) = serde_json::from_value(meta["childRecorder"].clone()) else {
            return false;
        };
        return recorder::stop_recorded_group(&initial.owner, &child, cancel).await;
    }
    // Only the local network/RPC pump lifetime is proved by owner death. Its
    // remote effect is deliberately still pending/outcome_unknown.
    true
}
