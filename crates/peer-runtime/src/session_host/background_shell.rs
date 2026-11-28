//! Background workers keep their original Work attempt, grant and stop owner.
use super::authority::ShellLifetimeAuthority;
use super::command_process::CommandOwner;
use super::*;
use crate::{
    CancellationToken,
    execution_budget::EpisodeBudget,
    live_execution::{HandleStop, LiveError},
    providers::{EffectOutcome, shell_stop_outcome},
};
use peer_protocol::{NativeOwnedProcess, NativeProcessRecorder, NativeProcessState};
use std::{collections::BTreeMap, time::Duration};
use tokio::sync::oneshot;

const UNPROVEN: HostError = HostError("execution_outcome_unknown");
const MISSING: HostError = HostError("shell_task_not_found");
const MAX_SHELLS: usize = 32;

pub(super) struct BackgroundWorker {
    pub cancel: CancellationToken,
    pub _cancel_if_dropped: tokio_util::sync::DropGuard,
    pub completion: oneshot::Receiver<EffectOutcome>,
}

struct Running {
    budget: EpisodeBudget,
    call: String,
    stream: String,
    dispatch: String,
    owner: NativeProcessRecorder,
    grant: Value,
    authority: ShellLifetimeAuthority,
    resource: HostResourcePlan,
    worker: BackgroundWorker,
    completion: Option<EffectOutcome>,
    process: Option<NativeOwnedProcess>,
    startup: Option<Value>,
}

impl Running {
    fn command(&self) -> CommandOwner<'_> {
        CommandOwner {
            budget: &self.budget,
            call: &self.call,
            dispatch: &self.dispatch,
            owner: self.owner.clone(),
        }
    }
}

struct Completed {
    stream: String,
    resource: HostResourcePlan,
    outcome: EffectOutcome,
}

#[derive(Default)]
pub(super) struct WorkBackgroundShells {
    running: BTreeMap<String, Running>,
    completed: BTreeMap<String, Completed>,
}

impl NativeSessionHost {
    pub(super) fn can_start_work_background_shell(&self) -> bool {
        self.background_shells.running.len() + self.background_shells.completed.len() < MAX_SHELLS
    }

    pub(super) fn has_work_background_shells(&self) -> bool {
        !self.background_shells.running.is_empty()
    }

    pub(super) fn work_background_shell_owned(
        &self,
        resource: &HostResourcePlan,
        task: &Value,
        stream: &str,
    ) -> bool {
        let Some(task) = task.as_str() else {
            return false;
        };
        self.background_shells.running.get(task).is_some_and(|run| {
            run.resource.execution == resource.execution
                && run.stream == stream
                && run.startup.is_some()
        }) || self
            .background_shells
            .completed
            .get(task)
            .is_some_and(|done| {
                done.resource.execution == resource.execution && done.stream == stream
            })
    }

    pub(super) fn verify_work_background_start(
        &self,
        command: &CommandOwner<'_>,
        resource: &HostResourcePlan,
        observation: &EffectOutcome,
    ) -> Result<(), HostError> {
        let process = command
            .budget
            .read_process(self, command.call, command.dispatch)?;
        let expected_artifact = format!("local-shell-artifact://{}", process.handle_id);
        if process.state != NativeProcessState::Running
            || process.child.is_none()
            || process.owner != command.owner
            || peer_protocol::normalize_session_execution_identity(&process.execution).as_ref()
                != Some(&resource.execution)
            || observation.status != "success"
            || observation.ended
            || observation.not_dispatched
            || observation.error.is_some()
            || observation.output["toolCallId"] != process.tool_call_id
            || observation.output["taskId"] != process.handle_id
            || observation.output["status"] != "running"
            || observation.output["artifactRef"] != expected_artifact
        {
            return Err(HostError("shell_background_start_unproven"));
        }
        Ok(())
    }

