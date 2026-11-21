//! Immutable inherited-background snapshots for `continue-history` and delegation
//! (`packages/conversation-store/src/inherited-background.mjs` + `background-snapshot-store.mjs`).
//!
//! Uses typed structs preserving exact JS insertion key order so compact JSON
//! SHA-256 `contentHash` digests match `selectionTextHash(JSON.stringify(data))` bit-for-bit.

use crate::{ProjectError, sha256_hex};
use peer_protocol::javascript_trim;
use peer_store::{ConversationStore, StoreError};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs::{self, OpenOptions},
    io::{ErrorKind, Write},
    path::{Path, PathBuf},
};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

const MAX_BACKGROUND_CHARS: usize = 64_000;
const MAX_READ_BUDGET_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InheritedBackgroundEntry {
    source_message_id: String,
    source_role: String,
    kind: String,
    text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InheritedBackgroundMissingItem {
    source_message_id: String,
    reason: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InheritedBackgroundData {
    schema_version: u32,
    source_conversation_id: String,
    source_revision: u64,
    captured_at: String,
    excluded_from_message_id: Option<String>,
    covered_message_ids: Vec<String>,
    entries: Vec<InheritedBackgroundEntry>,
    missing_items: Vec<InheritedBackgroundMissingItem>,
    character_count: usize,
    status: String,
    requires_missing_confirmation: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    scope: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredInheritedBackground {
    #[serde(flatten)]
    data: InheritedBackgroundData,
    content_hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CapturedBackground {
    pub snapshot_id: String,
    pub requires_missing_confirmation: bool,
    pub status: String,
    pub character_count: usize,
}

fn js_truthy(val: Option<&Value>) -> bool {
    match val {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn is_valid_iso_timestamp(value: &str) -> bool {
    let trimmed = value.trim();
    !trimmed.is_empty() && OffsetDateTime::parse(trimmed, &Rfc3339).is_ok()
}

fn build_data(
    conversation_id: &str,
    content_revision: u64,
    excluded_from_message_id: Option<String>,
    rows: &[Value],
    captured_at: &str,
) -> Result<InheritedBackgroundData, ProjectError> {
    if !is_valid_iso_timestamp(captured_at) {
        return Err(ProjectError::code("BACKGROUND_INVALID_TIME"));
    }

    let summary_index = rows
        .iter()
        .rposition(|row| js_truthy(row.get("_compaction")));
    if let Some(idx) = summary_index {
        let summary_row = &rows[idx];
        let is_user = summary_row.get("role").and_then(Value::as_str) == Some("user");
        let valid_text = summary_row
            .get("content")
            .and_then(Value::as_str)
            .is_some_and(|s| !javascript_trim(s).is_empty());
        if !is_user || !valid_text {
            return Err(ProjectError::code("BACKGROUND_SUMMARY_INVALID"));
        }
    }

    let mut covered_message_ids = Vec::new();
    let effective_rows = if let Some(idx) = summary_index {
        for row in &rows[..idx] {
            let id = row.get("id").and_then(Value::as_str).unwrap_or("");
            covered_message_ids.push(id.to_owned());
        }
        &rows[idx..]
    } else {
        rows
    };

    let mut missing_items = Vec::new();
    let mut entries = Vec::new();

    for row in effective_rows {
        let Some(id) = row
            .get("id")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            return Err(ProjectError::code("BACKGROUND_MESSAGE_ID_MISSING"));
        };
        let Some(role) = row.get("role").and_then(Value::as_str) else {
            return Err(ProjectError::code("BACKGROUND_MESSAGE_INVALID"));
        };
        if !matches!(role, "user" | "assistant" | "tool" | "system" | "developer") {
            return Err(ProjectError::code("BACKGROUND_MESSAGE_INVALID"));
        }
        if role == "system" || role == "developer" {
            continue;
        }
        if role == "tool" {
            missing_items.push(InheritedBackgroundMissingItem {
                source_message_id: id.to_owned(),
                reason: "tool_result_requires_evidence_resolver".to_owned(),
            });
            continue;
        }
        let has_tool_calls = row
            .get("tool_calls")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        let has_non_text_segments =
            row.get("segments")
                .and_then(Value::as_array)
                .is_some_and(|segs| {
                    segs.iter().any(|seg| {
                        let t = seg.get("type").and_then(Value::as_str);
                        t != Some("text") && t != Some("thinking")
                    })
                });
        if has_tool_calls || has_non_text_segments {
            missing_items.push(InheritedBackgroundMissingItem {
                source_message_id: id.to_owned(),
                reason: "tool_material_requires_evidence_resolver".to_owned(),
            });
        }

        let has_attachments = row
            .get("attachments")
            .and_then(Value::as_array)
            .is_some_and(|a| !a.is_empty());
        let non_string_content = matches!(
            row.get("content"),
            Some(v) if !v.is_null() && !v.is_string()
        );
        if has_attachments || non_string_content {
            missing_items.push(InheritedBackgroundMissingItem {
                source_message_id: id.to_owned(),
                reason: "attachment_material_requires_evidence_resolver".to_owned(),
            });
        }

        if let Some(content) = row.get("content").and_then(Value::as_str)
            && !javascript_trim(content).is_empty()
        {
            let kind = if js_truthy(row.get("_compaction")) {
                "summary"
            } else {
                "text"
            };
            entries.push(InheritedBackgroundEntry {
                source_message_id: id.to_owned(),
                source_role: role.to_owned(),
                kind: kind.to_owned(),
                text: content.to_owned(),
            });
        }
    }

    let character_count: usize = entries.iter().map(|e| e.text.chars().count()).sum();
    if character_count > MAX_BACKGROUND_CHARS {
        return Err(ProjectError::code("BACKGROUND_BUDGET_EXCEEDED"));
    }

    let status = if !missing_items.is_empty() {
        "partial"
    } else if summary_index.is_some() {
        "compacted"
    } else {
        "full"
    }
    .to_owned();
    let requires_missing_confirmation = !missing_items.is_empty();

    Ok(InheritedBackgroundData {
        schema_version: 1,
        source_conversation_id: conversation_id.to_owned(),
        source_revision: content_revision,
        captured_at: captured_at.to_owned(),
        excluded_from_message_id,
        covered_message_ids,
        entries,
        missing_items,
        character_count,
        status,
        requires_missing_confirmation,
        scope: None,
    })
}

fn is_valid_snapshot_id(id: &str) -> bool {
    id.len() == 64 && id.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn verify_existing_snapshot(path: &Path, expected_id: &str) -> Result<(), ProjectError> {
    let text = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::NotFound => {
            return Err(ProjectError::code("BACKGROUND_SNAPSHOT_MISSING"));
        }
        Err(_) => return Err(ProjectError::code("BACKGROUND_SNAPSHOT_READ_FAILED")),
    };
    let val: Value = serde_json::from_str(&text)
        .map_err(|_| ProjectError::code("BACKGROUND_SNAPSHOT_CORRUPT"))?;
    if val.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err(ProjectError::code("BACKGROUND_SNAPSHOT_INVALID"));
    }
    if val.get("contentHash").and_then(Value::as_str) != Some(expected_id) {
        return Err(ProjectError::code("BACKGROUND_SNAPSHOT_CORRUPT"));
    }
    let parsed_data: InheritedBackgroundData = serde_json::from_value(val)
        .map_err(|_| ProjectError::code("BACKGROUND_SNAPSHOT_CORRUPT"))?;
    let recomputed_json = serde_json::to_string(&parsed_data)
        .map_err(|_| ProjectError::code("BACKGROUND_SNAPSHOT_CORRUPT"))?;
    if sha256_hex(recomputed_json.as_bytes()) != expected_id {
        return Err(ProjectError::code("BACKGROUND_SNAPSHOT_CORRUPT"));
    }
    Ok(())
}

fn ensure_dir_private(dir: &Path) -> Result<(), ProjectError> {
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder
        .create(dir)
        .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))
}

fn open_exclusive_private(path: &Path) -> Result<fs::File, ProjectError> {
    let mut opts = OpenOptions::new();
    opts.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    opts.open(path)
        .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))
}

