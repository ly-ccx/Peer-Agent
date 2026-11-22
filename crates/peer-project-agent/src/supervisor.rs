//! Delegated work-session supervisor: spawns canonical `GoalPlan`s + child conversations,
//! schedules slots/worktrees, drives worker episodes via `NativeSessionHost`, evaluates
//! host Evidence verdicts & policy/user acceptance, and emits canonical inbox events.
//!
//! Matches `packages/runtime-node/src/project-agent/session-supervisor.mjs` (ADR 80, 85, 88, 91, 103, 116).

use crate::{
    BotListSession, BotProfileStore, ObjectiveStore, ProjectError, ProjectInbox,
    acceptance::{
        AcceptanceDecision, AcceptanceFacts, HostAuthorityFacts, compute_verification_verdict,
        decide_session_acceptance,
    },
    atomic_write,
    memory::create_snapshot,
    now_iso,
    scheduler::{ExecutionScheduler, SelectionOutcome},
    sha256_json,
    verifier::{VerifierOutcome, resolve_work_session_profile, run_independent_verifier},
    worktree::{GoalWorktreeAdapter, HandoffOutcome, WorktreeHandle},
};
use peer_protocol::LocalAccessLevel;
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model::NativeModel,
    native_exec::{execute_plan, recover_plan},
    providers::RuntimeMode,
    session_host::{EpisodeOutcome, PermissionInput},
};
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, DirectoryLock,
    EvidenceIndexStore, HostApproval, HostToolEvidence, NewProjectConversation, PolicyStore,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    io::{self, Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{Duration, SystemTime},
};

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

