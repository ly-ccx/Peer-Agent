//! Verification verdicts, acceptance close gate, and policy/user acceptance decisions.
//!
//! Matches `packages/protocol/src/delegation.ts#decideAcceptance`,
//! `packages/runtime-node/src/project-agent/verification-verdict.mjs`, and
//! `packages/runtime-node/src/project-agent/acceptance.mjs` (ADR 80 §8, ADR 88 §7, ADR 103).
//!
//! Verdict and close-gate truth come ONLY from the host Evidence index and canonical
//! GoalPlan records — never from model prose or self-asserted `userAgreed` flags.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;

pub const CHANGED_FILE_CONFIRM_LIMIT: usize = 20;

const CONFIRM_REASON_ORDER: [&str; 8] = [
    "verdict_not_passed",
    "manual_criteria_pending",
    "external_side_effects",
    "destructive_operation",
    "out_of_scope_write",
    "project_requires_confirm",
    "user_requested_review",
    "verification_below_floor",
];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationCheck {
    pub name: String,
    pub passed: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VerificationVerdict {
    pub outcome: String,
    pub independent_verifier: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub verifier_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub same_family_as_worker: Option<bool>,
    pub checks: Vec<VerificationCheck>,
    pub evidence_refs: Vec<String>,
}

#[derive(Debug, Clone, Default)]
pub struct HostAuthorityFacts {
    pub independent_verifier: Option<String>,
    pub verifier_model: Option<String>,
    pub same_family_as_worker: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcceptanceDecision {
    pub verdict: VerificationVerdict,
    pub verdict_ref: String,
    pub mode: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub accepted_by: Option<String>,
    pub reasons: Vec<String>,
    pub reported: bool,
    pub close_gate_passed: bool,
}

#[derive(Debug, Clone)]
pub struct AcceptanceFacts<'a> {
    pub plan: &'a Value,
    pub session_id: &'a str,
    pub evidence_index: &'a HashSet<String>,
    pub host_authority: HostAuthorityFacts,
    pub policy: &'a str,
    pub reported: bool,
    pub read_only: bool,
    pub changed_files: Vec<String>,
    pub manual_criteria_pending: bool,
    pub external_side_effects: bool,
    pub irreversible: bool,
    pub out_of_scope_write: bool,
    pub anchor_text: &'a str,
    pub verification_below_floor: bool,
}

pub fn anchor_requests_review(text: &str) -> bool {
    let lower = text.to_lowercase();
    [
        "确认一下",
        "给我看看",
        "等我确认",
        "先让我确认",
        "先别签",
        "let me review",
        "ask me to confirm",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

pub fn verdict_ref_for(session_id: &str, outcome: &str) -> String {
    let id = if session_id.trim().is_empty() {
        "session"
    } else {
        session_id.trim()
    };
    let out = if outcome.trim().is_empty() {
        "unknown"
    } else {
        outcome.trim()
    };
    format!("verdict:{id}:{out}")
}

pub fn is_handoff_conflict(handoff: &Value) -> bool {
    handoff["status"].as_str() == Some("stopped")
        && !matches!(
            handoff["stoppedReason"].as_str(),
            Some("acceptance_required" | "handoff_confirmation_required")
        )
}

pub fn handoff_question_id(
    accepted_at: &str,
    conflict: bool,
    updated_at: Option<&str>,
    commit_sha: Option<&str>,
    stopped_reason: Option<&str>,
) -> String {
    let payload = if conflict {
        serde_json::json!([accepted_at, updated_at, commit_sha, stopped_reason])
    } else {
        serde_json::json!([accepted_at])
    };
    let encoded = serde_json::to_string(&payload).unwrap_or_default();
    let hash = format!("{:x}", Sha256::digest(encoded.as_bytes()));
    let prefix = if conflict {
        "handoff_conflict"
    } else {
        "handoff"
    };
    format!("{prefix}-{}", &hash[..16])
}

fn collect_leaf_tasks<'a>(tasks: &'a [Value], out: &mut Vec<&'a Value>) {
    for task in tasks {
        let subtasks = task["subtasks"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        if !subtasks.is_empty() {
            collect_leaf_tasks(subtasks, out);
        } else {
            out.push(task);
        }
    }
}

fn collect_plan_evidence_refs(plan: &Value) -> Vec<String> {
    fn visit(tasks: &[Value], out: &mut Vec<String>) {
        for task in tasks {
            if let Some(refs) = task["evidenceRefs"].as_array() {
                for r in refs {
                    if let Some(s) = r.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                        out.push(s.to_owned());
                    }
                }
            }
            if let Some(sub) = task["subtasks"].as_array() {
                visit(sub, out);
            }
        }
    }
    let mut refs = Vec::new();
    if let Some(tasks) = plan["tasks"].as_array() {
        visit(tasks, &mut refs);
    }
    refs
}

/// Evaluates whether a manual criterion has a confirming latest `manualConfirmations` entry.
/// Supports both TS canonical `{ kind: "manual_dod", decision: "approve", criterionIds: [...] }`
/// (sorted by `decidedAt` descending with array-index tie-breaker) and legacy `{ criterionId, decision: "confirmed" }`.
pub fn is_manual_criterion_confirmed(manual_confirmations: &[Value], criterion_id: &str) -> bool {
    let mut matches: Vec<(usize, &Value)> = manual_confirmations
        .iter()
        .enumerate()
        .filter(|(_, row)| {
            let kind_ok = row.get("kind").is_none()
                || row["kind"].is_null()
                || row["kind"].as_str() == Some("manual_dod");
            let matches_criterion = row["criterionIds"]
                .as_array()
                .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(criterion_id)))
                || row["criterionId"].as_str() == Some(criterion_id);
            kind_ok && matches_criterion
        })
        .collect();
    matches.sort_by(|(idx_a, row_a), (idx_b, row_b)| {
        let ts_a = row_a["decidedAt"].as_str().unwrap_or("");
        let ts_b = row_b["decidedAt"].as_str().unwrap_or("");
        ts_b.cmp(ts_a).then_with(|| idx_b.cmp(idx_a))
    });
    matches
        .first()
        .is_some_and(|(_, row)| matches!(row["decision"].as_str(), Some("approve" | "confirmed")))
}

