use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LocalAccessLevel {
    AskBeforeLocal,
    SessionLocal,
    RestrictedLocal,
    FullLocal,
}

impl LocalAccessLevel {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AskBeforeLocal => "ask_before_local",
            Self::SessionLocal => "session_local",
            Self::RestrictedLocal => "restricted_local",
            Self::FullLocal => "full_local",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BotAccessPolicy {
    pub workspace_id: String,
    pub conversation_id: String,
    pub revision: u64,
    pub access_level: LocalAccessLevel,
    pub updated_at: String,
    pub source: String,
}

/// Persisted facts only. `requires_runtime_check` can never attest execution.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PersistedHistory {
    pub conversation_id: String,
    pub content_revision: u64,
    pub messages: Vec<serde_json::Value>,
    pub excluded_from_message_id: Option<String>,
    pub requires_runtime_check: bool,
}
