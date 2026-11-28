//! Stable, bounded display walk; provisional text is never execution history.
use super::*;
use peer_protocol::{
    JsonLimits, JsonSelection, ProjectionError, ProjectionLimits, project_json_reader,
    project_json_selected_reader,
};
use std::{
    fs::File,
    io::{self, BufRead, BufReader, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};
const RECORD_SOURCE: u64 = 1024 * 1024 * 1024;
pub enum DisplayEvent<'a> {
    Metadata(&'a SessionMetadata),
    Message(&'a Value),
}
#[derive(Debug)]
pub enum DisplayReadError {
    Source(StoreError),
    Sink(io::Error),
}
impl From<StoreError> for DisplayReadError {
    fn from(e: StoreError) -> Self {
        Self::Source(e)
    }
}
pub struct DisplaySnapshot {
    pub source_revision: String,
    pub has_provisional: bool,
    sources: Vec<(PathBuf, Option<files::FileIdentity>)>,
}
impl DisplaySnapshot {
    pub fn validate(&self) -> Result<(), StoreError> {
        for (path, before) in &self.sources {
            if files::identity(path)? != *before {
                return Err(StoreError::VersionChanged);
            }
        }
        Ok(())
    }
    pub fn aliases_source(&self, path: &Path) -> Result<bool, StoreError> {
        let candidate = files::identity(path)?;
        Ok(candidate.is_some_and(|c| {
            self.sources
                .iter()
                .any(|(_, v)| v.as_ref().is_some_and(|v| v.dev == c.dev && v.ino == c.ino))
        }))
    }
}
fn projection_error(e: ProjectionError) -> StoreError {
    match e {
        ProjectionError::Cancelled => StoreError::Cancelled,
        ProjectionError::LimitExceeded => StoreError::HistoryLimit,
        ProjectionError::InvalidJson => StoreError::HistoryCorrupt,
        ProjectionError::ReadFailed => StoreError::ReadFailed,
    }
}
fn limits(source: u64, selected: usize) -> ProjectionLimits {
    ProjectionLimits {
        source_bytes: source.max(1),
        selected: JsonLimits {
            bytes: selected,
            nodes: 65536,
            depth: 64,
            string_bytes: selected,
        },
        key_bytes: 4096,
    }
}
fn read_patch(
    path: &Path,
    content: bool,
    cancel: Option<&AtomicBool>,
) -> Result<Option<Value>, StoreError> {
    let Some((file, identity)) = files::open(path, RECORD_SOURCE)? else {
        return Ok(None);
    };
    let fields = if content {
        vec![
            ("role", JsonSelection::Full),
            ("content", JsonSelection::Full),
        ]
    } else {
        vec![("role", JsonSelection::Full)]
    };
    let root = [
        ("version", JsonSelection::Full),
        ("conversationId", JsonSelection::Full),
        ("messageId", JsonSelection::Full),
        ("patch", JsonSelection::Object(&fields)),
    ];
    let result = project_json_selected_reader(
        file,
        &JsonSelection::Object(&root),
        limits(
            identity.size,
            if content { 12 * 1024 * 1024 } else { 64 * 1024 },
        ),
        cancel,
    )
    .map_err(projection_error)?;
    Ok(Some(result.value))
}
fn line_end(
    reader: &mut BufReader<File>,
    end: u64,
    cancel: Option<&AtomicBool>,
) -> Result<Option<(u64, u64, bool)>, StoreError> {
    let start = reader
        .stream_position()
        .map_err(|_| StoreError::ReadFailed)?;
    let mut length = 0u64;
    let mut nonempty = false;
    loop {
        durable_jsonl::check_cancel(cancel)?;
        let remaining = end.saturating_sub(start + length);
        if remaining == 0 {
            return if length == 0 {
                Ok(None)
            } else {
                Err(StoreError::HistoryCorrupt)
            };
        }
        let bytes = reader.fill_buf().map_err(|_| StoreError::ReadFailed)?;
        let bytes = &bytes[..bytes.len().min(remaining.try_into().unwrap_or(usize::MAX))];
        if bytes.is_empty() {
            return if length == 0 {
                Ok(None)
            } else {
                Err(StoreError::HistoryCorrupt)
            };
        }
        let newline = bytes.iter().position(|b| *b == b'\n');
        let count = newline.map_or(bytes.len(), |n| n + 1);
        nonempty |= bytes[..count].iter().any(|b| !b.is_ascii_whitespace());
        length = length
            .checked_add(count as u64)
            .ok_or(StoreError::HistoryLimit)?;
        if length > RECORD_SOURCE {
            return Err(StoreError::HistoryLimit);
        }
        reader.consume(count);
        if newline.is_some() {
            return Ok(Some((start, length, nonempty)));
        }
    }
}
fn row(
    reader: &mut BufReader<File>,
    start: u64,
    length: u64,
    fields: &[&str],
    selected: usize,
    cancel: Option<&AtomicBool>,
) -> Result<Value, StoreError> {
    reader
        .seek(SeekFrom::Start(start))
        .map_err(|_| StoreError::ReadFailed)?;
    project_json_reader(
        Read::by_ref(reader).take(length),
        fields,
        limits(length, selected),
        cancel,
    )
    .map(|v| v.value)
    .map_err(projection_error)
}
impl ConversationStore {
    /// Visitor output must remain private until this call succeeds and the
    /// returned snapshot is rechecked. No permission or stop proof is returned.
    pub fn visit_display(
        &self,
        id: &str,
        cancel: Option<&AtomicBool>,
        mut visitor: impl FnMut(DisplayEvent<'_>) -> io::Result<()>,
    ) -> Result<DisplaySnapshot, DisplayReadError> {
        if !valid_id(id, false) {
            return Err(StoreError::InvalidInput.into());
        }
        let paths = [
            self.directory.join("index.jsonl"),
            self.directory.join(format!("{id}.jsonl")),
            self.directory.join(format!("{id}.stream.json")),
        ];
        let mut snapshot = DisplaySnapshot {
            source_revision: String::new(),
            has_provisional: false,
            sources: paths
                .iter()
                .map(|p| Ok((p.clone(), files::identity(p)?)))
                .collect::<Result<_, StoreError>>()?,
        };
        let raw = self
            .read_metadata(id)?
            .metadata
            .ok_or(StoreError::NotFound)?;
        let revision = raw
            .get("contentRevision")
            .and_then(Value::as_u64)
            .unwrap_or(0);
        let meta = SessionMetadata::parse(&raw)?;
        drop(raw);
        durable_jsonl::check_cancel(cancel)?;
        visitor(DisplayEvent::Metadata(&meta)).map_err(DisplayReadError::Sink)?;
        drop(meta);
        let patch = read_patch(&paths[2], false, cancel)?;
        if let Some(p) = &patch
            && (p["version"].as_f64() != Some(1.0)
                || p["conversationId"] != id
                || !p["patch"].is_object()
                || !p["messageId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty() && s.len() <= 4096))
        {
            return Err(StoreError::StreamStateInvalid.into());
        }
        let target = patch.as_ref().and_then(|p| p["messageId"].as_str());
        let mut applied = false;
        if let Some((file, identity)) = files::open(&paths[1], 9_007_199_254_740_991)? {
            if snapshot.sources[1].1.as_ref() != Some(&identity) {
                return Err(StoreError::VersionChanged.into());
            }
            let mut reader = BufReader::with_capacity(16 * 1024, file);
            while let Some((start, length, nonempty)) =
                line_end(&mut reader, identity.size, cancel)?
            {
                if !nonempty {
                    continue;
                }
                let probe = row(
                    &mut reader,
                    start,
                    length,
                    &["id", "role"],
                    64 * 1024,
                    cancel,
                )?;
                let matched = !applied && target.is_some() && probe["id"].as_str() == target;
                let role = if matched {
                    applied = true;
                    patch.as_ref().unwrap()["patch"]
                        .get("role")
                        .unwrap_or(&probe["role"])
                } else {
                    &probe["role"]
                };
                if matches!(role.as_str(), Some("user" | "assistant")) {
                    let mut overlay = if matched {
                        read_patch(&paths[2], true, cancel)?
                    } else {
                        None
                    };
                    let content = overlay
                        .as_mut()
                        .and_then(|p| p["patch"].as_object_mut())
                        .and_then(|p| p.remove("content"));
                    let content = match content {
                        Some(content) => content,
                        None => {
                            let mut base = row(
                                &mut reader,
                                start,
                                length,
                                &["content"],
                                12 * 1024 * 1024,
                                cancel,
                            )?;
                            base.as_object_mut()
                                .and_then(|p| p.remove("content"))
                                .unwrap_or(Value::Null)
                        }
                    };
                    let mut visible = serde_json::Map::new();
                    visible.insert("role".into(), role.clone());
                    visible.insert("content".into(), content);
                    visitor(DisplayEvent::Message(&Value::Object(visible)))
                        .map_err(DisplayReadError::Sink)?;
                }
                reader
                    .seek(SeekFrom::Start(start + length))
                    .map_err(|_| StoreError::ReadFailed)?;
            }
        } else if revision > 0 {
            return Err(StoreError::HistoryMissing.into());
        }
        if target.is_some() && !applied {
            return Err(StoreError::StreamTargetMissing.into());
        }
        snapshot.has_provisional = applied;
        snapshot.source_revision = files::fingerprint(
            &snapshot
                .sources
                .iter()
                .map(|(_, v)| v.clone())
                .collect::<Vec<_>>(),
        );
        snapshot.validate()?;
        Ok(snapshot)
    }
}
