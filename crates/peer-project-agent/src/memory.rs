//! Project & user memory store (`projects/<workspaceId>/memory/items.jsonl`
//! and `memory/items.jsonl`) with secret redaction, conflict detection,
//! rebuildable SQLite FTS5 trigram search, and frozen work-session snapshots.
//!
//! Matches `packages/runtime-node/src/memory/*` (ADR 81).
//! JSONL is the canonical source of truth; the SQLite index is a disposable cache.

pub mod admission;
pub mod conflict;
pub mod curator;
pub mod episodes;
pub mod file_anchors;
pub mod index;
pub mod maintenance;
pub mod snapshot;

use crate::{ProjectError, is_valid_workspace_id, now_iso, parse_iso_ms};
use peer_store::DirectoryLock;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

pub use admission::{
    AdmissionContext, AdmissionDecision, CuratorCandidate, decide_memory_admission,
    parse_curator_output, validate_curator_candidate,
};
pub use conflict::{MemoryConflictDecision, memory_conflict_decision};
pub use curator::{
    CURATOR_EXCLUDED_CAPABILITY_PREFIXES, CuratorOutcome, MemoryCurator, curator_prompt,
};
pub use episodes::{
    CURATOR_INTERVAL_MS, CuratorClock, EpisodeLog, MemoryCandidateRecord, MemoryEpisode,
    USER_INPUTS_PER_RUN, fingerprint_material, is_task_end_event,
};
pub use file_anchors::{capture_file_anchors, read_file_anchor};
pub use index::{MemoryHit, MemoryIndex};
pub use maintenance::{MaintenanceOutcome, MemoryMaintenance};
pub use snapshot::{FrozenMemoryItem, MemorySnapshot, create_snapshot, read_snapshots};

const TEXT_MAX: usize = 2000;
const REASON_MAX: usize = 500;
const REF_MAX: usize = 200;
const REF_COUNT_MAX: usize = 16;
const INFERRED_STALE_MS: i64 = 90 * 24 * 60 * 60 * 1000;
const LOCK_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryFileAnchor {
    pub path: String,
    pub content_hash: String,
    #[serde(default)]
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    pub scope: String,
    pub kind: String,
    pub text: String,
    pub trust: String,
    pub source_refs: Vec<String>,
    #[serde(default)]
    pub pinned: bool,
    pub status: String,
    #[serde(default = "default_confirmed_count")]
    pub confirmed_count: u32,
    pub created_at: String,
    pub updated_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_used_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_message_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub forget_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub topic_value: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_anchors: Option<Vec<MemoryFileAnchor>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub needs_reverify: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflict_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub superseded_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub maintenance_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conflicts_with: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

fn default_confirmed_count() -> u32 {
    1
}

/// Union of protocol secret patterns and shell redaction rules (`memory-redaction.mjs`).
/// Any match rejects the entire memory write rather than saving redacted text.
pub fn memory_secret_reason(value: &str) -> Option<&'static str> {
    if value.is_empty() {
        return None;
    }
    static PATTERNS: OnceLock<Vec<Regex>> = OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}",
            r"AKIA[0-9A-Z]{16}",
            r"sk-[A-Za-z0-9_-]{20,}",
            r"(?i)Bearer\s+[A-Za-z0-9._-]+",
            r"(?i)[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY)=[^\s]+",
        ]
        .iter()
        .map(|p| Regex::new(p).expect("compiled secret regex"))
        .collect()
    });
    patterns
        .iter()
        .any(|re| re.is_match(value))
        .then_some("sensitive")
}

