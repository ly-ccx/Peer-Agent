//! Deterministic memory maintenance (`packages/runtime-node/src/memory/maintenance.mjs`).

use crate::{
    ProjectError, atomic_write, is_valid_workspace_id,
    memory::{MemoryFilter, MemoryStore, file_anchors::read_file_anchor},
    parse_iso_ms,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
};

pub const NINETY_DAYS_MS: i64 = 90 * 24 * 60 * 60 * 1000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceOutcome {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub skipped: Option<&'static str>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub date: Option<String>,
    #[serde(default)]
    pub changed_ids: Vec<String>,
}

pub struct MemoryMaintenance {
    data_home: PathBuf,
    store: MemoryStore,
}

fn parse_digest_hm(clock: &str) -> Option<(u32, u32)> {
    let (h, m) = clock.trim().split_once(':')?;
    if h.len() != 2 || m.len() != 2 {
        return None;
    }
    let hh = h.parse::<u32>().ok()?;
    let mm = m.parse::<u32>().ok()?;
    (hh <= 23 && mm <= 59).then_some((hh, mm))
}

impl MemoryMaintenance {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            store: MemoryStore::new(&home),
            data_home: home,
        }
    }

    fn state_file(&self, workspace_id: &str) -> Result<PathBuf, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Err(ProjectError::code("INVALID_WORKSPACE"));
        }
        Ok(self
            .data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("memory-maintenance.json"))
    }

    /// Run once-daily deterministic memory expiry & verified file-anchor staleness check.
    pub fn run_due(
        &self,
        workspace_id: &str,
        workspace_path: &Path,
        at_iso: &str,
        digest_time: &str,
    ) -> Result<MaintenanceOutcome, ProjectError> {
        if !is_valid_workspace_id(workspace_id) {
            return Ok(MaintenanceOutcome {
                ok: false,
                skipped: Some("invalid_workspace"),
                date: None,
                changed_ids: Vec::new(),
            });
        }
        let Some(now_ms) = parse_iso_ms(at_iso) else {
            return Ok(MaintenanceOutcome {
                ok: false,
                skipped: Some("invalid_time"),
                date: None,
                changed_ids: Vec::new(),
            });
        };
        let Some((target_h, target_m)) = parse_digest_hm(digest_time) else {
            return Ok(MaintenanceOutcome {
                ok: false,
                skipped: Some("invalid_time"),
                date: None,
                changed_ids: Vec::new(),
            });
        };
        let dt = time::OffsetDateTime::from_unix_timestamp_nanos(i128::from(now_ms) * 1_000_000)
            .map_err(|_| ProjectError::code("INVALID_TIME"))?;
        let now_mins = u32::from(dt.hour()) * 60 + u32::from(dt.minute());
        if now_mins < target_h * 60 + target_m {
            return Ok(MaintenanceOutcome {
                ok: true,
                skipped: Some("not_due"),
                date: None,
                changed_ids: Vec::new(),
            });
        }
        let date = format!(
            "{:04}-{:02}-{:02}",
            dt.year(),
            u8::from(dt.month()),
            dt.day()
        );
        let state_file = self.state_file(workspace_id)?;
        if let Ok(raw) = fs::read_to_string(&state_file)
            && let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&raw)
            && parsed["date"].as_str() == Some(date.as_str())
        {
            return Ok(MaintenanceOutcome {
                ok: true,
                skipped: Some("already_ran"),
                date: Some(date),
                changed_ids: Vec::new(),
            });
        }

        let items = self.store.list(&MemoryFilter {
            scope: None,
            workspace_id: Some(workspace_id),
            kind: None,
            status: None,
        });
        let mut changed_ids = Vec::new();
        for item in items {
            if !matches!(item.status.as_str(), "active" | "conflicted") {
                continue;
            }
            let protected = item.pinned || item.kind == "responsibility";
            let expired = item
                .expires_at
                .as_deref()
                .and_then(parse_iso_ms)
                .is_some_and(|exp| exp <= now_ms);
            let unused = item.kind == "preference"
                && item.trust == "inferred"
                && parse_iso_ms(item.last_used_at.as_deref().unwrap_or(&item.created_at))
                    .is_some_and(|last| now_ms.saturating_sub(last) >= NINETY_DAYS_MS);

            if !protected && (expired || unused) {
                let reason = if expired { "expired" } else { "unused_90_days" };
                self.store.mark_maintained(
                    workspace_id,
                    &item.id,
                    Some("expired"),
                    None,
                    reason,
                )?;
                changed_ids.push(item.id);
                continue;
            }

            if item.trust == "verified"
                && item.needs_reverify != Some(true)
                && let Some(ref anchors) = item.file_anchors
                && anchors.iter().any(|anchor| {
                    read_file_anchor(workspace_path, &anchor.path)
                        .is_none_or(|obs| obs.content_hash != anchor.content_hash)
                })
            {
                self.store.mark_maintained(
                    workspace_id,
                    &item.id,
                    None,
                    Some(true),
                    "file_changed",
                )?;
                changed_ids.push(item.id);
            }
        }

        let mut body = serde_json::to_string(&json!({
            "date": date,
            "completedAt": at_iso,
        }))
        .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&state_file, body.as_bytes())?;

        Ok(MaintenanceOutcome {
            ok: true,
            skipped: None,
            date: Some(date),
            changed_ids,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::memory::{WriteCuratedMemoryRequest, file_anchors::capture_file_anchors};
    use tempfile::tempdir;

    #[test]
    fn maintenance_expires_old_entries_and_flags_modified_file_anchors() {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        fs::create_dir_all(ws.path().join("src")).unwrap();
        fs::write(ws.path().join("src/app.rs"), b"const V: u8 = 1;\n").unwrap();

        let store = MemoryStore::new(home.path());
        let anchors = capture_file_anchors(ws.path(), &["src/app.rs".into()]);
        let verified = store
            .write_curated(&WriteCuratedMemoryRequest {
                scope: "project",
                workspace_id: Some("ws-m"),
                kind: "fact",
                text: "app version is 1",
                trust: "verified",
                source_refs: vec!["ev-1".into()],
                confirmed_count: 1,
                pinned: false,
                anchor_message_id: None,
                expires_at: None,
                topic_key: None,
                topic_value: None,
                file_anchors: Some(anchors),
            })
            .unwrap();

        // Mutate file on disk
        fs::write(ws.path().join("src/app.rs"), b"const V: u8 = 2;\n").unwrap();
        let maint = MemoryMaintenance::new(home.path());
        let not_due = maint
            .run_due("ws-m", ws.path(), "2026-11-20T08:30:00.000Z", "09:00")
            .unwrap();
        assert_eq!(not_due.skipped, Some("not_due"));

        let ran = maint
            .run_due("ws-m", ws.path(), "2026-11-20T09:05:00.000Z", "09:00")
            .unwrap();
        assert!(ran.skipped.is_none());
        assert!(ran.changed_ids.contains(&verified.id));

        let updated = store.get(Some("ws-m"), &verified.id).unwrap();
        assert_eq!(updated.needs_reverify, Some(true));
        assert_eq!(updated.maintenance_reason.as_deref(), Some("file_changed"));

        let replay = maint
            .run_due("ws-m", ws.path(), "2026-11-20T10:00:00.000Z", "09:00")
            .unwrap();
        assert_eq!(replay.skipped, Some("already_ran"));
    }
}
