//! Unified Project Agent full-text search index across bots, visible messages,
//! delegated task titles, and active memories (`SQLite FTS5` trigram + short-term `LIKE`).
//!
//! Matches `packages/runtime-node/src/project-agent/conversation-search-index.mjs`.

use crate::{ProjectError, directory::is_visible_bot_message, memory::MemoryItem};
use rusqlite::{Connection, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::Path,
};

const DEFAULT_LIMIT: usize = 50;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSearchDocument {
    pub id: String,
    pub kind: String,
    pub workspace_id: String,
    pub title: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub memory_id: Option<String>,
    pub updated_at: String,
}

pub type ConversationSearchHit = ConversationSearchDocument;

fn valid_kind(kind: &str) -> bool {
    matches!(kind, "bot" | "message" | "task" | "memory")
}

fn clip(raw: &str, max_chars: usize) -> String {
    let collapsed: String = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for (idx, ch) in collapsed.chars().enumerate() {
        if idx >= max_chars {
            break;
        }
        out.push(ch);
    }
    out
}

fn message_text(msg: &Value) -> &str {
    msg["content"]
        .as_str()
        .or_else(|| msg["text"].as_str())
        .unwrap_or("")
}

/// Collect canonical search documents from bots, visible messages, delegated tasks, and memories.
/// Mirrors `conversation-search-index.mjs#collectConversationSearchDocuments`.
pub fn collect_conversation_search_documents(
    bots: &[Value],
    messages: &[(&str, &Value)],
    tasks: &[Value],
    memories: &[MemoryItem],
) -> Vec<ConversationSearchDocument> {
    let mut docs = Vec::new();
    for bot in bots {
        let Some(ws_id) = bot["workspaceId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let title = bot["profile"]["displayName"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(ws_id)
            .to_owned();
        let text = bot["preview"].as_str().unwrap_or("").to_owned();
        let updated_at = bot["lastActiveAt"].as_str().unwrap_or("").to_owned();
        docs.push(ConversationSearchDocument {
            id: format!("bot:{ws_id}"),
            kind: "bot".into(),
            workspace_id: ws_id.to_owned(),
            title,
            text,
            message_id: None,
            session_id: None,
            memory_id: None,
            updated_at,
        });
    }
    for &(ws_id, message) in messages {
        let Some(msg_id) = message["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if ws_id.is_empty() || !is_visible_bot_message(message) {
            continue;
        }
        let text = message_text(message).trim();
        if text.is_empty() {
            continue;
        }
        docs.push(ConversationSearchDocument {
            id: format!("message:{ws_id}:{msg_id}"),
            kind: "message".into(),
            workspace_id: ws_id.to_owned(),
            title: clip(text, 80),
            text: text.to_owned(),
            message_id: Some(msg_id.to_owned()),
            session_id: None,
            memory_id: None,
            updated_at: message["createdAt"].as_str().unwrap_or("").to_owned(),
        });
    }
    for task in tasks {
        let ws_id = task["workspaceId"].as_str().unwrap_or("");
        let sid = task["sessionId"].as_str().unwrap_or("");
        let title = task["title"].as_str().unwrap_or("").trim();
        if ws_id.is_empty() || sid.is_empty() || title.is_empty() {
            continue;
        }
        docs.push(ConversationSearchDocument {
            id: format!("task:{ws_id}:{sid}"),
            kind: "task".into(),
            workspace_id: ws_id.to_owned(),
            title: title.to_owned(),
            text: title.to_owned(),
            message_id: None,
            session_id: Some(sid.to_owned()),
            memory_id: None,
            updated_at: task["updatedAt"].as_str().unwrap_or("").to_owned(),
        });
    }
    for mem in memories {
        if !mem.status.is_empty() && mem.status != "active" {
            continue;
        }
        let text = mem.text.trim();
        if mem.id.is_empty() || text.is_empty() {
            continue;
        }
        docs.push(ConversationSearchDocument {
            id: format!("memory:{}", mem.id),
            kind: "memory".into(),
            workspace_id: mem.workspace_id.clone().unwrap_or_default(),
            title: clip(text, 80),
            text: text.to_owned(),
            message_id: None,
            session_id: None,
            memory_id: Some(mem.id.clone()),
            updated_at: if mem.updated_at.is_empty() {
                mem.created_at.clone()
            } else {
                mem.updated_at.clone()
            },
        });
    }
    docs
}

fn score_doc(doc: &ConversationSearchDocument, needle: &str) -> i32 {
    if needle.is_empty() {
        return 0;
    }
    let title_lower = doc.title.to_lowercase();
    if title_lower == needle {
        return 300;
    }
    if title_lower.starts_with(needle) {
        return 200;
    }
    if title_lower.contains(needle) {
        return 100;
    }
    if doc.text.to_lowercase().contains(needle) {
        return 50;
    }
    -1
}

fn fts_phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\""))
}

