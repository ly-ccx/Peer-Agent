//! Reap only process groups tied to the exact dead Work owner. Observing a
//! process stop never establishes what that Hook or Provider did.
use super::*;
use crate::{CancellationToken, recorder};
use peer_protocol::{NativeOwnedProcess, NativeProcessState, NativeProcessStop, NativeWorkHooks};

fn pending_rows(budget: &Value) -> impl Iterator<Item = &Value> {
    budget["attempts"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.values())
        .flat_map(|a| a["pendingTools"].as_array().into_iter().flatten())
        .chain(
            budget["uncertainDispatches"]
                .as_array()
                .into_iter()
                .flatten(),
        )
}

fn processes(current: &Current) -> Result<Vec<NativeOwnedProcess>, HostError> {
    let Some(work) = current.goal.facts["delegationOrigin"]["workId"].as_str() else {
        return Ok(vec![]);
    };
    let budget = &current.journal.state["works"][work]["budget"];
    let identity = json!(current.resource.execution);
    let mut result = vec![];
    for row in pending_rows(budget) {
        if let Some(hooks) = NativeWorkHooks::read(row).map_err(HostError)? {
            result.extend(
                hooks
                    .handles
                    .into_iter()
                    .map(|h| h.process)
                    .filter(|p| p.execution == identity),
            );
        }
    }
    Ok(result)
}

impl NativeSessionHost {
    pub(super) fn work_hooks_stopped(&self, current: &Current) -> Result<bool, HostError> {
        Ok(processes(current)?
            .iter()
            .all(|p| p.state == NativeProcessState::Ended))
    }

    pub(super) async fn recover_work_hook_processes(
        &mut self,
        current: &Current,
        cancel: &CancellationToken,
    ) -> Result<(), HostError> {
        if self.live.ownership(&current.resource.execution).ok()
            == Some(crate::live_execution::Ownership::Live)
        {
            return Ok(());
        }
        let processes = processes(current)?;
        if processes.is_empty() {
            return Ok(());
        }
        let Some(owner) = self.dead_native_owner(current).await else {
            return Ok(());
        };
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .ok_or(HostError("native_process_owner_unknown"))?;
        for process in processes {
            if cancel.is_cancelled() {
                return Err(HostError("CANCELLED"));
            }
            if process.owner != owner {
                return Err(HostError("native_process_owner_unknown"));
            }
            let observation = match process.state {
                NativeProcessState::Ended | NativeProcessState::Starting => continue,
                NativeProcessState::NotStarted => NativeProcessStop::OwnerDeadNotStarted,
                NativeProcessState::Running => {
                    let child = process
                        .child
                        .as_ref()
                        .ok_or(HostError("native_process_invalid"))?;
                    let gone = Box::pin(self.wait_owned(
                        recorder::stop_recorded_group(&owner, child, cancel),
                        cancel,
                        cancel,
                    ))
                    .await?;
                    if !gone {
                        continue;
                    }
                    NativeProcessStop::OwnerDeadGroupAbsent
                }
            };
            self.record_recovered_hook(work, &process, observation)?;
        }
        Ok(())
    }

    fn record_recovered_hook(
        &mut self,
        work: &str,
        process: &NativeOwnedProcess,
        observation: NativeProcessStop,
    ) -> Result<(), HostError> {
        let snapshot = self.journal.read(&NativeCoordinationReducer, None)?;
        let mut value = snapshot.state["works"][work].clone();
        let budget = &mut value["budget"];
        let mut changed = 0;
        let mut update = |row: &mut Value| -> Result<(), HostError> {
            if row["toolCallId"] != process.tool_call_id || row["dispatchId"] != process.dispatch_id
            {
                return Ok(());
            }
            for hook in row["nativeHooks"]["handles"]
                .as_array_mut()
                .into_iter()
                .flatten()
            {
                if hook["process"]["handleId"] != process.handle_id {
                    continue;
                }
                let actual: NativeOwnedProcess = serde_json::from_value(hook["process"].clone())
                    .map_err(|_| HostError("native_process_invalid"))?;
                if &actual != process || hook.get("observation").is_some() {
                    return Err(HostError("native_process_changed"));
                }
                hook["process"]["state"] = json!(NativeProcessState::Ended);
                hook["process"]["stopObservation"] = json!(observation);
                changed += 1;
            }
            Ok(())
        };
        for attempt in budget
            .get_mut("attempts")
            .and_then(Value::as_object_mut)
            .into_iter()
            .flat_map(|a| a.values_mut())
        {
            for row in attempt["pendingTools"].as_array_mut().into_iter().flatten() {
                update(row)?;
            }
        }
        for row in budget
            .get_mut("uncertainDispatches")
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
            &NativeCoordinationReducer,
            None,
        )?;
        Ok(())
    }
}

