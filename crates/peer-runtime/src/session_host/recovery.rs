use super::*;
use crate::{execution_budget::EpisodeBudget, recorder};
use peer_protocol::{javascript_json_digest, normalize_native_episode_recorder};
use std::time::Duration;
impl NativeSessionHost {
    /// ADR 131 native recorder v1: canonical provenance + unanimous complete
    /// identities + actual OS proof + no unresolved capability handles.
    pub(super) async fn dead_native_episode(&self, current: &Current) -> bool {
        if !self.command_processes_stopped(current).unwrap_or(false) {
            return false;
        }
        if self.live.ownership(&current.resource.execution).ok()
            == Some(crate::live_execution::Ownership::Live)
            || self
                .resources
                .unsettled_handles(&current.resource)
                .map_or(true, |h| !h.is_empty())
        {
            return false;
        }
        self.dead_native_owner(current).await.is_some()
    }
    pub(super) async fn dead_native_owner(&self, current: &Current) -> Option<recorder::Recorder> {
        let plan = &current.resource.execution.plan_id;
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .unwrap_or("");
        let budget = &current.journal.state["works"][work]["budget"];
        let rows = budget["attempts"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.values())
            .chain(
                budget["uncertainDispatches"]
                    .as_array()
                    .into_iter()
                    .flatten(),
            )
            .filter(|r| r["planId"] == *plan)
            .map(|r| &r["nativeRecorder"])
            .chain(
                budget["nativeUsagePending"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values())
                    .map(|r| &r["nativeRecorder"])
                    .filter(|r| r["execution"]["planId"] == *plan),
            );
        let mut recorder = None;
        for row in rows {
            let normalized = normalize_native_episode_recorder(row, &current.resource.execution)?;
            let Ok(next) =
                serde_json::from_value::<recorder::Recorder>(normalized["recorder"].clone())
            else {
                return None;
            };
            if recorder.as_ref().is_some_and(|old| old != &next) {
                return None;
            }
            recorder = Some(next);
        }
        if let Some(recorder) = recorder {
            recorder::prove(&recorder)
                .await
                .allows_settlement()
                .then_some(recorder)
        } else {
            None
        }
    }
    // ADR 131: local pump/owned child settlement is separate from the remote
    // tool's unknown effect. The latter remains canonical and unfenced.
    async fn recover_native_mcp_handles(
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
        for mut handle in self.resources.unsettled_handles(&current.resource)? {
            if cancel.is_cancelled() {
                return Err(HostError("CANCELLED"));
            }
            let meta = &handle["nativeMcp"];
            if meta["schemaVersion"] != 1
                || !matches!(meta["role"].as_str(), Some("rpc" | "connection"))
                || !matches!(
                    meta["transport"].as_str(),
                    Some("stdio" | "streamable_http" | "sse")
                )
                || meta["registryRevision"].as_str().is_none_or(str::is_empty)
            {
                continue;
            }
            let Ok(recorded) =
                serde_json::from_value::<recorder::Recorder>(meta["ownerRecorder"].clone())
            else {
                continue;
            };
            if recorded != owner {
                continue;
            }
            if meta["role"] == "connection" && meta["transport"] == "stdio" {
                let Ok(child) =
                    serde_json::from_value::<recorder::Recorder>(meta["childRecorder"].clone())
                else {
                    continue;
                };
                if !child.complete()
                    || child.host_id != owner.host_id
                    || child.acquired_at != owner.acquired_at
                {
                    continue;
                }
                if !recorder::stop_recorded_group(&owner, &child, cancel).await {
                    continue;
                }
                handle["nativeMcp"]["childStopObservation"] = json!("group_absent");
            }
            handle["nativeMcp"]["ownerStopObservation"] = json!("original_owner_dead");
            handle["state"] = json!("ended");
            self.resources
                .mark_handle(&current.resource, &handle, &super::episode_time())?;
        }
        Ok(())
    }
    /// Stops a proven-dead native worker, preserves pending tools as unknown,
    /// then obtains fresh reconciliation observations. It never replays a tool.
    pub async fn recover_native_episode(
        &mut self,
        plan: &str,
        cancel: &crate::CancellationToken,
    ) -> Result<Value, HostError> {
        let at = super::episode_time();
        let current = self.current(plan, &at)?;
        let mut existing = control(&current);
        if existing["phase"] == "settled" && existing["kind"] == "pause" {
            self.recover_execution_mirrors(plan, &at)?;
            self.persist_episode_pause(plan, &existing)?;
            self.settle_finished_recorders(&existing)?;
            peer_store::ConversationStore::new(&self.home).reconcile_index(
                current.goal.facts["conversationId"]
                    .as_str()
                    .ok_or(HostError("access_identity_invalid"))?,
                &at,
                None,
            )?;
            let intent = self.prepare_usage_ledger(cancel).await?;
            let pending = self.recover_pending_usage(cancel).await?;
            existing["usageLedgerRecovery"] = json!({"intent":intent,"pending":pending});
            return Ok(existing);
        }
        self.recover_native_mcp_handles(&current, cancel).await?;
        self.recover_work_shell(&current, cancel).await?;
        self.recover_work_hook_processes(&current, cancel).await?;
        self.recover_command_processes(&current, cancel).await?;
        let current = self.current(plan, &super::episode_time())?;
        if !self.dead_native_episode(&current).await {
            return Err(HostError("native_execution_stop_unproven"));
        }
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        self.recover_observed_work_pre(&current, cancel)?;
        let current = self.current(plan, &super::episode_time())?;
        let work = current.goal.facts["delegationOrigin"]["workId"]
            .as_str()
            .ok_or(HostError("work_budget_host_unavailable"))?;
        let attempts = current.journal.state["works"][work]["budget"]["attempts"]
            .as_object()
            .into_iter()
            .flat_map(|m| m.iter())
            .filter(|(_, r)| r["planId"] == plan)
            .map(|(id, r)| (id.clone(), r["nativeRecorder"].clone()))
            .collect::<Vec<_>>();
        let digest = javascript_json_digest(&current.goal.facts["execution"])
            .map_err(|_| HostError("execution_revision_stale"))?;
        let operation = format!("native-recovery-{}", &digest[..32]);
        self.begin_stop(plan, "pause", &operation, "host:native-recovery", &at)
            .await?;
        self.drain_stop(
            plan,
            &operation,
            Duration::from_secs(3),
            &super::episode_time(),
        )
        .await?;
        let stop = self.settle_stop(plan, &operation, &super::episode_time())?;
        for (attempt, native_recorder) in attempts {
            let budget = EpisodeBudget {
                work: work.into(),
                attempt,
                plan: plan.into(),
                session: current.resource.execution.session_id.clone(),
                native_recorder,
            };
            budget.usage(self, None, None, &super::episode_time())?;
            budget.finish(self, &super::episode_time(), None)?;
        }
        self.settle_finished_recorders(&stop)?;
        if stop["phase"] == "settled" {
            peer_store::ConversationStore::new(&self.home).reconcile_index(
                current.goal.facts["conversationId"]
                    .as_str()
                    .ok_or(HostError("access_identity_invalid"))?,
                &super::episode_time(),
                None,
            )?;
        }
        if stop["phase"] == "settled" {
            self.persist_episode_pause(plan, &stop)?;
        }
        let current = self.current(plan, &super::episode_time())?;
        let mut evidence = Vec::new();
        for claim in self.resources.claims_for(&current.resource)? {
            if !claim["evidenceCalls"]
                .as_array()
                .is_none_or(|a| a.is_empty())
            {
                evidence.push(
                    self.reconcile_unknown(
                        plan,
                        claim["claimId"]
                            .as_str()
                            .ok_or(HostError("reconciliation_invalid_input"))?,
                        &super::episode_time(),
                        cancel,
                    )
                    .await?,
                );
            }
        }
        // Usage reconciliation follows actual execution stop, never blocks it.
        let intent = self.prepare_usage_ledger(cancel).await?;
        let pending = self.recover_pending_usage(cancel).await?;
        let usage = json!({"intent":intent,"pending":pending});
        Ok(
            json!({"control":stop,"reconciliation":evidence,"unknownRetained":true,"usageLedgerRecovery":usage}),
        )
    }
}
pub(super) fn dispatch_scopes(current: &Current) -> Vec<peer_store::HostDispatchScopes> {
    let work = current.goal.facts["delegationOrigin"]["workId"]
        .as_str()
        .unwrap_or("");
    let b = &current.journal.state["works"][work]["budget"];
    let rows = b["uncertainDispatches"]
        .as_array()
        .into_iter()
        .flatten()
        .chain(
            b["attempts"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .flat_map(|a| a["pendingTools"].as_array().into_iter().flatten()),
        );
    rows.filter(|r| {
        r["planId"]
            .as_str()
            .is_none_or(|p| p == current.resource.execution.plan_id)
    })
    .filter_map(|row| {
        let id = row["toolCallId"].as_str()?;
        let scopes = row["declaredScopes"].as_array()?;
        if scopes.len() > 16 {
            return None;
        }
        let scopes = scopes
            .iter()
            .map(peer_protocol::normalize_execution_resource_scope)
            .collect::<Option<Vec<_>>>()?;
        Some(peer_store::HostDispatchScopes {
            tool_call_id: id.into(),
            scopes,
        })
    })
    .take(4096)
    .collect()
}
