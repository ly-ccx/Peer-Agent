//! Governed `project_agent` CapabilityProvider implementing `peer_runtime::providers::CapabilityProvider`.
//!
//! Every delegation, memory, and objective tool enters through the unified chain:
//! `CapabilityProvider -> Manifest -> RuntimeProjection(RuntimeMode::ProjectAgent) -> ToolCall -> PermissionGrant -> Evidence`.

use crate::{
    BotProfileStore, CommitAgentMessageRequest, ConversationSearchDocument,
    ConversationSearchIndex, CoordinationHub, DigestQueue, ExecutionObligationService,
    INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL, InteractiveResultStore, MemoryFilter,
    MemoryStore, ObjectiveActions, ObjectiveStore, ProjectError, SessionSupervisor, SpawnCriterion,
    SpawnSessionRequest, UpdateObjectiveRequest, UserAnchorCandidate, WriteMemoryRequest,
    acceptance::verdict_ref_for,
    memory_secret_reason, objective_action_card_id,
    objectives::{CreateObjectiveRequest, ObjectiveBudget, ObjectiveMilestone},
    reply::{
        ComposeReplyInput, SessionStatusFact, StatusClaim, Surfacing, SurfacingEvent,
        compose_reply, decide_surfacing, resolve_user_anchors,
    },
    skill_packs::{
        ACTIVATE_SKILL_PACK_CAPABILITY, ACTIVATE_SKILL_PACK_TOOL, all_skill_pack_ids,
        find_skill_pack,
    },
};
use peer_protocol::{ExecutionResourceScope, interactive_result::InteractiveOwner};
use peer_runtime::{
    CancellationToken,
    capability::{CapabilityError as HostError, ProviderPermission},
    model::NativeModel,
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
    pub answered_user_message_ids: HashSet<String>,
    pub user_anchor_candidates: Vec<UserAnchorCandidate>,
    pub unreported_anchor_sessions: Vec<(String, String)>,
    pub prior_report_fact_keys: HashSet<String>,
    pub worker_model_selection: Value,
    pub reply_committed_id: Option<String>,
    pub post_reply_rejected: bool,
    pub work_id: String,
    pub waiting_session_ids: Vec<String>,
    pub spawned_session_ids: Vec<String>,
    pub activated_packs: Vec<String>,
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
    coordination: Arc<CoordinationHub>,
    verifier_model: Option<NativeModel>,
    state: Arc<Mutex<TurnExecutionState>>,
}

impl ProjectCapabilityProvider {
    pub fn new(
        data_home: impl AsRef<Path>,
        supervisor: Arc<SessionSupervisor>,
        state: Arc<Mutex<TurnExecutionState>>,
    ) -> Self {
        Self::with_coordination(
            data_home,
            supervisor,
            Arc::new(CoordinationHub::new()),
            state,
        )
    }

    pub fn with_coordination(
        data_home: impl AsRef<Path>,
        supervisor: Arc<SessionSupervisor>,
        coordination: Arc<CoordinationHub>,
        state: Arc<Mutex<TurnExecutionState>>,
    ) -> Self {
        Self {
            data_home: data_home.as_ref().to_path_buf(),
            supervisor,
            coordination,
            verifier_model: None,
            state,
        }
    }

