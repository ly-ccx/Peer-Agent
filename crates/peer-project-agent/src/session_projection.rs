//! Canonical WorkSession & Supervision projection (ADR 80, ADR 102, ADR 110, ADR 116).
//!
//! Mirrors `packages/protocol/src/task-overview.ts` (`decideLifecycle`, `decideGoalPlan`,
//! `decideFollowUp`), `packages/protocol/src/delegation.ts#projectWorkSession`,
//! `packages/runtime-node/src/project-agent/session-report.mjs`,
//! `verification-completion.mjs`, `session-observation-revision.mjs`,
//! `verification-detail.mjs`, and `supervision-recovery.mjs`.

use crate::{
    acceptance::{HostAuthorityFacts, compute_verification_verdict, verdict_ref_for},
    obligation::read_coordination_read_model_buckets,
    parse_iso_ms, sha256_json,
    supervisor::{
        SessionSupervisor, WorkSessionSummary, completed_leaf_results, visible_worker_result,
    },
};
use peer_protocol::javascript_json_string;
use regex::Regex;
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::{
    collections::{HashMap, HashSet},
    path::Path,
    sync::OnceLock,
};

const ACTIVE_EXECUTION_RUNNER_STATUSES: [&str; 5] = [
    "running",
    "starting",
    "waiting_provider",
    "resuming_after_compaction",
    "exploring",
];

const ENDED_RUNNER_STATUSES: [&str; 4] = ["completed", "failed", "cancelled", "stopped"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FollowUpProjection {
    pub owner: String,
    pub in_current_list: bool,
    pub reason: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LifecycleDecision {
    pub status: String,
    pub action_right: String,
    pub needs_you_reason: Option<String>,
    pub next_action: String,
    pub status_label: String,
    pub action_label: String,
    pub cancelable: bool,
    pub needs_user: bool,
    pub verification_active: bool,
    pub blocked_reason: Option<String>,
    pub follow_up: FollowUpProjection,
}

#[derive(Debug, Clone)]
struct ProjectionDecision {
    action_right: &'static str,
    needs_you_reason: Option<&'static str>,
    next_action: &'static str,
    status_label: &'static str,
    action_label: &'static str,
}

fn opt_str(val: &Value) -> Option<&str> {
    val.as_str().map(str::trim).filter(|s| !s.is_empty())
}

pub(crate) fn is_local_persistence_failure(raw: &str) -> bool {
    let trimmed = raw.trim();
    trimmed == "conversation_persistence_failed"
        || trimmed.starts_with("conversation_persistence_failed:")
}

fn is_digestible_handoff_verdict(verdict: Option<&str>) -> bool {
    matches!(verdict, Some("AUTO_CLEAN" | "STALE"))
}

fn is_non_cancelable_status(status: &str) -> bool {
    matches!(
        status,
        "accepted"
            | "failed"
            | "cancelled"
            | "superseded"
            | "result_ready"
            | "stopping"
            | "awaiting_outcome"
    )
}

fn execution_ownership_of(plan: &Value, verification_active: bool) -> &'static str {
    if verification_active {
        return "live";
    }
    let runner_status = opt_str(&plan["runner"]["status"]).unwrap_or("");
    if ENDED_RUNNER_STATUSES.contains(&runner_status) {
        "ended"
    } else {
        "unknown"
    }
}

pub(crate) fn control_phases_for_origin(origin: &Value) -> (Option<String>, Option<String>) {
    let cancel_origin = opt_str(&origin["cancellation"]["phase"]).map(str::to_owned);
    let takeover_origin = opt_str(&origin["takeover"]["phase"]).map(str::to_owned);
    let Some(control) = origin.get("executionControl").filter(|v| v.is_object()) else {
        return (cancel_origin, takeover_origin);
    };
    let phase = opt_str(&control["phase"]).unwrap_or("");
    let kind = opt_str(&control["kind"]).unwrap_or("");
    let outcome = opt_str(&control["outcome"]).unwrap_or("");
    let next_action = opt_str(&control["nextAction"]).unwrap_or("");
    let unknown_calls = control["stopReceipt"]["unknownCalls"]
        .as_array()
        .is_some_and(|a| !a.is_empty());
    let refused = phase == "reconciling"
        && (unknown_calls
            || matches!(
                next_action,
                "execution_stop_unconfirmed"
                    | "execution_outcome_unknown"
                    | "reconcile_execution_outcome"
            ));
    let stopping = if refused {
        "awaiting_outcome".to_owned()
    } else {
        "stopping".to_owned()
    };
    let cancellation_phase = if kind == "cancel" {
        if phase == "settled" && outcome == "applied" {
            Some("completed".to_owned())
        } else {
            Some(stopping.clone())
        }
    } else {
        cancel_origin
    };
    let takeover_phase = if phase == "settled" && control["stopReceipt"].is_object() {
        None
    } else if kind == "takeover" {
        Some(stopping)
    } else {
        takeover_origin
    };
    (cancellation_phase, takeover_phase)
}

fn decide_goal_plan(
    plan: &Value,
    runner_status: Option<&str>,
    live_execution: bool,
    agent_waiting: bool,
    system_blocked: bool,
) -> ProjectionDecision {
    let status = opt_str(&plan["status"]).unwrap_or("");
    let interrupted = plan["runner"]["interruption"].is_object();
    let handoff_status = opt_str(&plan["deliveryHandoff"]["status"]);
    let handoff_verdict = opt_str(&plan["deliveryHandoff"]["verdict"]);

    if interrupted {
        return ProjectionDecision {
            action_right: "paused",
            needs_you_reason: None,
            next_action: "resume",
            status_label: "执行中断",
            action_label: "继续 →",
        };
    }

    if status == "completed" && runner_status == Some("waiting_user") {
        return ProjectionDecision {
            action_right: "needs_you",
            needs_you_reason: Some("user_input"),
            next_action: "answer_question",
            status_label: "等待你的选择",
            action_label: "回答 →",
        };
    }

    if status == "completed" {
        if let Some(hs) = handoff_status
            && hs != "delivered"
        {
            if hs == "stopped" {
                if is_digestible_handoff_verdict(handoff_verdict) {
                    return ProjectionDecision {
                        action_right: "terminal",
                        needs_you_reason: None,
                        next_action: "none",
                        status_label: "已完成",
                        action_label: "查看 →",
                    };
                }
                return ProjectionDecision {
                    action_right: "needs_you",
                    needs_you_reason: Some("decision"),
                    next_action: "decide_blocked",
                    status_label: "合不进源头",
                    action_label: "查看进度",
                };
            }
            if matches!(hs, "delivering" | "idle") {
                return ProjectionDecision {
                    action_right: "peer_advancing",
                    needs_you_reason: None,
                    next_action: "none",
                    status_label: "正在合进源头",
                    action_label: "查看 →",
                };
            }
        }
        if live_execution {
            return ProjectionDecision {
                action_right: "peer_advancing",
                needs_you_reason: None,
                next_action: "none",
                status_label: "Peer 正在推进",
                action_label: "查看 →",
            };
        }
        return ProjectionDecision {
            action_right: "terminal",
            needs_you_reason: None,
            next_action: "none",
            status_label: "已完成",
            action_label: "查看 →",
        };
    }

    if status == "cancelled" || status == "failed" {
        return ProjectionDecision {
            action_right: "terminal",
            needs_you_reason: None,
            next_action: "none",
            status_label: if status == "cancelled" {
                "已取消"
            } else {
                "已失败"
            },
            action_label: "查看 →",
        };
    }

    if status == "awaiting_approval" {
        return ProjectionDecision {
            action_right: "needs_you",
            needs_you_reason: Some("plan_approval"),
            next_action: "approve_plan",
            status_label: "待批准计划",
            action_label: "批准 →",
        };
    }

    if status == "drafting" {
        return ProjectionDecision {
            action_right: "needs_you",
            needs_you_reason: Some("plan_approval"),
            next_action: "confirm_scope",
            status_label: "待确认目标",
            action_label: "确认 →",
        };
    }

    let plan_still_active = matches!(status, "executing" | "accepted" | "approved");
    if agent_waiting
        && runner_status != Some("waiting_user")
        && matches!(status, "executing" | "completed")
    {
        return ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "等待主 Bot 答复",
            action_label: "",
        };
    }

    if plan_still_active && runner_status == Some("blocked") && system_blocked {
        return ProjectionDecision {
            action_right: "paused",
            needs_you_reason: None,
            next_action: "inspect",
            status_label: "系统执行中断",
            action_label: "诊断 →",
        };
    }

    if plan_still_active && runner_status == Some("waiting_user") {
        return ProjectionDecision {
            action_right: "needs_you",
            needs_you_reason: Some("user_input"),
            next_action: "answer_question",
            status_label: "等待你的选择",
            action_label: "回答 →",
        };
    }

    if plan_still_active && matches!(runner_status, Some("blocked" | "budget_exhausted")) {
        return ProjectionDecision {
            action_right: "needs_you",
            needs_you_reason: Some("decision"),
            next_action: "decide_blocked",
            status_label: if runner_status == Some("budget_exhausted") {
                "预算已耗尽"
            } else {
                "执行受阻"
            },
            action_label: "决策",
        };
    }

    if status == "paused" {
        return ProjectionDecision {
            action_right: "paused",
            needs_you_reason: None,
            next_action: "resume",
            status_label: "已暂停",
            action_label: "继续 →",
        };
    }

    if status == "executing" && runner_status == Some("idle") {
        return ProjectionDecision {
            action_right: "paused",
            needs_you_reason: None,
            next_action: "inspect",
            status_label: "推进中断",
            action_label: "诊断 →",
        };
    }

    if runner_status == Some("paused") {
        return ProjectionDecision {
            action_right: "paused",
            needs_you_reason: None,
            next_action: "resume",
            status_label: "已暂停",
            action_label: "继续 →",
        };
    }

    if matches!(
        runner_status,
        Some("running" | "compacting_context" | "resuming_after_compaction" | "exploring")
    ) {
        return ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "Peer 正在推进",
            action_label: "查看 →",
        };
    }

    if status == "executing" {
        return ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "Peer 正在推进",
            action_label: "查看 →",
        };
    }

    if matches!(status, "approved" | "accepted") {
        return ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "排队待执行",
            action_label: "查看 →",
        };
    }

    ProjectionDecision {
        action_right: "peer_advancing",
        needs_you_reason: None,
        next_action: "none",
        status_label: "Peer 正在推进",
        action_label: "查看 →",
    }
}

