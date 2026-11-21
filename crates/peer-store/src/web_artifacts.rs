//! Legacy-compatible web files backed by held directory FDs, not a cache.
use rustix::fs::{self, AtFlags, FileType, FlockOperation, Mode, OFlags};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::os::unix::fs::MetadataExt;
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
const MAX_BYTES: u64 = 512 * 1024 * 1024;
const ENTRIES: usize = 16384;
const PATH_BYTES: usize = 4 * 1024 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WebArtifactError {
    pub code: &'static str,
    pub effect_possible: bool,
}
impl std::fmt::Display for WebArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for WebArtifactError {}
pub struct WebArtifactStore {
    home: PathBuf,
}
#[derive(Debug)]
pub struct WebArtifactPublication {
    pub reference: String,
    pub artifact_refs: Vec<String>,
}
fn dir(parent: &File, name: &str) -> Result<File, &'static str> {
    fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| "web_artifact_invalid")
}
fn home(path: &Path) -> Result<File, &'static str> {
    fs::open(
        path,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| "web_artifact_unavailable")
}
fn id(file: &File) -> Result<(u64, u64), &'static str> {
    let m = file.metadata().map_err(|_| "web_artifact_unavailable")?;
    Ok((m.dev(), m.ino()))
}
fn check(cancel: &impl Fn() -> bool) -> Result<(), &'static str> {
    if cancel() { Err("CANCELLED") } else { Ok(()) }
}
#[derive(Default)]
struct Quota {
    bytes: u64,
    entries: usize,
    paths: usize,
}
// Stop while serializing, before allocating an arbitrarily large metadata copy.
struct BoundedMetadata(Vec<u8>);
impl Write for BoundedMetadata {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.0.len().saturating_add(bytes.len()) > 256 * 1024 {
            return Err(std::io::Error::other("web_artifact_limit"));
        }
        self.0.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
fn scan(
    fd: &File,
    depth: usize,
    prefix: usize,
    q: &mut Quota,
    cancel: &impl Fn() -> bool,
) -> Result<(), &'static str> {
    for entry in fs::Dir::read_from(fd).map_err(|_| "web_artifact_unavailable")? {
        check(cancel)?;
        let entry = entry.map_err(|_| "web_artifact_unavailable")?;
        let name = entry.file_name();
        if matches!(name.to_bytes(), b"." | b"..") {
            continue;
        }
        q.entries += 1;
        q.paths = q.paths.saturating_add(prefix + name.to_bytes().len());
        if q.entries > ENTRIES || q.paths > PATH_BYTES {
            return Err("web_artifact_limit");
        }
        let st =
            fs::statat(fd, name, AtFlags::SYMLINK_NOFOLLOW).map_err(|_| "web_artifact_changed")?;
        match FileType::from_raw_mode(st.st_mode) {
            FileType::RegularFile => {
                q.bytes = q
                    .bytes
                    .saturating_add(u64::try_from(st.st_size).map_err(|_| "web_artifact_invalid")?);
                if q.bytes > MAX_BYTES {
                    return Err("web_artifact_limit");
                }
            }
            FileType::Directory => {
                if depth >= 4 {
                    return Err("web_artifact_limit");
                };
                let child = fs::openat(
                    fd,
                    name,
                    OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                    Mode::empty(),
                )
                .map(File::from)
                .map_err(|_| "web_artifact_changed")?;
                scan(
                    &child,
                    depth + 1,
                    prefix + name.to_bytes().len() + 1,
                    q,
                    cancel,
                )?;
            }
            _ => return Err("web_artifact_invalid"),
        }
    }
    Ok(())
}
type FileVersion = (u64, u64, u64, i64, i64, i64, i64);
fn version(file: &File) -> Result<FileVersion, &'static str> {
    let m = file.metadata().map_err(|_| "web_artifact_unavailable")?;
    if !m.is_file() || m.nlink() != 1 || m.mode() & 0o777 != 0o600 {
        return Err("web_artifact_changed");
    };
    Ok((
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    ))
}
fn write_verified(
    fd: &File,
    name: &str,
    bytes: &[u8],
    cancel: &impl Fn() -> bool,
) -> Result<(), &'static str> {
    let mut file = fs::openat(
        fd,
        name,
        OFlags::RDWR | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_raw_mode(0o600),
    )
    .map(File::from)
    .map_err(|_| "web_artifact_unavailable")?;
    for part in bytes.chunks(65536) {
        check(cancel)?;
        file.write_all(part)
            .map_err(|_| "web_artifact_unavailable")?;
    }
    file.sync_all().map_err(|_| "web_artifact_commit_unknown")?;
    let before = version(&file)?;
    if before.2 != bytes.len() as u64 {
        return Err("web_artifact_changed");
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|_| "web_artifact_unavailable")?;
    let mut hash = Sha256::new();
    let mut buf = [0; 65536];
    let mut read_bytes = 0usize;
    loop {
        check(cancel)?;
        let n = file
            .read(&mut buf)
            .map_err(|_| "web_artifact_unavailable")?;
        if n == 0 {
            break;
        }
        read_bytes = read_bytes.saturating_add(n);
        if read_bytes > bytes.len() {
            return Err("web_artifact_changed");
        }
        hash.update(&buf[..n]);
    }
    let observed = hash.finalize();
    if observed[..] != Sha256::digest(bytes)[..] || before != version(&file)? {
        return Err("web_artifact_changed");
    }
    let named = fs::openat(
        fd,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .map(File::from)
    .map_err(|_| "web_artifact_changed")?;
    if version(&named)? != before {
        return Err("web_artifact_changed");
    }
    Ok(())
}
impl WebArtifactStore {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            home: home.as_ref().into(),
        }
    }
    /// A read-only early check; publication repeats this under the actual root lock.
    pub fn check_capacity(&self, cancel: &impl Fn() -> bool) -> Result<(), WebArtifactError> {
        let result = (|| {
            check(cancel)?;
            let h = home(&self.home)?;
            match fs::openat(
                &h,
                "web-artifacts",
                OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
                Mode::empty(),
            ) {
                Ok(fd) => scan(&File::from(fd), 0, 0, &mut Quota::default(), cancel),
                Err(rustix::io::Errno::NOENT) => Ok(()),
                Err(_) => Err("web_artifact_invalid"),
            }
        })();
        result.map_err(|code| WebArtifactError {
            code,
            effect_possible: false,
        })
    }
    pub fn publish(
        &self,
        date: &str,
        fetch: &str,
        content: &str,
        metadata: &Value,
        cancel: &impl Fn() -> bool,
    ) -> Result<WebArtifactPublication, WebArtifactError> {
        let mut effect = false;
        let result = (|| {
            check(cancel)?;
            if date.len() != 10
                || !date.bytes().enumerate().all(|(i, b)| {
                    if i == 4 || i == 7 {
                        b == b'-'
                    } else {
                        b.is_ascii_digit()
                    }
                })
                || uuid::Uuid::parse_str(fetch)
                    .ok()
                    .is_none_or(|id| id.hyphenated().to_string() != fetch)
                || content.len() > 8 * 1024 * 1024
            {
                return Err("web_artifact_invalid");
            }
            let mut encoded = BoundedMetadata(Vec::new());
            serde_json::to_writer_pretty(&mut encoded, metadata)
                .map_err(|_| "web_artifact_limit")?;
            encoded.write_all(b"\n").map_err(|_| "web_artifact_limit")?;
            let encoded = encoded.0;
            let h = home(&self.home)?;
            let root = match dir(&h, "web-artifacts") {
                Ok(d) => d,
                Err(_) => {
                    let st = fs::statat(&h, "web-artifacts", AtFlags::SYMLINK_NOFOLLOW);
                    if st.is_ok() {
                        return Err("web_artifact_invalid");
                    };
                    effect = true;
                    fs::mkdirat(&h, "web-artifacts", Mode::from_raw_mode(0o700))
                        .map_err(|_| "web_artifact_unavailable")?;
                    h.sync_all().map_err(|_| "web_artifact_commit_unknown")?;
                    dir(&h, "web-artifacts")?
                }
            };
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                check(cancel)?;
                match fs::flock(&root, FlockOperation::NonBlockingLockExclusive) {
                    Ok(()) => break,
                    Err(rustix::io::Errno::AGAIN | rustix::io::Errno::INTR)
                        if Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(10))
                    }
                    Err(_) => return Err("web_artifact_busy"),
                }
            }
            let mut quota = Quota::default();
            scan(&root, 0, 0, &mut quota, cancel)?;
            if quota
                .bytes
                .saturating_add(content.len() as u64)
                .saturating_add(encoded.len() as u64)
                > MAX_BYTES
                || quota.entries.saturating_add(5) > ENTRIES
                || quota.paths.saturating_add(
                    date.len()
                        + (date.len() + 1 + fetch.len())
                        + 2 * (date.len() + 1 + fetch.len() + 1)
                        + "content.txt".len()
                        + "metadata.json".len(),
                ) > PATH_BYTES
            {
                return Err("web_artifact_limit");
            }
            let day = match dir(&root, date) {
                Ok(d) => d,
                Err(_) => {
                    effect = true;
                    fs::mkdirat(&root, date, Mode::from_raw_mode(0o700))
                        .map_err(|_| "web_artifact_unavailable")?;
                    root.sync_all().map_err(|_| "web_artifact_commit_unknown")?;
                    dir(&root, date)?
                }
            };
            effect = true;
            fs::mkdirat(&day, fetch, Mode::from_raw_mode(0o700))
                .map_err(|_| "web_artifact_unavailable")?;
            let target = dir(&day, fetch)?;
            write_verified(&target, "content.txt", content.as_bytes(), cancel)?;
            #[cfg(feature = "test-fixtures")]
            if self.home.join(".native-cli-fixture").is_file()
                && std::env::var("PEER_NATIVE_WEB_PUBLICATION_FAULT").as_deref()
                    == Ok("after_content")
            {
                return Err("web_artifact_commit_unknown");
            }
            write_verified(&target, "metadata.json", &encoded, cancel)?;
            target
                .sync_all()
                .map_err(|_| "web_artifact_commit_unknown")?;
            day.sync_all().map_err(|_| "web_artifact_commit_unknown")?;
            root.sync_all().map_err(|_| "web_artifact_commit_unknown")?;
            check(cancel)?;
            if id(&home(&self.home)?)? != id(&h)?
                || id(&dir(&h, "web-artifacts")?)? != id(&root)?
                || id(&dir(&root, date)?)? != id(&day)?
                || id(&dir(&day, fetch)?)? != id(&target)?
            {
                return Err("web_artifact_changed");
            }
            Ok(WebArtifactPublication {
                reference: format!("local-web-artifact://{fetch}"),
                artifact_refs: vec![
                    format!("local-web-artifact://{fetch}/content"),
                    format!("local-web-artifact://{fetch}/metadata"),
                ],
            })
        })();
        result.map_err(|code| WebArtifactError {
            code,
            effect_possible: effect,
        })
    }
}
