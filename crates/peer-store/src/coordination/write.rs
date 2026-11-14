use super::{
    CoordinationError as Error, CoordinationSnapshot, CoordinationStore, Storage, segments,
};
use crate::{durable_jsonl as log, files};
use peer_protocol::{CoordinationReducer, javascript_json_digest, javascript_json_string};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Seek, SeekFrom, Write},
    sync::atomic::AtomicBool,
};
pub(super) fn semantic_floor(entry: &Value, state: &Value) -> u64 {
    let kind = entry["kind"].as_str().unwrap_or("");
    if ["obligation_grant", "execution_obligation"].contains(&kind) {
        return 11;
    }
    if kind == "session_control" {
        return if entry["minimumExecutorVersion"].as_u64().unwrap_or(0) >= 9 {
            9
        } else {
            7
        };
    }
    if kind.starts_with("intent_")
        || entry["mandate"]["intentSchemaVersion"] == 1
        || [
            "reply_committed",
            "reply_settlement_started",
            "reply_settlement_failed",
            "reply_settled",
            "reply_deferred",
            "reply_held",
            "reply_aggregated",
        ]
        .contains(&kind)
    {
        return if entry["minimumExecutorVersion"].as_u64().unwrap_or(0) >= 9 {
            9
        } else {
            8
        };
    }
    if kind == "agent_execution_completed"
        || state["transitions"].as_object().is_some_and(|rows| {
            rows.values()
                .any(|r| r["minimumExecutorVersion"] == 3 || r.get("reconciliationRef").is_some())
        })
        || state["agentCommands"]
            .as_object()
            .is_some_and(|rows| rows.values().any(|r| r["completionRecorded"] == true))
    {
        return 6;
    }
    if kind.starts_with("agent_") || ["work_note_written", "context_window_opened"].contains(&kind)
    {
        return 5;
    }
    if kind.starts_with("history_") {
        return 4;
    }
    2
}
fn head(storage: &Storage<'_>) -> Result<Value, Error> {
    storage
        .json("coordination-v2/head.json")?
        .ok_or(Error::Missing)
}
fn same_source(
    current: &CoordinationSnapshot,
    expected: &CoordinationSnapshot,
) -> Result<(), Error> {
    if current.source_revision != expected.source_revision
        || current.generation != expected.generation
        || current.hash != expected.hash
        || current.state["revision"] != expected.state["revision"]
    {
        return Err(Error::Changed);
    }
    Ok(())
}
fn put_blob(storage: &Storage<'_>, hash: &str, bytes: &[u8]) -> Result<(), Error> {
    storage.mkdir("coordination-v2/blobs")?;
    let relative = format!("coordination-v2/blobs/{hash}.json");
    let path = storage.path(&relative)?;
    if let Some(existing) = files::read(&path, 1024 * 1024)? {
        if existing != bytes {
            return Err(Error::Hash);
        }
        return Ok(());
    }
    let parent = path.parent().ok_or(Error::Invalid)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| Error::Read)?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| Error::Read)?;
    storage.guard()?;
    temp.persist_noclobber(&path).map_err(|_| Error::Changed)?;
    log::sync_dir(parent)?;
    Ok(())
}
impl CoordinationStore {
    /// Canonical replay must pass before physical promotion; re-read after it.
    pub fn prepare(
        &mut self,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
    ) -> Result<CoordinationSnapshot, Error> {
        let storage = Storage::new(&self.lease, cancel)?;
        if let Some(intent) = storage.json("coordination-fence.json")?
            && intent["status"] == "prepared"
        {
            crate::protect_coordination_writer(&self.lease, cancel)?;
        }
        let manifest = storage
            .json("coordination-v2/manifest.json")?
            .ok_or(Error::Missing)?;
        let floor = crate::coordination_fence::floor(&manifest)?;
        let durable_head = head(&storage)?;
        crate::coordination_fence::check_head(&manifest, &durable_head)?;
        let head_floor = durable_head["minimumWriterVersion"].as_u64().unwrap_or(2);
        if head_floor > floor {
            if ![3, 4, 5, 6, 7, 8, 9, 11, 12].contains(&head_floor) {
                return Err(Error::Schema);
            }
            let mut raised = manifest.clone();
            raised["minimumReaderVersion"] = json!(head_floor);
            raised["minimumWriterVersion"] = json!(head_floor);
            crate::coordination_fence::already_protected(&storage, &raised)?;
            storage.publish("coordination-v2/manifest.json", &raised, &[Some(&manifest)])?;
        }
        let before = self.read(reducer, cancel)?;
        crate::protect_coordination_writer(&self.lease, cancel)?;
        let after = self.read(reducer, cancel)?;
        if before.state != after.state || before.hash != after.hash {
            return Err(Error::Changed);
        }
        Ok(after)
    }
    /// A complete canonical tail may be durable while its head receipt lags.
    /// Checkpointing records that existing tail only; no tool is replayed or ended.
    pub fn checkpoint_head(
        &mut self,
        expected: &CoordinationSnapshot,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
    ) -> Result<CoordinationSnapshot, Error> {
        let current = self.read(reducer, cancel)?;
        same_source(&current, expected)?;
        if !current.physically_fenced {
            return Err(Error::Missing);
        }
        if current.state["revision"].as_u64() == Some(current.durable_head_revision) {
            return Ok(current);
        }
        let storage = Storage::new(&self.lease, cancel)?;
        let old = head(&storage)?;
        let mut next = old.clone();
        next["revision"] = current.state["revision"].clone();
        next["hash"] = json!(current.hash);
        next["minimumWriterVersion"] = json!(current.minimum_writer_version);
        storage.publish("coordination-v2/head.json", &next, &[Some(&old)])?;
        self.read(reducer, cancel)
    }
    pub fn append(
        &mut self,
        expected: &CoordinationSnapshot,
        event: &Value,
        now_ms: i64,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
    ) -> Result<CoordinationSnapshot, Error> {
        self.append_inner(expected, event, now_ms, reducer, cancel, || Ok(()))
    }
    fn append_inner(
        &mut self,
        expected: &CoordinationSnapshot,
        event: &Value,
        now_ms: i64,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
        after_body: impl FnOnce() -> Result<(), Error>,
    ) -> Result<CoordinationSnapshot, Error> {
        log::check_cancel(cancel)?;
        let current = self.read(reducer, cancel)?;
        same_source(&current, expected)?;
        if !current.physically_fenced {
            return Err(Error::Missing);
        }
        if current.state["revision"].as_u64() != Some(current.durable_head_revision) {
            return Err(Error::HeadPending);
        }
        if !event.is_object()
            || event["kind"]
                .as_str()
                .is_none_or(|s| s.is_empty() || s == "payload_ref")
            || [
                "schemaVersion",
                "storageVersion",
                "revision",
                "previousHash",
                "hash",
                "epoch",
                "at",
            ]
            .iter()
            .any(|k| event.get(k).is_some())
        {
            return Err(Error::Invalid);
        }
        let storage = Storage::new(&self.lease, cancel)?;
        let mut admitted = event.clone();
        admitted["epoch"] = json!(format!(
            "{}:{}",
            self.lease.record().host_id,
            self.lease.record().acquired_at
        ));
        admitted["at"] = json!(crate::lease::stamp(now_ms)?);
        let revision = current
            .durable_head_revision
            .checked_add(1)
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(Error::Limit)?;
        let mut validation = admitted.clone();
        validation["revision"] = json!(revision);
        validation["schemaVersion"] = json!(1);
        let next_state = reducer
            .reduce(&current.state, &validation)
            .map_err(Error::Reducer)?;
        if next_state["revision"].as_u64() != Some(revision) {
            return Err(Error::Revision);
        }
        let required = semantic_floor(&validation, &next_state).max(current.minimum_writer_version);
        if required > current.minimum_writer_version {
            let old_manifest = storage
                .json("coordination-v2/manifest.json")?
                .ok_or(Error::Missing)?;
            let mut manifest = old_manifest.clone();
            manifest["minimumWriterVersion"] = json!(required);
            manifest["minimumReaderVersion"] = json!(required);
            let old_head = head(&storage)?;
            let mut promoted = old_head.clone();
            promoted["minimumWriterVersion"] = json!(required);
            storage.publish("coordination-v2/head.json", &promoted, &[Some(&old_head)])?;
            storage.publish(
                "coordination-v2/manifest.json",
                &manifest,
                &[Some(&old_manifest)],
            )?;
        }
        let encoded = javascript_json_string(&admitted).map_err(|_| Error::Limit)?;
        let mut record = if encoded.len() > 60 * 1024 || admitted["kind"] == "work_note_written" {
            let hash = format!("{:x}", Sha256::digest(encoded.as_bytes()));
            put_blob(&storage, &hash, encoded.as_bytes())?;
            json!({"kind":"payload_ref","payloadRef":{"hash":hash,"bytes":encoded.len()}})
        } else {
            admitted
        };
        record["schemaVersion"] = json!(1);
        record["storageVersion"] = json!(2);
        record["previousHash"] = json!(current.hash);
        record["revision"] = json!(revision);
        let hash = javascript_json_digest(&record).map_err(|_| Error::Limit)?;
        record["hash"] = json!(hash);
        let mut bytes = javascript_json_string(&record)
            .map_err(|_| Error::Limit)?
            .into_bytes();
        bytes.push(b'\n');
        if bytes.len() > 64 * 1024 {
            return Err(Error::Limit);
        }
        let sources = segments(&storage)?;
        let mut target = sources.last().cloned();
        if let Some(source) = &target {
            let (_, identity) = storage
                .file(source, 64 * 1024 * 1024)?
                .ok_or(Error::Changed)?;
            if identity.size + bytes.len() as u64 > 32 * 1024 * 1024 {
                target = None
            }
        }
        storage.mkdir("coordination-v2/segments")?;
        let target = target
            .unwrap_or_else(|| format!("coordination-v2/segments/{:012}.jsonl", sources.len() + 1));
        if let Some((mut file, identity)) = storage.file(&target, 32 * 1024 * 1024)?
            && identity.size > 0
        {
            file.seek(SeekFrom::End(-1)).map_err(|_| Error::Read)?;
            let mut tail = [0];
            file.read_exact(&mut tail).map_err(|_| Error::Read)?;
            if tail[0] != b'\n' {
                bytes.insert(0, b'\n');
            }
        }
        storage.guard()?;
        log::append_to_limit(&storage.path(&target)?, &bytes, 32 * 1024 * 1024, cancel)
            .map_err(|_| Error::CommitUncertain)?;
        after_body().map_err(|_| Error::CommitUncertain)?;
        storage.guard().map_err(|_| Error::CommitUncertain)?;
        let old = head(&storage)?;
        let mut next = old.clone();
        next["revision"] = json!(revision);
        next["hash"] = json!(hash);
        next["minimumWriterVersion"] = json!(required);
        storage
            .publish("coordination-v2/head.json", &next, &[Some(&old)])
            .map_err(|_| Error::CommitUncertain)?;
        self.read(reducer, cancel)
            .map_err(|_| Error::CommitUncertain)
    }
    #[cfg(feature = "test-fixtures")]
    pub fn append_fixture(
        &mut self,
        expected: &CoordinationSnapshot,
        event: &Value,
        now_ms: i64,
        reducer: &impl CoordinationReducer,
        crash: bool,
    ) -> Result<CoordinationSnapshot, Error> {
        self.append_inner(expected, event, now_ms, reducer, None, || {
            if crash {
                std::process::exit(77)
            }
            Err(Error::Read)
        })
    }
}