fn lifecycle_presentation(
    status: &str,
    legacy: ProjectionDecision,
    delegated: bool,
    accepted: bool,
    takeover_stopping: bool,
    budget_gate: bool,
) -> ProjectionDecision {
    match status {
        "cancelled" => ProjectionDecision {
            action_right: "terminal",
            needs_you_reason: None,
            next_action: "none",
            status_label: "已取消",
            action_label: "查看 →",
        },
        "waiting_user" => {
            if legacy.action_right == "needs_you" {
                return legacy;
            }
            if budget_gate {
                ProjectionDecision {
                    action_right: "needs_you",
                    needs_you_reason: Some("decision"),
                    next_action: "decide_blocked",
                    status_label: "预算已耗尽",
                    action_label: "决策",
                }
            } else {
                ProjectionDecision {
                    action_right: "needs_you",
                    needs_you_reason: Some("user_input"),
                    next_action: "answer_question",
                    status_label: "等待你的选择",
                    action_label: "回答 →",
                }
            }
        }
        "verifying" => ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "核验中",
            action_label: "查看 →",
        },
        "stopping" => ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "正在停止",
            action_label: "查看 →",
        },
        "awaiting_outcome" => ProjectionDecision {
            action_right: "peer_advancing",
            needs_you_reason: None,
            next_action: "none",
            status_label: "执行结果待核实",
            action_label: "查看 →",
        },
        "waiting_agent" => {
            if legacy.action_right == "needs_you" || (delegated && legacy.action_right == "paused")
            {
                ProjectionDecision {
                    action_right: "peer_advancing",
                    needs_you_reason: None,
                    next_action: "none",
                    status_label: "由主 Bot 跟进",
                    action_label: "查看 →",
                }
            } else {
                legacy
            }
        }
        "starting" => {
            if takeover_stopping {
                ProjectionDecision {
                    action_right: "peer_advancing",
                    needs_you_reason: None,
                    next_action: "none",
                    status_label: "正在接手",
                    action_label: "查看 →",
                }
            } else {
                legacy
            }
        }
        "result_ready" => {
            if delegated && !accepted {
                ProjectionDecision {
                    action_right: "result_ready",
                    needs_you_reason: None,
                    next_action: "review_result",
                    status_label: "等待验收",
                    action_label: "验收 →",
                }
            } else {
                legacy
            }
        }
        _ => legacy,
    }
}

#[allow(clippy::too_many_arguments)]
fn decide_follow_up(
    status: &str,
    needs_you_reason: Option<&str>,
    ownership: &str,
    human_gate: bool,
    accepted: bool,
    superseded: bool,
    interrupted: bool,
    interruption_origin: Option<&str>,
    blocked_reason: Option<&str>,
    cancellation_phase: Option<&str>,
    cancellation_disposition: Option<&str>,
    obligation_disposition: Option<&str>,
    verification_failed: bool,
) -> FollowUpProjection {
    let make = |owner: &str, reason: &str| FollowUpProjection {
        owner: owner.to_owned(),
        in_current_list: owner != "none",
        reason: reason.to_owned(),
    };
    let live = ownership == "live";
    let stop_status = matches!(status, "cancelled" | "stopping" | "awaiting_outcome");
    let stop_pending = stop_status && !(cancellation_phase == Some("completed") && !live);
    let human_needs_you =
        status == "waiting_user" || (status == "result_ready" && human_gate && !accepted);

    if human_needs_you {
        if status == "result_ready" || needs_you_reason == Some("decision") {
            return make("user", "awaiting_human_gate");
        }
        return make("user", "human_request");
    }
    if live {
        return make("bot", "live_execution");
    }
    if obligation_disposition == Some("indexed") {
        return make("none", "obligation_indexed");
    }
    if stop_pending {
        return make("bot", "stop_unconfirmed");
    }
    if stop_status && cancellation_disposition == Some("user_withdrawn") {
        return make("none", "user_withdrawn");
    }
    if superseded || status == "superseded" {
        return make("none", "superseded");
    }
    if matches!(status, "failed" | "waiting_agent")
        && blocked_reason == Some("conversation_persistence_failed")
    {
        return make("bot", "local_persistence_failed");
    }
    if status == "result_ready" && verification_failed {
        return make("bot", "verification_failed");
    }
    if status == "failed" {
        return make("none", "execution_failed");
    }
    if accepted {
        return make("none", "settled");
    }
    if stop_status {
        return make("none", "stop_confirmed");
    }
    if status == "waiting_agent" {
        return make("bot", "technical_block");
    }
    if status == "result_ready" {
        return make("bot", "awaiting_acceptance_technical");
    }
    if matches!(status, "verifying" | "running" | "starting" | "queued") {
        return make("bot", "live_execution");
    }
    if status == "paused" {
        if interrupted && interruption_origin != Some("user") {
            let reason = match interruption_origin {
                Some(o) if !o.is_empty() && o != "unknown" => "technical_block",
                _ => "unknown_facts",
            };
            return make("bot", reason);
        }
        return make("none", "paused");
    }
    if status == "accepted" {
        return make("none", "settled");
    }
    make("bot", "unknown_facts")
}

/// Canonical lifecycle + followUp projection matching `packages/protocol/src/task-overview.ts#decideLifecycle`.
pub fn decide_lifecycle(
    plan: &Value,
    human_gate: bool,
    verification_active: bool,
    coordination_phase: Option<&str>,
    obligation_disposition: Option<&str>,
) -> LifecycleDecision {
    let origin = &plan["delegationOrigin"];
    let runner = &plan["runner"];
    let plan_status = opt_str(&plan["status"]).unwrap_or("");
    let ownership = execution_ownership_of(plan, verification_active);
    let persisted_runner = opt_str(&runner["status"]);
    let persisted_active =
        persisted_runner.is_some_and(|rs| ACTIVE_EXECUTION_RUNNER_STATUSES.contains(&rs));
    let live_execution = ownership == "live" && (persisted_active || persisted_runner.is_none());
    let runner_status = if persisted_active && ownership != "live" {
        None
    } else {
        persisted_runner
    };

    let phase = opt_str(&origin["phase"]);
    let superseded = opt_str(&origin["supersededBy"]).is_some();
    let accepted = opt_str(&plan["resultAcceptance"]["acceptedAt"]).is_some();
    let delegated = origin.is_object();
    let interrupted = runner["interruption"].is_object();
    let interruption_origin = opt_str(&runner["interruption"]["origin"]);
    let waiting_on_user = runner["waitingOnUser"].as_bool() == Some(true);
    let agent_wait_msg = opt_str(&origin["agentWaitMessageId"]).is_some();
    let agent_waiting = agent_wait_msg
        || persisted_runner == Some("blocked")
            && runner["blockedReason"].as_str() == Some("waiting_parent_agent");
    let raw_blocked_reason = opt_str(&runner["blockedReason"]);
    let last_error = opt_str(&runner["lastError"]).unwrap_or("");

    let blocked_reason: Option<String> = if is_local_persistence_failure(last_error) {
        Some("conversation_persistence_failed".to_owned())
    } else if agent_wait_msg && persisted_runner != Some("waiting_user") {
        Some("waiting_parent_agent".to_owned())
    } else {
        raw_blocked_reason.map(str::to_owned)
    };

    let needs_user_facts = phase == Some("awaiting_approval")
        || plan_status == "awaiting_approval"
        || (waiting_on_user && persisted_runner != Some("paused") && !superseded)
        || (persisted_runner == Some("blocked")
            && raw_blocked_reason == Some("manual_dod_confirmation_required"));

    let (cancel_phase, mut takeover_phase) = control_phases_for_origin(origin);
    if !origin["executionControl"].is_object() && coordination_phase == Some("awaiting_outcome") {
        takeover_phase = Some("awaiting_outcome".to_owned());
    }
    let cancel_disposition = opt_str(&origin["cancellation"]["disposition"]);

    let legacy = decide_goal_plan(
        plan,
        runner_status,
        live_execution,
        agent_waiting || agent_wait_msg,
        false,
    );

    let status = if plan_status == "cancelled"
        || (cancel_phase.as_deref() == Some("completed") && ownership != "live")
    {
        "cancelled"
    } else if plan_status == "failed" {
        "failed"
    } else if accepted {
        "accepted"
    } else if cancel_phase.as_deref() == Some("awaiting_outcome")
        || takeover_phase.as_deref() == Some("awaiting_outcome")
    {
        "awaiting_outcome"
    } else if cancel_phase.as_deref() == Some("stopping") {
        "stopping"
    } else if takeover_phase.as_deref() == Some("stopping") {
        "starting"
    } else if superseded && plan_status != "completed" {
        "superseded"
    } else if (phase == Some("paused") || runner_status == Some("paused"))
        && plan_status != "completed"
    {
        "paused"
    } else if interrupted
        && interruption_origin != Some("user")
        && delegated
        && runner_status == Some("failed")
        && !needs_user_facts
        && !live_execution
    {
        "waiting_agent"
    } else if interrupted {
        "paused"
    } else if needs_user_facts
        || runner_status == Some("waiting_user")
        || (runner_status == Some("budget_exhausted") && !live_execution)
    {
        "waiting_user"
    } else if (blocked_reason.as_deref() == Some("waiting_parent_agent") || agent_wait_msg)
        && phase != Some("paused")
        && !superseded
        && runner_status != Some("paused")
        && !live_execution
    {
        "waiting_agent"
    } else if verification_active {
        "verifying"
    } else if runner_status == Some("blocked") && !live_execution {
        "waiting_agent"
    } else if plan_status == "completed"
        && (runner_status.is_some_and(|rs| ACTIVE_EXECUTION_RUNNER_STATUSES.contains(&rs))
            || live_execution)
    {
        "running"
    } else if plan_status == "completed" {
        "result_ready"
    } else if phase == Some("starting") {
        "starting"
    } else if matches!(
        plan_status,
        "approved" | "accepted" | "paused" | "interrupted"
    ) || phase == Some("queued")
    {
        "queued"
    } else {
        "running"
    };

    let pres = lifecycle_presentation(
        status,
        legacy,
        delegated,
        accepted,
        takeover_phase.as_deref() == Some("stopping"),
        runner_status == Some("budget_exhausted") && !live_execution,
    );
    let verification_failed = !verification_active
        && (opt_str(&origin["independentVerifier"]) == Some("failed")
            || plan["verificationReport"]["passed"].as_bool() == Some(false));
    let follow_up = decide_follow_up(
        status,
        pres.needs_you_reason,
        ownership,
        human_gate,
        accepted,
        superseded,
        interrupted,
        interruption_origin,
        blocked_reason.as_deref(),
        cancel_phase.as_deref(),
        cancel_disposition,
        obligation_disposition,
        verification_failed,
    );

    let cancelable = (pres.action_right != "terminal" && !is_non_cancelable_status(status))
        || (status == "result_ready" && !accepted)
        || (status == "failed" && follow_up.in_current_list)
        || (status == "cancelled" && follow_up.reason == "stop_unconfirmed");

    LifecycleDecision {
        status: status.to_owned(),
        action_right: pres.action_right.to_owned(),
        needs_you_reason: pres.needs_you_reason.map(str::to_owned),
        next_action: pres.next_action.to_owned(),
        status_label: pres.status_label.to_owned(),
        action_label: pres.action_label.to_owned(),
        cancelable,
        needs_user: status == "waiting_user",
        verification_active: status == "verifying",
        blocked_reason,
        follow_up,
    }
}

fn completed_leaves<'a>(tasks: &'a [Value], out: &mut Vec<&'a Value>) {
    for task in tasks {
        if let Some(sub) = task["subtasks"].as_array().filter(|a| !a.is_empty()) {
            completed_leaves(sub, out);
        } else if task["status"].as_str() == Some("completed")
            && task["result"]
                .as_str()
                .is_some_and(|s| !s.trim().is_empty())
        {
            out.push(task);
        }
    }
}

