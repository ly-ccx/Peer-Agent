use crate::{StoreError, files, identity, valid_id};
use peer_protocol::{JsonDecodeError, JsonLimits, PersistedHistory, decode_json_bounded};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};

const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_HISTORY_NODES: usize = 65_536;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub struct ConversationStore {
    pub(crate) directory: PathBuf,
}
#[derive(Debug)]
pub struct HistorySnapshot {
    pub history: PersistedHistory,
    pub source_revision: String,
    index_version: Option<files::FileIdentity>,
}
impl HistorySnapshot {
    /// Check the whole index observed by this Store transaction before
    /// publishing a replacement of that file.
    pub(crate) fn check_index(&self, index: &Path) -> Result<(), StoreError> {
        if identity(index)? != self.index_version {
            return Err(StoreError::VersionChanged);
        }
        Ok(())
    }
}
pub struct ConversationMetadataSnapshot {
    pub metadata: Option<Value>,
    pub source_revision: String,
}

struct DecodeBudget(JsonLimits);
impl DecodeBudget {
    fn decode(&mut self, bytes: &[u8], invalid: StoreError) -> Result<Value, StoreError> {
        let decoded = decode_json_bounded(bytes, self.0).map_err(|error| match error {
            JsonDecodeError::LimitExceeded => StoreError::HistoryLimit,
            JsonDecodeError::InvalidJson => invalid,
        })?;
        self.0.nodes -= decoded.nodes;
        self.0.string_bytes -= decoded.string_bytes;
        Ok(decoded.value)
    }
}

fn rows(bytes: &[u8], budget: &mut DecodeBudget) -> Result<Vec<Value>, StoreError> {
    let mut values = Vec::new();
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        let value = budget.decode(line, StoreError::HistoryCorrupt)?;
        if !value.is_object() {
            return Err(StoreError::HistoryCorrupt);
        }
        values.push(value);
    }
    Ok(values)
}

fn recent_rows(
    bytes: &[u8],
    budget: &mut DecodeBudget,
    excluded: Option<&str>,
    kind: &str,
    limit: usize,
) -> Result<Vec<Value>, StoreError> {
    let mut selected = VecDeque::new();
    let mut committed = true;
    for line in bytes.split(|byte| *byte == b'\n') {
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        // Validate one row at a time. Keep only offsets into the bounded body
        // until the selected rows are decoded under the shared snapshot budget.
        let row = DecodeBudget(JsonLimits {
            bytes: budget.0.bytes,
            nodes: MAX_HISTORY_NODES,
            depth: budget.0.depth,
            string_bytes: budget.0.bytes,
        })
        .decode(line, StoreError::HistoryCorrupt)?;
        if !row.is_object() {
            return Err(StoreError::HistoryCorrupt);
        }
        if excluded.is_some_and(|id| row["id"] == id) {
            committed = false;
        }
        if committed && row["kind"] == kind {
            if selected.len() == limit {
                selected.pop_front();
            }
            selected.push_back(line);
        }
    }
    if committed && excluded.is_some() {
        return Err(StoreError::StreamTargetMissing);
    }
    selected
        .into_iter()
        .map(|line| budget.decode(line, StoreError::HistoryCorrupt))
        .collect()
}

