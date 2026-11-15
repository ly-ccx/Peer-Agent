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

impl NativeSessionHost {
    pub(super) fn observe_model_usage(
        &mut self,
        budget: &EpisodeBudget,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
    ) -> Result<(), HostError> {
        let metadata = RequestMetadata {
            fingerprint: observed.fingerprint.as_deref(),
            ..RequestMetadata::default()
        };
        if let Err(code) = accounting.observe(observed.usage.clone(), metadata) {
            accounting
                .observe(None, RequestMetadata::default())
                .map_err(HostError)?;
            budget.usage(self, None, &super::episode_time())?;
            return Err(HostError(code));
        }
        let usage = observed.usage.map(|u| serde_json::json!(u));
        if let Err(error) = budget.usage(self, usage.as_ref(), &super::episode_time()) {
            budget.usage(self, None, &super::episode_time())?;
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