fn session_report_evidence_refs(plan: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    let mut push = |raw: Option<&str>| {
        let Some(s) = raw.map(str::trim).filter(|s| !s.is_empty()) else {
            return;
        };
        if seen.insert(s.to_owned()) {
            out.push(s.to_owned());
        }
    };
    for r in plan["evidenceRefs"].as_array().into_iter().flatten() {
        push(r.as_str());
    }
    for r in plan["criterionResults"].as_array().into_iter().flatten() {
        push(r["evidenceRef"].as_str());
    }
    if let Some(tasks) = plan["tasks"].as_array() {
        let mut leaves = Vec::new();
        completed_leaves(tasks, &mut leaves);
        for leaf in leaves {
            for r in leaf["evidenceRefs"].as_array().into_iter().flatten() {
                push(r.as_str());
            }
        }
    }
    out
}

/// Mirror `packages/runtime-node/src/project-agent/session-report.mjs#buildSessionReport`.
pub fn build_session_report(
    plan: &Value,
    session_id: &str,
    status: &str,
    child_messages: &[Value],
) -> Value {
    let worker = child_messages.iter().rev().find(|m| {
        m["role"].as_str() == Some("assistant")
            && !m["_compaction"].as_bool().unwrap_or(false)
            && !visible_worker_result(m).is_empty()
    });
    let mut findings = Vec::new();
    if let Some(tasks) = plan["tasks"].as_array() {
        completed_leaf_results(tasks, &mut findings);
    }
    let summary = match worker {
        Some(msg) => visible_worker_result(msg),
        None => findings.join("\n\n"),
    };
    let evidence_refs = session_report_evidence_refs(plan);
    let changed_files: Vec<Value> = plan["involvedFiles"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let path = if let Some(s) = item.as_str() {
                s.trim()
            } else {
                item["path"].as_str().map(str::trim).unwrap_or("")
            };
            if path.is_empty() {
                return None;
            }
            let summary_txt = item["summary"].as_str().map(str::trim).unwrap_or("");
            Some(json!({ "path": path, "summary": summary_txt }))
        })
        .collect();

    let mut out = Map::new();
    out.insert("sessionId".into(), json!(session_id));
    out.insert(
        "planId".into(),
        plan.get("planId").cloned().unwrap_or(Value::Null),
    );
    out.insert("status".into(), json!(status));
    out.insert("summary".into(), json!(summary));
    out.insert(
        "taskBrief".into(),
        json!(plan["goal"].as_str().map(str::trim).unwrap_or("")),
    );
    out.insert("keyFindings".into(), json!(findings));
    out.insert("changedFiles".into(), json!(changed_files));
    out.insert("evidenceRefs".into(), json!(evidence_refs));
    if let Some(code) =
        opt_str(&plan["failure"]["code"]).or_else(|| opt_str(&plan["delegationOrigin"]["error"]))
    {
        let mut fail = Map::new();
        fail.insert("code".into(), json!(code));
        if let Some(msg) =
            opt_str(&plan["failure"]["message"]).or_else(|| opt_str(&plan["failure"]["detail"]))
        {
            fail.insert("message".into(), json!(msg));
        }
        if let Some(at) = opt_str(&plan["failure"]["at"]) {
            fail.insert("at".into(), json!(at));
        }
        out.insert("failure".into(), Value::Object(fail));
    }
    if !summary.is_empty() {
        let mut src = Map::new();
        src.insert(
            "kind".into(),
            json!(if worker.is_some() {
                "worker_message"
            } else {
                "task_results"
            }),
        );
        if let Some(msg) = worker {
            src.insert(
                "conversationId".into(),
                opt_str(&plan["delegationOrigin"]["workerConversationId"])
                    .or_else(|| opt_str(&plan["conversationId"]))
                    .map(|s| json!(s))
                    .unwrap_or(Value::Null),
            );
            src.insert(
                "messageId".into(),
                msg.get("id").cloned().unwrap_or(Value::Null),
            );
        }
        src.insert("verification".into(), json!("unverified"));
        out.insert("contentSource".into(), Value::Object(src));
    }
    Value::Object(out)
}

/// Mirror `packages/runtime-node/src/project-agent/verification-completion.mjs#verificationContentHash`.
pub fn verification_content_hash(plan: &Value, report: &Value) -> String {
    let mut parts = vec![
        plan.get("planId").cloned().unwrap_or(Value::Null),
        plan.get("goal").cloned().unwrap_or(Value::Null),
        plan.get("tasks").cloned().unwrap_or(Value::Null),
        plan.get("successCriteria").cloned().unwrap_or(Value::Null),
        plan.get("criterionResults").cloned().unwrap_or(Value::Null),
        plan.get("manualConfirmations")
            .cloned()
            .unwrap_or(Value::Null),
        plan.get("deliveryBinding").cloned().unwrap_or(Value::Null),
        report.clone(),
    ];
    if plan["delegationOrigin"]["takeover"]["repair"].as_bool() == Some(true) {
        parts.push(
            plan["delegationOrigin"]["takeover"]["binding"]
                .get("executionEpoch")
                .cloned()
                .unwrap_or(Value::Null),
        );
    }
    sha256_json(&Value::Array(parts))
}

/// Mirror `packages/runtime-node/src/project-agent/session-observation-revision.mjs`.
pub fn session_observation_revision(plan: &Value, source_revision: &str) -> String {
    static UUID_RE: OnceLock<Regex> = OnceLock::new();
    static TRACE_RE: OnceLock<Regex> = OnceLock::new();

    let run = plan["runner"]["verifierRuns"]
        .as_array()
        .and_then(|a| a.last());
    let review = if let Some(r) = run
        && matches!(r["status"].as_str(), Some("passed" | "failed"))
    {
        let mut obj = Map::new();
        obj.insert("status".into(), r["status"].clone());
        if let Some(v) = r.get("summary") {
            obj.insert("summary".into(), v.clone());
        }
        if let Some(v) = r.get("failureReason") {
            obj.insert("failureReason".into(), v.clone());
        }
        if let Some(rep) = r.get("report") {
            if let Some(v) = rep.get("failedCriteria") {
                obj.insert("failedCriteria".into(), v.clone());
            }
            if let Some(v) = rep.get("missingEvidence") {
                obj.insert("missingEvidence".into(), v.clone());
            }
            if let Some(v) = rep.get("risks") {
                obj.insert("risks".into(), v.clone());
            }
            if let Some(v) = rep.get("recommendedNextAction") {
                obj.insert("nextAction".into(), v.clone());
            }
        }
        Value::Object(obj)
    } else {
        Value::Null
    };

    let observation = json!({
        "sourceRevision": source_revision,
        "blockedReason": opt_str(&plan["runner"]["blockedReason"]).unwrap_or(""),
        "lastError": opt_str(&plan["runner"]["lastError"]).unwrap_or(""),
        "review": review,
    });
    let serialized = javascript_json_string(&observation).unwrap_or_else(|_| "{}".to_owned());
    let uuid_re = UUID_RE.get_or_init(|| {
        Regex::new(r"(?i)[0-9a-f]{8}-[0-9a-f-]{27,}").expect("valid uuid redaction regex")
    });
    let trace_re =
        TRACE_RE.get_or_init(|| Regex::new(r#"provider_trace=[^\s"\\]+"#).expect("valid trace re"));
    let s1 = uuid_re.replace_all(&serialized, "<id>");
    let s2 = trace_re.replace_all(&s1, "provider_trace=<ref>");
    crate::sha256_hex(s2.as_bytes())
}

/// Mirror `packages/runtime-node/src/project-agent/session-completion.mjs#projectCompletionReview`.
pub fn project_completion_review_for_plan(plan: &Value, report: &Value) -> Option<Value> {
    let phase = opt_str(&plan["delegationOrigin"]["phase"]);
    let plan_status = opt_str(&plan["status"]).unwrap_or("");
    if !plan["delegationOrigin"].is_object()
        || matches!(
            phase,
            Some("paused" | "superseded" | "queued" | "awaiting_approval")
        )
        || matches!(plan_status, "failed" | "cancelled")
        || plan["runner"]["status"].as_str() != Some("blocked")
        || plan["runner"]["blockedReason"].as_str() != Some("manual_dod_confirmation_required")
    {
        return None;
    }
    let summary = report["summary"].as_str().map(str::trim).unwrap_or("");
    if summary.is_empty() {
        return None;
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
        plan.get("planId").cloned().unwrap_or(Value::Null),
        plan.get("successCriteria").cloned().unwrap_or(Value::Null),
        plan.get("criterionResults").cloned().unwrap_or(Value::Null),
        plan.get("tasks").cloned().unwrap_or(Value::Null),
        summary,
        non_approved,
    ]));
    let expected_conf_id = format!("completion-review:{review_token}");
    let manual_criteria: Vec<&Value> = plan["successCriteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["kind"].as_str() == Some("manual"))
        .collect();
    let all_approved = manual_criteria.iter().all(|c| {
        let Some(cid) = opt_str(&c["id"]) else {
            return false;
        };
        confirmations
            .iter()
            .rev()
            .find(|row| {
                row["criterionIds"]
                    .as_array()
                    .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(cid)))
            })
            .and_then(|row| row["decision"].as_str())
            == Some("approve")
    });
    let confirmed = all_approved
        && confirmations.iter().any(|row| {
            row["confirmationId"].as_str() == Some(expected_conf_id.as_str())
                && row["decision"].as_str() == Some("approve")
        });
    let criteria: Vec<Value> = manual_criteria
        .into_iter()
        .filter(|c| {
            confirmed
                || opt_str(&c["id"]).is_none_or(|cid| {
                    confirmations
                        .iter()
                        .rev()
                        .find(|row| {
                            row["criterionIds"]
                                .as_array()
                                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(cid)))
                        })
                        .and_then(|row| row["decision"].as_str())
                        != Some("approve")
                })
        })
        .map(|c| {
            json!({
                "id": c.get("id").cloned().unwrap_or(Value::Null),
                "description": c.get("description").cloned().unwrap_or(Value::Null),
            })
        })
        .collect();
    if criteria.is_empty() {
        return None;
    }
    let session_id = plan["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
    let mut obj = Map::new();
    obj.insert("sessionId".into(), json!(session_id));
    obj.insert("reviewToken".into(), json!(review_token));
    obj.insert("criteria".into(), json!(criteria));
    obj.insert("report".into(), json!(summary));
    if confirmed {
        obj.insert("confirmed".into(), json!(true));
    }
    Some(Value::Object(obj))
}

