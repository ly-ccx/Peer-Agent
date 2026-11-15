//! Bounded Host control port. An async Provider cannot mint a permission fact.
use crate::{CancellationToken, recorder::Recorder, session_host::HostError};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
pub(crate) enum AdmissionRequest {
    Check(oneshot::Sender<Result<(), HostError>>),
    Child {
        handle: String,
        recorder: Recorder,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
}
#[derive(Clone)]
pub struct EffectAdmission {
    pub(crate) sender: mpsc::Sender<AdmissionRequest>,
    cancel: CancellationToken,
}
impl EffectAdmission {
    pub(crate) fn channel(cancel: &CancellationToken) -> (Self, mpsc::Receiver<AdmissionRequest>) {
        let (sender, receiver) = mpsc::channel(8);
        (
            Self {
                sender,
                cancel: cancel.clone(),
            },
            receiver,
        )
    }
    async fn request(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<(), HostError>>) -> AdmissionRequest,
    ) -> Result<(), HostError> {
        let (send, receive) = oneshot::channel();
        tokio::select! {biased;_=self.cancel.cancelled()=>return Err(HostError("CANCELLED")),result=self.sender.send(make(send))=>result.map_err(|_|HostError("execution_admission_closed"))?};
        tokio::select! {biased;_=self.cancel.cancelled()=>Err(HostError("CANCELLED")),result=receive=>result.map_err(|_|HostError("execution_admission_closed"))?}
    }
    pub async fn check(&self) -> Result<(), HostError> {
        self.request(AdmissionRequest::Check).await
    }
    pub(crate) async fn child(&self, handle: String, recorder: Recorder) -> Result<(), HostError> {
        self.request(|reply| AdmissionRequest::Child {
            handle,
            recorder,
            reply,
        })
        .await
    }
}
pub(crate) fn native_mcp_metadata(
    transport: &str,
    revision: &str,
    owner: &Value,
    role: &str,
) -> Value {
    serde_json::json!({"schemaVersion":1,"role":role,"transport":transport,"registryRevision":revision,"ownerRecorder":owner})
}
