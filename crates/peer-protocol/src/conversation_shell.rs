//! The persisted mirror of the original pending background Shell dispatch.
//! This record is not a grant, a completed command, or an OS observation.
use crate::{
    ConversationDispatchPhase, ConversationExecution, NativeOwnedProcess, NativeProcessState,
};
use serde_json::{Value, json};

pub fn shell_task_id_valid(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("shell_") else {
        return false;
    };
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

pub fn background_shell_process(handle: &Value) -> Option<NativeOwnedProcess> {
    let metadata = handle["metadata"].as_object()?;
    let shell = metadata.get("nativeShell")?;
    if metadata.len() != 2
        || metadata.get("kind")?.as_str()? != "shell_background"
        || shell.as_object()?.len() != 2
        || shell["schemaVersion"] != 1
    {
        return None;
    }
    let process: NativeOwnedProcess = serde_json::from_value(shell.get("process")?.clone()).ok()?;
    if !process.valid_envelope()
        || !shell_task_id_valid(&process.handle_id)
        || process.generation > 1
        || process
            .child
            .as_ref()
            .is_some_and(|child| child.pid == process.owner.pid)
        || handle["handleId"] != process.handle_id
        || handle["toolCallId"] != process.tool_call_id
        || handle["state"]
            != if process.state == NativeProcessState::Ended {
                "ended"
            } else {
                "active"
            }
    {
        return None;
    }
    Some(process)
}

pub fn background_shell_handle(process: &NativeOwnedProcess) -> Value {
    let state = if process.state == NativeProcessState::Ended {
        "ended"
    } else {
        "active"
    };
    json!({
        "handleId": process.handle_id, "toolCallId": process.tool_call_id, "state": state,
        "metadata": { "kind": "shell_background", "nativeShell": { "schemaVersion": 1, "process": process } }
    })
}

pub(crate) fn valid_background_shell_handle(handle: &Value, run: &ConversationExecution) -> bool {
    let Some(process) = background_shell_process(handle) else {
        return false;
    };
    run.engine == "peer-native"
        && process.owner == run.owner
        && process.valid_conversation(&run.identity)
        && run.pending_tools.iter().any(|call| {
            call.tool_call_id == process.tool_call_id
                && call.dispatch_id == process.dispatch_id
                && call.capability_id == "local.shell.exec"
                && call.phase != ConversationDispatchPhase::Prepared
                && call.native_process.as_ref() == Some(&process)
        })
}
