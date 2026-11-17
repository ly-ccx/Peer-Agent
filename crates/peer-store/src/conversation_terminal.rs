//! Existing v1 streaming sidecar and terminal merge, under the shared Store
//! locks. These writes record Host facts; they cannot authorize or run a tool.
use crate::{
    ConversationStore, DirectoryLock, HistorySnapshot, MessageCommit, StoreError,
    conversation_preview::preview,
    conversation_write::{locks, position, revision, timestamp, validate_messages},
    durable_jsonl as log, files, valid_id,
};
use peer_protocol::{JsonLimits, decode_json_bounded, javascript_json_string};
use serde_json::{Value, json};
use std::{path::PathBuf, sync::atomic::AtomicBool};

struct Update {
    directory: PathBuf,
    _locks: Vec<DirectoryLock>,
    current: HistorySnapshot,
    rows: Vec<Value>,
    index: Vec<Value>,
    metadata: usize,
    target: usize,
    sidecar: Option<Value>,
    sidecar_version: Option<files::FileIdentity>,
}
impl Update {
    fn open(
        store: &ConversationStore,
        expected: &HistorySnapshot,
        message: &str,
        patch: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<Self, StoreError> {
        log::check_cancel(cancel)?;
        let id = &expected.history.conversation_id;
        if !valid_id(id, false)
            || message.is_empty()
            || message.len() > 200
            || !patch.is_object()
            || !timestamp(at)
        {
            return Err(StoreError::InvalidInput);
        }
        let directory = store.write_directory()?;
        let held = locks(&directory, Some(id), cancel)?;
        let current = store.read_committed(id, None, log::MAX_BYTES)?;
        if current.source_revision != expected.source_revision
            || current.history.content_revision != expected.history.content_revision
        {
            return Err(StoreError::VersionChanged);
        }
        if current
            .history
            .excluded_from_message_id
            .as_deref()
            .is_some_and(|v| v != message)
        {
            return Err(StoreError::StreamStateInvalid);
        }
        let rows = log::read(&directory.join(format!("{id}.jsonl")), cancel)?;
        validate_messages(&rows)?;
        let target = rows
            .iter()
            .position(|row| row["id"] == message)
            .ok_or(StoreError::StreamTargetMissing)?;
        // A patch cannot silently rename the stable message or its author.
        if patch.get("id").is_some_and(|v| v != &rows[target]["id"])
            || patch
                .get("role")
                .is_some_and(|v| v != &rows[target]["role"])
        {
            return Err(StoreError::InvalidInput);
        }
        let index = log::read(&directory.join("index.jsonl"), cancel)?;
        let metadata = position(&index, id)?;
        if index[metadata]["messageCount"].as_u64() != Some(rows.len() as u64) {
            return Err(StoreError::CommitUncertain);
        }
        let file = directory.join(format!("{id}.stream.json"));
        let sidecar_version = files::identity(&file)?;
        let sidecar = files::read(&file, log::MAX_BYTES)?
            .map(|bytes| {
                decode_json_bounded(
                    &bytes,
                    JsonLimits {
                        bytes: log::MAX_BYTES,
                        nodes: 65_536,
                        depth: 64,
                        string_bytes: log::MAX_BYTES,
                    },
                )
                .map(|d| d.value)
                .map_err(|_| StoreError::StreamStateInvalid)
            })
            .transpose()?;
        if sidecar.as_ref().is_some_and(|v| {
            v["version"].as_f64() != Some(1.0)
                || v["conversationId"] != id.as_str()
                || v["messageId"] != message
                || !v["patch"].is_object()
        }) {
            return Err(StoreError::StreamStateInvalid);
        }
        if files::identity(&file)? != sidecar_version
            || store
                .read_committed(id, None, log::MAX_BYTES)?
                .source_revision
                != current.source_revision
        {
            return Err(StoreError::VersionChanged);
        }
        Ok(Self {
            directory,
            _locks: held,
            current,
            rows,
            index,
            metadata,
            target,
            sidecar,
            sidecar_version,
        })
    }
}
impl ConversationStore {
    /// A full current presentation patch replaces the prior patch; canonical
    /// history and its revision are unchanged, as in the existing TS Store.
    pub fn patch_stream_message(
        &self,
        expected: &HistorySnapshot,
        message: &str,
        patch: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<HistorySnapshot, StoreError> {
        let update = Update::open(self, expected, message, patch, at, cancel)?;
        let id = &expected.history.conversation_id;
        let mut marker = update.sidecar.unwrap_or_else(|| json!({}));
        marker["version"] = json!(1);
        marker["conversationId"] = json!(id);
        marker["messageId"] = json!(message);
        marker["patch"] = patch.clone();
        marker["patchedAt"] = json!(at);
        let encoded = javascript_json_string(&marker).map_err(|_| StoreError::HistoryLimit)?;
        if encoded.len() > log::MAX_BYTES {
            return Err(StoreError::HistoryLimit);
        }
        log::replace(
            &update.directory.join(format!("{id}.stream.json")),
            encoded.as_bytes(),
            cancel,
        )?;
        self.read_committed(id, None, log::MAX_BYTES)
    }
    /// The actual Host supplies its observed final patch. An uncertain commit
    /// requires a fresh source read and the same known facts, never tool replay.
    pub fn commit_terminal_message(
        &self,
        expected: &HistorySnapshot,
        message: &str,
        patch: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<MessageCommit, StoreError> {
        self.commit_terminal_inner(expected, message, patch, at, cancel, |_| Ok(()))
    }
    fn commit_terminal_inner(
        &self,
        expected: &HistorySnapshot,
        message: &str,
        patch: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
        mut after: impl FnMut(&str) -> Result<(), StoreError>,
    ) -> Result<MessageCommit, StoreError> {
        let mut update = Update::open(self, expected, message, patch, at, cancel)?;
        let mut merged = update.rows[update.target].clone();
        merged
            .as_object_mut()
            .unwrap()
            .extend(patch.as_object().unwrap().clone());
        if merged == update.rows[update.target] && update.sidecar.is_none() {
            return Ok(MessageCommit {
                snapshot: update.current,
                already_committed: true,
            });
        }
        update.rows[update.target] = merged;
        let body = log::encode(&update.rows)?;
        let next = revision(&update.index[update.metadata])? + 1;
        update.index[update.metadata]["contentRevision"] = json!(next);
        update.index[update.metadata]["contextSnapshot"] = Value::Null;
        update.index[update.metadata]["updatedAt"] = json!(at);
        preview(&mut update.index[update.metadata], &update.rows);
        let index = log::encode(&update.index)?;
        let id = &expected.history.conversation_id;
        let marker = update.sidecar.clone().unwrap_or_else(|| json!({"version":1,"conversationId":id,"messageId":message,"patch":{},"patchedAt":at}));
        let marker = javascript_json_string(&marker).map_err(|_| StoreError::HistoryLimit)?;
        if body
            .len()
            .saturating_add(index.len())
            .saturating_add(marker.len())
            > log::MAX_BYTES
        {
            return Err(StoreError::HistoryLimit);
        }
        let marker_file = update.directory.join(format!("{id}.stream.json"));
        log::replace(&marker_file, marker.as_bytes(), cancel)?;
        update.sidecar_version = files::identity(&marker_file)?;
        // Once the canonical body is published, finish its metadata and cleanup
        // even after cancellation. Every later failure is indeterminate.
        let finish = (|| {
            after("marker")?;
            log::replace(&update.directory.join(format!("{id}.jsonl")), &body, None)?;
            after("body")?;
            log::replace(&update.directory.join("index.jsonl"), &index, None)?;
            after("index")?;
            let stream = update.directory.join(format!("{id}.stream.json"));
            if files::identity(&stream)? != update.sidecar_version {
                return Err(StoreError::VersionChanged);
            }
            if update.sidecar_version.is_some() {
                std::fs::remove_file(&stream).map_err(|_| StoreError::ReadFailed)?;
                log::sync_dir(&update.directory)?;
            }
            after("sidecar")?;
            Ok::<_, StoreError>(())
        })();
        finish.map_err(|_| StoreError::CommitUncertain)?;
        Ok(MessageCommit {
            snapshot: self
                .read_committed(id, Some(next), log::MAX_BYTES)
                .map_err(|_| StoreError::CommitUncertain)?,
            already_committed: false,
        })
    }
    #[cfg(feature = "test-fixtures")]
    pub fn commit_terminal_fixture(
        &self,
        expected: &HistorySnapshot,
        message: &str,
        patch: &Value,
        at: &str,
        cancel: Option<&AtomicBool>,
        fail_after: &str,
    ) -> Result<MessageCommit, StoreError> {
        self.commit_terminal_inner(expected, message, patch, at, cancel, |stage| {
            if fail_after == format!("cancel:{stage}")
                && let Some(cancel) = cancel
            {
                cancel.store(true, std::sync::atomic::Ordering::Release);
            }
            if fail_after == format!("exit:{stage}")
                && self
                    .directory
                    .parent()
                    .is_some_and(|root| root.join(".native-cli-fixture").is_file())
            {
                std::process::exit(86);
            }
            if stage == fail_after {
                Err(StoreError::ReadFailed)
            } else {
                Ok(())
            }
        })
    }
}
