//! Execution obligation inspection, authorization grants, disposition settlement,
//! and bounded host unknown-outcome reconciliation (`execution-obligation.mjs`,
//! `execution-obligation-kernel.mjs`, `unknown-outcome-reconciliation.mjs`, ADR 127).

use crate::{
    BotProfileStore, CoordinationHub, ProjectError, SessionSupervisor, is_valid_workspace_id,
    now_iso, parse_iso_ms, sha256_json,
};
use peer_protocol::{
    NativeProcessRecorder, SessionExecutionIdentity, normalize_session_execution_identity,
};
use peer_runtime::recorder;
use peer_store::{ExecutionResourceStore, HostClaimClosure, HostResourcePlan, ResourceError};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

pub const OBLIGATION_FORMAT_VERSION: u64 = 11;
pub const OBLIGATION_GRANT_TTL_MS: i64 = 15 * 60 * 1000;

const ALLOWED_ACTIONS: [&str; 4] = [
    "retire_follow_up",
    "acknowledge_unknown",
    "restore_follow_up",
    "close_claim",
];
const RECORDER_FIELDS: [&str; 5] = ["bootId", "pid", "pidStart", "hostId", "acquiredAt"];

static PROOF_CACHE: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

fn proof_cache() -> &'static Mutex<HashMap<String, String>> {
    PROOF_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

fn cache_proof(key: &str, proof: &str) {
    if let Ok(mut g) = proof_cache().lock() {
        if g.len() > 512 {
            g.clear();
        }
        g.insert(key.to_owned(), proof.to_owned());
    }
}

fn cached_proof(key: &str) -> Option<String> {
    proof_cache().lock().ok().and_then(|g| g.get(key).cloned())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObligationClassification {
    pub classes: Vec<String>,
    pub gaps: Vec<String>,
    pub missing_fields: Vec<String>,
    pub unknown_call_ids: Vec<String>,
    pub open_handle_ids: Vec<String>,
    pub ownership: String,
    pub proof: String,
    pub allowed_actions: Vec<String>,
    pub closeable: bool,
    pub registration_absent: bool,
    pub stable_refusal: bool,
    pub barrier: bool,
}

pub fn obligation_id_for(
    workspace_id: &str,
    session_id: &str,
    plan_id: &str,
    operation_id: &str,
) -> String {
    format!(
        "obl_{}",
        sha256_json(&json!([workspace_id, session_id, plan_id, operation_id]))
    )
}

pub fn canonical_grant_key(grant_id: &str, items: &[Value], evidence_revision: &str) -> String {
    let mut norm_items: Vec<Value> = items
        .iter()
        .map(|item| {
            let mut actions: Vec<String> = item["actions"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            actions.sort();
            json!({
                "actions": actions,
                "operationId": item["operationId"].as_str().unwrap_or(""),
                "sessionId": item["sessionId"].as_str().unwrap_or(""),
            })
        })
        .collect();
    norm_items.sort_by(|a, b| {
        a["sessionId"]
            .as_str()
            .unwrap_or("")
            .cmp(b["sessionId"].as_str().unwrap_or(""))
            .then_with(|| {
                a["operationId"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["operationId"].as_str().unwrap_or(""))
            })
    });
    sha256_json(&json!({
        "evidenceRevision": evidence_revision,
        "grantId": grant_id,
        "items": norm_items,
    }))
}

fn parse_recorder(raw: &Value) -> Option<NativeProcessRecorder> {
    let obj = raw.as_object()?;
    let boot_id = obj.get("bootId")?.as_str()?.to_owned();
    let pid = u32::try_from(obj.get("pid")?.as_u64()?).ok()?;
    let pid_start = obj.get("pidStart")?.as_str()?.to_owned();
    let host_id = obj.get("hostId")?.as_str()?.to_owned();
    let acquired_at = obj.get("acquiredAt")?.as_str()?.to_owned();
    let rec = NativeProcessRecorder {
        boot_id,
        pid,
        pid_start,
        host_id,
        acquired_at,
    };
    rec.complete().then_some(rec)
}

fn missing_recorder_fields(recorder_val: Option<&Value>) -> Vec<String> {
    let Some(obj) = recorder_val.and_then(Value::as_object) else {
        return RECORDER_FIELDS.iter().map(|s| (*s).to_owned()).collect();
    };
    let mut missing = Vec::new();
    for field in RECORDER_FIELDS {
        match field {
            "pid" => {
                if obj
                    .get("pid")
                    .and_then(Value::as_u64)
                    .is_none_or(|n| n == 0 || n > i32::MAX as u64)
                {
                    missing.push(field.to_owned());
                }
            }
            _ => {
                if obj
                    .get(field)
                    .and_then(Value::as_str)
                    .is_none_or(|s| s.is_empty())
                {
                    missing.push(field.to_owned());
                }
            }
        }
    }
    missing
}

fn derive_ownership(plan: &Value) -> &'static str {
    let phase = plan["delegationOrigin"]["phase"].as_str().unwrap_or("");
    let status = plan["status"].as_str().unwrap_or("");
    if matches!(status, "cancelled" | "failed" | "completed" | "interrupted")
        || plan["resultAcceptance"]["acceptedAt"].is_string()
    {
        return "ended";
    }
    if matches!(phase, "running" | "starting" | "verifying") {
        return "live";
    }
    if phase.is_empty() && status.is_empty() {
        "unknown"
    } else {
        "ended"
    }
}

fn unsettled_plan_calls(plan: &Value) -> Vec<String> {
    let mut set = BTreeSet::new();
    if let Some(arr) = plan["delegationOrigin"]["uncertainDispatches"].as_array() {
        for item in arr {
            if let Some(id) = item["toolCallId"]
                .as_str()
                .or_else(|| item.as_str())
                .filter(|s| !s.is_empty())
            {
                set.insert(id.to_owned());
            }
        }
    }
    set.into_iter().collect()
}

pub fn classify_execution_obligation(
    plan: &Value,
    control: Option<&Value>,
    claims: &[Value],
    proof: &str,
    writer_epoch: Option<&str>,
    disposition: Option<&str>,
) -> ObligationClassification {
    let ownership = derive_ownership(plan);
    let mut unknown_set = BTreeSet::new();
    for id in unsettled_plan_calls(plan) {
        unknown_set.insert(id);
    }
    let mut open_set = BTreeSet::new();
    for claim in claims {
        if let Some(calls) = claim["evidenceCalls"].as_array() {
            for id in calls
                .iter()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                unknown_set.insert(id.to_owned());
            }
        }
        if let Some(handles) = claim["handles"].as_object() {
            for handle in handles.values() {
                if handle["state"].as_str() != Some("ended")
                    && let Some(hid) = handle["handleId"]
                        .as_str()
                        .or_else(|| handle["toolCallId"].as_str())
                        .filter(|s| !s.is_empty())
                {
                    open_set.insert(hid.to_owned());
                }
            }
        }
    }
    let unknown_call_ids: Vec<String> = unknown_set.into_iter().collect();
    let open_handle_ids: Vec<String> = open_set.into_iter().collect();

    let has_stop_receipt = control
        .and_then(|c| c.get("stopReceipt"))
        .is_some_and(|v| !v.is_null() && *v != Value::Bool(false));
    let registration_absent =
        unknown_call_ids.is_empty() && open_handle_ids.is_empty() && !has_stop_receipt;
    let ctrl_phase = control.and_then(|c| c["phase"].as_str()).unwrap_or("");
    let ctrl_outcome = control.and_then(|c| c["outcome"].as_str()).unwrap_or("");
    let next_action = control.and_then(|c| c["nextAction"].as_str()).unwrap_or("");
    let stable_refusal = ctrl_phase == "reconciling"
        && matches!(
            next_action,
            "execution_stop_unconfirmed"
                | "execution_outcome_unknown"
                | "reconcile_execution_outcome"
        );
    let barrier = matches!(ctrl_phase, "recorded" | "draining") && !stable_refusal;

    let mut classes = Vec::new();
    let mut gaps = Vec::new();
    let recorder_val = control.and_then(|c| c.get("recorder"));
    let missing_fields = missing_recorder_fields(recorder_val);
    let recorder_complete = missing_fields.is_empty();

    if ctrl_phase == "settled"
        && ctrl_outcome == "applied"
        && has_stop_receipt
        && ownership != "live"
    {
        classes.push("managed_stop_settled".to_owned());
    }
    if barrier {
        classes.push("barrier_in_progress".to_owned());
    }
    if !recorder_complete {
        classes.push("legacy_recorder_unproven".to_owned());
        gaps.push("no_recorder_tuple".to_owned());
    }
    if let (Some(ce), Some(we)) = (
        control
            .and_then(|c| c["hostEpoch"].as_str())
            .filter(|s| !s.is_empty()),
        writer_epoch.filter(|s| !s.is_empty()),
    ) && ce != we
    {
        classes.push("cross_host_unproven".to_owned());
        gaps.push("host_epoch_mismatch".to_owned());
    }
    if ownership == "unknown" {
        gaps.push("ownership_unknown".to_owned());
    }
    if proof == "alive" || ownership == "live" {
        classes.push(
            if ownership == "live" {
                "execution_still_running"
            } else {
                "recorder_alive"
            }
            .to_owned(),
        );
    }
    if matches!(proof, "dead" | "reused" | "different_boot") {
        let effect_unknown =
            !unknown_call_ids.is_empty() || !open_handle_ids.is_empty() || registration_absent;
        classes.push(
            if effect_unknown {
                "recorder_dead_with_unknown"
            } else {
                "recorder_dead_clear"
            }
            .to_owned(),
        );
    }
    if !unknown_call_ids.is_empty() || !open_handle_ids.is_empty() || registration_absent {
        classes.push("external_effect_unknown".to_owned());
    }
    if registration_absent && !has_stop_receipt {
        gaps.push("dispatch_registration_absent".to_owned());
    }
    if !unknown_call_ids.is_empty() {
        gaps.push("unknown_calls".to_owned());
    }
    if !open_handle_ids.is_empty() {
        gaps.push("open_handles".to_owned());
    }
    let last_err = plan["runner"]["lastError"].as_str().unwrap_or("");
    let remote = !last_err.is_empty()
        && (last_err.contains("401")
            || last_err.to_ascii_lowercase().contains("timeout")
            || last_err.to_ascii_lowercase().contains("timed out"));
    if remote && !matches!(proof, "dead" | "reused" | "different_boot") {
        classes.push("remote_unobserved".to_owned());
        gaps.push("remote_signal_not_death".to_owned());
    }

    let claim_state = claims
        .first()
        .and_then(|c| c["state"].as_str())
        .unwrap_or("");
    let closeable = !claims.is_empty()
        && matches!(claim_state, "draining" | "reconciling")
        && ownership != "live"
        && proof != "alive"
        && !barrier
        && !classes.iter().any(|c| {
            matches!(
                c.as_str(),
                "managed_stop_settled" | "recorder_dead_clear" | "remote_unobserved"
            )
        })
        && open_handle_ids.is_empty();

    let allowed_actions = if barrier
        || ownership == "live"
        || proof == "alive"
        || classes.iter().any(|c| {
            matches!(
                c.as_str(),
                "managed_stop_settled"
                    | "recorder_dead_clear"
                    | "recorder_alive"
                    | "execution_still_running"
            )
        }) {
        Vec::new()
    } else if disposition == Some("indexed") {
        if closeable {
            vec![
                "restore_follow_up".into(),
                "acknowledge_unknown".into(),
                "close_claim".into(),
            ]
        } else {
            vec!["restore_follow_up".into()]
        }
    } else if closeable {
        vec![
            "retire_follow_up".into(),
            "acknowledge_unknown".into(),
            "close_claim".into(),
        ]
    } else {
        vec!["retire_follow_up".into(), "acknowledge_unknown".into()]
    };

    ObligationClassification {
        classes,
        gaps,
        missing_fields,
        unknown_call_ids,
        open_handle_ids,
        ownership: ownership.to_owned(),
        proof: proof.to_owned(),
        allowed_actions,
        closeable,
        registration_absent,
        stable_refusal,
        barrier,
    }
}