/// Matches `isEffectiveMemory` in `packages/runtime-node/src/memory/memory-store.mjs`.
pub fn is_effective_memory(item: &MemoryItem, at_ms: i64) -> bool {
    if item.status != "active" || item.needs_reverify == Some(true) {
        return false;
    }
    if item.pinned || item.kind == "responsibility" {
        return true;
    }
    if let Some(ref exp) = item.expires_at
        && parse_iso_ms(exp).is_some_and(|ms| ms <= at_ms)
    {
        return false;
    }
    if item.kind == "preference" && item.trust == "inferred" {
        let reference = item
            .last_used_at
            .as_deref()
            .unwrap_or(item.created_at.as_str());
        if let Some(ref_ms) = parse_iso_ms(reference)
            && at_ms.saturating_sub(ref_ms) >= INFERRED_STALE_MS
        {
            return false;
        }
    }
    true
}

fn valid_kind(kind: &str) -> bool {
    matches!(
        kind,
        "fact" | "preference" | "decision" | "procedure" | "responsibility"
    )
}

fn valid_status(status: &str) -> bool {
    matches!(status, "active" | "forgotten" | "expired" | "conflicted")
}

fn valid_topic_key(key: &str) -> bool {
    let bytes = key.as_bytes();
    if bytes.is_empty() || bytes.len() > 120 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}

fn normalize_item(mut item: MemoryItem) -> Option<MemoryItem> {
    item.id = item.id.trim().to_owned();
    item.text = item.text.trim().to_owned();
    if item.id.is_empty()
        || item.id.len() > 200
        || item.text.is_empty()
        || item.text.chars().count() > TEXT_MAX
        || !valid_kind(&item.kind)
        || !valid_status(&item.status)
    {
        return None;
    }
    let inferred_pref = item.trust == "inferred"
        && item.kind == "preference"
        && item.scope == "user"
        && item.confirmed_count >= 3;
    if item.trust != "stated" && item.trust != "verified" && !inferred_pref {
        return None;
    }
    match item.scope.as_str() {
        "project" => {
            if item.kind == "preference" {
                return None;
            }
            if !item
                .workspace_id
                .as_deref()
                .is_some_and(is_valid_workspace_id)
            {
                return None;
            }
        }
        "user" => {
            if item.kind != "preference" {
                return None;
            }
            item.workspace_id = None;
        }
        _ => return None,
    }
    if item.source_refs.is_empty() || item.source_refs.len() > REF_COUNT_MAX {
        return None;
    }
    for r in &mut item.source_refs {
        *r = r.trim().to_owned();
        if r.is_empty() || r.len() > REF_MAX {
            return None;
        }
    }
    if let Some(ref tk) = item.topic_key {
        if !valid_topic_key(tk) {
            return None;
        }
        let tv = item.topic_value.as_ref()?;
        let tv_trim = tv.trim();
        if tv_trim.is_empty() || tv_trim.len() > 200 || memory_secret_reason(tv_trim).is_some() {
            return None;
        }
        item.topic_key = Some(tk.to_lowercase());
        item.topic_value = Some(tv_trim.to_lowercase());
    }
    if let Some(ref anchors) = item.file_anchors {
        if anchors.len() > 16 {
            return None;
        }
        for anchor in anchors {
            if anchor.path.is_empty()
                || anchor.path.len() > 500
                || anchor.path.starts_with('/')
                || anchor.path.contains('\\')
                || anchor.path.split('/').any(|seg| seg == "..")
                || anchor.content_hash.is_empty()
                || anchor.content_hash.len() > 128
            {
                return None;
            }
        }
    }
    Some(item)
}

pub struct WriteMemoryRequest<'a> {
    pub scope: &'a str,
    pub workspace_id: Option<&'a str>,
    pub kind: &'a str,
    pub text: &'a str,
    pub trust: &'a str,
    pub source_refs: Vec<String>,
    pub pinned: bool,
    pub anchor_message_id: Option<&'a str>,
    pub expires_at: Option<&'a str>,
    pub topic_key: Option<&'a str>,
    pub topic_value: Option<&'a str>,
    pub file_anchors: Option<Vec<MemoryFileAnchor>>,
}

