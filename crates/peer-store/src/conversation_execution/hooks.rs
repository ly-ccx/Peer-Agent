use super::*;
use crate::HookPhase;
use peer_protocol::{NativeProcessState, NativeProcessStop};
use serde_json::json;

pub struct ConversationHookRecord<'a> {
    pub process: &'a NativeOwnedProcess,
    pub event: HookPhase,
    pub rule_digest: &'a str,
    pub observation: Option<&'a Value>,
}

pub(super) fn hook_handle(row: &Value) -> bool {
    row["metadata"]["kind"] == "hook"
}

use peer_protocol::valid_conversation_hook_observation;
pub use peer_protocol::{conversation_hook_observation, conversation_hook_process};
impl ConversationStore {
    pub fn record_conversation_hook(
        &self,
        token: &mut ConversationExecutionToken,
        hook: &ConversationHookRecord<'_>,
        at: &str,
    ) -> Result<ConversationMetadataPublication, StoreError> {
        use NativeProcessState as State;
        let recovering = token.recovery_control.is_some();
        self.mutate_execution(token, at, None, |run, _| {
            let current = hook.process;
            let original = run
                .pending_tools
                .iter()
                .find(|p| {
                    p.tool_call_id == current.tool_call_id && p.dispatch_id == current.dispatch_id
                })
                .ok_or(StoreError::ExecutionChanged)?;
            if !current.valid_conversation(&run.identity)
                || current.owner != run.owner
                || hook.rule_digest.len() != 64
                || !hook.rule_digest.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return Err(StoreError::ExecutionInvalid);
            }
            if let Some(observed) = hook.observation
                && (current.state != State::Ended
                    || current.stop_observation != Some(NativeProcessStop::OwnedCompletion)
                    || !valid_conversation_hook_observation(
                        observed,
                        &json!(hook.event.name()),
                        hook.rule_digest,
                        &current.handle_id,
                    ))
            {
                return Err(StoreError::ExecutionInvalid);
            }
            let handle = run
                .handles
                .iter_mut()
                .find(|row| row["handleId"] == current.handle_id);
            if let Some(handle) = handle {
                let old = conversation_hook_process(handle).ok_or(StoreError::ExecutionInvalid)?;
                let metadata = &mut handle["metadata"]["nativeHook"];
                if metadata["event"] != hook.event.name()
                    || metadata["ruleDigest"] != hook.rule_digest
                    || old.owner != current.owner
                    || old.execution != current.execution
                    || old.dispatch_id != current.dispatch_id
                    || old.tool_call_id != current.tool_call_id
                    || old.handle_id != current.handle_id
                {
                    return Err(StoreError::ExecutionChanged);
                }
                let transition = match (old.state, current.state) {
                    (State::NotStarted, State::Starting) => {
                        current.generation == 1 && run.phase == Phase::Active
                    }
                    (State::Starting, State::Running) => current.generation == 1,
                    (State::Starting | State::Running, State::Ended) => {
                        current.generation == old.generation
                            && current.child == old.child
                            && (hook.observation.is_some()
                                || current.stop_observation
                                    == Some(NativeProcessStop::OwnerDeadGroupAbsent))
                    }
                    (State::NotStarted, State::Ended) => {
                        current.generation == 0
                            && current.child.is_none()
                            && (hook.observation.is_some()
                                || current.stop_observation
                                    == Some(NativeProcessStop::OwnerDeadNotStarted))
                    }
                    _ => false,
                };
                if !transition
                    || hook.observation.is_none() && current.state == State::Ended && !recovering
                {
                    return Err(StoreError::ExecutionChanged);
                }
                metadata["process"] = json!(current);
                if let Some(observed) = hook.observation {
                    metadata["observation"] = observed.clone();
                }
                if current.state == State::Ended {
                    handle["state"] = json!("ended");
                }
            } else {
                let expected_phase = match hook.event {
                    HookPhase::PreToolUse => DispatchPhase::Prepared,
                    HookPhase::PostToolUse => DispatchPhase::Dispatching,
                };
                if run.phase != Phase::Active
                    || original.phase != expected_phase
                    || current.state != State::NotStarted
                    || hook.observation.is_some()
                {
                    return Err(StoreError::ExecutionChanged);
                }
                run.handles.push(
                    json!({"handleId":current.handle_id,"toolCallId":current.tool_call_id,
                    "state":"active","metadata":{"kind":"hook","nativeHook":{
                        "schemaVersion":1,"event":hook.event.name(),"ruleDigest":hook.rule_digest,
                        "process":current
                    }}}),
                );
            }
            Ok(())
        })
    }
}
