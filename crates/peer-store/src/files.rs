use crate::StoreError;
use std::{
    fs::{self, File, Metadata},
    io::Read,
    path::Path,
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct FileIdentity {
    pub dev: u64,
    pub ino: u64,
    pub size: u64,
    pub modified_ns: i128,
    pub changed_ns: i128,
}

fn from_metadata(meta: &Metadata) -> FileIdentity {
    let (dev, ino) = crate::platform::metadata_dev_ino(meta);
    let (modified_ns, changed_ns) = crate::platform::metadata_times_ns(meta);
    FileIdentity {
        dev,
        ino,
        size: meta.len(),
        modified_ns,
        changed_ns,
    }
}

pub(crate) fn identity(path: &Path) -> Result<Option<FileIdentity>, StoreError> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() || meta.is_dir() => Ok(Some(from_metadata(&meta))),
        Ok(_) => Err(StoreError::ReadFailed),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(StoreError::ReadFailed),
    }
}

pub(crate) fn open(path: &Path, max: u64) -> Result<Option<(File, FileIdentity)>, StoreError> {
    let Some(before) = identity(path)? else {
        return Ok(None);
    };
    if before.size > max {
        return Err(StoreError::HistoryLimit);
    }
    let file = crate::platform::open_readonly_nofollow(path).map_err(|_| StoreError::ReadFailed)?;
    let meta = file.metadata().map_err(|_| StoreError::ReadFailed)?;
    if !meta.is_file() || from_metadata(&meta) != before {
        return Err(StoreError::VersionChanged);
    }
    Ok(Some((file, before)))
}

/// Strict bounded read: lstat/open/fstat/read/lstat must describe one file.
pub(crate) fn read(path: &Path, max: usize) -> Result<Option<Vec<u8>>, StoreError> {
    let Some((file, before)) = open(path, max as u64)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    file.take(max as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| StoreError::ReadFailed)?;
    if bytes.len() > max {
        return Err(StoreError::HistoryLimit);
    }
    if bytes.len() as u64 != before.size || identity(path)?.as_ref() != Some(&before) {
        return Err(StoreError::VersionChanged);
    }
    Ok(Some(bytes))
}

pub(crate) fn fingerprint(versions: &[Option<FileIdentity>]) -> String {
    use sha2::{Digest, Sha256};
    let mut hash = Sha256::new();
    for version in versions {
        match version {
            Some(v) => hash.update(format!(
                "{}:{}:{}:{}:{}\n",
                v.dev, v.ino, v.size, v.modified_ns, v.changed_ns
            )),
            None => hash.update(b"missing\n"),
        }
    }
    format!("{:x}", hash.finalize())
}
