//! Device-local recoverable input drafts (`project-runtime/<workspaceId>/input-drafts/<surface>.json`
//! and content-addressed `input-draft-blobs/<sha256>.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/input-draft-store.mjs` (ADR 115).
//! Never submits to the input queue or wakes any runner.

use crate::{
    INPUT_ATTACHMENT_LIMIT, ProjectError, atomic_write, attachments::normalize_user_upload,
    is_valid_input_id, is_valid_workspace_id, parse_iso_ms,
};
use peer_store::DirectoryLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_DRAFT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TOTAL_BLOB_BYTES: u64 = 96 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_QUOTE_MSG_ID_CHARS: usize = 512;
const MAX_PENDING: usize = 32;
const MAX_ATTACHMENTS: usize = 16;
const MAX_QUOTE_REFS: usize = 64;
const MAX_TASK_REFS: usize = 5;
const MAX_TASK_REF_TITLE_CHARS: usize = 200;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftTaskRef {
    pub session_id: String,
    pub title: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_message_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftQuote {
    pub message_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftAttachment {
    pub id: String,
    #[serde(flatten)]
    pub payload: serde_json::Map<String, Value>,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftBody {
    pub text: String,
    #[serde(default)]
    pub quote: Option<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_feedback: Option<Vec<Value>>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_refs: Vec<DraftTaskRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DraftEnvelope {
    pub input_id: String,
    pub text: String,
    pub created_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource_feedback: Option<Vec<Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub quote_refs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_to: Option<String>,
    #[serde(default)]
    pub attachment_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_refs: Vec<DraftTaskRef>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredDraftFile {
    schema_version: u32,
    revision: u64,
    draft: DraftBody,
    pending: Vec<DraftEnvelope>,
    uploads: BTreeMap<String, String>,
}

impl StoredDraftFile {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            draft: DraftBody::default(),
            pending: Vec::new(),
            uploads: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct DraftSnapshot {
    pub revision: u64,
    pub draft: DraftBody,
    pub pending: Vec<DraftEnvelope>,
    pub uploads: Vec<DraftAttachment>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedDraftBody {
    pub text: String,
    pub quote: Option<DraftQuote>,
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_refs: Vec<DraftTaskRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedDraftEnvelope {
    pub input_id: String,
    pub text: String,
    pub created_at: String,
    pub quote_refs: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub answer_to: Option<String>,
    pub attachments: Vec<Value>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub task_refs: Vec<DraftTaskRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HydratedDraftSnapshot {
    pub revision: u64,
    pub draft: HydratedDraftBody,
    pub pending: Vec<HydratedDraftEnvelope>,
}

/// Serializes normalized user uploads in the exact JS `normalizeUserUpload` key order
/// (`id, name, mimeType, size, sourceKind, kind, [dataUrl | text]`) so compact JSON
/// SHA-256 blob digests are identical between JS and Rust.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CanonicalUploadBlob<'a> {
    id: &'a str,
    name: &'a str,
    mime_type: &'a str,
    size: u64,
    source_kind: &'a str,
    kind: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    data_url: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<&'a str>,
}

pub struct DraftWriteRequest<'a> {
    pub workspace_id: &'a str,
    pub surface: &'a str,
    pub revision: u64,
    pub draft: DraftBody,
    pub pending: Vec<DraftEnvelope>,
    pub uploads: Vec<DraftAttachment>,
}

pub struct InputDraftStore {
    runtime_root: PathBuf,
}

fn normalize_task_refs_strict(value: Option<&Value>) -> Result<Vec<DraftTaskRef>, ProjectError> {
    let Some(val) = value else {
        return Ok(Vec::new());
    };
    if val.is_null() {
        return Ok(Vec::new());
    }
    let Some(arr) = val.as_array() else {
        return Err(ProjectError::code("INVALID_DRAFT"));
    };
    if arr.len() > MAX_TASK_REFS {
        return Err(ProjectError::code("INVALID_DRAFT"));
    }
    let mut out = Vec::with_capacity(arr.len());
    let mut seen = HashSet::new();
    for item in arr {
        let Some(obj) = item.as_object() else {
            return Err(ProjectError::code("INVALID_DRAFT"));
        };
        let Some(session_id) = obj
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= 200)
        else {
            return Err(ProjectError::code("INVALID_DRAFT"));
        };
        if !seen.insert(session_id.to_owned()) {
            continue;
        }
        let title = obj
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or("")
            .chars()
            .take(MAX_TASK_REF_TITLE_CHARS)
            .collect::<String>();
        let status = obj
            .get("status")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| s.encode_utf16().count() <= 64)
            .unwrap_or("accepted")
            .to_owned();
        let anchor_message_id = obj
            .get("anchorMessageId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.encode_utf16().count() <= MAX_QUOTE_MSG_ID_CHARS)
            .map(str::to_owned);
        out.push(DraftTaskRef {
            session_id: session_id.to_owned(),
            title,
            status,
            anchor_message_id,
        });
    }
    Ok(out)
}

fn valid_surface(surface: &str) -> bool {
    matches!(surface, "desktop" | "quick_chat" | "tui")
}

fn valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn validate_text_limit(value: Option<&Value>, limit: usize) -> Result<String, ProjectError> {
    let Some(s) = value.and_then(Value::as_str) else {
        return Err(ProjectError::code("INVALID_DRAFT"));
    };
    if s.encode_utf16().count() > limit {
        return Err(ProjectError::code("INVALID_DRAFT"));
    }
    Ok(s.to_owned())
}

fn normalize_quote_strict(value: Option<&Value>) -> Result<Option<DraftQuote>, ProjectError> {
    match value {
        None | Some(Value::Null) => Ok(None),
        Some(v) => {
            let Some(obj) = v.as_object() else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            let message_id = validate_text_limit(obj.get("messageId"), MAX_QUOTE_MSG_ID_CHARS)?;
            let text = validate_text_limit(obj.get("text"), MAX_TEXT_CHARS)?;
            Ok(Some(DraftQuote {
                message_id,
                text: Some(text),
            }))
        }
    }
}

fn has_nonempty_resource_feedback(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Array(arr)) => !arr.is_empty(),
        Some(_) => true,
    }
}

fn stored_has_resource_feedback(saved: &StoredDraftFile) -> bool {
    saved
        .draft
        .resource_feedback
        .as_ref()
        .is_some_and(|v| !v.is_empty())
        || saved.pending.iter().any(|item| {
            item.resource_feedback
                .as_ref()
                .is_some_and(|v| !v.is_empty())
        })
}

fn canonical_upload_json(raw: &Value) -> Result<(String, Value, String), ProjectError> {
    let norm = normalize_user_upload(raw).map_err(|_| ProjectError::code("INVALID_DRAFT"))?;
    let id = norm["id"]
        .as_str()
        .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?
        .to_owned();
    let blob = CanonicalUploadBlob {
        id: &id,
        name: norm["name"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?,
        mime_type: norm["mimeType"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?,
        size: norm["size"]
            .as_u64()
            .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?,
        source_kind: norm["sourceKind"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?,
        kind: norm["kind"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_DRAFT"))?,
        data_url: norm.get("dataUrl").and_then(Value::as_str),
        text: norm.get("text").and_then(Value::as_str),
    };
    let serialized =
        serde_json::to_string(&blob).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
    Ok((id, norm, serialized))
}

impl InputDraftStore {
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            runtime_root: data_home.as_ref().join("project-runtime"),
        }
    }

    fn location(
        &self,
        workspace_id: &str,
        surface: &str,
    ) -> Result<(PathBuf, PathBuf), ProjectError> {
        if !is_valid_workspace_id(workspace_id) || !valid_surface(surface) {
            return Err(ProjectError::code("INVALID_DRAFT"));
        }
        let root = self.runtime_root.join(workspace_id);
        let file = root.join("input-drafts").join(format!("{surface}.json"));
        Ok((root, file))
    }

    fn load(&self, file: &Path) -> Result<StoredDraftFile, ProjectError> {
        let meta = match fs::metadata(file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredDraftFile::empty());
            }
            Err(_) => return Err(ProjectError::code("DRAFT_UNAVAILABLE")),
        };
        if !meta.is_file() || meta.len() > MAX_DRAFT_BYTES {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        let raw = fs::read_to_string(file).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
        let saved: StoredDraftFile =
            serde_json::from_str(&raw).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
        if !matches!(saved.schema_version, 1..=3)
            || saved.pending.len() > MAX_PENDING
            || saved.uploads.values().any(|d| !valid_sha256_hex(d))
        {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        Ok(saved)
    }

    pub fn read(
        &self,
        workspace_id: &str,
        surface: &str,
        verify_blobs: bool,
    ) -> Result<DraftSnapshot, ProjectError> {
        let (root, file) = self.location(workspace_id, surface)?;
        let saved = self.load(&file)?;
        if saved.draft.text.chars().count() > MAX_TEXT_CHARS
            || saved.draft.attachment_ids.len() > MAX_ATTACHMENTS
        {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        let mut uploads = Vec::new();
        for (id, digest) in &saved.uploads {
            let blob_path = root
                .join("input-draft-blobs")
                .join(format!("{digest}.json"));
            let meta =
                fs::metadata(&blob_path).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
            if verify_blobs && meta.len() > MAX_DRAFT_BYTES {
                return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
            }
            let body = fs::read_to_string(&blob_path)
                .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
            if verify_blobs {
                let actual = format!("{:x}", Sha256::digest(body.as_bytes()));
                if actual != *digest {
                    return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
                }
            }
            let att: DraftAttachment =
                serde_json::from_str(&body).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
            if att.id != *id {
                return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
            }
            uploads.push(att);
        }
        Ok(DraftSnapshot {
            revision: saved.revision,
            draft: saved.draft,
            pending: saved.pending,
            uploads,
        })
    }

    /// CAS write by `request.revision`. Returns new revision on success.
    pub fn write(&self, request: DraftWriteRequest<'_>) -> Result<u64, ProjectError> {
        let (root, file) = self.location(request.workspace_id, request.surface)?;
        if request.draft.text.chars().count() > MAX_TEXT_CHARS {
            return Err(ProjectError::code("INVALID_DRAFT"));
        }
        if request.pending.len() > MAX_PENDING {
            return Err(ProjectError::code("DRAFT_LIMIT"));
        }
        let mut seen_pending = HashSet::new();
        for item in &request.pending {
            if !is_valid_input_id(&item.input_id)
                || item.text.chars().count() > MAX_TEXT_CHARS
                || !seen_pending.insert(item.input_id.as_str())
            {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
        }
        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        }
        let _lock = DirectoryLock::acquire(&file, LOCK_TIMEOUT, None)
            .map_err(|_| ProjectError::code("DRAFT_BUSY"))?;
        let before = self.load(&file)?;
        if before.revision != request.revision {
            return Err(ProjectError::code("DRAFT_CONFLICT"));
        }
        let mut uploads = before.uploads;
        for upload in &request.uploads {
            let body = serde_json::to_string(upload)
                .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
            let digest = format!("{:x}", Sha256::digest(body.as_bytes()));
            if let Some(prev) = uploads.get(&upload.id)
                && prev != &digest
            {
                return Err(ProjectError::code("DRAFT_ATTACHMENT_CONFLICT"));
            }
            let blob_path = root
                .join("input-draft-blobs")
                .join(format!("{digest}.json"));
            if !blob_path.exists() {
                atomic_write(&blob_path, body.as_bytes())
                    .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
            }
            uploads.insert(upload.id.clone(), digest);
        }
        let mut used_ids = HashSet::new();
        for id in &request.draft.attachment_ids {
            if !uploads.contains_key(id) {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            used_ids.insert(id.clone());
        }
        for item in &request.pending {
            for id in &item.attachment_ids {
                if !uploads.contains_key(id) {
                    return Err(ProjectError::code("INVALID_DRAFT"));
                }
                used_ids.insert(id.clone());
            }
        }
        let pruned_uploads: BTreeMap<String, String> = uploads
            .into_iter()
            .filter(|(k, _)| used_ids.contains(k))
            .collect();
        let has_feedback = request
            .draft
            .resource_feedback
            .as_ref()
            .is_some_and(|v| !v.is_empty())
            || request
                .pending
                .iter()
                .any(|p| p.resource_feedback.as_ref().is_some_and(|v| !v.is_empty()));
        let schema_version = if before.schema_version >= 3 {
            3
        } else if before.schema_version >= 2 || has_feedback {
            2
        } else {
            1
        };
        let next_revision = before.revision + 1;
        let stored = StoredDraftFile {
            schema_version,
            revision: next_revision,
            draft: request.draft,
            pending: request.pending,
            uploads: pruned_uploads,
        };
        let body =
            serde_json::to_string(&stored).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        atomic_write(&file, body.as_bytes())
            .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        Ok(next_revision)
    }

    fn load_strict(&self, file: &Path) -> Result<StoredDraftFile, ProjectError> {
        let meta = match fs::metadata(file) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                return Ok(StoredDraftFile::empty());
            }
            Err(_) => return Err(ProjectError::code("DRAFT_UNAVAILABLE")),
        };
        if !meta.is_file() || meta.len() > MAX_DRAFT_BYTES {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        let raw = fs::read_to_string(file).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
        let val: Value =
            serde_json::from_str(&raw).map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
        let Some(top) = val.as_object() else {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        };
        if top.keys().any(|k| {
            !matches!(
                k.as_str(),
                "schemaVersion" | "revision" | "draft" | "pending" | "uploads"
            )
        }) {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        let schema_version = top
            .get("schemaVersion")
            .and_then(Value::as_u64)
            .filter(|&v| (1..=3).contains(&v));
        let revision = top
            .get("revision")
            .and_then(Value::as_u64)
            .filter(|&r| r <= MAX_SAFE_INTEGER);
        let Some(draft_obj) = top.get("draft").and_then(Value::as_object) else {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        };
        let Some(pending_arr) = top.get("pending").and_then(Value::as_array) else {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        };
        let Some(uploads_obj) = top.get("uploads").and_then(Value::as_object) else {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        };
        if schema_version.is_none()
            || revision.is_none()
            || pending_arr.len() > MAX_PENDING
            || uploads_obj
                .values()
                .any(|v| !v.as_str().is_some_and(valid_sha256_hex))
        {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        if draft_obj.keys().any(|k| {
            !matches!(
                k.as_str(),
                "text" | "quote" | "resourceFeedback" | "taskRefs" | "attachmentIds"
            )
        }) {
            return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
        }
        for item in pending_arr {
            let Some(p) = item.as_object() else {
                return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
            };
            if p.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "inputId"
                        | "text"
                        | "createdAt"
                        | "resourceFeedback"
                        | "taskRefs"
                        | "quoteRefs"
                        | "answerTo"
                        | "attachmentIds"
                )
            }) {
                return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
            }
        }
        serde_json::from_value::<StoredDraftFile>(val)
            .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))
    }

    /// Reads and hydrates attachments in exact JS `input-draft-store.mjs#read` parity.
    /// Returns `RESOURCE_FEEDBACK_HOST_REQUIRED` if the draft or any pending envelope carries
    /// `resourceFeedback` so Electron Main can delegate interactive SQLite admission to Node.
    pub fn read_hydrated(
        &self,
        workspace_id: &str,
        surface: &str,
        verify_blobs: bool,
    ) -> Result<HydratedDraftSnapshot, ProjectError> {
        let (root, file) = self.location(workspace_id, surface)?;
        let saved = self.load_strict(&file)?;
        if stored_has_resource_feedback(&saved) {
            return Err(ProjectError::code("RESOURCE_FEEDBACK_HOST_REQUIRED"));
        }

        let mut hydrated_cache: HashMap<String, Value> = HashMap::new();
        let mut hydrate = |ids: &[String]| -> Result<Vec<Value>, ProjectError> {
            if ids.len() > INPUT_ATTACHMENT_LIMIT {
                return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
            }
            let mut out = Vec::with_capacity(ids.len());
            for id in ids {
                let Some(digest) = saved.uploads.get(id).filter(|d| valid_sha256_hex(d)) else {
                    return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
                };
                if let Some(cached) = hydrated_cache.get(id) {
                    out.push(cached.clone());
                    continue;
                }
                let blob_path = root
                    .join("input-draft-blobs")
                    .join(format!("{digest}.json"));
                if verify_blobs {
                    let meta = fs::metadata(&blob_path)
                        .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
                    if meta.len() > MAX_DRAFT_BYTES {
                        return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
                    }
                }
                let body = fs::read_to_string(&blob_path)
                    .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
                if verify_blobs {
                    let actual = format!("{:x}", Sha256::digest(body.as_bytes()));
                    if actual != *digest {
                        return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
                    }
                }
                let parsed: Value = serde_json::from_str(&body)
                    .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
                let normalized = normalize_user_upload(&parsed)
                    .map_err(|_| ProjectError::code("DRAFT_UNAVAILABLE"))?;
                if normalized["id"].as_str() != Some(id.as_str()) {
                    return Err(ProjectError::code("DRAFT_UNAVAILABLE"));
                }
                hydrated_cache.insert(id.clone(), normalized.clone());
                out.push(normalized);
            }
            Ok(out)
        };

        if saved.draft.text.encode_utf16().count() > MAX_TEXT_CHARS {
            return Err(ProjectError::code("INVALID_DRAFT"));
        }
        let draft_quote = normalize_quote_strict(saved.draft.quote.as_ref())?;
        let draft_attachments = hydrate(&saved.draft.attachment_ids)?;
        let draft = HydratedDraftBody {
            text: saved.draft.text,
            quote: draft_quote,
            attachments: draft_attachments,
            task_refs: saved.draft.task_refs,
        };

        let mut pending = Vec::with_capacity(saved.pending.len());
        for item in &saved.pending {
            if !is_valid_input_id(&item.input_id)
                || parse_iso_ms(&item.created_at).is_none()
                || item.text.encode_utf16().count() > MAX_TEXT_CHARS
            {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            let Some(quote_refs) = item.quote_refs.as_ref() else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            if quote_refs.len() > MAX_QUOTE_REFS
                || quote_refs
                    .iter()
                    .any(|q| q.encode_utf16().count() > MAX_TEXT_CHARS)
            {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            let answer_to = match item.answer_to.as_deref() {
                None | Some("") => None,
                Some(s) => {
                    if s.encode_utf16().count() > MAX_QUOTE_MSG_ID_CHARS {
                        return Err(ProjectError::code("INVALID_DRAFT"));
                    }
                    Some(s.to_owned())
                }
            };
            let attachments = hydrate(&item.attachment_ids)?;
            pending.push(HydratedDraftEnvelope {
                input_id: item.input_id.clone(),
                text: item.text.clone(),
                created_at: item.created_at.clone(),
                quote_refs: quote_refs.clone(),
                answer_to,
                attachments,
                task_refs: item.task_refs.clone(),
            });
        }

        Ok(HydratedDraftSnapshot {
            revision: saved.revision,
            draft,
            pending,
        })
    }

    /// Strict CAS write matching `packages/runtime-node/src/project-agent/input-draft-store.mjs#write`.
    /// Delegates (`RESOURCE_FEEDBACK_HOST_REQUIRED`) when either incoming payload or stored
    /// state contains non-empty `resourceFeedback`.
    pub fn write_strict(&self, request: &Value) -> Result<u64, ProjectError> {
        let Some(req_obj) = request.as_object() else {
            return Err(ProjectError::code("INVALID_DRAFT"));
        };
        let ws = req_obj
            .get("workspaceId")
            .and_then(Value::as_str)
            .unwrap_or("");
        let surface = req_obj.get("surface").and_then(Value::as_str).unwrap_or("");
        let (root, file) = self.location(ws, surface)?;
        let Some(expected_rev) = req_obj
            .get("revision")
            .and_then(Value::as_u64)
            .filter(|&r| r <= MAX_SAFE_INTEGER)
        else {
            return Err(ProjectError::code("INVALID_DRAFT"));
        };

        if let Some(d_obj) = req_obj.get("draft").and_then(Value::as_object)
            && has_nonempty_resource_feedback(d_obj.get("resourceFeedback"))
        {
            return Err(ProjectError::code("RESOURCE_FEEDBACK_HOST_REQUIRED"));
        }
        if let Some(p_arr) = req_obj.get("pending").and_then(Value::as_array)
            && p_arr.iter().any(|item| {
                item.as_object()
                    .is_some_and(|o| has_nonempty_resource_feedback(o.get("resourceFeedback")))
            })
        {
            return Err(ProjectError::code("RESOURCE_FEEDBACK_HOST_REQUIRED"));
        }

        if let Some(parent) = file.parent() {
            fs::create_dir_all(parent).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        }
        let _lock = DirectoryLock::acquire(&file, LOCK_TIMEOUT, None)
            .map_err(|_| ProjectError::code("DRAFT_BUSY"))?;
        let before = self
            .load_strict(&file)
            .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        if before.revision != expected_rev {
            return Err(ProjectError::code("DRAFT_CONFLICT"));
        }
        if stored_has_resource_feedback(&before) {
            return Err(ProjectError::code("RESOURCE_FEEDBACK_HOST_REQUIRED"));
        }

        let Some(req_uploads) = req_obj.get("uploads").and_then(Value::as_array) else {
            return Err(ProjectError::code("INVALID_DRAFT"));
        };
        if req_uploads.len() > INPUT_ATTACHMENT_LIMIT * (MAX_PENDING + 1) {
            return Err(ProjectError::code("INVALID_DRAFT"));
        }

        let mut uploads = before.uploads;
        for raw in req_uploads {
            let (id, _norm, body) = canonical_upload_json(raw)?;
            let digest = format!("{:x}", Sha256::digest(body.as_bytes()));
            if let Some(prev) = uploads.get(&id)
                && prev != &digest
            {
                return Err(ProjectError::code("DRAFT_ATTACHMENT_CONFLICT"));
            }
            let blob_path = root
                .join("input-draft-blobs")
                .join(format!("{digest}.json"));
            if !blob_path.exists() {
                atomic_write(&blob_path, body.as_bytes())
                    .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
            }
            uploads.insert(id, digest);
        }

        let validate_refs = |value: Option<&Value>| -> Result<Vec<String>, ProjectError> {
            let Some(arr) = value.and_then(Value::as_array) else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            if arr.len() > INPUT_ATTACHMENT_LIMIT {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            let mut out = Vec::with_capacity(arr.len());
            let mut seen = HashSet::new();
            for v in arr {
                let Some(id) = v.as_str() else {
                    return Err(ProjectError::code("INVALID_DRAFT"));
                };
                if !uploads.contains_key(id) || !seen.insert(id) {
                    return Err(ProjectError::code("INVALID_DRAFT"));
                }
                out.push(id.to_owned());
            }
            Ok(out)
        };

        let draft_obj = req_obj.get("draft").and_then(Value::as_object);
        let draft_text =
            validate_text_limit(draft_obj.and_then(|o| o.get("text")), MAX_TEXT_CHARS)?;
        let draft_quote = normalize_quote_strict(draft_obj.and_then(|o| o.get("quote")))?
            .map(|q| serde_json::to_value(q).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED")))
            .transpose()?;
        let draft_refs = validate_refs(draft_obj.and_then(|o| o.get("attachmentIds")))?;
        let draft_task_refs =
            normalize_task_refs_strict(draft_obj.and_then(|o| o.get("taskRefs")))?;
        let draft = DraftBody {
            text: draft_text,
            quote: draft_quote,
            resource_feedback: None,
            attachment_ids: draft_refs,
            task_refs: draft_task_refs,
        };

        let Some(req_pending) = req_obj.get("pending").and_then(Value::as_array) else {
            return Err(ProjectError::code("DRAFT_LIMIT"));
        };
        if req_pending.len() > MAX_PENDING {
            return Err(ProjectError::code("DRAFT_LIMIT"));
        }
        let mut pending = Vec::with_capacity(req_pending.len());
        let mut seen_input_ids = HashSet::new();
        for raw_item in req_pending {
            let Some(p) = raw_item.as_object() else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            let Some(input_id) = p
                .get("inputId")
                .and_then(Value::as_str)
                .filter(|s| is_valid_input_id(s))
            else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            if !seen_input_ids.insert(input_id.to_owned()) {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            let Some(created_at) = p
                .get("createdAt")
                .and_then(Value::as_str)
                .filter(|s| parse_iso_ms(s).is_some())
            else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            let Some(q_refs_arr) = p.get("quoteRefs").and_then(Value::as_array) else {
                return Err(ProjectError::code("INVALID_DRAFT"));
            };
            if q_refs_arr.len() > MAX_QUOTE_REFS {
                return Err(ProjectError::code("INVALID_DRAFT"));
            }
            let mut quote_refs = Vec::with_capacity(q_refs_arr.len());
            for qr in q_refs_arr {
                quote_refs.push(validate_text_limit(Some(qr), MAX_TEXT_CHARS)?);
            }
            let p_text = validate_text_limit(p.get("text"), MAX_TEXT_CHARS)?;
            let answer_to = match p.get("answerTo") {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) if s.is_empty() => None,
                Some(v) => Some(validate_text_limit(Some(v), MAX_QUOTE_MSG_ID_CHARS)?),
            };
            let attachment_ids = validate_refs(p.get("attachmentIds"))?;
            let task_refs = normalize_task_refs_strict(p.get("taskRefs"))?;
            pending.push(DraftEnvelope {
                input_id: input_id.to_owned(),
                text: p_text,
                created_at: created_at.to_owned(),
                resource_feedback: None,
                quote_refs: Some(quote_refs),
                answer_to,
                attachment_ids,
                task_refs,
            });
        }

        let mut used_ids: HashSet<String> = draft.attachment_ids.iter().cloned().collect();
        for item in &pending {
            used_ids.extend(item.attachment_ids.iter().cloned());
        }
        let mut total_blob_bytes: u64 = 0;
        for id in &used_ids {
            let digest = &uploads[id];
            let blob_path = root
                .join("input-draft-blobs")
                .join(format!("{digest}.json"));
            let meta =
                fs::metadata(&blob_path).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
            total_blob_bytes = total_blob_bytes.saturating_add(meta.len());
        }
        if total_blob_bytes > MAX_TOTAL_BLOB_BYTES {
            return Err(ProjectError::code("DRAFT_LIMIT"));
        }

        let pruned_uploads: BTreeMap<String, String> = uploads
            .into_iter()
            .filter(|(k, _)| used_ids.contains(k))
            .collect();
        let next_revision = before.revision + 1;
        let stored = StoredDraftFile {
            schema_version: before.schema_version,
            revision: next_revision,
            draft,
            pending,
            uploads: pruned_uploads,
        };
        let body =
            serde_json::to_string(&stored).map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        atomic_write(&file, body.as_bytes())
            .map_err(|_| ProjectError::code("DRAFT_SAVE_FAILED"))?;
        Ok(next_revision)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn draft_cas_and_blob_hydration_roundtrip() {
        let dir = tempdir().unwrap();
        let store = InputDraftStore::new(dir.path());
        let initial = store.read("ws-1", "tui", true).unwrap();
        assert_eq!(initial.revision, 0);

        let rev1 = store
            .write(DraftWriteRequest {
                workspace_id: "ws-1",
                surface: "tui",
                revision: 0,
                draft: DraftBody {
                    text: "draft text".into(),
                    quote: None,
                    resource_feedback: None,
                    attachment_ids: vec![],
                    task_refs: vec![],
                },
                pending: vec![],
                uploads: vec![],
            })
            .unwrap();
        assert_eq!(rev1, 1);

        // Stale revision fails with DRAFT_CONFLICT.
        let conflict = store
            .write(DraftWriteRequest {
                workspace_id: "ws-1",
                surface: "tui",
                revision: 0,
                draft: DraftBody::default(),
                pending: vec![],
                uploads: vec![],
            })
            .unwrap_err();
        assert_eq!(conflict.code, "DRAFT_CONFLICT");

        let read_back = store.read("ws-1", "tui", true).unwrap();
        assert_eq!(read_back.revision, 1);
        assert_eq!(read_back.draft.text, "draft text");
    }

    #[test]
    fn hydrated_read_and_strict_write_match_js_contract() {
        use serde_json::json;

        let dir = tempdir().unwrap();
        let store = InputDraftStore::new(dir.path());

        let initial = store.read_hydrated("ws-1", "desktop", false).unwrap();
        assert_eq!(initial.revision, 0);
        assert_eq!(initial.draft.text, "");
        assert_eq!(initial.draft.quote, None);
        assert!(initial.draft.attachments.is_empty());
        assert!(initial.pending.is_empty());

        let req = json!({
            "workspaceId": "ws-1",
            "surface": "desktop",
            "revision": 0,
            "uploads": [{
                "id": "att-1",
                "name": "note.txt",
                "mimeType": "text/plain",
                "size": 5,
                "kind": "text",
                "text": "hello"
            }],
            "draft": {
                "text": "draft body",
                "quote": { "messageId": "m-1", "text": "quoted" },
                "attachmentIds": ["att-1"]
            },
            "pending": [{
                "inputId": "in-1",
                "text": "queued text",
                "createdAt": "2026-11-21T00:00:00.000Z",
                "quoteRefs": ["m-0"],
                "answerTo": "card:question:reply:q-1",
                "attachmentIds": ["att-1"]
            }]
        });
        let rev1 = store.write_strict(&req).unwrap();
        assert_eq!(rev1, 1);

        // Stale revision fails with DRAFT_CONFLICT.
        assert_eq!(store.write_strict(&req).unwrap_err().code, "DRAFT_CONFLICT");

        // Verify blob digest uses exact JS insertion key order.
        let expected_blob = r#"{"id":"att-1","name":"note.txt","mimeType":"text/plain","size":5,"sourceKind":"user_upload","kind":"text","text":"hello"}"#;
        let expected_digest = format!("{:x}", Sha256::digest(expected_blob.as_bytes()));
        let blob_path = dir
            .path()
            .join("project-runtime/ws-1/input-draft-blobs")
            .join(format!("{expected_digest}.json"));
        assert_eq!(fs::read_to_string(&blob_path).unwrap(), expected_blob);

        let snap = store.read_hydrated("ws-1", "desktop", true).unwrap();
        assert_eq!(snap.revision, 1);
        assert_eq!(snap.draft.text, "draft body");
        assert_eq!(snap.draft.attachments.len(), 1);
        assert_eq!(snap.draft.attachments[0]["text"], "hello");
        assert_eq!(snap.pending.len(), 1);
        assert_eq!(snap.pending[0].attachments.len(), 1);

        // Rewriting with same attachment ID & content succeeds, whereas modified content conflicts.
        let rev2 = store
            .write_strict(&json!({
                "workspaceId": "ws-1",
                "surface": "desktop",
                "revision": 1,
                "uploads": [{
                    "id": "att-1",
                    "name": "note.txt",
                    "mimeType": "text/plain",
                    "size": 5,
                    "kind": "text",
                    "text": "hello"
                }],
                "draft": { "text": "v2", "quote": null, "attachmentIds": ["att-1"] },
                "pending": []
            }))
            .unwrap();
        assert_eq!(rev2, 2);

        let att_conflict = store
            .write_strict(&json!({
                "workspaceId": "ws-1",
                "surface": "desktop",
                "revision": 2,
                "uploads": [{
                    "id": "att-1",
                    "name": "note.txt",
                    "mimeType": "text/plain",
                    "size": 5,
                    "kind": "text",
                    "text": "world"
                }],
                "draft": { "text": "v3", "quote": null, "attachmentIds": ["att-1"] },
                "pending": []
            }))
            .unwrap_err();
        assert_eq!(att_conflict.code, "DRAFT_ATTACHMENT_CONFLICT");

        // More than 8 attachments per draft/pending rejects with INVALID_DRAFT.
        let nine_uploads: Vec<Value> = (0..9)
            .map(|i| {
                json!({
                    "id": format!("a-{i}"),
                    "name": format!("f-{i}.txt"),
                    "mimeType": "text/plain",
                    "size": 1,
                    "kind": "text",
                    "text": "x"
                })
            })
            .collect();
        let nine_ids: Vec<String> = (0..9).map(|i| format!("a-{i}")).collect();
        assert_eq!(
            store
                .write_strict(&json!({
                    "workspaceId": "ws-1",
                    "surface": "desktop",
                    "revision": 2,
                    "uploads": nine_uploads,
                    "draft": { "text": "", "quote": null, "attachmentIds": nine_ids },
                    "pending": []
                }))
                .unwrap_err()
                .code,
            "INVALID_DRAFT"
        );

        // Non-empty resourceFeedback signals host delegation.
        let fb_req = json!({
            "workspaceId": "ws-1",
            "surface": "desktop",
            "revision": 2,
            "uploads": [],
            "draft": {
                "text": "with feedback",
                "quote": null,
                "resourceFeedback": [{ "id": "rf-1", "resource": { "kind": "interactive" } }],
                "attachmentIds": []
            },
            "pending": []
        });
        assert_eq!(
            store.write_strict(&fb_req).unwrap_err().code,
            "RESOURCE_FEEDBACK_HOST_REQUIRED"
        );
    }

    #[test]
    fn draft_task_refs_roundtrip_and_strict_validation() {
        use serde_json::json;

        let dir = tempdir().unwrap();
        let store = InputDraftStore::new(dir.path());

        let req = json!({
            "workspaceId": "ws-1",
            "surface": "desktop",
            "revision": 0,
            "uploads": [],
            "draft": {
                "text": "请对照上次检查",
                "quote": null,
                "attachmentIds": [],
                "taskRefs": [{
                    "sessionId": "sess-123",
                    "title": "验证 gitconfig 放行",
                    "status": "accepted",
                    "anchorMessageId": "m-42"
                }]
            },
            "pending": [{
                "inputId": "in-ref-1",
                "text": "继续处理",
                "createdAt": "2026-11-23T10:00:00.000Z",
                "quoteRefs": [],
                "attachmentIds": [],
                "taskRefs": [{
                    "sessionId": "sess-123",
                    "title": "验证 gitconfig 放行"
                }]
            }]
        });

        let rev1 = store.write_strict(&req).unwrap();
        assert_eq!(rev1, 1);

        let snap = store.read_hydrated("ws-1", "desktop", true).unwrap();
        assert_eq!(snap.revision, 1);
        assert_eq!(snap.draft.task_refs.len(), 1);
        assert_eq!(snap.draft.task_refs[0].session_id, "sess-123");
        assert_eq!(snap.draft.task_refs[0].title, "验证 gitconfig 放行");
        assert_eq!(
            snap.draft.task_refs[0].anchor_message_id.as_deref(),
            Some("m-42")
        );
        assert_eq!(snap.pending.len(), 1);
        assert_eq!(snap.pending[0].task_refs.len(), 1);
        assert_eq!(snap.pending[0].task_refs[0].session_id, "sess-123");

        // Duplicate sessionId is deduplicated cleanly; exceeding MAX_TASK_REFS rejects INVALID_DRAFT
        let dup_req = json!({
            "workspaceId": "ws-1",
            "surface": "desktop",
            "revision": 1,
            "uploads": [],
            "draft": {
                "text": "",
                "quote": null,
                "attachmentIds": [],
                "taskRefs": [
                    { "sessionId": "sess-123", "title": "A" },
                    { "sessionId": "sess-123", "title": "B" }
                ]
            },
            "pending": []
        });
        assert_eq!(store.write_strict(&dup_req).unwrap(), 2);
        let deduped = store.read_hydrated("ws-1", "desktop", true).unwrap();
        assert_eq!(deduped.draft.task_refs.len(), 1);
        assert_eq!(deduped.draft.task_refs[0].title, "A");

        let too_many: Vec<Value> = (0..=MAX_TASK_REFS)
            .map(|i| json!({ "sessionId": format!("sess-{i}"), "title": format!("T{i}") }))
            .collect();
        let over_req = json!({
            "workspaceId": "ws-1",
            "surface": "desktop",
            "revision": 2,
            "uploads": [],
            "draft": { "text": "", "quote": null, "attachmentIds": [], "taskRefs": too_many },
            "pending": []
        });
        assert_eq!(
            store.write_strict(&over_req).unwrap_err().code,
            "INVALID_DRAFT"
        );
    }
}
