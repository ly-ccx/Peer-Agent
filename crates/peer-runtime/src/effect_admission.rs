//! Bounded Host control port. An async Provider cannot mint a permission fact.
use crate::{CancellationToken, capability::CapabilityError as HostError, recorder::Recorder};
use serde_json::Value;
use std::{
    future::Future,
    pin::Pin,
    sync::{Arc, OnceLock},
};
use tokio::sync::{mpsc, oneshot};
pub(crate) type ConnectionDriver = Pin<Box<dyn Future<Output = Result<(), ()>> + Send>>;
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
    ForegroundShellOpen {
        handle: String,
        cancel: CancellationToken,
        driver: ConnectionDriver,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    ForegroundShellBind {
        handle: String,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    BackgroundShellStarted {
        observation: crate::providers::EffectOutcome,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    StopBackgroundShell {
        task_id: String,
        reply: oneshot::Sender<Result<crate::providers::EffectOutcome, HostError>>,
    },
    Child {
        handle: String,
        recorder: Recorder,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
    Connection {
        handle: String,
        metadata: Value,
        cancel: CancellationToken,
        driver: ConnectionDriver,
        reply: oneshot::Sender<Result<(), HostError>>,
    },
}
// The current Host records its actual validation failure before cancelling
// the owned effect. The provider uses it only to describe the interruption.
#[derive(Clone, Default)]
pub(crate) struct EffectRevocation(Arc<OnceLock<HostError>>);

impl EffectRevocation {
    pub(crate) fn record(&self, reason: HostError) {
        let _ = self.0.set(reason);
    }
}

#[derive(Clone)]
pub struct EffectAdmission {
    pub(crate) sender: mpsc::Sender<AdmissionRequest>,
    cancel: CancellationToken,
    revocation: Option<EffectRevocation>,
    pub(crate) owner: Option<Recorder>,
    pub(crate) confined_reads: bool,
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
                revocation: None,
                owner: None,
                confined_reads: false,
            },
            receiver,
        )
    }
    async fn request(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<(), HostError>>) -> AdmissionRequest,
    ) -> Result<(), HostError> {
        self.exchange(make).await
    }
    async fn exchange<T>(
        &self,
        make: impl FnOnce(oneshot::Sender<Result<T, HostError>>) -> AdmissionRequest,
    ) -> Result<T, HostError> {
        let (send, receive) = oneshot::channel();
        tokio::select! {biased;_=self.cancel.cancelled()=>return Err(HostError("CANCELLED")),result=self.sender.send(make(send))=>result.map_err(|_|HostError("execution_admission_closed"))?};
        tokio::select! {biased;_=self.cancel.cancelled()=>Err(HostError("CANCELLED")),result=receive=>result.map_err(|_|HostError("execution_admission_closed"))?}
    }
    pub(crate) fn observe_revocations(&mut self) -> EffectRevocation {
        let observation = EffectRevocation::default();
        self.revocation = Some(observation.clone());
        observation
    }

    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) fn revocation_reason(&self) -> Option<HostError> {
        self.revocation
            .as_ref()
            .and_then(|observation| observation.0.get().copied())
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
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) async fn foreground_shell_open(
        &self,
        handle: String,
        cancel: CancellationToken,
        driver: ConnectionDriver,
    ) -> Result<(), HostError> {
        self.request(|reply| AdmissionRequest::ForegroundShellOpen {
            handle,
            cancel,
            driver,
            reply,
        })
        .await
    }
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    pub(crate) async fn foreground_shell_bind(&self, handle: String) -> Result<(), HostError> {
        self.request(|reply| AdmissionRequest::ForegroundShellBind { handle, reply })
            .await
    }
    pub(crate) async fn background_shell_started(
        &self,
        observation: crate::providers::EffectOutcome,
    ) -> Result<(), HostError> {
        self.request(|reply| AdmissionRequest::BackgroundShellStarted { observation, reply })
            .await
    }
    pub(crate) async fn stop_background_shell(
        &self,
        task_id: String,
    ) -> Result<crate::providers::EffectOutcome, HostError> {
        self.exchange(|reply| AdmissionRequest::StopBackgroundShell { task_id, reply })
            .await
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
    /// An unpolled transport belongs to the Host only after durable handle and
    /// live-owner registration. A rejected/dropped request cannot start it.
    pub(crate) async fn connection(
        &self,
        handle: String,
        metadata: Value,
        cancel: CancellationToken,
        driver: ConnectionDriver,
    ) -> Result<(), HostError> {
        if handle.is_empty()
            || handle.len() > 512
            || serde_json::to_vec(&metadata)
                .map_err(|_| HostError("mcp_handle_invalid"))?
                .len()
                > 64 * 1024
        {
            return Err(HostError("mcp_handle_invalid"));
        }
        self.request(|reply| AdmissionRequest::Connection {
            handle,
            metadata,
            cancel,
            driver,
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
