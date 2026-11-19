//! Durable project inbox (`project-runtime/<workspaceId>/inbox.jsonl`,
//! `inbox-cursor.json`, and `inbox-<day>.jsonl.gz` archives).
//!
//! Matches `packages/runtime-node/src/project-agent/project-inbox.mjs` (ADR 80/85):
//! - Append-only JSONL with monotonic `seq`, deduplicated by `eventId` across active and gzip archives.
//! - 2-second merge window batches concurrent events for a single wake turn.
//! - Cursor advances only on `commit_batch` with `ok = true`.

use crate::{ProjectError, atomic_write, is_valid_workspace_id, now_iso, parse_iso_ms};
use flate2::{Compression, read::GzDecoder, write::GzEncoder};
use peer_store::DirectoryLock;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::Duration,
};

pub const DEFAULT_MERGE_WINDOW_MS: i64 = 2_000;
pub const DEFAULT_MAX_BYTES: u64 = 20 * 1024 * 1024;
pub const DEFAULT_ARCHIVE_AFTER_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const UNSCOPED_DIR: &str = "_unscoped";

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxCursor {
    pub seq: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct InboxBatch {
    pub events: Vec<Value>,
    pub through_seq: u64,
    pub wait_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppendResult {
    pub appended: usize,
    pub duplicates: Vec<String>,
}

pub struct ProjectInbox {
    runtime_root: PathBuf,
    merge_window_ms: i64,
    max_bytes: u64,
    archive_after_ms: i64,
}

impl ProjectInbox {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
            merge_window_ms: DEFAULT_MERGE_WINDOW_MS,
            max_bytes: DEFAULT_MAX_BYTES,
            archive_after_ms: DEFAULT_ARCHIVE_AFTER_MS,
        }
    }

    pub fn with_limits(
        data_home: impl AsRef<Path>,
        merge_window_ms: i64,
        max_bytes: u64,
        archive_after_ms: i64,
    ) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
            merge_window_ms: merge_window_ms.max(0),
            max_bytes: max_bytes.max(1),
            archive_after_ms: archive_after_ms.max(0),
        }
    }

    fn dir_for(&self, workspace_id: &str) -> PathBuf {
        let dir_name = if is_valid_workspace_id(workspace_id) {
            workspace_id
        } else {
            UNSCOPED_DIR
        };
        self.runtime_root.join(dir_name)
    }

    fn inbox_file(&self, workspace_id: &str) -> PathBuf {
        self.dir_for(workspace_id).join("inbox.jsonl")
    }

    fn cursor_file(&self, workspace_id: &str) -> PathBuf {
        self.dir_for(workspace_id).join("inbox-cursor.json")
    }

    fn read_events(&self, workspace_id: &str) -> Vec<Value> {
        let file = self.inbox_file(workspace_id);
        let Ok(raw) = fs::read_to_string(&file) else {
            return Vec::new();
        };
        let mut events = Vec::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(ev) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if ev["eventId"].as_str().is_some_and(|s| !s.is_empty())
                && ev["seq"].as_u64().is_some_and(|n| n > 0)
            {
                events.push(ev);
            }
        }
        events.sort_by_key(|ev| ev["seq"].as_u64().unwrap_or(0));
        events
    }

    fn known_ids(&self, workspace_id: &str, active: &[Value]) -> HashSet<String> {
        let mut ids: HashSet<String> = active
            .iter()
            .filter_map(|e| e["eventId"].as_str().map(str::to_owned))
            .collect();
        let Ok(entries) = fs::read_dir(self.dir_for(workspace_id)) else {
            return ids;
        };
        for entry in entries.flatten() {
            let name = entry.file_name();
            let Some(s) = name.to_str() else { continue };
            if !s.starts_with("inbox-") || !s.ends_with(".jsonl.gz") {
                continue;
            }
            let Ok(bytes) = fs::read(entry.path()) else {
                continue;
            };
            let mut decoder = GzDecoder::new(&bytes[..]);
            let mut text = String::new();
            if decoder.read_to_string(&mut text).is_err() {
                continue;
            }
            for line in text.lines() {
                if let Ok(ev) = serde_json::from_str::<Value>(line)
                    && let Some(id) = ev["eventId"].as_str()
                {
                    ids.insert(id.to_owned());
                }
            }
        }
        ids
    }

    pub fn read_cursor(&self, workspace_id: &str) -> InboxCursor {
        let file = self.cursor_file(workspace_id);
        let Ok(raw) = fs::read_to_string(&file) else {
            return InboxCursor::default();
        };
        serde_json::from_str::<InboxCursor>(&raw).unwrap_or_default()
    }

    fn write_cursor(&self, workspace_id: &str, seq: u64) -> Result<InboxCursor, ProjectError> {
        let cursor = InboxCursor {
            seq,
            updated_at: Some(now_iso()),
        };
        let body = serde_json::to_string(&cursor)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        atomic_write(&self.cursor_file(workspace_id), body.as_bytes())?;
        Ok(cursor)
    }

    pub fn append(
        &self,
        workspace_id: &str,
        incoming: &[Value],
    ) -> Result<AppendResult, ProjectError> {
        let file = self.inbox_file(workspace_id);
        let dir = self.dir_for(workspace_id);
        fs::create_dir_all(&dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let _lock = DirectoryLock::acquire(&file, LOCK_TIMEOUT, None)?;
        let existing = self.read_events(workspace_id);
        let mut seen = self.known_ids(workspace_id, &existing);
        let mut seq = existing
            .iter()
            .filter_map(|e| e["seq"].as_u64())
            .max()
            .unwrap_or(0);
        let mut appended = 0usize;
        let mut duplicates = Vec::new();
        let mut lines = String::new();
        let stamp = now_iso();
        for ev in incoming {
            let Some(obj) = ev.as_object() else { continue };
            let Some(event_id) = obj
                .get("eventId")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            else {
                continue;
            };
            if !seen.insert(event_id.to_owned()) {
                duplicates.push(event_id.to_owned());
                continue;
            }
            seq += 1;
            let mut stored = obj.clone();
            if stored
                .get("workspaceId")
                .and_then(Value::as_str)
                .is_none_or(|s| s.is_empty())
            {
                stored.insert("workspaceId".into(), json!(workspace_id));
            }
            stored.insert("seq".into(), json!(seq));
            if stored
                .get("at")
                .and_then(Value::as_str)
                .is_none_or(|s| s.trim().is_empty())
            {
                stored.insert("at".into(), json!(stamp));
            }
            let encoded = serde_json::to_string(&Value::Object(stored))
                .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
            lines.push_str(&encoded);
            lines.push('\n');
            appended += 1;
        }
        if !lines.is_empty() {
            let mut handle = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&file)
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            handle
                .write_all(lines.as_bytes())
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            handle
                .sync_all()
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            let _ = self.archive_consumed_unlocked(workspace_id);
        }
        Ok(AppendResult {
            appended,
            duplicates,
        })
    }

    fn archive_consumed_unlocked(&self, workspace_id: &str) -> Result<usize, ProjectError> {
        let file = self.inbox_file(workspace_id);
        let Ok(meta) = fs::metadata(&file) else {
            return Ok(0);
        };
        if meta.len() <= self.max_bytes {
            return Ok(0);
        }
        let cursor = self.read_cursor(workspace_id).seq;
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let cutoff = now_ms.saturating_sub(self.archive_after_ms);
        let events = self.read_events(workspace_id);
        let mut keep = Vec::new();
        let mut drop_events = Vec::new();
        for ev in events {
            let ev_seq = ev["seq"].as_u64().unwrap_or(0);
            let at_ms = ev["at"].as_str().and_then(parse_iso_ms);
            if ev_seq <= cursor && at_ms.is_some_and(|ms| ms < cutoff) {
                drop_events.push(ev);
            } else {
                keep.push(ev);
            }
        }
        if drop_events.is_empty() {
            return Ok(0);
        }
        let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for ev in &drop_events {
            let day = ev["at"]
                .as_str()
                .filter(|s| s.len() >= 10 && s.as_bytes()[4] == b'-' && s.as_bytes()[7] == b'-')
                .map(|s| s[..10].to_owned())
                .unwrap_or_else(|| "undated".to_owned());
            groups.entry(day).or_default().push(ev.clone());
        }
        let dir = self.dir_for(workspace_id);
        for (day, rows) in groups {
            let mut body = String::new();
            for row in rows {
                if let Ok(line) = serde_json::to_string(&row) {
                    body.push_str(&line);
                    body.push('\n');
                }
            }
            let mut encoder = GzEncoder::new(Vec::new(), Compression::default());
            encoder
                .write_all(body.as_bytes())
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            let gz = encoder
                .finish()
                .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
            let mut target = dir.join(format!("inbox-{day}.jsonl.gz"));
            let mut suffix = 1u32;
            while target.exists() {
                target = dir.join(format!("inbox-{day}-{suffix}.jsonl.gz"));
                suffix += 1;
            }
            atomic_write(&target, &gz)?;
        }
        let mut kept = String::new();
        for row in keep {
            if let Ok(line) = serde_json::to_string(&row) {
                kept.push_str(&line);
                kept.push('\n');
            }
        }
        atomic_write(&file, kept.as_bytes())?;
        Ok(drop_events.len())
    }

    /// Take unconsumed events past cursor. If the latest unconsumed event is still inside
    /// `merge_window_ms` (unless `ignore_window` is true), returns `events = []` and `wait_ms > 0`.
    pub fn take_batch(&self, workspace_id: &str, now_ms: i64, ignore_window: bool) -> InboxBatch {
        let cursor = self.read_cursor(workspace_id).seq;
        let pending: Vec<Value> = self
            .read_events(workspace_id)
            .into_iter()
            .filter(|ev| ev["seq"].as_u64().unwrap_or(0) > cursor)
            .collect();
        if pending.is_empty() {
            return InboxBatch {
                events: Vec::new(),
                through_seq: cursor,
                wait_ms: 0,
            };
        }
        if !ignore_window && self.merge_window_ms > 0 {
            let latest_at = pending
                .last()
                .and_then(|ev| ev["at"].as_str())
                .and_then(parse_iso_ms);
            if let Some(at_ms) = latest_at {
                let elapsed = now_ms.saturating_sub(at_ms);
                if elapsed < self.merge_window_ms {
                    return InboxBatch {
                        events: Vec::new(),
                        through_seq: cursor,
                        wait_ms: self.merge_window_ms - elapsed,
                    };
                }
            }
        }
        let through_seq = pending
            .last()
            .and_then(|ev| ev["seq"].as_u64())
            .unwrap_or(cursor);
        InboxBatch {
            events: pending,
            through_seq,
            wait_ms: 0,
        }
    }

    pub fn commit_batch(
        &self,
        workspace_id: &str,
        through_seq: u64,
        ok: bool,
    ) -> Result<InboxCursor, ProjectError> {
        let current = self.read_cursor(workspace_id);
        if !ok || through_seq <= current.seq {
            return Ok(current);
        }
        self.write_cursor(workspace_id, through_seq)
    }

    pub fn list_recent(&self, workspace_id: &str, limit: usize) -> Vec<Value> {
        let mut events = self.read_events(workspace_id);
        if events.len() > limit {
            events.drain(..events.len() - limit);
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn inbox_dedup_merge_window_and_gzip_archive_work() {
        let dir = tempdir().unwrap();
        let inbox = ProjectInbox::with_limits(dir.path(), 2_000, 128, 0);
        let r1 = inbox
            .append(
                "ws-1",
                &[
                    json!({"eventId":"ev-1","kind":"session_ended","at":"2026-01-01T00:00:00.000Z","payload":{}}),
                    json!({"eventId":"ev-1","kind":"session_ended","at":"2026-01-01T00:00:00.000Z","payload":{}}),
                ],
            )
            .unwrap();
        assert_eq!(r1.appended, 1);
        assert_eq!(r1.duplicates, vec!["ev-1"]);

        let t0 = parse_iso_ms("2026-01-01T00:00:00.500Z").unwrap();
        let waiting = inbox.take_batch("ws-1", t0, false);
        assert!(waiting.events.is_empty());
        assert_eq!(waiting.wait_ms, 1500);

        let t1 = parse_iso_ms("2026-01-01T00:00:03.000Z").unwrap();
        let ready = inbox.take_batch("ws-1", t1, false);
        assert_eq!(ready.events.len(), 1);
        assert_eq!(ready.through_seq, 1);

        inbox.commit_batch("ws-1", ready.through_seq, true).unwrap();
        assert!(inbox.take_batch("ws-1", t1, false).events.is_empty());

        // Trigger gzip archive and confirm dedup still remembers archived ev-1.
        let r2 = inbox
            .append(
                "ws-1",
                &[json!({"eventId":"ev-2","kind":"session_ended","at":"2026-01-01T00:00:05.000Z","payload":{"pad":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}})],
            )
            .unwrap();
        assert_eq!(r2.appended, 1);
        let dup_archived = inbox
            .append(
                "ws-1",
                &[json!({"eventId":"ev-1","kind":"session_ended","at":"2026-01-01T00:00:06.000Z","payload":{}})],
            )
            .unwrap();
        assert_eq!(dup_archived.appended, 0);
        assert_eq!(dup_archived.duplicates, vec!["ev-1"]);
    }
}
