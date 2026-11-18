//! Host-owned continuation of an ordinary Goal. Model turns reuse the same
//! cognition, permission and Tool Result/Evidence chain as the intake turn.
use super::*;
use crate::{goal_facts::leaf_tasks, system_context::goal_runner, turn_loop};
use peer_store::{
    GoalStore, LocalGoalIntake, OrdinaryRunner, RunnerAdmission, RunnerPhase, RunnerStop,
    VerifierReceipt,
};

const NO_PROGRESS_LIMIT: usize = 3;

pub(super) struct Runner {
    pub lease: OrdinaryRunner,
    pub frame: Option<(LocalGoalIntake, Value)>,
    tick: Option<Tick>,
    verification: Option<VerifierReceipt>,
}

pub(super) enum RunnerOutcome {
    Stop(RunnerStop),
    Waiting(Value),
}

struct Tick {
    content: String,
    after_messages: usize,
    compaction_boundary: i64,
}

#[derive(Default)]
struct Progress {
    last: Option<(u64, usize)>,
    no_progress: usize,
}

impl Progress {
    fn stalled(&mut self, plan: &Value) -> bool {
        let completed = plan["progress"]["completed"].as_u64().unwrap_or(0);
        let references = leaf_tasks(plan)
            .map(|task| task["evidenceRefs"].as_array().map_or(0, Vec::len))
            .sum();
        if self
            .last
            .replace((completed, references))
            .is_none_or(|(previous, evidence)| completed > previous || references > evidence)
        {
            self.no_progress = 0;
        } else {
            self.no_progress += 1;
        }
        self.no_progress >= NO_PROGRESS_LIMIT
    }
}

