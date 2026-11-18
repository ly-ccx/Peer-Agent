//! Persisted process and dispatch bindings for owned Shell resources.
//! This record is not a grant, a completed command, or an OS observation.
use crate::{
    ConversationDispatchPhase, ConversationExecution, NativeOwnedProcess, NativeProcessState,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub fn shell_task_id_valid(value: &str) -> bool {
    let Some(uuid) = value.strip_prefix("shell_") else {
        return false;
    };
    uuid_valid(uuid)
}

fn uuid_valid(uuid: &str) -> bool {
    uuid.len() == 36
        && uuid.bytes().enumerate().all(|(index, byte)| {
            if matches!(index, 8 | 13 | 18 | 23) {
                byte == b'-'
            } else {
                byte.is_ascii_hexdigit()
            }
        })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeShellCommandBinding {
    pub tool_call_id: String,
    pub dispatch_id: String,
    pub generation: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeShellSession {
    pub schema_version: u8,
    pub process: NativeOwnedProcess,
    pub command: Option<NativeShellCommandBinding>,
}

impl NativeShellSession {
    pub fn from_handle(handle: &Value) -> Option<Self> {
        if handle.as_object()?.len() != 4 {
            return None;
        }
        let metadata = handle["metadata"].as_object()?;
        if metadata.len() != 2 || metadata.get("kind")?.as_str()? != "shell_session" {
            return None;
        }
        let raw = metadata.get("nativeShellSession")?;
        if raw.as_object()?.len() != 3 || raw.get("command").is_none() {
            return None;
        }
        let session: Self = serde_json::from_value(raw.clone()).ok()?;
        let process = &session.process;
        (session.schema_version == 1
            && process.valid_envelope()
            && raw["process"]["owner"] == json!(process.owner)
            && raw["process"]["child"] == json!(process.child)
            && process.generation <= 1
            && process
                .handle_id
                .strip_prefix("shell-session_")
                .is_some_and(uuid_valid)
            && process
                .child
                .as_ref()
                .is_none_or(|child| child.pid != process.owner.pid)
            && handle["handleId"] == process.handle_id
            && handle["toolCallId"] == process.tool_call_id
            && handle["state"]
                == if process.state == NativeProcessState::Ended {
                    "ended"
                } else {
                    "active"
                }
            && session.command.as_ref().is_none_or(|command| {
                matches!(
                    process.state,
                    NativeProcessState::Running | NativeProcessState::Ended
                ) && process.child.is_some()
                    && command.generation == process.generation
            }))
        .then_some(session)
    }

    pub fn handle(&self) -> Value {
        let process = &self.process;
        let state = if process.state == NativeProcessState::Ended {
            "ended"
        } else {
            "active"
        };
        json!({
            "handleId": process.handle_id,
            "toolCallId": process.tool_call_id,
            "state": state,
            "metadata": { "kind": "shell_session", "nativeShellSession": self },
        })
    }

    pub(crate) fn valid_for_run(&self, run: &ConversationExecution) -> bool {
        let bound = |tool_call: &str, dispatch: &str| {
            run.pending_tools.iter().any(|call| {
                call.tool_call_id == tool_call
                    && call.dispatch_id == dispatch
                    && call.capability_id == "local.shell.exec"
                    && call.phase != ConversationDispatchPhase::Prepared
                    && call.native_process.is_none()
            })
        };
        let process = &self.process;
        run.engine == "peer-native"
            && process.owner == run.owner
            && process.valid_conversation(&run.identity)
            && (!matches!(
                process.state,
                NativeProcessState::NotStarted | NativeProcessState::Starting
            ) || bound(&process.tool_call_id, &process.dispatch_id))
            && self
                .command
                .as_ref()
                .is_none_or(|command| bound(&command.tool_call_id, &command.dispatch_id))
    }
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
