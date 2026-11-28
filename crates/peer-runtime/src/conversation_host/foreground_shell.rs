//! Durable command binding and owned interpreter retirement for ordinary runs.
use super::*;
use crate::{effect_admission::ConnectionDriver, recorder::Recorder};
use peer_protocol::{
    NativeOwnedProcess, NativeProcessKind, NativeProcessState as Process, NativeProcessStop,
    NativeShellCommandBinding, NativeShellSession,
};

pub(super) struct ForegroundAuthority {
    access_revision: u64,
    credential_revision: String,
    _owner: tokio_util::sync::DropGuard,
}

impl Host<'_> {
    fn foreground_shell(&self) -> Result<Option<NativeShellSession>, HostError> {
        let run = self
            .store
            .read_conversation_execution(&self.identity.conversation_id)?
            .ok_or(HostError("conversation_execution_changed"))?;
        Ok(run.handles.iter().find_map(NativeShellSession::from_handle))
    }

    pub(super) fn foreground_shell_open(
        &mut self,
        grant: &ToolGrant,
        dispatch: &str,
        handle: String,
        cancel: CancellationToken,
        driver: ConnectionDriver,
    ) -> Result<(), HostError> {
        if grant.capability != "local.shell.exec" || cancel.is_cancelled() {
            return Err(HostError("native_process_owner_unknown"));
        }
        let mut process = NativeOwnedProcess {
            schema_version: 1,
            kind: NativeProcessKind::Command,
            handle_id: handle,
            tool_call_id: grant.call.clone(),
            dispatch_id: dispatch.into(),
            execution: json!(self.identity),
            generation: 0,
            state: Process::NotStarted,
            owner: self.run.owner().clone(),
            child: None,
            stop_observation: None,
        };
        let receipt =
            self.store
                .register_conversation_shell_session(&mut self.run, &process, &now())?;
        self.publication(receipt)?;
        if self
            .live
            .track_handle(
                &self.identity,
                &process.handle_id,
                &grant.call,
                cancel.clone(),
                driver,
            )
            .is_err()
        {
            // The Provider has not received a spawn authorization.
            self.record_foreground_shell_end(&process.handle_id, true)?;
            let receipt =
                self.store
                    .end_conversation_handle(&mut self.run, &process.handle_id, &now())?;
            self.publication(receipt)?;
            return Err(HostError("native_execution_owner_unavailable"));
        }
        self.foreground_authority = Some(ForegroundAuthority {
            access_revision: grant.revision,
            credential_revision: grant.credential_revision.clone(),
            _owner: cancel.drop_guard(),
        });
        process.state = Process::Starting;
        process.generation = 1;
        let receipt =
            self.store
                .record_conversation_shell_process(&mut self.run, &process, &now())?;
        self.publication(receipt)?;
        #[cfg(feature = "test-fixtures")]
        super::fixture_fault(&self.home, "foreground_before_spawn");
        Ok(())
    }

    pub(super) fn validate_foreground_authority(&self) -> Result<(), HostError> {
        if let Some(authority) = &self.foreground_authority
            && (self.access.snapshot()?.1 != authority.access_revision
                || !self.projection.has_capability("local.shell.exec")
                || self
                    .credentials
                    .normalized_conversation(&self.identity)
                    .map_err(HostError)?
                    .as_deref()
                    != Some(&authority.credential_revision))
        {
            return Err(HostError("permission_policy_changed"));
        }
        Ok(())
    }

    pub(super) fn foreground_shell_spawned(
        &mut self,
        call: &str,
        dispatch: &str,
        child: Recorder,
    ) -> Result<(), HostError> {
        let mut process = self
            .foreground_shell()?
            .filter(|session| {
                session.process.tool_call_id == call && session.process.dispatch_id == dispatch
            })
            .ok_or(HostError("native_process_owner_unknown"))?
            .process;
        Self::observe_spawned_process(&mut process, child)?;
        let receipt =
            self.store
                .record_conversation_shell_process(&mut self.run, &process, &now())?;
        self.factual_publication(receipt)
    }

    pub(super) fn foreground_shell_bind(
        &mut self,
        grant: &ToolGrant,
        dispatch: &str,
        handle: &str,
    ) -> Result<(), HostError> {
        let session = self
            .foreground_shell()?
            .filter(|session| session.process.handle_id == handle)
            .ok_or(HostError("native_process_owner_unknown"))?;
        let command = NativeShellCommandBinding {
            tool_call_id: grant.call.clone(),
            dispatch_id: dispatch.into(),
            generation: session.process.generation,
        };
        let receipt =
            self.store
                .bind_conversation_shell_command(&mut self.run, handle, &command, &now())?;
        self.publication(receipt)
    }

    pub(super) fn foreground_shell_evidence(
        &self,
        call: &str,
        dispatch: &str,
    ) -> Result<Option<Value>, HostError> {
        let Some(session) = self.foreground_shell()? else {
            return Ok(None);
        };
        let Some(binding) = session
            .command
            .filter(|binding| binding.tool_call_id == call)
        else {
            return Ok(None);
        };
        if binding.dispatch_id != dispatch {
            return Err(HostError("conversation_execution_changed"));
        }
        Ok(Some(json!({
            "handleId": session.process.handle_id,
            "dispatchId": binding.dispatch_id,
            "generation": binding.generation,
        })))
    }

    pub(super) fn record_foreground_shell_end(
        &mut self,
        handle: &str,
        advance: bool,
    ) -> Result<(), HostError> {
        let Some(session) = self
            .foreground_shell()?
            .filter(|session| session.process.handle_id == handle)
        else {
            return Ok(());
        };
        let mut process = session.process;
        if process.state != Process::Ended {
            process.state = Process::Ended;
            process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
            let receipt =
                self.store
                    .record_conversation_shell_process(&mut self.run, &process, &now())?;
            // Closing a run has already stopped Context admission. The
            // cleanup receipt advances the Store token only in that phase.
            if advance {
                self.factual_publication(receipt)?;
            }
        }
        Ok(())
    }
}