/// Returns `true` when the host's independent verifier completed with a passing
/// structured verdict backed by host-indexed Evidence and did not fail `criterion_id`.
pub(crate) fn criterion_verified_by_independent_report(
    plan: &Value,
    criterion_id: &str,
    known_refs: &HashSet<String>,
) -> bool {
    if plan["delegationOrigin"]["independentVerifier"].as_str() != Some("passed") {
        return false;
    }
    let report = &plan["verificationReport"];
    if report["passed"].as_bool() != Some(true) {
        return false;
    }
    let explicitly_failed = report["failedCriteria"]
        .as_array()
        .into_iter()
        .flatten()
        .any(|fc| fc["criterionId"].as_str() == Some(criterion_id));
    if explicitly_failed {
        return false;
    }
    report["evidenceRefs"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .any(|r| !r.is_empty() && known_refs.contains(r))
}

fn criterion_result_has_indexed_evidence(result: &Value, known_refs: &HashSet<String>) -> bool {
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
        .any(|r| !r.is_empty() && known_refs.contains(r));
    single_ok || multi_ok
}

fn evaluate_close_gate_inner(
    plan: &Value,
    known_refs: &HashSet<String>,
    require_manual_confirmed: bool,
) -> (bool, Vec<String>) {
    let tasks = plan["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut leaves = Vec::new();
    collect_leaf_tasks(tasks, &mut leaves);
    if leaves.is_empty() {
        return (false, vec!["no_leaf_tasks".to_owned()]);
    }
    let mut unmet = Vec::new();
    for leaf in &leaves {
        let status = leaf["status"].as_str().unwrap_or("");
        let tid = leaf["taskId"].as_str().unwrap_or("unknown");
        if status != "completed" {
            unmet.push(format!("task:{tid}:status_{status}"));
            continue;
        }
        let has_indexed_evidence = leaf["evidenceRefs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .any(|r| known_refs.contains(r.trim()));
        if !has_indexed_evidence {
            unmet.push(format!("task:{tid}:missing_indexed_evidence"));
        }
    }
    if let Some(criteria) = plan["successCriteria"].as_array() {
        let results = plan["criterionResults"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let reviews = plan["modelReviews"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let manual_confirmations = plan["manualConfirmations"]
            .as_array()
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        for criterion in criteria {
            let cid = criterion["id"].as_str().unwrap_or("");
            let kind = criterion["kind"].as_str().unwrap_or("");
            match kind {
                "manual" => {
                    if require_manual_confirmed
                        && !is_manual_criterion_confirmed(manual_confirmations, cid)
                    {
                        unmet.push(format!("criterion:{cid}:manual_pending"));
                    }
                }
                "model_review" => {
                    let reviewed =
                        reviews.iter().any(|r| {
                            r["criterionId"].as_str() == Some(cid)
                                && r["passed"] == true
                                && criterion_result_has_indexed_evidence(r, known_refs)
                        }) || criterion_verified_by_independent_report(plan, cid, known_refs);
                    if !reviewed {
                        unmet.push(format!("criterion:{cid}:model_review_unmet"));
                    }
                }
                "command" | "test" => {
                    let passed =
                        results.iter().any(|r| {
                            r["criterionId"].as_str() == Some(cid)
                                && r["passed"] == true
                                && criterion_result_has_indexed_evidence(r, known_refs)
                        }) || criterion_verified_by_independent_report(plan, cid, known_refs);
                    if !passed {
                        unmet.push(format!("criterion:{cid}:check_unmet"));
                    }
                }
                _ => {
                    let passed = results.iter().any(|r| {
                        r["criterionId"].as_str() == Some(cid)
                            && r["passed"] == true
                            && criterion_result_has_indexed_evidence(r, known_refs)
                    });
                    if !passed {
                        unmet.push(format!("criterion:{cid}:check_unmet"));
                    }
                }
            }
        }
    }
    (unmet.is_empty(), unmet)
}

/// Evaluates whether every leaf task is completed with indexed host Evidence and
/// all required automatic/model_review/manual criteria pass against the host Evidence index.
pub fn evaluate_acceptance_close_gate(
    plan: &Value,
    known_refs: &HashSet<String>,
) -> (bool, Vec<String>) {
    evaluate_close_gate_inner(plan, known_refs, true)
}

/// Evaluates leaf evidence and all non-manual (`file-*`, `command`, `test`, `model_review`)
/// criteria without requiring `manual` criteria to already be confirmed.
pub(crate) fn evaluate_mechanical_close_gate(
    plan: &Value,
    known_refs: &HashSet<String>,
) -> (bool, Vec<String>) {
    evaluate_close_gate_inner(plan, known_refs, false)
}

pub fn compute_verification_verdict(
    plan: &Value,
    evidence_index: &HashSet<String>,
    host_authority: &HostAuthorityFacts,
) -> VerificationVerdict {
    let tasks = plan["tasks"].as_array().map(Vec::as_slice).unwrap_or(&[]);
    let mut leaves = Vec::new();
    collect_leaf_tasks(tasks, &mut leaves);
    let independent = host_authority
        .independent_verifier
        .clone()
        .unwrap_or_else(|| "missing".to_owned());

    let (gate_ok, unmet) = evaluate_acceptance_close_gate(plan, evidence_index);
    let unmet_leaf_count = unmet.iter().filter(|u| u.starts_with("task:")).count();

    let outcome = if leaves.is_empty() {
        "unverifiable"
    } else if independent == "failed" {
        "failed"
    } else if gate_ok {
        "passed"
    } else if unmet_leaf_count < leaves.len() {
        "partial"
    } else {
        "failed"
    };

    let mut checks = Vec::new();
    if leaves.is_empty() {
        checks.push(VerificationCheck {
            name: "leaves".to_owned(),
            passed: false,
            reason: Some("no_leaf_tasks".to_owned()),
        });
    } else {
        let first_task_unmet = unmet.iter().find(|u| u.starts_with("task:")).cloned();
        checks.push(VerificationCheck {
            name: "leaf_evidence".to_owned(),
            passed: first_task_unmet.is_none(),
            reason: first_task_unmet,
        });
    }
    let verifier_passed = matches!(independent.as_str(), "passed" | "not_required");
    checks.push(VerificationCheck {
        name: "independent_verifier".to_owned(),
        passed: verifier_passed,
        reason: (!verifier_passed).then_some(independent.clone()),
    });

    let mut seen = HashSet::new();
    let mut intersected = Vec::new();
    for r in collect_plan_evidence_refs(plan) {
        if evidence_index.contains(&r) && seen.insert(r.clone()) {
            intersected.push(r);
        }
    }

    VerificationVerdict {
        outcome: outcome.to_owned(),
        independent_verifier: independent,
        verifier_model: host_authority.verifier_model.clone(),
        same_family_as_worker: host_authority.same_family_as_worker,
        checks,
        evidence_refs: intersected,
    }
}

/// Computes the authoritative acceptance decision. `user_confirm` is ONLY passed by
/// the local user confirmation command, never by model parameters.
pub fn decide_session_acceptance(
    facts: &AcceptanceFacts<'_>,
    user_confirm: bool,
) -> AcceptanceDecision {
    let verdict =
        compute_verification_verdict(facts.plan, facts.evidence_index, &facts.host_authority);
    let verdict_ref = verdict_ref_for(facts.session_id, &verdict.outcome);
    let (close_gate_passed, _) = evaluate_acceptance_close_gate(facts.plan, facts.evidence_index);
    let policy = if facts.policy == "confirm" {
        "confirm"
    } else {
        "auto"
    };

    let mut raw_reasons: HashSet<&'static str> = HashSet::new();
    if verdict.outcome != "passed" {
        raw_reasons.insert("verdict_not_passed");
    }
    if facts.manual_criteria_pending {
        raw_reasons.insert("manual_criteria_pending");
    }
    if facts.external_side_effects {
        raw_reasons.insert("external_side_effects");
    }
    if facts.irreversible {
        raw_reasons.insert("destructive_operation");
    }
    if facts.out_of_scope_write {
        raw_reasons.insert("out_of_scope_write");
    }
    if policy == "confirm" {
        raw_reasons.insert("project_requires_confirm");
    }
    if anchor_requests_review(facts.anchor_text) {
        raw_reasons.insert("user_requested_review");
    }
    if facts.verification_below_floor {
        raw_reasons.insert("verification_below_floor");
    }

    let mut reasons: Vec<String> = CONFIRM_REASON_ORDER
        .iter()
        .filter(|r| raw_reasons.contains(**r))
        .map(|s| (*s).to_owned())
        .collect();

    let mut unique_files = HashSet::new();
    for path in &facts.changed_files {
        let t = path.trim();
        if !t.is_empty() {
            unique_files.insert(t);
        }
    }
    let over_limit = !facts.read_only && unique_files.len() > CHANGED_FILE_CONFIRM_LIMIT;
    if over_limit {
        reasons.push("changed_files_over_limit".to_owned());
    }

    let mode = if reasons.is_empty() {
        "auto"
    } else {
        "confirm"
    };
    let accepted_by =
        if reasons.is_empty() && policy == "auto" && facts.reported && close_gate_passed {
            Some("policy".to_owned())
        } else if !reasons.is_empty() && user_confirm && close_gate_passed && mode == "confirm" {
            Some("user".to_owned())
        } else {
            None
        };

    AcceptanceDecision {
        verdict,
        verdict_ref,
        mode: mode.to_owned(),
        accepted_by,
        reasons,
        reported: facts.reported,
        close_gate_passed,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn policy_acceptance_requires_indexed_evidence_and_reported_reply() {
        let plan = json!({
            "planId": "p1",
            "tasks": [{"taskId": "t1", "status": "completed", "evidenceRefs": ["ev-1"]}],
            "successCriteria": [{"id": "c1", "kind": "file-exists", "description": "exists"}],
            "criterionResults": [{"criterionId": "c1", "passed": true, "evidenceRefs": ["ev-1"]}],
        });
        let empty_index = HashSet::new();
        let indexed: HashSet<String> = ["ev-1".to_owned()].into_iter().collect();

        // Missing from host Evidence index -> fails close gate, cannot auto-accept.
        let unindexed = decide_session_acceptance(
            &AcceptanceFacts {
                plan: &plan,
                session_id: "s1",
                evidence_index: &empty_index,
                host_authority: HostAuthorityFacts {
                    independent_verifier: Some("passed".into()),
                    ..Default::default()
                },
                policy: "auto",
                reported: true,
                read_only: false,
                changed_files: vec!["a.rs".into()],
                manual_criteria_pending: false,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text: "fix bug",
                verification_below_floor: false,
            },
            false,
        );
        assert!(!unindexed.close_gate_passed);
        assert_eq!(unindexed.accepted_by, None);

        // With indexed Evidence + reported + auto policy -> policy accepted.
        let accepted = decide_session_acceptance(
            &AcceptanceFacts {
                plan: &plan,
                session_id: "s1",
                evidence_index: &indexed,
                host_authority: HostAuthorityFacts {
                    independent_verifier: Some("passed".into()),
                    ..Default::default()
                },
                policy: "auto",
                reported: true,
                read_only: false,
                changed_files: vec!["a.rs".into()],
                manual_criteria_pending: false,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text: "fix bug",
                verification_below_floor: false,
            },
            false,
        );
        assert!(accepted.close_gate_passed);
        assert_eq!(accepted.accepted_by.as_deref(), Some("policy"));

        // Over 20 changed files forces confirm mode even with auto policy.
        let too_many: Vec<String> = (0..21).map(|i| format!("f{i}.rs")).collect();
        let forced_confirm = decide_session_acceptance(
            &AcceptanceFacts {
                plan: &plan,
                session_id: "s1",
                evidence_index: &indexed,
                host_authority: HostAuthorityFacts {
                    independent_verifier: Some("passed".into()),
                    ..Default::default()
                },
                policy: "auto",
                reported: true,
                read_only: false,
                changed_files: too_many,
                manual_criteria_pending: false,
                external_side_effects: false,
                irreversible: false,
                out_of_scope_write: false,
                anchor_text: "fix bug",
                verification_below_floor: false,
            },
            false,
        );
        assert_eq!(forced_confirm.mode, "confirm");
        assert_eq!(forced_confirm.accepted_by, None);
        assert!(
            forced_confirm
                .reasons
                .contains(&"changed_files_over_limit".to_owned())
        );
    }

    #[test]
    fn manual_criterion_confirmed_supports_canonical_latest_and_legacy_formats() {
        let canonical = vec![json!({
            "confirmationId": "completion-review:tok-1",
            "kind": "manual_dod",
            "decision": "approve",
            "criterionIds": ["m1"],
            "decidedAt": "2026-11-22T01:00:00.000Z",
        })];
        assert!(is_manual_criterion_confirmed(&canonical, "m1"));
        assert!(!is_manual_criterion_confirmed(&canonical, "m2"));

        // Later reject overrides earlier approve by decidedAt
        let overridden = vec![
            canonical[0].clone(),
            json!({
                "confirmationId": "completion-review:tok-2",
                "kind": "manual_dod",
                "decision": "reject",
                "criterionIds": ["m1"],
                "decidedAt": "2026-11-22T02:00:00.000Z",
            }),
        ];
        assert!(!is_manual_criterion_confirmed(&overridden, "m1"));

        // Legacy test fixture format still supported
        let legacy = vec![json!({
            "criterionId": "m1",
            "decision": "confirmed",
        })];
        assert!(is_manual_criterion_confirmed(&legacy, "m1"));
    }
}
