//! Single-threaded per-workspace ProjectAgentRunner actor (ADR 80, ADR 85, ADR 88, ADR 94).
//!
//! Runs main Bot cognition turns through `peer_runtime::model::NativeModel` and
//! `ProviderRegistry::project_for_mode(RuntimeMode::ProjectAgent, None)` +
//! `EffectAdmission::spawn_read_only_host`, enforces circuit breaker (5 consecutive
//! failures -> 10m cooldown), tracks ephemeral `ProjectAgentActivity`, and supports
//! clean per-turn cancellation without disrupting delegated child sessions.

use crate::{
    BotProfileStore, MemoryFilter, MemoryStore, ObjectiveStore, ProjectError, ProjectInput,
    SessionSupervisor, is_effective_memory, now_iso, parse_iso_ms,
    provider::{ProjectCapabilityProvider, TurnExecutionState},
    system_context::{ProjectAgentContextInput, assemble_project_agent_context},
};
use peer_runtime::{
    CancellationToken,
    model::{LiveHistory, NativeModel},
    providers::{EffectAdmission, EffectOutcome, ProviderCall, ProviderRegistry, RuntimeMode},
    system_context::instructions::ProjectInstructions,
};
use peer_store::{ConversationStore, EvidenceIndexStore, HostToolEvidence};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

const CIRCUIT_FAILURE_THRESHOLD: u32 = 5;
const CIRCUIT_OPEN_MS: i64 = 10 * 60 * 1000;
const MAX_BOT_ROUNDS: usize = 10;
const MAX_BOT_TOOL_CALLS: usize = 24;

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

#[derive(Debug, Clone, Default)]
pub struct CircuitBreaker {
    consecutive_failures: u32,
    open_until_ms: Option<i64>,
    last_reason: Option<String>,
}

impl CircuitBreaker {
    pub fn is_open(&self, now_ms: i64) -> bool {
        self.open_until_ms.is_some_and(|until| now_ms < until)
    }

    pub fn record_success(&mut self) {
        self.consecutive_failures = 0;
        self.open_until_ms = None;
        self.last_reason = None;
    }

    pub fn record_failure(&mut self, reason: &str, now_ms: i64) -> bool {
        self.consecutive_failures = self.consecutive_failures.saturating_add(1);
        self.last_reason = Some(reason.to_owned());
        if self.consecutive_failures >= CIRCUIT_FAILURE_THRESHOLD {
            self.open_until_ms = Some(now_ms + CIRCUIT_OPEN_MS);
            true
        } else {
            false
        }
    }

    pub fn reset_manual(&mut self) {
        self.record_success();
    }
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
    breaker: Mutex<CircuitBreaker>,
    activity: Mutex<Option<ProjectAgentActivity>>,
}

impl ProjectAgentRunner {
    pub fn new(data_home: impl AsRef<Path>, supervisor: Arc<SessionSupervisor>) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
            supervisor,
            breaker: Mutex::new(CircuitBreaker::default()),
            activity: Mutex::new(None),
        }
    }

    pub fn current_activity(&self) -> Option<ProjectAgentActivity> {
        self.activity.lock().ok().and_then(|g| g.clone())
    }

    pub fn reset_circuit_breaker(&self) {
        if let Ok(mut b) = self.breaker.lock() {
            b.reset_manual();
        }
    }

    fn set_activity_phase(&self, phase: &str, text: Option<&str>, finished: bool) {
        if let Ok(mut guard) = self.activity.lock()
            && let Some(ref mut act) = *guard
        {
            act.revision += 1;
            act.phase = phase.to_owned();
            if let Some(t) = text {
                act.reply_text = t.to_owned();
            }
            if finished {
                act.finished_at = Some(now_iso());
            }
        }
    }

    fn record_turn_failure(
        &self,
        conv_store: &ConversationStore,
        conversation_id: &str,
        turn_id: &str,
        code: &'static str,
        now_ms: i64,
        cancel: &CancellationToken,
    ) -> TurnEndKind {
        if cancel.is_cancelled() || code == "CANCELLED" {
            return TurnEndKind::UserStopped;
        }
        let tripped = self
            .breaker
            .lock()
            .map(|mut b| b.record_failure(code, now_ms))
            .unwrap_or(false);
        if tripped {
            let at = now_iso();
            let _ = conv_store.append_message_idempotent(
                conversation_id,
                &json!({
                    "id": format!("{turn_id}-circuit"),
                    "role": "assistant",
                    "kind": "system_card",
                    "content": "代理连续失败，已暂停自动推进。十分钟后再试，也可以现在手动重试。",
                    "createdAt": at,
                }),
                &at,
                None,
            );
        }
        TurnEndKind::Failed {
            code: code.to_owned(),
        }
    }
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

