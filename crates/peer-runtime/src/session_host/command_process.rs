//! Same canonical dispatch owns local command intent, child identity and stop.
use super::*;
use crate::{
    execution_budget::EpisodeBudget,
    recorder::{self, Recorder},
};
use peer_protocol::{NativeProcessState, NativeProcessStop};
pub(super) struct CommandOwner<'a> {
    pub budget: &'a EpisodeBudget,
    pub call: &'a str,
    pub dispatch: &'a str,
    pub owner: Recorder,
}
impl NativeSessionHost {
    pub(super) fn command_processes_stopped(&self, current: &Current) -> Result<bool, HostError> {
        let Some(work) = current.goal.facts["delegationOrigin"]["workId"].as_str() else {
            return Ok(true);
        };
        let processes =
            peer_protocol::native_processes_in_work(&current.journal.state["works"][work])
                .map_err(HostError)?;
        let execution = json!(current.resource.execution);
        Ok(self.work_hooks_stopped(current)?
            && self.work_shell_stopped(current)?
            && processes
                .iter()
                .filter(|p| p.execution == execution)
                .all(|p| p.state == NativeProcessState::Ended))
    }
    pub(super) async fn recover_command_processes(
        &mut self,
        current: &Current,
        cancel: &crate::CancellationToken,
    ) -> Result<(), HostError> {
        if self.live.ownership(&current.resource.execution).ok()
            == Some(crate::live_execution::Ownership::Live)
        {
            return Ok(());
        }
        let Some(owner) = self.dead_native_owner(current).await else {
            return Ok(());
        };
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .ok_or(HostError("native_process_owner_unknown"))?;
        let processes =
            peer_protocol::native_processes_in_work(&current.journal.state["works"][work])
                .map_err(HostError)?;
        let execution = json!(current.resource.execution);
        for process in processes.into_iter().filter(|p| p.execution == execution) {
            if cancel.is_cancelled() {
                return Err(HostError("CANCELLED"));
            }
            if process.owner != owner {
                return Err(HostError("native_process_owner_unknown"));
            }
            let observation = match process.state {
                NativeProcessState::Ended => None,
                NativeProcessState::NotStarted => Some(NativeProcessStop::OwnerDeadNotStarted),
                // The owner may have died between fork and identity publication.
                // Absence of an identity is never evidence of an absent child.
                NativeProcessState::Starting => continue,
                NativeProcessState::Running => {
                    let child = process
                        .child
                        .as_ref()
                        .ok_or(HostError("native_process_invalid"))?;
                    if !Box::pin(self.wait_owned(
                        recorder::stop_recorded_group(&owner, child, cancel),
                        cancel,
                        cancel,
                    ))
                    .await?
                    {
                        continue;
                    }
                    Some(NativeProcessStop::OwnerDeadGroupAbsent)
                }
            };
            if let Some(observation) = observation {
                let snapshot = self
                    .journal
                    .read(&crate::coordination::NativeCoordinationReducer, None)?;
                let mut value = snapshot.state["works"][work].clone();
                let mut changed = 0;
                let mut update = |row: &mut Value| -> Result<(), HostError> {
                    if row["toolCallId"] != process.tool_call_id
                        || row["dispatchId"] != process.dispatch_id
                    {
                        return Ok(());
                    }
                    let actual: peer_protocol::NativeOwnedProcess =
                        serde_json::from_value(row["nativeProcess"].clone())
                            .map_err(|_| HostError("native_process_invalid"))?;
                    if actual != process {
                        return Err(HostError("native_process_changed"));
                    }
                    row["nativeProcess"]["state"] = json!("ended");
                    row["nativeProcess"]["stopObservation"] = json!(observation);
                    changed += 1;
                    Ok(())
                };
                for attempt in value
                    .get_mut("budget")
                    .and_then(|b| b.get_mut("attempts"))
                    .and_then(Value::as_object_mut)
                    .into_iter()
                    .flat_map(|m| m.values_mut())
                {
                    for row in attempt
                        .get_mut("pendingTools")
                        .and_then(Value::as_array_mut)
                        .into_iter()
                        .flatten()
                    {
                        update(row)?;
                    }
                }
                for row in value
                    .get_mut("budget")
                    .and_then(|b| b.get_mut("uncertainDispatches"))
                    .and_then(Value::as_array_mut)
                    .into_iter()
                    .flatten()
                {
                    update(row)?;
                }
                if changed != 1 {
                    return Err(HostError("native_process_changed"));
                }
                self.journal.append(
                    &snapshot,
                    &json!({"kind":"work","work":value}),
                    milliseconds(&episode_time())?,
                    &crate::coordination::NativeCoordinationReducer,
                    None,
                )?;
            }
            if let Some(mut handle) = self
                .resources
                .unsettled_handles(&current.resource)?
                .into_iter()
                .find(|h| {
                    h["handleId"] == process.handle_id && h["toolCallId"] == process.tool_call_id
                })
            {
                handle["state"] = json!("ended");
                handle["nativeProcessStop"] = json!(observation.or(process.stop_observation));
                self.resources
                    .mark_handle(&current.resource, &handle, &episode_time())?;
            }
        }
        Ok(())
    }
    pub(super) async fn command_starting(
        &mut self,
        command: &CommandOwner<'_>,
        owned: &crate::CancellationToken,
        external: &crate::CancellationToken,
    ) -> Result<(), HostError> {
        let previous = command
            .budget
            .read_process(self, command.call, command.dispatch)?;
        if previous.owner != command.owner {
            return Err(HostError("native_process_owner_unknown"));
        }
        if previous.state == NativeProcessState::Running {
            let child = previous
                .child
                .as_ref()
                .ok_or(HostError("native_process_invalid"))?;
            let proof = Box::pin(self.wait_owned(recorder::prove(child), owned, external)).await?;
            if !proof.allows_settlement() || !crate::providers::group_absent(child.pid) {
                return Err(HostError("native_process_still_running"));
            }
        } else if previous.state != NativeProcessState::NotStarted {
            return Err(HostError("native_process_transition_invalid"));
        }
        if previous.generation >= 64 {
            return Err(HostError("native_process_limit"));
        }
        if owned.is_cancelled() || external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        command
            .budget
            .change_process(self, &previous, &episode_time(), true, |p| {
                p["generation"] = json!(previous.generation + 1);
                p["state"] = json!("starting");
                p.as_object_mut().unwrap().remove("child");
                p.as_object_mut().unwrap().remove("stopObservation");
            })
    }
    pub(super) fn command_started(
        &mut self,
        command: &CommandOwner<'_>,
        child: Recorder,
    ) -> Result<(), HostError> {
        let previous = command
            .budget
            .read_process(self, command.call, command.dispatch)?;
        let lease = self.journal.lease().record();
        let pid = rustix::process::Pid::from_raw(child.pid as i32)
            .ok_or(HostError("native_process_invalid"))?;
        if previous.state != NativeProcessState::Starting || previous.owner != command.owner {
            return Err(HostError("native_process_transition_invalid"));
        }
        if !child.complete()
            || child.host_id != lease.host_id
            || child.acquired_at != lease.acquired_at
            || child.boot_id != previous.owner.boot_id
        {
            return Err(HostError("native_process_recorder_invalid"));
        }
        if !match rustix::process::getpgid(Some(pid)) {
            Ok(group) => group == pid,
            // Darwin returns ESRCH for an exited, unreaped child while ps
            // still observes its start identity. Preserve this owned launch
            // as running/unsettled; only the actual Child wait plus group
            // absence may later prove completion. This is no death proof.
            Err(rustix::io::Errno::SRCH) => true,
            Err(_) => false,
        } {
            return Err(HostError("native_process_group_unproven"));
        }
        command
            .budget
            .change_process(self, &previous, &episode_time(), false, |p| {
                p["child"] = json!(child);
                p["state"] = json!("running");
            })
    }
    pub(super) fn command_completed(
        &mut self,
        command: &CommandOwner<'_>,
    ) -> Result<(), HostError> {
        let previous = command
            .budget
            .read_process(self, command.call, command.dispatch)?;
        if previous.state == NativeProcessState::Ended {
            return Ok(());
        }
        command
            .budget
            .change_process(self, &previous, &episode_time(), false, |p| {
                p["state"] = json!("ended");
                p["stopObservation"] = json!(NativeProcessStop::OwnedCompletion);
            })
    }
}
