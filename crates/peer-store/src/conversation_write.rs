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

/// Host creation intent. UI text/metadata cannot choose a persisted id.
pub struct NewConversation<'a> {
    pub title: &'a str,
    pub workspace_path: Option<&'a str>,
    pub mode: &'a str,
    pub created_at: &'a str,
}
#[derive(Debug)]
pub struct MessageCommit {
    pub snapshot: HistorySnapshot,
    pub already_committed: bool,
}
fn timestamp(at: &str) -> bool {
    at.len() <= 64
        && time::OffsetDateTime::parse(at, &time::format_description::well_known::Rfc3339).is_ok()
}
fn locks(
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
fn revision(meta: &Value) -> Result<u64, StoreError> {
    meta["contentRevision"]
        .as_u64()
        .filter(|v| *v < 9_007_199_254_740_991)
        .ok_or(StoreError::HistoryCorrupt)
}
fn position(index: &[Value], id: &str) -> Result<usize, StoreError> {
    let mut found = None;
    for (i, row) in index.iter().enumerate() {
        if row["id"] == id && found.replace(i).is_some() {
            return Err(StoreError::HistoryCorrupt);
        }
    }
    found.ok_or(StoreError::NotFound)
}
fn validate_messages(rows: &[Value]) -> Result<(), StoreError> {
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
    fn write_directory(&self) -> Result<PathBuf, StoreError> {
        log::directory(&self.directory)
    }
    pub fn create(
        &self,
        input: &NewConversation<'_>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        log::check_cancel(cancel)?;
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
        preview(&mut meta, &[]);
        index.push(meta.clone());
        log::replace(&file, &log::encode(&index)?, cancel)?;
        Ok(meta)
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
        log::append(&body, &log::encode(std::slice::from_ref(message))?, cancel)?;
        // From this point failure is indeterminate to the caller. A retry must
        // reconcile canonical body/index, never discard the durable body.
        after_body().map_err(|_| StoreError::CommitUncertain)?;
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
