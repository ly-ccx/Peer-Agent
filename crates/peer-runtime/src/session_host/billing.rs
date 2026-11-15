//! Runtime owns billing, including terminal errors. Store owns recovery/dedupe.
use super::{HostError, NativeSessionHost};
use crate::CancellationToken;
use crate::{
    execution_budget::EpisodeBudget,
    model::{ModelError, ModelTurn},
    usage_accounting::{RequestMetadata, RuntimeUsageAccounting},
};
use peer_protocol::{RuntimeTurnUsage, UsageAmounts};
use peer_store::ConversationStore;
use serde_json::Value;
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

/// Captured before the ownership wait can reject a late result. Known provider
/// facts survive lease loss; executable calls still require the ownership gate.
#[derive(Default)]
pub(super) struct ModelObservation {
    usage: Option<UsageAmounts>,
    fingerprint: Option<String>,
    invalid: bool,
}
impl ModelObservation {
    pub(super) fn usage(&self) -> Option<&UsageAmounts> {
        self.usage.as_ref()
    }
    pub(super) fn capture(result: &Result<ModelTurn, ModelError>) -> Self {
        match result {
            Ok(turn) => {
                let usage = turn
                    .usage
                    .as_ref()
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose();
                match usage {
                    Ok(usage) => Self {
                        usage,
                        fingerprint: Some(turn.request_fingerprint.clone()),
                        invalid: false,
                    },
                    Err(_) => Self {
                        invalid: true,
                        ..Self::default()
                    },
                }
            }
            Err(error) => error
                .observation
                .as_ref()
                .map(|o| Self {
                    usage: o.usage.clone(),
                    fingerprint: Some(o.request_fingerprint.clone()),
                    invalid: false,
                })
                .unwrap_or_default(),
        }
    }
}

pub(super) struct BillingScope<'a> {
    pub conversation: &'a str,
    pub attribution: &'a Value,
}
impl BillingScope<'_> {
    pub(super) fn snapshot(
        &self,
        budget: &EpisodeBudget,
        usage: RuntimeTurnUsage,
    ) -> Result<Option<Value>, HostError> {
        if usage.amounts.total_tokens == 0 {
            return Ok(None);
        }
        let value = serde_json::json!({"schemaVersion":1,"workId":budget.work,"execution":budget.native_recorder["execution"],"conversationId":self.conversation,"attribution":self.attribution,"usage":usage,"knownAmountsOnly":true});
        peer_protocol::normalize_native_usage_snapshot(
            &value,
            &budget.work,
            self.attribution["workspaceId"].as_str().unwrap_or(""),
        )
        .ok_or(HostError("native_usage_snapshot_invalid"))?;
        Ok(Some(value))
    }
}

