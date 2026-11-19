//! Device-local recoverable input drafts (`project-runtime/<workspaceId>/input-drafts/<surface>.json`
//! and content-addressed `input-draft-blobs/<sha256>.json`).
//!
//! Matches `packages/runtime-node/src/project-agent/input-draft-store.mjs` (ADR 115).
//! Never submits to the input queue or wakes any runner.

use crate::{ProjectError, atomic_write, is_valid_input_id, is_valid_workspace_id};
use peer_store::DirectoryLock;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const MAX_DRAFT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 100_000;
const MAX_PENDING: usize = 32;
const MAX_ATTACHMENTS: usize = 16;
const LOCK_TIMEOUT: Duration = Duration::from_secs(2);

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

fn valid_surface(surface: &str) -> bool {
    matches!(surface, "desktop" | "quick_chat" | "tui")
}

fn valid_sha256_hex(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
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
}
