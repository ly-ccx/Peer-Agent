use crate::{StoreError, files, identity, valid_id};
use peer_protocol::{JsonDecodeError, JsonLimits, PersistedHistory, decode_json_bounded};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_HISTORY_BYTES: usize = 8 * 1024 * 1024;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

pub struct ConversationStore {
    pub(crate) directory: PathBuf,
}
#[derive(Debug)]
pub struct HistorySnapshot {
    pub history: PersistedHistory,
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

impl ConversationStore {
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
            nodes: 65_536,
            depth: 64,
            string_bytes: budget,
        });
        let index = files::read(&files[0], remaining)?.ok_or(StoreError::NotFound)?;
        remaining = remaining
            .checked_sub(index.len())
            .ok_or(StoreError::HistoryLimit)?;
        let entries = rows(&index, &mut decode)?;
        let matches: Vec<_> = entries
            .iter()
            .filter(|row| row["id"].as_str() == Some(conversation_id))
            .collect();
        if matches.is_empty() {
            return Err(StoreError::NotFound);
        }
        if matches.len() != 1 {
            return Err(StoreError::HistoryCorrupt);
        }
        let meta = matches[0];
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
        let mut messages = rows(body.as_deref().unwrap_or_default(), &mut decode)?;
        if revision > 0 && messages.is_empty() {
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
            let index = messages
                .iter()
                .position(|row| row["id"].as_str() == Some(id))
                .ok_or(StoreError::StreamTargetMissing)?;
            messages.truncate(index);
            Some(id.to_owned())
        } else {
            None
        };
        let after: Vec<_> = files
            .iter()
            .map(|file| identity(file))
            .collect::<Result<_, _>>()?;
        if before != after {
            return Err(StoreError::VersionChanged);
        }
        Ok(HistorySnapshot {
            history: PersistedHistory {
                conversation_id: conversation_id.to_owned(),
                content_revision: revision,
                messages,
                excluded_from_message_id: excluded,
                requires_runtime_check: true,
            },
            source_revision: files::fingerprint(&before),
        })
    }
}
