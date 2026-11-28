//! Owned derivation from saved observations; never executes a past tool.
use super::*;
use crate::model::ToolResultEncoding;
impl ContextPipeline {
    pub(super) async fn result_views(
        &self,
        host: &mut impl CognitionHost,
        f: &CognitionRequest<'_>,
        history: &HistorySnapshot,
        projected: &Value,
    ) -> Result<ToolResultEncoding, HostError> {
        Self::guard(host, f)?;
        let sources = ToolResultEncoding::collect(projected).map_err(|e| HostError(e.code))?;
        let home = f.home.to_path_buf();
        let conversation = self.conversation.clone();
        let cancel = f.owned.clone();
        let task =
            tokio::task::spawn_blocking(move || sources.materialize(&home, &conversation, &cancel));
        let encoded = host
            .wait(task, f.owned, f.external)
            .await?
            .map_err(|_| HostError("model_tool_result_encoding_unavailable"))?
            .map_err(|e| HostError(e.code))?;
        Self::guard(host, f)?;
        let fresh = ConversationStore::new(f.home).read_committed(
            &self.conversation,
            None,
            8 * 1024 * 1024,
        )?;
        if fresh.source_revision != history.source_revision {
            return Err(peer_store::StoreError::ContextConflict.into());
        }
        Ok(encoded)
    }
}
