//! A committed startup may coexist with the next serial Tool Call. The
//! original pending dispatch remains protected until its process really ends.
use super::*;
use peer_protocol::{NativeProcessState, background_shell_process};

fn startup_result<'a>(
    run: &ConversationExecution,
    history: &'a HistorySnapshot,
    pending: &ConversationPendingTool,
) -> Option<&'a Value> {
    let process = pending.native_process.as_ref()?;
    if pending.phase != DispatchPhase::Dispatching
        || pending.capability_id != "local.shell.exec"
        || process.state != NativeProcessState::Running
        || process.child.is_none()
        || !run.handles.iter().any(|handle| {
            handle["handleId"] == process.handle_id
                && background_shell_process(handle).as_ref() == Some(process)
        })
    {
        return None;
    }
    let row = history.history.messages.iter().find(|row| {
        row["id"] == pending.message_id
            && row["streamId"] == run.identity.stream_id
            && row["role"] == "assistant"
    })?;
    let permitted = row["permissionGrants"].as_array()?.iter().any(|grant| {
        grant["toolCallId"] == pending.tool_call_id
            && grant["granted"] == true
            && grant["grantId"].as_str().is_some_and(|id| !id.is_empty())
            && grant["scope"] == pending.capability_id
            && grant["duration"] == "once"
    });
    let segment = row["segments"].as_array()?.iter().find(|segment| {
        segment["type"] == "tool-call" && segment["toolCallId"] == pending.tool_call_id
    })?;
    let result = &segment["result"];
    (permitted
        && segment["args"]["background"] == true
        && peer_protocol::approval_args_digest(&segment["args"])
            .ok()
            .as_deref()
            == Some(&pending.args_digest)
        && result["toolCallId"] == pending.tool_call_id
        && result["capabilityId"] == pending.capability_id
        && result["status"] == "success"
        && result["output"]["status"] == "running"
        && result["output"]["taskId"] == process.handle_id
        && result["error"].is_null()
        && serde_json::from_value::<NativeOwnedProcess>(
            result["evidence"]["nativeProcess"].clone(),
        )
        .ok()
        .as_ref()
            == Some(process))
    .then_some(result)
}

pub(super) fn shall_allow_next_tool(
    run: &ConversationExecution,
    history: &HistorySnapshot,
    evidence: &crate::EvidenceIndexStore,
    cancel: Option<&AtomicBool>,
) -> Result<bool, StoreError> {
    if run.pending_tools.is_empty() {
        return Ok(true);
    }
    let Some(results) = run
        .pending_tools
        .iter()
        .map(|pending| startup_result(run, history, pending))
        .collect::<Option<Vec<_>>>()
    else {
        return Ok(false);
    };
    let references = run
        .pending_tools
        .iter()
        .map(|pending| format!("tool-result://{}", pending.tool_call_id))
        .collect::<Vec<_>>();
    let rows = evidence.find(&references, cancel)?;
    Ok(results.iter().all(|result| {
        rows.iter().any(|row| {
            row["conversationId"] == run.identity.conversation_id
                && row["streamId"] == run.identity.stream_id
                && row["toolCallId"] == result["toolCallId"]
                && row["capabilityId"] == result["capabilityId"]
                && row["createdAt"] == result["completedAt"]
                && row["artifactRefs"] == result["evidence"]["artifactRefs"]
        })
    }))
}
