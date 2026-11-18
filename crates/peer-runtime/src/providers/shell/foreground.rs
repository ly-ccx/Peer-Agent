//! Ordinary foreground Shell adapter sharing one owned interpreter.
use super::{
    session::{AdmissionPoint, Exchange, OutputStatus, SessionOutput, ShellSession},
    *,
};
use std::sync::Mutex;
use tokio::sync::Mutex as AsyncMutex;

pub(super) struct ShellScope {
    declared: Vec<ExecutionResourceScope>,
    directories: Vec<peer_store::ResourceIdentity>,
}
impl ShellScope {
    pub(super) fn observe(cwd: &Path) -> Result<Self, HostError> {
        let declared = peer_store::provider_execution_scopes(cwd)?;
        let directories = declared
            .iter()
            .map(|scope| match scope {
                ExecutionResourceScope::Directory { path } => {
                    peer_store::directory_resource(path, false).map_err(Into::into)
                }
                _ => Err(HostError("shell_session_scope_unavailable")),
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            declared,
            directories,
        })
    }

    pub(super) fn declared(&self) -> &[ExecutionResourceScope] {
        &self.declared
    }

    fn check(&self, cwd: &Path) -> Result<(), &'static str> {
        let current = Self::observe(cwd).map_err(|_| "shell_session_scope_changed")?;
        if current.declared != self.declared || current.directories != self.directories {
            return Err("shell_session_scope_changed");
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(super) struct ForegroundShell {
    shared: Arc<Shared>,
}

struct Shared {
    id: String,
    cwd: Mutex<Option<PathBuf>>,
    slot: AsyncMutex<Slot>,
}

#[derive(Default)]
struct Slot {
    shell: Option<ShellSession>,
    stopped: Option<bool>,
}
impl Slot {
    async fn stop(&mut self) -> bool {
        if let Some(shell) = self.shell.take() {
            self.stopped = Some(shell.stop().await);
        }
        self.stopped.unwrap_or(true)
    }
}

impl ForegroundShell {
    pub(super) fn new() -> Self {
        Self {
            shared: Arc::new(Shared {
                id: format!("shell-session_{}", uuid::Uuid::new_v4()),
                cwd: Mutex::new(None),
                slot: AsyncMutex::new(Slot::default()),
            }),
        }
    }

    // A scope-selection hint. The worker checks its kernel cwd and the
    // original Host grant again before it can accept a command.
    pub(super) fn cwd(&self) -> Option<PathBuf> {
        self.shared.cwd.lock().ok()?.clone()
    }

    async fn open(
        &self,
        slot: &mut Slot,
        cwd: &Path,
        artifacts: &ShellArtifacts,
        port: &EffectAdmission,
        cancel: &CancellationToken,
    ) -> Result<(), HostError> {
        if slot.stopped.is_some() {
            return Err(HostError("shell_session_closed"));
        }
        if slot.shell.is_some() {
            return Ok(());
        }
        let lifetime = cancel.child_token();
        let actual = lifetime.clone();
        let shared = self.shared.clone();
        port.foreground_shell_open(
            self.shared.id.clone(),
            lifetime,
            Box::pin(async move {
                actual.cancelled().await;
                shared
                    .slot
                    .lock()
                    .await
                    .stop()
                    .await
                    .then_some(())
                    .ok_or(())
            }),
        )
        .await?;
        port.check().await?;
        artifacts
            .check_current()
            .map_err(|_| HostError("shell_artifact_unavailable"))?;
        let worker = ShellSession::spawn(cwd).map_err(|_| HostError("shell_spawn_failed"))?;
        let pid = worker.pid();
        slot.shell = Some(worker);
        port.command_started(pid).await
    }

    pub(super) async fn run(
        self,
        effect: ShellEffect,
        scope: ShellScope,
        call: ProviderCall,
        cancel: CancellationToken,
        port: EffectAdmission,
    ) -> EffectOutcome {
        if let Err(error) = port.check().await {
            return EffectOutcome::not_dispatched(error.0);
        }
        if let Err(code) = scope.check(&effect.cwd) {
            return EffectOutcome::not_dispatched(code);
        }
        let mut metadata = json!({
            "taskId": effect.handle, "toolCallId": call.tool_call_id(), "command": effect.command,
            "cwd": effect.cwd, "startedAt": call.started_at(), "status": "running",
        });
        let Ok((mut artifacts, stdout, stderr)) =
            ShellArtifacts::begin(&effect.home, call.started_at(), &effect.handle, &metadata)
        else {
            return EffectOutcome::not_dispatched("shell_artifact_unavailable");
        };
        let output = SessionOutput::new(CapturedStream::new(stdout), CapturedStream::new(stderr));
        let mut slot = self.shared.slot.lock().await;
        if let Err(error) = self
            .open(&mut slot, &effect.cwd, &artifacts, &port, &cancel)
            .await
        {
            let stopped = slot.stop().await;
            cancel.cancel();
            let mut outcome = EffectOutcome::not_dispatched(error.0);
            outcome.ended = stopped;
            metadata["status"] = json!(outcome.status);
            metadata["notDispatched"] = json!(true);
            metadata["managedProcessEnded"] = json!(stopped);
            if artifacts.finish(&metadata).is_err() {
                artifact_failed(&mut outcome);
            }
            return outcome;
        }
        let shell = slot.shell.as_mut().expect("opened actual Shell session");
        let handle = &self.shared.id;
        let result = shell
            .exchange(
                Exchange {
                    command: &effect.command,
                    cwd: &effect.cwd,
                    change_cwd: effect.args.get("cwd").is_some(),
                    timeout: effect.timeout,
                    cancel: &cancel,
                    output: &output,
                },
                |point| {
                    let port = &port;
                    let artifacts = &artifacts;
                    let scope = &scope;
                    let cwd = &effect.cwd;
                    async move {
                        scope.check(cwd)?;
                        match point {
                            AdmissionPoint::DirectoryChange => port.check().await,
                            AdmissionPoint::CommandWrite => {
                                artifacts
                                    .check_current()
                                    .map_err(|_| "shell_artifact_unavailable")?;
                                port.foreground_shell_bind(handle.clone()).await
                            }
                        }
                        .map_err(|error| error.0)
                    }
                },
            )
            .await;
        let result = result.map_err(|mut error| {
            if error.code == "CANCELLED"
                && let Some(reason) = port.revocation_reason()
            {
                error.code = reason.0;
            }
            error
        });
        let (mut outcome, stopped) = match result {
            Ok(exit) => {
                if let Ok(mut remembered) = self.shared.cwd.lock() {
                    *remembered = Some(exit.cwd);
                }
                let mut outcome = EffectOutcome::failed("shell_exit_failed");
                outcome.status = if exit.code == 0 { "success" } else { "failed" };
                outcome.error = None;
                outcome.output = json!({"exitCode":exit.code,"timedOut":false,"cancelled":false});
                (outcome, false)
            }
            Err(error) if error.may_have_dispatched => {
                let stopped = slot.stop().await;
                let mut outcome = EffectOutcome::failed("execution_outcome_unknown");
                outcome.ended = stopped;
                outcome.output = json!({
                    "exitCode": null, "timedOut": error.code == "shell_timeout",
                    "cancelled": error.code == "CANCELLED", "interrupted": true, "stopReason": error.code,
                });
                (outcome, stopped)
            }
            Err(error) => {
                if let Some(shell) = slot.shell.as_mut()
                    && let Ok(actual) = shell.cwd()
                    && let Ok(mut remembered) = self.shared.cwd.lock()
                {
                    *remembered = Some(actual);
                }
                (EffectOutcome::not_dispatched(error.code), false)
            }
        };
        let (stdout, stderr) = output.previews().await;
        let (preview_truncated, artifact_truncated) = output.truncated().await;
        let reference = format!("local-shell-artifact://{}", effect.handle);
        outcome.output["taskId"] = json!(effect.handle);
        outcome.output["stdout"] = json!(stdout);
        outcome.output["stderr"] = json!(stderr);
        if preview_truncated {
            outcome.output["truncated"] = json!(true);
        }
        outcome.artifacts = artifact_refs(&reference);
        metadata["status"] = json!(outcome.status);
        metadata["notDispatched"] = json!(outcome.not_dispatched);
        metadata["managedProcessEnded"] = json!(stopped);
        metadata["output"] = outcome.output.clone();
        metadata["truncated"] = json!(artifact_truncated);
        let mut capture = output.observe();
        let status = *capture.borrow();
        if status == OutputStatus::Draining
            && let Some(shell) = slot.shell.as_mut()
        {
            // Late descendants may still own the streams. Publish the artifact
            // metadata only from the owning session after drain observation.
            shell.after_output(async move {
                let _ = capture
                    .wait_for(|status| *status != OutputStatus::Draining)
                    .await;
                let status = *capture.borrow();
                let (_, truncated) = output.truncated().await;
                metadata["truncated"] = json!(truncated);
                metadata["captureStatus"] = json!(capture_status(status));
                let _ = artifacts.finish(&metadata);
            });
        } else {
            metadata["captureStatus"] = json!(capture_status(status));
            if artifacts.finish(&metadata).is_err() {
                artifact_failed(&mut outcome);
            }
        }
        outcome
    }
}

fn capture_status(status: OutputStatus) -> &'static str {
    match status {
        OutputStatus::Fresh => "not_started",
        OutputStatus::Draining => "draining",
        OutputStatus::Sealed => "complete",
        OutputStatus::Incomplete => "incomplete",
    }
}