/// Mirror `packages/runtime-node/src/project-agent/verification-detail.mjs#buildVerificationDetail`.
pub fn build_verification_detail(
    plan: &Value,
    session_id: &str,
    evidence_refs: &[String],
) -> Value {
    let origin = &plan["delegationOrigin"];
    let host_hv = &plan["hostVerification"];
    let independent = opt_str(&host_hv["independentVerifier"])
        .or_else(|| opt_str(&origin["independentVerifier"]))
        .map(str::to_owned);
    let verifier_model = opt_str(&host_hv["verifierModel"])
        .or_else(|| opt_str(&origin["verifierModel"]))
        .map(str::to_owned);
    let same_family = host_hv["sameFamilyAsWorker"]
        .as_bool()
        .or_else(|| origin["sameFamilyAsWorker"].as_bool());
    let evidence_set: HashSet<String> = evidence_refs.iter().cloned().collect();
    let verdict = compute_verification_verdict(
        plan,
        &evidence_set,
        &HostAuthorityFacts {
            independent_verifier: independent,
            verifier_model: verifier_model.clone(),
            same_family_as_worker: same_family,
        },
    );
    let checks: Vec<Value> = verdict
        .checks
        .iter()
        .map(|check| {
            let mut obj = Map::new();
            obj.insert("name".into(), json!(check.name));
            obj.insert(
                "result".into(),
                json!(if check.passed { "passed" } else { "failed" }),
            );
            obj.insert("evidenceRefs".into(), json!(verdict.evidence_refs));
            if let Some(ref reason) = check.reason {
                obj.insert("reason".into(), json!(reason));
            }
            Value::Object(obj)
        })
        .collect();
    let mut out = Map::new();
    out.insert("sessionId".into(), json!(session_id));
    out.insert("outcome".into(), json!(verdict.outcome));
    if let Some(exp) = host_hv
        .get("explicitVerification")
        .filter(|v| v.is_object())
        && let Some(ev_outcome) = exp["outcome"].as_str()
        && matches!(ev_outcome, "passed" | "failed" | "partial" | "unverifiable")
        && exp["verdictRef"].as_str() == Some(verdict_ref_for(session_id, ev_outcome).as_str())
    {
        out.insert(
            "explicitVerification".into(),
            json!({
                "verdictRef": exp["verdictRef"],
                "outcome": ev_outcome,
            }),
        );
    }
    out.insert("checks".into(), json!(checks));
    out.insert(
        "workerModel".into(),
        origin["modelSelection"]["worker"]["modelProviderId"]
            .as_str()
            .map(|s| json!(s))
            .unwrap_or(Value::Null),
    );
    out.insert(
        "verifierModel".into(),
        verifier_model.map(Value::String).unwrap_or(Value::Null),
    );
    out.insert("sameSource".into(), json!(same_family == Some(true)));
    if let Some(summary) = opt_str(&plan["verificationReport"]["summary"]) {
        out.insert("summary".into(), json!(summary));
    }
    if let Some(err) = opt_str(&plan["verificationReport"]["error"]) {
        out.insert("error".into(), json!(err));
    }
    let review_attempts = build_review_attempts(plan);
    out.insert("reviewAttempts".into(), Value::Array(review_attempts));
    out.insert("outputs".into(), json!([]));
    Value::Object(out)
}

fn normalize_diagnostic_criteria(raw: Option<&Value>, id_key: &str) -> Vec<Value> {
    raw.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            if let Some(s) = item.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                return Some(json!({
                    id_key: "",
                    "reason": s,
                    "evidenceRefs": [],
                }));
            }
            let obj = item.as_object()?;
            let reason = obj
                .get("reason")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())?;
            let id = obj
                .get(id_key)
                .and_then(Value::as_str)
                .map(str::trim)
                .unwrap_or("");
            let refs: Vec<String> = obj
                .get("evidenceRefs")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            Some(json!({
                id_key: id,
                "reason": reason,
                "evidenceRefs": refs,
            }))
        })
        .collect()
}

fn build_review_attempts(plan: &Value) -> Vec<Value> {
    let Some(runs) = plan["runner"]["verifierRuns"].as_array() else {
        return Vec::new();
    };
    let finished_indices: Vec<usize> = runs
        .iter()
        .enumerate()
        .filter(|(_, r)| {
            matches!(
                r["status"].as_str(),
                Some("passed" | "failed" | "interrupted")
            )
        })
        .map(|(i, _)| i)
        .collect();
    let last_finished = finished_indices.last().copied();
    let current_report = plan["verificationReport"]
        .as_object()
        .map(|_| &plan["verificationReport"]);

    finished_indices
        .into_iter()
        .map(|idx| {
            let run = &runs[idx];
            let raw_status = run["status"].as_str().unwrap_or("failed");
            let status = if raw_status == "passed" {
                "passed"
            } else {
                "failed"
            };
            let run_id = opt_str(&run["verifierRunId"])
                .map(str::to_owned)
                .unwrap_or_else(|| format!("vrun-legacy-{}", idx + 1));
            let completed_at = opt_str(&run["completedAt"])
                .or_else(|| opt_str(&run["startedAt"]))
                .unwrap_or("")
                .to_owned();
            let fallback_report = (Some(idx) == last_finished)
                .then_some(current_report)
                .flatten();
            let embedded_report = run.get("report").filter(|v| v.is_object());
            let report_src = embedded_report.or(fallback_report);

            let failure_reason = if status == "passed" {
                String::new()
            } else {
                opt_str(&run["failureReason"])
                    .or_else(|| opt_str(&run["summary"]))
                    .or_else(|| opt_str(&run["error"]))
                    .or_else(|| report_src.and_then(|r| opt_str(&r["summary"])))
                    .or_else(|| report_src.and_then(|r| opt_str(&r["error"])))
                    .unwrap_or("verification_failed")
                    .to_owned()
            };
            let failed_criteria = normalize_diagnostic_criteria(
                report_src.and_then(|r| r.get("failedCriteria")),
                "criterionId",
            );
            let missing_evidence = normalize_diagnostic_criteria(
                report_src.and_then(|r| r.get("missingEvidence")),
                "taskId",
            );
            let risks: Vec<String> = report_src
                .and_then(|r| r["risks"].as_array())
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            let evidence_refs: Vec<String> = report_src
                .and_then(|r| r["evidenceRefs"].as_array())
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .collect();
            let recommended_next_action = report_src
                .and_then(|r| opt_str(&r["recommendedNextAction"]))
                .unwrap_or("")
                .to_owned();

            json!({
                "verifierRunId": run_id,
                "status": status,
                "diagnosticOnly": true,
                "matchesCurrentSource": Value::Null,
                "completedAt": completed_at,
                "failureReason": failure_reason,
                "failedCriteria": failed_criteria,
                "missingEvidence": missing_evidence,
                "risks": risks,
                "recommendedNextAction": recommended_next_action,
                "evidenceRefs": evidence_refs,
            })
        })
        .collect()
}

fn verification_progress_from_plan(plan: &Value) -> Option<Value> {
    let val = plan["runner"]
        .get("verificationContinuation")
        .filter(|v| v.is_object())?;
    let cid = opt_str(&val["continuationId"])?;
    let started_at = opt_str(&val["startedAt"]).filter(|s| parse_iso_ms(s).is_some())?;
    let last_progress_at = opt_str(&val["lastProgressAt"]).filter(|s| parse_iso_ms(s).is_some())?;
    Some(json!({
        "continuationId": cid,
        "startedAt": started_at,
        "lastProgressAt": last_progress_at,
        "observationCount": val["observationCount"].as_u64().unwrap_or(0),
        "phase": val.get("phase").cloned().unwrap_or(Value::Null),
    }))
}

fn has_unsettled_dispatch_work(work: &Value) -> bool {
    let uncertain = work["budget"]["uncertainDispatches"]
        .as_array()
        .is_some_and(|a| !a.is_empty());
    let pending_tools = work["budget"]["attempts"]
        .as_object()
        .is_some_and(|attempts| {
            attempts.values().any(|att| {
                att["pendingTools"]
                    .as_array()
                    .is_some_and(|a| !a.is_empty())
            })
        });
    uncertain || pending_tools
}

fn goal_plan_waits_on_user(plan: &Value) -> bool {
    let Some(tasks) = plan["tasks"].as_array() else {
        return false;
    };
    fn any_waiting(nodes: &[Value]) -> bool {
        nodes.iter().any(|node| {
            if let Some(sub) = node["subtasks"].as_array().filter(|a| !a.is_empty()) {
                any_waiting(sub)
            } else {
                node["status"].as_str() == Some("waiting_user")
            }
        })
    }
    any_waiting(tasks)
}

fn takeover_blocker_for_resume(plan: &Value, human_gate: bool) -> Option<&'static str> {
    let phase = opt_str(&plan["delegationOrigin"]["phase"]);
    let status = opt_str(&plan["status"]);
    if phase == Some("awaiting_approval") || status == Some("awaiting_approval") {
        return Some("plan_approval_required");
    }
    if plan["runner"]["status"].as_str() == Some("waiting_user") || goal_plan_waits_on_user(plan) {
        return Some("human_decision_required");
    }
    if human_gate {
        return Some("human_decision_required");
    }
    if plan["resultAcceptance"]["acceptedAt"].is_string()
        || status == Some("cancelled")
        || plan["delegationOrigin"]["cancellation"].is_object()
    {
        return Some("session_not_running");
    }
    None
}

