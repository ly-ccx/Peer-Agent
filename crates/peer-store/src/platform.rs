//! Platform-specific filesystem primitives with zero `unsafe` code.
//! Unix keeps strict FD-relative / `O_NOFOLLOW` / `flock` / `renameat_with`
//! semantics; Windows uses `FILE_FLAG_OPEN_REPARSE_POINT` and `fs2` locks.
use crate::StoreError;
#[cfg(windows)]
use std::fs::{self, OpenOptions};
use std::{
    fs::{File, Metadata},
    io,
    path::Path,
};

#[cfg(windows)]
pub(crate) const DIR_LOCK_NAME: &str = ".peer-dir.lock";

#[cfg(windows)]
pub(crate) const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
#[cfg(windows)]
const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
#[cfg(windows)]
pub(crate) const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;

pub(crate) fn sync_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

pub(crate) fn metadata_dev_ino(meta: &Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // JS safe-integer mask (2^53 - 1). In 100ns NTFS ticks this covers
        // ~28.5 years without wrapping and stays invariant across writes and renames.
        const MAX_SAFE_INT: u64 = 9_007_199_254_740_991;
        let dev = if meta.is_dir() { 2 } else { 1 };
        let ino = meta.creation_time() & MAX_SAFE_INT;
        (dev, ino)
    }
}

pub(crate) fn metadata_times_ns(meta: &Metadata) -> (i128, i128) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let modified = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
        let changed = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
        (modified, changed)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const WINDOWS_TO_UNIX_EPOCH_100NS: i128 = 116_444_736_000_000_000;
        let modified = (i128::from(meta.last_write_time()) - WINDOWS_TO_UNIX_EPOCH_100NS) * 100;
        let changed = (i128::from(meta.creation_time()) - WINDOWS_TO_UNIX_EPOCH_100NS) * 100;
        (modified, changed)
    }
}

pub(crate) fn metadata_nlink_is_one(meta: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        meta.nlink() == 1
    }
    #[cfg(not(unix))]
    {
        meta.is_file()
    }
}

#[cfg(windows)]
pub(crate) fn is_reparse_point(meta: &Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    (meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT) != 0
}

#[cfg(windows)]
pub(crate) fn open_directory_identity(path: &Path) -> io::Result<same_file::Handle> {
    use std::os::windows::fs::OpenOptionsExt;
    // Hold the actual NTFS file identity with the handle open. Creation time
    // can be reused when another directory replaces this path immediately.
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(path)?;
    let meta = file.metadata()?;
    if !meta.is_dir() || is_reparse_point(&meta) {
        return Err(io::Error::other("not a directory"));
    }
    same_file::Handle::from_file(file)
}

