//! Read-only existing registry seam. No diagnostics/config writes or transport.
use crate::{StoreError, files};
use std::path::{Path, PathBuf};
pub struct McpRegistryStore {
    file: PathBuf,
}
pub struct McpRegistrySnapshot {
    pub source_revision: String,
    pub inventory: peer_protocol::McpInventory,
    servers: Vec<serde_json::Value>,
}
impl McpRegistrySnapshot {
    /// Host transport configuration only. Never return this to a renderer/model.
    pub fn server(&self, id: &str) -> Option<serde_json::Value> {
        self.servers
            .iter()
            .find(|v| v["id"].as_str().or_else(|| v["mcpId"].as_str()) == Some(id))
            .cloned()
    }
}
impl McpRegistryStore {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            file: home.as_ref().join("mcp-registry.json"),
        }
    }
    pub fn read(&self) -> Result<McpRegistrySnapshot, StoreError> {
        let before = files::identity(&self.file)?;
        let raw = files::read(&self.file, 1024 * 1024)?;
        let value = match raw {
            None => serde_json::json!({"version":1,"servers":[]}),
            Some(bytes) => {
                peer_protocol::decode_json_bounded(
                    &bytes,
                    peer_protocol::JsonLimits {
                        bytes: 1024 * 1024,
                        nodes: 65536,
                        depth: 32,
                        string_bytes: 1024 * 1024,
                    },
                )
                .map_err(|_| StoreError::HistoryCorrupt)?
                .value
            }
        };
        if files::identity(&self.file)? != before {
            return Err(StoreError::VersionChanged);
        }
        let inventory = peer_protocol::project_mcp_inventory(&value)
            .map_err(|_| StoreError::McpInventoryInvalid)?;
        Ok(McpRegistrySnapshot {
            source_revision: files::fingerprint(&[before]),
            inventory,
            servers: value
                .as_array()
                .or_else(|| value["servers"].as_array())
                .cloned()
                .unwrap_or_default(),
        })
    }
}