/// Mirror `packages/runtime-node/src/project-agent/supervision-recovery.mjs#supervisionRecovery`.
#[allow(clippy::too_many_arguments)]
pub fn supervision_recovery(
    plan: &Value,
    session: &Value,
    work: Option<&Value>,
    mandate: Option<&Value>,
    transitions: &[&Value],
    receipts: &[&Value],
    requests: &[&Value],
    related_works: &[&Value],
) -> Value {
    let session_id = session["sessionId"].as_str().unwrap_or("");
    let pending: Vec<&Value> = transitions
        .iter()
        .copied()
        .filter(|row| {
            row["oldSessionId"].as_str() == Some(session_id)
                && matches!(
                    row["phase"].as_str(),
                    Some("blocked" | "awaiting_outcome" | "stopping")
                )
        })
        .collect();
    let mut blockers = Vec::new();
    let mut seen_blockers = HashSet::new();
    let mut push_blocker = |s: String| {
        if !s.is_empty() && seen_blockers.insert(s.clone()) && blockers.len() < 24 {
            blockers.push(s);
        }
    };
    for row in &pending {
        if let Some(s) = opt_str(&row["error"]).or_else(|| opt_str(&row["phase"])) {
            push_blocker(s.to_owned());
        }
    }
    if let Some(w) = work {
        for row in w["budget"]["uncertainDispatches"]
            .as_array()
            .into_iter()
            .flatten()
        {
            push_blocker(
                opt_str(&row["toolCallId"])
                    .unwrap_or("dispatch_identity_unknown")
                    .to_owned(),
            );
        }
        if let Some(attempts) = w["budget"]["attempts"].as_object() {
            for att in attempts.values() {
                for row in att["pendingTools"].as_array().into_iter().flatten() {
                    push_blocker(
                        opt_str(&row["toolCallId"])
                            .unwrap_or("dispatch_identity_unknown")
                            .to_owned(),
                    );
                }
            }
        }
    }
    for row in receipts {
        if row["effect"].as_str() == Some("unknown")
            && let Some(op) = opt_str(&row["operationId"])
        {
            push_blocker(op.to_owned());
        }
    }
    let request = requests
        .iter()
        .copied()
        .find(|r| r["status"].as_str() == Some("open"));
    if session["followUp"]["owner"].as_str() == Some("user")
        || request.is_some_and(|r| r["responder"].as_str() == Some("user"))
    {
        return json!({
            "state": "waiting_user",
            "blockers": blockers,
            "nextAction": "native_user_decision",
        });
    }
    let unknown_commands = receipts
        .iter()
        .any(|r| r["effect"].as_str() == Some("unknown"));
    if work.is_some_and(has_unsettled_dispatch_work)
        || unknown_commands
        || pending
            .iter()
            .any(|r| r["phase"].as_str() == Some("awaiting_outcome"))
    {
        return json!({
            "state": "reconciliation_required",
            "blockers": blockers,
            "nextAction": "inspect_original_results",
            "replayAllowed": false,
        });
    }
    if let Some(w) = work
        && w["stopScope"].as_str() == Some("work")
        && matches!(w["state"].as_str(), Some("paused" | "cancelled"))
    {
        return json!({
            "state": "user_stopped",
            "blockers": blockers,
            "nextAction": "current_user_required",
        });
    }
    if request.is_some() || opt_str(&plan["delegationOrigin"]["agentWaitMessageId"]).is_some() {
        let req_id = request
            .and_then(|r| opt_str(&r["requestId"]))
            .or_else(|| opt_str(&plan["delegationOrigin"]["agentWaitMessageId"]))
            .unwrap_or("");
        let mut obj = Map::new();
        obj.insert("state".into(), json!("waiting_agent"));
        obj.insert("blockers".into(), json!(blockers));
        obj.insert("nextAction".into(), json!("answer_agent_request"));
        obj.insert("requestId".into(), json!(req_id));
        if let Some(r) = request
            && let Some(rev) = r.get("revision").filter(|v| !v.is_null())
        {
            obj.insert("expectedRequestRevision".into(), rev.clone());
        }
        return Value::Object(obj);
    }
    if session["followUp"]["owner"].as_str() == Some("none") {
        return json!({
            "state": "settled",
            "blockers": [],
            "nextAction": "none",
        });
    }
    let sess_status = session["status"].as_str().unwrap_or("");
    if matches!(
        sess_status,
        "running" | "starting" | "queued" | "verifying" | "stopping"
    ) || receipts
        .iter()
        .any(|r| r["effect"].as_str() == Some("pending"))
    {
        return json!({
            "state": "observing",
            "blockers": blockers,
            "nextAction": "observe_current_attempt",
        });
    }
    if mandate.is_none() || !plan["delegationOrigin"]["coordinationBinding"].is_object() {
        return json!({
            "state": "legacy_unbound",
            "blockers": blockers,
            "nextAction": "adopt_with_current_user",
            "expectedRevision": mandate.and_then(|m| m["goalRevision"].as_u64()).unwrap_or(0),
        });
    }
    let goal_rev = mandate
        .and_then(|m| m.get("goalRevision").cloned())
        .unwrap_or(json!(0));
    let blocked_work = related_works
        .iter()
        .copied()
        .find(|w| {
            w["state"].as_str() == Some("blocked_system")
                || w["end"].as_str() == Some("no_progress")
        })
        .or_else(|| {
            work.filter(|w| {
                w["state"].as_str() == Some("blocked_system")
                    || w["end"].as_str() == Some("no_progress")
            })
        });
    if let Some(bw) = blocked_work {
        let wid = opt_str(&bw["workId"]).unwrap_or("current");
        let reason = opt_str(&bw["recovery"]["blockedCode"])
            .or_else(|| opt_str(&bw["recovery"]["failureKind"]))
            .or_else(|| opt_str(&bw["end"]))
            .unwrap_or("blocked_system");
        push_blocker(format!("work:{wid}:{reason}"));
        return json!({
            "state": "blocked",
            "blockers": blockers,
            "nextAction": "inspect_blocker_and_change_method",
            "expectedRevision": goal_rev,
        });
    }
    let human_gate = session["resultConfirmationRequired"].as_bool() == Some(true);
    if let Some(blocker) = takeover_blocker_for_resume(plan, human_gate) {
        push_blocker(blocker.to_owned());
        return json!({
            "state": "blocked",
            "blockers": blockers,
            "nextAction": "inspect_current_facts",
            "expectedRevision": goal_rev,
        });
    }
    json!({
        "state": "repairable",
        "blockers": blockers,
        "nextAction": "coordinate_resume",
        "expectedRevision": goal_rev,
    })
}

fn coordination_facts_for_session(
    buckets: &HashMap<String, HashMap<String, Value>>,
    session_id: &str,
) -> Option<Value> {
    let transitions_map = buckets.get("transitions")?;
    let mut related: Vec<&Value> = transitions_map
        .values()
        .filter(|row| {
            row["action"].as_str() != Some("query")
                && (row["oldSessionId"].as_str() == Some(session_id)
                    || row["replacementSessionId"].as_str() == Some(session_id))
        })
        .collect();
    if related.is_empty() {
        return None;
    }
    related.sort_by(|a, b| {
        let ta = opt_str(&a["updatedAt"])
            .or_else(|| opt_str(&a["createdAt"]))
            .unwrap_or("");
        let tb = opt_str(&b["updatedAt"])
            .or_else(|| opt_str(&b["createdAt"]))
            .unwrap_or("");
        ta.cmp(tb).then_with(|| {
            opt_str(&a["operationId"])
                .unwrap_or("")
                .cmp(opt_str(&b["operationId"]).unwrap_or(""))
        })
    });
    let transition = *related.last()?;
    let lineage = related
        .iter()
        .rev()
        .copied()
        .find(|row| {
            row["action"].as_str() == Some("replace")
                && opt_str(&row["replacementSessionId"]).is_some()
        })
        .unwrap_or(transition);

    let mut obj = Map::new();
    obj.insert("operationId".into(), transition["operationId"].clone());
    obj.insert("action".into(), transition["action"].clone());
    obj.insert("phase".into(), transition["phase"].clone());
    obj.insert(
        "reason".into(),
        transition.get("reason").cloned().unwrap_or(Value::Null),
    );
    obj.insert(
        "goalRevision".into(),
        transition
            .get("expectedGoalRevision")
            .cloned()
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "executionAdmission".into(),
        transition
            .get("executionAdmission")
            .cloned()
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "executionEffect".into(),
        transition
            .get("executionEffect")
            .cloned()
            .unwrap_or(Value::Null),
    );
    obj.insert(
        "executionAttemptRef".into(),
        transition
            .get("executionAttemptRef")
            .cloned()
            .unwrap_or(Value::Null),
    );
    if lineage["action"].as_str() == Some("replace") {
        obj.insert("priorSessionId".into(), lineage["oldSessionId"].clone());
        obj.insert(
            "replacementSessionId".into(),
            lineage["replacementSessionId"].clone(),
        );
        let replacement_title = opt_str(&lineage["operationId"])
            .and_then(|op_id| buckets.get("decisions").and_then(|d| d.get(op_id)))
            .and_then(|dec| dec["payload"]["task"].get("title"))
            .cloned()
            .unwrap_or(Value::Null);
        obj.insert("replacementTitle".into(), replacement_title);
    }
    Some(Value::Object(obj))
}

fn obligation_disposition_for_session(
    buckets: &HashMap<String, HashMap<String, Value>>,
    session_id: &str,
) -> Option<String> {
    let obl_id = buckets.get("obligationHeads")?.get(session_id)?.as_str()?;
    buckets
        .get("obligationDispositions")?
        .get(obl_id)?
        .get("phase")?
        .as_str()
        .map(str::to_owned)
}

fn project_session_value(
    supervisor: &SessionSupervisor,
    plan: &Value,
    summary: &WorkSessionSummary,
    buckets: Option<&HashMap<String, HashMap<String, Value>>>,
    all_summaries: &[WorkSessionSummary],
    child_messages: &[Value],
    parent_anchors: &mut HashMap<String, HashMap<String, String>>,
) -> Value {
    let origin = &plan["delegationOrigin"];
    let session_id = summary.session_id.as_str();
    let workspace_id = summary.workspace_id.as_str();
    let verification_active = opt_str(&origin["phase"]) == Some("verifying")
        && !matches!(opt_str(&plan["status"]), Some("failed" | "cancelled"))
        && opt_str(&plan["resultAcceptance"]["acceptedAt"]).is_none();
    let human_gate = if verification_active {
        false
    } else {
        supervisor.compute_human_gate_with_cache(plan, summary, parent_anchors)
    };
    let coord_facts = buckets.and_then(|b| coordination_facts_for_session(b, session_id));
    let coord_phase = coord_facts.as_ref().and_then(|cf| opt_str(&cf["phase"]));
    let obl_disp = buckets.and_then(|b| obligation_disposition_for_session(b, session_id));
    let lc = decide_lifecycle(
        plan,
        human_gate,
        verification_active,
        coord_phase,
        obl_disp.as_deref(),
    );

    let report = build_session_report(plan, session_id, &lc.status, child_messages);
    let mut report_without_status = report.clone();
    if let Some(obj) = report_without_status.as_object_mut() {
        obj.remove("status");
    }
    let source_rev = verification_content_hash(plan, &report_without_status);
    let obs_rev = session_observation_revision(plan, &source_rev);

    let spawn_conv_id = opt_str(&plan["conversationId"]).unwrap_or(&summary.conversation_id);
    let conv_created_at = if spawn_conv_id.is_empty() {
        String::new()
    } else {
        supervisor.conversation_created_at(spawn_conv_id)
    };
    let spawned_at = if !conv_created_at.is_empty() {
        conv_created_at
    } else {
        opt_str(&plan["createdAt"])
            .or_else(|| opt_str(&plan["updatedAt"]))
            .unwrap_or("")
            .to_owned()
    };

    let mut session = Map::new();
    session.insert("sessionId".into(), json!(session_id));
    session.insert("workspaceId".into(), json!(workspace_id));
    session.insert("title".into(), json!(summary.title));
    session.insert("planId".into(), json!(summary.plan_id));
    session.insert("status".into(), json!(lc.status));
    session.insert("actionRight".into(), json!(lc.action_right));
    session.insert("nextAction".into(), json!(lc.next_action));
    session.insert("statusLabel".into(), json!(lc.status_label));
    session.insert("cancelable".into(), json!(lc.cancelable));
    session.insert("followUp".into(), json!(lc.follow_up));
    session.insert(
        "executionOwnership".into(),
        json!(execution_ownership_of(plan, verification_active)),
    );
    if let Some(ref r) = lc.needs_you_reason {
        session.insert("needsYouReason".into(), json!(r));
    }
    if let Some(cf) = coord_facts {
        session.insert("coordination".into(), cf);
    }
    session.insert("spawnedAt".into(), json!(spawned_at));
    if !summary.conversation_id.is_empty() {
        session.insert("conversationId".into(), json!(summary.conversation_id));
    }
    session.insert("origin".into(), origin.clone());
    if let Some(epoch) = summary.follow_up_epoch {
        session.insert("followUpEpoch".into(), json!(epoch));
    }
    if let Some(closure) = origin
        .get("executionClaimClosure")
        .filter(|v| v.is_object())
    {
        session.insert("executionClaimClosure".into(), closure.clone());
        let recorded = supervisor.list_retained_unknowns(plan);
        let retained = if !recorded.is_empty() {
            recorded
        } else {
            vec![json!({
                "closureId": closure.get("closureId").cloned().unwrap_or(Value::Null),
                "unknownCalls": closure.get("unknownCalls").cloned().unwrap_or_else(|| json!([])),
                "at": closure.get("at").cloned().unwrap_or(Value::Null),
                "proof": if closure["proof"].as_str() == Some("verified_dead") {
                    "verified_dead"
                } else {
                    "legacy_user_confirmed"
                },
            })]
        };
        session.insert("retainedUnknowns".into(), Value::Array(retained));
    }
    if let Some(disp) = obl_disp {
        session.insert("obligationDisposition".into(), json!(disp));
    }
    if let Some(sup) = opt_str(&origin["supersededBy"]) {
        session.insert("supersededBy".into(), json!(sup));
    }
    if origin["phase"].as_str() == Some("paused") {
        session.insert("phase".into(), json!("paused"));
    }
    if origin["phase"].as_str() == Some("queued")
        && let Some(reason) =
            SessionSupervisor::dependency_queue_reason(plan, workspace_id, all_summaries)
    {
        session.insert("queueReason".into(), json!(reason));
    }
    if let Some(vp) = verification_progress_from_plan(plan) {
        session.insert("verificationProgress".into(), vp);
    }
    if let Some(review) = project_completion_review_for_plan(plan, &report)
        && review["confirmed"].as_bool() != Some(true)
    {
        session.insert("completionReviewRequired".into(), json!(true));
    }
    if lc.status == "result_ready" {
        session.insert("resultConfirmationRequired".into(), json!(human_gate));
    }
    session.insert("sourceRevision".into(), json!(source_rev));
    session.insert("observationRevision".into(), json!(obs_rev));

    let interventions: Vec<Value> = child_messages
        .iter()
        .filter(|row| opt_str(&row["answerTo"]).is_some() && opt_str(&row["id"]).is_some())
        .map(|row| json!({ "id": row["id"] }))
        .collect();
    if !interventions.is_empty() {
        session.insert("interventions".into(), Value::Array(interventions));
    }

    Value::Object(session)
}