impl ConversationStore {
    /// Identity/ancestry lookup reads the index only, never a long message body.
    pub fn read_metadata(
        &self,
        conversation_id: &str,
    ) -> Result<ConversationMetadataSnapshot, StoreError> {
        if !valid_id(conversation_id, false) {
            return Err(StoreError::InvalidInput);
        }
        let path = self.directory.join("index.jsonl");
        let before = identity(&path)?.ok_or(StoreError::NotFound)?;
        let rows = crate::durable_jsonl::read(&path, None)?;
        let mut found = None;
        for row in rows {
            if row["id"] == conversation_id {
                if found.is_some() {
                    return Err(StoreError::HistoryCorrupt);
                }
                found = Some(row);
            }
        }
        if identity(&path)?.as_ref() != Some(&before) {
            return Err(StoreError::VersionChanged);
        }
        Ok(ConversationMetadataSnapshot {
            metadata: found,
            source_revision: files::fingerprint(&[Some(before)]),
        })
    }
    /// Construction performs no migration, mkdir or write.
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            directory: data_home.as_ref().join("conversations"),
        }
    }

    pub fn read_committed(
        &self,
        conversation_id: &str,
        expected_revision: Option<u64>,
        budget: usize,
    ) -> Result<HistorySnapshot, StoreError> {
        self.read_committed_projection(conversation_id, expected_revision, budget, None)
    }

    /// Read the latest committed rows of one kind in chronological order.
    /// Like a full snapshot, this excludes the active stream and its suffix.
    pub fn read_recent_committed_by_kind(
        &self,
        conversation_id: &str,
        kind: &str,
        limit: usize,
        budget: usize,
    ) -> Result<Vec<Value>, StoreError> {
        if limit == 0 {
            return Err(StoreError::InvalidInput);
        }
        let snapshot =
            self.read_committed_projection(conversation_id, None, budget, Some((kind, limit)))?;
        Ok(snapshot.history.messages)
    }

    fn read_committed_projection(
        &self,
        conversation_id: &str,
        expected_revision: Option<u64>,
        budget: usize,
        projection: Option<(&str, usize)>,
    ) -> Result<HistorySnapshot, StoreError> {
        if !valid_id(conversation_id, false) || budget == 0 || budget > MAX_HISTORY_BYTES {
            return Err(StoreError::InvalidInput);
        }
        let files = [
            self.directory.join("index.jsonl"),
            self.directory.join(format!("{conversation_id}.jsonl")),
            self.directory
                .join(format!("{conversation_id}.stream.json")),
        ];
        let before: Vec<_> = files
            .iter()
            .map(|file| identity(file))
            .collect::<Result<_, _>>()?;
        let mut remaining = budget;
        // Shared across index, history and sidecar, including overwritten keys.
        // Bytes alone do not bound the number of small allocated JSON nodes.
        let mut decode = DecodeBudget(JsonLimits {
            bytes: budget,
            nodes: MAX_HISTORY_NODES,
            depth: 64,
            string_bytes: budget,
        });
        let index = files::read(&files[0], remaining)?.ok_or(StoreError::NotFound)?;
        remaining = remaining
            .checked_sub(index.len())
            .ok_or(StoreError::HistoryLimit)?;
        let mut selected = None;
        for line in index.split(|byte| *byte == b'\n') {
            if line.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let row = decode.decode(line, StoreError::HistoryCorrupt)?;
            if !row.is_object() {
                return Err(StoreError::HistoryCorrupt);
            }
            if row["id"] == conversation_id && selected.replace((line, row)).is_some() {
                return Err(StoreError::HistoryCorrupt);
            }
        }
        let (index_line, meta) = selected.ok_or(StoreError::NotFound)?;
        let revision = if meta.get("contentRevision").is_none_or(Value::is_null) {
            0
        } else {
            meta["contentRevision"]
                .as_f64()
                .filter(|r| {
                    r.is_finite() && *r >= 0.0 && r.fract() == 0.0 && *r <= MAX_SAFE_INTEGER as f64
                })
                .ok_or(StoreError::HistoryCorrupt)? as u64
        };
        if expected_revision.is_some_and(|expected| expected != revision) {
            return Err(StoreError::VersionChanged);
        }
        let body = files::read(&files[1], remaining)?;
        if revision > 0 && body.is_none() {
            return Err(StoreError::HistoryMissing);
        }
        remaining = remaining
            .checked_sub(body.as_ref().map_or(0, Vec::len))
            .ok_or(StoreError::HistoryLimit)?;
        let body = body.as_deref().unwrap_or_default();
        let mut messages = if projection.is_none() {
            rows(body, &mut decode)?
        } else {
            Vec::new()
        };
        if revision > 0 && body.iter().all(u8::is_ascii_whitespace) {
            return Err(StoreError::HistoryCorrupt);
        }
        let sidecar = files::read(&files[2], remaining)?;
        let excluded = if let Some(sidecar) = sidecar {
            let marker = decode.decode(&sidecar, StoreError::StreamStateInvalid)?;
            if marker["version"].as_f64() != Some(1.0)
                || marker["conversationId"].as_str() != Some(conversation_id)
                || !marker["patch"].is_object()
            {
                return Err(StoreError::StreamStateInvalid);
            }
            let id = marker["messageId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or(StoreError::StreamStateInvalid)?;
            Some(id.to_owned())
        } else {
            None
        };
        if let Some((kind, limit)) = projection {
            messages = recent_rows(body, &mut decode, excluded.as_deref(), kind, limit)?;
        } else if let Some(id) = excluded.as_deref() {
            let index = messages
                .iter()
                .position(|row| row["id"].as_str() == Some(id))
                .ok_or(StoreError::StreamTargetMissing)?;
            messages.truncate(index);
        }
        let after: Vec<_> = files
            .iter()
            .map(|file| identity(file))
            .collect::<Result<_, _>>()?;
        if before != after {
            return Err(StoreError::VersionChanged);
        }
        let mut source = Sha256::new();
        source.update(b"conversation-source-v2\0");
        source.update(Sha256::digest(index_line));
        source.update(files::fingerprint(&before[1..]));
        Ok(HistorySnapshot {
            history: PersistedHistory {
                conversation_id: conversation_id.to_owned(),
                content_revision: revision,
                messages,
                excluded_from_message_id: excluded,
                requires_runtime_check: true,
            },
            source_revision: format!("{:x}", source.finalize()),
            index_version: before.into_iter().next().flatten(),
        })
    }
}
