//! Independently observed Goal review under the original conversation owner.
use super::{
    explorer::PlanWrite,
    task_update::{VerifierEvidence, observed_scoped_evidence},
    *,
};
use serde_json::json;
use sha2::{Digest, Sha256};

pub struct VerifierLease {
    pub id: String,
    pub plan: Value,
    owner: OrdinaryRunner,
    source: LocalGoalIntake,
    criterion_revision: String,
}

pub enum VerifierSettlement {
    Report(Value),
    Interrupted(&'static str),
}

pub struct VerifierReceipt {
    source: LocalGoalIntake,
    id: String,
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
        let (mut report, mut reason) = match result {
            VerifierSettlement::Report(report) => (report, "goal_verifier_failed"),
            VerifierSettlement::Interrupted(reason) => {
                (json!({"passed":false,"evidenceRefs":[]}), reason)
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
        let row = running_review(&mut plan, &lease.id)?;
        row["status"] = json!(if passed { "passed" } else { "failed" });
        row["failureReason"] = json!((!passed).then_some(reason));
        row["summary"] = report["summary"]
            .as_str()
            .map_or_else(|| json!(reason), |summary| json!(summary));
        row["evidenceRefs"] = report["evidenceRefs"].clone();
        row["report"] = report;
        row["updatedAt"] = json!(at);
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
            source: LocalGoalIntake {
                plan_revision,
                index_revision: files::fingerprint(&[index]),
                ..lease.source.clone()
            },
        })
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
        let refs = row["evidenceRefs"]
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
        if refs.is_empty()
            || row["sourceRevision"] != criterion_revision(plan)?
            || row["report"]["passed"] != true
            || !self.verifier_refs_exist(plan, &receipt.id, runner.stream_id(), &refs)?
        {
            return Ok(("blocked", Some("goal_verifier_evidence_unavailable")));
        }
        Ok(("completed", None))
    }
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
