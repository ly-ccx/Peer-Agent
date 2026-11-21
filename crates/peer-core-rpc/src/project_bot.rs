//! Project Agent Bot RPC domain handlers:
//! - `project.profile.{readAvatar, update}`
//! - `project.access.{read, update}`
//! - `project.bot.{markRead, listApprovals, listHistory, search}`

use crate::{protocol::RpcError, server::ServerContext};
use peer_project_agent::{
    BOT_AVATAR_COLORS, BotDirectory, BotProfileStore, ConversationSearchIndex, MemoryFilter,
    MemoryStore, ProjectRegistry, SessionSupervisor, clean_display_name,
    collect_conversation_search_documents, is_effective_memory, is_valid_workspace_id, now_iso,
    parse_iso_ms,
};
use peer_protocol::LocalAccessLevel;
use peer_store::{
    ConversationListQuery, ConversationStore, PolicyStore, PolicyUpdateError, StoreError,
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

const AVATAR_MAX_BYTES: u64 = 1024 * 1024;
const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;
const BOT_PROACTIVITY_LEVELS: [&str; 6] = ["inherit", "quiet", "low", "standard", "high", "muted"];
const MODEL_POLICY_ROLES: [&str; 8] = [
    "project_agent",
    "session_worker",
    "explorer",
    "verifier",
    "visual_verifier",
    "memory_curator",
    "objective_probe",
    "compactor",
];
const MODEL_POLICY_TIERS: [&str; 4] = ["strong", "fast", "economy", "vision"];
const REASONING_EFFORTS: [&str; 6] = ["off", "low", "medium", "high", "xhigh", "max"];
const ACTIVE_PLAN_STATUSES: [&str; 8] = [
    "drafting",
    "awaiting_approval",
    "approved",
    "accepted",
    "executing",
    "paused",
    "interrupted",
    "failed",
];
const TERMINAL_GOAL_STATUSES: [&str; 3] = ["completed", "failed", "cancelled"];

fn ok_fail(code: &str) -> Value {
    json!({ "ok": false, "code": code })
}

fn encode_base64(input: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    if input.is_empty() {
        return String::new();
    }
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = u32::from(chunk[0]);
        let b1 = u32::from(*chunk.get(1).unwrap_or(&0));
        let b2 = u32::from(*chunk.get(2).unwrap_or(&0));
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

fn is_valid_image_source(path: &Path) -> bool {
    let Ok(meta) = fs::metadata(path) else {
        return false;
    };
    if !meta.is_file() || meta.len() == 0 || meta.len() > AVATAR_MAX_BYTES {
        return false;
    }
    let Ok(bytes) = fs::read(path) else {
        return false;
    };
    (bytes.len() >= 8 && bytes[..4] == [0x89, 0x50, 0x4e, 0x47])
        || (bytes.len() >= 3 && bytes[..3] == [0xff, 0xd8, 0xff])
        || (bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP")
}

fn validate_model_policy_shape(policy: &Value) -> Result<(), &'static str> {
    if policy.is_null() {
        return Ok(());
    }
    let Some(obj) = policy.as_object() else {
        return Err("INVALID_MODEL_POLICY");
    };
    if obj.keys().any(|k| k != "scope" && k != "overrides") {
        return Err("INVALID_MODEL_POLICY");
    }
    if let Some(scope_val) = obj.get("scope").filter(|v| !v.is_null()) {
        let Some(scope) = scope_val.as_object() else {
            return Err("INVALID_MODEL_POLICY");
        };
        if scope
            .keys()
            .any(|k| !matches!(k.as_str(), "modelProviderIds" | "families" | "localOnly"))
        {
            return Err("INVALID_MODEL_POLICY");
        }
        if let Some(ids) = scope.get("modelProviderIds") {
            let Some(arr) = ids.as_array() else {
                return Err("INVALID_MODEL_POLICY");
            };
            if arr.len() > 100 || arr.iter().any(|v| v.as_str().is_none()) {
                return Err("INVALID_MODEL_POLICY");
            }
        }
        if let Some(families) = scope.get("families") {
            let Some(arr) = families.as_array() else {
                return Err("INVALID_MODEL_POLICY");
            };
            if arr.len() > 100
                || arr.iter().any(|v| {
                    v.as_str()
                        .is_none_or(|s| s.trim().is_empty() || s.chars().count() > 100)
                })
            {
                return Err("INVALID_MODEL_POLICY");
            }
        }
        if let Some(local_only) = scope.get("localOnly")
            && !local_only.is_boolean()
        {
            return Err("INVALID_MODEL_POLICY");
        }
    }
    if let Some(overrides_val) = obj.get("overrides").filter(|v| !v.is_null()) {
        let Some(overrides) = overrides_val.as_object() else {
            return Err("INVALID_MODEL_POLICY");
        };
        for (role, setting_val) in overrides {
            if !MODEL_POLICY_ROLES.contains(&role.as_str()) {
                return Err("INVALID_MODEL_POLICY");
            }
            let Some(setting) = setting_val.as_object() else {
                return Err("INVALID_MODEL_POLICY");
            };
            let mode = setting.get("mode").and_then(Value::as_str);
            let valid_mode = match mode {
                Some("tier") => setting
                    .get("tier")
                    .and_then(Value::as_str)
                    .is_some_and(|t| MODEL_POLICY_TIERS.contains(&t)),
                Some("fixed") => setting
                    .get("modelProviderId")
                    .and_then(Value::as_str)
                    .is_some_and(|s| !s.is_empty()),
                Some("auto") => setting
                    .get("pool")
                    .and_then(Value::as_array)
                    .is_some_and(|arr| {
                        !arr.is_empty()
                            && arr.len() <= 100
                            && arr.iter().all(|v| v.as_str().is_some())
                    }),
                _ => false,
            };
            if let Some(effort_val) = setting.get("reasoningEffort").filter(|v| !v.is_null()) {
                let Some(effort) = effort_val.as_str() else {
                    return Err("INVALID_REASONING_EFFORT");
                };
                if !REASONING_EFFORTS.contains(&effort) {
                    return Err("INVALID_REASONING_EFFORT");
                }
            }
            if let Some(fast_mode) = setting.get("fastMode")
                && !fast_mode.is_boolean()
            {
                return Err("INVALID_FAST_MODE");
            }
            if !valid_mode {
                return Err("INVALID_MODEL_POLICY");
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// project.profile.{readAvatar, update}
// ---------------------------------------------------------------------------

pub fn handle_profile_read_avatar(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let ws = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    match BotProfileStore::new(&ctx.config.data_home).read_avatar(ws) {
        Ok((mime, bytes)) => Ok(json!({
            "ok": true,
            "dataUrl": format!("data:{mime};base64,{}", encode_base64(&bytes)),
        })),
        Err(err) => Ok(ok_fail(err.code)),
    }
}

pub fn handle_profile_update(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let Some(obj) = params_val.as_object() else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    let ws = obj.get("workspaceId").and_then(Value::as_str).unwrap_or("");
    let store = BotProfileStore::new(&ctx.config.data_home);
    let Some(existing) = store.read(ws) else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if existing.status == "archived" {
        return Ok(ok_fail("NOT_FOUND"));
    }

    // Pre-validate all policy & profile fields before writing any mutation.
    let auto_handoff = match obj.get("autoHandoffOnPolicyAccept") {
        None => None,
        Some(v) => match v.as_bool() {
            Some(b) => Some(b),
            None => return Ok(ok_fail("INVALID_HANDOFF_POLICY")),
        },
    };
    let plan_approval = match obj.get("planApproval") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s @ ("never" | "writes" | "always")) => Some(s),
            _ => return Ok(ok_fail("INVALID_PLAN_APPROVAL")),
        },
    };
    let acceptance_policy = match obj.get("acceptancePolicy") {
        None => None,
        Some(v) => match v.as_str() {
            Some(s @ ("auto" | "confirm")) => Some(s),
            _ => return Ok(ok_fail("INVALID_ACCEPTANCE_POLICY")),
        },
    };
    let model_policy = match obj.get("modelPolicy") {
        None => None,
        Some(v) => {
            if let Err(code) = validate_model_policy_shape(v) {
                return Ok(ok_fail(code));
            }
            Some(v.clone())
        }
    };
    let display_name = match obj.get("displayName").and_then(Value::as_str) {
        None => None,
        Some(raw) => {
            let cleaned = clean_display_name(raw);
            if cleaned.is_empty() {
                return Ok(ok_fail("INVALID_NAME"));
            }
            Some(cleaned)
        }
    };
    let regenerate_avatar = obj.get("regenerateAvatar").and_then(Value::as_bool) == Some(true);
    let avatar_color = match obj.get("avatarColor") {
        None => None,
        Some(v) => match v.as_str() {
            Some(c) if BOT_AVATAR_COLORS.contains(&c) => Some(c),
            _ => return Ok(ok_fail("INVALID_AVATAR_COLOR")),
        },
    };
    let proactivity = match obj.get("proactivity").and_then(Value::as_str) {
        None => None,
        Some(level) => {
            if !BOT_PROACTIVITY_LEVELS.contains(&level) {
                return Ok(ok_fail("INVALID_PROACTIVITY"));
            }
            Some(level)
        }
    };
    let avatar_source_path = match obj.get("avatarSourcePath") {
        None => None,
        Some(v) => {
            let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                return Ok(ok_fail("INVALID_IMAGE"));
            };
            if !is_valid_image_source(Path::new(s)) {
                return Ok(ok_fail("INVALID_IMAGE"));
            }
            Some(s)
        }
    };

    if let Some(name) = display_name {
        let mut cur = store.read(ws).ok_or_else(|| {
            RpcError::internal_error("profile vanished during displayName update")
        })?;
        cur.display_name = name;
        if let Err(err) = store.save(cur) {
            return Ok(ok_fail(err.code));
        }
    }
    if regenerate_avatar && let Err(err) = store.regenerate_avatar(ws) {
        return Ok(ok_fail(err.code));
    }
    if let Some(color) = avatar_color
        && let Err(err) = store.set_avatar_color(ws, color)
    {
        return Ok(ok_fail(err.code));
    }
    if let Some(level) = proactivity {
        let Some(mut cur) = store.read(ws) else {
            return Ok(ok_fail("NOT_FOUND"));
        };
        cur.proactivity = Some(level.to_owned());
        if let Err(err) = store.save(cur) {
            return Ok(ok_fail(err.code));
        }
    }
    if let Some(src) = avatar_source_path
        && let Err(err) = store.install_avatar(ws, Path::new(src))
    {
        return Ok(ok_fail(err.code));
    }
    if auto_handoff.is_some()
        || plan_approval.is_some()
        || acceptance_policy.is_some()
        || model_policy.is_some()
    {
        let Some(mut cur) = store.read(ws) else {
            return Ok(ok_fail("NOT_FOUND"));
        };
        if let Some(handoff) = auto_handoff {
            cur.auto_handoff_on_policy_accept = handoff;
        }
        if let Some(pa) = plan_approval {
            cur.plan_approval = Some(pa.to_owned());
        }
        if let Some(ap) = acceptance_policy {
            cur.acceptance_policy = Some(ap.to_owned());
        }
        if let Some(mp) = model_policy {
            cur.model_policy = Some(mp);
        }
        if let Err(err) = store.save(cur) {
            return Ok(ok_fail(err.code));
        }
    }

    match store.read(ws) {
        Some(profile) => Ok(json!({ "ok": true, "profile": profile })),
        None => Ok(ok_fail("NOT_FOUND")),
    }
}

// ---------------------------------------------------------------------------
// project.access.{read, update}
// ---------------------------------------------------------------------------

fn js_truthy(val: Option<&Value>) -> bool {
    match val {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().is_some_and(|x| x != 0.0 && !x.is_nan()),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

fn ensure_policy_db_exists(data_home: &Path) -> Result<(), &'static str> {
    let sqlite_path = data_home.join("project-runtime").join("bot-access.sqlite");
    if sqlite_path.exists() {
        return Ok(());
    }
    PolicyStore::new(data_home)
        .initialize(LocalAccessLevel::AskBeforeLocal, &now_iso(), None)
        .map(|_| ())
        .map_err(|_| "POLICY_UNAVAILABLE")
}

fn read_workspace_access_policy(data_home: &Path, workspace_id: &str) -> Value {
    if !is_valid_workspace_id(workspace_id) {
        return ok_fail("NOT_FOUND");
    }
    let Some(profile) = BotProfileStore::new(data_home)
        .read(workspace_id)
        .filter(|p| p.is_active())
        .filter(|p| {
            p.agent_conversation_id
                .as_deref()
                .is_some_and(|s| !s.is_empty())
        })
    else {
        return ok_fail("NOT_FOUND");
    };
    if let Err(code) = ensure_policy_db_exists(data_home) {
        return ok_fail(code);
    }
    match PolicyStore::new(data_home).read_or_register(workspace_id, &now_iso()) {
        Ok(policy) => json!({
            "ok": true,
            "policy": policy,
            "inherited": false,
            "botName": profile.display_name,
        }),
        Err(StoreError::NotFound) => ok_fail("NOT_FOUND"),
        Err(StoreError::OutOfScope) => ok_fail("OUT_OF_SCOPE"),
        Err(_) => ok_fail("POLICY_UNAVAILABLE"),
    }
}

fn read_all_goal_plans(data_home: &Path) -> Vec<Value> {
    let dir = data_home.join("goal-plans");
    let index_path = dir.join("index.jsonl");
    let Ok(raw_index) = fs::read_to_string(&index_path) else {
        return Vec::new();
    };
    let mut plans = Vec::new();
    let mut seen_ids = HashSet::new();
    for line in raw_index.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(row) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(plan_id) = row["planId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if !seen_ids.insert(plan_id.to_owned()) {
            continue;
        }
        let detail_path = dir.join(format!("{plan_id}.json"));
        let hydrated = fs::read_to_string(&detail_path)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .filter(|v| v.is_object());
        plans.push(hydrated.unwrap_or(row));
    }
    plans
}

fn active_plan_for_conversation<'a>(plans: &'a [Value], conv_id: &str) -> Option<&'a Value> {
    plans
        .iter()
        .filter(|plan| plan["conversationId"].as_str() == Some(conv_id))
        .filter(|plan| {
            plan["status"]
                .as_str()
                .is_some_and(|s| ACTIVE_PLAN_STATUSES.contains(&s))
        })
        .max_by(|a, b| {
            a["updatedAt"]
                .as_str()
                .unwrap_or("")
                .cmp(b["updatedAt"].as_str().unwrap_or(""))
        })
}

