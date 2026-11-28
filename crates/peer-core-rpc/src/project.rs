//! Project Agent RPC domain handlers (`project.memory.*`, `project.objectives.*`, `project.profile.*`).

use crate::{protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BotProfileStore, MemoryFilter, MemoryStore, ObjectiveActions, ObjectiveBudget,
    ObjectiveCommandPatch, ObjectiveMilestone, ObjectiveStore, ProjectError, SessionSupervisor,
    is_valid_workspace_id, now_iso, parse_iso_ms, sha256_hex,
};
use peer_store::ConversationStore;
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs,
};

fn ok_fail(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

fn memory_fail(err: ProjectError) -> Value {
    ok_fail(&err.code.to_ascii_uppercase())
}

fn require_object(params: &Value) -> Result<&Map<String, Value>, Value> {
    params.as_object().ok_or_else(|| ok_fail("INVALID_INPUT"))
}

fn trimmed_workspace_id(obj: &Map<String, Value>) -> Result<&str, Value> {
    let ws = obj
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("");
    if !is_valid_workspace_id(ws) {
        return Err(ok_fail("INVALID_WORKSPACE"));
    }
    Ok(ws)
}

// ---------------------------------------------------------------------------
// project.memory.*
// ---------------------------------------------------------------------------

pub fn handle_memory_list(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params = if params_val.is_null() {
        Value::Object(Map::new())
    } else {
        params_val
    };
    let Some(obj) = params.as_object() else {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };

    let kind_filter = obj
        .get("kind")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let trust_filter = obj
        .get("trust")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let status_filter = obj
        .get("status")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let id_filter: Option<HashSet<&str>> =
        obj.get("ids").and_then(Value::as_array).and_then(|arr| {
            if arr.is_empty() {
                None
            } else {
                Some(arr.iter().filter_map(Value::as_str).collect())
            }
        });

    let store = MemoryStore::new(&ctx.config.data_home);
    let items: Vec<_> = store
        .list(&MemoryFilter {
            scope: None,
            workspace_id: Some(ws),
            kind: kind_filter,
            status: status_filter,
        })
        .into_iter()
        .filter(|item| trust_filter.is_none_or(|t| item.trust == t))
        .filter(|item| {
            id_filter
                .as_ref()
                .is_none_or(|wanted| wanted.contains(item.id.as_str()))
        })
        .collect();

    let memory_enabled = BotProfileStore::new(&ctx.config.data_home)
        .read(ws)
        .is_none_or(|p| p.is_memory_enabled());

    Ok(json!({
        "ok": true,
        "items": items,
        "memoryEnabled": memory_enabled,
    }))
}

pub fn handle_memory_pin(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let obj = match require_object(&params_val) {
        Ok(obj) => obj,
        Err(resp) => return Ok(resp),
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let Some(pinned) = obj.get("pinned").and_then(Value::as_bool) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    match MemoryStore::new(&ctx.config.data_home).set_pinned(ws, id, pinned) {
        Ok(item) => Ok(json!({ "ok": true, "item": item })),
        Err(err) => Ok(memory_fail(err)),
    }
}

pub fn handle_memory_forget(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let obj = match require_object(&params_val) {
        Ok(obj) => obj,
        Err(resp) => return Ok(resp),
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let reason = obj
        .get("reason")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("用户撤销");
    match MemoryStore::new(&ctx.config.data_home).forget_visible(ws, id, reason) {
        Ok((item, already_forgotten)) => {
            let mut resp = json!({ "ok": true, "item": item });
            if already_forgotten {
                resp["alreadyForgotten"] = json!(true);
            }
            Ok(resp)
        }
        Err(err) => Ok(memory_fail(err)),
    }
}

pub fn handle_memory_restore(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let obj = match require_object(&params_val) {
        Ok(obj) => obj,
        Err(resp) => return Ok(resp),
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let resolve_conflict = obj.get("resolveConflict").and_then(Value::as_bool) == Some(true);
    let store = MemoryStore::new(&ctx.config.data_home);
    if resolve_conflict {
        match store.resolve_conflict(ws, id) {
            Ok((item, already_resolved)) => {
                let mut resp = json!({ "ok": true, "item": item });
                if already_resolved {
                    resp["alreadyResolved"] = json!(true);
                }
                Ok(resp)
            }
            Err(err) => Ok(memory_fail(err)),
        }
    } else {
        match store.restore(ws, id) {
            Ok((item, already_active)) => {
                let mut resp = json!({ "ok": true, "item": item });
                if already_active {
                    resp["alreadyActive"] = json!(true);
                }
                Ok(resp)
            }
            Err(err) => Ok(memory_fail(err)),
        }
    }
}

pub fn handle_memory_edit(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let obj = match require_object(&params_val) {
        Ok(obj) => obj,
        Err(resp) => return Ok(resp),
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let Some(id) = obj.get("id").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let Some(text) = obj.get("text").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    match MemoryStore::new(&ctx.config.data_home).revise_stated(ws, id, text) {
        Ok((item, revoked_id)) => Ok(json!({
            "ok": true,
            "item": item,
            "revokedId": revoked_id,
        })),
        Err(err) => Ok(memory_fail(err)),
    }
}

pub fn handle_memory_set_switches(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let obj = match require_object(&params_val) {
        Ok(obj) => obj,
        Err(resp) => return Ok(resp),
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let profiles = BotProfileStore::new(&ctx.config.data_home);
    let enabled = match obj.get("memoryEnabled").and_then(Value::as_bool) {
        Some(value) => {
            let Some(mut profile) = profiles.read(ws) else {
                return Ok(ok_fail("NOT_FOUND"));
            };
            if profile.status == "archived" {
                return Ok(ok_fail("NOT_FOUND"));
            }
            profile.memory_enabled = Some(value);
            if let Err(err) = profiles.save(profile) {
                return Ok(ok_fail(err.code));
            }
            value
        }
        None => profiles.read(ws).is_none_or(|p| p.is_memory_enabled()),
    };
    Ok(json!({ "ok": true, "memoryEnabled": enabled }))
}

// ---------------------------------------------------------------------------
// project.objectives.*
// ---------------------------------------------------------------------------

fn read_watch_state_doc(data_home: &std::path::Path, workspace_id: &str) -> Option<Value> {
    let path = data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("objectives")
        .join("watch-state.json");
    let raw = fs::read_to_string(path).ok()?;
    serde_json::from_str::<Value>(&raw).ok()
}

fn decorate_objective_view(
    workspace_id: &str,
    item: peer_project_agent::ObjectiveItem,
    store: &ObjectiveStore,
    actions: &ObjectiveActions,
    watch_doc: Option<&Value>,
    today: &str,
) -> Value {
    let observations = store
        .observations(workspace_id, &item.objective_id)
        .unwrap_or_default();
    let last_observation = observations
        .last()
        .and_then(|obs| serde_json::to_value(obs).ok())
        .unwrap_or(Value::Null);
    let probes_today = watch_doc
        .and_then(|doc| doc.get("reservations").and_then(Value::as_object))
        .map(|reservations| {
            reservations
                .values()
                .filter(|entry| {
                    entry.get("objectiveId").and_then(Value::as_str)
                        == Some(item.objective_id.as_str())
                        && entry
                            .get("at")
                            .and_then(Value::as_str)
                            .is_some_and(|at| at.starts_with(today))
                })
                .count()
        })
        .unwrap_or_else(|| {
            observations
                .iter()
                .filter(|obs| obs.observed_at.starts_with(today))
                .count()
        });

    let mut view = serde_json::to_value(&item).unwrap_or(Value::Null);
    if let Some(watches) = view.get_mut("watches").and_then(Value::as_array_mut) {
        for watch in watches.iter_mut() {
            let Some(wid) = watch
                .get("watchId")
                .and_then(Value::as_str)
                .map(str::to_owned)
            else {
                continue;
            };
            let plain_key = format!("{}:{wid}", item.objective_id);
            let hashed_key = sha256_hex(plain_key.as_bytes());
            let overlay = watch_doc
                .and_then(|doc| {
                    doc.get("watches")
                        .and_then(|m| m.get(&hashed_key))
                        .or_else(|| doc.get("cursors").and_then(|m| m.get(&plain_key)))
                })
                .and_then(Value::as_object);
            if let (Some(overlay_map), Some(watch_map)) = (overlay, watch.as_object_mut()) {
                for (k, v) in overlay_map {
                    watch_map.insert(k.clone(), v.clone());
                }
            }
        }
    }
    view["lastObservation"] = last_observation;
    view["usage"] = json!({
        "date": today,
        "probes": probes_today,
        "autoSessions": actions.daily_auto_usage(workspace_id, &item.objective_id),
    });
    view
}

pub fn handle_objectives_list(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params = if params_val.is_null() {
        Value::Object(Map::new())
    } else {
        params_val
    };
    let Some(obj) = params.as_object() else {
        return Ok(ok_fail("INVALID_WORKSPACE"));
    };
    let ws = match trimmed_workspace_id(obj) {
        Ok(ws) => ws,
        Err(resp) => return Ok(resp),
    };
    let Some(profile) = BotProfileStore::new(&ctx.config.data_home).read(ws) else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if profile
        .agent_conversation_id
        .as_deref()
        .is_none_or(str::is_empty)
    {
        return Ok(ok_fail("NOT_FOUND"));
    }

    let store = ObjectiveStore::new(&ctx.config.data_home);
    let actions = ObjectiveActions::new(&ctx.config.data_home);
    let watch_doc = read_watch_state_doc(&ctx.config.data_home, ws);
    let today = now_iso()[..10].to_owned();
    let items = match store.list(ws) {
        Ok(items) => items,
        Err(err) => return Ok(ok_fail(err.code)),
    };
    let views: Vec<Value> = items
        .into_iter()
        .map(|item| decorate_objective_view(ws, item, &store, &actions, watch_doc.as_ref(), &today))
        .collect();
    Ok(json!({ "ok": true, "items": views }))
}

struct ParsedObjectiveUpdatePatch<'a> {
    title: Option<&'a str>,
    outcome: Option<&'a str>,
    autonomy: Option<&'a str>,
    watches: Option<Vec<Value>>,
    milestones: Option<Vec<ObjectiveMilestone>>,
    success_signals: Option<Vec<Value>>,
    budget: Option<ObjectiveBudget>,
    deadline: Option<Option<&'a str>>,
    auto_accept: Option<bool>,
}

fn validate_update_patch<'a>(
    patch_val: &'a Value,
    workspace_id: &str,
    objective_id: &str,
    plans: &[Value],
) -> Result<ParsedObjectiveUpdatePatch<'a>, &'static str> {
    const ALLOWED_PATCH_KEYS: &[&str] = &[
        "autoAccept",
        "title",
        "outcome",
        "autonomy",
        "watches",
        "milestones",
        "successSignals",
        "budget",
        "deadline",
    ];
    let Some(obj) = patch_val.as_object() else {
        return Err("INVALID_INPUT");
    };
    if obj
        .keys()
        .any(|k| !ALLOWED_PATCH_KEYS.contains(&k.as_str()))
    {
        return Err("INVALID_INPUT");
    }

    let auto_accept = match obj.get("autoAccept") {
        None => None,
        Some(v) => Some(v.as_bool().ok_or("INVALID_INPUT")?),
    };
    let title = match obj.get("title") {
        None => None,
        Some(v) => {
            let s = v.as_str().ok_or("INVALID_INPUT")?;
            if s.trim().is_empty() || s.chars().count() > 120 {
                return Err("INVALID_INPUT");
            }
            Some(s)
        }
    };
    let outcome = match obj.get("outcome") {
        None => None,
        Some(v) => {
            let s = v.as_str().ok_or("INVALID_INPUT")?;
            if s.trim().is_empty() || s.chars().count() > 2000 {
                return Err("INVALID_INPUT");
            }
            Some(s)
        }
    };
    let autonomy = match obj.get("autonomy") {
        None => None,
        Some(v) => {
            let s = v.as_str().ok_or("INVALID_INPUT")?;
            if !matches!(s, "report_only" | "propose" | "act") {
                return Err("INVALID_INPUT");
            }
            Some(s)
        }
    };
    let budget = match obj.get("budget") {
        None => None,
        Some(v) => {
            let b_obj = v.as_object().ok_or("INVALID_INPUT")?;
            if b_obj
                .keys()
                .any(|k| !matches!(k.as_str(), "maxAutoSessionsPerDay" | "maxProbeRunsPerDay"))
            {
                return Err("INVALID_INPUT");
            }
            let max_auto = b_obj
                .get("maxAutoSessionsPerDay")
                .and_then(Value::as_u64)
                .ok_or("INVALID_INPUT")?;
            let max_probe = b_obj
                .get("maxProbeRunsPerDay")
                .and_then(Value::as_u64)
                .ok_or("INVALID_INPUT")?;
            if max_auto > 3 || !(1..=1440).contains(&max_probe) {
                return Err("INVALID_INPUT");
            }
            Some(ObjectiveBudget {
                max_auto_sessions_per_day: max_auto as u32,
                max_probe_runs_per_day: max_probe as u32,
            })
        }
    };
    let deadline = match obj.get("deadline") {
        None => None,
        Some(v) => {
            let s = v.as_str().ok_or("INVALID_INPUT")?;
            if s.trim().is_empty() || s.len() > 40 || parse_iso_ms(s).is_none() {
                return Err("INVALID_INPUT");
            }
            Some(Some(s))
        }
    };
    let watches = match obj.get("watches") {
        None => None,
        Some(v) => {
            let arr = v.as_array().ok_or("INVALID_INPUT")?;
            if arr.len() > 16 {
                return Err("INVALID_INPUT");
            }
            Some(arr.clone())
        }
    };
    let milestones = match obj.get("milestones") {
        None => None,
        Some(v) => {
            let arr = v.as_array().ok_or("INVALID_INPUT")?;
            if arr.len() > 32 {
                return Err("INVALID_INPUT");
            }
            let mut parsed = Vec::with_capacity(arr.len());
            for item in arr {
                let m_obj = item.as_object().ok_or("INVALID_INPUT")?;
                if m_obj
                    .keys()
                    .any(|k| !matches!(k.as_str(), "id" | "title" | "status" | "sessionIds"))
                {
                    return Err("INVALID_INPUT");
                }
                let m: ObjectiveMilestone =
                    serde_json::from_value(item.clone()).map_err(|_| "INVALID_INPUT")?;
                if m.id.trim().is_empty()
                    || m.id.len() > 200
                    || m.title.trim().is_empty()
                    || m.title.len() > 200
                    || !matches!(m.status.as_str(), "pending" | "active" | "done" | "dropped")
                    || m.session_ids.len() > 100
                    || m.session_ids
                        .iter()
                        .any(|sid| sid.trim().is_empty() || sid.len() > 200)
                {
                    return Err("INVALID_INPUT");
                }
                parsed.push(m);
            }
            Some(parsed)
        }
    };
    let success_signals = match obj.get("successSignals") {
        None => None,
        Some(v) => {
            let arr = v.as_array().ok_or("INVALID_INPUT")?;
            if arr.len() > 16 {
                return Err("INVALID_INPUT");
            }
            for item in arr {
                let s_obj = item.as_object().ok_or("INVALID_INPUT")?;
                if s_obj
                    .keys()
                    .any(|k| !matches!(k.as_str(), "signalId" | "watchId" | "operator" | "value"))
                {
                    return Err("INVALID_INPUT");
                }
                let op = s_obj
                    .get("operator")
                    .and_then(Value::as_str)
                    .ok_or("INVALID_INPUT")?;
                if !matches!(op, "equals" | "contains" | "succeeded") {
                    return Err("INVALID_INPUT");
                }
            }
            Some(arr.clone())
        }
    };

    if let Some(ref parsed_milestones) = milestones {
        let mut plan_by_session: BTreeMap<&str, &Value> = BTreeMap::new();
        for plan in plans {
            if let Some(sid) = plan["delegationOrigin"]["sessionId"].as_str() {
                plan_by_session.insert(sid, plan);
            }
        }
        for m in parsed_milestones {
            for sid in &m.session_ids {
                let Some(plan) = plan_by_session.get(sid.as_str()) else {
                    return Err("SESSION_OUT_OF_SCOPE");
                };
                if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id)
                    || plan["delegationOrigin"]["objectiveId"].as_str() != Some(objective_id)
                {
                    return Err("SESSION_OUT_OF_SCOPE");
                }
            }
            if m.status == "done"
                && (m.session_ids.is_empty()
                    || m.session_ids.iter().any(|sid| {
                        plan_by_session
                            .get(sid.as_str())
                            .is_none_or(|p| !p["resultAcceptance"]["acceptedAt"].is_string())
                    }))
            {
                return Err("MILESTONE_UNPROVEN");
            }
        }
    }

    Ok(ParsedObjectiveUpdatePatch {
        title,
        outcome,
        autonomy,
        watches,
        milestones,
        success_signals,
        budget,
        deadline,
        auto_accept,
    })
}

fn build_objective_action_text(
    method: &str,
    current_autonomy: &str,
    patch: Option<&ParsedObjectiveUpdatePatch<'_>>,
) -> String {
    let mut action = match method {
        "update" => match patch.and_then(|p| p.autonomy) {
            Some("act") => "持续目标允许直接处理，发现问题就直接修".to_owned(),
            Some("report_only") => "持续目标只报告变化".to_owned(),
            Some("propose") => "持续目标先提议再执行".to_owned(),
            _ => {
                if current_autonomy == "act" {
                    "调整持续目标计划，继续直接处理".to_owned()
                } else {
                    "调整持续目标计划".to_owned()
                }
            }
        },
        "resume" => {
            if current_autonomy == "act" {
                "确认并恢复这个目标，发现问题就直接修".to_owned()
            } else {
                "确认并恢复这个持续目标".to_owned()
            }
        }
        "pause" => "暂停这个目标".to_owned(),
        _ => "放弃这个目标".to_owned(),
    };
    if method == "update"
        && let Some(p) = patch
    {
        if let Some(aa) = p.auto_accept {
            action.push_str(if aa {
                ";允许这个目标自动签收任务"
            } else {
                ";关闭这个目标自动签收任务"
            });
        }
        if let Some(ref b) = p.budget {
            action.push_str(&format!(
                ";每天自动任务上限调整到 {};每天探测上限调整到 {}",
                b.max_auto_sessions_per_day, b.max_probe_runs_per_day
            ));
        }
    }
    action
}

pub fn handle_objectives_command(
    ctx: &ServerContext,
    params_val: Value,
    method: &str,
) -> Result<Value, RpcError> {
    const ALLOWED_KEYS: &[&str] = &[
        "workspaceId",
        "objectiveId",
        "requestId",
        "patch",
        "expectedVersion",
    ];
    let Some(obj) = params_val.as_object() else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    if obj.keys().any(|k| !ALLOWED_KEYS.contains(&k.as_str())) {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let Some(ws) = obj.get("workspaceId").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let Some(objective_id) = obj.get("objectiveId").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let Some(request_id) = obj.get("requestId").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    if !is_valid_workspace_id(ws) || request_id.is_empty() || request_id.chars().count() > 200 {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let expected_version = match obj.get("expectedVersion") {
        None => None,
        Some(v) => {
            let Some(n) = v.as_u64().filter(|n| *n >= 1) else {
                return Ok(ok_fail("INVALID_INPUT"));
            };
            Some(n)
        }
    };

    let Some(profile) = BotProfileStore::new(&ctx.config.data_home).read(ws) else {
        return Ok(ok_fail("PROJECT_AGENT_DISABLED"));
    };
    if profile.status != "active" {
        return Ok(ok_fail("PROJECT_AGENT_DISABLED"));
    }
    let Some(conversation_id) = profile
        .agent_conversation_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
    else {
        return Ok(ok_fail("PROJECT_AGENT_DISABLED"));
    };

    let obj_store = ObjectiveStore::new(&ctx.config.data_home);
    let current = match obj_store.get(ws, objective_id) {
        Ok(Some(item)) => item,
        Ok(None) => return Ok(ok_fail("NOT_FOUND")),
        Err(err) => return Ok(ok_fail(err.code)),
    };

    let raw_patch = match obj.get("patch") {
        None | Some(Value::Null) => json!({}),
        Some(v) => v.clone(),
    };
    if !raw_patch.is_object() {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let plans = if method == "update" {
        SessionSupervisor::new(&ctx.config.data_home, None).list_workspace_plans(ws)
    } else {
        Vec::new()
    };
    let parsed_patch = if method == "update" {
        match validate_update_patch(&raw_patch, ws, objective_id, &plans) {
            Ok(p) => Some(p),
            Err(code) => return Ok(ok_fail(code)),
        }
    } else {
        None
    };

    let action = build_objective_action_text(method, &current.autonomy, parsed_patch.as_ref());
    let fp_payload = format!(
        "{{\"workspaceId\":{},\"objectiveId\":{},\"method\":{},\"patch\":{}}}",
        serde_json::to_string(ws).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(objective_id).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(method).unwrap_or_else(|_| "\"\"".into()),
        serde_json::to_string(&raw_patch).unwrap_or_else(|_| "{}".into()),
    );
    let fingerprint = sha256_hex(fp_payload.as_bytes());
    let message_id = format!(
        "objective-command:{}",
        sha256_hex(format!("{ws}:{request_id}").as_bytes())
    );

    let conv_store = ConversationStore::new(&ctx.config.data_home);
    let existing_window =
        match conv_store.read_conversation_window(&conversation_id, None, None, true) {
            Ok(Some(page)) => page,
            _ => return Ok(ok_fail("USER_FACT_WRITE_FAILED")),
        };
    let existing_msg = existing_window["window"].as_array().and_then(|rows| {
        rows.iter()
            .find(|m| m["id"].as_str() == Some(message_id.as_str()))
    });

    let appended_message = if let Some(msg) = existing_msg {
        if msg["meta"]["objectiveCommandFingerprint"].as_str() != Some(fingerprint.as_str()) {
            return Ok(ok_fail("REQUEST_ID_REUSED"));
        }
        None
    } else {
        let msg = json!({
            "id": message_id,
            "role": "user",
            "kind": "user_input",
            "content": action,
            "createdAt": now_iso(),
            "meta": {
                "objectiveId": objective_id,
                "objectiveCommand": method,
                "objectiveCommandFingerprint": fingerprint,
            },
        });
        match conv_store.append_classic_message(&conversation_id, &msg) {
            Ok(Some(_)) => Some(msg),
            _ => return Ok(ok_fail("USER_FACT_WRITE_FAILED")),
        }
    };

    let mut cmd = ObjectiveCommandPatch {
        expected_version,
        command_id: Some(message_id.as_str()),
        command_fingerprint: Some(fingerprint.as_str()),
        ..Default::default()
    };
    match method {
        "update" => {
            if let Some(ref p) = parsed_patch {
                cmd.title = p.title;
                cmd.outcome = p.outcome;
                cmd.autonomy = p.autonomy;
                cmd.watches = p.watches.clone();
                cmd.milestones = p.milestones.clone();
                cmd.success_signals = p.success_signals.clone();
                cmd.budget = p.budget.clone();
                cmd.deadline = p.deadline;
                cmd.auto_accept = p.auto_accept;
                if p.auto_accept == Some(true) {
                    cmd.auto_accept_approved_by = Some(message_id.as_str());
                }
            }
        }
        "pause" => cmd.status = Some("paused"),
        "resume" => {
            cmd.status = Some("active");
            cmd.pending_confirmation = Some(false);
        }
        "close" => cmd.status = Some("abandoned"),
        _ => return Ok(ok_fail("INVALID_INPUT")),
    }

    match obj_store.apply_command(ws, objective_id, &cmd) {
        Ok((item, replayed)) => {
            let mut resp = json!({
                "ok": true,
                "item": item,
                "conversationId": conversation_id,
            });
            if replayed {
                resp["replayed"] = json!(true);
            }
            if let Some(msg) = appended_message {
                resp["appendedMessage"] = msg;
            }
            Ok(resp)
        }
        Err(err) => Ok(ok_fail(err.code)),
    }
}

// ---------------------------------------------------------------------------
// project.profile.*
// ---------------------------------------------------------------------------

pub fn handle_profile_read_unknown_outcome_policy(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let Some(ws) = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(ok_fail("invalid_input"));
    };
    match BotProfileStore::new(&ctx.config.data_home).read_unknown_outcome_policy(ws) {
        Ok(policy) => Ok(json!({ "ok": true, "policy": policy })),
        Err(err) if err.code == "NOT_FOUND" => Ok(ok_fail("workspace_not_found")),
        Err(_) => Ok(ok_fail("unknown_outcome_policy_unsupported")),
    }
}

pub fn handle_profile_set_unknown_outcome_policy(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let Some(ws) = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    else {
        return Ok(ok_fail("invalid_input"));
    };
    let Some(tier) = params_val
        .get("tier")
        .and_then(Value::as_str)
        .filter(|t| matches!(*t, "ask" | "bot_verified"))
    else {
        return Ok(ok_fail("invalid_input"));
    };
    match BotProfileStore::new(&ctx.config.data_home).set_unknown_outcome_policy(ws, tier) {
        Ok(policy) => Ok(json!({ "ok": true, "policy": policy })),
        Err(err) => Ok(ok_fail(err.code)),
    }
}
