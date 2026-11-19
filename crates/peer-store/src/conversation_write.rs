//! Existing ConversationStore JSONL write seam. No private execution journal.
use crate::conversation_preview::preview;
use crate::{
    ConversationStore, DirectoryLock, HistorySnapshot, StoreError, durable_jsonl as log, files,
    valid_id,
};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

/// Host creation intent for a project-agent or delegated work-session conversation.
pub struct NewProjectConversation<'a> {
    pub id: Option<&'a str>,
    pub title: &'a str,
    pub workspace_id: &'a str,
    pub workspace_path: Option<&'a str>,
    pub role: &'a str,
    pub parent_conversation_id: Option<&'a str>,
    pub mode: &'a str,
    pub created_at: &'a str,
}
/// Host creation intent. UI text/metadata cannot choose a persisted id.
pub struct NewConversation<'a> {
    pub title: &'a str,
    pub workspace_path: Option<&'a str>,
    pub mode: &'a str,
    pub created_at: &'a str,
}
/// User-selected model metadata, shared with the existing conversation index.
pub struct ConversationModelSelection<'a> {
    pub provider_id: &'a str,
    pub model: &'a str,
    pub effort: &'a str,
}
impl ConversationModelSelection<'_> {
    fn validate(&self) -> Result<(), StoreError> {
        if self.provider_id.is_empty() || self.model.is_empty() {
            return Err(StoreError::InvalidInput);
        }
        Ok(())
    }
    fn stored_effort(&self) -> &str {
        match self.effort {
            "off" | "low" | "high" | "xhigh" | "max" => self.effort,
            _ => "default",
        }
    }
    pub fn matches(&self, meta: &Value) -> bool {
        meta["modelProviderId"] == self.provider_id
            && meta["model"] == self.model
            && meta["effort"] == self.stored_effort()
    }
    fn apply(&self, meta: &mut Value) {
        let before = crate::context_model_key(meta);
        meta["modelProviderId"] = json!(self.provider_id);
        meta["model"] = json!(self.model);
        meta["effort"] = json!(self.stored_effort());
        if crate::context_model_key(meta) != before {
            meta["contextSnapshot"] = Value::Null;
        }
    }
}

#[derive(Debug)]
pub struct MessageCommit {
    pub snapshot: HistorySnapshot,
    pub already_committed: bool,
}
pub(super) fn timestamp(at: &str) -> bool {
    at.len() <= 64
        && time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).is_ok()
}
pub(crate) fn locks(
    directory: &Path,
    id: Option<&str>,
    cancel: Option<&AtomicBool>,
) -> Result<Vec<DirectoryLock>, StoreError> {
    let mut held = vec![DirectoryLock::acquire(
        &directory.join("index.jsonl"),
        Duration::from_millis(100),
        cancel,
    )?];
    if let Some(id) = id {
        held.push(DirectoryLock::acquire(
            &directory.join(format!("{id}.jsonl")),
            Duration::from_millis(100),
            cancel,
        )?);
    }
    Ok(held)
}
pub(super) fn revision(meta: &Value) -> Result<u64, StoreError> {
    meta["contentRevision"]
        .as_u64()
        .filter(|v| *v < 9_007_199_254_740_991)
        .ok_or(StoreError::HistoryCorrupt)
}
pub(super) fn position(index: &[Value], id: &str) -> Result<usize, StoreError> {
    let mut found = None;
    for (i, row) in index.iter().enumerate() {
        if row["id"] == id && found.replace(i).is_some() {
            return Err(StoreError::HistoryCorrupt);
        }
    }
    found.ok_or(StoreError::NotFound)
}
pub(super) fn validate_messages(rows: &[Value]) -> Result<(), StoreError> {
    let mut seen = HashSet::new();
    for row in rows {
        let id = row["id"]
            .as_str()
            .filter(|s| !s.is_empty() && s.len() <= 200)
            .ok_or(StoreError::HistoryCorrupt)?;
        if !seen.insert(id) {
            return Err(StoreError::HistoryCorrupt);
        }
    }
    Ok(())
}
impl ConversationStore {
    pub(crate) fn write_directory(&self) -> Result<PathBuf, StoreError> {
        log::directory(&self.directory)
    }
    pub fn create(
        &self,
        input: &NewConversation<'_>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        self.create_with_model(input, None, cancel)
    }

