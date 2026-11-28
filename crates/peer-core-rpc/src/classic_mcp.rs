//! Classic MCP Registry & redacted credential metadata RPC handlers (`classic.mcp.*`).

use crate::{protocol::RpcError, server::ServerContext};
use peer_store::{McpCredentialStore, McpRegistryStore, StoreError};
use serde::Deserialize;
use serde_json::{Value, json};

fn map_store_error(err: StoreError) -> RpcError {
    match err {
        StoreError::InvalidInput | StoreError::McpCredentialInvalid => {
            RpcError::invalid_params(err.code())
        }
        StoreError::NotFound => RpcError::invalid_params("mcp_server_not_found"),
        _ => RpcError::internal_error(err.code()),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerIdParams {
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    mcp_id: Option<String>,
}

impl ServerIdParams {
    fn resolve_id(&self) -> Result<&str, RpcError> {
        self.server_id
            .as_deref()
            .or(self.mcp_id.as_deref())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| RpcError::invalid_params("serverId or mcpId is required"))
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetEnabledParams {
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    mcp_id: Option<String>,
    #[serde(default)]
    enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetToolVisibilityParams {
    #[serde(default)]
    server_id: Option<String>,
    #[serde(default)]
    mcp_id: Option<String>,
    tool_name: String,
    #[serde(default)]
    visible: bool,
}

pub fn handle_list_installed(ctx: &ServerContext) -> Result<Value, RpcError> {
    McpRegistryStore::new(&ctx.config.data_home)
        .list_installed()
        .map_err(map_store_error)
}

pub fn handle_list_capabilities(ctx: &ServerContext) -> Result<Value, RpcError> {
    McpRegistryStore::new(&ctx.config.data_home)
        .list_capability_manifests()
        .map_err(map_store_error)
}

pub fn handle_list_credentials(ctx: &ServerContext) -> Result<Value, RpcError> {
    let items = McpCredentialStore::new(&ctx.config.data_home)
        .list_metadata()
        .map_err(map_store_error)?;
    Ok(Value::Array(items))
}

pub fn handle_upsert_server(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    if !params_val.is_object() {
        return Err(RpcError::invalid_params(
            "MCP server config must be an object",
        ));
    }
    McpRegistryStore::new(&ctx.config.data_home)
        .upsert_server(&params_val)
        .map_err(map_store_error)
}

pub fn handle_uninstall(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ServerIdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid mcp.uninstall params: {err}")))?;
    let id = params.resolve_id()?;
    let (servers, bound_credential_ref) = McpRegistryStore::new(&ctx.config.data_home)
        .uninstall(id)
        .map_err(map_store_error)?;
    Ok(json!({
        "servers": servers,
        "boundCredentialRef": bound_credential_ref,
    }))
}

pub fn handle_set_enabled(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SetEnabledParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid mcp.setEnabled params: {err}")))?;
    let id = params
        .server_id
        .as_deref()
        .or(params.mcp_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RpcError::invalid_params("serverId or mcpId is required"))?;
    McpRegistryStore::new(&ctx.config.data_home)
        .set_enabled(id, params.enabled)
        .map_err(map_store_error)
}

pub fn handle_set_tool_visibility(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let params: SetToolVisibilityParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid mcp.setToolVisibility params: {err}"))
    })?;
    let id = params
        .server_id
        .as_deref()
        .or(params.mcp_id.as_deref())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| RpcError::invalid_params("serverId or mcpId is required"))?;
    McpRegistryStore::new(&ctx.config.data_home)
        .set_tool_visibility(id, &params.tool_name, params.visible)
        .map_err(map_store_error)
}
