//! Episodic material log, curator rate clock (`10 min`, `8 user inputs`), and candidate cache
//! (`packages/runtime-node/src/memory/episodes.mjs`).

use crate::{ProjectError, atomic_write, is_valid_workspace_id, parse_iso_ms};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

pub const CURATOR_INTERVAL_MS: i64 = 10 * 60 * 1000;
pub const USER_INPUTS_PER_RUN: usize = 8;
pub const FINGERPRINT_MAX: usize = 200;

pub fn is_task_end_event(event: &Value) -> bool {
    matches!(
        event["kind"].as_str(),
        Some("session_verified" | "result_ready" | "failed" | "cancelled" | "interrupted")
    )
}

pub fn fingerprint_material(
    trigger: &str,
    texts: &[String],
    evidence_refs: &[String],
    session_ids: &[String],
    untrusted: bool,
) -> String {
    let body = json!({
        "trigger": trigger,
        "texts": texts,
        "evidenceRefs": evidence_refs,
        "sessionIds": session_ids,
        "untrusted": untrusted,
    });
    let serialized = serde_json::to_string(&body).unwrap_or_else(|_| "{}".into());
    format!("{:x}", Sha256::digest(serialized.as_bytes()))
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CuratorClock {
    #[serde(default)]
    pub last_run_at: Option<String>,
    #[serde(default)]
    pub user_inputs: usize,
    #[serde(default)]
    pub pending_texts: Vec<String>,
    #[serde(default)]
    pub fingerprints: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEpisode {
    pub id: String,
    pub workspace_id: String,
    pub anchor_message_id: String,
    #[serde(default)]
    pub dispositions: Vec<Value>,
    pub summary: String,
    pub opened_at: String,
    pub closed_at: String,
    pub trigger: String,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub evidence_refs: Vec<String>,
    #[serde(default)]
    pub evidence_texts: BTreeMap<String, String>,
    #[serde(default)]
    pub texts: Vec<String>,
    #[serde(default)]
    pub untrusted: bool,
    pub fingerprint: String,
    #[serde(default)]
    pub extracted: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCandidateRecord {
    pub key: String,
    pub status: String,
    pub reason: String,
    #[serde(default)]
    pub episode_ids: Vec<String>,
    #[serde(default)]
    pub memory_id: Option<String>,
    pub candidate: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn clean_strings(values: &[String], max_items: usize, max_chars: usize) -> Vec<String> {
    let mut out = Vec::new();
    for raw in values {
        let trimmed = raw.trim();
        if trimmed.is_empty() {
            continue;
        }
        let clipped: String = trimmed.chars().take(max_chars).collect();
        out.push(clipped);
        if out.len() >= max_items {
            break;
        }
    }
    out
}

pub struct EpisodeLog {
    data_home: PathBuf,
}

impl EpisodeLog {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
        }
    }

    fn memory_dir(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("projects")
            .join(workspace_id)
            .join("memory"))
    }

    pub fn episode_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        Ok(self.memory_dir(workspace_id)?.join("episodes.jsonl"))
    }

    pub fn candidate_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        Ok(self.memory_dir(workspace_id)?.join("candidates.jsonl"))
    }

    fn clock_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        Ok(self.memory_dir(workspace_id)?.join("curator-clock.json"))
    }

    pub fn read_clock(&self, workspace_id: &str) -> CuratorClock {
        let Ok(file) = self.clock_file(workspace_id) else {
            return CuratorClock::default();
        };
        let Ok(raw) = fs::read_to_string(&file) else {
            return CuratorClock::default();
        };
        let Ok(mut clock) = serde_json::from_str::<CuratorClock>(&raw) else {
            return CuratorClock::default();
        };
        clock.pending_texts = clean_strings(&clock.pending_texts, 32, 2000);
        clock.fingerprints = clean_strings(&clock.fingerprints, FINGERPRINT_MAX, 80);
        clock
    }

    fn write_clock(&self, workspace_id: &str, clock: &CuratorClock) -> Result<(), ProjectError> {
        let file = self.clock_file(workspace_id)?;
        let mut body = serde_json::to_string(clock)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&file, body.as_bytes())
    }

    pub fn note_user_texts(&self, workspace_id: &str, texts: &[String]) -> CuratorClock {
        let incoming = clean_strings(texts, 32, 2000);
        if !is_valid_workspace_id(workspace_id) || incoming.is_empty() {
            return CuratorClock::default();
        }
        let mut clock = self.read_clock(workspace_id);
        clock.user_inputs += incoming.len();
        let mut merged = clock.pending_texts;
        merged.extend(incoming);
        clock.pending_texts = clean_strings(&merged, 32, 2000);
        let _ = self.write_clock(workspace_id, &clock);
        clock
    }

    pub fn take_user_material(&self, workspace_id: &str) -> Option<Vec<String>> {
        let mut clock = self.read_clock(workspace_id);
        if clock.user_inputs < USER_INPUTS_PER_RUN || clock.pending_texts.is_empty() {
            return None;
        }
        let texts = std::mem::take(&mut clock.pending_texts);
        clock.user_inputs = 0;
        let _ = self.write_clock(workspace_id, &clock);
        Some(texts)
    }

    pub fn user_input_count(&self, workspace_id: &str) -> usize {
        self.read_clock(workspace_id).user_inputs
    }

    pub fn seen(&self, workspace_id: &str, fingerprint: &str) -> bool {
        self.read_clock(workspace_id)
            .fingerprints
            .iter()
            .any(|f| f == fingerprint)
    }

    pub fn remember_fingerprint(&self, workspace_id: &str, fingerprint: &str) {
        if fingerprint.is_empty() || !is_valid_workspace_id(workspace_id) {
            return;
        }
        let mut clock = self.read_clock(workspace_id);
        if clock.fingerprints.iter().any(|f| f == fingerprint) {
            return;
        }
        clock.fingerprints.push(fingerprint.to_owned());
        if clock.fingerprints.len() > FINGERPRINT_MAX {
            let drain = clock.fingerprints.len() - FINGERPRINT_MAX;
            clock.fingerprints.drain(..drain);
        }
        let _ = self.write_clock(workspace_id, &clock);
    }

    pub fn due(&self, workspace_id: &str, at_iso: &str) -> bool {
        let Some(last) = self.read_clock(workspace_id).last_run_at else {
            return true;
        };
        let Some(last_ms) = parse_iso_ms(&last) else {
            return true;
        };
        let Some(at_ms) = parse_iso_ms(at_iso) else {
            return true;
        };
        at_ms - last_ms >= CURATOR_INTERVAL_MS
    }

    pub fn next_due_at(&self, workspace_id: &str) -> Option<String> {
        let last = self.read_clock(workspace_id).last_run_at?;
        let ms = parse_iso_ms(&last)?;
        time::OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(ms + CURATOR_INTERVAL_MS) * 1_000_000,
        )
        .ok()
        .and_then(crate::format_iso)
    }

    pub fn mark_ran(&self, workspace_id: &str, at_iso: &str) {
        let mut clock = self.read_clock(workspace_id);
        clock.last_run_at = Some(at_iso.to_owned());
        let _ = self.write_clock(workspace_id, &clock);
    }

    fn append_jsonl(&self, file: &Path, val: &impl Serialize) -> Result<(), ProjectError> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let mut line = serde_json::to_string(val)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        line.push('\n');
        let mut handle = OpenOptions::new()
            .create(true)
            .append(true)
            .open(file)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        handle
            .write_all(line.as_bytes())
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        handle
            .sync_all()
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        Ok(())
    }

    pub fn append_episode(&self, episode: &MemoryEpisode) -> Result<(), ProjectError> {
        let file = self.episode_file(&episode.workspace_id)?;
        self.append_jsonl(&file, episode)
    }

    pub fn list_episodes(&self, workspace_id: &str) -> Vec<MemoryEpisode> {
        let Ok(file) = self.episode_file(workspace_id) else {
            return Vec::new();
        };
        let Ok(raw) = fs::read_to_string(&file) else {
            return Vec::new();
        };
        let mut by_id = BTreeMap::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(ep) = serde_json::from_str::<MemoryEpisode>(line)
                && !ep.id.is_empty()
            {
                by_id.insert(ep.id.clone(), ep);
            }
        }
        by_id.into_values().collect()
    }

    pub fn mark_extracted(
        &self,
        workspace_id: &str,
        episode_id: &str,
    ) -> Result<Option<MemoryEpisode>, ProjectError> {
        let Some(mut ep) = self
            .list_episodes(workspace_id)
            .into_iter()
            .find(|e| e.id == episode_id)
        else {
            return Ok(None);
        };
        ep.extracted = true;
        self.append_episode(&ep)?;
        Ok(Some(ep))
    }

    pub fn next_unextracted(&self, workspace_id: &str) -> Option<MemoryEpisode> {
        let mut list: Vec<MemoryEpisode> = self
            .list_episodes(workspace_id)
            .into_iter()
            .filter(|e| !e.extracted)
            .collect();
        list.sort_by(|a, b| a.opened_at.cmp(&b.opened_at));
        list.into_iter().next()
    }

    pub fn list_candidates(&self, workspace_id: &str) -> Vec<MemoryCandidateRecord> {
        let Ok(file) = self.candidate_file(workspace_id) else {
            return Vec::new();
        };
        let Ok(raw) = fs::read_to_string(&file) else {
            return Vec::new();
        };
        let mut by_key = BTreeMap::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            if let Ok(rec) = serde_json::from_str::<MemoryCandidateRecord>(line)
                && !rec.key.is_empty()
            {
                by_key.insert(rec.key.clone(), rec);
            }
        }
        by_key.into_values().collect()
    }

    pub fn read_candidate(&self, workspace_id: &str, key: &str) -> Option<MemoryCandidateRecord> {
        self.list_candidates(workspace_id)
            .into_iter()
            .find(|c| c.key == key)
    }

    pub fn write_candidate(
        &self,
        workspace_id: &str,
        candidate: &MemoryCandidateRecord,
    ) -> Result<(), ProjectError> {
        let file = self.candidate_file(workspace_id)?;
        self.append_jsonl(&file, candidate)
    }
}
