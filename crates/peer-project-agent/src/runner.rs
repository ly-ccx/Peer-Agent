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
    BotProfileStore, MemoryFilter, MemoryStore, ObjectiveStore, ProjectError, ProjectInput,
    SessionSupervisor,
    circuit_breaker::{CircuitAdmit, CircuitBreakerStore},
    is_effective_memory, now_iso, parse_iso_ms,
    provider::{ProjectCapabilityProvider, TurnExecutionState},
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
    usage_accounting::{RequestMetadata, RuntimeUsageAccounting},
};
use peer_store::{ConversationStore, EvidenceIndexStore, HostToolEvidence};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const USER_MAX_BOT_ROUNDS: usize = 10;
const USER_MAX_BOT_TOOL_CALLS: usize = 20;
const WAKE_MAX_BOT_ROUNDS: usize = 6;
const WAKE_MAX_BOT_TOOL_CALLS: usize = 12;
const MAX_BOT_HISTORY_MESSAGES: usize = 40;
const MAX_STREAM_TEXT_BYTES: usize = 32_000;
const MAX_PUBLIC_UPDATES: usize = 100;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectAgentActivity {
    pub workspace_id: String,
    pub conversation_id: String,
    pub turn_id: String,
    pub revision: u64,
    pub started_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub finished_at: Option<String>,
    pub reply_to: Vec<String>,
    pub phase: String,
    pub reply_text: String,
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

pub struct ProjectAgentRunner {
    data_home: PathBuf,
    supervisor: Arc<SessionSupervisor>,
    breaker_store: CircuitBreakerStore,
    last_workspace_id: Mutex<Option<String>>,
    retry_delays_ms: Mutex<Vec<u64>>,
    activity: Mutex<Option<ProjectAgentActivity>>,
}

impl ProjectAgentRunner {
    pub fn new(data_home: impl AsRef<Path>, supervisor: Arc<SessionSupervisor>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            breaker_store: CircuitBreakerStore::new(&home),
            data_home: home,
            supervisor,
            last_workspace_id: Mutex::new(None),
            retry_delays_ms: Mutex::new(SAME_PROVIDER_RETRY_DELAYS_MS.to_vec()),
            activity: Mutex::new(None),
        }
    }

    pub fn current_activity(&self) -> Option<ProjectAgentActivity> {
        self.activity.lock().ok().and_then(|g| g.clone())
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

    fn set_activity_phase(&self, phase: &str, text: Option<&str>, finished: bool) {
        if let Ok(mut guard) = self.activity.lock()
            && let Some(ref mut act) = *guard
        {
            act.revision += 1;
            act.phase = phase.to_owned();
            if let Some(t) = text {
                act.reply_text = clip_utf8_bytes(t, MAX_STREAM_TEXT_BYTES).to_owned();
            }
            if finished {
                act.finished_at = Some(now_iso());
            }
        }
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
                && !m["content"].as_str().unwrap_or("").trim().is_empty()
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
        live_messages.push(json!({
            "role": m["role"],
            "content": m["content"].as_str().unwrap_or(""),
        }));
        committed_message_ids.push(m["id"].as_str().map(str::to_owned));
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
            Some("user") => expanded.push(msg.clone()),
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
) -> String {
    let msg_id = format!("reply-{turn_id}");
    let at = now_iso();
    let _ = conv_store.append_message_idempotent(
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
    );
    msg_id
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
            let stream_buf = Arc::new(Mutex::new(String::new()));
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
                                self.set_activity_phase("thinking", None, false);
                            }
                            ModelDelta::Text(chunk) => {
                                if !chunk.is_empty()
                                    && let Ok(mut buf) = stream_buf.lock()
                                {
                                    let avail = MAX_STREAM_TEXT_BYTES.saturating_sub(buf.len());
                                    if avail > 0 {
                                        buf.push_str(clip_utf8_bytes(chunk, avail));
                                    }
                                    self.set_activity_phase("responding", Some(&buf), false);
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
                    self.set_activity_phase("thinking", Some(""), false);
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
                .read_committed(opts.conversation_id, None, 1024 * 1024)
                .is_ok()
        {
            let _ = std::fs::create_dir_all(&conv_dir);
            let _ = std::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(&conv_file);
        }
        let history_messages = conv_store
            .read_committed(opts.conversation_id, None, 4 * 1024 * 1024)
            .map(|snap| snap.history.messages)
            .unwrap_or_default();

        let mut valid_user_ids = HashSet::new();
        let mut prior_report_fact_keys = HashSet::new();
        for msg in &history_messages {
            let kind = msg["kind"].as_str().unwrap_or("");
            if (kind == "user_input" || (kind.is_empty() && msg["role"] == "user"))
                && compaction_marker(msg).is_none()
                && let Some(id) = msg["id"].as_str()
            {
                valid_user_ids.insert(id.to_owned());
            }
            if kind == "agent_reply"
                && let Some(keys) = msg["meta"]["reportFactKeys"].as_array()
            {
                for k in keys {
                    if let Some(s) = k.as_str() {
                        prior_report_fact_keys.insert(s.to_owned());
                    }
                }
            }
        }

        let current_input_anchors: Vec<String> = opts
            .user_inputs
            .iter()
            .map(|i| format!("input-{}", i.input_id))
            .collect();
        for a in &current_input_anchors {
            valid_user_ids.insert(a.clone());
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

        if let Ok(mut guard) = self.activity.lock() {
            *guard = Some(ProjectAgentActivity {
                workspace_id: opts.workspace_id.to_owned(),
                conversation_id: opts.conversation_id.to_owned(),
                turn_id: turn_id.clone(),
                revision: 1,
                started_at: now_str.clone(),
                finished_at: None,
                reply_to: current_input_anchors.clone(),
                phase: "thinking".into(),
                reply_text: String::new(),
            });
        }

        let profile = BotProfileStore::new(&self.data_home).read(opts.workspace_id);
        let bot_name = profile
            .as_ref()
            .map(|p| p.display_name.as_str())
            .unwrap_or("Peer Bot");
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
        let sessions = self.supervisor.list_sessions(opts.workspace_id);
        let objectives = ObjectiveStore::new(&self.data_home)
            .list(opts.workspace_id)
            .unwrap_or_default();
        let instructions =
            ProjectInstructions::observe_host(opts.workspace_path, &self.data_home, cancel)
                .unwrap_or_default();

        let LoadedBotHistory {
            mut continuity_summary,
            mut compaction_epoch,
            mut live_messages,
            mut committed_message_ids,
        } = load_bot_history(&history_messages);

        if live_messages.is_empty() || opts.kind == "wake" {
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

        let build_system_prompt = |continuity: Option<&str>| {
            assemble_project_agent_context(&ProjectAgentContextInput {
                workspace_id: opts.workspace_id,
                workspace_path: &opts.workspace_path.to_string_lossy(),
                bot_name,
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
            prior_report_fact_keys,
            worker_model_selection: opts.worker_model_selection.clone(),
            reply_committed_id: None,
            waiting_session_ids: vec![],
            spawned_session_ids: vec![],
            memory_learned: vec![],
            memory_used: vec![],
            holds_lease: opts.holds_lease,
        }));

        let mut registry = ProviderRegistry::for_project_agent();
        registry.register(Box::new(ProjectCapabilityProvider::new(
            &self.data_home,
            Arc::clone(&self.supervisor),
            Arc::clone(&turn_state),
        )));
        let projection = registry.project_for_mode(RuntimeMode::ProjectAgent, None)?;
        let tools_json = projection.definitions();

        let (admission, admission_task) =
            EffectAdmission::spawn_read_only_host(cancel.clone(), || true);
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

        for _round in 0..max_rounds {
            if cancel.is_cancelled() {
                final_end = TurnEndKind::UserStopped;
                break;
            }
            self.set_activity_phase("thinking", None, false);
            let mut model_turn = match self
                .call_model_with_retry(
                    model,
                    opts.conversation_id,
                    &system_prompt,
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
                            live = LiveHistory::default();
                            match self
                                .call_model_with_retry(
                                    model,
                                    opts.conversation_id,
                                    &system_prompt,
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

            push_public_update(
                &mut public_updates,
                &mut public_update_chars,
                &model_turn.content,
            );

            if model_turn.calls.is_empty() {
                rounds_record.push(json!({
                    "text": model_turn.content,
                    "toolCalls": [],
                }));
                if opts.kind == "user" && !model_turn.content.trim().is_empty() {
                    let msg_id = persist_fallback_reply(
                        &conv_store,
                        opts.conversation_id,
                        &turn_id,
                        &current_input_anchors,
                        model_turn.content.trim(),
                    );
                    final_end = TurnEndKind::ReplyCommitted { message_id: msg_id };
                }
                break;
            }

            let mut assistant_tool_calls = Vec::new();
            let mut tool_results = Vec::new();
            let mut round_tool_records = Vec::new();
            let mut executed_ids = Vec::new();
            let mut stop_loop = false;

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
                self.set_activity_phase("tool", None, false);

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

                let completed_at = now_iso();
                let ended_ms = parse_iso_ms(&completed_at).unwrap_or(started_ms);
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

                round_tool_records.push(json!({
                    "name": call.name,
                    "input": call.arguments,
                    "result": outcome.output,
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
                    "content": serde_json::to_string(&outcome.output).unwrap_or_else(|_| "{}".into()),
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

            if stop_loop {
                break;
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
            self.set_activity_phase("thinking", None, false);
            match self
                .call_model_with_retry(
                    model,
                    opts.conversation_id,
                    &system_prompt,
                    &live_messages,
                    &json!([]),
                    &live,
                    &mut accounting,
                    cancel,
                )
                .await
            {
                Ok(t) => {
                    push_public_update(&mut public_updates, &mut public_update_chars, &t.content);
                    rounds_record.push(json!({
                        "text": t.content,
                        "toolCalls": [],
                    }));
                    let trimmed = t.content.trim();
                    if !trimmed.is_empty() {
                        let msg_id = persist_fallback_reply(
                            &conv_store,
                            opts.conversation_id,
                            &turn_id,
                            &current_input_anchors,
                            trimmed,
                        );
                        final_end = TurnEndKind::ReplyCommitted { message_id: msg_id };
                    }
                }
                Err(err) => {
                    trial_in_flight = false;
                    final_end = self.record_turn_failure(&failure_ctx, err.code, cancel);
                }
            }
        }

        drop(admission);
        let _ = admission_task.await;

        let snapshot = turn_state.lock().map(|s| s.clone()).unwrap_or_default();
        if let Some(msg_id) = snapshot.reply_committed_id {
            final_end = TurnEndKind::ReplyCommitted { message_id: msg_id };
            self.set_activity_phase("done", None, true);
        } else if !snapshot.waiting_session_ids.is_empty() {
            final_end = TurnEndKind::AwaitingChildren {
                session_ids: snapshot.waiting_session_ids,
            };
            self.set_activity_phase("done", None, true);
        } else {
            let phase = match final_end {
                TurnEndKind::UserStopped => "stopped",
                TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "error",
                _ => "done",
            };
            self.set_activity_phase(phase, None, true);
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
        let finished_ms = parse_iso_ms(&finished_at).unwrap_or(now_ms);
        let duration_ms = finished_ms.saturating_sub(now_ms).max(0);
        let outcome_label = match &final_end {
            TurnEndKind::Failed { .. } | TurnEndKind::CircuitOpen => "error",
            TurnEndKind::UserStopped => "stopped",
            _ => "done",
        };
        let _ = conv_store.append_message_idempotent(
            opts.conversation_id,
            &json!({
                "id": turn_id,
                "role": "assistant",
                "kind": "agent_turn",
                "turnId": turn_id,
                "turnKind": opts.kind,
                "userInputs": current_input_anchors,
                "replyTo": current_input_anchors,
                "content": "",
                "rounds": rounds_record,
                "publicUpdates": public_updates,
                "createdAt": finished_at,
                "meta": {
                    "diagnosticTiming": {
                        "startedAt": now_str,
                        "finishedAt": finished_at,
                        "durationMs": duration_ms,
                        "outcome": outcome_label,
                    }
                }
            }),
            &finished_at,
            None,
        );

        Ok(AgentTurnOutcome {
            turn_id,
            end: final_end,
            spawned_session_ids: snapshot.spawned_session_ids,
            tool_calls: total_tool_calls,
        })
    }
}
