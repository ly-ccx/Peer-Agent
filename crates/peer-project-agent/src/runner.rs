//! Single-threaded per-workspace ProjectAgentRunner actor (ADR 80, ADR 85, ADR 88, ADR 94).
//!
//! Runs main Bot cognition turns through `peer_runtime::model::NativeModel` and
//! `ProviderRegistry::for_project_agent()` + `EffectAdmission::spawn_read_only_host`,
//! enforces persistent per-provider circuit breaker (`circuit-breaker.json`), retries
//! transient provider errors with bounded backoff, compacts oversized history with
//! canonical `_compaction` markers, streams live activity deltas, persists durable
//! `agent_turn` / `agent_unavailable` records, and logs canonical usage to
//! `usage/requests.jsonl`.

pub use crate::circuit_breaker::CircuitBreaker;
use crate::{
    BotProfileStore, CoordinationHub, InteractiveResultStore, MemoryFilter, MemoryStore,
    ObjectiveStore, ProjectError, ProjectInput, SessionSupervisor, ToolProjectionMode,
    TurnProjectionSignals, UserAnchorCandidate, atomic_write,
    circuit_breaker::{CircuitAdmit, CircuitBreakerStore},
    coordination_work_id, is_effective_memory, is_valid_workspace_id, memory_secret_reason,
    now_iso, parse_iso_ms,
    provider::{ProjectCapabilityProvider, TurnExecutionState},
    skill_packs::{
        ACTIVATE_SKILL_PACK_TOOL, auto_activated_packs, build_allowlist, ordered_definitions,
        render_unactivated_pack_catalog,
    },
    system_context::{ProjectAgentContextInput, assemble_project_agent_context},
};
use peer_protocol::{UsageAmounts, UsagePurpose, build_compaction_marker};
use peer_runtime::{
    CancellationToken, build_compaction_summary_input, build_structural_compaction_summary,
    compaction_summary_prompts,
    model::{
        LiveHistory, ModelDelta, ModelError, ModelTurn, NativeModel, SAME_PROVIDER_RETRY_DELAYS_MS,
        SameProviderRetryPolicy,
    },
    providers::{EffectAdmission, EffectOutcome, ProviderCall, ProviderRegistry, RuntimeMode},
    system_context::instructions::ProjectInstructions,
    tool_markup::{
        has_literal_tool_call_syntax, has_partial_tool_call_prefix, neutralize_tool_call_syntax,
        strip_literal_tool_call_blocks,
    },
    usage_accounting::{RequestMetadata, RuntimeUsageAccounting},
};
use peer_store::{ConversationStore, EvidenceIndexStore, HostToolEvidence};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const USER_MAX_BOT_ROUNDS: usize = 14;
const USER_MAX_BOT_TOOL_CALLS: usize = 28;
const WAKE_MAX_BOT_ROUNDS: usize = 8;
const WAKE_MAX_BOT_TOOL_CALLS: usize = 16;
const MAX_BOT_HISTORY_MESSAGES: usize = 40;
const MAX_STREAM_TEXT_BYTES: usize = 32_000;
const MAX_PUBLIC_UPDATES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentActivity {
    pub workspace_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    pub revision: u64,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub reply_to: Vec<String>,
    pub phase: String,
    pub reply_text: String,
    #[serde(default)]
    pub segments: Vec<Value>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TurnEndKind {
    ReplyCommitted { message_id: String },
    AwaitingChildren { session_ids: Vec<String> },
    Yielded,
    UserStopped,
    CircuitOpen,
    Failed { code: String },
}

#[derive(Debug, Clone)]
pub struct AgentTurnOutcome {
    pub turn_id: String,
    pub end: TurnEndKind,
    pub spawned_session_ids: Vec<String>,
    pub tool_calls: usize,
}

pub struct RunTurnOptions<'a> {
    pub workspace_id: &'a str,
    pub workspace_path: &'a Path,
    pub conversation_id: &'a str,
    pub kind: &'a str,
    pub user_inputs: &'a [ProjectInput],
    pub wake_events: &'a [Value],
    pub worker_model_selection: Value,
    pub holds_lease: bool,
}

type ActivityListener = Arc<dyn Fn(ProjectAgentActivity, String) + Send + Sync>;

pub struct ProjectAgentRunner {
    data_home: PathBuf,
    supervisor: Arc<SessionSupervisor>,
    coordination: Arc<CoordinationHub>,
    breaker_store: CircuitBreakerStore,
    last_workspace_id: Mutex<Option<String>>,
    retry_delays_ms: Mutex<Vec<u64>>,
    projection_mode: Mutex<ToolProjectionMode>,
    activities: Mutex<HashMap<String, ProjectAgentActivity>>,
    statuses: Mutex<HashMap<String, String>>,
    activity_listener: Mutex<Option<ActivityListener>>,
}

impl ProjectAgentRunner {
    pub fn new(data_home: impl AsRef<Path>, supervisor: Arc<SessionSupervisor>) -> Self {
        Self::with_coordination(data_home, supervisor, Arc::new(CoordinationHub::new()))
    }

    pub fn with_coordination(
        data_home: impl AsRef<Path>,
        supervisor: Arc<SessionSupervisor>,
        coordination: Arc<CoordinationHub>,
    ) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            breaker_store: CircuitBreakerStore::new(&home),
            data_home: home,
            supervisor,
            coordination,
            last_workspace_id: Mutex::new(None),
            retry_delays_ms: Mutex::new(SAME_PROVIDER_RETRY_DELAYS_MS.to_vec()),
            projection_mode: Mutex::new(ToolProjectionMode::from_env()),
            activities: Mutex::new(HashMap::new()),
            statuses: Mutex::new(HashMap::new()),
            activity_listener: Mutex::new(None),
        }
    }

    pub fn set_projection_mode(&self, mode: ToolProjectionMode) {
        if let Ok(mut guard) = self.projection_mode.lock() {
            *guard = mode;
        }
    }

    pub fn projection_mode(&self) -> ToolProjectionMode {
        self.projection_mode
            .lock()
            .map(|g| *g)
            .unwrap_or(ToolProjectionMode::Progressive)
    }

    pub fn current_activity(&self) -> Option<ProjectAgentActivity> {
        let ws = self.last_workspace_id.lock().ok().and_then(|g| g.clone())?;
        self.activity_for(&ws)
    }

    pub fn activity_for(&self, workspace_id: &str) -> Option<ProjectAgentActivity> {
        self.activities
            .lock()
            .ok()
            .and_then(|g| g.get(workspace_id).cloned())
    }

    pub fn status_for(&self, workspace_id: &str) -> Option<String> {
        self.statuses
            .lock()
            .ok()
            .and_then(|g| g.get(workspace_id).cloned())
    }

    pub fn set_activity_listener(&self, listener: Option<ActivityListener>) {
        if let Ok(mut guard) = self.activity_listener.lock() {
            *guard = listener;
        }
    }

    /// Override transient retry backoff delays (primarily for deterministic fast tests).
    pub fn set_retry_delays_ms(&self, delays: Vec<u64>) {
        if let Ok(mut guard) = self.retry_delays_ms.lock() {
            *guard = delays;
        }
    }

    pub fn reset_circuit_breaker_for(&self, workspace_id: &str) {
        let _ = self.breaker_store.reset_manual(workspace_id);
    }

    pub fn reset_circuit_breaker(&self) {
        if let Ok(guard) = self.last_workspace_id.lock()
            && let Some(ws_id) = guard.as_deref()
        {
            let _ = self.breaker_store.reset_manual(ws_id);
        }
    }

    fn status_for_phase(phase: &str) -> &'static str {
        match phase {
            "error" => "error",
            "done" | "stopped" | "idle" => "idle",
            "waiting" | "waiting_provider" => "waiting_provider",
            _ => "thinking",
        }
    }

    fn init_activity(&self, activity: ProjectAgentActivity) {
        let status = Self::status_for_phase(&activity.phase).to_owned();
        let ws = activity.workspace_id.clone();
        if let Ok(mut guard) = self.activities.lock() {
            guard.insert(ws.clone(), activity.clone());
        }
        if let Ok(mut guard) = self.statuses.lock() {
            guard.insert(ws, status.clone());
        }
        let listener = self.activity_listener.lock().ok().and_then(|g| g.clone());
        if let Some(cb) = listener {
            cb(activity, status);
        }
    }

    fn update_activity(&self, workspace_id: &str, update: impl FnOnce(&mut ProjectAgentActivity)) {
        let updated = if let Ok(mut guard) = self.activities.lock()
            && let Some(act) = guard.get_mut(workspace_id)
        {
            act.revision += 1;
            update(act);
            Some(act.clone())
        } else {
            None
        };
        if let Some(act) = updated {
            let status = Self::status_for_phase(&act.phase).to_owned();
            if let Ok(mut guard) = self.statuses.lock() {
                guard.insert(workspace_id.to_owned(), status.clone());
            }
            let listener = self.activity_listener.lock().ok().and_then(|g| g.clone());
            if let Some(cb) = listener {
                cb(act, status);
            }
        }
    }

    fn set_activity_phase(
        &self,
        workspace_id: &str,
        phase: &str,
        text: Option<&str>,
        finished: bool,
    ) {
        self.update_activity(workspace_id, |act| {
            act.phase = phase.to_owned();
            if let Some(t) = text {
                act.reply_text = clip_utf8_bytes(t, MAX_STREAM_TEXT_BYTES).to_owned();
            }
            if finished {
                act.finished_at = Some(now_iso());
            }
        });
    }

    fn set_status_only(&self, workspace_id: &str, status: &str) {
        if let Ok(mut guard) = self.statuses.lock() {
            guard.insert(workspace_id.to_owned(), status.to_owned());
        }
    }

    fn dispose_activity(&self, workspace_id: &str) {
        let disposed = if let Ok(mut guard) = self.activities.lock()
            && let Some(mut act) = guard.remove(workspace_id)
        {
            act.revision += 1;
            act.phase = "disposed".to_owned();
            act.reply_text.clear();
            act.segments.clear();
            act.finished_at = Some(now_iso());
            Some(act)
        } else {
            None
        };
        self.set_status_only(workspace_id, "idle");
        if let Some(act) = disposed {
            let listener = self.activity_listener.lock().ok().and_then(|g| g.clone());
            if let Some(cb) = listener {
                cb(act, "idle".to_owned());
            }
        }
    }

    fn record_activity_tool_start(
        &self,
        workspace_id: &str,
        call_id: &str,
        name: &str,
        summary: Option<&str>,
        started_at: &str,
    ) {
        const MAX_ACTIVITY_SEGMENTS: usize = 100;
        self.update_activity(workspace_id, |act| {
            act.phase = "tool".to_owned();
            if act.segments.len() < MAX_ACTIVITY_SEGMENTS {
                let mut seg = json!({
                    "kind": "tool",
                    "id": call_id,
                    "name": name,
                    "status": "running",
                    "startedAt": started_at,
                });
                if let Some(s) = summary.filter(|s| !s.is_empty()) {
                    seg["summary"] = json!(s);
                }
                act.segments.push(seg);
            }
        });
    }

    fn record_activity_tool_finish(
        &self,
        workspace_id: &str,
        call_id: &str,
        ok: bool,
        finished_at: &str,
    ) {
        let status = if ok { "done" } else { "error" };
        self.update_activity(workspace_id, |act| {
            if let Some(seg) = act
                .segments
                .iter_mut()
                .rev()
                .find(|s| s["id"].as_str() == Some(call_id))
            {
                seg["status"] = json!(status);
                seg["finishedAt"] = json!(finished_at);
            }
        });
    }

    fn record_turn_failure(
        &self,
        ctx: &TurnFailureCtx<'_>,
        code: &'static str,
        cancel: &CancellationToken,
    ) -> TurnEndKind {
        if cancel.is_cancelled() || code == "CANCELLED" {
            let _ = self
                .breaker_store
                .abandon_trial(ctx.workspace_id, Some(ctx.provider_scope));
            return TurnEndKind::UserStopped;
        }
        let outcome = self.breaker_store.record_failure(
            ctx.workspace_id,
            ctx.turn_id,
            code,
            Some(ctx.provider_scope),
            None,
            ctx.now_ms,
        );
        let (tripped, open_until) = match outcome {
            Ok(out) => (out.tripped, out.open_until),
            Err(_) => (false, None),
        };
        let (content, meta) = if tripped {
            (
                "代理连续失败，已暂停自动推进。十分钟后再试，也可以现在手动重试。".to_owned(),
                json!({ "circuitOpenUntil": open_until }),
            )
        } else {
            (
                format!("代理暂时不可用：{code}"),
                json!({ "errorCode": code }),
            )
        };
        let at = now_iso();
        let _ = ctx.conv_store.append_message_idempotent(
            ctx.conversation_id,
            &json!({
                "id": format!("{}-card", ctx.turn_id),
                "role": "assistant",
                "kind": "system_card",
                "card": "agent_unavailable",
                "turnId": ctx.turn_id,
                "content": content,
                "actions": ["retry"],
                "meta": meta,
                "cards": [{
                    "cardId": format!("card:agent_unavailable:{}", ctx.turn_id),
                    "kind": "agent_unavailable",
                    "content": content,
                    "actions": [{
                        "id": "retry",
                        "channel": "project-agent:retry",
                        "payload": {
                            "workspaceId": ctx.workspace_id,
                            "turnId": ctx.turn_id,
                        }
                    }]
                }],
                "createdAt": at,
            }),
            &at,
            None,
        );
        TurnEndKind::Failed {
            code: code.to_owned(),
        }
    }
}

struct TurnFailureCtx<'a> {
    conv_store: &'a ConversationStore,
    workspace_id: &'a str,
    conversation_id: &'a str,
    turn_id: &'a str,
    provider_scope: &'a str,
    now_ms: i64,
}

fn activity_tool_summary(name: &str, args: &Value) -> Option<String> {
    if name == "post_reply" {
        return None;
    }
    let candidate = match name {
        "read_file" | "read_files" | "list_files" | "list_directory" | "view_image"
        | "read_image" | "analyze_image" | "edit_file" | "write_file" => {
            args["path"].as_str().or_else(|| args["file"].as_str())
        }
        "search_files" | "search_conversation" => {
            args["query"].as_str().or_else(|| args["path"].as_str())
        }
        "git_query" => args["path"]
            .as_str()
            .filter(|s| {
                let t = s.trim();
                !t.is_empty() && t != "."
            })
            .or_else(|| args["operation"].as_str())
            .or_else(|| args["query"].as_str())
            .or_else(|| args["kind"].as_str())
            .or_else(|| args["op"].as_str()),
        _ => None,
    }?;
    let trimmed = candidate.trim();
    if trimmed.is_empty()
        || trimmed.chars().any(char::is_control)
        || memory_secret_reason(trimmed).is_some()
    {
        return None;
    }
    Some(trimmed.chars().take(160).collect())
}

