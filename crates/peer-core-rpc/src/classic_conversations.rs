//! Classic Conversations RPC domain handlers (`classic.conversations.*`).

use crate::{protocol::RpcError, server::ServerContext};
use peer_store::{
    ConversationListQuery, ConversationSearchQuery, ConversationStore, StoreError,
    ToolArtifactStore, delete_session,
};
use serde::{Deserialize, Deserializer};
use serde_json::{Value, json};
use std::collections::HashSet;

fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::<T>::deserialize(deserializer)?))
}

fn map_store_error(err: StoreError) -> RpcError {
    match err {
        StoreError::InvalidInput
        | StoreError::ExecutionBusy
        | StoreError::StreamStateInvalid
        | StoreError::GoalChanged => RpcError::invalid_params(err.code()),
        StoreError::NotFound => RpcError::invalid_params("conversation_not_found"),
        _ => RpcError::internal_error(err.code()),
    }
}

fn parse_string_or_array(val: Option<&Value>) -> Option<Vec<String>> {
    let v = val.filter(|v| !v.is_null())?;
    if let Some(s) = v.as_str() {
        return Some(vec![s.to_owned()]);
    }
    if let Some(arr) = v.as_array() {
        return Some(
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect(),
        );
    }
    None
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListParams {
    #[serde(default, deserialize_with = "deserialize_double_option")]
    workspace_path: Option<Option<String>>,
    #[serde(default)]
    status: Option<Value>,
    #[serde(default)]
    roles: Option<Vec<String>>,
    #[serde(default)]
    include_message_count: Option<bool>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    cursor: Option<String>,
    #[serde(default)]
    paginated: bool,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchParams {
    #[serde(default)]
    query: String,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    workspace_path: Option<Option<String>>,
    #[serde(default)]
    status: Option<Value>,
    #[serde(default)]
    roles: Option<Vec<String>>,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    include_workspace_name_match: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdParams {
    id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct GetParams {
    id: String,
    #[serde(default)]
    limit: Option<usize>,
    #[serde(default)]
    before: Option<String>,
    #[serde(default)]
    full: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateTitleParams {
    id: String,
    title: String,
    #[serde(default)]
    source: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateModeParams {
    id: String,
    mode: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateFastModeParams {
    id: String,
    #[serde(default)]
    fast_mode: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateIsolationParams {
    id: String,
    preferred_execution_isolation: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateModelEffortParams {
    id: String,
    #[serde(default)]
    effort: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    model_provider_id: Option<Option<String>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    model: Option<Option<String>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppendMessageParams {
    id: String,
    message: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateLastMessageParams {
    id: String,
    content: Value,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReplaceMessagesParams {
    id: String,
    messages: Vec<Value>,
    #[serde(default)]
    allow_empty: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReorderPinnedParams {
    #[serde(default)]
    ids: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AutoArchiveParams {
    #[serde(default)]
    before: String,
    #[serde(default)]
    exclude_ids: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AddUsageParams {
    id: String,
    #[serde(default)]
    usage: Value,
}

pub fn handle_list(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ListParams = if params_val.is_null() {
        ListParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid list params: {err}")))?
    };
    let query = ConversationListQuery {
        workspace_path: params.workspace_path,
        statuses: parse_string_or_array(params.status.as_ref()),
        roles: params.roles,
        include_message_count: params.include_message_count.unwrap_or(true),
        limit: params.limit,
        cursor: params.cursor,
        paginated: params.paginated,
    };
    ConversationStore::new(&ctx.config.data_home)
        .list_conversations_view(&query)
        .map_err(map_store_error)
}

pub fn handle_search(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: SearchParams = if params_val.is_null() {
        SearchParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid search params: {err}")))?
    };
    let statuses = if let Some(ref raw) = params.status {
        if raw.is_null() {
            None
        } else {
            parse_string_or_array(Some(raw))
        }
    } else {
        Some(vec!["active".to_owned()])
    };
    let query = ConversationSearchQuery {
        query: params.query,
        workspace_path: params.workspace_path,
        statuses,
        roles: params.roles,
        limit: params.limit.unwrap_or(50),
        include_workspace_name_match: params.include_workspace_name_match,
    };
    let items = ConversationStore::new(&ctx.config.data_home)
        .search_conversations(&query)
        .map_err(map_store_error)?;
    Ok(Value::Array(items))
}

pub fn handle_create(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let payload = if params_val.is_null() {
        json!({})
    } else if params_val.is_object() {
        params_val
    } else {
        return Err(RpcError::invalid_params(
            "Invalid classic.conversations.create params",
        ));
    };
    ConversationStore::new(&ctx.config.data_home)
        .create_classic_conversation(&payload)
        .map_err(map_store_error)
}

pub fn handle_get(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: GetParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid get params: {err}")))?;
    let page = ConversationStore::new(&ctx.config.data_home)
        .read_conversation_window(
            &params.id,
            params.limit,
            params.before.as_deref(),
            params.full,
        )
        .map_err(map_store_error)?;
    Ok(page.unwrap_or(Value::Null))
}

pub fn handle_update_title(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: UpdateTitleParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid updateTitle params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_title(&params.id, &params.title, params.source.as_deref())
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_update_mode(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: UpdateModeParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid updateMode params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_mode_classic(&params.id, &params.mode)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_update_fast_mode(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: UpdateFastModeParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid updateFastMode params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_fast_mode(&params.id, params.fast_mode)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_update_preferred_execution_isolation(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let params: UpdateIsolationParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!(
            "Invalid updatePreferredExecutionIsolation params: {err}"
        ))
    })?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_preferred_execution_isolation(&params.id, &params.preferred_execution_isolation)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_update_model_effort(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let params: UpdateModelEffortParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid updateModelEffort params: {err}"))
    })?;
    let mp_ref = params.model_provider_id.as_ref().map(|opt| opt.as_deref());
    let model_ref = params.model.as_ref().map(|opt| opt.as_deref());
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_model_effort_classic(&params.id, params.effort.as_deref(), mp_ref, model_ref)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_append_message(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: AppendMessageParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid appendMessage params: {err}")))?;
    let meta = ConversationStore::new(&ctx.config.data_home)
        .append_classic_message(&params.id, &params.message)
        .map_err(map_store_error)?;
    Ok(meta.unwrap_or(Value::Null))
}

pub fn handle_update_last_message(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let params: UpdateLastMessageParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid updateLastMessage params: {err}"))
    })?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .update_last_message(&params.id, &params.content)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_replace_messages(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ReplaceMessagesParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid replaceMessages params: {err}"))
    })?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .replace_messages(&params.id, &params.messages, params.allow_empty)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_archive(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: IdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid archive params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .set_archive_status(&params.id, true)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_restore(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: IdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid restore params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .set_archive_status(&params.id, false)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_pin(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: IdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid pin params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .pin_conversation(&params.id)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_unpin(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: IdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid unpin params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .unpin_conversation(&params.id)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}

pub fn handle_reorder_pinned(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ReorderPinnedParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid reorderPinned params: {err}")))?;
    ConversationStore::new(&ctx.config.data_home)
        .reorder_pinned(&params.ids)
        .map_err(map_store_error)
}

pub fn handle_auto_archive(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: AutoArchiveParams = if params_val.is_null() {
        AutoArchiveParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid autoArchive params: {err}")))?
    };
    let mut excluded: HashSet<String> = params.exclude_ids.into_iter().collect();
    let active = ctx.streams.list_active();
    if let Some(ids) = active["conversationIds"].as_array() {
        for v in ids {
            if let Some(s) = v.as_str() {
                excluded.insert(s.to_owned());
            }
        }
    }
    let exclude_list: Vec<String> = excluded.into_iter().collect();
    ConversationStore::new(&ctx.config.data_home)
        .auto_archive(&params.before, &exclude_list)
        .map_err(map_store_error)
}

pub fn handle_delete(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: IdParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid delete params: {err}")))?;
    if params.id.trim().is_empty() {
        return Err(RpcError::invalid_params("id must not be empty"));
    }
    let active = ctx.streams.list_active();
    if active["conversationIds"]
        .as_array()
        .is_some_and(|arr| arr.iter().any(|v| v == params.id.as_str()))
    {
        return Err(RpcError::invalid_params("conversation_execution_busy"));
    }

    match delete_session(&ctx.config.data_home, &params.id) {
        Ok(()) | Err(StoreError::NotFound) => {}
        Err(err) => return Err(map_store_error(err)),
    }
    let _ = ToolArtifactStore::new(&ctx.config.data_home).remove_conversation(&params.id);

    let remaining = ConversationStore::new(&ctx.config.data_home)
        .list_all_metas_with_counts()
        .map_err(map_store_error)?;
    Ok(Value::Array(remaining))
}

pub fn handle_add_usage(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: AddUsageParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid addUsage params: {err}")))?;
    let updated = ConversationStore::new(&ctx.config.data_home)
        .add_usage_classic(&params.id, &params.usage)
        .map_err(map_store_error)?;
    Ok(updated.unwrap_or(Value::Null))
}
