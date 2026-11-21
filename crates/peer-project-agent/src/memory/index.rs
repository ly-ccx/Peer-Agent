//! Disposable SQLite FTS5 trigram index for project & user memory.
//!
//! Matches `packages/runtime-node/src/sqlite/fts-index.mjs` and
//! `packages/runtime-node/src/memory/memory-index.mjs` exact DDL and query rules:
//! - Tables: `memory_doc (id, body, meta, updated_at)` and `memory_fts USING fts5(id UNINDEXED, body, tokenize='trigram')`.
//! - Terms with fewer than 3 characters use `LIKE` with `\` escape; >=3 chars use FTS5 phrase MATCH.
//! - Multi-term queries intersect hit IDs across all whitespace-separated terms.

use crate::{ProjectError, memory::MemoryItem, now_iso, parse_iso_ms};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{collections::HashSet, fs, path::Path};

#[derive(Debug, Clone, PartialEq)]
pub struct MemoryHit {
    pub id: String,
    pub text: String,
    pub meta: Value,
}

pub struct MemoryIndex {
    conn: Connection,
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

impl MemoryIndex {
    pub fn open(file: &Path) -> Result<Self, ProjectError> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let conn =
            Connection::open(file).map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA busy_timeout = 5000;
             CREATE TABLE IF NOT EXISTS memory_doc (
               id TEXT PRIMARY KEY,
               body TEXT NOT NULL,
               meta TEXT NOT NULL,
               updated_at INTEGER NOT NULL
             );
             CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts
               USING fts5(id UNINDEXED, body, tokenize='trigram');",
        )
        .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(Self { conn })
    }

    pub fn upsert(&self, item: &MemoryItem) -> Result<(), ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let meta = json!({
            "scope": item.scope,
            "workspaceId": item.workspace_id,
            "kind": item.kind,
        });
        let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "null".into());
        self.conn
            .execute(
                "INSERT INTO memory_doc (id, body, meta, updated_at) VALUES (?1, ?2, ?3, ?4)
                 ON CONFLICT(id) DO UPDATE SET body=excluded.body, meta=excluded.meta, updated_at=excluded.updated_at",
                params![item.id, item.text, meta_str, now_ms],
            )
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        self.conn
            .execute("DELETE FROM memory_fts WHERE id = ?1", params![item.id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        if !item.text.is_empty() {
            self.conn
                .execute(
                    "INSERT INTO memory_fts (id, body) VALUES (?1, ?2)",
                    params![item.id, item.text],
                )
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        }
        Ok(())
    }

    pub fn remove(&self, id: &str) -> Result<(), ProjectError> {
        self.conn
            .execute("DELETE FROM memory_doc WHERE id = ?1", params![id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        self.conn
            .execute("DELETE FROM memory_fts WHERE id = ?1", params![id])
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        Ok(())
    }

    pub fn rebuild(&self, items: &[MemoryItem]) -> Result<(), ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        self.conn
            .execute_batch("BEGIN IMMEDIATE; DELETE FROM memory_doc; DELETE FROM memory_fts;")
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let res = (|| -> Result<(), ProjectError> {
            let mut ins_doc = self
                .conn
                .prepare(
                    "INSERT INTO memory_doc (id, body, meta, updated_at) VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(id) DO UPDATE SET body=excluded.body, meta=excluded.meta, updated_at=excluded.updated_at",
                )
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let mut ins_fts = self
                .conn
                .prepare("INSERT INTO memory_fts (id, body) VALUES (?1, ?2)")
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let mut seen = HashSet::new();
            for item in items {
                if !seen.insert(item.id.as_str()) {
                    continue;
                }
                let meta = json!({
                    "scope": item.scope,
                    "workspaceId": item.workspace_id,
                    "kind": item.kind,
                });
                let meta_str = serde_json::to_string(&meta).unwrap_or_else(|_| "null".into());
                ins_doc
                    .execute(params![item.id, item.text, meta_str, now_ms])
                    .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
                if !item.text.is_empty() {
                    ins_fts
                        .execute(params![item.id, item.text])
                        .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
                }
            }
            Ok(())
        })();
        match res {
            Ok(()) => {
                self.conn
                    .execute_batch("COMMIT;")
                    .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
                Ok(())
            }
            Err(e) => {
                let _ = self.conn.execute_batch("ROLLBACK;");
                Err(e)
            }
        }
    }

    fn ids_for_term(&self, term: &str) -> Result<HashSet<String>, ProjectError> {
        // Match JS `term.length < 3` (UTF-16 length).
        if term.encode_utf16().count() < 3 {
            let mut stmt = self
                .conn
                .prepare("SELECT id FROM memory_doc WHERE body LIKE ?1 ESCAPE '\\'")
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let rows = stmt
                .query_map(params![like_pattern(term)], |row| row.get::<_, String>(0))
                .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
            let mut set = HashSet::new();
            for r in rows.flatten() {
                set.insert(r);
            }
            return Ok(set);
        }
        let mut stmt = self
            .conn
            .prepare("SELECT id FROM memory_fts WHERE memory_fts MATCH ?1")
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let Ok(rows) = stmt.query_map(params![fts_phrase(term)], |row| row.get::<_, String>(0))
        else {
            return Ok(HashSet::new());
        };
        let mut set = HashSet::new();
        for r in rows.flatten() {
            set.insert(r);
        }
        Ok(set)
    }

    pub fn search(&self, query: &str, limit: usize) -> Result<Vec<MemoryHit>, ProjectError> {
        let terms: Vec<&str> = query.split_whitespace().filter(|s| !s.is_empty()).collect();
        if terms.is_empty() || limit == 0 {
            return Ok(Vec::new());
        }
        let mut acc: Option<HashSet<String>> = None;
        for term in terms {
            let found = self.ids_for_term(term)?;
            acc = Some(match acc {
                Some(prev) => prev.intersection(&found).cloned().collect(),
                None => found,
            });
            if acc.as_ref().is_some_and(HashSet::is_empty) {
                return Ok(Vec::new());
            }
        }
        let ids: Vec<String> = acc.unwrap_or_default().into_iter().collect();
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(",");
        let sql = format!(
            "SELECT id, body, meta FROM memory_doc WHERE id IN ({placeholders}) ORDER BY updated_at DESC LIMIT ?"
        );
        let mut stmt = self
            .conn
            .prepare(&sql)
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let mut param_values: Vec<rusqlite::types::Value> =
            ids.into_iter().map(rusqlite::types::Value::Text).collect();
        param_values.push(rusqlite::types::Value::Integer(limit as i64));
        let rows = stmt
            .query_map(rusqlite::params_from_iter(param_values), |row| {
                let id: String = row.get(0)?;
                let body: String = row.get(1)?;
                let meta_str: String = row.get(2)?;
                Ok((id, body, meta_str))
            })
            .map_err(|e| ProjectError::new("SQLITE_ERROR", e.to_string()))?;
        let mut hits = Vec::new();
        for row in rows.flatten() {
            let meta = serde_json::from_str::<Value>(&row.2).unwrap_or(Value::String(row.2));
            hits.push(MemoryHit {
                id: row.0,
                text: row.1,
                meta,
            });
        }
        Ok(hits)
    }
}
