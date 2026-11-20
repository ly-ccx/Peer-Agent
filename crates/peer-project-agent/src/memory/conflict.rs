//! Memory conflict detection & supersession policy (`packages/runtime-node/src/memory/conflict.mjs`).

use crate::{memory::MemoryItem, parse_iso_ms};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryConflictDecision {
    pub replace_ids: Vec<String>,
    pub conflict_ids: Vec<String>,
}

/// Compare a new `item` carrying `topicKey` + `topicValue` against `existing` memories within
/// the same scope (`user`, or `project` + matching `workspace_id`), returning sorted `replace_ids`
/// (newer authoritative `stated`/`verified` writes supersede prior conflicting items) and
/// `conflict_ids` (non-authoritative or older claims that stay flagged as conflicted).
pub fn memory_conflict_decision(
    item: &MemoryItem,
    existing: &[MemoryItem],
) -> MemoryConflictDecision {
    let mut replace_ids = Vec::new();
    let mut conflict_ids = Vec::new();

    let Some(topic_key) = item.topic_key.as_deref().filter(|s| !s.is_empty()) else {
        return MemoryConflictDecision::default();
    };
    let Some(topic_value) = item.topic_value.as_deref().filter(|s| !s.is_empty()) else {
        return MemoryConflictDecision::default();
    };

    let item_ms = parse_iso_ms(&item.created_at);
    let item_authoritative = matches!(item.trust.as_str(), "stated" | "verified");

    for other in existing {
        if other.id == item.id {
            continue;
        }
        if !matches!(other.status.as_str(), "active" | "conflicted") {
            continue;
        }
        if other.scope != item.scope {
            continue;
        }
        if item.scope != "user" && other.workspace_id != item.workspace_id {
            continue;
        }
        if other.topic_key.as_deref() != Some(topic_key) {
            continue;
        }
        let Some(other_val) = other.topic_value.as_deref().filter(|s| !s.is_empty()) else {
            continue;
        };
        if other_val == topic_value {
            continue;
        }

        let newer = match (item_ms, parse_iso_ms(&other.created_at)) {
            (Some(a), Some(b)) => a > b,
            _ => false,
        };
        if item_authoritative && newer {
            replace_ids.push(other.id.clone());
        } else {
            conflict_ids.push(other.id.clone());
        }
    }

    replace_ids.sort();
    conflict_ids.sort();
    MemoryConflictDecision {
        replace_ids,
        conflict_ids,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Map;

    fn sample(id: &str, trust: &str, created_at: &str, val: &str) -> MemoryItem {
        MemoryItem {
            id: id.into(),
            scope: "project".into(),
            kind: "decision".into(),
            text: format!("Use {val}"),
            trust: trust.into(),
            source_refs: vec!["ev-1".into()],
            pinned: false,
            status: "active".into(),
            confirmed_count: 1,
            created_at: created_at.into(),
            updated_at: created_at.into(),
            last_used_at: None,
            workspace_id: Some("ws-1".into()),
            anchor_message_id: None,
            forget_reason: None,
            expires_at: None,
            topic_key: Some("pkg_mgr".into()),
            topic_value: Some(val.into()),
            file_anchors: None,
            needs_reverify: None,
            conflict_id: None,
            superseded_by: None,
            maintenance_reason: None,
            conflicts_with: None,
            extra: Map::new(),
        }
    }

    #[test]
    fn newer_authoritative_replaces_while_inferred_marks_conflict() {
        let old = sample("m1", "verified", "2026-11-20T09:00:00.000Z", "npm");
        let newer_stated = sample("m2", "stated", "2026-11-20T10:00:00.000Z", "pnpm");
        let dec = memory_conflict_decision(&newer_stated, std::slice::from_ref(&old));
        assert_eq!(dec.replace_ids, vec!["m1"]);
        assert!(dec.conflict_ids.is_empty());

        let newer_inferred = sample("m3", "inferred", "2026-11-20T11:00:00.000Z", "yarn");
        let dec2 = memory_conflict_decision(&newer_inferred, &[old]);
        assert!(dec2.replace_ids.is_empty());
        assert_eq!(dec2.conflict_ids, vec!["m1"]);
    }
}
