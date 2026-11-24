//! Atomic publication of a human-requested reading copy, never a Store write.
#[cfg(test)]
mod tests;
use peer_store::DisplaySnapshot;
use std::{
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Clone, Debug, PartialEq, Eq)]
struct Version {
    dev: u64,
    ino: u64,
    len: u64,
    mtime_ns: i128,
    ctime_ns: i128,
}

fn meta_dev_ino(m: &fs::Metadata) -> (u64, u64) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        (m.dev(), m.ino())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        (if m.is_dir() { 2 } else { 1 }, m.creation_time())
    }
}

fn version(path: &Path) -> io::Result<Option<Version>> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e),
    };
    if !m.is_file() {
        return Err(io::Error::other("export_target_not_regular"));
    }
    let (dev, ino) = meta_dev_ino(&m);
    #[cfg(unix)]
    let (mtime_ns, ctime_ns) = {
        use std::os::unix::fs::MetadataExt;
        (
            i128::from(m.mtime()) * 1_000_000_000 + i128::from(m.mtime_nsec()),
            i128::from(m.ctime()) * 1_000_000_000 + i128::from(m.ctime_nsec()),
        )
    };
    #[cfg(windows)]
    let (mtime_ns, ctime_ns) = {
        use std::os::windows::fs::MetadataExt;
        (
            i128::from(m.last_write_time()),
            i128::from(m.creation_time()),
        )
    };
    Ok(Some(Version {
        dev,
        ino,
        len: m.len(),
        mtime_ns,
        ctime_ns,
    }))
}

fn normalized(path: &Path) -> io::Result<PathBuf> {
    let absolute = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let mut out = PathBuf::new();
    for c in absolute.components() {
        match c {
            Component::ParentDir => {
                out.pop();
            }
            Component::CurDir => {}
            _ => out.push(c.as_os_str()),
        }
    }
    Ok(out)
}

fn resolved(path: &Path) -> io::Result<PathBuf> {
    let mut parent = path;
    let mut tail = Vec::new();
    loop {
        match fs::canonicalize(parent) {
            Ok(mut p) => {
                for c in tail.iter().rev() {
                    p.push(c);
                }
                return Ok(p);
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                tail.push(
                    parent
                        .file_name()
                        .ok_or_else(|| io::Error::other("export_target_invalid"))?
                        .to_owned(),
                );
                parent = parent
                    .parent()
                    .ok_or_else(|| io::Error::other("export_target_invalid"))?;
            }
            Err(e) => return Err(e),
        }
    }
}

pub(super) fn check_cancel(cancel: &AtomicBool) -> io::Result<()> {
    if cancel.load(Ordering::Acquire) {
        Err(io::Error::new(
            io::ErrorKind::Interrupted,
            "export_cancelled",
        ))
    } else {
        Ok(())
    }
}

