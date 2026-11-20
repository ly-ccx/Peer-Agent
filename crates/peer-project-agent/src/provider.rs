//! Governed `project_agent` CapabilityProvider implementing `peer_runtime::providers::CapabilityProvider`.
//!
//! Every delegation, memory, and objective tool enters through the unified chain:
//! `CapabilityProvider -> Manifest -> RuntimeProjection(RuntimeMode::ProjectAgent) -> ToolCall -> PermissionGrant -> Evidence`.

use crate::{
    BotProfileStore, MemoryFilter, MemoryStore, ObjectiveStore, ProjectError, SessionSupervisor,
    SpawnCriterion, SpawnSessionRequest, WriteMemoryRequest,
    objectives::CreateObjectiveRequest,
    reply::{
        ComposeReplyInput, SessionStatusFact, StatusClaim, Surfacing, SurfacingEvent,
        compose_reply, decide_surfacing,
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
    pub prior_report_fact_keys: HashSet<String>,
    pub worker_model_selection: Value,
    pub reply_committed_id: Option<String>,
    pub waiting_session_ids: Vec<String>,
    pub spawned_session_ids: Vec<String>,
    pub memory_learned: Vec<String>,
    pub memory_used: Vec<String>,
    pub holds_lease: bool,
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
                                "prompt": {"type": "string"}
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
                    "required": ["title", "outcome", "autonomy", "originMessageId"],
                    "properties": {
                        "title": {"type": "string", "maxLength": 120},
                        "outcome": {"type": "string", "maxLength": 2000},
                        "autonomy": {"type": "string", "enum": ["report_only", "propose", "act"]},
                        "originMessageId": {"type": "string"},
                        "watches": {"type": "array"},
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
                Err(err) => EffectOutcome {
                    status: "failed",
                    output: json!({"ok": false, "error": err.code, "message": err.detail}),
                    error: Some(err.code),
                    artifacts: vec![],
                    ended: true,
                    materialization: None,
                    not_dispatched: false,
                },
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

fn execute_project_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    state_lock: &Mutex<TurnExecutionState>,
    tool_call_id: &str,
) -> Result<Value, ProjectError> {
    let mut state = state_lock
        .lock()
        .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
    if !state.holds_lease {
        return Err(ProjectError::code("LEASE_REQUIRED"));
    }
    match capability {
        "local.delegation.spawn_session" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::new(
                    "current_user_required",
                    "Historical user messages cannot authorize new tasks during an ordinary wake.",
                ));
            }
            let anchors: Vec<String> = args["anchorMessageIds"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            if anchors.is_empty()
                || anchors
                    .iter()
                    .any(|a| !state.valid_user_message_ids.contains(a))
            {
                return Err(ProjectError::code("invalid_anchor"));
            }
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
                return Err(ProjectError::code("current_user_required"));
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
                return Err(ProjectError::code("current_user_required"));
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
                return Err(ProjectError::code("current_user_required"));
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
                return Err(ProjectError::code("current_user_required"));
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
                return Err(ProjectError::code("invalid_input"));
            }
            let all = supervisor.list_sessions(&state.workspace_id);
            for sid in &sids {
                let Some(s) = all.iter().find(|row| &row.session_id == sid) else {
                    return Err(ProjectError::code("NOT_FOUND"));
                };
                if !matches!(
                    s.status.as_str(),
                    "queued" | "starting" | "running" | "verifying" | "waiting_user"
                ) {
                    return Err(ProjectError::code("session_not_active"));
                }
            }
            state.waiting_session_ids = sids.clone();
            Ok(
                json!({ "ok": true, "waiting": sids, "control": { "terminal": true, "reason": "project_agent_wait" } }),
            )
        }
        "local.delegation.post_reply" => {
            let text = args["text"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let proactive = args["proactive"].as_bool().unwrap_or(false);
            let mut reply_to: Vec<String> = args["replyTo"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_else(|| state.current_input_anchors.clone());
            if reply_to.is_empty()
                && !proactive
                && state.kind == "user"
                && !state.current_input_anchors.is_empty()
            {
                reply_to = state.current_input_anchors.clone();
            }
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
                decide_surfacing(
                    &SurfacingEvent {
                        origin: "user_request".into(),
                        kind: if question.is_some() {
                            "needs_user".into()
                        } else {
                            "result".into()
                        },
                        novelty: true,
                        severity: "notable".into(),
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
            })?;

            if composed.suppressed_duplicate {
                state.reply_committed_id = Some("suppressed".into());
                return Ok(json!({
                    "ok": true,
                    "suppressed": true,
                    "control": { "terminal": true, "reason": "project_agent_reply" }
                }));
            }

            let at = crate::now_iso();
            let mut msg = composed.message;
            msg["createdAt"] = json!(at);
            ConversationStore::new(data_home).append_message_idempotent(
                &state.conversation_id,
                &msg,
                &at,
                None,
            )?;

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
            Ok(json!({
                "ok": true,
                "messageId": reply_id,
                "surfacing": surfacing.as_str(),
                "control": { "terminal": true, "reason": "project_agent_reply" }
            }))
        }
        "local.delegation.set_proactivity" => {
            if state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required"));
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
        "local.objective.create" => {
            let (item, replayed) =
                ObjectiveStore::new(data_home).create(&CreateObjectiveRequest {
                    workspace_id: &state.workspace_id,
                    project_agent_conversation_id: &state.conversation_id,
                    origin_message_id: args["originMessageId"].as_str().unwrap_or_else(|| {
                        state
                            .current_input_anchors
                            .first()
                            .map(String::as_str)
                            .unwrap_or("")
                    }),
                    title: args["title"].as_str().unwrap_or(""),
                    outcome: args["outcome"].as_str().unwrap_or(""),
                    autonomy: args["autonomy"].as_str().unwrap_or("propose"),
                    created_by: if state.current_input_anchors.is_empty() {
                        "agent_proposal"
                    } else {
                        "user_request"
                    },
                    watches: args["watches"].as_array().cloned().unwrap_or_default(),
                    milestones: vec![],
                    success_signals: vec![],
                    budget: None,
                    deadline: args["deadline"].as_str(),
                    request_id: args["requestId"].as_str(),
                })?;
            Ok(json!({ "ok": true, "objective": item, "replayed": replayed }))
        }
        "local.objective.list" => {
            let items = ObjectiveStore::new(data_home).list(&state.workspace_id)?;
            Ok(json!({ "ok": true, "items": items }))
        }
        _ => Err(ProjectError::code("tool_not_projected")),
    }
}