impl ProjectAgentRunner {
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
        let turn_id = format!("turn-{}", uuid::Uuid::new_v4());
        let now_str = now_iso();
        let now_ms = parse_iso_ms(&now_str).unwrap_or(0);

        if opts.kind != "user"
            && self
                .breaker
                .lock()
                .map(|b| b.is_open(now_ms))
                .unwrap_or(false)
        {
            return Ok(AgentTurnOutcome {
                turn_id,
                end: TurnEndKind::CircuitOpen,
                spawned_session_ids: vec![],
                tool_calls: 0,
            });
        }

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

        let system_prompt = assemble_project_agent_context(&ProjectAgentContextInput {
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
        });

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

        // Build bounded model-facing message list from committed history + synthetic wake prompt.
        let mut live_messages: Vec<Value> = history_messages
            .iter()
            .filter(|m| {
                matches!(m["role"].as_str(), Some("user" | "assistant"))
                    && !m["content"].as_str().unwrap_or("").trim().is_empty()
            })
            .rev()
            .take(40)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .map(|m| {
                json!({
                    "role": m["role"],
                    "content": m["content"].as_str().unwrap_or(""),
                })
            })
            .collect();
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
        }

        let (admission, admission_task) =
            EffectAdmission::spawn_read_only_host(cancel.clone(), || true);
        let evidence_store = EvidenceIndexStore::new(&self.data_home);
        let mut live = LiveHistory::default();
        let mut total_tool_calls = 0usize;
        let mut final_end = TurnEndKind::Yielded;

        for _round in 0..MAX_BOT_ROUNDS {
            if cancel.is_cancelled() {
                final_end = TurnEndKind::UserStopped;
                break;
            }
            self.set_activity_phase("thinking", None, false);
            let mut model_turn = match model
                .turn_with_materialized_history(
                    &self.data_home,
                    opts.conversation_id,
                    &system_prompt,
                    &json!({"messages": live_messages}),
                    &tools_json,
                    &live,
                    cancel,
                )
                .await
            {
                Ok(t) => {
                    if let Ok(mut b) = self.breaker.lock() {
                        b.record_success();
                    }
                    t
                }
                Err(err) => {
                    final_end = self.record_turn_failure(
                        &conv_store,
                        opts.conversation_id,
                        &turn_id,
                        err.code,
                        now_ms,
                        cancel,
                    );
                    break;
                }
            };

            if model_turn.calls.is_empty() {
                // ADR 87: ordinary user turns without explicit post_reply do not forge verified claims,
                // but if the model produced plain text on a user turn with no tool calls, persist an anchored reply.
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
            let mut executed_ids = Vec::new();
            let mut stop_loop = false;

            let calls = std::mem::take(&mut model_turn.calls);
            for call in calls {
                if cancel.is_cancelled() {
                    final_end = TurnEndKind::UserStopped;
                    stop_loop = true;
                    break;
                }
                if total_tool_calls >= MAX_BOT_TOOL_CALLS {
                    final_end = TurnEndKind::Yielded;
                    stop_loop = true;
                    break;
                }
                total_tool_calls += 1;
                let call_id = format!("tc-{}", uuid::Uuid::new_v4());
                let started_at = now_iso();
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

            if !assistant_tool_calls.is_empty() {
                let sanitized =
                    peer_runtime::canonical_history::sanitize_assistant(&model_turn.content);
                let trimmed = peer_protocol::javascript_trim(&sanitized);
                if !trimmed.is_empty() {
                    live_messages.push(json!({
                        "role": "assistant",
                        "content": trimmed,
                    }));
                }
                live_messages.push(json!({
                    "role": "assistant",
                    "content": Value::Null,
                    "toolCalls": assistant_tool_calls,
                }));
                live_messages.extend(tool_results);
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
            match model
                .turn_with_materialized_history(
                    &self.data_home,
                    opts.conversation_id,
                    &system_prompt,
                    &json!({"messages": live_messages}),
                    &json!([]),
                    &live,
                    cancel,
                )
                .await
            {
                Ok(t) => {
                    if let Ok(mut b) = self.breaker.lock() {
                        b.record_success();
                    }
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
                    final_end = self.record_turn_failure(
                        &conv_store,
                        opts.conversation_id,
                        &turn_id,
                        err.code,
                        now_ms,
                        cancel,
                    );
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

        Ok(AgentTurnOutcome {
            turn_id,
            end: final_end,
            spawned_session_ids: snapshot.spawned_session_ids,
            tool_calls: total_tool_calls,
        })
    }
}
