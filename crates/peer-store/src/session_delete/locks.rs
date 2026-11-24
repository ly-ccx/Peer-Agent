//! Tickets for this operation's own directories in the shared mkdir protocol.
use crate::{
    StoreError, durable_jsonl as log, files,
    platform::{DirectoryGuard, metadata_dev_ino, rename_noreplace},
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub(super) fn lock_directory(path: &Path) -> Result<DirectoryGuard, StoreError> {
    DirectoryGuard::lock_nonblocking(path)
}

pub(super) fn check_directory(guard: &DirectoryGuard, path: &Path) -> Result<(), StoreError> {
    guard.check_path(path)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Ticket {
    nonce: String,
    device: u64,
    inode: u64,
}

impl Ticket {
    pub(super) fn prepare(index: &Path) -> Result<Self, StoreError> {
        let nonce = uuid::Uuid::new_v4().to_string();
        let parent = index.parent().ok_or(StoreError::InvalidInput)?;
        let path = parent.join(format!(".peer-delete-lock-{nonce}"));
        fs::create_dir(&path).map_err(|_| StoreError::ReadFailed)?;
        log::replace(&path.join("owner"), nonce.as_bytes(), None)?;
        log::sync_dir(parent)?;
        let meta = fs::symlink_metadata(&path).map_err(|_| StoreError::ReadFailed)?;
        let (device, inode) = metadata_dev_ino(&meta);
        Ok(Self {
            nonce,
            device,
            inode,
        })
    }

    pub(super) fn staged(&self, file: &Path) -> Result<PathBuf, StoreError> {
        let uuid = uuid::Uuid::parse_str(&self.nonce).map_err(|_| StoreError::HistoryCorrupt)?;
        if uuid.to_string() != self.nonce {
            return Err(StoreError::HistoryCorrupt);
        }
        Ok(file.with_file_name(format!(".peer-delete-lock-{}", self.nonce)))
    }

    fn matches(&self, path: &Path) -> Result<bool, StoreError> {
        let meta = match fs::symlink_metadata(path) {
            Ok(meta) => meta,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(_) => return Err(StoreError::ReadFailed),
        };
        let (dev, ino) = metadata_dev_ino(&meta);
        if !meta.is_dir() || dev != self.device || ino != self.inode {
            return Ok(false);
        }
        Ok(files::read(&path.join("owner"), 36)?.as_deref() == Some(self.nonce.as_bytes()))
    }

    pub(super) fn acquire(&self, file: &Path) -> Result<Held, StoreError> {
        let staged = self.staged(file)?;
        let mut name = file.as_os_str().to_owned();
        name.push(".lock");
        let installed = PathBuf::from(name);
        if !self.matches(&installed)? {
            if !self.matches(&staged)? {
                return Err(StoreError::LockOwnershipChanged);
            }
            rename_exclusive(&staged, &installed)?;
        }
        let held = Held {
            ticket: self.clone(),
            installed,
            staged,
            owned: true,
        };
        held.check()?;
        log::sync_dir(file.parent().ok_or(StoreError::InvalidInput)?)?;
        Ok(held)
    }

    pub(super) fn discard(&self, file: &Path) -> Result<(), StoreError> {
        let staged = self.staged(file)?;
        if self.matches(&staged)? {
            fs::remove_file(staged.join("owner")).map_err(|_| StoreError::ReadFailed)?;
            fs::remove_dir(&staged).map_err(|_| StoreError::ReadFailed)?;
            log::sync_dir(file.parent().ok_or(StoreError::InvalidInput)?)?;
        }
        Ok(())
    }
}

fn rename_exclusive(from: &Path, to: &Path) -> Result<(), StoreError> {
    rename_noreplace(from, to)
}

pub(super) struct Held {
    ticket: Ticket,
    installed: PathBuf,
    staged: PathBuf,
    owned: bool,
}

impl Held {
    pub(super) fn check(&self) -> Result<(), StoreError> {
        if self.owned && self.ticket.matches(&self.installed)? {
            Ok(())
        } else {
            Err(StoreError::LockOwnershipChanged)
        }
    }

    pub(super) fn release(&mut self) -> Result<(), StoreError> {
        self.check()?;
        rename_exclusive(&self.installed, &self.staged)?;
        self.owned = false;
        log::sync_dir(self.installed.parent().ok_or(StoreError::InvalidInput)?)
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if self.owned {
            let _ = self.release();
        }
    }
}
