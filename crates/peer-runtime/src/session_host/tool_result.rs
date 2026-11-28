//! The Host retains ownership until content publication has actually ended.
use super::{HostError, NativeSessionHost};
use crate::{
    CancellationToken,
    providers::ToolOutputKind,
    tool_result_content::{ArchivePolicy, archive},
};
use serde_json::Value;
impl NativeSessionHost {
    pub(super) async fn archive_tool_result(
        &mut self,
        conversation: &str,
        result: Value,
        kind: ToolOutputKind,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<Value, HostError> {
        let home = self.home.clone();
        let conversation = conversation.to_owned();
        let cancel = owned.clone();
        let task = tokio::task::spawn_blocking(move || {
            archive(
                &home,
                &conversation,
                result,
                kind,
                ArchivePolicy::LargeOnly,
                &cancel,
            )
            .map_err(HostError)
        });
        self.wait_owned(task, owned, external)
            .await?
            .map_err(|_| HostError("artifact_unavailable"))?
    }
}