pub fn handle_access_read(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let Some(obj) = params_val.as_object() else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    if obj
        .keys()
        .any(|k| k != "workspaceId" && k != "conversationId")
    {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let has_ws = js_truthy(obj.get("workspaceId"));
    let has_conv = js_truthy(obj.get("conversationId"));
    if has_ws == has_conv {
        return Ok(ok_fail("INVALID_INPUT"));
    }

    if has_ws {
        let Some(ws) = obj.get("workspaceId").and_then(Value::as_str) else {
            return Ok(ok_fail("NOT_FOUND"));
        };
        return Ok(read_workspace_access_policy(&ctx.config.data_home, ws));
    }

    let Some(conv_id) = obj.get("conversationId").and_then(Value::as_str) else {
        return Ok(ok_fail("INVALID_INPUT"));
    };

    let data_home = &ctx.config.data_home;
    let conv_store = ConversationStore::new(data_home);
    let conv_rows = match conv_store.list_conversations_view(&ConversationListQuery {
        roles: Some(vec![
            "default".into(),
            "project_agent".into(),
            "work_session".into(),
        ]),
        include_message_count: false,
        ..Default::default()
    }) {
        Ok(Value::Array(items)) => items,
        _ => return Ok(ok_fail("POLICY_UNAVAILABLE")),
    };
    let mut by_id: HashMap<String, Value> = HashMap::new();
    for row in conv_rows {
        if let Some(id) = row["id"].as_str().filter(|s| !s.is_empty()) {
            by_id.insert(id.to_owned(), row);
        }
    }
    let meta = by_id.get(conv_id);
    let plans = read_all_goal_plans(data_home);
    let plan = active_plan_for_conversation(&plans, conv_id);
    let ws_opt = plan
        .and_then(|p| p["delegationOrigin"]["workspaceId"].as_str())
        .or_else(|| meta.and_then(|m| m["workspaceId"].as_str()))
        .filter(|s| !s.is_empty());

    let profile = ws_opt.and_then(|ws| {
        if !is_valid_workspace_id(ws) {
            return None;
        }
        BotProfileStore::new(data_home)
            .read(ws)
            .filter(|p| p.is_active())
            .filter(|p| {
                p.agent_conversation_id
                    .as_deref()
                    .is_some_and(|s| !s.is_empty())
            })
    });

    let delegated = plan.is_some_and(|p| p["delegationOrigin"].is_object())
        || meta.is_some_and(|m| m["role"].as_str() == Some("work_session"));
    let root = profile
        .as_ref()
        .is_some_and(|p| p.agent_conversation_id.as_deref() == Some(conv_id));
    if !root && !delegated && meta.and_then(|m| m["role"].as_str()) != Some("project_agent") {
        return Ok(json!({ "ok": true, "policy": Value::Null, "inherited": false }));
    }

    let (Some(ws), Some(prof)) = (ws_opt, profile.as_ref()) else {
        return Ok(ok_fail("OUT_OF_SCOPE"));
    };
    if root {
        return Ok(read_workspace_access_policy(data_home, ws));
    }

    let Some(bot_conv_id) = prof.agent_conversation_id.as_deref() else {
        return Ok(ok_fail("OUT_OF_SCOPE"));
    };
    let mut cursor: Option<String> = Some(conv_id.to_owned());
    let mut seen = HashSet::new();
    for _ in 0..4 {
        let Some(cur) = cursor.as_deref().filter(|s| !s.is_empty()) else {
            return Ok(ok_fail("OUT_OF_SCOPE"));
        };
        if cur == bot_conv_id {
            break;
        }
        if !seen.insert(cur.to_owned()) {
            return Ok(ok_fail("OUT_OF_SCOPE"));
        }
        let row = by_id.get(cur);
        if let Some(r) = row
            && (r["workspaceId"].as_str() != Some(ws) || r["role"].as_str() != Some("work_session"))
        {
            return Ok(ok_fail("OUT_OF_SCOPE"));
        }
        let next_parent = row
            .and_then(|r| r["parentConversationId"].as_str())
            .filter(|s| !s.is_empty())
            .or_else(|| {
                let p = if cur == conv_id {
                    plan
                } else {
                    active_plan_for_conversation(&plans, cur)
                };
                p.and_then(|p| p["delegationOrigin"]["parentConversationId"].as_str())
                    .filter(|s| !s.is_empty())
            })
            .map(str::to_owned);
        cursor = next_parent;
    }
    if cursor.as_deref() != Some(bot_conv_id) {
        return Ok(ok_fail("OUT_OF_SCOPE"));
    }
    let mut res = read_workspace_access_policy(data_home, ws);
    if res["ok"].as_bool() == Some(true) {
        res["inherited"] = json!(true);
    }
    Ok(res)
}

pub fn handle_access_update(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let Some(obj) = params_val.as_object() else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    if obj.keys().any(|k| {
        !matches!(
            k.as_str(),
            "workspaceId" | "expectedRevision" | "accessLevel"
        )
    }) {
        return Ok(ok_fail("INVALID_INPUT"));
    }
    let Some(ws) = obj
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| is_valid_workspace_id(s))
    else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let Some(expected_rev_i64) = obj
        .get("expectedRevision")
        .and_then(Value::as_i64)
        .filter(|&n| (1..=MAX_SAFE_INTEGER).contains(&n))
    else {
        return Ok(ok_fail("INVALID_INPUT"));
    };
    let expected_revision = expected_rev_i64 as u64;
    let level = match obj.get("accessLevel").and_then(Value::as_str) {
        Some("ask_before_local") => LocalAccessLevel::AskBeforeLocal,
        Some("session_local") => LocalAccessLevel::SessionLocal,
        Some("restricted_local") => LocalAccessLevel::RestrictedLocal,
        Some("full_local") => LocalAccessLevel::FullLocal,
        _ => return Ok(ok_fail("INVALID_INPUT")),
    };

    let data_home = &ctx.config.data_home;
    let Some(profile) = BotProfileStore::new(data_home)
        .read(ws)
        .filter(|p| p.is_active())
        .filter(|p| {
            p.agent_conversation_id
                .as_deref()
                .is_some_and(|s| !s.is_empty())
        })
    else {
        return Ok(ok_fail("NOT_FOUND"));
    };
    if let Err(code) = ensure_policy_db_exists(data_home) {
        return Ok(ok_fail(code));
    }
    let store = PolicyStore::new(data_home);
    let ts = now_iso();
    if let Err(err) = store.read_or_register(ws, &ts) {
        return Ok(ok_fail(match err {
            StoreError::NotFound => "NOT_FOUND",
            StoreError::OutOfScope => "OUT_OF_SCOPE",
            _ => "POLICY_UNAVAILABLE",
        }));
    }
    match store.update_existing(ws, expected_revision, level, &ts) {
        Ok(policy) => Ok(json!({
            "ok": true,
            "policy": policy,
            "inherited": false,
            "botName": profile.display_name,
        })),
        Err(PolicyUpdateError::Conflict(before)) => Ok(json!({
            "ok": false,
            "code": "POLICY_CONFLICT",
            "policy": before,
        })),
        Err(PolicyUpdateError::Store(StoreError::InvalidInput)) => Ok(ok_fail("INVALID_INPUT")),
        Err(PolicyUpdateError::Store(StoreError::NotFound)) => Ok(ok_fail("NOT_FOUND")),
        Err(PolicyUpdateError::Store(StoreError::OutOfScope)) => Ok(ok_fail("OUT_OF_SCOPE")),
        Err(_) => Ok(ok_fail("POLICY_UNAVAILABLE")),
    }
}

