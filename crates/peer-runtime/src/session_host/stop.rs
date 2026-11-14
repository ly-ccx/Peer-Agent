use super::*;
use crate::{live_execution::Ownership, recorder};
use peer_protocol::javascript_json_digest;
use std::time::Duration;

impl NativeSessionHost {
    /// Local Host control entry. The caller must already own the canonical
    /// control authority; this method never authenticates an assistant string.
    pub async fn begin_stop(
        &mut self,
        plan_id: &str,
        kind: &str,
        operation_id: &str,
        authority_ref: &str,
        now: &str,
    ) -> Result<Value, HostError> {
        if !["pause", "cancel", "takeover"].contains(&kind)
            || [operation_id, authority_ref]
                .into_iter()
                .any(|s| s.is_empty() || s.len() > 512)
        {
            return Err(HostError("session_control_conflict"));
        }
        let current = self.current(plan_id, now)?;
        let old = control(&current);
        let execution = &current.goal.facts["execution"];
        let identity = json!({"kind":kind,"operationId":operation_id,"authorityRef":authority_ref,"execution":execution});
        let digest = javascript_json_digest(&identity)
            .map_err(|_| HostError("session_control_resource_limit"))?;
        if old["operationId"] == operation_id {
            if old["requestDigest"] != digest {
                return Err(HostError("operation_identity_conflict"));
            }
            self.recover_execution_mirrors(plan_id, now)?;
            // Recover a crash between durable admission closure and ledger
            // protection. Do not skip the uncommitted second half on replay.
            if old["phase"] == "recorded" {
                self.live
                    .close_admission(&current.resource.execution)
                    .map_err(|_| HostError("execution_stop_unconfirmed"))?;
                self.resources.protect(
                    &current.resource,
                    old["hostEpoch"].as_str(),
                    Some(operation_id),
                    "draining",
                    &unsettled(&current),
                    now,
                )?;
                return self.advance_control(
                    plan_id,
                    operation_id,
                    json!({"phase":"draining"}),
                    now,
                );
            }
            return Ok(old);
        }
        if kind != "cancel"
            && (old["kind"] == "cancel"
                || !current.goal.facts["delegationOrigin"]["cancellation"].is_null())
        {
            return Err(HostError("work_execution_stopped"));
        }
        let ownership = self
            .live
            .ownership(&current.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?;
        let terminal = terminal_runner(&current.goal.facts);
        let unproven = ownership == Ownership::Unknown
            && !terminal
            && (current.goal.facts["delegationOrigin"]["phase"] == "running"
                || !current.goal.facts["delegationOrigin"]["takeover"].is_null()
                || !current.goal.facts["delegationOrigin"]["cancellation"].is_null());
        let lease = self.journal.lease().record();
        let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
        let record = recorder::local_recorder(&lease.host_id, &lease.acquired_at).await;
        // Re-read after OS observation; the actual commit CAS also binds Goal.
        let fresh = self.current(plan_id, now)?;
        if fresh.goal.source_revision != current.goal.source_revision {
            return Err(HostError("execution_revision_stale"));
        }
        let mut operation = identity;
        let m = operation
            .as_object_mut()
            .ok_or(HostError("session_control_conflict"))?;
        m.extend(json!({"requestDigest":digest,"revision":1,"workspaceId":current.resource.workspace_id,"parentConversationId":current.goal.facts["delegationOrigin"]["parentConversationId"],"sessionId":current.resource.execution.session_id,"planId":plan_id,"expectedExecution":execution,"hostEpoch":epoch,"unproven":unproven,"phase":"recorded","updatedAt":now}).as_object().unwrap().clone());
        if let Some(record) = record {
            operation["recorder"] = serde_json::to_value(record)
                .map_err(|_| HostError("execution_stop_unconfirmed"))?;
        }
        self.live
            .close_admission(&current.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?;
        self.write_control(&fresh, &operation, milliseconds(now)?)?;
        self.resources.protect(
            &current.resource,
            Some(&epoch),
            Some(operation_id),
            "draining",
            &unsettled(&current),
            now,
        )?;
        self.advance_control(plan_id, operation_id, json!({"phase":"draining"}), now)
    }
    fn advance_control(
        &mut self,
        plan_id: &str,
        operation_id: &str,
        patch: Value,
        now: &str,
    ) -> Result<Value, HostError> {
        let fresh = self.current(plan_id, now)?;
        let mut op = control(&fresh);
        if op["operationId"] != operation_id || op["phase"] == "settled" {
            return Err(HostError("session_control_superseded"));
        }
        let revision = op["revision"]
            .as_u64()
            .ok_or(HostError("session_control_conflict"))?;
        op.as_object_mut()
            .ok_or(HostError("session_control_conflict"))?
            .extend(
                patch
                    .as_object()
                    .ok_or(HostError("session_control_conflict"))?
                    .clone(),
            );
        op["revision"] = json!(
            revision
                .checked_add(1)
                .ok_or(HostError("session_control_conflict"))?
        );
        op["updatedAt"] = json!(now);
        self.write_control(&fresh, &op, milliseconds(now)?)?;
        Ok(op)
    }
    /// Cancels the real registered owners and waits for their completion. A
    /// deadline persists reconciling; calling again may commit a late real stop.
    pub async fn drain_stop(
        &mut self,
        plan_id: &str,
        operation_id: &str,
        deadline: Duration,
        now: &str,
    ) -> Result<Value, HostError> {
        let result = self.drain_inner(plan_id, operation_id, deadline, now).await;
        if let Err(error) = result {
            let _ = self.advance_control(
                plan_id,
                operation_id,
                json!({"phase":"reconciling","nextAction":error.0}),
                now,
            );
        }
        result
    }
    async fn drain_inner(
        &mut self,
        plan_id: &str,
        operation_id: &str,
        deadline: Duration,
        now: &str,
    ) -> Result<Value, HostError> {
        let before = self.current(plan_id, now)?;
        let operation = control(&before);
        if operation["operationId"] != operation_id
            || operation["expectedExecution"] != before.goal.facts["execution"]
        {
            return Err(HostError("execution_revision_stale"));
        }
        if operation["phase"] == "settled" {
            return operation
                .get("stopReceipt")
                .cloned()
                .ok_or(HostError("session_control_receipt_required"));
        }
        let proof =
            match serde_json::from_value::<recorder::Recorder>(operation["recorder"].clone()) {
                Ok(r) => recorder::prove(&r).await,
                Err(_) => recorder::RecorderProof::Unproven,
            };
        let ownership = self
            .live
            .ownership(&before.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?;
        let recorded_elsewhere = operation["hostEpoch"].as_str()
            != Some(&format!(
                "{}:{}",
                self.journal.lease().record().host_id,
                self.journal.lease().record().acquired_at
            ));
        let native_stopped = self.dead_native_episode(&before).await;
        if !terminal_runner(&before.goal.facts)
            && !native_stopped
            && !proof.allows_settlement()
            && (operation["unproven"] == true
                || recorded_elsewhere && ownership != Ownership::Ended)
        {
            return Err(HostError("execution_stop_unconfirmed"));
        }
        if ownership == Ownership::Live {
            let live = self.live.clone();
            let drain = live.drain(&before.resource.execution, deadline);
            tokio::pin!(drain);
            let started = std::time::Instant::now();
            let base = milliseconds(now)?;
            loop {
                tokio::select! {
                    result = &mut drain => { result.map_err(|_|HostError("execution_stop_unconfirmed"))?; break; },
                    _ = tokio::time::sleep(Duration::from_secs(5)) => {
                        let elapsed = i64::try_from(started.elapsed().as_millis()).map_err(|_|HostError("invalid_host_time"))?;
                        self.journal.heartbeat(base.checked_add(elapsed).ok_or(HostError("invalid_host_time"))?)?;
                    }
                }
            }
        } else if ownership != Ownership::Ended
            && !native_stopped
            && !terminal_runner(&before.goal.facts)
            && !proof.allows_settlement()
        {
            return Err(HostError("execution_stop_unconfirmed"));
        }
        let fresh = self.current(plan_id, now)?;
        if fresh.goal.facts["execution"] != before.goal.facts["execution"]
            || control(&fresh)["operationId"] != operation_id
        {
            return Err(HostError("execution_revision_stale"));
        }
        if self
            .live
            .ownership(&fresh.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?
            == Ownership::Live
        {
            return Err(HostError("execution_still_running"));
        }
        for (id, call, state) in self
            .live
            .handle_observations(&fresh.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?
        {
            self.resources.mark_handle(
                &fresh.resource,
                &json!({"handleId":id,"toolCallId":call,"state":state,"completedAt":now}),
                now,
            )?;
            if state == "ended" {
                self.live
                    .acknowledge_ended_handle(&fresh.resource.execution, &id)
                    .map_err(|_| HostError("execution_stop_unconfirmed"))?;
            }
        }
        let claims = self.resources.claims_for(&fresh.resource)?;
        let open = claims
            .iter()
            .flat_map(|c| {
                c["handles"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values())
            })
            .filter(|h| h["state"] != "ended");
        let handles: Vec<_> = open
            .filter_map(|h| h["toolCallId"].as_str().map(str::to_owned))
            .collect();
        if !handles.is_empty() && !proof.allows_settlement() {
            return Err(HostError("execution_stop_unconfirmed"));
        }
        let mut unknown = unsettled(&fresh);
        if proof.allows_settlement() {
            unknown.extend(handles);
            unknown.extend(
                claims
                    .iter()
                    .flat_map(|c| c["evidenceCalls"].as_array().into_iter().flatten())
                    .filter_map(|v| v.as_str().map(str::to_owned)),
            );
            unknown = unique(unknown);
            unknown.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
        }
        let refs = claim_refs(&claims);
        let digest = javascript_json_digest(&json!([unknown, refs]))
            .map_err(|_| HostError("session_control_resource_limit"))?;
        let receipt = json!({"receiptId":format!("stop:{operation_id}:{digest}"),"operationId":operation_id,"execution":fresh.goal.facts["execution"],"admissionClosed":true,"runnerIdle":true,"schedulerIdle":true,"resourceClaims":refs,"unknownCalls":unknown,"scope":"managed_execution","completedAt":now});
        self.advance_control(
            plan_id,
            operation_id,
            json!({"stopReceipt":receipt,"phase":"reconciling"}),
            now,
        )?;
        Ok(receipt)
    }
    pub fn settle_stop(
        &mut self,
        plan_id: &str,
        operation_id: &str,
        now: &str,
    ) -> Result<Value, HostError> {
        let current = self.current(plan_id, now)?;
        let operation = control(&current);
        if operation["operationId"] != operation_id {
            return Err(HostError("session_control_superseded"));
        }
        if operation["phase"] == "settled" {
            return Ok(operation);
        }
        let receipt = operation
            .get("stopReceipt")
            .ok_or(HostError("session_control_receipt_required"))?;
        if self
            .live
            .ownership(&current.resource.execution)
            .map_err(|_| HostError("execution_stop_unconfirmed"))?
            == Ownership::Live
        {
            return Err(HostError("execution_still_running"));
        }
        self.resources.settle(
            &current.resource,
            receipt,
            &super::recovery::dispatch_scopes(&current),
            now,
        )?;
        if receipt["unknownCalls"]
            .as_array()
            .is_none_or(|a| !a.is_empty())
        {
            return self.advance_control(
                plan_id,
                operation_id,
                json!({"phase":"reconciling","nextAction":"reconcile_execution_outcome"}),
                now,
            );
        }
        self.advance_control(
            plan_id,
            operation_id,
            json!({"phase":"settled","outcome":"applied","nextAction":null}),
            now,
        )
    }
}
fn terminal_runner(facts: &Value) -> bool {
    matches!(
        facts["runner"]["status"].as_str(),
        Some("completed" | "failed" | "cancelled" | "stopped")
    )
}
