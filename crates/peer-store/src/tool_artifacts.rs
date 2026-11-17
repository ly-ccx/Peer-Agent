//! Immutable canonical tool-result content. Never a permission or cache.
use crate::valid_id;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{self, BufWriter, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
mod storage;
const MAX_BYTES: u64 = 128 * 1024 * 1024;
const MAX_CONVERSATION: u64 = 256 * 1024 * 1024;
const MAX_ENTRIES: usize = 4096;
const MAX_PATH_BYTES: usize = 4 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;
const WINDOW: usize = 256 * 1024;
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolArtifactError {
    Invalid,
    Missing,
    Corrupt,
    Changed,
    Limit,
    Busy,
    Unavailable,
    CommitUnknown,
    Cancelled,
}
impl ToolArtifactError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "artifact_invalid",
            Self::Missing => "artifact_missing",
            Self::Corrupt => "artifact_corrupt",
            Self::Changed => "artifact_changed",
            Self::Limit => "artifact_limit",
            Self::Busy => "artifact_busy",
            Self::Unavailable => "artifact_unavailable",
            Self::CommitUnknown => "artifact_commit_unknown",
            Self::Cancelled => "cancelled",
        }
    }
}
impl std::fmt::Display for ToolArtifactError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ToolArtifactError {}
type Error = ToolArtifactError;
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolArtifactFormat {
    Utf8,
    Json,
}
impl ToolArtifactFormat {
    fn extension(self) -> &'static str {
        match self {
            Self::Utf8 => "txt",
            Self::Json => "json",
        }
    }
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ToolArtifactRef {
    pub schema_version: u8,
    pub conversation_id: String,
    pub sha256: String,
    pub bytes: u64,
    pub format: ToolArtifactFormat,
}
impl ToolArtifactRef {
    fn validate(&self, conversation: &str) -> Result<(), Error> {
        if self.schema_version != 1
            || self.conversation_id != conversation
            || !valid_id(conversation, false)
            || self.bytes > MAX_BYTES
            || self.sha256.len() != 64
            || !self
                .sha256
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        {
            return Err(Error::Invalid);
        }
        Ok(())
    }
    fn name(&self) -> String {
        format!("{}.{}", self.sha256, self.format.extension())
    }
}
#[derive(Debug)]
pub struct ToolArtifactWindow {
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub total_bytes: u64,
    pub complete: bool,
}
pub struct ToolArtifactStore {
    home: PathBuf,
}
fn check(cancel: &impl Fn() -> bool) -> Result<(), Error> {
    if cancel() {
        Err(Error::Cancelled)
    } else {
        Ok(())
    }
}
impl ToolArtifactStore {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            home: home.as_ref().into(),
        }
    }
    pub fn path(&self, conversation: &str, reference: &ToolArtifactRef) -> Result<PathBuf, Error> {
        reference.validate(conversation)?;
        Ok(self
            .home
            .join("conversations")
            .join(format!("{conversation}.tool-results"))
            .join(reference.name()))
    }
    pub fn publish_utf8(
        &self,
        conversation: &str,
        text: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<ToolArtifactRef, Error> {
        self.publish(conversation, ToolArtifactFormat::Utf8, cancel, |out| {
            out.write_all(text.as_bytes())
        })
    }
    pub fn publish_json(
        &self,
        conversation: &str,
        value: &serde_json::Value,
        cancel: &impl Fn() -> bool,
    ) -> Result<ToolArtifactRef, Error> {
        self.publish(conversation, ToolArtifactFormat::Json, cancel, |out| {
            serde_json::to_writer(out, value).map_err(io::Error::other)
        })
    }
    /// Two streaming passes keep a 100MiB text observation out of the heap.
    pub fn publish_utf8_reader(
        &self,
        conversation: &str,
        reader: &mut (impl Read + Seek),
        cancel: &impl Fn() -> bool,
    ) -> Result<ToolArtifactRef, Error> {
        let start = reader.stream_position().map_err(|_| Error::Unavailable)?;
        self.publish(conversation, ToolArtifactFormat::Utf8, cancel, |out| {
            reader.seek(SeekFrom::Start(start))?;
            let mut buffer = [0; CHUNK];
            loop {
                let n = reader.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                out.write_all(&buffer[..n])?;
            }
            Ok(())
        })
    }
    fn publish(
        &self,
        conversation: &str,
        format: ToolArtifactFormat,
        cancel: &impl Fn() -> bool,
        mut emit: impl FnMut(&mut dyn Write) -> io::Result<()>,
    ) -> Result<ToolArtifactRef, Error> {
        if !valid_id(conversation, false) {
            return Err(Error::Invalid);
        }
        check(cancel)?;
        let mut count = Sink::new(io::sink(), cancel);
        if emit(&mut count).is_err() {
            return Err(count.error.unwrap_or(Error::Unavailable));
        }
        let (bytes, hash) = count.finish()?;
        let reference = ToolArtifactRef {
            schema_version: 1,
            conversation_id: conversation.into(),
            sha256: hash,
            bytes,
            format,
        };
        let dir = storage::Directory::open(&self.home, conversation, true, cancel)?;
        if dir.exists(&reference.name())? {
            self.verify(&dir, conversation, &reference, cancel)?;
            dir.sync().map_err(|_| Error::CommitUnknown)?;
            return Ok(reference);
        }
        dir.capacity(bytes, cancel)?;
        check(cancel)?;
        let temp = format!(".partial-{}", uuid::Uuid::new_v4());
        let file = dir.create(&temp)?;
        let mut write = Sink::new(BufWriter::with_capacity(CHUNK, file), cancel);
        if emit(&mut write).is_err() {
            return Err(write.error.unwrap_or(Error::Unavailable));
        }
        let (written, hash) = write.finish()?;
        if written != reference.bytes || hash != reference.sha256 {
            return Err(Error::Changed);
        }
        // Reopen through the locked directory FD. Partial files are preserved on any
        // uncertain exit; only this known-complete temporary link is removed below.
        let file = dir.file(&temp)?;
        file.sync_all().map_err(|_| Error::Unavailable)?;
        check(cancel)?;
        dir.publish(&temp, &reference.name())?;
        dir.check_path().map_err(|_| Error::CommitUnknown)?;
        self.verify(&dir, conversation, &reference, cancel)
            .map_err(|_| Error::CommitUnknown)?;
        Ok(reference)
    }
    fn verify(
        &self,
        dir: &storage::Directory,
        conversation: &str,
        reference: &ToolArtifactRef,
        cancel: &impl Fn() -> bool,
    ) -> Result<(File, storage::Version), Error> {
        reference.validate(conversation)?;
        let mut file = dir.file(&reference.name())?;
        let before = storage::version(&file)?;
        if before.2 != reference.bytes {
            return Err(Error::Corrupt);
        }
        let mut hash = Sha256::new();
        let mut buffer = [0; CHUNK];
        let mut total = 0u64;
        loop {
            check(cancel)?;
            let n = file.read(&mut buffer).map_err(|_| Error::Unavailable)?;
            if n == 0 {
                break;
            }
            total += n as u64;
            if total > reference.bytes {
                return Err(Error::Corrupt);
            }
            hash.update(&buffer[..n]);
        }
        if total != reference.bytes || format!("{:x}", hash.finalize()) != reference.sha256 {
            return Err(Error::Corrupt);
        }
        if storage::version(&file)? != before || !dir.same_file(&reference.name(), &file)? {
            return Err(Error::Changed);
        }
        dir.check_path()?;
        file.seek(SeekFrom::Start(0))
            .map_err(|_| Error::Unavailable)?;
        Ok((file, before))
    }
    pub fn read_window(
        &self,
        conversation: &str,
        reference: &ToolArtifactRef,
        offset: u64,
        length: usize,
        cancel: &impl Fn() -> bool,
    ) -> Result<ToolArtifactWindow, Error> {
        reference.validate(conversation)?;
        if length > WINDOW || offset > reference.bytes {
            return Err(Error::Invalid);
        }
        let dir = storage::Directory::open(&self.home, conversation, false, cancel)?;
        let verified = self.verify(&dir, conversation, reference, cancel)?;
        verified_window(&dir, reference, verified, (offset, length), cancel)
    }
}
fn verified_window(
    dir: &storage::Directory,
    reference: &ToolArtifactRef,
    verified: (File, storage::Version),
    range: (u64, usize),
    cancel: &impl Fn() -> bool,
) -> Result<ToolArtifactWindow, Error> {
    let (offset, length) = range;
    // Keep the version that was actually hashed. Recapturing here would bless
    // a mutation between full validation and the range read.
    let (mut file, before) = verified;
    file.seek(SeekFrom::Start(offset))
        .map_err(|_| Error::Unavailable)?;
    let size = length.min((reference.bytes - offset) as usize);
    let mut bytes = vec![0; size];
    file.read_exact(&mut bytes).map_err(|_| Error::Changed)?;
    check(cancel)?;
    if storage::version(&file)? != before || !dir.same_file(&reference.name(), &file)? {
        return Err(Error::Changed);
    }
    dir.check_path()?;
    Ok(ToolArtifactWindow {
        complete: offset == 0 && bytes.len() as u64 == reference.bytes,
        offset,
        total_bytes: reference.bytes,
        bytes,
    })
}

