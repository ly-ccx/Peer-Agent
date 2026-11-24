//! Pure delegation stall detection, failure same-cause escalation, and stateful `WatchPublisher`
//! matching `packages/runtime-node/src/project-agent/{watchdog.mjs, event-mapper.mjs, watch-publisher.mjs}`.

use crate::parse_iso_ms;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::{HashMap, HashSet},
    sync::{Mutex, OnceLock},
};

pub const STALL_WINDOW_MS: i64 = 10 * 60 * 1000;
pub const SAME_CAUSE_RETRY_LIMIT: usize = 3;
pub const PROGRESS_THROTTLE_MS: i64 = 30_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StallAssessment {
    pub stalled: bool,
    pub stall_id: Option<String>,
    pub anchor: Option<String>,
    pub waiting: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FailureDescription {
    pub reason: String,
    pub last_error: String,
    pub summary: String,
    pub cause: String,
    pub cause_class: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SameCauseAssessment {
    pub task_key: String,
    pub cause: String,
    pub cause_class: String,
    pub count: usize,
    pub ask_user: bool,
    pub stop_auto_retry: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchSessionFacts {
    pub session_id: String,
    pub workspace_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
    pub version: String,
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub completed_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub result_revision: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_progress_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub progress_emitted_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stall_id: Option<String>,
    /// `(taskId, status, updatedAt)`
    #[serde(default)]
    pub leaves: Vec<(String, String, Option<String>)>,
    /// `(approvalId, kind)`
    #[serde(default)]
    pub needs_user: Vec<(String, String)>,
    #[serde(default)]
    pub last_error: String,
    #[serde(default)]
    pub interruption_reason: String,
    #[serde(default)]
    pub interruption_code: String,
    #[serde(default)]
    pub blocked_reason: String,
    #[serde(default)]
    pub recoverable_interruption_count: usize,
    #[serde(default)]
    pub failure_log: Vec<Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verdict_outcome: Option<String>,
    #[serde(default)]
    pub verdict_evidence_refs: Vec<String>,
}

/// Machine category classification matching `progress-policy.mjs#stableFailureClass`.
pub fn stable_failure_class(raw: &str) -> String {
    let text = raw.trim().to_lowercase();
    if text.is_empty() {
        return String::new();
    }
    static UUID_RE: OnceLock<Regex> = OnceLock::new();
    static HEX_RE: OnceLock<Regex> = OnceLock::new();
    static ISO_RE: OnceLock<Regex> = OnceLock::new();
    static CODE_RE: OnceLock<Regex> = OnceLock::new();
    static HTTP_RE: OnceLock<Regex> = OnceLock::new();
    static IDENT_RE: OnceLock<Regex> = OnceLock::new();

    let normalized = UUID_RE
        .get_or_init(|| Regex::new(r"[0-9a-f]{8}-[0-9a-f-]{27,}").unwrap())
        .replace_all(&text, "<id>");
    let normalized = HEX_RE
        .get_or_init(|| Regex::new(r"\b[0-9a-f]{16,}\b").unwrap())
        .replace_all(&normalized, "<hex>");
    let normalized = ISO_RE
        .get_or_init(|| Regex::new(r"\b\d{4}-\d{2}-\d{2}t[\d:.]+z\b").unwrap())
        .replace_all(&normalized, "<time>");

    if let Some(m) = CODE_RE
        .get_or_init(|| {
            Regex::new(r"\b(err_[a-z0-9_]+|econn[a-z_]+|e[an]oent|eacces|eaddrinuse|[a-z]+(?:_[a-z0-9]+)+)\b")
                .unwrap()
        })
        .find(&normalized)
    {
        return m.as_str().to_owned();
    }
    if normalized.contains("timeout")
        || normalized.contains("timed out")
        || normalized.contains("超时")
    {
        return "timeout".to_owned();
    }
    if normalized.contains("network")
        || normalized.contains("socket")
        || normalized.contains("网络")
        || normalized.contains("连接")
    {
        return "network".to_owned();
    }
    if normalized.contains("permission")
        || normalized.contains("denied")
        || normalized.contains("授权")
        || normalized.contains("权限")
    {
        return "permission".to_owned();
    }
    if normalized.contains("bind") || normalized.contains("端口被占用") {
        return "binding_failed".to_owned();
    }
    if let Some(m) = HTTP_RE
        .get_or_init(|| Regex::new(r"\b(401|403|429|500|502|503|504)\b").unwrap())
        .find(&normalized)
    {
        return format!("http_{}", m.as_str());
    }
    if IDENT_RE
        .get_or_init(|| Regex::new(r"^[a-z][a-z0-9_.:-]{0,79}$").unwrap())
        .is_match(&normalized)
    {
        normalized.into_owned()
    } else {
        "unclassified_failure".to_owned()
    }
}

fn normalize_cause(text: &str) -> String {
    let trimmed = text.trim().to_lowercase();
    if trimmed.is_empty() {
        return String::new();
    }
    trimmed
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .chars()
        .take(240)
        .collect()
}

fn derive_plan_status(plan: &Value) -> String {
    if plan["delegationOrigin"]["supersededBy"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return "superseded".to_owned();
    }
    if plan["resultAcceptance"]["acceptedAt"]
        .as_str()
        .is_some_and(|s| !s.is_empty())
    {
        return "accepted".to_owned();
    }
    if !matches!(plan["status"].as_str(), Some("cancelled" | "failed"))
        && plan["delegationOrigin"]["phase"].as_str() == Some("verifying")
    {
        return "verifying".to_owned();
    }
    match plan["status"].as_str().unwrap_or("") {
        "cancelled" => "cancelled".to_owned(),
        "failed" => "failed".to_owned(),
        "interrupted" => "interrupted".to_owned(),
        "completed" => "result_ready".to_owned(),
        "awaiting_approval" => "waiting_user".to_owned(),
        _ => match plan["delegationOrigin"]["phase"]
            .as_str()
            .unwrap_or("queued")
        {
            "paused" => "paused".to_owned(),
            "awaiting_approval" => "waiting_user".to_owned(),
            "verifying" => "verifying".to_owned(),
            "running" => {
                if plan["runner"]["status"] == "waiting_user" {
                    "waiting_user".to_owned()
                } else {
                    "running".to_owned()
                }
            }
            "starting" => "starting".to_owned(),
            _ => "queued".to_owned(),
        },
    }
}

fn collect_leaves(tasks: &[Value], out: &mut Vec<(String, String, Option<String>)>) {
    for task in tasks {
        if !task.is_object() {
            continue;
        }
        if let Some(sub) = task["subtasks"].as_array().filter(|s| !s.is_empty()) {
            collect_leaves(sub, out);
            continue;
        }
        let Some(tid) = task["taskId"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        let status = match task["status"].as_str() {
            Some("completed") => "completed",
            Some(s) if !s.trim().is_empty() => s.trim(),
            _ => "pending",
        };
        let updated_at = task["updatedAt"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        out.push((tid.to_owned(), status.to_owned(), updated_at));
    }
}

fn terminal_verifier_revision(plan: &Value) -> Option<String> {
    if let Some(runs) = plan["runner"]["verifierRuns"].as_array()
        && let Some(latest) = runs.last()
        && matches!(latest["status"].as_str(), Some("passed" | "failed"))
        && let Some(ended) = latest["completedAt"]
            .as_str()
            .or_else(|| latest["updatedAt"].as_str())
            .filter(|s| !s.is_empty())
    {
        return Some(format!(
            "{}:{ended}",
            latest["status"].as_str().unwrap_or("")
        ));
    }
    if plan["verificationReport"].is_object() {
        let passed = plan["verificationReport"]["passed"]
            .as_bool()
            .unwrap_or(false);
        let updated = plan["updatedAt"].as_str().unwrap_or("");
        if !updated.is_empty() {
            return Some(format!("report:{passed}:{updated}"));
        }
    }
    None
}

pub fn watch_facts_from_plan(plan: &Value) -> Option<WatchSessionFacts> {
    let origin = plan["delegationOrigin"].as_object()?;
    let session_id = origin
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())?
        .to_owned();
    let workspace_id = origin
        .get("workspaceId")
        .and_then(Value::as_str)
        .map(str::trim)
        .unwrap_or("")
        .to_owned();
    let status = derive_plan_status(plan);
    let mut leaves = Vec::new();
    if let Some(tasks) = plan["tasks"].as_array() {
        collect_leaves(tasks, &mut leaves);
    }
    let last_progress_at = leaves
        .iter()
        .filter(|(_, st, _)| st == "completed")
        .filter_map(|(_, _, at)| at.as_ref().and_then(|s| parse_iso_ms(s).map(|ms| (ms, s))))
        .max_by_key(|(ms, _)| *ms)
        .map(|(_, s)| s.clone())
        .or_else(|| {
            plan["progressEmittedAt"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
        });
    let mut needs_user = Vec::new();
    if origin.get("phase").and_then(Value::as_str) == Some("awaiting_approval") {
        let aid = origin
            .get("planApprovalId")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("{session_id}:plan_approval"));
        needs_user.push((aid, "plan_approval".to_owned()));
    } else if status == "waiting_user" {
        needs_user.push((format!("{session_id}:question"), "question".to_owned()));
    }
    let completed_at = if status == "result_ready" {
        plan["timing"]["completedAt"]
            .as_str()
            .or_else(|| plan["updatedAt"].as_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
    } else {
        None
    };
    let mut failure_log = plan["failureLog"].as_array().cloned().unwrap_or_default();
    if failure_log.is_empty()
        && let Some(events) = plan["runTrace"]["events"].as_array()
    {
        for ev in events {
            if matches!(
                ev["type"].as_str(),
                Some("step_failed" | "network_interrupted")
            ) {
                let reason = ev["payload"]["reason"]
                    .as_str()
                    .or_else(|| ev["payload"]["message"].as_str())
                    .unwrap_or("");
                if !reason.is_empty() {
                    failure_log.push(json!({
                        "taskId": plan["runner"]["currentTaskId"],
                        "planId": plan["planId"],
                        "sessionId": session_id,
                        "cause": reason,
                    }));
                }
            }
        }
    }

    let verdict_outcome = origin
        .get("independentVerifier")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let verdict_evidence_refs = plan["verificationReport"]["evidenceRefs"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(Value::as_str)
                .take(20)
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default();

    Some(WatchSessionFacts {
        workspace_id,
        plan_id: plan["planId"].as_str().map(str::to_owned),
        task_id: plan["runner"]["currentTaskId"].as_str().map(str::to_owned),
        version: plan["updatedAt"]
            .as_str()
            .or_else(|| plan["planId"].as_str())
            .unwrap_or(&session_id)
            .to_owned(),
        session_id,
        status,
        completed_at,
        result_revision: terminal_verifier_revision(plan),
        started_at: plan["createdAt"]
            .as_str()
            .or_else(|| origin.get("createdAt").and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
        last_progress_at,
        progress_emitted_at: None,
        stall_id: None,
        leaves,
        needs_user,
        last_error: plan["runner"]["lastError"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned(),
        interruption_reason: plan["runner"]["interruption"]["reason"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned(),
        interruption_code: plan["runner"]["interruption"]["code"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned(),
        blocked_reason: plan["runner"]["blockedReason"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_owned(),
        recoverable_interruption_count: plan["runner"]["recoverableInterruptionCount"]
            .as_u64()
            .unwrap_or(0) as usize,
        failure_log,
        verdict_outcome,
        verdict_evidence_refs,
    })
}

pub fn delegation_facts_for_workspace(
    plans: &[Value],
    workspace_id: &str,
) -> Vec<WatchSessionFacts> {
    plans
        .iter()
        .filter(|p| p["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id))
        .filter_map(watch_facts_from_plan)
        .collect()
}

fn waiting_on_user(session: &WatchSessionFacts) -> bool {
    if session.status == "waiting_user" {
        return true;
    }
    session
        .needs_user
        .iter()
        .any(|(_, k)| matches!(k.as_str(), "approval" | "question" | "plan_approval"))
}

fn progress_anchor(session: &WatchSessionFacts) -> Option<(i64, String)> {
    let candidates = [
        session.last_progress_at.as_deref(),
        session.progress_emitted_at.as_deref(),
        session.started_at.as_deref(),
    ];
    for c in candidates.into_iter().flatten() {
        if let Some(ms) = parse_iso_ms(c) {
            return Some((ms, c.trim().to_owned()));
        }
    }
    None
}

pub fn assess_stall(session: &WatchSessionFacts, now_ms: i64, window_ms: i64) -> StallAssessment {
    let window = window_ms.max(0);
    if session.session_id.is_empty() {
        return StallAssessment {
            stalled: false,
            stall_id: None,
            anchor: None,
            waiting: false,
        };
    }
    if session.status == "result_ready" {
        if waiting_on_user(session) {
            return StallAssessment {
                stalled: false,
                stall_id: None,
                anchor: None,
                waiting: true,
            };
        }
        if session.verdict_outcome.as_deref() == Some("failed") {
            return StallAssessment {
                stalled: false,
                stall_id: None,
                anchor: None,
                waiting: false,
            };
        }
        let Some(anchor_str) = session.completed_at.as_deref() else {
            return StallAssessment {
                stalled: false,
                stall_id: None,
                anchor: None,
                waiting: false,
            };
        };
        let Some(anchor_ms) = parse_iso_ms(anchor_str) else {
            return StallAssessment {
                stalled: false,
                stall_id: None,
                anchor: None,
                waiting: false,
            };
        };
        if now_ms - anchor_ms < window {
            return StallAssessment {
                stalled: false,
                stall_id: None,
                anchor: None,
                waiting: false,
            };
        }
        let rev = session
            .result_revision
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(anchor_str);
        return StallAssessment {
            stalled: true,
            stall_id: Some(format!("stall:verify:{}:{rev}", session.session_id)),
            anchor: Some("verification_pending".to_owned()),
            waiting: false,
        };
    }

    if !matches!(session.status.as_str(), "running" | "verifying") {
        return StallAssessment {
            stalled: false,
            stall_id: None,
            anchor: None,
            waiting: false,
        };
    }
    if waiting_on_user(session) {
        return StallAssessment {
            stalled: false,
            stall_id: None,
            anchor: None,
            waiting: true,
        };
    }
    let Some((anchor_ms, token)) = progress_anchor(session) else {
        return StallAssessment {
            stalled: false,
            stall_id: None,
            anchor: None,
            waiting: false,
        };
    };
    if now_ms - anchor_ms < window {
        return StallAssessment {
            stalled: false,
            stall_id: None,
            anchor: Some(token),
            waiting: false,
        };
    }
    StallAssessment {
        stalled: true,
        stall_id: Some(format!("stall:{}:{token}", session.session_id)),
        anchor: Some(token),
        waiting: false,
    }
}

pub fn describe_failure(session: &WatchSessionFacts) -> FailureDescription {
    let reason = if !session.interruption_reason.is_empty() {
        session.interruption_reason.clone()
    } else {
        session.blocked_reason.clone()
    };
    let last_error = session.last_error.clone();
    let mut parts = Vec::new();
    if !reason.is_empty() {
        parts.push(reason.clone());
    }
    if !last_error.is_empty() && last_error != reason {
        parts.push(last_error.clone());
    }
    let raw_cause = if !reason.is_empty() {
        reason.as_str()
    } else {
        last_error.as_str()
    };
    let class_src = if !session.interruption_code.is_empty() {
        session.interruption_code.as_str()
    } else {
        raw_cause
    };
    FailureDescription {
        cause: normalize_cause(raw_cause),
        cause_class: stable_failure_class(class_src),
        reason,
        last_error,
        summary: parts.join("；"),
    }
}

fn task_key_of(session: &WatchSessionFacts) -> String {
    if let Some(ref t) = session.task_id
        && !t.is_empty()
    {
        return t.clone();
    }
    if let Some(ref p) = session.plan_id
        && !p.is_empty()
    {
        return p.clone();
    }
    session.session_id.clone()
}

pub fn assess_same_cause(
    session: &WatchSessionFacts,
    failure_opt: Option<&FailureDescription>,
) -> SameCauseAssessment {
    let owned_failure;
    let failure = match failure_opt {
        Some(f) => f,
        None => {
            owned_failure = describe_failure(session);
            &owned_failure
        }
    };
    let cause = normalize_cause(&failure.cause);
    let task_key = task_key_of(session);
    let cause_class = stable_failure_class(if !failure.cause_class.is_empty() {
        &failure.cause_class
    } else {
        &cause
    });
    if cause.is_empty() {
        return SameCauseAssessment {
            task_key,
            cause: String::new(),
            cause_class,
            count: 0,
            ask_user: false,
            stop_auto_retry: false,
        };
    }

    let mut count = 1usize;
    if !session.failure_log.is_empty() {
        for entry in &session.failure_log {
            let entry_key = entry["taskId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| entry["planId"].as_str().filter(|s| !s.is_empty()))
                .or_else(|| entry["sessionId"].as_str().filter(|s| !s.is_empty()))
                .unwrap_or("");
            if !entry_key.is_empty() && entry_key != task_key {
                continue;
            }
            let entry_class = entry["causeClass"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(stable_failure_class)
                .unwrap_or_else(|| {
                    stable_failure_class(
                        entry["cause"]
                            .as_str()
                            .or_else(|| entry["reason"].as_str())
                            .or_else(|| entry["lastError"].as_str())
                            .unwrap_or(""),
                    )
                });
            if entry_class == cause_class {
                count += 1;
            }
        }
    } else if session.recoverable_interruption_count > 0 {
        count += session.recoverable_interruption_count;
    }

    let ask_user = count >= SAME_CAUSE_RETRY_LIMIT;
    SameCauseAssessment {
        task_key,
        cause,
        cause_class,
        count,
        ask_user,
        stop_auto_retry: ask_user,
    }
}

pub fn delegation_event_id(session_id: &str, kind: &str, token: &str) -> String {
    let material = format!("{session_id}\0{kind}\0{token}");
    format!("{:x}", Sha256::digest(material.as_bytes()))
}

pub struct WatchPublisher {
    snapshots: Mutex<HashMap<String, HashMap<String, WatchSessionFacts>>>,
}

impl Default for WatchPublisher {
    fn default() -> Self {
        Self::new()
    }
}

impl WatchPublisher {
    pub fn new() -> Self {
        Self {
            snapshots: Mutex::new(HashMap::new()),
        }
    }

    pub fn forget(&self, workspace_id: &str) {
        if let Ok(mut g) = self.snapshots.lock() {
            g.remove(workspace_id);
        }
    }

    pub fn next_delay_ms(
        &self,
        workspace_id: &str,
        now_ms: i64,
        poll_ms: i64,
        min_ms: i64,
        window_ms: i64,
    ) -> i64 {
        let mut delay = poll_ms.max(min_ms);
        let Ok(g) = self.snapshots.lock() else {
            return delay;
        };
        let Some(sessions) = g.get(workspace_id) else {
            return delay;
        };
        for s in sessions.values() {
            if s.status == "result_ready" {
                if let Some(ref completed) = s.completed_at
                    && let Some(ms) = parse_iso_ms(completed)
                {
                    let rem = ms + window_ms - now_ms;
                    if rem > 0 {
                        delay = delay.min(rem);
                    }
                }
                continue;
            }
            if !matches!(s.status.as_str(), "running" | "verifying") || waiting_on_user(s) {
                continue;
            }
            if let Some((anchor_ms, _)) = progress_anchor(s) {
                let rem = anchor_ms + window_ms - now_ms;
                if rem > 0 {
                    delay = delay.min(rem);
                }
            }
        }
        delay.max(min_ms)
    }

    pub fn publish(
        &self,
        workspace_id: &str,
        plans: &[Value],
        at_iso: &str,
        window_ms: Option<i64>,
    ) -> Vec<Value> {
        let now_ms = parse_iso_ms(at_iso).unwrap_or(0);
        let win = window_ms.unwrap_or(STALL_WINDOW_MS);
        let mut current_list = delegation_facts_for_workspace(plans, workspace_id);
        let mut events = Vec::new();
        let Ok(mut guard) = self.snapshots.lock() else {
            return events;
        };
        let prior_map = guard.entry(workspace_id.to_owned()).or_default();

        for curr in &mut current_list {
            let prior = prior_map.get(&curr.session_id);
            let mut progressed = false;

            // Progress diff on newly completed leaves (throttled per session)
            if let Some(prev) = prior {
                let prev_done: HashSet<&str> = prev
                    .leaves
                    .iter()
                    .filter(|(_, st, _)| st == "completed")
                    .map(|(id, _, _)| id.as_str())
                    .collect();
                let mut fresh: Vec<String> = curr
                    .leaves
                    .iter()
                    .filter(|(id, st, _)| st == "completed" && !prev_done.contains(id.as_str()))
                    .map(|(id, _, _)| id.clone())
                    .collect();
                fresh.sort();
                if !fresh.is_empty() {
                    let throttled = prev
                        .progress_emitted_at
                        .as_deref()
                        .and_then(parse_iso_ms)
                        .is_some_and(|ms| now_ms.saturating_sub(ms) < PROGRESS_THROTTLE_MS);
                    if !throttled {
                        let tok = fresh.join(",");
                        events.push(json!({
                            "eventId": delegation_event_id(&curr.session_id, "progress", &tok),
                            "kind": "progress",
                            "workspaceId": workspace_id,
                            "sessionId": curr.session_id,
                            "at": at_iso,
                            "payload": { "leafIds": fresh },
                        }));
                        progressed = true;
                    }
                }
            }

            // New user-action needs
            let seen_needs: HashSet<&str> = prior
                .map(|p| p.needs_user.iter().map(|(id, _)| id.as_str()).collect())
                .unwrap_or_default();
            for (aid, kind) in &curr.needs_user {
                if !seen_needs.contains(aid.as_str()) {
                    events.push(json!({
                        "eventId": delegation_event_id(&curr.session_id, "needs_user", aid),
                        "kind": "needs_user",
                        "workspaceId": workspace_id,
                        "sessionId": curr.session_id,
                        "at": at_iso,
                        "payload": { "need": kind },
                    }));
                }
            }

            // result_ready transition / revision change
            let result_changed = curr.status == "result_ready"
                && (prior.is_none_or(|p| p.status != "result_ready")
                    || (curr.result_revision.is_some()
                        && curr.result_revision != prior.and_then(|p| p.result_revision.clone())));
            if result_changed {
                let token = curr
                    .result_revision
                    .as_deref()
                    .or(curr.completed_at.as_deref())
                    .unwrap_or(&curr.version);
                events.push(json!({
                    "eventId": delegation_event_id(&curr.session_id, "result_ready", token),
                    "kind": "result_ready",
                    "workspaceId": workspace_id,
                    "sessionId": curr.session_id,
                    "at": at_iso,
                    "payload": {
                        "outcome": curr.verdict_outcome,
                        "evidenceRefs": curr.verdict_evidence_refs,
                    },
                }));
            }

            // Terminal failure / interruption / cancellation
            if prior.is_some_and(|p| p.status != curr.status)
                && matches!(curr.status.as_str(), "failed" | "interrupted" | "cancelled")
            {
                let mut payload = json!({ "status": curr.status });
                if matches!(curr.status.as_str(), "failed" | "interrupted") {
                    let failure = describe_failure(curr);
                    if !failure.summary.is_empty() {
                        payload["summary"] = json!(failure.summary);
                        if !failure.reason.is_empty() {
                            payload["reason"] = json!(failure.reason);
                        }
                        if !failure.last_error.is_empty() {
                            payload["lastError"] = json!(failure.last_error);
                        }
                        if !failure.cause.is_empty() {
                            payload["cause"] = json!(failure.cause);
                        }
                        let same = assess_same_cause(curr, Some(&failure));
                        if same.count > 0 {
                            payload["sameCauseCount"] = json!(same.count);
                        }
                        if same.ask_user {
                            payload["stopAutoRetry"] = json!(true);
                            payload["askUser"] = json!(true);
                        }
                    }
                }
                events.push(json!({
                    "eventId": delegation_event_id(&curr.session_id, &curr.status, &curr.version),
                    "kind": curr.status,
                    "workspaceId": workspace_id,
                    "sessionId": curr.session_id,
                    "at": at_iso,
                    "payload": payload,
                }));
            }

            // Stall detection with deduplication by stall_id
            let stall = assess_stall(curr, now_ms, win);
            if stall.stalled
                && let Some(ref sid) = stall.stall_id
                && prior.and_then(|p| p.stall_id.as_deref()) != Some(sid.as_str())
            {
                events.push(json!({
                    "eventId": delegation_event_id(&curr.session_id, "stalled", sid),
                    "kind": "stalled",
                    "workspaceId": workspace_id,
                    "sessionId": curr.session_id,
                    "at": at_iso,
                    "payload": {
                        "stallId": sid,
                        "anchor": stall.anchor,
                    },
                }));
                curr.stall_id = Some(sid.clone());
            } else if let Some(prev_sid) = prior.and_then(|p| p.stall_id.clone())
                && curr.stall_id.is_none()
            {
                curr.stall_id = Some(prev_sid);
            }

            curr.progress_emitted_at = if progressed {
                Some(at_iso.to_owned())
            } else {
                prior
                    .and_then(|p| p.progress_emitted_at.clone())
                    .or_else(|| curr.progress_emitted_at.clone())
            };
        }

        prior_map.clear();
        for f in current_list {
            prior_map.insert(f.session_id.clone(), f);
        }
        events
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_facts(status: &str) -> WatchSessionFacts {
        WatchSessionFacts {
            session_id: "sess-1".into(),
            workspace_id: "ws-1".into(),
            plan_id: Some("plan-1".into()),
            task_id: Some("task-1".into()),
            version: "v1".into(),
            status: status.into(),
            completed_at: None,
            result_revision: None,
            started_at: Some("2026-11-20T10:00:00.000Z".into()),
            last_progress_at: None,
            progress_emitted_at: None,
            stall_id: None,
            leaves: vec![("task-1".into(), "pending".into(), None)],
            needs_user: vec![],
            last_error: String::new(),
            interruption_reason: String::new(),
            interruption_code: String::new(),
            blocked_reason: String::new(),
            recoverable_interruption_count: 0,
            failure_log: vec![],
            verdict_outcome: None,
            verdict_evidence_refs: vec![],
        }
    }

    #[test]
    fn stall_detection_handles_running_result_ready_and_waiting_user() {
        let mut s = sample_facts("running");
        let now_ok = parse_iso_ms("2026-11-20T10:05:00.000Z").unwrap();
        assert!(!assess_stall(&s, now_ok, STALL_WINDOW_MS).stalled);

        let now_stalled = parse_iso_ms("2026-11-20T10:11:00.000Z").unwrap();
        let st = assess_stall(&s, now_stalled, STALL_WINDOW_MS);
        assert!(st.stalled);
        assert!(st.stall_id.as_deref().unwrap().starts_with("stall:sess-1:"));

        // waiting_user suppresses stall
        s.needs_user.push(("ap-1".into(), "plan_approval".into()));
        let waiting = assess_stall(&s, now_stalled, STALL_WINDOW_MS);
        assert!(!waiting.stalled);
        assert!(waiting.waiting);

        // result_ready past window triggers verify stall
        s.needs_user.clear();
        s.status = "result_ready".into();
        s.completed_at = Some("2026-11-20T10:00:00.000Z".into());
        s.result_revision = Some("rev-7".into());
        let verify_stall = assess_stall(&s, now_stalled, STALL_WINDOW_MS);
        assert!(verify_stall.stalled);
        assert_eq!(
            verify_stall.stall_id.as_deref(),
            Some("stall:verify:sess-1:rev-7")
        );
        assert_eq!(verify_stall.anchor.as_deref(), Some("verification_pending"));
    }

    #[test]
    fn same_cause_limit_triggers_at_three_matching_failures() {
        let mut s = sample_facts("failed");
        s.last_error = "ECONNRESET: socket hang up".into();
        s.failure_log = vec![
            json!({"taskId": "task-1", "cause": "ECONNRESET: read error"}),
            json!({"taskId": "task-1", "cause": "econnreset during stream"}),
        ];
        let same = assess_same_cause(&s, None);
        assert_eq!(same.cause_class, "econnreset");
        assert_eq!(same.count, 3);
        assert!(same.ask_user);
        assert!(same.stop_auto_retry);
    }

    #[test]
    fn watch_publisher_deduplicates_stalls_and_emits_same_cause_failure() {
        let publisher = WatchPublisher::new();
        let plan_running = json!({
            "planId": "p1",
            "status": "executing",
            "createdAt": "2026-11-20T10:00:00.000Z",
            "updatedAt": "2026-11-20T10:00:00.000Z",
            "tasks": [{"taskId": "t1", "status": "pending"}],
            "delegationOrigin": {
                "workspaceId": "ws-1",
                "sessionId": "s-1",
                "phase": "running"
            }
        });
        let ev1 = publisher.publish(
            "ws-1",
            std::slice::from_ref(&plan_running),
            "2026-11-20T10:12:00.000Z",
            None,
        );
        assert_eq!(ev1.len(), 1);
        assert_eq!(ev1[0]["kind"], "stalled");

        // Repeating at same stall anchor must not duplicate
        let ev2 = publisher.publish("ws-1", &[plan_running], "2026-11-20T10:15:00.000Z", None);
        assert!(ev2.is_empty());

        let plan_failed = json!({
            "planId": "p1",
            "status": "failed",
            "createdAt": "2026-11-20T10:00:00.000Z",
            "updatedAt": "2026-11-20T10:16:00.000Z",
            "tasks": [{"taskId": "t1", "status": "failed"}],
            "runner": {
                "currentTaskId": "t1",
                "lastError": "model timeout exceeded",
                "recoverableInterruptionCount": 2
            },
            "delegationOrigin": {
                "workspaceId": "ws-1",
                "sessionId": "s-1",
                "phase": "running"
            }
        });
        let ev3 = publisher.publish("ws-1", &[plan_failed], "2026-11-20T10:16:00.000Z", None);
        assert!(ev3.iter().any(|e| {
            e["kind"] == "failed"
                && e["payload"]["stopAutoRetry"] == true
                && e["payload"]["sameCauseCount"] == 3
        }));
    }
}
