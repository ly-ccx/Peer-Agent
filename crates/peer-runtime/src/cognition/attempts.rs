//! A physical attempt is accounted before deciding to wait or dispatch again.
//! The same owner wait handles cancellation/lease renewal; tools never enter
//! this loop. History CAS and live authority are rechecked after every wait.
use super::*;
use crate::model::{ModelError, PreparedRequest, qoder_retry::Policy};
impl ContextPipeline {
    pub(super) async fn send_attempts(
        &mut self,
        host: &mut impl CognitionHost,
        f: &CognitionRequest<'_>,
        accounting: &mut RuntimeUsageAccounting,
        mut prepared: PreparedRequest<'_>,
        history: &HistorySnapshot,
        capacity_bearing: bool,
    ) -> Result<Result<ModelTurn, ModelError>, HostError> {
        let seed = prepared.retry_seed();
        let mut policy = Policy::default();
        let store = ConversationStore::new(f.home);
        let mut revision = history.source_revision.clone();
        loop {
            Self::guard(host, f)?;
            host.admit_request()?;
            let fingerprint = prepared.fingerprint().to_owned();
            let mut observed = None;
            let turn = host
                .wait(
                    async {
                        let result = prepared.send(f.owned).await;
                        observed = Some(ModelObservation::capture(&result));
                        result
                    },
                    f.owned,
                    f.external,
                )
                .await;
            let observed = observed.unwrap_or_default();
            let capacity = if capacity_bearing {
                self.capacity
                    .observe(observed.usage(), &fingerprint, milliseconds(&now())?)
                    .map_err(HostError)
            } else {
                Ok(())
            };
            host.observe(accounting, observed, capacity_bearing)?;
            capacity?;
            // Preserve factual late usage before ownership/cancellation failures.
            let turn = turn?;
            Self::authority(host, f)?;
            {
                let fresh = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
                if fresh.source_revision != revision {
                    return Err(peer_store::StoreError::ContextConflict.into());
                }
                if capacity_bearing {
                    self.capacity.complete();
                }
                if capacity_bearing
                    && let Err(error) = &turn
                    && let Some(status) = error.context_overflow_status
                {
                    self.capacity.overflow(status);
                }
                if capacity_bearing {
                    revision = self
                        .persist(&store, &fresh, "turn_complete")?
                        .source_revision;
                }
            }
            let delay = match (&turn, &seed) {
                (Err(error), Some(_)) => policy.next(error).map_err(|e| HostError(e.code))?,
                _ => None,
            };
            let Some(delay) = delay else {
                return Ok(turn);
            };
            Self::guard(host, f)?;
            host.wait(async {
                tokio::select! { biased; _ = f.owned.cancelled() => {}, _ = tokio::time::sleep(delay) => {} }
            }, f.owned, f.external).await?;
            Self::guard(host, f)?;
            prepared = seed
                .as_ref()
                .expect("Qoder retries have a frozen seed")
                .prepare()
                .map_err(|e| HostError(e.code))?;
            {
                let fresh = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
                if fresh.source_revision != revision {
                    return Err(peer_store::StoreError::ContextConflict.into());
                }
                // Qoder is observed-only. No auxiliary count call is admitted.
                if capacity_bearing {
                    self.capacity
                        .built(
                            prepared.fingerprint(),
                            fresh.history.content_revision,
                            Ok(None),
                            milliseconds(&now())?,
                        )
                        .map_err(HostError)?;
                    revision = self
                        .persist(&store, &fresh, "request_preflight")?
                        .source_revision;
                }
            }
        }
    }
}
