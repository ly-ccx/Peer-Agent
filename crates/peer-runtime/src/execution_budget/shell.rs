//! Canonical interpreter and current command facts for an owned Work attempt.
use super::*;
use peer_protocol::{
    NativeProcessRecorder, NativeProcessState, NativeShellCommandBinding, NativeShellSession,
    native_work_shell_sessions,
};

const UNKNOWN: HostError = HostError("native_work_shell_invalid");

impl EpisodeBudget {
    pub(crate) fn shell_owner(&self) -> Result<NativeProcessRecorder, HostError> {
        let owner: NativeProcessRecorder =
            serde_json::from_value(self.native_recorder["recorder"].clone())
                .map_err(|_| UNKNOWN)?;
        owner.complete().then_some(owner).ok_or(UNKNOWN)
    }

    pub(crate) fn read_shell(
        &self,
        host: &NativeSessionHost,
    ) -> Result<Option<NativeShellSession>, HostError> {
        let snapshot = host.journal.read(&NativeCoordinationReducer, None)?;
        Ok(
            native_work_shell_sessions(&snapshot.state["works"][&self.work])
                .map_err(HostError)?
                .into_iter()
                .find(|record| record.attempt_id == self.attempt)
                .map(|record| record.session),
        )
    }

    pub(crate) fn save_shell(
        &self,
        host: &mut NativeSessionHost,
        before: Option<&NativeShellSession>,
        after: &NativeShellSession,
        at: &str,
        active: bool,
    ) -> Result<(), HostError> {
        self.change(host, at, active, |budget| {
            let attempt = &mut budget["attempts"][&self.attempt];
            Self::check_shell_attempt(attempt, &self.native_recorder)?;
            let expected = before.map(|shell| json!(shell));
            if expected.as_ref() != attempt.get("nativeShellSession") {
                return Err(UNKNOWN);
            }
            attempt["nativeShellSession"] = json!(after);
            Ok(())
        })
    }

    fn check_shell_attempt(attempt: &Value, recorder: &Value) -> Result<(), HostError> {
        if attempt["role"] != "work_session" || &attempt["nativeRecorder"] != recorder {
            return Err(UNKNOWN);
        }
        Ok(())
    }

    pub(crate) fn bind_shell(
        &self,
        host: &mut NativeSessionHost,
        handle: &str,
        call: &str,
        dispatch: &str,
        grant: &Value,
        at: &str,
    ) -> Result<(), HostError> {
        self.change(host, at, true, |budget| {
            let attempt = &mut budget["attempts"][&self.attempt];
            Self::check_shell_attempt(attempt, &self.native_recorder)?;
            let mut shell: NativeShellSession =
                serde_json::from_value(attempt["nativeShellSession"].clone())
                    .map_err(|_| UNKNOWN)?;
            if shell.process.handle_id != handle
                || shell.process.state != NativeProcessState::Running
                || shell.command.is_some()
            {
                return Err(UNKNOWN);
            }
            let row = super::process::row(budget, &self.attempt, call, dispatch)?;
            if row.get("nativeShellGrant").is_some() {
                return Err(UNKNOWN);
            }
            row["nativeShellGrant"] = grant.clone();
            shell.command = Some(NativeShellCommandBinding {
                tool_call_id: call.into(),
                dispatch_id: dispatch.into(),
                generation: shell.process.generation,
            });
            budget["attempts"][&self.attempt]["nativeShellSession"] = json!(shell);
            Ok(())
        })
    }

    pub(crate) fn shell_evidence(
        &self,
        host: &NativeSessionHost,
        call: &str,
        dispatch: &str,
    ) -> Result<Option<Value>, HostError> {
        let Some(shell) = self.read_shell(host)? else {
            return Ok(None);
        };
        let Some(binding) = &shell.command else {
            return Ok(None);
        };
        if binding.tool_call_id != call || binding.dispatch_id != dispatch {
            return Err(UNKNOWN);
        }
        Ok(Some(binding_evidence(&shell, binding)))
    }

    pub(super) fn settle_shell_command(
        attempt: &mut Value,
        call: &str,
        dispatch: &str,
        result: &Value,
    ) -> Result<(), HostError> {
        let Some(raw) = attempt.get("nativeShellSession") else {
            return Ok(());
        };
        let mut shell: NativeShellSession =
            serde_json::from_value(raw.clone()).map_err(|_| UNKNOWN)?;
        let Some(binding) = &shell.command else {
            return Ok(());
        };
        let row = attempt["pendingTools"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["toolCallId"] == call && row["dispatchId"] == dispatch)
            .ok_or(UNKNOWN)?;
        if binding.tool_call_id != call || binding.dispatch_id != dispatch {
            return Ok(());
        }
        if result["evidence"]["shellSession"] != binding_evidence(&shell, binding)
            || result["evidence"]["permissionGrantId"] != row["nativeShellGrant"]["grantId"]
        {
            return Err(UNKNOWN);
        }
        shell.command = None;
        attempt["nativeShellSession"] = json!(shell);
        Ok(())
    }
}

fn binding_evidence(shell: &NativeShellSession, binding: &NativeShellCommandBinding) -> Value {
    json!({
        "handleId": shell.process.handle_id,
        "dispatchId": binding.dispatch_id,
        "generation": binding.generation,
    })
}