const SESSION_COORDINATION_BUCKETS: [&str; 7] = [
    "transitions",
    "decisions",
    "obligationHeads",
    "obligationDispositions",
    "works",
    "mandates",
    "agentRequests",
];

const REPORT_EXTRA_BUCKETS: [&str; 8] = [
    "transitions",
    "decisions",
    "obligationHeads",
    "obligationDispositions",
    "works",
    "mandates",
    "agentRequests",
    "agentCommands",
];

fn load_workspace_coordination(
    data_home: &Path,
    workspace_id: &str,
    buckets: &[&str],
) -> Option<HashMap<String, HashMap<String, Value>>> {
    if workspace_id.is_empty() {
        return None;
    }
    read_coordination_read_model_buckets(data_home, workspace_id, buckets).ok()
}

pub(crate) fn load_workspace_session_coordination(
    data_home: &Path,
    workspace_id: &str,
) -> Option<HashMap<String, HashMap<String, Value>>> {
    load_workspace_coordination(data_home, workspace_id, &SESSION_COORDINATION_BUCKETS)
}

pub(crate) fn compute_bot_list_session_lifecycle(
    supervisor: &SessionSupervisor,
    plan: &Value,
    summary: &WorkSessionSummary,
    buckets: Option<&HashMap<String, HashMap<String, Value>>>,
    parent_anchors: &mut HashMap<String, HashMap<String, String>>,
) -> (LifecycleDecision, bool) {
    let origin = &plan["delegationOrigin"];
    let session_id = summary.session_id.as_str();
    let verification_active = opt_str(&origin["phase"]) == Some("verifying")
        && !matches!(opt_str(&plan["status"]), Some("failed" | "cancelled"))
        && opt_str(&plan["resultAcceptance"]["acceptedAt"]).is_none();
    let human_gate = if verification_active {
        false
    } else {
        supervisor.compute_human_gate_with_cache(plan, summary, parent_anchors)
    };
    let coord_facts = buckets.and_then(|b| coordination_facts_for_session(b, session_id));
    let coord_phase = coord_facts.as_ref().and_then(|cf| opt_str(&cf["phase"]));
    let obl_disp = buckets.and_then(|b| obligation_disposition_for_session(b, session_id));
    let lc = decide_lifecycle(
        plan,
        human_gate,
        verification_active,
        coord_phase,
        obl_disp.as_deref(),
    );
    (lc, human_gate)
}

#[derive(Debug, Clone, Default)]
pub struct ListSessionsQuery<'a> {
    pub workspace_id: Option<&'a str>,
    pub work_id: Option<&'a str>,
    pub session_ids: Option<&'a [String]>,
    pub status: Option<&'a str>,
    /// Optional scope: `"all"` (default), `"active"`, or `"history"`.
    pub scope: Option<&'a str>,
    /// Optional history category filter: `"all"`, `"settled"`, `"canceled"`, `"failed"`.
    pub category: Option<&'a str>,
    /// Optional case-insensitive search substring over title / summary / sessionId.
    pub search_query: Option<&'a str>,
    /// Optional sessionId cursor (returns items strictly after this sessionId).
    pub cursor: Option<&'a str>,
    pub limit: Option<usize>,
}

#[derive(Debug, Clone)]
pub struct PagedSessions {
    pub sessions: Vec<Value>,
    pub total_count: usize,
    pub next_cursor: Option<String>,
}

fn matches_history_category(projected: &Value, category: &str) -> bool {
    let status = projected["status"].as_str().unwrap_or("");
    let reason = projected["followUp"]["reason"].as_str().unwrap_or("");
    match category {
        "settled" => status == "accepted" || reason == "settled",
        "canceled" => {
            matches!(status, "cancelled" | "superseded" | "paused")
                || matches!(
                    reason,
                    "stop_confirmed" | "user_withdrawn" | "superseded" | "paused"
                )
        }
        "failed" => {
            status == "failed" || reason == "verification_failed" || reason == "execution_failed"
        }
        _ => true,
    }
}

/// Project delegated sessions with optional ADR 134 scope/category/search/cursor pagination.
pub fn list_sessions_paged(data_home: &Path, query: &ListSessionsQuery<'_>) -> PagedSessions {
    let max_cap = if query.scope.is_some() || query.cursor.is_some() {
        100
    } else {
        50
    };
    let cap = query
        .limit
        .filter(|&n| n > 0)
        .map_or(50, |n| n.min(max_cap));
    let supervisor = SessionSupervisor::new(data_home, None);
    let all_summaries = supervisor.all_delegated_summaries();
    let pairs = supervisor.list_delegated_plans(query.workspace_id);
    let mut coord_cache: HashMap<String, Option<crate::obligation::CoordinationBuckets>> =
        HashMap::new();
    let mut parent_anchors: HashMap<String, HashMap<String, String>> = HashMap::new();
    let sid_set: Option<HashSet<&str>> = query
        .session_ids
        .map(|arr| arr.iter().map(String::as_str).collect());
    let search_q = query
        .search_query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let scope = query.scope.map(str::trim).filter(|s| !s.is_empty());
    let category = query
        .category
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "all");
    let cursor = query.cursor.map(str::trim).filter(|s| !s.is_empty());

    let mut matched = Vec::new();
    for (summary, plan) in pairs {
        if query.work_id.is_some() || sid_set.is_some() {
            let wid_match = query
                .work_id
                .is_some_and(|w| plan["delegationOrigin"]["workId"].as_str() == Some(w));
            let sid_match = sid_set
                .as_ref()
                .is_some_and(|set| set.contains(summary.session_id.as_str()));
            if !wid_match && !sid_match {
                continue;
            }
        }
        let buckets = coord_cache
            .entry(summary.workspace_id.clone())
            .or_insert_with(|| {
                load_workspace_coordination(
                    data_home,
                    &summary.workspace_id,
                    &SESSION_COORDINATION_BUCKETS,
                )
            })
            .as_ref();
        let child_msgs = supervisor.child_conversation_messages(&summary.conversation_id);
        let projected = project_session_value(
            &supervisor,
            &plan,
            &summary,
            buckets,
            &all_summaries,
            &child_msgs,
            &mut parent_anchors,
        );
        if let Some(st) = query.status
            && projected["status"].as_str() != Some(st)
        {
            continue;
        }
        let reason = projected["followUp"]["reason"].as_str().unwrap_or("");
        let in_current = projected["followUp"]["inCurrentList"].as_bool() == Some(true);
        if let Some(sc) = scope {
            if reason == "obligation_indexed" {
                continue;
            }
            if sc == "active" && !in_current {
                continue;
            }
            if sc == "history" && in_current {
                continue;
            }
        }
        if let Some(cat) = category
            && !matches_history_category(&projected, cat)
        {
            continue;
        }
        if let Some(ref q) = search_q {
            let title = projected["title"].as_str().unwrap_or("").to_lowercase();
            let summary_txt = projected["summary"].as_str().unwrap_or("").to_lowercase();
            let sid = projected["sessionId"].as_str().unwrap_or("").to_lowercase();
            if !title.contains(q) && !summary_txt.contains(q) && !sid.contains(q) {
                continue;
            }
        }
        matched.push(projected);
    }

    let total_count = matched.len();
    let start_idx = match cursor {
        Some(c) => matched
            .iter()
            .position(|row| row["sessionId"].as_str() == Some(c))
            .map(|pos| pos + 1)
            .unwrap_or(total_count),
        None => 0,
    };
    let slice_end = (start_idx + cap).min(total_count);
    let sessions = matched[start_idx..slice_end].to_vec();
    let next_cursor = if slice_end < total_count {
        sessions
            .last()
            .and_then(|row| row["sessionId"].as_str())
            .map(str::to_owned)
    } else {
        None
    };

    PagedSessions {
        sessions,
        total_count,
        next_cursor,
    }
}

/// Project delegated sessions matching JS `session-supervisor.mjs#list`.
pub fn list_sessions_projected(
    data_home: &Path,
    workspace_id: Option<&str>,
    work_id: Option<&str>,
    session_ids: Option<&[String]>,
    status: Option<&str>,
    limit: Option<usize>,
) -> Vec<Value> {
    list_sessions_paged(
        data_home,
        &ListSessionsQuery {
            workspace_id,
            work_id,
            session_ids,
            status,
            scope: None,
            category: None,
            search_query: None,
            cursor: None,
            limit,
        },
    )
    .sessions
}