fn put_snapshot_immutable(
    dir: &Path,
    stored: &StoredInheritedBackground,
) -> Result<(), ProjectError> {
    let content_hash = &stored.content_hash;
    if !is_valid_snapshot_id(content_hash) {
        return Err(ProjectError::code("BACKGROUND_SNAPSHOT_ID_INVALID"));
    }
    let serialized = serde_json::to_string(stored)
        .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))?;
    ensure_dir_private(dir)?;
    let target: PathBuf = dir.join(format!("{content_hash}.json"));
    let temporary = dir.join(format!(".pending-{}", uuid::Uuid::new_v4()));

    let result = (|| -> Result<(), ProjectError> {
        {
            let mut file = open_exclusive_private(&temporary)?;
            file.write_all(serialized.as_bytes())
                .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))?;
            file.sync_all()
                .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))?;
        }
        match fs::hard_link(&temporary, &target) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == ErrorKind::AlreadyExists => {
                // Never silently overwrite an existing snapshot if it was corrupted.
                verify_existing_snapshot(&target, content_hash)
            }
            Err(e) => Err(ProjectError::new("SNAPSHOT_FAILED", e.to_string())),
        }
    })();

    let _ = fs::remove_file(&temporary);
    result
}

/// Captures an immutable inherited-background snapshot for `conversation_id` at `captured_at`
/// matching `packages/conversation-store/src/index.mjs#captureInheritedBackground` for an idle
/// history conversation.
pub fn capture_inherited_background(
    data_home: &Path,
    conversation_id: &str,
    captured_at: &str,
) -> Result<CapturedBackground, ProjectError> {
    let store = ConversationStore::new(data_home);
    let snap1 = store
        .read_committed(conversation_id, None, MAX_READ_BUDGET_BYTES)
        .map_err(|e| match e {
            StoreError::NotFound => ProjectError::code("NOT_FOUND"),
            _ => ProjectError::new("SNAPSHOT_FAILED", e.code()),
        })?;
    let data = build_data(
        &snap1.history.conversation_id,
        snap1.history.content_revision,
        snap1.history.excluded_from_message_id.clone(),
        &snap1.history.messages,
        captured_at,
    )?;
    let data_json = serde_json::to_string(&data)
        .map_err(|e| ProjectError::new("SNAPSHOT_FAILED", e.to_string()))?;
    let content_hash = sha256_hex(data_json.as_bytes());

    let snap2 = store
        .read_committed(conversation_id, None, MAX_READ_BUDGET_BYTES)
        .map_err(|e| match e {
            StoreError::NotFound => ProjectError::code("BACKGROUND_VERSION_CHANGED"),
            _ => ProjectError::new("SNAPSHOT_FAILED", e.code()),
        })?;
    if snap2.source_revision != snap1.source_revision
        || snap2.history.content_revision != snap1.history.content_revision
    {
        return Err(ProjectError::code("BACKGROUND_VERSION_CHANGED"));
    }

    let status = data.status.clone();
    let requires_missing_confirmation = data.requires_missing_confirmation;
    let character_count = data.character_count;
    let stored = StoredInheritedBackground {
        data,
        content_hash: content_hash.clone(),
    };
    let dir = data_home
        .join("conversations")
        .join("inherited-backgrounds");
    put_snapshot_immutable(&dir, &stored)?;

    Ok(CapturedBackground {
        snapshot_id: content_hash,
        requires_missing_confirmation,
        status,
        character_count,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tempfile::tempdir;

    #[test]
    fn captures_full_compacted_and_partial_snapshots_idempotently() {
        let dir = tempdir().unwrap();
        let store = ConversationStore::new(dir.path());
        let created_at = "2026-11-21T00:00:00.000Z";

        // Full conversation
        let conv = store
            .create_classic_conversation(&json!({
                "title": "History Thread",
                "workspacePath": "/tmp/repo",
                "mode": "chat",
            }))
            .unwrap();
        let cid = conv["id"].as_str().unwrap();
        store
            .append_classic_message(
                cid,
                &json!({ "id": "m-1", "role": "user", "content": "Check auth" }),
            )
            .unwrap();
        store
            .append_classic_message(
                cid,
                &json!({ "id": "m-2", "role": "assistant", "content": "Checked auth." }),
            )
            .unwrap();

        let cap1 = capture_inherited_background(dir.path(), cid, created_at).unwrap();
        assert_eq!(cap1.status, "full");
        assert!(!cap1.requires_missing_confirmation);
        assert_eq!(
            cap1.character_count,
            "Check auth".len() + "Checked auth.".len()
        );

        // Idempotent second capture hits existing snapshot and verifies hash.
        let cap2 = capture_inherited_background(dir.path(), cid, created_at).unwrap();
        assert_eq!(cap1.snapshot_id, cap2.snapshot_id);

        // Corrupt existing file prevents silent overwrite.
        let snap_path = dir
            .path()
            .join("conversations/inherited-backgrounds")
            .join(format!("{}.json", cap1.snapshot_id));
        fs::write(&snap_path, "{\"schemaVersion\":1,\"contentHash\":\"bad\"}").unwrap();
        assert_eq!(
            capture_inherited_background(dir.path(), cid, created_at)
                .unwrap_err()
                .code,
            "BACKGROUND_SNAPSHOT_CORRUPT"
        );
        fs::remove_file(&snap_path).unwrap();

        // Compacted + partial conversation
        store
            .append_classic_message(
                cid,
                &json!({ "id": "m-sum", "role": "user", "_compaction": true, "content": "Prior summary" }),
            )
            .unwrap();
        store
            .append_classic_message(
                cid,
                &json!({
                    "id": "m-tool",
                    "role": "assistant",
                    "content": "Ran tool",
                    "tool_calls": [{ "id": "tc-1" }]
                }),
            )
            .unwrap();
        let partial = capture_inherited_background(dir.path(), cid, created_at).unwrap();
        assert_eq!(partial.status, "partial");
        assert!(partial.requires_missing_confirmation);
        let written: Value = serde_json::from_str(
            &fs::read_to_string(
                dir.path()
                    .join("conversations/inherited-backgrounds")
                    .join(format!("{}.json", partial.snapshot_id)),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(written["coveredMessageIds"], json!(["m-1", "m-2"]));
        assert_eq!(written["entries"][0]["kind"], "summary");
        assert_eq!(
            written["missingItems"][0]["reason"],
            "tool_material_requires_evidence_resolver"
        );
    }
}
