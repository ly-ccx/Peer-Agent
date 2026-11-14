//! Bounded fact logs. Callers hold their existing file lock and Host ownership.
//! A partial final row blocks writers; it is never silently discarded.
use crate::{StoreError, files};
use peer_protocol::{JsonDecodeError, JsonLimits, decode_json_bounded, javascript_json_string};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

pub(crate) const MAX_BYTES: usize = 8 * 1024 * 1024;
pub(crate) fn check_cancel(cancel: Option<&AtomicBool>) -> Result<(), StoreError> {
    if cancel.is_some_and(|v| v.load(Ordering::Acquire)) {
        Err(StoreError::Cancelled)
    } else {
        Ok(())
    }
}
pub(crate) fn directory(path: &Path) -> Result<PathBuf, StoreError> {
    if !path.exists() {
        let parent = path.parent().ok_or(StoreError::InvalidInput)?;
        let parent = if parent.exists() {
            fs::canonicalize(parent).map_err(|_| StoreError::ReadFailed)?
        } else {
            directory(parent)?
        };
        let target = parent.join(path.file_name().ok_or(StoreError::InvalidInput)?);
        match fs::create_dir(&target) {
            Ok(()) => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    fs::set_permissions(&target, fs::Permissions::from_mode(0o700))
                        .map_err(|_| StoreError::ReadFailed)?;
                }
                sync_dir(&parent)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => (),
            Err(_) => return Err(StoreError::ReadFailed),
        }
    }
    let meta = fs::symlink_metadata(path).map_err(|_| StoreError::ReadFailed)?;
    if !meta.is_dir() {
        return Err(StoreError::ReadFailed);
    }
    fs::canonicalize(path).map_err(|_| StoreError::ReadFailed)
}
pub(crate) fn read(path: &Path, cancel: Option<&AtomicBool>) -> Result<Vec<Value>, StoreError> {
    check_cancel(cancel)?;
    let Some(bytes) = files::read(path, MAX_BYTES)? else {
        return Ok(Vec::new());
    };
    if !bytes.is_empty() && bytes.last() != Some(&b'\n') {
        return Err(StoreError::HistoryCorrupt);
    }
    let mut limits = JsonLimits {
        bytes: MAX_BYTES,
        nodes: 65_536,
        depth: 64,
        string_bytes: MAX_BYTES,
    };
    let mut rows = Vec::new();
    for line in bytes.split(|b| *b == b'\n') {
        check_cancel(cancel)?;
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        if rows.len() >= 4096 {
            return Err(StoreError::HistoryLimit);
        }
        let row = decode_json_bounded(line, limits).map_err(|e| match e {
            JsonDecodeError::LimitExceeded => StoreError::HistoryLimit,
            _ => StoreError::HistoryCorrupt,
        })?;
        if !row.value.is_object() {
            return Err(StoreError::HistoryCorrupt);
        }
        limits.nodes -= row.nodes;
        limits.string_bytes -= row.string_bytes;
        rows.push(row.value);
    }
    Ok(rows)
}
pub(crate) fn encode(rows: &[Value]) -> Result<Vec<u8>, StoreError> {
    if rows.len() > 4096 {
        return Err(StoreError::HistoryLimit);
    }
    let mut limits = JsonLimits {
        bytes: MAX_BYTES,
        nodes: 65_536,
        depth: 64,
        string_bytes: MAX_BYTES,
    };
    let mut bytes = Vec::new();
    for row in rows {
        let text = javascript_json_string(row).map_err(|_| StoreError::HistoryLimit)?;
        let decoded =
            decode_json_bounded(text.as_bytes(), limits).map_err(|_| StoreError::HistoryLimit)?;
        limits.nodes -= decoded.nodes;
        limits.string_bytes -= decoded.string_bytes;
        bytes.extend_from_slice(text.as_bytes());
        bytes.push(b'\n');
        if bytes.len() > MAX_BYTES {
            return Err(StoreError::HistoryLimit);
        }
    }
    Ok(bytes)
}
pub(crate) fn sync_dir(path: &Path) -> Result<(), StoreError> {
    File::open(path)
        .and_then(|f| f.sync_all())
        .map_err(|_| StoreError::ReadFailed)
}
pub(crate) fn replace(
    path: &Path,
    bytes: &[u8],
    cancel: Option<&AtomicBool>,
) -> Result<(), StoreError> {
    check_cancel(cancel)?;
    let before = files::identity(path)?;
    let parent = path.parent().ok_or(StoreError::InvalidInput)?;
    let mut temp = tempfile::NamedTempFile::new_in(parent).map_err(|_| StoreError::ReadFailed)?;
    temp.write_all(bytes)
        .and_then(|_| temp.as_file().sync_all())
        .map_err(|_| StoreError::ReadFailed)?;
    check_cancel(cancel)?;
    if files::identity(path)? != before {
        return Err(StoreError::VersionChanged);
    }
    if before.is_none() {
        temp.persist_noclobber(path)
            .map_err(|_| StoreError::VersionChanged)?;
    } else {
        // Cooperative read-check-rename, matching the existing Store contract.
        temp.persist(path).map_err(|_| StoreError::ReadFailed)?;
    }
    sync_dir(parent).map_err(|_| StoreError::CommitUncertain)
}
pub(crate) fn append(
    path: &Path,
    bytes: &[u8],
    cancel: Option<&AtomicBool>,
) -> Result<(), StoreError> {
    append_to_limit(path, bytes, MAX_BYTES as u64, cancel)
}
pub(crate) fn append_to_limit(
    path: &Path,
    bytes: &[u8],
    max_file_bytes: u64,
    cancel: Option<&AtomicBool>,
) -> Result<(), StoreError> {
    check_cancel(cancel)?;
    let before = files::identity(path)?;
    let mut options = OpenOptions::new();
    options.write(true).append(true);
    if before.is_none() {
        options.create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32);
    }
    let mut file = options.open(path).map_err(|_| StoreError::ReadFailed)?;
    // files::identity also rejects non-regular paths; opened descriptor identity
    // must still match the path before any write.
    let opened = file.metadata().map_err(|_| StoreError::ReadFailed)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let current = files::identity(path)?.ok_or(StoreError::VersionChanged)?;
        if !opened.is_file()
            || current.dev != opened.dev()
            || current.ino != opened.ino()
            || before.as_ref().is_some_and(|old| old != &current)
        {
            return Err(StoreError::VersionChanged);
        }
    }
    if opened.len().saturating_add(bytes.len() as u64) > max_file_bytes {
        return Err(StoreError::HistoryLimit);
    }
    check_cancel(cancel)?;
    // Once append starts, sync its actual effect even if cancellation arrives.
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|_| StoreError::CommitUncertain)?;
    sync_dir(path.parent().ok_or(StoreError::InvalidInput)?)
        .map_err(|_| StoreError::CommitUncertain)
}