    pub(crate) fn with_verifier_model(mut self, model: NativeModel) -> Self {
        self.verifier_model = Some(model);
        self
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
                "Delegate a new task from a current user input with title, brief, kind, readOnly and successCriteria. On wake, supply only supersedes to retry an eligible failed task with its original specification.",
                json!({
                    "type": "object",
                    "anyOf": [{"required": ["title", "brief", "successCriteria", "kind", "readOnly"]}, {"required": ["supersedes"]}],
                    "properties": {
                        "anchorMessageIds": {
                            "type": "array",
                            "minItems": 1,
                            "items": {"type": "string"},
                            "description": "Optional on normal user turns (host auto-anchors to current user input when omitted)."
                        },
                        "title": {"type": "string", "maxLength": 60},
                        "brief": {"type": "string", "maxLength": 4000},
                        "kind": {"type": "string", "enum": ["code", "research", "docs", "ui", "ops", "other"]},
                        "readOnly": {"type": "boolean"},
                        "capabilityPreset": {
                            "type": "string",
                            "enum": ["read_only", "code_edit", "code_edit_and_shell", "web_research"],
                            "description": "High-level capability intent preset (preferred over raw requiredCapabilities). Ignored for write/shell when readOnly=true."
                        },
                        "requiredCapabilities": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Optional explicit worker capability IDs (host derives safe capabilities automatically from readOnly, capabilityPreset, and successCriteria when omitted)."
                        },
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
                                    "kind": {
                                        "type": "string",
                                        "enum": ["command", "test", "file-contains", "file-exists", "model_review"],
                                        "description": "Use command/test/file-exists/file-contains for mechanical checks, and model_review for report completeness, audit, or quality checks (verified automatically by the independent verifier without requiring manual user sign-off)."
                                    },
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
                "Cancel or dismiss an active, queued, failed, verification-failed, unaccepted result_ready, or stale cancelled delegated work session so it leaves the active follow-up list. Dead/failed/verification-failed sessions may be cancelled autonomously without waiting for a user turn.",
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
                "Send a user-authorized answer or amendment. On wake, answer only a pending technical question directed to this parent Bot.",
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
                "Inspect acceptance or run bounded independent read-only verification for a completed session. A missing or failed verdict, force, or focus requests a new check.",
                json!({
                    "type": "object",
                    "required": ["sessionId"],
                    "properties": {
                        "sessionId": {"type": "string"},
                        "focus": {"type": "string", "maxLength": 500},
                        "force": {"type": "boolean"}
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
                "Speak to the user in natural, human-friendly language as their project partner. Keep structured provenance in `sources`/`statusClaims`, never as raw protocol jargon inside `text`.",
                json!({
                    "type": "object",
                    "required": ["text"],
                    "properties": {
                        "replyTo": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "User message IDs from Current input anchors being answered. May be omitted on normal user turns to auto-anchor to the current user message; on wake turns when anchors are empty, pass proactive: true."
                        },
                        "text": {
                            "type": "string",
                            "maxLength": 8000,
                            "description": "Your direct message spoken to the user. Write naturally like a human teammate: lead with clear conclusions in the user's language, and never expose internal tool names, JSON fields (like workerOutput), raw session UUIDs, or protocol status enums (like result_ready / verification_failed / supersedes)."
                        },
                        "proactive": {"type": "boolean"},
                        "sources": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Raw delegated work session UUIDs belonging to this project (NEVER file paths or directory names). Omit or pass [] when not citing delegated sessions."
                        },
                        "statusClaims": {
                            "type": "array",
                            "description": "Optional explicit status claims for cited sessions (host fills omitted claims from persisted host facts, while still rejecting any explicit claim that disagrees with host state).",
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
                "Resume a delegated work session. On wake, only host-confirmed recoverable technical interruptions with settled effects can resume.",
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
            Self::manifest(
                "send_agent_message",
                "local.delegation.send_agent_message",
                "Send a durable parent-to-child update, question, or answer via the coordination mailbox.",
                json!({
                    "type": "object",
                    "required": ["text", "purpose"],
                    "properties": {
                        "sessionId": {"type": "string", "maxLength": 200},
                        "text": {"type": "string", "maxLength": 4000},
                        "purpose": {"type": "string", "enum": ["update", "question", "answer"]},
                        "delivery": {"type": "string", "enum": ["mailbox_only", "ensure_turn"]},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "expectedExecutionEpoch": {"type": "string", "maxLength": 200},
                        "replyTo": {"type": "string", "maxLength": 200},
                        "decisionRequest": {"type": "object"},
                        "decisionAnswer": {"type": "object"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "coordinate_work",
                "local.delegation.coordinate_work",
                "Query coordination v2 mandate revisions or issue revision-guarded work control actions.",
                json!({
                    "type": "object",
                    "required": ["action", "reason"],
                    "properties": {
                        "action": {"type": "string", "enum": ["parallel", "augment", "revise", "query", "answer", "cancel", "replace", "handoff", "resume", "assess"]},
                        "assessment": {"type": "object"},
                        "afterSessionId": {"type": "string", "maxLength": 200},
                        "eventId": {"type": "string", "maxLength": 200},
                        "payloadOffset": {"type": "integer", "minimum": 0},
                        "inputId": {"type": "string", "maxLength": 200},
                        "afterInputId": {"type": "string", "maxLength": 200},
                        "expectedWorkRevision": {"type": "integer", "minimum": 0},
                        "workId": {"type": "string", "maxLength": 200},
                        "sessionId": {"type": "string", "maxLength": 200},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "reason": {"type": "string", "maxLength": 500},
                        "text": {"type": "string", "maxLength": 4000},
                        "replyTo": {"type": "string", "maxLength": 200},
                        "task": {"type": "object"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "memory_remember",
                "local.memory.remember",
                "Record a typed durable fact or user preference without overriding runtime-owned metadata.",
                json!({
                    "type": "object",
                    "required": ["text", "kind"],
                    "properties": {
                        "text": {"type": "string", "maxLength": 2000},
                        "kind": {"type": "string", "enum": ["fact", "preference", "decision", "procedure", "responsibility"]},
                        "anchorMessageId": {"type": "string"},
                        "pinned": {"type": "boolean"},
                        "expiresAt": {"type": "string"},
                        "topicKey": {"type": "string", "maxLength": 120},
                        "topicValue": {"type": "string", "maxLength": 200}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "read_work_notes",
                "local.continuity.read_notes",
                "Read scoped working-context notes persisted in the Coordination V2 journal.",
                json!({
                    "type": "object",
                    "properties": {
                        "workId": {"type": "string", "maxLength": 200},
                        "noteId": {"type": "string", "maxLength": 200},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "write_work_note",
                "local.continuity.write_note",
                "Write or update a named versioned working-context note using optimistic expectedRevision.",
                json!({
                    "type": "object",
                    "required": ["name", "text", "expectedRevision"],
                    "properties": {
                        "workId": {"type": "string", "maxLength": 200},
                        "name": {"type": "string", "maxLength": 120},
                        "text": {"type": "string", "maxLength": 12000},
                        "expectedRevision": {"type": "integer", "minimum": 0},
                        "sourceRefs": {"type": "array", "maxItems": 32, "items": {"type": "string", "maxLength": 300}}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "search_work_history",
                "local.continuity.search_history",
                "Search bounded pages of work conversation history with automatic secret redaction.",
                json!({
                    "type": "object",
                    "properties": {
                        "workId": {"type": "string", "maxLength": 200},
                        "conversationId": {"type": "string", "maxLength": 200},
                        "query": {"type": "string", "maxLength": 500},
                        "before": {"type": "string", "maxLength": 300},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 50}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "prepare_context_handoff",
                "local.continuity.prepare_handoff",
                "Prepare a durable continuity handoff window in Coordination V2.",
                json!({
                    "type": "object",
                    "required": ["hint"],
                    "properties": {
                        "workId": {"type": "string", "maxLength": 200},
                        "hint": {"type": "string", "maxLength": 6000},
                        "previousWindowId": {"type": "string", "maxLength": 200},
                        "historyCursor": {"type": "string", "maxLength": 300}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "inspect_execution_obligation",
                "local.delegation.inspect_execution_obligation",
                "Inspect unsettled execution obligations, recorder liveness, resource claims, and allowed follow-up actions.",
                json!({
                    "type": "object",
                    "properties": {
                        "sessionIds": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
                        "obligationIds": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
                        "detail": {"type": "string", "enum": ["summary", "evidence"]}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "request_obligation_authorization",
                "local.delegation.request_obligation_authorization",
                "Request a user-confirmed authorization grant to retire/restore execution follow-up or close an unsettled claim.",
                json!({
                    "type": "object",
                    "required": ["items"],
                    "properties": {
                        "items": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "required": ["obligationId", "sessionId", "operationId", "evidenceRevision", "actions"],
                                "properties": {
                                    "obligationId": {"type": "string"},
                                    "sessionId": {"type": "string"},
                                    "operationId": {"type": "string"},
                                    "evidenceRevision": {"type": "string"},
                                    "actions": {"type": "array", "minItems": 1, "items": {"type": "string"}}
                                },
                                "additionalProperties": false
                            }
                        }
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "resolve_execution_obligation",
                "local.delegation.resolve_execution_obligation",
                "Resolve confirmed execution obligations idempotently using grantId and idempotencyKey.",
                json!({
                    "type": "object",
                    "required": ["grantId", "idempotencyKey", "items"],
                    "properties": {
                        "grantId": {"type": "string"},
                        "idempotencyKey": {"type": "string", "minLength": 16, "maxLength": 128},
                        "items": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 20,
                            "items": {
                                "type": "object",
                                "required": ["sessionId", "operationId", "actions"],
                                "properties": {
                                    "sessionId": {"type": "string"},
                                    "operationId": {"type": "string"},
                                    "actions": {"type": "array", "minItems": 1, "items": {"type": "string"}}
                                },
                                "additionalProperties": false
                            }
                        }
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                "propose_objective_action",
                "local.objective.propose_action",
                "Reserve an auto-spawn or create a user-approval proposal card for an active objective watch event batch.",
                json!({
                    "type": "object",
                    "required": ["objectiveId", "eventIds", "task"],
                    "properties": {
                        "objectiveId": {"type": "string"},
                        "eventIds": {"type": "array", "minItems": 1, "maxItems": 20, "items": {"type": "string"}},
                        "task": {"type": "object"},
                        "forceProposal": {"type": "boolean"}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                INTERACTIVE_INSPECT_TOOL,
                INTERACTIVE_INSPECT_CAPABILITY,
                "Inspect metadata or fallback text of an admitted fixed interactive result or publication receipt.",
                json!({
                    "type": "object",
                    "required": ["target", "view"],
                    "properties": {
                        "target": {"type": "object"},
                        "view": {"type": "string", "enum": ["metadata", "text", "program", "data", "evaluate"]},
                        "bindingId": {"type": "string"},
                        "selector": {"type": "object"},
                        "followupId": {"type": "string"},
                        "offset": {"type": "integer", "minimum": 0},
                        "limit": {"type": "integer", "minimum": 1, "maximum": 4000}
                    },
                    "additionalProperties": false
                }),
            ),
            Self::manifest(
                ACTIVATE_SKILL_PACK_TOOL,
                ACTIVATE_SKILL_PACK_CAPABILITY,
                "Activate one or more on-demand Project Agent capability packs to unlock their tools and receive their usage guide.",
                json!({
                    "type": "object",
                    "required": ["packs"],
                    "properties": {
                        "packs": {
                            "type": "array",
                            "minItems": 1,
                            "maxItems": 4,
                            "items": {
                                "type": "string",
                                "enum": all_skill_pack_ids()
                            },
                            "description": "Capability pack IDs to activate for the remainder of this turn."
                        }
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
            && !capability.starts_with("local.continuity.")
            && !capability.starts_with("local.interactive.")
        {
            return Err(HostError("tool_not_projected"));
        }
        Ok(Box::new(PreparedProjectEffect {
            capability: capability.to_owned(),
            args,
            data_home: self.data_home.clone(),
            supervisor: Arc::clone(&self.supervisor),
            coordination: Arc::clone(&self.coordination),
            verifier_model: self.verifier_model.clone(),
            state: Arc::clone(&self.state),
        }))
    }
}

struct PreparedProjectEffect {
    capability: String,
    args: Value,
    data_home: PathBuf,
    supervisor: Arc<SessionSupervisor>,
    coordination: Arc<CoordinationHub>,
    verifier_model: Option<NativeModel>,
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
            let res = if self.capability == "local.delegation.verify_session" {
                self.verify_session(&cancel).await
            } else if matches!(
                self.capability.as_str(),
                "local.delegation.inspect_execution_obligation"
                    | "local.delegation.request_obligation_authorization"
                    | "local.delegation.resolve_execution_obligation"
            ) {
                execute_async_obligation_capability(
                    &self.capability,
                    &self.args,
                    &self.data_home,
                    &self.supervisor,
                    &self.coordination,
                    &self.state,
                    call.tool_call_id(),
                )
                .await
            } else {
                execute_project_capability(
                    &self.capability,
                    &self.args,
                    &self.data_home,
                    &self.supervisor,
                    &self.coordination,
                    &self.state,
                    call.tool_call_id(),
                )
            };
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

impl PreparedProjectEffect {
    async fn verify_session(&self, cancel: &CancellationToken) -> Result<Value, CapFailure> {
        let sid = self.args["sessionId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("invalid_input"))?;
        let focus = self.args["focus"]
            .as_str()
            .map(str::trim)
            .filter(|focus| !focus.is_empty());
        if focus.is_some_and(|text| text.chars().count() > 500) {
            return Err(ProjectError::code("invalid_input").into());
        }
        let (workspace, plan) = {
            let state = self
                .state
                .lock()
                .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
            if !state.holds_lease {
                return Err(ProjectError::code("LEASE_REQUIRED").into());
            }
            check_quote_scope(&state, sid)?;
            let plan =
                self.supervisor
                    .plan_for_bot(&state.workspace_id, &state.conversation_id, sid)?;
            (state.workspace_id.clone(), plan)
        };
        let origin = &plan["delegationOrigin"];
        let force = self.args["force"] == true || focus.is_some();
        let missing_or_failed = origin["independentVerifier"] == "failed"
            || origin["independentVerifier"] == "missing"
            || origin["independentVerifier"].is_null()
            || plan["verificationReport"]["passed"] == false;
        if (force || missing_or_failed)
            && let Some(model) = &self.verifier_model
        {
            // Ordinary conversation execution is local-thread only. Keep it on a
            // blocking-pool thread while the provider effect stays Send.
            let epoch = self
                .coordination
                .lease_epoch(&workspace)
                .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
            let coordination = Arc::clone(&self.coordination);
            let runtime = tokio::runtime::Handle::current();
            let supervisor = Arc::clone(&self.supervisor);
            let focus = focus.map(str::to_owned);
            let model = model.clone();
            let child = cancel.child_token();
            let _cancel_on_drop = child.clone().drop_guard();
            return Ok(tokio::task::spawn_blocking(move || {
                runtime.block_on(supervisor.reverify_session(
                    plan,
                    focus.as_deref(),
                    &model,
                    &child,
                    || coordination.holds_generation(&workspace, &epoch),
                ))
            })
            .await
            .map_err(|_| ProjectError::code("verifier_task_failed"))??);
        }
        let decision = self
            .supervisor
            .settle_session(&workspace, sid, false, false, None, true)?;
        Ok(json!({"ok": true, "sessionId": sid, "decision": decision, "reverified": false}))
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
    let mut reply_to = if raw_reply_to.is_empty() {
        if !proactive && state.kind == "user" && !state.current_input_anchors.is_empty() {
            state.current_input_anchors.clone()
        } else {
            Vec::new()
        }
    } else {
        resolve_anchors_for_state(&raw_reply_to, state)?
    };
    let raw_sources: Vec<String> = args["sources"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    let mut status_claims: Vec<StatusClaim> = args["statusClaims"]
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

    // Normalize optional `session:` prefix when it matches a real project session,
    // deduplicate sources, merge any claimed real project session IDs, and auto-fill
    // omitted statusClaims from persisted host facts while preserving strict rejection
    // of explicit mismatched claims and forged sources.
    let mut sources: Vec<String> = Vec::new();
    let mut seen_sources = HashSet::new();
    for raw in raw_sources {
        let trimmed = raw.trim();
        let normalized = if project_session_ids.contains(trimmed) {
            trimmed.to_owned()
        } else if let Some(stripped) = trimmed.strip_prefix("session:")
            && project_session_ids.contains(stripped)
        {
            stripped.to_owned()
        } else {
            raw
        };
        if seen_sources.insert(normalized.clone()) {
            sources.push(normalized);
        }
    }
    for claim in &mut status_claims {
        if !project_session_ids.contains(&claim.session_id)
            && let Some(stripped) = claim.session_id.trim().strip_prefix("session:")
            && project_session_ids.contains(stripped)
        {
            claim.session_id = stripped.to_owned();
        }
        if project_session_ids.contains(&claim.session_id)
            && seen_sources.insert(claim.session_id.clone())
        {
            sources.push(claim.session_id.clone());
        }
    }
    let explicit_claim_ids: HashSet<String> =
        status_claims.iter().map(|c| c.session_id.clone()).collect();
    for sid in &sources {
        if !explicit_claim_ids.contains(sid)
            && let Some(fact) = session_facts.iter().find(|f| f.session_id == *sid)
        {
            status_claims.push(StatusClaim {
                session_id: sid.clone(),
                status: fact.status.clone(),
            });
        }
    }
    // When a wake turn posts a reply citing sessions whose originating user input has not yet
    // received any agent_reply (e.g. after `wait_for_sessions`), inherit those unanswered
    // anchors automatically so the user message transitions cleanly to replied.
    if state.kind == "wake" && reply_to.is_empty() && !sources.is_empty() {
        let mut seen_reply_to = HashSet::new();
        for sid in &sources {
            if let Some(sess) = sessions.iter().find(|s| s.session_id == *sid) {
                for anc in &sess.anchor_message_ids {
                    if state.valid_user_message_ids.contains(anc)
                        && !state.answered_user_message_ids.contains(anc)
                        && seen_reply_to.insert(anc.clone())
                    {
                        reply_to.push(anc.clone());
                    }
                }
            }
        }
    }

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
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 50) as usize;
    let kinds_filter: Option<HashSet<String>> = args["kinds"].as_array().map(|arr| {
        arr.iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect()
    });
    let messages = crate::read_full_conversation_messages(
        &ConversationStore::new(data_home),
        &state.conversation_id,
    )
    .map_err(ProjectError::from)?;

    let mut docs = Vec::new();
    let mut row_by_id: std::collections::HashMap<String, (&str, Value)> =
        std::collections::HashMap::new();
    for m in messages.iter().rev() {
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
        let Some(msg_id) = m["id"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let content = m["content"].as_str().unwrap_or("");
        if content.trim().is_empty() {
            continue;
        }
        let title: String = content.split_whitespace().collect::<Vec<_>>().join(" ");
        let clipped_title: String = title.chars().take(80).collect();
        let doc = ConversationSearchDocument {
            id: format!("message:{}:{msg_id}", state.workspace_id),
            kind: "message".into(),
            workspace_id: state.workspace_id.clone(),
            title: clipped_title,
            text: content.to_owned(),
            message_id: Some(msg_id.to_owned()),
            session_id: None,
            memory_id: None,
            updated_at: m["createdAt"].as_str().unwrap_or("").to_owned(),
        };
        docs.push(doc);
        row_by_id.insert(msg_id.to_owned(), (eff_kind, m.clone()));
    }

    let db_path = data_home
        .join("project-runtime")
        .join(&state.workspace_id)
        .join("search-index.sqlite");
    let idx = ConversationSearchIndex::open(&db_path)?;
    for doc in &docs {
        let _ = idx.upsert(doc)?;
    }
    let hits = idx.search(query, Some(&state.workspace_id), Some(&["message"]), 200)?;

    let mut matches = Vec::new();
    for hit in hits {
        let Some(msg_id) = hit.message_id.as_deref() else {
            continue;
        };
        let Some((eff_kind, m)) = row_by_id.get(msg_id) else {
            continue;
        };
        let content = m["content"].as_str().unwrap_or("");
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

fn spawn_from_args(
    args: &Value,
    state: &mut TurnExecutionState,
    supervisor: &SessionSupervisor,
    coordination: &CoordinationHub,
) -> Result<crate::WorkSessionSummary, CapFailure> {
    let mut raw_anchors: Vec<String> = match args.get("anchorMessageIds") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(arr)) => arr
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect(),
        Some(_) => return Err(ProjectError::code("invalid_input").into()),
    };
    if raw_anchors.is_empty()
        && args.get("anchorMessageIds").is_none_or(Value::is_null)
        && state.kind == "user"
        && !state.current_input_anchors.is_empty()
    {
        raw_anchors = state.current_input_anchors.clone();
    }
    if raw_anchors.is_empty() {
        return Err(ProjectError::code("invalid_anchor").into());
    }
    let anchors = resolve_anchors_for_state(&raw_anchors, state)?;
    if let Some(sup) = args["supersedes"].as_str() {
        check_quote_scope(state, sup)?;
    }
    let mut criteria: Vec<SpawnCriterion> = serde_json::from_value(args["successCriteria"].clone())
        .map_err(|err| {
            ProjectError::new("invalid_input", format!("invalid successCriteria: {err}"))
        })?;
    let anchor_text = supervisor.anchor_text_for_ids(&state.conversation_id, &anchors);
    let user_requested_manual = crate::acceptance::anchor_requests_review(&anchor_text);
    for c in &mut criteria {
        // Model-generated criteria must not invent human-blocking `manual` gates unless
        // the user's anchor message explicitly requested manual review/confirmation
        // (mirrors `criterion-authority.mjs`). Promote unauthorized `manual` -> `model_review`
        // so the independent verifier checks it automatically.
        if c.kind.eq_ignore_ascii_case("manual") && !user_requested_manual {
            c.kind = "model_review".to_owned();
        }
        if c.description.trim().is_empty() {
            c.description = if let Some(cmd) = c.command.as_deref().filter(|s| !s.trim().is_empty())
            {
                let clipped: String = cmd.trim().chars().take(120).collect();
                format!("Run command: {clipped}")
            } else if let Some(path) = c.path.as_deref().filter(|s| !s.trim().is_empty()) {
                format!("Verify {} on {}", c.kind, path.trim())
            } else if let Some(exp) = c.expect.as_deref().filter(|s| !s.trim().is_empty()) {
                let clipped: String = exp.trim().chars().take(120).collect();
                format!("Verify {}: {clipped}", c.kind)
            } else {
                format!("Verify {} criterion", c.kind)
            };
        }
    }
    let read_only = args["readOnly"].as_bool().unwrap_or(true);
    let mut required_caps: Vec<String> = args["requiredCapabilities"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();
    if required_caps.is_empty()
        && let Some(preset) = args["capabilityPreset"].as_str().map(str::trim)
    {
        let preset_caps: &[&str] = match (preset, read_only) {
            ("read_only", _) | ("code_edit", true) | ("code_edit_and_shell", true) => &[
                "local.file.read",
                "local.file.list",
                "local.file.search",
                "local.git.query",
            ],
            ("code_edit", false) => &[
                "local.file.read",
                "local.file.list",
                "local.file.search",
                "local.git.query",
                "local.file.write",
                "local.file.edit",
            ],
            ("code_edit_and_shell", false) => &[
                "local.file.read",
                "local.file.list",
                "local.file.search",
                "local.git.query",
                "local.file.write",
                "local.file.edit",
                "local.shell.exec",
                "local.shell.stop",
            ],
            ("web_research", true) => &[
                "local.file.read",
                "local.file.list",
                "local.file.search",
                "local.git.query",
            ],
            ("web_research", false) => &[
                "local.file.read",
                "local.file.list",
                "local.file.search",
                "local.git.query",
                "local.web.fetch",
            ],
            _ => return Err(ProjectError::code("invalid_input").into()),
        };
        required_caps = preset_caps.iter().map(|s| (*s).to_owned()).collect();
    }
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
            read_only,
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
    if !state.work_id.is_empty() && coordination.holds(&state.workspace_id) {
        let _ = coordination.ensure_work(
            &state.workspace_id,
            &state.work_id,
            &state.conversation_id,
            &state.current_input_anchors,
            std::slice::from_ref(&spawned.session_id),
            "runnable",
        );
    }
    Ok(spawned)
}

fn execute_continuity_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    coordination: &CoordinationHub,
    state: &TurnExecutionState,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let work_id = args["workId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or_else(|| state.work_id.clone());
    if work_id.is_empty() {
        return Err(ProjectError::code("working_context_unavailable").into());
    }
    match capability {
        "local.continuity.read_notes" => {
            if coordination
                .read_work(&state.workspace_id, &work_id)?
                .is_none()
            {
                return Err(ProjectError::code("working_context_unavailable").into());
            }
            let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
            let notes = coordination.read_work_notes(
                &state.workspace_id,
                &work_id,
                None,
                args["noteId"].as_str(),
                limit,
            )?;
            Ok(json!({ "ok": true, "notes": notes }))
        }
        "local.continuity.write_note" => {
            let work = coordination
                .read_work(&state.workspace_id, &work_id)?
                .ok_or_else(|| ProjectError::code("working_context_unavailable"))?;
            if matches!(
                work["state"].as_str(),
                Some("paused" | "cancelled" | "coalesced" | "delivered")
            ) {
                return Err(ProjectError::code("work_execution_stopped").into());
            }
            let name = args["name"]
                .as_str()
                .ok_or_else(|| ProjectError::code("work_note_invalid"))?;
            let text = args["text"]
                .as_str()
                .ok_or_else(|| ProjectError::code("work_note_invalid"))?;
            let expected_revision = args["expectedRevision"]
                .as_u64()
                .ok_or_else(|| ProjectError::code("work_note_invalid"))?;
            let source_refs: Vec<String> = args["sourceRefs"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let (note, replayed) = coordination.write_work_note(
                &state.workspace_id,
                &work_id,
                &state.conversation_id,
                name,
                text,
                expected_revision,
                source_refs,
                tool_call_id,
            )?;
            Ok(json!({ "ok": true, "note": note, "replayed": replayed }))
        }
        "local.continuity.search_history" => {
            if coordination
                .read_work(&state.workspace_id, &work_id)?
                .is_none()
            {
                return Err(ProjectError::code("working_context_unavailable").into());
            }
            let conv_id = args["conversationId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or(&state.conversation_id);
            let query = args["query"]
                .as_str()
                .map(|s| s.trim().to_lowercase())
                .unwrap_or_default();
            let before = args["before"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty());
            let limit = args["limit"].as_u64().unwrap_or(20).clamp(1, 50) as usize;
            let messages =
                crate::read_full_conversation_messages(&ConversationStore::new(data_home), conv_id)
                    .map_err(ProjectError::from)?;
            let mut matches = Vec::new();
            let mut seen_before = before.is_none();
            for m in messages.iter().rev() {
                let id = m["id"].as_str().unwrap_or("");
                if !seen_before {
                    if Some(id) == before {
                        seen_before = true;
                    }
                    continue;
                }
                if m["meta"]["compaction"].is_object()
                    || matches!(m["kind"].as_str(), Some("compaction" | "agent_turn"))
                {
                    continue;
                }
                let raw_text = m["content"].as_str().unwrap_or("");
                if raw_text.is_empty() {
                    continue;
                }
                if !query.is_empty() && !raw_text.to_lowercase().contains(&query) {
                    continue;
                }
                let redacted = memory_secret_reason(raw_text).is_some();
                let snippet: String = if redacted {
                    "[sensitive history content omitted]".to_owned()
                } else {
                    raw_text.chars().take(2000).collect()
                };
                matches.push(json!({
                    "messageId": id,
                    "conversationId": conv_id,
                    "kind": m["kind"],
                    "text": snippet,
                    "redacted": redacted,
                }));
                if matches.len() >= limit {
                    break;
                }
            }
            let next_cursor = matches
                .last()
                .and_then(|m| m["messageId"].as_str())
                .map(str::to_owned);
            Ok(json!({
                "ok": true,
                "matches": matches,
                "nextCursor": next_cursor,
                "searchedOnePage": true,
            }))
        }
        "local.continuity.prepare_handoff" => {
            let work = coordination
                .read_work(&state.workspace_id, &work_id)?
                .ok_or_else(|| ProjectError::code("working_context_unavailable"))?;
            if matches!(
                work["state"].as_str(),
                Some("paused" | "cancelled" | "coalesced" | "delivered")
            ) {
                return Err(ProjectError::code("work_execution_stopped").into());
            }
            let hint = args["hint"]
                .as_str()
                .ok_or_else(|| ProjectError::code("context_hint_invalid"))?;
            let (window, replayed) = coordination.prepare_context_handoff(
                &state.workspace_id,
                &work_id,
                &state.conversation_id,
                hint,
                args["previousWindowId"].as_str(),
                args["historyCursor"].as_str(),
                tool_call_id,
            )?;
            Ok(json!({
                "ok": true,
                "window": window,
                "replayed": replayed,
                "providerWindowChanged": false,
            }))
        }
        _ => Err(ProjectError::code("tool_not_projected").into()),
    }
}

fn execute_send_agent_message(
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    coordination: &CoordinationHub,
    state: &TurnExecutionState,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let sid = args["sessionId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ProjectError::code("agent_identity_mismatch"))?;
    let plan = supervisor
        .find_plan_by_session(&state.workspace_id, sid)
        .ok_or_else(|| ProjectError::code("agent_out_of_scope"))?;
    if plan["delegationOrigin"]["workspaceId"].as_str() != Some(state.workspace_id.as_str())
        || plan["delegationOrigin"]["parentConversationId"].as_str()
            != Some(state.conversation_id.as_str())
    {
        return Err(ProjectError::code("agent_out_of_scope").into());
    }
    let child_conv_id = plan["conversationId"]
        .as_str()
        .ok_or_else(|| ProjectError::code("agent_conversation_unavailable"))?;
    let text = args["text"]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.chars().count() <= 4_000)
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let purpose = args["purpose"]
        .as_str()
        .filter(|p| matches!(*p, "update" | "question" | "answer"))
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let ensure_turn = args["delivery"].as_str() == Some("ensure_turn") || purpose == "answer";
    let work_id = if !state.work_id.is_empty() {
        state.work_id.clone()
    } else {
        crate::coordination_work_id(
            &state.conversation_id,
            std::slice::from_ref(&sid.to_owned()),
        )
    };
    coordination.ensure_work(
        &state.workspace_id,
        &work_id,
        &state.conversation_id,
        &state.current_input_anchors,
        &[sid.to_owned()],
        "runnable",
    )?;
    if let Some(exp_rev) = args["expectedRevision"].as_u64() {
        let coord_state = coordination.read_state(&state.workspace_id)?;
        let cur_rev = coord_state["mandates"][&work_id]["goalRevision"]
            .as_u64()
            .unwrap_or(0);
        if exp_rev != cur_rev {
            return Err(ProjectError::code("goal_revision_conflict").into());
        }
    }

    let (msg, replayed) = coordination.commit_agent_message(
        &state.workspace_id,
        CommitAgentMessageRequest {
            work_id: &work_id,
            session_id: sid,
            direction: "parent_to_child",
            purpose,
            text,
            sender_conversation_id: &state.conversation_id,
            recipient_conversation_id: child_conv_id,
            ensure_turn,
            goal_revision: args["expectedRevision"].as_u64(),
            execution_epoch: args["expectedExecutionEpoch"].as_str(),
            reply_to: args["replyTo"].as_str(),
            decision_answer: args.get("decisionAnswer").filter(|v| v.is_object()),
            delivery_key: tool_call_id,
        },
    )?;

    let at = crate::now_iso();
    let msg_id = msg["messageId"].as_str().unwrap_or(tool_call_id);
    ConversationStore::new(data_home)
        .append_message_idempotent(
            child_conv_id,
            &json!({
                "id": msg_id,
                "role": "user",
                "kind": "agent_message",
                "content": text,
                "agentMessage": msg,
                "createdAt": at,
            }),
            &at,
            None,
        )
        .map_err(ProjectError::from)?;

    let session_status = supervisor
        .list_sessions(&state.workspace_id)
        .into_iter()
        .find(|s| s.session_id == sid)
        .map(|s| s.status)
        .unwrap_or_default();
    if ensure_turn
        && !matches!(
            session_status.as_str(),
            "accepted" | "cancelled" | "failed" | "superseded"
        )
    {
        let _ = supervisor.message_session(
            &state.workspace_id,
            sid,
            text,
            if purpose == "answer" {
                "answer"
            } else {
                "amend"
            },
            true,
        );
    }

    Ok(json!({
        "ok": true,
        "messageId": msg_id,
        "sessionId": sid,
        "workId": work_id,
        "delivery": if ensure_turn { "queued" } else { "mailbox_only" },
        "replayed": replayed,
    }))
}

fn execute_coordinate_work(
    args: &Value,
    supervisor: &SessionSupervisor,
    coordination: &CoordinationHub,
    state: &mut TurnExecutionState,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let action = args["action"]
        .as_str()
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let reason = args["reason"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| ProjectError::code("invalid_input"))?;
    let sid_opt = args["sessionId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    let coord_state = coordination.read_state(&state.workspace_id)?;
    let work_id = args["workId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .or_else(|| {
            sid_opt.and_then(|sid| {
                coord_state["works"]
                    .as_object()?
                    .values()
                    .find(|w| {
                        w["sessionIds"]
                            .as_array()
                            .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(sid)))
                    })
                    .and_then(|w| w["workId"].as_str().map(str::to_owned))
            })
        })
        .unwrap_or_else(|| state.work_id.clone());

    if action == "query" {
        let mandate = &coord_state["mandates"][&work_id];
        let work = &coord_state["works"][&work_id];
        let goal_revision = mandate["goalRevision"].as_u64().unwrap_or(0);
        let sessions = supervisor.list_sessions(&state.workspace_id);
        let session =
            sid_opt.and_then(|sid| sessions.iter().find(|s| s.session_id == sid).cloned());
        let open_requests: Vec<Value> = coord_state["agentRequests"]
            .as_object()
            .into_iter()
            .flatten()
            .map(|(_, r)| r.clone())
            .filter(|r| {
                r["status"] == "open"
                    && sid_opt.is_none_or(|sid| r["sessionId"].as_str() == Some(sid))
            })
            .collect();
        return Ok(json!({
            "ok": true,
            "action": "query",
            "workId": work_id,
            "goalRevision": goal_revision,
            "work": work,
            "mandate": mandate,
            "session": session,
            "sessions": sessions,
            "agentRequests": open_requests,
        }));
    }

    if state.current_input_anchors.is_empty() {
        return Err(ProjectError::code("current_user_required").into());
    }
    if let Some(sid) = sid_opt {
        check_quote_scope(state, sid)?;
    }

    coordination.ensure_work(
        &state.workspace_id,
        &work_id,
        &state.conversation_id,
        &state.current_input_anchors,
        &sid_opt.map(|s| vec![s.to_owned()]).unwrap_or_default(),
        "runnable",
    )?;
    let mandate = coordination.record_coordination_decision(
        &state.workspace_id,
        &work_id,
        action,
        reason,
        args["expectedRevision"].as_u64(),
        state.current_input_anchors.clone(),
        tool_call_id,
        sid_opt,
    )?;

    let mut extra_session: Value = Value::Null;
    match action {
        "cancel" => {
            let sid = sid_opt.ok_or_else(|| ProjectError::code("invalid_input"))?;
            let updated =
                supervisor.cancel_session_by_agent(&state.workspace_id, sid, reason, true)?;
            extra_session = json!(updated);
        }
        "resume" => {
            let sid = sid_opt.ok_or_else(|| ProjectError::code("invalid_input"))?;
            let updated = supervisor.resume_session(&state.workspace_id, sid, true)?;
            extra_session = json!(updated);
        }
        "answer" | "augment" | "revise" => {
            let sid = sid_opt.ok_or_else(|| ProjectError::code("invalid_input"))?;
            let text = args["text"].as_str().unwrap_or(reason);
            let intent = if action == "answer" {
                "answer"
            } else {
                "amend"
            };
            let updated =
                supervisor.message_session(&state.workspace_id, sid, text, intent, true)?;
            extra_session = json!(updated);
        }
        "handoff" => {
            let sid = sid_opt.ok_or_else(|| ProjectError::code("invalid_input"))?;
            let _ = supervisor.handoff_worktree(&state.workspace_id, sid, true)?;
        }
        "parallel" | "replace" => {
            if action == "replace"
                && let Some(old_sid) = sid_opt
            {
                let _ = supervisor.cancel_session_by_agent(
                    &state.workspace_id,
                    old_sid,
                    reason,
                    true,
                )?;
            }
            if args["task"].is_object() {
                let spawned = spawn_from_args(&args["task"], state, supervisor, coordination)?;
                extra_session = json!(spawned);
            }
        }
        "assess" => {}
        _ => return Err(ProjectError::code("invalid_input").into()),
    }

    Ok(json!({
        "ok": true,
        "action": action,
        "workId": work_id,
        "goalRevision": mandate["goalRevision"],
        "mandate": mandate,
        "session": extra_session,
    }))
}

fn execute_project_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    coordination: &CoordinationHub,
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
            let (spawned, retry_count) = if state.current_input_anchors.is_empty() {
                let predecessor = args["supersedes"]
                    .as_str()
                    .filter(|_| state.kind == "wake")
                    .ok_or_else(|| ProjectError::code("current_user_required"))?;
                check_quote_scope(&state, predecessor)?;
                let (spawned, count) = supervisor.retry_session(&state, predecessor, args)?;
                state.spawned_session_ids.push(spawned.session_id.clone());
                (spawned, Some(count))
            } else {
                (
                    spawn_from_args(args, &mut state, supervisor, coordination)?,
                    None,
                )
            };
            let mut result = json!({
                "ok": true,
                "sessionId": spawned.session_id,
                "planId": spawned.plan_id,
                "status": spawned.status,
                "phase": spawned.phase,
                "queued": spawned.phase == "queued",
                "approvalId": spawned.approval_id,
            });
            if let Some(count) = retry_count {
                result["autoRetryCount"] = json!(count);
                result["maxAutoRetries"] =
                    json!(crate::supervisor::autonomy::MAX_AUTONOMOUS_RETRIES);
            }
            Ok(result)
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
                // Keep report payload compact and non-redundant so normal session reports
                // stay inline without triggering unnecessary multi-round read_tool_result paging.
                let brief_preview: String = if report.task_brief.chars().count() > 400 {
                    let head: String = report.task_brief.chars().take(400).collect();
                    format!("{head}…")
                } else {
                    report.task_brief.clone()
                };
                let ev_total = report.evidence_refs.len();
                let ev_refs: Vec<&String> = report.evidence_refs.iter().take(12).collect();
                let worker_out: String = if report.worker_output.chars().count() > 3800 {
                    let head: String = report.worker_output.chars().take(3800).collect();
                    format!(
                        "{head}\n…[truncated; total {} chars]",
                        report.worker_output.chars().count()
                    )
                } else {
                    report.worker_output.clone()
                };
                let mut compact_report = json!({
                    "taskBrief": brief_preview,
                    "evidenceRefs": ev_refs,
                    "changedFiles": report.changed_files,
                    "verdictOutcome": report.verdict_outcome,
                    "independentVerifier": report.independent_verifier,
                    "workerOutput": worker_out,
                });
                if let Some(ref question) = report.pending_agent_question {
                    compact_report["pendingAgentQuestion"] = json!(question);
                }
                if ev_total > 12 {
                    compact_report["evidenceRefCount"] = json!(ev_total);
                }
                if let Some(ref fc) = report.failure_code {
                    compact_report["failureCode"] = json!(fc);
                }
                if let Some(ref fd) = report.failure_detail {
                    compact_report["failureDetail"] = json!(fd);
                }
                Ok(json!({ "ok": true, "session": report.summary, "report": compact_report }))
            }
        }
        "local.delegation.cancel_session" => {
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let autonomous_cleanup =
                supervisor.is_dead_or_invalid_session(&state.workspace_id, sid);
            if !autonomous_cleanup && state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            if !autonomous_cleanup {
                check_quote_scope(&state, sid)?;
            }
            let reason = args["reason"].as_str().unwrap_or("cancelled");
            let updated = if autonomous_cleanup && state.current_input_anchors.is_empty() {
                supervisor.cleanup_session(&state.workspace_id, sid, reason, true)?
            } else {
                supervisor.cancel_session_by_agent(&state.workspace_id, sid, reason, true)?
            };
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "status": updated.status }))
        }
        "local.delegation.control_work" => {
            let sid = args["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let action = args["action"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let autonomous_cleanup = action == "cancel"
                && supervisor.is_dead_or_invalid_session(&state.workspace_id, sid);
            if !autonomous_cleanup && state.current_input_anchors.is_empty() {
                return Err(ProjectError::code("current_user_required").into());
            }
            if !autonomous_cleanup {
                check_quote_scope(&state, sid)?;
            }
            let updated = if autonomous_cleanup && state.current_input_anchors.is_empty() {
                supervisor.cleanup_session(&state.workspace_id, sid, "bot_cleanup", true)?
            } else if action == "cancel" {
                supervisor.cancel_session_by_agent(&state.workspace_id, sid, "user_control", true)?
            } else {
                supervisor.control_session(
                    &state.workspace_id,
                    sid,
                    action,
                    "user_control",
                    true,
                )?
            };
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
            let updated = if state.current_input_anchors.is_empty() {
                if state.kind != "wake" || intent != "answer" {
                    return Err(ProjectError::code("current_user_required").into());
                }
                supervisor.answer_worker(&state.workspace_id, &state.conversation_id, sid, text)?
            } else {
                supervisor.message_session(&state.workspace_id, sid, text, intent, true)?
            };
            Ok(json!({ "ok": true, "sessionId": updated.session_id, "status": updated.status }))
        }
        "local.delegation.resume_session" => {
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
            let updated = if state.current_input_anchors.is_empty() {
                if state.kind != "wake" {
                    return Err(ProjectError::code("current_user_required").into());
                }
                supervisor.resume_technical_session(
                    &state.workspace_id,
                    &state.conversation_id,
                    sid,
                )?
            } else {
                supervisor.resume_session(&state.workspace_id, sid, true)?
            };
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
        "local.delegation.send_agent_message" => execute_send_agent_message(
            args,
            data_home,
            supervisor,
            coordination,
            &state,
            tool_call_id,
        ),
        "local.delegation.coordinate_work" => {
            execute_coordinate_work(args, supervisor, coordination, &mut state, tool_call_id)
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
        "local.memory.remember" => {
            if let Some(obj) = args.as_object() {
                for forbidden in [
                    "trust",
                    "status",
                    "sourceRefs",
                    "scope",
                    "workspaceId",
                    "fileAnchors",
                    "needsReverify",
                    "conflictId",
                    "conflictsWith",
                    "supersededBy",
                ] {
                    if obj.contains_key(forbidden) {
                        return Err(ProjectError::code("invalid_input").into());
                    }
                }
            }
            let kind = args["kind"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let text = args["text"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let scope = if kind == "preference" {
                "user"
            } else {
                "project"
            };
            let anchor_owned = args["anchorMessageId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|raw| {
                    resolve_anchors_for_state(&[raw.to_owned()], &state)
                        .map(|v| v.into_iter().next().unwrap_or_default())
                })
                .transpose()?
                .or_else(|| state.current_input_anchors.first().cloned())
                .or_else(|| {
                    state
                        .user_anchor_candidates
                        .last()
                        .map(|c| c.message_id.clone())
                });
            let source_refs = anchor_owned
                .clone()
                .map(|a| vec![a])
                .unwrap_or_else(|| vec![format!("turn:{}", state.turn_id)]);
            let item = MemoryStore::new(data_home).write(&WriteMemoryRequest {
                scope,
                workspace_id: (scope == "project").then_some(state.workspace_id.as_str()),
                kind,
                text,
                trust: "stated",
                source_refs,
                pinned: args["pinned"].as_bool().unwrap_or(false),
                anchor_message_id: anchor_owned.as_deref(),
                expires_at: args["expiresAt"].as_str(),
                topic_key: args["topicKey"].as_str(),
                topic_value: args["topicValue"].as_str(),
                file_anchors: None,
            })?;
            state.memory_learned.push(item.id.clone());
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
        cap if cap.starts_with("local.continuity.") => {
            execute_continuity_capability(cap, args, data_home, coordination, &state, tool_call_id)
        }
        "local.objective.propose_action" => {
            let oid = args["objectiveId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let event_ids: Vec<String> = args["eventIds"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            if event_ids.is_empty() {
                return Err(ProjectError::code("invalid_input").into());
            }
            let obj = ObjectiveStore::new(data_home)
                .get(&state.workspace_id, oid)?
                .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
            if obj.status != "active" {
                return Err(ProjectError::code("OBJECTIVE_NOT_ACTIVE").into());
            }
            let mut task = args["task"].clone();
            if !task.is_object() {
                return Err(ProjectError::code("invalid_input").into());
            }
            if task["anchorMessageIds"]
                .as_array()
                .is_none_or(Vec::is_empty)
            {
                let fallback = if state.current_input_anchors.is_empty() {
                    vec![obj.origin_message_id.clone()]
                } else {
                    state.current_input_anchors.clone()
                };
                task["anchorMessageIds"] = json!(fallback);
            }
            task["objectiveId"] = json!(oid);
            let force_proposal = args["forceProposal"].as_bool().unwrap_or(false);
            let actions = ObjectiveActions::new(data_home);
            let (action, replayed) =
                actions.prepare(&obj, task.clone(), event_ids, force_proposal)?;
            if action.mode == "auto" && action.session_id.is_none() {
                let spawned = spawn_from_args(&task, &mut state, supervisor, coordination)?;
                let _ = actions.link_session(
                    &state.workspace_id,
                    &action.action_id,
                    &spawned.session_id,
                )?;
                Ok(json!({
                    "ok": true,
                    "mode": "auto",
                    "actionId": action.action_id,
                    "sessionId": spawned.session_id,
                    "replayed": replayed,
                    "action": action,
                }))
            } else {
                Ok(json!({
                    "ok": true,
                    "mode": action.mode,
                    "actionId": action.action_id,
                    "cardId": objective_action_card_id(&action.action_id),
                    "replayed": replayed,
                    "action": action,
                }))
            }
        }
        cap if cap == ACTIVATE_SKILL_PACK_CAPABILITY => {
            let raw_packs = args["packs"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            if raw_packs.is_empty() || raw_packs.len() > 4 {
                return Err(ProjectError::code("invalid_input").into());
            }
            let mut specs = Vec::with_capacity(raw_packs.len());
            let mut seen_req = HashSet::new();
            for item in raw_packs {
                let raw_id = item
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .ok_or_else(|| ProjectError::code("invalid_input"))?;
                let Some(spec) = find_skill_pack(raw_id) else {
                    return Err(CapFailure {
                        err: ProjectError::new(
                            "invalid_skill_pack",
                            format!("Unknown capability pack: {raw_id}"),
                        ),
                        extra: Some(json!({
                            "unknownPack": raw_id,
                            "availablePacks": all_skill_pack_ids(),
                        })),
                    });
                };
                if seen_req.insert(spec.id) {
                    specs.push(spec);
                }
            }
            let mut activated = Vec::new();
            let mut already_active = Vec::new();
            let mut unlocked_capabilities = Vec::new();
            let mut guides = serde_json::Map::new();
            for spec in specs {
                if state.activated_packs.iter().any(|p| p == spec.id) {
                    already_active.push(spec.id);
                } else {
                    state.activated_packs.push(spec.id.to_owned());
                    activated.push(spec.id);
                }
                for cap_id in spec.capabilities {
                    unlocked_capabilities.push(*cap_id);
                }
                guides.insert(spec.id.to_owned(), json!(spec.guide));
            }
            Ok(json!({
                "ok": true,
                "activated": activated,
                "alreadyActive": already_active,
                "unlockedCapabilities": unlocked_capabilities,
                "guides": guides,
            }))
        }
        cap if cap == INTERACTIVE_INSPECT_CAPABILITY => {
            let owner = InteractiveOwner {
                workspace_id: state.workspace_id.clone(),
                conversation_id: state.conversation_id.clone(),
            };
            let out = InteractiveResultStore::new(data_home).inspect_for_role(
                "project_agent",
                &owner,
                args,
            )?;
            Ok(out)
        }
        cap if cap.starts_with("local.objective.") => {
            execute_objective_capability(cap, args, data_home, &state)
        }
        _ => Err(ProjectError::code("tool_not_projected").into()),
    }
}

async fn execute_async_obligation_capability(
    capability: &str,
    args: &Value,
    data_home: &Path,
    supervisor: &SessionSupervisor,
    coordination: &CoordinationHub,
    state_lock: &Mutex<TurnExecutionState>,
    tool_call_id: &str,
) -> Result<Value, CapFailure> {
    let (holds_lease, workspace_id, conversation_id) = {
        let g = state_lock
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        (
            g.holds_lease,
            g.workspace_id.clone(),
            g.conversation_id.clone(),
        )
    };
    if !holds_lease {
        return Err(ProjectError::code("LEASE_REQUIRED").into());
    }
    let svc = ExecutionObligationService::new(data_home, coordination, supervisor);
    match capability {
        "local.delegation.inspect_execution_obligation" => {
            let sids: Vec<String> = args["sessionIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let oids: Vec<String> = args["obligationIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            svc.inspect_async(&workspace_id, Some(&conversation_id), &sids, &oids)
                .await
                .map_err(Into::into)
        }
        "local.delegation.request_obligation_authorization" => {
            let items = args["items"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            svc.request_authorization(&workspace_id, &conversation_id, items)
                .await
                .map_err(Into::into)
        }
        "local.delegation.resolve_execution_obligation" => {
            let grant_id = args["grantId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let idempotency_key = args["idempotencyKey"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let items = args["items"]
                .as_array()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            svc.resolve(
                &workspace_id,
                &conversation_id,
                grant_id,
                idempotency_key,
                items,
                tool_call_id,
            )
            .await
            .map_err(Into::into)
        }
        _ => Err(ProjectError::code("tool_not_projected").into()),
    }
}
