//! Raw presentation history only. A page cannot attest execution or authorize a
//! model request; canonical persisted-history admission remains a separate port.
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptCursor {
    pub conversation_id: String,
    pub source_revision: String,
    pub before_byte: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptRange {
    pub start: u64,
    pub end: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum TranscriptRow {
    Message { range: TranscriptRange, raw: Value },
    InvalidJson { range: TranscriptRange },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptPage {
    pub conversation_id: String,
    pub source_revision: String,
    pub rows: Vec<TranscriptRow>,
    pub older: Option<TranscriptCursor>,
    pub scanned_bytes: usize,
    pub requires_runtime_check: bool,
}
