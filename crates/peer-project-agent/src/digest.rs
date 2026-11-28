//! Persistent per-workspace digest queue (`digest-queue.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/digest.mjs`:
//! defers `Surfacing::Digest` updates and merges them into a single anchored
//! `agent_reply` card when the daily digest time is due.

use crate::{ProjectError, atomic_write, is_valid_workspace_id};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

const MAX_DIGEST_BYTES: u64 = 4 * 1024 * 1024;
const DEFAULT_DIGEST_TIME: &str = "09:00";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DigestItem {
    pub id: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DigestStateDoc {
    #[serde(default)]
    items: BTreeMap<String, Vec<DigestItem>>,
    #[serde(default)]
    fired: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct DueDigest {
    pub date: String,
    pub message: Value,
    pub item_count: usize,
}

fn valid_clock(value: &str) -> Option<(String, u32)> {
    let t = value.trim();
    let (h, m) = t.split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let hour: u32 = h.parse().ok()?;
    let minute: u32 = m.parse().ok()?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((format!("{hour:02}:{minute:02}"), hour * 60 + minute))
}

fn normalize_clock(digest_time: &str) -> (String, u32) {
    valid_clock(digest_time).unwrap_or_else(|| (DEFAULT_DIGEST_TIME.to_owned(), 9 * 60))
}

fn valid_ymd(date: &str) -> bool {
    let b = date.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, &c)| i == 4 || i == 7 || c.is_ascii_digit())
}

pub fn digest_separator(digest_time: &str) -> String {
    let (clock, _) = normalize_clock(digest_time);
    format!("今天 {clock} · 今日小结")
}

fn utc_date_and_minutes(at_iso: &str) -> Option<(String, u32)> {
    let dt = OffsetDateTime::parse(at_iso.trim(), &Rfc3339)
        .ok()?
        .to_offset(time::UtcOffset::UTC);
    let date = format!(
        "{:04}-{:02}-{:02}",
        dt.year(),
        u8::from(dt.month()),
        dt.day()
    );
    let minutes = u32::from(dt.hour()) * 60 + u32::from(dt.minute());
    Some((date, minutes))
}

fn merge_references(items: &[DigestItem]) -> (Vec<String>, Vec<String>, Vec<Value>, Value) {
    let messages: Vec<&Value> = items
        .iter()
        .filter_map(|it| it.message.as_ref().filter(|m| m["kind"] == "agent_reply"))
        .collect();
    let collect_top = |key: &str| -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for m in &messages {
            if let Some(arr) = m[key].as_array() {
                for item in arr {
                    if let Some(s) = item.as_str().filter(|s| !s.is_empty())
                        && seen.insert(s.to_owned())
                    {
                        out.push(s.to_owned());
                    }
                }
            }
        }
        out
    };
    let collect_meta = |key: &str| -> Vec<String> {
        let mut seen = HashSet::new();
        let mut out = Vec::new();
        for m in &messages {
            if let Some(arr) = m["meta"][key].as_array() {
                for item in arr {
                    if let Some(s) = item.as_str().filter(|s| !s.is_empty())
                        && seen.insert(s.to_owned())
                    {
                        out.push(s.to_owned());
                    }
                }
            }
        }
        out
    };

    let sources = collect_top("sources");
    let reply_to = collect_top("replyTo");
    let mut marks = Vec::new();
    let mut digest_reply_ids = Vec::new();
    let mut session_states_map: BTreeMap<String, Value> = BTreeMap::new();

    for m in &messages {
        if let Some(arr) = m["marks"].as_array() {
            marks.extend(arr.iter().cloned());
        }
        if let Some(id) = m["id"].as_str().filter(|s| !s.is_empty()) {
            digest_reply_ids.push(Value::String(id.to_owned()));
        }
        if let Some(states) = m["meta"]["sessionStates"].as_array() {
            for st in states {
                if let Some(sid) = st["sessionId"].as_str().filter(|s| !s.is_empty()) {
                    session_states_map.insert(sid.to_owned(), st.clone());
                }
            }
        }
    }

    let mut meta = Map::new();
    meta.insert("memoryUsed".into(), json!(collect_meta("memoryUsed")));
    meta.insert("memoryLearned".into(), json!(collect_meta("memoryLearned")));
    meta.insert("evidenceRefs".into(), json!(collect_meta("evidenceRefs")));
    meta.insert(
        "reportFactKeys".into(),
        json!(collect_meta("reportFactKeys")),
    );
    if !digest_reply_ids.is_empty() {
        meta.insert("digestReplyIds".into(), Value::Array(digest_reply_ids));
    }
    if !session_states_map.is_empty() {
        meta.insert(
            "sessionStates".into(),
            Value::Array(session_states_map.into_values().collect()),
        );
    }

    (sources, reply_to, marks, Value::Object(meta))
}