struct Sink<'a, W: Write, C: Fn() -> bool> {
    out: W,
    hash: Sha256,
    bytes: u64,
    pending: Vec<u8>,
    cancel: &'a C,
    error: Option<Error>,
}
impl<'a, W: Write, C: Fn() -> bool> Sink<'a, W, C> {
    fn new(out: W, cancel: &'a C) -> Self {
        Self {
            out,
            hash: Sha256::new(),
            bytes: 0,
            pending: Vec::new(),
            cancel,
            error: None,
        }
    }
    fn finish(mut self) -> Result<(u64, String), Error> {
        if !self.pending.is_empty() {
            return Err(Error::Invalid);
        }
        self.out.flush().map_err(|_| Error::Unavailable)?;
        Ok((self.bytes, format!("{:x}", self.hash.finalize())))
    }
}
impl<W: Write, C: Fn() -> bool> Write for Sink<'_, W, C> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = b.len().min(CHUNK);
        let b = &b[..n];
        let error = if (self.cancel)() {
            Some(Error::Cancelled)
        } else if self.bytes.saturating_add(n as u64) > MAX_BYTES {
            Some(Error::Limit)
        } else {
            None
        };
        if let Some(error) = error {
            self.error = Some(error);
            return Err(io::Error::other(error.code()));
        }
        // Only carry an incomplete UTF-8 suffix (at most three bytes).
        let mut text = std::mem::take(&mut self.pending);
        text.extend_from_slice(b);
        if let Err(error) = std::str::from_utf8(&text) {
            if error.error_len().is_some() {
                self.error = Some(Error::Invalid);
                return Err(io::Error::other("artifact_invalid"));
            }
            self.pending.extend_from_slice(&text[error.valid_up_to()..]);
        }
        self.out.write_all(b)?;
        self.hash.update(b);
        self.bytes += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}

#[cfg(test)]
mod verified_window_tests {
    use super::*;
    #[test]
    fn mutation_between_full_hash_validation_and_window_read_is_rejected() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("conversations")).unwrap();
        std::fs::write(home.path().join("conversations/c.jsonl"), "{}").unwrap();
        let store = ToolArtifactStore::new(home.path());
        let reference = store.publish_utf8("c", "original", &|| false).unwrap();
        let dir = storage::Directory::open(home.path(), "c", false, &|| false).unwrap();
        let verified = store.verify(&dir, "c", &reference, &|| false).unwrap();
        std::fs::write(store.path("c", &reference).unwrap(), "tampered").unwrap();
        assert_eq!(
            verified_window(&dir, &reference, verified, (0, 8), &|| false).unwrap_err(),
            Error::Changed
        );
    }
}
