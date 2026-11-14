//! Canonical journal authority, distinct from the rebuildable coordination SQL
//! cache. No event is skipped because its Runtime reducer is unavailable.
use crate::{
    FenceError, LeaseToken, StoreError,
    coordination_fence::{self, storage::Storage},
};
use peer_protocol::CoordinationReducer;
use serde_json::{Value, json};
use std::{fmt, sync::atomic::AtomicBool};
mod initialize;
mod read_model;
mod replay;
mod write;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CoordinationError {
    Store(StoreError),
    Fence(FenceError),
    Missing,
    HeadPending,
    CommitUncertain,
    Invalid,
    Corrupt,
    Schema,
    Changed,
    Hash,
    Revision,
    PartialTail,
    PayloadMissing,
    Limit,
    Read,
    Reducer(&'static str),
}
impl CoordinationError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Store(e) => e.code(),
            Self::Fence(e) => e.code(),
            Self::Missing => "coordination_recovery_pending",
            Self::HeadPending => "coordination_durable_pending_projection",
            Self::CommitUncertain => "coordination_durable_pending_projection",
            Self::Invalid => "coordination_entry_invalid",
            Self::Corrupt => "coordination_journal_invalid",
            Self::Schema => "coordination_schema_unsupported",
            Self::Changed => "coordination_read_changed",
            Self::Hash => "coordination_hash_mismatch",
            Self::Revision => "coordination_revision_gap",
            Self::PartialTail => "coordination_partial_tail",
            Self::PayloadMissing => "coordination_payload_missing",
            Self::Limit => "coordination_native_resource_limit",
            Self::Read => "coordination_read_failed",
            Self::Reducer(code) => code,
        }
    }
}
impl fmt::Display for CoordinationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for CoordinationError {}
impl From<StoreError> for CoordinationError {
    fn from(e: StoreError) -> Self {
        Self::Store(e)
    }
}
impl From<FenceError> for CoordinationError {
    fn from(e: FenceError) -> Self {
        Self::Fence(e)
    }
}
#[derive(Debug)]
pub struct CoordinationSnapshot {
    pub state: Value,
    pub source_revision: String,
    pub generation: String,
    pub hash: String,
    pub durable_head_revision: u64,
    pub minimum_writer_version: u64,
    pub physically_fenced: bool,
}
/// Owns the unique lease handle. The Host serializes this Store and heartbeats;
/// dropping it never releases a lease or manufactures an execution stop.
pub struct CoordinationStore {
    lease: LeaseToken,
}
fn file_token(v: &crate::files::FileIdentity) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        v.dev, v.ino, v.size, v.modified_ns, v.changed_ns
    )
}
fn hash_valid(s: &str) -> bool {
    s.is_empty()
        || s.len() == 64
            && s.bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn segments(storage: &Storage<'_>) -> Result<Vec<String>, CoordinationError> {
    let path = storage.path("coordination-v2/segments")?;
    let mut files = Vec::new();
    match std::fs::read_dir(path) {
        Ok(entries) => {
            for (i, entry) in entries.enumerate() {
                if i >= 4096 {
                    return Err(CoordinationError::Limit);
                }
                let entry = entry.map_err(|_| CoordinationError::Read)?;
                let name = entry.file_name();
                let name = name.to_str().ok_or(CoordinationError::Corrupt)?;
                if name.len() == 18
                    && name.ends_with(".jsonl")
                    && name[..12].bytes().all(|b| b.is_ascii_digit())
                {
                    files.push(format!("coordination-v2/segments/{name}"));
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
        Err(_) => return Err(CoordinationError::Read),
    }
    files.sort();
    if files
        .iter()
        .enumerate()
        .any(|(i, file)| !file.ends_with(&format!("/{:012}.jsonl", i + 1)))
    {
        return Err(CoordinationError::Corrupt);
    }
    Ok(files)
}
impl CoordinationStore {
    pub fn new(lease: LeaseToken) -> Self {
        Self { lease }
    }
    pub fn lease(&self) -> &LeaseToken {
        &self.lease
    }
    pub fn heartbeat(&mut self, now_ms: i64) -> Result<(), CoordinationError> {
        Ok(self.lease.heartbeat(now_ms)?)
    }
    pub fn into_lease(self) -> LeaseToken {
        self.lease
    }
    pub fn read(
        &self,
        reducer: &impl CoordinationReducer,
        cancel: Option<&AtomicBool>,
    ) -> Result<CoordinationSnapshot, CoordinationError> {
        let storage = Storage::new(&self.lease, cancel)?;
        storage.guard()?;
        let metadata_paths = [
            "coordination-v2/manifest.json",
            "coordination-v2/head.json",
            "coordination-v2/legacy-seal.json",
            "coordination-fence.json",
            "coordination-recovery.json",
        ];
        let metadata_before: Vec<_> = metadata_paths
            .iter()
            .map(|p| storage.token(p))
            .collect::<Result<_, _>>()?;
        let manifest = storage
            .json("coordination-v2/manifest.json")?
            .ok_or(CoordinationError::Missing)?;
        let floor = coordination_fence::floor(&manifest)?;
        let head = storage
            .json("coordination-v2/head.json")?
            .ok_or(CoordinationError::Missing)?;
        coordination_fence::check_head(&manifest, &head)?;
        let head_revision = head["revision"]
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(CoordinationError::Corrupt)?;
        let head_hash = head["hash"]
            .as_str()
            .filter(|s| hash_valid(s))
            .ok_or(CoordinationError::Corrupt)?;
        if head["minimumWriterVersion"].as_u64().unwrap_or(2) > floor {
            return Err(CoordinationError::Schema);
        }
        for relative in ["coordination-fence.json", "coordination-recovery.json"] {
            if let Some(marker) = storage.json(relative)? {
                if marker["schemaVersion"] != 1 {
                    return Err(CoordinationError::Schema);
                }
                if marker["status"] != "complete" {
                    return Err(CoordinationError::Missing);
                }
            }
        }
        let fenced = floor >= 3;
        if fenced {
            coordination_fence::already_protected(&storage, &manifest)?;
        }
        let legacy = if fenced {
            "coordination-v2/baseline.jsonl"
        } else {
            "coordination.jsonl"
        };
        if !fenced
            && storage.token(legacy)?
                != manifest["legacyVersion"]
                    .as_str()
                    .ok_or(CoordinationError::Corrupt)?
        {
            return Err(CoordinationError::Changed);
        }
        let mut paths = vec![
            "coordination-v2/manifest.json".to_owned(),
            "coordination-v2/head.json".to_owned(),
            "coordination-v2/legacy-seal.json".to_owned(),
            "coordination-fence.json".to_owned(),
            "coordination-recovery.json".to_owned(),
            legacy.to_owned(),
        ];
        let sources = segments(&storage)?;
        paths.extend(sources.iter().cloned());
        let before: Vec<_> = paths
            .iter()
            .map(|p| storage.token(p))
            .collect::<Result<_, _>>()?;
        let mut replay = replay::Replay {
            state: json!({"revision":0,"events":{},"works":{},"deliveries":{}}),
            hash: String::new(),
            head_revision,
            head_hash,
            head_seen: head_revision == 0 && head_hash.is_empty(),
            total: 0,
            reducer,
            blobs: Vec::new(),
            records: 0,
            minimum_format: 2,
        };
        let (bytes, sha256) = replay.source(&storage, legacy, false)?;
        if let Some(seal) = storage.json("coordination-v2/legacy-seal.json")? {
            coordination_fence::check_seal(&storage, &manifest, None)?;
            if seal["bytes"].as_u64() != Some(bytes) || seal["sha256"] != sha256 {
                return Err(CoordinationError::Hash);
            }
        } else if storage.token(legacy)?
            != manifest["legacyVersion"]
                .as_str()
                .ok_or(CoordinationError::Corrupt)?
        {
            return Err(CoordinationError::Changed);
        }
        for source in &sources {
            replay.source(&storage, source, true)?;
        }
        if replay.minimum_format > floor {
            return Err(CoordinationError::Schema);
        }
        if !replay.head_seen
            || replay.state["revision"]
                .as_u64()
                .ok_or(CoordinationError::Corrupt)?
                < head_revision
        {
            return Err(CoordinationError::Hash);
        }
        if segments(&storage)? != sources {
            return Err(CoordinationError::Changed);
        }
        for (path, token) in &replay.blobs {
            if storage.token(path)? != *token {
                return Err(CoordinationError::Changed);
            }
        }
        if metadata_paths
            .iter()
            .map(|p| storage.token(p))
            .collect::<Result<Vec<_>, _>>()?
            != metadata_before
        {
            return Err(CoordinationError::Changed);
        }
        let after: Vec<_> = paths
            .iter()
            .map(|p| storage.token(p))
            .collect::<Result<_, _>>()?;
        if before != after {
            return Err(CoordinationError::Changed);
        }
        storage.guard()?;
        let source_revision = peer_protocol::javascript_json_digest(&json!(before))
            .map_err(|_| CoordinationError::Limit)?;
        Ok(CoordinationSnapshot {
            state: read_model::project(&replay.state)?,
            source_revision,
            generation: manifest["generation"].as_str().unwrap().to_owned(),
            hash: replay.hash,
            durable_head_revision: head_revision,
            minimum_writer_version: floor,
            physically_fenced: fenced,
        })
    }
}