pub struct DigestQueue {
    file: PathBuf,
}

impl DigestQueue {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            file: data_home
                .as_ref()
                .join("project-runtime")
                .join("digest-queue.json"),
        }
    }

    fn load_doc(&self) -> DigestStateDoc {
        let Ok(meta) = fs::metadata(&self.file) else {
            return DigestStateDoc::default();
        };
        if !meta.is_file() || meta.len() > MAX_DIGEST_BYTES {
            return DigestStateDoc::default();
        }
        let Ok(raw) = fs::read_to_string(&self.file) else {
            return DigestStateDoc::default();
        };
        serde_json::from_str::<DigestStateDoc>(&raw).unwrap_or_default()
    }

    fn save_doc(&self, doc: &DigestStateDoc) -> Result<(), ProjectError> {
        let mut encoded = serde_json::to_string(doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        encoded.push('\n');
        atomic_write(&self.file, encoded.as_bytes())
    }

    pub fn hold(
        &self,
        workspace_id: &str,
        id: Option<&str>,
        text: &str,
        message: Option<Value>,
        at: Option<&str>,
    ) -> Result<usize, ProjectError> {
        let ws = workspace_id.trim();
        let trimmed = text.trim();
        if !is_valid_workspace_id(ws) || trimmed.is_empty() {
            return Err(ProjectError::code("invalid_input"));
        }
        let mut doc = self.load_doc();
        let list = doc.items.entry(ws.to_owned()).or_default();
        let item_id = id
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| format!("digest-item-{}", list.len() + 1));
        if list.iter().any(|row| row.id == item_id) {
            return Ok(list.len());
        }
        list.push(DigestItem {
            id: item_id,
            text: trimmed.to_owned(),
            message: message.filter(|m| m["kind"] == "agent_reply"),
            at: at
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        });
        let len = list.len();
        self.save_doc(&doc)?;
        Ok(len)
    }

    pub fn pending(&self, workspace_id: &str) -> usize {
        self.load_doc()
            .items
            .get(workspace_id.trim())
            .map_or(0, Vec::len)
    }

    pub(crate) fn pending_messages(&self, workspace_id: &str) -> Vec<Value> {
        self.load_doc()
            .items
            .remove(workspace_id)
            .into_iter()
            .flatten()
            .filter_map(|item| item.message)
            .collect()
    }

    pub fn consider(
        &self,
        workspace_id: &str,
        at_iso: &str,
        digest_time: &str,
    ) -> Result<Option<DueDigest>, ProjectError> {
        let ws = workspace_id.trim();
        if !is_valid_workspace_id(ws) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        let Some((date, cur_minutes)) = utc_date_and_minutes(at_iso) else {
            return Ok(None);
        };
        let (clock, target_minutes) = normalize_clock(digest_time);
        let mut doc = self.load_doc();
        if doc
            .fired
            .get(ws)
            .is_some_and(|prev| prev.as_str() >= date.as_str())
        {
            return Ok(None);
        }
        if cur_minutes < target_minutes {
            return Ok(None);
        }
        let items = doc.items.get(ws).cloned().unwrap_or_default();
        if items.is_empty() {
            doc.fired.insert(ws.to_owned(), date);
            self.save_doc(&doc)?;
            return Ok(None);
        }

        let separator_label = digest_separator(&clock);
        let content = items
            .iter()
            .map(|it| it.text.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        let (sources, reply_to, marks, mut meta) = merge_references(&items);
        if let Some(obj) = meta.as_object_mut() {
            obj.insert("surfacing".into(), json!("digest"));
            obj.insert("digestDate".into(), json!(date));
        }
        let message = json!({
            "id": format!("digest:{ws}:{date}"),
            "role": "assistant",
            "kind": "agent_reply",
            "proactive": true,
            "separatorLabel": separator_label,
            "content": content,
            "sources": sources,
            "replyTo": reply_to,
            "marks": marks,
            "meta": meta,
        });
        Ok(Some(DueDigest {
            date,
            message,
            item_count: items.len(),
        }))
    }

    pub fn acknowledge(&self, workspace_id: &str, date: &str) -> Result<bool, ProjectError> {
        let ws = workspace_id.trim();
        let d = date.trim();
        if !is_valid_workspace_id(ws) || !valid_ymd(d) {
            return Ok(false);
        }
        let mut doc = self.load_doc();
        doc.fired.insert(ws.to_owned(), d.to_owned());
        doc.items.insert(ws.to_owned(), Vec::new());
        self.save_doc(&doc)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn hold_dedup_consider_due_time_and_acknowledge_merge_references() {
        let dir = tempdir().unwrap();
        let queue = DigestQueue::new(dir.path());
        let ws = "ws-digest-1";

        let m1 = json!({
            "id": "r-1",
            "kind": "agent_reply",
            "sources": ["s-1"],
            "replyTo": ["input-1"],
            "marks": [{"sessionId": "s-1", "outcome": "passed", "verdictRef": "verdict:s-1:passed"}],
            "meta": {
                "memoryUsed": ["mem-1"],
                "memoryLearned": [],
                "evidenceRefs": ["ev-1"],
                "sessionStates": [{"sessionId": "s-1", "status": "result_ready"}]
            }
        });
        let m2 = json!({
            "id": "r-2",
            "kind": "agent_reply",
            "sources": ["s-2", "s-1"],
            "replyTo": ["input-2"],
            "marks": [{"sessionId": "s-2", "outcome": "passed", "verdictRef": "verdict:s-2:passed"}],
            "meta": {
                "memoryUsed": [],
                "memoryLearned": ["mem-2"],
                "evidenceRefs": ["ev-2"],
                "sessionStates": [{"sessionId": "s-2", "status": "accepted"}]
            }
        });

        assert_eq!(
            queue
                .hold(ws, Some("r-1"), "First update", Some(m1.clone()), None)
                .unwrap(),
            1
        );
        // Duplicate id is ignored
        assert_eq!(
            queue
                .hold(ws, Some("r-1"), "First update", Some(m1), None)
                .unwrap(),
            1
        );
        assert_eq!(
            queue
                .hold(ws, Some("r-2"), "Second update", Some(m2), None)
                .unwrap(),
            2
        );
        assert_eq!(queue.pending(ws), 2);

        // Before 09:00 UTC -> not due
        assert!(
            queue
                .consider(ws, "2026-11-20T08:59:00.000Z", "09:00")
                .unwrap()
                .is_none()
        );

        // At 09:00 UTC -> due with merged metadata & separatorLabel
        let due = queue
            .consider(ws, "2026-11-20T09:00:00.000Z", "09:00")
            .unwrap()
            .expect("digest due");
        assert_eq!(due.date, "2026-11-20");
        assert_eq!(due.item_count, 2);
        assert_eq!(due.message["id"], "digest:ws-digest-1:2026-11-20");
        assert_eq!(due.message["separatorLabel"], "今天 09:00 · 今日小结");
        assert_eq!(due.message["content"], "First update\nSecond update");
        assert_eq!(due.message["sources"], json!(["s-1", "s-2"]));
        assert_eq!(due.message["replyTo"], json!(["input-1", "input-2"]));
        assert_eq!(due.message["meta"]["evidenceRefs"], json!(["ev-1", "ev-2"]));
        assert_eq!(due.message["meta"]["digestReplyIds"], json!(["r-1", "r-2"]));

        // Acknowledge clears queue & records fired date
        assert!(queue.acknowledge(ws, "2026-11-20").unwrap());
        assert_eq!(queue.pending(ws), 0);
        assert!(
            queue
                .consider(ws, "2026-11-20T12:00:00.000Z", "09:00")
                .unwrap()
                .is_none()
        );
    }
}