fn compact_persisted_value(value: &Value, key: Option<&str>, depth: usize) -> Value {
    const MAX_STRING_CHARS: usize = 2_000;
    const MAX_ARRAY_ITEMS: usize = 25;
    const PROTECTED_KEYS: [&str; 12] = [
        "path",
        "kind",
        "tool",
        "status",
        "error",
        "reason",
        "sessionId",
        "planId",
        "messageId",
        "conversationId",
        "evidenceRef",
        "verdictRef",
    ];
    if depth >= 6 {
        return value.clone();
    }
    match value {
        Value::String(s) => {
            if key.is_some_and(|k| PROTECTED_KEYS.contains(&k))
                || s.chars().count() <= MAX_STRING_CHARS
            {
                Value::String(s.clone())
            } else {
                let clipped: String = s.chars().take(MAX_STRING_CHARS).collect();
                Value::String(format!("{clipped}…[truncated]"))
            }
        }
        Value::Array(items) => {
            let compacted: Vec<Value> = items
                .iter()
                .take(MAX_ARRAY_ITEMS)
                .map(|item| compact_persisted_value(item, None, depth + 1))
                .collect();
            Value::Array(compacted)
        }
        Value::Object(map) => {
            let mut out = serde_json::Map::with_capacity(map.len());
            for (k, v) in map {
                let compacted = compact_persisted_value(v, Some(k.as_str()), depth + 1);
                if let (Value::Array(orig), Value::Array(kept)) = (v, &compacted)
                    && orig.len() > kept.len()
                {
                    out.insert(format!("{k}TruncatedCount"), json!(orig.len()));
                }
                out.insert(k.clone(), compacted);
            }
            Value::Object(out)
        }
        _ => value.clone(),
    }
}

/// Compact oversized tool outputs before persisting them into `agent_turn` JSONL rows
/// so conversation history does not balloon across turns while keeping small payloads
/// and structural navigation/status fields intact.
fn compact_persisted_tool_result(value: &Value) -> Value {
    const COMPACT_THRESHOLD_BYTES: usize = 4_096;
    if serde_json::to_string(value).map_or(0, |s| s.len()) <= COMPACT_THRESHOLD_BYTES {
        return value.clone();
    }
    compact_persisted_value(value, None, 0)
}

