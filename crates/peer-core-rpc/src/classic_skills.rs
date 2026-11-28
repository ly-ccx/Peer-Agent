//! Classic Skills RPC domain handlers (`classic.skills.*`).

use crate::{protocol::RpcError, server::ServerContext};
use peer_store::{StoreError, skill_manage};
use serde::{Deserialize, Deserializer};
use serde_json::Value;
use std::path::{Path, PathBuf};

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

fn map_store_error(err: StoreError) -> RpcError {
    match err {
        StoreError::InvalidInput | StoreError::OutOfScope => RpcError::invalid_params(err.code()),
        _ => RpcError::internal_error(err.code()),
    }
}

fn workspace_path_ref(opt: &Option<Option<String>>) -> Option<Option<&Path>> {
    opt.as_ref().map(|inner| inner.as_deref().map(Path::new))
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListSkillsParams {
    #[serde(default)]
    active_workspace: Option<String>,
    #[serde(default)]
    workspace_paths: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillTargetParams {
    skill_id: String,
    #[serde(default)]
    active_workspace: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    workspace_path: Option<Option<String>>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceRootsParams {
    #[serde(default)]
    source_roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LinkSkillParams {
    skill_id: String,
    #[serde(default)]
    source_roots: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SkillIdOnlyParams {
    skill_id: String,
}

pub fn handle_list(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ListSkillsParams = if params_val.is_null() {
        ListSkillsParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid skills.list params: {err}")))?
    };
    let ws_paths: Option<Vec<PathBuf>> = params
        .workspace_paths
        .map(|items| items.into_iter().map(PathBuf::from).collect());
    skill_manage::list_skills(
        &ctx.config.data_home,
        params.active_workspace.as_deref().map(Path::new),
        ws_paths.as_deref(),
    )
    .map_err(map_store_error)
}

pub fn handle_get_detail(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SkillTargetParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid skills.getDetail params: {err}"))
    })?;
    let detail = skill_manage::get_skill_detail(
        &ctx.config.data_home,
        &params.skill_id,
        params.active_workspace.as_deref().map(Path::new),
        workspace_path_ref(&params.workspace_path),
    )
    .map_err(map_store_error)?;
    Ok(detail.unwrap_or(Value::Null))
}

pub fn handle_set_enabled(
    ctx: &ServerContext,
    params_val: Value,
    enabled: bool,
) -> Result<Value, RpcError> {
    let params: SkillTargetParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid skills enable/disable params: {err}"))
    })?;
    skill_manage::set_skill_enabled(
        &ctx.config.data_home,
        &params.skill_id,
        enabled,
        params.active_workspace.as_deref().map(Path::new),
        workspace_path_ref(&params.workspace_path),
    )
    .map_err(map_store_error)
}

pub fn handle_list_available(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SourceRootsParams = if params_val.is_null() {
        SourceRootsParams::default()
    } else {
        serde_json::from_value(params_val).map_err(|err| {
            RpcError::invalid_params(format!("Invalid skills.listAvailable params: {err}"))
        })?
    };
    let roots: Vec<PathBuf> = params.source_roots.into_iter().map(PathBuf::from).collect();
    skill_manage::list_available_skills(&ctx.config.data_home, &roots).map_err(map_store_error)
}

pub fn handle_link(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: LinkSkillParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid skills.link params: {err}")))?;
    let roots: Vec<PathBuf> = params.source_roots.into_iter().map(PathBuf::from).collect();
    skill_manage::link_skill(&ctx.config.data_home, &params.skill_id, &roots)
        .map_err(map_store_error)
}

pub fn handle_unlink(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SkillIdOnlyParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid skills.unlink params: {err}")))?;
    skill_manage::unlink_skill(&ctx.config.data_home, &params.skill_id).map_err(map_store_error)
}

pub fn handle_uninstall(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SkillTargetParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid skills.uninstall params: {err}"))
    })?;
    skill_manage::uninstall_skill(
        &ctx.config.data_home,
        &params.skill_id,
        params.active_workspace.as_deref().map(Path::new),
        workspace_path_ref(&params.workspace_path),
    )
    .map_err(map_store_error)
}
