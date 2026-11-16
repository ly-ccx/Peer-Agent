//! MCP metadata only. Secret resolution and legacy decryption never live here.
use crate::{DirectoryLock, StoreError, durable_jsonl, files};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub struct McpCredentialBinding {
    pub revision: String,
    pub metadata: Value,
}
pub struct McpCredentialStore {
    file: PathBuf,
}
impl McpCredentialStore {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            file: home.as_ref().join("mcp-credentials.json"),
        }
    }
    fn source(&self) -> Result<(String, Value), StoreError> {
        let before = files::identity(&self.file)?;
        let raw = files::read(&self.file, 1024 * 1024)?;
        let value = match raw {
            None => json!({"version":2,"credentials":[]}),
            Some(raw) => {
                peer_protocol::decode_json_bounded(
                    &raw,
                    peer_protocol::JsonLimits {
                        bytes: 1024 * 1024,
                        nodes: 65536,
                        depth: 32,
                        string_bytes: 1024 * 1024,
                    },
                )
                .map_err(|_| StoreError::McpCredentialInvalid)?
                .value
            }
        };
        if files::identity(&self.file)? != before {
            return Err(StoreError::VersionChanged);
        }
        Ok((files::fingerprint(&[before]), value))
    }
    pub fn revision(&self) -> Result<String, StoreError> {
        self.source().map(|v| v.0)
    }
    pub fn binding(
        &self,
        credential_ref: &str,
        kind: &str,
    ) -> Result<McpCredentialBinding, StoreError> {
        let (revision, value) = self.source()?;
        let rows = validate(&value)?;
        let metadata = rows
            .iter()
            .find(|r| r["credentialRef"] == credential_ref && r["kind"] == kind)
            .ok_or(StoreError::McpCredentialMissing)?
            .clone();
        Ok(McpCredentialBinding { revision, metadata })
    }
    /// Hold the same cross-host directory lock through OAuth refresh/login.
    /// No stale-lock takeover. Dropping on cancellation releases only our lock.
    pub fn transaction(
        &self,
        binding: &McpCredentialBinding,
    ) -> Result<McpCredentialTransaction, StoreError> {
        let lock = DirectoryLock::acquire(&self.file, std::time::Duration::ZERO, None)?;
        self.check(binding)?;
        let (revision, data) = self.source()?;
        if revision != binding.revision {
            return Err(StoreError::VersionChanged);
        }
        Ok(McpCredentialTransaction {
            file: self.file.clone(),
            lock,
            binding: binding.clone(),
            data,
        })
    }
    pub fn check(&self, binding: &McpCredentialBinding) -> Result<(), StoreError> {
        let current = self.binding(
            binding.metadata["credentialRef"]
                .as_str()
                .ok_or(StoreError::McpCredentialInvalid)?,
            binding.metadata["kind"]
                .as_str()
                .ok_or(StoreError::McpCredentialInvalid)?,
        )?;
        if current.revision != binding.revision || current.metadata != binding.metadata {
            return Err(StoreError::VersionChanged);
        }
        Ok(())
    }
}

fn validate(value: &Value) -> Result<&Vec<Value>, StoreError> {
    if value["version"] == 1 {
        return Err(StoreError::McpCredentialMigrationRequired);
    }
    if value["version"] != 2 {
        return Err(StoreError::McpCredentialInvalid);
    }
    let rows = value["credentials"]
        .as_array()
        .filter(|v| v.len() <= 1024)
        .ok_or(StoreError::McpCredentialInvalid)?;
    let mut refs = std::collections::HashSet::new();
    for row in rows {
        if row["kind"] == "oauth2" && !row["oauth"].is_object() {
            return Err(StoreError::McpCredentialInvalid);
        }
        let id = row["id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or(StoreError::McpCredentialInvalid)?;
        let ref_ = row["credentialRef"]
            .as_str()
            .filter(|v| v.len() <= 1024 && *v == format!("mcp-cred:{id}"))
            .ok_or(StoreError::McpCredentialInvalid)?;
        if !refs.insert(ref_)
            || row.get("secret").is_some()
            || !matches!(
                row["kind"].as_str(),
                Some("http_bearer" | "http_header" | "stdio_env" | "oauth2")
            )
        {
            return Err(StoreError::McpCredentialInvalid);
        }
        let prefix = format!("mcp/{:x}/", Sha256::digest(ref_.as_bytes()));
        let key = row["vaultKey"]
            .as_str()
            .ok_or(StoreError::McpCredentialInvalid)?;
        let generation = key
            .strip_prefix(&prefix)
            .ok_or(StoreError::McpCredentialInvalid)?;
        if !uuid::Uuid::parse_str(generation).is_ok_and(|v| {
            v.get_version_num() == 4
                && v.get_variant() == uuid::Variant::RFC4122
                && v.to_string() == generation
        }) {
            return Err(StoreError::McpCredentialInvalid);
        }
        if row["oauth"].as_object().is_some_and(|o| {
            o.keys().any(|k| {
                !matches!(
                    k.as_str(),
                    "authorizationServerUrl"
                        | "clientId"
                        | "clientSecretConfigured"
                        | "scopes"
                        | "redirectUrl"
                        | "tokenStatus"
                        | "expiresAt"
                )
            })
        }) {
            return Err(StoreError::McpCredentialInvalid);
        }
    }
    Ok(rows)
}

pub struct McpCredentialTransaction {
    file: PathBuf,
    lock: DirectoryLock,
    binding: McpCredentialBinding,
    data: Value,
}
impl McpCredentialTransaction {
    /// Only a verified immutable Vault slot may be published by the Host.
    pub fn commit(mut self, metadata: Value) -> Result<McpCredentialBinding, StoreError> {
        self.lock.check_owned()?;
        let store = McpCredentialStore {
            file: self.file.clone(),
        };
        store.check(&self.binding)?;
        if metadata["credentialRef"] != self.binding.metadata["credentialRef"]
            || metadata["id"] != self.binding.metadata["id"]
            || metadata["kind"] != self.binding.metadata["kind"]
        {
            return Err(StoreError::McpCredentialInvalid);
        }
        let row = self.data["credentials"]
            .as_array_mut()
            .ok_or(StoreError::McpCredentialInvalid)?
            .iter_mut()
            .find(|r| r["credentialRef"] == metadata["credentialRef"])
            .ok_or(StoreError::McpCredentialMissing)?;
        *row = metadata;
        validate(&self.data)?;
        let bytes = serde_json::to_vec(&self.data).map_err(|_| StoreError::McpCredentialInvalid)?;
        if bytes.len() > 1024 * 1024 {
            return Err(StoreError::HistoryLimit);
        }
        durable_jsonl::replace(&self.file, &bytes, None)?;
        let committed = store.binding(
            self.binding.metadata["credentialRef"].as_str().unwrap(),
            self.binding.metadata["kind"].as_str().unwrap(),
        )?;
        self.lock.release()?;
        Ok(committed)
    }
}
