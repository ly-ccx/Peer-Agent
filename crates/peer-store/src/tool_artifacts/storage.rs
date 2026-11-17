use super::*;
use rustix::fs::{AtFlags, FlockOperation, Mode, OFlags};
use std::os::unix::fs::MetadataExt;

pub(super) type Version = (u64, u64, u64, i128, i128);
pub(super) fn version(file: &File) -> Result<Version, Error> {
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
pub(super) struct Directory {
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
                Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => return Err(Error::Busy),
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
            total = total.saturating_add(u64::try_from(stat.st_size).map_err(|_| Error::Corrupt)?);
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
