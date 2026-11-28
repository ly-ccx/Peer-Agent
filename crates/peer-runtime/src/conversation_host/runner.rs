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
    pub visual_report: Option<Value>,
}

impl Runner {
    pub(super) fn new(lease: OrdinaryRunner) -> Self {
        Self {
            lease,
            frame: None,
            tick: None,
            verification: None,
            visual_report: None,
        }
    }
}

pub(super) enum RunnerOutcome {
    Stop(RunnerStop),
    Waiting(Value),
}

struct Tick {
    content: String,
    after_messages: usize,
    compaction_boundary: i64,
    repair: bool,
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
            visual_report: None,
        });
        self.mode = RuntimeMode::Goal;
        self.projection = projection;
        self.advance_goal(&store, &lease, max_turns)
            .await
            .map(|stop| Some(RunnerOutcome::Stop(stop)))
    }

    pub(super) async fn advance_goal(
        &mut self,
        store: &GoalStore,
        lease: &OrdinaryRunner,
        max_turns: Option<usize>,
    ) -> Result<RunnerStop, HostError> {
        let mut progress = Progress::default();
        let mut phase = RunnerPhase::Orient;
        let mut verifier_turns = 0usize;
        let remaining = |turns: usize, reviews| {
            max_turns.map(|max| max.saturating_sub(turns).saturating_sub(reviews))
        };
        let owned = self.owned.clone();
        let external = self.external.clone();
        let conv_id = self.identity.conversation_id.clone();
        let workspace = self.workspace.clone();
        loop {
            self.source_current()?;
            let (source, plan) = store.read_ordinary_runner(lease)?;
            match plan["status"].as_str() {
                Some("completed") if !matches!(phase, RunnerPhase::Repair) => {
                    let budget = remaining(self.turns, verifier_turns);
                    if budget == Some(0) {
                        return Ok(RunnerStop::BudgetExhausted);
                    }
                    let (result, turns) = match self.run_goal_verifier(store, lease, budget).await {
                        Err(HostError("goal_verifier_budget_exhausted")) => {
                            return Ok(RunnerStop::BudgetExhausted);
                        }
                        result => result?,
                    };
                    verifier_turns = verifier_turns
                        .checked_add(turns)
                        .ok_or(HostError("runtime_counter_limit"))?;
                    if remaining(self.turns, verifier_turns) != Some(0) {
                        let admit = || self.check_worker_settled(true).map_err(|error| error.0);
                        let repairing = match &result {
                            Some(receipt) => {
                                store.begin_verification_repair(lease, receipt, &now(), admit)?
                            }
                            None => store.begin_completion_gate_repair(
                                lease,
                                &format!("gate-{}", uuid::Uuid::new_v4()),
                                &now(),
                                admit,
                            )?,
                        };
                        if repairing {
                            self.emit_goal_event(GoalRunnerEvent::PlanChanged {
                                plan_id: lease.plan_id(),
                                conversation_id: &conv_id,
                                change_kind: "runner-state",
                            })
                            .await;
                            phase = RunnerPhase::Repair;
                            continue;
                        }
                    }
                    if result.as_ref().is_some_and(VerifierReceipt::passed)
                        && self.goal_hooks.is_some()
                    {
                        let visual_run_id = format!("visual-{}", uuid::Uuid::new_v4());
                        let visual = self
                            .run_visual_verification_hook(
                                lease.plan_id(),
                                &conv_id,
                                &visual_run_id,
                                &workspace,
                                &owned,
                            )
                            .await?;
                        if visual.required && !visual.passed {
                            let admit = || self.check_worker_settled(true).map_err(|error| error.0);
                            let repairing = store.begin_visual_verification_repair(
                                lease,
                                &visual_run_id,
                                &visual.report,
                                &now(),
                                admit,
                            )?;
                            self.emit_goal_event(GoalRunnerEvent::PlanChanged {
                                plan_id: lease.plan_id(),
                                conversation_id: &conv_id,
                                change_kind: "runner-state",
                            })
                            .await;
                            if repairing && remaining(self.turns, verifier_turns) != Some(0) {
                                self.emit_goal_event(GoalRunnerEvent::StateChanged {
                                    plan_id: lease.plan_id(),
                                    conversation_id: &conv_id,
                                    event_type: "goalRunner:visualRepairStarted",
                                    detail: json!({ "verifierRunId": visual_run_id }),
                                })
                                .await;
                                phase = RunnerPhase::Repair;
                                continue;
                            }
                            return Ok(RunnerStop::Blocked("goal_visual_verification_failed"));
                        }
                        if visual.required && visual.passed {
                            self.runner.as_mut().expect("owned Runner").visual_report =
                                Some(visual.report);
                        }
                    }
                    self.runner.as_mut().expect("owned Runner").verification = result;
                    return Ok(RunnerStop::Verify);
                }
                Some("failed") => return Ok(RunnerStop::Failed),
                _ => {}
            }
            if leaf_tasks(&plan).any(|task| task["status"] == "waiting_user") {
                return Ok(RunnerStop::Waiting("requested_user_input"));
            }
            let budget = remaining(self.turns, verifier_turns);
            if budget == Some(0) {
                return Ok(RunnerStop::BudgetExhausted);
            }
            if !matches!(phase, RunnerPhase::Repair) && progress.stalled(&plan) {
                return Ok(RunnerStop::Blocked("no_progress"));
            }
            let next = match phase {
                RunnerPhase::Orient => RunnerPhase::Inspect,
                RunnerPhase::Inspect => RunnerPhase::PlanScaffold,
                RunnerPhase::PlanScaffold | RunnerPhase::Act | RunnerPhase::Repair => {
                    RunnerPhase::Act
                }
            };
            let mut tool_calls = None;
            if !matches!(phase, RunnerPhase::Inspect)
                || !self.drive_deterministic_inspect(source, &plan).await?
            {
                let with_hooks = self.goal_hooks.is_some();
                let tick_stream_id = if with_hooks {
                    let turn_number = plan["runner"]["turnCount"]
                        .as_u64()
                        .unwrap_or(0)
                        .saturating_add(1);
                    let tick_id = format!("goal-tick-{}", uuid::Uuid::new_v4());
                    let assistant_id = format!("asst-goal-{}", uuid::Uuid::new_v4());
                    let started_at = now();
                    let started_at_ms = crate::capability::milliseconds(&started_at).unwrap_or(0);
                    let placeholder = json!({
                        "id": assistant_id,
                        "role": "assistant",
                        "content": "",
                        "segments": [],
                        "createdAt": started_at,
                        "streamId": self.identity.stream_id,
                        "permissionGrants": [],
                    });
                    self.append(&placeholder)?;
                    self.prepared_assistant = Some(PreparedAssistant {
                        message_id: assistant_id.clone(),
                        content: String::new(),
                        thinking_content: String::new(),
                        segments: Vec::new(),
                        permission_grants: Vec::new(),
                        started_at_ms,
                    });
                    self.emit_goal_event(GoalRunnerEvent::TickStarted {
                        plan_id: lease.plan_id(),
                        conversation_id: &conv_id,
                        stream_id: &tick_id,
                        turn_number,
                        assistant_message_id: &assistant_id,
                        started_at_ms,
                    })
                    .await;
                    Some(tick_id)
                } else {
                    None
                };

                self.begin_runner_tick(&plan)?;
                let turn = turn_loop::run(self, budget, &owned, &external).await;
                self.runner.as_mut().expect("owned Runner").tick = None;

                if let Some(tick_id) = tick_stream_id {
                    let tick_err = turn.as_ref().err().map(TurnError::code).or_else(|| {
                        turn.as_ref()
                            .ok()
                            .filter(|t| t.stop == turn_loop::LoopStop::MaxTurns)
                            .map(|_| "agent_loop_exhausted")
                    });
                    self.finalize_prepared_assistant(tick_err);
                    let cancelled = owned.is_cancelled()
                        || external.is_cancelled()
                        || tick_err == Some("CANCELLED");
                    let usage_snap = self.usage.snapshot();
                    self.emit_goal_event(GoalRunnerEvent::TickFinished {
                        plan_id: lease.plan_id(),
                        conversation_id: &conv_id,
                        stream_id: &tick_id,
                        error: tick_err,
                        cancelled,
                        usage: &usage_snap,
                    })
                    .await;
                }

                let turn = turn?;
                tool_calls = Some(turn.tool_calls);
                if turn.stop != turn_loop::LoopStop::Replied {
                    store.record_ordinary_runner_step(lease, phase, tool_calls, &now(), || {
                        self.source_current().map_err(|error| error.0)
                    })?;
                    self.emit_goal_event(GoalRunnerEvent::PlanChanged {
                        plan_id: lease.plan_id(),
                        conversation_id: &conv_id,
                        change_kind: "runner-progress",
                    })
                    .await;
                    return Ok(if turn.stop == turn_loop::LoopStop::MaxTurns {
                        RunnerStop::BudgetExhausted
                    } else {
                        RunnerStop::Blocked(turn.stop.as_str())
                    });
                }
                self.drive_requested_explorers().await?;
            }
            store.record_ordinary_runner_step(lease, next, tool_calls, &now(), || {
                self.source_current().map_err(|error| error.0)
            })?;
            self.emit_goal_event(GoalRunnerEvent::PlanChanged {
                plan_id: lease.plan_id(),
                conversation_id: &conv_id,
                change_kind: "runner-progress",
            })
            .await;
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
            repair: plan["runner"]["phase"] == "repair",
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

    pub(super) fn repairing_goal(&self) -> bool {
        self.worker.is_none()
            && self
                .runner
                .as_ref()
                .and_then(|runner| runner.tick.as_ref())
                .is_some_and(|tick| tick.repair)
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
        let plan = GoalStore::new(&self.home).settle_ordinary_runner_with_visual(
            &runner.lease,
            &run,
            stop,
            runner.verification.as_ref(),
            runner.visual_report.as_ref(),
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

pub(super) fn report_value(plan: &Value) -> Value {
    report(plan)
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
