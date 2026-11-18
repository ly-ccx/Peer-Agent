//! Work claim and canonical attempt own the same native Shell interpreter.
use super::*;
use crate::{
    CancellationToken,
    effect_admission::ConnectionDriver,
    execution_budget::EpisodeBudget,
    recorder::{self, Recorder},
};
use peer_protocol::{
    NativeOwnedProcess, NativeProcessKind, NativeProcessState as State, NativeProcessStop,
    NativeShellSession, native_work_shell_sessions,
};

const INVALID: HostError = HostError("native_work_shell_invalid");

pub(super) struct ShellDispatch<'a> {
    pub budget: &'a EpisodeBudget,
    pub call: &'a str,
    pub dispatch: &'a str,
}

pub(super) struct WorkShellWatch {
    handle: String,
    origin: super::authority::ShellLifetimeAuthority,
    _stop: tokio_util::sync::DropGuard,
}

impl WorkShellWatch {
    pub(super) fn check(&self, host: &NativeSessionHost) -> Result<(), HostError> {
        self.origin.check(host, &episode_time())
    }
}

impl NativeSessionHost {
    pub(super) fn work_shell_open(
        &mut self,
        authority: &super::effect_wait::AuthorizationWait<'_>,
        handle: String,
        cancel: CancellationToken,
        driver: ConnectionDriver,
    ) -> Result<(), HostError> {
        let dispatch = authority.shell.ok_or(INVALID)?;
        let budget = dispatch.budget;
        let resource = authority.resource;
        let identity = authority.grant.identity();
        let owner = budget.shell_owner()?;
        let lease = self.journal.lease().record();
        if resource.read_only
            || cancel.is_cancelled()
            || self.shell_watch.is_some()
            || identity.capability_id != "local.shell.exec"
            || identity.tool_call_id != dispatch.call
            || budget.native_recorder["execution"] != json!(resource.execution)
            || owner.host_id != lease.host_id
            || owner.acquired_at != lease.acquired_at
            || owner.pid != std::process::id()
        {
            return Err(INVALID);
        }
        let mut shell = NativeShellSession {
            schema_version: 1,
            process: NativeOwnedProcess {
                schema_version: 1,
                kind: NativeProcessKind::Command,
                handle_id: handle.clone(),
                tool_call_id: dispatch.call.into(),
                dispatch_id: dispatch.dispatch.into(),
                execution: json!(resource.execution),
                generation: 0,
                state: State::NotStarted,
                owner,
                child: None,
                stop_observation: None,
            },
            command: None,
        };
        let at = episode_time();
        budget.save_shell(self, None, &shell, &at, true)?;
        self.resources.mark_handle(
            resource,
            &json!({"handleId":handle,"toolCallId":dispatch.call,"state":"active"}),
            &at,
        )?;
        if self
            .live
            .track_handle(
                &resource.execution,
                &handle,
                dispatch.call,
                cancel.clone(),
                driver,
            )
            .is_err()
        {
            // The request has not yet authorised spawn.
            self.end_work_shell(budget, &shell, NativeProcessStop::OwnedCompletion)?;
            self.resources.mark_handle(
                resource,
                &json!({"handleId":handle,"toolCallId":dispatch.call,"state":"ended"}),
                &episode_time(),
            )?;
            return Err(HostError("execution_resource_owner_unknown"));
        }
        self.shell_watch = Some(WorkShellWatch {
            handle,
            origin: authority.grant.shell_lifetime_authority(),
            _stop: cancel.drop_guard(),
        });
        let not_started = shell.clone();
        shell.process.state = State::Starting;
        shell.process.generation = 1;
        budget.save_shell(self, Some(&not_started), &shell, &episode_time(), true)
    }

    pub(super) fn work_shell_spawned(
        &mut self,
        dispatch: &ShellDispatch<'_>,
        child: Recorder,
    ) -> Result<(), HostError> {
        let previous = dispatch.budget.read_shell(self)?.ok_or(INVALID)?;
        let mut shell = previous.clone();
        let process = &mut shell.process;
        if process.tool_call_id != dispatch.call
            || process.dispatch_id != dispatch.dispatch
            || process.state != State::Starting
            || !child.complete()
            || child.host_id != process.owner.host_id
            || child.acquired_at != process.owner.acquired_at
            || child.boot_id != process.owner.boot_id
        {
            return Err(INVALID);
        }
        let pid = rustix::process::Pid::from_raw(child.pid as i32).ok_or(INVALID)?;
        if !matches!(rustix::process::getpgid(Some(pid)), Ok(group) if group==pid)
            && rustix::process::getpgid(Some(pid)) != Err(rustix::io::Errno::SRCH)
        {
            return Err(HostError("native_process_group_unproven"));
        }
        process.child = Some(child);
        process.state = State::Running;
        dispatch
            .budget
            .save_shell(self, Some(&previous), &shell, &episode_time(), false)
    }

