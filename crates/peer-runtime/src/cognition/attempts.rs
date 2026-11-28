//! Replay a single pure inference step. No partial turn can reach dispatch.
use super::*;
use crate::model::{ModelError, PreparedRequest};

impl ContextPipeline {
    pub(super) async fn send_attempts(
        &mut self,
        host: &mut impl CognitionHost,
        f: &CognitionRequest<'_>,
        accounting: &mut RuntimeUsageAccounting,
        prepared: PreparedRequest<'_>,
        history: &HistorySnapshot,
        capacity_bearing: bool,
    ) -> Result<(Result<ModelTurn, ModelError>, HistorySnapshot), HostError> {
        let store = ConversationStore::new(f.home);
        let mut revision = history.source_revision.clone();
        let mut policy = host.retry_policy();
        let mut deadline = None;
        let mut permit = None;
        let mut attempts = 0;
        let (turn, checked) = loop {
            Self::guard(host, f)?;
            self.check_attempt_source(&store, &revision)?;
            host.admit_request(capacity_bearing)?;
            attempts += 1;
            let mut observed = None;
            let turn = host
                .send_prepared(&prepared, f, &mut observed, capacity_bearing, deadline)
                .await;
            drop(permit.take());
            let observed = observed.unwrap_or_default();
            let capacity = if capacity_bearing {
                self.capacity
                    .observe(
                        observed.usage(),
                        prepared.fingerprint(),
                        milliseconds(&now())?,
                    )
                    .map_err(HostError)
            } else {
                Ok(())
            };
            if let Some(publication) = host.observe(accounting, observed, capacity_bearing)? {
                let next = publication
                    .advance(
                        &self.conversation,
                        history.history.content_revision,
                        &revision,
                    )?
                    .to_owned();
                host.advance_owned_source(&revision, &next, history.history.content_revision)?;
                revision = next;
            }
            capacity?;
            // Preserve factual usage even when the owner rejected a late result.
            let turn = turn?.map_err(|mut error| {
                error.attempts_used = attempts;
                error
            });
            Self::authority(host, f)?;
            let checked = self.check_attempt_source(&store, &revision)?;
            let Err(error) = &turn else {
                break (turn, checked);
            };
            let Some(retry) = policy.next_retry(error) else {
                break (turn, checked);
            };
            if !host.can_retry()? {
                break (turn, checked);
            }
            host.on_retry(retry.notice, retry.deadline).await?;
            permit = host.wait(
                async {
                    tokio::select! {
                        biased;
                        _ = f.external.cancelled() => Err(HostError("CANCELLED")),
                        ready = f.model.wait_for_retry(&retry, f.owned) => ready.map_err(|e| HostError(e.code)),
                    }
                },
                f.owned, f.external,
            ).await??;
            Self::authority(host, f)?;
            let checked = self.check_attempt_source(&store, &revision)?;
            if permit.is_none()
                || tokio::time::Instant::now() >= retry.deadline
                || !host.can_retry()?
            {
                break (turn, checked);
            }
            deadline = Some(retry.deadline);
        };
        let checked = if capacity_bearing {
            self.capacity.complete();
            if let Err(error) = &turn
                && let Some(status) = error.context_overflow_status
            {
                self.capacity.overflow(status);
            }
            self.persist_for_host(host, &store, &checked, "turn_complete")?
        } else {
            checked
        };
        Ok((turn, checked))
    }

    fn check_attempt_source(
        &self,
        store: &ConversationStore,
        revision: &str,
    ) -> Result<HistorySnapshot, HostError> {
        let fresh = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
        if fresh.source_revision != revision {
            return Err(peer_store::StoreError::ContextConflict.into());
        }
        Ok(fresh)
    }
}
