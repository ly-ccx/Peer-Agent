//! Governed `project_agent` CapabilityProvider implementing `peer_runtime::providers::CapabilityProvider`.
//!
//! Every delegation, memory, and objective tool enters through the unified chain:
//! `CapabilityProvider -> Manifest -> RuntimeProjection(RuntimeMode::ProjectAgent) -> ToolCall -> PermissionGrant -> Evidence`.

use crate::{
    BotProfileStore, DigestQueue, MemoryFilter, MemoryStore, ObjectiveStore, ProjectError,
    SessionSupervisor, SpawnCriterion, SpawnSessionRequest, UpdateObjectiveRequest,
    UserAnchorCandidate, WriteMemoryRequest,
    acceptance::verdict_ref_for,
    memory_secret_reason,
    objectives::{CreateObjectiveRequest, ObjectiveBudget, ObjectiveMilestone},
    reply::{
        ComposeReplyInput, SessionStatusFact, StatusClaim, Surfacing, SurfacingEvent,
        compose_reply, decide_surfacing, resolve_user_anchors,
    },
};
use peer_protocol::ExecutionResourceScope;
use peer_runtime::{
    CancellationToken,
    capability::{CapabilityError as HostError, ProviderPermission},
    providers::{CapabilityProvider, EffectFuture, EffectOutcome, PreparedEffect, ProviderCall},
};
use peer_store::ConversationStore;
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

#[derive(Debug, Clone, Default)]
pub struct TurnExecutionState {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub conversation_id: String,
    pub turn_id: String,
    pub kind: String,
    pub current_input_anchors: Vec<String>,
    pub current_input_id: String,
    pub quote_session_ids: Vec<String>,
    pub valid_user_message_ids: HashSet<String>,
    pub user_anchor_candidates: Vec<UserAnchorCandidate>,
    pub unreported_anchor_sessions: Vec<(String, String)>,
    pub prior_report_fact_keys: HashSet<String>,
    pub worker_model_selection: Value,
    pub reply_committed_id: Option<String>,
    pub post_reply_rejected: bool,
    pub waiting_session_ids: Vec<String>,
    pub spawned_session_ids: Vec<String>,
    pub memory_learned: Vec<String>,
    pub memory_used: Vec<String>,
    pub holds_lease: bool,
}

struct CapFailure {
    err: ProjectError,
    extra: Option<Value>,
}

impl From<ProjectError> for CapFailure {
    fn from(err: ProjectError) -> Self {
        Self { err, extra: None }
    }
}

pub struct ProjectCapabilityProvider {
    data_home: PathBuf,
    supervisor: Arc<SessionSupervisor>,
    state: Arc<Mutex<TurnExecutionState>>,
}

impl ProjectCapabilityProvider {
    pub fn new(
        data_home: impl AsRef<Path>,
        supervisor: Arc<SessionSupervisor>,
        state: Arc<Mutex<TurnExecutionState>>,
    ) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
            supervisor,
            state,
        }
    }

    fn manifest(name: &str, cap_id: &str, description: &str, schema: Value) -> (String, Value) {
        (
            name.to_owned(),
            json!({
                "capabilityId": cap_id,
                "displayName": name,
                "description": description,
                "sideEffectLevel": "L1",
                "modeScopes": ["project_agent"],
                "inputSchema": schema,
            }),
        )
    }
}

