//! Shape checks for the Hook process in the original conversation execution
//! handle. The Store and OS still own authority and the terminal observation.
use crate::{
    ConversationDispatchPhase, ConversationExecution, NativeOwnedProcess, NativeProcessState,
    NativeProcessStop,
};
use serde_json::Value;
pub fn conversation_hook_process(handle: &Value) -> Option<NativeOwnedProcess> {
    if handle["metadata"]["kind"] != "hook"
        || handle["metadata"]["nativeHook"]["schemaVersion"] != 1
    {
        return None;
    }
    let p: NativeOwnedProcess =
        serde_json::from_value(handle["metadata"]["nativeHook"]["process"].clone()).ok()?;
    (handle["handleId"] == p.handle_id
        && handle["toolCallId"] == p.tool_call_id
        && matches!(
            handle["metadata"]["nativeHook"]["event"].as_str(),
            Some("PreToolUse" | "PostToolUse")
        )
        && handle["state"]
            == if p.state == NativeProcessState::Ended {
                "ended"
            } else {
                "active"
            })
    .then_some(p)
}

pub fn conversation_hook_observation(handle: &Value) -> Option<&Value> {
    let process = conversation_hook_process(handle)?;
    if process.state != NativeProcessState::Ended
        || process.stop_observation != Some(NativeProcessStop::OwnedCompletion)
    {
        return None;
    }
    let native = &handle["metadata"]["nativeHook"];
    native.get("observation").filter(|observed| {
        valid_conversation_hook_observation(
            observed,
            &native["event"],
            native["ruleDigest"].as_str().unwrap_or(""),
            &process.handle_id,
        )
    })
}

pub fn valid_conversation_hook_observation(
    observed: &Value,
    event: &Value,
    digest: &str,
    handle: &str,
) -> bool {
    let text = |v: &Value| {
        v.as_str()
            .is_some_and(|s| s.len() <= 1024 && !s.chars().any(char::is_control))
    };
    observed.as_object().is_some_and(|m| m.len() == 10)
        && observed["event"] == *event
        && observed["ruleDigest"] == digest
        && observed["handleId"] == handle
        && matches!(
            observed["decision"].as_str(),
            Some("allow" | "ask" | "deny")
        )
        && observed["outcome"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 128)
        && observed
            .get("exitCode")
            .is_some_and(|v| v.is_null() || v.as_i64().is_some_and(|n| i32::try_from(n).is_ok()))
        && observed["durationMs"]
            .as_u64()
            .is_some_and(|duration| duration <= 9_007_199_254_740_991)
        && text(&observed["id"])
        && observed["hookId"] == observed["id"]
        && observed
            .get("reason")
            .is_some_and(|v| v.is_null() || text(v))
}

pub(crate) fn valid_hook_handle(handle: &Value, run: &ConversationExecution) -> bool {
    let Some(process) = conversation_hook_process(handle) else {
        return false;
    };
    let metadata = &handle["metadata"];
    let hook = &metadata["nativeHook"];
    let digest = hook["ruleDigest"].as_str().unwrap_or_default();
    let raw = &hook["process"];
    if metadata.as_object().is_none_or(|m| m.len() != 2)
        || hook.as_object().is_none_or(|m| {
            m.keys().any(|key| {
                ![
                    "schemaVersion",
                    "event",
                    "ruleDigest",
                    "process",
                    "observation",
                ]
                .contains(&key.as_str())
            })
        })
        || digest.len() != 64
        || !digest
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        || !crate::conversation_execution::recorder_shape(&raw["owner"])
        || raw.get("child").is_some_and(|child| {
            !child.is_null() && !crate::conversation_execution::recorder_shape(child)
        })
        || !process.valid_conversation(&run.identity)
        || process.owner != run.owner
        || process.generation > 1
        || !run.pending_tools.iter().any(|p| {
            p.tool_call_id == process.tool_call_id
                && p.dispatch_id == process.dispatch_id
                && (hook["event"] == "PreToolUse" || p.phase != ConversationDispatchPhase::Prepared)
        })
    {
        return false;
    }
    if process.stop_observation == Some(NativeProcessStop::OwnedCompletion) {
        conversation_hook_observation(handle).is_some()
    } else {
        hook.get("observation").is_none()
    }
}