// ---------------------------------------------------------------------------
// project.bot.{markRead, listApprovals, listHistory, search}
// ---------------------------------------------------------------------------

pub fn handle_bot_mark_read(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let ws = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .unwrap_or("");
    if !is_valid_workspace_id(ws) {
        return Ok(ok_fail("NOT_FOUND"));
    }
    match BotDirectory::new(&ctx.config.data_home).mark_read_bot(ws) {
        Ok(res) => Ok(json!({
            "ok": true,
            "at": res.at,
            "messageId": res.message_id,
            "changed": res.changed,
        })),
        Err(err) => Ok(ok_fail(err.code)),
    }
}

fn read_approval_jsonl_lines(
    file: &Path,
    folded: &mut Vec<(String, Value)>,
    pos: &mut HashMap<String, usize>,
) {
    let Ok(raw) = fs::read_to_string(file) else {
        return;
    };
    for line in raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let Ok(record) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(approval_id) = record
            .get("approvalId")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty() && s.len() <= 200)
        else {
            continue;
        };
        let Some(state) = record.get("state").and_then(Value::as_str) else {
            continue;
        };
        if !matches!(
            state,
            "open" | "approved" | "denied" | "expired" | "stale" | "cancelled"
        ) {
            continue;
        }
        if let Some(&idx) = pos.get(approval_id) {
            folded[idx].1 = record;
        } else {
            let idx = folded.len();
            pos.insert(approval_id.to_owned(), idx);
            folded.push((approval_id.to_owned(), record));
        }
    }
}

