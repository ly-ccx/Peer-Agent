use super::*;

pub(super) type Version = (u64, u64, u64, i128, i128);

#[cfg(unix)]
mod imp {
    use super::*;
    use rustix::fs::{AtFlags, FlockOperation, Mode, OFlags};
    use std::os::unix::fs::MetadataExt;

    pub(in crate::tool_artifacts) fn version(file: &File) -> Result<Version, Error> {
        let m = file.metadata().map_err(|_| Error::Unavailable)?;
        // A crash between publication and unlink can leave two names for the same
        // verified body. Retain both; link count alone is not evidence of damage.
        if !m.is_file() || m.mode() & 0o777 != 0o600 || m.nlink() == 0 {
            return Err(Error::Corrupt);
        }
        Ok((
            m.dev(),
            m.ino(),
            m.len(),
            i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
            i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()),
        ))
    }

    fn failure(e: rustix::io::Errno) -> Error {
        match e {
            rustix::io::Errno::NOENT => Error::Missing,
            rustix::io::Errno::LOOP | rustix::io::Errno::NOTDIR => Error::Invalid,
            _ => Error::Unavailable,
        }
    }

    fn identity(file: &File) -> Result<(u64, u64), Error> {
        let m = file.metadata().map_err(|_| Error::Unavailable)?;
        if !m.is_dir() {
            return Err(Error::Invalid);
        }
        Ok((m.dev(), m.ino()))
    }

    fn directory_at(parent: &File, name: &str) -> Result<File, Error> {
        rustix::fs::openat(
            parent,
            name,
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )
        .map(File::from)
        .map_err(failure)
    }

    /// All mutations are relative to held FDs. Path identity is checked before a
    /// receipt is returned, so replacement cannot redirect writes outside the store.
    pub(in crate::tool_artifacts) struct Directory {
        home_path: PathBuf,
        home: File,
        parent: File,
        body: File,
        body_name: String,
        directory: File,
        name: String,
    }

    impl Directory {
        pub fn open(
            home: &Path,
            conversation: &str,
            create: bool,
            cancel: &impl Fn() -> bool,
        ) -> Result<Self, Error> {
            if !valid_id(conversation, false) {
                return Err(Error::Invalid);
            }
            check(cancel)?;
            let home_file = rustix::fs::open(
                home,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(failure)?;
            let parent = directory_at(&home_file, "conversations")?;
            // A blob cannot create or resurrect a conversation. The host owns its
            // metadata/lease; this check also rejects a missing or special body.
            let body = rustix::fs::openat(
                &parent,
                format!("{conversation}.jsonl"),
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(failure)?;
            if !body.metadata().map_err(|_| Error::Unavailable)?.is_file() {
                return Err(Error::Invalid);
            }
            let name = format!("{conversation}.tool-results");
            let directory = match directory_at(&parent, &name) {
                Ok(file) => file,
                Err(Error::Missing) if create => {
                    match rustix::fs::mkdirat(&parent, &name, Mode::from_raw_mode(0o700)) {
                        Ok(()) => parent.sync_all().map_err(|_| Error::CommitUnknown)?,
                        Err(rustix::io::Errno::EXIST) => (),
                        Err(e) => return Err(failure(e)),
                    }
                    directory_at(&parent, &name)?
                }
                Err(e) => return Err(e),
            };
            if directory.metadata().map_err(|_| Error::Unavailable)?.mode() & 0o777 != 0o700 {
                return Err(Error::Invalid);
            }
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                check(cancel)?;
                match rustix::fs::flock(&directory, FlockOperation::NonBlockingLockExclusive) {
                    Ok(()) => break,
                    Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR)
                        if Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => {
                        return Err(Error::Busy);
                    }
                    Err(_) => return Err(Error::Unavailable),
                }
            }
            let result = Self {
                home_path: home.into(),
                home: home_file,
                parent,
                body,
                body_name: format!("{conversation}.jsonl"),
                directory,
                name,
            };
            result.check_path()?;
            Ok(result)
        }

        pub fn check_path(&self) -> Result<(), Error> {
            let home = rustix::fs::open(
                &self.home_path,
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(|_| Error::Changed)?;
            if identity(&home)? != identity(&self.home)? {
                return Err(Error::Changed);
            }
            let parent = directory_at(&home, "conversations").map_err(|_| Error::Changed)?;
            let directory = directory_at(&parent, &self.name).map_err(|_| Error::Changed)?;
            if identity(&parent)? != identity(&self.parent)?
                || identity(&directory)? != identity(&self.directory)?
            {
                return Err(Error::Changed);
            }
            let current = rustix::fs::statat(&parent, &self.body_name, AtFlags::SYMLINK_NOFOLLOW)
                .map_err(|_| Error::Changed)?;
            let body = rustix::fs::fstat(&self.body).map_err(|_| Error::Unavailable)?;
            if !rustix::fs::FileType::from_raw_mode(current.st_mode).is_file()
                || (current.st_dev, current.st_ino) != (body.st_dev, body.st_ino)
            {
                return Err(Error::Changed);
            }
            Ok(())
        }

        pub fn exists(&self, name: &str) -> Result<bool, Error> {
            match rustix::fs::statat(&self.directory, name, AtFlags::SYMLINK_NOFOLLOW) {
                Ok(_) => Ok(true),
                Err(rustix::io::Errno::NOENT) => Ok(false),
                Err(e) => Err(failure(e)),
            }
        }

        pub fn file(&self, name: &str) -> Result<File, Error> {
            let file = rustix::fs::openat(
                &self.directory,
                name,
                OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
                Mode::empty(),
            )
            .map(File::from)
            .map_err(failure)?;
            version(&file)?;
            Ok(file)
        }

        pub fn same_file(&self, name: &str, file: &File) -> Result<bool, Error> {
            Ok(version(&self.file(name)?)? == version(file)?)
        }

        pub fn capacity(&self, bytes: u64, cancel: &impl Fn() -> bool) -> Result<(), Error> {
            let mut count = 0usize;
            let mut total = bytes;
            let mut names = 0usize;
            let entries = rustix::fs::Dir::read_from(&self.directory).map_err(failure)?;
            for entry in entries {
                check(cancel)?;
                let entry = entry.map_err(failure)?;
                let name = entry.file_name();
                if matches!(name.to_bytes(), b"." | b"..") {
                    continue;
                }
                count += 1;
                names = names.saturating_add(name.to_bytes().len());
                if count >= MAX_ENTRIES || names > MAX_PATH_BYTES {
                    return Err(Error::Limit);
                }
                let stat = rustix::fs::statat(&self.directory, name, AtFlags::SYMLINK_NOFOLLOW)
                    .map_err(failure)?;
                if !rustix::fs::FileType::from_raw_mode(stat.st_mode).is_file() {
                    return Err(Error::Corrupt);
                }
                total =
                    total.saturating_add(u64::try_from(stat.st_size).map_err(|_| Error::Corrupt)?);
                if total > MAX_CONVERSATION {
                    return Err(Error::Limit);
                }
            }
            Ok(())
        }

        pub fn create(&self, name: &str) -> Result<File, Error> {
            self.check_path()?;
            rustix::fs::openat(
                &self.directory,
                name,
                OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::from_raw_mode(0o600),
            )
            .map(File::from)
            .map_err(failure)
        }

        pub fn sync(&self) -> Result<(), Error> {
            self.directory.sync_all().map_err(|_| Error::CommitUnknown)
        }

        pub fn publish(&self, temp: &str, name: &str) -> Result<(), Error> {
            self.check_path()?;
            // linkat is atomic and never replaces an existing content address.
            rustix::fs::linkat(
                &self.directory,
                temp,
                &self.directory,
                name,
                AtFlags::empty(),
            )
            .map_err(|e| {
                if e == rustix::io::Errno::EXIST {
                    Error::Changed
                } else {
                    failure(e)
                }
            })?;
            self.sync()?;
            rustix::fs::unlinkat(&self.directory, temp, AtFlags::empty())
                .map_err(|_| Error::CommitUnknown)?;
            self.sync()
        }
    }
}

