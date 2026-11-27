//! Project Agent Bot read/projection RPC handlers:
//! - `project.bot.list`
//! - `project.bot.listAttention`
//! - `project.bot.get`
//! - `project.bot.listObligationGrants`
//! - `project.bot.readConversation`
//! - `project.bot.listSessions`
//! - `project.bot.getSession`

use crate::{protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BotDirectory, ListSessionsQuery, ReadConversationOptions, SessionSupervisor,
    get_session_projected, list_persisted_obligation_grants_enriched, list_sessions_paged,
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
    let sessions = SessionSupervisor::new(data_home, None).list_bot_sessions(workspace_id);
    let sessions_by_ws = std::collections::HashMap::from([(workspace_id.to_owned(), sessions)]);
    match BotDirectory::new(data_home).get_bot(workspace_id, &sessions_by_ws) {
        Ok(detail) => {
            let path_exists =
                !detail.path.is_empty() && std::path::Path::new(&detail.path).is_dir();
            Ok(json!({
                "ok": true,
                "item": detail.item,
                "path": detail.path,
                "pathExists": path_exists,
                "profile": detail.profile,
            }))
        }
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

pub fn handle_bot_read_conversation(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let process_for = match params.get("processFor").filter(|v| !v.is_null()) {
        None => None,
        Some(v) => {
            let Some(s) = v.as_str() else {
                return Ok(json!({ "ok": false, "code": "INVALID_INPUT" }));
            };
            Some(s.to_owned())
        }
    };
    let opts = ReadConversationOptions {
        limit: params
            .get("limit")
            .and_then(Value::as_u64)
            .and_then(|n| usize::try_from(n).ok()),
        before: params
            .get("before")
            .and_then(Value::as_str)
            .map(str::to_owned),
        kinds: params.get("kinds").and_then(Value::as_array).map(|arr| {
            arr.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        }),
        latest: params.get("latest").and_then(Value::as_bool) == Some(true),
        presentation_only: params.get("presentationOnly").and_then(Value::as_bool) == Some(true),
        process_for,
        view: params
            .get("view")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    Ok(BotDirectory::new(&ctx.config.data_home).read_conversation(workspace_id, &opts))
}

pub fn handle_bot_list_sessions(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let work_id = params
        .get("workId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let session_ids: Option<Vec<String>> =
        params
            .get("sessionIds")
            .and_then(Value::as_array)
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            });
    let status = params
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let scope = params
        .get("scope")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let category = params
        .get("category")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let search_query = params
        .get("query")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let cursor = params
        .get("cursor")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty());
    let limit = params
        .get("limit")
        .and_then(Value::as_u64)
        .and_then(|n| usize::try_from(n).ok());

    let paged = list_sessions_paged(
        &ctx.config.data_home,
        &ListSessionsQuery {
            workspace_id,
            work_id,
            session_ids: session_ids.as_deref(),
            status,
            scope,
            category,
            search_query,
            cursor,
            limit,
        },
    );
    Ok(json!({
        "ok": true,
        "sessions": paged.sessions,
        "totalCount": paged.total_count,
        "nextCursor": paged.next_cursor,
    }))
}

pub fn handle_bot_get_session(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let detail = params.get("detail").and_then(Value::as_str);
    match get_session_projected(&ctx.config.data_home, session_id, detail) {
        Some(session) => Ok(json!({ "ok": true, "session": session })),
        None => Ok(json!({ "ok": false, "code": "NOT_FOUND" })),
    }
}
