use super::FenceError;
use crate::{LeaseToken, StoreError, files};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};
use tempfile::NamedTempFile;
pub(super) const MAX_BASELINE_BYTES: u64 = 2 * 1024 * 1024 * 1024;
fn version(v: &files::FileIdentity) -> String {
    format!(
        "{}:{}:{}:{}:{}",
        v.dev, v.ino, v.size, v.modified_ns, v.changed_ns
    )
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct ContentProof {
    pub version: String,
    pub bytes: u64,
    pub sha256: String,
}
impl ContentProof {
    pub fn missing() -> Self {
        Self {
            version: "missing".into(),
            bytes: 0,
            sha256: format!("{:x}", Sha256::digest([])),
        }
    }
}
pub(super) struct Storage<'a> {
    directory: PathBuf,
    lease: &'a LeaseToken,
    cancelled: Option<&'a AtomicBool>,
}
impl<'a> Storage<'a> {
    pub fn new(
        lease: &'a LeaseToken,
        cancelled: Option<&'a AtomicBool>,
    ) -> Result<Self, FenceError> {
        Ok(Self {
            directory: fs::canonicalize(lease.directory()?)
                .map_err(|_| FenceError::Store(StoreError::ReadFailed))?,
            lease,
            cancelled,
        })
    }
    pub fn guard(&self) -> Result<(), FenceError> {
        if self.cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
            return Err(StoreError::Cancelled.into());
        }
        if !self.lease.holds()? {
            return Err(StoreError::LeaseOwnershipLost.into());
        }
        Ok(())
    }
    fn path(&self, relative: &str) -> Result<PathBuf, FenceError> {
        let mut path = self.directory.clone();
        for part in Path::new(relative).components() {
            let Component::Normal(part) = part else {
                return Err(FenceError::Invalid);
            };
            path.push(part);
            match fs::symlink_metadata(&path) {
                Ok(meta) if meta.file_type().is_symlink() => return Err(FenceError::Invalid),
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(StoreError::ReadFailed.into()),
            }
        }
        Ok(path)
    }
    pub fn exists(&self, relative: &str) -> Result<bool, FenceError> {
        Ok(files::identity(&self.path(relative)?)?.is_some())
    }
    pub fn is_directory(&self, relative: &str) -> Result<bool, FenceError> {
        match fs::symlink_metadata(self.path(relative)?) {
            Ok(m) => Ok(m.is_dir()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(_) => Err(StoreError::ReadFailed.into()),
        }
    }
    pub fn file(
        &self,
        relative: &str,
        max: u64,
    ) -> Result<Option<(File, files::FileIdentity)>, FenceError> {
        files::open(&self.path(relative)?, max).map_err(|e| {
            if e == StoreError::HistoryLimit {
                FenceError::Limit
            } else {
                e.into()
            }
        })
    }
    pub fn token(&self, relative: &str) -> Result<String, FenceError> {
        Ok(files::identity(&self.path(relative)?)?
            .map_or_else(|| "missing".into(), |v| version(&v)))
    }
    pub fn json(&self, relative: &str) -> Result<Option<Value>, FenceError> {
        let Some(bytes) = files::read(&self.path(relative)?, 256 * 1024).map_err(|e| {
            if e == StoreError::HistoryLimit {
                FenceError::Limit
            } else {
                e.into()
            }
        })?
        else {
            return Ok(None);
        };
        Ok(Some(
            decode_json_bounded(
                &bytes,
                JsonLimits {
                    bytes: 256 * 1024,
                    nodes: 4096,
                    depth: 32,
                    string_bytes: 256 * 1024,
                },
            )
            .map_err(|_| FenceError::Invalid)?
            .value,
        ))
    }
    pub fn hash_or_missing(&self, relative: &str) -> Result<ContentProof, FenceError> {
        if !self.exists(relative)? {
            Ok(ContentProof::missing())
        } else {
            self.hash(relative)
        }
    }
    pub fn hash(&self, relative: &str) -> Result<ContentProof, FenceError> {
        let Some((mut file, before)) = self.file(relative, MAX_BASELINE_BYTES)? else {
            return Err(FenceError::LegacyChanged);
        };
        let mut hash = Sha256::new();
        let mut count = 0u64;
        let mut buffer = [0; 256 * 1024];
        loop {
            self.guard()?;
            let size = file.read(&mut buffer).map_err(|_| StoreError::ReadFailed)?;
            if size == 0 {
                break;
            }
            count += size as u64;
            if count > MAX_BASELINE_BYTES {
                return Err(FenceError::Limit);
            }
            hash.update(&buffer[..size]);
        }
        if count != before.size || files::identity(&self.path(relative)?)?.as_ref() != Some(&before)
        {
            return Err(FenceError::Changed);
        }
        Ok(ContentProof {
            version: version(&before),
            bytes: count,
            sha256: format!("{:x}", hash.finalize()),
        })
    }
    fn sync_dir(path: &Path) -> Result<(), FenceError> {
        File::open(path)
            .and_then(|f| f.sync_all())
            .map_err(|_| FenceError::Store(StoreError::ReadFailed))
    }
    fn create_dir(&self, relative: &str, new_only: bool) -> Result<(), FenceError> {
        self.guard()?;
        let path = self.path(relative)?;
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {}
            Err(e)
                if !new_only
                    && e.kind() == std::io::ErrorKind::AlreadyExists
                    && self.is_directory(relative)? => {}
            Err(_) => return Err(FenceError::Invalid),
        };
        Self::sync_dir(path.parent().ok_or(FenceError::Invalid)?)
    }
    pub fn mkdir(&self, relative: &str) -> Result<(), FenceError> {
        self.create_dir(relative, false)
    }
    pub fn mkdir_new(&self, relative: &str) -> Result<(), FenceError> {
        self.create_dir(relative, true)
    }
    fn persist(
        &self,
        relative: &str,
        temp: NamedTempFile,
        expected: Option<files::FileIdentity>,
    ) -> Result<(), FenceError> {
        temp.as_file()
            .sync_all()
            .map_err(|_| StoreError::ReadFailed)?;
        self.guard()?;
        let path = self.path(relative)?;
        if files::identity(&path)? != expected {
            return Err(FenceError::Changed);
        }
        let published = if expected.is_none() {
            temp.persist_noclobber(&path)
        } else {
            temp.persist(&path)
        };
        published.map_err(|error| {
            if error.error.kind() == std::io::ErrorKind::AlreadyExists {
                FenceError::Changed
            } else {
                StoreError::ReadFailed.into()
            }
        })?;
        Self::sync_dir(path.parent().ok_or(FenceError::Invalid)?)
    }
    pub fn publish(
        &self,
        relative: &str,
        value: &Value,
        allowed: &[Option<&Value>],
    ) -> Result<(), FenceError> {
        self.guard()?;
        let path = self.path(relative)?;
        let before = files::identity(&path)?;
        let current = self.json(relative)?;
        if !allowed.contains(&current.as_ref()) {
            return Err(FenceError::Changed);
        }
        let bytes = serde_json::to_vec(value).map_err(|_| FenceError::Invalid)?;
        if bytes.len() > 256 * 1024 {
            return Err(FenceError::Limit);
        }
        let mut temp = NamedTempFile::new_in(path.parent().ok_or(FenceError::Invalid)?)
            .map_err(|_| StoreError::ReadFailed)?;
        temp.write_all(&bytes).map_err(|_| StoreError::ReadFailed)?;
        self.persist(relative, temp, before)
    }
    pub fn empty(&self, relative: &str) -> Result<(), FenceError> {
        let path = self.path(relative)?;
        let temp = NamedTempFile::new_in(path.parent().ok_or(FenceError::Invalid)?)
            .map_err(|_| StoreError::ReadFailed)?;
        self.persist(relative, temp, None)
    }
    pub fn copy(&self, source: &str, target: &str, max: u64) -> Result<(), FenceError> {
        self.guard()?;
        let Some((mut file, before)) = self.file(source, max)? else {
            return Err(FenceError::Changed);
        };
        let path = self.path(target)?;
        let mut temp = NamedTempFile::new_in(path.parent().ok_or(FenceError::Invalid)?)
            .map_err(|_| StoreError::ReadFailed)?;
        let mut buffer = [0; 256 * 1024];
        let mut total = 0u64;
        loop {
            self.guard()?;
            let size = file.read(&mut buffer).map_err(|_| StoreError::ReadFailed)?;
            if size == 0 {
                break;
            }
            total += size as u64;
            if total > max {
                return Err(FenceError::Limit);
            }
            temp.write_all(&buffer[..size])
                .map_err(|_| StoreError::ReadFailed)?;
        }
        if total != before.size || files::identity(&self.path(source)?)?.as_ref() != Some(&before) {
            return Err(FenceError::Changed);
        }
        self.persist(target, temp, None)
    }
    pub fn rename(&self, source: &str, target: &str) -> Result<(), FenceError> {
        self.guard()?;
        let from = self.path(source)?;
        let to = self.path(target)?;
        if files::identity(&to)?.is_some() {
            return Err(FenceError::Changed);
        }
        fs::rename(&from, &to).map_err(|_| StoreError::ReadFailed)?;
        Self::sync_dir(from.parent().ok_or(FenceError::Invalid)?)?;
        Self::sync_dir(to.parent().ok_or(FenceError::Invalid)?)
    }
}
