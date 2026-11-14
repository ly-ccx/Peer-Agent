//! Existing host.lease storage port. A lease is never a stop receipt, grant,
//! writer fence, or proof that an older external operation has stopped.
use crate::{StoreError, files, valid_id};
pub use peer_protocol::{HostLeaseRecord, HostSurface};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::{Path, PathBuf},
};
use tempfile::NamedTempFile;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub const HOST_LEASE_HEARTBEAT_MS: i64 = 5_000;
pub const HOST_LEASE_STALE_MS: i64 = 20_000;

/// Supplied by the host composition root, never deserialized from model input.
pub struct HostIdentity {
    host_id: String,
    surface: HostSurface,
    pid: u32,
    app_version: String,
}
impl HostIdentity {
    pub fn new(
        host_id: &str,
        surface: HostSurface,
        pid: u32,
        app_version: &str,
    ) -> Result<Self, StoreError> {
        if host_id.trim().is_empty() || host_id.len() > 256 || pid == 0 || app_version.len() > 256 {
            return Err(StoreError::InvalidInput);
        }
        Ok(Self {
            host_id: host_id.trim().to_owned(),
            surface,
            pid,
            app_version: app_version.to_owned(),
        })
    }
    fn owns(&self, record: &HostLeaseRecord) -> bool {
        self.host_id == record.host_id && self.pid == record.pid
    }
}

struct Snapshot {
    record: HostLeaseRecord,
    raw: Value,
    identity: files::FileIdentity,
}
pub struct HostLeaseStore {
    root: PathBuf,
}
pub enum AcquireLease {
    Acquired { token: LeaseToken, took_over: bool },
    Held(HostLeaseRecord),
}

/// Not auto-released on Drop: the Runtime must settle active work first.
pub struct LeaseToken {
    path: PathBuf,
    record: HostLeaseRecord,
}

fn stamp(ms: i64) -> Result<String, StoreError> {
    let date = OffsetDateTime::from_unix_timestamp_nanos(i128::from(ms) * 1_000_000)
        .map_err(|_| StoreError::InvalidInput)?;
    // Match JS Date.toISOString() millisecond precision for existing records.
    let format = time::format_description::parse_borrowed::<2>(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
    )
    .map_err(|_| StoreError::InvalidInput)?;
    date.format(&format).map_err(|_| StoreError::InvalidInput)
}
fn millis(text: &str) -> Result<i64, StoreError> {
    let date = OffsetDateTime::parse(text, &Rfc3339).map_err(|_| StoreError::LeaseCorrupt)?;
    i64::try_from(date.unix_timestamp_nanos() / 1_000_000).map_err(|_| StoreError::LeaseCorrupt)
}
fn read(path: &Path) -> Result<Option<Snapshot>, StoreError> {
    let before = files::identity(path)?;
    let Some(bytes) = files::read(path, 16 * 1024)? else {
        return Ok(None);
    };
    let raw = decode_json_bounded(
        &bytes,
        JsonLimits {
            bytes: 16 * 1024,
            nodes: 128,
            depth: 8,
            string_bytes: 8192,
        },
    )
    .map_err(|_| StoreError::LeaseCorrupt)?
    .value;
    let mut record: HostLeaseRecord =
        serde_json::from_value(raw.clone()).map_err(|_| StoreError::LeaseCorrupt)?;
    record.host_id = record.host_id.trim().to_owned();
    if record.host_id.is_empty()
        || record.pid == 0
        || record.host_id.len() > 256
        || record.app_version.len() > 256
    {
        return Err(StoreError::LeaseCorrupt);
    }
    record.acquired_at = stamp(millis(&record.acquired_at)?)?;
    record.heartbeat_at = stamp(millis(&record.heartbeat_at)?)?;
    if before != files::identity(path)? {
        return Err(StoreError::VersionChanged);
    }
    Ok(Some(Snapshot {
        record,
        raw,
        identity: before.ok_or(StoreError::VersionChanged)?,
    }))
}
fn temporary(directory: &Path, value: &Value) -> Result<NamedTempFile, StoreError> {
    let mut file = NamedTempFile::new_in(directory).map_err(|_| StoreError::ReadFailed)?;
    serde_json::to_writer(file.as_file_mut(), value).map_err(|_| StoreError::ReadFailed)?;
    file.write_all(b"\n").map_err(|_| StoreError::ReadFailed)?;
    file.as_file()
        .sync_all()
        .map_err(|_| StoreError::ReadFailed)?;
    Ok(file)
}
fn sync_directory(directory: &Path) -> Result<(), StoreError> {
    fs::File::open(directory)
        .and_then(|f| f.sync_all())
        .map_err(|_| StoreError::ReadFailed)
}
fn fresh(record: &HostLeaseRecord, now: i64) -> Result<bool, StoreError> {
    Ok(now.saturating_sub(millis(&record.heartbeat_at)?) < HOST_LEASE_STALE_MS)
}
fn same_generation(a: &HostLeaseRecord, b: &HostLeaseRecord) -> bool {
    a.host_id == b.host_id && a.pid == b.pid && a.acquired_at == b.acquired_at
}

