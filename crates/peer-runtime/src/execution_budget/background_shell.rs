//! A published startup stays pending until its own registered worker retires.
use super::*;
use peer_protocol::{NativeOwnedProcess, NativeProcessState, NativeProcessStop};
use std::collections::BTreeMap;

const UNPROVEN: HostError = HostError("shell_background_start_unproven");

impl EpisodeBudget {
    pub(super) fn check_pending(
        &self,
        budget: &Value,
        live: &BTreeMap<String, Value>,
    ) -> Result<(), HostError> {
        let relevant = |row: &Value| row["planId"].as_str().is_none_or(|p| p == self.plan);
        let unknown = budget["uncertainDispatches"]
            .as_array()
            .is_some_and(|rows| rows.iter().any(relevant));
        let blocked = budget["attempts"]
            .as_object()
            .into_iter()
            .flatten()
            .filter(|(_, attempt)| relevant(attempt))
            .any(|(id, attempt)| {
                attempt["pendingTools"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|row| {
                        id != &self.attempt
                            || attempt["nativeRecorder"] != self.native_recorder
                            || row["nativeProcess"]["state"] != "running"
                            || row["dispatchId"].as_str().and_then(|d| live.get(d))
                                != row["nativeBackgroundShell"].get("startup")
                            || row["nativeBackgroundShell"].get("startup").is_none()
                    })
            });
        if unknown || blocked {
            return Err(HostError("execution_outcome_unknown"));
        }
        Ok(())
    }

    pub(crate) fn confirm_background_start(
        &self,
        host: &mut NativeSessionHost,
        process: &NativeOwnedProcess,
        result: &Value,
        grant: &Value,
        at: &str,
    ) -> Result<Value, HostError> {
        let call = &process.tool_call_id;
        let dispatch = &process.dispatch_id;
        let handle = &process.handle_id;
        let refs = peer_protocol::collect_tool_result_evidence_refs(Some(call), result)
            .map_err(|_| UNPROVEN)?;
        if process.state != NativeProcessState::Running
            || result["toolCallId"] != call.as_str()
            || result["capabilityId"] != "local.shell.exec"
            || result["status"] != "success"
            || result["output"]["status"] != "running"
            || result["output"]["taskId"] != handle.as_str()
            || result["output"]["toolCallId"] != call.as_str()
            || result["output"]["artifactRef"] != format!("local-shell-artifact://{handle}")
            || result["evidence"]["nativeProcess"] != json!(process)
            || result["evidence"]["permissionGrantId"] != grant["grantId"]
        {
            return Err(UNPROVEN);
        }
        let startup = json!({"evidenceId":result["evidence"]["evidenceId"],"evidenceRefs":refs});
        self.change(host, at, false, |budget| {
            let row = super::process::row(budget, &self.attempt, call, dispatch)?;
            let background = &row["nativeBackgroundShell"];
            if background["grant"] != *grant
                || background.get("startup").is_some()
                || row["nativeProcess"] != json!(process)
            {
                return Err(UNPROVEN);
            }
            row["nativeBackgroundShell"]["startup"] = startup.clone();
            Ok(())
        })?;
        Ok(startup)
    }

    pub(crate) fn settle_background(
        &self,
        host: &mut NativeSessionHost,
        process: &NativeOwnedProcess,
        startup: &Value,
        at: &str,
    ) -> Result<(), HostError> {
        if process.state != NativeProcessState::Ended
            || process.stop_observation != Some(NativeProcessStop::OwnedCompletion)
        {
            return Err(UNPROVEN);
        }
        let dispatch = &process.dispatch_id;
        let call = &process.tool_call_id;
        self.change(host, at, false, |budget| {
            let attempt = &mut budget["attempts"][&self.attempt];
            let receipt = json!({"dispatchId":dispatch,"toolCallId":call,"outcome":"resulted",
                "evidenceRefs":startup["evidenceRefs"],"settledAt":at});
            // A failed acknowledgement of a durable settlement is retryable.
            if attempt["settledTools"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|old| {
                    old["dispatchId"] == dispatch.as_str()
                        && old["toolCallId"] == call.as_str()
                        && old["outcome"] == "resulted"
                        && old["evidenceRefs"] == startup["evidenceRefs"]
                })
            {
                return Ok(());
            }
            let row = super::process::row(budget, &self.attempt, call, dispatch)?;
            if row["nativeProcess"] != json!(process)
                || row["nativeBackgroundShell"]["startup"] != *startup
            {
                return Err(UNPROVEN);
            }
            let attempt = &mut budget["attempts"][&self.attempt];
            attempt["pendingTools"]
                .as_array_mut()
                .ok_or(UNPROVEN)?
                .retain(|row| row["dispatchId"] != dispatch.as_str());
            if !attempt["settledTools"].is_array() {
                attempt["settledTools"] = json!([]);
            }
            attempt["settledTools"]
                .as_array_mut()
                .ok_or(UNPROVEN)?
                .push(receipt);
            Ok(())
        })
    }
}
