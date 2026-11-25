//! Account a physical attempt before publishing its terminal result.
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
        Self::guard(host, f)?;
        if store
            .read_committed(&self.conversation, None, 8 * 1024 * 1024)?
            .source_revision
            != revision
        {
            return Err(peer_store::StoreError::ContextConflict.into());
        }
        host.admit_request(capacity_bearing)?;
        let fingerprint = prepared.fingerprint().to_owned();
        let mut observed = None;
        let turn = host
            .send_prepared(prepared, f, &mut observed, capacity_bearing)
            .await;
        let observed = observed.unwrap_or_default();
        let capacity = if capacity_bearing {
            self.capacity
                .observe(observed.usage(), &fingerprint, milliseconds(&now())?)
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
        // Preserve factual late usage before ownership/cancellation failures.
        let turn = turn?;
        Self::authority(host, f)?;
        let checked = {
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
                self.persist_for_host(host, &store, &fresh, "turn_complete")?
            } else {
                fresh
            }
        };
        Ok((turn, checked))
    }
}