    pub fn create_with_model(
        &self,
        input: &NewConversation<'_>,
        model: Option<&ConversationModelSelection<'_>>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        log::check_cancel(cancel)?;
        if let Some(model) = model {
            model.validate()?;
        }
        if input.title.is_empty()
            || input.title.len() > 1024
            || !["chat", "plan", "goal"].contains(&input.mode)
            || !timestamp(input.created_at)
            || input.workspace_path.is_some_and(|p| p.len() > 16_384)
        {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = locks(&directory, None, cancel)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, cancel)?;
        let mut meta = json!({"id":uuid::Uuid::new_v4().to_string(),"title":input.title,"workspacePath":input.workspace_path,"mode":input.mode,"fastMode":false,"preferredExecutionIsolation":"none","effort":"default","modelProviderId":null,"status":"active","archivedAt":null,"lastReadAt":input.created_at,"pinnedAt":null,"pinnedOrder":null,"messageCount":0,"contentRevision":0,"contextSnapshot":null,"createdAt":input.created_at,"updatedAt":input.created_at});
        if let Some(model) = model {
            model.apply(&mut meta);
        }
        preview(&mut meta, &[]);
        index.push(meta.clone());
        log::replace(&file, &log::encode(&index)?, cancel)?;
        Ok(meta)
    }
    /// Create a canonical `project_agent` or `work_session` conversation in the shared index.
    pub fn create_project_conversation(
        &self,
        input: &NewProjectConversation<'_>,
        model: Option<&ConversationModelSelection<'_>>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        log::check_cancel(cancel)?;
        if let Some(model) = model {
            model.validate()?;
        }
        if input.title.is_empty()
            || input.title.len() > 1024
            || !valid_id(input.workspace_id, true)
            || !matches!(input.role, "project_agent" | "work_session")
            || !matches!(input.mode, "chat" | "plan" | "goal" | "project_agent")
            || !timestamp(input.created_at)
            || input.workspace_path.is_some_and(|p| p.len() > 16_384)
            || input
                .parent_conversation_id
                .is_some_and(|id| !valid_id(id, false))
            || input.id.is_some_and(|id| !valid_id(id, false))
        {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = locks(&directory, None, cancel)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, cancel)?;
        let id = input
            .id
            .map(str::to_owned)
            .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        if index.iter().any(|row| row["id"] == id) {
            return Err(StoreError::VersionChanged);
        }
        let mut meta = json!({
            "id": id,
            "title": input.title,
            "workspacePath": input.workspace_path,
            "workspaceId": input.workspace_id,
            "role": input.role,
            "mode": input.mode,
            "fastMode": false,
            "preferredExecutionIsolation": "none",
            "effort": "default",
            "modelProviderId": null,
            "status": "active",
            "archivedAt": null,
            "lastReadAt": input.created_at,
            "pinnedAt": null,
            "pinnedOrder": null,
            "messageCount": 0,
            "contentRevision": 0,
            "contextSnapshot": null,
            "createdAt": input.created_at,
            "updatedAt": input.created_at
        });
        if let Some(parent) = input.parent_conversation_id {
            meta["parentConversationId"] = json!(parent);
        }
        if let Some(model) = model {
            model.apply(&mut meta);
        }
        preview(&mut meta, &[]);
        index.push(meta.clone());
        log::replace(&file, &log::encode(&index)?, cancel)?;
        Ok(meta)
    }
    /// Append a message to a conversation using the canonical index→body lock,
    /// returning `already_committed = true` if an identical message id already exists.
    pub fn append_message_idempotent(
        &self,
        conversation_id: &str,
        message: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<MessageCommit, StoreError> {
        let current = self.read_committed(conversation_id, None, log::MAX_BYTES)?;
        if let Some(existing) = current
            .history
            .messages
            .iter()
            .find(|m| m["id"] == message["id"])
        {
            if existing != message {
                return Err(StoreError::VersionChanged);
            }
            return Ok(MessageCommit {
                snapshot: current,
                already_committed: true,
            });
        }
        self.commit_message(&current, message, at, cancel)
    }
    /// Change the ordinary chat model before acknowledging the selection.
    /// An executing or unreconciled conversation still owns its metadata.
    pub fn update_chat_model(
        &self,
        id: &str,
        workspace: &str,
        model: &ConversationModelSelection<'_>,
        at: &str,
    ) -> Result<(), StoreError> {
        model.validate()?;
        if !valid_id(id, false) || !timestamp(at) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = locks(&directory, Some(id), None)?;
        let file = directory.join("index.jsonl");
        let version = files::identity(&file)?;
        let mut index = log::read(&file, None)?;
        let pos = position(&index, id)?;
        let row = &mut index[pos];
        if row["workspacePath"] != workspace
            || row["mode"] != "chat"
            || !row["parentConversationId"].is_null()
            || !row["role"].is_null() && row["role"] != "chat"
        {
            return Err(StoreError::OutOfScope);
        }
        if crate::conversation_execution::decode(row, id)?.is_some_and(|run| !run.permits_new_run())
            || files::identity(&directory.join(format!("{id}.stream.json")))?.is_some()
        {
            return Err(StoreError::ExecutionBusy);
        }
        if model.matches(row) {
            // A retry after rename with uncertain durability must still sync.
            return log::sync_dir(&directory);
        }
        model.apply(row);
        row["updatedAt"] = json!(at);
        let bytes = log::encode(&index)?;
        if files::identity(&file)? != version {
            return Err(StoreError::VersionChanged);
        }
        log::replace(&file, &bytes, None)
    }

    /// CAS protects both logical revision and actual source identity. A repeated
    /// identical message id is a read receipt, never another append or execution.
    pub fn commit_message(
        &self,
        expected: &HistorySnapshot,
        message: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<MessageCommit, StoreError> {
        self.commit_inner(expected, message, at, cancel, || Ok(()))
    }
    fn commit_inner(
        &self,
        expected: &HistorySnapshot,
        message: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
        after_body: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<MessageCommit, StoreError> {
        log::check_cancel(cancel)?;
        let id = &expected.history.conversation_id;
        if !valid_id(id, false)
            || !timestamp(at)
            || !message.is_object()
            || !message["id"]
                .as_str()
                .is_some_and(|v| !v.is_empty() && v.len() <= 200)
            || !["user", "assistant", "tool"].contains(&message["role"].as_str().unwrap_or(""))
        {
            return Err(StoreError::InvalidInput);
        }
        if message["role"] == "user"
            && message["content"]
                .as_str()
                .is_none_or(|s| peer_protocol::javascript_trim(s).is_empty())
            && message["attachments"].as_array().is_none_or(Vec::is_empty)
        {
            return Err(StoreError::InvalidInput);
        }
        log::encode(std::slice::from_ref(message))?;
        let directory = self.write_directory()?;
        let _held = locks(&directory, Some(id), cancel)?;
        let current = self.read_committed(id, None, log::MAX_BYTES)?;
        if current.history.excluded_from_message_id.is_some() {
            return Err(StoreError::StreamStateInvalid);
        }
        let body = directory.join(format!("{id}.jsonl"));
        let mut rows = log::read(&body, cancel)?;
        validate_messages(&rows)?;
        let index_file = directory.join("index.jsonl");
        let mut index = log::read(&index_file, cancel)?;
        let pos = position(&index, id)?;
        if index[pos]["messageCount"].as_u64() != Some(rows.len() as u64) {
            return Err(StoreError::CommitUncertain);
        }
        if let Some(old) = rows.iter().find(|v| v["id"] == message["id"]) {
            if old != message {
                return Err(StoreError::VersionChanged);
            }
            return Ok(MessageCommit {
                snapshot: current,
                already_committed: true,
            });
        }
        if current.history.content_revision != expected.history.content_revision
            || current.source_revision != expected.source_revision
        {
            return Err(StoreError::VersionChanged);
        }
        let next_revision = revision(&index[pos])? + 1;
        rows.push(message.clone());
        log::encode(&rows)?;
        index[pos]["messageCount"] = json!(rows.len());
        index[pos]["contentRevision"] = json!(next_revision);
        index[pos]["contextSnapshot"] = Value::Null;
        index[pos]["updatedAt"] = json!(at);
        preview(&mut index[pos], &rows);
        let next_index = log::encode(&index)?;
        current.check_index(&index_file)?;
        log::append(&body, &log::encode(std::slice::from_ref(message))?, cancel)?;
        // From this point failure is indeterminate to the caller. A retry must
        // reconcile canonical body/index, never discard the durable body.
        after_body().map_err(|_| StoreError::CommitUncertain)?;
        current
            .check_index(&index_file)
            .map_err(|_| StoreError::CommitUncertain)?;
        log::replace(&index_file, &next_index, None).map_err(|_| StoreError::CommitUncertain)?;
        Ok(MessageCommit {
            snapshot: self.read_committed(id, Some(next_revision), log::MAX_BYTES)?,
            already_committed: false,
        })
    }
    /// Host-owned offline reconciliation. Repairs only derived metadata from a
    /// fully valid canonical body; no message, grant, Evidence or lock is removed.
    /// Tool outcomes still require their own ledger/handle reconciliation.
    pub fn reconcile_index(
        &self,
        id: &str,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<HistorySnapshot, StoreError> {
        log::check_cancel(cancel)?;
        if !valid_id(id, false) || !timestamp(at) {
            return Err(StoreError::InvalidInput);
        }
        let directory = self.write_directory()?;
        let _held = locks(&directory, Some(id), cancel)?;
        if files::identity(&directory.join(format!("{id}.stream.json")))?.is_some() {
            return Err(StoreError::StreamStateInvalid);
        }
        let body = directory.join(format!("{id}.jsonl"));
        let before = files::identity(&body)?;
        let rows = log::read(&body, cancel)?;
        validate_messages(&rows)?;
        let file = directory.join("index.jsonl");
        let mut index = log::read(&file, cancel)?;
        let pos = position(&index, id)?;
        if before.is_none() && revision(&index[pos])? > 0 {
            return Err(StoreError::HistoryMissing);
        }
        if index[pos]["messageCount"]
            .as_u64()
            .is_some_and(|count| count > rows.len() as u64)
        {
            // Fewer canonical rows is data loss, not an interrupted append.
            return Err(StoreError::HistoryMissing);
        }
        if index[pos]["messageCount"].as_u64() != Some(rows.len() as u64) {
            index[pos]["messageCount"] = json!(rows.len());
            index[pos]["contentRevision"] = json!(revision(&index[pos])? + 1);
            index[pos]["contextSnapshot"] = Value::Null;
            index[pos]["updatedAt"] = json!(at);
            preview(&mut index[pos], &rows);
            let bytes = log::encode(&index)?;
            if files::identity(&body)? != before {
                return Err(StoreError::VersionChanged);
            }
            log::replace(&file, &bytes, cancel)?;
        }
        self.read_committed(id, None, log::MAX_BYTES)
    }
    #[cfg(feature = "test-fixtures")]
    pub fn commit_message_fixture(
        &self,
        expected: &HistorySnapshot,
        message: &Value,
        at: &str,
        crash: bool,
    ) -> Result<MessageCommit, StoreError> {
        self.commit_inner(expected, message, at, None, || {
            if crash {
                std::process::exit(77)
            }
            Err(StoreError::ReadFailed)
        })
    }
}
