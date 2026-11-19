//! Project registry: stable `workspaceId` per workspace in `projects/registry.json`.
//!
//! Matches `packages/runtime-node/src/project-registry.mjs` (ADR 85 §6 & RC03).
//! `diagnostic_snapshot` is strictly read-only and never backs up or mutates disk.

use crate::{ProjectError, atomic_write, is_uuid_v4, is_valid_workspace_id, now_iso};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

const MAX_REGISTRY_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRegistryEntry {
    pub workspace_id: String,
    pub path: String,
    pub real_path: String,
    pub created_at: String,
    pub previous_paths: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_alias: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistryDocument {
    schema_version: u32,
    projects: Vec<ProjectRegistryEntry>,
}

impl RegistryDocument {
    fn empty() -> Self {
        Self {
            schema_version: 1,
            projects: Vec::new(),
        }
    }
}

pub struct ProjectRegistry {
    file_path: PathBuf,
}

fn normalize_path(value: &str) -> Option<String> {
    let mut trimmed = value.trim();
    if trimmed.is_empty() {
        return None;
    }
    while trimmed.len() > 1 && (trimmed.ends_with('/') || trimmed.ends_with('\\')) {
        trimmed = &trimmed[..trimmed.len() - 1];
    }
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_owned())
    }
}

fn resolve_real_path(folder: &str) -> String {
    fs::canonicalize(folder)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| folder.to_owned())
}