impl NativeSessionHost {
    // Called only after the original owner and every recorded child are proven
    // stopped. Unknown Hooks and calls without their original anchor stay open.
    pub(super) fn recover_observed_work_pre(
        &mut self,
        current: &Current,
        cancel: &CancellationToken,
    ) -> Result<(), HostError> {
        use peer_store::{ConversationStore, EvidenceIndexStore, HostToolEvidence};
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .ok_or(HostError("work_budget_host_unavailable"))?;
        let plan = &current.resource.execution.plan_id;
        let conversation = current.goal.facts["conversationId"]
            .as_str()
            .ok_or(HostError("access_identity_invalid"))?;
        let attempts = current.journal.state["works"][work]["budget"]["attempts"]
            .as_object()
            .into_iter()
            .flat_map(|a| a.iter())
            .filter(|(_, attempt)| attempt["planId"] == *plan);
        for (attempt_id, attempt) in attempts {
            for row in attempt["pendingTools"].as_array().into_iter().flatten() {
                if cancel.is_cancelled() {
                    return Err(HostError("CANCELLED"));
                }
                let Some(hooks) = NativeWorkHooks::read(row).map_err(HostError)? else {
                    continue;
                };
                let Some(intent) = &hooks.intent else {
                    continue;
                };
                if hooks.provider_phase != peer_protocol::WorkProviderPhase::Prepared
                    || hooks.handles.is_empty()
                    || row["conversationId"] != conversation
                    || hooks.handles.iter().any(|h| h.observation.is_none())
                {
                    continue;
                }
                let required = |key: &str| {
                    row[key]
                        .as_str()
                        .ok_or(HostError("native_work_hooks_invalid"))
                };
                let call = required("toolCallId")?;
                let stream = required("streamId")?;
                let capability = required("capabilityId")?;
                let dispatch = required("dispatchId")?;
                let store = ConversationStore::new(&self.home);
                let snapshot = store.read_committed(conversation, None, 8 * 1024 * 1024)?;
                let Some(message) = snapshot
                    .history
                    .messages
                    .iter()
                    .find(|message| message["id"] == intent.message_id)
                else {
                    continue;
                };
                let Some(segment) = message["segments"]
                    .as_array()
                    .filter(|rows| rows.len() == 1)
                    .map(|rows| &rows[0])
                else {
                    continue;
                };
                let Some(tool) = segment["tool"].as_str() else {
                    continue;
                };
                let args = &segment["args"];
                let Some(mut grants) = message["permissionGrants"].as_array().cloned() else {
                    continue;
                };
                if grants.len() > 1
                    || grants
                        .first()
                        .is_some_and(|g| g["toolCallId"] != call || !g["granted"].is_boolean())
                {
                    continue;
                }
                let records = hooks
                    .handles
                    .iter()
                    .filter_map(|hook| hook.observation.as_ref())
                    .collect::<Vec<_>>();
                let at = episode_time();
                if grants.is_empty() && segment.get("result").is_none() {
                    grants.push(json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),
                        "toolCallId":call,"granted":false,"scope":capability,"duration":"denied",
                        "decidedAt":at,"reason":"permission_cancelled"}));
                }
                let Some(grant) = grants.first() else {
                    continue;
                };
                let mut result = if let Some(original) = segment.get("result") {
                    if original["toolCallId"] != call
                        || original["capabilityId"] != capability
                        || original["evidence"]["dispatchOutcome"] != "not_dispatched"
                    {
                        continue;
                    }
                    original.clone()
                } else {
                    json!({"toolCallId":call,"capabilityId":capability,"status":"cancelled","output":{},
                        "outputPreview":{"kind":"json"},"completedAt":at,
                        "error":{"code":"CANCELLED","message":"Original owner ended before dispatch","recoverable":true},
                        "evidence":{"evidenceId":format!("evidence-{}",uuid::Uuid::new_v4()),
                            "toolCallId":call,"summary":"Original owner ended before dispatch","artifactRefs":[],
                            "dispatchOutcome":"not_dispatched"}})
                };
                let decision = if records.iter().any(|r| r["decision"] == "deny") {
                    "deny"
                } else if records.iter().any(|r| r["decision"] == "ask") {
                    "ask"
                } else {
                    "allow"
                };
                result["evidence"]["hooks"] = json!(records);
                result["evidence"]["hookFinalDecision"] = json!(decision);
                if !self.journal.lease().holds()?
                    || self.goals.revision(plan)? != current.goal.source_revision
                {
                    return Err(HostError("execution_revision_stale"));
                }
                super::episode::hook_message::HookMessage {
                    intent,
                    conversation,
                    stream,
                    call,
                    tool,
                    args,
                }
                .commit(self, &grants, Some(&result))?;
                EvidenceIndexStore::new(&self.home).register(
                    &HostToolEvidence {
                        conversation_id: conversation,
                        plan_id: Some(plan),
                        stream_id: Some(stream),
                        tool_name: tool,
                        capability_id: capability,
                        tool_call_id: call,
                        grant,
                        result: &result,
                    },
                    None,
                )?;
                let budget = crate::execution_budget::EpisodeBudget {
                    work: work.into(),
                    attempt: attempt_id.clone(),
                    plan: plan.clone(),
                    session: current.resource.execution.session_id.clone(),
                    native_recorder: attempt["nativeRecorder"].clone(),
                };
                budget.settle(self, call, dispatch, &result, &at)?;
            }
        }
        Ok(())
    }
}
