//! The ordinary Runner uses the Goal's canonical body and the same writer fence
//! as task publications and Explorer lifecycles.
use super::{explorer::PlanWrite, *};
use crate::durable_jsonl as log;
use peer_protocol::{ConversationExecution, ConversationExecutionIdentity};
use serde_json::json;

#[derive(Clone)]
pub struct OrdinaryRunner {
    pub(super) goal: LocalGoalIntake,
    identity: ConversationExecutionIdentity,
    verify_only: bool,
}

pub enum RunnerAdmission {
    Started(OrdinaryRunner),
    Waiting(Value),
}

#[derive(Clone, Copy)]
pub enum RunnerPhase {
    Orient,
    Inspect,
    PlanScaffold,
    Act,
    Repair,
}
impl RunnerPhase {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Orient => "orient",
            Self::Inspect => "inspect",
            Self::PlanScaffold => "plan_scaffold",
            Self::Act => "act",
            Self::Repair => "repair",
        }
    }
}

#[derive(Clone, Copy)]
pub enum RunnerStop {
    Verify,
    Failed,
    Blocked(&'static str),
    Waiting(&'static str),
    BudgetExhausted,
}

impl OrdinaryRunner {
    pub fn plan_id(&self) -> &str {
        self.goal.plan_id()
    }

    pub(super) fn stream_id(&self) -> &str {
        &self.identity.stream_id
    }

    pub(super) fn owns(&self, plan: &Value) -> bool {
        plan["planId"] == self.plan_id()
            && plan["conversationId"] == self.identity.conversation_id
            && plan["runner"]["nativeRunnerOwner"] == self.identity.stream_id
    }
}

pub(super) fn valid_runner_owner(plan: &Value, stream: &str) -> bool {
    plan["runner"]["status"] == "running" && plan["runner"]["nativeRunnerOwner"] == stream
}

fn is_stopped(run: &ConversationExecution) -> bool {
    run.stop
        .as_ref()
        .is_some_and(|stop| stop.runner_idle && stop.admission_closed && stop.handles_ended)
        && run.handles.is_empty()
}

pub(super) fn timing_started(plan: &mut Value, at: &str) {
    if !plan["timing"].is_object() {
        plan["timing"] = json!({"activeAccumulatedMs":0});
    }
    if let Some(timing) = plan["timing"].as_object_mut() {
        timing.entry("startedAt").or_insert_with(|| json!(at));
        timing
            .entry("activeSegmentStartedAt")
            .or_insert_with(|| json!(at));
    }
}

impl GoalStore {
    pub fn begin_ordinary_runner(
        &self,
        goal: &LocalGoalIntake,
        identity: &ConversationExecutionIdentity,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<RunnerAdmission, GoalError> {
        if !valid_id(&identity.stream_id, false) {
            return Err(GoalError::Invalid);
        }
        let transaction = PlanWrite::lock(self)?;
        let mut plan = self.read_local_goal(goal)?;
        if plan["conversationId"] != identity.conversation_id
            || plan["originWorkspacePath"].as_str().map(Path::new) != Some(&goal.workspace)
            || !plan["parentPlanId"].is_null()
            || !plan["delegationOrigin"].is_null()
            || !matches!(
                plan["status"].as_str(),
                Some("accepted" | "approved" | "executing" | "completed")
            )
            || plan["runner"]["requestedInput"].is_object()
            || plan["runner"]["nativeRunnerOwner"].is_string()
            || plan["runner"].is_object() && !explorer::retired(&plan["runner"])
        {
            return Err(GoalError::Projection("goal_plan_requires_current_owner"));
        }
        if !plan["runner"].is_object() {
            plan["runner"] = json!({"turnCount":0,"roundCount":0,"toolCallCount":0,"explorers":[]});
        }
        let verify_only = plan["status"] == "completed";
        let authorized = verify_only
            || plan["approval"]["decision"] == "approve"
            || plan["status"] == "executing"
            || plan["workflowKind"] == "goal_self_driven"
                && (plan["activation"]["kind"] == "accepted_goal" || plan["status"] == "accepted");
        if !authorized {
            set_stopped(
                &mut plan,
                "blocked",
                Some("goal_runner_approval_required"),
                at,
            );
            transaction.publish(goal.plan_id(), &goal.plan_revision, &plan, at, admit)?;
            return Ok(RunnerAdmission::Waiting(plan));
        }
        if !verify_only {
            plan["status"] = json!("executing");
            timing_started(&mut plan, at);
        }
        let runner = &mut plan["runner"];
        let counters = runner.as_object_mut().ok_or(GoalError::Invalid)?;
        // Legacy display budgets are informative. Actual admission is governed
        // by the caller's explicit cap and the no-progress policy.
        for (key, display_limit) in [("maxTurns", 8), ("maxToolCalls", 40), ("maxExplorers", 3)] {
            counters.entry(key).or_insert(json!(display_limit));
        }
        runner["nativeRunnerOwner"] = json!(identity.stream_id);
        runner["enabled"] = json!(true);
        runner["status"] = json!("running");
        runner["intent"] = json!(if verify_only { "verify" } else { "execute" });
        runner["phase"] = json!(if verify_only {
            "verify"
        } else {
            RunnerPhase::Orient.as_str()
        });
        runner["updatedAt"] = json!(at);
        plan["updatedAt"] = json!(at);
        transaction.publish(goal.plan_id(), &goal.plan_revision, &plan, at, admit)?;
        Ok(RunnerAdmission::Started(OrdinaryRunner {
            goal: goal.clone(),
            identity: identity.clone(),
            verify_only,
        }))
    }

    pub fn read_ordinary_runner(
        &self,
        runner: &OrdinaryRunner,
    ) -> Result<(LocalGoalIntake, Value), GoalError> {
        let index = files::identity(&self.directory.join("index.jsonl"))?;
        let goal = LocalGoalIntake {
            plan_revision: self.revision(runner.plan_id())?,
            index_revision: files::fingerprint(&[index]),
            ..runner.goal.clone()
        };
        let plan = self.read_local_goal(&goal)?;
        if !runner.owns(&plan)
            || runner.verify_only
                && plan["status"] != "completed"
                && super::verifier::repairs(&plan, runner.stream_id())
                    .next()
                    .is_none()
            || !valid_runner_owner(&plan, &runner.identity.stream_id)
            || plan["originWorkspacePath"].as_str().map(Path::new) != Some(&goal.workspace)
            || !plan["parentPlanId"].is_null()
            || !plan["delegationOrigin"].is_null()
            || !matches!(
                plan["status"].as_str(),
                Some("executing" | "completed" | "failed")
            )
        {
            return Err(GoalError::Changed);
        }
        Ok((goal, plan))
    }

    pub fn record_ordinary_runner_step(
        &self,
        runner: &OrdinaryRunner,
        next: RunnerPhase,
        tool_calls: Option<usize>,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), GoalError> {
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(runner)?;
        if plan["runner"]["phase"] == "repair" && next.as_str() != "repair" {
            super::verifier::settle_repair(&mut plan, runner.stream_id(), at, None)?;
            super::task_update::transition_plan(&mut plan, at)?;
        }
        let runner = &mut plan["runner"];
        if let Some(tool_calls) = tool_calls {
            for (key, increment) in [("turnCount", 1), ("toolCallCount", tool_calls as u64)] {
                let count = runner[key]
                    .as_u64()
                    .ok_or(GoalError::Invalid)?
                    .checked_add(increment)
                    .filter(|n| *n <= 9_007_199_254_740_991)
                    .ok_or(GoalError::Limit)?;
                runner[key] = json!(count);
            }
        }
        runner["phase"] = json!(next.as_str());
        runner["updatedAt"] = json!(at);
        plan["updatedAt"] = json!(at);
        transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(())
    }

    pub fn settle_ordinary_runner(
        &self,
        runner: &OrdinaryRunner,
        run: &ConversationExecution,
        requested: RunnerStop,
        verification: Option<&VerifierReceipt>,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<Value, GoalError> {
        if runner.identity != run.identity || !is_stopped(run) {
            return Err(GoalError::Projection("goal_runner_stop_unproven"));
        }
        let transaction = PlanWrite::lock(self)?;
        let (source, mut plan) = self.read_ordinary_runner(runner)?;
        let (status, reason) = if !run.pending_tools.is_empty() {
            ("blocked", Some("execution_outcome_unknown"))
        } else {
            match requested {
                RunnerStop::Verify => self.verified_completion(&plan, runner, verification)?,
                RunnerStop::Failed => ("failed", Some("goal_failed")),
                RunnerStop::Blocked(reason) => ("blocked", Some(reason)),
                RunnerStop::Waiting(reason) => ("waiting_user", Some(reason)),
                RunnerStop::BudgetExhausted => ("budget_exhausted", Some("max_turns")),
            }
        };
        if !matches!(status, "completed" | "waiting_user") {
            reopen_unverified(&mut plan);
        }
        super::verifier::interrupt_verifier(&mut plan, at)?;
        super::verifier::settle_repair(&mut plan, runner.stream_id(), at, reason)?;
        set_stopped(&mut plan, status, reason, at);
        transaction.publish(source.plan_id(), &source.plan_revision, &plan, at, admit)?;
        Ok(plan)
    }

    pub fn recover_stopped_runner(
        &self,
        run: &ConversationExecution,
        at: &str,
        admit: impl FnOnce() -> Result<(), &'static str>,
    ) -> Result<(), GoalError> {
        if !is_stopped(run) || files::identity(&self.directory.join("index.jsonl"))?.is_none() {
            return Ok(());
        }
        let transaction = PlanWrite::lock(self)?;
        let index = self.directory.join("index.jsonl");
        let mut owned = None;
        for row in log::read(&index, None)?
            .into_iter()
            .filter(|row| row["conversationId"] == run.identity.conversation_id)
        {
            let id = row["planId"].as_str().ok_or(GoalError::Invalid)?;
            let revision = self.revision(id)?;
            let plan = self.read_context(id, &revision)?;
            if plan["conversationId"] == run.identity.conversation_id
                && valid_runner_owner(&plan, &run.identity.stream_id)
                && owned.replace((id.to_owned(), revision, plan)).is_some()
            {
                return Err(GoalError::Changed);
            }
        }
        if let Some((id, revision, mut plan)) = owned {
            let reason = if run.pending_tools.is_empty() {
                "goal_runner_owner_interrupted"
            } else {
                "execution_outcome_unknown"
            };
            super::verifier::interrupt_verifier(&mut plan, at)?;
            super::verifier::settle_repair(&mut plan, &run.identity.stream_id, at, Some(reason))?;
            reopen_unverified(&mut plan);
            set_stopped(&mut plan, "blocked", Some(reason), at);
            transaction.publish(&id, &revision, &plan, at, admit)?;
        }
        Ok(())
    }

    pub(super) fn ordinary_goal_verification(
        &self,
        plan: &Value,
    ) -> Result<(&'static str, Option<&'static str>), GoalError> {
        if plan["status"] != "completed" {
            return Ok(("blocked", Some("goal_verification_incomplete")));
        }
        let mut leaves = 0;
        let mut stack: Vec<_> = plan["tasks"].as_array().into_iter().flatten().collect();
        let mut refs = std::collections::BTreeSet::new();
        while let Some(task) = stack.pop() {
            if let Some(children) = task["subtasks"].as_array().filter(|rows| !rows.is_empty()) {
                stack.extend(children);
                continue;
            }
            leaves += 1;
            let Some(evidence) = task["evidenceRefs"]
                .as_array()
                .filter(|refs| !refs.is_empty())
            else {
                return Ok(("blocked", Some("goal_verification_task_evidence_required")));
            };
            if !matches!(task["status"].as_str(), Some("completed" | "cancelled")) {
                return Ok(("blocked", Some("goal_verification_incomplete")));
            }
            for reference in evidence {
                refs.insert(reference.as_str().ok_or(GoalError::Invalid)?.to_owned());
            }
        }
        if leaves == 0 {
            return Ok(("blocked", Some("goal_verification_incomplete")));
        }
        let mut manual = Vec::new();
        for criterion in plan["successCriteria"].as_array().into_iter().flatten() {
            let id = criterion["id"].as_str().ok_or(GoalError::Invalid)?;
            match criterion["kind"].as_str() {
                Some("manual") => manual.push(id),
                Some("model_review") => {}
                Some("test" | "command" | "file-exists" | "file-contains") => {
                    let evidence = plan["criterionResults"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .rev()
                        .find(|result| result["criterionId"] == id)
                        .filter(|result| result["passed"] == true)
                        .and_then(|result| result["evidenceRef"].as_str());
                    let Some(evidence) = evidence else {
                        return Ok((
                            "blocked",
                            Some("goal_verification_criterion_evidence_required"),
                        ));
                    };
                    refs.insert(evidence.to_owned());
                }
                _ => return Ok(("blocked", Some("goal_verification_criterion_unsupported"))),
            }
        }
        let home = self.directory.parent().ok_or(GoalError::Invalid)?;
        let conversation = plan["conversationId"].as_str().ok_or(GoalError::Invalid)?;
        let plan_id = plan["planId"].as_str().ok_or(GoalError::Invalid)?;
        let refs = refs.into_iter().collect::<Vec<_>>();
        if super::task_update::observed_evidence(home, conversation, plan_id, &refs, None)?.len()
            != refs.len()
        {
            return Ok(("blocked", Some("goal_verification_evidence_unavailable")));
        }
        if !manual.is_empty()
            && plan["manualConfirmations"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|entry| {
                    entry["kind"] == "manual_dod"
                        && manual.iter().all(|id| {
                            entry["criterionIds"]
                                .as_array()
                                .is_some_and(|ids| ids.iter().any(|value| value == *id))
                        })
                })
                .max_by_key(|entry| entry["decidedAt"].as_str().unwrap_or(""))
                .is_none_or(|entry| entry["decision"] != "approve")
        {
            return Ok(("waiting_user", Some("manual_dod_confirmation_required")));
        }
        Ok(("blocked", Some("goal_verifier_required")))
    }
}

pub(super) fn reopen_unverified(plan: &mut Value) {
    if plan["status"] == "completed" {
        // Settled leaves are provisional until an independent review passes.
        plan["status"] = json!("executing");
        if let Some(timing) = plan["timing"].as_object_mut() {
            for key in ["completedAt", "wallClockMs", "activeMs"] {
                timing.remove(key);
            }
        }
    }
}

fn set_stopped(plan: &mut Value, status: &str, reason: Option<&str>, at: &str) {
    let runner = &mut plan["runner"];
    runner["enabled"] = json!(false);
    runner["status"] = json!(status);
    runner["intent"] = json!(if status == "completed" {
        "synthesize"
    } else {
        "block"
    });
    runner["phase"] = json!(match status {
        "completed" => "synthesize",
        "waiting_user" => "waiting_user",
        _ => "blocked",
    });
    runner["blockedReason"] = json!(reason);
    runner["updatedAt"] = json!(at);
    plan["updatedAt"] = json!(at);
}