#[cfg(windows)]
mod imp {
    use super::*;
    use crate::{
        StoreError,
        platform::{
            DIR_LOCK_NAME, DirectoryGuard, FILE_FLAG_OPEN_REPARSE_POINT, directory_path_identity,
            is_reparse_point, metadata_dev_ino, metadata_times_ns, open_readonly_nofollow,
        },
    };
    use std::{fs::OpenOptions, os::windows::fs::OpenOptionsExt};

    pub(in crate::tool_artifacts) fn version(file: &File) -> Result<Version, Error> {
        let m = file.metadata().map_err(|_| Error::Unavailable)?;
        if !m.is_file() || is_reparse_point(&m) {
            return Err(Error::Corrupt);
        }
        let (dev, ino) = metadata_dev_ino(&m);
        let (modified_ns, changed_ns) = metadata_times_ns(&m);
        Ok((dev, ino, m.len(), modified_ns, changed_ns))
    }

    fn map_io(err: io::Error) -> Error {
        match err.kind() {
            io::ErrorKind::NotFound => Error::Missing,
            io::ErrorKind::InvalidInput => Error::Invalid,
            _ => Error::Unavailable,
        }
    }

    fn check_dir(path: &Path) -> Result<(u64, u64), Error> {
        match std::fs::symlink_metadata(path) {
            Ok(meta) => {
                if !meta.is_dir() || meta.file_type().is_symlink() || is_reparse_point(&meta) {
                    return Err(Error::Invalid);
                }
                Ok(metadata_dev_ino(&meta))
            }
            Err(e) => Err(map_io(e)),
        }
    }

