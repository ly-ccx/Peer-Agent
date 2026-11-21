//! Host-owned local child facts in the existing canonical pending dispatch.
//! Shape validation is not process death, authorization or effect proof.
use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeProcessRecorder {
    pub boot_id: String,
    pub pid: u32,
    pub pid_start: String,
    pub host_id: String,
    pub acquired_at: String,
}
impl NativeProcessRecorder {
    pub fn complete(&self) -> bool {
        self.pid > 0
            && self.pid <= i32::MAX as u32
            && [
                &self.boot_id,
                &self.pid_start,
                &self.host_id,
                &self.acquired_at,
            ]
            .iter()
            .all(|s| !s.is_empty() && s.len() <= 8192)
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeProcessState {
    NotStarted,
    Starting,
    Running,
    Ended,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeProcessStop {
    OwnedCompletion,
    OwnerDeadNotStarted,
    OwnerDeadGroupAbsent,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum NativeProcessKind {
    Command,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NativeOwnedProcess {
    pub schema_version: u8,
    pub kind: NativeProcessKind,
    pub handle_id: String,
    pub tool_call_id: String,
    pub dispatch_id: String,
    pub execution: Value,
    pub generation: u32,
    pub state: NativeProcessState,
    pub owner: NativeProcessRecorder,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub child: Option<NativeProcessRecorder>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_observation: Option<NativeProcessStop>,
}
impl NativeOwnedProcess {
    pub fn valid(&self) -> bool {
        self.valid_envelope()
            && crate::normalize_session_execution_identity(&self.execution).is_some()
    }
    pub fn valid_conversation(&self, identity: &crate::ConversationExecutionIdentity) -> bool {
        self.valid_envelope()
            && serde_json::to_value(identity).is_ok_and(|expected| expected == self.execution)
    }
    pub(crate) fn valid_envelope(&self) -> bool {
        let child = self.child.as_ref().is_none_or(|c| {
            c.complete()
                && c.host_id == self.owner.host_id
                && c.acquired_at == self.owner.acquired_at
                && c.boot_id == self.owner.boot_id
        });
        let state = match self.state {
            NativeProcessState::NotStarted => {
                self.generation == 0 && self.child.is_none() && self.stop_observation.is_none()
            }
            NativeProcessState::Starting => {
                self.generation > 0 && self.child.is_none() && self.stop_observation.is_none()
            }
            NativeProcessState::Running => {
                self.generation > 0 && self.child.is_some() && self.stop_observation.is_none()
            }
            NativeProcessState::Ended => match self.stop_observation {
                Some(NativeProcessStop::OwnedCompletion) => true,
                Some(NativeProcessStop::OwnerDeadNotStarted) => {
                    self.generation == 0 && self.child.is_none()
                }
                Some(NativeProcessStop::OwnerDeadGroupAbsent) => {
                    self.generation > 0 && self.child.is_some()
                }
                None => false,
            },
        };
        self.schema_version == 1
            && self.generation <= 64
            && self.owner.complete()
            && child
            && state
            && [&self.handle_id, &self.tool_call_id, &self.dispatch_id]
                .iter()
                .all(|s| !s.is_empty() && s.len() <= 200)
    }
}
/// Shared storage/reducer guard. Unknown or malformed child facts fail closed;
/// callers retain the original canonical source for supported reconciliation.
pub fn native_processes_in_work(work: &Value) -> Result<Vec<NativeOwnedProcess>, &'static str> {
    let budget = &work["budget"];
    let rows = budget["attempts"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .flat_map(|a| a["pendingTools"].as_array().into_iter().flatten())
        .chain(
            budget["uncertainDispatches"]
                .as_array()
                .into_iter()
                .flatten(),
        );
    let mut processes = Vec::new();
    for row in rows {
        let Some(value) = row.get("nativeProcess") else {
            continue;
        };
        let p: NativeOwnedProcess =
            serde_json::from_value(value.clone()).map_err(|_| "native_process_invalid")?;
        let owner: NativeProcessRecorder =
            serde_json::from_value(row["nativeRecorder"]["recorder"].clone())
                .map_err(|_| "native_process_invalid")?;
        if !p.valid()
            || row["toolCallId"] != p.tool_call_id
            || row["dispatchId"] != p.dispatch_id
            || p.owner != owner
            || crate::normalize_session_execution_identity(&p.execution)
                != crate::normalize_session_execution_identity(&row["nativeRecorder"]["execution"])
            || processes.len() >= 128
            || processes.iter().any(|old: &NativeOwnedProcess| {
                old.handle_id == p.handle_id
                    || old.tool_call_id == p.tool_call_id
                    || old.dispatch_id == p.dispatch_id
            })
        {
            return Err("native_process_invalid");
        }
        processes.push(p);
    }
    Ok(processes)
}
