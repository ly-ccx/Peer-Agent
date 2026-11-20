#![forbid(unsafe_code)]

//! Native Project Agent runtime (ADR 80–88, 91–103, 117, 129–131).
//!
//! Owns project identity, bot profiles, durable input queues, inbox event streams,
//! input drafts, project memory, objectives/watches, execution scheduling,
//! delegated session supervision, verification/acceptance, and the single-threaded
//! ProjectAgentRunner actor. Never depends on terminal UI crates.

pub mod acceptance;
pub mod circuit_breaker;
pub mod coordination_bridge;
pub mod digest;
pub mod directory;
pub mod drafts;
pub mod host;
pub mod inbox;
pub mod input_queue;
pub mod memory;
pub mod objectives;
pub mod obligation;
pub mod profile;
pub mod provider;
pub mod recovery;
pub mod registry;
pub mod reply;
pub mod runner;
pub mod scheduler;
pub mod supervisor;
pub mod system_context;
pub mod verifier;
pub mod watchdog;
pub mod worktree;

use std::{fmt, fs, io::Write, path::Path};
use tempfile::NamedTempFile;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};

pub use acceptance::{
    AcceptanceDecision, AcceptanceFacts, CHANGED_FILE_CONFIRM_LIMIT, HostAuthorityFacts,
    VerificationCheck, VerificationVerdict, anchor_requests_review, compute_verification_verdict,
    decide_session_acceptance, evaluate_acceptance_close_gate, handoff_question_id,
    verdict_ref_for,
};
pub use circuit_breaker::{
    CIRCUIT_COOLDOWN_MS, CIRCUIT_FAILURE_LIMIT, CircuitAdmit, CircuitBreaker, CircuitBreakerState,
    CircuitBreakerStore, FailureOutcome,
};
pub use coordination_bridge::{
    CommitAgentMessageRequest, CoordinationHub, coordination_work_id, sha256_json,
};
pub use digest::{DigestItem, DigestQueue, DueDigest, digest_separator};
pub use directory::{
    AttentionItem, AttentionKind, BotDirectory, BotListFilter, BotListItem, BotListMessage,
    BotListSession, BotRowState, FamiliarizeOffer, InteractionPage, QuestionState,
    ReplyQuestionStatus, default_familiarize_offer, filter_bot_list, is_visible_bot_message,
    project_bot_attention, project_bot_list_item, project_bot_list_message,
    project_reply_questions, sort_bot_list,
};
pub use drafts::{
    DraftAttachment, DraftBody, DraftEnvelope, DraftQuote, DraftSnapshot, DraftWriteRequest,
    InputDraftStore,
};
pub use host::{
    FAMILIARIZE_READ_CAPABILITIES, FamiliarizeKind, ForegroundTickReport, HostTickReport,
    LeaseStatus, MaintenanceReport, NativeProjectHost, RESPONSIBILITY_QUESTION,
    StartFamiliarizeResult, bot_list_json,
};
pub use inbox::{InboxBatch, InboxCursor, ProjectInbox};
pub use input_queue::{
    ConsumeOutcome, InputQueue, ProjectInput, SubmitInputRequest, input_message_id,
};
pub use memory::{
    AdmissionContext, AdmissionDecision, CURATOR_EXCLUDED_CAPABILITY_PREFIXES, CURATOR_INTERVAL_MS,
    CuratorCandidate, CuratorClock, CuratorOutcome, EpisodeLog, FrozenMemoryItem,
    MaintenanceOutcome, MemoryCandidateRecord, MemoryCurator, MemoryEpisode, MemoryFileAnchor,
    MemoryFilter, MemoryHit, MemoryIndex, MemoryItem, MemoryMaintenance, MemorySnapshot,
    MemoryStore, USER_INPUTS_PER_RUN, WriteCuratedMemoryRequest, WriteMemoryRequest,
    capture_file_anchors, create_snapshot, curator_prompt, decide_memory_admission,
    fingerprint_material, is_effective_memory, is_task_end_event, memory_secret_reason,
    parse_curator_output, read_file_anchor, read_snapshots, validate_curator_candidate,
};
pub use objectives::{
    AppendObservationRequest, CreateObjectiveRequest, ObjectiveActionItem, ObjectiveActions,
    ObjectiveBudget, ObjectiveItem, ObjectiveMilestone, ObjectiveStore, ProbeOutcome,
    UpdateObjectiveRequest, WatchCursorState, WatchHost, WatchObservation, WatchReconcileReport,
    objective_action_card_id,
};
pub use obligation::{
    ExecutionObligationService, OBLIGATION_FORMAT_VERSION, OBLIGATION_GRANT_TTL_MS,
    ObligationClassification, canonical_grant_key, classify_execution_obligation,
    host_resource_plan_from_plan, obligation_id_for, reconcile_unknown_outcome,
};
pub use profile::{
    BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BotAvatar, BotProfile, BotProfileStore, CreateBotProfile,
    clean_display_name, generate_avatar,
};
pub use provider::{ProjectCapabilityProvider, TurnExecutionState};
pub use recovery::{
    ProjectRecoveryBarrier, RECOVERY_PHASES, RecoveryDiagnostic, RecoveryRunCounts,
};
pub use registry::{ProjectRegistry, ProjectRegistryEntry};
pub use reply::{
    ComposeReplyInput, ComposedReply, SessionStatusFact, StatusClaim, Surfacing, SurfacingDecision,
    SurfacingEvent, UserAnchorCandidate, compose_reply, decide_surfacing, normalize_proactivity,
    resolve_user_anchors,
};
pub use runner::{
    AgentTurnOutcome, ProjectAgentActivity, ProjectAgentRunner, RunTurnOptions, TurnEndKind,
    read_retry_continuity,
};
pub use scheduler::{
    ExecutionScheduler, QueueEntry, QueuedBehind, ScheduleDecision, SelectionOutcome, SlotKind,
    normalize_concurrency, slot_of,
};
pub use supervisor::{
    SessionSupervisor, SpawnCriterion, SpawnSessionRequest, WorkSessionReport, WorkSessionSummary,
};
pub use system_context::{ProjectAgentContextInput, assemble_project_agent_context};
pub use verifier::{
    READ_ONLY_CAPABILITY_CEILING, VerifierIssue, VerifierOutcome, VerifierReport,
    WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES, WORKER_CAPABILITY_CEILING, WorkSessionProfile,
    decode_verifier_report, model_family, resolve_work_session_profile, run_independent_verifier,
};
pub use watchdog::{
    FailureDescription, PROGRESS_THROTTLE_MS, SAME_CAUSE_RETRY_LIMIT, STALL_WINDOW_MS,
    SameCauseAssessment, StallAssessment, WatchPublisher, WatchSessionFacts, assess_same_cause,
    assess_stall, delegation_event_id, delegation_facts_for_workspace, describe_failure,
    stable_failure_class, watch_facts_from_plan,
};
pub use worktree::{GoalWorktreeAdapter, HandoffOutcome, WorktreeHandle};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectError {
    pub code: &'static str,
    pub detail: String,
}