pub struct WriteCuratedMemoryRequest<'a> {
    pub scope: &'a str,
    pub workspace_id: Option<&'a str>,
    pub kind: &'a str,
    pub text: &'a str,
    pub trust: &'a str,
    pub source_refs: Vec<String>,
    pub confirmed_count: u32,
    pub pinned: bool,
    pub anchor_message_id: Option<&'a str>,
    pub expires_at: Option<&'a str>,
    pub topic_key: Option<&'a str>,
    pub topic_value: Option<&'a str>,
    pub file_anchors: Option<Vec<MemoryFileAnchor>>,
}

#[derive(Debug, Clone, Default)]
pub struct MemoryFilter<'a> {
    pub scope: Option<&'a str>,
    pub workspace_id: Option<&'a str>,
    pub kind: Option<&'a str>,
    pub status: Option<&'a str>,
}

pub struct MemoryStore {
    data_home: PathBuf,
}

impl MemoryStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
        }
    }

    pub fn user_file(&self) -> PathBuf {
        self.data_home.join("memory").join("items.jsonl")
    }

    pub fn project_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("projects")
            .join(workspace_id)
            .join("memory")
            .join("items.jsonl"))
    }

    pub fn index_file(&self, workspace_id: Option<&str>) -> Result<PathBuf, ProjectError> {
        if let Some(ws) = workspace_id
            && !is_valid_workspace_id(ws)
        {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("cache")
            .join("memory-index")
            .join("memory-index.sqlite"))
    }

    fn fold_file(&self, file: &Path) -> Vec<MemoryItem> {
        let Ok(raw) = fs::read_to_string(file) else {
            return Vec::new();
        };
        let mut folded: BTreeMap<String, MemoryItem> = BTreeMap::new();
        for line in raw.lines() {
            if line.trim().is_empty() {
                continue;
            }
            let Ok(parsed) = serde_json::from_str::<MemoryItem>(line) else {
                continue;
            };
            if let Some(norm) = normalize_item(parsed) {
                folded.insert(norm.id.clone(), norm);
            }
        }
        folded.into_values().collect()
    }

    fn append_item(&self, file: &Path, item: &MemoryItem) -> Result<(), ProjectError> {
        if let Some(dir) = file.parent() {
            fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        }
        let _lock = DirectoryLock::acquire(file, LOCK_TIMEOUT, None)?;
        let mut line = serde_json::to_string(item)
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

    /// Write a stated or verified memory item. Rejects secrets and `inferred` via tool path.
    pub fn write(&self, req: &WriteMemoryRequest<'_>) -> Result<MemoryItem, ProjectError> {
        if req.trust == "inferred" {
            return Err(ProjectError::code("INFERRED_NOT_ALLOWED"));
        }
        if memory_secret_reason(req.text).is_some() {
            return Err(ProjectError::code("sensitive"));
        }
        let at = now_iso();
        let candidate = MemoryItem {
            id: format!("mem-{}", uuid::Uuid::new_v4()),
            scope: req.scope.to_owned(),
            kind: req.kind.to_owned(),
            text: req.text.to_owned(),
            trust: req.trust.to_owned(),
            source_refs: req.source_refs.clone(),
            pinned: req.pinned,
            status: "active".to_owned(),
            confirmed_count: 1,
            created_at: at.clone(),
            updated_at: at,
            last_used_at: None,
            workspace_id: req.workspace_id.map(str::to_owned),
            anchor_message_id: req.anchor_message_id.map(str::to_owned),
            forget_reason: None,
            expires_at: req.expires_at.map(str::to_owned),
            topic_key: req.topic_key.map(str::to_owned),
            topic_value: req.topic_value.map(str::to_owned),
            file_anchors: req.file_anchors.clone(),
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Map::new(),
        };
        let mut item =
            normalize_item(candidate).ok_or_else(|| ProjectError::code("INVALID_MEMORY"))?;
        let file = match item.scope.as_str() {
            "user" => self.user_file(),
            "project" => self.project_file(item.workspace_id.as_deref().unwrap_or(""))?,
            _ => return Err(ProjectError::code("INVALID_MEMORY")),
        };
        let existing = self.fold_file(&file);
        let created_at = item.created_at.clone();
        self.apply_conflict_decision(&file, &existing, &mut item, &created_at);
        self.append_item(&file, &item)?;
        if item.status == "active"
            && let Ok(idx_path) = self.index_file(item.workspace_id.as_deref())
            && let Ok(idx) = MemoryIndex::open(&idx_path)
        {
            let _ = idx.upsert(&item);
        }
        Ok(item)
    }

    fn apply_conflict_decision(
        &self,
        file: &Path,
        existing: &[MemoryItem],
        item: &mut MemoryItem,
        at: &str,
    ) {
        let dec = memory_conflict_decision(item, existing);
        if !dec.replace_ids.is_empty() {
            let replace_set: std::collections::HashSet<&str> =
                dec.replace_ids.iter().map(String::as_str).collect();
            for old in existing {
                if !replace_set.contains(old.id.as_str()) {
                    continue;
                }
                let mut superseded = old.clone();
                superseded.status = "forgotten".to_owned();
                superseded.superseded_by = Some(item.id.clone());
                superseded.forget_reason = Some("superseded".to_owned());
                superseded.updated_at = at.to_owned();
                let _ = self.append_item(file, &superseded);
                if let Ok(idx_path) = self.index_file(superseded.workspace_id.as_deref())
                    && let Ok(idx) = MemoryIndex::open(&idx_path)
                {
                    let _ = idx.remove(&superseded.id);
                }
            }
        }
        if !dec.conflict_ids.is_empty() {
            let conflict_set: std::collections::HashSet<&str> =
                dec.conflict_ids.iter().map(String::as_str).collect();
            let conflict_id = format!("conf-{}", uuid::Uuid::new_v4());
            for old in existing {
                if !conflict_set.contains(old.id.as_str()) {
                    continue;
                }
                let mut flagged = old.clone();
                let mut list = flagged.conflicts_with.clone().unwrap_or_default();
                if !list.contains(&item.id) {
                    list.push(item.id.clone());
                }
                flagged.conflicts_with = Some(list);
                flagged.conflict_id = Some(conflict_id.clone());
                flagged.status = "conflicted".to_owned();
                flagged.updated_at = at.to_owned();
                let _ = self.append_item(file, &flagged);
                if let Ok(idx_path) = self.index_file(flagged.workspace_id.as_deref())
                    && let Ok(idx) = MemoryIndex::open(&idx_path)
                {
                    let _ = idx.remove(&flagged.id);
                }
            }
            item.conflict_id = Some(conflict_id);
            item.conflicts_with = Some(dec.conflict_ids);
            item.status = "conflicted".to_owned();
        }
    }

    pub fn get(&self, workspace_id: Option<&str>, id: &str) -> Option<MemoryItem> {
        self.list(&MemoryFilter {
            scope: None,
            workspace_id,
            kind: None,
            status: None,
        })
        .into_iter()
        .find(|item| item.id == id)
    }

    /// Write a curated memory item (`verified` or confirmed `inferred` user preference >= 3 episodes),
    /// annotating single-value `topic_key` conflicts across active items in the same scope.
    pub fn write_curated(
        &self,
        req: &WriteCuratedMemoryRequest<'_>,
    ) -> Result<MemoryItem, ProjectError> {
        if memory_secret_reason(req.text).is_some() {
            return Err(ProjectError::code("sensitive"));
        }
        let at = now_iso();
        let candidate = MemoryItem {
            id: format!("mem-{}", uuid::Uuid::new_v4()),
            scope: req.scope.to_owned(),
            kind: req.kind.to_owned(),
            text: req.text.to_owned(),
            trust: req.trust.to_owned(),
            source_refs: req.source_refs.clone(),
            pinned: req.pinned,
            status: "active".to_owned(),
            confirmed_count: req.confirmed_count.max(1),
            created_at: at.clone(),
            updated_at: at.clone(),
            last_used_at: None,
            workspace_id: req.workspace_id.map(str::to_owned),
            anchor_message_id: req.anchor_message_id.map(str::to_owned),
            forget_reason: None,
            expires_at: req.expires_at.map(str::to_owned),
            topic_key: req.topic_key.map(str::to_owned),
            topic_value: req.topic_value.map(str::to_owned),
            file_anchors: req.file_anchors.clone(),
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Map::new(),
        };
        let mut item =
            normalize_item(candidate).ok_or_else(|| ProjectError::code("INVALID_MEMORY"))?;
        let file = match item.scope.as_str() {
            "user" => self.user_file(),
            "project" => self.project_file(item.workspace_id.as_deref().unwrap_or(""))?,
            _ => return Err(ProjectError::code("INVALID_MEMORY")),
        };

        let existing = self.fold_file(&file);
        self.apply_conflict_decision(&file, &existing, &mut item, &at);

        self.append_item(&file, &item)?;
        if item.status == "active"
            && let Ok(idx_path) = self.index_file(item.workspace_id.as_deref())
            && let Ok(idx) = MemoryIndex::open(&idx_path)
        {
            let _ = idx.upsert(&item);
        }
        Ok(item)
    }

    /// Apply deterministic maintenance transition (`status` and/or `needs_reverify`) to an item.
    pub fn mark_maintained(
        &self,
        workspace_id: &str,
        id: &str,
        status: Option<&str>,
        needs_reverify: Option<bool>,
        maintenance_reason: &str,
    ) -> Result<MemoryItem, ProjectError> {
        let project_path = self.project_file(workspace_id)?;
        let user_path = self.user_file();
        let (file, mut current) = if let Some(item) = self
            .fold_file(&project_path)
            .into_iter()
            .find(|item| item.id == id)
        {
            (project_path, item)
        } else if let Some(item) = self
            .fold_file(&user_path)
            .into_iter()
            .find(|item| item.id == id)
        {
            (user_path, item)
        } else {
            return Err(ProjectError::code("NOT_FOUND"));
        };

        if let Some(st) = status {
            if !valid_status(st) {
                return Err(ProjectError::code("INVALID_MEMORY"));
            }
            current.status = st.to_owned();
        }
        if let Some(nr) = needs_reverify {
            current.needs_reverify = Some(nr);
        }
        let reason_trim = maintenance_reason.trim();
        if !reason_trim.is_empty() {
            current.maintenance_reason = Some(reason_trim.chars().take(REASON_MAX).collect());
        }
        current.updated_at = now_iso();
        self.append_item(&file, &current)?;
        if let Ok(idx_path) = self.index_file(Some(workspace_id))
            && let Ok(idx) = MemoryIndex::open(&idx_path)
        {
            if current.status == "active" && current.needs_reverify != Some(true) {
                let _ = idx.upsert(&current);
            } else {
                let _ = idx.remove(&current.id);
            }
        }
        Ok(current)
    }

    /// Tombstone an existing memory item by appending a `status = "forgotten"` record.
    pub fn forget(
        &self,
        scope: &str,
        workspace_id: Option<&str>,
        id: &str,
        reason: Option<&str>,
    ) -> Result<MemoryItem, ProjectError> {
        let file = match scope {
            "user" => self.user_file(),
            "project" => self.project_file(workspace_id.unwrap_or(""))?,
            _ => return Err(ProjectError::code("INVALID_SCOPE")),
        };
        let mut current = self
            .fold_file(&file)
            .into_iter()
            .find(|item| item.id == id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        current.status = "forgotten".to_owned();
        current.updated_at = now_iso();
        if let Some(r) = reason {
            let trimmed: String = r.trim().chars().take(REASON_MAX).collect();
            if !trimmed.is_empty() {
                current.forget_reason = Some(trimmed);
            }
        }
        self.append_item(&file, &current)?;
        if let Ok(idx_path) = self.index_file(workspace_id)
            && let Ok(idx) = MemoryIndex::open(&idx_path)
        {
            let _ = idx.remove(&current.id);
        }
        Ok(current)
    }

    pub fn list(&self, filter: &MemoryFilter<'_>) -> Vec<MemoryItem> {
        let mut items = Vec::new();
        let include_user = filter.scope.is_none() || filter.scope == Some("user");
        let include_project = filter.scope.is_none() || filter.scope == Some("project");
        if include_user {
            items.extend(self.fold_file(&self.user_file()));
        }
        if include_project {
            if let Some(ws) = filter.workspace_id {
                if let Ok(file) = self.project_file(ws) {
                    items.extend(self.fold_file(&file));
                }
            } else if let Ok(entries) = fs::read_dir(self.data_home.join("projects")) {
                for entry in entries.flatten() {
                    if let Some(ws) = entry.file_name().to_str()
                        && is_valid_workspace_id(ws)
                        && let Ok(file) = self.project_file(ws)
                    {
                        items.extend(self.fold_file(&file));
                    }
                }
            }
        }
        items
            .into_iter()
            .filter(|item| {
                filter.kind.is_none_or(|k| item.kind == k)
                    && filter.status.is_none_or(|s| item.status == s)
            })
            .collect()
    }

    /// Rebuild and query the disposable FTS5 trigram index for a workspace (+ user preferences).
    pub fn search(
        &self,
        workspace_id: Option<&str>,
        query: &str,
        limit: usize,
    ) -> Result<Vec<MemoryItem>, ProjectError> {
        let items = self.list(&MemoryFilter {
            scope: None,
            workspace_id,
            kind: None,
            status: Some("active"),
        });
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let effective: Vec<MemoryItem> = items
            .into_iter()
            .filter(|item| is_effective_memory(item, now_ms))
            .collect();
        let idx_path = self.index_file(workspace_id)?;
        let idx = MemoryIndex::open(&idx_path)?;
        idx.rebuild(&effective)?;
        let hits = idx.search(query, limit)?;
        let by_id: BTreeMap<String, MemoryItem> = effective
            .into_iter()
            .map(|item| (item.id.clone(), item))
            .collect();
        Ok(hits
            .into_iter()
            .filter_map(|hit| by_id.get(&hit.id).cloned())
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn memory_secret_rejection_fts_trigram_chinese_search_and_forget_work() {
        let dir = tempdir().unwrap();
        let store = MemoryStore::new(dir.path());

        // Secrets are strictly rejected without persisting.
        let err = store
            .write(&WriteMemoryRequest {
                scope: "project",
                workspace_id: Some("ws-1"),
                kind: "fact",
                text: "API token is sk-1234567890abcdefghijklmnop",
                trust: "stated",
                source_refs: vec!["msg-1".into()],
                pinned: false,
                anchor_message_id: Some("msg-1"),
                expires_at: None,
                topic_key: None,
                topic_value: None,
                file_anchors: None,
            })
            .unwrap_err();
        assert_eq!(err.code, "sensitive");

        let saved = store
            .write(&WriteMemoryRequest {
                scope: "project",
                workspace_id: Some("ws-1"),
                kind: "decision",
                text: "原生 CLI 全面使用 Rust 与 Ratatui 实现有界内存",
                trust: "verified",
                source_refs: vec!["ev-1".into()],
                pinned: true,
                anchor_message_id: Some("msg-2"),
                expires_at: None,
                topic_key: Some("cli.stack"),
                topic_value: Some("rust-ratatui"),
                file_anchors: None,
            })
            .unwrap();

        // Chinese substring search via SQLite FTS5 trigram AND <3 char LIKE fallback.
        let hits_cjk = store.search(Some("ws-1"), "有界内存", 10).unwrap();
        assert_eq!(hits_cjk.len(), 1);
        assert_eq!(hits_cjk[0].id, saved.id);

        let hits_short = store.search(Some("ws-1"), "原生", 10).unwrap();
        assert_eq!(hits_short.len(), 1);

        // Forget tombstones the item.
        store
            .forget("project", Some("ws-1"), &saved.id, Some("obsolete"))
            .unwrap();
        assert!(
            store
                .search(Some("ws-1"), "有界内存", 10)
                .unwrap()
                .is_empty()
        );
    }
}