    pub(super) fn work_shell_bind(
        &mut self,
        authority: &super::effect_wait::AuthorizationWait<'_>,
        handle: &str,
    ) -> Result<(), HostError> {
        let call = authority.shell.ok_or(INVALID)?;
        call.budget.bind_shell(
            self,
            handle,
            call.call,
            call.dispatch,
            authority.grant.facts(),
            &episode_time(),
        )
    }

    fn current_work_shell(
        current: &Current,
    ) -> Result<Option<(EpisodeBudget, NativeShellSession)>, HostError> {
        let Some(work) = current.goal.facts["delegationOrigin"]["workId"].as_str() else {
            return Ok(None);
        };
        let value = &current.journal.state["works"][work];
        let execution = json!(current.resource.execution);
        Ok(native_work_shell_sessions(value)
            .map_err(HostError)?
            .into_iter()
            .find(|record| record.session.process.execution == execution)
            .map(|record| {
                let budget = EpisodeBudget {
                    work: work.into(),
                    attempt: record.attempt_id.into(),
                    plan: current.resource.execution.plan_id.clone(),
                    session: current.resource.execution.session_id.clone(),
                    native_recorder:
                        value["budget"]["attempts"][record.attempt_id]["nativeRecorder"].clone(),
                };
                (budget, record.session)
            }))
    }

    fn end_work_shell(
        &mut self,
        budget: &EpisodeBudget,
        before: &NativeShellSession,
        observation: NativeProcessStop,
    ) -> Result<(), HostError> {
        if before.process.state == State::Ended {
            return Ok(());
        }
        let mut shell = before.clone();
        shell.process.state = State::Ended;
        shell.process.stop_observation = Some(observation);
        budget.save_shell(self, Some(before), &shell, &episode_time(), false)
    }

    pub(super) fn mark_owned_work_shell_ended(
        &mut self,
        current: &Current,
        handle: &str,
        call: &str,
    ) -> Result<(), HostError> {
        if let Some((budget, shell)) = Self::current_work_shell(current)?
            && shell.process.handle_id == handle
        {
            if shell.process.tool_call_id != call {
                return Err(INVALID);
            }
            self.end_work_shell(&budget, &shell, NativeProcessStop::OwnedCompletion)?;
            if self
                .shell_watch
                .as_ref()
                .is_some_and(|watch| watch.handle == handle)
            {
                self.shell_watch = None;
            }
        }
        Ok(())
    }

    pub(super) fn work_shell_stopped(&self, current: &Current) -> Result<bool, HostError> {
        Ok(Self::current_work_shell(current)?
            .is_none_or(|(_, shell)| shell.process.state == State::Ended))
    }

    pub(super) async fn recover_work_shell(
        &mut self,
        current: &Current,
        cancel: &CancellationToken,
    ) -> Result<(), HostError> {
        if self.live.ownership(&current.resource.execution).ok()
            == Some(crate::live_execution::Ownership::Live)
        {
            return Ok(());
        }
        let Some((budget, shell)) = Self::current_work_shell(current)? else {
            return Ok(());
        };
        let Some(owner) = self.dead_native_owner(current).await else {
            return Ok(());
        };
        let process = &shell.process;
        if process.owner != owner {
            return Err(INVALID);
        }
        let observation = match process.state {
            State::Ended => process.stop_observation.ok_or(INVALID)?,
            State::NotStarted => NativeProcessStop::OwnerDeadNotStarted,
            State::Starting => return Ok(()),
            State::Running => {
                let child = process.child.as_ref().ok_or(INVALID)?;
                if !self
                    .wait_owned(
                        recorder::stop_recorded_group(&owner, child, cancel),
                        cancel,
                        cancel,
                    )
                    .await?
                {
                    return Ok(());
                }
                NativeProcessStop::OwnerDeadGroupAbsent
            }
        };
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        self.end_work_shell(&budget, &shell, observation)?;
        if self
            .resources
            .unsettled_handles(&current.resource)?
            .iter()
            .any(|handle| {
                handle["handleId"] == process.handle_id
                    && handle["toolCallId"] == process.tool_call_id
            })
        {
            self.resources.mark_handle(
                &current.resource,
                &json!({"handleId":process.handle_id,"toolCallId":process.tool_call_id,"state":"ended","nativeProcessStop":observation}),
                &episode_time(),
            )?;
        }
        Ok(())
    }
}