pub fn host_resource_plan_from_plan(plan: &Value) -> Option<HostResourcePlan> {
    let origin = plan["delegationOrigin"].as_object()?;
    let execution = origin
        .get("executionControl")
        .and_then(|ec| ec.get("execution"))
        .and_then(normalize_session_execution_identity)
        .or_else(|| {
            let plan_id = plan["planId"].as_str()?.to_owned();
            let session_id = origin.get("sessionId")?.as_str()?.to_owned();
            let execution_epoch = origin
                .get("executionEpoch")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
                .unwrap_or("epoch-1")
                .to_owned();
            Some(SessionExecutionIdentity {
                plan_id,
                session_id,
                execution_epoch,
                goal_revision: origin
                    .get("coordinationBinding")
                    .and_then(|b| b["goalRevision"].as_u64()),
                generation: origin
                    .get("executionGeneration")
                    .and_then(Value::as_str)
                    .map(str::to_owned),
            })
        })?;
    let workspace_id = origin.get("workspaceId")?.as_str()?.to_owned();
    let directory = plan["targetWorkspacePath"]
        .as_str()
        .or_else(|| plan["originWorkspacePath"].as_str())
        .map(PathBuf::from);
    let title = plan["title"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(&execution.session_id)
        .chars()
        .take(200)
        .collect();
    let read_only = origin
        .get("readOnly")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    Some(HostResourcePlan {
        execution,
        workspace_id,
        directory,
        title,
        read_only,
    })
}

fn read_claims_for_plan(data_home: &Path, plan: &Value) -> Vec<Value> {
    let Some(host_plan) = host_resource_plan_from_plan(plan) else {
        return Vec::new();
    };
    let store = match ExecutionResourceStore::open_existing(data_home) {
        Ok(s) => s,
        Err(ResourceError::Missing) => return Vec::new(),
        Err(_) => return Vec::new(),
    };
    store.claims_for(&host_plan).unwrap_or_default()
}

fn plan_control(plan: &Value) -> Option<&Value> {
    plan["delegationOrigin"]
        .get("executionControl")
        .filter(|v| v.is_object())
        .or_else(|| plan.get("executionControl").filter(|v| v.is_object()))
}

fn plan_operation_id(plan: &Value, control: Option<&Value>) -> String {
    control
        .and_then(|c| c["operationId"].as_str())
        .or_else(|| plan["delegationOrigin"]["cancellation"]["operationId"].as_str())
        .or_else(|| plan["planId"].as_str())
        .unwrap_or("")
        .to_owned()
}

fn probe_git_workspace(directory: &Path) -> Result<(usize, usize, Vec<String>), &'static str> {
    let canonical = std::fs::canonicalize(directory).map_err(|_| "git_unavailable")?;
    let out = Command::new("git")
        .args(["status", "--porcelain=v1", "-uall"])
        .current_dir(&canonical)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|_| "git_unavailable")?;
    if !out.status.success() {
        return Err("git_unavailable");
    }
    let stdout = String::from_utf8_lossy(&out.stdout);
    let mut changed = 0usize;
    let mut untracked = 0usize;
    let mut paths = Vec::new();
    for line in stdout.lines() {
        if line.len() < 4 {
            continue;
        }
        if line.starts_with("?? ") {
            untracked += 1;
        } else {
            changed += 1;
        }
        if paths.len() < 32 {
            paths.push(line[3..].trim().to_owned());
        }
    }
    Ok((changed, untracked, paths))
}

/// Host-executed, read-only reconciliation over an unsettled execution resource claim.
pub async fn reconcile_unknown_outcome(
    data_home: &Path,
    plan: &Value,
    claim_id: &str,
    work: Option<&Value>,
) -> Result<Value, ProjectError> {
    if claim_id.trim().is_empty() {
        return Err(ProjectError::code("reconciliation_invalid_input"));
    }
    let host_plan = host_resource_plan_from_plan(plan)
        .ok_or_else(|| ProjectError::code("reconciliation_invalid_input"))?;
    let mut store = ExecutionResourceStore::open_existing_writable(data_home)
        .map_err(|e| ProjectError::code(e.code()))?;
    let claims = store
        .claims_for(&host_plan)
        .map_err(|e| ProjectError::code(e.code()))?;
    let claim = claims
        .into_iter()
        .find(|c| c["claimId"].as_str() == Some(claim_id))
        .ok_or_else(|| ProjectError::code("reconciliation_claim_missing"))?;
    let claim_state = claim["state"].as_str().unwrap_or("");
    if !matches!(claim_state, "draining" | "reconciling") {
        return Err(ProjectError::code("reconciliation_claim_active"));
    }
    let mut unknown_set = BTreeSet::new();
    if let Some(arr) = claim["evidenceCalls"].as_array() {
        for c in arr
            .iter()
            .filter_map(Value::as_str)
            .filter(|s| !s.is_empty())
        {
            unknown_set.insert(c.to_owned());
        }
    }
    if unknown_set.is_empty() {
        return Err(ProjectError::code("reconciliation_no_unknown"));
    }
    if unknown_set.len() > 60 {
        return Err(ProjectError::code("reconciliation_too_many_unknown"));
    }
    let unknown_calls: Vec<String> = unknown_set.into_iter().collect();

    let mut probes: Vec<Value> = Vec::new();
    let push_probe = |probes: &mut Vec<Value>, kind: &str, r: &str, result_val: Value| {
        let mut res_str = serde_json::to_string(&result_val).unwrap_or_else(|_| "{}".into());
        if res_str.chars().count() > 4096 {
            res_str = res_str.chars().take(4096).collect();
        }
        let observed_at = now_iso();
        let d = sha256_json(&json!({ "kind": kind, "ref": r, "result": result_val }));
        probes.push(json!({
            "kind": kind,
            "ref": r,
            "result": res_str,
            "observedAt": observed_at,
            "digest": d,
        }));
    };

    // 1. Dispatch receipt probe
    let budget = work.map(|w| &w["budget"]);
    let receipts = budget
        .and_then(|b| b["dispatchReceipts"].as_object())
        .map(|m| m.values().cloned().collect::<Vec<_>>())
        .unwrap_or_default();
    let uncertain = budget
        .and_then(|b| b["uncertainDispatches"].as_array())
        .cloned()
        .unwrap_or_default();
    let mut answered: HashMap<String, String> = HashMap::new();
    let mut capability_of: HashMap<String, String> = HashMap::new();
    for id in &unknown_calls {
        let row = uncertain
            .iter()
            .find(|u| u["toolCallId"].as_str() == Some(id.as_str()));
        if let Some(cap) = row.and_then(|r| r["capabilityId"].as_str()) {
            capability_of.insert(id.clone(), cap.to_owned());
        }
        let receipt = receipts
            .iter()
            .find(|r| r["toolCallId"].as_str() == Some(id.as_str()));
        if let Some(outcome) = receipt.and_then(|r| r["outcome"].as_str()) {
            answered.insert(id.clone(), outcome.to_owned());
        }
        push_probe(
            &mut probes,
            "receipt",
            &format!("receipt:{id}"),
            json!({
                "answered": receipt.and_then(|r| r["outcome"].as_str()),
                "capabilityId": row.and_then(|r| r["capabilityId"].as_str()),
                "dispatchId": row.and_then(|r| r["dispatchId"].as_str())
                    .or_else(|| receipt.and_then(|r| r["dispatchId"].as_str())),
                "registeredAt": row.and_then(|r| r["registeredAt"].as_str()),
            }),
        );
    }

    // 2. Open handle probe
    let mut open_handles = Vec::new();
    if let Some(handles) = claim["handles"].as_object() {
        for h in handles.values() {
            if h["state"].as_str() != Some("ended")
                && let Some(hid) = h["handleId"]
                    .as_str()
                    .or_else(|| h["toolCallId"].as_str())
                    .filter(|s| !s.is_empty())
            {
                open_handles.push(hid.to_owned());
            }
        }
    }
    push_probe(
        &mut probes,
        "handle",
        &format!("handles:{claim_id}"),
        json!({ "openHandles": open_handles }),
    );

    // 3. Process liveness / recorder death proof
    let control = plan_control(plan);
    let recorder_proof = if let Some(rec) = control
        .and_then(|c| c.get("recorder"))
        .and_then(parse_recorder)
    {
        let p = recorder::prove(&rec).await.as_str().to_owned();
        let cache_key = format!(
            "{}:{}:{}",
            host_plan.execution.plan_id,
            host_plan.execution.session_id,
            sha256_json(
                control
                    .and_then(|c| c.get("recorder"))
                    .unwrap_or(&Value::Null)
            )
        );
        cache_proof(&cache_key, &p);
        p
    } else {
        "not_available".to_owned()
    };
    push_probe(
        &mut probes,
        "process",
        &format!("process:{}", host_plan.execution.session_id),
        json!({ "recorderProof": recorder_proof }),
    );

    // 4. Bounded workspace git status probe
    let resource_ref = claim["resourceRef"].as_str().unwrap_or("");
    let directory = resource_ref.strip_prefix("directory:");
    let mut git_visible_changes = None;
    if let Some(dir) = directory {
        match probe_git_workspace(Path::new(dir)) {
            Ok((changed, untracked, paths)) => {
                let any_change = changed + untracked > 0;
                git_visible_changes = Some(any_change);
                push_probe(
                    &mut probes,
                    "workspace",
                    resource_ref,
                    json!({
                        "clean": !any_change,
                        "changed": changed,
                        "untracked": untracked,
                        "consistent": true,
                        "paths": paths,
                    }),
                );
            }
            Err(err_code) => {
                push_probe(
                    &mut probes,
                    "workspace",
                    resource_ref,
                    json!({ "clean": null, "error": err_code }),
                );
            }
        }
    } else {
        push_probe(
            &mut probes,
            "workspace",
            resource_ref,
            json!({ "clean": null, "error": "scope_not_directory" }),
        );
    }

    let fenced = unknown_calls.iter().all(|id| {
        capability_of
            .get(id)
            .is_some_and(|c| c.starts_with("local."))
    });
    let verdict = if !fenced {
        "unfenced_external"
    } else if !open_handles.is_empty() || matches!(recorder_proof.as_str(), "alive" | "unproven") {
        "inconclusive"
    } else if unknown_calls
        .iter()
        .all(|id| answered.get(id).map(String::as_str) == Some("not_dispatched"))
        || git_visible_changes == Some(false)
    {
        "no_effect_observed"
    } else {
        "inconclusive"
    };

    let claim_rev = claim["revision"].as_u64().unwrap_or(1);
    let probe_digests: Vec<Value> = probes.iter().map(|p| p["digest"].clone()).collect();
    let evidence_digest = sha256_json(&json!({
        "claimId": claim_id,
        "claimRevision": claim_rev,
        "resourceRef": resource_ref,
        "verdict": verdict,
        "probes": probe_digests,
    }));

    let mut evidence = json!({
        "execution": claim["execution"],
        "claimId": claim_id,
        "claimRevision": claim_rev,
        "probes": probes,
        "verdict": verdict,
        "evidenceDigest": evidence_digest,
    });
    if let Some(scope) = claim.get("scope").filter(|s| !s.is_null()) {
        evidence["scope"] = scope.clone();
    } else if let Some(dir) = directory {
        evidence["scope"] = json!({ "kind": "directory", "path": dir });
    }

    let recorded = store
        .record_reconciliation(&evidence)
        .map_err(|e| ProjectError::code(e.code()))?;
    Ok(json!({ "ok": true, "evidence": recorded }))
}