/// Project one delegated session (with optional `report` view) matching `session-supervisor.mjs#get`.
pub fn get_session_projected(
    data_home: &Path,
    session_id: &str,
    detail: Option<&str>,
) -> Option<Value> {
    let trimmed = session_id.trim();
    if trimmed.is_empty() {
        return None;
    }
    let supervisor = SessionSupervisor::new(data_home, None);
    let all_summaries = supervisor.all_delegated_summaries();
    let pairs = supervisor.list_delegated_plans(None);
    let (summary, plan) = pairs.into_iter().find(|(s, _)| s.session_id == trimmed)?;

    let bucket_list: &[&str] = if detail == Some("report") {
        &REPORT_EXTRA_BUCKETS
    } else {
        &SESSION_COORDINATION_BUCKETS
    };
    let buckets = load_workspace_coordination(data_home, &summary.workspace_id, bucket_list);
    let child_msgs = supervisor.child_conversation_messages(&summary.conversation_id);
    let mut parent_anchors = HashMap::new();
    let mut session = project_session_value(
        &supervisor,
        &plan,
        &summary,
        buckets.as_ref(),
        &all_summaries,
        &child_msgs,
        &mut parent_anchors,
    );

    if let Some(worker_cid) = opt_str(&plan["delegationOrigin"]["workerConversationId"])
        && let Ok(Some(working_plan)) =
            peer_store::WorkingPlanStore::new(data_home).read(worker_cid)
        && !working_plan.steps.is_empty()
    {
        let (completed, total, blocked) = working_plan.counts();
        let steps = working_plan
            .steps
            .iter()
            .map(|step| {
                json!({
                    "title": step.title,
                    "status": step.status,
                    "check": step.check,
                    "note": step.note,
                })
            })
            .collect::<Vec<_>>();
        session["workingPlan"] = json!({
            "epoch": working_plan.epoch,
            "revision": working_plan.revision,
            "updatedAt": working_plan.updated_at,
            "summary": working_plan.summary,
            "invariants": working_plan.invariants,
            "completed": completed,
            "total": total,
            "blocked": blocked,
            "steps": steps,
        });
    }

    if detail == Some("report") {
        let sess_status = session["status"].as_str().unwrap_or("");
        let mut report = build_session_report(&plan, trimmed, sess_status, &child_msgs);
        if let Some(b) = buckets.as_ref() {
            let mut requests: Vec<&Value> = b
                .get("agentRequests")
                .map(|m| m.values().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter(|r| {
                    r["sessionId"].as_str() == Some(trimmed) && r["status"].as_str() == Some("open")
                })
                .collect();
            requests.sort_by(|a, b| {
                b["sequence"]
                    .as_i64()
                    .cmp(&a["sequence"].as_i64())
                    .then_with(|| {
                        opt_str(&b["requestId"])
                            .unwrap_or("")
                            .cmp(opt_str(&a["requestId"]).unwrap_or(""))
                    })
            });
            requests.truncate(16);

            let mut receipts: Vec<&Value> = b
                .get("agentCommands")
                .map(|m| m.values().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter(|c| c["sessionId"].as_str() == Some(trimmed))
                .collect();
            receipts.sort_by(|a, b| {
                b["sequence"]
                    .as_i64()
                    .cmp(&a["sequence"].as_i64())
                    .then_with(|| {
                        opt_str(&b["operationId"])
                            .unwrap_or("")
                            .cmp(opt_str(&a["operationId"]).unwrap_or(""))
                    })
            });
            receipts.truncate(16);

            let work_id = opt_str(&plan["delegationOrigin"]["workId"]);
            let work = work_id.and_then(|wid| b.get("works").and_then(|w| w.get(wid)));
            let mandate = work_id.and_then(|wid| b.get("mandates").and_then(|m| m.get(wid)));
            let transitions: Vec<&Value> = b
                .get("transitions")
                .map(|t| t.values().collect())
                .unwrap_or_default();
            let parent_conv = opt_str(&plan["delegationOrigin"]["parentConversationId"]);
            let mut related_works: Vec<&Value> = b
                .get("works")
                .map(|w| w.values().collect::<Vec<_>>())
                .unwrap_or_default()
                .into_iter()
                .filter(|row| {
                    opt_str(&row["parentConversationId"]) == parent_conv
                        && row["sessionIds"]
                            .as_array()
                            .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(trimmed)))
                        && row["state"].as_str() == Some("blocked_system")
                })
                .collect();
            if related_works.len() > 8 {
                let start = related_works.len() - 8;
                related_works = related_works.split_off(start);
            }

            let recovery = supervision_recovery(
                &plan,
                &session,
                work,
                mandate,
                &transitions,
                &receipts,
                &requests,
                &related_works,
            );
            report["agentSupervision"] = json!({
                "requests": requests,
                "receipts": receipts,
                "recovery": recovery,
            });
        }

        let reviewed = opt_str(&plan["hostVerification"]["verdictRef"]).is_some()
            || matches!(
                opt_str(&plan["delegationOrigin"]["independentVerifier"]),
                Some("passed" | "failed" | "not_required")
            )
            || plan["runner"]["verifierRuns"]
                .as_array()
                .is_some_and(|runs| !runs.is_empty());
        if reviewed {
            let indexed: Vec<String> = supervisor
                .indexed_evidence_refs_for_plan(&plan)
                .into_iter()
                .collect();
            report["verification"] = build_verification_detail(&plan, trimmed, &indexed);
        }

        session["report"] = report;
    }

    Some(session)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BotProfileStore, CreateBotProfile, ProjectRegistry};
    use peer_store::{ConversationStore, NewProjectConversation};
    use rusqlite::Connection;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn lifecycle_report_completion_review_and_supervision_recovery_match_contract() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let ws_dir = dir.path().join("repo");
        fs::create_dir_all(&ws_dir).unwrap();
        let reg = ProjectRegistry::new(home)
            .register(&ws_dir.to_string_lossy(), None)
            .unwrap();
        let ws_id = reg.workspace_id;

        let conv_store = ConversationStore::new(home);
        let parent_conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Bot",
                    workspace_id: &ws_id,
                    workspace_path: Some(&reg.path),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: "2026-11-22T01:00:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let parent_id = parent_conv["id"].as_str().unwrap().to_owned();
        BotProfileStore::new(home)
            .create(&CreateBotProfile {
                workspace_id: &ws_id,
                display_name: "TestBot",
                managed: false,
                agent_conversation_id: &parent_id,
                avatar_salt: "",
            })
            .unwrap();

        let child_conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Task 1",
                    workspace_id: &ws_id,
                    workspace_path: Some(&reg.path),
                    role: "work_session",
                    parent_conversation_id: Some(&parent_id),
                    mode: "goal",
                    created_at: "2026-11-22T01:01:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let child_id = child_conv["id"].as_str().unwrap().to_owned();
        conv_store
            .append_classic_message(
                &child_id,
                &json!({
                    "id": "m-worker-1",
                    "role": "assistant",
                    "content": "Completed refactor safely.",
                    "createdAt": "2026-11-22T01:02:00.000Z",
                }),
            )
            .unwrap();

        let plan_dir = home.join("goal-plans");
        fs::create_dir_all(&plan_dir).unwrap();
        let plan_review = json!({
            "planId": "plan-rev-1",
            "conversationId": child_id,
            "title": "Review Task",
            "goal": "Implement and verify manual DoD",
            "status": "executing",
            "createdAt": "2026-11-22T01:01:00.000Z",
            "updatedAt": "2026-11-22T01:03:00.000Z",
            "successCriteria": [{ "id": "c-man", "kind": "manual", "description": "Visual signoff" }],
            "tasks": [{ "taskId": "t1", "title": "Code", "status": "completed", "result": "Leaf ok", "evidenceRefs": ["ev-1"] }],
            "runner": { "status": "blocked", "blockedReason": "manual_dod_confirmation_required" },
            "delegationOrigin": {
                "workspaceId": ws_id,
                "sessionId": "sess-rev-1",
                "workId": "work-1",
                "parentConversationId": parent_id,
                "phase": "running",
                "independentVerifier": "passed",
                "verifierModel": "openai:gpt-5",
                "sameFamilyAsWorker": false
            }
        });
        let plan_done = json!({
            "planId": "plan-done-2",
            "conversationId": child_id,
            "title": "Done Task",
            "goal": "Archived step",
            "status": "completed",
            "createdAt": "2026-11-22T01:00:00.000Z",
            "updatedAt": "2026-11-22T01:02:00.000Z",
            "resultAcceptance": { "acceptedAt": "2026-11-22T01:02:30.000Z", "acceptedBy": "policy" },
            "delegationOrigin": {
                "workspaceId": ws_id,
                "sessionId": "sess-done-2",
                "parentConversationId": parent_id,
                "phase": "ended"
            }
        });
        fs::write(
            plan_dir.join("plan-rev-1.json"),
            serde_json::to_string(&plan_review).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("plan-done-2.json"),
            serde_json::to_string(&plan_done).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("index.jsonl"),
            format!(
                "{}\n{}\n",
                serde_json::to_string(&plan_review).unwrap(),
                serde_json::to_string(&plan_done).unwrap()
            ),
        )
        .unwrap();

        // Seed coordination SQLite read model with open agentRequest for agentSupervision.
        let db_uuid = "11111111-2222-3333-4444-555555555555";
        let db_name = format!("coordination-{db_uuid}.sqlite");
        let rm_dir = home
            .join("project-runtime")
            .join(&ws_id)
            .join(".read-models");
        fs::create_dir_all(&rm_dir).unwrap();
        fs::write(
            rm_dir.join("coordination-current.json"),
            serde_json::to_string(&json!({ "schemaVersion": 1, "file": db_name })).unwrap(),
        )
        .unwrap();
        let conn = Connection::open(rm_dir.join(&db_name)).unwrap();
        conn.execute(
            "CREATE TABLE objects (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (bucket, id))",
            [],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO objects VALUES ('agentRequests', 'req-1', ?)",
            [&serde_json::to_string(&json!({
                "requestId": "req-1",
                "sessionId": "sess-rev-1",
                "status": "open",
                "responder": "user",
                "sequence": 4
            }))
            .unwrap()],
        )
        .unwrap();
        drop(conn);

        // Filter & list check
        let all = list_sessions_projected(home, Some(&ws_id), None, None, None, Some(10));
        assert_eq!(all.len(), 2);
        assert_eq!(all[0]["sessionId"], "sess-rev-1");
        assert_eq!(all[0]["status"], "waiting_user");
        assert_eq!(all[0]["completionReviewRequired"], true);
        assert_eq!(all[0]["followUp"]["owner"], "user");
        assert!(all[0]["sourceRevision"].as_str().is_some());
        assert!(all[0]["observationRevision"].as_str().is_some());

        let only_acc =
            list_sessions_projected(home, Some(&ws_id), None, None, Some("accepted"), Some(1));
        assert_eq!(only_acc.len(), 1);
        assert_eq!(only_acc[0]["sessionId"], "sess-done-2");
        assert_eq!(only_acc[0]["followUp"]["inCurrentList"], false);

        // get_session detail=report includes summary, agentSupervision & verification
        let full = get_session_projected(home, "sess-rev-1", Some("report")).unwrap();
        assert_eq!(full["report"]["summary"], "Completed refactor safely.");
        assert_eq!(full["report"]["contentSource"]["kind"], "worker_message");
        assert_eq!(
            full["report"]["agentSupervision"]["recovery"]["state"],
            "waiting_user"
        );
        assert_eq!(
            full["report"]["agentSupervision"]["requests"][0]["requestId"],
            "req-1"
        );
        assert_eq!(
            full["report"]["verification"]["verifierModel"],
            "openai:gpt-5"
        );

        let rev = project_completion_review_for_plan(&plan_review, &full["report"]).unwrap();
        assert_eq!(rev["criteria"][0]["id"], "c-man");

        assert!(get_session_projected(home, "missing-session", None).is_none());

        // Paged scope / category / query / cursor projection (ADR 134)
        let active_page = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("active"),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(active_page.total_count, 1);
        assert_eq!(active_page.sessions.len(), 1);
        assert_eq!(active_page.sessions[0]["sessionId"], "sess-rev-1");
        assert!(active_page.next_cursor.is_none());

        let hist_page = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("history"),
                category: Some("settled"),
                search_query: Some("done"),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(hist_page.total_count, 1);
        assert_eq!(hist_page.sessions[0]["sessionId"], "sess-done-2");

        let all_paged_1 = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("all"),
                limit: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(all_paged_1.total_count, 2);
        assert_eq!(all_paged_1.sessions.len(), 1);
        let cursor = all_paged_1.next_cursor.as_deref().expect("next cursor");
        let all_paged_2 = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("all"),
                cursor: Some(cursor),
                limit: Some(1),
                ..Default::default()
            },
        );
        assert_eq!(all_paged_2.total_count, 2);
        assert_eq!(all_paged_2.sessions.len(), 1);
        assert_ne!(
            all_paged_2.sessions[0]["sessionId"],
            all_paged_1.sessions[0]["sessionId"]
        );
        assert!(all_paged_2.next_cursor.is_none());
    }

    #[test]
    fn execution_failure_vs_verification_failure_and_review_attempts_projection() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let ws_dir = dir.path().join("repo");
        fs::create_dir_all(&ws_dir).unwrap();
        let reg = ProjectRegistry::new(home)
            .register(&ws_dir.to_string_lossy(), None)
            .unwrap();
        let ws_id = reg.workspace_id;

        let conv_store = ConversationStore::new(home);
        let parent_conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Bot",
                    workspace_id: &ws_id,
                    workspace_path: Some(&reg.path),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: "2026-11-25T01:00:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let parent_id = parent_conv["id"].as_str().unwrap().to_owned();
        BotProfileStore::new(home)
            .create(&CreateBotProfile {
                workspace_id: &ws_id,
                display_name: "TestBot",
                managed: false,
                agent_conversation_id: &parent_id,
                avatar_salt: "",
            })
            .unwrap();

        let plan_dir = home.join("goal-plans");
        fs::create_dir_all(&plan_dir).unwrap();

        // 1) Worker execution failure (never ran verification): must NOT be `verification_failed` or stuck in active list.
        let exec_failed_plan = json!({
            "planId": "plan-exec-fail",
            "conversationId": "conv-exec-fail",
            "title": "Render OpenUI Demo",
            "goal": "Publish interactive demo card",
            "status": "failed",
            "createdAt": "2026-11-25T01:01:00.000Z",
            "updatedAt": "2026-11-25T01:02:00.000Z",
            "tasks": [{ "taskId": "task-1", "title": "Render", "status": "failed", "evidenceRefs": [] }],
            "failure": {
                "code": "tool_not_projected",
                "message": "tool_not_projected",
                "at": "2026-11-25T01:02:00.000Z"
            },
            "delegationOrigin": {
                "workspaceId": ws_id,
                "sessionId": "sess-exec-fail",
                "parentConversationId": parent_id,
                "phase": "failed",
                "error": "tool_not_projected"
            }
        });

        // 2) Completed worker whose independent verifier failed twice: stays active as `verification_failed`
        //    and projects both `reviewAttempts` entries plus verification summary/error.
        let verify_failed_plan = json!({
            "planId": "plan-verify-fail",
            "conversationId": "conv-verify-fail",
            "title": "Audit Build",
            "goal": "Verify build output",
            "status": "completed",
            "createdAt": "2026-11-25T01:03:00.000Z",
            "updatedAt": "2026-11-25T01:05:00.000Z",
            "tasks": [{ "taskId": "task-1", "title": "Build", "status": "completed", "result": "Build output ok", "evidenceRefs": [] }],
            "runner": {
                "verifierRuns": [
                    {
                        "verifierRunId": "vrun-1",
                        "status": "interrupted",
                        "startedAt": "2026-11-25T01:03:30.000Z",
                        "completedAt": "2026-11-25T01:03:42.000Z",
                        "error": "CANCELLED"
                    },
                    {
                        "verifierRunId": "vrun-2",
                        "status": "failed",
                        "startedAt": "2026-11-25T01:04:00.000Z",
                        "completedAt": "2026-11-25T01:04:20.000Z",
                        "failureReason": "Missing test evidence",
                        "summary": "Verifier could not locate test artifact",
                        "report": {
                            "failedCriteria": [{ "criterionId": "c-1", "reason": "No test log", "evidenceRefs": [] }],
                            "missingEvidence": [],
                            "risks": ["flaky runner"],
                            "evidenceRefs": []
                        }
                    }
                ]
            },
            "verificationReport": {
                "passed": false,
                "summary": "Verifier could not locate test artifact",
                "failedCriteria": [{ "criterionId": "c-1", "reason": "No test log", "evidenceRefs": [] }]
            },
            "delegationOrigin": {
                "workspaceId": ws_id,
                "sessionId": "sess-verify-fail",
                "parentConversationId": parent_id,
                "phase": "completed",
                "independentVerifier": "failed",
                "verifierModel": "gpt-6.2-sol"
            }
        });

        fs::write(
            plan_dir.join("plan-exec-fail.json"),
            serde_json::to_string(&exec_failed_plan).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("plan-verify-fail.json"),
            serde_json::to_string(&verify_failed_plan).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("index.jsonl"),
            "{\"planId\":\"plan-exec-fail\"}\n{\"planId\":\"plan-verify-fail\"}\n",
        )
        .unwrap();

        let active = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("active"),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(active.total_count, 1);
        assert_eq!(active.sessions[0]["sessionId"], "sess-verify-fail");
        assert_eq!(
            active.sessions[0]["followUp"]["reason"],
            "verification_failed"
        );

        let history_failed = list_sessions_paged(
            home,
            &ListSessionsQuery {
                workspace_id: Some(&ws_id),
                scope: Some("history"),
                category: Some("failed"),
                limit: Some(10),
                ..Default::default()
            },
        );
        assert_eq!(history_failed.total_count, 1);
        assert_eq!(history_failed.sessions[0]["sessionId"], "sess-exec-fail");
        assert_eq!(
            history_failed.sessions[0]["followUp"]["inCurrentList"],
            false
        );
        assert_eq!(
            history_failed.sessions[0]["followUp"]["reason"],
            "execution_failed"
        );

        let exec_detail = get_session_projected(home, "sess-exec-fail", Some("report")).unwrap();
        assert_eq!(
            exec_detail["report"]["failure"]["code"],
            "tool_not_projected"
        );
        assert!(exec_detail["report"].get("verification").is_none());

        let vf_detail = get_session_projected(home, "sess-verify-fail", Some("report")).unwrap();
        let ver = &vf_detail["report"]["verification"];
        assert_eq!(ver["outcome"], "failed");
        assert_eq!(ver["summary"], "Verifier could not locate test artifact");
        let attempts = ver["reviewAttempts"]
            .as_array()
            .expect("reviewAttempts array");
        assert_eq!(attempts.len(), 2);
        assert_eq!(attempts[0]["verifierRunId"], "vrun-1");
        assert_eq!(attempts[0]["status"], "failed");
        assert_eq!(attempts[0]["failureReason"], "CANCELLED");
        assert_eq!(attempts[1]["verifierRunId"], "vrun-2");
        assert_eq!(attempts[1]["failureReason"], "Missing test evidence");
        assert_eq!(attempts[1]["failedCriteria"][0]["reason"], "No test log");
    }

    #[test]
    fn worker_conversation_id_takes_precedence_over_plan_stub_conversation() {
        let dir = tempdir().unwrap();
        let home = dir.path();
        let ws_dir = dir.path().join("repo");
        fs::create_dir_all(&ws_dir).unwrap();
        let reg = ProjectRegistry::new(home)
            .register(&ws_dir.to_string_lossy(), None)
            .unwrap();
        let ws_id = reg.workspace_id;

        let conv_store = ConversationStore::new(home);
        let parent_conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Bot",
                    workspace_id: &ws_id,
                    workspace_path: Some(&reg.path),
                    role: "project_agent",
                    parent_conversation_id: None,
                    mode: "project_agent",
                    created_at: "2026-11-25T02:00:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let parent_id = parent_conv["id"].as_str().unwrap().to_owned();
        let stub_conv = conv_store
            .create_project_conversation(
                &NewProjectConversation {
                    id: None,
                    title: "Stub Task",
                    workspace_id: &ws_id,
                    workspace_path: Some(&reg.path),
                    role: "work_session",
                    parent_conversation_id: Some(&parent_id),
                    mode: "goal",
                    created_at: "2026-11-25T02:01:00.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let stub_id = stub_conv["id"].as_str().unwrap().to_owned();
        conv_store
            .append_message_idempotent(
                &stub_id,
                &json!({
                    "id": format!("brief-{stub_id}"),
                    "role": "user",
                    "content": "Brief only",
                    "createdAt": "2026-11-25T02:01:00.000Z",
                }),
                "2026-11-25T02:01:00.000Z",
                None,
            )
            .unwrap();

        let worker_conv = conv_store
            .create_with_model(
                &peer_store::NewConversation {
                    title: "Stub Task",
                    workspace_path: Some(&reg.path),
                    mode: "chat",
                    created_at: "2026-11-25T02:01:02.000Z",
                },
                None,
                None,
            )
            .unwrap();
        let worker_id = worker_conv["id"].as_str().unwrap().to_owned();
        conv_store
            .append_message_idempotent(
                &worker_id,
                &json!({
                    "id": "worker-msg-1",
                    "role": "assistant",
                    "content": "Verified real worker findings.",
                    "createdAt": "2026-11-25T02:02:00.000Z",
                }),
                "2026-11-25T02:02:00.000Z",
                None,
            )
            .unwrap();

        let plan_dir = home.join("goal-plans");
        fs::create_dir_all(&plan_dir).unwrap();
        let plan = json!({
            "planId": "plan-worker-conv",
            "conversationId": stub_id,
            "title": "Research ACP",
            "goal": "Investigate ACP",
            "status": "completed",
            "createdAt": "2026-11-25T02:01:00.000Z",
            "updatedAt": "2026-11-25T02:02:00.000Z",
            "tasks": [{ "taskId": "task-1", "title": "Research ACP", "status": "completed", "evidenceRefs": [] }],
            "delegationOrigin": {
                "workspaceId": ws_id,
                "sessionId": stub_id,
                "parentConversationId": parent_id,
                "workerConversationId": worker_id,
                "phase": "completed"
            }
        });
        fs::write(
            plan_dir.join("plan-worker-conv.json"),
            serde_json::to_string(&plan).unwrap(),
        )
        .unwrap();
        fs::write(
            plan_dir.join("index.jsonl"),
            "{\"planId\":\"plan-worker-conv\"}\n",
        )
        .unwrap();

        let sup = SessionSupervisor::new(home, None);
        let listed = sup.list_sessions(&ws_id);
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].session_id, stub_id);
        assert_eq!(listed[0].conversation_id, worker_id);

        let bot_listed = sup.list_bot_sessions(&ws_id);
        assert_eq!(bot_listed.len(), 1);
        assert_eq!(bot_listed[0].session_id, stub_id);
        assert_eq!(
            bot_listed[0].conversation_id.as_deref(),
            Some(worker_id.as_str())
        );

        let detail = get_session_projected(home, &stub_id, Some("report")).unwrap();
        assert_eq!(detail["sessionId"], stub_id);
        assert_eq!(detail["conversationId"], worker_id);
        assert_eq!(detail["spawnedAt"], "2026-11-25T02:01:00.000Z");
        assert_eq!(
            detail["report"]["summary"],
            "Verified real worker findings."
        );
        assert_eq!(
            detail["report"]["contentSource"]["conversationId"],
            worker_id
        );
    }
}
