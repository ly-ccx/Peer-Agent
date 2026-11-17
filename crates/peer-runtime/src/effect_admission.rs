//! Bounded Host control port. An async Provider cannot mint a permission fact.
use crate::{CancellationToken, recorder::Recorder, session_host::HostError};
use serde_json::Value;
use tokio::sync::{mpsc, oneshot};
pub(crate) enum AdmissionRequest {
    Check(oneshot::Sender<Result<(), HostError>>),
    ReadScope {
        path: std::path::PathBuf,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    CommandStarting(oneshot::Sender<Result<(), HostError>>),
    CommandStarted {
        recorder: Recorder,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
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
    pub(crate) owner: Option<Recorder>,
}
impl EffectAdmission {
    pub(crate) fn blocking_guard(&self) -> BlockingAdmission {
        BlockingAdmission {
            port: self.clone(),
            runtime: tokio::runtime::Handle::current(),
            next: std::cell::Cell::new(std::time::Instant::now()),
            error: std::cell::Cell::new(None),
        }
    }
    pub(crate) fn channel(cancel: &CancellationToken) -> (Self, mpsc::Receiver<AdmissionRequest>) {
        let (sender, receiver) = mpsc::channel(8);
        (
            Self {
                sender,
                cancel: cancel.clone(),
                owner: None,
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
    pub(crate) async fn read_scope(&self, path: std::path::PathBuf) -> Result<(), HostError> {
        if !path.is_absolute() || path.as_os_str().len() > 8192 {
            return Err(HostError("read_scope_invalid"));
        }
        self.request(|reply| AdmissionRequest::ReadScope { path, reply })
            .await
    }
    pub(crate) async fn command_starting(&self) -> Result<(), HostError> {
        self.request(AdmissionRequest::CommandStarting).await
    }
    pub(crate) async fn command_started(&self, pid: u32) -> Result<(), HostError> {
        let owner = self
            .owner
            .as_ref()
            .ok_or(HostError("native_process_owner_unknown"))?;
        let recorder = crate::recorder::process_recorder(pid, &owner.host_id, &owner.acquired_at)
            .await
            .ok_or(HostError("native_process_recorder_unavailable"))?;
        // Recording a real child is a cleanup/accountability action even after
        // cancellation. It cannot authorize another spawn. The original owner
        // still kills and joins its child if this bounded acknowledgement fails.
        let (send, receive) = oneshot::channel();
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            self.sender
                .send(AdmissionRequest::CommandStarted {
                    recorder,
                    reply: send,
                })
                .await
                .map_err(|_| HostError("execution_admission_closed"))?;
            receive
                .await
                .map_err(|_| HostError("execution_admission_closed"))?
        })
        .await
        .map_err(|_| HostError("native_process_record_timeout"))?
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
/// Fresh Host checks for a real owned blocking worker, with bounded polling.
/// An observed authority failure is retained through Store cancellation errors.
pub(crate) struct BlockingAdmission {
    port: EffectAdmission,
    runtime: tokio::runtime::Handle,
    next: std::cell::Cell<std::time::Instant>,
    error: std::cell::Cell<Option<HostError>>,
}
impl BlockingAdmission {
    pub(crate) fn check(&self) -> Result<(), HostError> {
        let result = self.runtime.block_on(self.port.check());
        if let Err(error) = result {
            self.error.set(Some(error))
        }
        result
    }
    pub(crate) fn error(&self) -> Option<&'static str> {
        self.error.get().map(|e| e.0)
    }
    pub(crate) fn interrupted(&self) -> bool {
        if self.error.get().is_some() {
            return true;
        }
        if self.port.cancel.is_cancelled() {
            self.error.set(Some(HostError("CANCELLED")));
            return true;
        }
        if std::time::Instant::now() >= self.next.get() {
            let failed = self.check().is_err();
            // Authority I/O itself may take over one interval. Start the next
            // poll after its acknowledgement, otherwise serde's many tiny
            // writes immediately repeat that expensive check without progress.
            self.next
                .set(std::time::Instant::now() + std::time::Duration::from_millis(100));
            return failed;
        }
        false
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

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "current_thread")]
    async fn slow_currentness_ack_does_not_make_every_json_write_another_host_check() {
        let cancel = CancellationToken::new();
        let (port, mut requests) = EffectAdmission::channel(&cancel);
        let guard = port.blocking_guard();
        drop(port);
        let worker = tokio::task::spawn_blocking(move || {
            assert!(!guard.interrupted());
            for _ in 0..100 {
                assert!(!guard.interrupted());
            }
            std::thread::sleep(std::time::Duration::from_millis(110));
            assert!(!guard.interrupted());
        });
        let serve = async {
            let mut count = 0;
            while let Some(AdmissionRequest::Check(reply)) = requests.recv().await {
                count += 1;
                tokio::time::sleep(std::time::Duration::from_millis(120)).await;
                reply.send(Ok(())).unwrap();
            }
            count
        };
        let (worker, count) = tokio::join!(worker, serve);
        worker.unwrap();
        assert_eq!(count, 2);
    }
}
