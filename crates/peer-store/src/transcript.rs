//! Reverse JSONL pages with bounded I/O and AST residency. No index/sidecar
//! mutation or canonical-history / execution claim follows from this reader.
use crate::{StoreError, files, valid_id};
use peer_protocol::{
    JsonDecodeError, JsonLimits, TranscriptCursor, TranscriptPage, TranscriptRange, TranscriptRow,
    decode_json_bounded, javascript_trim,
};
use std::{
    fmt,
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::atomic::{AtomicBool, Ordering},
};

#[derive(Debug, Clone, Copy)]
pub struct TranscriptLimits {
    pub records: usize,
    pub scan_bytes: usize,
    pub record_bytes: usize,
    pub json: JsonLimits,
}
impl Default for TranscriptLimits {
    fn default() -> Self {
        Self {
            records: 80,
            scan_bytes: 8 * 1024 * 1024,
            record_bytes: 2 * 1024 * 1024,
            json: JsonLimits {
                bytes: 4 * 1024 * 1024,
                nodes: 32_768,
                depth: 64,
                string_bytes: 4 * 1024 * 1024,
            },
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TranscriptLimit {
    ScanBytes,
    RecordBytes,
    DecodedPage,
}
#[derive(Debug, PartialEq, Eq)]
pub enum TranscriptError {
    Store(StoreError),
    InvalidCursor,
    LimitExceeded {
        kind: TranscriptLimit,
        line_end: u64,
        scanned_from: u64,
    },
}
impl From<StoreError> for TranscriptError {
    fn from(error: StoreError) -> Self {
        Self::Store(error)
    }
}
impl fmt::Display for TranscriptError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Store(error) => error.fmt(f),
            Self::InvalidCursor => f.write_str("TRANSCRIPT_INVALID_CURSOR"),
            Self::LimitExceeded { .. } => f.write_str("TRANSCRIPT_RESOURCE_LIMIT"),
        }
    }
}
impl std::error::Error for TranscriptError {}

pub struct TranscriptReader {
    directory: PathBuf,
}
impl TranscriptReader {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            directory: data_home.as_ref().join("conversations"),
        }
    }

    /// Cursor is an exclusive byte boundary bound to one file identity. An
    /// external write invalidates it; callers must re-anchor from a fresh page.
    /// Parsing/corruption diagnostics concern only this display page. Streaming
    /// sidecars and index revisions are intentionally not execution facts here.
    pub fn read_page(
        &self,
        conversation_id: &str,
        cursor: Option<&TranscriptCursor>,
        limits: TranscriptLimits,
        cancelled: Option<&AtomicBool>,
    ) -> Result<TranscriptPage, TranscriptError> {
        validate_limits(limits)?;
        if !valid_id(conversation_id, false) {
            return Err(StoreError::InvalidInput.into());
        }
        check_cancel(cancelled)?;
        let path = self.directory.join(format!("{conversation_id}.jsonl"));
        let Some((mut file, identity)) = files::open(&path, 9_007_199_254_740_991)? else {
            return Err(StoreError::NotFound.into());
        };
        let revision = files::fingerprint(&[Some(identity.clone())]);
        let end = if let Some(cursor) = cursor {
            if cursor.conversation_id != conversation_id || cursor.source_revision.len() != 64 {
                return Err(TranscriptError::InvalidCursor);
            }
            if cursor.source_revision != revision {
                return Err(StoreError::VersionChanged.into());
            }
            if cursor.before_byte == 0 || cursor.before_byte > identity.size {
                return Err(TranscriptError::InvalidCursor);
            }
            // Never admit a forged cursor in the middle of a JSON record.
            let mut prior = [0];
            read_at(&mut file, cursor.before_byte - 1, &mut prior)?;
            if prior[0] != b'\n' {
                return Err(TranscriptError::InvalidCursor);
            }
            cursor.before_byte
        } else {
            identity.size
        };
        let result = scan(&mut file, end, limits, cancelled);
        if files::identity(&path)?.as_ref() != Some(&identity) {
            return Err(StoreError::VersionChanged.into());
        }
        let (rows, oldest, scanned_bytes) = result?;
        Ok(TranscriptPage {
            conversation_id: conversation_id.to_owned(),
            source_revision: revision.clone(),
            rows,
            older: oldest
                .filter(|offset| *offset > 0)
                .map(|before_byte| TranscriptCursor {
                    conversation_id: conversation_id.to_owned(),
                    source_revision: revision,
                    before_byte,
                }),
            scanned_bytes,
            requires_runtime_check: true,
        })
    }
}

