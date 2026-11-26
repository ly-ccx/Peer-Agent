//! Delegated work-session supervisor: spawns canonical `GoalPlan`s + child conversations,
//! schedules slots/worktrees, drives worker episodes via `NativeSessionHost`, evaluates
//! host Evidence verdicts & policy/user acceptance, and emits canonical inbox events.
//!
//! Matches `packages/runtime-node/src/project-agent/session-supervisor.mjs` (ADR 80, 85, 88, 91, 103, 116).

use crate::{
    BotListSession, BotProfileStore, INTERACTIVE_INSPECT_CAPABILITY, INTERACTIVE_INSPECT_TOOL,
    InteractiveContentBridge, ObjectiveStore, ProjectError, ProjectInbox,
    WorkSessionInteractiveContext, WorkSessionInteractiveProvider,
    acceptance::{
        AcceptanceDecision, AcceptanceFacts, HostAuthorityFacts, compute_verification_verdict,
        decide_session_acceptance,
    },
    atomic_write, interactive_context_extension, is_interactive_results_enabled_in_settings,
    memory::create_snapshot,
    now_iso,
    scheduler::{ExecutionScheduler, SelectionOutcome},
    sha256_json,
    verifier::{
        WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES, delegated_access,
        resolve_work_session_profile_with_interactive,
    },
    worktree::{GoalWorktreeAdapter, HandoffOutcome, WorktreeHandle},
};
use peer_protocol::{
    HostSurface,
    interactive_result::{
        INTERACTIVE_PUBLISH_CAPABILITY, INTERACTIVE_PUBLISH_TOOL, InteractiveOwner,
    },
};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationOptions, NativeConversationRuntime},
    model::NativeModel,
    native_exec::{execute_plan, recover_plan},
    providers::{CapabilityProvider, RuntimeMode},
    session_host::{EpisodeOutcome, PermissionInput},
};
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, DirectoryLock,
    EvidenceIndexStore, HostApproval, HostToolEvidence, NewConversation, NewProjectConversation,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::{Duration, SystemTime},
};

mod approval_recovery;
pub(crate) mod autonomy;
mod followup;
pub use followup::{MessageSessionOutcome, MessageSessionRequest};
mod verification;

const LOCK_TIMEOUT: Duration = Duration::from_secs(5);
const DELEGATION_MARKER: &[u8] = b"\"delegationOrigin\"";
const LARGE_PLAN_THRESHOLD: u64 = 256 * 1024;
const LARGE_PLAN_HEAD_BYTES: usize = 32 * 1024;
const LARGE_PLAN_TAIL_BYTES: usize = 128 * 1024;

