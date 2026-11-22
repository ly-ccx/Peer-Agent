use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, time::Duration};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_EXTERNAL_CAPABILITIES: usize = 128;
pub const MAX_PENDING_HOST_CALLS: usize = 256;
pub const DEFAULT_REVERSE_TIMEOUT: Duration = Duration::from_secs(30);

pub const CODE_PARSE_ERROR: i32 = -32700;
pub const CODE_INVALID_REQUEST: i32 = -32600;
pub const CODE_METHOD_NOT_FOUND: i32 = -32601;
pub const CODE_INVALID_PARAMS: i32 = -32602;
pub const CODE_INTERNAL_ERROR: i32 = -32603;
pub const CODE_NOT_INITIALIZED: i32 = -32001;
pub const CODE_ALREADY_INITIALIZED: i32 = -32002;
pub const CODE_SHUTTING_DOWN: i32 = -32003;
pub const CODE_HOST_CALL_FAILED: i32 = -32004;
pub const CODE_UNAUTHORIZED: i32 = -32005;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: i32,
    pub message: String,
    pub data: Option<Value>,
}

impl RpcError {
    pub fn parse_error(message: impl Into<String>) -> Self {
        Self {
            code: CODE_PARSE_ERROR,
            message: message.into(),
            data: None,
        }
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self {
            code: CODE_INVALID_REQUEST,
            message: message.into(),
            data: None,
        }
    }

    pub fn method_not_found(method: &str) -> Self {
        Self {
            code: CODE_METHOD_NOT_FOUND,
            message: format!("Method not found: {method}"),
            data: None,
        }
    }

    pub fn invalid_params(message: impl Into<String>) -> Self {
        Self {
            code: CODE_INVALID_PARAMS,
            message: message.into(),
            data: None,
        }
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self {
            code: CODE_INTERNAL_ERROR,
            message: message.into(),
            data: None,
        }
    }

    pub fn not_initialized() -> Self {
        Self {
            code: CODE_NOT_INITIALIZED,
            message: "Core session has not been initialized; call core.initialize first".into(),
            data: None,
        }
    }

    pub fn already_initialized() -> Self {
        Self {
            code: CODE_ALREADY_INITIALIZED,
            message: "Core session is already initialized".into(),
            data: None,
        }
    }

    pub fn shutting_down() -> Self {
        Self {
            code: CODE_SHUTTING_DOWN,
            message: "Core server is shutting down".into(),
            data: None,
        }
    }

    pub fn host_call_failed(message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code: CODE_HOST_CALL_FAILED,
            message: message.into(),
            data,
        }
    }

    pub fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            code: CODE_UNAUTHORIZED,
            message: message.into(),
            data: None,
        }
    }

    pub fn to_error_object(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("code".into(), json!(self.code));
        obj.insert("message".into(), json!(self.message));
        if let Some(data) = &self.data {
            obj.insert("data".into(), data.clone());
        }
        Value::Object(obj)
    }

    pub fn to_response(&self, id: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "error": self.to_error_object(),
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ClientInfo {
    pub name: String,
    pub version: String,
}

impl ClientInfo {
    pub fn validate(&self) -> Result<(), RpcError> {
        let name = self.name.trim();
        let version = self.version.trim();
        if name.is_empty() || name.len() > 128 {
            return Err(RpcError::invalid_params(
                "client.name must be 1..=128 chars",
            ));
        }
        if version.is_empty() || version.len() > 128 {
            return Err(RpcError::invalid_params(
                "client.version must be 1..=128 chars",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ExternalCapabilityManifest {
    pub alias: String,
    pub capability_id: String,
    pub manifest: Value,
}

impl ExternalCapabilityManifest {
    pub fn validate(&self) -> Result<(), RpcError> {
        validate_identifier(&self.alias, "externalCapabilities[].alias")?;
        validate_identifier(&self.capability_id, "externalCapabilities[].capabilityId")?;
        if !self.manifest.is_object() {
            return Err(RpcError::invalid_params(
                "externalCapabilities[].manifest must be a JSON object",
            ));
        }
        Ok(())
    }
}

fn validate_identifier(value: &str, label: &str) -> Result<(), RpcError> {
    if value.is_empty() || value.len() > 128 {
        return Err(RpcError::invalid_params(format!(
            "{label} must be 1..=128 characters"
        )));
    }
    if value
        .bytes()
        .any(|b| b.is_ascii_whitespace() || b.is_ascii_control())
    {
        return Err(RpcError::invalid_params(format!(
            "{label} must not contain whitespace or control characters"
        )));
    }
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InitializeParams {
    pub protocol_version: u32,
    pub client: ClientInfo,
    #[serde(default)]
    pub external_capabilities: Vec<ExternalCapabilityManifest>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub auth_token: Option<String>,
}

impl InitializeParams {
    pub fn validate(&self) -> Result<(), RpcError> {
        if self.protocol_version != PROTOCOL_VERSION {
            return Err(RpcError::invalid_params(format!(
                "Unsupported protocolVersion {}; expected {}",
                self.protocol_version, PROTOCOL_VERSION
            )));
        }
        self.client.validate()?;
        if self.external_capabilities.len() > MAX_EXTERNAL_CAPABILITIES {
            return Err(RpcError::invalid_params(format!(
                "externalCapabilities exceeds limit ({MAX_EXTERNAL_CAPABILITIES})"
            )));
        }
        let mut seen = HashSet::with_capacity(self.external_capabilities.len());
        for entry in &self.external_capabilities {
            entry.validate()?;
            if !seen.insert(entry.alias.as_str()) {
                return Err(RpcError::invalid_params(format!(
                    "Duplicate external capability alias: {}",
                    entry.alias
                )));
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct CoreCapabilitiesSummary {
    pub domains: Vec<String>,
    pub planned_domains: Vec<String>,
    pub bidirectional_host_calls: bool,
    pub registered_external_capabilities: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InitializeResult {
    pub protocol_version: u32,
    pub server: ServerInfo,
    pub pid: u32,
    pub capabilities: CoreCapabilitiesSummary,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PingParams {
    #[serde(default)]
    pub probe_host: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct PingResult {
    pub ok: bool,
    pub server_version: String,
    pub uptime_ms: u64,
    pub pid: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host_probe: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CapabilitiesListResult {
    pub domains: Vec<String>,
    pub external_capabilities: Vec<ExternalCapabilityManifest>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatusResult {
    pub ok: bool,
    pub daemon: bool,
    pub pid: u32,
    pub server_version: String,
    pub uptime_ms: u64,
    pub connected_clients: usize,
    pub initialized_clients: usize,
    pub transport: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    pub project_bot_host_enabled: bool,
    pub owned_workspaces: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShutdownResult {
    pub ok: bool,
    pub draining: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub disconnected: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub daemon_shutdown: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub remaining_clients: Option<usize>,
}