impl Host<'_> {
    pub(super) async fn drive_new_goal(
        &mut self,
        max_turns: Option<usize>,
    ) -> Result<Option<RunnerOutcome>, HostError> {
        self.source_current()?;
        let Some(goal) = self.newly_created_goal()? else {
            return Ok(None);
        };
        let store = GoalStore::new(&self.home);
        if max_turns.is_some_and(|max| self.turns >= max)
            && store.read_local_goal(&goal)?["status"] != "completed"
        {
            return Ok(None);
        }
        let projection = self
            .providers
            .project_for_mode(RuntimeMode::Goal, self.allowlist.as_deref())?;
        let admission = store.begin_ordinary_runner(&goal, &self.identity, &now(), || {
            self.source_current().map_err(|error| error.0)
        })?;
        let lease = match admission {
            RunnerAdmission::Started(lease) => lease,
            RunnerAdmission::Waiting(plan) => {
                return Ok(Some(RunnerOutcome::Waiting(report(&plan))));
            }
        };
        self.runner = Some(Runner {
            lease: lease.clone(),
            tick: None,
            frame: None,
            verification: None,
        });
        self.mode = RuntimeMode::Goal;
        self.projection = projection;
        self.advance_goal(&store, &lease, max_turns)
            .await
            .map(|stop| Some(RunnerOutcome::Stop(stop)))
    }

    async fn advance_goal(
        &mut self,
        store: &GoalStore,
        lease: &OrdinaryRunner,
        max_turns: Option<usize>,
    ) -> Result<RunnerStop, HostError> {
        let mut progress = Progress::default();
        let mut phase = RunnerPhase::Orient;
        let owned = self.owned.clone();
        let external = self.external.clone();
        loop {
            self.source_current()?;
            let (source, plan) = store.read_ordinary_runner(lease)?;
            match plan["status"].as_str() {
                Some("completed") => {
                    let remaining = max_turns.map(|max| max.saturating_sub(self.turns));
                    if remaining == Some(0) {
                        return Ok(RunnerStop::BudgetExhausted);
                    }
                    let result = match self.run_goal_verifier(store, lease, remaining).await {
                        Err(HostError("goal_verifier_budget_exhausted")) => {
                            return Ok(RunnerStop::BudgetExhausted);
                        }
                        result => result?,
                    };
                    self.runner.as_mut().expect("owned Runner").verification = result;
                    return Ok(RunnerStop::Verify);
                }
                Some("failed") => return Ok(RunnerStop::Failed),
                _ => {}
            }
            if leaf_tasks(&plan).any(|task| task["status"] == "waiting_user") {
                return Ok(RunnerStop::Waiting("requested_user_input"));
            }
            let remaining = max_turns.map(|max| max.saturating_sub(self.turns));
            if remaining == Some(0) {
                return Ok(RunnerStop::BudgetExhausted);
            }
            if progress.stalled(&plan) {
                return Ok(RunnerStop::Blocked("no_progress"));
            }
            let next = match phase {
                RunnerPhase::Orient => RunnerPhase::Inspect,
                RunnerPhase::Inspect => RunnerPhase::PlanScaffold,
                RunnerPhase::PlanScaffold | RunnerPhase::Act => RunnerPhase::Act,
            };
            let mut tool_calls = None;
            if !matches!(phase, RunnerPhase::Inspect)
                || !self.drive_deterministic_inspect(source, &plan).await?
            {
                self.begin_runner_tick(&plan)?;
                let turn = turn_loop::run(self, remaining, &owned, &external).await;
                self.runner.as_mut().expect("owned Runner").tick = None;
                let turn = turn?;
                tool_calls = Some(turn.tool_calls);
                if turn.stop == turn_loop::LoopStop::MaxTurns {
                    store.record_ordinary_runner_step(lease, phase, tool_calls, &now(), || {
                        self.source_current().map_err(|error| error.0)
                    })?;
                    return Ok(RunnerStop::BudgetExhausted);
                }
                self.drive_requested_explorers().await?;
            }
            store.record_ordinary_runner_step(lease, next, tool_calls, &now(), || {
                self.source_current().map_err(|error| error.0)
            })?;
            phase = next;
        }
    }

    fn begin_runner_tick(&mut self, plan: &Value) -> Result<(), HostError> {
        let completed = plan["runner"]["turnCount"]
            .as_u64()
            .ok_or(HostError("goal_runner_state_invalid"))?;
        let number = completed
            .checked_add(1)
            .ok_or(HostError("runtime_counter_limit"))?;
        let projected = crate::canonical_history::project_history(&self.expected.history.messages)
            .map_err(HostError)?;
        self.runner.as_mut().expect("owned Runner").tick = Some(Tick {
            content: goal_runner::tick(plan, number),
            after_messages: projected["messages"].as_array().map_or(0, Vec::len),
            compaction_boundary: projected["compactionBoundaryIndex"].as_i64().unwrap_or(-1),
        });
        Ok(())
    }

    pub(super) fn runner_request_input(&self, projected: &Value) -> Option<(usize, &str)> {
        let tick = self.runner.as_ref()?.tick.as_ref()?;
        let index = if projected["compactionBoundaryIndex"] == tick.compaction_boundary {
            tick.after_messages
        } else {
            // The canonical compactor keeps exactly one authentic user row.
            1
        };
        Some((index, &tick.content))
    }

    pub(super) fn check_runner(&self) -> Result<(), HostError> {
        if self.worker.is_none()
            && let Some(runner) = &self.runner
        {
            let store = GoalStore::new(&self.home);
            if let Some((source, _)) = &runner.frame {
                store.check_local_intake(source)?;
            } else {
                store.read_ordinary_runner(&runner.lease)?;
            }
        }
        Ok(())
    }

    pub(super) fn prepare_runner_frame(&mut self) -> Result<(), HostError> {
        if self.worker.is_none()
            && let Some(runner) = &mut self.runner
        {
            runner.frame = Some(GoalStore::new(&self.home).read_ordinary_runner(&runner.lease)?);
        }
        Ok(())
    }

    pub(super) fn settle_runner(&self, stop: RunnerStop) -> Result<Option<Value>, HostError> {
        let Some(runner) = &self.runner else {
            return Ok(None);
        };
        let current = || {
            self.store
                .read_conversation_execution(&self.identity.conversation_id)?
                .ok_or(HostError("goal_runner_stop_unproven"))
        };
        let run = current()?;
        if run.owner != *self.run.owner() {
            return Err(HostError("goal_runner_stop_unproven"));
        }
        let plan = GoalStore::new(&self.home).settle_ordinary_runner(
            &runner.lease,
            &run,
            stop,
            runner.verification.as_ref(),
            &now(),
            || {
                let latest = current().map_err(|error| error.0)?;
                if latest != run {
                    return Err("goal_runner_stop_unproven");
                }
                Ok(())
            },
        )?;
        Ok(Some(report(&plan)))
    }
}

fn report(plan: &Value) -> Value {
    let runner = &plan["runner"];
    let manual = plan["successCriteria"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|criterion| criterion["kind"] == "manual")
        .filter_map(|criterion| criterion["id"].as_str())
        .filter(|id| {
            !plan["manualConfirmations"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|entry| {
                    entry["kind"] == "manual_dod"
                        && entry["decision"] == "approve"
                        && entry["criterionIds"]
                            .as_array()
                            .is_some_and(|ids| ids.iter().any(|value| value == *id))
                })
        })
        .collect::<Vec<_>>();
    json!({"planId":plan["planId"],"planStatus":plan["status"],"runnerStatus":runner["status"],
            "exitReason":runner["blockedReason"],"blockedReason":runner["blockedReason"],
                "waitingQuestion":null,"pendingManualDoD":manual,"progress":plan["progress"]})
}
