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

#[cfg(unix)]
fn from_metadata(meta: &Metadata) -> FileIdentity {
    use std::os::unix::fs::MetadataExt;
    FileIdentity {
        dev: meta.dev(),
        ino: meta.ino(),
        size: meta.len(),
        modified_ns: i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec()),
        changed_ns: i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec()),
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

/// Strict bounded read: lstat/open/fstat/read/lstat must describe one file.
pub(crate) fn read(path: &Path, max: usize) -> Result<Option<Vec<u8>>, StoreError> {
    let Some(before) = identity(path)? else {
        return Ok(None);
    };
    if before.size > max as u64 {
        return Err(StoreError::HistoryLimit);
    }
    let fd = rustix::fs::open(
        path,
        rustix::fs::OFlags::RDONLY | rustix::fs::OFlags::NOFOLLOW | rustix::fs::OFlags::NONBLOCK,
        rustix::fs::Mode::empty(),
    )
    .map_err(|_| StoreError::ReadFailed)?;
    let file = File::from(fd);
    let meta = file.metadata().map_err(|_| StoreError::ReadFailed)?;
    if !meta.is_file() || from_metadata(&meta) != before {
        return Err(StoreError::VersionChanged);
    }
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
