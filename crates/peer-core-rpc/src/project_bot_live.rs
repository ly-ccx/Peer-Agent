//! Live Project Agent Bot RPC handlers (`project.bot.*` mutations, session control,
//! live approvals, obligations, familiarization, recovery, and host lease orchestration).

use crate::{protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BotProfile, FamiliarizeKind, LeaseStatus, SubmitInputRequest, execute_recovery_restore,
    execute_recovery_retain, get_session_projected, inspect_recovery, is_valid_workspace_id,
    now_iso, occupied_recovery_view, parse_iso_ms,
};
use peer_runtime::session_host::LocalPermissionDecision;
use peer_store::{ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, PolicyStore};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

fn ok_fail(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

fn session_id_from_answer(answer_to: &str) -> &str {
    let Some(rest) = answer_to.strip_prefix("card:question:") else {
        return "";
    };
    let Some((seg, _)) = rest.split_once(':') else {
        return "";
    };
    if matches!(seg, "" | "reply" | "objective") {
        ""
    } else {
        seg
    }
}

fn is_plan_approval(record: &Value) -> bool {
    record["kind"].as_str() == Some("plan_approval")
        || record["capabilityId"].as_str() == Some("goal.plan")
        || record["approvalId"]
            .as_str()
            .is_some_and(|id| id.starts_with("plan:"))
}

fn resolve_worker_selection(ctx: &ServerContext, workspace_id: &str) -> Value {
    ctx.project_host
        .host()
        .resolve_bot_model_selection(workspace_id, "session_worker", None, None, None, false)
        .map(|s| s.selection)
        .unwrap_or_else(|_| json!({}))
}

fn ensure_lease_for_mutation(ctx: &ServerContext, workspace_id: &str) -> Result<(), Value> {
    if !ctx.project_host.is_enabled() {
        return Err(ok_fail("HOST_OFFLINE"));
    }
    let host = ctx.project_host.host();
    if host.holds_lease(workspace_id) {
        return Ok(());
    }
    match host.ensure_lease(workspace_id) {
        Ok(LeaseStatus::Acquired { .. }) => {
            ctx.project_host.set_recovery_ready(workspace_id);
            Ok(())
        }
        Ok(LeaseStatus::HeldByOther(_)) => Err(ok_fail("LEASE_HELD_BY_OTHER")),
        Err(err) => Err(ok_fail(err.code)),
    }
}

fn promote_and_spawn_workers(ctx: &ServerContext, workspace_id: &str) {
    let host = ctx.project_host.host();
    if ctx.project_host.is_enabled()
        && host.holds_lease(workspace_id)
        && let Ok(promoted) = host.supervisor().promote_queued(workspace_id, true)
    {
        for psid in promoted.start {
            ctx.project_host.spawn_worker_session(workspace_id, &psid);
        }
    }
}

fn check_policy_stamp_for_approval(data_home: &Path, record: &Value) -> Result<(), ()> {
    let Some(stored_rev) = record.get("policyRevision").and_then(Value::as_str) else {
        return Ok(());
    };
    if !stored_rev.starts_with("bot:") && stored_rev != "legacy" {
        return Ok(());
    }
    let Some(ws_id) = record.get("workspaceId").and_then(Value::as_str) else {
        return Ok(());
    };
    let Ok(policy) = PolicyStore::new(data_home).read_existing(ws_id) else {
        return Err(());
    };
    let expected = format!(
        "bot:{}:{}:{}",
        policy.workspace_id, policy.conversation_id, policy.revision
    );
    if stored_rev == expected {
        Ok(())
    } else {
        Err(())
    }
}

fn approval_terminal_state(state: &str) -> bool {
    matches!(state, "approved" | "denied" | "expired" | "cancelled")
}

fn find_approval(data_home: &Path, workspace_id: &str, approval_id: &str) -> Option<Value> {
    ApprovalStore::new(data_home)
        .list(Some(workspace_id), None)
        .ok()?
        .into_iter()
        .find(|row| row["approvalId"].as_str() == Some(approval_id))
}

fn string_vec(val: Option<&Value>) -> Vec<String> {
    val.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect()
}

fn build_recovery_session_inventory(ctx: &ServerContext, workspace_id: &str) -> Vec<Value> {
    let host = ctx.project_host.host();
    host.supervisor()
        .list_workspace_plans(workspace_id)
        .into_iter()
        .filter_map(|plan| {
            let sid = plan["delegationOrigin"]["sessionId"].as_str()?.to_owned();
            let title = plan["title"].as_str().unwrap_or("").to_owned();
            let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
            let plan_status = plan["status"].as_str().unwrap_or("");
            let has_worktree = plan["deliveryBinding"]["worktreePath"]
                .as_str()
                .is_some_and(|s| !s.is_empty());
            let accepted = plan["resultAcceptance"]["acceptedAt"]
                .as_str()
                .is_some_and(|s| !s.is_empty());
            let is_terminal = matches!(plan_status, "completed" | "failed" | "cancelled")
                || matches!(phase, "cancelled" | "completed" | "failed" | "superseded");
            let terminal = is_terminal && !has_worktree && (plan_status != "completed" || accepted);
            let safe = matches!(plan_status, "completed" | "cancelled") && terminal;
            Some(json!({
                "sessionId": sid,
                "title": title,
                "terminal": terminal,
                "safe": safe,
            }))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// 1. project.bot.hostConfigure
// ---------------------------------------------------------------------------

pub async fn handle_host_configure(
    ctx: &crate::server::ServerContext,
    params: Value,
) -> Result<Value, RpcError> {
    ctx.project_host
        .configure(params)
        .await
        .map_err(RpcError::invalid_params)
}

// ---------------------------------------------------------------------------
// 2. project.bot.hostStatus
// ---------------------------------------------------------------------------

pub fn handle_host_status(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let ws = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    Ok(ctx.project_host.status(ws))
}

// ---------------------------------------------------------------------------
// 3. project.bot.create
// ---------------------------------------------------------------------------

pub async fn handle_create(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let host = ctx.project_host.host();
    let managed = params.get("managed").and_then(Value::as_bool) == Some(true);
    let display_name = params
        .get("displayName")
        .or_else(|| params.get("name"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let workspace_id = if let Some(ws) = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        if !is_valid_workspace_id(ws) {
            return Ok(ok_fail("INVALID_WORKSPACE"));
        }
        if let Some(ws_path) = params
            .get("workspacePath")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            && host.registry().get(ws).ok().flatten().is_none()
        {
            match host.registry().register(ws_path, None) {
                Ok(entry) => entry.workspace_id,
                Err(err) => return Ok(ok_fail(err.code)),
            }
        } else {
            ws.to_owned()
        }
    } else if let Some(ws_path) = params
        .get("workspacePath")
        .or_else(|| params.get("path"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        match host.registry().register(ws_path, None) {
            Ok(entry) => entry.workspace_id,
            Err(err) => return Ok(ok_fail(err.code)),
        }
    } else {
        return Ok(ok_fail("INVALID_INPUT"));
    };

    let (profile, _created) = match host.ensure_bot(&workspace_id, managed, display_name) {
        Ok(res) => res,
        Err(err) => return Ok(ok_fail(err.code)),
    };

    if ctx.project_host.is_enabled() {
        let _ = host.ensure_lease(&workspace_id);
        ctx.project_host.set_recovery_ready(&workspace_id);
    }

    let start_fam = params
        .get("startFamiliarize")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let familiarize = if start_fam {
        let sel = resolve_worker_selection(ctx, &workspace_id);
        match host.start_familiarize(&workspace_id, sel) {
            Ok(fam) => {
                if let FamiliarizeKind::Research {
                    session_id: Some(_),
                } = fam.kind
                {
                    promote_and_spawn_workers(ctx, &workspace_id);
                }
                match &fam.kind {
                    FamiliarizeKind::Blank => Some(json!({
                        "ok": true,
                        "kind": "blank",
                        "reused": fam.reused,
                    })),
                    FamiliarizeKind::Research { session_id } => Some(json!({
                        "ok": true,
                        "kind": "research",
                        "reused": fam.reused,
                        "sessionId": session_id,
                    })),
                }
            }
            Err(err) => Some(ok_fail(err.code)),
        }
    } else {
        None
    };

    ctx.project_host.emit_changed(vec![workspace_id.clone()]);
    if ctx.project_host.is_enabled() {
        ctx.project_host.wake_workspace(&workspace_id);
    }

    Ok(json!({
        "ok": true,
        "workspaceId": workspace_id,
        "profile": profile,
        "familiarize": familiarize,
    }))
}

// ---------------------------------------------------------------------------
// 4. project.bot.delete
// ---------------------------------------------------------------------------

pub async fn handle_delete(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let phase = params
        .get("phase")
        .and_then(Value::as_str)
        .unwrap_or("prepare");
    let host = ctx.project_host.host();

    if phase == "finalize" {
        let folder_removed = params
            .get("folderRemoved")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let cleanup_error = params.get("cleanupError").and_then(Value::as_str);
        match host.delete_bot_finalize_cleanup(workspace_id, folder_removed, cleanup_error) {
            Ok(res) => {
                ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
                return Ok(res);
            }
            Err(err) => return Ok(ok_fail(err.code)),
        }
    }

    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    }
    let Some(profile) = host.profiles().read(workspace_id) else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if profile.status == "archived" && profile.deletion_cleanup.is_none() {
        return Ok(json!({ "ok": true, "profile": profile, "reused": true }));
    }
    let confirm_managed = params.get("confirmManaged").and_then(Value::as_bool) == Some(true);
    if profile.managed && !confirm_managed {
        return Ok(ok_fail("CONFIRM_REQUIRED"));
    }

    // Quiesce running work, archive profile first so heartbeat cannot re-acquire lease,
    // then cancel non-terminal sessions and release lease.
    ctx.project_host.quiesce_workspace(workspace_id).await;
    let prep = match host.delete_bot_prepare(workspace_id, confirm_managed) {
        Ok(res) => res,
        Err(err) => return Ok(ok_fail(err.code)),
    };
    if host.holds_lease(workspace_id) {
        let _ = host
            .supervisor()
            .cancel_workspace_sessions(workspace_id, "bot_deleted", true);
        let _ = host.release_lease(workspace_id);
    }
    if prep["archived"] == true || prep["ok"] == true {
        ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    }
    Ok(prep)
}

// ---------------------------------------------------------------------------
// 4b. project.bot.rebindFolder
// ---------------------------------------------------------------------------

pub async fn handle_rebind_folder(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    }

    let host = ctx.project_host.host();
    let Some(mut profile) = host.profiles().read(workspace_id) else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if !profile.is_active() {
        return Ok(ok_fail("ARCHIVED"));
    }

    let raw_path = params
        .get("workspacePath")
        .or_else(|| params.get("path"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let mut norm = raw_path;
    while norm.len() > 1 && (norm.ends_with('/') || norm.ends_with('\\')) {
        norm = &norm[..norm.len() - 1];
    }
    if norm.is_empty() {
        return Ok(ok_fail("INVALID_PATH"));
    }
    if !Path::new(norm).is_dir() {
        return Ok(ok_fail("FOLDER_NOT_FOUND"));
    }

    let existing = match host.registry().get(workspace_id) {
        Ok(Some(entry)) => entry,
        Ok(None) => return Ok(ok_fail("NOT_FOUND")),
        Err(err) => return Ok(ok_fail(err.code)),
    };

    let real = std::fs::canonicalize(norm)
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|_| norm.to_owned());

    match host.registry().find_by_path(norm) {
        Ok(Some(other)) if other.workspace_id != workspace_id => {
            return Ok(ok_fail("PATH_TAKEN"));
        }
        Ok(_) => {}
        Err(err) => return Ok(ok_fail(err.code)),
    }

    if existing.path == norm && existing.real_path == real {
        return Ok(json!({
            "ok": true,
            "workspaceId": workspace_id,
            "path": existing.path,
            "previousPath": existing.path,
            "pathExists": true,
            "unchanged": true,
            "profile": profile,
        }));
    }

    ctx.project_host.quiesce_workspace(workspace_id).await;

    let updated_entry = match host.registry().update_path(workspace_id, norm) {
        Ok(Some(entry)) => entry,
        Ok(None) => return Ok(ok_fail("NOT_FOUND")),
        Err(err) => return Ok(ok_fail(err.code)),
    };

    if profile.managed {
        profile.managed = false;
        profile = match host.profiles().save(profile) {
            Ok(saved) => saved,
            Err(err) => return Ok(ok_fail(err.code)),
        };
    }

    if let Some(conv_id) = profile.agent_conversation_id.as_deref() {
        let _ = ConversationStore::new(&ctx.config.data_home)
            .update_workspace_path(conv_id, &updated_entry.path);
    }

    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);

    Ok(json!({
        "ok": true,
        "workspaceId": workspace_id,
        "path": updated_entry.path,
        "previousPath": existing.path,
        "pathExists": true,
        "unchanged": false,
        "profile": profile,
    }))
}

// ---------------------------------------------------------------------------
// 5. project.bot.submitInput
// ---------------------------------------------------------------------------

pub async fn handle_submit_input(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let host = ctx.project_host.host();
    if host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("NOT_FOUND"));
    }

    let input_id = params
        .get("inputId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let surface = params
        .get("surface")
        .and_then(Value::as_str)
        .unwrap_or("desktop");
    let text = params.get("text").and_then(Value::as_str).unwrap_or("");
    let answer_to = params
        .get("answerTo")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let anchor_refs = string_vec(params.get("anchorRefs"));
    let quote_refs = string_vec(params.get("quoteRefs"));
    let raw_task_refs = string_vec(params.get("taskRefs"));
    let mut task_refs = Vec::new();
    let mut seen_task_refs = std::collections::HashSet::new();
    for sid in raw_task_refs {
        let trimmed = sid.trim();
        if trimmed.is_empty() || !seen_task_refs.insert(trimmed.to_owned()) {
            continue;
        }
        if host
            .supervisor()
            .find_plan_by_session(workspace_id, trimmed)
            .is_some()
        {
            task_refs.push(trimmed.to_owned());
            if task_refs.len() >= 5 {
                break;
            }
        }
    }
    let attachment_refs = string_vec(params.get("attachmentRefs"));
    let attachments = params
        .get("attachments")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let input = match host.submit_user_input_full(&SubmitInputRequest {
        workspace_id,
        input_id: &input_id,
        surface,
        text,
        anchor_refs,
        quote_refs,
        task_refs,
        attachment_refs,
        attachments,
        answer_to: answer_to.clone(),
        history_ref: None,
        history_snapshot_id: None,
        history_confirmed: None,
    }) {
        Ok(i) => i,
        Err(err) => {
            if err.code == "QUESTION_CLOSED" {
                ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
                ctx.project_host
                    .emit_conversation_changed(workspace_id, None);
                return Ok(ok_fail("QUESTION_CLOSED"));
            }
            let code = if matches!(
                err.code,
                "RESOURCE_FEEDBACK_RECIPIENT_CHANGED" | "INVALID_RESOURCE_FEEDBACK"
            ) {
                err.code
            } else {
                "INVALID_INPUT"
            };
            return Ok(json!({
                "ok": false,
                "code": code,
                "message": err.detail,
            }));
        }
    };

    let answer_str = answer_to.as_deref().unwrap_or("");
    let sid = session_id_from_answer(answer_str);
    let handoff = if !answer_str.is_empty() && !sid.is_empty() {
        host.handle_handoff_answer(workspace_id, sid, answer_str, &input.text)
            .ok()
    } else {
        None
    };

    let mut delivery = "queued";
    let handoff_handled = handoff
        .as_ref()
        .is_some_and(|h| h["handled"].as_bool() == Some(true));
    if let Some(err_str) = handoff
        .as_ref()
        .and_then(|h| h["error"].as_str())
        .filter(|s| !s.is_empty())
    {
        ctx.project_host
            .emit_conversation_changed(workspace_id, None);
        ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
        return Ok(json!({
            "ok": false,
            "code": "HANDOFF_FAILED",
            "input": input,
            "message": format!("未能清理任务工作区，改动仍已保留，请重试 ({err_str})。"),
        }));
    }

    if ctx.project_host.is_enabled() && host.holds_lease(workspace_id) {
        if handoff_handled && handoff.as_ref().is_some_and(|h| h["repairing"] == true) {
            ctx.project_host.spawn_worker_session(workspace_id, sid);
        }
        ctx.project_host.wake_workspace(workspace_id);
    } else if !handoff_handled && !answer_str.is_empty() && !sid.is_empty() {
        match host.deliver_offline_answer(workspace_id, sid, &input.text) {
            Ok(res) if res["error"] == "workspace_mismatch" => {
                return Ok(json!({
                    "ok": false,
                    "code": "NOT_FOUND",
                    "input": input,
                }));
            }
            Ok(res) if res["userIntervened"] == true => {
                delivery = "user_intervened";
            }
            _ => {}
        }
    }

    ctx.project_host
        .emit_conversation_changed(workspace_id, None);
    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    Ok(json!({
        "ok": true,
        "input": input,
        "delivery": delivery,
    }))
}

// ---------------------------------------------------------------------------
// 6. project.bot.stopResponse
// ---------------------------------------------------------------------------

pub fn handle_stop_response(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if workspace_id.is_empty() || turn_id.is_empty() || turn_id.len() > 200 {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    if ctx
        .project_host
        .host()
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("NOT_FOUND"));
    }
    let res = ctx.project_host.stop_turn(workspace_id, turn_id);
    if res["ok"] == true {
        ctx.project_host
            .emit_conversation_changed(workspace_id, None);
        ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    }
    Ok(res)
}

// ---------------------------------------------------------------------------
// 7. project.bot.cancelSession
// ---------------------------------------------------------------------------

pub fn handle_cancel_session(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if session_id.is_empty() {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let reason = params
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("user_cancel");
    let host = ctx.project_host.host();
    let workspace_id = if let Some(ws) = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        ws.to_owned()
    } else if let Some(proj) = get_session_projected(&ctx.config.data_home, session_id, None)
        && let Some(ws) = proj["workspaceId"].as_str()
    {
        ws.to_owned()
    } else {
        return Ok(ok_fail("NOT_FOUND"));
    };

    if let Err(resp) = ensure_lease_for_mutation(ctx, &workspace_id) {
        return Ok(resp);
    }
    ctx.project_host.cancel_live_worker(session_id);
    match host
        .supervisor()
        .control_session(&workspace_id, session_id, "cancel", reason, true)
    {
        Ok(_) => {
            ctx.project_host.emit_changed(vec![workspace_id.clone()]);
            if ctx.project_host.is_enabled() {
                ctx.project_host.wake_workspace(&workspace_id);
            }
            let session = get_session_projected(&ctx.config.data_home, session_id, None)
                .unwrap_or_else(|| json!({ "sessionId": session_id, "workspaceId": workspace_id, "status": "cancelled" }));
            Ok(json!({ "ok": true, "session": session }))
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 8. project.bot.resumeSession
// ---------------------------------------------------------------------------

pub async fn handle_resume_session(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let request_id = params
        .get("requestId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let host = ctx.project_host.host();
    let lock =
        is_valid_workspace_id(workspace_id).then(|| ctx.project_host.workspace_lock(workspace_id));
    let _ws_guard = match lock {
        Some(ref m) => Some(m.lock().await),
        None => None,
    };
    let resumed = host.resume_session_with_anchor(workspace_id, session_id, request_id);
    drop(_ws_guard);
    match resumed {
        Ok(session) => {
            promote_and_spawn_workers(ctx, workspace_id);
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            Ok(json!({ "ok": true, "session": session }))
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 8b. project.bot.verifySession (ADR 134 — UI-triggered bounded re-verify)
// ---------------------------------------------------------------------------

pub async fn handle_verify_session(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    let focus = params
        .get("focus")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    if !is_valid_workspace_id(workspace_id)
        || session_id.is_empty()
        || focus.is_some_and(|s| s.chars().count() > 500)
    {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    match ctx
        .project_host
        .verify_session_now(workspace_id, session_id, focus)
        .await
    {
        Ok(result) => Ok(json!({
            "ok": true,
            "sessionId": session_id,
            "result": result,
        })),
        Err(err) => Ok(json!({
            "ok": false,
            "code": err.code,
            "message": err.detail,
        })),
    }
}

// ---------------------------------------------------------------------------
// 9. project.bot.decideObligation
// ---------------------------------------------------------------------------

pub async fn handle_decide_obligation(
    ctx: &ServerContext,
    params: Value,
) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let grant_id = params.get("grantId").and_then(Value::as_str).unwrap_or("");
    if !is_valid_workspace_id(workspace_id) || grant_id.trim().is_empty() {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let host = ctx.project_host.host();
    let Some(profile) = host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
    else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    let Some(parent_conv_id) = profile.agent_conversation_id else {
        return Ok(ok_fail("CONVERSATION_REQUIRED"));
    };
    if let Err(resp) = ensure_lease_for_mutation(ctx, workspace_id) {
        return Ok(resp);
    }
    if let Err(err) = host.coordination().ensure_snapshot(workspace_id) {
        return Ok(ok_fail(err.code));
    }

    let decision = params
        .get("decision")
        .and_then(Value::as_str)
        .unwrap_or("confirm");
    let svc = host.obligation_service();
    let result = if decision == "revoke" {
        match svc.revoke_grant(workspace_id, grant_id) {
            Ok(res) => res,
            Err(err) => return Ok(ok_fail(err.code)),
        }
    } else {
        let confirmed = match svc.confirm_grant(workspace_id, Some(&parent_conv_id), grant_id) {
            Ok(c) => c,
            Err(err) => return Ok(ok_fail(err.code)),
        };
        let items = confirmed["grant"]["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if items.is_empty() {
            confirmed
        } else {
            let resolve_items: Vec<Value> = items
                .iter()
                .map(|item| {
                    json!({
                        "sessionId": item["sessionId"],
                        "operationId": item["operationId"],
                        "actions": item["actions"],
                    })
                })
                .collect();
            let idem_key = format!("panel-{grant_id}");
            match svc
                .resolve(
                    workspace_id,
                    &parent_conv_id,
                    grant_id,
                    &idem_key,
                    &resolve_items,
                    "",
                )
                .await
            {
                Ok(resolved) => resolved,
                Err(err) => return Ok(ok_fail(err.code)),
            }
        }
    };

    ctx.project_host.emit_obligation_grants(json!({
        "workspaceId": workspace_id,
        "grantId": grant_id,
        "decision": decision,
    }));
    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    if ctx.project_host.is_enabled() {
        ctx.project_host.wake_workspace(workspace_id);
    }
    Ok(result)
}

// ---------------------------------------------------------------------------
// 10. project.bot.requestClaimClosure
// ---------------------------------------------------------------------------

pub async fn handle_request_claim_closure(
    ctx: &ServerContext,
    params: Value,
) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) || session_id.trim().is_empty() {
        return Ok(ok_fail("invalid_input"));
    }
    let host = ctx.project_host.host();
    if host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("claim_not_found"));
    }
    if ensure_lease_for_mutation(ctx, workspace_id).is_err() {
        return Ok(ok_fail("obligation_unavailable"));
    }
    if host.coordination().ensure_snapshot(workspace_id).is_err() {
        return Ok(ok_fail("obligation_unavailable"));
    }

    let svc = host.obligation_service();
    let inspected = match svc
        .inspect_async(workspace_id, None, &[session_id.to_owned()], &[])
        .await
    {
        Ok(v) => v,
        Err(err) => return Ok(ok_fail(err.code)),
    };
    let Some(item) = inspected["items"]
        .as_array()
        .and_then(|arr| {
            arr.iter().find(|row| {
                row["sessionId"].as_str() == Some(session_id) && row.get("error").is_none()
            })
        })
        .cloned()
    else {
        return Ok(ok_fail("claim_not_found"));
    };

    let allowed: Vec<&str> = item["allowedActions"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .collect();
    if item["closeClaimAvailable"] != true || !allowed.contains(&"close_claim") {
        return Ok(ok_fail("claim_not_closeable"));
    }
    let mut actions = vec![json!("close_claim")];
    if allowed.contains(&"acknowledge_unknown") {
        actions.push(json!("acknowledge_unknown"));
    }
    let parent_conv_id = item["parentConversationId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            host.profiles()
                .read(workspace_id)
                .and_then(|p| p.agent_conversation_id)
        })
        .unwrap_or_default();
    if parent_conv_id.is_empty() {
        return Ok(ok_fail("obligation_unavailable"));
    }

    let requested = match svc
        .request_authorization(
            workspace_id,
            &parent_conv_id,
            &[json!({
                "obligationId": item["obligationId"],
                "sessionId": session_id,
                "operationId": item["operationId"],
                "evidenceRevision": item["evidenceRevision"],
                "actions": actions,
            })],
        )
        .await
    {
        Ok(v) => v,
        Err(err) => return Ok(ok_fail(err.code)),
    };

    ctx.project_host.emit_obligation_grants(json!({
        "workspaceId": workspace_id,
        "grantId": requested["grantId"],
        "sessionId": session_id,
    }));
    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    Ok(requested)
}

// ---------------------------------------------------------------------------
// 11. project.bot.decideApproval
// ---------------------------------------------------------------------------

pub async fn handle_decide_approval(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let approval_id = params
        .get("approvalId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let decision = match params.get("decision").and_then(Value::as_str) {
        Some("approve") => "approved",
        Some("cancel") => "cancelled",
        Some("reject" | "deny") => "denied",
        _ => return Ok(ok_fail("INVALID_INPUT")),
    };
    if !is_valid_workspace_id(workspace_id) || approval_id.trim().is_empty() {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let duration = if decision != "approved" {
        "denied"
    } else if params.get("duration").and_then(Value::as_str) == Some("task") {
        "task"
    } else {
        "once"
    };

    let data_home = &ctx.config.data_home;
    let store = ApprovalStore::new(data_home);
    let mut current = match find_approval(data_home, workspace_id, approval_id) {
        Some(row) => row,
        None => return Ok(ok_fail("NOT_FOUND")),
    };

    // Expire past-deadline open/stale approvals before deciding
    let now_str = now_iso();
    let now_ms = parse_iso_ms(&now_str).unwrap_or(0);
    if matches!(current["state"].as_str(), Some("open" | "stale"))
        && let Some(dl) = current["deadlineAt"].as_str().and_then(parse_iso_ms)
        && dl <= now_ms
    {
        if current["state"].as_str() == Some("open")
            && ctx.project_host.is_live_approval_mirrored(approval_id) == Some(false)
        {
            let _ = ctx
                .project_host
                .settle_live_approval(approval_id, LocalPermissionDecision::Timeout);
            let mut settled = None;
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if let Some(row) = find_approval(data_home, workspace_id, approval_id)
                    && approval_terminal_state(row["state"].as_str().unwrap_or(""))
                {
                    settled = Some(row);
                    break;
                }
            }
            current = settled.unwrap_or_else(|| {
                let latest = find_approval(data_home, workspace_id, approval_id).unwrap_or(current);
                if !approval_terminal_state(latest["state"].as_str().unwrap_or("")) {
                    store
                        .decide(
                            &latest,
                            ApprovalState::Expired,
                            ApprovalDecision::Policy,
                            &now_str,
                            Some("permission_timeout"),
                            None,
                        )
                        .unwrap_or(latest)
                } else {
                    latest
                }
            });
        } else {
            let saved = store
                .decide(
                    &current,
                    ApprovalState::Expired,
                    ApprovalDecision::Policy,
                    &now_str,
                    Some("permission_timeout"),
                    None,
                )
                .unwrap_or(current);
            if saved["state"].as_str().is_some() {
                let _ = ctx
                    .project_host
                    .settle_live_approval(approval_id, LocalPermissionDecision::Timeout);
            }
            current = saved;
        }
    }

    let is_plan = is_plan_approval(&current);
    if !is_plan
        && matches!(current["state"].as_str(), Some("open" | "stale"))
        && check_policy_stamp_for_approval(data_home, &current).is_err()
    {
        let saved = if current["state"].as_str() == Some("open")
            && ctx.project_host.is_live_approval_mirrored(approval_id) == Some(false)
        {
            let _ = ctx
                .project_host
                .settle_live_approval(approval_id, LocalPermissionDecision::Deny);
            let mut settled = None;
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if let Some(row) = find_approval(data_home, workspace_id, approval_id)
                    && approval_terminal_state(row["state"].as_str().unwrap_or(""))
                {
                    settled = Some(row);
                    break;
                }
            }
            settled.unwrap_or_else(|| {
                let latest = find_approval(data_home, workspace_id, approval_id).unwrap_or(current);
                if matches!(latest["state"].as_str(), Some("open" | "stale")) {
                    store
                        .decide(
                            &latest,
                            ApprovalState::Expired,
                            ApprovalDecision::Policy,
                            &now_iso(),
                            Some("permission_policy_changed"),
                            None,
                        )
                        .unwrap_or(latest)
                } else {
                    latest
                }
            })
        } else {
            let saved = store
                .decide(
                    &current,
                    ApprovalState::Expired,
                    ApprovalDecision::Policy,
                    &now_iso(),
                    Some("permission_policy_changed"),
                    None,
                )
                .unwrap_or(current);
            let _ = ctx
                .project_host
                .settle_live_approval(approval_id, LocalPermissionDecision::Deny);
            saved
        };
        ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
        return Ok(json!({ "ok": true, "approval": saved }));
    }

    let host = ctx.project_host.host();
    if approval_terminal_state(current["state"].as_str().unwrap_or("")) {
        if decision == "approved"
            && current["state"] == "approved"
            && is_plan
            && let Some(sid) = current["sessionId"].as_str()
            && let Some(mut plan) = host.supervisor().find_plan_by_session(workspace_id, sid)
            && plan["delegationOrigin"]["phase"] == "awaiting_approval"
        {
            let _ = ensure_lease_for_mutation(ctx, workspace_id);
            plan["status"] = json!("accepted");
            plan["delegationOrigin"]["phase"] = json!("queued");
            plan["updatedAt"] = json!(now_iso());
            let _ = host.supervisor().save_plan_json(&plan);
            if ctx.project_host.is_enabled()
                && let Ok(promoted) = host.supervisor().promote_queued(workspace_id, true)
            {
                for psid in promoted.start {
                    ctx.project_host.spawn_worker_session(workspace_id, &psid);
                }
            }
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            return Ok(json!({ "ok": true, "approval": current, "resumed": true }));
        }
        return Ok(json!({ "ok": true, "approval": current }));
    }

    let session_id = current["sessionId"].as_str().map(str::to_owned);
    if decision == "approved"
        && let Some(ref sid) = session_id
        && let Some(proj) = get_session_projected(data_home, sid, None)
        && matches!(
            proj["status"].as_str(),
            Some("paused" | "superseded" | "cancelled")
        )
    {
        return Ok(ok_fail("SESSION_PAUSED"));
    }

    if is_plan {
        if let Err(resp) = ensure_lease_for_mutation(ctx, workspace_id) {
            return Ok(resp);
        }
        let approve = decision == "approved";
        match host
            .supervisor()
            .decide_plan_approval(workspace_id, approval_id, approve, true)
        {
            Ok(summary) => {
                if approve
                    && ctx.project_host.is_enabled()
                    && let Ok(promoted) = host.supervisor().promote_queued(workspace_id, true)
                {
                    for sid in promoted.start {
                        ctx.project_host.spawn_worker_session(workspace_id, &sid);
                    }
                }
                let updated =
                    find_approval(data_home, workspace_id, approval_id).unwrap_or(current);
                ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
                return Ok(json!({
                    "ok": true,
                    "approval": updated,
                    "resumed": summary,
                }));
            }
            Err(err) => return Ok(ok_fail(err.code)),
        }
    }

    if current["state"].as_str() == Some("open") {
        let perm_dec = match (decision, duration) {
            ("approved", "task") => LocalPermissionDecision::ApproveSession,
            ("approved", _) => LocalPermissionDecision::Approve,
            ("cancelled", _) => LocalPermissionDecision::Cancel,
            _ => LocalPermissionDecision::Deny,
        };
        if let Some(mirrored) = ctx.project_host.settle_live_approval(approval_id, perm_dec) {
            // Wait briefly for the running engine or mirrored waiter to persist the decided row.
            let mut latest = None;
            for _ in 0..50 {
                tokio::time::sleep(Duration::from_millis(20)).await;
                if let Some(row) = find_approval(data_home, workspace_id, approval_id)
                    && approval_terminal_state(row["state"].as_str().unwrap_or(""))
                {
                    latest = Some(row);
                    break;
                }
            }
            let _ = mirrored;
            let final_row = latest
                .or_else(|| find_approval(data_home, workspace_id, approval_id))
                .unwrap_or(current);
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            return Ok(json!({ "ok": true, "approval": final_row }));
        }
        // No live waiter: fail closed by marking expired (`permission_unavailable`).
        let saved = store
            .decide(
                &current,
                ApprovalState::Expired,
                ApprovalDecision::Policy,
                &now_iso(),
                Some("permission_unavailable"),
                None,
            )
            .unwrap_or(current);
        ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
        return Ok(json!({ "ok": true, "approval": saved }));
    }

    // Stale approval decision + session resume
    let target_state = match decision {
        "approved" => ApprovalState::Approved,
        "cancelled" => ApprovalState::Cancelled,
        _ => ApprovalState::Denied,
    };
    let reason = match target_state {
        ApprovalState::Cancelled => Some("permission_cancelled"),
        ApprovalState::Denied => Some("local_user_denied"),
        _ => None,
    };
    let saved = match store.decide(
        &current,
        target_state,
        ApprovalDecision::LocalUser,
        &now_iso(),
        reason,
        None,
    ) {
        Ok(row) => row,
        Err(_) => return Ok(ok_fail("NOT_FOUND")),
    };

    let mut resumed_val: Option<Value> = None;
    if decision == "approved"
        && let Some(ref sid) = session_id
        && ensure_lease_for_mutation(ctx, workspace_id).is_ok()
    {
        if let Ok(sum) = host.supervisor().resume_session(workspace_id, sid, true) {
            resumed_val = serde_json::to_value(sum).ok();
        }
        if ctx.project_host.is_enabled()
            && let Ok(promoted) = host.supervisor().promote_queued(workspace_id, true)
        {
            for psid in promoted.start {
                ctx.project_host.spawn_worker_session(workspace_id, &psid);
            }
        }
    }

    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    let mut out = json!({ "ok": true, "approval": saved });
    if let Some(resumed) = resumed_val {
        out["resumed"] = resumed;
    }
    Ok(out)
}

// ---------------------------------------------------------------------------
// 12. project.bot.startFamiliarize
// ---------------------------------------------------------------------------

pub fn handle_start_familiarize(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    }
    let host = ctx.project_host.host();
    let sel = resolve_worker_selection(ctx, workspace_id);
    match host.start_familiarize(workspace_id, sel) {
        Ok(res) => {
            if let FamiliarizeKind::Research {
                session_id: Some(_),
            } = res.kind
            {
                promote_and_spawn_workers(ctx, workspace_id);
            }
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            ctx.project_host
                .emit_conversation_changed(workspace_id, None);
            Ok(match res.kind {
                FamiliarizeKind::Blank => json!({
                    "ok": true,
                    "kind": "blank",
                    "reused": res.reused,
                }),
                FamiliarizeKind::Research { session_id } => json!({
                    "ok": true,
                    "kind": "research",
                    "reused": res.reused,
                    "sessionId": session_id,
                }),
            })
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 13. project.bot.confirmResult
// ---------------------------------------------------------------------------

pub fn handle_confirm_result(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let stage = params.get("stage").and_then(Value::as_str);
    if workspace_id.is_empty() || session_id.is_empty() {
        return Ok(ok_fail("NOT_FOUND"));
    }
    if let Some(st) = stage
        && !matches!(st, "manual_completion" | "result_acceptance")
    {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let Some(projected) = get_session_projected(&ctx.config.data_home, session_id, None) else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if projected["workspaceId"].as_str() != Some(workspace_id) {
        return Ok(ok_fail("NOT_FOUND"));
    }
    let host = ctx.project_host.host();
    let res = if stage == Some("manual_completion") {
        let token = params
            .get("reviewToken")
            .and_then(Value::as_str)
            .unwrap_or("");
        match host.confirm_completion_review(workspace_id, session_id, token) {
            Ok(v) => {
                if v["ok"] == true {
                    promote_and_spawn_workers(ctx, workspace_id);
                    v
                } else {
                    ok_fail(v["error"].as_str().unwrap_or("NOT_CONFIRMABLE"))
                }
            }
            Err(err) => ok_fail(err.code),
        }
    } else {
        match host.confirm_session_result(workspace_id, session_id, None) {
            Ok(decision) => {
                if decision.accepted_by.is_some() {
                    if ctx.project_host.is_enabled() {
                        ctx.project_host.wake_workspace(workspace_id);
                    }
                    json!({ "ok": true, "decision": decision })
                } else {
                    ok_fail("NOT_CONFIRMABLE")
                }
            }
            Err(err) => ok_fail(err.code),
        }
    };
    ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
    ctx.project_host
        .emit_conversation_changed(workspace_id, None);
    Ok(res)
}

// ---------------------------------------------------------------------------
// 14. project.bot.acceptReadme
// ---------------------------------------------------------------------------

pub fn handle_accept_readme(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("NOT_FOUND"));
    }
    let host = ctx.project_host.host();
    if host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("NOT_FOUND"));
    }
    let sel = resolve_worker_selection(ctx, workspace_id);
    match host.accept_readme(workspace_id, sel) {
        Ok(res) => {
            if res["ok"] == true {
                if res["sessionId"].as_str().is_some() {
                    promote_and_spawn_workers(ctx, workspace_id);
                }
                ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
                ctx.project_host
                    .emit_conversation_changed(workspace_id, None);
            }
            Ok(res)
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 15. project.bot.retry
// ---------------------------------------------------------------------------

pub async fn handle_retry(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let turn_id = params
        .get("turnId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) || turn_id.is_empty() || turn_id.len() > 200 {
        return Ok(ok_fail("NOT_FOUND"));
    }
    if !ctx.project_host.try_begin_retry(workspace_id, turn_id) {
        return Ok(ok_fail("RETRY_IN_FLIGHT"));
    }
    ctx.project_host.wait_workspace_idle(workspace_id).await;
    let result = ctx.project_host.host().retry_turn(workspace_id, turn_id);
    ctx.project_host.finish_retry(workspace_id, turn_id);
    match result {
        Ok(res) => {
            if res["ok"] == true {
                if ctx.project_host.is_enabled() {
                    ctx.project_host.wake_workspace(workspace_id);
                }
                ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
                ctx.project_host
                    .emit_conversation_changed(workspace_id, None);
            }
            Ok(res)
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 16. project.bot.takeoverHost
// ---------------------------------------------------------------------------

pub fn handle_takeover_host(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let host = ctx.project_host.host();
    if host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("NOT_FOUND"));
    }
    ctx.project_host.clear_yield_cooldown(workspace_id);
    if host.holds_lease(workspace_id) {
        return Ok(json!({ "ok": true, "requested": false, "alreadyHost": true }));
    }
    match host.request_takeover(workspace_id) {
        Ok(true) => {
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            Ok(json!({ "ok": true, "requested": true }))
        }
        Ok(false) => {
            // Free lease: acquire directly if host runtime is enabled
            let acquired = if ctx.project_host.is_enabled() {
                matches!(
                    host.ensure_lease(workspace_id),
                    Ok(LeaseStatus::Acquired { .. })
                )
            } else {
                false
            };
            if acquired {
                ctx.project_host.set_recovery_ready(workspace_id);
                ctx.project_host.wake_workspace(workspace_id);
            }
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            Ok(json!({ "ok": true, "requested": false, "acquired": acquired }))
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 17. project.bot.recovery
// ---------------------------------------------------------------------------

pub async fn handle_recovery(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    let action = params.get("action").and_then(Value::as_str).unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("NOT_FOUND"));
    }
    let host = ctx.project_host.host();
    if host
        .profiles()
        .read(workspace_id)
        .filter(BotProfile::is_active)
        .is_none()
    {
        return Ok(ok_fail("NOT_FOUND"));
    }
    if !matches!(action, "inspect" | "restore" | "retain" | "retain_all") {
        return Ok(ok_fail("INVALID_INPUT"));
    }

    let sessions = build_recovery_session_inventory(ctx, workspace_id);
    let is_ready = ctx.project_host.is_workspace_ready(workspace_id);

    if action == "inspect" {
        return match inspect_recovery(host, workspace_id, &sessions, is_ready) {
            Ok(res) => Ok(res),
            Err(err) => Ok(ok_fail(err.code)),
        };
    }

    let plan_token = params
        .get("planToken")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !host.holds_lease(workspace_id) {
        return Ok(occupied_recovery_view(&ctx.config.data_home, workspace_id));
    }
    let Some(expected_epoch) = host.lease_epoch(workspace_id) else {
        return Ok(occupied_recovery_view(&ctx.config.data_home, workspace_id));
    };

    ctx.project_host.quiesce_workspace(workspace_id).await;
    if host.lease_epoch(workspace_id).as_deref() != Some(&expected_epoch) {
        return Ok(ok_fail("coordination_lease_lost"));
    }

    let result = match action {
        "restore" => execute_recovery_restore(
            host,
            workspace_id,
            plan_token,
            &expected_epoch,
            &sessions,
            is_ready,
        ),
        "retain" | "retain_all" => {
            let work_id = params.get("workId").and_then(Value::as_str);
            let session_id = params.get("sessionId").and_then(Value::as_str);
            execute_recovery_retain(
                host,
                workspace_id,
                action,
                plan_token,
                work_id,
                session_id,
                &expected_epoch,
                &sessions,
                is_ready,
            )
        }
        _ => Err(peer_project_agent::ProjectError::code("INVALID_INPUT")),
    };

    match result {
        Ok(res) => {
            ctx.project_host.set_recovery_ready(workspace_id);
            ctx.project_host.emit_changed(vec![workspace_id.to_owned()]);
            if ctx.project_host.is_enabled() {
                ctx.project_host.wake_workspace(workspace_id);
            }
            Ok(res)
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// 17. project.bot.wake
// ---------------------------------------------------------------------------

pub fn handle_wake(ctx: &ServerContext, params: Value) -> Result<Value, RpcError> {
    let workspace_id = params
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("");
    if !is_valid_workspace_id(workspace_id) {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    }
    let woken =
        if ctx.project_host.is_enabled() && ctx.project_host.host().holds_lease(workspace_id) {
            ctx.project_host.wake_workspace(workspace_id);
            true
        } else {
            false
        };
    Ok(json!({
        "ok": true,
        "woken": woken,
        "workspaceId": workspace_id,
    }))
}