impl HostLeaseStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            root: data_home.as_ref().join("project-runtime"),
        }
    }
    fn path(&self, workspace_id: &str) -> Result<PathBuf, StoreError> {
        if !valid_id(workspace_id, true) {
            return Err(StoreError::InvalidInput);
        }
        Ok(self.root.join(workspace_id).join("host.lease"))
    }
    pub fn inspect(&self, workspace_id: &str) -> Result<Option<HostLeaseRecord>, StoreError> {
        Ok(read(&self.path(workspace_id)?)?.map(|s| s.record))
    }
    pub fn acquire(
        &self,
        workspace_id: &str,
        owner: &HostIdentity,
        now: i64,
    ) -> Result<AcquireLease, StoreError> {
        let path = self.path(workspace_id)?;
        let directory = path.parent().ok_or(StoreError::InvalidInput)?;
        fs::create_dir_all(directory).map_err(|_| StoreError::ReadFailed)?;
        if !fs::symlink_metadata(directory)
            .map_err(|_| StoreError::ReadFailed)?
            .is_dir()
        {
            return Err(StoreError::ReadFailed);
        }
        let at = stamp(now)?;
        let record = HostLeaseRecord {
            host_id: owner.host_id.clone(),
            surface: owner.surface,
            pid: owner.pid,
            app_version: owner.app_version.clone(),
            acquired_at: at.clone(),
            heartbeat_at: at,
        };
        let temporary = temporary(
            directory,
            &serde_json::to_value(&record).map_err(|_| StoreError::InvalidInput)?,
        )?;
        for _ in 0..5 {
            match fs::hard_link(temporary.path(), &path) {
                Ok(()) => {
                    sync_directory(directory)?;
                    return Ok(AcquireLease::Acquired {
                        token: LeaseToken { path, record },
                        took_over: false,
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(_) => return Err(StoreError::ReadFailed),
            }
            let Some(current) = read(&path)? else {
                continue;
            };
            if owner.owns(&current.record) {
                return Ok(AcquireLease::Acquired {
                    token: LeaseToken {
                        path,
                        record: current.record,
                    },
                    took_over: false,
                });
            }
            if fresh(&current.record, now)? {
                return Ok(AcquireLease::Held(current.record));
            }
            let aside = NamedTempFile::new_in(directory).map_err(|_| StoreError::ReadFailed)?;
            if fs::rename(&path, aside.path()).is_err() {
                continue;
            }
            let moved = match read(aside.path()) {
                Ok(Some(value)) => value,
                _ => {
                    // Preserve an unexpected replacement; never silently reclaim it.
                    let _ = fs::hard_link(aside.path(), &path);
                    let _ = aside.keep();
                    return Err(StoreError::LeaseCorrupt);
                }
            };
            if fresh(&moved.record, now)? && !owner.owns(&moved.record) {
                if fs::hard_link(aside.path(), &path).is_err() {
                    let _ = aside.keep();
                    return Err(StoreError::LeaseContended);
                }
                sync_directory(directory)?;
                return Ok(AcquireLease::Held(moved.record));
            }
            match fs::hard_link(temporary.path(), &path) {
                Ok(()) => {
                    sync_directory(directory)?;
                    return Ok(AcquireLease::Acquired {
                        token: LeaseToken { path, record },
                        took_over: true,
                    });
                }
                Err(_) => continue,
            }
        }
        Err(StoreError::LeaseContended)
    }
    /// Writes the existing takeover request; holder still owns draining/settlement.
    pub fn request_takeover(
        &self,
        workspace_id: &str,
        requester: &HostIdentity,
        now: i64,
    ) -> Result<bool, StoreError> {
        let path = self.path(workspace_id)?;
        let Some(current) = read(&path)? else {
            return Ok(false);
        };
        if requester.owns(&current.record) || !fresh(&current.record, now)? {
            return Ok(false);
        }
        let directory = path.parent().ok_or(StoreError::InvalidInput)?;
        let request = json!({"workspaceId":workspace_id,"holderHostId":current.record.host_id,"holderPid":current.record.pid,"requestedAt":stamp(now)?});
        temporary(directory, &request)?
            .persist(directory.join("host.yield"))
            .map_err(|_| StoreError::ReadFailed)?;
        sync_directory(directory)?;
        Ok(true)
    }
}

impl LeaseToken {
    pub fn record(&self) -> &HostLeaseRecord {
        &self.record
    }
    fn current(&self) -> Result<Snapshot, StoreError> {
        let current = read(&self.path)?.ok_or(StoreError::LeaseOwnershipLost)?;
        if !same_generation(&current.record, &self.record) {
            return Err(StoreError::LeaseOwnershipLost);
        }
        Ok(current)
    }
    pub fn holds(&self) -> Result<bool, StoreError> {
        match self.current() {
            Ok(_) => Ok(true),
            Err(StoreError::LeaseOwnershipLost) => Ok(false),
            Err(e) => Err(e),
        }
    }
    pub fn heartbeat(&mut self, now: i64) -> Result<(), StoreError> {
        let current = self.current()?;
        let directory = self.path.parent().ok_or(StoreError::InvalidInput)?;
        let mut next = current.raw;
        next["heartbeatAt"] = stamp(now)?.into();
        let temp = temporary(directory, &next)?;
        if files::identity(&self.path)?.as_ref() != Some(&current.identity) {
            return Err(StoreError::LeaseOwnershipLost);
        }
        // Matches the existing TS protocol; this is not a strong cross-runtime CAS.
        // Actual dispatch and persistence still require execution/resource fences.
        temp.persist(&self.path)
            .map_err(|_| StoreError::ReadFailed)?;
        sync_directory(directory)?;
        self.record.heartbeat_at = stamp(now)?;
        Ok(())
    }
    pub fn takeover_requested(&self) -> Result<bool, StoreError> {
        self.current()?;
        let directory = self.path.parent().ok_or(StoreError::InvalidInput)?;
        let Some(bytes) = files::read(&directory.join("host.yield"), 16 * 1024)? else {
            return Ok(false);
        };
        let request = decode_json_bounded(
            &bytes,
            JsonLimits {
                bytes: 16 * 1024,
                nodes: 128,
                depth: 8,
                string_bytes: 8192,
            },
        )
        .map_err(|_| StoreError::LeaseCorrupt)?
        .value;
        if request["workspaceId"].as_str() != directory.file_name().and_then(|name| name.to_str())
            || request["holderHostId"]
                .as_str()
                .is_none_or(|id| id.trim().is_empty() || id.len() > 256)
            || request["holderPid"]
                .as_u64()
                .is_none_or(|pid| pid == 0 || pid > u64::from(u32::MAX))
        {
            return Err(StoreError::LeaseCorrupt);
        }
        millis(
            request["requestedAt"]
                .as_str()
                .ok_or(StoreError::LeaseCorrupt)?,
        )?;
        Ok(
            request["holderHostId"].as_str() == Some(&self.record.host_id)
                && request["holderPid"].as_u64() == Some(u64::from(self.record.pid)),
        )
    }
    /// Caller must first obtain its real Session Control stop receipt.
    /// No product execution entry exposes this low-level storage port yet.
    pub fn release(self) -> Result<(), StoreError> {
        let current = self.current()?;
        if files::identity(&self.path)?.as_ref() != Some(&current.identity) {
            return Err(StoreError::LeaseOwnershipLost);
        }
        fs::remove_file(&self.path).map_err(|_| StoreError::ReadFailed)?;
        sync_directory(self.path.parent().ok_or(StoreError::InvalidInput)?)
    }
}