fn clip_utf8_bytes(s: &str, max_bytes: usize) -> &str {
    if s.len() <= max_bytes {
        return s;
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    &s[..end]
}

fn format_tool_outcome_output(outcome: &EffectOutcome) -> Value {
    if outcome.status == "success" {
        return outcome.output.clone();
    }
    if let Some(obj) = outcome.output.as_object()
        && !obj.is_empty()
    {
        let mut out = obj.clone();
        if let Some(code) = outcome.error
            && !out.contains_key("error")
            && !out.contains_key("reason")
        {
            out.insert("ok".to_owned(), json!(false));
            out.insert("error".to_owned(), json!(code));
        }
        return Value::Object(out);
    }
    json!({
        "ok": false,
        "status": outcome.status,
        "error": outcome.error.unwrap_or("tool_failed"),
    })
}

fn redact_continuity_text(text: &str, max_chars: usize) -> String {
    let stripped = strip_literal_tool_call_blocks(text);
    let trimmed = stripped.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    if memory_secret_reason(trimmed).is_some() {
        return "[REDACTED]".to_owned();
    }
    trimmed.chars().take(max_chars).collect()
}

fn is_safe_turn_trace_id(turn_id: &str) -> bool {
    let trimmed = turn_id.trim();
    !trimmed.is_empty()
        && trimmed.len() <= 200
        && !trimmed.contains(['/', '\\', '\0'])
        && !trimmed.contains("..")
}

fn turn_trace_path(data_home: &Path, workspace_id: &str, turn_id: &str) -> Option<PathBuf> {
    if !is_valid_workspace_id(workspace_id) || !is_safe_turn_trace_id(turn_id) {
        return None;
    }
    Some(
        data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("turns")
            .join(format!("{}.json", turn_id.trim())),
    )
}

fn write_agent_turn_trace(
    data_home: &Path,
    workspace_id: &str,
    turn_id: &str,
    rounds: &[Value],
    public_updates: &[Value],
    diagnostic_timing: &Value,
) -> bool {
    let Some(path) = turn_trace_path(data_home, workspace_id, turn_id) else {
        return false;
    };
    let payload = json!({
        "schemaVersion": 1,
        "turnId": turn_id,
        "rounds": rounds,
        "publicUpdates": public_updates,
        "diagnosticTiming": diagnostic_timing,
    });
    let Ok(bytes) = serde_json::to_vec(&payload) else {
        return false;
    };
    atomic_write(&path, &bytes).is_ok()
}

/// Hydrate an offloaded `agent_turn` stub (`traceRef`) with its persisted `rounds` and
/// `publicUpdates` from `project-runtime/<workspaceId>/turns/<turnId>.json`.
/// Legacy inline `agent_turn` rows (without `traceRef` or already carrying `rounds`) are untouched.
pub fn hydrate_agent_turn_record(data_home: &Path, workspace_id: &str, msg: &mut Value) {
    if msg["kind"].as_str() != Some("agent_turn") {
        return;
    }
    let needs_rounds = msg.get("rounds").is_none_or(Value::is_null);
    let needs_updates = msg.get("publicUpdates").is_none_or(Value::is_null);
    if !needs_rounds && !needs_updates {
        return;
    }
    let Some(trace_ref) = msg["traceRef"]
        .as_str()
        .or_else(|| msg["turnId"].as_str())
        .or_else(|| msg["id"].as_str())
        .filter(|s| !s.is_empty())
    else {
        return;
    };
    let Some(path) = turn_trace_path(data_home, workspace_id, trace_ref) else {
        return;
    };
    let Ok(raw) = std::fs::read(&path) else {
        return;
    };
    let Ok(trace) = serde_json::from_slice::<Value>(&raw) else {
        return;
    };
    if let Some(obj) = msg.as_object_mut() {
        if needs_rounds && let Some(rounds) = trace.get("rounds").filter(|v| v.is_array()) {
            obj.insert("rounds".to_owned(), rounds.clone());
        }
        if needs_updates && let Some(updates) = trace.get("publicUpdates").filter(|v| v.is_array())
        {
            obj.insert("publicUpdates".to_owned(), updates.clone());
        }
    }
}

/// Reconstruct factual continuity from the latest stopped/failed `agent_turn` for
/// `current_input_anchors` (before any answering `agent_reply`).
pub fn read_retry_continuity(
    messages: &[Value],
    current_input_anchors: &[String],
    exclude_turn_id: Option<&str>,
) -> Option<Value> {
    read_retry_continuity_in(None, None, messages, current_input_anchors, exclude_turn_id)
}

fn read_retry_continuity_in(
    data_home: Option<&Path>,
    workspace_id: Option<&str>,
    messages: &[Value],
    current_input_anchors: &[String],
    exclude_turn_id: Option<&str>,
) -> Option<Value> {
    if current_input_anchors.is_empty() {
        return None;
    }
    let anchor_set: HashSet<&str> = current_input_anchors.iter().map(String::as_str).collect();
    let mut found_turn: Option<Value> = None;
    for msg in messages.iter().rev() {
        let kind = msg["kind"].as_str().unwrap_or("");
        if kind == "agent_reply" {
            let overlaps = msg["replyTo"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .any(|a| anchor_set.contains(a));
            if overlaps {
                return None;
            }
            continue;
        }
        if kind != "agent_turn" {
            continue;
        }
        let tid = msg["turnId"]
            .as_str()
            .or_else(|| msg["id"].as_str())
            .unwrap_or("");
        if exclude_turn_id.is_some_and(|ex| ex == tid) {
            continue;
        }
        let outcome = msg["meta"]["diagnosticTiming"]["outcome"]
            .as_str()
            .unwrap_or("");
        if !matches!(outcome, "stopped" | "error") {
            continue;
        }
        let overlaps = msg["userInputs"]
            .as_array()
            .or_else(|| msg["replyTo"].as_array())
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|a| anchor_set.contains(a));
        if overlaps {
            let mut cloned = msg.clone();
            if let (Some(home), Some(ws)) = (data_home, workspace_id) {
                hydrate_agent_turn_record(home, ws, &mut cloned);
            }
            found_turn = Some(cloned);
            break;
        }
    }
    let turn = found_turn?;
    let prev_turn_id = turn["turnId"]
        .as_str()
        .or_else(|| turn["id"].as_str())
        .unwrap_or("")
        .to_owned();
    let outcome = turn["meta"]["diagnosticTiming"]["outcome"]
        .as_str()
        .unwrap_or("stopped")
        .to_owned();

    let card_partial = messages
        .iter()
        .rev()
        .find(|m| {
            m["kind"] == "system_card"
                && m["card"] == "agent_stopped"
                && m["turnId"].as_str() == Some(prev_turn_id.as_str())
        })
        .and_then(|m| m["partialReply"].as_str())
        .map(|s| redact_continuity_text(s, 1200))
        .filter(|s| !s.is_empty());

    let raw_partial = card_partial
        .or_else(|| {
            turn["publicUpdates"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .filter_map(|u| u["text"].as_str())
                .map(|s| redact_continuity_text(s, 1200))
                .find(|s| !s.is_empty())
        })
        .or_else(|| {
            turn["rounds"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .filter_map(|r| r["text"].as_str())
                .map(|s| redact_continuity_text(s, 1200))
                .find(|s| !s.is_empty())
        })
        .unwrap_or_default();

    let mut completed_tools = Vec::new();
    for round in turn["rounds"].as_array().into_iter().flatten() {
        for tc in round["toolCalls"].as_array().into_iter().flatten() {
            if completed_tools.len() >= 16 {
                break;
            }
            let name = tc["name"].as_str().unwrap_or("");
            if name.is_empty() {
                continue;
            }
            let ok = tc["result"]["ok"] == true;
            let raw_summary = tc["result"]["error"]
                .as_str()
                .or_else(|| tc["result"]["status"].as_str())
                .unwrap_or(if ok { "ok" } else { "failed" });
            completed_tools.push(json!({
                "name": name,
                "ok": ok,
                "summary": redact_continuity_text(raw_summary, 200),
            }));
        }
    }
    if completed_tools.is_empty()
        && let Some(summary_arr) = turn["meta"]["completedToolsSummary"].as_array()
    {
        for item in summary_arr.iter().take(16) {
            if item["name"].as_str().is_some_and(|n| !n.is_empty()) {
                completed_tools.push(item.clone());
            }
        }
    }

    Some(json!({
        "previousTurnId": prev_turn_id,
        "outcome": outcome,
        "partialReply": raw_partial,
        "completedTools": completed_tools,
        "note": "Continue from this factual continuity without repeating already-committed side effects.",
    }))
}

fn compaction_marker(msg: &Value) -> Option<&Value> {
    msg.get("_compaction")
        .filter(|v| v.is_object())
        .or_else(|| msg.get("compaction").filter(|v| v.is_object()))
}

struct LoadedBotHistory {
    continuity_summary: Option<String>,
    compaction_epoch: u64,
    live_messages: Vec<Value>,
    committed_message_ids: Vec<Option<String>>,
}

fn load_bot_history(history_messages: &[Value]) -> LoadedBotHistory {
    let mut continuity_summary = None;
    let mut compaction_epoch = 0u64;
    let selected: Vec<&Value> = if let Some(boundary) = history_messages
        .iter()
        .rposition(|m| compaction_marker(m).is_some())
    {
        let marker = compaction_marker(&history_messages[boundary]).unwrap();
        continuity_summary = [
            marker["summary"].as_str(),
            marker["handoffContent"].as_str(),
            history_messages[boundary]["content"].as_str(),
        ]
        .into_iter()
        .flatten()
        .map(str::trim)
        .find(|s| !s.is_empty())
        .map(str::to_owned);
        compaction_epoch = marker["historySelection"]["compactionEpoch"]
            .as_u64()
            .unwrap_or(0);

        let mut out = Vec::new();
        if let Some(retained_ids) = marker["historySelection"]["retainedMessageIds"].as_array() {
            let wanted: HashSet<&str> = retained_ids.iter().filter_map(Value::as_str).collect();
            for msg in &history_messages[..boundary] {
                if let Some(id) = msg["id"].as_str()
                    && wanted.contains(id)
                {
                    out.push(msg);
                }
            }
        }
        out.extend(history_messages[boundary + 1..].iter());
        out
    } else {
        history_messages.iter().collect()
    };

    let filtered: Vec<&Value> = selected
        .into_iter()
        .filter(|m| {
            compaction_marker(m).is_none()
                && !matches!(m["kind"].as_str(), Some("agent_turn" | "system_card"))
                && matches!(m["role"].as_str(), Some("user" | "assistant"))
                && (!m["content"].as_str().unwrap_or("").trim().is_empty()
                    || (m["role"].as_str() == Some("user")
                        && m["attachments"].as_array().is_some_and(|a| !a.is_empty())))
        })
        .rev()
        .take(MAX_BOT_HISTORY_MESSAGES)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();

    let mut live_messages = Vec::with_capacity(filtered.len());
    let mut committed_message_ids = Vec::with_capacity(filtered.len());
    for m in filtered {
        if m["role"].as_str() == Some("user") {
            if let Some(projected) = crate::attachments::project_user_message_for_model(m) {
                live_messages.push(projected);
                committed_message_ids.push(m["id"].as_str().map(str::to_owned));
            }
        } else {
            let raw = m["content"].as_str().unwrap_or("");
            let cleaned = neutralize_tool_call_syntax(&strip_literal_tool_call_blocks(raw));
            if cleaned.trim().is_empty() {
                continue;
            }
            live_messages.push(json!({
                "role": m["role"],
                "content": cleaned,
            }));
            committed_message_ids.push(m["id"].as_str().map(str::to_owned));
        }
    }

    LoadedBotHistory {
        continuity_summary,
        compaction_epoch,
        live_messages,
        committed_message_ids,
    }
}

fn prepare_summary_messages(messages: &[Value]) -> Vec<Value> {
    let mut expanded = Vec::new();
    let mut tool_calls_by_id = HashSet::new();
    for msg in messages {
        match msg["role"].as_str() {
            Some("user") => {
                if let Some(parts) = msg["content"].as_array() {
                    let mut text_parts = Vec::new();
                    let mut img_count = 0usize;
                    for p in parts {
                        if let Some(t) = p["text"].as_str() {
                            text_parts.push(t.to_owned());
                        } else if p["type"] == "image_url" {
                            img_count += 1;
                        }
                    }
                    if img_count > 0 {
                        text_parts.push(format!("[{img_count} image attachment(s)]"));
                    }
                    expanded.push(json!({ "role": "user", "content": text_parts.join("\n") }));
                } else {
                    expanded.push(msg.clone());
                }
            }
            Some("assistant") => {
                if let Some(calls) = msg["toolCalls"].as_array().filter(|a| !a.is_empty()) {
                    if let Some(txt) = msg["content"].as_str().filter(|s| !s.trim().is_empty()) {
                        expanded.push(json!({ "role": "assistant", "content": txt }));
                    }
                    // Group::project requires each tool message to pair cleanly 1:1 with a
                    // single-call assistant record; record all calls before matching later tool rows.
                    for call in calls {
                        if let Some(id) = call["id"].as_str() {
                            tool_calls_by_id.insert(id.to_owned());
                        }
                        expanded.push(json!({
                            "role": "assistant",
                            "content": Value::Null,
                            "toolCalls": [call.clone()],
                        }));
                    }
                } else {
                    expanded.push(msg.clone());
                }
            }
            Some("tool") => {
                let id = msg["toolCallId"].as_str().unwrap_or("");
                if !id.is_empty() && tool_calls_by_id.contains(id) {
                    // Reorder any interleaved tool responses directly behind their single call.
                    if let Some(pos) = expanded.iter().rposition(|entry| {
                        entry["role"] == "assistant"
                            && entry["toolCalls"][0]["id"].as_str() == Some(id)
                    }) {
                        expanded.insert(pos + 1, msg.clone());
                    }
                }
            }
            _ => {}
        }
    }
    // Strip any assistant tool call without a paired tool response so Group::project stays valid.
    let present_tools: HashSet<String> = expanded
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["toolCallId"].as_str().map(str::to_owned))
        .collect();
    expanded
        .into_iter()
        .filter(|m| {
            !(m["role"] == "assistant"
                && m["toolCalls"]
                    .as_array()
                    .and_then(|a| a.first())
                    .and_then(|c| c["id"].as_str())
                    .is_some_and(|id| !present_tools.contains(id)))
        })
        .collect()
}

fn record_attempt_usage(
    accounting: &mut RuntimeUsageAccounting,
    result: &Result<ModelTurn, ModelError>,
    capacity_bearing: bool,
) {
    match result {
        Ok(turn) => {
            let _ = accounting.observe(
                turn.usage_amounts(),
                RequestMetadata {
                    fingerprint: Some(&turn.request_fingerprint),
                    purpose: UsagePurpose::Agent,
                    capacity_bearing,
                },
            );
        }
        Err(err) => {
            if let Some(obs) = err.observation.as_deref() {
                let _ = accounting.observe(
                    obs.usage.clone(),
                    RequestMetadata {
                        fingerprint: Some(&obs.request_fingerprint),
                        purpose: UsagePurpose::Agent,
                        capacity_bearing,
                    },
                );
            }
        }
    }
}

fn clip_chars(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

fn format_synthesis_observations(entries: &[String]) -> String {
    const MAX_OBSERVATIONS_BYTES: usize = 24 * 1024;
    let mut kept_rev: Vec<&str> = Vec::new();
    let mut used = 0usize;
    for entry in entries.iter().rev() {
        let len = entry.len() + 1;
        if !kept_rev.is_empty() && used + len > MAX_OBSERVATIONS_BYTES {
            break;
        }
        used += len;
        kept_rev.push(entry.as_str());
    }
    kept_rev.reverse();
    let omitted = entries.len().saturating_sub(kept_rev.len());
    let mut lines = vec![
        "[Tool execution observations from this turn — read-only context; tools are now disabled]"
            .to_owned(),
    ];
    if omitted > 0 {
        lines.push(format!("[Earlier tool observations omitted: {omitted}]"));
    }
    lines.extend(kept_rev.into_iter().map(str::to_owned));
    lines.push("[/Tool execution observations]".to_owned());
    lines.join("\n")
}

fn flatten_history_for_prose_synthesis(messages: &[Value]) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut call_meta: HashMap<String, (String, String)> = HashMap::new();
    let mut pending_observations: Vec<String> = Vec::new();

    let flush_observations = |out: &mut Vec<Value>, obs: &mut Vec<String>| {
        if obs.is_empty() {
            return;
        }
        let body = format_synthesis_observations(obs);
        obs.clear();
        out.push(json!({
            "role": "user",
            "content": body,
        }));
    };

    for msg in messages {
        match msg["role"].as_str() {
            Some("user") => {
                flush_observations(&mut out, &mut pending_observations);
                out.push(msg.clone());
            }
            Some("assistant") => {
                if let Some(calls) = msg["toolCalls"].as_array().filter(|a| !a.is_empty()) {
                    for call in calls {
                        let id = call["id"].as_str().unwrap_or("");
                        let name = call["name"].as_str().unwrap_or("unknown").to_owned();
                        let args = clip_chars(
                            &neutralize_tool_call_syntax(&strip_literal_tool_call_blocks(
                                call["arguments"].as_str().unwrap_or("{}"),
                            )),
                            240,
                        );
                        if !id.is_empty() {
                            call_meta.insert(id.to_owned(), (name, args));
                        }
                    }
                }
                if let Some(raw) = msg["content"].as_str() {
                    let cleaned = neutralize_tool_call_syntax(&strip_literal_tool_call_blocks(raw));
                    if !cleaned.trim().is_empty() {
                        flush_observations(&mut out, &mut pending_observations);
                        out.push(json!({
                            "role": "assistant",
                            "content": cleaned,
                        }));
                    }
                }
            }
            Some("tool") => {
                let id = msg["toolCallId"].as_str().unwrap_or("");
                let (name, args) = call_meta.get(id).cloned().unwrap_or_else(|| {
                    (
                        msg["name"].as_str().unwrap_or("tool").to_owned(),
                        "{}".to_owned(),
                    )
                });
                let raw_out = msg["content"].as_str().unwrap_or("");
                let cleaned_out = clip_chars(
                    &neutralize_tool_call_syntax(&strip_literal_tool_call_blocks(raw_out)),
                    1200,
                );
                pending_observations.push(format!("- {name}({args}) => {cleaned_out}"));
            }
            _ => {}
        }
    }
    flush_observations(&mut out, &mut pending_observations);
    out
}

fn estimate_prompt_chars(system_prompt: &str, messages: &[Value]) -> usize {
    let mut total = system_prompt.len();
    for msg in messages {
        total += msg.to_string().len();
    }
    total
}

fn persist_fallback_reply(
    conv_store: &ConversationStore,
    conversation_id: &str,
    turn_id: &str,
    current_input_anchors: &[String],
    text: &str,
) -> Result<String, peer_store::StoreError> {
    let msg_id = format!("reply-{turn_id}");
    let at = now_iso();
    conv_store.append_message_idempotent(
        conversation_id,
        &json!({
            "id": msg_id,
            "role": "assistant",
            "kind": "agent_reply",
            "content": text,
            "replyTo": current_input_anchors,
            "sources": [],
            "fallback": true,
            "turnId": turn_id,
            "createdAt": at,
            "meta": {
                "replyTo": current_input_anchors,
                "sources": [],
                "memoryUsed": [],
                "memoryLearned": [],
                "surfacing": "message",
            },
            "marks": [],
        }),
        &at,
        None,
    )?;
    Ok(msg_id)
}

fn push_public_update(updates: &mut Vec<Value>, total_chars: &mut usize, text: &str) {
    let trimmed = text.trim();
    if trimmed.is_empty()
        || updates.len() >= MAX_PUBLIC_UPDATES
        || *total_chars >= MAX_STREAM_TEXT_BYTES
    {
        return;
    }
    let remaining = MAX_STREAM_TEXT_BYTES - *total_chars;
    let clipped: String = trimmed.chars().take(remaining).collect();
    if clipped.is_empty() {
        return;
    }
    *total_chars += clipped.chars().count();
    let role = if updates.is_empty() {
        "opening"
    } else {
        "narration"
    };
    updates.push(json!({
        "id": format!("text-{}", updates.len() + 1),
        "role": role,
        "text": clipped,
    }));
}

struct TurnCompactionOutcome {
    summary: String,
    compaction_epoch: u64,
}

impl ProjectAgentRunner {
    #[allow(clippy::too_many_arguments)]
    async fn call_model_with_retry(
        &self,
        model: &NativeModel,
        workspace_id: &str,
        conversation_id: &str,
        system_prompt: &str,
        live_messages: &[Value],
        tools_json: &Value,
        live: &LiveHistory,
        accounting: &mut RuntimeUsageAccounting,
        cancel: &CancellationToken,
    ) -> Result<ModelTurn, ModelError> {
        let delays = self
            .retry_delays_ms
            .lock()
            .map(|g| g.clone())
            .unwrap_or_else(|_| SAME_PROVIDER_RETRY_DELAYS_MS.to_vec());
        let mut policy = SameProviderRetryPolicy::with_delays_ms(delays);
        loop {
            if cancel.is_cancelled() {
                return Err(ModelError::new("CANCELLED"));
            }
            let stream_state = Arc::new(Mutex::new((String::new(), false)));
            let stream_text_to_activity = tools_json.as_array().is_none_or(|a| a.is_empty());
            let result = model
                .turn_with_materialized_history_and_deltas(
                    &self.data_home,
                    conversation_id,
                    system_prompt,
                    &json!({"messages": live_messages}),
                    tools_json,
                    live,
                    cancel,
                    async |delta| {
                        match delta {
                            ModelDelta::Thinking(_) => {
                                self.set_activity_phase(workspace_id, "thinking", None, false);
                            }
                            ModelDelta::Text(chunk) => {
                                if !stream_text_to_activity {
                                    // Dual-channel isolation: companion prose emitted during
                                    // tool-enabled rounds is internal scratchpad, never streamed
                                    // into the user-facing reply bubble.
                                    self.set_activity_phase(workspace_id, "thinking", None, false);
                                } else if !chunk.is_empty()
                                    && let Ok(mut state) = stream_state.lock()
                                {
                                    let avail = MAX_STREAM_TEXT_BYTES.saturating_sub(state.0.len());
                                    if avail > 0 {
                                        state.0.push_str(clip_utf8_bytes(chunk, avail));
                                    }
                                    if !state.1 && has_literal_tool_call_syntax(&state.0) {
                                        state.1 = true;
                                        let clean = strip_literal_tool_call_blocks(&state.0);
                                        if clean.is_empty() {
                                            self.set_activity_phase(
                                                workspace_id,
                                                "thinking",
                                                Some(""),
                                                false,
                                            );
                                        } else {
                                            self.set_activity_phase(
                                                workspace_id,
                                                "responding",
                                                Some(&clean),
                                                false,
                                            );
                                        }
                                    } else if !state.1 && !has_partial_tool_call_prefix(&state.0) {
                                        self.set_activity_phase(
                                            workspace_id,
                                            "responding",
                                            Some(&state.0),
                                            false,
                                        );
                                    }
                                }
                            }
                        }
                        Ok(())
                    },
                )
                .await;
            record_attempt_usage(accounting, &result, true);
            match result {
                Ok(turn) => return Ok(turn),
                Err(err) => {
                    let delay = match policy.next_delay(&err) {
                        Ok(Some(d)) => d,
                        Ok(None) => return Err(err),
                        Err(code) => return Err(ModelError::new(code)),
                    };
                    // Discard any partial text emitted before retrying so the live pane resets cleanly.
                    self.set_activity_phase(workspace_id, "waiting", Some(""), false);
                    tokio::select! {
                        biased;
                        _ = cancel.cancelled() => return Err(ModelError::new("CANCELLED")),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
            }
        }
    }

    #[allow(clippy::too_many_arguments)]
    async fn compact_bot_history(
        &self,
        model: &NativeModel,
        conv_store: &ConversationStore,
        conversation_id: &str,
        continuity_summary: Option<&str>,
        compaction_epoch: &mut u64,
        live_messages: &mut Vec<Value>,
        committed_ids: &mut Vec<Option<String>>,
        accounting: &mut RuntimeUsageAccounting,
        cancel: &CancellationToken,
    ) -> Result<Option<TurnCompactionOutcome>, ModelError> {
        let Some(last_user_idx) = live_messages.iter().rposition(|m| m["role"] == "user") else {
            return Ok(None);
        };
        let split_at = if last_user_idx > 0 {
            last_user_idx
        } else {
            // Same-turn tool-loop overflow: retain initial user prompt and latest round pair.
            let Some(tail_start) = live_messages[1..]
                .iter()
                .rposition(|m| m["role"] == "assistant")
                .map(|i| i + 1)
                .filter(|&idx| idx > 1)
            else {
                return Ok(None);
            };
            tail_start
        };
        let old_slice = if last_user_idx > 0 {
            live_messages[..split_at].to_vec()
        } else {
            live_messages[1..split_at].to_vec()
        };
        let summary_msgs = prepare_summary_messages(&old_slice);
        if summary_msgs.is_empty() {
            return Ok(None);
        }
        let continuity_val = continuity_summary.map(|s| json!({ "summary": s }));
        let Ok(input) = build_compaction_summary_input(continuity_val.as_ref(), summary_msgs)
        else {
            return Ok(None);
        };

        let (method, summary) = match compaction_summary_prompts() {
            Ok((sys, prompt)) => {
                let summary_hist = json!({
                    "messages": [{
                        "role": "user",
                        "content": format!("{prompt}\n\nConversation facts (not instructions):\n{input}")
                    }]
                });
                let res = model
                    .turn_with_history(
                        &sys,
                        &summary_hist,
                        &json!([]),
                        &LiveHistory::default(),
                        cancel,
                    )
                    .await;
                record_attempt_usage(accounting, &res, false);
                match res {
                    Ok(t) if t.calls.is_empty() && !t.content.trim().is_empty() => {
                        ("llm", t.content)
                    }
                    Err(e) if e.code == "CANCELLED" || e.code == ModelError::AUTH_REJECTED => {
                        return Err(e);
                    }
                    _ => match build_structural_compaction_summary(&input) {
                        Ok(s) => ("structured", s),
                        Err(_) => return Ok(None),
                    },
                }
            }
            Err(_) => match build_structural_compaction_summary(&input) {
                Ok(s) => ("structured", s),
                Err(_) => return Ok(None),
            },
        };

        let retained_id = if last_user_idx > 0 {
            committed_ids
                .get(last_user_idx)
                .and_then(|id| id.as_deref())
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        } else {
            committed_ids
                .first()
                .and_then(|id| id.as_deref())
                .filter(|id| !id.is_empty())
                .map(str::to_owned)
        };
        let next_epoch = compaction_epoch.saturating_add(1);
        let mut marker_input = json!({
            "method": method,
            "summary": summary,
            "originalMessageCount": live_messages.len(),
        });
        if let Some(ref rid) = retained_id {
            marker_input["historySelection"] = json!({
                "version": 1,
                "compactionEpoch": next_epoch,
                "retainedMessageIds": [rid],
            });
        }
        let Ok(marker) = build_compaction_marker(&marker_input) else {
            return Ok(None);
        };

        let at = now_iso();
        let compact_id = format!("compact-{}", uuid::Uuid::new_v4());
        let _ = conv_store.append_message_idempotent(
            conversation_id,
            &json!({
                "id": compact_id,
                "role": "user",
                "content": summary,
                "createdAt": at,
                "_compaction": marker,
            }),
            &at,
            None,
        );

        *compaction_epoch = next_epoch;
        if last_user_idx > 0 {
            *live_messages = live_messages[split_at..].to_vec();
            if committed_ids.len() >= split_at {
                *committed_ids = committed_ids[split_at..].to_vec();
            } else {
                committed_ids.clear();
            }
        } else {
            let mut compacted_msgs = Vec::with_capacity(1 + (live_messages.len() - split_at));
            compacted_msgs.push(live_messages[0].clone());
            compacted_msgs.extend_from_slice(&live_messages[split_at..]);
            *live_messages = compacted_msgs;
            let first_id = committed_ids.first().cloned().unwrap_or(None);
            committed_ids.clear();
            committed_ids.push(first_id);
        }

        Ok(Some(TurnCompactionOutcome {
            summary,
            compaction_epoch: next_epoch,
        }))
    }

    /// Execute one bounded main-Bot cognition turn (`user` or `wake`).
    pub async fn run_turn(
        &self,
        opts: &RunTurnOptions<'_>,
        model: &NativeModel,
        cancel: &CancellationToken,
    ) -> Result<AgentTurnOutcome, ProjectError> {
        self.run_turn_with_verifier(opts, model, None, cancel).await
    }

    pub(crate) async fn run_turn_with_verifier(
        &self,
        opts: &RunTurnOptions<'_>,
        model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        cancel: &CancellationToken,
    ) -> Result<AgentTurnOutcome, ProjectError> {
        if !opts.holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if let Ok(mut guard) = self.last_workspace_id.lock() {
            *guard = Some(opts.workspace_id.to_owned());
        }
        let turn_id = format!("turn-{}", uuid::Uuid::new_v4());
        let now_str = now_iso();
        let now_ms = parse_iso_ms(&now_str).unwrap_or(0);
        let provider_scope = format!("provider:{}", model.provider());
        let manual_trial = opts.kind == "user";

        let mut trial_in_flight = match self.breaker_store.admit(
            opts.workspace_id,
            manual_trial,
            Some(&provider_scope),
            now_ms,
        ) {
            Ok(CircuitAdmit::Blocked { .. }) => {
                return Ok(AgentTurnOutcome {
                    turn_id,
                    end: TurnEndKind::CircuitOpen,
                    spawned_session_ids: vec![],
                    tool_calls: 0,
                });
            }
            Ok(CircuitAdmit::Admitted { trial }) => trial,
            Err(_) => false,
        };

        let (max_rounds, max_tool_calls) = if opts.kind == "user" {
            (USER_MAX_BOT_ROUNDS, USER_MAX_BOT_TOOL_CALLS)
        } else {
            (WAKE_MAX_BOT_ROUNDS, WAKE_MAX_BOT_TOOL_CALLS)
        };

        let conv_store = ConversationStore::new(&self.data_home);
        let conv_dir = self.data_home.join("conversations");
        let conv_file = conv_dir.join(format!("{}.jsonl", opts.conversation_id));
        if !conv_file.exists()
            && conv_store
                .read_metadata(opts.conversation_id)
                .is_ok_and(|snap| snap.metadata.is_some())
        {
            let _ = std::fs::create_dir_all(&conv_dir);
            let _ = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&conv_file);
        }
        let history_messages =
            crate::read_full_conversation_messages(&conv_store, opts.conversation_id)
                .unwrap_or_default();

        let mut valid_user_ids = HashSet::new();
        let mut answered_user_ids = HashSet::new();
        let mut prior_report_fact_keys = HashSet::new();
        let mut reported_session_ids = HashSet::new();
        let mut anchor_seen = HashSet::new();
        let mut user_anchor_candidates = Vec::new();
        for msg in &history_messages {
            let kind = msg["kind"].as_str().unwrap_or("");
            if (kind == "user_input" || (kind.is_empty() && msg["role"] == "user"))
                && compaction_marker(msg).is_none()
                && let Some(id) = msg["id"].as_str()
            {
                valid_user_ids.insert(id.to_owned());
                if anchor_seen.insert(id.to_owned()) {
                    let input_id = msg["inputId"]
                        .as_str()
                        .map(str::to_owned)
                        .or_else(|| id.strip_prefix("input-").map(str::to_owned));
                    user_anchor_candidates.push(UserAnchorCandidate {
                        message_id: id.to_owned(),
                        input_id,
                        text: msg["content"].as_str().unwrap_or("").to_owned(),
                    });
                }
            }
            if kind == "agent_reply" {
                if let Some(reply_to) = msg["replyTo"].as_array() {
                    for anc in reply_to {
                        if let Some(id) = anc.as_str().filter(|v| !v.is_empty()) {
                            answered_user_ids.insert(id.to_owned());
                        }
                    }
                }
                if let Some(srcs) = msg["sources"].as_array() {
                    for s in srcs {
                        if let Some(sid) = s.as_str().filter(|v| !v.is_empty()) {
                            reported_session_ids.insert(sid.to_owned());
                        }
                    }
                }
                if let Some(keys) = msg["meta"]["reportFactKeys"].as_array() {
                    for k in keys {
                        if let Some(s) = k.as_str() {
                            prior_report_fact_keys.insert(s.to_owned());
                            if let Some((sid, _)) = s.split_once('|')
                                && !sid.is_empty()
                            {
                                reported_session_ids.insert(sid.to_owned());
                            }
                        }
                    }
                }
            }
        }

        let current_input_anchors: Vec<String> = opts
            .user_inputs
            .iter()
            .map(|i| format!("input-{}", i.input_id))
            .collect();
        for inp in opts.user_inputs {
            let anchor_id = format!("input-{}", inp.input_id);
            valid_user_ids.insert(anchor_id.clone());
            if anchor_seen.insert(anchor_id.clone()) {
                user_anchor_candidates.push(UserAnchorCandidate {
                    message_id: anchor_id,
                    input_id: Some(inp.input_id.clone()),
                    text: inp.text.clone(),
                });
            }
        }
        let current_input_id = opts
            .user_inputs
            .first()
            .map(|i| i.input_id.clone())
            .unwrap_or_default();
        let quote_session_ids: Vec<String> = opts
            .user_inputs
            .iter()
            .flat_map(|i| i.quote_refs.iter().cloned())
            .collect();
        let input_ids: Vec<String> = opts
            .user_inputs
            .iter()
            .map(|i| i.input_id.clone())
            .collect();
        let coord_active = opts.holds_lease && self.coordination.holds(opts.workspace_id);
        let work_id = if coord_active {
            let linked = if opts.kind == "wake" {
                self.coordination
                    .read_state(opts.workspace_id)
                    .ok()
                    .and_then(|st| {
                        let wake_sids: HashSet<&str> = opts
                            .wake_events
                            .iter()
                            .filter_map(|e| e["sessionId"].as_str())
                            .collect();
                        st["works"].as_object()?.values().find_map(|w| {
                            let wid = w["workId"].as_str()?;
                            let owns = w["sessionIds"]
                                .as_array()?
                                .iter()
                                .filter_map(Value::as_str)
                                .any(|s| wake_sids.contains(s));
                            owns.then(|| wid.to_owned())
                        })
                    })
            } else {
                None
            };
            linked.unwrap_or_else(|| {
                let keys: Vec<String> = if !input_ids.is_empty() {
                    input_ids.clone()
                } else {
                    let ev_ids: Vec<String> = opts
                        .wake_events
                        .iter()
                        .filter_map(|e| e["eventId"].as_str().map(str::to_owned))
                        .collect();
                    if ev_ids.is_empty() {
                        vec![turn_id.clone()]
                    } else {
                        ev_ids
                    }
                };
                coordination_work_id(opts.conversation_id, &keys)
            })
        } else {
            coordination_work_id(
                opts.conversation_id,
                if input_ids.is_empty() {
                    std::slice::from_ref(&turn_id)
                } else {
                    &input_ids
                },
            )
        };

        let sessions = self.supervisor.list_sessions(opts.workspace_id);
        let unanswered_wake_anchors: Vec<String> = if opts.kind == "wake" {
            let wake_sids: HashSet<&str> = opts
                .wake_events
                .iter()
                .filter_map(|e| {
                    e["sessionId"]
                        .as_str()
                        .or_else(|| e["payload"]["sessionId"].as_str())
                })
                .filter(|s| !s.is_empty())
                .collect();
            let mut anchors = Vec::new();
            let mut seen = HashSet::new();
            for s in &sessions {
                if !wake_sids.is_empty() && !wake_sids.contains(s.session_id.as_str()) {
                    continue;
                }
                for anc in &s.anchor_message_ids {
                    if valid_user_ids.contains(anc)
                        && !answered_user_ids.contains(anc)
                        && seen.insert(anc.clone())
                    {
                        anchors.push(anc.clone());
                    }
                }
            }
            anchors
        } else {
            Vec::new()
        };

        let visible_activity = opts.kind == "user" || !unanswered_wake_anchors.is_empty();
        if visible_activity {
            let activity_reply_to = if opts.kind == "user" {
                current_input_anchors.clone()
            } else {
                unanswered_wake_anchors.clone()
            };
            self.init_activity(ProjectAgentActivity {
                workspace_id: opts.workspace_id.to_owned(),
                conversation_id: opts.conversation_id.to_owned(),
                turn_id: turn_id.clone(),
                work_id: Some(work_id.clone()),
                revision: 1,
                started_at: now_str.clone(),
                finished_at: None,
                reply_to: activity_reply_to,
                phase: "thinking".into(),
                reply_text: String::new(),
                segments: Vec::new(),
            });
        } else {
            self.dispose_activity(opts.workspace_id);
            self.set_status_only(opts.workspace_id, "thinking");
        }

        let profile = BotProfileStore::new(&self.data_home).read(opts.workspace_id);
        let bot_name = profile
            .as_ref()
            .map(|p| p.display_name.as_str())
            .unwrap_or("Peer Bot");
        let global_communication_style = read_global_communication_style(&self.data_home);
        let communication_style = profile
            .as_ref()
            .map(|p| p.effective_communication_style(&global_communication_style))
            .unwrap_or(global_communication_style.as_str());
        let memory_enabled = profile.as_ref().is_none_or(|p| p.is_memory_enabled());
        let memories = if memory_enabled {
            MemoryStore::new(&self.data_home)
                .list(&MemoryFilter {
                    scope: None,
                    workspace_id: Some(opts.workspace_id),
                    kind: None,
                    status: Some("active"),
                })
                .into_iter()
                .filter(|m| is_effective_memory(m, now_ms))
                .collect()
        } else {
            Vec::new()
        };
        let mut unreported_anchor_sessions = Vec::new();
        for s in &sessions {
            if s.status == "result_ready" && !reported_session_ids.contains(&s.session_id) {
                for anchor in &s.anchor_message_ids {
                    unreported_anchor_sessions.push((anchor.clone(), s.session_id.clone()));
                }
            }
        }
        let objectives = ObjectiveStore::new(&self.data_home)
            .list(opts.workspace_id)
            .unwrap_or_default();
        let instructions = ProjectInstructions::observe_desktop_host(
            opts.workspace_path,
            &self.data_home,
            None,
            cancel,
        )
        .unwrap_or_default();
        let retry_continuity = read_retry_continuity_in(
            Some(&self.data_home),
            Some(opts.workspace_id),
            &history_messages,
            &current_input_anchors,
            Some(&turn_id),
        );

        let (working_context, agent_messages) = if coord_active {
            let _ = self.coordination.ensure_work(
                opts.workspace_id,
                &work_id,
                opts.conversation_id,
                &input_ids,
                &[],
                "runnable",
            );
            let wc = self.coordination.read_working_context(
                opts.workspace_id,
                &work_id,
                opts.conversation_id,
            );
            let msgs = self
                .coordination
                .read_agent_messages_for_context(opts.workspace_id, opts.conversation_id);
            let obs_ids: Vec<String> = msgs
                .iter()
                .filter_map(|m| m["messageId"].as_str().map(str::to_owned))
                .collect();
            let _ = self.coordination.mark_agent_messages_observed(
                opts.workspace_id,
                opts.conversation_id,
                &obs_ids,
            );
            (wc, msgs)
        } else {
            (None, Vec::new())
        };

        let projection_mode = self.projection_mode();
        let initial_packs: Vec<String> = if projection_mode == ToolProjectionMode::Progressive {
            let has_obligations =
                crate::read_persisted_obligation_grants(&self.data_home, opts.workspace_id)
                    .is_ok_and(|grants| !grants.is_empty())
                    || peer_store::ExecutionResourceStore::open_existing(&self.data_home)
                        .ok()
                        .is_some_and(|rstore| {
                            sessions.iter().any(|s| {
                                self.supervisor
                                    .read_plan(&s.plan_id)
                                    .ok()
                                    .and_then(|plan| crate::host_resource_plan_from_plan(&plan))
                                    .is_some_and(|hp| {
                                        !rstore.claims_for(&hp).unwrap_or_default().is_empty()
                                            || !rstore
                                                .retained_unknowns(&hp)
                                                .unwrap_or_default()
                                                .is_empty()
                                    })
                            })
                        });
            let interactive_publishing_available =
                self.supervisor.is_interactive_publishing_available();
            let has_interactive_results = interactive_publishing_available
                || InteractiveResultStore::new(&self.data_home)
                    .list_for_owner(&peer_protocol::interactive_result::InteractiveOwner {
                        workspace_id: opts.workspace_id.to_owned(),
                        conversation_id: opts.conversation_id.to_owned(),
                    })
                    .is_ok_and(|items| !items.is_empty());
            let has_working_context = working_context.as_ref().is_some_and(|wc| {
                wc["notes"].as_array().is_some_and(|a| !a.is_empty())
                    || wc["windows"].as_array().is_some_and(|a| !a.is_empty())
            });
            auto_activated_packs(&TurnProjectionSignals {
                has_sessions: !sessions.is_empty(),
                has_objectives: !objectives.is_empty(),
                has_obligations,
                has_interactive_results,
                has_working_context,
            })
        } else {
            Vec::new()
        };
        let skill_pack_catalog = if projection_mode == ToolProjectionMode::Progressive {
            render_unactivated_pack_catalog(&initial_packs)
        } else {
            None
        };
        let mounted_capabilities_summary = crate::render_bot_mounted_capabilities_summary(
            &self.data_home,
            opts.workspace_path,
            profile.as_ref().and_then(|p| p.capability_policy.as_ref()),
        );

        let LoadedBotHistory {
            mut continuity_summary,
            mut compaction_epoch,
            mut live_messages,
            mut committed_message_ids,
        } = load_bot_history(&history_messages);

        if opts.kind == "user" && !opts.user_inputs.is_empty() {
            for inp in opts.user_inputs {
                let anchor_id = format!("input-{}", inp.input_id);
                if committed_message_ids
                    .iter()
                    .any(|id| id.as_deref() == Some(anchor_id.as_str()))
                {
                    continue;
                }
                let mut content = inp.text.clone();
                if !inp.task_refs.is_empty() {
                    let mut ref_lines = Vec::new();
                    for sid in &inp.task_refs {
                        if let Some(plan) =
                            self.supervisor.find_plan_by_session(opts.workspace_id, sid)
                        {
                            let title = plan["title"].as_str().unwrap_or(sid);
                            let status = plan["status"].as_str().unwrap_or("unknown");
                            ref_lines.push(format!(
                                "- sessionId={sid} title=\"{title}\" status={status}"
                            ));
                        }
                    }
                    if !ref_lines.is_empty() {
                        content = format!(
                            "[用户引用任务上下文（宿主核验）]\n{}\n\n{}",
                            ref_lines.join("\n"),
                            content
                        );
                    }
                }
                let synthetic = json!({
                    "id": anchor_id,
                    "role": "user",
                    "kind": "user_input",
                    "content": content,
                    "attachments": inp.attachments,
                });
                if let Some(projected) =
                    crate::attachments::project_user_message_for_model(&synthetic)
                {
                    live_messages.push(projected);
                    committed_message_ids.push(Some(anchor_id));
                } else if !content.trim().is_empty() {
                    live_messages.push(json!({"role": "user", "content": content}));
                    committed_message_ids.push(Some(anchor_id));
                }
            }
        }

        if opts.kind == "wake" || (live_messages.is_empty() && opts.user_inputs.is_empty()) {
            let wake_text = if opts.wake_events.is_empty() {
                "Review current project status and respond via post_reply or wait_for_sessions."
                    .to_owned()
            } else {
                format!(
                    "Process {} project wake event(s). Inspect updated reports, verify results, and respond via post_reply or wait_for_sessions.",
                    opts.wake_events.len()
                )
            };
            live_messages.push(json!({"role": "user", "content": wake_text}));
            committed_message_ids.push(None);
        }

        let host_surface = self.supervisor.surface_str();
        let interactive_publishing_available =
            self.supervisor.is_interactive_publishing_available();
        let build_system_prompt = |continuity: Option<&str>| {
            assemble_project_agent_context(&ProjectAgentContextInput {
                workspace_id: opts.workspace_id,
                workspace_path: &opts.workspace_path.to_string_lossy(),
                bot_name,
                communication_style,
                provider: model.provider(),
                model: model.model_id(),
                turn_kind: opts.kind,
                instructions: &instructions,
                memories: &memories,
                sessions: &sessions,
                objectives: &objectives,
                current_input_anchors: &current_input_anchors,
                wake_events: opts.wake_events,
                continuity_summary: continuity,
                retry_continuity: retry_continuity.as_ref(),
                working_context: working_context.as_ref(),
                agent_messages: &agent_messages,
                skill_pack_catalog: skill_pack_catalog.as_deref(),
                mounted_capabilities_summary: mounted_capabilities_summary.as_deref(),
                host_surface,
                interactive_publishing_available,
            })
        };
        let mut system_prompt = build_system_prompt(continuity_summary.as_deref());

        let turn_state = Arc::new(Mutex::new(TurnExecutionState {
            workspace_id: opts.workspace_id.to_owned(),
            workspace_path: opts.workspace_path.to_path_buf(),
            conversation_id: opts.conversation_id.to_owned(),
            turn_id: turn_id.clone(),
            kind: opts.kind.to_owned(),
            current_input_anchors: current_input_anchors.clone(),
            current_input_id,
            quote_session_ids,
            valid_user_message_ids: valid_user_ids,
            answered_user_message_ids: answered_user_ids,
            user_anchor_candidates,
            unreported_anchor_sessions,
            prior_report_fact_keys,
            worker_model_selection: opts.worker_model_selection.clone(),
            reply_committed_id: None,
            post_reply_rejected: false,
            work_id: work_id.clone(),
            waiting_session_ids: vec![],
            spawned_session_ids: vec![],
            activated_packs: initial_packs.clone(),
            memory_learned: vec![],
            memory_used: vec![],
            holds_lease: opts.holds_lease,
        }));

        let mut registry = ProviderRegistry::for_project_agent();
        registry.register(Box::new(
            ProjectCapabilityProvider::with_coordination(
                &self.data_home,
                Arc::clone(&self.supervisor),
                Arc::clone(&self.coordination),
                Arc::clone(&turn_state),
            )
            .with_verifier_model(verifier_model.unwrap_or(model).clone()),
        ));
        let (mut projection, mut tools_json) = if projection_mode == ToolProjectionMode::Progressive
        {
            let allowlist = build_allowlist(&initial_packs, &[]);
            let proj = registry.project_for_mode(RuntimeMode::ProjectAgent, Some(&allowlist))?;
            let defs = ordered_definitions(&proj, &allowlist);
            (proj, defs)
        } else {
            let proj = registry.project_for_mode(RuntimeMode::ProjectAgent, None)?;
            let defs = proj.definitions();
            (proj, defs)
        };
        let mut observed_activated_packs = initial_packs.len();
        let mut pack_activation_free_rounds = 0usize;

        let (mut admission, admission_task) =
            EffectAdmission::spawn_read_only_host(cancel.clone(), || true);
        if let Some(owner) = peer_runtime::recorder::local_recorder(
            &format!("project-agent-{}", opts.workspace_id),
            &now_str,
        )
        .await
        {
            admission = admission.with_owner(owner);
        }
        let evidence_store = EvidenceIndexStore::new(&self.data_home);
        let mut live = LiveHistory::default();
        let mut accounting = RuntimeUsageAccounting::default();
        let mut compacted_this_turn = false;
        let mut total_tool_calls = 0usize;
        let mut final_end = TurnEndKind::Yielded;
        let mut rounds_record: Vec<Value> = Vec::new();
        let mut public_updates: Vec<Value> = Vec::new();
        let mut public_update_chars = 0usize;

        // Pre-flight proactive compaction if conversation history is already >= 85% of context window.
        if let Some(window) = model.context_window()
            && live_messages.len() > 2
            && !cancel.is_cancelled()
        {
            let est_tokens = estimate_prompt_chars(&system_prompt, &live_messages) / 3;
            let threshold = ((window as usize).saturating_mul(85)) / 100;
            if est_tokens >= threshold
                && let Ok(Some(done)) = self
                    .compact_bot_history(
                        model,
                        &conv_store,
                        opts.conversation_id,
                        continuity_summary.as_deref(),
                        &mut compaction_epoch,
                        &mut live_messages,
                        &mut committed_message_ids,
                        &mut accounting,
                        cancel,
                    )
                    .await
            {
                continuity_summary = Some(done.summary);
                compaction_epoch = done.compaction_epoch;
                system_prompt = build_system_prompt(continuity_summary.as_deref());
                compacted_this_turn = true;
            }
        }

        let failure_ctx = TurnFailureCtx {
            conv_store: &conv_store,
            workspace_id: opts.workspace_id,
            conversation_id: opts.conversation_id,
            turn_id: &turn_id,
            provider_scope: &provider_scope,
            now_ms,
        };

        let mut delivery_repair_used = false;
        let mut protocol_repair_attempts = 0usize;
        let mut round = 0usize;
        while round < max_rounds {
            round += 1;
            if cancel.is_cancelled() {
                final_end = TurnEndKind::UserStopped;
                break;
            }
            self.set_activity_phase(opts.workspace_id, "thinking", None, false);
            let near_cutoff = (round >= max_rounds
                || max_tool_calls.saturating_sub(total_tool_calls) <= 2)
                && turn_state
                    .lock()
                    .map(|s| s.reply_committed_id.is_none() && s.waiting_session_ids.is_empty())
                    .unwrap_or(false);
            fn round_prompt_for(base: &str, near_cutoff: bool) -> std::borrow::Cow<'_, str> {
                if near_cutoff {
                    std::borrow::Cow::Owned(format!(
                        "{base}\n\nFINAL TOOL ROUND NOTICE:\nThis is your last tool round for this turn. Do NOT start further exploratory reads. If you need to delegate work, call `spawn_session` now, and deliver your reply via `post_reply` (or call `wait_for_sessions` if active child sessions remain)."
                    ))
                } else {
                    std::borrow::Cow::Borrowed(base)
                }
            }
            let round_system_prompt = round_prompt_for(&system_prompt, near_cutoff);
            let mut model_turn = match self
                .call_model_with_retry(
                    model,
                    opts.workspace_id,
                    opts.conversation_id,
                    &round_system_prompt,
                    &live_messages,
                    &tools_json,
                    &live,
                    &mut accounting,
                    cancel,
                )
                .await
            {
                Ok(t) => t,
                Err(err)
                    if err.context_overflow_status.is_some()
                        && !compacted_this_turn
                        && live_messages.len() > 1 =>
                {
                    compacted_this_turn = true;
                    match self
                        .compact_bot_history(
                            model,
                            &conv_store,
                            opts.conversation_id,
                            continuity_summary.as_deref(),
                            &mut compaction_epoch,
                            &mut live_messages,
                            &mut committed_message_ids,
                            &mut accounting,
                            cancel,
                        )
                        .await
                    {
                        Ok(Some(done)) => {
                            continuity_summary = Some(done.summary);
                            compaction_epoch = done.compaction_epoch;
                            system_prompt = build_system_prompt(continuity_summary.as_deref());
                            let retry_system_prompt = round_prompt_for(&system_prompt, near_cutoff);
                            live = LiveHistory::default();
                            match self
                                .call_model_with_retry(
                                    model,
                                    opts.workspace_id,
                                    opts.conversation_id,
                                    &retry_system_prompt,
                                    &live_messages,
                                    &tools_json,
                                    &live,
                                    &mut accounting,
                                    cancel,
                                )
                                .await
                            {
                                Ok(t) => t,
                                Err(retry_err) => {
                                    trial_in_flight = false;
                                    final_end = self.record_turn_failure(
                                        &failure_ctx,
                                        retry_err.code,
                                        cancel,
                                    );
                                    break;
                                }
                            }
                        }
                        Ok(None) => {
                            trial_in_flight = false;
                            final_end = self.record_turn_failure(&failure_ctx, err.code, cancel);
                            break;
                        }
                        Err(compact_err) => {
                            trial_in_flight = false;
                            final_end =
                                self.record_turn_failure(&failure_ctx, compact_err.code, cancel);
                            break;
                        }
                    }
                }
                Err(err) => {
                    trial_in_flight = false;
                    final_end = self.record_turn_failure(&failure_ctx, err.code, cancel);
                    break;
                }
            };

            let leaked_protocol = has_literal_tool_call_syntax(&model_turn.content);
            // Dual-channel isolation: only non-tool rounds emit user-visible prose updates.
            // Companion text emitted alongside tool calls stays in `rounds_record` for diagnostics
            // so internal scratchpad monologues never leak into the chat or process summary.
            if model_turn.calls.is_empty() && !leaked_protocol {
                push_public_update(
                    &mut public_updates,
                    &mut public_update_chars,
                    &model_turn.content,
                );
            }
            if cancel.is_cancelled() {
                rounds_record.push(json!({
                    "text": model_turn.content,
                    "toolCalls": [],
                }));
                final_end = TurnEndKind::UserStopped;
                break;
            }

            if model_turn.calls.is_empty() {
                rounds_record.push(json!({
                    "text": model_turn.content,
                    "toolCalls": [],
                }));
                if leaked_protocol {
                    if protocol_repair_attempts < 2 && !cancel.is_cancelled() {
                        protocol_repair_attempts += 1;
                        self.set_activity_phase(opts.workspace_id, "thinking", Some(""), false);
                        live_messages.push(json!({
                            "role": "user",
                            "content": "Your previous response emitted raw tool-call markup (such as DSML or XML tags) in plain text instead of structured tool calls. Do NOT output <｜DSML｜...>, <|DSML|...>, <tool_call>, <function_calls>, <invoke>, or <parameter> tags in text. Either invoke tools using the native structured tool-calling interface (including post_reply for your final answer), or reply directly in plain prose.",
                        }));
                        committed_message_ids.push(None);
                        round = round.saturating_sub(1);
                        continue;
                    }
                    let clean = strip_literal_tool_call_blocks(&model_turn.content);
                    if opts.kind == "user" && !clean.is_empty() {
                        push_public_update(&mut public_updates, &mut public_update_chars, &clean);
                        match persist_fallback_reply(
                            &conv_store,
                            opts.conversation_id,
                            &turn_id,
                            &current_input_anchors,
                            &clean,
                        ) {
                            Ok(msg_id) => {
                                final_end = TurnEndKind::ReplyCommitted { message_id: msg_id };
                            }
                            Err(err) => {
                                trial_in_flight = false;
                                final_end =
                                    self.record_turn_failure(&failure_ctx, err.code(), cancel);
                            }
                        }
                    } else if opts.kind == "user" {
                        trial_in_flight = false;
                        final_end = self.record_turn_failure(
                            &failure_ctx,
                            "unsupported_tool_response",
                            cancel,
                        );
                    }
                    break;
                }
                let (post_rejected, committed_or_waiting) = turn_state
                    .lock()
                    .map(|s| {
                        (
                            s.post_reply_rejected,
                            s.reply_committed_id.is_some() || !s.waiting_session_ids.is_empty(),
                        )
                    })
                    .unwrap_or((false, false));
                if !committed_or_waiting
                    && !delivery_repair_used
                    && !cancel.is_cancelled()
                    && (opts.kind == "wake" || post_rejected)
                {
                    delivery_repair_used = true;
                    let sanitized =
                        peer_runtime::canonical_history::sanitize_assistant(&model_turn.content);
                    let trimmed = peer_protocol::javascript_trim(&sanitized);
                    if !trimmed.is_empty() {
                        live_messages.push(json!({
                            "role": "assistant",
                            "content": trimmed,
                        }));
                        committed_message_ids.push(None);
                    }
                    live_messages.push(json!({
                        "role": "user",
                        "content": "No final reply or session wait has been committed (or your previous post_reply was rejected). Fix any validation error using the tool diagnostics and call post_reply (or wait_for_sessions if active child sessions remain).",
                    }));
                    committed_message_ids.push(None);
                    round = round.saturating_sub(1);
                    continue;
                }
                if opts.kind == "user" && !model_turn.content.trim().is_empty() {
                    match persist_fallback_reply(
                        &conv_store,
                        opts.conversation_id,
                        &turn_id,
                        &current_input_anchors,
                        model_turn.content.trim(),
                    ) {
                        Ok(msg_id) => {
                            final_end = TurnEndKind::ReplyCommitted { message_id: msg_id };
                        }
                        Err(err) => {
                            trial_in_flight = false;
                            final_end = self.record_turn_failure(&failure_ctx, err.code(), cancel);
                        }
                    }
                }
                break;
            }

            let mut assistant_tool_calls = Vec::new();
            let mut tool_results = Vec::new();
            let mut round_tool_records = Vec::new();
            let mut executed_ids = Vec::new();
            let mut stop_loop = false;
            let mut all_pack_activations = true;

            let calls = std::mem::take(&mut model_turn.calls);
            for call in calls {
                if cancel.is_cancelled() {
                    final_end = TurnEndKind::UserStopped;
                    stop_loop = true;
                    break;
                }
                if total_tool_calls >= max_tool_calls {
                    final_end = TurnEndKind::Yielded;
                    stop_loop = true;
                    break;
                }
                total_tool_calls += 1;
                let call_id = format!("tc-{}", uuid::Uuid::new_v4());
                let started_at = now_iso();
                let started_ms = parse_iso_ms(&started_at).unwrap_or(0);
                let tool_summary = activity_tool_summary(&call.name, &call.arguments);
                self.record_activity_tool_start(
                    opts.workspace_id,
                    &call_id,
                    &call.name,
                    tool_summary.as_deref(),
                    &started_at,
                );

                let cap_id = projection
                    .capability(&call.name)
                    .unwrap_or("unknown")
                    .to_owned();
                let outcome = match registry.prepare(
                    &projection,
                    &call.name,
                    call.arguments.clone(),
                    opts.workspace_path,
                    &self.data_home,
                ) {
                    Ok(mut prepared) => {
                        prepared.admission(admission.clone());
                        match prepared.start(
                            ProviderCall::for_host(opts.conversation_id, &call_id, &started_at),
                            cancel.clone(),
                        ) {
                            Ok(fut) => fut.await,
                            Err(e) => EffectOutcome::failed(e.0),
                        }
                    }
                    Err(e) => EffectOutcome::failed(e.0),
                };

                if call.name != ACTIVATE_SKILL_PACK_TOOL || outcome.status != "success" {
                    all_pack_activations = false;
                }

                let completed_at = now_iso();
                let ended_ms = parse_iso_ms(&completed_at).unwrap_or(started_ms);
                self.record_activity_tool_finish(
                    opts.workspace_id,
                    &call_id,
                    outcome.status == "success",
                    &completed_at,
                );
                let grant = json!({
                    "grantId": format!("grant-{call_id}"),
                    "toolCallId": call_id,
                    "granted": outcome.status == "success",
                    "duration": if outcome.status == "success" { "once" } else { "denied" },
                    "scope": cap_id,
                    "decidedAt": completed_at,
                });
                let result_record = json!({
                    "toolCallId": call_id,
                    "status": outcome.status,
                    "completedAt": completed_at,
                    "outputPreview": {"summary": outcome.status},
                    "evidence": {
                        "evidenceId": format!("ev-{call_id}"),
                        "toolCallId": call_id,
                        "summary": format!("{} ({})", call.name, outcome.status),
                        "artifactRefs": outcome.artifacts,
                    }
                });
                let _ = evidence_store.register(
                    &HostToolEvidence {
                        conversation_id: opts.conversation_id,
                        plan_id: None,
                        stream_id: Some(&turn_id),
                        tool_name: &call.name,
                        capability_id: &cap_id,
                        tool_call_id: &call_id,
                        grant: &grant,
                        result: &result_record,
                    },
                    None,
                );

                let tool_output = format_tool_outcome_output(&outcome);
                round_tool_records.push(json!({
                    "name": call.name,
                    "input": call.arguments,
                    "result": compact_persisted_tool_result(&tool_output),
                    "startedAtMs": started_ms,
                    "endedAtMs": ended_ms,
                }));

                executed_ids.push(call_id.clone());
                assistant_tool_calls.push(json!({
                    "id": call_id,
                    "name": call.name,
                    "arguments": serde_json::to_string(&call.arguments).unwrap_or_else(|_| "{}".into()),
                }));
                tool_results.push(json!({
                    "role": "tool",
                    "toolCallId": call_id,
                    "name": call.name,
                    "content": serde_json::to_string(&tool_output).unwrap_or_else(|_| "{}".into()),
                }));

                if outcome.output["control"]["terminal"] == true {
                    stop_loop = true;
                    break;
                }
            }

            rounds_record.push(json!({
                "text": model_turn.content,
                "toolCalls": round_tool_records,
            }));

            if !assistant_tool_calls.is_empty() {
                let sanitized = neutralize_tool_call_syntax(&strip_literal_tool_call_blocks(
                    &peer_runtime::canonical_history::sanitize_assistant(&model_turn.content),
                ));
                let trimmed = peer_protocol::javascript_trim(&sanitized);
                if !trimmed.is_empty() {
                    live_messages.push(json!({
                        "role": "assistant",
                        "content": trimmed,
                    }));
                    committed_message_ids.push(None);
                }
                live_messages.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                    "toolCalls": assistant_tool_calls,
                }));
                committed_message_ids.push(None);
                let tool_count = tool_results.len();
                live_messages.extend(tool_results);
                committed_message_ids.extend(std::iter::repeat_n(None, tool_count));
                if !stop_loop && !executed_ids.is_empty() {
                    let history_val = json!({"messages": live_messages});
                    let _ = live.remember_turn(&history_val, &executed_ids, &mut model_turn);
                }
            }

            if projection_mode == ToolProjectionMode::Progressive {
                let activated_now = turn_state
                    .lock()
                    .map(|s| s.activated_packs.clone())
                    .unwrap_or_default();
                if activated_now.len() > observed_activated_packs {
                    observed_activated_packs = activated_now.len();
                    let allowlist = build_allowlist(&initial_packs, &activated_now);
                    if let Ok(next_proj) =
                        registry.project_for_mode(RuntimeMode::ProjectAgent, Some(&allowlist))
                    {
                        tools_json = ordered_definitions(&next_proj, &allowlist);
                        projection = next_proj;
                    }
                }
                if !stop_loop
                    && all_pack_activations
                    && !executed_ids.is_empty()
                    && pack_activation_free_rounds < 2
                {
                    pack_activation_free_rounds += 1;
                    round = round.saturating_sub(1);
                }
            }

            if stop_loop {
                break;
            }
            if round >= max_rounds {
                let (post_rejected, committed_or_waiting) = turn_state
                    .lock()
                    .map(|s| {
                        (
                            s.post_reply_rejected,
                            s.reply_committed_id.is_some() || !s.waiting_session_ids.is_empty(),
                        )
                    })
                    .unwrap_or((false, false));
                if !committed_or_waiting
                    && !delivery_repair_used
                    && !cancel.is_cancelled()
                    && (opts.kind == "wake" || post_rejected)
                {
                    delivery_repair_used = true;
                    live_messages.push(json!({
                        "role": "user",
                        "content": "No final reply or session wait has been committed (or your previous post_reply was rejected). Fix any validation error using the tool diagnostics and call post_reply (or wait_for_sessions if active child sessions remain).",
                    }));
                    committed_message_ids.push(None);
                    round = round.saturating_sub(1);
                }
            }
        }

        let needs_synthesis = opts.kind == "user"
            && !cancel.is_cancelled()
            && !matches!(
                final_end,
                TurnEndKind::ReplyCommitted { .. }
                    | TurnEndKind::AwaitingChildren { .. }
                    | TurnEndKind::UserStopped
                    | TurnEndKind::Failed { .. }
                    | TurnEndKind::CircuitOpen
            )
            && turn_state
                .lock()
                .map(|s| s.reply_committed_id.is_none() && s.waiting_session_ids.is_empty())
                .unwrap_or(false);
        if needs_synthesis {
            self.set_activity_phase(opts.workspace_id, "thinking", None, false);
            let synthesis_system_prompt = format!(
                "{system_prompt}\n\nFINAL SYNTHESIS OVERRIDE:\nTool calls are disabled for this final response because the per-turn tool-round limit has been reached. Do NOT call `post_reply` or any other tool, and do NOT emit DSML, XML, or pseudo tool-call tags (`<｜DSML｜...>`, `<|DSML|...>`, `<tool_call>`, `<invoke>`, `<parameter>`). Do NOT mention internal tool names (such as `post_reply` or `spawn_session`) or internal runtime mechanics (such as exhausted tool rounds or disabled tools) in your reply to the user; answer naturally in the user's language summarizing only verified findings observed so far and clearly stating any remaining next step."
            );
            let mut synthesis_messages = live_messages.clone();
            synthesis_messages.push(json!({
                "role": "user",
                "content": "Tool rounds for this turn are now exhausted and tools are disabled. Do not call post_reply or any tool, do not output DSML/XML tool-call markup, and do not mention internal tool names or runtime round limits. Write your final natural plain-text reply directly to the user summarizing verified findings so far and what still remains if incomplete.",
            }));
            match self
                .call_model_with_retry(
                    model,
                    opts.workspace_id,
                    opts.conversation_id,
                    &synthesis_system_prompt,
                    &synthesis_messages,
                    &json!([]),
                    &live,
                    &mut accounting,
                    cancel,
                )
                .await
            {
                Ok(first_turn) => {
                    let turn_to_finalize = if has_literal_tool_call_syntax(&first_turn.content)
                        && !cancel.is_cancelled()
                    {
                        rounds_record.push(json!({
                            "text": first_turn.content,
                            "toolCalls": [],
                        }));
                        self.set_activity_phase(opts.workspace_id, "thinking", Some(""), false);
                        let mut flattened = flatten_history_for_prose_synthesis(&live_messages);
                        flattened.push(json!({
                            "role": "user",
                            "content": "Your previous synthesis response emitted raw tool-call markup (DSML/XML), which is invalid here because tools are disabled. Write your final answer to the user strictly in plain prose without any <｜DSML｜...>, <|DSML|...>, <tool_call>, <function_calls>, <invoke>, or <parameter> tags.",
                        }));
                        let no_live = LiveHistory::default();
                        self.call_model_with_retry(
                            model,
                            opts.workspace_id,
                            opts.conversation_id,
                            &synthesis_system_prompt,
                            &flattened,
                            &json!([]),
                            &no_live,
                            &mut accounting,
                            cancel,
                        )
                        .await
                    } else {
                        Ok(first_turn)
                    };
                    match turn_to_finalize {
                        Ok(t) => {
                            rounds_record.push(json!({
                                "text": t.content,
                                "toolCalls": [],
                            }));
                            let leaked = has_literal_tool_call_syntax(&t.content);
                            let final_text = if leaked {
                                strip_literal_tool_call_blocks(&t.content)
                            } else {
                                t.content.trim().to_owned()
                            };
                            if !final_text.is_empty() {
                                push_public_update(
                                    &mut public_updates,
                                    &mut public_update_chars,
                                    &final_text,
                                );
                                match persist_fallback_reply(
                                    &conv_store,
                                    opts.conversation_id,
                                    &turn_id,
                                    &current_input_anchors,
                                    &final_text,
                                ) {
                                    Ok(msg_id) => {
                                        final_end =
                                            TurnEndKind::ReplyCommitted { message_id: msg_id };
                                    }
                                    Err(err) => {
                                        trial_in_flight = false;
                                        final_end = self.record_turn_failure(
                                            &failure_ctx,
                                            err.code(),
                                            cancel,
                                        );
                                    }
                                }
                            } else if leaked && !cancel.is_cancelled() {
                                trial_in_flight = false;
                                final_end = self.record_turn_failure(
                                    &failure_ctx,
                                    "unsupported_tool_response",
                                    cancel,
                                );
                            }
                        }
                        Err(err) => {
                            trial_in_flight = false;
                            final_end = self.record_turn_failure(&failure_ctx, err.code, cancel);
                        }
                    }
                }
                Err(err) => {
                    trial_in_flight = false;
                    final_end = self.record_turn_failure(&failure_ctx, err.code, cancel);
                }
            }
        }

        let needs_wake_failure_fallback = opts.kind == "wake"
            && !cancel.is_cancelled()
            && !matches!(
                final_end,
                TurnEndKind::ReplyCommitted { .. }
                    | TurnEndKind::AwaitingChildren { .. }
                    | TurnEndKind::UserStopped
                    | TurnEndKind::Failed { .. }
                    | TurnEndKind::CircuitOpen
            )
            && turn_state
                .lock()
                .map(|s| s.reply_committed_id.is_none() && s.waiting_session_ids.is_empty())
                .unwrap_or(false);
        if needs_wake_failure_fallback {
            let mut failed_event_sids = Vec::new();
            let mut seen_sids = HashSet::new();
            for ev in opts.wake_events {
                let ev_kind = ev["kind"].as_str().unwrap_or("");
                let is_failure_event = ev_kind == "session_failed"
                    || (ev_kind == "session_ended"
                        && (ev["payload"]["status"].as_str() == Some("failed")
                            || ev["payload"]["error"].is_string()));
                if !is_failure_event {
                    continue;
                }
                if let Some(sid) = ev["payload"]["sessionId"]
                    .as_str()
                    .or_else(|| ev["sessionId"].as_str())
                    .filter(|s| !s.is_empty())
                    && seen_sids.insert(sid.to_owned())
                {
                    failed_event_sids.push(sid.to_owned());
                }
            }
            if !failed_event_sids.is_empty() {
                let live_sessions = self.supervisor.list_sessions(opts.workspace_id);
                let failed_summaries: Vec<crate::WorkSessionSummary> = failed_event_sids
                    .iter()
                    .filter_map(|sid| {
                        live_sessions
                            .iter()
                            .find(|s| s.session_id == *sid && s.status == "failed")
                            .cloned()
                    })
                    .collect();
                if !failed_summaries.is_empty() {
                    let (valid_user_ids, prior_keys, unreported_anchors) = turn_state
                        .lock()
                        .map(|s| {
                            (
                                s.valid_user_message_ids.clone(),
                                s.prior_report_fact_keys.clone(),
                                s.unreported_anchor_sessions.clone(),
                            )
                        })
                        .unwrap_or_default();
                    let project_session_ids: HashSet<String> =
                        live_sessions.iter().map(|s| s.session_id.clone()).collect();
                    let mut sources = Vec::new();
                    let mut status_claims = Vec::new();
                    let mut session_facts = Vec::new();
                    let mut reply_to = Vec::new();
                    let mut seen_anchors = HashSet::new();
                    let mut details = Vec::new();
                    for summary in &failed_summaries {
                        let rep = self
                            .supervisor
                            .read_report(opts.workspace_id, &summary.session_id)
                            .ok();
                        let reason_raw = rep
                            .as_ref()
                            .and_then(|r| {
                                r.failure_detail
                                    .as_deref()
                                    .or(r.failure_code.as_deref())
                                    .map(str::trim)
                                    .filter(|v| !v.is_empty())
                            })
                            .unwrap_or("执行异常中断");
                        let reason: String = reason_raw.chars().take(240).collect();
                        details.push((summary.title.clone(), summary.session_id.clone(), reason));
                        sources.push(summary.session_id.clone());
                        status_claims.push(crate::reply::StatusClaim {
                            session_id: summary.session_id.clone(),
                            status: "failed".to_owned(),
                        });
                        session_facts.push(crate::reply::SessionStatusFact {
                            session_id: summary.session_id.clone(),
                            status: summary.status.clone(),
                            source_revision: Some(summary.updated_at.clone()),
                            observation_revision: None,
                            independent_verifier: rep
                                .as_ref()
                                .map(|r| r.independent_verifier.clone()),
                            verdict_outcome: rep.as_ref().map(|r| r.verdict_outcome.clone()),
                            verdict_ref: rep.as_ref().map(|r| {
                                crate::acceptance::verdict_ref_for(
                                    &summary.session_id,
                                    &r.verdict_outcome,
                                )
                            }),
                        });
                        for anc in &summary.anchor_message_ids {
                            if valid_user_ids.contains(anc) && seen_anchors.insert(anc.clone()) {
                                reply_to.push(anc.clone());
                            }
                        }
                    }
                    let fallback_text = if details.len() == 1 {
                        let (title, _sid, reason) = &details[0];
                        format!(
                            "「{title}」没能顺利跑完：{reason}。\n\n如果你想换个思路或者让我再试一次，直接告诉我就可以。"
                        )
                    } else {
                        let lines: Vec<String> = details
                            .iter()
                            .map(|(title, _sid, reason)| format!("- 「{title}」：{reason}"))
                            .collect();
                        format!(
                            "有 {} 项任务没能顺利跑完：\n{}\n\n如果你想调整方案或重新来过，直接告诉我就可以。",
                            details.len(),
                            lines.join("\n")
                        )
                    };
                    let reply_id = format!("reply-wake-fallback-{turn_id}");
                    if let Ok(composed) =
                        crate::reply::compose_reply(crate::reply::ComposeReplyInput {
                            message_id: reply_id.clone(),
                            turn_id: Some(turn_id.clone()),
                            kind: "wake".into(),
                            text: fallback_text,
                            reply_to,
                            sources,
                            status_claims,
                            proactive: true,
                            question: None,
                            valid_user_message_ids: valid_user_ids,
                            project_session_ids,
                            session_facts,
                            memory_used: vec![],
                            memory_learned: vec![],
                            evidence_refs: vec![],
                            surfacing: crate::reply::Surfacing::Message,
                            prior_report_fact_keys: prior_keys,
                            unreported_anchor_sessions: unreported_anchors,
                        })
                        && !composed.suppressed_duplicate
                    {
                        let at = now_iso();
                        let mut msg = composed.message;
                        msg["createdAt"] = json!(at);
                        if let Some(meta) = msg["meta"].as_object_mut() {
                            meta.insert("fallback".into(), json!(true));
                        }
                        if conv_store
                            .append_message_idempotent(opts.conversation_id, &msg, &at, None)
                            .is_ok()
                            && let Ok(mut guard) = turn_state.lock()
                        {
                            for k in composed.report_fact_keys {
                                guard.prior_report_fact_keys.insert(k);
                            }
                            guard.reply_committed_id = Some(reply_id);
                        }
                    }
                }
            }
        }

        drop(admission);
        let _ = admission_task.await;

        let live_partial = self
            .activity_for(opts.workspace_id)
            .map(|a| a.reply_text.trim().to_owned())
            .unwrap_or_default();
        let snapshot = turn_state.lock().map(|s| s.clone()).unwrap_or_default();
        if let Some(msg_id) = snapshot.reply_committed_id {
            final_end = TurnEndKind::ReplyCommitted {
                message_id: msg_id.clone(),
            };
            if visible_activity {
                if msg_id == "suppressed" || msg_id == "silent" || msg_id.starts_with("digest:") {
                    self.dispose_activity(opts.workspace_id);
                } else {
                    self.set_activity_phase(opts.workspace_id, "done", None, true);
                }
            }
        } else if !snapshot.waiting_session_ids.is_empty() {
            let waiting_ids = snapshot.waiting_session_ids;
            if visible_activity {
                if public_updates.is_empty() {
                    let waiting_title = self
                        .supervisor
                        .list_sessions(opts.workspace_id)
                        .into_iter()
                        .find(|s| waiting_ids.contains(&s.session_id))
                        .map(|s| s.title);
                    let wait_at = now_iso();
                    self.update_activity(opts.workspace_id, |act| {
                        act.phase = "tool".to_owned();
                        let mut seg = json!({
                            "kind": "tool",
                            "id": format!("wait-{turn_id}"),
                            "name": "wait_for_sessions",
                            "status": "running",
                            "startedAt": wait_at,
                        });
                        if let Some(title) = waiting_title.as_deref().filter(|t| !t.is_empty()) {
                            seg["summary"] = json!(title);
                        }
                        act.segments = vec![seg];
                        act.finished_at = None;
                    });
                } else {
                    self.set_activity_phase(opts.workspace_id, "done", None, true);
                }
            }
            final_end = TurnEndKind::AwaitingChildren {
                session_ids: waiting_ids,
            };
        } else {
            let phase = match final_end {
                TurnEndKind::UserStopped => "stopped",
                TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "error",
                _ => "done",
            };
            if visible_activity {
                if matches!(final_end, TurnEndKind::Yielded) && public_updates.is_empty() {
                    self.dispose_activity(opts.workspace_id);
                } else {
                    self.set_activity_phase(opts.workspace_id, phase, None, true);
                }
            }
        }
        if !visible_activity {
            let status = match final_end {
                TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "error",
                _ => "idle",
            };
            self.set_status_only(opts.workspace_id, status);
        }

        match &final_end {
            TurnEndKind::UserStopped => {
                if trial_in_flight {
                    let _ = self
                        .breaker_store
                        .abandon_trial(opts.workspace_id, Some(&provider_scope));
                }
            }
            TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => {}
            _ => {
                let _ = self
                    .breaker_store
                    .record_success(opts.workspace_id, Some(&provider_scope));
            }
        }

        // Persist canonical usage ledger record when provider tokens were observed.
        let turn_usage = accounting.snapshot().turn_total;
        if turn_usage.provider_request_count > 0 && turn_usage.amounts != UsageAmounts::default() {
            let model_provider_id =
                if opts.worker_model_selection["modelId"].as_str() == Some(model.model_id()) {
                    opts.worker_model_selection["modelProviderId"]
                        .as_str()
                        .map(str::to_owned)
                } else {
                    None
                }
                .unwrap_or_else(|| format!("{}::{}", model.provider(), model.model_id()));
            let attribution = json!({
                "id": format!("bot_turn_{turn_id}"),
                "streamId": turn_id,
                "role": "project_agent",
                "workspaceId": opts.workspace_id,
                "model": model.model_id(),
                "providerName": model.provider(),
                "modelProviderId": model_provider_id,
            });
            let _ = conv_store.record_runtime_turn_usage(
                opts.conversation_id,
                &turn_usage,
                &attribution,
                None,
            );
        }

        // Persist durable hidden agent_turn process record for diagnostics and replay.
        let finished_at = now_iso();
        if matches!(final_end, TurnEndKind::UserStopped) {
            let raw_partial = if !live_partial.is_empty() {
                live_partial
            } else {
                public_updates
                    .last()
                    .and_then(|u| u["text"].as_str())
                    .unwrap_or("")
                    .trim()
                    .to_owned()
            };
            let partial_reply = strip_literal_tool_call_blocks(&raw_partial);
            let preview: String = partial_reply.chars().take(200).collect();
            let content = if preview.is_empty() {
                "已停止当前回复；可点击重试继续。".to_owned()
            } else {
                format!("已停止当前回复（保留片段）：{preview}")
            };
            let mut card_msg = json!({
                "id": format!("{turn_id}-stopped"),
                "role": "assistant",
                "kind": "system_card",
                "card": "agent_stopped",
                "turnId": turn_id,
                "replyTo": current_input_anchors,
                "content": content,
                "actions": ["retry"],
                "cards": [{
                    "cardId": format!("card:agent_stopped:{turn_id}"),
                    "kind": "agent_stopped",
                    "content": content,
                    "actions": [{
                        "id": "retry",
                        "channel": "project-agent:retry",
                        "payload": {
                            "workspaceId": opts.workspace_id,
                            "turnId": turn_id,
                        }
                    }]
                }],
                "createdAt": finished_at,
            });
            if !partial_reply.is_empty() {
                card_msg["partialReply"] = json!(partial_reply);
            }
            let _ = conv_store.append_message_idempotent(
                opts.conversation_id,
                &card_msg,
                &finished_at,
                None,
            );
        }
        let finished_ms = parse_iso_ms(&finished_at).unwrap_or(now_ms);
        let duration_ms = finished_ms.saturating_sub(now_ms).max(0);
        let outcome_label = match &final_end {
            TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "error",
            TurnEndKind::UserStopped => "stopped",
            _ => "done",
        };
        let diagnostic_timing = json!({
            "startedAt": now_str,
            "finishedAt": finished_at,
            "durationMs": duration_ms,
            "outcome": outcome_label,
        });
        let trace_offloaded = write_agent_turn_trace(
            &self.data_home,
            opts.workspace_id,
            &turn_id,
            &rounds_record,
            &public_updates,
            &diagnostic_timing,
        );
        let mut completed_tools_summary = Vec::new();
        if trace_offloaded && matches!(outcome_label, "stopped" | "error") {
            for round in &rounds_record {
                for tc in round["toolCalls"].as_array().into_iter().flatten() {
                    if completed_tools_summary.len() >= 16 {
                        break;
                    }
                    let name = tc["name"].as_str().unwrap_or("");
                    if name.is_empty() {
                        continue;
                    }
                    let ok = tc["result"]["ok"] == true;
                    let raw_summary = tc["result"]["error"]
                        .as_str()
                        .or_else(|| tc["result"]["status"].as_str())
                        .unwrap_or(if ok { "ok" } else { "failed" });
                    completed_tools_summary.push(json!({
                        "name": name,
                        "ok": ok,
                        "summary": redact_continuity_text(raw_summary, 200),
                    }));
                }
            }
        }
        let mut meta = json!({
            "workId": work_id,
            "diagnosticTiming": diagnostic_timing,
        });
        if !completed_tools_summary.is_empty() {
            meta["completedToolsSummary"] = json!(completed_tools_summary);
        }
        let mut agent_turn_msg = json!({
            "id": turn_id,
            "role": "assistant",
            "kind": "agent_turn",
            "turnId": turn_id,
            "turnKind": opts.kind,
            "userInputs": current_input_anchors,
            "replyTo": current_input_anchors,
            "content": "",
            "createdAt": finished_at,
            "meta": meta,
        });
        if trace_offloaded {
            agent_turn_msg["traceRef"] = json!(turn_id);
        } else {
            agent_turn_msg["rounds"] = json!(rounds_record);
            agent_turn_msg["publicUpdates"] = json!(public_updates);
        }
        let _ = conv_store.append_message_idempotent(
            opts.conversation_id,
            &agent_turn_msg,
            &finished_at,
            None,
        );

        if coord_active {
            let end_state = match &final_end {
                TurnEndKind::ReplyCommitted { .. } => "delivered",
                TurnEndKind::AwaitingChildren { .. } => "waiting_children",
                TurnEndKind::UserStopped => "stopped",
                TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "blocked",
                TurnEndKind::Yielded => "runnable",
            };
            let _ = self.coordination.ensure_work(
                opts.workspace_id,
                &work_id,
                opts.conversation_id,
                &input_ids,
                &snapshot.spawned_session_ids,
                end_state,
            );
        }

        if !matches!(
            final_end,
            TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen | TurnEndKind::UserStopped
        ) {
            let curator = crate::MemoryCurator::new(&self.data_home);
            if opts.kind == "user" && !opts.user_inputs.is_empty() {
                let texts: Vec<String> = opts.user_inputs.iter().map(|u| u.text.clone()).collect();
                let anchor = current_input_anchors.last().map(String::as_str);
                let _ = curator.record_user_inputs(opts.workspace_id, &texts, anchor, &finished_at);
            } else if opts.kind == "wake" && !opts.wake_events.is_empty() {
                let _ =
                    curator.record_task_events(opts.workspace_id, opts.wake_events, &finished_at);
            }
        }

        Ok(AgentTurnOutcome {
            turn_id,
            end: final_end,
            spawned_session_ids: snapshot.spawned_session_ids,
            tool_calls: total_tool_calls,
        })
    }
}