fn validate_document(doc: RegistryDocument) -> Option<RegistryDocument> {
    if doc.schema_version != 1 {
        return None;
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    let mut entries = Vec::with_capacity(doc.projects.len());
    for entry in doc.projects {
        if !is_uuid_v4(&entry.workspace_id)
            || entry.path.is_empty()
            || entry.real_path.is_empty()
            || entry.created_at.is_empty()
        {
            return None;
        }
        if let Some(ref alias) = entry.remote_alias
            && !is_valid_workspace_id(alias)
        {
            return None;
        }
        if !ids.insert(entry.workspace_id.clone()) || !paths.insert(entry.path.clone()) {
            return None;
        }
        entries.push(entry);
    }
    Some(RegistryDocument {
        schema_version: 1,
        projects: entries,
    })
}

impl ProjectRegistry {
    /// Points at `<data_home>/projects/registry.json`. Performs no disk I/O on construction.
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            file_path: data_home.as_ref().join("projects").join("registry.json"),
        }
    }

    pub fn from_file(file_path: impl AsRef<Path>) -> Self {
        Self {
            file_path: file_path.as_ref().to_path_buf(),
        }
    }

    pub fn file_path(&self) -> &Path {
        &self.file_path
    }

    /// Strictly read-only snapshot (ADR 85 RC03). Missing returns empty vec; corrupt
    /// returns `CORRUPT_REGISTRY` without backing up, repairing, or creating directories.
    pub fn diagnostic_snapshot(&self) -> Result<Vec<ProjectRegistryEntry>, ProjectError> {
        let meta = match fs::metadata(&self.file_path) {
            Ok(m) => m,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(ProjectError::code("CORRUPT_REGISTRY")),
        };
        if !meta.is_file() || meta.len() > MAX_REGISTRY_BYTES {
            return Err(ProjectError::code("CORRUPT_REGISTRY"));
        }
        let raw = fs::read_to_string(&self.file_path)
            .map_err(|_| ProjectError::code("CORRUPT_REGISTRY"))?;
        let parsed: RegistryDocument =
            serde_json::from_str(&raw).map_err(|_| ProjectError::code("CORRUPT_REGISTRY"))?;
        let valid =
            validate_document(parsed).ok_or_else(|| ProjectError::code("CORRUPT_REGISTRY"))?;
        Ok(valid.projects)
    }

    /// Read-only remote aliases for `workspace_id`. Never writes or repairs disk.
    pub fn read_remote_aliases(&self, workspace_id: &str) -> Vec<String> {
        if !is_valid_workspace_id(workspace_id) {
            return Vec::new();
        }
        let Ok(entries) = self.diagnostic_snapshot() else {
            return Vec::new();
        };
        entries
            .into_iter()
            .find(|e| e.workspace_id == workspace_id)
            .and_then(|e| e.remote_alias)
            .filter(|a| is_valid_workspace_id(a) && a != workspace_id)
            .into_iter()
            .collect()
    }

    fn backup_corrupt(&self) {
        let stamp = now_iso().replace(':', "-");
        let mut dest = self.file_path.as_os_str().to_os_string();
        dest.push(format!(".corrupt-{stamp}"));
        let _ = fs::copy(&self.file_path, PathBuf::from(dest));
    }

    fn read_doc(&self) -> (RegistryDocument, bool) {
        if !self.file_path.exists() {
            return (RegistryDocument::empty(), false);
        }
        match self.diagnostic_snapshot() {
            Ok(projects) => (
                RegistryDocument {
                    schema_version: 1,
                    projects,
                },
                false,
            ),
            Err(_) => {
                self.backup_corrupt();
                (RegistryDocument::empty(), true)
            }
        }
    }

    fn write_doc(&self, doc: &RegistryDocument) -> Result<(), ProjectError> {
        let mut body = serde_json::to_string_pretty(doc)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        body.push('\n');
        atomic_write(&self.file_path, body.as_bytes())
    }

    pub fn list(&self) -> Result<Vec<ProjectRegistryEntry>, ProjectError> {
        let (doc, dirty) = self.read_doc();
        if dirty {
            self.write_doc(&doc)?;
        }
        Ok(doc.projects)
    }

    pub fn get(&self, workspace_id: &str) -> Result<Option<ProjectRegistryEntry>, ProjectError> {
        let entries = self.list()?;
        Ok(entries.into_iter().find(|e| e.workspace_id == workspace_id))
    }

    pub fn find_by_path(&self, folder: &str) -> Result<Option<ProjectRegistryEntry>, ProjectError> {
        let Some(norm) = normalize_path(folder) else {
            return Ok(None);
        };
        let real = resolve_real_path(&norm);
        let entries = self.list()?;
        Ok(entries
            .into_iter()
            .find(|e| e.path == norm || e.real_path == real))
    }

    /// Find existing registration by path/realPath or create a new UUIDv4 entry atomically.
    pub fn register(
        &self,
        folder: &str,
        remote_alias: Option<&str>,
    ) -> Result<ProjectRegistryEntry, ProjectError> {
        let norm = normalize_path(folder).ok_or_else(|| ProjectError::code("INVALID_PATH"))?;
        if let Some(alias) = remote_alias
            && !is_valid_workspace_id(alias)
        {
            return Err(ProjectError::code("INVALID_ALIAS"));
        }
        let real = resolve_real_path(&norm);
        let (mut doc, mut dirty) = self.read_doc();
        if let Some(entry) = doc
            .projects
            .iter_mut()
            .find(|e| e.path == norm || e.real_path == real)
        {
            if entry.path != norm {
                if !entry.previous_paths.contains(&entry.path) {
                    entry.previous_paths.push(entry.path.clone());
                }
                entry.path = norm;
                entry.real_path = real;
                dirty = true;
            }
            if let Some(alias) = remote_alias
                && entry.remote_alias.as_deref() != Some(alias)
            {
                entry.remote_alias = Some(alias.to_owned());
                dirty = true;
            }
            let out = entry.clone();
            if dirty {
                self.write_doc(&doc)?;
            }
            return Ok(out);
        }
        let entry = ProjectRegistryEntry {
            workspace_id: uuid::Uuid::new_v4().to_string(),
            path: norm,
            real_path: real,
            created_at: now_iso(),
            previous_paths: Vec::new(),
            remote_alias: remote_alias.map(str::to_owned),
        };
        doc.projects.push(entry.clone());
        self.write_doc(&doc)?;
        Ok(entry)
    }

    pub fn update_path(
        &self,
        workspace_id: &str,
        new_folder: &str,
    ) -> Result<Option<ProjectRegistryEntry>, ProjectError> {
        let norm = normalize_path(new_folder).ok_or_else(|| ProjectError::code("INVALID_PATH"))?;
        let real = resolve_real_path(&norm);
        let (mut doc, mut dirty) = self.read_doc();
        let Some(entry) = doc
            .projects
            .iter_mut()
            .find(|e| e.workspace_id == workspace_id)
        else {
            if dirty {
                self.write_doc(&doc)?;
            }
            return Ok(None);
        };
        if entry.path != norm || entry.real_path != real {
            if entry.path != norm && !entry.previous_paths.contains(&entry.path) {
                entry.previous_paths.push(entry.path.clone());
            }
            entry.path = norm;
            entry.real_path = real;
            dirty = true;
        }
        let out = entry.clone();
        if dirty {
            self.write_doc(&doc)?;
        }
        Ok(Some(out))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn register_find_and_diagnostic_snapshot_preserve_contract() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("my-repo");
        fs::create_dir_all(&ws).unwrap();
        let reg = ProjectRegistry::new(dir.path());
        assert!(reg.diagnostic_snapshot().unwrap().is_empty());

        let first = reg
            .register(ws.to_str().unwrap(), Some("my-alias"))
            .unwrap();
        assert!(is_uuid_v4(&first.workspace_id));
        assert_eq!(first.remote_alias.as_deref(), Some("my-alias"));
        assert_eq!(
            reg.read_remote_aliases(&first.workspace_id),
            vec!["my-alias"]
        );

        // Re-registering same path returns identical workspaceId.
        let second = reg.register(&format!("{}/", ws.display()), None).unwrap();
        assert_eq!(first.workspace_id, second.workspace_id);

        // Corrupt file fails closed in diagnostic_snapshot without mutating disk.
        fs::write(reg.file_path(), "{broken").unwrap();
        assert_eq!(
            reg.diagnostic_snapshot().unwrap_err().code,
            "CORRUPT_REGISTRY"
        );
        assert_eq!(fs::read_to_string(reg.file_path()).unwrap(), "{broken");
    }
}