impl CapabilityProvider for ProjectCapabilityProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        vec![
            Self::manifest(
                "spawn_session",
                "local.delegation.spawn_session",
                "Delegate a scoped work task to an isolated child session with structured success criteria.",
                json!({
                    "type": "object",
                    "required": ["anchorMessageIds", "title", "brief", "successCriteria", "kind", "readOnly", "requiredCapabilities"],
                    "properties": {
                        "anchorMessageIds": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                        "title": {"type": "string", "maxLength": 60},
                        "brief": {"type": "string", "maxLength": 4000},
                        "kind": {"type": "string", "enum": ["code", "research", "docs", "ui", "ops", "other"]},
                        "readOnly": {"type": "boolean"},
                        "requiredCapabilities": {"type": "array", "items": {"type": "string"}},
                        "priority": {"type": "string", "enum": ["high", "normal", "low"]},
                        "dependsOn": {"type": "array", "items": {"type": "string"}},
                        "supersedes": {"type": "string"},
                        "objectiveId": {"type": "string"},
                        "isolation": {"type": "string", "enum": ["auto", "none", "worktree"]},
                        "successCriteria": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 8,
                            "items": {
                                "type": "object",
                                "required": ["kind", "description"],
                                "properties": {
                                    "id": {"type": "string"},
                                    "kind": {"type": "string", "enum": ["command", "test", "file-contains", "file-exists", "model_review", "manual"]},
                                    "description": {"type": "string"},
                                    "command": {"type": "string"},
                                    "path": {"type": "string"},
                                    "expect": {"type": "string"}
                                },
                                "additionalProperties": false
                            }
                        }
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "list_sessions",
                "local.delegation.list_sessions",
                "List delegated work sessions for this project.",
                json!({
                    "type": "object",
                    "properties": {
                        "status": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "get_session",
                "local.delegation.get_session",
                "Inspect a delegated work session summary or verified report.",
                json!({
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "detail": {"type": "string", "enum": ["summary", "report"]}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "cancel_session",
                "local.delegation.cancel_session",
                "Cancel an active or queued delegated work session.",
                json!({
                    "type": "object",
                    "required": ["sessionId", "reason"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "reason": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "control_work",
                "local.delegation.control_work",
                "Pause, cancel, or resume a delegated work session anchored to a user message.",
                json!({
                    "type": "object",
                    "required": ["sessionId", "action", "anchorMessageId"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "action": {"type": "string", "enum": ["pause", "cancel", "resume"]},
                        "anchorMessageId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "reprioritize_session",
                "local.delegation.reprioritize_session",
                "Change scheduling priority of a queued delegated session.",
                json!({
                    "type": "object",
                    "required": ["sessionId", "priority"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "priority": {"type": "string", "enum": ["high", "normal", "low"]},
                        "anchorMessageId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "message_session",
                "local.delegation.message_session",
                "Send an answer or amendment to an open delegated work session.",
                json!({
                    "type": "object",
                    "required": ["sessionId", "text", "intent"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "text": {"type": "string"},
                        "intent": {"type": "string", "enum": ["answer", "amend"]}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "verify_session",
                "local.delegation.verify_session",
                "Evaluate host Evidence verification verdict and acceptance status for a completed session.",
                json!({
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "focus": {"type": "string", "maxLength": 500}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "wait_for_sessions",
                "local.delegation.wait_for_sessions",
                "Yield this main bot turn quietly while waiting for delegated child sessions to report.",
                json!({
                    "type": "object",
                    "required": ["sessionIds"],
                    "properties": {
                        "sessionIds": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "post_reply",
                "local.delegation.post_reply",
                "Deliver an anchored canonical reply to the user with host-verified session status claims.",
                json!({
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "replyTo": {"type": "array", "items": {"type": "string"}},
                        "text": {"type": "string", "maxLength": 2000},
                        "proactive": {"type": "boolean"},
                        "sources": {"type": "array", "items": {"type": "string"}},
                        "statusClaims": {
                            "type": "array",
                            "items": {
                                "type": "object",
                                "required": ["sessionId", "status"],
                                "properties": {
                                    "sessionId": {"type": "string"},
                                    "status": {"type": "string"}
                                },
                                "additionalProperties": false
                            }
                        },
                        "question": {
                            "type": "object",
                            "properties": {
                                "options": {"type": "array", "items": {"type": "string"}},
                                "expiresAt": {"type": "string"},
                                "prompt": {"type": "string"},
                                "agentRequestId": {"type": "string"},
                                "expectedRequestRevision": {"type": "integer"}
                            },
                            "additionalProperties": false
                        }
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "set_proactivity",
                "local.delegation.set_proactivity",
                "Update this bot's proactive notification level anchored to a user message.",
                json!({
                    "type": "object",
                    "required": ["level", "anchorMessageId"],
                    "properties": {
                        "level": {"type": "string", "enum": ["quiet", "low", "standard", "high", "muted"]},
                        "anchorMessageId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "memory_search",
                "local.memory.search",
                "Search project facts and user preferences via FTS5 index.",
                json!({
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "memory_write",
                "local.memory.write",
                "Record a sourced project fact/decision/procedure or user preference.",
                json!({
                    "type": "object",
                    "required": ["scope", "kind", "text", "sourceRefs"],
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "user"]},
                        "kind": {"type": "string", "enum": ["fact", "preference", "decision", "procedure", "responsibility"]},
                        "text": {"type": "string", "maxLength": 2000},
                        "sourceRefs": {"type": "array", "minItems": 1, "items": {"type": "string"}},
                        "pinned": {"type": "boolean"},
                        "anchorMessageId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "memory_forget",
                "local.memory.forget",
                "Mark a memory item as forgotten.",
                json!({
                    "type": "object",
                    "required": ["scope", "id"],
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "user"]},
                        "id": {"type": "string"},
                        "reason": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "memory_list",
                "local.memory.list",
                "List active project and user memories.",
                json!({
                    "type": "object",
                    "properties": {
                        "scope": {"type": "string", "enum": ["project", "user"]},
                        "kind": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "create_objective",
                "local.objective.create",
                "Create a tracked project objective with optional deterministic watches.",
                json!({
                    "type": "object",
                    "required": ["title", "outcome"],
                    "properties": {
                        "title": {"type": "string", "maxLength": 120},
                        "outcome": {"type": "string", "maxLength": 2000},
                        "autonomy": {"type": "string", "enum": ["report_only", "propose", "act"]},
                        "originMessageId": {"type": "string"},
                        "anchorMessageId": {"type": "string"},
                        "createdBy": {"type": "string", "enum": ["user_request", "agent_proposal"]},
                        "watches": {"type": "array"},
                        "milestones": {"type": "array"},
                        "successSignals": {"type": "array"},
                        "budget": {"type": "object"},
                        "deadline": {"type": "string"},
                        "requestId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "list_objectives",
                "local.objective.list",
                "List tracked objectives for this project.",
                json!({
                    "type": "object",
                    "properties": {},
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "get_objective",
                "local.objective.get",
                "Inspect a single tracked project objective by ID.",
                json!({
                    "type": "object",
                    "required": ["objectiveId"],
                    "properties": {
                        "objectiveId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "update_objective",
                "local.objective.update",
                "Update fields, watches, milestones, budget, or deadline of an existing objective.",
                json!({
                    "type": "object",
                    "required": ["objectiveId"],
                    "properties": {
                        "objectiveId": {"type": "string"},
                        "title": {"type": "string", "maxLength": 120},
                        "outcome": {"type": "string", "maxLength": 2000},
                        "autonomy": {"type": "string", "enum": ["report_only", "propose", "act"]},
                        "watches": {"type": "array"},
                        "milestones": {"type": "array"},
                        "successSignals": {"type": "array"},
                        "budget": {"type": "object"},
                        "deadline": {"type": ["string", "null"]},
                        "autoAccept": {"type": "boolean"},
                        "expectedVersion": {"type": "integer"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "pause_objective",
                "local.objective.pause",
                "Pause an active project objective.",
                json!({
                    "type": "object",
                    "required": ["objectiveId"],
                    "properties": {
                        "objectiveId": {"type": "string"},
                        "expectedVersion": {"type": "integer"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "resume_objective",
                "local.objective.resume",
                "Resume a paused project objective.",
                json!({
                    "type": "object",
                    "required": ["objectiveId"],
                    "properties": {
                        "objectiveId": {"type": "string"},
                        "expectedVersion": {"type": "integer"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "close_objective",
                "local.objective.close",
                "Close an objective as achieved or abandoned with optional evidence references.",
                json!({
                    "type": "object",
                    "required": ["objectiveId", "status"],
                    "properties": {
                        "objectiveId": {"type": "string"},
                        "status": {"type": "string", "enum": ["achieved", "abandoned"]},
                        "evidenceRefs": {"type": "array", "items": {"type": "string"}}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "resume_session",
                "local.delegation.resume_session",
                "Resume a paused or waiting delegated work session anchored to a user message.",
                json!({
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "anchorMessageId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "get_verification_detail",
                "local.delegation.get_verification_detail",
                "Read host verification verdict details, criterion results, evidence references, and changed files for a session.",
                json!({
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": {
                        "sessionId": {"type": "string"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "search_conversation",
                "local.delegation.search_history",
                "Search visible project conversation history by substring with automatic secret redaction.",
                json!({
                    "type": "object",
                    "required": ["query"],
                    "properties": {
                        "query": {"type": "string"},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50},
                        "kinds": {"type": "array", "items": {"type": "string"}}
                    },
                    "additionalProperties": false
                }),
            ),
        ]
    }

    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        _workspace: &Path,
        _home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if !capability.starts_with("local.delegation.")
            && !capability.starts_with("local.memory.")
            && !capability.starts_with("local.objective.")
        {
            return Err(HostError("tool_not_projected"));
        }
        Ok(Box::new(PreparedProjectEffect {
            capability: capability.to_owned(),
            args,
            data_home: self.data_home.clone(),
            supervisor: Arc::clone(&self.supervisor),
            state: Arc::clone(&self.state),
        }))
    }
}

struct PreparedProjectEffect {
    capability: String,
    args: Value,
    data_home: PathBuf,
    supervisor: Arc<SessionSupervisor>,
    state: Arc<Mutex<TurnExecutionState>>,
}

impl PreparedEffect for PreparedProjectEffect {
    fn args(&self) -> &Value {
        &self.args
    }

    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
    }

    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }

    fn start(
        self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        Ok(Box::pin(async move {
            if cancel.is_cancelled() {
                return EffectOutcome {
                    status: "cancelled",
                    output: json!({"ok": false, "error": "CANCELLED"}),
                    error: Some("CANCELLED"),
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: true,
                };
            }
            let res = execute_project_capability(
                &self.capability,
                &self.args,
                &self.data_home,
                &self.supervisor,
                &self.state,
                call.tool_call_id(),
            );
            match res {
                Ok(output) => EffectOutcome {
                    status: "success",
                    output,
                    error: None,
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                },
                Err(failure) => {
                    let mut out = json!({
                        "ok": false,
                        "error": failure.err.code,
                        "message": failure.err.detail,
                    });
                    if let (Some(dst), Some(Value::Object(src))) =
                        (out.as_object_mut(), failure.extra)
                    {
                        for (k, v) in src {
                            dst.insert(k, v);
                        }
                    }
                    EffectOutcome {
                        status: "failed",
                        output: out,
                        error: Some(failure.err.code),
                        artifacts: vec![],
                        ended: true,
                        materialization: None,
                        not_dispatched: false,
                    }
                }
            }
        }))
    }
}

fn check_quote_scope(state: &TurnExecutionState, target_session: &str) -> Result<(), ProjectError> {
    if !state.quote_session_ids.is_empty()
        && !state.quote_session_ids.iter().any(|s| s == target_session)
    {
        return Err(ProjectError::new(
            "out_of_scope",
            "Target session is outside quoted user message scope",
        ));
    }
    Ok(())
}

fn resolve_anchors_for_state(
    supplied: &[String],
    state: &TurnExecutionState,
) -> Result<Vec<String>, CapFailure> {
    if state.user_anchor_candidates.is_empty() {
        if supplied
            .iter()
            .any(|a| !state.valid_user_message_ids.contains(a.trim()))
        {
            return Err(ProjectError::code("invalid_anchor").into());
        }
        return Ok(supplied.iter().map(|s| s.trim().to_owned()).collect());
    }
    resolve_user_anchors(supplied, &state.user_anchor_candidates).map_err(|(err, diag)| {
        CapFailure {
            err,
            extra: Some(diag),
        }
    })
}

fn execute_post_reply(
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    state: &mut TurnExecutionState,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let text = args["text"]
        .as_str()
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let proactive = args["proactive"].as_bool().unwrap_or(false);
    let raw_reply_to: Vec<String> = args["replyTo"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let reply_to = if raw_reply_to.is_empty() {
        if !proactive && state.kind == "user" && !state.current_input_anchors.is_empty() {
            state.current_input_anchors.clone()
        } else {
            Vec::new()
        }
    } else {
        resolve_anchors_for_state(&raw_reply_to, state)?
    };
    let sources: Vec<String> = args["sources"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let status_claims: Vec<StatusClaim> = args["statusClaims"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|item| {
                    Some(StatusClaim {
                        session_id: item["sessionId"].as_str()?.to_owned(),
                        status: item["status"].as_str()?.to_owned(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let question = args.get("question").filter(|v| v.is_object()).cloned();

    let sessions = supervisor.list_sessions(&state.workspace_id);
    let project_session_ids: HashSet<String> =
        sessions.iter().map(|s| s.session_id.clone()).collect();
    let session_facts: Vec<SessionStatusFact> = sessions
        .iter()
        .map(|s| {
            let rep = supervisor
                .read_report(&state.workspace_id, &s.session_id)
                .ok();
            SessionStatusFact {
                session_id: s.session_id.clone(),
                status: s.status.clone(),
                source_revision: Some(s.updated_at.clone()),
                observation_revision: None,
                independent_verifier: rep.as_ref().map(|r| r.independent_verifier.clone()),
                verdict_outcome: rep.as_ref().map(|r| r.verdict_outcome.clone()),
                verdict_ref: rep
                    .as_ref()
                    .map(|r| verdict_ref_for(&s.session_id, &r.verdict_outcome)),
            }
        })
        .collect();

    let profiles = BotProfileStore::new(data_home);
    let proactivity = profiles
        .read(&state.workspace_id)
        .and_then(|p| p.proactivity)
        .unwrap_or_else(|| "standard".into());
    let surfacing = if state.kind == "user" {
        Surfacing::Message
    } else {
        let is_agent_proactive = proactive && reply_to.is_empty() && question.is_none();
        decide_surfacing(
            &SurfacingEvent {
                origin: if is_agent_proactive {
                    "objective_signal"
                } else {
                    "user_request"
                }
                .into(),
                kind: if question.is_some() {
                    "needs_user"
                } else if is_agent_proactive && sources.is_empty() {
                    "idea"
                } else {
                    "result"
                }
                .into(),
                novelty: true,
                severity: if is_agent_proactive && sources.is_empty() {
                    "info"
                } else {
                    "notable"
                }
                .into(),
                deadline_imminent: false,
            },
            &proactivity,
            false,
            question.is_some(),
        )
        .decision
    };

    let mut ev_refs = Vec::new();
    for sid in &sources {
        if let Ok(rep) = supervisor.read_report(&state.workspace_id, sid) {
            ev_refs.extend(rep.evidence_refs);
        }
    }

    let reply_id = format!("reply-{tool_call_id}");
    let composed = compose_reply(ComposeReplyInput {
        message_id: reply_id.clone(),
        turn_id: Some(state.turn_id.clone()),
        kind: state.kind.clone(),
        text: text.to_owned(),
        reply_to,
        sources: sources.clone(),
        status_claims,
        proactive,
        question,
        valid_user_message_ids: state.valid_user_message_ids.clone(),
        project_session_ids,
        session_facts,
        memory_used: state.memory_used.clone(),
        memory_learned: state.memory_learned.clone(),
        evidence_refs: ev_refs,
        surfacing,
        prior_report_fact_keys: state.prior_report_fact_keys.clone(),
        unreported_anchor_sessions: state.unreported_anchor_sessions.clone(),
    })?;

    if composed.suppressed_duplicate {
        state.reply_committed_id = Some("suppressed".into());
        state.post_reply_rejected = false;
        return Ok(json!({
            "ok": true,
            "suppressed": true,
            "control": { "terminal": true, "reason": "project_agent_reply" }
        }));
    }

    if surfacing == Surfacing::Silent {
        state.reply_committed_id = Some("silent".into());
        state.post_reply_rejected = false;
        return Ok(json!({
            "ok": true,
            "suppressed": true,
            "surfacing": "silent",
            "control": { "terminal": true, "reason": "project_agent_reply" }
        }));
    }

    let at = crate::now_iso();
    let mut msg = composed.message;
    msg["createdAt"] = json!(at);

    if surfacing == Surfacing::Digest {
        DigestQueue::new(data_home).hold(
            &state.workspace_id,
            Some(&reply_id),
            text,
            Some(msg),
            Some(&at),
        )?;
        for k in composed.report_fact_keys {
            state.prior_report_fact_keys.insert(k);
        }
        state.reply_committed_id = Some(format!("digest:{reply_id}"));
        state.post_reply_rejected = false;
        return Ok(json!({
            "ok": true,
            "queuedForDigest": true,
            "messageId": reply_id,
            "surfacing": "digest",
            "control": { "terminal": true, "reason": "project_agent_reply" }
        }));
    }

    ConversationStore::new(data_home)
        .append_message_idempotent(&state.conversation_id, &msg, &at, None)
        .map_err(ProjectError::from)?;

    // Policy auto-acceptance for any cited `result_ready` sessions after reply is durably posted.
    for sid in &sources {
        let _ = supervisor.settle_session(
            &state.workspace_id,
            sid,
            true,
            false,
            None,
            state.holds_lease,
        );
    }
    for k in composed.report_fact_keys {
        state.prior_report_fact_keys.insert(k);
    }
    state.reply_committed_id = Some(reply_id.clone());
    state.post_reply_rejected = false;
    Ok(json!({
        "ok": true,
        "messageId": reply_id,
        "surfacing": surfacing.as_str(),
        "control": { "terminal": true, "reason": "project_agent_reply" }
    }))
}

fn execute_search_conversation(
    args: &Value,
    data_home: &Path,
    state: &TurnExecutionState,
) -> Result<Value, CapFailure> {
    let query = args["query"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let needle = query.to_lowercase();
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
    let kinds_filter: Option<HashSet<String>> = args["kinds"].as_array().map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let snap = ConversationStore::new(data_home)
        .read_committed(&state.conversation_id, None, 4 * 1024 * 1024)
        .map_err(ProjectError::from)?;
    let mut matches = Vec::new();
    for m in snap.history.messages.iter().rev() {
        if m["meta"]["compaction"].is_object()
            || matches!(m["kind"].as_str(), Some("compaction" | "agent_turn"))
        {
            continue;
        }
        let kind = m["kind"].as_str().unwrap_or("");
        let eff_kind = if kind.is_empty() && m["role"] == "user" {
            "user_input"
        } else {
            kind
        };
        if let Some(ref allowed) = kinds_filter {
            if !allowed.contains(eff_kind) {
                continue;
            }
        } else if !matches!(eff_kind, "user_input" | "agent_reply" | "system_card") {
            continue;
        }
        let content = m["content"].as_str().unwrap_or("");
        if content.is_empty() || !content.to_lowercase().contains(&needle) {
            continue;
        }
        let redacted = memory_secret_reason(content).is_some();
        let snippet: String = if redacted {
            "[REDACTED]".to_owned()
        } else {
            content.chars().take(300).collect()
        };
        matches.push(json!({
            "id": m["id"],
            "kind": eff_kind,
            "role": m["role"],
            "createdAt": m["createdAt"],
            "snippet": snippet,
            "redacted": redacted,
        }));
        if matches.len() >= limit {
            break;
        }
    }
    Ok(json!({ "ok": true, "matches": matches }))
}

fn execute_objective_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    state: &TurnExecutionState,
) -> Result<Value, CapFailure> {
    let store = ObjectiveStore::new(data_home);
    match capability {
        "local.objective.create" => {
            let supplied_anchor = args["anchorMessageId"]
                .as_str()
                .or_else(|| args["originMessageId"].as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let origin_message_id = if let Some(raw) = supplied_anchor {
                resolve_anchors_for_state(&[raw.to_owned()], state)?
                    .into_iter()
                    .next()
                    .ok_or_else(|| ProjectError::code("invalid_anchor"))?
            } else {
                state
                    .current_input_anchors
                    .first()
                    .cloned()
                    .or_else(|| {
                        state
                            .user_anchor_candidates
                            .last()
                            .map(|c| c.message_id.clone())
                    })
                    .ok_or_else(|| ProjectError::code("invalid_anchor"))?
            };
            let default_created_by = if state.current_input_anchors.is_empty() {
                "agent_proposal"
            } else {
                "user_request"
            };
            let created_by = args["createdBy"].as_str().unwrap_or(default_created_by);
            let milestones: Vec<ObjectiveMilestone> =
                if args.get("milestones").is_some_and(|v| !v.is_null()) {
                    serde_json::from_value(args["milestones"].clone())
                        .map_err(|_| ProjectError::code("invalid_input"))?
                } else {
                    vec![]
                };
            let budget: Option<ObjectiveBudget> =
                if args.get("budget").is_some_and(|v| !v.is_null()) {
                    Some(
                        serde_json::from_value(args["budget"].clone())
                            .map_err(|_| ProjectError::code("invalid_input"))?,
                    )
                } else {
                    None
                };
            let (item, replayed) = store.create(&CreateObjectiveRequest {
                workspace_id: &state.workspace_id,
                project_agent_conversation_id: &state.conversation_id,
                origin_message_id: &origin_message_id,
                title: args["title"].as_str().unwrap_or(""),
                outcome: args["outcome"].as_str().unwrap_or(""),
                autonomy: args["autonomy"].as_str().unwrap_or("propose"),
                created_by,
                watches: args["watches"].as_array().cloned().unwrap_or_default(),
                milestones,
                success_signals: args["successSignals"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default(),
                budget,
                deadline: args["deadline"].as_str(),
                request_id: args["requestId"].as_str(),
            })?;
            Ok(json!({ "ok": true, "objective": item, "replayed": replayed }))
        }
        "local.objective.list" => {
            let items = store.list(&state.workspace_id)?;
            Ok(json!({ "ok": true, "items": items }))
        }
        "local.objective.get" => {
            let oid = args["objectiveId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let item = store
                .get(&state.workspace_id, oid)?
                .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
            Ok(json!({ "ok": true, "objective": item }))
        }
        "local.objective.update" => {
            let oid = args["objectiveId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let watches = args
                .get("watches")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_array()
                        .cloned()
                        .ok_or_else(|| ProjectError::code("invalid_input"))
                })
                .transpose()?;
            let milestones = args
                .get("milestones")
                .filter(|v| !v.is_null())
                .map(|v| {
                    serde_json::from_value::<Vec<ObjectiveMilestone>>(v.clone())
                        .map_err(|_| ProjectError::code("invalid_input"))
                })
                .transpose()?;
            let success_signals = args
                .get("successSignals")
                .filter(|v| !v.is_null())
                .map(|v| {
                    v.as_array()
                        .cloned()
                        .ok_or_else(|| ProjectError::code("invalid_input"))
                })
                .transpose()?;
            let budget = args
                .get("budget")
                .filter(|v| !v.is_null())
                .map(|v| {
                    serde_json::from_value::<ObjectiveBudget>(v.clone())
                        .map_err(|_| ProjectError::code("invalid_input"))
                })
                .transpose()?;
            let deadline = args
                .as_object()
                .and_then(|m| m.get("deadline"))
                .map(|v| {
                    if v.is_null() {
                        Ok(None)
                    } else {
                        v.as_str()
                            .map(Some)
                            .ok_or_else(|| ProjectError::code("invalid_input"))
                    }
                })
                .transpose()?;
            let item = store.update(
                &state.workspace_id,
                oid,
                &UpdateObjectiveRequest {
                    title: args["title"].as_str(),
                    outcome: args["outcome"].as_str(),
                    autonomy: args["autonomy"].as_str(),
                    watches,
                    milestones,
                    success_signals,
                    budget,
                    deadline,
                    auto_accept: args["autoAccept"].as_bool(),
                    expected_version: args["expectedVersion"].as_u64(),
                },
            )?;
            Ok(json!({ "ok": true, "objective": item }))
        }
        "local.objective.pause" | "local.objective.resume" => {
            let oid = args["objectiveId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let status = if capability == "local.objective.pause" {
                "paused"
            } else {
                "active"
            };
            let item = store.update_status(
                &state.workspace_id,
                oid,
                status,
                args["expectedVersion"].as_u64(),
            )?;
            Ok(json!({ "ok": true, "objective": item }))
        }
        "local.objective.close" => {
            let oid = args["objectiveId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let status = args["status"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let evidence_refs: Vec<String> = args["evidenceRefs"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let item = store.close(&state.workspace_id, oid, status, evidence_refs)?;
            Ok(json!({ "ok": true, "objective": item }))
        }
        _ => Err(ProjectError::code("tool_not_projected").into()),
    }
}

fn execute_project_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    state_lock: &Mutex<TurnExecutionState>,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let mut state = state_lock
        .lock()
        .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
    if !state.holds_lease {
        return Err(ProjectError::code("LEASE_REQUIRED").into());
    }
    match capability {
        "local.delegation.spawn_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::new(
                    "current_user_required",
                    "Historical user messages cannot authorize new tasks during an ordinary wake.",
                )
                .into());
            }
            let raw_anchors: Vec<String> = args["anchorMessageIds"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if raw_anchors.is_empty() {
                return Err(ProjectError::code("invalid_anchor").into());
            }
            let anchors = resolve_anchors_for_state(&raw_anchors, &state)?;
            if let Some(sup) = args["supersedes"].as_str() {
                check_quote_scope(&state, sup)?;
            }
            let criteria: Vec<SpawnCriterion> =
                serde_json::from_value(args["successCriteria"].clone())
                    .map_err(|_| ProjectError::code("invalid_input"))?;
            let required_caps: Vec<String> = args["requiredCapabilities"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let depends_on: Vec<String> = args["dependsOn"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let spawned = supervisor.spawn_session(
                SpawnSessionRequest {
                    workspace_id: state.workspace_id.clone(),
                    workspace_path: state.workspace_path.clone(),
                    parent_conversation_id: state.conversation_id.clone(),
                    anchor_message_ids: anchors,
                    input_id: state.current_input_id.clone(),
                    surface: "tui".into(),
                    title: args["title"].as_str().unwrap_or("").to_owned(),
                    brief: args["brief"].as_str().unwrap_or("").to_owned(),
                    kind: args["kind"].as_str().unwrap_or("other").to_owned(),
                    read_only: args["readOnly"].as_bool().unwrap_or(true),
                    required_capabilities: required_caps,
                    success_criteria: criteria,
                    priority: args["priority"].as_str().unwrap_or("normal").to_owned(),
                    depends_on,
                    supersedes: args["supersedes"].as_str().map(str::to_owned),
                    objective_id: args["objectiveId"].as_str().map(str::to_owned),
                    isolation: args["isolation"].as_str().unwrap_or("auto").to_owned(),
                    worker_model_selection: state.worker_model_selection.clone(),
                },
                state.holds_lease,
            )?;
            state.spawned_session_ids.push(spawned.session_id.clone());
            Ok(json!({
                "ok": true,
                "sessionId": spawned.session_id,
                "planId": spawned.plan_id,
                "status": spawned.status,
                "phase": spawned.phase,
                "queued": spawned.phase == "queued",
                "approvalId": spawned.approval_id,
            }))
        }
        "local.delegation.list_sessions" => {
            let status_filter = args["status"].as_str();
            let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
            let items: Vec<_> = supervisor
                .list_sessions(&state.workspace_id)
                .into_iter()
                .filter(|s| status_filter.is_none_or(|f| s.status == f))
                .take(limit)
                .collect();
            Ok(json!({ "ok": true, "sessions": items }))
        }
        "local.delegation.get_session" => {
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let report = supervisor.read_report(&state.workspace_id, sid)?;
            if args["detail"].as_str() == Some("summary") {
                Ok(json!({ "ok": true, "session": report.summary }))
            } else {
                Ok(json!({ "ok": true, "session": report.summary, "report": report }))
            }
        }
        "local.delegation.cancel_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            check_quote_scope(&state, sid)?;
            let reason = args["reason"].as_str().unwrap_or("cancelled");
            let updated =
                supervisor.control_session(&state.workspace_id, sid, "cancel", reason, true)?;
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "status": updated.status }))
        }
        "local.delegation.control_work" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let action = args["action"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            check_quote_scope(&state, sid)?;
            let updated = supervisor.control_session(
                &state.workspace_id,
                sid,
                action,
                "user_control",
                true,
            )?;
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "status": updated.status }))
        }
        "local.delegation.reprioritize_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let priority = args["priority"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            check_quote_scope(&state, sid)?;
            let updated =
                supervisor.reprioritize_session(&state.workspace_id, sid, priority, true)?;
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "priority": updated.priority }))
        }
        "local.delegation.message_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let text = args["text"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let intent = args["intent"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            check_quote_scope(&state, sid)?;
            let updated =
                supervisor.message_session(&state.workspace_id, sid, text, intent, true)?;
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "status": updated.status }))
        }
        "local.delegation.resume_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            if let Some(raw_anchor) = args["anchorMessageId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                let _ = resolve_anchors_for_state(&[raw_anchor.to_owned()], &state)?;
            }
            check_quote_scope(&state, sid)?;
            let updated = supervisor.resume_session(&state.workspace_id, sid, true)?;
            Ok(json!({
                "ok": true,
                "sessionId": updated.session_id,
                "status": updated.status,
                "phase": updated.phase,
            }))
        }
        "local.delegation.get_verification_detail" => {
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let detail = supervisor.read_verification_detail(&state.workspace_id, sid)?;
            Ok(json!({ "ok": true, "detail": detail }))
        }
        "local.delegation.search_history" => execute_search_conversation(args, data_home, &state),
        "local.delegation.verify_session" => {
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let decision =
                supervisor.settle_session(&state.workspace_id, sid, false, false, None, true)?;
            Ok(json!({ "ok": true, "sessionId": sid, "decision": decision }))
        }
        "local.delegation.wait_for_sessions" => {
            let sids: Vec<String> = args["sessionIds"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if sids.is_empty() {
                return Err(ProjectError::code("invalid_input").into());
            }
            let all = supervisor.list_sessions(&state.workspace_id);
            for sid in &sids {
                let Some(s) = all.iter().find(|row| &row.session_id == sid) else {
                    return Err(ProjectError::code("NOT_FOUND").into());
                };
                if !matches!(
                    s.status.as_str(),
                    "queued" | "starting" | "running" | "verifying" | "waiting_user"
                ) {
                    return Err(ProjectError::code("session_not_active").into());
                }
            }
            state.waiting_session_ids = sids.clone();
            Ok(
                json!({ "ok": true, "waiting": sids, "control": { "terminal": true, "reason": "project_agent_wait" } }),
            )
        }
        "local.delegation.post_reply" => {
            let res = execute_post_reply(args, data_home, supervisor, &mut state, tool_call_id);
            if res.is_err() {
                state.post_reply_rejected = true;
            }
            res
        }
        "local.delegation.set_proactivity" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            let level = args["level"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let updated =
                BotProfileStore::new(data_home).set_proactivity(&state.workspace_id, level)?;
            Ok(json!({ "ok": true, "proactivity": updated.proactivity }))
        }
        "local.memory.search" => {
            let query = args["query"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
            let hits =
                MemoryStore::new(data_home).search(Some(&state.workspace_id), query, limit)?;
            for h in &hits {
                if !state.memory_used.contains(&h.id) {
                    state.memory_used.push(h.id.clone());
                }
            }
            Ok(json!({ "ok": true, "items": hits }))
        }
        "local.memory.write" => {
            let scope = args["scope"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let kind = args["kind"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let text = args["text"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let source_refs: Vec<String> = args["sourceRefs"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            let item = MemoryStore::new(data_home).write(&WriteMemoryRequest {
                scope,
                workspace_id: (scope == "project").then_some(state.workspace_id.as_str()),
                kind,
                text,
                trust: "stated",
                source_refs,
                pinned: args["pinned"].as_bool().unwrap_or(false),
                anchor_message_id: args["anchorMessageId"].as_str(),
                expires_at: None,
                topic_key: None,
                topic_value: None,
                file_anchors: None,
            })?;
            state.memory_learned.push(item.id.clone());
            Ok(json!({ "ok": true, "item": item }))
        }
        "local.memory.forget" => {
            let scope = args["scope"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let id = args["id"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let reason = args["reason"].as_str();
            let item = MemoryStore::new(data_home).forget(
                scope,
                (scope == "project").then_some(state.workspace_id.as_str()),
                id,
                reason,
            )?;
            Ok(json!({ "ok": true, "item": item }))
        }
        "local.memory.list" => {
            let items = MemoryStore::new(data_home).list(&MemoryFilter {
                scope: args["scope"].as_str(),
                workspace_id: Some(&state.workspace_id),
                kind: args["kind"].as_str(),
                status: Some("active"),
            });
            Ok(json!({ "ok": true, "items": items }))
        }
        cap if cap.starts_with("local.objective.") => {
            execute_objective_capability(cap, args, data_home, &state)
        }
        _ => Err(ProjectError::code("tool_not_projected").into()),
    }
}