fn read_global_communication_style(data_home: &Path) -> String {
    let Ok(raw) = std::fs::read_to_string(data_home.join("settings.json")) else {
        return "natural".to_owned();
    };
    let Ok(value) = serde_json::from_str::<Value>(&raw) else {
        return "natural".to_owned();
    };
    match value
        .get("projectAgent")
        .and_then(|pa| pa.get("communicationStyle"))
        .and_then(Value::as_str)
    {
        Some(style @ ("natural" | "concise" | "detailed" | "technical")) => style.to_owned(),
        _ => "natural".to_owned(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex as StdMutex;
    use tempfile::tempdir;

    #[test]
    fn global_personalization_style_and_system_instructions_reach_project_bot() {
        let dir = tempdir().unwrap();
        let workspace = tempdir().unwrap();
        std::fs::write(
            dir.path().join("settings.json"),
            json!({
                "schemaVersion": 3,
                "systemInstructions": "先给结论，少用内部术语。",
                "shortcuts": { "toggleSidebar": "Cmd+\\" },
                "projectAgent": {
                    "shell": "bots",
                    "interactiveResults": true,
                    "communicationStyle": "concise"
                }
            })
            .to_string(),
        )
        .unwrap();

        let global_style = read_global_communication_style(dir.path());
        assert_eq!(global_style, "concise");

        let (mut profile, _) = BotProfileStore::new(dir.path())
            .create(&crate::CreateBotProfile {
                workspace_id: "ws-style-inherit",
                display_name: "Demo",
                managed: false,
                agent_conversation_id: "conv-1",
                avatar_salt: "salt",
            })
            .unwrap();
        // Unset or "inherit" follows global default ("concise")
        assert_eq!(
            profile.effective_communication_style(&global_style),
            "concise"
        );
        profile.communication_style = Some("inherit".to_owned());
        assert_eq!(
            profile.effective_communication_style(&global_style),
            "concise"
        );
        // Explicit per-bot override wins over global default
        profile.communication_style = Some("technical".to_owned());
        assert_eq!(
            profile.effective_communication_style(&global_style),
            "technical"
        );

        // Desktop-only keys in settings.json must NOT prevent systemInstructions from loading
        let cancel = CancellationToken::new();
        let instructions =
            ProjectInstructions::observe_desktop_host(workspace.path(), dir.path(), None, &cancel)
                .expect("observe_desktop_host succeeds with desktop keys");
        let rendered = instructions
            .sections()
            .into_iter()
            .map(|s| s.to_string())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            rendered.contains("先给结论，少用内部术语。"),
            "systemInstructions must reach project bot instructions, got: {rendered}"
        );
    }

    #[test]
    fn per_workspace_activity_and_listener_emit_status_transitions() {
        let dir = tempdir().unwrap();
        let sup = Arc::new(SessionSupervisor::new(dir.path(), None));
        let runner = ProjectAgentRunner::new(dir.path(), sup);
        let events: Arc<StdMutex<Vec<(String, String, u64)>>> = Arc::new(StdMutex::new(Vec::new()));
        let events_cb = Arc::clone(&events);
        runner.set_activity_listener(Some(Arc::new(move |act, status| {
            events_cb
                .lock()
                .unwrap()
                .push((act.workspace_id, status, act.revision));
        })));

        runner.init_activity(ProjectAgentActivity {
            workspace_id: "ws-a".into(),
            conversation_id: "conv-a".into(),
            turn_id: "turn-a".into(),
            work_id: Some("work-a".into()),
            revision: 1,
            started_at: "2026-11-22T00:00:00.000Z".into(),
            finished_at: None,
            reply_to: vec![],
            phase: "thinking".into(),
            reply_text: String::new(),
            segments: vec![],
        });
        let serialized_a = serde_json::to_value(runner.activity_for("ws-a").unwrap()).unwrap();
        assert_eq!(serialized_a["segments"], json!([]));
        assert_eq!(serialized_a["workId"], json!("work-a"));

        runner.init_activity(ProjectAgentActivity {
            workspace_id: "ws-b".into(),
            conversation_id: "conv-b".into(),
            turn_id: "turn-b".into(),
            work_id: None,
            revision: 1,
            started_at: "2026-11-22T00:00:00.000Z".into(),
            finished_at: None,
            reply_to: vec![],
            phase: "waiting".into(),
            reply_text: String::new(),
            segments: vec![],
        });
        runner.record_activity_tool_start(
            "ws-a",
            "tc-1",
            "read_file",
            None,
            "2026-11-22T00:00:01.000Z",
        );
        assert_eq!(
            runner.activity_for("ws-a").unwrap().segments,
            vec![json!({
                "kind": "tool",
                "id": "tc-1",
                "name": "read_file",
                "status": "running",
                "startedAt": "2026-11-22T00:00:01.000Z",
            })]
        );
        runner.record_activity_tool_finish("ws-a", "tc-1", true, "2026-11-22T00:00:02.000Z");
        assert_eq!(
            runner.activity_for("ws-a").unwrap().segments,
            vec![json!({
                "kind": "tool",
                "id": "tc-1",
                "name": "read_file",
                "status": "done",
                "startedAt": "2026-11-22T00:00:01.000Z",
                "finishedAt": "2026-11-22T00:00:02.000Z",
            })]
        );
        runner.set_activity_phase("ws-a", "responding", Some("hello"), false);
        runner.set_activity_phase("ws-a", "done", None, true);

        assert_eq!(runner.status_for("ws-a").as_deref(), Some("idle"));
        assert_eq!(
            runner.status_for("ws-b").as_deref(),
            Some("waiting_provider")
        );
        assert_eq!(runner.activity_for("ws-a").unwrap().reply_text, "hello");
        let log = events.lock().unwrap();
        assert_eq!(log.len(), 6);
        assert_eq!(log[2], ("ws-a".to_owned(), "thinking".to_owned(), 2));
        assert_eq!(log[3], ("ws-a".to_owned(), "thinking".to_owned(), 3));
        assert_eq!(log[4], ("ws-a".to_owned(), "thinking".to_owned(), 4));
        assert_eq!(log[5], ("ws-a".to_owned(), "idle".to_owned(), 5));
        drop(log);

        runner.dispose_activity("ws-a");
        assert!(runner.activity_for("ws-a").is_none());
        assert_eq!(runner.status_for("ws-a").as_deref(), Some("idle"));
        assert!(runner.activity_for("ws-b").is_some());
        runner.dispose_activity("ws-b");
        assert!(runner.activity_for("ws-b").is_none());
        assert_eq!(runner.status_for("ws-b").as_deref(), Some("idle"));
        let log = events.lock().unwrap();
        assert_eq!(log.len(), 8);
        assert_eq!(log[6], ("ws-a".to_owned(), "idle".to_owned(), 6));
        assert_eq!(log[7], ("ws-b".to_owned(), "idle".to_owned(), 2));
    }

    #[test]
    fn dispose_activity_emits_disposed_snapshot_with_empty_payloads() {
        let dir = tempdir().unwrap();
        let sup = Arc::new(SessionSupervisor::new(dir.path(), None));
        let runner = ProjectAgentRunner::new(dir.path(), sup);
        let captured: Arc<StdMutex<Vec<(ProjectAgentActivity, String)>>> =
            Arc::new(StdMutex::new(Vec::new()));
        let cap_cb = Arc::clone(&captured);
        runner.set_activity_listener(Some(Arc::new(move |act, st| {
            cap_cb.lock().unwrap().push((act, st));
        })));
        runner.init_activity(ProjectAgentActivity {
            workspace_id: "ws-d".into(),
            conversation_id: "conv-d".into(),
            turn_id: "turn-d".into(),
            work_id: Some("work-d".into()),
            revision: 1,
            started_at: "2026-11-22T00:00:00.000Z".into(),
            finished_at: None,
            reply_to: vec![],
            phase: "responding".into(),
            reply_text: "draft".into(),
            segments: vec![
                json!({ "kind": "tool", "id": "tc-1", "name": "read_file", "status": "done" }),
            ],
        });
        runner.dispose_activity("ws-d");
        assert!(runner.activity_for("ws-d").is_none());
        assert_eq!(runner.status_for("ws-d").as_deref(), Some("idle"));
        let items = captured.lock().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[1].0.phase, "disposed");
        assert_eq!(items[1].0.reply_text, "");
        assert!(items[1].0.segments.is_empty());
        assert!(items[1].0.finished_at.is_some());
        assert_eq!(items[1].1, "idle");
    }

    #[test]
    fn format_tool_outcome_output_preserves_error_code_when_output_empty() {
        let failed = EffectOutcome::failed("path_not_found");
        assert_eq!(
            format_tool_outcome_output(&failed),
            json!({
                "ok": false,
                "status": "failed",
                "error": "path_not_found",
            })
        );

        let mut structured = EffectOutcome::failed("git_path_not_found");
        structured.output = json!({ "reason": "git_path_not_found" });
        assert_eq!(
            format_tool_outcome_output(&structured),
            json!({ "reason": "git_path_not_found" })
        );

        let mut partial_obj = EffectOutcome::failed("read_denied");
        partial_obj.output = json!({ "path": "secret" });
        assert_eq!(
            format_tool_outcome_output(&partial_obj),
            json!({ "path": "secret", "ok": false, "error": "read_denied" })
        );

        let ok = EffectOutcome {
            status: "success",
            output: json!({ "ok": true, "content": "hi" }),
            error: None,
            artifacts: vec![],
            ended: true,
            materialization: None,
            not_dispatched: false,
        };
        assert_eq!(
            format_tool_outcome_output(&ok),
            json!({ "ok": true, "content": "hi" })
        );
    }

    #[test]
    fn persist_fallback_reply_propagates_store_error() {
        let dir = tempdir().unwrap();
        let conv_store = ConversationStore::new(dir.path());
        let err = persist_fallback_reply(
            &conv_store,
            "missing-conv",
            "turn-missing",
            &["input-1".into()],
            "fallback text",
        )
        .unwrap_err();
        assert_eq!(err, peer_store::StoreError::NotFound);

        let meta = conv_store
            .create(
                &peer_store::NewConversation {
                    title: "Mismatch",
                    workspace_path: None,
                    mode: "chat",
                    created_at: "2026-11-22T00:00:00.000Z",
                },
                None,
            )
            .unwrap();
        let conv_id = meta["id"].as_str().unwrap();
        std::fs::write(
            dir.path().join(format!("conversations/{conv_id}.jsonl")),
            "{\"id\":\"u-1\",\"role\":\"user\",\"content\":\"hi\"}\n",
        )
        .unwrap();
        let err = persist_fallback_reply(
            &conv_store,
            conv_id,
            "turn-mismatch",
            &["input-1".into()],
            "fallback text",
        )
        .unwrap_err();
        assert_eq!(err, peer_store::StoreError::CommitUncertain);
    }

    #[test]
    fn load_bot_history_skips_pure_dsml_and_strips_leaked_blocks_from_mixed_replies() {
        let messages = vec![
            json!({ "id": "in-1", "role": "user", "kind": "user_input", "content": "hi" }),
            json!({
                "id": "reply-pure-dsml",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"read_file\">\n<｜DSML｜ parameter name=\"path\" string=\"true\">foo.css</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>"
            }),
            json!({ "id": "in-2", "role": "user", "kind": "user_input", "content": "next?" }),
            json!({
                "id": "reply-mixed",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Part one done.\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"search_files\"></｜DSML｜ invoke>\n</｜DSML｜ calls>"
            }),
        ];
        let loaded = load_bot_history(&messages);
        assert_eq!(loaded.live_messages.len(), 3);
        assert_eq!(loaded.live_messages[0]["content"], "hi");
        assert_eq!(loaded.live_messages[1]["content"], "next?");
        assert_eq!(loaded.live_messages[2]["content"], "Part one done.");
        assert_eq!(
            loaded.committed_message_ids,
            vec![
                Some("in-1".to_owned()),
                Some("in-2".to_owned()),
                Some("reply-mixed".to_owned())
            ]
        );
    }

    #[test]
    fn flatten_history_for_prose_synthesis_removes_tool_messages_and_preserves_observations() {
        let messages = vec![
            json!({ "role": "user", "content": "Inspect CSS" }),
            json!({
                "role": "assistant",
                "content": Value::Null,
                "toolCalls": [{ "id": "tc-1", "name": "read_file", "arguments": "{\"path\":\"a.css\"}" }]
            }),
            json!({
                "role": "tool",
                "toolCallId": "tc-1",
                "name": "read_file",
                "content": "{\"ok\":true,\"text\":\"<｜DSML｜ calls> body\"}"
            }),
        ];
        let flattened = flatten_history_for_prose_synthesis(&messages);
        assert_eq!(flattened.len(), 2);
        assert!(
            flattened
                .iter()
                .all(|m| m["role"] == "user" || m["role"] == "assistant")
        );
        assert!(flattened.iter().all(|m| m.get("toolCalls").is_none()));
        let obs = flattened[1]["content"].as_str().unwrap();
        assert!(obs.contains("read_file"));
        assert!(!obs.contains("<｜DSML｜"));
    }

    #[test]
    fn activity_tool_summary_extracts_safe_hints_and_filters_secrets() {
        assert_eq!(
            activity_tool_summary(
                "read_file",
                &json!({"path": "apps/desktop/src/provider-settings.css"})
            )
            .as_deref(),
            Some("apps/desktop/src/provider-settings.css")
        );
        assert_eq!(
            activity_tool_summary("search_files", &json!({"query": "llm-group"})).as_deref(),
            Some("llm-group")
        );
        assert_eq!(
            activity_tool_summary("post_reply", &json!({"text": "done"})),
            None
        );
        assert_eq!(
            activity_tool_summary("read_file", &json!({"path": "foo\nbar"})),
            None
        );
        assert_eq!(
            activity_tool_summary(
                "search_files",
                &json!({"query": "sk-proj-abcdefghijklmnopqrstuvwxyz123456"})
            ),
            None
        );
        assert_eq!(
            activity_tool_summary("git_query", &json!({"operation": "snapshot", "path": "."}))
                .as_deref(),
            Some("snapshot")
        );
        assert_eq!(
            activity_tool_summary(
                "git_query",
                &json!({"operation": "status", "path": "Peer-Agent"})
            )
            .as_deref(),
            Some("Peer-Agent")
        );
    }

    #[test]
    fn compact_persisted_tool_result_preserves_small_and_shrinks_large_payloads() {
        let small = json!({ "ok": true, "sessions": [{ "id": "s1" }] });
        assert_eq!(compact_persisted_tool_result(&small), small);

        let huge_content = "A".repeat(25_000);
        let many_matches: Vec<Value> = (0..40)
            .map(|i| json!({ "path": format!("src/file_{i}.rs"), "line": i }))
            .collect();
        let big = json!({
            "kind": "file_read_result",
            "tool": "read_file",
            "status": "success",
            "path": "/very/long/path/preserved/without/truncation",
            "content": huge_content,
            "matches": many_matches,
        });
        let compacted = compact_persisted_tool_result(&big);
        assert_eq!(compacted["kind"], "file_read_result");
        assert_eq!(compacted["tool"], "read_file");
        assert_eq!(compacted["status"], "success");
        assert_eq!(
            compacted["path"],
            "/very/long/path/preserved/without/truncation"
        );
        let kept_content = compacted["content"].as_str().unwrap();
        assert!(kept_content.ends_with("…[truncated]"));
        assert!(kept_content.chars().count() < 2_050);
        assert_eq!(compacted["matches"].as_array().unwrap().len(), 25);
        assert_eq!(compacted["matchesTruncatedCount"], 40);
    }

    #[test]
    fn agent_turn_trace_offload_hydrates_for_directory_and_retry_continuity() {
        let dir = tempdir().unwrap();
        let ws_id = "ws-trace";
        let turn_id = "turn-offload-1";
        let rounds = vec![json!({
            "text": "Checking workspace layout",
            "toolCalls": [{
                "name": "list_files",
                "input": { "path": "." },
                "result": { "ok": true, "entries": ["README.md"] }
            }]
        })];
        let updates = vec![json!({ "text": "Checking workspace layout" })];
        let timing = json!({
            "startedAt": "2026-11-22T00:00:00.000Z",
            "finishedAt": "2026-11-22T00:00:01.000Z",
            "durationMs": 1000,
            "outcome": "stopped",
        });

        assert!(write_agent_turn_trace(
            dir.path(),
            ws_id,
            turn_id,
            &rounds,
            &updates,
            &timing,
        ));
        assert!(
            turn_trace_path(dir.path(), ws_id, turn_id)
                .unwrap()
                .is_file()
        );

        let mut stub = json!({
            "id": turn_id,
            "role": "assistant",
            "kind": "agent_turn",
            "turnId": turn_id,
            "traceRef": turn_id,
            "content": "",
            "createdAt": "2026-11-22T00:00:01.000Z",
        });
        assert!(stub.get("rounds").is_none());
        hydrate_agent_turn_record(dir.path(), ws_id, &mut stub);
        assert_eq!(stub["rounds"], json!(rounds));
        assert_eq!(stub["publicUpdates"], json!(updates));

        let messages = vec![json!({
            "id": turn_id,
            "role": "assistant",
            "kind": "agent_turn",
            "turnId": turn_id,
            "traceRef": turn_id,
            "userInputs": ["input-offload-1"],
            "replyTo": ["input-offload-1"],
            "content": "",
            "createdAt": "2026-11-22T00:00:01.000Z",
            "meta": {
                "diagnosticTiming": timing,
            }
        })];
        let anchors = vec!["input-offload-1".to_owned()];
        let continuity =
            read_retry_continuity_in(Some(dir.path()), Some(ws_id), &messages, &anchors, None)
                .expect("retry continuity hydrated from offloaded trace");
        assert_eq!(continuity["previousTurnId"], turn_id);
        assert_eq!(continuity["partialReply"], "Checking workspace layout");
        let tools = continuity["completedTools"].as_array().unwrap();
        assert_eq!(tools.len(), 1);
        assert_eq!(tools[0]["name"], "list_files");
    }
}