pub struct ExecutionObligationService<'a> {
    data_home: &'a Path,
    coordination: &'a CoordinationHub,
    supervisor: &'a SessionSupervisor,
}

impl<'a> ExecutionObligationService<'a> {
    pub fn new(
        data_home: &'a Path,
        coordination: &'a CoordinationHub,
        supervisor: &'a SessionSupervisor,
    ) -> Self {
        Self {
            data_home,
            coordination,
            supervisor,
        }
    }

    fn build_item_view(
        &self,
        plan: &Value,
        coord_state: &Value,
        proof_override: Option<&str>,
    ) -> Value {
        let origin = &plan["delegationOrigin"];
        let workspace_id = origin["workspaceId"].as_str().unwrap_or("");
        let session_id = origin["sessionId"].as_str().unwrap_or("");
        let plan_id = plan["planId"].as_str().unwrap_or("");
        let control = plan_control(plan);
        let operation_id = plan_operation_id(plan, control);
        let claims = read_claims_for_plan(self.data_home, plan);
        let disp_id = coord_state["obligationHeads"][session_id].as_str();
        let disposition =
            disp_id.and_then(|id| coord_state["obligationDispositions"][id]["phase"].as_str());

        let proof = if let Some(p) = proof_override {
            p.to_owned()
        } else if let Some(rec_val) = control.and_then(|c| c.get("recorder")) {
            let key = format!("{plan_id}:{session_id}:{}", sha256_json(rec_val));
            cached_proof(&key).unwrap_or_else(|| "unproven".to_owned())
        } else {
            "unproven".to_owned()
        };

        let cls = classify_execution_obligation(plan, control, &claims, &proof, None, disposition);

        let mut claim_summaries: Vec<Value> = claims
            .iter()
            .map(|c| {
                json!({
                    "claimId": c["claimId"],
                    "revision": c["revision"],
                    "state": c["state"],
                })
            })
            .collect();
        claim_summaries.sort_by(|a, b| {
            a["claimId"]
                .as_str()
                .unwrap_or("")
                .cmp(b["claimId"].as_str().unwrap_or(""))
        });

        let has_receipt = control
            .and_then(|c| c.get("stopReceipt"))
            .is_some_and(|v| !v.is_null() && *v != Value::Bool(false));
        let control_rev = control.and_then(|c| c["revision"].as_u64()).unwrap_or(0);
        let evidence_body = json!({
            "operationId": if operation_id.is_empty() { Value::Null } else { json!(operation_id) },
            "revision": control_rev,
            "nextAction": control.and_then(|c| c.get("nextAction")).cloned().unwrap_or(Value::Null),
            "hasReceipt": has_receipt,
            "claims": claim_summaries,
            "unknownCallIds": cls.unknown_call_ids,
            "openHandleIds": cls.open_handle_ids,
            "ownership": cls.ownership,
            "hostEpochMismatch": false,
            "recorderComplete": cls.missing_fields.is_empty(),
            "proof": cls.proof,
        });
        let evidence_revision = sha256_json(&evidence_body);
        let obligation_id = obligation_id_for(workspace_id, session_id, plan_id, &operation_id);

        let first_claim = claims.first();
        let resource = first_claim.map(|c| {
            let rref = c["resourceRef"].as_str().unwrap_or("");
            let kind = if rref.starts_with("file:") {
                "file"
            } else {
                "directory"
            };
            json!({
                "claimId": c["claimId"],
                "revision": c["revision"],
                "state": c["state"],
                "resourceKind": kind,
                "scope": c.get("scope").cloned().unwrap_or(Value::Null),
            })
        });
        let liveness = match cls.proof.as_str() {
            "alive" => "recorder_alive",
            "dead" | "reused" | "different_boot" => "recorder_dead",
            _ => match cls.ownership.as_str() {
                "live" => "live",
                "ended" => "ended",
                _ => "recorder_unproven",
            },
        };
        let title: String = plan["title"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(session_id)
            .trim()
            .chars()
            .take(200)
            .collect();

        json!({
            "sessionId": session_id,
            "planId": plan_id,
            "operationId": operation_id,
            "obligationId": obligation_id,
            "title": title,
            "classes": cls.classes,
            "liveness": liveness,
            "livenessFreshness": "advisory",
            "outcome": {
                "registration": if cls.registration_absent { "registration_absent" } else { "registered" },
                "unknownCallIds": cls.unknown_call_ids,
                "openHandleIds": cls.open_handle_ids,
            },
            "resource": resource,
            "gaps": cls.gaps,
            "missingFields": cls.missing_fields,
            "evidenceRevision": evidence_revision,
            "observedAt": now_iso(),
            "allowedActions": cls.allowed_actions,
            "refusalPreview": if cls.barrier {
                json!(["barrier_in_progress"])
            } else if cls.proof == "alive" || cls.ownership == "live" {
                json!(["recorder_alive"])
            } else {
                json!([])
            },
            "planStatus": plan["status"],
            "closeClaimAvailable": cls.closeable,
            "recorderProof": cls.proof,
            "parentConversationId": origin["parentConversationId"],
            "workspaceId": workspace_id,
            "disposition": disposition,
            "controlRevision": control_rev,
            "claimRevision": first_claim.and_then(|c| c["revision"].as_u64()).unwrap_or(0),
        })
    }

    async fn live_proof_for_plan(&self, plan: &Value) -> String {
        let Some(control) = plan_control(plan) else {
            return "unproven".to_owned();
        };
        let Some(rec_val) = control.get("recorder") else {
            return "unproven".to_owned();
        };
        let Some(rec) = parse_recorder(rec_val) else {
            return "unproven".to_owned();
        };
        let plan_id = plan["planId"].as_str().unwrap_or("");
        let session_id = plan["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
        let cache_key = format!("{plan_id}:{session_id}:{}", sha256_json(rec_val));
        let p = recorder::prove(&rec).await.as_str().to_owned();
        cache_proof(&cache_key, &p);
        p
    }

    #[allow(clippy::type_complexity)]
    fn locate_plans(
        &self,
        workspace_id: &str,
        parent_conv_id: Option<&str>,
        session_ids: &[String],
        obligation_ids: &[String],
        coord_state: &Value,
    ) -> Result<Vec<Result<(String, Value), Value>>, ProjectError> {
        let mut wanted = BTreeSet::new();
        for id in session_ids.iter().chain(obligation_ids.iter()) {
            wanted.insert(id.clone());
        }
        if wanted.is_empty() {
            return Err(ProjectError::code("obligation_scope_empty"));
        }
        if wanted.len() > 20 {
            return Err(ProjectError::code("too_many_items"));
        }
        let all_plans = self.supervisor.list_workspace_plans(workspace_id);
        let mut out = Vec::new();
        for target_id in wanted {
            let found = all_plans.iter().find(|plan| {
                if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id) {
                    return false;
                }
                let sid = plan["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
                if sid == target_id {
                    return true;
                }
                if let Some(obl_head) = coord_state["obligationHeads"][sid].as_str()
                    && obl_head == target_id
                {
                    return true;
                }
                let oid = plan_operation_id(plan, plan_control(plan));
                let computed = obligation_id_for(
                    workspace_id,
                    sid,
                    plan["planId"].as_str().unwrap_or(""),
                    &oid,
                );
                computed == target_id
            });
            match found {
                Some(plan)
                    if parent_conv_id.is_none_or(|pcid| {
                        plan["delegationOrigin"]["parentConversationId"].as_str() == Some(pcid)
                    }) =>
                {
                    out.push(Ok((target_id, plan.clone())));
                }
                _ => out.push(Err(json!({ "id": target_id, "error": "out_of_scope" }))),
            }
        }
        Ok(out)
    }

    pub async fn inspect_async(
        &self,
        workspace_id: &str,
        parent_conv_id: Option<&str>,
        session_ids: &[String],
        obligation_ids: &[String],
    ) -> Result<Value, ProjectError> {
        let coord_state = self.coordination.read_state(workspace_id)?;
        let located = self.locate_plans(
            workspace_id,
            parent_conv_id,
            session_ids,
            obligation_ids,
            &coord_state,
        )?;
        let mut items = Vec::new();
        for entry in located {
            match entry {
                Ok((_, plan)) => {
                    let proof = self.live_proof_for_plan(&plan).await;
                    items.push(self.build_item_view(&plan, &coord_state, Some(&proof)));
                }
                Err(err_row) => items.push(err_row),
            }
        }
        Ok(json!({ "ok": true, "observedAt": now_iso(), "items": items }))
    }

    pub fn inspect(
        &self,
        workspace_id: &str,
        parent_conv_id: Option<&str>,
        session_ids: &[String],
        obligation_ids: &[String],
    ) -> Result<Value, ProjectError> {
        let coord_state = self.coordination.read_state(workspace_id)?;
        let located = self.locate_plans(
            workspace_id,
            parent_conv_id,
            session_ids,
            obligation_ids,
            &coord_state,
        )?;
        let mut items = Vec::new();
        for entry in located {
            match entry {
                Ok((_, plan)) => items.push(self.build_item_view(&plan, &coord_state, None)),
                Err(err_row) => items.push(err_row),
            }
        }
        Ok(json!({ "ok": true, "observedAt": now_iso(), "items": items }))
    }

    pub async fn request_authorization(
        &self,
        workspace_id: &str,
        parent_conv_id: &str,
        items: &[Value],
    ) -> Result<Value, ProjectError> {
        if items.is_empty() {
            return Err(ProjectError::code("obligation_scope_empty"));
        }
        if items.len() > 20 {
            return Err(ProjectError::code("too_many_items"));
        }
        let mut session_ids = Vec::new();
        for item in items {
            let sid = item["sessionId"]
                .as_str()
                .ok_or_else(|| ProjectError::code("invalid_input"))?;
            let actions = item["actions"]
                .as_array()
                .ok_or_else(|| ProjectError::code("action_unavailable"))?;
            if actions.is_empty()
                || actions
                    .iter()
                    .any(|a| !a.as_str().is_some_and(|s| ALLOWED_ACTIONS.contains(&s)))
            {
                return Err(ProjectError::code("action_unavailable"));
            }
            if !session_ids.iter().any(|s| s == sid) {
                session_ids.push(sid.to_owned());
            }
        }
        let fresh = self
            .inspect_async(workspace_id, Some(parent_conv_id), &session_ids, &[])
            .await?;
        let present: Vec<&Value> = fresh["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|it| it.get("error").is_none())
            .collect();

        // Check staleness across obligationId and evidenceRevision
        let mut stale = Vec::new();
        for req in items {
            let sid = req["sessionId"].as_str().unwrap_or("");
            let row = present
                .iter()
                .find(|c| c["sessionId"].as_str() == Some(sid));
            match row {
                None => stale.push(json!({
                    "obligationId": req["obligationId"],
                    "sessionId": sid,
                    "reason": "item_missing",
                })),
                Some(r) if r["obligationId"] != req["obligationId"] => stale.push(json!({
                    "obligationId": r["obligationId"],
                    "sessionId": sid,
                    "reason": "obligation_mismatch",
                })),
                Some(r) if r["evidenceRevision"] != req["evidenceRevision"] => stale.push(json!({
                    "obligationId": r["obligationId"],
                    "sessionId": sid,
                    "reason": "evidence_revision",
                })),
                _ => {}
            }
        }
        if !stale.is_empty() {
            return Ok(json!({
                "ok": false,
                "error": "evidence_stale",
                "nextTool": "inspect_execution_obligation",
                "message": "Evidence changed. Call inspect_execution_obligation again and copy fresh evidenceRevision.",
                "stale": stale,
            }));
        }

        let mut card = Vec::new();
        let mut rejected = Vec::new();
        for req in items {
            let sid = req["sessionId"].as_str().unwrap_or("");
            let Some(row) = present
                .iter()
                .find(|c| c["sessionId"].as_str() == Some(sid))
            else {
                rejected.push(json!({ "sessionId": sid, "error": "out_of_scope" }));
                continue;
            };
            if req["operationId"] != row["operationId"] {
                rejected.push(json!({ "sessionId": sid, "error": "authorization_mismatch" }));
                continue;
            }
            let allowed: Vec<&str> = row["allowedActions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            let req_actions: Vec<&str> = req["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .collect();
            if !row["refusalPreview"].as_array().is_none_or(Vec::is_empty)
                || req_actions.iter().any(|a| !allowed.contains(a))
            {
                let err = row["refusalPreview"][0]
                    .as_str()
                    .unwrap_or("action_unavailable");
                rejected.push(json!({ "sessionId": sid, "error": err }));
                continue;
            }
            let has_unknown_gap = row["gaps"].as_array().into_iter().flatten().any(|g| {
                matches!(
                    g.as_str(),
                    Some(
                        "unknown_calls"
                            | "open_handles"
                            | "dispatch_registration_absent"
                            | "no_recorder_tuple"
                    )
                )
            });
            if has_unknown_gap
                && (req_actions.contains(&"retire_follow_up")
                    || req_actions.contains(&"close_claim"))
                && !req_actions.contains(&"acknowledge_unknown")
            {
                rejected.push(json!({ "sessionId": sid, "error": "unknown_not_acknowledged" }));
                continue;
            }
            if req_actions.contains(&"restore_follow_up")
                && row["disposition"].as_str() != Some("indexed")
            {
                rejected.push(json!({ "sessionId": sid, "error": "not_indexed" }));
                continue;
            }
            let mut card_row = (*row).clone();
            card_row["actions"] = req["actions"].clone();
            card.push(card_row);
        }

        if card.is_empty() {
            let err_code = rejected
                .first()
                .and_then(|r| r["error"].as_str())
                .unwrap_or("action_unavailable");
            return Ok(json!({ "ok": false, "error": err_code, "items": rejected }));
        }

        let grant_id = uuid::Uuid::new_v4().to_string();
        let closes = card.iter().any(|c| {
            c["actions"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "close_claim"))
        });
        let stored_items: Vec<Value> = card
            .iter()
            .map(|c| {
                let gaps: Vec<Value> = c["gaps"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|g| g.is_string())
                    .take(12)
                    .cloned()
                    .collect();
                json!({
                    "sessionId": c["sessionId"],
                    "operationId": c["operationId"],
                    "actions": c["actions"],
                    "evidenceRevision": c["evidenceRevision"],
                    "controlRevision": c["controlRevision"],
                    "claimRevision": c["claimRevision"],
                    "title": c["title"],
                    "gaps": gaps,
                })
            })
            .collect();
        let grant = json!({
            "grantId": grant_id,
            "status": "pending",
            "canonicalKey": Value::Null,
            "items": stored_items,
            "consequences": {
                "willBeMarkedCancelled": false,
                "resourceWillRemain": !closes,
                "requiresAcknowledge": true,
                "retainsUnknown": closes,
            },
            "principal": {
                "workspaceId": workspace_id,
                "parentConversationId": parent_conv_id,
            },
            "audience": parent_conv_id,
            "revision": 1,
            "updatedAt": now_iso(),
        });
        self.coordination.append_event(
            workspace_id,
            json!({
                "kind": "obligation_grant",
                "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                "grant": grant,
            }),
        )?;

        Ok(json!({
            "ok": true,
            "grantId": grant_id,
            "status": "pending",
            "idempotencyKey": format!("panel-{grant_id}"),
            "items": card,
            "rejected": rejected,
            "consequences": {
                "willBeMarkedCancelled": false,
                "resourceWillRemain": !closes,
                "requiresAcknowledge": true,
                "retainsUnknown": closes,
            },
        }))
    }

    pub fn pending_grants(&self, workspace_id: &str, parent_conv_id: Option<&str>) -> Vec<Value> {
        let Ok(state) = self.coordination.read_state(workspace_id) else {
            return Vec::new();
        };
        let Some(map) = state["obligationGrants"].as_object() else {
            return Vec::new();
        };
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        map.values()
            .filter(|g| {
                g["status"] == "pending"
                    && parent_conv_id.is_none_or(|pcid| {
                        g["principal"]["parentConversationId"].as_str() == Some(pcid)
                    })
                    && g["expiresAt"]
                        .as_str()
                        .and_then(parse_iso_ms)
                        .is_none_or(|exp| exp > now_ms)
            })
            .cloned()
            .collect()
    }

    pub fn confirm_grant(
        &self,
        workspace_id: &str,
        parent_conv_id: Option<&str>,
        grant_id: &str,
    ) -> Result<Value, ProjectError> {
        let state = self.coordination.read_state(workspace_id)?;
        let grant = state["obligationGrants"][grant_id].clone();
        if grant.is_null() {
            return Err(ProjectError::code("grant_not_found"));
        }
        if grant["status"].as_str() != Some("pending") {
            return Err(ProjectError::code("grant_not_pending"));
        }
        if grant["principal"]["workspaceId"].as_str() != Some(workspace_id)
            || parent_conv_id
                .is_some_and(|p| grant["principal"]["parentConversationId"].as_str() != Some(p))
        {
            return Err(ProjectError::code("authorization_scope_mismatch"));
        }
        let sids: Vec<String> = grant["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|i| i["sessionId"].as_str().map(str::to_owned))
            .collect();
        let fresh = self.inspect(workspace_id, parent_conv_id, &sids, &[])?;
        let stale = grant["items"].as_array().into_iter().flatten().any(|item| {
            let sid = item["sessionId"].as_str().unwrap_or("");
            let row = fresh["items"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| c["sessionId"].as_str() == Some(sid));
            row.is_none_or(|r| {
                r.get("error").is_some() || r["evidenceRevision"] != item["evidenceRevision"]
            })
        });
        let at = now_iso();
        if stale {
            let mut revoked = grant;
            revoked["status"] = json!("revoked");
            revoked["revokedAt"] = json!(at);
            revoked["revision"] = json!(revoked["revision"].as_u64().unwrap_or(1) + 1);
            revoked["updatedAt"] = json!(at);
            self.coordination.append_event(
                workspace_id,
                json!({
                    "kind": "obligation_grant",
                    "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                    "grant": revoked,
                }),
            )?;
            return Err(ProjectError::code("evidence_stale"));
        }

        let now_ms = parse_iso_ms(&at).unwrap_or(0);
        let expires_iso = time::OffsetDateTime::from_unix_timestamp_nanos(
            i128::from(now_ms + OBLIGATION_GRANT_TTL_MS) * 1_000_000,
        )
        .ok()
        .and_then(crate::format_iso)
        .unwrap_or_else(|| at.clone());

        let mut confirmed = grant;
        confirmed["status"] = json!("confirmed");
        confirmed["confirmedAt"] = json!(at);
        confirmed["expiresAt"] = json!(expires_iso);
        confirmed["revision"] = json!(confirmed["revision"].as_u64().unwrap_or(1) + 1);
        confirmed["updatedAt"] = json!(at);
        self.coordination.append_event(
            workspace_id,
            json!({
                "kind": "obligation_grant",
                "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                "grant": confirmed.clone(),
            }),
        )?;
        Ok(json!({ "ok": true, "grant": confirmed }))
    }

    pub fn revoke_grant(&self, workspace_id: &str, grant_id: &str) -> Result<Value, ProjectError> {
        let state = self.coordination.read_state(workspace_id)?;
        let grant = state["obligationGrants"][grant_id].clone();
        if grant.is_null() {
            return Err(ProjectError::code("grant_not_found"));
        }
        if grant["status"].as_str() != Some("pending") {
            return Err(ProjectError::code("grant_not_pending"));
        }
        let at = now_iso();
        let mut revoked = grant;
        revoked["status"] = json!("revoked");
        revoked["revokedAt"] = json!(at);
        revoked["revision"] = json!(revoked["revision"].as_u64().unwrap_or(1) + 1);
        revoked["updatedAt"] = json!(at);
        self.coordination.append_event(
            workspace_id,
            json!({
                "kind": "obligation_grant",
                "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                "grant": revoked,
            }),
        )?;
        Ok(json!({ "ok": true, "status": "revoked" }))
    }

    pub async fn resolve(
        &self,
        workspace_id: &str,
        parent_conv_id: &str,
        grant_id: &str,
        idempotency_key: &str,
        items: &[Value],
        tool_call_id: &str,
    ) -> Result<Value, ProjectError> {
        let state = self.coordination.read_state(workspace_id)?;
        let grant = state["obligationGrants"][grant_id].clone();
        if grant.is_null() {
            return Err(ProjectError::code("grant_not_found"));
        }
        if grant["principal"]["workspaceId"].as_str() != Some(workspace_id)
            || grant["principal"]["parentConversationId"].as_str() != Some(parent_conv_id)
        {
            return Err(ProjectError::code("authorization_scope_mismatch"));
        }
        let default_rev = grant["items"][0]["evidenceRevision"].as_str().unwrap_or("");
        let key = canonical_grant_key(grant_id, items, default_rev);
        if let Some(replayed_items) = grant["results"].get(&key).filter(|v| v.is_array()) {
            return Ok(json!({
                "ok": true,
                "grantId": grant_id,
                "replayed": true,
                "items": replayed_items,
            }));
        }
        if !idempotency_key.is_empty()
            && let Some(prev_key) = grant["canonicalKey"].as_str()
            && prev_key != key
        {
            return Err(ProjectError::code("authorization_mismatch"));
        }
        let status = grant["status"].as_str().unwrap_or("");
        if status == "pending" {
            return Err(ProjectError::code("grant_pending"));
        }
        if status == "revoked" {
            return Err(ProjectError::code("grant_revoked"));
        }
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let expired_time = grant["expiresAt"]
            .as_str()
            .and_then(parse_iso_ms)
            .is_some_and(|exp| exp <= now_ms);
        if status == "expired" || expired_time {
            if status != "expired" {
                let mut exp_grant = grant.clone();
                exp_grant["status"] = json!("expired");
                exp_grant["revision"] = json!(exp_grant["revision"].as_u64().unwrap_or(1) + 1);
                exp_grant["updatedAt"] = json!(now_iso());
                let _ = self.coordination.append_event(
                    workspace_id,
                    json!({
                        "kind": "obligation_grant",
                        "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                        "grant": exp_grant,
                    }),
                );
            }
            return Err(ProjectError::code("grant_expired"));
        }
        if status != "confirmed" {
            return Err(ProjectError::code("authorization_required"));
        }

        let all_plans = self.supervisor.list_workspace_plans(workspace_id);
        let mut results = Vec::new();
        for req in items {
            let sid = req["sessionId"].as_str().unwrap_or("");
            let op_id = req["operationId"].as_str().unwrap_or("");
            let mut req_actions: Vec<String> = req["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            req_actions.sort();

            let bound = grant["items"].as_array().into_iter().flatten().find(|row| {
                row["sessionId"].as_str() == Some(sid) && row["operationId"].as_str() == Some(op_id)
            });
            let Some(bound) = bound else {
                results.push(json!({
                    "sessionId": sid,
                    "operationId": op_id,
                    "result": "rejected",
                    "code": "authorization_mismatch",
                }));
                continue;
            };
            let mut bound_actions: Vec<String> = bound["actions"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_owned)
                .collect();
            bound_actions.sort();
            if req_actions != bound_actions {
                results.push(json!({
                    "sessionId": sid,
                    "operationId": op_id,
                    "result": "rejected",
                    "code": "authorization_mismatch",
                }));
                continue;
            }
            let Some(plan) = all_plans.iter().find(|p| {
                p["delegationOrigin"]["sessionId"].as_str() == Some(sid)
                    && p["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id)
            }) else {
                results.push(json!({
                    "sessionId": sid,
                    "result": "rejected",
                    "code": "session_not_found",
                }));
                continue;
            };

            let live_proof = self.live_proof_for_plan(plan).await;
            let cur_state = self.coordination.read_state(workspace_id)?;
            let current = self.build_item_view(plan, &cur_state, Some(&live_proof));
            if current["evidenceRevision"] != bound["evidenceRevision"] {
                let conflict = current["claimRevision"] != bound["claimRevision"]
                    || current["controlRevision"] != bound["controlRevision"];
                results.push(json!({
                    "sessionId": sid,
                    "obligationId": current["obligationId"],
                    "result": "rejected",
                    "code": if conflict { "revision_conflict" } else { "evidence_stale" },
                }));
                continue;
            }
            let has_unknown_gap = current["gaps"].as_array().into_iter().flatten().any(|g| {
                matches!(
                    g.as_str(),
                    Some(
                        "unknown_calls"
                            | "open_handles"
                            | "dispatch_registration_absent"
                            | "no_recorder_tuple"
                    )
                )
            });
            let has_retire_or_close = req_actions.iter().any(|a| a == "retire_follow_up")
                || req_actions.iter().any(|a| a == "close_claim");
            if has_unknown_gap
                && has_retire_or_close
                && !req_actions.iter().any(|a| a == "acknowledge_unknown")
            {
                results.push(json!({
                    "sessionId": sid,
                    "result": "rejected",
                    "code": "unknown_not_acknowledged",
                }));
                continue;
            }
            if current["classes"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == "managed_stop_settled"))
            {
                results.push(json!({
                    "sessionId": sid,
                    "result": "rejected",
                    "code": "already_settled",
                }));
                continue;
            }
            if req_actions.iter().any(|a| a == "restore_follow_up")
                && req_actions.iter().any(|a| a == "close_claim")
            {
                results.push(json!({
                    "sessionId": sid,
                    "result": "rejected",
                    "code": "action_unavailable",
                }));
                continue;
            }
            if req_actions.iter().any(|a| a == "restore_follow_up")
                && current["disposition"].as_str() != Some("indexed")
            {
                results.push(json!({
                    "sessionId": sid,
                    "result": "rejected",
                    "code": "not_indexed",
                }));
                continue;
            }

            let mut closure: Option<Value> = None;
            if req_actions.iter().any(|a| a == "close_claim") {
                if current["closeClaimAvailable"] != true || current["resource"].is_null() {
                    results.push(json!({
                        "sessionId": sid,
                        "result": "rejected",
                        "code": "claim_not_closeable",
                    }));
                    continue;
                }
                let Some(host_plan) = host_resource_plan_from_plan(plan) else {
                    results.push(json!({
                        "sessionId": sid,
                        "result": "rejected",
                        "code": "claim_closure_unavailable",
                    }));
                    continue;
                };
                let claim_id = current["resource"]["claimId"].as_str().unwrap_or("");
                let claim_rev = current["resource"]["revision"].as_u64().unwrap_or(0);
                let unknown_calls: Vec<String> = current["outcome"]["unknownCallIds"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect();
                let proof_str =
                    if matches!(live_proof.as_str(), "dead" | "reused" | "different_boot") {
                        "verified_dead"
                    } else {
                        "legacy_user_confirmed"
                    };
                match ExecutionResourceStore::open_existing_writable(self.data_home).and_then(
                    |mut store| {
                        store.close_claim(
                            &host_plan,
                            HostClaimClosure {
                                claim_id,
                                claim_revision: claim_rev,
                                authority_ref: grant_id,
                                unknown_calls: &unknown_calls,
                                proof: proof_str,
                                resolution: None,
                                at: &now_iso(),
                            },
                        )
                    },
                ) {
                    Ok(receipt) => closure = Some(receipt),
                    Err(err) => {
                        results.push(json!({
                            "sessionId": sid,
                            "result": "rejected",
                            "code": err.code(),
                        }));
                        continue;
                    }
                }
            }

            let phase = if req_actions.iter().any(|a| a == "restore_follow_up") {
                "current"
            } else {
                "indexed"
            };
            let obl_id = current["obligationId"].as_str().unwrap_or("");
            let previous = cur_state["obligationDispositions"][obl_id].clone();
            if closure.is_none() && previous["phase"].as_str() == Some(phase) {
                results.push(json!({
                    "sessionId": sid,
                    "operationId": op_id,
                    "result": "replayed",
                    "disposition": phase,
                    "obligationId": obl_id,
                    "planStatus": plan["status"],
                    "claim": current["resource"],
                }));
                continue;
            }
            let next_rev = previous["revision"].as_u64().unwrap_or(0) + 1;
            let at = now_iso();
            let disp_row = json!({
                "obligationId": obl_id,
                "sessionId": sid,
                "planId": current["planId"],
                "operationId": op_id,
                "phase": phase,
                "evidenceRevision": current["evidenceRevision"],
                "revision": next_rev,
                "updatedAt": at,
            });
            let mut audit = json!({
                "auditId": format!("{grant_id}:{sid}:{phase}:{next_rev}"),
                "actor": "main_bot",
                "toolCallId": tool_call_id,
                "workspaceId": workspace_id,
                "parentConversationId": parent_conv_id,
                "gaps": current["gaps"],
                "claim": current["resource"],
                "beforeRevision": previous["revision"].as_u64().unwrap_or(0),
            });
            if let Some(ref clr) = closure {
                audit["closure"] = clr.clone();
            }
            self.coordination.append_event(
                workspace_id,
                json!({
                    "kind": "execution_obligation",
                    "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                    "disposition": disp_row,
                    "audit": audit,
                }),
            )?;
            let mut res_row = json!({
                "sessionId": sid,
                "operationId": op_id,
                "result": "applied",
                "disposition": phase,
                "obligationId": obl_id,
                "planStatus": plan["status"],
                "claim": if closure.is_some() {
                    let mut c = current["resource"].clone();
                    if let Some(obj) = c.as_object_mut() {
                        obj.insert("state".into(), json!("released"));
                    }
                    c
                } else {
                    current["resource"].clone()
                },
            });
            if let Some(clr) = closure {
                res_row["closure"] = clr;
            }
            results.push(res_row);
        }

        // Persist canonicalKey + idempotent results on the grant
        let latest_state = self.coordination.read_state(workspace_id)?;
        let saved = latest_state["obligationGrants"][grant_id].clone();
        if !saved.is_null() && saved["results"].get(&key).is_none() {
            let mut updated_grant = saved;
            updated_grant["canonicalKey"] = json!(key);
            if !updated_grant["results"].is_object() {
                updated_grant["results"] = json!({});
            }
            updated_grant["results"][&key] = json!(results);
            updated_grant["revision"] = json!(updated_grant["revision"].as_u64().unwrap_or(1) + 1);
            updated_grant["updatedAt"] = json!(now_iso());
            self.coordination.append_event(
                workspace_id,
                json!({
                    "kind": "obligation_grant",
                    "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                    "grant": updated_grant,
                }),
            )?;
        }

        Ok(json!({
            "ok": true,
            "grantId": grant_id,
            "items": results,
        }))
    }

    pub fn suspend_live(&self, workspace_id: &str, plans: &[Value]) -> Result<usize, ProjectError> {
        let state = self.coordination.read_state(workspace_id)?;
        let mut suspended = 0usize;
        for plan in plans {
            if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id) {
                continue;
            }
            let sid = plan["delegationOrigin"]["sessionId"].as_str().unwrap_or("");
            let Some(obl_id) = state["obligationHeads"][sid].as_str() else {
                continue;
            };
            let current = &state["obligationDispositions"][obl_id];
            if current["phase"].as_str() != Some("indexed") {
                continue;
            }
            if derive_ownership(plan) != "live" {
                continue;
            }
            let mut next_row = current.clone();
            next_row["phase"] = json!("suspended");
            next_row["revision"] = json!(next_row["revision"].as_u64().unwrap_or(1) + 1);
            next_row["updatedAt"] = json!(now_iso());
            self.coordination.append_event(
                workspace_id,
                json!({
                    "kind": "execution_obligation",
                    "minimumExecutorVersion": OBLIGATION_FORMAT_VERSION,
                    "disposition": next_row,
                }),
            )?;
            suspended += 1;
        }
        Ok(suspended)
    }
}

const CONFINED_CAPABILITIES: [&str; 5] = [
    "local.file.read",
    "local.file.list",
    "local.file.search",
    "local.file.write",
    "local.file.edit",
];
const SETTLED_RECORDER_PROOFS: [&str; 3] = ["dead", "reused", "different_boot"];

fn is_valid_coordination_sqlite_name(name: &str) -> bool {
    let Some(rest) = name.strip_prefix("coordination-") else {
        return false;
    };
    let Some(uuid_part) = rest.strip_suffix(".sqlite") else {
        return false;
    };
    uuid_part.len() == 36
        && uuid_part
            .bytes()
            .all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f' | b'-'))
}

fn is_grant_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 36 {
        return false;
    }
    bytes.iter().enumerate().all(|(i, &b)| match i {
        8 | 13 | 18 | 23 => b == b'-',
        _ => b.is_ascii_hexdigit(),
    })
}

/// Read persisted pending obligation grants from `<data_home>/project-runtime/<ws>/.read-models/`.
/// Mirrors `packages/runtime-node/src/project-agent/execution-obligation.mjs#readPersistedObligationGrants`.
pub fn read_persisted_obligation_grants(
    data_home: &Path,
    workspace_id: &str,
) -> Result<Vec<Value>, (&'static str, &'static str)> {
    if workspace_id.is_empty() || !is_valid_workspace_id(workspace_id) {
        return Err(("obligation_store_unreadable", "obligation_store_unreadable"));
    }
    let dir = data_home.join("project-runtime").join(workspace_id);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let pointer_file = dir.join(".read-models").join("coordination-current.json");
    let ledger_exists =
        dir.join("coordination-v2").exists() || dir.join("coordination.jsonl").exists();
    if !pointer_file.exists() {
        return if ledger_exists {
            Err(("obligation_store_unreadable", "coordination_index_missing"))
        } else {
            Ok(Vec::new())
        };
    }
    let raw = fs::read_to_string(&pointer_file)
        .map_err(|_| ("obligation_store_unreadable", "coordination_index_corrupt"))?;
    let pointer: Value = serde_json::from_str(&raw)
        .map_err(|_| ("obligation_store_unreadable", "coordination_index_corrupt"))?;
    if pointer["schemaVersion"].as_u64() != Some(1) {
        return Err(("obligation_store_unreadable", "coordination_index_corrupt"));
    }
    let Some(file_name) = pointer["file"].as_str() else {
        return Err(("obligation_store_unreadable", "coordination_index_corrupt"));
    };
    if !is_valid_coordination_sqlite_name(file_name) {
        return Err(("obligation_store_unreadable", "coordination_index_corrupt"));
    }
    let sqlite_file = dir.join(".read-models").join(file_name);
    if !sqlite_file.exists() {
        return Err(("obligation_store_unreadable", "coordination_index_missing"));
    }
    let conn = Connection::open_with_flags(
        &sqlite_file,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?;
    let mut stmt = conn
        .prepare("SELECT value FROM objects WHERE bucket = 'obligationGrants'")
        .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?;
    let mut rows = stmt
        .query([])
        .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?;
    let mut grants = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?
    {
        let raw_val: String = row
            .get(0)
            .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?;
        let parsed: Value = serde_json::from_str(&raw_val)
            .map_err(|_| ("obligation_store_unreadable", "obligation_store_unreadable"))?;
        if parsed["status"].as_str() == Some("pending") {
            grants.push(parsed);
        }
    }
    Ok(grants)
}

/// Filter pending grants to `parent_conversation_id` (retaining legacy unscoped grants when owned).
/// Mirrors `execution-obligation.mjs#selectPendingGrants` + reason reporting in `project-agent-application-service.mjs`.
pub fn select_pending_grants<F>(
    grants: &[Value],
    parent_conversation_id: Option<&str>,
    owns_session: F,
) -> (Vec<Value>, Vec<String>)
where
    F: Fn(&Value) -> bool,
{
    let mut kept = Vec::new();
    let mut reasons = Vec::new();
    for grant in grants {
        let parent = grant["principal"]["parentConversationId"]
            .as_str()
            .unwrap_or("");
        let gid = grant["grantId"].as_str().unwrap_or("");
        if parent_conversation_id.is_none_or(|pcid| parent == pcid) {
            kept.push(grant.clone());
            continue;
        }
        if parent.is_empty() && owns_session(grant) {
            kept.push(grant.clone());
            reasons.push(format!("legacy_session_owner:{gid}"));
            continue;
        }
        let reason = if !parent.is_empty() {
            "parent_mismatch"
        } else {
            "legacy_unverified"
        };
        reasons.push(format!("{reason}:{gid}"));
    }
    (kept, reasons)
}

/// Compute display-only title and shortId fallback without mutating the grant.
/// Mirrors `execution-obligation.mjs#obligationDisplayTitle`.
pub fn obligation_display_title(
    item: &Value,
    projected_title: Option<&str>,
) -> (Option<String>, Option<String>) {
    let session_id = item["sessionId"].as_str().unwrap_or("");
    let usable = |v: &str| !v.is_empty() && v != session_id && !is_grant_uuid(v);
    let stored = item["title"].as_str().map(str::trim).unwrap_or("");
    if usable(stored) {
        return (Some(stored.to_owned()), None);
    }
    let projected = projected_title.map(str::trim).unwrap_or("");
    if usable(projected) {
        return (Some(projected.to_owned()), None);
    }
    let compact: String = session_id
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(8)
        .collect();
    let short_id = if compact.is_empty() {
        "unknown".to_owned()
    } else {
        compact
    };
    (None, Some(short_id))
}

fn evaluate_claim_unknown_envelope(
    store: &ExecutionResourceStore,
    claim: &Value,
) -> Result<(String, Value), String> {
    let mut seen_calls = HashMap::<String, ()>::new();
    let mut unknown_calls = Vec::new();
    if let Some(arr) = claim["evidenceCalls"].as_array() {
        for c in arr {
            if let Some(id) = c.as_str().filter(|s| !s.is_empty())
                && seen_calls.insert(id.to_owned(), ()).is_none()
            {
                unknown_calls.push(id.to_owned());
            }
        }
    }
    if unknown_calls.is_empty() {
        return Err("no_unknown_calls".into());
    }
    if claim["handles"]
        .as_object()
        .is_some_and(|map| map.values().any(|h| h["state"].as_str() != Some("ended")))
    {
        return Err("open_handles".into());
    }
    let claim_id = claim["claimId"].as_str().unwrap_or("");
    let rows = store
        .reconciliation_evidence_for(claim_id)
        .unwrap_or_default();
    let Some(evidence) = rows.last() else {
        return Err("reconciliation_missing".into());
    };
    if evidence["claimRevision"].as_i64() != claim["revision"].as_i64()
        || claim["revision"].as_i64().is_none()
    {
        return Err("reconciliation_stale".into());
    }
    let verdict = evidence["verdict"].as_str().unwrap_or("");
    if !matches!(verdict, "no_effect_observed" | "effect_observed") {
        return Err(format!("verdict_{verdict}"));
    }
    let probes = evidence["probes"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let recorder_proof = probes
        .iter()
        .find(|p| p["kind"].as_str() == Some("process"))
        .and_then(|p| p["result"].as_str())
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|v| v["recorderProof"].as_str().map(str::to_owned));
    if !recorder_proof
        .as_deref()
        .is_some_and(|rp| SETTLED_RECORDER_PROOFS.contains(&rp))
    {
        return Err("recorder_not_proven_dead".into());
    }
    for call_id in &unknown_calls {
        let receipt_ref = format!("receipt:{call_id}");
        let cap_id = probes
            .iter()
            .find(|p| {
                p["kind"].as_str() == Some("receipt")
                    && p["ref"].as_str() == Some(receipt_ref.as_str())
            })
            .and_then(|p| p["result"].as_str())
            .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
            .and_then(|v| v["capabilityId"].as_str().map(str::to_owned));
        if !cap_id
            .as_deref()
            .is_some_and(|c| CONFINED_CAPABILITIES.contains(&c))
        {
            return Err("capability_not_confined".into());
        }
    }
    Ok((verdict.to_owned(), evidence["evidenceDigest"].clone()))
}

/// Fresh read-only advisory unknown-outcome facts (ADR 127 UO-06b); never frozen onto a grant.
/// Mirrors `unknown-outcome-resolution.mjs#inspect` + `execution-obligation.mjs#inspect`.
pub fn inspect_unknown_outcome_advisory(data_home: &Path, plan: &Value) -> Option<Value> {
    let origin = plan.get("delegationOrigin").filter(|v| v.is_object())?;
    let host_plan = host_resource_plan_from_plan(plan)?;
    let store = ExecutionResourceStore::open_existing(data_home).ok()?;
    let claims = store.claims_for(&host_plan).ok()?;
    let claim = claims.first()?;
    if !matches!(claim["state"].as_str(), Some("draining" | "reconciling")) {
        return None;
    }
    let ws_id = origin["workspaceId"].as_str().unwrap_or("");
    let policy_tier = match BotProfileStore::new(data_home).read_unknown_outcome_policy(ws_id) {
        Ok(val) => val["tier"].as_str().unwrap_or("ask").to_owned(),
        Err(err) if err.code == "NOT_FOUND" => "ask".to_owned(),
        Err(err) => err.code.to_lowercase(),
    };
    let reconciliation = match evaluate_claim_unknown_envelope(&store, claim) {
        Ok((verdict, evidence_digest)) => json!({
            "eligible": true,
            "verdict": verdict,
            "evidenceDigest": evidence_digest,
        }),
        Err(reason) => json!({
            "eligible": false,
            "reason": reason,
        }),
    };
    Some(json!({
        "policyTier": policy_tier,
        "reconciliation": reconciliation,
    }))
}

/// Lease-free read-only persisted obligation grant listing + display/unknownOutcome decoration.
pub fn list_persisted_obligation_grants_enriched(
    data_home: &Path,
    workspace_id: &str,
    parent_conversation_id: Option<&str>,
) -> Value {
    let raw = match read_persisted_obligation_grants(data_home, workspace_id) {
        Ok(rows) => rows,
        Err((code, cause)) => {
            return json!({
                "ok": false,
                "code": code,
                "cause": cause,
            });
        }
    };
    let supervisor = SessionSupervisor::new(data_home, None);
    let plans = supervisor.list_workspace_plans(workspace_id);
    let plan_by_session: HashMap<&str, &Value> = plans
        .iter()
        .filter_map(|p| {
            p["delegationOrigin"]["sessionId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(|sid| (sid, p))
        })
        .collect();

    let (selected, reasons) = select_pending_grants(&raw, parent_conversation_id, |grant| {
        let Some(pcid) = parent_conversation_id else {
            return false;
        };
        grant["items"].as_array().is_some_and(|items| {
            items.iter().any(|item| {
                item["sessionId"]
                    .as_str()
                    .and_then(|sid| plan_by_session.get(sid))
                    .is_some_and(|p| {
                        p["delegationOrigin"]["workspaceId"].as_str() == Some(workspace_id)
                            && p["delegationOrigin"]["parentConversationId"].as_str() == Some(pcid)
                    })
            })
        })
    });

    let enriched: Vec<Value> = selected
        .into_iter()
        .map(|mut grant| {
            if let Some(items) = grant.get_mut("items").and_then(Value::as_array_mut) {
                for item in items.iter_mut() {
                    let sid = item["sessionId"].as_str().unwrap_or("");
                    let matching_plan = plan_by_session.get(sid).copied();
                    let projected_title = matching_plan.and_then(|p| p["title"].as_str());
                    let (title, short_id) = obligation_display_title(item, projected_title);
                    let close_claim = item["actions"]
                        .as_array()
                        .is_some_and(|acts| acts.iter().any(|a| a.as_str() == Some("close_claim")));
                    let unknown_outcome = if close_claim {
                        matching_plan.and_then(|p| inspect_unknown_outcome_advisory(data_home, p))
                    } else {
                        None
                    };
                    if let Some(obj) = item.as_object_mut() {
                        obj.insert(
                            "displayTitle".into(),
                            title.map(Value::String).unwrap_or(Value::Null),
                        );
                        obj.insert(
                            "shortId".into(),
                            short_id.map(Value::String).unwrap_or(Value::Null),
                        );
                        if let Some(uo) = unknown_outcome {
                            obj.insert("unknownOutcome".into(), uo);
                        }
                    }
                }
            }
            grant
        })
        .collect();

    json!({
        "ok": true,
        "grants": enriched,
        "rawCount": raw.len(),
        "reasons": reasons,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{NativeProjectHost, SpawnCriterion, SpawnSessionRequest, input_message_id};
    use tempfile::tempdir;

    #[test]
    fn obligation_id_and_classifier_respect_barrier_and_indexed_states() {
        let oid = obligation_id_for("ws-1", "sess-1", "plan-1", "op-1");
        assert!(oid.starts_with("obl_"));

        let plan = json!({
            "planId": "plan-1",
            "status": "cancelled",
            "delegationOrigin": {
                "workspaceId": "ws-1",
                "sessionId": "sess-1",
                "phase": "ended",
                "uncertainDispatches": [{"toolCallId": "call-u1"}]
            }
        });
        let barrier_ctrl = json!({ "phase": "draining", "operationId": "op-1" });
        let blocked =
            classify_execution_obligation(&plan, Some(&barrier_ctrl), &[], "unproven", None, None);
        assert!(blocked.barrier);
        assert!(blocked.allowed_actions.is_empty());

        let settled_ctrl = json!({
            "phase": "settled",
            "outcome": "cancelled",
            "operationId": "op-1"
        });
        let cls =
            classify_execution_obligation(&plan, Some(&settled_ctrl), &[], "dead", None, None);
        assert!(!cls.barrier);
        assert!(cls.gaps.contains(&"unknown_calls".to_owned()));
        assert!(cls.allowed_actions.contains(&"retire_follow_up".to_owned()));

        let cls_indexed = classify_execution_obligation(
            &plan,
            Some(&settled_ctrl),
            &[],
            "dead",
            None,
            Some("indexed"),
        );
        assert_eq!(cls_indexed.allowed_actions, vec!["restore_follow_up"]);
    }

    #[tokio::test]
    async fn obligation_grant_lifecycle_and_unknown_reconciliation_work_end_to_end() {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let init = Command::new("git")
            .args(["init"])
            .current_dir(ws.path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(init.status.success());

        let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
        let (entry, prof) = host.bind_workspace(ws.path(), Some("OblBot")).unwrap();
        host.ensure_lease(&entry.workspace_id).unwrap();
        let conv_id = prof.agent_conversation_id.unwrap();
        host.submit_user_input(&entry.workspace_id, "in-o1", "Run write task", None)
            .unwrap();
        host.inputs()
            .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
            .unwrap();

        let spawned = host
            .supervisor()
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: entry.workspace_id.clone(),
                    workspace_path: ws.path().to_path_buf(),
                    parent_conversation_id: conv_id.clone(),
                    anchor_message_ids: vec![input_message_id("in-o1").unwrap()],
                    input_id: "in-o1".into(),
                    surface: "tui".into(),
                    title: "Obligation Test".into(),
                    brief: "Check unknown outcome".into(),
                    kind: "code".into(),
                    read_only: false,
                    required_capabilities: vec!["local.file.write".into()],
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "file-exists".into(),
                        description: "ok".into(),
                        command: None,
                        path: Some("Cargo.toml".into()),
                        expect: None,
                    }],
                    priority: "normal".into(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "none".into(),
                    worker_model_selection: json!({}),
                },
                true,
            )
            .unwrap();

        // Cancel session and seed an unsettled ExecutionResourceStore claim
        host.supervisor()
            .control_session(
                &entry.workspace_id,
                &spawned.session_id,
                "cancel",
                "stop",
                true,
            )
            .unwrap();
        let plan = host
            .supervisor()
            .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
            .unwrap();
        let host_plan = host_resource_plan_from_plan(&plan).unwrap();
        let mut rstore = ExecutionResourceStore::initialize(home.path(), None).unwrap();
        let _resv = rstore
            .reserve(
                &host_plan,
                peer_store::ResourceReservation {
                    host_epoch: "epoch-1",
                    scopes: &[],
                    record_conflict: false,
                },
                "2026-11-20T10:00:00.000Z",
            )
            .unwrap();
        rstore
            .activate(&host_plan, "epoch-1", "2026-11-20T10:00:01.000Z")
            .unwrap();
        rstore
            .protect(
                &host_plan,
                Some("epoch-1"),
                Some("op-1"),
                "draining",
                &[String::from("call-u1")],
                "2026-11-20T10:00:02.000Z",
            )
            .unwrap();
        let claim = rstore.claims_for(&host_plan).unwrap().pop().unwrap();
        let claim_id = claim["claimId"].as_str().unwrap().to_owned();

        let work = json!({
            "budget": {
                "uncertainDispatches": [{
                    "toolCallId": "call-u1",
                    "capabilityId": "local.file.write"
                }]
            }
        });
        let recon = reconcile_unknown_outcome(home.path(), &plan, &claim_id, Some(&work))
            .await
            .unwrap();
        assert_eq!(recon["ok"], true);
        assert_eq!(recon["evidence"]["verdict"], "no_effect_observed");

        let svc =
            ExecutionObligationService::new(home.path(), host.coordination(), host.supervisor());
        let inspected = svc
            .inspect_async(
                &entry.workspace_id,
                Some(&conv_id),
                std::slice::from_ref(&spawned.session_id),
                &[],
            )
            .await
            .unwrap();
        let row = &inspected["items"][0];
        let obl_id = row["obligationId"].as_str().unwrap().to_owned();
        let op_id = row["operationId"].as_str().unwrap().to_owned();
        let ev_rev = row["evidenceRevision"].as_str().unwrap().to_owned();

        // Stale evidenceRevision rejected
        let stale = svc
            .request_authorization(
                &entry.workspace_id,
                &conv_id,
                &[json!({
                    "obligationId": obl_id,
                    "sessionId": spawned.session_id,
                    "operationId": op_id,
                    "evidenceRevision": "stale-rev",
                    "actions": ["retire_follow_up", "acknowledge_unknown"]
                })],
            )
            .await
            .unwrap();
        assert_eq!(stale["error"], "evidence_stale");

        let auth = svc
            .request_authorization(
                &entry.workspace_id,
                &conv_id,
                &[json!({
                    "obligationId": obl_id,
                    "sessionId": spawned.session_id,
                    "operationId": op_id,
                    "evidenceRevision": ev_rev,
                    "actions": ["retire_follow_up", "acknowledge_unknown"]
                })],
            )
            .await
            .unwrap();
        assert_eq!(auth["ok"], true);
        let grant_id = auth["grantId"].as_str().unwrap().to_owned();

        let confirmed = svc
            .confirm_grant(&entry.workspace_id, Some(&conv_id), &grant_id)
            .unwrap();
        assert_eq!(confirmed["ok"], true);

        let resolve_items = vec![json!({
            "sessionId": spawned.session_id,
            "operationId": op_id,
            "actions": ["retire_follow_up", "acknowledge_unknown"]
        })];
        let resolved = svc
            .resolve(
                &entry.workspace_id,
                &conv_id,
                &grant_id,
                "idem-key-1234567890",
                &resolve_items,
                "call-res-1",
            )
            .await
            .unwrap();
        assert_eq!(resolved["ok"], true);
        assert_eq!(resolved["items"][0]["result"], "applied");
        assert_eq!(resolved["items"][0]["disposition"], "indexed");

        // Idempotent replay with same idempotencyKey & items
        let replayed = svc
            .resolve(
                &entry.workspace_id,
                &conv_id,
                &grant_id,
                "idem-key-1234567890",
                &resolve_items,
                "call-res-2",
            )
            .await
            .unwrap();
        assert_eq!(replayed["replayed"], true);
    }

    #[tokio::test]
    async fn read_persisted_obligation_grants_handles_absent_corrupt_scoping_titles_and_advisory_facts()
     {
        let home = tempdir().unwrap();

        // 1. Absent runtime dir -> empty ok
        let empty = list_persisted_obligation_grants_enriched(home.path(), "ws-none", None);
        assert_eq!(empty["ok"], true);
        assert_eq!(empty["grants"].as_array().unwrap().len(), 0);

        // 2. Ledger exists without pointer -> coordination_index_missing
        let rt_missing = home.path().join("project-runtime/ws-no-ptr");
        fs::create_dir_all(rt_missing.join("coordination-v2")).unwrap();
        let err_missing = read_persisted_obligation_grants(home.path(), "ws-no-ptr").unwrap_err();
        assert_eq!(
            err_missing,
            ("obligation_store_unreadable", "coordination_index_missing")
        );

        // 3. Corrupt pointer (path traversal / schemaVersion)
        let models_dir = rt_missing.join(".read-models");
        fs::create_dir_all(&models_dir).unwrap();
        fs::write(
            models_dir.join("coordination-current.json"),
            r#"{"schemaVersion":1,"file":"../evil.sqlite"}"#,
        )
        .unwrap();
        let err_corrupt = read_persisted_obligation_grants(home.path(), "ws-no-ptr").unwrap_err();
        assert_eq!(
            err_corrupt,
            ("obligation_store_unreadable", "coordination_index_corrupt")
        );

        // 4. Full valid SQLite read model + scoping + UUID title fallback + fresh advisory unknownOutcome
        let ws = tempdir().unwrap();
        let ws_dir_git = Command::new("git")
            .args(["init"])
            .current_dir(ws.path())
            .env("GIT_TERMINAL_PROMPT", "0")
            .output()
            .unwrap();
        assert!(ws_dir_git.status.success());

        let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
        let (entry, prof) = host.bind_workspace(ws.path(), Some("ReadOblBot")).unwrap();
        let ws_id = entry.workspace_id.clone();
        let conv_id = prof.agent_conversation_id.unwrap();
        host.ensure_lease(&ws_id).unwrap();
        host.submit_user_input(&ws_id, "in-ro1", "Run confined file task", None)
            .unwrap();
        host.inputs()
            .consume(&ws_id, &conv_id, host.conversations(), true)
            .unwrap();

        let spawned = host
            .supervisor()
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: ws_id.clone(),
                    workspace_path: ws.path().to_path_buf(),
                    parent_conversation_id: conv_id.clone(),
                    anchor_message_ids: vec![input_message_id("in-ro1").unwrap()],
                    input_id: "in-ro1".into(),
                    surface: "tui".into(),
                    title: "Clean up temp files".into(),
                    brief: "Cleanup".into(),
                    kind: "code".into(),
                    read_only: false,
                    required_capabilities: vec!["local.file.write".into()],
                    success_criteria: vec![SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "file-exists".into(),
                        description: "ok".into(),
                        command: None,
                        path: Some("Cargo.toml".into()),
                        expect: None,
                    }],
                    priority: "normal".into(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "none".into(),
                    worker_model_selection: json!({}),
                },
                true,
            )
            .unwrap();
        host.supervisor()
            .control_session(&ws_id, &spawned.session_id, "cancel", "stop", true)
            .unwrap();
        let plan = host
            .supervisor()
            .find_plan_by_session(&ws_id, &spawned.session_id)
            .unwrap();
        let host_plan = host_resource_plan_from_plan(&plan).unwrap();
        let mut rstore = ExecutionResourceStore::initialize(home.path(), None).unwrap();
        let _resv = rstore
            .reserve(
                &host_plan,
                peer_store::ResourceReservation {
                    host_epoch: "epoch-ro",
                    scopes: &[],
                    record_conflict: false,
                },
                "2026-11-22T01:00:00.000Z",
            )
            .unwrap();
        rstore
            .activate(&host_plan, "epoch-ro", "2026-11-22T01:00:01.000Z")
            .unwrap();
        rstore
            .protect(
                &host_plan,
                Some("epoch-ro"),
                Some("op-ro"),
                "draining",
                &["call-ro-1".into()],
                "2026-11-22T01:00:02.000Z",
            )
            .unwrap();
        let claim = rstore.claims_for(&host_plan).unwrap().pop().unwrap();
        let claim_id = claim["claimId"].as_str().unwrap().to_owned();
        let work = json!({
            "budget": {
                "uncertainDispatches": [{
                    "toolCallId": "call-ro-1",
                    "capabilityId": "local.file.write"
                }]
            }
        });
        let mut plan_with_rec = plan.clone();
        plan_with_rec["executionControl"] = json!({
            "recorder": {
                "bootId": "boot-prior-000",
                "pid": 999999u64,
                "pidStart": "macos-v2:1:0",
                "hostId": "test-host",
                "acquiredAt": "2026-11-22T01:00:00.000Z"
            }
        });
        reconcile_unknown_outcome(home.path(), &plan_with_rec, &claim_id, Some(&work))
            .await
            .unwrap();

        // Write coordination-current SQLite read model directly (works even while lease dropped or inactive).
        host.release_lease(&ws_id).unwrap();
        let db_uuid = "11111111-2222-3333-4444-555555555555";
        let db_name = format!("coordination-{db_uuid}.sqlite");
        let ws_models = home
            .path()
            .join("project-runtime")
            .join(&ws_id)
            .join(".read-models");
        fs::create_dir_all(&ws_models).unwrap();
        fs::write(
            ws_models.join("coordination-current.json"),
            serde_json::to_string(&json!({ "schemaVersion": 1, "file": db_name })).unwrap(),
        )
        .unwrap();
        let sqlite_path = ws_models.join(&db_name);
        let conn = Connection::open(&sqlite_path).unwrap();
        conn.execute(
            "CREATE TABLE objects (bucket TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (bucket, id))",
            [],
        )
        .unwrap();
        let uuid_sid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
        let grants = vec![
            json!({
                "grantId": "g-match",
                "status": "pending",
                "principal": { "workspaceId": ws_id, "parentConversationId": conv_id },
                "items": [{
                    "obligationId": "obl-1",
                    "sessionId": spawned.session_id,
                    "operationId": "op-ro",
                    "actions": ["close_claim", "acknowledge_unknown"]
                }]
            }),
            json!({
                "grantId": "g-legacy",
                "status": "pending",
                "principal": { "workspaceId": ws_id },
                "items": [{
                    "obligationId": "obl-2",
                    "sessionId": spawned.session_id,
                    "title": uuid_sid,
                    "actions": ["retire_follow_up"]
                }]
            }),
            json!({
                "grantId": "g-other",
                "status": "pending",
                "principal": { "workspaceId": ws_id, "parentConversationId": "other-conv" },
                "items": [{ "obligationId": "obl-3", "sessionId": uuid_sid, "actions": ["retire_follow_up"] }]
            }),
        ];
        for g in &grants {
            conn.execute(
                "INSERT INTO objects VALUES ('obligationGrants', ?, ?)",
                [
                    g["grantId"].as_str().unwrap(),
                    &serde_json::to_string(g).unwrap(),
                ],
            )
            .unwrap();
        }
        drop(conn);

        let listed = list_persisted_obligation_grants_enriched(home.path(), &ws_id, Some(&conv_id));
        assert_eq!(listed["ok"], true);
        assert_eq!(listed["rawCount"], 3);
        let returned = listed["grants"].as_array().unwrap();
        assert_eq!(returned.len(), 2);

        let g_match = returned.iter().find(|g| g["grantId"] == "g-match").unwrap();
        assert_eq!(g_match["items"][0]["displayTitle"], "Clean up temp files");
        assert_eq!(g_match["items"][0]["shortId"], Value::Null);
        assert_eq!(g_match["items"][0]["unknownOutcome"]["policyTier"], "ask");
        assert_eq!(
            g_match["items"][0]["unknownOutcome"]["reconciliation"]["eligible"],
            true
        );

        let reasons: Vec<&str> = listed["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect();
        assert!(reasons.contains(&"legacy_session_owner:g-legacy"));
        assert!(reasons.contains(&"parent_mismatch:g-other"));

        // UUID fallback for obligation_display_title when no projected title matches
        let (title_opt, short_opt) =
            obligation_display_title(&json!({ "sessionId": uuid_sid, "title": uuid_sid }), None);
        assert_eq!(title_opt, None);
        assert_eq!(short_opt.as_deref(), Some("aaaaaaaa"));
    }
}
