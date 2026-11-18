//! Child ownership is attached to the same pending dispatch, including readonly
//! tasks which deliberately have no writable-directory resource claim.
use super::*;
use peer_protocol::{
    NativeOwnedProcess, NativeProcessKind, NativeProcessRecorder, NativeProcessState,
};
pub(super) fn row<'a>(
    budget: &'a mut Value,
    attempt: &str,
    call: &str,
    dispatch: &str,
) -> Result<&'a mut Value, HostError> {
    let rows = budget["attempts"][attempt]["pendingTools"]
        .as_array_mut()
        .ok_or(HostError("native_process_owner_unknown"))?;
    if rows
        .iter()
        .filter(|r| r["toolCallId"] == call && r["dispatchId"] == dispatch)
        .count()
        != 1
    {
        return Err(HostError("native_process_owner_unknown"));
    }
    rows.iter_mut()
        .find(|r| r["toolCallId"] == call && r["dispatchId"] == dispatch)
        .ok_or(HostError("native_process_owner_unknown"))
}
impl EpisodeBudget {
    pub(crate) fn prepare_process(
        &self,
        host: &mut NativeSessionHost,
        call: &str,
        dispatch: &str,
        handle: &str,
        at: &str,
    ) -> Result<NativeOwnedProcess, HostError> {
        let owner: NativeProcessRecorder =
            serde_json::from_value(self.native_recorder["recorder"].clone())
                .map_err(|_| HostError("native_process_owner_unknown"))?;
        let lease = host.journal.lease().record();
        if !owner.complete()
            || owner.host_id != lease.host_id
            || owner.acquired_at != lease.acquired_at
        {
            return Err(HostError("native_process_owner_unknown"));
        }
        let process = NativeOwnedProcess {
            schema_version: 1,
            kind: NativeProcessKind::Command,
            handle_id: handle.into(),
            tool_call_id: call.into(),
            dispatch_id: dispatch.into(),
            execution: self.native_recorder["execution"].clone(),
            generation: 0,
            state: NativeProcessState::NotStarted,
            owner,
            child: None,
            stop_observation: None,
        };
        if !process.valid() {
            return Err(HostError("native_process_invalid"));
        }
        self.change(host, at, true, |b| {
            let row = row(b, &self.attempt, call, dispatch)?;
            if row.get("nativeProcess").is_some() {
                return Err(HostError("native_process_owner_unknown"));
            }
            row["nativeProcess"] = json!(process);
            Ok(())
        })?;
        Ok(process)
    }
    pub(crate) fn read_process(
        &self,
        host: &NativeSessionHost,
        call: &str,
        dispatch: &str,
    ) -> Result<NativeOwnedProcess, HostError> {
        let snapshot = host.journal.read(&NativeCoordinationReducer, None)?;
        let work = &snapshot.state["works"][&self.work];
        peer_protocol::native_processes_in_work(work)
            .map_err(HostError)?
            .into_iter()
            .find(|p| {
                p.tool_call_id == call
                    && p.dispatch_id == dispatch
                    && p.execution == self.native_recorder["execution"]
            })
            .ok_or(HostError("native_process_owner_unknown"))
    }
    pub(crate) fn change_process(
        &self,
        host: &mut NativeSessionHost,
        expected: &NativeOwnedProcess,
        at: &str,
        active: bool,
        update: impl FnOnce(&mut Value),
    ) -> Result<(), HostError> {
        self.change(host, at, active, |b| {
            let row = row(
                b,
                &self.attempt,
                &expected.tool_call_id,
                &expected.dispatch_id,
            )?;
            let current: NativeOwnedProcess = serde_json::from_value(row["nativeProcess"].clone())
                .map_err(|_| HostError("native_process_invalid"))?;
            if current != *expected {
                return Err(HostError("native_process_changed"));
            }
            // Patch lifecycle fields in place: opaque future owner/source facts
            // survive rather than being lost through a typed reserialization.
            update(&mut row["nativeProcess"]);
            Ok(())
        })
    }
}