impl NativeSessionHost {
    pub(super) fn settle_finished_recorders(&mut self, stop: &Value) -> Result<(), HostError> {
        let state = self
            .journal
            .read(&crate::coordination::NativeCoordinationReducer, None)?;
        let works = state.state["works"]
            .as_object()
            .ok_or(HostError("work_budget_invalid"))?;
        if !works.values().any(|work| {
            work["budget"]["attempts"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .any(|row| row["nativeLoopFinished"] == true)
        }) {
            return Ok(());
        }
        let receipt = &stop["stopReceipt"];
        if receipt["scope"] != "managed_execution"
            || receipt["runnerIdle"] != true
            || receipt["schedulerIdle"] != true
            || receipt["admissionClosed"] != true
        {
            return Err(HostError("native_execution_stop_unproven"));
        }
        let execution = peer_protocol::normalize_session_execution_identity(&receipt["execution"])
            .ok_or(HostError("native_execution_stop_unproven"))?;
        let mut targets = Vec::new();
        for (work_id, work) in works {
            for (attempt, row) in work["budget"]["attempts"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.iter())
            {
                if row["nativeLoopFinished"] == true
                    && row["planId"] == execution.plan_id
                    && row["sessionId"] == execution.session_id
                {
                    peer_protocol::normalize_native_episode_recorder(
                        &row["nativeRecorder"],
                        &execution,
                    )
                    .ok_or(HostError("native_execution_stop_unproven"))?;
                    targets.push((work_id.clone(), attempt.clone(), row.clone()));
                }
            }
        }
        for (work_id, attempt, expected) in targets {
            let current = self
                .journal
                .read(&crate::coordination::NativeCoordinationReducer, None)?;
            let mut work = current.state["works"][&work_id].clone();
            let actual = &work["budget"]["attempts"][&attempt];
            if peer_protocol::approval_args_digest(actual).ok()
                != peer_protocol::approval_args_digest(&expected).ok()
            {
                return Err(HostError("native_execution_stop_unproven"));
            }
            work["budget"]["attempts"]
                .as_object_mut()
                .ok_or(HostError("work_budget_invalid"))?
                .shift_remove(&attempt);
            self.journal.append(
                &current,
                &serde_json::json!({"kind":"work","work":work}),
                super::milliseconds(&super::episode_time())?,
                &crate::coordination::NativeCoordinationReducer,
                None,
            )?;
        }
        Ok(())
    }
    fn pending_usage(
        &self,
        work: &str,
        raw: &Value,
    ) -> Result<peer_protocol::NativeUsageSnapshot, HostError> {
        let workspace = self.journal.lease().workspace_id()?;
        let snapshot =
            peer_protocol::normalize_native_usage_snapshot(&raw["snapshot"], work, workspace)
                .ok_or(HostError("native_usage_snapshot_invalid"))?;
        peer_protocol::normalize_native_episode_recorder(
            &raw["nativeRecorder"],
            &snapshot.execution,
        )
        .ok_or(HostError("native_usage_snapshot_invalid"))?;
        Ok(snapshot)
    }
    fn validate_usage_receipt(
        &self,
        work_id: &str,
        expected: &Value,
        receipt: &Value,
    ) -> Result<(), HostError> {
        let saved = self.pending_usage(work_id, expected)?;
        let row = &receipt["ledgerRow"];
        if row["id"] != saved.attribution["id"] || row["conversationId"] != saved.conversation_id {
            return Err(HostError("native_usage_receipt_invalid"));
        }
        let amounts = serde_json::json!(saved.usage);
        for (key, value) in amounts.as_object().unwrap() {
            if peer_protocol::approval_args_digest(&row[key]).ok()
                != peer_protocol::approval_args_digest(value).ok()
            {
                return Err(HostError("native_usage_receipt_invalid"));
            }
        }
        for (key, value) in saved.attribution.as_object().unwrap() {
            if key != "at"
                && !value.is_null()
                && peer_protocol::approval_args_digest(&row[key]).ok()
                    != peer_protocol::approval_args_digest(value).ok()
            {
                return Err(HostError("native_usage_receipt_invalid"));
            }
        }
        Ok(())
    }
    fn acknowledge_usage_batch(
        &mut self,
        records: Vec<(String, String, Value)>,
    ) -> Result<(), HostError> {
        // Receipt validation precedes admission here. Group a bounded batch by
        // Work so one loop does not replay the same growing journal per row.
        let mut grouped = std::collections::BTreeMap::<String, Vec<(String, Value)>>::new();
        for (work, attempt, expected) in records {
            grouped.entry(work).or_default().push((attempt, expected));
        }
        for (work_id, records) in grouped {
            let current = self
                .journal
                .read(&crate::coordination::NativeCoordinationReducer, None)?;
            let mut work = current.state["works"][&work_id].clone();
            let mut changed = false;
            for (attempt, expected) in records {
                let actual = &work["budget"]["nativeUsagePending"][&attempt];
                if actual.is_null() {
                    continue;
                }
                if peer_protocol::approval_args_digest(actual).ok()
                    != peer_protocol::approval_args_digest(&expected).ok()
                {
                    return Err(HostError("native_usage_snapshot_changed"));
                }
                work["budget"]["nativeUsagePending"]
                    .as_object_mut()
                    .ok_or(HostError("native_usage_snapshot_invalid"))?
                    .shift_remove(&attempt);
                changed = true;
            }
            if changed {
                self.journal.append(
                    &current,
                    &serde_json::json!({"kind":"work","work":work}),
                    super::milliseconds(&super::episode_time())?,
                    &crate::coordination::NativeCoordinationReducer,
                    None,
                )?;
            }
        }
        Ok(())
    }
    pub(super) fn acknowledge_current_usage(
        &mut self,
        budget: &EpisodeBudget,
        receipt: &Value,
    ) -> Result<(), HostError> {
        let state = self
            .journal
            .read(&crate::coordination::NativeCoordinationReducer, None)?;
        let raw = state.state["works"][&budget.work]["budget"]["nativeUsagePending"]
            [&budget.attempt]
            .clone();
        if raw.is_null() {
            return Ok(());
        }
        self.validate_usage_receipt(&budget.work, &raw, receipt)?;
        self.acknowledge_usage_batch(vec![(budget.work.clone(), budget.attempt.clone(), raw)])
    }
    /// Closed-loop snapshots only. Active attempts first require their real stop
    /// proof and are moved by EpisodeBudget::finish, never sealed by this sweep.
    pub(super) async fn recover_pending_usage(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<peer_protocol::NativeUsageRecoveryProgress, HostError> {
        let state = self
            .journal
            .read(&crate::coordination::NativeCoordinationReducer, None)?;
        let limit = peer_protocol::native_usage_recovery_batch_limit();
        let mut total = 0usize;
        let mut candidates = Vec::new();
        for (work_id, work) in state.state["works"]
            .as_object()
            .ok_or(HostError("native_usage_snapshot_invalid"))?
        {
            if work["budget"]["nativeUsagePending"].is_null() {
                continue;
            }
            let pending = work["budget"]["nativeUsagePending"]
                .as_object()
                .ok_or(HostError("native_usage_snapshot_invalid"))?;
            total += pending.len();
            for (attempt, raw) in pending {
                if candidates.len() < limit {
                    candidates.push((work_id.clone(), attempt.clone(), raw.clone()));
                }
            }
        }
        let mut confirmed = Vec::new();
        for (work, attempt, raw) in candidates {
            if cancel.is_cancelled() {
                return Err(HostError("CANCELLED"));
            }
            let snapshot = self.pending_usage(&work, &raw)?;
            let owned = cancel.child_token();
            let receipt = self
                .persist_turn_usage(
                    &snapshot.conversation_id,
                    snapshot.usage,
                    snapshot.attribution,
                    &owned,
                    cancel,
                )
                .await?
                .ok_or(HostError("native_usage_conversation_missing"))?;
            self.validate_usage_receipt(&work, &raw, &receipt)?;
            confirmed.push((work, attempt, raw));
        }
        let settled = confirmed.len();
        self.acknowledge_usage_batch(confirmed)?;
        Ok(peer_protocol::NativeUsageRecoveryProgress {
            schema_version: 1,
            settled,
            remaining: total - settled,
        })
    }
    pub(super) async fn prepare_episode_usage(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<(), HostError> {
        self.prepare_usage_ledger(cancel).await?;
        if self.recover_pending_usage(cancel).await?.remaining != 0 {
            return Err(HostError("native_usage_recovery_required"));
        }
        Ok(())
    }
    pub(super) fn observe_model_usage(
        &mut self,
        budget: &EpisodeBudget,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
        scope: &BillingScope<'_>,
    ) -> Result<(), HostError> {
        self.observe_usage_for(
            budget,
            accounting,
            observed,
            scope,
            peer_protocol::UsagePurpose::Agent,
            true,
        )
    }
    pub(super) fn observe_usage_for(
        &mut self,
        budget: &EpisodeBudget,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
        scope: &BillingScope<'_>,
        purpose: peer_protocol::UsagePurpose,
        capacity_bearing: bool,
    ) -> Result<(), HostError> {
        let metadata = RequestMetadata {
            fingerprint: observed.fingerprint.as_deref(),
            purpose,
            capacity_bearing,
        };
        if let Err(code) = accounting.observe(observed.usage.clone(), metadata) {
            accounting
                .observe(None, RequestMetadata::default())
                .map_err(HostError)?;
            let snapshot = scope.snapshot(budget, accounting.snapshot().turn_total)?;
            budget.usage(self, None, snapshot.as_ref(), &super::episode_time())?;
            return Err(HostError(code));
        }
        let usage = observed.usage.map(|u| serde_json::json!(u));
        let snapshot = scope.snapshot(budget, accounting.snapshot().turn_total)?;
        if let Err(error) = budget.usage(
            self,
            usage.as_ref(),
            snapshot.as_ref(),
            &super::episode_time(),
        ) {
            budget.usage(self, None, None, &super::episode_time())?;
            return Err(error);
        }
        if observed.invalid {
            return Err(HostError("native_usage_invalid"));
        }
        Ok(())
    }
    /// The blocking scan never blocks lease heartbeat. Before a new intent,
    /// cancelled admission may stop its read; an existing intent stays recoverable.
    pub(super) async fn prepare_usage_ledger(
        &mut self,
        cancel: &CancellationToken,
    ) -> Result<Option<Value>, HostError> {
        let flag = Arc::new(AtomicBool::new(false));
        let worker_flag = flag.clone();
        let home = self.home.clone();
        let owned = cancel.child_token();
        let notify = owned.clone();
        let future = async move {
            let mut job = tokio::task::spawn_blocking(move || {
                ConversationStore::new(home).recover_runtime_usage(Some(&worker_flag))
            });
            let result = tokio::select! {biased;result=&mut job=>result,_=notify.cancelled()=>{flag.store(true,Ordering::Release);job.await}};
            result
                .map_err(|_| HostError("native_usage_worker_failed"))?
                .map_err(HostError::from)
        };
        self.wait_owned(future, &owned, cancel).await?
    }
    /// Cleanup must persist already observed usage even after cancellation. It
    /// does not dispatch a new capability, and the caller still drains execution
    /// if this returns an error. The worker is always awaited while heartbeating.
    pub(super) async fn persist_turn_usage(
        &mut self,
        conversation: &str,
        usage: RuntimeTurnUsage,
        attribution: Value,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<Option<Value>, HostError> {
        if usage.amounts.total_tokens == 0 {
            return Ok(None);
        }
        let home = self.home.clone();
        let conversation = conversation.to_owned();
        let future = async move {
            tokio::task::spawn_blocking(move || {
                ConversationStore::new(home).record_runtime_turn_usage(
                    &conversation,
                    &usage,
                    &attribution,
                    None,
                )
            })
            .await
            .map_err(|_| HostError("native_usage_worker_failed"))?
            .map_err(HostError::from)
        };
        self.wait_owned(future, owned, external).await?
    }
}