    pub(in crate::tool_artifacts) struct Directory {
        home_path: PathBuf,
        home_id: (u64, u64),
        parent_path: PathBuf,
        parent_id: (u64, u64),
        body_path: PathBuf,
        body_id: (u64, u64),
        directory_path: PathBuf,
        dir_id: (u64, u64),
        _guard: DirectoryGuard,
    }

    impl Directory {
        pub fn open(
            home: &Path,
            conversation: &str,
            create: bool,
            cancel: &impl Fn() -> bool,
        ) -> Result<Self, Error> {
            if !valid_id(conversation, false) {
                return Err(Error::Invalid);
            }
            check(cancel)?;
            let home_path = home.to_path_buf();
            let home_id = check_dir(&home_path)?;
            let parent_path = home_path.join("conversations");
            let parent_id = check_dir(&parent_path)?;
            let body_path = parent_path.join(format!("{conversation}.jsonl"));
            let body_file = open_readonly_nofollow(&body_path).map_err(map_io)?;
            let body_meta = body_file.metadata().map_err(|_| Error::Unavailable)?;
            if !body_meta.is_file() || is_reparse_point(&body_meta) {
                return Err(Error::Invalid);
            }
            let body_id = metadata_dev_ino(&body_meta);
            let directory_path = parent_path.join(format!("{conversation}.tool-results"));
            let dir_id = match check_dir(&directory_path) {
                Ok(id) => id,
                Err(Error::Missing) if create => {
                    match std::fs::create_dir(&directory_path) {
                        Ok(()) => {}
                        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
                        Err(e) => return Err(map_io(e)),
                    }
                    check_dir(&directory_path)?
                }
                Err(e) => return Err(e),
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            let guard = loop {
                check(cancel)?;
                match DirectoryGuard::lock_nonblocking(&directory_path) {
                    Ok(guard) => break guard,
                    Err(StoreError::LockBusy) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(StoreError::LockBusy) => return Err(Error::Busy),
                    Err(_) => return Err(Error::Unavailable),
                }
            };
            let result = Self {
                home_path,
                home_id,
                parent_path,
                parent_id,
                body_path,
                body_id,
                directory_path,
                dir_id,
                _guard: guard,
            };
            result.check_path()?;
            Ok(result)
        }

        pub fn check_path(&self) -> Result<(), Error> {
            if directory_path_identity(&self.home_path).map_err(|_| Error::Changed)? != self.home_id
                || directory_path_identity(&self.parent_path).map_err(|_| Error::Changed)?
                    != self.parent_id
                || directory_path_identity(&self.directory_path).map_err(|_| Error::Changed)?
                    != self.dir_id
            {
                return Err(Error::Changed);
            }
            let current = std::fs::symlink_metadata(&self.body_path).map_err(|_| Error::Changed)?;
            if !current.is_file()
                || current.file_type().is_symlink()
                || is_reparse_point(&current)
                || metadata_dev_ino(&current) != self.body_id
            {
                return Err(Error::Changed);
            }
            Ok(())
        }

        pub fn exists(&self, name: &str) -> Result<bool, Error> {
            match std::fs::symlink_metadata(self.directory_path.join(name)) {
                Ok(_) => Ok(true),
                Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(false),
                Err(e) => Err(map_io(e)),
            }
        }

        pub fn file(&self, name: &str) -> Result<File, Error> {
            let file = open_readonly_nofollow(&self.directory_path.join(name)).map_err(map_io)?;
            version(&file)?;
            Ok(file)
        }

        pub fn same_file(&self, name: &str, file: &File) -> Result<bool, Error> {
            Ok(version(&self.file(name)?)? == version(file)?)
        }

        pub fn capacity(&self, bytes: u64, cancel: &impl Fn() -> bool) -> Result<(), Error> {
            let mut count = 0usize;
            let mut total = bytes;
            let mut names = 0usize;
            let entries = std::fs::read_dir(&self.directory_path).map_err(map_io)?;
            for entry in entries {
                check(cancel)?;
                let entry = entry.map_err(map_io)?;
                let name = entry.file_name();
                if name == DIR_LOCK_NAME {
                    continue;
                }
                count += 1;
                names = names.saturating_add(name.to_string_lossy().len());
                if count >= MAX_ENTRIES || names > MAX_PATH_BYTES {
                    return Err(Error::Limit);
                }
                let meta = std::fs::symlink_metadata(entry.path()).map_err(map_io)?;
                if !meta.is_file() || meta.file_type().is_symlink() || is_reparse_point(&meta) {
                    return Err(Error::Corrupt);
                }
                total = total.saturating_add(meta.len());
                if total > MAX_CONVERSATION {
                    return Err(Error::Limit);
                }
            }
            Ok(())
        }

        pub fn create(&self, name: &str) -> Result<File, Error> {
            self.check_path()?;
            let file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(self.directory_path.join(name))
                .map_err(map_io)?;
            let meta = file.metadata().map_err(|_| Error::Unavailable)?;
            if !meta.is_file() || is_reparse_point(&meta) {
                return Err(Error::Invalid);
            }
            Ok(file)
        }

        pub fn sync(&self) -> Result<(), Error> {
            Ok(())
        }

        pub fn publish(&self, temp: &str, name: &str) -> Result<(), Error> {
            self.check_path()?;
            let from = self.directory_path.join(temp);
            let to = self.directory_path.join(name);
            std::fs::hard_link(&from, &to).map_err(|e| {
                if e.kind() == io::ErrorKind::AlreadyExists {
                    Error::Changed
                } else {
                    map_io(e)
                }
            })?;
            std::fs::remove_file(&from).map_err(|_| Error::CommitUnknown)?;
            Ok(())
        }
    }
}

pub(super) use imp::{Directory, version};