pub(crate) fn open_readonly_nofollow(path: &Path) -> io::Result<File> {
    #[cfg(unix)]
    {
        let fd = rustix::fs::open(
            path,
            rustix::fs::OFlags::RDONLY
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::NONBLOCK
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::empty(),
        )?;
        Ok(File::from(fd))
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let pre = fs::symlink_metadata(path)?;
        if pre.file_type().is_symlink() || is_reparse_point(&pre) || !pre.is_file() {
            return Err(io::Error::other("not a regular file"));
        }
        let file = OpenOptions::new()
            .read(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let opened = file.metadata()?;
        if is_reparse_point(&opened) || !opened.is_file() {
            return Err(io::Error::other("symlink or non-regular file"));
        }
        Ok(file)
    }
}

/// Atomically create a private file if absent.
/// Returns `Ok(true)` if newly created, `Ok(false)` if it already existed.
pub(crate) fn create_new_private_file(path: &Path) -> io::Result<bool> {
    #[cfg(unix)]
    {
        match rustix::fs::open(
            path,
            rustix::fs::OFlags::CREATE
                | rustix::fs::OFlags::EXCL
                | rustix::fs::OFlags::RDWR
                | rustix::fs::OFlags::NOFOLLOW
                | rustix::fs::OFlags::CLOEXEC,
            rustix::fs::Mode::RUSR | rustix::fs::Mode::WUSR,
        ) {
            Ok(fd) => {
                drop(fd);
                Ok(true)
            }
            Err(rustix::io::Errno::EXIST) => Ok(false),
            Err(error) => Err(error.into()),
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        match OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
        {
            Ok(file) => {
                drop(file);
                Ok(true)
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(error) => Err(error),
        }
    }
}

pub(crate) fn directory_path_identity(path: &Path) -> io::Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use rustix::fs::{Mode, OFlags};
        let fd = rustix::fs::open(
            path,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?;
        let file = File::from(fd);
        let meta = file.metadata()?;
        Ok(metadata_dev_ino(&meta))
    }
    #[cfg(windows)]
    {
        let meta = fs::symlink_metadata(path)?;
        if !meta.is_dir() || meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(io::Error::other("not a directory"));
        }
        Ok(metadata_dev_ino(&meta))
    }
}

pub(crate) fn rename_noreplace(from: &Path, to: &Path) -> Result<(), StoreError> {
    #[cfg(unix)]
    {
        use rustix::fs::{CWD, RenameFlags, renameat_with};
        renameat_with(CWD, from, CWD, to, RenameFlags::NOREPLACE).map_err(|e| {
            if e == rustix::io::Errno::EXIST {
                StoreError::LockBusy
            } else {
                StoreError::ReadFailed
            }
        })
    }
    #[cfg(windows)]
    {
        match fs::symlink_metadata(to) {
            Ok(_) => return Err(StoreError::LockBusy),
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(_) => return Err(StoreError::ReadFailed),
        }
        fs::rename(from, to).map_err(|e| {
            if e.kind() == io::ErrorKind::AlreadyExists {
                StoreError::LockBusy
            } else {
                StoreError::ReadFailed
            }
        })
    }
}

/// Exclusive non-blocking directory lock.
/// On Unix, holds an `O_DIRECTORY | O_CLOEXEC` FD with `flock`.
/// On Windows, holds an `fs2` exclusive lock on `<dir>/.peer-dir.lock` and
/// records the directory's `(dev, ino)` identity for subsequent verification.
pub(crate) struct DirectoryGuard {
    #[cfg(unix)]
    file: File,
    #[cfg(windows)]
    _lock: File,
    #[cfg(windows)]
    dir_identity: (u64, u64),
}

impl DirectoryGuard {
    pub(crate) fn lock_nonblocking(path: &Path) -> Result<Self, StoreError> {
        #[cfg(unix)]
        {
            use rustix::fs::{FlockOperation, Mode, OFlags};
            let file = rustix::fs::open(
                path,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(|_| StoreError::ReadFailed)?;
            rustix::fs::flock(&file, FlockOperation::NonBlockingLockExclusive).map_err(|e| {
                if matches!(e, rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) {
                    StoreError::LockBusy
                } else {
                    StoreError::ReadFailed
                }
            })?;
            Ok(Self { file })
        }
        #[cfg(windows)]
        {
            use fs2::FileExt;
            use std::os::windows::fs::OpenOptionsExt;
            let dir_identity = directory_path_identity(path).map_err(|_| StoreError::ReadFailed)?;
            let lock_path = path.join(DIR_LOCK_NAME);
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&lock_path)
                .map_err(|_| StoreError::ReadFailed)?;
            let meta = lock.metadata().map_err(|_| StoreError::ReadFailed)?;
            if is_reparse_point(&meta) || !meta.is_file() {
                return Err(StoreError::ReadFailed);
            }
            lock.try_lock_exclusive().map_err(|e| {
                if e.kind() == io::ErrorKind::WouldBlock || e.raw_os_error() == Some(33)
                /* ERROR_LOCK_VIOLATION */
                {
                    StoreError::LockBusy
                } else {
                    StoreError::ReadFailed
                }
            })?;
            Ok(Self {
                _lock: lock,
                dir_identity,
            })
        }
    }

    pub(crate) fn identity(&self) -> io::Result<(u64, u64)> {
        #[cfg(unix)]
        {
            let meta = self.file.metadata()?;
            Ok(metadata_dev_ino(&meta))
        }
        #[cfg(windows)]
        {
            Ok(self.dir_identity)
        }
    }

    pub(crate) fn check_path(&self, path: &Path) -> Result<(), StoreError> {
        let held = self.identity().map_err(|_| StoreError::ReadFailed)?;
        let current =
            directory_path_identity(path).map_err(|_| StoreError::LockOwnershipChanged)?;
        if held != current {
            return Err(StoreError::LockOwnershipChanged);
        }
        Ok(())
    }
}