fn publication_lock(parent: &Path, identity: (u64, u64), cancel: &AtomicBool) -> io::Result<File> {
    #[cfg(unix)]
    {
        let directory = File::open(parent)?;
        let meta = directory.metadata()?;
        if meta_dev_ino(&meta) != identity {
            return Err(io::Error::other("export_target_changed"));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            check_cancel(cancel)?;
            match rustix::fs::flock(
                &directory,
                rustix::fs::FlockOperation::NonBlockingLockExclusive,
            ) {
                Ok(()) => return Ok(directory),
                Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(io::Error::other("export_target_busy"));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
    #[cfg(windows)]
    {
        use fs2::FileExt;
        let meta = fs::metadata(parent)?;
        if meta_dev_ino(&meta) != identity {
            return Err(io::Error::other("export_target_changed"));
        }
        // Keep the lockfile in temp_dir keyed by canonical parent path so the
        // export destination directory is never polluted with extra entries.
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        for byte in parent.to_string_lossy().as_bytes() {
            hash ^= u64::from(*byte);
            hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
        }
        let lock_path = std::env::temp_dir().join(format!("peer-export-{hash:016x}.lock"));
        let lock = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&lock_path)?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            check_cancel(cancel)?;
            match lock.try_lock_exclusive() {
                Ok(()) => return Ok(lock),
                Err(e) if e.kind() == io::ErrorKind::WouldBlock || e.raw_os_error() == Some(33) => {
                    if std::time::Instant::now() >= deadline {
                        return Err(io::Error::other("export_target_busy"));
                    }
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                Err(e) => return Err(e),
            }
        }
    }
}

fn default_sync(file: &File) -> io::Result<()> {
    #[cfg(unix)]
    {
        file.sync_all()
    }
    #[cfg(windows)]
    {
        let _ = file;
        Ok(())
    }
}

fn reserved(path: &Path, home: &Path) -> io::Result<bool> {
    let store = resolved(&normalized(&home.join("conversations"))?)?;
    if path.starts_with(&store) {
        return Ok(true);
    }
    if let Ok(identity) = fs::metadata(&store) {
        let store_id = meta_dev_ino(&identity);
        let mut parent = path.parent();
        while let Some(p) = parent {
            if let Ok(m) = fs::metadata(p)
                && meta_dev_ino(&m) == store_id
            {
                return Ok(true);
            }
            parent = p.parent();
        }
    }
    Ok(false)
}

pub(super) struct Destination {
    original: PathBuf,
    path: PathBuf,
    before: Option<Version>,
    ancestor: PathBuf,
    ancestor_id: (u64, u64),
    permissions: Option<fs::Permissions>,
}

impl Destination {
    pub fn inspect(home: &Path, path: &str, force: bool) -> io::Result<Self> {
        let original = normalized(Path::new(path))?;
        let name = original
            .file_name()
            .ok_or_else(|| io::Error::other("export_target_invalid"))?;
        let path = resolved(original.parent().unwrap())?.join(name);
        if reserved(&path, home)? {
            return Err(io::Error::other("export_target_is_store"));
        }
        let before = version(&path)?;
        if before.is_some() && !force {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "export_target_exists",
            ));
        }
        let permissions = if before.is_some() {
            Some(fs::metadata(&path)?.permissions())
        } else {
            None
        };
        let mut ancestor = path.parent().unwrap().to_path_buf();
        while !ancestor.exists() {
            ancestor = ancestor
                .parent()
                .ok_or_else(|| io::Error::other("export_target_invalid"))?
                .to_path_buf();
        }
        let meta = fs::metadata(&ancestor)?;
        if !meta.is_dir() {
            return Err(io::Error::other("export_target_parent_invalid"));
        }
        Ok(Self {
            original,
            path,
            before,
            ancestor,
            ancestor_id: meta_dev_ino(&meta),
            permissions,
        })
    }

    fn current(&self) -> io::Result<()> {
        let ancestor = fs::metadata(&self.ancestor)?;
        let same = resolved(self.original.parent().unwrap())?
            .join(self.original.file_name().unwrap())
            == self.path;
        if !same
            || meta_dev_ino(&ancestor) != self.ancestor_id
            || version(&self.path)? != self.before
        {
            return Err(io::Error::other("export_target_changed"));
        }
        Ok(())
    }

    pub fn publish(
        &self,
        source: &DisplaySnapshot,
        spool: &mut File,
        cancel: &AtomicBool,
    ) -> io::Result<()> {
        self.publish_with_sync(source, spool, cancel, default_sync)
    }

    fn publish_with_sync(
        &self,
        source: &DisplaySnapshot,
        spool: &mut File,
        cancel: &AtomicBool,
        sync: impl FnOnce(&File) -> io::Result<()>,
    ) -> io::Result<()> {
        check_cancel(cancel)?;
        self.current()?;
        if source
            .aliases_source(&self.path)
            .map_err(|_| io::Error::other("export_target_unavailable"))?
        {
            return Err(io::Error::other("export_target_is_source"));
        }
        let parent = self.path.parent().unwrap();
        fs::create_dir_all(parent)?;
        self.current()?;
        let parent_meta = fs::metadata(parent)?;
        let parent_id = meta_dev_ino(&parent_meta);
        let mut temp = tempfile::NamedTempFile::new_in(parent)?;
        spool.seek(SeekFrom::Start(0))?;
        let mut bytes = [0u8; 65536];
        loop {
            check_cancel(cancel)?;
            let n = spool.read(&mut bytes)?;
            if n == 0 {
                break;
            }
            temp.write_all(&bytes[..n])?;
        }
        if let Some(mode) = &self.permissions {
            temp.as_file().set_permissions(mode.clone())?;
        }
        temp.as_file().sync_all()?;
        let directory = publication_lock(parent, parent_id, cancel)?;
        check_cancel(cancel)?;
        source
            .validate()
            .map_err(|_| io::Error::other("export_source_changed"))?;
        self.current()?;
        let after = fs::metadata(parent)?;
        if meta_dev_ino(&after) != parent_id {
            return Err(io::Error::other("export_target_changed"));
        }
        if self.before.is_some() {
            temp.persist(&self.path)
                .map_err(|_| io::Error::other("export_publish_failed"))?;
        } else {
            temp.persist_noclobber(&self.path)
                .map_err(|_| io::Error::other("export_target_changed"))?;
        }
        sync(&directory).map_err(|_| io::Error::other("export_publication_unknown"))
    }
}
