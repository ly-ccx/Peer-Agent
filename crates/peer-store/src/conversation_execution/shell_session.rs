//! The process remains registered while commands settle on their own facts.
use super::*;
use peer_protocol::{
    NativeProcessState as State, NativeProcessStop, NativeShellCommandBinding, NativeShellSession,
    approval_args_digest,
};

impl ConversationStore {
    /// Called before spawning the actual interpreter. The original admitted
    /// dispatch is the initial process owner, even after its result settles.
    pub fn register_conversation_shell_session(
        &self,
        token: &mut ConversationExecutionToken,
        process: &NativeOwnedProcess,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, history| {
            let starting_call = NativeShellCommandBinding {
                tool_call_id: process.tool_call_id.clone(),
                dispatch_id: process.dispatch_id.clone(),
                generation: 1,
            };
            if run.phase != Phase::Active
                || process.state != State::NotStarted
                || run
                    .handles
                    .iter()
                    .any(|handle| handle["metadata"]["kind"] == "shell_session")
                || !admitted_shell_call(run, history, &starting_call)
            {
                return Err(StoreError::ExecutionChanged);
            }
            run.handles.push(
                NativeShellSession {
                    schema_version: 1,
                    process: process.clone(),
                    command: None,
                }
                .handle(),
            );
            Ok(())
        })
    }

    pub fn record_conversation_shell_process(
        &self,
        token: &mut ConversationExecutionToken,
        process: &NativeOwnedProcess,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        let recovering = token.recovery_control.is_some();
        self.mutate_execution(token, at, None, |run, _| {
            let active = run.phase == Phase::Active;
            let row = shell_handle_mut(run, &process.handle_id)?;
            let mut session =
                NativeShellSession::from_handle(row).ok_or(StoreError::ExecutionInvalid)?;
            let old = &session.process;
            if old == process {
                return Ok(());
            }
            let matching = old.tool_call_id == process.tool_call_id
                && old.dispatch_id == process.dispatch_id
                && old.execution == process.execution
                && old.owner == process.owner;
            let valid = match (old.state, process.state) {
                (State::NotStarted, State::Starting) => {
                    active && !recovering && process.generation == 1
                }
                (State::Starting, State::Running) => {
                    !recovering && process.generation == old.generation
                }
                (State::NotStarted | State::Starting | State::Running, State::Ended) => {
                    process.generation == old.generation
                        && process.child == old.child
                        && if recovering {
                            matches!(
                                (old.state, process.stop_observation),
                                (
                                    State::NotStarted,
                                    Some(NativeProcessStop::OwnerDeadNotStarted)
                                ) | (
                                    State::Running,
                                    Some(NativeProcessStop::OwnerDeadGroupAbsent)
                                )
                            )
                        } else {
                            process.stop_observation == Some(NativeProcessStop::OwnedCompletion)
                        }
                }
                _ => false,
            };
            if !matching || !valid {
                return Err(StoreError::ExecutionChanged);
            }
            session.process = process.clone();
            *row = session.handle();
            Ok(())
        })
    }

    /// Publish the particular command before writing its payload into the
    /// interpreter. A matching original canonical Grant must already exist.
    pub fn bind_conversation_shell_command(
        &self,
        token: &mut ConversationExecutionToken,
        handle: &str,
        command: &NativeShellCommandBinding,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        self.mutate_execution(token, at, None, |run, history| {
            if run.phase != Phase::Active || !admitted_shell_call(run, history, command) {
                return Err(StoreError::ExecutionChanged);
            }
            let row = shell_handle_mut(run, handle)?;
            let mut session =
                NativeShellSession::from_handle(row).ok_or(StoreError::ExecutionInvalid)?;
            if session.process.state != State::Running
                || session.process.generation != command.generation
                || session.command.is_some()
            {
                return Err(StoreError::ExecutionBusy);
            }
            session.command = Some(command.clone());
            *row = session.handle();
            Ok(())
        })
    }
}

fn shell_handle_mut<'a>(
    run: &'a mut ConversationExecution,
    handle: &str,
) -> Result<&'a mut Value, StoreError> {
    run.handles
        .iter_mut()
        .find(|row| row["handleId"] == handle && row["metadata"]["kind"] == "shell_session")
        .ok_or(StoreError::ExecutionChanged)
}

fn admitted_shell_call(
    run: &ConversationExecution,
    history: &HistorySnapshot,
    binding: &NativeShellCommandBinding,
) -> bool {
    let Some(pending) = run.pending_tools.iter().find(|pending| {
        pending.tool_call_id == binding.tool_call_id
            && pending.dispatch_id == binding.dispatch_id
            && pending.phase == DispatchPhase::Dispatching
            && pending.capability_id == "local.shell.exec"
            && pending.native_process.is_none()
    }) else {
        return false;
    };
    let Some(row) = history.history.messages.iter().find(|row| {
        row["id"] == pending.message_id
            && row["role"] == "assistant"
            && row["streamId"] == run.identity.stream_id
    }) else {
        return false;
    };
    row["permissionGrants"].as_array().is_some_and(|grants| {
        grants.iter().any(|grant| {
            grant["toolCallId"] == pending.tool_call_id
                && grant["granted"] == true
                && grant["grantId"].as_str().is_some_and(|id| !id.is_empty())
                && grant["scope"] == pending.capability_id
        })
    }) && row["segments"].as_array().is_some_and(|segments| {
        segments.iter().any(|segment| {
            segment["type"] == "tool-call"
                && segment["toolCallId"] == pending.tool_call_id
                && segment["args"]["background"] != true
                && segment["result"].is_null()
                && approval_args_digest(&segment["args"]).ok().as_deref()
                    == Some(&pending.args_digest)
        })
    })
}

pub(super) fn shell_result_matches(
    session: &NativeShellSession,
    call: &str,
    result: &Value,
) -> bool {
    if let Some(command) = session
        .command
        .as_ref()
        .filter(|command| command.tool_call_id == call)
    {
        let bound = &result["evidence"]["shellSession"];
        return bound["handleId"] == session.process.handle_id
            && bound["dispatchId"] == command.dispatch_id
            && bound["generation"] == session.process.generation;
    }
    session.process.tool_call_id != call
        || result["evidence"]["dispatchOutcome"] == "not_dispatched"
}

pub(super) fn clear_settled_command(run: &mut ConversationExecution, call: &str) {
    for handle in &mut run.handles {
        if let Some(mut session) = NativeShellSession::from_handle(handle)
            && session
                .command
                .as_ref()
                .is_some_and(|command| command.tool_call_id == call)
        {
            session.command = None;
            *handle = session.handle();
        }
    }
}