    pub(super) fn track_work_background_shell(
        &mut self,
        handle: &str,
        command: &CommandOwner<'_>,
        grant: &HostPermissionGrant,
        resource: &HostResourcePlan,
        worker: BackgroundWorker,
    ) {
        self.background_shells.running.insert(
            handle.to_owned(),
            Running {
                budget: command.budget.clone(),
                call: command.call.to_owned(),
                stream: grant.identity().stream_id.to_owned(),
                dispatch: command.dispatch.to_owned(),
                owner: command.owner.clone(),
                grant: grant.facts().clone(),
                authority: grant.shell_lifetime_authority(),
                resource: resource.clone(),
                worker,
                completion: None,
                process: None,
                startup: None,
            },
        );
    }

    pub(super) fn confirm_work_background_start(
        &mut self,
        result: &Value,
        indexed: &[Value],
    ) -> Result<(), HostError> {
        let handle = result["output"]["taskId"].as_str().ok_or(UNPROVEN)?;
        let running = self.background_shells.running.get(handle).ok_or(UNPROVEN)?;
        let call_ref = format!("tool-result://{}", running.call);
        if !indexed.iter().any(|row| {
            row["evidenceRef"] == call_ref
                && row["toolCallId"] == running.call
                && row["planId"] == running.budget.plan
                && row["capabilityId"] == "local.shell.exec"
        }) {
            return Err(UNPROVEN);
        }
        let budget = running.budget.clone();
        let grant = running.grant.clone();
        let process = budget.read_process(self, &running.call, &running.dispatch)?;
        let startup =
            budget.confirm_background_start(self, &process, result, &grant, &episode_time())?;
        self.background_shells
            .running
            .get_mut(handle)
            .ok_or(UNPROVEN)?
            .startup = Some(startup);
        Ok(())
    }

    pub(crate) fn background_dispatches(&self, budget: &EpisodeBudget) -> BTreeMap<String, Value> {
        self.background_shells
            .running
            .values()
            .filter(|run| {
                run.budget.work == budget.work
                    && run.budget.attempt == budget.attempt
                    && run.budget.native_recorder == budget.native_recorder
                    && !run.worker.cancel.is_cancelled()
            })
            .filter_map(|run| Some((run.dispatch.clone(), run.startup.clone()?)))
            .collect()
    }

    pub(super) fn check_work_background_shells(&self, owned: &CancellationToken) {
        if self.background_shells.running.values().any(|run| {
            !run.worker.cancel.is_cancelled() && run.authority.check(self, &episode_time()).is_err()
        }) {
            owned.cancel();
        }
    }

    pub(super) async fn reap_work_background_shells(
        &mut self,
        resource: &HostResourcePlan,
    ) -> Result<(), HostError> {
        if !self.has_work_background_shells() {
            return Ok(());
        }
        for (handle, call, state) in self
            .live
            .handle_observations(&resource.execution)
            .map_err(|_| UNPROVEN)?
        {
            if state != "ended" || !self.background_shells.running.contains_key(&handle) {
                continue;
            }
            let mut run = self
                .background_shells
                .running
                .remove(&handle)
                .ok_or(UNPROVEN)?;
            let finished = self
                .finish_work_background_shell(&handle, &call, &mut run)
                .await;
            match finished {
                Ok(outcome) => {
                    self.background_shells.completed.insert(
                        handle,
                        Completed {
                            resource: run.resource,
                            stream: run.stream,
                            outcome,
                        },
                    );
                }
                Err(error) => {
                    self.background_shells.running.insert(handle, run);
                    return Err(error);
                }
            }
        }
        Ok(())
    }

