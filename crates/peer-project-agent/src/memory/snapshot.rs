//! Frozen memory snapshots captured when spawning delegated work sessions.
//!
//! Matches `packages/runtime-node/src/memory/memory-snapshot.mjs` (ADR 81).

use crate::{
    ProjectError, is_valid_workspace_id,
    memory::{MemoryFilter, MemoryItem, MemoryStore, is_effective_memory},
    now_iso, parse_iso_ms,
};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FrozenMemoryItem {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub trust: String,
    pub status: String,
    pub scope: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySnapshot {
    pub snapshot_id: String,
    pub item_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub items: Vec<FrozenMemoryItem>,
    pub created_at: String,
}

fn snapshots_file(data_home: &Path, workspace_id: &str) -> Result<PathBuf, ProjectError> {
    if !is_valid_workspace_id(workspace_id) {
        return Err(ProjectError::code("invalid_workspace"));
    }
    Ok(data_home
        .join("projects")
        .join(workspace_id)
        .join("memory")
        .join("snapshots.jsonl"))
}

fn freeze_item(item: &MemoryItem) -> FrozenMemoryItem {
    FrozenMemoryItem {
        id: item.id.clone(),
        kind: item.kind.clone(),
        text: item.text.clone(),
        trust: if item.trust == "verified" {
            "verified".to_owned()
        } else {
            "stated".to_owned()
        },
        status: if item.status == "forgotten" {
            "forgotten".to_owned()
        } else {
            "active".to_owned()
        },
        scope: if item.scope == "user" {
            "user".to_owned()
        } else {
            "project".to_owned()
        },
    }
}

pub fn create_snapshot(
    data_home: &Path,
    workspace_id: &str,
) -> Result<MemorySnapshot, ProjectError> {
    let file = snapshots_file(data_home, workspace_id)?;
    let store = MemoryStore::new(data_home);
    let at = now_iso();
    let now_ms = parse_iso_ms(&at).unwrap_or(0);
    let mut active: Vec<MemoryItem> = store
        .list(&MemoryFilter {
            scope: None,
            workspace_id: Some(workspace_id),
            kind: None,
            status: Some("active"),
        })
        .into_iter()
        .filter(|item| is_effective_memory(item, now_ms))
        .collect();
    active.sort_by(|a, b| a.id.cmp(&b.id));
    let snapshot = MemorySnapshot {
        snapshot_id: format!("snap-{}", uuid::Uuid::new_v4()),
        item_ids: active.iter().map(|i| i.id.clone()).collect(),
        items: active.iter().map(freeze_item).collect(),
        created_at: at,
    };
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir).map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    }
    let mut line = serde_json::to_string(&snapshot)
        .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
    line.push('\n');
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&file)
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    handle
        .write_all(line.as_bytes())
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    handle
        .sync_all()
        .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
    Ok(snapshot)
}

pub fn read_snapshots(data_home: &Path, workspace_id: &str) -> Vec<MemorySnapshot> {
    let Ok(file) = snapshots_file(data_home, workspace_id) else {
        return Vec::new();
    };
    let Ok(raw) = fs::read_to_string(file) else {
        return Vec::new();
    };
    raw.lines()
        .filter(|l| !l.trim().is_empty())
        .filter_map(|line| serde_json::from_str::<MemorySnapshot>(line).ok())
        .collect()
}