fn validate_limits(limits: TranscriptLimits) -> Result<(), StoreError> {
    if limits.records == 0
        || limits.records > 256
        || limits.scan_bytes == 0
        || limits.scan_bytes > 16 * 1024 * 1024
        || limits.record_bytes == 0
        || limits.record_bytes > limits.scan_bytes
        || limits.json.bytes == 0
        || limits.json.bytes > 8 * 1024 * 1024
        || limits.json.nodes == 0
        || limits.json.nodes > 65_536
        || limits.json.depth > 64
        || limits.json.string_bytes > 8 * 1024 * 1024
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(())
}
fn check_cancel(cancelled: Option<&AtomicBool>) -> Result<(), StoreError> {
    if cancelled.is_some_and(|c| c.load(Ordering::Acquire)) {
        Err(StoreError::Cancelled)
    } else {
        Ok(())
    }
}
fn read_at(file: &mut File, start: u64, output: &mut [u8]) -> Result<(), StoreError> {
    file.seek(SeekFrom::Start(start))
        .and_then(|_| file.read_exact(output))
        .map_err(|_| StoreError::ReadFailed)
}

struct PageBuilder {
    rows: Vec<TranscriptRow>,
    remaining: JsonLimits,
    records: usize,
    oldest: Option<u64>,
}
impl PageBuilder {
    fn record(&mut self, reversed: &mut [u8], start: u64, end: u64) -> Result<(), TranscriptError> {
        if reversed.is_empty() {
            return Ok(());
        }
        self.records += 1;
        self.oldest = Some(start);
        reversed.reverse();
        let text = std::str::from_utf8(reversed).map(javascript_trim);
        if text.as_ref().is_ok_and(|s| s.is_empty()) {
            return Ok(());
        }
        let raw = match text {
            Ok(text) => match decode_json_bounded(text.as_bytes(), self.remaining) {
                Ok(decoded) => {
                    self.remaining.bytes -= text.len();
                    self.remaining.nodes -= decoded.nodes;
                    self.remaining.string_bytes -= decoded.string_bytes;
                    Some(decoded.value)
                }
                Err(JsonDecodeError::LimitExceeded) => {
                    return Err(TranscriptError::LimitExceeded {
                        kind: TranscriptLimit::DecodedPage,
                        line_end: end,
                        scanned_from: start,
                    });
                }
                Err(JsonDecodeError::InvalidJson) => None,
            },
            Err(_) => None,
        };
        let range = TranscriptRange { start, end };
        self.rows.push(match raw {
            Some(raw) => TranscriptRow::Message { range, raw },
            None => TranscriptRow::InvalidJson { range },
        });
        Ok(())
    }
}

fn scan(
    file: &mut File,
    end: u64,
    limits: TranscriptLimits,
    cancelled: Option<&AtomicBool>,
) -> Result<(Vec<TranscriptRow>, Option<u64>, usize), TranscriptError> {
    let mut page = PageBuilder {
        rows: Vec::new(),
        remaining: limits.json,
        records: 0,
        oldest: None,
    };
    let mut buffer = [0; 16 * 1024];
    let mut reversed = Vec::new();
    let mut position = end;
    let mut line_end = end;
    let mut scanned = 0;
    while position > 0 {
        check_cancel(cancelled)?;
        if scanned == limits.scan_bytes {
            return Err(TranscriptError::LimitExceeded {
                kind: TranscriptLimit::ScanBytes,
                line_end,
                scanned_from: position,
            });
        }
        let count = buffer
            .len()
            .min(position as usize)
            .min(limits.scan_bytes - scanned);
        let start = position - count as u64;
        read_at(file, start, &mut buffer[..count])?;
        scanned += count;
        for index in (0..count).rev() {
            let offset = start + index as u64;
            if buffer[index] == b'\n' {
                page.record(&mut reversed, offset + 1, line_end)?;
                reversed.clear();
                if page.records == limits.records {
                    page.rows.reverse();
                    return Ok((page.rows, page.oldest, scanned));
                }
                line_end = offset;
            } else {
                if reversed.len() == limits.record_bytes {
                    return Err(TranscriptError::LimitExceeded {
                        kind: TranscriptLimit::RecordBytes,
                        line_end,
                        scanned_from: offset + 1,
                    });
                }
                reversed.push(buffer[index]);
            }
        }
        position = start;
    }
    check_cancel(cancelled)?;
    page.record(&mut reversed, 0, line_end)?;
    page.rows.reverse();
    // Preserve the legacy byte-window anchor, including a possible final empty
    // page for a prefix that consists only of blank lines.
    Ok((page.rows, page.oldest, scanned))
}