fn summarize_doc(doc: &PlanSummaryDoc) -> Option<WorkSessionSummary> {
    let origin = doc.delegation_origin.as_ref()?;
    let workspace_id = origin
        .workspace_id
        .as_deref()
        .filter(|s| !s.is_empty())?
        .to_owned();
    let conversation_id = doc.conversation_id.clone().unwrap_or_default();
    let session_id = origin
        .session_id
        .clone()
        .unwrap_or_else(|| conversation_id.clone());
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
    Some(WorkSessionSummary {
        session_id,
        workspace_id,
        conversation_id,
        plan_id: doc.plan_id.clone().unwrap_or_default(),
        title: doc.title.clone().unwrap_or_default(),
        status: derive_doc_status(doc, origin),
        phase: origin.phase.clone().unwrap_or_else(|| "queued".to_owned()),
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
    pub worker_output: String,
}

pub struct SessionSupervisor {
    data_home: PathBuf,
    goal_plans_dir: PathBuf,
    conversations: ConversationStore,
    approvals: ApprovalStore,
    profiles: BotProfileStore,
    inbox: ProjectInbox,
    scheduler: ExecutionScheduler,
    worktrees: GoalWorktreeAdapter,
    plan_cache: Mutex<PlanIndexCache>,
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
    if confirmations
        .iter()
        .any(|c| c["criterionId"].as_str() == Some(criterion_id) && c["decision"] == "confirmed")
    {
        return true;
    }
    let mut matches: Vec<&Value> = confirmations
        .iter()
        .filter(|c| {
            c["kind"].as_str() == Some("manual_dod")
                && c["criterionIds"]
                    .as_array()
                    .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(criterion_id)))
        })
        .collect();
    matches.sort_by(|a, b| {
        let da = a["decidedAt"].as_str().unwrap_or("");
        let db = b["decidedAt"].as_str().unwrap_or("");
        db.cmp(da)
    });
    matches.first().and_then(|c| c["decision"].as_str()) == Some("approve")
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
            let Some(review) = reviews
                .iter()
                .rev()
                .find(|r| r["criterionId"].as_str() == Some(cid))
            else {
                return false;
            };
            let current =
                !source_rev.is_empty() && review["sourceRevision"].as_str() == Some(source_rev);
            let run_id = review["verifierRunId"].as_str().unwrap_or("");
            let verified = current
                && verifier_runs.iter().any(|run| {
                    run["verifierRunId"].as_str() == Some(run_id)
                        && run["status"].as_str() == Some("passed")
                });
            let evs: Vec<&str> = review["evidenceRefs"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .collect();
            if !verified
                || review["passed"] != true
                || evs.is_empty()
                || !evs.iter().all(|r| known_refs.contains(*r))
            {
                return false;
            }
            continue;
        }
        let is_auto = matches!(kind, "command" | "test" | "file-contains" | "file-exists");
        if !is_auto && is_manual_criterion_approved(plan, cid) {
            continue;
        }
        let Some(result) = results
            .iter()
            .find(|r| r["criterionId"].as_str() == Some(cid))
        else {
            return false;
        };
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
        if !single_ok && !multi_ok {
            return false;
        }
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
        let msgs = if let Ok(Some(page)) = self.conversations.read_conversation_window(
            &item.project_agent_conversation_id,
            None,
            None,
            true,
        ) {
            page["window"].as_array().cloned().unwrap_or_default()
        } else {
            self.conversations
                .read_committed(&item.project_agent_conversation_id, None, 4 * 1024 * 1024)
                .map(|s| s.history.messages)
                .unwrap_or_default()
        };
        let authorized = msgs.iter().any(|row| {
            row["id"].as_str() == Some(anchor_id)
                && row["role"].as_str() == Some("user")
                && row["kind"].as_str() == Some("user_input")
                && row["content"]
                    .as_str()
                    .is_some_and(authorizes_objective_auto_accept)
        });
        if authorized { "auto" } else { "confirm" }
    }

    pub(crate) fn compute_human_gate(&self, plan: &Value, summary: &WorkSessionSummary) -> bool {
        if plan["status"].as_str() != Some("completed") {
            return false;
        }
        if plan["runner"]["enabled"].as_bool() == Some(true)
            && plan["runner"]["status"].as_str() != Some("completed")
        {
            return false;
        }
        let evidence = self.indexed_evidence_refs_for_plan(plan);
        if !close_gate_passed_for_list(plan, &evidence) {
            return false;
        }
        let origin = &plan["delegationOrigin"];
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

        let anchor_id = origin["anchorMessageId"].as_str().unwrap_or("");
        let parent_conv_id = origin["parentConversationId"].as_str().unwrap_or("");
        let anchor_text = if !anchor_id.is_empty() && !parent_conv_id.is_empty() {
            self.conversations
                .read_committed(parent_conv_id, None, 4 * 1024 * 1024)
                .ok()
                .and_then(|snap| {
                    snap.history
                        .messages
                        .into_iter()
                        .find(|m| m["id"].as_str() == Some(anchor_id))
                        .and_then(|m| m["content"].as_str().map(str::to_owned))
                })
                .unwrap_or_default()
        } else {
            String::new()
        };

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
            if let Ok(Some(page)) = self.conversations.read_conversation_window(
                &summary.conversation_id,
                None,
                None,
                true,
            ) {
                page["window"].as_array().cloned().unwrap_or_default()
            } else {
                self.conversations
                    .read_committed(&summary.conversation_id, None, 8 * 1024 * 1024)
                    .map(|s| s.history.messages)
                    .unwrap_or_default()
            }
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
    ) -> BotListSession {
        let mut result_confirmation_required = None;
        let mut completion_review_required = false;
        let mut queue_reason = None;

        if summary.status == "result_ready" && !summary.accepted {
            result_confirmation_required = Some(match self.read_plan(&summary.plan_id) {
                Ok(plan) => self.compute_human_gate(&plan, &summary),
                Err(_) => true,
            });
        } else if summary.status == "waiting_user"
            && let Ok(plan) = self.read_plan(&summary.plan_id)
        {
            if summary.phase == "queued" {
                queue_reason =
                    Self::dependency_queue_reason(&plan, &summary.workspace_id, all_summaries);
            }
            completion_review_required = self.compute_completion_review_required(&plan, &summary);
        }

        BotListSession {
            session_id: summary.session_id,
            title: summary.title,
            status: summary.status,
            updated_at: Some(summary.updated_at),
            result_confirmation_required,
            completion_review_required,
            conversation_id: (!summary.conversation_id.is_empty())
                .then_some(summary.conversation_id),
            queue_reason,
        }
    }

    pub fn new(data_home: impl AsRef<Path>, concurrency: Option<usize>) -> Self {
        let home = data_home.as_ref().to_path_buf();
        Self {
            goal_plans_dir: home.join("goal-plans"),
            conversations: ConversationStore::new(&home),
            approvals: ApprovalStore::new(&home),
            profiles: BotProfileStore::new(&home),
            inbox: ProjectInbox::new(&home),
            scheduler: ExecutionScheduler::new(&home, concurrency),
            worktrees: GoalWorktreeAdapter::new(&home, None),
            data_home: home,
            plan_cache: Mutex::new(PlanIndexCache::default()),
        }
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
        if let Ok(Some(page)) =
            self.conversations
                .read_conversation_window(conversation_id, None, None, true)
        {
            page["window"].as_array().cloned().unwrap_or_default()
        } else {
            self.conversations
                .read_committed(conversation_id, None, 8 * 1024 * 1024)
                .map(|s| s.history.messages)
                .unwrap_or_default()
        }
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
        let mut grouped: HashMap<String, Vec<BotListSession>> = HashMap::new();
        for s in &summaries {
            if s.workspace_id.is_empty() {
                continue;
            }
            let ws_id = s.workspace_id.clone();
            grouped
                .entry(ws_id)
                .or_default()
                .push(self.to_bot_list_session(s.clone(), &summaries));
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
        WorkSessionSummary {
            session_id: origin["sessionId"]
                .as_str()
                .or_else(|| plan["conversationId"].as_str())
                .unwrap_or("")
                .to_owned(),
            workspace_id: origin["workspaceId"].as_str().unwrap_or("").to_owned(),
            conversation_id: plan["conversationId"].as_str().unwrap_or("").to_owned(),
            plan_id: plan["planId"].as_str().unwrap_or("").to_owned(),
            title: plan["title"].as_str().unwrap_or("").to_owned(),
            status: derive_session_status(plan),
            phase: origin["phase"].as_str().unwrap_or("queued").to_owned(),
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

    pub fn list_bot_sessions(&self, workspace_id: &str) -> Vec<BotListSession> {
        let all_summaries = self.all_delegated_summaries();
        let mut items: Vec<BotListSession> = all_summaries
            .iter()
            .filter(|s| s.workspace_id == workspace_id)
            .cloned()
            .map(|s| self.to_bot_list_session(s, &all_summaries))
            .collect();
        items.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        items
    }

    pub fn find_plan_by_session(&self, workspace_id: &str, session_id: &str) -> Option<Value> {
        self.list_workspace_plans(workspace_id)
            .into_iter()
            .find(|p| {
                p["delegationOrigin"]["sessionId"].as_str() == Some(session_id)
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
        if req.anchor_message_ids.is_empty()
            || req.title.trim().is_empty()
            || req.title.chars().count() > 60
            || req.brief.trim().is_empty()
            || req.brief.chars().count() > 4000
            || req.success_criteria.is_empty()
            || req.success_criteria.len() > 8
        {
            return Err(ProjectError::code("invalid_input"));
        }
        let at = now_iso();
        let snapshot = create_snapshot(&self.data_home, &req.workspace_id)?;
        let plan_id = format!("plan-{}", uuid::Uuid::new_v4());
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
                "createdAt": at,
            }),
            &at,
            None,
        )?;

        let use_worktree = !req.read_only
            && (req.isolation == "worktree"
                || (req.isolation == "auto"
                    && GoalWorktreeAdapter::is_git_repository(&req.workspace_path)));
        let delivery_binding = if use_worktree {
            match self
                .worktrees
                .prepare(&plan_id, &req.workspace_path, Some(&req.title))
            {
                Ok(handle) => json!({
                    "executionIsolation": "worktree",
                    "targetWorkspacePath": req.workspace_path,
                    "worktreePath": handle.worktree_path,
                    "branch": handle.branch,
                    "targetBranch": handle.target_branch,
                    "targetBranchSource": "workspace_head",
                    "baselineCommit": handle.baseline_commit,
                }),
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
            "memorySnapshotId": snapshot.snapshot_id,
            "priority": req.priority,
            "dependsOn": req.depends_on,
            "isolation": req.isolation,
            "phase": initial_phase,
            "executionGeneration": execution_generation,
            "depth": 1,
            "modelSelection": {
                "worker": req.worker_model_selection,
            }
        });
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

        // ADR 80: supersede old session ONLY after the replacement session is durably created.
        if let Some(ref old_sid) = req.supersedes
            && let Some(mut old_plan) = self.find_plan_by_session(&req.workspace_id, old_sid)
        {
            let old_status = derive_session_status(&old_plan);
            if !matches!(old_status.as_str(), "result_ready" | "accepted") {
                old_plan["delegationOrigin"]["phase"] = json!("paused");
                old_plan["delegationOrigin"]["supersededBy"] = json!(session_id);
                old_plan["delegationOrigin"]["supersededAt"] = json!(at);
                old_plan["updatedAt"] = json!(at);
                let _ = self.write_plan(&old_plan);
            }
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
            let outcome =
                execute_plan(&self.data_home, &plan_id, permission, max_turns, cancel).await?;
            (outcome, None)
        } else {
            let target_ws = plan["targetWorkspacePath"]
                .as_str()
                .or_else(|| plan["originWorkspacePath"].as_str())
                .map(PathBuf::from)
                .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
            let ws_access = PolicyStore::new(&self.data_home)
                .read_existing(workspace_id)
                .map(|p| p.access_level)
                .unwrap_or(LocalAccessLevel::SessionLocal);
            let session_profile = resolve_work_session_profile(&plan, "worker", ws_access)
                .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?;
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
            let mat_dir = self
                .data_home
                .join("project-runtime")
                .join(workspace_id)
                .join("session-attachments")
                .join(session_id);
            let anchor_ids: Vec<String> = plan["delegationOrigin"]["anchorMessageIds"]
                .as_array()
                .map(|arr| {
                    arr.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let image_paths: Vec<PathBuf> = if let (Some(parent_cid), false) = (
                plan["delegationOrigin"]["parentConversationId"].as_str(),
                anchor_ids.is_empty(),
            ) {
                self.conversations
                    .read_committed(parent_cid, None, 8 * 1024 * 1024)
                    .ok()
                    .and_then(|snap| {
                        crate::attachments::attachments_from_messages(
                            &snap.history.messages,
                            &anchor_ids,
                        )
                        .ok()
                    })
                    .and_then(|atts| {
                        crate::attachments::materialize_image_attachments(&mat_dir, &atts).ok()
                    })
                    .unwrap_or_default()
            } else {
                Vec::new()
            };
            let runtime = NativeConversationRuntime::new(
                &self.data_home,
                ConversationAccess::new(session_profile.access_level),
            );
            let conv_res = Box::pin(runtime.execute(
                &ConversationOptions {
                    workspace: &target_ws,
                    conversation_id: None,
                    resume_from: None,
                    prompt: &prompt,
                    image_paths: &image_paths,
                    provider_id: worker_model.provider(),
                    mode: RuntimeMode::Chat,
                    effort: "default",
                    persist_model_selection: false,
                    allowlist: Some(&session_profile.allowlist),
                    max_turns: Some(max_turns.max(1)),
                },
                worker_model,
                permission,
                cancel,
            ))
            .await;
            let _ = fs::remove_dir_all(&mat_dir);
            let conv_out = conv_res?;
            let status: &'static str = match conv_out.error {
                None => "completed",
                Some("CANCELLED") => "cancelled",
                Some(_) => "failed",
            };
            (
                EpisodeOutcome {
                    status,
                    content: conv_out.content,
                    tool_calls: conv_out.turns,
                    stop: json!({"status": status, "error": conv_out.error}),
                    usage: conv_out.usage,
                    lifetime_usage: conv_out.lifetime_usage,
                    context_accounting: json!({}),
                },
                Some(conv_out.session_id),
            )
        };

        let at = now_iso();
        if let Ok(mut updated) = self.read_plan(&plan_id) {
            let final_status = match outcome.status {
                "completed" => "completed",
                "cancelled" => "cancelled",
                _ => "failed",
            };
            updated["status"] = json!(final_status);
            updated["updatedAt"] = json!(at);
            updated["delegationOrigin"]["lastWorkerOutput"] = json!(outcome.content);
            if let Some(ref wcid) = worker_conv_id {
                updated["delegationOrigin"]["workerConversationId"] = json!(wcid);
            }
            if final_status == "completed" {
                self.evaluate_deterministic_criteria(&mut updated);
                let mut ev_refs = self.indexed_evidence_refs_for_plan(&updated);
                let has_model_review = updated["successCriteria"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["kind"] == "model_review");
                if verifier_model.is_some() || has_model_review {
                    updated["delegationOrigin"]["phase"] = json!("verifying");
                    let _ = self.write_plan(&updated);
                    let vmodel = verifier_model.unwrap_or(worker_model);
                    match Box::pin(run_independent_verifier(
                        &self.data_home,
                        &updated,
                        &ev_refs,
                        vmodel,
                        cancel,
                    ))
                    .await
                    {
                        Ok(VerifierOutcome::Verified {
                            report,
                            verifier_conversation_id,
                            verifier_model_id,
                            same_family_as_worker,
                            verifier_evidence_refs,
                        }) => {
                            updated["delegationOrigin"]["verifierConversationId"] =
                                json!(verifier_conversation_id);
                            updated["delegationOrigin"]["verifierModel"] = json!(verifier_model_id);
                            updated["delegationOrigin"]["sameFamilyAsWorker"] =
                                json!(same_family_as_worker);
                            updated["delegationOrigin"]["independentVerifier"] =
                                json!(if report.passed { "passed" } else { "failed" });
                            updated["verificationReport"] =
                                serde_json::to_value(&report).unwrap_or(Value::Null);
                            for r in verifier_evidence_refs {
                                ev_refs.insert(r);
                            }
                            let review_refs = if report.evidence_refs.is_empty() {
                                let mut all: Vec<String> = ev_refs.iter().cloned().collect();
                                all.sort();
                                all
                            } else {
                                report.evidence_refs.clone()
                            };
                            let verified_at = now_iso();
                            let reviews: Vec<Value> = updated["successCriteria"]
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter(|c| c["kind"] == "model_review")
                                .enumerate()
                                .map(|(idx, c)| {
                                    let cid = c["id"]
                                        .as_str()
                                        .map(str::to_owned)
                                        .unwrap_or_else(|| format!("c-{}", idx + 1));
                                    let explicitly_failed = report
                                        .failed_criteria
                                        .iter()
                                        .any(|fc| fc.criterion_id.as_deref() == Some(cid.as_str()));
                                    let passed = report.passed && !explicitly_failed;
                                    json!({
                                        "criterionId": cid,
                                        "passed": passed,
                                        "evidenceRefs": review_refs,
                                        "summary": report.summary,
                                        "verifierModel": verifier_model_id,
                                        "sameFamilyAsWorker": same_family_as_worker,
                                        "verifiedAt": verified_at,
                                    })
                                })
                                .collect();
                            if !reviews.is_empty() {
                                updated["modelReviews"] = json!(reviews);
                            }
                        }
                        Ok(VerifierOutcome::InvalidReport {
                            error,
                            summary,
                            verifier_conversation_id,
                        }) => {
                            if !verifier_conversation_id.is_empty() {
                                updated["delegationOrigin"]["verifierConversationId"] =
                                    json!(verifier_conversation_id);
                            }
                            updated["delegationOrigin"]["independentVerifier"] = json!("failed");
                            updated["verificationReport"] = json!({
                                "passed": false,
                                "error": error,
                                "summary": summary,
                            });
                        }
                        Err(err) => {
                            updated["delegationOrigin"]["independentVerifier"] = json!("failed");
                            updated["verificationReport"] = json!({
                                "passed": false,
                                "error": err.code,
                                "summary": err.detail,
                            });
                        }
                    }
                    updated["delegationOrigin"]["phase"] = json!("completed");
                }
                let mut list: Vec<String> = ev_refs.into_iter().collect();
                list.sort();
                if !list.is_empty() {
                    updated["evidenceRefs"] = json!(list);
                }
                if let Some(tasks) = updated["tasks"].as_array_mut() {
                    for t in tasks {
                        t["status"] = json!("completed");
                        if !list.is_empty() {
                            t["evidenceRefs"] = json!(list);
                        }
                    }
                }
            }
            let _ = self.write_plan(&updated);
            self.emit_event(
                workspace_id,
                if final_status == "completed" {
                    "report_available"
                } else {
                    "session_ended"
                },
                session_id,
                json!({"planId": plan_id, "status": final_status}),
            );
        }
        Ok(outcome)
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
            let candidate = ws_root.join(rel_path);
            let confined_target = fs::canonicalize(&candidate)
                .ok()
                .filter(|p| p.starts_with(&canon_root));
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
            results.push(json!({
                "criterionId": cid,
                "passed": passed,
                "status": if passed { "passed" } else { "failed" },
                "evidenceRefs": ev_refs,
                "checkedAt": checked_at,
            }));
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
        let mut refs = HashSet::new();
        let store = EvidenceIndexStore::new(&self.data_home);
        if let Some(plan_id) = plan["planId"].as_str() {
            for row in store.list_for_plan(plan_id, None).unwrap_or_default() {
                if let Some(r) = row["evidenceRef"].as_str() {
                    refs.insert(r.to_owned());
                }
            }
        }
        for conv_id in [
            plan["conversationId"].as_str(),
            plan["delegationOrigin"]["workerConversationId"].as_str(),
            plan["delegationOrigin"]["verifierConversationId"].as_str(),
        ]
        .into_iter()
        .flatten()
        {
            for row in store
                .list_for_conversation(conv_id, None)
                .unwrap_or_default()
            {
                if let Some(r) = row["evidenceRef"].as_str() {
                    refs.insert(r.to_owned());
                }
            }
        }
        refs
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
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"].as_str().unwrap_or("").to_owned();
        let evidence = self.indexed_evidence_refs_for_plan(&plan);
        let profile = self.profiles.read(workspace_id);
        let policy = profile
            .as_ref()
            .map(|p| p.acceptance_policy_str())
            .unwrap_or("auto");
        let read_only = plan["delegationOrigin"]["readOnly"] == true;
        let changed_files = self.session_changed_files(&plan);
        let anchor_text = plan["goal"].as_str().unwrap_or("");
        let manual_pending = plan["successCriteria"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|c| {
                let cid = c["id"].as_str().unwrap_or("");
                c["kind"] == "manual"
                    && !plan["manualConfirmations"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .any(|m| {
                            m["criterionId"].as_str() == Some(cid) && m["decision"] == "confirmed"
                        })
            });
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
                anchor_text,
                verification_below_floor: false,
            },
            user_confirm,
        );

        let at = now_iso();
        plan["delegationOrigin"]["independentVerifier"] = json!(verifier_state);
        if let Some(ref by) = decision.accepted_by {
            plan["resultAcceptance"] = json!({
                "acceptedAt": at,
                "acceptedBy": by,
                "verdictRef": decision.verdict_ref,
                "mode": decision.mode,
            });
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
        let rows = self.approvals.list(Some(workspace_id), None)?;
        let expected = rows
            .iter()
            .find(|r| r["approvalId"].as_str() == Some(approval_id))
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
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
        let plan_id = expected["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let mut plan = self.read_plan(plan_id)?;
        if approve {
            plan["status"] = json!("accepted");
            plan["approval"] = json!({
                "decision": "approved",
                "approvalId": approval_id,
                "decidedAt": at,
                "decidedBy": "local_ui",
            });
            plan["delegationOrigin"]["phase"] = json!("queued");
        } else {
            plan["status"] = json!("cancelled");
            plan["delegationOrigin"]["phase"] = json!("cancelled");
        }
        plan["updatedAt"] = json!(at);
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    pub fn control_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        action: &str,
        reason: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let current = derive_session_status(&plan);
        if matches!(current.as_str(), "result_ready" | "accepted") {
            return Err(ProjectError::code("session_already_completed"));
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
                if plan["runner"]["status"] == "waiting_user" {
                    plan["runner"]["status"] = json!("running");
                }
                plan["updatedAt"] = json!(at);
            }
            "cancel" => {
                plan["status"] = json!("cancelled");
                plan["delegationOrigin"]["phase"] = json!("cancelled");
                plan["delegationOrigin"]["cancellation"] = json!({
                    "operationId": uuid::Uuid::new_v4().to_string(),
                    "reason": reason,
                    "phase": "completed",
                    "requestedAt": at,
                    "completedAt": at,
                });
                plan["updatedAt"] = json!(at);
            }
            _ => return Err(ProjectError::code("invalid_action")),
        }
        self.write_plan(&plan)?;
        if action == "cancel" {
            self.emit_event(
                workspace_id,
                "session_ended",
                session_id,
                json!({"status": "cancelled", "reason": reason}),
            );
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
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        plan["delegationOrigin"]["priority"] = json!(priority);
        plan["updatedAt"] = json!(now_iso());
        self.write_plan(&plan)?;
        Ok(self.summarize(&plan))
    }

    pub fn message_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        text: &str,
        intent: &str,
        holds_lease: bool,
    ) -> Result<WorkSessionSummary, ProjectError> {
        if !holds_lease {
            return Err(ProjectError::code("LEASE_REQUIRED"));
        }
        if !matches!(intent, "answer" | "amend") || text.trim().is_empty() {
            return Err(ProjectError::code("invalid_input"));
        }
        let mut plan = self
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let status = derive_session_status(&plan);
        if matches!(
            status.as_str(),
            "accepted" | "cancelled" | "failed" | "superseded"
        ) {
            return Err(ProjectError::code("session_terminal"));
        }
        let conv_id = plan["conversationId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let at = now_iso();
        let content = if intent == "amend" {
            format!("来自项目代理转达：{text}")
        } else {
            text.to_owned()
        };
        self.conversations.append_message_idempotent(
            &conv_id,
            &json!({
                "id": format!("msg-{}", uuid::Uuid::new_v4()),
                "role": "user",
                "kind": if intent == "amend" { "user_correction" } else { "user_input" },
                "content": content,
                "createdAt": at,
            }),
            &at,
            None,
        )?;
        if plan["runner"]["status"] == "waiting_user" {
            plan["runner"]["status"] = json!("running");
            plan["delegationOrigin"]["phase"] = json!("queued");
        }
        plan["updatedAt"] = json!(at);
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
        let _ = self
            .approvals
            .recover_owned(Some(workspace_id), &at, None)?;
        let plans = self.list_workspace_plans(workspace_id);
        let _ = self.scheduler.reconcile(workspace_id, &plans)?;
        let mut recovered = 0usize;
        for plan in &plans {
            let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
            let pid = plan["planId"].as_str().unwrap_or("");
            if phase == "running"
                && !pid.is_empty()
                && recover_plan(&self.data_home, pid, cancel).await.is_ok()
            {
                recovered += 1;
            }
        }
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
}