impl ProjectError {
    pub fn new(code: &'static str, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
    pub fn code(code: &'static str) -> Self {
        Self {
            code,
            detail: code.to_owned(),
        }
    }
}

impl fmt::Display for ProjectError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        if self.detail == self.code {
            f.write_str(self.code)
        } else {
            write!(f, "{}: {}", self.code, self.detail)
        }
    }
}

impl std::error::Error for ProjectError {}

impl From<peer_store::StoreError> for ProjectError {
    fn from(error: peer_store::StoreError) -> Self {
        Self::code(error.code())
    }
}

impl From<peer_runtime::capability::CapabilityError> for ProjectError {
    fn from(error: peer_runtime::capability::CapabilityError) -> Self {
        Self::code(error.0)
    }
}

/// Matches `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` used across project-agent stores.
pub fn is_valid_workspace_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 128 {
        return false;
    }
    bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

/// Matches `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$` for input IDs.
pub fn is_valid_input_id(value: &str) -> bool {
    is_valid_workspace_id(value)
}

/// Matches RFC 4122 UUIDv4 (case-insensitive) used by `projects/registry.json`.
pub fn is_uuid_v4(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    for (i, &b) in bytes.iter().enumerate() {
        match i {
            8 | 13 | 18 | 23 => {
                if b != b'-' {
                    return false;
                }
            }
            14 => {
                if b != b'4' {
                    return false;
                }
            }
            19 => {
                if !matches!(b, b'8' | b'9' | b'a' | b'b' | b'A' | b'B') {
                    return false;
                }
            }
            _ => {
                if !b.is_ascii_hexdigit() {
                    return false;
                }
            }
        }
    }
    true
}

/// Current host timestamp formatted identically to JS `Date.toISOString()` (millisecond precision).
pub fn now_iso() -> String {
    let now = OffsetDateTime::now_utc();
    format_iso(now).unwrap_or_else(|| "1970-01-01T00:00:00.000Z".into())
}

pub fn format_iso(dt: OffsetDateTime) -> Option<String> {
    let fmt = time::format_description::parse_borrowed::<2>(
        "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
    )
    .ok()?;
    dt.to_offset(time::UtcOffset::UTC).format(&fmt).ok()
}

pub fn parse_iso_ms(value: &str) -> Option<i64> {
    let dt = OffsetDateTime::parse(value.trim(), &Rfc3339).ok()?;
    i64::try_from(dt.unix_timestamp_nanos() / 1_000_000).ok()
}

/// FNV-1a 32-bit over UTF-16 code units, matching JavaScript `charCodeAt` hashing.
pub(crate) fn fnv1a_utf16(text: &str) -> u32 {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in text.encode_utf16() {
        hash ^= u32::from(unit);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    hash
}

/// Atomic file write in target directory with fsync before rename.
pub(crate) fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), ProjectError> {
    let dir = path
        .parent()
        .ok_or_else(|| ProjectError::code("INVALID_PATH"))?;
    fs::create_dir_all(dir)
        .map_err(|e| ProjectError::new("IO_ERROR", format!("mkdir {}: {e}", dir.display())))?;
    let mut temp = NamedTempFile::new_in(dir)
        .map_err(|e| ProjectError::new("IO_ERROR", format!("tempfile {}: {e}", dir.display())))?;
    temp.write_all(bytes)
        .map_err(|e| ProjectError::new("IO_ERROR", format!("write {}: {e}", path.display())))?;
    temp.as_file()
        .sync_all()
        .map_err(|e| ProjectError::new("IO_ERROR", format!("sync {}: {e}", path.display())))?;
    temp.persist(path)
        .map_err(|e| ProjectError::new("IO_ERROR", format!("rename {}: {e}", path.display())))?;
    if let Ok(d) = fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}
