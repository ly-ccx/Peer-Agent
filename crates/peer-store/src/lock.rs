use crate::StoreError;
#[cfg(unix)]
use crate::{files, identity};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
    thread,
    time::{Duration, Instant},
};

/// Uses exactly the existing TS `${file}.lock` mkdir protocol; never expires it.
pub struct DirectoryLock {
    path: PathBuf,
    #[cfg(unix)]
    identity: files::FileIdentity,
    #[cfg(windows)]
    identity: same_file::Handle,
    owned: bool,
}

impl DirectoryLock {
    pub fn check_owned(&self) -> Result<(), StoreError> {
        if !self.owned || !self.path_still_owned()? {
            return Err(StoreError::LockOwnershipChanged);
        }
        Ok(())
    }

    fn path_still_owned(&self) -> Result<bool, StoreError> {
        #[cfg(unix)]
        {
            Ok(identity(&self.path)?.as_ref() == Some(&self.identity))
        }
        #[cfg(windows)]
        {
            Ok(crate::platform::open_directory_identity(&self.path)
                .is_ok_and(|current| current == self.identity))
        }
    }
    pub fn acquire(
        file: &Path,
        timeout: Duration,
        cancelled: Option<&AtomicBool>,
    ) -> Result<Self, StoreError> {
        let mut name = file.as_os_str().to_owned();
        name.push(".lock");
        let path = PathBuf::from(name);
        let began = Instant::now();
        loop {
            if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                return Err(StoreError::Cancelled);
            }
            match fs::create_dir(&path) {
                Ok(()) => {
                    #[cfg(unix)]
                    let version = identity(&path)?.ok_or(StoreError::LockOwnershipChanged)?;
                    #[cfg(windows)]
                    let version = crate::platform::open_directory_identity(&path)
                        .map_err(|_| StoreError::LockOwnershipChanged)?;
                    let lock = Self {
                        path,
                        identity: version,
                        owned: true,
                    };
                    if cancelled.is_some_and(|flag| flag.load(Ordering::Acquire)) {
                        drop(lock);
                        return Err(StoreError::Cancelled);
                    }
                    return Ok(lock);
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                    if began.elapsed() >= timeout {
                        return Err(StoreError::LockBusy);
                    }
                    thread::sleep(
                        Duration::from_millis(5).min(timeout.saturating_sub(began.elapsed())),
                    );
                }
                Err(_) => return Err(StoreError::ReadFailed),
            }
        }
    }

    fn unlock(&mut self) -> Result<(), StoreError> {
        let ownership = self.check_owned();
        self.owned = false;
        ownership?;
        // Never recursively delete an unknown lock body or replacement owner.
        fs::remove_dir(&self.path).map_err(|_| StoreError::LockOwnershipChanged)
    }
    pub fn release(mut self) -> Result<(), StoreError> {
        self.unlock()
    }
}

impl Drop for DirectoryLock {
    fn drop(&mut self) {
        if self.owned {
            let _ = self.unlock();
        }
    }
}