pub fn handle_bot_list_approvals(
    ctx: &ServerContext,
    params_val: Value,
) -> Result<Value, RpcError> {
    let filter_obj = params_val.as_object();
    let runtime_root = ctx.config.data_home.join("project-runtime");
    let mut folded: Vec<(String, Value)> = Vec::new();
    let mut pos: HashMap<String, usize> = HashMap::new();

    if let Some(ws_val) = filter_obj.and_then(|o| o.get("workspaceId")) {
        if ws_val.is_null() {
            let file = runtime_root.join("_unscoped").join("approvals.jsonl");
            if file.is_file() {
                read_approval_jsonl_lines(&file, &mut folded, &mut pos);
            }
        } else if let Some(ws_id) = ws_val.as_str().filter(|s| is_valid_workspace_id(s)) {
            let file = runtime_root.join(ws_id).join("approvals.jsonl");
            if file.is_file() {
                read_approval_jsonl_lines(&file, &mut folded, &mut pos);
            }
        } else {
            return Ok(json!({ "ok": true, "approvals": [] }));
        }
    } else if let Ok(entries) = fs::read_dir(&runtime_root) {
        let mut subdirs: Vec<_> = entries
            .flatten()
            .filter(|e| e.file_type().is_ok_and(|ft| ft.is_dir()))
            .collect();
        subdirs.sort_by_key(|e| e.file_name());
        for entry in subdirs {
            let file = entry.path().join("approvals.jsonl");
            if file.is_file() {
                read_approval_jsonl_lines(&file, &mut folded, &mut pos);
            }
        }
    }

    let state_filter = filter_obj
        .and_then(|o| o.get("state"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let stream_filter = filter_obj
        .and_then(|o| o.get("streamId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let conv_filter = filter_obj
        .and_then(|o| o.get("conversationId"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let ws_filter = filter_obj.and_then(|o| o.get("workspaceId"));

    let approvals: Vec<Value> = folded
        .into_iter()
        .map(|(_, record)| record)
        .filter(|record| {
            if let Some(st) = state_filter
                && record["state"].as_str() != Some(st)
            {
                return false;
            }
            if let Some(sid) = stream_filter
                && record["streamId"].as_str() != Some(sid)
            {
                return false;
            }
            if let Some(cid) = conv_filter
                && record["conversationId"].as_str() != Some(cid)
            {
                return false;
            }
            if let Some(ws_wanted) = ws_filter {
                if ws_wanted.is_null() {
                    if !record["workspaceId"].is_null() {
                        return false;
                    }
                } else if record.get("workspaceId") != Some(ws_wanted) {
                    return false;
                }
            }
            true
        })
        .collect();

    Ok(json!({ "ok": true, "approvals": approvals }))
}

fn tasks_wait(tasks: Option<&Vec<Value>>) -> bool {
    let Some(arr) = tasks else {
        return false;
    };
    for task in arr {
        if task["status"].as_str() == Some("waiting_user") {
            return true;
        }
        if tasks_wait(task["subtasks"].as_array()) {
            return true;
        }
    }
    false
}

fn goal_waits_on_user(plan: &Value) -> bool {
    plan["runner"]["status"].as_str() == Some("waiting_user")
        || tasks_wait(plan["tasks"].as_array())
}

pub fn handle_bot_list_history(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let obj = params_val.as_object();
    let unscoped = obj.and_then(|o| o.get("unscoped")).and_then(Value::as_bool) == Some(true);
    let mut folder = obj
        .and_then(|o| o.get("workspacePath"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned();
    if !unscoped
        && folder.is_empty()
        && let Some(ws_id) = obj
            .and_then(|o| o.get("workspaceId"))
            .and_then(Value::as_str)
            .filter(|s| is_valid_workspace_id(s))
    {
        let profile_active = BotProfileStore::new(&ctx.config.data_home)
            .read(ws_id)
            .is_some_and(|p| p.is_active());
        if profile_active
            && let Ok(Some(entry)) = ProjectRegistry::new(&ctx.config.data_home).get(ws_id)
        {
            folder = entry.path;
        }
    }
    if !unscoped && folder.is_empty() {
        return Ok(json!({ "ok": true, "history": [], "goals": [] }));
    }

    let conv_store = ConversationStore::new(&ctx.config.data_home);
    let conversations = match conv_store.list_conversations_view(&ConversationListQuery {
        workspace_path: None,
        statuses: None,
        roles: None,
        include_message_count: false,
        ..Default::default()
    }) {
        Ok(Value::Array(items)) => items,
        Ok(_) => Vec::new(),
        Err(err) => {
            return Ok(json!({
                "ok": false,
                "code": "CONVERSATION_REQUIRED",
                "message": err.code(),
            }));
        }
    };

    let mut history: Vec<Value> = Vec::new();
    for meta in conversations {
        let Some(id) = meta["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if meta["role"].as_str().is_some_and(|r| !r.trim().is_empty()) {
            continue;
        }
        let status = meta["status"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or("active");
        if status == "archived" {
            continue;
        }
        let conv_folder = meta["workspacePath"].as_str().filter(|s| !s.is_empty());
        if unscoped {
            if conv_folder.is_some() {
                continue;
            }
        } else if conv_folder != Some(folder.as_str()) {
            continue;
        }
        let updated_at = meta["updatedAt"]
            .as_str()
            .filter(|s| !s.is_empty())
            .or_else(|| meta["createdAt"].as_str())
            .unwrap_or("");
        history.push(json!({
            "id": id,
            "title": meta["title"].as_str().unwrap_or(""),
            "workspacePath": conv_folder.map(Value::from).unwrap_or(Value::Null),
            "updatedAt": updated_at,
            "status": status,
        }));
    }
    history.sort_by(|a, b| {
        b["updatedAt"]
            .as_str()
            .unwrap_or("")
            .cmp(a["updatedAt"].as_str().unwrap_or(""))
    });

    let mut goals = Vec::new();
    if !unscoped {
        let history_ids: HashSet<String> = history
            .iter()
            .filter_map(|item| item["id"].as_str().map(str::to_owned))
            .collect();
        for plan in read_all_goal_plans(&ctx.config.data_home) {
            if js_truthy(plan.get("delegationOrigin")) {
                continue;
            }
            let status = plan["status"].as_str().unwrap_or("");
            if TERMINAL_GOAL_STATUSES.contains(&status) {
                continue;
            }
            let Some(plan_id) = plan["planId"].as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let plan_path = plan["targetWorkspacePath"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| {
                    plan["originWorkspacePath"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                })
                .or_else(|| plan["workspacePath"].as_str())
                .unwrap_or("");
            let conv_id = plan["conversationId"].as_str().unwrap_or("");
            let in_workspace =
                plan_path == folder || (!conv_id.is_empty() && history_ids.contains(conv_id));
            if !in_workspace {
                continue;
            }
            let title = plan["title"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| plan["goal"].as_str())
                .unwrap_or("");
            goals.push(json!({
                "planId": plan_id,
                "conversationId": conv_id,
                "title": title,
                "status": status,
                "waitingUser": goal_waits_on_user(&plan),
                "updatedAt": plan["updatedAt"].as_str().unwrap_or(""),
            }));
        }
    }

    Ok(json!({
        "ok": true,
        "history": history,
        "goals": goals,
    }))
}

pub fn handle_bot_search(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let query = params_val
        .get("query")
        .and_then(Value::as_str)
        .unwrap_or("");
    let workspace_id = params_val
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    let limit = params_val
        .get("limit")
        .and_then(Value::as_u64)
        .map(|n| n as usize)
        .unwrap_or(50);

    let data_home = &ctx.config.data_home;
    let supervisor = SessionSupervisor::new(data_home, None);
    let sessions_by_ws = supervisor.list_all_bot_sessions();
    let bot_items = BotDirectory::new(data_home).list(&sessions_by_ws);
    let bots: Vec<Value> = bot_items
        .into_iter()
        .filter_map(|item| serde_json::to_value(item).ok())
        .collect();

    let conv_store = ConversationStore::new(data_home);
    let mut msg_storage: Vec<(String, Value)> = Vec::new();
    for bot in &bots {
        let Some(ws_id) = bot["workspaceId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(conv_id) = bot["profile"]["agentConversationId"]
            .as_str()
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let messages = if let Ok(Some(page)) =
            conv_store.read_conversation_window(conv_id, None, None, true)
        {
            page["window"].as_array().cloned().unwrap_or_default()
        } else {
            conv_store
                .read_committed(conv_id, None, 4 * 1024 * 1024)
                .map(|s| s.history.messages)
                .unwrap_or_default()
        };
        for m in messages {
            msg_storage.push((ws_id.to_owned(), m));
        }
    }
    let msg_refs: Vec<(&str, &Value)> =
        msg_storage.iter().map(|(ws, m)| (ws.as_str(), m)).collect();

    let mut tasks: Vec<Value> = Vec::new();
    for plan in read_all_goal_plans(data_home) {
        let origin = &plan["delegationOrigin"];
        let Some(ws_id) = origin["workspaceId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let Some(session_id) = origin["sessionId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let title = plan["title"].as_str().map(str::trim).unwrap_or("");
        if title.is_empty() {
            continue;
        }
        tasks.push(json!({
            "workspaceId": ws_id,
            "sessionId": session_id,
            "title": title,
            "updatedAt": plan["updatedAt"].as_str().unwrap_or(""),
        }));
    }

    let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
    let memories: Vec<_> = MemoryStore::new(data_home)
        .list(&MemoryFilter {
            scope: None,
            workspace_id: None,
            kind: None,
            status: Some("active"),
        })
        .into_iter()
        .filter(|m| is_effective_memory(m, now_ms))
        .collect();

    let docs = collect_conversation_search_documents(&bots, &msg_refs, &tasks, &memories);
    let hits = ConversationSearchIndex::open_in_memory()
        .and_then(|idx| {
            idx.rebuild(&docs)?;
            idx.search(query, workspace_id, None, limit)
        })
        .unwrap_or_default();

    Ok(json!({ "ok": true, "hits": hits }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_encoder_matches_rfc4648_vectors() {
        assert_eq!(encode_base64(b""), "");
        assert_eq!(encode_base64(b"f"), "Zg==");
        assert_eq!(encode_base64(b"fo"), "Zm8=");
        assert_eq!(encode_base64(b"foo"), "Zm9v");
        assert_eq!(encode_base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(
            encode_base64(&[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            "iVBORw0KGgo="
        );
    }
}
