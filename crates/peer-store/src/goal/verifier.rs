//! Independently observed Goal review under the original conversation owner.
use super::{
    explorer::PlanWrite,
    task_update::{VerifierEvidence, observed_scoped_evidence},
    *,
};
use serde_json::json;
use sha2::{Digest, Sha256};

const MODEL_REVIEW_HISTORY: usize = 64;
const VERIFICATION_REPAIR_ATTEMPTS: usize = 2;
const VISUAL_REPAIR_ATTEMPTS: usize = 2;

pub struct VerifierLease {
    pub id: String,
    pub plan: Value,
    owner: OrdinaryRunner,
    source: LocalGoalIntake,
    criterion_revision: String,
}

pub enum VerifierSettlement {
    Report { report: Value, allows_repair: bool },
    Interrupted(&'static str),
}

pub struct VerifierReceipt {
    source: LocalGoalIntake,
    id: String,
    allows_repair: bool,
    passed: bool,
}

impl VerifierReceipt {
    pub fn passed(&self) -> bool {
        self.passed
    }
}

fn model_review_ids(plan: &Value) -> impl Iterator<Item = &str> {
    plan["successCriteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|criterion| criterion["kind"] == "model_review")
        .filter_map(|criterion| criterion["id"].as_str())
}

fn record_model_reviews(
    plan: &mut Value,
    lease: &VerifierLease,
    passed: bool,
    refs: &Value,
    at: &str,
) -> Result<(), GoalError> {
    let new = model_review_ids(plan)
        .map(|id| {
            json!({"criterionId":id,
        "sourceRevision":lease.criterion_revision,"verifierRunId":lease.id,
        "passed":passed,"evidenceRefs":refs,"checkedAt":at})
        })
        .collect::<Vec<_>>();
    if new.is_empty() {
        return Ok(());
    }
    let rows = plan
        .as_object_mut()
        .ok_or(GoalError::Invalid)?
        .entry("modelReviews")
        .or_insert_with(|| json!([]))
        .as_array_mut()
        .ok_or(GoalError::Invalid)?;
    rows.extend(new);
    let older = rows.len().saturating_sub(MODEL_REVIEW_HISTORY);
    rows.drain(..older);
    Ok(())
}

// Existing criterion-review.mjs shape. Optional object properties are absent;
// optional array entries are null, as in JSON.stringify.
fn criterion_revision(plan: &Value) -> Result<String, GoalError> {
    fn tasks(nodes: &Value) -> Vec<Value> {
        nodes
            .as_array()
            .into_iter()
            .flatten()
            .map(|node| {
                let mut task = serde_json::Map::new();
                for key in ["taskId", "status", "result", "evidenceRefs"] {
                    if let Some(value) = node.get(key) {
                        task.insert(key.to_owned(), value.clone());
                    }
                }
                task.insert("subtasks".to_owned(), json!(tasks(&node["subtasks"])));
                Value::Object(task)
            })
            .collect()
    }
    let facts = json!([
        plan["planId"],
        plan["goal"],
        plan["successCriteria"],
        tasks(&plan["tasks"]),
        plan["manualConfirmations"],
        plan["deliveryBinding"]
    ]);
    let bytes = peer_protocol::javascript_json_string(&facts).map_err(|_| GoalError::Invalid)?;
    Ok(format!("{:x}", Sha256::digest(bytes.as_bytes())))
}

impl VerifierLease {
    pub fn plan_id(&self) -> &str {
        self.owner.plan_id()
    }
}

impl GoalStore {
    pub fn begin_verifier(
        &self,
        owner: &OrdinaryRunner,
        id: &str,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Option<VerifierLease>, GoalError> {
        if !valid_id(id, false) {
            return Err(GoalError::Invalid);
        }
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(owner)?;
        if self.ordinary_goal_verification(&plan)?.1 != Some("goal_verifier_required") {
            return Ok(None);
        }
        let criterion_revision = criterion_revision(&plan)?;
        let runner = &mut plan["runner"];
        if runner["nativeVerifierId"].is_string() {
            return Err(GoalError::Changed);
        }
        let runs = runner
            .as_object_mut()
            .ok_or(GoalError::Invalid)?
            .entry("verifierRuns")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(GoalError::Invalid)?;
        if runs
            .iter()
            .any(|row| row["verifierRunId"] == id || row["status"] == "running")
        {
            return Err(GoalError::Changed);
        }
        runs.push(json!({"verifierRunId":id,"planId":source.plan_id(),"target":{"kind":"plan"},"status":"running",
            "sourceRevision":criterion_revision,"summary":"Verifier started","evidenceRefs":[],"createdAt":at,"updatedAt":at}));
        runner["nativeVerifierId"] = json!(id);
        runner["phase"] = json!("verify");
        runner["intent"] = json!("verify");
        runner["updatedAt"] = json!(at);
        plan["updatedAt"] = json!(at);
        let (plan_revision, index) =
            transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(Some(VerifierLease {
            id: id.to_owned(),
            plan,
            owner: owner.clone(),
            criterion_revision,
            source: LocalGoalIntake {
                plan_revision,
                index_revision: files::fingerprint(&[index]),
                ..source
            },
        }))
    }

    pub fn check_verifier(&self, lease: &VerifierLease) -> Result<(), GoalError> {
        self.check_local_intake(&lease.source)
    }

    pub fn finish_verifier(
        &self,
        lease: &VerifierLease,
        result: VerifierSettlement,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<VerifierReceipt, GoalError> {
        let transaction = PlanWrite::lock(self)?;
        let mut plan = self.read_local_goal(&lease.source)?;
        if !lease.owner.owns(&plan)
            || plan["runner"]["nativeVerifierId"] != lease.id
            || plan["runner"]["phase"] != "verify"
            || criterion_revision(&plan)? != lease.criterion_revision
        {
            return Err(GoalError::Changed);
        }
        let has_report = matches!(&result, VerifierSettlement::Report { .. });
        let (mut report, mut reason, allows_repair) = match result {
            VerifierSettlement::Report {
                report,
                allows_repair,
            } => (report, "goal_verifier_failed", allows_repair),
            VerifierSettlement::Interrupted(reason) => {
                (json!({"passed":false,"evidenceRefs":[]}), reason, false)
            }
        };
        let refs = report["evidenceRefs"]
            .as_array()
            .ok_or(GoalError::Invalid)?
            .iter()
            .map(|reference| {
                reference
                    .as_str()
                    .map(str::to_owned)
                    .ok_or(GoalError::Invalid)
            })
            .collect::<Result<Vec<_>, _>>()?;
        if !refs.is_empty()
            && !self.verifier_refs_exist(&plan, &lease.id, lease.owner.stream_id(), &refs)?
        {
            report["passed"] = json!(false);
            report["evidenceRefs"] = json!([]);
            reason = "goal_verifier_evidence_unavailable";
        }
        if refs.is_empty() {
            report["passed"] = json!(false);
        }
        let passed = report["passed"] == true;
        let used = report["evidenceRefs"].clone();
        let row = running_review(&mut plan, &lease.id)?;
        row["status"] = json!(if passed { "passed" } else { "failed" });
        row["failureReason"] = json!((!passed).then_some(reason));
        row["summary"] = report["summary"]
            .as_str()
            .map_or_else(|| json!(reason), |summary| json!(summary));
        row["evidenceRefs"] = report["evidenceRefs"].clone();
        row["report"] = report;
        row["updatedAt"] = json!(at);
        if has_report {
            record_model_reviews(&mut plan, lease, passed, &used, at)?;
        }
        plan["runner"]
            .as_object_mut()
            .ok_or(GoalError::Invalid)?
            .remove("nativeVerifierId");
        plan["runner"]["updatedAt"] = json!(at);
        plan["updatedAt"] = json!(at);
        let (plan_revision, index) = transaction.publish(
            lease.plan_id(),
            &lease.source.plan_revision,
            &plan,
            at,
            admit,
        )?;
        Ok(VerifierReceipt {
            id: lease.id.clone(),
            allows_repair: allows_repair
                && !passed
                && used.as_array().is_some_and(|refs| !refs.is_empty()),
            passed,
            source: LocalGoalIntake {
                plan_revision,
                index_revision: files::fingerprint(&[index]),
                ..lease.source.clone()
            },
        })
    }

    pub fn begin_verification_repair(
        &self,
        owner: &OrdinaryRunner,
        receipt: &VerifierReceipt,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<bool, GoalError> {
        if !receipt.allows_repair {
            return Ok(false);
        }
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(owner)?;
        self.check_local_intake(&receipt.source)?;
        if receipt.source.plan_id() != owner.plan_id() || plan["runner"]["phase"] != "verify" {
            return Err(GoalError::Changed);
        }
        if !can_repair(&plan, owner)
            || self.ordinary_goal_verification(&plan)?.1 != Some("goal_verifier_required")
        {
            return Ok(false);
        }
        let revision = criterion_revision(&plan)?;
        let row = verifier_runs(&plan)
            .find(|row| row["verifierRunId"] == receipt.id)
            .ok_or(GoalError::Changed)?;
        let refs = evidence_refs(row)?;
        if row["status"] != "failed"
            || row["sourceRevision"] != revision
            || row["failureReason"] != "goal_verifier_failed"
            || row["report"]["passed"] != false
            || !row["nativeRepair"].is_null()
            || refs.is_empty()
            || !self.verifier_refs_exist(&plan, &receipt.id, owner.stream_id(), &refs)?
        {
            return Ok(false);
        }
        let row = plan["runner"]["verifierRuns"]
            .as_array_mut()
            .and_then(|rows| {
                rows.iter_mut()
                    .find(|row| row["verifierRunId"] == receipt.id)
            })
            .ok_or(GoalError::Changed)?;
        row["nativeRepair"] = repair_admission(owner, at);
        reopen_for_repair(&mut plan, at);
        transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(true)
    }

    pub fn begin_visual_verification_repair(
        &self,
        owner: &OrdinaryRunner,
        check_id: &str,
        report: &Value,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<bool, GoalError> {
        if !valid_id(check_id, false) {
            return Err(GoalError::Invalid);
        }
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(owner)?;
        if verifier_runs(&plan).any(|row| row["verifierRunId"] == check_id) {
            return Err(GoalError::Changed);
        }
        let revision = criterion_revision(&plan)?;
        let summary = report["summary"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or("Visual verification failed")
            .to_owned();
        let refs = report["evidenceRefs"]
            .as_array()
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(|s| json!(s))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let visual_repair_count = verifier_runs(&plan)
            .filter(|row| {
                row["nativeCheck"] == "visual_verification"
                    && row["nativeRepair"]["streamId"] == owner.stream_id()
            })
            .count();
        let eligible = !plan["runner"]["requestedInput"].is_object()
            && visual_repair_count < VISUAL_REPAIR_ATTEMPTS
            && (plan["workflowKind"] == "goal_self_driven"
                || plan["executionPolicy"]["autonomy"] == "self_driven"
                || plan["activation"]["kind"] == "accepted_goal"
                || plan["approval"]["decision"] == "approve");

        let mut row = json!({
            "verifierRunId": check_id,
            "planId": source.plan_id(),
            "target": { "kind": "plan" },
            "status": "failed",
            "nativeCheck": "visual_verification",
            "sourceRevision": revision,
            "summary": summary,
            "failureReason": "goal_visual_verification_failed",
            "evidenceRefs": refs,
            "report": report,
            "createdAt": at,
            "updatedAt": at,
        });
        if eligible {
            row["nativeRepair"] = repair_admission(owner, at);
        }

        let runner = plan["runner"].as_object_mut().ok_or(GoalError::Invalid)?;
        runner.insert("visualVerification".into(), report.clone());
        let runs = runner
            .entry("verifierRuns")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(GoalError::Invalid)?;
        runs.push(row);
        if eligible {
            plan["runner"]["visualRepair"] = json!(true);
            reopen_for_repair(&mut plan, at);
        } else {
            if let Some(obj) = plan["runner"].as_object_mut() {
                obj.remove("visualRepair");
            }
            plan["runner"]["updatedAt"] = json!(at);
            plan["updatedAt"] = json!(at);
        }
        transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(eligible)
    }

    pub fn begin_completion_gate_repair(
        &self,
        owner: &OrdinaryRunner,
        check_id: &str,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<bool, GoalError> {
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(owner)?;
        if !can_repair(&plan, owner) || !plan["deliveryBinding"].is_null() {
            return Ok(false);
        }
        let (_, reason) = self.ordinary_goal_verification(&plan)?;
        let Some(
            reason @ ("goal_verification_criterion_evidence_required"
            | "goal_verification_task_evidence_required"),
        ) = reason
        else {
            return Ok(false);
        };
        let Some(evidence) = self.completion_gate_evidence(&plan)? else {
            return Ok(false);
        };
        if !valid_id(check_id, false)
            || verifier_runs(&plan).any(|row| row["verifierRunId"] == check_id)
        {
            return Err(GoalError::Changed);
        }
        let revision = criterion_revision(&plan)?;
        plan["runner"]
            .as_object_mut()
            .ok_or(GoalError::Invalid)?
            .entry("verifierRuns")
            .or_insert_with(|| json!([]))
            .as_array_mut()
            .ok_or(GoalError::Invalid)?
            .push(json!({"verifierRunId":check_id,"planId":source.plan_id(),
                "target":{"kind":"plan"},"status":"failed","nativeCheck":"completion_gate",
                "sourceRevision":revision,"summary":reason,"failureReason":reason,
                "evidenceRefs":evidence,"createdAt":at,"updatedAt":at,
                "nativeRepair":repair_admission(owner, at)}));
        reopen_for_repair(&mut plan, at);
        transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(true)
    }

    fn completion_gate_evidence(&self, plan: &Value) -> Result<Option<Vec<String>>, GoalError> {
        let mut refs = std::collections::BTreeSet::new();
        let mut pending: Vec<_> = plan["tasks"].as_array().into_iter().flatten().collect();
        while let Some(task) = pending.pop() {
            if let Some(children) = task["subtasks"].as_array().filter(|rows| !rows.is_empty()) {
                pending.extend(children);
            } else if task["evidenceRefs"].is_array() {
                refs.extend(evidence_refs(task)?);
            }
        }
        for result in plan["criterionResults"].as_array().into_iter().flatten() {
            if let Some(reference) = result["evidenceRef"].as_str() {
                refs.insert(reference.to_owned());
            }
        }
        let home = self.directory.parent().ok_or(GoalError::Invalid)?;
        let conversation = plan["conversationId"].as_str().ok_or(GoalError::Invalid)?;
        let plan_id = plan["planId"].as_str().ok_or(GoalError::Invalid)?;
        let refs = refs.into_iter().collect::<Vec<_>>();
        let actual =
            super::task_update::observed_evidence(home, conversation, plan_id, &refs, None)?;
        Ok((actual.len() == refs.len()).then_some(refs))
    }

    fn verifier_refs_exist(
        &self,
        plan: &Value,
        id: &str,
        stream: &str,
        refs: &[String],
    ) -> Result<bool, GoalError> {
        let home = self.directory.parent().ok_or(GoalError::Invalid)?;
        let conversation = plan["conversationId"].as_str().ok_or(GoalError::Invalid)?;
        let plan_id = plan["planId"].as_str().ok_or(GoalError::Invalid)?;
        Ok(observed_scoped_evidence(
            home,
            conversation,
            plan_id,
            refs,
            None,
            Some(VerifierEvidence { id, stream }),
        )?
        .len()
            == refs.len())
    }

    pub(super) fn verified_completion(
        &self,
        plan: &Value,
        runner: &OrdinaryRunner,
        receipt: Option<&VerifierReceipt>,
    ) -> Result<(&'static str, Option<&'static str>), GoalError> {
        let eligibility = self.ordinary_goal_verification(plan)?;
        if eligibility.1 != Some("goal_verifier_required") {
            return Ok(eligibility);
        }
        let Some(receipt) = receipt else {
            return Ok(eligibility);
        };
        self.check_local_intake(&receipt.source)?;
        if receipt.source.plan_id() != runner.plan_id() {
            return Err(GoalError::Changed);
        }
        let row = plan["runner"]["verifierRuns"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["verifierRunId"] == receipt.id)
            .ok_or(GoalError::Changed)?;
        if row["status"] != "passed" {
            return Ok(("blocked", Some("goal_verifier_failed")));
        }
        let refs = evidence_refs(row)?;
        if refs.is_empty()
            || row["sourceRevision"] != criterion_revision(plan)?
            || row["report"]["passed"] != true
            || !self.verifier_refs_exist(plan, &receipt.id, runner.stream_id(), &refs)?
        {
            return Ok(("blocked", Some("goal_verifier_evidence_unavailable")));
        }
        if model_review_ids(plan).any(|id| {
            plan["modelReviews"]
                .as_array()
                .into_iter()
                .flatten()
                .rev()
                .find(|entry| entry["criterionId"] == id)
                .is_none_or(|entry| {
                    entry["passed"] != true
                        || entry["sourceRevision"] != row["sourceRevision"]
                        || entry["verifierRunId"] != receipt.id
                        || entry["evidenceRefs"] != row["evidenceRefs"]
                })
        }) {
            return Ok(("blocked", Some("goal_model_review_required")));
        }
        Ok(("completed", None))
    }
}

fn can_repair(plan: &Value, owner: &OrdinaryRunner) -> bool {
    let self_driven = plan["workflowKind"] == "goal_self_driven"
        || plan["executionPolicy"]["autonomy"] == "self_driven"
        || plan["activation"]["kind"] == "accepted_goal";
    self_driven
        && !plan["runner"]["requestedInput"].is_object()
        && repairs(plan, owner.stream_id()).count() < VERIFICATION_REPAIR_ATTEMPTS
}

fn repair_admission(owner: &OrdinaryRunner, at: &str) -> Value {
    json!({"streamId":owner.stream_id(),"startedAt":at})
}

fn reopen_for_repair(plan: &mut Value, at: &str) {
    super::runner::reopen_unverified(plan);
    super::runner::timing_started(plan, at);
    let runner = &mut plan["runner"];
    runner["phase"] = json!("repair");
    runner["intent"] = json!("execute");
    runner["updatedAt"] = json!(at);
    plan["updatedAt"] = json!(at);
}

fn verifier_runs(plan: &Value) -> impl Iterator<Item = &Value> {
    plan["runner"]["verifierRuns"]
        .as_array()
        .into_iter()
        .flatten()
}

pub(super) fn repairs<'a>(plan: &'a Value, stream: &'a str) -> impl Iterator<Item = &'a Value> {
    verifier_runs(plan).filter(move |row| row["nativeRepair"]["streamId"] == stream)
}

pub(super) fn settle_repair(
    plan: &mut Value,
    stream: &str,
    at: &str,
    reason: Option<&str>,
) -> Result<(), GoalError> {
    if plan["runner"]["phase"] != "repair" {
        return Ok(());
    }
    let repair = plan["runner"]["verifierRuns"]
        .as_array_mut()
        .and_then(|rows| {
            rows.iter_mut().rev().find(|row| {
                row["nativeRepair"]["streamId"] == stream
                    && row["nativeRepair"]["settledAt"].is_null()
            })
        })
        .ok_or(GoalError::Changed)?;
    repair["nativeRepair"]["settledAt"] = json!(at);
    if let Some(reason) = reason {
        repair["nativeRepair"]["stopReason"] = json!(reason);
    }
    Ok(())
}

fn evidence_refs(row: &Value) -> Result<Vec<String>, GoalError> {
    row["evidenceRefs"]
        .as_array()
        .ok_or(GoalError::Invalid)?
        .iter()
        .map(|value| value.as_str().map(str::to_owned).ok_or(GoalError::Invalid))
        .collect()
}

fn running_review<'a>(plan: &'a mut Value, id: &str) -> Result<&'a mut Value, GoalError> {
    plan["runner"]["verifierRuns"]
        .as_array_mut()
        .and_then(|rows| {
            rows.iter_mut()
                .find(|row| row["verifierRunId"] == id && row["status"] == "running")
        })
        .ok_or(GoalError::Changed)
}

pub(super) fn interrupt_verifier(plan: &mut Value, at: &str) -> Result<(), GoalError> {
    if let Some(id) = plan["runner"]["nativeVerifierId"]
        .as_str()
        .map(str::to_owned)
    {
        let row = running_review(plan, &id)?;
        row["status"] = json!("failed");
        row["failureReason"] = json!("goal_verifier_owner_interrupted");
        row["updatedAt"] = json!(at);
        plan["runner"]
            .as_object_mut()
            .ok_or(GoalError::Invalid)?
            .remove("nativeVerifierId");
    }
    Ok(())
}