fn like_pattern(term: &str) -> String {
    let escaped = term
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_");
    format!("%{escaped}%")
}

pub struct ConversationSearchIndex {
    conn: Connection,
}

impl ConversationSearchIndex {
    fn init(conn: Connection) -> Result<Self, ProjectError> {
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS search_doc (
               id TEXT PRIMARY KEY,
               kind TEXT NOT NULL,
               workspace_id TEXT NOT NULL,
               title TEXT NOT NULL,
               body TEXT NOT NULL,
               message_id TEXT,
               session_id TEXT,
               memory_id TEXT,
               updated_at TEXT NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS search_fts
               USING fts5(id UNINDEXED, title, body, tokenize='trigram');",
        )
        .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(Self { conn })
    }

    pub fn open(file: &Path) -> Result<Self, ProjectError> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let conn =
            Connection::open(file).map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Self::init(conn)
    }

    pub fn open_in_memory() -> Result<Self, ProjectError> {
        let conn = Connection::open_in_memory()
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Self::init(conn)
    }

    pub fn size(&self) -> Result<usize, ProjectError> {
        let n: i64 = self
            .conn
            .query_row("SELECT COUNT(*) FROM search_doc", [], |r| r.get(0))
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(n as usize)
    }

    pub fn upsert(&self, doc: &ConversationSearchDocument) -> Result<bool, ProjectError> {
        let id = doc.id.trim();
        if id.is_empty() || !valid_kind(&doc.kind) {
            return Ok(false);
        }
        self.conn
            .execute(
                "INSERT INTO search_doc(id, kind, workspace_id, title, body, message_id, session_id, memory_id, updated_at)
                 VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                 ON CONFLICT(id) DO UPDATE SET
                   kind = excluded.kind,
                   workspace_id = excluded.workspace_id,
                   title = excluded.title,
                   body = excluded.body,
                   message_id = excluded.message_id,
                   session_id = excluded.session_id,
                   memory_id = excluded.memory_id,
                   updated_at = excluded.updated_at",
                params![
                    id,
                    doc.kind,
                    doc.workspace_id,
                    doc.title,
                    doc.text,
                    doc.message_id,
                    doc.session_id,
                    doc.memory_id,
                    doc.updated_at,
                ],
            )
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        self.conn
            .execute("DELETE FROM search_fts WHERE id = ?1", params![id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        self.conn
            .execute(
                "INSERT INTO search_fts(id, title, body) VALUES(?1, ?2, ?3)",
                params![id, doc.title, doc.text],
            )
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(true)
    }

    pub fn remove(&self, id: &str) -> Result<bool, ProjectError> {
        let n = self
            .conn
            .execute("DELETE FROM search_doc WHERE id = ?1", params![id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        self.conn
            .execute("DELETE FROM search_fts WHERE id = ?1", params![id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(n > 0)
    }

    pub fn rebuild(&self, docs: &[ConversationSearchDocument]) -> Result<(), ProjectError> {
        self.conn
            .execute_batch("BEGIN IMMEDIATE; DELETE FROM search_doc; DELETE FROM search_fts;")
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let res = (|| -> Result<(), ProjectError> {
            let mut ins_doc = self
                .conn
                .prepare(
                    "INSERT INTO search_doc(id, kind, workspace_id, title, body, message_id, session_id, memory_id, updated_at)
                     VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
                     ON CONFLICT(id) DO UPDATE SET
                       kind = excluded.kind, workspace_id = excluded.workspace_id,
                       title = excluded.title, body = excluded.body,
                       message_id = excluded.message_id, session_id = excluded.session_id,
                       memory_id = excluded.memory_id, updated_at = excluded.updated_at",
                )
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let mut ins_fts = self
                .conn
                .prepare("INSERT INTO search_fts(id, title, body) VALUES(?1, ?2, ?3)")
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let mut seen = HashSet::new();
            for doc in docs.iter().rev() {
                let id = doc.id.trim();
                if id.is_empty() || !valid_kind(&doc.kind) || !seen.insert(id.to_owned()) {
                    continue;
                }
                ins_doc
                    .execute(params![
                        id,
                        doc.kind,
                        doc.workspace_id,
                        doc.title,
                        doc.text,
                        doc.message_id,
                        doc.session_id,
                        doc.memory_id,
                        doc.updated_at,
                    ])
                    .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
                ins_fts
                    .execute(params![id, doc.title, doc.text])
                    .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            }
            Ok(())
        })();
        match res {
            Ok(()) => self
                .conn
                .execute_batch("COMMIT;")
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string())),
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    pub fn sync(&self, docs: &[ConversationSearchDocument]) -> Result<(), ProjectError> {
        let mut by_id: BTreeMap<String, ConversationSearchDocument> = BTreeMap::new();
        for doc in docs {
            let id = doc.id.trim();
            if !id.is_empty() && valid_kind(&doc.kind) {
                let mut d = doc.clone();
                d.id = id.to_owned();
                by_id.insert(id.to_owned(), d);
            }
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM search_doc")
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let existing_ids: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?
            .filter_map(Result::ok)
            .collect();
        drop(stmt);

        for old_id in existing_ids {
            if !by_id.contains_key(&old_id) {
                let _ = self.remove(&old_id)?;
            }
        }
        for doc in by_id.values() {
            let _ = self.upsert(doc)?;
        }
        Ok(())
    }

    fn candidate_ids_for_needle(&self, needle: &str) -> Result<HashSet<String>, ProjectError> {
        if needle.chars().count() < 3 {
            let pat = like_pattern(needle);
            let mut stmt = self
                .conn
                .prepare(
                    "SELECT id FROM search_doc WHERE lower(title) LIKE ?1 ESCAPE '\\' OR lower(body) LIKE ?1 ESCAPE '\\'",
                )
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let ids = stmt
                .query_map(params![pat], |r| r.get::<_, String>(0))
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?
                .filter_map(Result::ok)
                .collect();
            return Ok(ids);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM search_fts WHERE search_fts MATCH ?1")
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let ids = stmt
            .query_map(params![fts_phrase(needle)], |r| r.get::<_, String>(0))
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?
            .filter_map(Result::ok)
            .collect();
        Ok(ids)
    }

    pub fn search(
        &self,
        query: &str,
        workspace_id: Option<&str>,
        kinds: Option<&[&str]>,
        limit: usize,
    ) -> Result<Vec<ConversationSearchHit>, ProjectError> {
        let cap = if limit == 0 { DEFAULT_LIMIT } else { limit };
        let needle = query.trim().to_lowercase();
        let candidate_ids = if needle.is_empty() {
            None
        } else {
            Some(self.candidate_ids_for_needle(&needle)?)
        };
        if let Some(ref cids) = candidate_ids
            && cids.is_empty()
        {
            return Ok(Vec::new());
        }

        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, kind, workspace_id, title, body, message_id, session_id, memory_id, updated_at
                 FROM search_doc",
            )
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let rows: Vec<ConversationSearchDocument> = stmt
            .query_map([], |r| {
                Ok(ConversationSearchDocument {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    workspace_id: r.get(2)?,
                    title: r.get(3)?,
                    text: r.get(4)?,
                    message_id: r.get(5)?,
                    session_id: r.get(6)?,
                    memory_id: r.get(7)?,
                    updated_at: r.get(8)?,
                })
            })
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?
            .filter_map(Result::ok)
            .collect();

        let mut scored: Vec<(i32, ConversationSearchDocument)> = Vec::new();
        for doc in rows {
            if let Some(ws) = workspace_id
                && doc.workspace_id != ws
            {
                continue;
            }
            if let Some(allowed) = kinds
                && !allowed.contains(&doc.kind.as_str())
            {
                continue;
            }
            if let Some(ref cids) = candidate_ids
                && !cids.contains(&doc.id)
            {
                continue;
            }
            let sc = score_doc(&doc, &needle);
            if sc >= 0 {
                scored.push((sc, doc));
            }
        }
        scored.sort_by(|(sa, a), (sb, b)| {
            sb.cmp(sa)
                .then_with(|| b.updated_at.cmp(&a.updated_at))
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(scored.into_iter().take(cap).map(|(_, d)| d).collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::MemoryItem;
    use serde_json::json;

    #[test]
    fn incremental_sync_matches_rebuild_and_handles_cjk_ranking() {
        let bots = vec![json!({
            "workspaceId": "ws-1",
            "profile": { "displayName": "构建助手" },
            "preview": "负责工作区构建与发布",
            "lastActiveAt": "2026-11-21T00:00:00.000Z",
        })];
        let msg = json!({
            "id": "m-1",
            "role": "assistant",
            "kind": "agent_reply",
            "content": "数据库连接池配置已完成检查。",
            "createdAt": "2026-11-21T00:01:00.000Z",
        });
        let tasks = vec![json!({
            "workspaceId": "ws-1",
            "sessionId": "s-1",
            "title": "deploy-service",
            "updatedAt": "2026-11-21T00:02:00.000Z",
        })];
        let mem = MemoryItem {
            id: "mem-1".into(),
            scope: "project".into(),
            kind: "fact".into(),
            text: "数据库连接池最大连接数为 16".into(),
            trust: "verified".into(),
            source_refs: vec!["ev-1".into()],
            pinned: false,
            status: "active".into(),
            confirmed_count: 1,
            created_at: "2026-11-21T00:03:00.000Z".into(),
            updated_at: "2026-11-21T00:03:00.000Z".into(),
            last_used_at: None,
            workspace_id: Some("ws-1".into()),
            anchor_message_id: None,
            forget_reason: None,
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Default::default(),
        };

        let docs = collect_conversation_search_documents(&bots, &[("ws-1", &msg)], &tasks, &[mem]);
        let idx_rebuilt = ConversationSearchIndex::open_in_memory().unwrap();
        idx_rebuilt.rebuild(&docs).unwrap();

        let idx_synced = ConversationSearchIndex::open_in_memory().unwrap();
        idx_synced
            .upsert(&ConversationSearchDocument {
                id: "stale:1".into(),
                kind: "bot".into(),
                workspace_id: "ws-1".into(),
                title: "stale".into(),
                text: "stale".into(),
                message_id: None,
                session_id: None,
                memory_id: None,
                updated_at: "".into(),
            })
            .unwrap();
        idx_synced.sync(&docs).unwrap();
        assert_eq!(idx_synced.size().unwrap(), docs.len());

        let cjk_rebuilt = idx_rebuilt.search("连接池", None, None, 10).unwrap();
        let cjk_synced = idx_synced.search("连接池", None, None, 10).unwrap();
        assert_eq!(cjk_rebuilt, cjk_synced);
        assert_eq!(cjk_rebuilt.len(), 2);

        // Exact title match ranks first (score 300)
        let exact = idx_synced.search("deploy-service", None, None, 10).unwrap();
        assert_eq!(exact[0].kind, "task");
        assert_eq!(exact[0].session_id.as_deref(), Some("s-1"));
    }
}
