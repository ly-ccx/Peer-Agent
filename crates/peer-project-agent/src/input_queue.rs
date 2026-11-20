//! Durable project input queue (`project-runtime/<workspaceId>/input-queue.jsonl`
//! and `input-cursor.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/input-queue.mjs` (ADR 85 §2):
//! - Any surface (`desktop`, `quick_chat`, `tui`, `remote`) can append idempotently.
//! - Only the lease-holding Host consumes pending inputs, appends `user_input`
//!   messages to the bot conversation (`id = "input-<inputId>"`), and advances cursor.
//! - Replay after message append but before cursor advance never duplicates a message.

use crate::{ProjectError, atomic_write, is_valid_input_id, is_valid_workspace_id, now_iso};
use peer_store::{ConversationStore, DirectoryLock};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_QUEUE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 200_000;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

pub fn input_message_id(input_id: &str) -> Result<String, ProjectError> {
    let trimmed = input_id.trim();
    if !is_valid_input_id(trimmed) {
        return Err(ProjectError::code("INVALID_INPUT_ID"));
    }
    Ok(format!("input-{trimmed}"))
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectInput {
    pub input_id: String,
    pub workspace_id: String,
    pub surface: String,
    pub text: String,
    #[serde(default)]
    pub anchor_refs: Vec<String>,
    #[serde(default)]
    pub quote_refs: Vec<String>,
    #[serde(default)]
    pub attachment_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub attachments: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_feedback: Option<Vec<Value>>,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_to: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_ref: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_snapshot_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub history_confirmed: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CursorState {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    consumed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    executed_input_id: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    completed_input_ids: Vec<String>,
}

pub struct SubmitInputRequest<'a> {
    pub workspace_id: &'a str,
    pub input_id: &'a str,
    pub surface: &'a str,
    pub text: &'a str,
    pub anchor_refs: Vec<String>,
    pub quote_refs: Vec<String>,
    pub attachment_refs: Vec<String>,
    pub answer_to: Option<String>,
}

#[derive(Debug, Clone)]
pub struct ConsumeOutcome {
    pub consumed: Vec<ProjectInput>,
    pub pending_execution: Vec<ProjectInput>,
}

pub struct InputQueue {
    runtime_root: PathBuf,
}

fn valid_surface(surface: &str) -> bool {
    matches!(surface, "desktop" | "quick_chat" | "tui" | "remote")
}

impl InputQueue {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
        }
    }

    pub fn from_runtime_root(runtime_root: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: runtime_root.as_ref().to_path_buf(),
        }
    }

    fn queue_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .runtime_root
            .join(workspace_id)
            .join("input-queue.jsonl"))
    }

    fn cursor_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .runtime_root
            .join(workspace_id)
            .join("input-cursor.json"))
    }

    fn with_lock<T>(
        &self,
        workspace_id: &str,
        f: impl FnOnce() -> Result<T, ProjectError>,
    ) -> Result<T, ProjectError> {
        let qfile = self.queue_file(workspace_id)?;
        if let Some(parent) = qfile.parent() {
            fs::create_dir_all(parent).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let _lock = DirectoryLock::acquire(&qfile, LOCK_TIMEOUT, None)?;
        f()
    }

    fn read_inputs_unlocked(&self, workspace_id: &str) -> Result<Vec<ProjectInput>, ProjectError> {
        let file = self.queue_file(workspace_id)?;
        let meta = match fs::metadata(&file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        if !meta.is_file() || meta.len() > MAX_QUEUE_BYTES {
            return Err(ProjectError::code("INPUT_QUEUE_LIMIT"));
        }
        let raw =
            fs::read_to_string(&file).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let mut out = Vec::new();
        let mut seen = HashSet::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(row) = serde_json::from_str::<ProjectInput>(line) else {
                continue;
            };
            if row.workspace_id != workspace_id
                || !is_valid_input_id(&row.input_id)
                || !valid_surface(&row.surface)
            {
                continue;
            }
            if seen.insert(row.input_id.clone()) {
                out.push(row);
            }
        }
        Ok(out)
    }

    fn read_cursor_state(&self, workspace_id: &str) -> Result<CursorState, ProjectError> {
        let file = self.cursor_file(workspace_id)?;
        let raw = match fs::read_to_string(&file) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(CursorState::default()),
            Err(e) => return Err(ProjectError::new("IO_ERROR", e.to_string())),
        };
        serde_json::from_str(&raw).map_err(|_| ProjectError::code("CORRUPT_INPUT_CURSOR"))
    }

    fn write_cursor_state(
        &self,
        workspace_id: &str,
        state: &CursorState,
    ) -> Result<(), ProjectError> {
        let file = self.cursor_file(workspace_id)?;
        let mut body = serde_json::to_string(state)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&file, body.as_bytes())
    }

    /// Append a user input idempotently. Re-submitting an existing `inputId` returns
    /// the original stored row without writing a duplicate.
    pub fn submit_input(
        &self,
        request: &SubmitInputRequest<'_>,
    ) -> Result<ProjectInput, ProjectError> {
        let ws = request.workspace_id.trim();
        let input_id = request.input_id.trim();
        if !is_valid_workspace_id(ws) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        if !is_valid_input_id(input_id) {
            return Err(ProjectError::code("INVALID_INPUT_ID"));
        }
        if !valid_surface(request.surface) {
            return Err(ProjectError::code("INVALID_SURFACE"));
        }
        let text = request.text.trim();
        if text.is_empty() && request.attachment_refs.is_empty() {
            return Err(ProjectError::code("EMPTY_INPUT"));
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err(ProjectError::code("INPUT_TOO_LARGE"));
        }
        self.with_lock(ws, || {
            let existing = self.read_inputs_unlocked(ws)?;
            if let Some(found) = existing.into_iter().find(|r| r.input_id == input_id) {
                return Ok(found);
            }
            let row = ProjectInput {
                input_id: input_id.to_owned(),
                workspace_id: ws.to_owned(),
                surface: request.surface.to_owned(),
                text: request.text.to_owned(),
                anchor_refs: request.anchor_refs.clone(),
                quote_refs: request.quote_refs.clone(),
                attachment_refs: request.attachment_refs.clone(),
                attachments: None,
                resource_feedback: None,
                created_at: now_iso(),
                answer_to: request.answer_to.clone(),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            };
            let file = self.queue_file(ws)?;
            let mut line = serde_json::to_string(&row)
                .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
            line.push('\n');
            let mut handle = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            handle
                .write_all(line.as_bytes())
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            handle
                .sync_all()
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            Ok(row)
        })
    }

    pub fn list(&self, workspace_id: &str) -> Result<Vec<ProjectInput>, ProjectError> {
        let ws = workspace_id.trim();
        if !is_valid_workspace_id(ws) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        self.read_inputs_unlocked(ws)
    }

    /// Read-only check for unconsumed or delivered-but-unexecuted user inputs.
    pub fn has_pending(&self, workspace_id: &str) -> bool {
        let ws = workspace_id.trim();
        if !is_valid_workspace_id(ws) {
            return false;
        }
        let Ok(inputs) = self.read_inputs_unlocked(ws) else {
            return false;
        };
        if inputs.is_empty() {
            return false;
        }
        let Ok(cursor) = self.read_cursor_state(ws) else {
            return false;
        };
        let Some(delivered_id) = cursor.input_id.as_deref() else {
            return true;
        };
        let Some(delivered_idx) = inputs.iter().position(|r| r.input_id == delivered_id) else {
            return true;
        };
        if delivered_idx + 1 < inputs.len() {
            return true;
        }
        let start = cursor
            .executed_input_id
            .as_deref()
            .and_then(|id| inputs.iter().position(|r| r.input_id == id))
            .map(|idx| idx + 1)
            .unwrap_or(0);
        inputs[start..=delivered_idx]
            .iter()
            .any(|item| !cursor.completed_input_ids.contains(&item.input_id))
    }

    pub fn read_cursor(&self, workspace_id: &str) -> Result<Option<String>, ProjectError> {
        let state = self.read_cursor_state(workspace_id)?;
        Ok(state.input_id.filter(|s| !s.trim().is_empty()))
    }

    /// Host-only consumption: moves unread inputs past cursor into the bot's canonical
    /// conversation (`id = "input-<inputId>"`), advances `input-cursor.json`, and
    /// returns both newly consumed inputs and all delivered-but-unexecuted inputs.
    pub fn consume(
        &self,
        workspace_id: &str,
        conversation_id: &str,
        conversations: &ConversationStore,
        holds_lease: bool,
    ) -> Result<ConsumeOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let ws = workspace_id.trim();
        if !is_valid_workspace_id(ws) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        self.with_lock(ws, || {
            let inputs = self.read_inputs_unlocked(ws)?;
            let mut cursor = self.read_cursor_state(ws)?;
            let start = match cursor.input_id.as_deref() {
                Some(last_id) => inputs
                    .iter()
                    .position(|row| row.input_id == last_id)
                    .map(|idx| idx + 1)
                    .unwrap_or(0),
                None => 0,
            };
            let mut consumed = Vec::new();
            for item in &inputs[start..] {
                let msg_id = input_message_id(&item.input_id)?;
                let mut msg = json!({
                    "id": msg_id,
                    "role": "user",
                    "kind": "user_input",
                    "inputId": item.input_id,
                    "surface": item.surface,
                    "content": item.text,
                    "createdAt": item.created_at,
                });
                if !item.anchor_refs.is_empty() {
                    msg["anchorRefs"] = json!(item.anchor_refs);
                }
                if !item.quote_refs.is_empty() {
                    msg["quoteRefs"] = json!(item.quote_refs);
                }
                if !item.attachment_refs.is_empty() {
                    msg["attachmentRefs"] = json!(item.attachment_refs);
                }
                if let Some(ref answer_to) = item.answer_to {
                    msg["answerTo"] = json!(answer_to);
                }
                conversations.append_message_idempotent(
                    conversation_id,
                    &msg,
                    &item.created_at,
                    None,
                )?;
                cursor.input_id = Some(item.input_id.clone());
                cursor.consumed_at = Some(now_iso());
                self.write_cursor_state(ws, &cursor)?;
                consumed.push(item.clone());
            }
            let pending_execution =
                self.compute_pending_execution(ws, &inputs, &mut cursor, &[], &[])?;
            Ok(ConsumeOutcome {
                consumed,
                pending_execution,
            })
        })
    }

    /// Mark inputs as executed/replied so they are not re-dispatched after restart.
    pub fn mark_executed(
        &self,
        workspace_id: &str,
        completed_input_ids: &[String],
        replied_message_ids: &[String],
        holds_lease: bool,
    ) -> Result<Vec<ProjectInput>, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let ws = workspace_id.trim();
        self.with_lock(ws, || {
            let inputs = self.read_inputs_unlocked(ws)?;
            let mut cursor = self.read_cursor_state(ws)?;
            self.compute_pending_execution(
                ws,
                &inputs,
                &mut cursor,
                completed_input_ids,
                replied_message_ids,
            )
        })
    }

    fn compute_pending_execution(
        &self,
        ws: &str,
        inputs: &[ProjectInput],
        cursor: &mut CursorState,
        completed: &[String],
        replied_message_ids: &[String],
    ) -> Result<Vec<ProjectInput>, ProjectError> {
        let Some(delivered_id) = cursor.input_id.as_deref() else {
            return Ok(Vec::new());
        };
        let Some(delivered_idx) = inputs.iter().position(|r| r.input_id == delivered_id) else {
            return Ok(Vec::new());
        };
        let mut through: Option<usize> = cursor
            .executed_input_id
            .as_deref()
            .and_then(|id| inputs.iter().position(|r| r.input_id == id));
        let mut acked: HashSet<String> = cursor.completed_input_ids.iter().cloned().collect();
        let replies: HashSet<&str> = replied_message_ids.iter().map(String::as_str).collect();
        for item in &inputs[..=delivered_idx] {
            let msg_id = format!("input-{}", item.input_id);
            if completed.contains(&item.input_id) || replies.contains(msg_id.as_str()) {
                acked.insert(item.input_id.clone());
            }
        }
        loop {
            let next_idx = match through {
                None => 0,
                Some(idx) => idx + 1,
            };
            if next_idx > delivered_idx {
                break;
            }
            if acked.remove(&inputs[next_idx].input_id) {
                through = Some(next_idx);
            } else {
                break;
            }
        }
        let start = through.map(|i| i + 1).unwrap_or(0);
        let pending: Vec<ProjectInput> = inputs[start..=delivered_idx]
            .iter()
            .filter(|item| !acked.contains(&item.input_id))
            .cloned()
            .collect();
        let next_executed = through.map(|idx| inputs[idx].input_id.clone());
        let mut next_completed: Vec<String> = acked.into_iter().collect();
        next_completed.sort();
        if cursor.executed_input_id != next_executed || cursor.completed_input_ids != next_completed
        {
            cursor.executed_input_id = next_executed;
            cursor.completed_input_ids = next_completed;
            self.write_cursor_state(ws, cursor)?;
        }
        Ok(pending)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use peer_store::NewProjectConversation;
    use tempfile::tempdir;

    #[test]
    fn submit_consume_idempotency_and_execution_cursor_work() {
        let dir = tempdir().unwrap();
        let conv_store = ConversationStore::new(dir.path());
        let conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Bot",
                    workspace_id: "ws-1",
                    workspace_path: Some("/tmp/repo"),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: &now_iso(),
                },
                None,
                None,
            )
            .unwrap();
        let conv_id = conv["id"].as_str().unwrap();

        let queue = InputQueue::new(dir.path());
        let req = SubmitInputRequest {
            workspace_id: "ws-1",
            input_id: "in-1",
            surface: "tui",
            text: "Hello bot",
            anchor_refs: vec![],
            quote_refs: vec![],
            attachment_refs: vec![],
            answer_to: None,
        };
        let first = queue.submit_input(&req).unwrap();
        let dup = queue.submit_input(&req).unwrap();
        assert_eq!(first, dup);

        // Non-host cannot consume.
        assert_eq!(
            queue
                .consume("ws-1", conv_id, &conv_store, false)
                .unwrap_err()
                .code,
            "LEASE_REQUIRED"
        );

        let out = queue.consume("ws-1", conv_id, &conv_store, true).unwrap();
        assert_eq!(out.consumed.len(), 1);
        assert_eq!(out.pending_execution.len(), 1);

        // Re-consuming produces no duplicate messages.
        let out2 = queue.consume("ws-1", conv_id, &conv_store, true).unwrap();
        assert!(out2.consumed.is_empty());
        assert_eq!(out2.pending_execution.len(), 1);

        let remaining = queue
            .mark_executed("ws-1", &["in-1".to_owned()], &[], true)
            .unwrap();
        assert!(remaining.is_empty());
    }
}
