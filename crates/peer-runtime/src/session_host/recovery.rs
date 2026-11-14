use super::*;
use crate::{execution_budget::EpisodeBudget, recorder};
use peer_protocol::{javascript_json_digest, normalize_native_episode_recorder};
use std::time::Duration;
impl NativeSessionHost {
    /// ADR 131 native recorder v1: canonical provenance + unanimous complete
    /// identities + actual OS proof + no unresolved capability handles.
    pub(super) async fn dead_native_episode(&self, current: &Current) -> bool {
        if self.live.ownership(&current.resource.execution).ok()
            == Some(crate::live_execution::Ownership::Live)
            || self
                .resources
                .unsettled_handles(&current.resource)
                .map_or(true, |h| !h.is_empty())
        {
            return false;
        }
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
            .filter(|r| r["planId"] == *plan);
        let mut recorder = None;
        for row in rows {
            let Some(normalized) = normalize_native_episode_recorder(
                &row["nativeRecorder"],
                &current.resource.execution,
            ) else {
                return false;
            };
            let Ok(next) =
                serde_json::from_value::<recorder::Recorder>(normalized["recorder"].clone())
            else {
                return false;
            };
            if recorder.as_ref().is_some_and(|old| old != &next) {
                return false;
            }
            recorder = Some(next);
        }
        if let Some(recorder) = recorder {
            recorder::prove(&recorder).await.allows_settlement()
        } else {
            false
        }
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
        let existing = control(&current);
        if existing["phase"] == "settled" && existing["kind"] == "pause" {
            self.recover_execution_mirrors(plan, &at)?;
            self.persist_episode_pause(plan, &existing)?;
            return Ok(existing);
        }
        if !self.dead_native_episode(&current).await {
            return Err(HostError("native_execution_stop_unproven"));
        }
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
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
            budget.usage(self, None, &super::episode_time())?;
            budget.finish(self, &super::episode_time())?;
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
        Ok(json!({"control":stop,"reconciliation":evidence,"unknownRetained":true}))
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