type FileStamp = (u64, Option<SystemTime>);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanIndexMetaRow {
    plan_id: Option<String>,
    conversation_id: Option<String>,
    title: Option<String>,
    status: Option<String>,
    updated_at: Option<String>,
    result_accepted_at: Option<String>,
    result_accepted_by: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PhaseSummary {
    phase: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DelegationOriginSummary {
    workspace_id: Option<String>,
    session_id: Option<String>,
    worker_conversation_id: Option<String>,
    phase: Option<String>,
    read_only: Option<bool>,
    priority: Option<String>,
    plan_approval_id: Option<String>,
    superseded_by: Option<String>,
    anchor_message_id: Option<String>,
    anchor_message_ids: Option<Vec<String>>,
    agent_wait_message_id: Option<String>,
    cancellation: Option<PhaseSummary>,
    takeover: Option<PhaseSummary>,
    follow_up_epoch: Option<u64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RunnerSummary {
    status: Option<String>,
    blocked_reason: Option<String>,
    waiting_on_user: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AcceptanceSummary {
    accepted_at: Option<String>,
    accepted_by: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryBindingSummary {
    worktree_path: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeliveryHandoffSummary {
    status: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PlanSummaryDoc {
    plan_id: Option<String>,
    conversation_id: Option<String>,
    title: Option<String>,
    status: Option<String>,
    updated_at: Option<String>,
    delegation_origin: Option<DelegationOriginSummary>,
    runner: Option<RunnerSummary>,
    result_acceptance: Option<AcceptanceSummary>,
    delivery_binding: Option<DeliveryBindingSummary>,
    delivery_handoff: Option<DeliveryHandoffSummary>,
}

#[derive(Debug, Default)]
struct PlanIndexCache {
    index_stamp: Option<FileStamp>,
    index_rows: Vec<PlanIndexMetaRow>,
    /// Maps `plan_id -> (stamp, Some(summary) | None for non-delegated plans)`.
    entries: HashMap<String, (FileStamp, Option<WorkSessionSummary>)>,
}

fn file_stamp(path: &Path) -> Option<FileStamp> {
    let meta = fs::metadata(path).ok()?;
    Some((meta.len(), meta.modified().ok()))
}

fn find_bytes(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    if needle.is_empty() {
        return Some(0);
    }
    let n = needle.len();
    if haystack.len() < n {
        return None;
    }
    if n == 1 {
        return haystack.iter().position(|&b| b == needle[0]);
    }
    let mut skip = [n; 256];
    for (idx, &b) in needle[..n - 1].iter().enumerate() {
        skip[usize::from(b)] = n - 1 - idx;
    }
    let last = needle[n - 1];
    let mut i = 0usize;
    let limit = haystack.len() - n;
    while i <= limit {
        let cur_last = haystack[i + n - 1];
        if cur_last == last && haystack[i..i + n - 1] == needle[..n - 1] {
            return Some(i);
        }
        i += skip[usize::from(cur_last)];
    }
    None
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    find_bytes(haystack, needle).is_some()
}

fn extract_top_level_field<T: for<'de> Deserialize<'de>>(buf: &[u8], key: &str) -> Option<T> {
    let pattern = format!("\n  \"{key}\":");
    let pos = find_bytes(buf, pattern.as_bytes())?;
    let val_slice = &buf[pos + pattern.len()..];
    serde_json::Deserializer::from_slice(val_slice)
        .into_iter::<T>()
        .next()?
        .ok()
}

#[allow(clippy::too_many_arguments)]
fn derive_status_fields(
    plan_status: &str,
    accepted: bool,
    superseded: bool,
    phase: Option<&str>,
    agent_wait_msg: bool,
    cancel_phase: Option<&str>,
    takeover_phase: Option<&str>,
    runner_status: Option<&str>,
    runner_blocked_reason: Option<&str>,
    runner_waiting_on_user: bool,
) -> String {
    if plan_status == "cancelled" || cancel_phase == Some("completed") {
        return "cancelled".to_owned();
    }
    if plan_status == "failed" {
        return "failed".to_owned();
    }
    if accepted {
        return "accepted".to_owned();
    }
    if cancel_phase == Some("awaiting_outcome") || takeover_phase == Some("awaiting_outcome") {
        return "awaiting_outcome".to_owned();
    }
    if cancel_phase == Some("stopping") {
        return "stopping".to_owned();
    }
    if takeover_phase == Some("stopping") {
        return "starting".to_owned();
    }
    if superseded && plan_status != "completed" {
        return "superseded".to_owned();
    }
    if (phase == Some("paused") || runner_status == Some("paused")) && plan_status != "completed" {
        return "paused".to_owned();
    }
    let needs_user = phase == Some("awaiting_approval")
        || plan_status == "awaiting_approval"
        || (runner_waiting_on_user && runner_status != Some("paused") && !superseded)
        || (runner_status == Some("blocked")
            && runner_blocked_reason == Some("manual_dod_confirmation_required"));
    if needs_user || runner_status == Some("waiting_user") {
        return "waiting_user".to_owned();
    }
    if runner_status == Some("budget_exhausted") {
        return "waiting_user".to_owned();
    }
    if (runner_blocked_reason == Some("waiting_parent_agent")
        || (agent_wait_msg && runner_status != Some("waiting_user")))
        && phase != Some("paused")
        && !superseded
        && runner_status != Some("paused")
    {
        return "waiting_agent".to_owned();
    }
    if phase == Some("verifying") {
        return "verifying".to_owned();
    }
    if runner_status == Some("blocked") {
        return "waiting_agent".to_owned();
    }
    if plan_status == "completed" {
        if matches!(
            runner_status,
            Some("running" | "resuming" | "compacting" | "exploring")
        ) {
            return "running".to_owned();
        }
        return "result_ready".to_owned();
    }
    if phase == Some("starting") {
        return "starting".to_owned();
    }
    if phase == Some("queued")
        || matches!(
            plan_status,
            "approved" | "accepted" | "paused" | "interrupted"
        )
    {
        return "queued".to_owned();
    }
    "running".to_owned()
}

fn derive_doc_status(doc: &PlanSummaryDoc, origin: &DelegationOriginSummary) -> String {
    let superseded = origin
        .superseded_by
        .as_deref()
        .is_some_and(|s| !s.is_empty());
    let accepted = doc
        .result_acceptance
        .as_ref()
        .and_then(|a| a.accepted_at.as_deref())
        .is_some();
    let runner = doc.runner.as_ref();
    derive_status_fields(
        doc.status.as_deref().unwrap_or(""),
        accepted,
        superseded,
        origin.phase.as_deref(),
        origin
            .agent_wait_message_id
            .as_deref()
            .is_some_and(|s| !s.is_empty()),
        origin
            .cancellation
            .as_ref()
            .and_then(|c| c.phase.as_deref()),
        origin.takeover.as_ref().and_then(|t| t.phase.as_deref()),
        runner.and_then(|r| r.status.as_deref()),
        runner.and_then(|r| r.blocked_reason.as_deref()),
        runner.and_then(|r| r.waiting_on_user) == Some(true),
    )
}

fn normalize_summary_phase(status: &str, raw_phase: Option<&str>) -> String {
    if matches!(status, "accepted" | "failed" | "cancelled" | "superseded")
        && matches!(
            raw_phase,
            None | Some("queued" | "starting" | "running" | "verifying")
        )
    {
        return status.to_owned();
    }
    raw_phase.unwrap_or("queued").to_owned()
}

fn summarize_doc(doc: &PlanSummaryDoc) -> Option<WorkSessionSummary> {
    let origin = doc.delegation_origin.as_ref()?;
    let workspace_id = origin
        .workspace_id
        .as_deref()
        .filter(|s| !s.is_empty())?
        .to_owned();
    let plan_conversation_id = doc.conversation_id.clone().unwrap_or_default();
    let session_id = origin
        .session_id
        .clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| plan_conversation_id.clone());
    let conversation_id = origin
        .worker_conversation_id
        .as_deref()
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .unwrap_or(plan_conversation_id);
    let acceptance = doc.result_acceptance.as_ref();
    let anchor_message_ids = origin
        .anchor_message_ids
        .as_ref()
        .filter(|a| !a.is_empty())
        .cloned()
        .unwrap_or_else(|| {
            origin
                .anchor_message_id
                .as_deref()
                .filter(|s| !s.is_empty())
                .map(|s| vec![s.to_owned()])
                .unwrap_or_default()
        });
    let status = derive_doc_status(doc, origin);
    let phase = normalize_summary_phase(&status, origin.phase.as_deref());
    Some(WorkSessionSummary {
        session_id,
        workspace_id,
        conversation_id,
        plan_id: doc.plan_id.clone().unwrap_or_default(),
        title: doc.title.clone().unwrap_or_default(),
        status,
        phase,
        read_only: origin.read_only == Some(true),
        priority: origin
            .priority
            .clone()
            .unwrap_or_else(|| "normal".to_owned()),
        updated_at: doc.updated_at.clone().unwrap_or_default(),
        accepted: acceptance.and_then(|a| a.accepted_at.as_deref()).is_some(),
        accepted_by: acceptance.and_then(|a| a.accepted_by.clone()),
        worktree_path: doc
            .delivery_binding
            .as_ref()
            .and_then(|d| d.worktree_path.clone()),
        approval_id: origin.plan_approval_id.clone(),
        handoff_status: doc.delivery_handoff.as_ref().and_then(|h| h.status.clone()),
        anchor_message_ids,
        follow_up_epoch: origin.follow_up_epoch,
    })
}

fn read_exact_or_eof(file: &mut File, buf: &mut Vec<u8>, limit: usize) -> io::Result<()> {
    buf.clear();
    file.take(limit as u64).read_to_end(buf)?;
    Ok(())
}

fn extract_large_plan_summary(
    file: &mut File,
    file_len: u64,
    pid: &str,
    index_row: &PlanIndexMetaRow,
) -> Option<WorkSessionSummary> {
    let mut head = Vec::with_capacity(LARGE_PLAN_HEAD_BYTES.min(file_len as usize));
    file.seek(SeekFrom::Start(0)).ok()?;
    read_exact_or_eof(file, &mut head, LARGE_PLAN_HEAD_BYTES).ok()?;

    // Confirm 2-space pretty-printed root layout before skipping the middle trace body.
    if extract_top_level_field::<String>(&head, "planId").as_deref() != Some(pid) {
        return None;
    }

    let tail_len = (LARGE_PLAN_TAIL_BYTES as u64).min(file_len);
    let mut tail = Vec::with_capacity(tail_len as usize);
    file.seek(SeekFrom::Start(file_len.saturating_sub(tail_len)))
        .ok()?;
    read_exact_or_eof(file, &mut tail, tail_len as usize).ok()?;

    // If `delegationOrigin` sits outside both head and tail windows, return `None` to trigger full-file fallback.
    let origin: DelegationOriginSummary = extract_top_level_field(&tail, "delegationOrigin")
        .or_else(|| extract_top_level_field(&head, "delegationOrigin"))?;

    let runner = extract_top_level_field::<RunnerSummary>(&tail, "runner")
        .or_else(|| extract_top_level_field::<RunnerSummary>(&head, "runner"));
    let result_acceptance = extract_top_level_field::<AcceptanceSummary>(&tail, "resultAcceptance")
        .or_else(|| extract_top_level_field::<AcceptanceSummary>(&head, "resultAcceptance"))
        .or_else(|| {
            (index_row.result_accepted_at.is_some() || index_row.result_accepted_by.is_some()).then(
                || AcceptanceSummary {
                    accepted_at: index_row.result_accepted_at.clone(),
                    accepted_by: index_row.result_accepted_by.clone(),
                },
            )
        });
    let delivery_binding =
        extract_top_level_field::<DeliveryBindingSummary>(&head, "deliveryBinding").or_else(|| {
            extract_top_level_field::<DeliveryBindingSummary>(&tail, "deliveryBinding")
        });
    let delivery_handoff =
        extract_top_level_field::<DeliveryHandoffSummary>(&tail, "deliveryHandoff").or_else(|| {
            extract_top_level_field::<DeliveryHandoffSummary>(&head, "deliveryHandoff")
        });

    let doc = PlanSummaryDoc {
        plan_id: Some(pid.to_owned()),
        conversation_id: extract_top_level_field::<String>(&head, "conversationId")
            .or_else(|| extract_top_level_field::<String>(&tail, "conversationId"))
            .or_else(|| index_row.conversation_id.clone()),
        title: extract_top_level_field::<String>(&head, "title")
            .or_else(|| extract_top_level_field::<String>(&tail, "title"))
            .or_else(|| index_row.title.clone()),
        status: extract_top_level_field::<String>(&head, "status")
            .or_else(|| extract_top_level_field::<String>(&tail, "status"))
            .or_else(|| index_row.status.clone()),
        updated_at: extract_top_level_field::<String>(&tail, "updatedAt")
            .or_else(|| extract_top_level_field::<String>(&head, "updatedAt"))
            .or_else(|| index_row.updated_at.clone()),
        delegation_origin: Some(origin),
        runner,
        result_acceptance,
        delivery_binding,
        delivery_handoff,
    };
    summarize_doc(&doc)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnCriterion {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    pub kind: String,
    #[serde(default)]
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expect: Option<String>,
}

#[derive(Debug, Clone)]
pub struct SpawnSessionRequest {
    pub workspace_id: String,
    pub workspace_path: PathBuf,
    pub parent_conversation_id: String,
    pub anchor_message_ids: Vec<String>,
    pub input_id: String,
    pub surface: String,
    pub title: String,
    pub brief: String,
    pub kind: String,
    pub read_only: bool,
    pub required_capabilities: Vec<String>,
    pub success_criteria: Vec<SpawnCriterion>,
    pub priority: String,
    pub depends_on: Vec<String>,
    pub supersedes: Option<String>,
    pub objective_id: Option<String>,
    pub isolation: String,
    pub worker_model_selection: Value,
}

/// Default per-episode turn budget for delegated worker sessions.
/// Sized to comfortably cover real multi-file inspection, editing, build/typecheck,
/// and final reporting without tripping premature `agent_loop_exhausted` failures.
pub const DEFAULT_WORKER_MAX_TURNS: usize = 64;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionSummary {
    pub session_id: String,
    pub workspace_id: String,
    pub conversation_id: String,
    pub plan_id: String,
    pub title: String,
    pub status: String,
    pub phase: String,
    pub read_only: bool,
    pub priority: String,
    pub updated_at: String,
    pub accepted: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_by: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub worktree_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff_status: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub anchor_message_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub follow_up_epoch: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkSessionReport {
    pub summary: WorkSessionSummary,
    pub task_brief: String,
    pub evidence_refs: Vec<String>,
    pub changed_files: Vec<String>,
    pub verdict_outcome: String,
    pub independent_verifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_agent_question: Option<String>,
    pub worker_output: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_code: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_detail: Option<String>,
}

pub struct SessionSupervisor {
    data_home: PathBuf,
    surface: HostSurface,
    goal_plans_dir: PathBuf,
    conversations: ConversationStore,
    approvals: ApprovalStore,
    profiles: BotProfileStore,
    inbox: ProjectInbox,
    scheduler: ExecutionScheduler,
    worktrees: GoalWorktreeAdapter,
    plan_cache: Mutex<PlanIndexCache>,
    transitions: Mutex<()>,
    verifying_sessions: Mutex<HashMap<String, verification::ActiveVerification>>,
    interactive_bridge: RwLock<Option<Arc<dyn InteractiveContentBridge>>>,
    interactive_enabled_override: RwLock<Option<bool>>,
}

fn resolve_confined_criterion_path(
    ws_root: &Path,
    canon_root: &Path,
    rel_path: &str,
) -> Option<PathBuf> {
    if rel_path.is_empty() {
        return None;
    }
    let direct = ws_root.join(rel_path);
    if let Ok(canon) = fs::canonicalize(&direct)
        && canon.starts_with(canon_root)
    {
        return Some(canon);
    }
    // Multi-repo workspace fallback: when the bound workspace contains child repo folders
    // (e.g. `peer-dev/Peer-Agent/...`), resolve an unambiguous unique child match confined
    // strictly inside `canon_root`.
    if Path::new(rel_path).is_absolute() {
        return None;
    }
    let mut matches = Vec::new();
    let entries = fs::read_dir(ws_root).ok()?;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if name.to_string_lossy().starts_with('.') {
            continue;
        }
        let child = entry.path();
        if !child.is_dir() {
            continue;
        }
        if let Ok(canon) = fs::canonicalize(child.join(rel_path))
            && canon.starts_with(canon_root)
        {
            matches.push(canon);
            if matches.len() > 1 {
                return None;
            }
        }
    }
    matches.into_iter().next()
}

fn normalize_model_selection_slot(raw: &Value) -> Value {
    let model_id = raw["modelId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("default");
    let provider_id = raw["providerId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .or_else(|| {
            raw["modelProviderId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .unwrap_or("native");
    let model_provider_id = raw["modelProviderId"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(provider_id);
    let family = raw["family"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if model_id.contains("claude") {
                "anthropic"
            } else if model_id.contains("gemini") {
                "google"
            } else {
                "openai"
            }
        });
    let mut slot = json!({
        "providerId": provider_id,
        "modelId": model_id,
        "modelProviderId": model_provider_id,
        "family": family,
    });
    if let Some(effort) = raw["reasoningEffort"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        slot["reasoningEffort"] = json!(effort);
    }
    if let Some(fast) = raw["fastMode"].as_bool() {
        slot["fastMode"] = json!(fast);
    }
    slot
}

fn canonical_model_selection_snapshot(worker_raw: &Value, resolved_at: &str) -> Value {
    let worker = normalize_model_selection_slot(worker_raw);
    let mut verifier = worker.clone();
    verifier["sameFamilyAsWorker"] = json!(true);
    json!({
        "worker": worker,
        "explorer": worker,
        "verifier": verifier,
        "source": {
            "worker": "auto",
            "explorer": "auto",
            "verifier": "auto",
        },
        "resolvedAt": resolved_at,
    })
}

fn plan_approval_required(policy: &str, read_only: bool) -> bool {
    match policy {
        "always" => true,
        "writes" => !read_only,
        _ => false,
    }
}

fn derive_session_status(plan: &Value) -> String {
    let origin = &plan["delegationOrigin"];
    let runner = &plan["runner"];
    let superseded = origin["supersededBy"]
        .as_str()
        .is_some_and(|s| !s.is_empty());
    let accepted = plan["resultAcceptance"]["acceptedAt"].as_str().is_some();
    derive_status_fields(
        plan["status"].as_str().unwrap_or(""),
        accepted,
        superseded,
        origin["phase"].as_str(),
        origin["agentWaitMessageId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        origin["cancellation"]["phase"].as_str(),
        origin["takeover"]["phase"].as_str(),
        runner["status"].as_str(),
        runner["blockedReason"].as_str(),
        runner["waitingOnUser"].as_bool() == Some(true),
    )
}

fn is_manual_criterion_approved(plan: &Value, criterion_id: &str) -> bool {
    let confirmations = plan["manualConfirmations"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    crate::acceptance::is_manual_criterion_confirmed(confirmations, criterion_id)
}

fn close_gate_passed_for_list(plan: &Value, known_refs: &HashSet<String>) -> bool {
    let Some(criteria) = plan["successCriteria"].as_array() else {
        return true;
    };
    if criteria.is_empty() {
        return true;
    }
    let results = plan["criterionResults"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let reviews = plan["modelReviews"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let source_rev = plan["modelReviewSourceRevision"].as_str().unwrap_or("");
    let verifier_runs = plan["runner"]["verifierRuns"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);

    let advisory_review = crate::acceptance::independent_review_not_required(plan);
    for criterion in criteria {
        let Some(cid) = criterion["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        let kind = criterion["kind"].as_str().unwrap_or("");
        if kind == "model_review" {
            let review_ok = reviews
                .iter()
                .rev()
                .find(|r| r["criterionId"].as_str() == Some(cid))
                .is_some_and(|review| {
                    let evs: Vec<&str> = review["evidenceRefs"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(Value::as_str)
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .collect();
                    let evs_valid = !evs.is_empty() && evs.iter().all(|r| known_refs.contains(*r));
                    if review["passed"] != true || !evs_valid {
                        return false;
                    }
                    if !source_rev.is_empty() {
                        let run_id = review["verifierRunId"].as_str().unwrap_or("");
                        review["sourceRevision"].as_str() == Some(source_rev)
                            && verifier_runs.iter().any(|run| {
                                run["verifierRunId"].as_str() == Some(run_id)
                                    && run["status"].as_str() == Some("passed")
                            })
                    } else {
                        plan["delegationOrigin"]["independentVerifier"].as_str() == Some("passed")
                    }
                });
            if !review_ok
                && !advisory_review
                && !crate::acceptance::criterion_verified_by_independent_report(
                    plan, cid, known_refs,
                )
            {
                return false;
            }
            continue;
        }
        if kind == "manual" {
            // Pending manual criteria ARE the human confirmation gate; blocking human_gate
            // on unapproved manual criteria creates a Catch-22 where the user is never prompted.
            continue;
        }
        let is_auto = matches!(kind, "command" | "test" | "file-contains" | "file-exists");
        if !is_auto && is_manual_criterion_approved(plan, cid) {
            continue;
        }
        let result_ok = results
            .iter()
            .find(|r| r["criterionId"].as_str() == Some(cid))
            .is_some_and(|result| {
                if result["passed"] != true {
                    return false;
                }
                let single_ok = result["evidenceRef"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .is_some_and(|r| known_refs.contains(r));
                let multi_ok = result["evidenceRefs"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .any(|r| known_refs.contains(r));
                single_ok || multi_ok
            });
        if result_ok {
            continue;
        }
        if matches!(kind, "command" | "test") {
            let explicitly_failed = results
                .iter()
                .any(|r| r["criterionId"].as_str() == Some(cid) && r["passed"] == false);
            if (advisory_review && !explicitly_failed)
                || crate::acceptance::criterion_verified_by_independent_report(
                    plan, cid, known_refs,
                )
            {
                continue;
            }
        }
        return false;
    }
    true
}

pub(crate) fn completed_leaf_results(tasks: &[Value], out: &mut Vec<String>) {
    for task in tasks {
        if let Some(sub) = task["subtasks"].as_array().filter(|a| !a.is_empty()) {
            completed_leaf_results(sub, out);
        } else if task["status"].as_str() == Some("completed")
            && let Some(res) = task["result"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            out.push(res.to_owned());
        }
    }
}

pub(crate) fn visible_worker_result(message: &Value) -> String {
    if let Some(segments) = message["segments"].as_array() {
        for seg in segments.iter().rev() {
            if seg["type"].as_str() == Some("text")
                && let Some(content) = seg["content"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
            {
                return content.to_owned();
            }
        }
        if !segments.is_empty() {
            return String::new();
        }
    }
    message["content"]
        .as_str()
        .map(str::trim)
        .unwrap_or("")
        .to_owned()
}

fn authorizes_objective_auto_accept(raw: &str) -> bool {
    use regex::Regex;
    use std::sync::OnceLock;
    static STRIP_RE: OnceLock<Regex> = OnceLock::new();
    static DENY_RE: OnceLock<Regex> = OnceLock::new();
    static ALLOW_RE: OnceLock<Regex> = OnceLock::new();

    let strip_re = STRIP_RE.get_or_init(|| {
        Regex::new(r#"(?m)```[\s\S]*?```|`[^`]*`|^[ \t]*>.*$|“[^”]*”|「[^」]*」|"[^"\n]*""#)
            .expect("valid strip regex")
    });
    let clean = strip_re.replace_all(raw, "");
    let deny_re = DENY_RE.get_or_init(|| {
        Regex::new(r"(?i)(?:不要|别|不能|\bnot\b|don['’]?t|cannot|won['’]?t)")
            .expect("valid deny regex")
    });
    if deny_re.is_match(&clean) {
        return false;
    }
    let allow_re = ALLOW_RE.get_or_init(|| {
        Regex::new(r"(?i)(?:允许|同意|可以|开启|启用).{0,12}自动签收|automatically accept|allow.{0,12}auto.{0,5}accept").expect("valid allow regex")
    });
    allow_re.is_match(&clean)
}

impl SessionSupervisor {
    fn objective_acceptance_policy(&self, workspace_id: &str, objective_id: &str) -> &'static str {
        let Ok(Some(item)) = ObjectiveStore::new(&self.data_home).get(workspace_id, objective_id)
        else {
            return "confirm";
        };
        if item.status != "active" || item.auto_accept != Some(true) {
            return "confirm";
        }
        let Some(anchor_id) = item.auto_accept_approved_by.as_deref() else {
            return "confirm";
        };
        let parent_msgs = crate::read_full_conversation_messages(
            &self.conversations,
            &item.project_agent_conversation_id,
        )
        .unwrap_or_default();
        let authorized = parent_msgs.iter().any(|row| {
            row["id"].as_str() == Some(anchor_id)
                && row["role"].as_str() == Some("user")
                && row["kind"].as_str() == Some("user_input")
                && row["content"]
                    .as_str()
                    .is_some_and(authorizes_objective_auto_accept)
        });
        if authorized { "auto" } else { "confirm" }
    }

    /// Reads the combined user message text for one or more anchor message IDs
    /// in a parent project-agent conversation.
    pub(crate) fn anchor_text_for_ids(
        &self,
        parent_conv_id: &str,
        anchor_ids: &[String],
    ) -> String {
        if parent_conv_id.is_empty() || anchor_ids.is_empty() {
            return String::new();
        }
        let Ok(msgs) = crate::read_full_conversation_messages(&self.conversations, parent_conv_id)
        else {
            return String::new();
        };
        let wanted: HashSet<&str> = anchor_ids
            .iter()
            .map(|s| s.trim())
            .filter(|s| !s.is_empty())
            .collect();
        msgs.into_iter()
            .filter(|m| m["id"].as_str().is_some_and(|id| wanted.contains(id)))
            .filter_map(|m| m["content"].as_str().map(str::to_owned))
            .collect::<Vec<_>>()
            .join("\n")
    }

    fn resolve_plan_anchor_text(
        &self,
        plan: &Value,
        parent_anchors: Option<&mut HashMap<String, HashMap<String, String>>>,
    ) -> String {
        let origin = &plan["delegationOrigin"];
        let parent_conv_id = origin["parentConversationId"].as_str().unwrap_or("");
        if parent_conv_id.is_empty() {
            return String::new();
        }
        let mut ids: Vec<String> = origin["anchorMessageIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if ids.is_empty()
            && let Some(single) = origin["anchorMessageId"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        {
            ids.push(single.to_owned());
        }
        if ids.is_empty() {
            return String::new();
        }
        if let Some(cache) = parent_anchors {
            let map = cache.entry(parent_conv_id.to_owned()).or_insert_with(|| {
                crate::read_full_conversation_messages(&self.conversations, parent_conv_id)
                    .ok()
                    .map(|msgs| {
                        msgs.into_iter()
                            .filter_map(|m| {
                                Some((
                                    m["id"].as_str()?.to_owned(),
                                    m["content"].as_str()?.to_owned(),
                                ))
                            })
                            .collect()
                    })
                    .unwrap_or_default()
            });
            ids.iter()
                .filter_map(|id| map.get(id).cloned())
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            self.anchor_text_for_ids(parent_conv_id, &ids)
        }
    }

    #[allow(dead_code)]
    pub(crate) fn compute_human_gate(&self, plan: &Value, summary: &WorkSessionSummary) -> bool {
        let mut parent_anchors = HashMap::new();
        self.compute_human_gate_with_cache(plan, summary, &mut parent_anchors)
    }

    pub(crate) fn compute_human_gate_with_cache(
        &self,
        plan: &Value,
        summary: &WorkSessionSummary,
        parent_anchors: &mut HashMap<String, HashMap<String, String>>,
    ) -> bool {
        if plan["status"].as_str() != Some("completed") {
            return false;
        }
        if plan["runner"]["enabled"].as_bool() == Some(true)
            && plan["runner"]["status"].as_str() != Some("completed")
        {
            return false;
        }
        let origin = &plan["delegationOrigin"];
        if origin["phase"].as_str() == Some("verifying")
            || origin["independentVerifier"].as_str() == Some("failed")
            || plan["verificationReport"]["passed"].as_bool() == Some(false)
        {
            return false;
        }
        let evidence = self.indexed_evidence_refs_for_plan(plan);
        if !close_gate_passed_for_list(plan, &evidence) {
            return false;
        }
        let ws_id = summary.workspace_id.as_str();
        let policy = if let Some(oid) = origin["objectiveId"].as_str().filter(|s| !s.is_empty()) {
            self.objective_acceptance_policy(ws_id, oid)
        } else if self
            .profiles
            .read(ws_id)
            .is_some_and(|p| p.acceptance_policy_str() == "confirm")
        {
            "confirm"
        } else {
            "auto"
        };

        let independent_verifier = origin["independentVerifier"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let verification_below_floor = !matches!(
            independent_verifier.as_deref(),
            Some("passed" | "not_required")
        );
        let manual_pending = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| {
                let Some(cid) = c["id"].as_str().map(str::trim).filter(|s| !s.is_empty()) else {
                    return false;
                };
                c["kind"].as_str() == Some("manual") && !is_manual_criterion_approved(plan, cid)
            });

        let anchor_text = self.resolve_plan_anchor_text(plan, Some(parent_anchors));

        let decision = decide_session_acceptance(
            &AcceptanceFacts {
                plan,
                session_id: &summary.session_id,
                evidence_index: &evidence,
                host_authority: HostAuthorityFacts {
                    independent_verifier,
                    verifier_model: origin["verifierModel"].as_str().map(str::to_owned),
                    same_family_as_worker: origin["sameFamilyAsWorker"].as_bool(),
                },
                policy,
                reported: false,
                read_only: summary.read_only,
                changed_files: self.session_changed_files(plan),
                manual_criteria_pending: manual_pending,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text: &anchor_text,
                verification_below_floor,
            },
            false,
        );
        decision.mode == "confirm"
    }

    fn compute_completion_review_required(
        &self,
        plan: &Value,
        summary: &WorkSessionSummary,
    ) -> bool {
        if matches!(
            plan["delegationOrigin"]["phase"].as_str(),
            Some("paused" | "superseded" | "queued" | "awaiting_approval")
        ) || matches!(plan["status"].as_str(), Some("failed" | "cancelled"))
            || plan["runner"]["status"].as_str() != Some("blocked")
            || plan["runner"]["blockedReason"].as_str() != Some("manual_dod_confirmation_required")
        {
            return false;
        }
        let manual_ids: Vec<&str> = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["kind"].as_str() == Some("manual"))
            .filter_map(|c| c["id"].as_str().map(str::trim).filter(|s| !s.is_empty()))
            .collect();
        if manual_ids.is_empty() {
            return false;
        }
        let child_msgs = if !summary.conversation_id.is_empty() {
            crate::read_full_conversation_messages(&self.conversations, &summary.conversation_id)
                .unwrap_or_default()
        } else {
            Vec::new()
        };
        let report_summary = child_msgs
            .iter()
            .rev()
            .find_map(|m| {
                if m["role"].as_str() == Some("assistant") && m["_compaction"].is_null() {
                    let v = visible_worker_result(m);
                    if !v.is_empty() {
                        return Some(v);
                    }
                }
                None
            })
            .unwrap_or_else(|| {
                let mut findings = Vec::new();
                if let Some(tasks) = plan["tasks"].as_array() {
                    completed_leaf_results(tasks, &mut findings);
                }
                findings.join("\n\n")
            });
        if report_summary.trim().is_empty() {
            return false;
        }
        let confirmations = plan["manualConfirmations"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let non_approved: Vec<Value> = confirmations
            .iter()
            .filter(|row| row["decision"].as_str() != Some("approve"))
            .cloned()
            .collect();
        let review_token = sha256_json(&json!([
            plan["planId"],
            plan["successCriteria"],
            plan["criterionResults"],
            plan["tasks"],
            report_summary,
            non_approved,
        ]));
        let expected_conf_id = format!("completion-review:{review_token}");
        let all_criteria_approved = manual_ids.iter().all(|cid| {
            confirmations
                .iter()
                .rev()
                .find(|row| {
                    row["criterionIds"]
                        .as_array()
                        .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(*cid)))
                })
                .and_then(|row| row["decision"].as_str())
                == Some("approve")
        });
        let token_confirmed = confirmations.iter().any(|row| {
            row["confirmationId"].as_str() == Some(expected_conf_id.as_str())
                && row["decision"].as_str() == Some("approve")
        });
        !(all_criteria_approved && token_confirmed)
    }

    pub(crate) fn dependency_queue_reason(
        plan: &Value,
        workspace_id: &str,
        summaries: &[WorkSessionSummary],
    ) -> Option<String> {
        let deps = plan["delegationOrigin"]["dependsOn"].as_array()?;
        let mut by_session: HashMap<&str, &WorkSessionSummary> = HashMap::new();
        for s in summaries {
            if s.workspace_id == workspace_id && !s.session_id.is_empty() {
                by_session.insert(s.session_id.as_str(), s);
            }
        }
        let mut has_failed = false;
        for dep in deps {
            let Some(dep_id) = dep.as_str().filter(|s| !s.is_empty()) else {
                continue;
            };
            let Some(found) = by_session.get(dep_id) else {
                return Some("dependency_missing".to_owned());
            };
            if matches!(found.status.as_str(), "failed" | "cancelled") {
                has_failed = true;
            }
        }
        has_failed.then(|| "dependency_failed".to_owned())
    }

    fn to_bot_list_session(
        &self,
        summary: WorkSessionSummary,
        all_summaries: &[WorkSessionSummary],
        parent_anchors: &mut HashMap<String, HashMap<String, String>>,
        coord_cache: &mut HashMap<String, Option<crate::obligation::CoordinationBuckets>>,
    ) -> BotListSession {
        let mut result_confirmation_required = None;
        let mut completion_review_required = false;
        let mut queue_reason = None;
        let mut follow_up = None;
        let mut phase_label = None;
        let mut resolved_status = summary.status.clone();
        let anchor_message_id = summary.anchor_message_ids.first().cloned();
        let plan_id = (!summary.plan_id.is_empty()).then(|| summary.plan_id.clone());

        let buckets = coord_cache
            .entry(summary.workspace_id.clone())
            .or_insert_with(|| {
                crate::session_projection::load_workspace_session_coordination(
                    &self.data_home,
                    &summary.workspace_id,
                )
            })
            .as_ref();

        if let Ok(plan) = self.read_plan(&summary.plan_id) {
            let (lc, human_gate) = crate::session_projection::compute_bot_list_session_lifecycle(
                self,
                &plan,
                &summary,
                buckets,
                parent_anchors,
            );
            resolved_status = lc.status.clone();
            phase_label = (!lc.status_label.is_empty()).then_some(lc.status_label);
            follow_up = Some(lc.follow_up);
            if resolved_status == "result_ready" && !summary.accepted {
                result_confirmation_required = Some(human_gate);
            } else if resolved_status == "waiting_user" {
                if summary.phase == "queued" {
                    queue_reason =
                        Self::dependency_queue_reason(&plan, &summary.workspace_id, all_summaries);
                }
                completion_review_required =
                    self.compute_completion_review_required(&plan, &summary);
            }
        } else if summary.status == "result_ready" && !summary.accepted {
            result_confirmation_required = Some(true);
        }

        BotListSession {
            session_id: summary.session_id,
            title: summary.title,
            status: resolved_status,
            updated_at: Some(summary.updated_at),
            result_confirmation_required,
            completion_review_required,
            conversation_id: (!summary.conversation_id.is_empty())
                .then_some(summary.conversation_id),
            queue_reason,
            follow_up,
            phase_label,
            anchor_message_id,
            plan_id,
        }
    }

    pub fn new(data_home: impl AsRef<Path>, concurrency: Option<usize>) -> Self {
        Self::new_for_surface(data_home, HostSurface::Tui, concurrency)
    }

    pub fn new_for_surface(
        data_home: impl AsRef<Path>,
        surface: HostSurface,
        concurrency: Option<usize>,
    ) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            surface,
            goal_plans_dir: home.join("goal-plans"),
            conversations: ConversationStore::new(&home),
            approvals: ApprovalStore::new(&home),
            profiles: BotProfileStore::new(&home),
            inbox: ProjectInbox::new(&home),
            scheduler: ExecutionScheduler::new(&home, concurrency),
            worktrees: GoalWorktreeAdapter::new(&home, None),
            data_home: home,
            plan_cache: Mutex::new(PlanIndexCache::default()),
            transitions: Mutex::new(()),
            verifying_sessions: Mutex::new(HashMap::new()),
            interactive_bridge: RwLock::new(None),
            interactive_enabled_override: RwLock::new(None),
        }
    }

    pub fn surface(&self) -> HostSurface {
        self.surface
    }

    pub fn surface_str(&self) -> &'static str {
        match self.surface {
            HostSurface::Desktop => "desktop",
            HostSurface::Tui => "tui",
        }
    }

    pub fn set_interactive_bridge(&self, bridge: Option<Arc<dyn InteractiveContentBridge>>) {
        if let Ok(mut guard) = self.interactive_bridge.write() {
            *guard = bridge;
        }
    }

    pub fn interactive_bridge(&self) -> Option<Arc<dyn InteractiveContentBridge>> {
        self.interactive_bridge.read().ok().and_then(|g| g.clone())
    }

    pub fn set_interactive_enabled_override(&self, enabled: Option<bool>) {
        if let Ok(mut guard) = self.interactive_enabled_override.write() {
            *guard = enabled;
        }
    }

    pub fn is_interactive_results_enabled(&self) -> bool {
        if let Ok(guard) = self.interactive_enabled_override.read()
            && let Some(explicit) = *guard
        {
            return explicit;
        }
        is_interactive_results_enabled_in_settings(&self.data_home)
    }

    /// True iff this host can both validate/publish interactive results for workers
    /// and inspect/evaluate them for verifiers (Desktop surface + bridge + setting on).
    pub fn is_interactive_publishing_available(&self) -> bool {
        self.surface == HostSurface::Desktop
            && self.interactive_bridge().is_some()
            && self.is_interactive_results_enabled()
    }

    fn check_delegation_capabilities(&self, req: &SpawnSessionRequest) -> Result<(), ProjectError> {
        let mut needs_publish = false;
        let mut needs_inspect = false;
        for raw in &req.required_capabilities {
            let cap = raw.trim().to_ascii_lowercase();
            if cap.is_empty() {
                continue;
            }
            if WORK_SESSION_EXCLUDED_CAPABILITY_PREFIXES
                .iter()
                .any(|prefix| cap.starts_with(prefix))
            {
                return Err(ProjectError::new(
                    "capability_not_available",
                    format!("Delegated worker cannot be granted excluded capability `{raw}`"),
                ));
            }
            if cap == INTERACTIVE_PUBLISH_CAPABILITY || cap == INTERACTIVE_PUBLISH_TOOL {
                needs_publish = true;
                continue;
            }
            if cap == INTERACTIVE_INSPECT_CAPABILITY || cap == INTERACTIVE_INSPECT_TOOL {
                needs_inspect = true;
                continue;
            }
            if req.read_only
                && matches!(
                    cap.as_str(),
                    "local.file.write"
                        | "local.file.edit"
                        | "write_file"
                        | "edit_file"
                        | "local.shell.exec"
                        | "local.shell.stop"
                        | "run_command"
                )
            {
                return Err(ProjectError::new(
                    "capability_not_available",
                    format!(
                        "Read-only delegated worker cannot be granted `{raw}`; set readOnly=false if project writes or commands are required"
                    ),
                ));
            }
        }
        if needs_publish && !self.is_interactive_publishing_available() {
            let detail = if self.surface != HostSurface::Desktop
                || self.interactive_bridge().is_none()
            {
                format!(
                    "`{INTERACTIVE_PUBLISH_CAPABILITY}` requires the Desktop host with interactive results support (current host surface: {})",
                    self.surface_str()
                )
            } else {
                format!(
                    "`{INTERACTIVE_PUBLISH_CAPABILITY}` is disabled because `projectAgent.interactiveResults` is turned off in Settings -> General"
                )
            };
            return Err(ProjectError::new("capability_not_available", detail));
        }
        if needs_inspect && !self.is_interactive_publishing_available() {
            let detail = if self.surface != HostSurface::Desktop
                || self.interactive_bridge().is_none()
            {
                format!(
                    "`{INTERACTIVE_INSPECT_CAPABILITY}` requires the Desktop host with interactive results support (current host surface: {})",
                    self.surface_str()
                )
            } else {
                format!(
                    "`{INTERACTIVE_INSPECT_CAPABILITY}` is disabled because `projectAgent.interactiveResults` is turned off in Settings -> General"
                )
            };
            return Err(ProjectError::new("capability_not_available", detail));
        }
        Ok(())
    }

    pub fn scheduler(&self) -> &ExecutionScheduler {
        &self.scheduler
    }

    fn plan_file(&self, plan_id: &str) -> PathBuf {
        self.goal_plans_dir.join(format!("{plan_id}.json"))
    }

    fn index_file(&self) -> PathBuf {
        self.goal_plans_dir.join("index.jsonl")
    }

    pub fn read_plan(&self, plan_id: &str) -> Result<Value, ProjectError> {
        let path = self.plan_file(plan_id);
        let raw = fs::read_to_string(&path).map_err(|_| ProjectError::code("NOT_FOUND"))?;
        serde_json::from_str(&raw).map_err(|_| ProjectError::code("GOAL_SOURCE_INVALID"))
    }

    pub fn save_plan_json(&self, plan: &Value) -> Result<(), ProjectError> {
        let _transition = self.transition_lock()?;
        self.write_plan(plan)
    }

    fn write_plan(&self, plan: &Value) -> Result<(), ProjectError> {
        let plan_id = plan["planId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        fs::create_dir_all(&self.goal_plans_dir)
            .map_err(|e| ProjectError::new("IO_ERROR", e.to_string()))?;
        let index_path = self.index_file();
        let _lock = DirectoryLock::acquire(&index_path, LOCK_TIMEOUT, None)?;
        let body = serde_json::to_string_pretty(plan)
            .map_err(|e| ProjectError::new("SERIALIZE_ERROR", e.to_string()))?;
        atomic_write(&self.plan_file(plan_id), format!("{body}\n").as_bytes())?;

        let mut rows: Vec<Value> = fs::read_to_string(&index_path)
            .ok()
            .map(|raw| {
                raw.lines()
                    .filter(|l| !l.trim().is_empty())
                    .filter_map(|l| serde_json::from_str::<Value>(l).ok())
                    .collect()
            })
            .unwrap_or_default();
        let index_row = json!({
            "planId": plan_id,
            "conversationId": plan["conversationId"],
            "title": plan["title"],
            "status": plan["status"],
            "createdAt": plan["createdAt"],
            "updatedAt": plan["updatedAt"],
        });
        if let Some(slot) = rows.iter_mut().find(|r| r["planId"] == plan_id) {
            *slot = index_row;
        } else {
            rows.push(index_row);
        }
        let mut encoded = String::new();
        for row in rows {
            if let Ok(line) = serde_json::to_string(&row) {
                encoded.push_str(&line);
                encoded.push('\n');
            }
        }
        atomic_write(&index_path, encoded.as_bytes())?;
        if let Ok(mut cache) = self.plan_cache.lock() {
            cache.index_stamp = None;
            cache.entries.remove(plan_id);
        }
        Ok(())
    }

    pub(crate) fn all_delegated_summaries(&self) -> Vec<WorkSessionSummary> {
        let Some(cur_index_stamp) = file_stamp(&self.index_file()) else {
            if let Ok(mut cache) = self.plan_cache.lock() {
                cache.index_stamp = None;
                cache.index_rows.clear();
                cache.entries.clear();
            }
            return Vec::new();
        };

        let mut cache = match self.plan_cache.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };

        let index_changed = cache.index_stamp != Some(cur_index_stamp);
        if index_changed {
            let Ok(raw_index) = fs::read_to_string(self.index_file()) else {
                return Vec::new();
            };
            let mut seen = HashSet::new();
            let mut next_rows = Vec::new();
            for line in raw_index.lines() {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(row) = serde_json::from_str::<PlanIndexMetaRow>(line)
                    && let Some(pid) = row.plan_id.clone().filter(|s| !s.is_empty())
                    && seen.insert(pid)
                {
                    next_rows.push(row);
                }
            }
            cache.index_rows = next_rows;
            cache.index_stamp = Some(cur_index_stamp);
            if cache.entries.len() > cache.index_rows.len() + 256 {
                let live: HashSet<String> = cache
                    .index_rows
                    .iter()
                    .filter_map(|r| r.plan_id.clone())
                    .collect();
                cache.entries.retain(|pid, _| live.contains(pid));
            }
        }

        let rows_to_check: Vec<PlanIndexMetaRow> = if index_changed {
            cache.index_rows.clone()
        } else {
            cache
                .index_rows
                .iter()
                .filter(|row| {
                    row.plan_id
                        .as_deref()
                        .is_some_and(|pid| cache.entries.get(pid).is_none_or(|(_, v)| v.is_some()))
                })
                .cloned()
                .collect()
        };

        let mut raw_buf = Vec::new();
        for row in &rows_to_check {
            let Some(pid) = row.plan_id.as_deref().filter(|s| !s.is_empty()) else {
                continue;
            };
            let path = self.plan_file(pid);
            let Some(stamp) = file_stamp(&path) else {
                cache.entries.remove(pid);
                continue;
            };
            if cache
                .entries
                .get(pid)
                .is_some_and(|(prev_stamp, _)| *prev_stamp == stamp)
            {
                continue;
            }
            let Ok(mut file) = File::open(&path) else {
                cache.entries.remove(pid);
                continue;
            };
            if stamp.0 > LARGE_PLAN_THRESHOLD
                && let Some(summary) = extract_large_plan_summary(&mut file, stamp.0, pid, row)
            {
                cache.entries.insert(pid.to_owned(), (stamp, Some(summary)));
                continue;
            }
            if file.seek(SeekFrom::Start(0)).is_err() {
                continue;
            }
            raw_buf.clear();
            if file.read_to_end(&mut raw_buf).is_err() {
                continue;
            }
            if !contains_bytes(&raw_buf, DELEGATION_MARKER) {
                cache.entries.insert(pid.to_owned(), (stamp, None));
                continue;
            }
            let summary = serde_json::from_slice::<PlanSummaryDoc>(&raw_buf)
                .ok()
                .and_then(|doc| summarize_doc(&doc));
            cache.entries.insert(pid.to_owned(), (stamp, summary));
        }

        cache
            .index_rows
            .iter()
            .filter_map(|row| {
                let pid = row.plan_id.as_deref()?;
                cache
                    .entries
                    .get(pid)
                    .and_then(|(_, summary)| summary.clone())
            })
            .collect()
    }

    pub fn list_workspace_plans(&self, workspace_id: &str) -> Vec<Value> {
        self.list_sessions(workspace_id)
            .into_iter()
            .filter_map(|s| self.read_plan(&s.plan_id).ok())
            .collect()
    }

    pub(crate) fn list_delegated_plans(
        &self,
        workspace_id: Option<&str>,
    ) -> Vec<(WorkSessionSummary, Value)> {
        let mut items = Vec::new();
        for summary in self.all_delegated_summaries() {
            if workspace_id.is_some_and(|ws| summary.workspace_id != ws) {
                continue;
            }
            if let Ok(plan) = self.read_plan(&summary.plan_id) {
                items.push((summary, plan));
            }
        }
        items.sort_by(|a, b| b.0.updated_at.cmp(&a.0.updated_at));
        items
    }

    pub(crate) fn child_conversation_messages(&self, conversation_id: &str) -> Vec<Value> {
        if conversation_id.trim().is_empty() {
            return Vec::new();
        }
        crate::read_full_conversation_messages(&self.conversations, conversation_id)
            .unwrap_or_default()
    }

    pub(crate) fn conversation_created_at(&self, conversation_id: &str) -> String {
        if conversation_id.trim().is_empty() {
            return String::new();
        }
        self.conversations
            .read_metadata(conversation_id)
            .ok()
            .and_then(|snap| snap.metadata)
            .and_then(|m| m["createdAt"].as_str().map(str::to_owned))
            .unwrap_or_default()
    }

    pub(crate) fn list_retained_unknowns(&self, plan: &Value) -> Vec<Value> {
        let Ok(rstore) = peer_store::ExecutionResourceStore::open_existing(&self.data_home) else {
            return Vec::new();
        };
        let Some(host_plan) = crate::host_resource_plan_from_plan(plan) else {
            return Vec::new();
        };
        rstore.retained_unknowns(&host_plan).unwrap_or_default()
    }

    pub fn list_all_bot_sessions(&self) -> HashMap<String, Vec<BotListSession>> {
        let summaries = self.all_delegated_summaries();
        let mut parent_anchors = HashMap::new();
        let mut coord_cache = HashMap::new();
        let mut grouped: HashMap<String, Vec<BotListSession>> = HashMap::new();
        for s in &summaries {
            if s.workspace_id.is_empty() {
                continue;
            }
            let ws_id = s.workspace_id.clone();
            grouped
                .entry(ws_id)
                .or_default()
                .push(self.to_bot_list_session(
                    s.clone(),
                    &summaries,
                    &mut parent_anchors,
                    &mut coord_cache,
                ));
        }
        for sessions in grouped.values_mut() {
            sessions.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        }
        grouped
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn summarize(&self, plan: &Value) -> WorkSessionSummary {
        let origin = &plan["delegationOrigin"];
        let anchor_message_ids = origin["anchorMessageIds"]
            .as_array()
            .filter(|a| !a.is_empty())
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                origin["anchorMessageId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(|s| vec![s.to_owned()])
                    .unwrap_or_default()
            });
        let status = derive_session_status(plan);
        let phase = normalize_summary_phase(&status, origin["phase"].as_str());
        let plan_conversation_id = plan["conversationId"].as_str().unwrap_or("");
        let session_id = origin["sessionId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(plan_conversation_id)
            .to_owned();
        let conversation_id = origin["workerConversationId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .unwrap_or(plan_conversation_id)
            .to_owned();
        WorkSessionSummary {
            session_id,
            workspace_id: origin["workspaceId"].as_str().unwrap_or("").to_owned(),
            conversation_id,
            plan_id: plan["planId"].as_str().unwrap_or("").to_owned(),
            title: plan["title"].as_str().unwrap_or("").to_owned(),
            status,
            phase,
            read_only: origin["readOnly"] == true,
            priority: origin["priority"].as_str().unwrap_or("normal").to_owned(),
            updated_at: plan["updatedAt"].as_str().unwrap_or("").to_owned(),
            accepted: plan["resultAcceptance"]["acceptedAt"].as_str().is_some(),
            accepted_by: plan["resultAcceptance"]["acceptedBy"]
                .as_str()
                .map(str::to_owned),
            worktree_path: plan["deliveryBinding"]["worktreePath"]
                .as_str()
                .map(str::to_owned),
            approval_id: origin["planApprovalId"].as_str().map(str::to_owned),
            handoff_status: plan["deliveryHandoff"]["status"]
                .as_str()
                .map(str::to_owned),
            anchor_message_ids,
            follow_up_epoch: origin["followUpEpoch"].as_u64(),
        }
    }

    pub fn list_sessions(&self, workspace_id: &str) -> Vec<WorkSessionSummary> {
        let mut items: Vec<WorkSessionSummary> = self
            .all_delegated_summaries()
            .into_iter()
            .filter(|s| s.workspace_id == workspace_id)
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub(crate) fn pending_result_sessions(
        &self,
        workspace_id: &str,
        conversation_id: &str,
    ) -> Vec<WorkSessionSummary> {
        self.list_workspace_plans(workspace_id)
            .iter()
            .filter(|plan| {
                plan["status"] == "completed"
                    && plan["delegationOrigin"]["cancellation"]["disposition"] != "user_withdrawn"
                    && !plan["delegationOrigin"]["supersededBy"].is_string()
                    && plan["delegationOrigin"]["parentConversationId"] == conversation_id
                    && derive_session_status(plan) == "result_ready"
                    && plan["updatedAt"]
                        .as_str()
                        .is_some_and(|revision| !revision.is_empty())
            })
            .map(|plan| self.summarize(plan))
            .collect()
    }

    pub fn list_bot_sessions(&self, workspace_id: &str) -> Vec<BotListSession> {
        let all_summaries = self.all_delegated_summaries();
        let mut parent_anchors = HashMap::new();
        let mut coord_cache = HashMap::new();
        let mut items: Vec<BotListSession> = all_summaries
            .iter()
            .filter(|s| s.workspace_id == workspace_id)
            .cloned()
            .map(|s| {
                self.to_bot_list_session(s, &all_summaries, &mut parent_anchors, &mut coord_cache)
            })
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn find_plan_by_session(&self, workspace_id: &str, session_id: &str) -> Option<Value> {
        self.list_workspace_plans(workspace_id)
            .into_iter()
            .find(|p| {
                p["delegationOrigin"]["sessionId"].as_str() == Some(session_id)
                    || p["delegationOrigin"]["workerConversationId"].as_str() == Some(session_id)
                    || p["conversationId"].as_str() == Some(session_id)
                    || p["planId"].as_str() == Some(session_id)
            })
    }

    fn emit_event(&self, workspace_id: &str, kind: &str, session_id: &str, payload: Value) {
        let at = now_iso();
        let event_id = format!("sup-{kind}-{session_id}-{}", uuid::Uuid::new_v4());
        let _ = self.inbox.append(
            workspace_id,
            &[json!({
                "eventId": event_id,
                "kind": kind,
                "workspaceId": workspace_id,
                "sessionId": session_id,
                "at": at,
                "payload": payload,
            })],
        );
    }

    /// Persist the terminal transition and its replayable inbox event together.
    /// Callers hold the transition lock until both writes have been attempted.
    fn persist_terminal_transition(
        &self,
        plan: &mut Value,
        initiated_by: &str,
    ) -> Result<(), ProjectError> {
        let origin = &plan["delegationOrigin"];
        let workspace = origin["workspaceId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let session = origin["sessionId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let epoch = origin["followUpEpoch"].as_u64().unwrap_or(0);
        let status = plan["status"].as_str().unwrap_or_default();
        let revision = plan["updatedAt"].as_str().unwrap_or_default();
        let token = format!("{status}:e{epoch}:{revision}");
        let mut payload = json!({
            "planId": plan["planId"], "status": status, "followUpEpoch": epoch,
            "initiatedBy": initiated_by, "sameCauseCount": 0, "stopAutoRetry": false,
        });
        if matches!(status, "failed" | "interrupted")
            && let Some(mut facts) = crate::watchdog::watch_facts_from_plan(plan)
        {
            let code = plan["failure"]["code"]
                .as_str()
                .or_else(|| plan["runner"]["interruption"]["reason"].as_str())
                .or_else(|| origin["error"].as_str())
                .unwrap_or("WORKER_FAILED");
            facts.interruption_code = code.to_owned();
            facts.interruption_reason = code.to_owned();
            if let Some(detail) = plan["failure"]["message"].as_str() {
                facts.last_error = detail.chars().take(500).collect();
            }
            let failure = crate::watchdog::describe_failure(&facts);
            let same = crate::watchdog::assess_same_cause(&facts, Some(&failure));
            payload["failureCode"] = json!(code);
            payload["failureSummary"] = json!(failure.summary);
            payload["sameCauseCount"] = json!(same.count);
            payload["stopAutoRetry"] = json!(same.stop_auto_retry);
            let mut log = facts.failure_log;
            log.push(json!({
                "taskId": same.task_key, "cause": same.cause, "causeClass": same.cause_class,
                "followUpEpoch": epoch,
            }));
            let excess = log.len().saturating_sub(64);
            log.drain(..excess);
            plan["failureLog"] = json!(log);
        }
        let at = plan["updatedAt"].clone();
        let event_id = crate::watchdog::delegation_event_id(&session, "session_ended", &token);
        let event = json!({
            "eventId": event_id, "kind": "session_ended", "workspaceId": workspace,
            "sessionId": session, "at": at, "payload": payload,
        });
        plan["delegationOrigin"]["terminalEvent"] = event.clone();
        self.write_plan(plan)?;
        self.inbox.append(&workspace, &[event])?;
        Ok(())
    }

    /// Spawn a delegated work session: freezes memory snapshot, creates child conversation
    /// + canonical GoalPlan + optional isolated worktree + optional plan approval gate.
    pub fn spawn_session(
        &self,
        req: SpawnSessionRequest,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        self.spawn_session_impl(req, None, None)
    }

    fn spawn_session_impl(
        &self,
        req: SpawnSessionRequest,
        retry: Option<(u64, &Value)>,
        fresh_followup_attachments: Option<&[Value]>,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if req.anchor_message_ids.is_empty() {
            return Err(ProjectError::new(
                "invalid_input",
                "anchorMessageIds must contain at least one valid user message anchor",
            ));
        }
        if req.title.trim().is_empty() || req.title.chars().count() > 60 {
            return Err(ProjectError::new(
                "invalid_input",
                "title is required and must be at most 60 characters",
            ));
        }
        if req.brief.trim().is_empty()
            || req.brief.chars().count()
                > if fresh_followup_attachments.is_some() {
                    11_000
                } else {
                    4_000
                }
        {
            return Err(ProjectError::new(
                "invalid_input",
                "brief is required and must be at most 4000 characters",
            ));
        }
        if req.success_criteria.is_empty() || req.success_criteria.len() > 8 {
            return Err(ProjectError::new(
                "invalid_input",
                "successCriteria must contain between 1 and 8 items",
            ));
        }
        self.check_delegation_capabilities(&req)?;
        let at = now_iso();
        let snapshot = create_snapshot(&self.data_home, &req.workspace_id)?;
        let plan_id = format!("plan-{}", uuid::Uuid::new_v4());
        let use_worktree = !req.read_only
            && (req.isolation == "worktree"
                || match retry {
                    Some((_, predecessor)) => {
                        predecessor["deliveryBinding"]["executionIsolation"] == "worktree"
                    }
                    None => {
                        req.isolation == "auto"
                            && GoalWorktreeAdapter::is_git_repository(&req.workspace_path)
                    }
                });
        let retry_title = retry.map(|(count, _)| {
            let prefix: String = req.title.chars().take(30).collect();
            format!("retry-{count}-{}-{prefix}", &plan_id[5..13])
        });
        let delivery_binding = if use_worktree {
            match self.worktrees.prepare(
                &plan_id,
                &req.workspace_path,
                Some(retry_title.as_deref().unwrap_or(&req.title)),
            ) {
                Ok(handle) => {
                    if let Some((_, predecessor)) = retry {
                        let binding = &predecessor["deliveryBinding"];
                        if binding["baselineCommit"] != handle.baseline_commit
                            || binding["targetBranch"] != handle.target_branch
                        {
                            let _ = self.worktrees.cleanup_if_clean(&handle);
                            return Err(ProjectError::code("retry_workspace_changed"));
                        }
                    }
                    json!({
                        "executionIsolation": "worktree",
                        "targetWorkspacePath": req.workspace_path,
                        "worktreePath": handle.worktree_path,
                        "branch": handle.branch,
                        "targetBranch": handle.target_branch,
                        "targetBranchSource": "workspace_head",
                        "baselineCommit": handle.baseline_commit,
                    })
                }
                Err(error) if retry.is_some() || fresh_followup_attachments.is_some() => {
                    return Err(error);
                }
                Err(_) => json!({
                    "executionIsolation": "none",
                    "targetWorkspacePath": req.workspace_path,
                }),
            }
        } else {
            json!({
                "executionIsolation": "none",
                "targetWorkspacePath": req.workspace_path,
            })
        };

        let conv = self.conversations.create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: req.title.trim(),
                workspace_id: &req.workspace_id,
                workspace_path: req.workspace_path.to_str(),
                role: "work_session",
                parent_conversation_id: Some(&req.parent_conversation_id),
                mode: "goal",
                created_at: &at,
            },
            None,
            None,
        )?;
        let session_id = conv["id"]
            .as_str()
            .ok_or_else(|| ProjectError::code("CONVERSATION_CREATE_FAILED"))?
            .to_owned();

        // Append the delegated brief as the opening user message in the child conversation.
        self.conversations.append_message_idempotent(
            &session_id,
            &json!({
                "id": format!("brief-{session_id}"),
                "role": "user",
                "content": req.brief,
                "attachments": fresh_followup_attachments.unwrap_or_default(),
                "createdAt": at,
            }),
            &at,
            None,
        )?;

        let profile = self.profiles.read(&req.workspace_id);
        let plan_approval_policy = profile
            .as_ref()
            .map(|p| p.plan_approval_str())
            .unwrap_or("never");
        let needs_plan_approval = plan_approval_required(plan_approval_policy, req.read_only);
        let approval_id = needs_plan_approval.then(|| format!("plan:{plan_id}"));

        let criteria: Vec<Value> = req
            .success_criteria
            .iter()
            .enumerate()
            .map(|(i, c)| {
                let mut row = json!({
                    "id": c.id.clone().unwrap_or_else(|| format!("c-{}", i + 1)),
                    "kind": c.kind,
                    "description": c.description,
                });
                if let Some(ref cmd) = c.command {
                    row["command"] = json!(cmd);
                }
                if let Some(ref p) = c.path {
                    row["path"] = json!(p);
                }
                if let Some(ref exp) = c.expect {
                    row["expect"] = json!(exp);
                }
                row
            })
            .collect();

        let execution_generation = uuid::Uuid::new_v4().to_string();
        let initial_phase = if needs_plan_approval {
            "awaiting_approval"
        } else {
            "queued"
        };
        let initial_status = if needs_plan_approval {
            "awaiting_approval"
        } else {
            "accepted"
        };
        let model_selection = canonical_model_selection_snapshot(&req.worker_model_selection, &at);
        let declared_caps: Vec<String> = {
            let mut seen = HashSet::new();
            req.required_capabilities
                .iter()
                .map(|c| c.trim())
                .filter(|c| !c.is_empty())
                .filter(|c| seen.insert((*c).to_owned()))
                .map(str::to_owned)
                .collect()
        };
        let mut origin = json!({
            "workspaceId": req.workspace_id,
            "sessionId": session_id,
            "parentConversationId": req.parent_conversation_id,
            "anchorMessageId": req.anchor_message_ids[0],
            "anchorMessageIds": req.anchor_message_ids,
            "inputId": req.input_id,
            "surface": req.surface,
            "kind": req.kind,
            "readOnly": req.read_only,
            "requiredCapabilities": req.required_capabilities,
            "capabilityAdmission": {
                "required": declared_caps,
                "inventoryHash": Value::Null,
                "inventoryKnown": true,
                "requirementsDeclared": !req.required_capabilities.is_empty(),
                "checkedAt": at,
            },
            "memorySnapshotId": snapshot.snapshot_id,
            "priority": req.priority,
            "dependsOn": req.depends_on,
            "isolation": req.isolation,
            "phase": initial_phase,
            "executionGeneration": execution_generation,
            "depth": 1,
            "modelSelection": model_selection,
        });
        if let Some(ref predecessor) = req.supersedes {
            origin["supersedes"] = json!(predecessor);
        }
        if fresh_followup_attachments.is_some() {
            origin["startedFreshFollowUp"] = json!(true);
        }
        if let Some((count, predecessor)) = retry {
            origin["autoRetryCount"] = json!(count);
            origin["autonomousRetry"] = json!(true);
            for key in ["workerTurnsUsed", "workerTurnLimit"] {
                if let Some(value) = predecessor["delegationOrigin"].get(key) {
                    origin[key] = value.clone();
                }
            }
        }
        if let Some(ref obj_id) = req.objective_id {
            origin["objectiveId"] = json!(obj_id);
        }
        if let Some(ref aid) = approval_id {
            origin["planApprovalId"] = json!(aid);
        }

        let plan = json!({
            "planId": plan_id,
            "conversationId": session_id,
            "originWorkspacePath": req.workspace_path,
            "targetWorkspacePath": delivery_binding["worktreePath"].as_str()
                .map(PathBuf::from)
                .unwrap_or_else(|| req.workspace_path.clone()),
            "title": req.title.trim(),
            "goal": req.brief.trim(),
            "tasks": [{
                "taskId": "task-1",
                "title": req.title.trim(),
                "status": "pending",
                "evidenceRefs": [],
            }],
            "successCriteria": criteria,
            "status": initial_status,
            "workflowKind": if needs_plan_approval { "plan_approval" } else { "goal_self_driven" },
            "activation": if needs_plan_approval {
                json!({"kind": "approval_required"})
            } else {
                json!({"kind": "accepted_goal", "acceptedAt": at, "acceptedBy": "delegation"})
            },
            "deliveryBinding": delivery_binding,
            "delegationOrigin": origin,
            "executionPolicy": {
                "autonomy": if needs_plan_approval { "approval_gated" } else { "self_driven" },
                "irreversibleRequiresConfirmation": true,
                "writeScope": "workspace_and_boundaries",
            },
            "version": 1,
            "createdAt": at,
            "updatedAt": at,
            "createdBy": "project_agent",
            "criterionResults": [],
            "modelReviews": [],
            "manualConfirmations": [],
            "evidenceRefs": [],
            "progress": {"total": 1, "completed": 0, "failed": 0, "blocked": 0, "percent": 0},
        });
        self.write_plan(&plan)?;

        if let Some(ref aid) = approval_id {
            let digest = format!("{:x}", Sha256::digest(plan_id.as_bytes()));
            self.approvals.open(
                &HostApproval {
                    approval_id: aid,
                    workspace_id: Some(&req.workspace_id),
                    conversation_id: &session_id,
                    stream_id: &execution_generation,
                    plan_id: Some(&plan_id),
                    session_id: Some(&session_id),
                    capability_id: "goal.plan",
                    args_digest: &digest,
                    policy_revision: "1",
                    created_at: &at,
                    deadline_at: None,
                },
                None,
            )?;
        }

        // A predecessor only leaves the current list after its successor is durable.
        if let Some(ref old_sid) = req.supersedes
            && let Some(mut old_plan) = self.find_plan_by_session(&req.workspace_id, old_sid)
            && fresh_followup_attachments.is_none()
            && (retry.is_some()
                || !matches!(
                    derive_session_status(&old_plan).as_str(),
                    "result_ready" | "accepted" | "verifying"
                ))
        {
            self.retire_replaced_session(&mut old_plan, &json!(session_id))?;
        }

        let all_plans = self.list_workspace_plans(&req.workspace_id);
        let _ = self.scheduler.reconcile(&req.workspace_id, &all_plans);
        self.emit_event(
            &req.workspace_id,
            "session_spawned",
            &session_id,
            json!({"planId": plan_id, "title": req.title, "phase": initial_phase}),
        );
        Ok(self.summarize(&plan))
    }

    /// Promote eligible queued sessions according to `ExecutionScheduler`.
    pub fn promote_queued(
        &self,
        workspace_id: &str,
        holds_lease: bool,
    ) -> Result<SelectionOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let all_plans = self.list_workspace_plans(workspace_id);
        let outcome = self.scheduler.select(workspace_id, &all_plans)?;
        let at = now_iso();
        for sid in &outcome.start {
            if let Some(mut plan) = self.find_plan_by_session(workspace_id, sid) {
                plan["delegationOrigin"]["phase"] = json!("running");
                plan["status"] = json!("executing");
                plan["updatedAt"] = json!(at);
                self.write_plan(&plan)?;
                self.emit_event(
                    workspace_id,
                    "session_running",
                    sid,
                    json!({"planId": plan["planId"]}),
                );
            }
        }
        Ok(outcome)
    }

    /// Fail a delegated work session durably and emit `session_ended` (`status: "failed"`),
    /// ensuring runtime/worker errors never leave the session permanently stuck in `executing`/`running`.
    pub fn fail_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        code: &str,
        detail: &str,
        holds_lease: bool,
    ) -> Result<bool, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let Some(mut plan) = self.find_plan_by_session(workspace_id, session_id) else {
            return Ok(false);
        };
        if matches!(
            plan["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(false);
        }
        let at = now_iso();
        plan["status"] = json!("failed");
        plan["updatedAt"] = json!(at);
        plan["delegationOrigin"]["phase"] = json!("failed");
        plan["delegationOrigin"]["error"] = json!(code);
        plan["delegationOrigin"]["errorDetail"] = json!(detail);
        plan["failure"] = json!({
            "code": code,
            "message": detail,
            "at": at,
        });
        let mut failed_tasks = 0usize;
        if let Some(tasks) = plan["tasks"].as_array_mut() {
            for t in tasks {
                if !matches!(t["status"].as_str(), Some("completed" | "cancelled")) {
                    t["status"] = json!("failed");
                    failed_tasks += 1;
                }
            }
        }
        if let Some(progress) = plan.get_mut("progress").and_then(Value::as_object_mut) {
            progress.insert("failed".to_owned(), json!(failed_tasks));
        }
        plan["runner"]["status"] = json!("failed");
        self.persist_terminal_transition(&mut plan, "worker")?;
        Ok(true)
    }

    fn cancel_session_on_abort(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<(), ProjectError> {
        let _transition = self.transition_lock()?;
        let Some(mut plan) = self.find_plan_by_session(workspace_id, session_id) else {
            return Ok(());
        };
        if matches!(
            plan["status"].as_str(),
            Some("completed" | "failed" | "cancelled")
        ) {
            return Ok(());
        }
        let at = now_iso();
        plan["status"] = json!("cancelled");
        plan["updatedAt"] = json!(at);
        plan["delegationOrigin"]["phase"] = json!("cancelled");
        plan["delegationOrigin"]["cancellation"] = json!({
            "operationId": uuid::Uuid::new_v4().to_string(),
            "reason": "aborted",
            "phase": "completed",
            "requestedAt": at,
            "completedAt": at,
        });
        if plan["runner"].is_object() {
            plan["runner"]["status"] = json!("cancelled");
        }
        if let Some(tasks) = plan["tasks"].as_array_mut() {
            for t in tasks {
                if !matches!(t["status"].as_str(), Some("completed" | "failed")) {
                    t["status"] = json!("cancelled");
                }
            }
        }
        self.persist_terminal_transition(&mut plan, "worker")?;
        Ok(())
    }

    /// Execute one delegated session episode via the existing native `NativeSessionHost`
    /// Execute one delegated session episode via the unified native runtime
    /// (`NativeConversationRuntime` for native-spawned worker sessions, or
    /// `peer_runtime::native_exec::execute_plan` for legacy coordination-bound GoalPlans),
    /// honoring all Grants, Evidence, MCP, Hooks, Skills, Compaction, Billing, and Stop/Recovery invariants.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_session_episode(
        &self,
        workspace_id: &str,
        session_id: &str,
        worker_model: &NativeModel,
        permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
        holds_lease: bool,
    ) -> Result<EpisodeOutcome, ProjectError> {
        Box::pin(self.run_session_episode_with_verifier(
            workspace_id,
            session_id,
            worker_model,
            None,
            permission,
            max_turns,
            cancel,
            holds_lease,
        ))
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn run_session_episode_with_verifier(
        &self,
        workspace_id: &str,
        session_id: &str,
        worker_model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
        holds_lease: bool,
    ) -> Result<EpisodeOutcome, ProjectError> {
        Box::pin(self.run_session_episode_with_verifier_owned(
            workspace_id,
            session_id,
            worker_model,
            verifier_model,
            permission,
            max_turns,
            cancel,
            || holds_lease,
        ))
        .await
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn run_session_episode_with_verifier_owned(
        &self,
        workspace_id: &str,
        session_id: &str,
        worker_model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
        owns_lease: impl Fn() -> bool,
    ) -> Result<EpisodeOutcome, ProjectError> {
        let holds_lease = owns_lease();
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let _permit = self
            .scheduler
            .global_semaphore()
            .acquire_owned()
            .await
            .map_err(|_| ProjectError::code("SCHEDULER_CLOSED"))?;

        let is_legacy_coordinated = plan["delegationOrigin"]["coordinationBinding"].is_object();
        let (outcome, worker_conv_id) = if is_legacy_coordinated {
            let outcome = match execute_plan(
                &self.data_home,
                &plan_id,
                permission,
                max_turns,
                cancel,
            )
            .await
            {
                Ok(out) => out,
                Err(err) => {
                    if cancel.is_cancelled() {
                        let _ = self.cancel_session_on_abort(workspace_id, session_id);
                    } else {
                        let _ =
                            self.fail_session(workspace_id, session_id, err.0, err.0, holds_lease);
                    }
                    return Err(err.into());
                }
            };
            (outcome, None)
        } else {
            let target_ws = match plan["targetWorkspacePath"]
                .as_str()
                .or_else(|| plan["originWorkspacePath"].as_str())
                .map(PathBuf::from)
            {
                Some(path) => path,
                None => {
                    let _ = self.fail_session(
                        workspace_id,
                        session_id,
                        "WORKSPACE_NOT_FOUND",
                        "Missing targetWorkspacePath on plan",
                        holds_lease,
                    );
                    return Err(ProjectError::code("WORKSPACE_NOT_FOUND"));
                }
            };
            if !target_ws.exists() {
                let detail = format!("Workspace path does not exist: {}", target_ws.display());
                let _ = self.fail_session(
                    workspace_id,
                    session_id,
                    "WORKSPACE_NOT_FOUND",
                    &detail,
                    holds_lease,
                );
                return Err(ProjectError::new("WORKSPACE_NOT_FOUND", detail));
            }
            // The session follows the Bot's current policy on every call. A
            // policy that cannot be read fails the session rather than falling
            // back to another level (ADR101 §2.3, §6.1, §6.3).
            let access = match delegated_access(&self.data_home, workspace_id) {
                Ok(access) => access,
                Err(error) => {
                    let _ = self.fail_session(
                        workspace_id,
                        session_id,
                        error.code,
                        &error.detail,
                        holds_lease,
                    );
                    return Err(error);
                }
            };
            let interactive_available = self.is_interactive_publishing_available();
            let interactive_bridge = interactive_available
                .then(|| self.interactive_bridge())
                .flatten();
            let mut session_profile = match resolve_work_session_profile_with_interactive(
                &plan,
                "worker",
                interactive_bridge.is_some(),
            ) {
                Some(p) => p,
                None => {
                    let _ = self.fail_session(
                        workspace_id,
                        session_id,
                        "INVALID_PLAN",
                        "Invalid work session profile",
                        holds_lease,
                    );
                    return Err(ProjectError::code("INVALID_PLAN"));
                }
            };
            let bot_cap_policy = self
                .profiles
                .read(workspace_id)
                .and_then(|p| p.capability_policy);
            crate::extend_worker_allowlist_with_bot_capabilities(
                &self.data_home,
                &target_ws,
                bot_cap_policy.as_ref(),
                &mut session_profile,
            );
            let worker_cap_overrides = bot_cap_policy
                .as_ref()
                .map(|p| peer_runtime::conversation_host::CapabilityOverrides {
                    enabled_skill_ids: p.enabled_skill_ids.clone(),
                    disabled_skill_ids: p.disabled_skill_ids.clone(),
                    enabled_mcp_ids: p.enabled_mcp_ids.clone(),
                    disabled_mcp_ids: p.disabled_mcp_ids.clone(),
                })
                .unwrap_or_default();
            let mut prompt = format!(
                "Delegated Task: {}\n\nObjective:\n{}\n",
                plan["title"].as_str().unwrap_or(""),
                plan["goal"].as_str().unwrap_or("")
            );
            if let Some(criteria) = plan["successCriteria"].as_array()
                && !criteria.is_empty()
            {
                prompt.push_str("\nSuccess Criteria:\n");
                for c in criteria {
                    let desc = c["description"].as_str().unwrap_or("");
                    let kind = c["kind"].as_str().unwrap_or("manual");
                    prompt.push_str(&format!("- [{kind}] {desc}\n"));
                }
            }
            let remaining_turns = max_turns.max(1).saturating_sub(
                plan["delegationOrigin"]["workerTurnsUsed"]
                    .as_u64()
                    .unwrap_or(0) as usize,
            );
            if remaining_turns == 0 {
                return Err(ProjectError::code("worker_budget_exhausted"));
            }
            let effective_max_turns = remaining_turns;
            prompt.push_str(&format!(
                "\nExecution Guidance:\n\
                 - Turn budget: {effective_max_turns} turns. Batch independent read/search/check tool calls into the same turn whenever possible instead of issuing one small lookup per turn.\n\
                 - Once all required edits and verification commands succeed, stop calling tools and deliver a concise factual final report citing exact file paths, line numbers, and observed command results.\n"
            ));
            let has_web_search = session_profile
                .allowlist
                .iter()
                .any(|c| c == "local.web.search");
            let has_web_fetch = session_profile
                .allowlist
                .iter()
                .any(|c| c == "local.web.fetch");
            if has_web_search && has_web_fetch {
                prompt.push_str(
                    "- `web_search` and `web_fetch` ARE projected in this session for read-only web research. Use `web_search` to discover authoritative documentation/repository URLs and highlights, follow up with `web_fetch` when full page details are needed, and cite direct URLs for all external claims.\n",
                );
            } else if has_web_search {
                prompt.push_str(
                    "- `web_search` IS projected in this session for read-only web search. Cite direct URLs from search results and never fabricate unverified claims.\n",
                );
            } else if has_web_fetch {
                prompt.push_str(
                    "- `web_fetch` IS projected in this session for read-only HTTP/HTTPS URL fetching. Fetch authoritative documentation/repository URLs directly via `web_fetch` and never fabricate unverified claims.\n",
                );
            }
            let anchor_ids: Vec<String> = plan["delegationOrigin"]["anchorMessageIds"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let input_attachments = if plan["delegationOrigin"]["startedFreshFollowUp"] == true {
                crate::read_full_conversation_messages(&self.conversations, session_id)
                    .ok()
                    .and_then(|messages| {
                        messages
                            .into_iter()
                            .find(|message| message["id"] == format!("brief-{session_id}"))
                    })
                    .and_then(|message| message["attachments"].as_array().cloned())
                    .unwrap_or_default()
            } else if let (Some(parent_cid), false) = (
                plan["delegationOrigin"]["parentConversationId"].as_str(),
                anchor_ids.is_empty(),
            ) {
                crate::read_full_conversation_messages(&self.conversations, parent_cid)
                    .ok()
                    .and_then(|msgs| {
                        crate::attachments::attachments_from_messages_persisted(&msgs, &anchor_ids)
                            .ok()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let continuation = if plan["delegationOrigin"]["continueWorkerConversation"] == true {
                let continuation = self
                    .load_worker_checkpoint(&plan)?
                    .filter(|run| {
                        run.attribution["providerName"] == worker_model.provider()
                            && run.attribution["model"] == worker_model.model_id()
                    })
                    .ok_or_else(|| ProjectError::code("worker_checkpoint_unavailable"))?;
                prompt = match plan["delegationOrigin"]["followUpPrompt"].as_str() {
                    Some(_) => "Continue on your existing work and workspace using the latest follow-up instruction recorded above. Do not redo already completed steps unless asked.".to_owned(),
                    None => "Continue the existing delegated task using the recorded work and any answer from the parent project agent. Preserve its original scope and account for effects already completed.".to_owned(),
                };
                Some(continuation)
            } else {
                None
            };
            let can_publish_interactive = session_profile
                .allowlist
                .iter()
                .any(|c| c == INTERACTIVE_PUBLISH_CAPABILITY);
            let can_inspect_interactive = session_profile
                .allowlist
                .iter()
                .any(|c| c == INTERACTIVE_INSPECT_CAPABILITY);
            let mut extra_providers: Vec<Box<dyn CapabilityProvider>> = Vec::new();
            let mut context_extensions: Vec<Value> = Vec::new();
            if let Some(bridge) = interactive_bridge
                && (can_publish_interactive || can_inspect_interactive)
                && let (Some(parent_cid), Some(plan_cid)) = (
                    plan["delegationOrigin"]["parentConversationId"].as_str(),
                    plan["conversationId"].as_str(),
                )
            {
                let epoch = plan["delegationOrigin"]["executionGeneration"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .unwrap_or(&plan_id)
                    .to_owned();
                extra_providers.push(Box::new(WorkSessionInteractiveProvider::new(
                    WorkSessionInteractiveContext {
                        data_home: self.data_home.clone(),
                        owner: InteractiveOwner {
                            workspace_id: workspace_id.to_owned(),
                            conversation_id: parent_cid.to_owned(),
                        },
                        plan_id: plan_id.clone(),
                        session_id: session_id.to_owned(),
                        plan_conversation_id: plan_cid.to_owned(),
                        execution_epoch: epoch,
                        role: "session_worker".to_owned(),
                        can_publish: can_publish_interactive,
                        bridge: Arc::clone(&bridge),
                        on_published: None,
                    },
                )));
                context_extensions.push(interactive_context_extension(
                    Some(bridge.as_ref()),
                    can_publish_interactive,
                ));
                if can_publish_interactive && continuation.is_none() {
                    prompt.push_str(
                        "- `publish_interactive_result` IS projected in this session. Follow the `Peer Interactive Results Catalog & Rules` section in your system context strictly (`peer-basic-1` DSL), pass `publication: {\"kind\": \"create\"}`, valid `title`, `textFallback`, `program`, and `inputs`, and cite the returned `artifactRef` (`interactive-result://...`) in your final report.\n",
                    );
                }
            }
            let precreated_worker_cid: Option<String> = if continuation.is_none() {
                let canonical_ws =
                    fs::canonicalize(&target_ws).unwrap_or_else(|_| target_ws.clone());
                let conv_title = plan["title"]
                    .as_str()
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .unwrap_or("Delegated task");
                let created_at = now_iso();
                let created = self
                    .conversations
                    .create_with_model(
                        &NewConversation {
                            title: conv_title,
                            workspace_path: canonical_ws.to_str(),
                            mode: RuntimeMode::Chat.as_str(),
                            created_at: &created_at,
                        },
                        None,
                        None,
                    )
                    .ok()
                    .and_then(|v| v["id"].as_str().map(str::to_owned));
                if let Some(ref wcid) = created
                    && let Ok(_guard) = self.transition_lock()
                    && let Ok(mut live_plan) = self.read_plan(&plan_id)
                    && !matches!(
                        derive_session_status(&live_plan).as_str(),
                        "accepted" | "cancelled" | "paused" | "superseded"
                    )
                {
                    live_plan["delegationOrigin"]["workerConversationId"] = json!(wcid);
                    live_plan["updatedAt"] = json!(now_iso());
                    let _ = self.write_plan(&live_plan);
                }
                created
            } else {
                None
            };
            let mailbox = ConversationStore::new(&self.data_home);
            let plan_path = self.plan_file(&plan_id);
            let mailbox_id = plan["conversationId"]
                .as_str()
                .unwrap_or(session_id)
                .to_owned();
            let epoch = plan["delegationOrigin"]["followUpEpoch"]
                .as_u64()
                .unwrap_or(0);
            let image_home = self.data_home.clone();
            let image_workspace = workspace_id.to_owned();
            let runtime = NativeConversationRuntime::new(&self.data_home, access)
                .with_capability_overrides(worker_cap_overrides)
                .with_delegated_attachments(input_attachments, move |attachment| {
                    crate::attachments::resolve_workspace_image_data_url(
                        &image_home,
                        &image_workspace,
                        attachment,
                    )
                })
                .with_delegated_inputs(move |after| {
                    let plan: Value = fs::read(&plan_path)
                        .ok()
                        .and_then(|data| serde_json::from_slice(&data).ok())
                        .ok_or(peer_runtime::capability::CapabilityError(
                            "delegation_plan_unavailable",
                        ))?;
                    let through = plan["delegationOrigin"]["pendingSteerSeq"]
                        .as_u64()
                        .unwrap_or(0);
                    if through <= after {
                        return Ok(Vec::new());
                    }
                    let rows = crate::read_full_conversation_messages(&mailbox, &mailbox_id)
                        .map_err(|e| peer_runtime::capability::CapabilityError(e.code()))?;
                    let mut pending: Vec<_> = rows
                        .into_iter()
                        .filter(|message| {
                            message["followUpEpoch"].as_u64() == Some(epoch)
                                && message["steerSeq"]
                                    .as_u64()
                                    .is_some_and(|seq| seq > after && seq <= through)
                        })
                        .collect();
                    pending.sort_by_key(|message| message["steerSeq"].as_u64());
                    Ok(pending)
                });
            let conv_res = Box::pin(
                runtime.execute_delegated_with_extensions(
                    &ConversationOptions {
                        workspace: &target_ws,
                        conversation_id: continuation
                            .as_ref()
                            .map(|run| run.identity.conversation_id.as_str())
                            .or(precreated_worker_cid.as_deref()),
                        resume_from: continuation.as_ref(),
                        prompt: &prompt,
                        image_paths: &[],
                        provider_id: worker_model.provider(),
                        mode: RuntimeMode::Chat,
                        effort: "default",
                        persist_model_selection: false,
                        allowlist: Some(&session_profile.allowlist),
                        max_turns: Some(effective_max_turns),
                    },
                    worker_model,
                    permission,
                    cancel,
                    extra_providers,
                    context_extensions,
                ),
            )
            .await;
            let mut conv_out = match conv_res {
                Ok(out) => out,
                Err(err) => {
                    if cancel.is_cancelled() || err.0 == "CANCELLED" {
                        let _ = self.cancel_session_on_abort(workspace_id, session_id);
                    } else {
                        let _ =
                            self.fail_session(workspace_id, session_id, err.0, err.0, holds_lease);
                    }
                    return Err(err.into());
                }
            };
            if conv_out.error == Some("agent_loop_exhausted")
                && !cancel.is_cancelled()
                && effective_max_turns >= 2
            {
                let wrap_prompt = "You have reached the tool-turn limit for this delegated task. Tools are now disabled. Write your concise, factual final report directly in plain text summarizing only verified edits, file checks, and command results observed in this session (clearly note anything still unverified). Do not emit tool-call markup.";
                if let Ok(wrap_out) = Box::pin(runtime.execute_delegated(
                    &ConversationOptions {
                        workspace: &target_ws,
                        conversation_id: Some(&conv_out.session_id),
                        resume_from: None,
                        prompt: wrap_prompt,
                        image_paths: &[],
                        provider_id: worker_model.provider(),
                        mode: RuntimeMode::Chat,
                        effort: "default",
                        persist_model_selection: false,
                        allowlist: Some(&[]),
                        max_turns: Some(1),
                    },
                    worker_model,
                    permission,
                    cancel,
                ))
                .await
                {
                    let cleaned = peer_runtime::tool_markup::strip_literal_tool_call_blocks(
                        &wrap_out.content,
                    );
                    if wrap_out.error.is_none() && !cleaned.trim().is_empty() {
                        conv_out.content = cleaned.trim().to_owned();
                        conv_out.error = None;
                        conv_out.turns = conv_out.turns.saturating_add(wrap_out.turns);
                        if wrap_out.lifetime_usage.is_some() {
                            conv_out.lifetime_usage = wrap_out.lifetime_usage;
                        }
                    }
                }
            }
            let question = conv_out.parent_question;
            let status: &'static str = match conv_out.error {
                None if question.is_some() => "waiting_agent",
                None => "completed",
                Some("CANCELLED") => "cancelled",
                Some(_) => "failed",
            };
            (
                EpisodeOutcome {
                    status,
                    content: conv_out.content,
                    tool_calls: conv_out.turns,
                    stop: json!({"status": status, "error": conv_out.error, "parentQuestion": question.map(|q| {
                        json!({"id": q.call_id, "text": q.question})
                    })}),
                    usage: conv_out.usage,
                    lifetime_usage: conv_out.lifetime_usage,
                    context_accounting: json!({}),
                },
                Some(conv_out.session_id),
            )
        };

        let at = now_iso();
        // Declare before the transition guard so even unwinding releases the lock before
        // verifier cleanup runs. Keep it registered through the final plan write.
        let verification;
        let mut transition = Some(self.transition_lock()?);
        if let Ok(mut updated) = self.read_plan(&plan_id) {
            if matches!(
                derive_session_status(&updated).as_str(),
                "accepted" | "cancelled" | "paused" | "superseded"
            ) {
                return Ok(outcome);
            }
            // A steer may arrive after the last provider response, but before
            // this episode acquires the state-transition lock. Keep that input
            // on the same Worker instead of settling an obsolete result.
            let origin = &updated["delegationOrigin"];
            let committed_already = origin["terminalEvent"]["payload"]["followUpEpoch"].as_u64()
                == Some(origin["followUpEpoch"].as_u64().unwrap_or(0))
                && matches!(
                    updated["status"].as_str(),
                    Some("completed" | "failed" | "cancelled" | "interrupted")
                );
            if committed_already {
                return Ok(outcome);
            }
            if outcome.status == "completed"
                && origin["pendingSteerEpoch"].as_u64()
                    == Some(origin["followUpEpoch"].as_u64().unwrap_or(0))
                && let Some(seq) = origin["pendingSteerSeq"].as_u64()
                && let Some(conversation) = worker_conv_id.as_deref()
                && self.load_worker_checkpoint(&updated)?.is_some()
                && !crate::read_full_conversation_messages(&self.conversations, conversation)?
                    .iter()
                    .any(|message| message["steerSeq"] == seq)
            {
                updated["delegationOrigin"]["continueWorkerConversation"] = json!(true);
                updated["delegationOrigin"]["phase"] = json!("queued");
                updated["runner"]["status"] = json!("running");
                updated["updatedAt"] = json!(at);
                self.write_plan(&updated)?;
                self.emit_event(
                    workspace_id,
                    "session_resumed",
                    session_id,
                    json!({"planId": plan_id}),
                );
                return Ok(outcome);
            }
            let turns_used = updated["delegationOrigin"]["workerTurnsUsed"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(outcome.tool_calls as u64);
            updated["delegationOrigin"]["workerTurnsUsed"] = json!(turns_used);
            updated["delegationOrigin"]["workerTurnLimit"] = json!(max_turns.max(1));
            if outcome.status == "waiting_agent" {
                if let Some(ref wcid) = worker_conv_id {
                    updated["delegationOrigin"]["workerConversationId"] = json!(wcid);
                }
                let question = &outcome.stop["parentQuestion"];
                updated["delegationOrigin"]["agentWaitMessageId"] = question["id"].clone();
                updated["delegationOrigin"]["agentWaitQuestion"] = question["text"].clone();
                updated["runner"]["status"] = json!("blocked");
                updated["runner"]["blockedReason"] = json!("waiting_parent_agent");
                updated["updatedAt"] = json!(at);
                self.write_plan(&updated)?;
                self.emit_event(
                    workspace_id,
                    "worker_question",
                    session_id,
                    json!({
                        "planId": plan_id,
                        "requestId": question["id"],
                        "question": question["text"],
                    }),
                );
                return Ok(outcome);
            }
            let mut final_status = match outcome.status {
                "completed" => "completed",
                "cancelled" => "cancelled",
                _ => "failed",
            };
            updated["updatedAt"] = json!(at);
            updated["delegationOrigin"]["lastWorkerOutput"] = json!(outcome.content);
            if let Some(ref wcid) = worker_conv_id {
                updated["delegationOrigin"]["workerConversationId"] = json!(wcid);
            }
            if updated["runner"]["status"] == "running" {
                updated["runner"]["status"] = json!(final_status);
            }
            updated["delegationOrigin"]["continueWorkerConversation"] = Value::Null;
            updated["delegationOrigin"]["followUpPrompt"] = Value::Null;
            if final_status == "failed"
                && outcome.stop["error"]
                    .as_str()
                    .is_some_and(autonomy::transient_worker_error)
                && self.load_worker_checkpoint(&updated)?.is_some()
            {
                final_status = "interrupted";
                if !updated["runner"].is_object() {
                    updated["runner"] = json!({});
                }
                updated["runner"]["interruption"] = json!({
                    "origin": "provider",
                    "source": "stream_error",
                    "reason": outcome.stop["error"],
                    "interruptedAt": at,
                    "recoverable": true,
                });
                updated["runner"]["status"] = json!("paused");
            }
            if final_status == "completed" {
                self.evaluate_deterministic_criteria(&mut updated);
                let mut ev_refs = self.indexed_evidence_refs_for_plan(&updated);
                let has_model_review = updated["successCriteria"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["kind"] == "model_review");
                // Read-only web evidence is unreadable by the independent
                // verifier; these sessions are delivered on the gate (ADR 137 D1).
                let verifier_not_required =
                    crate::acceptance::independent_verifier_not_required(&updated);
                if !verifier_not_required && (verifier_model.is_some() || has_model_review) {
                    // Keep plan status non-terminal while verifying so watchdog/UI
                    // never project premature `result_ready` or wake before verification ends.
                    updated["status"] = json!("executing");
                    updated["delegationOrigin"]["phase"] = json!("verifying");
                    let run_id = Self::record_verifier_run(&mut updated);
                    if !owns_lease() {
                        return Err(ProjectError::code("LEASE_REQUIRED"));
                    }
                    verification = self.register_verification(
                        workspace_id,
                        session_id,
                        &plan_id,
                        run_id.clone(),
                        cancel,
                        &owns_lease,
                    )?;
                    self.write_plan(&updated)?;
                    let started = updated.clone();
                    drop(transition.take());
                    let vmodel = verifier_model.unwrap_or(worker_model);
                    self.verify_plan(
                        &mut updated,
                        &mut ev_refs,
                        &run_id,
                        None,
                        vmodel,
                        verification.token(),
                    )
                    .await;
                    transition = Some(self.transition_lock()?);
                    if !owns_lease() {
                        return Err(ProjectError::code("LEASE_REQUIRED"));
                    }
                    if self.read_plan(&plan_id)? != started {
                        return Err(ProjectError::code("session_state_changed"));
                    }
                } else if verifier_not_required
                    && updated["delegationOrigin"]["independentVerifier"] != "failed"
                {
                    // A failed mechanical check keeps its repair path; nothing else
                    // claims an independent verdict that was never requested.
                    updated["delegationOrigin"]["independentVerifier"] = json!("not_required");
                }
                Self::complete_worker_plan(&mut updated, ev_refs);
            } else {
                updated["status"] = json!(final_status);
                updated["delegationOrigin"]["phase"] = json!(final_status);
                if final_status == "failed" {
                    let err_code = outcome.stop["error"]
                        .as_str()
                        .unwrap_or("WORKER_FAILED")
                        .to_owned();
                    updated["delegationOrigin"]["error"] = json!(err_code);
                    updated["failure"] = json!({
                        "code": err_code,
                        "message": err_code,
                        "at": at,
                    });
                }
                if final_status != "interrupted"
                    && let Some(tasks) = updated["tasks"].as_array_mut()
                {
                    for t in tasks.iter_mut() {
                        if !matches!(
                            t["status"].as_str(),
                            Some("completed" | "cancelled" | "failed")
                        ) {
                            t["status"] = json!(final_status);
                        }
                    }
                    let total = tasks.len();
                    let completed = tasks.iter().filter(|t| t["status"] == "completed").count();
                    let failed = tasks.iter().filter(|t| t["status"] == "failed").count();
                    let blocked = tasks.iter().filter(|t| t["status"] == "blocked").count();
                    updated["progress"] = json!({
                        "total": total,
                        "completed": completed,
                        "failed": failed,
                        "blocked": blocked,
                        "percent": (completed * 100).checked_div(total).unwrap_or(0),
                    });
                }
            }
            let _transition = transition;
            self.persist_terminal_transition(&mut updated, "worker")?;
        }
        Ok(outcome)
    }

    fn complete_worker_plan(plan: &mut Value, refs: HashSet<String>) {
        plan["status"] = json!("completed");
        plan["updatedAt"] = json!(now_iso());
        plan["delegationOrigin"]["phase"] = json!("completed");
        let mut refs: Vec<_> = refs.into_iter().collect();
        refs.sort();
        if !refs.is_empty() {
            plan["evidenceRefs"] = json!(refs);
        }
        if let Some(tasks) = plan["tasks"].as_array_mut() {
            for task in tasks.iter_mut() {
                task["status"] = json!("completed");
                if !refs.is_empty() {
                    task["evidenceRefs"] = json!(refs);
                }
            }
            let total = tasks.len();
            plan["progress"] = json!({
                "total": total,
                "completed": total,
                "failed": 0,
                "blocked": 0,
                "percent": if total > 0 { 100 } else { 0 },
            });
        }
    }

    /// Host-owned deterministic criterion evaluator (never trusts worker prose):
    /// checks confined `file-exists` and `file-contains` criteria on disk and registers
    /// host verification Evidence in `EvidenceIndexStore`.
    fn evaluate_deterministic_criteria(&self, plan: &mut Value) {
        let Some(plan_id) = plan["planId"].as_str().map(str::to_owned) else {
            return;
        };
        let Some(conv_id) = plan["conversationId"].as_str().map(str::to_owned) else {
            return;
        };
        let Some(ws_root) = plan["targetWorkspacePath"]
            .as_str()
            .or_else(|| plan["originWorkspacePath"].as_str())
            .map(PathBuf::from)
        else {
            return;
        };
        let Ok(canon_root) = fs::canonicalize(&ws_root) else {
            return;
        };
        let criteria = plan["successCriteria"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if criteria.is_empty() {
            return;
        }
        let evidence_store = EvidenceIndexStore::new(&self.data_home);
        let mut results = Vec::new();
        let mut deterministic_count = 0usize;
        let mut all_deterministic_passed = true;
        let mut has_manual = false;

        for (idx, c) in criteria.iter().enumerate() {
            let cid = c["id"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("c-{}", idx + 1));
            let kind = c["kind"].as_str().unwrap_or("manual");
            if kind == "manual" {
                has_manual = true;
                continue;
            }
            if !matches!(kind, "file-exists" | "file-contains") {
                continue;
            }
            deterministic_count += 1;
            let rel_path = c["path"].as_str().unwrap_or("").trim();
            let confined_target = resolve_confined_criterion_path(&ws_root, &canon_root, rel_path);
            let passed = match (kind, confined_target) {
                ("file-exists", Some(p)) => p.exists(),
                ("file-contains", Some(p)) => {
                    let needle = c["expect"].as_str().unwrap_or("");
                    !needle.is_empty()
                        && fs::read_to_string(&p)
                            .map(|body| body.contains(needle))
                            .unwrap_or(false)
                }
                _ => false,
            };
            if !passed {
                all_deterministic_passed = false;
            }
            let checked_at = now_iso();
            let call_id = format!("verify-{plan_id}-{cid}");
            let ev_id = format!("ev-{call_id}");
            let status_str = if passed { "success" } else { "failed" };
            let grant = json!({
                "grantId": format!("grant-{call_id}"),
                "toolCallId": call_id,
                "granted": true,
                "duration": "once",
                "scope": "local.verify.criterion",
                "decidedAt": checked_at,
            });
            let result_rec = json!({
                "toolCallId": call_id,
                "status": status_str,
                "completedAt": checked_at,
                "outputPreview": {"criterionId": cid, "kind": kind, "passed": passed},
                "evidence": {
                    "evidenceId": ev_id,
                    "toolCallId": call_id,
                    "summary": format!("host verify {kind} {rel_path}: {passed}"),
                    "artifactRefs": [],
                }
            });
            let registered = evidence_store
                .register(
                    &HostToolEvidence {
                        conversation_id: &conv_id,
                        plan_id: Some(&plan_id),
                        stream_id: Some("host-verifier"),
                        tool_name: "host_verify_criterion",
                        capability_id: "local.verify.criterion",
                        tool_call_id: &call_id,
                        grant: &grant,
                        result: &result_rec,
                    },
                    None,
                )
                .unwrap_or_default();
            let ev_refs: Vec<String> = registered
                .into_iter()
                .filter_map(|r| r["evidenceRef"].as_str().map(str::to_owned))
                .collect();
            let mut entry = json!({
                "criterionId": cid,
                "passed": passed,
                "status": if passed { "passed" } else { "failed" },
                "evidenceRefs": ev_refs,
                "checkedAt": checked_at,
            });
            if let Some(first_ref) = ev_refs.first() {
                entry["evidenceRef"] = json!(first_ref);
            }
            results.push(entry);
        }

        if !results.is_empty() {
            plan["criterionResults"] = json!(results);
        }
        if deterministic_count > 0 && !has_manual {
            plan["delegationOrigin"]["independentVerifier"] = json!(if all_deterministic_passed {
                "passed"
            } else {
                "failed"
            });
        }
    }

    pub fn indexed_evidence_refs(&self, plan_id: &str) -> HashSet<String> {
        let store = EvidenceIndexStore::new(&self.data_home);
        store
            .list_for_plan(plan_id, None)
            .unwrap_or_default()
            .into_iter()
            .filter_map(|row| row["evidenceRef"].as_str().map(str::to_owned))
            .collect()
    }

    pub fn indexed_evidence_refs_for_plan(&self, plan: &Value) -> HashSet<String> {
        let plan_id = plan["planId"]
            .as_str()
            .filter(|s| !peer_protocol::javascript_trim(s).is_empty() && s.len() <= 200);
        let conv_ids: Vec<&str> = [
            plan["conversationId"].as_str(),
            plan["delegationOrigin"]["workerConversationId"].as_str(),
            plan["delegationOrigin"]["verifierConversationId"].as_str(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !peer_protocol::javascript_trim(s).is_empty() && s.len() <= 200)
        .collect();
        EvidenceIndexStore::new(&self.data_home)
            .refs_for_plan_and_conversations(plan_id, &conv_ids, None)
            .unwrap_or_default()
    }

    /// Evaluate verification verdict + acceptance decision from canonical plan & host Evidence index,
    /// persisting `resultAcceptance` when either policy auto-accepts or user explicitly confirms.
    pub fn settle_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        reported: bool,
        user_confirm: bool,
        independent_verifier: Option<&str>,
        holds_lease: bool,
    ) -> Result<AcceptanceDecision, ProjectError> {
        self.settle_session_inner(
            workspace_id,
            session_id,
            reported,
            user_confirm,
            independent_verifier,
            holds_lease,
            None,
        )
    }

    pub(crate) fn settle_reported_revision(
        &self,
        workspace_id: &str,
        session_id: &str,
        revision: &str,
        holds_lease: bool,
    ) -> Result<AcceptanceDecision, ProjectError> {
        self.settle_session_inner(
            workspace_id,
            session_id,
            true,
            false,
            None,
            holds_lease,
            Some(revision),
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn settle_session_inner(
        &self,
        workspace_id: &str,
        session_id: &str,
        reported: bool,
        user_confirm: bool,
        independent_verifier: Option<&str>,
        holds_lease: bool,
        revision: Option<&str>,
    ) -> Result<AcceptanceDecision, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if revision.is_some_and(|expected| {
            plan["updatedAt"] != expected || derive_session_status(&plan) != "result_ready"
        }) {
            return Err(ProjectError::code("session_state_changed"));
        }
        if plan["delegationOrigin"]["phase"] == "verifying" {
            return Err(ProjectError::code("verifier_in_progress"));
        }
        if plan["delegationOrigin"]["supersededBy"].is_string() {
            return Err(ProjectError::code("session_superseded"));
        }
        let plan_id = plan["planId"].as_str().unwrap_or("").to_owned();
        let evidence = self.indexed_evidence_refs_for_plan(&plan);
        let profile = self.profiles.read(workspace_id);
        let policy = if let Some(oid) = plan["delegationOrigin"]["objectiveId"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            self.objective_acceptance_policy(workspace_id, oid)
        } else if profile
            .as_ref()
            .is_some_and(|p| p.acceptance_policy_str() == "confirm")
        {
            "confirm"
        } else {
            "auto"
        };
        let read_only = plan["delegationOrigin"]["readOnly"] == true;
        let changed_files = self.session_changed_files(&plan);
        let anchor_text = self.resolve_plan_anchor_text(&plan, None);
        let pending_manual_ids: Vec<String> = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|c| {
                let cid = c["id"].as_str().map(str::trim).filter(|s| !s.is_empty())?;
                (c["kind"].as_str() == Some("manual") && !is_manual_criterion_approved(&plan, cid))
                    .then(|| cid.to_owned())
            })
            .collect();
        let manual_pending = !pending_manual_ids.is_empty();
        let verifier_state = independent_verifier
            .map(str::to_owned)
            .or_else(|| {
                plan["delegationOrigin"]["independentVerifier"]
                    .as_str()
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| {
                if read_only {
                    "not_required".to_owned()
                } else {
                    "missing".to_owned()
                }
            });

        // Explicit local-user confirmation of a result_ready session also confirms any
        // pending `manual` DoD criteria once all mechanical/verifier gates have passed.
        if user_confirm
            && manual_pending
            && verifier_state != "failed"
            && crate::acceptance::evaluate_mechanical_close_gate(&plan, &evidence).0
        {
            let confirmed_at = now_iso();
            let mut confirmations = plan["manualConfirmations"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            confirmations.push(json!({
                "confirmationId": format!("confirm-result:{session_id}:{confirmed_at}"),
                "kind": "manual_dod",
                "decision": "approve",
                "criterionIds": pending_manual_ids,
                "confirmedBy": "user",
                "decidedAt": confirmed_at,
            }));
            plan["manualConfirmations"] = Value::Array(confirmations);
        }

        let decision = decide_session_acceptance(
            &AcceptanceFacts {
                plan: &plan,
                session_id,
                evidence_index: &evidence,
                host_authority: HostAuthorityFacts {
                    independent_verifier: Some(verifier_state.clone()),
                    verifier_model: plan["delegationOrigin"]["verifierModel"]
                        .as_str()
                        .map(str::to_owned),
                    same_family_as_worker: plan["delegationOrigin"]["sameFamilyAsWorker"].as_bool(),
                },
                policy,
                reported,
                read_only,
                changed_files,
                manual_criteria_pending: manual_pending,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text: &anchor_text,
                verification_below_floor: false,
            },
            user_confirm,
        );

        let already_accepted = plan["resultAcceptance"]["acceptedAt"].as_str().is_some();
        let at = now_iso();
        plan["delegationOrigin"]["independentVerifier"] = json!(verifier_state);
        if !already_accepted
            && derive_session_status(&plan) == "result_ready"
            && let Some(ref by) = decision.accepted_by
        {
            plan["resultAcceptance"] = json!({
                "acceptedAt": at,
                "acceptedBy": by,
                "verdictRef": decision.verdict_ref,
                "mode": decision.mode,
            });
            if plan["status"].as_str() == Some("completed") {
                plan["delegationOrigin"]["phase"] = json!("accepted");
            }
            plan["updatedAt"] = json!(at);
            self.write_plan(&plan)?;
            self.emit_event(
                workspace_id,
                "session_verified",
                session_id,
                json!({
                    "planId": plan_id,
                    "verdict": decision.verdict.outcome,
                    "acceptedBy": by,
                }),
            );
        }
        Ok(decision)
    }

    pub fn read_report(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<WorkSessionReport, ProjectError> {
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let evidence = self.indexed_evidence_refs_for_plan(&plan);
        let verdict = compute_verification_verdict(
            &plan,
            &evidence,
            &HostAuthorityFacts {
                independent_verifier: plan["delegationOrigin"]["independentVerifier"]
                    .as_str()
                    .map(str::to_owned),
                verifier_model: plan["delegationOrigin"]["verifierModel"]
                    .as_str()
                    .map(str::to_owned),
                same_family_as_worker: plan["delegationOrigin"]["sameFamilyAsWorker"].as_bool(),
            },
        );
        Ok(WorkSessionReport {
            summary: self.summarize(&plan),
            task_brief: plan["goal"].as_str().unwrap_or("").to_owned(),
            evidence_refs: verdict.evidence_refs,
            changed_files: self.session_changed_files(&plan),
            verdict_outcome: verdict.outcome,
            independent_verifier: verdict.independent_verifier,
            worker_output: plan["delegationOrigin"]["lastWorkerOutput"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
            pending_agent_question: plan["delegationOrigin"]["agentWaitMessageId"]
                .as_str()
                .and_then(|_| plan["delegationOrigin"]["agentWaitQuestion"].as_str())
                .map(str::to_owned),
            failure_code: plan["failure"]["code"]
                .as_str()
                .or_else(|| plan["delegationOrigin"]["error"].as_str())
                .map(str::to_owned),
            failure_detail: plan["failure"]["message"]
                .as_str()
                .or_else(|| plan["failure"]["detail"].as_str())
                .map(str::to_owned),
        })
    }

    fn session_changed_files(&self, plan: &Value) -> Vec<String> {
        let binding = &plan["deliveryBinding"];
        if binding["executionIsolation"] != "worktree" {
            return Vec::new();
        }
        let Some(wt) = binding["worktreePath"].as_str() else {
            return Vec::new();
        };
        let Some(ws) = binding["targetWorkspacePath"].as_str() else {
            return Vec::new();
        };
        let Some(baseline) = binding["baselineCommit"].as_str() else {
            return Vec::new();
        };
        let handle = WorktreeHandle {
            workspace_path: PathBuf::from(ws),
            worktree_path: PathBuf::from(wt),
            repository_root: PathBuf::from(ws),
            branch: binding["branch"].as_str().unwrap_or("").to_owned(),
            target_branch: binding["targetBranch"].as_str().unwrap_or("").to_owned(),
            baseline_commit: baseline.to_owned(),
        };
        self.worktrees.changed_files(&handle)
    }

    pub fn read_verification_detail(
        &self,
        workspace_id: &str,
        session_id: &str,
    ) -> Result<Value, ProjectError> {
        let plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let evidence = self.indexed_evidence_refs_for_plan(&plan);
        let verdict = compute_verification_verdict(
            &plan,
            &evidence,
            &HostAuthorityFacts {
                independent_verifier: plan["delegationOrigin"]["independentVerifier"]
                    .as_str()
                    .map(str::to_owned),
                verifier_model: plan["delegationOrigin"]["verifierModel"]
                    .as_str()
                    .map(str::to_owned),
                same_family_as_worker: plan["delegationOrigin"]["sameFamilyAsWorker"].as_bool(),
            },
        );
        Ok(json!({
            "sessionId": session_id,
            "planId": plan["planId"],
            "status": derive_session_status(&plan),
            "verdict": verdict,
            "criterionResults": plan["criterionResults"],
            "modelReviews": plan["modelReviews"],
            "verificationReport": plan["verificationReport"],
            "verifierModel": plan["delegationOrigin"]["verifierModel"],
            "sameFamilyAsWorker": plan["delegationOrigin"]["sameFamilyAsWorker"],
            "evidenceRefs": verdict.evidence_refs,
            "changedFiles": self.session_changed_files(&plan),
            "resultAcceptance": plan["resultAcceptance"],
            "deliveryHandoff": plan["deliveryHandoff"],
        }))
    }

    fn worktree_handle_from_plan(
        &self,
        plan: &Value,
    ) -> Result<Option<WorktreeHandle>, ProjectError> {
        let binding = &plan["deliveryBinding"];
        let Some(wt) = binding["worktreePath"].as_str().filter(|s| !s.is_empty()) else {
            return Ok(None);
        };
        let ws = binding["targetWorkspacePath"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
        Ok(Some(WorktreeHandle {
            workspace_path: PathBuf::from(ws),
            worktree_path: PathBuf::from(wt),
            repository_root: PathBuf::from(ws),
            branch: binding["branch"].as_str().unwrap_or("").to_owned(),
            target_branch: binding["targetBranch"].as_str().unwrap_or("").to_owned(),
            baseline_commit: binding["baselineCommit"].as_str().unwrap_or("").to_owned(),
        }))
    }

    pub fn handoff_worktree(
        &self,
        workspace_id: &str,
        session_id: &str,
        holds_lease: bool,
    ) -> Result<HandoffOutcome, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if plan["resultAcceptance"]["acceptedAt"].as_str().is_none() {
            return Ok(HandoffOutcome::Stopped {
                reason: "acceptance_required",
                detail: "session must be accepted before merging worktree".to_owned(),
            });
        }
        let Some(handle) = self.worktree_handle_from_plan(&plan)? else {
            return Ok(HandoffOutcome::NothingToMerge);
        };
        let outcome = self.worktrees.handoff_merge(&handle)?;
        let at = now_iso();
        plan["deliveryHandoff"] = match &outcome {
            HandoffOutcome::Merged { commit_sha } => json!({
                "status": "delivered",
                "commitSha": commit_sha,
                "updatedAt": at,
            }),
            HandoffOutcome::NothingToMerge => json!({
                "status": "nothing_to_merge",
                "updatedAt": at,
            }),
            HandoffOutcome::Stopped { reason, detail } => json!({
                "status": "stopped",
                "reason": reason,
                "detail": detail,
                "updatedAt": at,
            }),
        };
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(outcome)
    }

    pub fn discard_worktree(
        &self,
        workspace_id: &str,
        session_id: &str,
        holds_lease: bool,
    ) -> Result<bool, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let cleaned = match self.worktree_handle_from_plan(&plan)? {
            Some(handle) => self.worktrees.cleanup_if_clean(&handle).unwrap_or(false),
            None => false,
        };
        let at = now_iso();
        plan["deliveryHandoff"] = json!({
            "status": "discarded",
            "cleaned": cleaned,
            "updatedAt": at,
        });
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(cleaned)
    }

    pub fn resume_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        self.control_session(
            workspace_id,
            session_id,
            "resume",
            "user_resume",
            holds_lease,
        )
    }

    pub fn decide_plan_approval(
        &self,
        workspace_id: &str,
        approval_id: &str,
        approve: bool,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let rows = self.approvals.list(Some(workspace_id), None)?;
        let expected = rows
            .iter()
            .find(|r| r["approvalId"].as_str() == Some(approval_id))
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = expected["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let mut plan = self.read_plan(plan_id)?;
        let origin = &plan["delegationOrigin"];
        if origin["workspaceId"] != workspace_id
            || origin["phase"] != "awaiting_approval"
            || origin["planApprovalId"]
                .as_str()
                .is_some_and(|id| id != approval_id)
        {
            return Err(ProjectError::code("approval_scope_changed"));
        }
        let at = now_iso();
        let state = if approve {
            ApprovalState::Approved
        } else {
            ApprovalState::Denied
        };
        self.approvals.decide(
            expected,
            state,
            ApprovalDecision::LocalUser,
            &at,
            (!approve).then_some("local_user_denied"),
            None,
        )?;
        plan["approval"] = json!({
            "decision": state.as_str(),
            "approvalId": approval_id,
            "decidedAt": at,
            "decidedBy": "local_ui",
        });
        if approve {
            plan["status"] = json!("accepted");
            plan["delegationOrigin"]["phase"] = json!("queued");
        } else {
            plan["status"] = json!("cancelled");
            plan["delegationOrigin"]["phase"] = json!("cancelled");
            // A denied plan never started a worker and has no pending stop.
            plan["delegationOrigin"]["cancellation"] = json!({
                "operationId": uuid::Uuid::new_v4().to_string(),
                "phase": "completed",
                "reason": "plan_approval_denied",
                "requestedAt": at,
                "completedAt": at,
            });
        }
        plan["updatedAt"] = json!(at);
        if approve {
            self.write_plan(&plan)?;
        } else {
            self.persist_terminal_transition(&mut plan, "user")?;
        }
        Ok(self.summarize(&plan))
    }

    pub fn cancel_workspace_sessions(
        &self,
        workspace_id: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<Vec<String>, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut cancelled = Vec::new();
        for plan in self.list_workspace_plans(workspace_id) {
            let status = plan["status"].as_str().unwrap_or("");
            if matches!(status, "completed" | "failed" | "cancelled")
                || !plan["resultAcceptance"]["acceptedAt"].is_null()
            {
                continue;
            }
            let Some(sid) = plan["delegationOrigin"]["sessionId"].as_str() else {
                continue;
            };
            self.control_session(workspace_id, sid, "cancel", reason, holds_lease)?;
            cancelled.push(sid.to_owned());
        }
        Ok(cancelled)
    }

    /// Returns `true` when the session is already dead or failed verification (never active
    /// or passing work), so the project agent can autonomously retire/cancel it on wake turns
    /// without waiting for an explicit user cancel prompt.
    pub fn is_dead_or_invalid_session(&self, workspace_id: &str, session_id: &str) -> bool {
        let Some(plan) = self.find_plan_by_session(workspace_id, session_id) else {
            return false;
        };
        Self::is_dead_or_invalid_plan(&plan)
    }

    fn is_dead_or_invalid_plan(plan: &Value) -> bool {
        let origin = &plan["delegationOrigin"];
        if matches!(
            origin["cancellation"]["phase"].as_str(),
            Some("stopping" | "awaiting_outcome")
        ) || matches!(
            plan["runner"]["blockedReason"].as_str(),
            Some(
                "execution_outcome_unknown"
                    | "cancelled_outcome_unknown"
                    | "coordination_reconciliation_required"
            )
        ) {
            return false;
        }
        let status = derive_session_status(plan);
        if status == "failed" {
            return true;
        }
        if status == "result_ready"
            && (origin["independentVerifier"].as_str() == Some("failed")
                || plan["verificationReport"]["passed"].as_bool() == Some(false))
        {
            return true;
        }
        status == "cancelled" && origin["cancellation"]["phase"].as_str() != Some("completed")
    }

    pub fn control_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        action: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        self.control_session_with_origin(
            workspace_id,
            session_id,
            action,
            reason,
            holds_lease,
            false,
            false,
        )
    }

    pub(crate) fn cancel_session_by_agent(
        &self,
        workspace_id: &str,
        session_id: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        self.control_session_with_origin(
            workspace_id,
            session_id,
            "cancel",
            reason,
            holds_lease,
            false,
            true,
        )
    }

    pub(crate) fn cleanup_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        self.control_session_with_origin(
            workspace_id,
            session_id,
            "cancel",
            reason,
            holds_lease,
            true,
            true,
        )
    }

    #[allow(clippy::too_many_arguments)]
    fn control_session_with_origin(
        &self,
        workspace_id: &str,
        session_id: &str,
        action: &str,
        reason: &str,
        holds_lease: bool,
        bot_cleanup: bool,
        initiated_by_agent: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let _transition = self.transition_lock()?;
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if bot_cleanup {
            if plan["delegationOrigin"]["supersededBy"].is_string() {
                return Ok(self.summarize(&plan));
            }
            if !Self::is_dead_or_invalid_plan(&plan) {
                return Err(ProjectError::code("current_user_required"));
            }
        }
        let current = derive_session_status(&plan);
        if current == "verifying" && action != "cancel" {
            return Err(ProjectError::code("verifier_in_progress"));
        }
        if current == "accepted" || (action != "cancel" && current == "result_ready") {
            return Err(ProjectError::code("session_already_completed"));
        }
        if current == "cancelled"
            && plan["delegationOrigin"]["cancellation"]["phase"] == "completed"
        {
            return Ok(self.summarize(&plan));
        }
        let at = now_iso();
        match action {
            "pause" => {
                plan["delegationOrigin"]["phase"] = json!("paused");
                plan["updatedAt"] = json!(at);
            }
            "resume" => {
                plan["delegationOrigin"]["phase"] = json!("queued");
                if plan["status"] == "paused" {
                    plan["status"] = json!("accepted");
                }
                if matches!(
                    plan["runner"]["status"].as_str(),
                    Some("waiting_user" | "paused")
                ) {
                    plan["runner"]["status"] = json!("running");
                }
                plan["updatedAt"] = json!(at);
            }
            "cancel" => {
                if current == "verifying" {
                    Self::finish_verifier_run(&mut plan, "interrupted", Some("CANCELLED"));
                }
                plan["status"] = json!("cancelled");
                plan["delegationOrigin"]["phase"] = json!("cancelled");
                plan["delegationOrigin"]["cancellation"] = json!({
                    "operationId": uuid::Uuid::new_v4().to_string(),
                    "reason": reason,
                    "phase": "completed",
                    "requestedAt": at,
                    "completedAt": at,
                });
                if bot_cleanup {
                    plan["delegationOrigin"]["cancellation"]["initiator"] = json!("project_agent");
                } else {
                    plan["delegationOrigin"]["cancellation"]["disposition"] =
                        json!("user_withdrawn");
                }
                if plan["runner"].is_object() {
                    plan["runner"]["status"] = json!("cancelled");
                }
                plan["updatedAt"] = json!(at);
            }
            _ => return Err(ProjectError::code("invalid_action")),
        }
        if action == "cancel" {
            self.cancel_live_verification(session_id);
            self.persist_terminal_transition(
                &mut plan,
                if initiated_by_agent {
                    "project_agent"
                } else {
                    "user"
                },
            )?;
        } else {
            self.write_plan(&plan)?;
        }
        Ok(self.summarize(&plan))
    }

    pub fn reprioritize_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        priority: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if !matches!(priority, "high" | "normal" | "low") {
            return Err(ProjectError::code("invalid_priority"));
        }
        let _transition = self.transition_lock()?;
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        plan["delegationOrigin"]["priority"] = json!(priority);
        plan["updatedAt"] = json!(now_iso());
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    /// Startup recovery for an owned workspace: marks orphaned `open` approvals as `stale`/`expired`,
    /// reconciles scheduler queue, and runs native plan recovery on interrupted delegated plans.
    pub async fn recover_workspace(
        &self,
        workspace_id: &str,
        cancel: &CancellationToken,
        holds_lease: bool,
    ) -> Result<usize, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let at = now_iso();
        let mut plans = self.list_workspace_plans(workspace_id);
        self.recover_workspace_approvals(workspace_id, &mut plans, &at)?;
        let mut recovered = 0usize;
        let successors: HashMap<String, Value> = plans
            .iter()
            .filter_map(|plan| {
                let origin = &plan["delegationOrigin"];
                (origin["autonomousRetry"] == true || origin["startedFreshFollowUp"] == true)
                    .then_some(())?;
                Some((
                    origin["supersedes"].as_str()?.to_owned(),
                    origin["sessionId"].clone(),
                ))
            })
            .collect();
        for plan in &mut plans {
            {
                let _transition = self.transition_lock()?;
                if let Some(plan_id) = plan["planId"].as_str() {
                    *plan = self.read_plan(plan_id)?;
                }
                let event = &plan["delegationOrigin"]["terminalEvent"];
                if event["kind"] == "session_ended" && event["workspaceId"] == workspace_id {
                    self.inbox
                        .append(workspace_id, std::slice::from_ref(event))?;
                }
                if self.recover_verification(plan)? {
                    recovered += 1;
                    continue;
                }
            }
            if let Some(successor) = plan["delegationOrigin"]["sessionId"]
                .as_str()
                .and_then(|sid| successors.get(sid))
                && plan["delegationOrigin"]["supersededBy"].is_null()
                && matches!(
                    derive_session_status(plan).as_str(),
                    "result_ready" | "failed" | "accepted" | "interrupted"
                )
            {
                self.retire_replaced_session(plan, successor)?;
                recovered += 1;
            }
            let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
            let pid = plan["planId"].as_str().unwrap_or("").to_owned();
            if phase == "running" && !pid.is_empty() {
                if plan["delegationOrigin"]["coordinationBinding"].is_object() {
                    if recover_plan(&self.data_home, &pid, cancel).await.is_ok() {
                        recovered += 1;
                    }
                } else if plan["status"] == "executing"
                    && plan["delegationOrigin"]["agentWaitMessageId"].is_null()
                    && plan["runner"]["blockedReason"] != "waiting_parent_agent"
                {
                    plan["status"] = json!("accepted");
                    plan["delegationOrigin"]["phase"] = json!("queued");
                    plan["updatedAt"] = json!(&at);
                    if self.write_plan(plan).is_ok() {
                        recovered += 1;
                    }
                }
            }
        }
        let _ = self.scheduler.reconcile(workspace_id, &plans)?;
        Ok(recovered)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CreateBotProfile;
    use tempfile::tempdir;

    #[test]
    fn supervisor_spawns_approves_promotes_and_controls_sessions() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let convs = ConversationStore::new(dir.path());
        let at = now_iso();
        let parent = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Main Bot",
                    workspace_id: "ws-1",
                    workspace_path: ws.to_str(),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: &at,
                },
                None,
                None,
            )
            .unwrap();
        let parent_id = parent["id"].as_str().unwrap().to_owned();
        let profiles = BotProfileStore::new(dir.path());
        let (mut prof, _) = profiles
            .create(&CreateBotProfile {
                workspace_id: "ws-1",
                display_name: "Main Bot",
                managed: false,
                agent_conversation_id: &parent_id,
                avatar_salt: "",
            })
            .unwrap();
        prof.plan_approval = Some("writes".into());
        profiles.save(prof).unwrap();

        let sup = SessionSupervisor::new(dir.path(), Some(4));
        let spawned = sup
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: "ws-1".into(),
                    workspace_path: ws,
                    parent_conversation_id: parent_id,
                    anchor_message_ids: vec!["input-1".into()],
                    input_id: "1".into(),
                    surface: "tui".into(),
                    title: "Write hello".into(),
                    brief: "Create hello.txt".into(),
                    kind: "code".into(),
                    read_only: false,
                    required_capabilities: vec!["local.file.write".into()],
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "file-exists".into(),
                        description: "hello.txt exists".into(),
                        command: None,
                        path: Some("hello.txt".into()),
                        expect: None,
                    }],
                    priority: "high".into(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "none".into(),
                    worker_model_selection: json!({"providerId":"env","model":"test"}),
                },
                true,
            )
            .unwrap();
        assert_eq!(spawned.status, "waiting_user");
        let aid = spawned.approval_id.clone().unwrap();

        // Approve the plan -> moves to queued -> promote moves to running.
        let approved = sup.decide_plan_approval("ws-1", &aid, true, true).unwrap();
        assert_eq!(approved.phase, "queued");
        let promoted = sup.promote_queued("ws-1", true).unwrap();
        assert_eq!(promoted.start, vec![spawned.session_id.clone()]);

        // Cancel cleanly records cancellation.
        let cancelled = sup
            .control_session("ws-1", &spawned.session_id, "cancel", "user_stop", true)
            .unwrap();
        assert_eq!(cancelled.status, "cancelled");
    }

    #[test]
    fn contains_bytes_and_delegated_plan_cache_skip_non_delegated_and_track_updates() {
        assert!(contains_bytes(b"hello world", b""));
        assert!(contains_bytes(
            b"abc\"delegationOrigin\"xyz",
            b"\"delegationOrigin\""
        ));
        assert!(contains_bytes(
            b"\"delegationOrigin\"",
            b"\"delegationOrigin\""
        ));
        assert!(contains_bytes(b"aaabaaac", b"aaac"));
        assert!(!contains_bytes(b"short", b"longer-needle"));
        assert!(!contains_bytes(
            b"{\"status\":\"completed\"}",
            b"\"delegationOrigin\""
        ));

        let dir = tempdir().unwrap();
        let sup = SessionSupervisor::new(dir.path(), Some(1));
        let plans_dir = dir.path().join("goal-plans");
        fs::create_dir_all(&plans_dir).unwrap();

        // Seed 20 ordinary/non-delegated plans (one even intentionally unparseable as JSON
        // to prove the byte pre-filter skips JSON decoding completely when marker is absent)
        // plus 2 delegated plans across two workspaces.
        let mut index_lines = String::new();
        for i in 0..20 {
            let pid = format!("ord-{i}");
            let body = if i == 0 {
                "{not-valid-json-without-marker".to_owned()
            } else {
                serde_json::to_string(&json!({
                    "planId": pid,
                    "title": format!("Ordinary {i}"),
                    "status": "completed",
                    "updatedAt": "2026-11-20T00:00:00.000Z"
                }))
                .unwrap()
            };
            fs::write(plans_dir.join(format!("{pid}.json")), body).unwrap();
            index_lines.push_str(&format!("{{\"planId\":\"{pid}\"}}\n"));
        }

        let make_delegated =
            |pid: &str, ws: &str, sid: &str, status: &str, phase: &str, ts: &str| {
                json!({
                    "planId": pid,
                    "conversationId": format!("conv-{sid}"),
                    "title": format!("Task {sid}"),
                    "status": status,
                    "updatedAt": ts,
                    "delegationOrigin": {
                        "workspaceId": ws,
                        "sessionId": sid,
                        "phase": phase,
                        "readOnly": true,
                        "priority": "normal"
                    }
                })
            };

        fs::write(
            plans_dir.join("del-a.json"),
            serde_json::to_string(&make_delegated(
                "del-a",
                "ws-a",
                "sess-a",
                "running",
                "running",
                "2026-11-20T01:00:00.000Z",
            ))
            .unwrap(),
        )
        .unwrap();
        index_lines.push_str("{\"planId\":\"del-a\"}\n");

        fs::write(
            plans_dir.join("del-b.json"),
            serde_json::to_string(&make_delegated(
                "del-b",
                "ws-b",
                "sess-b",
                "completed",
                "completed",
                "2026-11-20T02:00:00.000Z",
            ))
            .unwrap(),
        )
        .unwrap();
        index_lines.push_str("{\"planId\":\"del-b\"}\n");
        fs::write(plans_dir.join("index.jsonl"), &index_lines).unwrap();

        let grouped = sup.list_all_bot_sessions();
        assert_eq!(grouped.len(), 2);
        assert_eq!(grouped["ws-a"].len(), 1);
        assert_eq!(grouped["ws-a"][0].session_id, "sess-a");
        assert_eq!(grouped["ws-a"][0].status, "running");
        assert_eq!(grouped["ws-b"].len(), 1);
        assert_eq!(grouped["ws-b"][0].status, "result_ready");

        // Out-of-process edit to existing delegated plan (even with index.jsonl unchanged and
        // altering byte length so file stamp changes reliably across coarse filesystems) is detected.
        fs::write(
            plans_dir.join("del-a.json"),
            serde_json::to_string_pretty(&make_delegated(
                "del-a",
                "ws-a",
                "sess-a",
                "completed",
                "completed",
                "2026-11-20T03:00:00.000Z",
            ))
            .unwrap(),
        )
        .unwrap();
        let ws_a_after = sup.list_bot_sessions("ws-a");
        assert_eq!(ws_a_after.len(), 1);
        assert_eq!(ws_a_after[0].status, "result_ready");

        // New delegated plan added to index.jsonl is picked up automatically.
        sup.write_plan(&make_delegated(
            "del-a2",
            "ws-a",
            "sess-a2",
            "running",
            "running",
            "2026-11-20T04:00:00.000Z",
        ))
        .unwrap();
        let ws_a_two = sup.list_bot_sessions("ws-a");
        assert_eq!(ws_a_two.len(), 2);
        assert_eq!(ws_a_two[0].session_id, "sess-a2");

        // Large (> 256 KiB) pretty-printed plan uses head+tail fast path and matches summarize(&Value).
        let filler: Vec<String> = (0..600)
            .map(|idx| format!("{idx:04}:{}", "x".repeat(512)))
            .collect();
        let large_pretty_val = json!({
            "planId": "del-large-pretty",
            "conversationId": "conv-large-pretty",
            "deliveryBinding": { "worktreePath": "/tmp/wt-large" },
            "title": "Large pretty task",
            "status": "in_progress",
            "runTrace": filler,
            "delegationOrigin": {
                "workspaceId": "ws-large",
                "sessionId": "sess-large-pretty",
                "phase": "running",
                "readOnly": false,
                "priority": "high",
                "planApprovalId": "appr-1"
            },
            "runner": { "status": "waiting_user" },
            "updatedAt": "2026-11-20T05:00:00.000Z"
        });
        let large_pretty_raw = serde_json::to_string_pretty(&large_pretty_val).unwrap();
        assert!(large_pretty_raw.len() as u64 > LARGE_PLAN_THRESHOLD);
        fs::write(plans_dir.join("del-large-pretty.json"), &large_pretty_raw).unwrap();

        // Large (> 256 KiB) single-line compact plan cleanly falls back to full-file PlanSummaryDoc.
        let large_compact_val = json!({
            "planId": "del-large-compact",
            "conversationId": "conv-large-compact",
            "title": "Large compact task",
            "status": "completed",
            "runTrace": filler,
            "delegationOrigin": {
                "workspaceId": "ws-large",
                "sessionId": "sess-large-compact",
                "phase": "completed",
                "readOnly": true,
                "priority": "normal"
            },
            "resultAcceptance": {
                "acceptedAt": "2026-11-20T06:01:00.000Z",
                "acceptedBy": "policy"
            },
            "updatedAt": "2026-11-20T06:00:00.000Z"
        });
        let large_compact_raw = serde_json::to_string(&large_compact_val).unwrap();
        assert!(large_compact_raw.len() as u64 > LARGE_PLAN_THRESHOLD);
        fs::write(plans_dir.join("del-large-compact.json"), &large_compact_raw).unwrap();

        let mut updated_index = fs::read_to_string(plans_dir.join("index.jsonl")).unwrap();
        updated_index.push_str("{\"planId\":\"del-large-pretty\"}\n");
        updated_index.push_str("{\"planId\":\"del-large-compact\"}\n");
        fs::write(plans_dir.join("index.jsonl"), updated_index).unwrap();

        let ws_large = sup.list_sessions("ws-large");
        assert_eq!(ws_large.len(), 2);
        assert_eq!(ws_large[0], sup.summarize(&large_compact_val));
        assert_eq!(ws_large[1], sup.summarize(&large_pretty_val));
    }

    #[test]
    fn list_bot_sessions_computes_completion_review_and_dependency_queue_reasons() {
        let dir = tempdir().unwrap();
        let plans_dir = dir.path().join("goal-plans");
        fs::create_dir_all(&plans_dir).unwrap();
        let convs = ConversationStore::new(dir.path());
        let child_conv = convs
            .create_project_conversation(
                &NewProjectConversation {
                    id: Some("conv-comp"),
                    title: "ManualTask",
                    workspace_id: "ws-s",
                    workspace_path: Some("/tmp/s"),
                    role: "work_session",
                    parent_conversation_id: Some("parent-s"),
                    mode: "goal",
                    created_at: "2026-11-22T00:00:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let cid = child_conv["id"].as_str().unwrap().to_owned();
        convs
            .append_classic_message(
                &cid,
                &json!({
                    "id": "worker-msg",
                    "role": "assistant",
                    "content": "Manual check ready"
                }),
            )
            .unwrap();

        let dep_failed_plan = json!({
            "planId": "p-dep",
            "conversationId": "conv-dep",
            "title": "Failed Dep",
            "status": "failed",
            "updatedAt": "2026-11-22T00:01:00.000Z",
            "delegationOrigin": {
                "workspaceId": "ws-s",
                "sessionId": "s-dep",
                "phase": "failed"
            }
        });
        let queued_blocked_plan = json!({
            "planId": "p-qblk",
            "conversationId": "conv-qblk",
            "title": "Blocked Child",
            "status": "executing",
            "updatedAt": "2026-11-22T00:02:00.000Z",
            "delegationOrigin": {
                "workspaceId": "ws-s",
                "sessionId": "s-qblk",
                "phase": "queued",
                "dependsOn": ["s-dep"]
            },
            "runner": { "status": "waiting_user", "blockedReason": "dependency_failed" }
        });
        let comp_plan = json!({
            "planId": "p-comp",
            "conversationId": cid,
            "title": "Manual DoD Task",
            "status": "executing",
            "updatedAt": "2026-11-22T00:03:00.000Z",
            "delegationOrigin": {
                "workspaceId": "ws-s",
                "sessionId": "s-comp",
                "phase": "running"
            },
            "runner": {
                "status": "blocked",
                "blockedReason": "manual_dod_confirmation_required"
            },
            "successCriteria": [
                { "id": "m1", "kind": "manual", "description": "Sign off" }
            ],
            "tasks": []
        });

        for p in [&dep_failed_plan, &queued_blocked_plan, &comp_plan] {
            let pid = p["planId"].as_str().unwrap();
            fs::write(
                plans_dir.join(format!("{pid}.json")),
                serde_json::to_string(p).unwrap(),
            )
            .unwrap();
        }
        fs::write(
            plans_dir.join("index.jsonl"),
            "{\"planId\":\"p-dep\"}\n{\"planId\":\"p-qblk\"}\n{\"planId\":\"p-comp\"}\n",
        )
        .unwrap();

        let sup = SessionSupervisor::new(dir.path(), Some(1));
        let rows = sup.list_bot_sessions("ws-s");
        assert_eq!(rows.len(), 3);
        let qblk = rows.iter().find(|r| r.session_id == "s-qblk").unwrap();
        assert_eq!(qblk.status, "waiting_user");
        assert_eq!(qblk.queue_reason.as_deref(), Some("dependency_failed"));
        let comp = rows.iter().find(|r| r.session_id == "s-comp").unwrap();
        assert_eq!(comp.status, "waiting_user");
        assert!(comp.completion_review_required);
    }

    struct DenyAllPermission;
    impl PermissionInput for DenyAllPermission {
        fn decide<'a>(
            &'a mut self,
            _prompt: Value,
            _cancel: &'a CancellationToken,
        ) -> std::pin::Pin<
            Box<
                dyn std::future::Future<
                        Output = peer_runtime::session_host::LocalPermissionDecision,
                    > + 'a,
            >,
        > {
            Box::pin(async { peer_runtime::session_host::LocalPermissionDecision::Deny })
        }
    }

    #[tokio::test]
    async fn missing_target_workspace_fails_session_cleanly_instead_of_hanging() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let sup = SessionSupervisor::new(dir.path(), Some(1));
        let missing_ws = dir.path().join("deleted-workspace");

        let spawned = sup
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: "ws-miss".into(),
                    workspace_path: ws.clone(),
                    parent_conversation_id: "conv-parent".into(),
                    anchor_message_ids: vec!["input-1".into()],
                    input_id: "1".into(),
                    surface: "desktop".into(),
                    kind: "ui".into(),
                    title: "Missing Workspace Task".into(),
                    brief: "Read files".into(),
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "model_review".into(),
                        description: "Done".into(),
                        command: None,
                        path: None,
                        expect: None,
                    }],
                    required_capabilities: vec!["read_file".into()],
                    depends_on: vec![],
                    priority: "normal".into(),
                    read_only: true,
                    isolation: "none".into(),
                    objective_id: None,
                    supersedes: None,
                    worker_model_selection: json!({ "modelProviderId": "m-1" }),
                },
                true,
            )
            .unwrap();
        sup.promote_queued("ws-miss", true).unwrap();

        let mut plan = sup.read_plan(&spawned.plan_id).unwrap();
        plan["targetWorkspacePath"] = json!(missing_ws);
        plan["originWorkspacePath"] = json!(missing_ws);
        sup.write_plan(&plan).unwrap();

        let dummy_model = peer_runtime::model::NativeModel::new(
            peer_runtime::model::ModelConfig {
                endpoint: "http://127.0.0.1:9/chat/completions".into(),
                model: "mock".into(),
                provider: "openai".into(),
                wire: peer_runtime::model::wire::Wire::Chat,
                generation: peer_runtime::model::wire::GenerationOptions::default(),
            },
            None,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let mut perm = DenyAllPermission;
        let cancel = CancellationToken::new();
        let err = sup
            .run_session_episode_with_verifier(
                "ws-miss",
                &spawned.session_id,
                &dummy_model,
                None,
                &mut perm,
                4,
                &cancel,
                true,
            )
            .await
            .err()
            .expect("missing target workspace should fail session");
        assert_eq!(err.code, "WORKSPACE_NOT_FOUND");

        let updated = sup.read_plan(&spawned.plan_id).unwrap();
        assert_eq!(updated["status"], "failed");
        assert_eq!(updated["delegationOrigin"]["phase"], "failed");
        assert_eq!(updated["failure"]["code"], "WORKSPACE_NOT_FOUND");
        assert_eq!(updated["tasks"][0]["status"], "failed");
        let events = sup.inbox.list_recent("ws-miss", 50);
        assert!(events.iter().any(|e| {
            e["kind"] == "session_ended"
                && e["sessionId"] == spawned.session_id
                && e["payload"]["status"] == "failed"
                && e["payload"]["failureCode"] == "WORKSPACE_NOT_FOUND"
        }));
    }

    #[tokio::test]
    async fn recover_workspace_requeues_orphaned_non_legacy_executing_session() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let sup = SessionSupervisor::new(dir.path(), Some(1));
        let spawned = sup
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: "ws-rec".into(),
                    workspace_path: ws.clone(),
                    parent_conversation_id: "conv-parent".into(),
                    anchor_message_ids: vec!["input-1".into()],
                    input_id: "1".into(),
                    surface: "desktop".into(),
                    kind: "ui".into(),
                    title: "Orphaned Worker".into(),
                    brief: "Inspect".into(),
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "model_review".into(),
                        description: "Done".into(),
                        command: None,
                        path: None,
                        expect: None,
                    }],
                    required_capabilities: vec!["read_file".into()],
                    depends_on: vec![],
                    priority: "normal".into(),
                    read_only: true,
                    isolation: "none".into(),
                    objective_id: None,
                    supersedes: None,
                    worker_model_selection: json!({ "modelProviderId": "m-1" }),
                },
                true,
            )
            .unwrap();
        sup.promote_queued("ws-rec", true).unwrap();
        let running = sup.read_plan(&spawned.plan_id).unwrap();
        assert_eq!(running["status"], "executing");
        assert_eq!(running["delegationOrigin"]["phase"], "running");

        let cancel = CancellationToken::new();
        let recovered = sup
            .recover_workspace("ws-rec", &cancel, true)
            .await
            .unwrap();
        assert_eq!(recovered, 1);

        let requeued = sup.read_plan(&spawned.plan_id).unwrap();
        assert_eq!(requeued["status"], "accepted");
        assert_eq!(requeued["delegationOrigin"]["phase"], "queued");

        let promoted = sup.promote_queued("ws-rec", true).unwrap();
        assert_eq!(promoted.start, vec![spawned.session_id]);
    }

    #[test]
    fn read_report_surfaces_failure_code_and_detail_for_failed_plan() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("workspace");
        fs::create_dir_all(&ws).unwrap();
        let sup = SessionSupervisor::new(dir.path(), Some(1));
        let spawned = sup
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: "ws-rep".into(),
                    workspace_path: ws,
                    parent_conversation_id: "conv-parent".into(),
                    anchor_message_ids: vec!["input-1".into()],
                    input_id: "1".into(),
                    surface: "desktop".into(),
                    kind: "ui".into(),
                    title: "Fail Report".into(),
                    brief: "Edit CSS".into(),
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "manual".into(),
                        description: "Done".into(),
                        command: None,
                        path: None,
                        expect: None,
                    }],
                    required_capabilities: vec!["local.file.write".into()],
                    depends_on: vec![],
                    priority: "normal".into(),
                    read_only: false,
                    isolation: "none".into(),
                    objective_id: None,
                    supersedes: None,
                    worker_model_selection: json!({}),
                },
                true,
            )
            .unwrap();
        sup.fail_session(
            "ws-rep",
            &spawned.session_id,
            "tool_not_projected",
            "tool_not_projected",
            true,
        )
        .unwrap();
        let report = sup.read_report("ws-rep", &spawned.session_id).unwrap();
        assert_eq!(report.failure_code.as_deref(), Some("tool_not_projected"));
        assert_eq!(report.failure_detail.as_deref(), Some("tool_not_projected"));
    }

    #[test]
    fn accepted_session_normalizes_stale_running_phase_and_settle_is_idempotent() {
        let dir = tempdir().unwrap();
        let plans_dir = dir.path().join("goal-plans");
        fs::create_dir_all(&plans_dir).unwrap();
        let plan = json!({
            "planId": "plan-idem",
            "conversationId": "conv-idem",
            "title": "Already Accepted Legacy",
            "status": "completed",
            "delegationOrigin": {
                "workspaceId": "ws-idem",
                "sessionId": "sess-idem",
                "phase": "running",
                "readOnly": true,
                "priority": "normal"
            },
            "resultAcceptance": {
                "acceptedAt": "2026-10-25T03:41:22.639Z",
                "acceptedBy": "policy",
                "verdictRef": "verdict:sess-idem:passed",
                "mode": "auto"
            },
            "updatedAt": "2026-10-25T03:41:22.639Z"
        });
        fs::write(
            plans_dir.join("plan-idem.json"),
            serde_json::to_string_pretty(&plan).unwrap(),
        )
        .unwrap();
        fs::write(
            plans_dir.join("index.jsonl"),
            "{\"planId\":\"plan-idem\"}\n",
        )
        .unwrap();

        let sup = SessionSupervisor::new(dir.path(), None);
        let summary_direct = sup.summarize(&plan);
        assert_eq!(summary_direct.status, "accepted");
        assert_eq!(summary_direct.phase, "accepted");

        let listed = sup.list_sessions("ws-idem");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].status, "accepted");
        assert_eq!(listed[0].phase, "accepted");

        let _ = sup
            .settle_session("ws-idem", "sess-idem", true, false, None, true)
            .unwrap();
        let after = sup.read_plan("plan-idem").unwrap();
        assert_eq!(
            after["resultAcceptance"]["acceptedAt"],
            "2026-10-25T03:41:22.639Z"
        );
        let inbox_path = dir.path().join("project-runtime/ws-idem/inbox.jsonl");
        let inbox_raw = fs::read_to_string(&inbox_path).unwrap_or_default();
        assert!(
            !inbox_raw.contains("session_verified"),
            "already-accepted plan must not emit duplicate session_verified wake event: {inbox_raw}"
        );
    }

    #[test]
    fn resolve_confined_criterion_path_handles_direct_unique_subrepo_ambiguous_and_escape() {
        let dir = tempdir().unwrap();
        let ws = dir.path().join("peer-dev");
        let repo_a = ws.join("Peer-Agent/apps/desktop");
        let repo_b = ws.join("Peer-Knowledge/docs");
        fs::create_dir_all(&repo_a).unwrap();
        fs::create_dir_all(&repo_b).unwrap();
        fs::write(ws.join("root.txt"), "root").unwrap();
        fs::write(repo_a.join("settings.css"), "padding: 12px;").unwrap();
        fs::write(ws.join("Peer-Agent/shared.md"), "a").unwrap();
        fs::write(ws.join("Peer-Knowledge/shared.md"), "b").unwrap();
        fs::write(dir.path().join("outside.txt"), "secret").unwrap();

        let canon_root = fs::canonicalize(&ws).unwrap();
        assert_eq!(
            resolve_confined_criterion_path(&ws, &canon_root, "root.txt"),
            Some(fs::canonicalize(ws.join("root.txt")).unwrap())
        );
        assert_eq!(
            resolve_confined_criterion_path(&ws, &canon_root, "apps/desktop/settings.css"),
            Some(fs::canonicalize(repo_a.join("settings.css")).unwrap())
        );
        assert_eq!(
            resolve_confined_criterion_path(&ws, &canon_root, "shared.md"),
            None,
            "ambiguous path present in multiple child repos must not guess"
        );
        assert_eq!(
            resolve_confined_criterion_path(&ws, &canon_root, "../outside.txt"),
            None,
            "path escaping workspace root must be rejected"
        );
    }
}

#[cfg(test)]
mod followup_tests;
