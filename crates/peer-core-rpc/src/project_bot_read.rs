//! Project Agent Bot read/projection RPC handlers:
//! - `project.bot.list`
//! - `project.bot.listAttention`
//! - `project.bot.get`
//! - `project.bot.listObligationGrants`

use crate::{protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BotDirectory, SessionSupervisor, list_persisted_obligation_grants_enriched,
};
use serde_json::{Value, json};

pub fn handle_bot_list(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let query = params.get("query").and_then(Value::as_str);
    let needs_you_only = params.get("needsYouOnly").and_then(Value::as_bool) == Some(true);
    let data_home = &ctx.config.data_home;
    let sessions_by_ws = SessionSupervisor::new(data_home, None).list_all_bot_sessions();
    let items = BotDirectory::new(data_home).query_items(&sessions_by_ws, query, needs_you_only);
    Ok(json!({ "ok": true, "items": items }))
}

pub fn handle_bot_list_attention(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = match params.get("workspaceId") {
        None => None,
        Some(v) => {
            let Some(ws) = v.as_str() else {
                return Ok(json!({ "ok": false, "code": "NOT_FOUND" }));
            };
            Some(ws)
        }
    };
    let data_home = &ctx.config.data_home;
    let sessions_by_ws = SessionSupervisor::new(data_home, None).list_all_bot_sessions();
    match BotDirectory::new(data_home).list_attention(workspace_id, &sessions_by_ws) {
        Ok(items) => Ok(json!({ "ok": true, "items": items })),
        Err(err) => Ok(json!({ "ok": false, "code": err.code })),
    }
}

pub fn handle_bot_get(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let data_home = &ctx.config.data_home;
    let sessions_by_ws = SessionSupervisor::new(data_home, None).list_all_bot_sessions();
    match BotDirectory::new(data_home).get_bot(workspace_id, &sessions_by_ws) {
        Ok(detail) => Ok(json!({
            "ok": true,
            "item": detail.item,
            "path": detail.path,
            "profile": detail.profile,
        })),
        Err(err) => Ok(json!({ "ok": false, "code": err.code })),
    }
}

pub fn handle_bot_list_obligation_grants(
    ctx: &ServerContext,
    params: Value,
) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let parent_conversation_id = params.get("parentConversationId").and_then(Value::as_str);
    Ok(list_persisted_obligation_grants_enriched(
        &ctx.config.data_home,
        workspace_id,
        parent_conversation_id,
    ))
}
