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
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumableSessionRow {
    pub id: String,
    pub title: Option<String>,
    pub updated_at: Option<String>,
    pub created_at: Option<String>,
    pub workspace_path: Option<String>,
    pub mode: Option<String>,
    pub message_count: u64,
    pub role: String,
}

impl ResumableSessionRow {
    fn parse(value: &Value) -> Result<Option<Self>, StoreError> {
        let meta = SessionMetadata::parse(value)?;
        if value["status"].as_str().is_some_and(|s| s != "active")
            || !value["parentConversationId"].is_null()
            || !matches!(meta.role.as_str(), "default" | "chat")
        {
            return Ok(None);
        }
        let text = |key: &str| match value.get(key) {
            None | Some(Value::Null) => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            _ => Err(StoreError::HistoryCorrupt),
        };
        Ok(Some(Self {
            id: meta.id,
            title: meta.title,
            updated_at: meta.updated_at,
            created_at: meta.created_at,
            workspace_path: text("workspacePath")?,
            mode: text("mode")?,
            message_count: value["messageCount"].as_u64().unwrap_or(0),
            role: meta.role,
        }))
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

    /// Read-only list of active ordinary sessions for in-TUI `/resume` picker.
    pub fn list_resumable_sessions(
        &self,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<ResumableSessionRow>, StoreError> {
        let path = self.directory.join("index.jsonl");
        let before = files::identity(&path)?;
        if before.is_none() {
            return Ok(Vec::new());
        }
        let rows = durable_jsonl::read(&path, cancel)?;
        let mut ids = HashSet::new();
        let mut result = Vec::new();
        for row in rows {
            durable_jsonl::check_cancel(cancel)?;
            let id = row["id"].as_str().unwrap_or("");
            if !valid_id(id, false) || !ids.insert(id.to_owned()) {
                return Err(StoreError::HistoryCorrupt);
            }
            if let Some(entry) = ResumableSessionRow::parse(&row)? {
                result.push(entry);
            }
        }
        result.sort_by(|a, b| b.sort_key().cmp(a.sort_key()));
        if files::identity(&path)? != before {
            return Err(StoreError::VersionChanged);
        }
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn list_resumable_sessions_excludes_non_active_and_child_sessions() {
        let root = tempfile::tempdir().unwrap();
        let store = ConversationStore::new(root.path());
        assert!(store.list_resumable_sessions(None).unwrap().is_empty());

        let conv_dir = root.path().join("conversations");
        std::fs::create_dir_all(&conv_dir).unwrap();
        let rows = [
            json!({"id":"s-old","title":"Old","status":"active","mode":"chat","workspacePath":"/w","messageCount":2,"createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-01T00:01:00Z"}),
            json!({"id":"s-new","title":"New","status":"active","mode":"plan","workspacePath":"/w","messageCount":4,"createdAt":"2026-01-02T00:00:00Z","updatedAt":"2026-01-02T00:01:00Z"}),
            json!({"id":"s-child","title":"Child","status":"active","mode":"chat","parentConversationId":"s-new","workspacePath":"/w","messageCount":1,"createdAt":"2026-01-03T00:00:00Z"}),
            json!({"id":"s-bot","title":"Bot","status":"active","role":"project_agent","mode":"project_agent","workspacePath":"/w","messageCount":3,"createdAt":"2026-01-03T00:00:00Z"}),
            json!({"id":"s-archived","title":"Archived","status":"archived","mode":"chat","workspacePath":"/w","messageCount":5,"createdAt":"2026-01-04T00:00:00Z"}),
        ];
        let body = rows
            .iter()
            .map(|r| serde_json::to_string(r).unwrap())
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        std::fs::write(conv_dir.join("index.jsonl"), body).unwrap();

        let resumable = store.list_resumable_sessions(None).unwrap();
        assert_eq!(
            resumable.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            ["s-new", "s-old"]
        );
        assert_eq!(resumable[0].mode.as_deref(), Some("plan"));
        assert_eq!(resumable[0].message_count, 4);
    }
}
