//! Human display projections. Never canonical execution history or permission.
use crate::{ConversationStore, StoreError, durable_jsonl, files, valid_id};
use serde_json::Value;
use std::{collections::HashSet, sync::atomic::AtomicBool};
mod visible;
pub use visible::{DisplayEvent, DisplayReadError, DisplaySnapshot};

#[derive(Debug, Clone)]
pub struct SessionMetadata {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    pub role: String,
}
impl SessionMetadata {
    fn parse(value: &Value) -> Result<Self, StoreError> {
        let id = value["id"]
            .as_str()
            .filter(|s| valid_id(s, false))
            .ok_or(StoreError::HistoryCorrupt)?
            .to_owned();
        let text = |key: &str| match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            _ => Err(StoreError::HistoryCorrupt),
        };
        Ok(Self {
            id,
            title: text("title")?,
            updated_at: text("updatedAt")?,
            created_at: text("createdAt")?,
            role: match value["role"].as_str() {
                Some("project_agent") => "project_agent",
                Some("work_session") => "work_session",
                _ => "default",
            }
            .into(),
        })
    }
    fn sort_key(&self) -> &str {
        self.updated_at
            .as_deref()
            .filter(|s| !s.is_empty())
            .or(self.created_at.as_deref())
            .unwrap_or("")
    }
}
impl ConversationStore {
    /// One current index observation, with no body/sidecar read or migration.
    pub fn list_sessions(
        &self,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<SessionMetadata>, StoreError> {
        let path = self.directory.join("index.jsonl");
        let before = files::identity(&path)?;
        let rows = durable_jsonl::read(&path, cancel)?;
        let mut ids = HashSet::new();
        let mut result = Vec::new();
        for row in rows {
            durable_jsonl::check_cancel(cancel)?;
            let meta = SessionMetadata::parse(&row)?;
            if !ids.insert(meta.id.clone()) {
                return Err(StoreError::HistoryCorrupt);
            }
            result.push(meta);
        }
        // Stable ordering keeps the source order for equal normal ISO timestamps.
        result.sort_by(|a, b| b.sort_key().cmp(a.sort_key()));
        if files::identity(&path)? != before {
            return Err(StoreError::VersionChanged);
        }
        Ok(result)
    }
}
