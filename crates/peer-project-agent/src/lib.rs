#![forbid(unsafe_code)]

//! Native Project Agent runtime (ADR 80–88, 91–103, 117, 129–131).
//!
//! Owns project identity, bot profiles, durable input queues, inbox event streams,
//! input drafts, project memory, objectives/watches, execution scheduling,
//! delegated session supervision, verification/acceptance, and the single-threaded
//! ProjectAgentRunner actor. Never depends on terminal UI crates.

pub mod acceptance;
pub mod attachments;
pub mod cards;
pub mod circuit_breaker;
pub mod coordination_bridge;
pub mod coordination_recovery;
pub mod digest;
pub mod directory;
pub mod drafts;
pub mod host;
pub mod inbox;
pub mod inherited_background;
pub mod input_queue;
pub mod interactive_provider;
pub mod interactive_results;
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
pub mod search_index;
pub mod session_projection;
pub mod skill_packs;
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
    is_handoff_conflict, verdict_ref_for,
};
pub use attachments::{
    INPUT_ATTACHMENT_LIMIT, MAX_IMAGE_ATTACHMENT_BYTES, MAX_TEXT_ATTACHMENT_BYTES,
    attachments_from_messages, load_local_image_attachment, materialize_image_attachments,
    normalize_input_attachments, normalize_user_upload, project_user_message_for_model,
};
pub use cards::{
    CardResolution, ConfirmCardInput, TaskQuestionDraft, append_card_resolution,
    latest_task_question, project_cards, project_waiting_user_question_cards,
    project_workspace_cards, read_card_resolutions,
};
pub use circuit_breaker::{
    CIRCUIT_COOLDOWN_MS, CIRCUIT_FAILURE_LIMIT, CircuitAdmit, CircuitBreaker, CircuitBreakerState,
    CircuitBreakerStore, FailureOutcome,
};
pub use coordination_bridge::{
    CommitAgentMessageRequest, CoordinationHub, coordination_work_id, sha256_hex, sha256_json,
};
pub use coordination_recovery::{
    execute_recovery_restore, execute_recovery_retain, inspect_coordination_fork, inspect_recovery,
    needs_recovery_attention, occupied_recovery_view,
};
pub use digest::{DigestItem, DigestQueue, DueDigest, digest_separator};
pub use directory::{
    AttentionItem, AttentionKind, BotDetail, BotDirectory, BotListFilter, BotListItem,
    BotListMessage, BotListSession, BotRowProjection, BotRowState, FamiliarizeOffer,
    InteractionPage, MarkReadResult, QuestionState, ReadConversationOptions, ReplyQuestionStatus,
    default_familiarize_offer, filter_bot_list, is_visible_bot_message, project_bot_attention,
    project_bot_attention_with_cards, project_bot_list_item, project_bot_list_message,
    project_reply_questions, sort_bot_list,
};
pub use drafts::{
    DraftAttachment, DraftBody, DraftEnvelope, DraftQuote, DraftSnapshot, DraftTaskRef,
    DraftWriteRequest, HydratedDraftBody, HydratedDraftEnvelope, HydratedDraftSnapshot,
    InputDraftStore,
};
pub use host::{
    FAMILIARIZE_READ_CAPABILITIES, FamiliarizeKind, ForegroundTickReport, HostTickReport,
    LeaseStatus, MaintenanceReport, NativeProjectHost, RESPONSIBILITY_QUESTION,
    StartFamiliarizeResult, bot_list_json,
};
pub use inbox::{InboxBatch, InboxCursor, InboxDiagnosticSnapshot, ProjectInbox};
pub use inherited_background::{CapturedBackground, capture_inherited_background};
pub use input_queue::{
    ConsumeOutcome, InputDiagnosticSnapshot, InputQueue, ProjectInput, SubmitInputRequest,
    input_message_id,
};
pub use interactive_provider::{
    INTERACTIVE_READ_RULES, WorkSessionInteractiveContext, WorkSessionInteractiveProvider,
    interactive_context_extension,
};
pub use interactive_results::{
    INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL, INTERACTIVE_RESULTS_PER_BOT,
    INTERACTIVE_STORE_BYTES, INTERACTIVE_TOMBSTONE_LIMIT, InteractiveContentBridge,
    InteractiveResultStore, InteractiveValidationError, PublishInteractiveRequest,
    ValidatedPublicationRequest, build_cleanup_expected_digest,
    is_interactive_results_enabled_in_settings, task_result_references,
};
pub use memory::{
    AdmissionContext, AdmissionDecision, CURATOR_EXCLUDED_CAPABILITY_PREFIXES, CURATOR_INTERVAL_MS,
    CuratorCandidate, CuratorClock, CuratorOutcome, EpisodeLog, FrozenMemoryItem,
    MaintenanceOutcome, MemoryCandidateRecord, MemoryConflictDecision, MemoryCurator,
    MemoryEpisode, MemoryFileAnchor, MemoryFilter, MemoryHit, MemoryIndex, MemoryItem,
    MemoryMaintenance, MemorySnapshot, MemoryStore, USER_INPUTS_PER_RUN, WriteCuratedMemoryRequest,
    WriteMemoryRequest, capture_file_anchors, create_snapshot, curator_prompt,
    decide_memory_admission, fingerprint_material, is_effective_memory, is_task_end_event,
    memory_conflict_decision, memory_secret_reason, parse_curator_output, read_file_anchor,
    read_snapshots, validate_curator_candidate,
};
pub use objectives::{
    AppendObservationRequest, CreateObjectiveRequest, ObjectiveActionItem, ObjectiveActions,
    ObjectiveBudget, ObjectiveCommandPatch, ObjectiveItem, ObjectiveMilestone, ObjectiveStore,
    ProbeOutcome, UpdateObjectiveRequest, WatchCursorState, WatchHost, WatchObservation,
    WatchReconcileReport, objective_action_card_id,
};
pub use obligation::{
    ExecutionObligationService, OBLIGATION_FORMAT_VERSION, OBLIGATION_GRANT_TTL_MS,
    ObligationClassification, canonical_grant_key, classify_execution_obligation,
    host_resource_plan_from_plan, inspect_unknown_outcome_advisory,
    list_persisted_obligation_grants_enriched, obligation_display_title, obligation_id_for,
    read_coordination_read_model_buckets, read_coordination_snapshot_readonly,
    read_persisted_obligation_grants, reconcile_unknown_outcome, select_pending_grants,
};
pub use profile::{
    BOT_AVATAR_COLORS, BOT_AVATAR_SHAPES, BOT_COMMUNICATION_STYLES,
    BOT_PROFILE_COMMUNICATION_STYLES, BotAvatar, BotCapabilityPolicy, BotProfile, BotProfileStore,
    CreateBotProfile, clean_display_name, generate_avatar,
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
    hydrate_agent_turn_record, read_retry_continuity,
};
pub use scheduler::{
    ExecutionScheduler, QueueEntry, QueuedBehind, ScheduleDecision, SelectionOutcome, SlotKind,
    normalize_concurrency, slot_of,
};
pub use search_index::{
    ConversationSearchDocument, ConversationSearchHit, ConversationSearchIndex,
    collect_conversation_search_documents,
};
pub use session_projection::{
    FollowUpProjection, LifecycleDecision, ListSessionsQuery, PagedSessions, build_session_report,
    build_verification_detail, decide_lifecycle, get_session_projected, list_sessions_paged,
    list_sessions_projected, project_completion_review_for_plan, session_observation_revision,
    supervision_recovery, verification_content_hash,
};
pub use skill_packs::{
    ACTIVATE_SKILL_PACK_CAPABILITY, ACTIVATE_SKILL_PACK_TOOL, CORE_CAPABILITIES, SKILL_PACKS,
    SkillPackSpec, ToolProjectionMode, TurnProjectionSignals, all_skill_pack_ids,
    auto_activated_packs, build_allowlist, find_skill_pack, ordered_definitions,
    render_unactivated_pack_catalog,
};
pub use supervisor::{
    DEFAULT_WORKER_MAX_TURNS, SessionSupervisor, SpawnCriterion, SpawnSessionRequest,
    WorkSessionReport, WorkSessionSummary,
};
pub use system_context::{ProjectAgentContextInput, assemble_project_agent_context};
pub use verifier::{
    READ_ONLY_CAPABILITY_CEILING, VerifierIssue, VerifierOutcome, VerifierReport,
    WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES, WORKER_CAPABILITY_CEILING, WorkSessionProfile,
    decode_verifier_report, extend_worker_allowlist_with_bot_capabilities, model_family,
    render_bot_mounted_capabilities_summary, resolve_work_session_profile,
    run_independent_verifier,
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

/// Host timestamp offset from `OffsetDateTime::now_utc()` by `offset_ms` milliseconds.
pub fn now_iso_offset_ms(offset_ms: i64) -> String {
    let target = OffsetDateTime::now_utc() + time::Duration::milliseconds(offset_ms);
    format_iso(target).unwrap_or_else(now_iso)
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

/// Normalize ISO timestamp matching `diagnostics.mjs#iso` (`^\d{4}-\d{2}-\d{2}T` + RFC3339).
pub fn normalize_diagnostic_iso(value: &str) -> Option<String> {
    let bytes = value.as_bytes();
    if bytes.len() < 11
        || !bytes[..4].iter().all(u8::is_ascii_digit)
        || bytes[4] != b'-'
        || !bytes[5..7].iter().all(u8::is_ascii_digit)
        || bytes[7] != b'-'
        || !bytes[8..10].iter().all(u8::is_ascii_digit)
        || bytes[10] != b'T'
    {
        return None;
    }
    let dt = OffsetDateTime::parse(value, &Rfc3339).ok()?;
    format_iso(dt)
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

/// Slice a `&str` to at most `max_units` UTF-16 code units cleanly along UTF-8 boundaries.
pub fn utf16_slice(raw: &str, max_units: usize) -> &str {
    let mut units = 0;
    let mut end = 0;
    for (pos, ch) in raw.char_indices() {
        let next = units + ch.len_utf16();
        if next > max_units {
            break;
        }
        units = next;
        end = pos + ch.len_utf8();
    }
    &raw[..end]
}

fn compiled_regex(pattern: &str) -> regex::Regex {
    regex::RegexBuilder::new(pattern)
        .size_limit(128 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .expect("fixed regex pattern")
}

/// Redact secrets and truncate preview matching `packages/runtime-node/src/project-agent/output-redaction.mjs`.
pub fn redact_shell_output(raw: &str) -> String {
    use regex::Regex;
    use std::sync::OnceLock;

    const WS: &str = r"\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
    let truncated = utf16_slice(raw, 4_000);
    let mut text = if truncated.len() < raw.len() {
        format!("{truncated}\n...[preview truncated]")
    } else {
        truncated.to_owned()
    };

    static RE: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    for (re, to) in RE.get_or_init(|| {
        vec![
            (compiled_regex("AKIA[0-9A-Z]{16}"), "[REDACTED_AWS_KEY]"),
            (
                compiled_regex("sk-[A-Za-z0-9_-]{20,}"),
                "[REDACTED_API_KEY]",
            ),
            (
                compiled_regex(&format!(r"((?i-u:Bearer)[{WS}]+)[A-Za-z0-9._-]+")),
                "${1}[REDACTED_TOKEN]",
            ),
            (
                compiled_regex(&format!(
                    r"((?i-u:[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))=)[^{WS}]+"
                )),
                "${1}[REDACTED]",
            ),
        ]
    }) {
        text = re.replace_all(&text, *to).into_owned();
    }
    text
}

/// Filter relative diagnostic watch paths matching `packages/runtime-node/src/project-agent/diagnostics.mjs#relativePaths`.
pub fn is_safe_diagnostic_relative_path(item: &str) -> bool {
    use regex::Regex;
    use std::sync::OnceLock;

    let len_u16 = item.encode_utf16().count();
    if len_u16 == 0 || len_u16 > 500 {
        return false;
    }
    if item.starts_with('/') || item.contains('\\') || item.contains(['\r', '\n', '\0']) {
        return false;
    }
    let bytes = item.as_bytes();
    if bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':' {
        return false;
    }
    if item.split('/').any(|seg| seg == "..") {
        return false;
    }
    static SECRET_HINT: OnceLock<Regex> = OnceLock::new();
    let re = SECRET_HINT.get_or_init(|| {
        compiled_regex(
            r"(?i:\b(?:sk|pk|rk)-[A-Za-z0-9]{8,}|Bearer\s|(?:api[_-]?key|token|secret|password)\s*[=:])",
        )
    });
    !re.is_match(item)
}

/// Stream-read every committed message in a conversation without enforcing the
/// bounded 4–8 MiB snapshot cap used by `read_committed`.
pub(crate) fn read_full_conversation_messages(
    store: &peer_store::ConversationStore,
    conv_id: &str,
) -> Result<Vec<serde_json::Value>, peer_store::StoreError> {
    match store.read_conversation_window(conv_id, None, None, true)? {
        Some(page) => Ok(page["window"].as_array().cloned().unwrap_or_default()),
        None => Err(peer_store::StoreError::NotFound),
    }
}