    async fn finish_work_background_shell(
        &mut self,
        handle: &str,
        call: &str,
        run: &mut Running,
    ) -> Result<EffectOutcome, HostError> {
        if run.call != call {
            return Err(UNPROVEN);
        }
        // The registry observes completion only after this same worker sends.
        if run.completion.is_none() {
            run.completion = Some((&mut run.worker.completion).await.map_err(|_| UNPROVEN)?);
        }
        let outcome = run.completion.as_ref().ok_or(UNPROVEN)?;
        if !outcome.ended {
            return Err(UNPROVEN);
        }
        if run.process.is_none() {
            let command = run.command();
            self.command_completed(&command)?;
            run.process = Some(run.budget.read_process(self, call, &run.dispatch)?);
        }
        self.resources.mark_handle(
            &run.resource,
            &json!({"handleId":handle,"toolCallId":call,"state":"ended"}),
            &episode_time(),
        )?;
        if outcome.error != Some("execution_outcome_unknown")
            && let Some(startup) = &run.startup
        {
            run.budget.settle_background(
                self,
                run.process.as_ref().ok_or(UNPROVEN)?,
                startup,
                &episode_time(),
            )?;
        }
        self.live
            .acknowledge_ended_handle(&run.resource.execution, handle)
            .map_err(|_| UNPROVEN)?;
        let mut outcome = run.completion.take().ok_or(UNPROVEN)?;
        outcome.output["toolCallId"] = json!(call);
        Ok(outcome)
    }

    pub(super) async fn stop_work_background_shell(
        &mut self,
        resource: &HostResourcePlan,
        grant: &HostPermissionGrant,
        args: &Value,
        handle: &str,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<EffectOutcome, HostError> {
        self.reap_work_background_shells(resource).await?;
        self.validate_permission(grant, args, &episode_time())?;
        if args["taskId"] != handle
            || !self.work_background_shell_owned(
                resource,
                &args["taskId"],
                grant.identity().stream_id,
            )
        {
            return Err(MISSING);
        }
        let mut stopped = false;
        if let Some(run) = self.background_shells.running.get(handle) {
            let call = run.call.clone();
            let live = self.live.clone();
            let identity = &resource.execution;
            let result = self
                .wait_owned(
                    live.stop_owned_handle(identity, handle, &call, Duration::from_secs(4)),
                    owned,
                    external,
                )
                .await
                .map_err(|_| UNPROVEN)?;
            stopped = match result {
                Ok(status) => status == HandleStop::Stopped,
                Err(LiveError::StopUnconfirmed | LiveError::Unknown) => return Err(UNPROVEN),
                Err(_) => return Err(MISSING),
            };
            self.reap_work_background_shells(resource).await?;
        }
        let done = self
            .background_shells
            .completed
            .get(handle)
            .ok_or(UNPROVEN)?;
        shell_stop_outcome(handle, args, stopped, &done.outcome)
    }

    pub(super) async fn drain_work_background_shells(
        &mut self,
        resource: &HostResourcePlan,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<(), HostError> {
        let active: Vec<_> = self
            .background_shells
            .running
            .iter()
            .filter(|(_, run)| run.resource.execution == resource.execution)
            .map(|(handle, run)| {
                run.worker.cancel.cancel();
                (handle.clone(), run.call.clone())
            })
            .collect();
        if active.is_empty() {
            self.background_shells
                .completed
                .retain(|_, done| done.resource.execution != resource.execution);
            return Ok(());
        }
        let live = self.live.clone();
        let execution = &resource.execution;
        let stopped = self
            .wait_owned(
                async {
                    let mut stops = tokio::task::JoinSet::new();
                    for (handle, call) in active {
                        let live = live.clone();
                        let execution = execution.clone();
                        stops.spawn(async move {
                            live.stop_owned_handle(
                                &execution,
                                &handle,
                                &call,
                                Duration::from_secs(4),
                            )
                            .await
                        });
                    }
                    let mut unproven = false;
                    while let Some(result) = stops.join_next().await {
                        unproven |= !matches!(result, Ok(Ok(_)));
                    }
                    if unproven { Err(UNPROVEN) } else { Ok(()) }
                },
                owned,
                external,
            )
            .await;
        let reaped = self.reap_work_background_shells(resource).await;
        self.background_shells
            .completed
            .retain(|_, done| done.resource.execution != *execution);
        stopped.map_err(|_| UNPROVEN)??;
        reaped?;
        if self
            .background_shells
            .running
            .values()
            .any(|run| run.resource.execution == *execution)
        {
            return Err(UNPROVEN);
        }
        Ok(())
    }
}
