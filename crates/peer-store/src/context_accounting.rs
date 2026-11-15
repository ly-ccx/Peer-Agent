//! Existing context sidecar/index sink. Billing is deliberately not a dependency.
use crate::{ConversationStore, HistorySnapshot, StoreError, durable_jsonl as log, files};
use serde_json::{Value, json};
const SAFE: f64 = 9_007_199_254_740_991.0;
const OWNED: &[&str] = &[
    "version",
    "conversationId",
    "contentRevision",
    "modelKey",
    "revision",
    "phase",
    "compactionEpoch",
    "contextWindow",
    "inputBudget",
    "compactionThresholdTokens",
    "authoritativeInputTokens",
    "percent",
    "pressureSource",
    "pendingUncountedChanges",
    "pendingContentChars",
    "countCapability",
    "counterStatus",
    "updatedAt",
    "lastObserved",
    "nextCounted",
    "lastOverflow",
    "verification",
    "usageBreakdown",
    "projectorVersion",
    "compactionBoundaryId",
];
fn integer(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= SAFE)
        .map(|n| n as u64)
}
fn text(v: &Value) -> Option<&str> {
    v.as_str()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty())
}
pub fn context_model_key(meta: &Value) -> String {
    let provider = text(&meta["modelProviderId"]).unwrap_or("unknown-provider");
    let (base, embedded) = provider
        .rsplit_once("::")
        .filter(|(base, _)| !base.is_empty())
        .unwrap_or((provider, ""));
    let model = text(&meta["model"]).unwrap_or(embedded);
    if model.is_empty() {
        base.into()
    } else {
        format!("{base}::{model}")
    }
}
fn valid(v: &Value, id: &str, model: &str) -> bool {
    if v["version"].as_f64() != Some(1.0)
        || v["conversationId"] != id
        || text(&v["modelKey"]) != Some(model)
        || integer(&v["contentRevision"]).is_none()
        || integer(&v["revision"]).is_none()
        || integer(&v["compactionEpoch"]).is_none()
        || integer(&v["pendingContentChars"]).is_none()
        || !v["pendingUncountedChanges"].is_boolean()
    {
        return false;
    }
    if !matches!(
        v["phase"].as_str(),
        Some(
            "request_preflight"
                | "stream_preview"
                | "tool_result"
                | "post_compaction"
                | "turn_complete"
                | "restored"
                | "model_changed"
        )
    ) || !matches!(v["counterStatus"].as_str(), Some("active" | "degraded"))
        || !matches!(
            v["pressureSource"].as_str(),
            Some(
                "provider_usage"
                    | "provider_count_api"
                    | "provider_tokenizer"
                    | "provider_error_evidence"
                    | "unknown"
            )
        )
    {
        return false;
    }
    for key in ["contextWindow", "inputBudget", "compactionThresholdTokens"] {
        if !v[key].is_null()
            && v[key]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n <= 0.0 || n > SAFE)
        {
            return false;
        }
    }
    for key in ["authoritativeInputTokens", "percent", "updatedAt"] {
        if !v[key].is_null()
            && v[key]
                .as_f64()
                .is_none_or(|n| !n.is_finite() || n < 0.0 || n > SAFE)
        {
            return false;
        }
    }
    matches!(
        v["countCapability"]["kind"].as_str(),
        Some("provider_count_api" | "observed_usage_only" | "unavailable")
    ) || v["countCapability"]["kind"] == "provider_tokenizer"
        && text(&v["countCapability"]["tokenizerVersion"]).is_some()
}
fn binding_matches(v: &Value, b: &Value) -> bool {
    if b["selectionVersion"] != 1
        && v.get("projectorVersion").is_none()
        && v.get("compactionBoundaryId").is_none()
    {
        return true;
    }
    v["projectorVersion"].as_f64() == Some(3.0)
        && v["compactionBoundaryId"] == b["compactionBoundaryId"]
        && (b["selectionVersion"] != 1
            || integer(&v["compactionEpoch"]) == integer(&b["compactionEpoch"]))
}
impl ConversationStore {
    pub fn bind_context_model(
        &self,
        id: &str,
        provider: &str,
        model: &str,
    ) -> Result<(), StoreError> {
        if !crate::valid_id(id, false) || provider.is_empty() || model.is_empty() {
            return Err(StoreError::ContextInvalid);
        }
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, None, None)?;
        let file = directory.join("index.jsonl");
        let mut rows = log::read(&file, None)?;
        let positions = rows
            .iter()
            .enumerate()
            .filter(|(_, r)| r["id"] == id)
            .map(|(i, _)| i)
            .collect::<Vec<_>>();
        if positions.len() != 1 {
            return Err(StoreError::ContextConflict);
        }
        let row = &mut rows[positions[0]];
        let expected = format!("{provider}::{model}");
        if context_model_key(row) == expected {
            return Ok(());
        }
        if text(&row["modelProviderId"]).is_some_and(|p| p != provider)
            || text(&row["model"]).is_some_and(|m| m != model)
        {
            return Err(StoreError::ContextConflict);
        }
        row["modelProviderId"] = json!(provider);
        row["model"] = json!(model);
        log::replace(&file, &log::encode(&rows)?, None)
    }
    pub fn read_context_snapshot(
        &self,
        history: &HistorySnapshot,
        model: &str,
    ) -> Result<Option<Value>, StoreError> {
        let id = &history.history.conversation_id;
        let meta = self
            .read_metadata(id)?
            .metadata
            .ok_or(StoreError::NotFound)?;
        if context_model_key(&meta) != model {
            return Ok(None);
        }
        let file = self
            .directory
            .join(".context-snapshots")
            .join(format!("{id}.json"));
        let raw = match files::read(&file, 65536)? {
            Some(bytes) => peer_protocol::decode_json_bounded(
                &bytes,
                peer_protocol::JsonLimits {
                    bytes: 65536,
                    nodes: 8192,
                    depth: 32,
                    string_bytes: 65536,
                },
            )
            .ok()
            .map(|v| v.value),
            None => meta.get("contextSnapshot").cloned(),
        };
        let Some(mut raw) = raw else { return Ok(None) };
        let legacy = text(&meta["modelProviderId"]).or_else(|| text(&meta["model"]));
        if legacy.is_some_and(|key| text(&raw["modelKey"]) == Some(key)) {
            raw["modelKey"] = json!(model);
        }
        let binding = peer_protocol::context_history_binding(&history.history.messages)
            .map_err(|_| StoreError::ContextInvalid)?;
        if !valid(&raw, id, model)
            || !binding_matches(&raw, &binding)
            || integer(&raw["contentRevision"]).is_none_or(|n| n > history.history.content_revision)
        {
            return Ok(None);
        }
        raw["projectorVersion"] = json!(3);
        raw["compactionBoundaryId"] = binding["compactionBoundaryId"].clone();
        Ok(Some(raw))
    }
    /// Writes return only after both sidecar and compatible index mirror are
    /// durable. A partial commit stays visible; no old file is erased on error.
    pub fn write_context_snapshot(
        &self,
        expected: &HistorySnapshot,
        snapshot: &Value,
    ) -> Result<HistorySnapshot, StoreError> {
        self.write_context_inner(expected, snapshot, || Ok(()))
    }
    #[cfg(feature = "test-fixtures")]
    pub fn write_context_snapshot_fixture(
        &self,
        expected: &HistorySnapshot,
        snapshot: &Value,
    ) -> Result<HistorySnapshot, StoreError> {
        self.write_context_inner(expected, snapshot, || {
            Err(StoreError::ContextCommitUncertain)
        })
    }
    fn write_context_inner(
        &self,
        expected: &HistorySnapshot,
        snapshot: &Value,
        before_index: impl FnOnce() -> Result<(), StoreError>,
    ) -> Result<HistorySnapshot, StoreError> {
        let id = &expected.history.conversation_id;
        let directory = self.write_directory()?;
        let _held = crate::conversation_write::locks(&directory, Some(id), None)?;
        let current = self.read_committed(id, None, 8 * 1024 * 1024)?;
        if current.source_revision != expected.source_revision
            || current.history.excluded_from_message_id.is_some()
        {
            return Err(StoreError::ContextConflict);
        }
        let index = directory.join("index.jsonl");
        let mut rows = log::read(&index, None)?;
        let position = rows
            .iter()
            .position(|r| r["id"] == *id)
            .ok_or(StoreError::NotFound)?;
        let model = context_model_key(&rows[position]);
        if !valid(snapshot, id, &model)
            || integer(&snapshot["contentRevision"]) != Some(current.history.content_revision)
        {
            return Err(StoreError::ContextInvalid);
        }
        let binding = peer_protocol::context_history_binding(&current.history.messages)
            .map_err(|_| StoreError::ContextInvalid)?;
        if binding["selectionVersion"] == 1
            && integer(&snapshot["compactionEpoch"]) != integer(&binding["compactionEpoch"])
        {
            return Err(StoreError::ContextConflict);
        }
        let folder = directory.join(".context-snapshots");
        if files::identity(&folder)?.is_none() {
            std::fs::create_dir(&folder).map_err(|_| StoreError::ReadFailed)?;
            std::fs::File::open(&directory)
                .and_then(|f| f.sync_all())
                .map_err(|_| StoreError::ReadFailed)?;
        }
        if !std::fs::symlink_metadata(&folder)
            .map_err(|_| StoreError::ReadFailed)?
            .is_dir()
        {
            return Err(StoreError::ContextInvalid);
        }
        let file = folder.join(format!("{id}.json"));
        let previous = files::read(&file, 65536)?
            .map(|bytes| {
                peer_protocol::decode_json_bounded(
                    &bytes,
                    peer_protocol::JsonLimits {
                        bytes: 65536,
                        nodes: 8192,
                        depth: 32,
                        string_bytes: 65536,
                    },
                )
                .map(|v| v.value)
                .map_err(|_| StoreError::ContextInvalid)
            })
            .transpose()?
            .or_else(|| {
                rows[position]
                    .get("contextSnapshot")
                    .filter(|v| !v.is_null())
                    .cloned()
            });
        if previous
            .as_ref()
            .is_some_and(|v| v["version"].as_f64() != Some(1.0))
        {
            return Err(StoreError::ContextInvalid);
        }
        let mut next = previous.unwrap_or(json!({}));
        let object = next.as_object_mut().ok_or(StoreError::ContextInvalid)?;
        for key in OWNED {
            object.shift_remove(*key);
        }
        object.extend(
            snapshot
                .as_object()
                .ok_or(StoreError::ContextInvalid)?
                .clone(),
        );
        next["projectorVersion"] = json!(3);
        next["compactionBoundaryId"] = binding["compactionBoundaryId"].clone();
        let bytes = peer_protocol::javascript_json_string(&next)
            .map_err(|_| StoreError::ContextInvalid)?
            .into_bytes();
        if bytes.len() > 65536 {
            return Err(StoreError::HistoryLimit);
        }
        log::replace(&file, &bytes, None)?;
        before_index()?;
        rows[position]["contextSnapshot"] = next;
        log::replace(&index, &log::encode(&rows)?, None)
            .map_err(|_| StoreError::ContextCommitUncertain)?;
        let after = self.read_committed(id, None, 8 * 1024 * 1024)?;
        if after.history.messages != current.history.messages
            || after.history.excluded_from_message_id.is_some()
        {
            return Err(StoreError::ContextConflict);
        }
        Ok(after)
    }
}
