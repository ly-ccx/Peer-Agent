use super::*;
use peer_store::ShellArtifacts;
use std::{process::Stdio, time::Duration};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
pub(super) struct ShellProvider {
    pub(super) background: bool,
}
struct ShellEffect {
    args: Value,
    cwd: PathBuf,
    command: String,
    background: bool,
    timeout: Duration,
    handle: String,
    home: PathBuf,
    risk: HostShellRisk,
    port: Option<EffectAdmission>,
}
impl CapabilityProvider for ShellProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let description = if self.background {
            "Run a bounded foreground or background shell command with governed approval. Use shell_stop with the returned task ID to stop a background command."
        } else {
            "Run a bounded foreground shell command in the active workspace with governed approval."
        };
        let mut manifests = vec![(
            "bash".into(),
            json!({"capabilityId":"local.shell.exec","displayName":"Run shell command","description":description,"riskLevel":"L3_sensitive","modeScopes":["chat","goal"],"inputSchema":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"number"},"background":{"type":"boolean"}},"required":["command"],"additionalProperties":false}}),
        )];
        if self.background {
            manifests.push((
                "shell_stop".into(),
                json!({"capabilityId":"local.shell.stop","displayName":"Stop shell task","description":"Stop a background shell task owned by this execution using its opaque task ID.","riskLevel":"L2_low_write","modeScopes":["chat","goal"],"inputSchema":{"type":"object","properties":{"taskId":{"type":"string","minLength":43,"maxLength":43},"reason":{"type":"string"}},"required":["taskId"],"additionalProperties":false}}),
            ));
        }
        manifests
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if self.background && capability == "local.shell.stop" {
            return ShellStop::prepare(args, workspace);
        }
        if capability != "local.shell.exec" {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(&args, &["command", "cwd", "timeoutMs", "background"])?;
        let background = args
            .get("background")
            .map(|value| value.as_bool().ok_or(HostError("invalid_background")))
            .transpose()?
            .unwrap_or(false);
        if background && !self.background {
            return Err(HostError("native_background_shell_unsupported"));
        }
        let command = string(&args, "command")?.trim().to_owned();
        if command.is_empty() || command.len() > 16384 || command.contains('\0') {
            return Err(HostError("invalid_command"));
        }
        let risk = shell_risk::classify(&command).map_err(HostError)?;
        let cwd = if let Some(c) = args.get("cwd") {
            resolve(workspace, c.as_str().ok_or(HostError("invalid_cwd"))?)?
        } else {
            workspace.to_owned()
        };
        if !cwd.is_dir() {
            return Err(HostError("invalid_cwd"));
        }
        let timeout = args
            .get("timeoutMs")
            .map(|v| {
                v.as_u64()
                    .filter(|n| *n > 0 && *n <= 600000)
                    .ok_or(HostError("invalid_timeout"))
            })
            .transpose()?
            .unwrap_or(30000);
        Ok(Box::new(ShellEffect {
            args,
            cwd,
            command,
            background,
            timeout: Duration::from_millis(timeout),
            handle: format!("shell_{}", uuid::Uuid::new_v4()),
            home: home.into(),
            risk,
            port: None,
        }))
    }
}
impl PreparedEffect for ShellEffect {
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Shell
    }
    fn risk(&self) -> Option<HostShellRisk> {
        Some(self.risk)
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        peer_store::provider_execution_scopes(&self.cwd).map_err(Into::into)
    }
    fn handle(&self) -> Option<&str> {
        Some(&self.handle)
    }
    fn owned_command(&self) -> bool {
        true
    }
    fn background_shell(&self) -> bool {
        self.background
    }
    fn start(
        mut self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            match self.run(call, cancel, port).await {
                Ok(outcome) => outcome,
                Err(error) if error.0 == "CANCELLED" => EffectOutcome::not_dispatched(error.0),
                Err(error) => EffectOutcome::failed(error.0),
            }
        }))
    }
}
impl ShellEffect {
    async fn spawn(
        &self,
        port: &EffectAdmission,
        artifacts: &ShellArtifacts,
    ) -> Result<tokio::process::Child, HostError> {
        port.check().await?;
        let mut command = tokio::process::Command::new("/bin/sh");
        command
            .arg("-c")
            .arg(&self.command)
            .current_dir(&self.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(unix)]
        command.process_group(0);
        port.command_starting().await?;
        artifacts
            .check_current()
            .map_err(|_| HostError("shell_artifact_unavailable"))?;
        command.spawn().map_err(|_| HostError("shell_spawn_failed"))
    }
    async fn run(
        self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
        port: EffectAdmission,
    ) -> Result<EffectOutcome, HostError> {
        let now = call.started_at();
        port.check().await?;
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let mut metadata = json!({
            "taskId": self.handle, "toolCallId": call.tool_call_id(),
            "command": self.command, "cwd": self.cwd, "startedAt": now, "status": "running"
        });
        let (mut artifacts, out, err) =
            match ShellArtifacts::begin(&self.home, now, &self.handle, &metadata) {
                Ok(artifacts) => artifacts,
                Err(_) => return Ok(EffectOutcome::not_dispatched("shell_artifact_unavailable")),
            };
        let mut child = match self.spawn(&port, &artifacts).await {
            Ok(child) => child,
            Err(error) => {
                // The spawn seam returned before creating a child.
                let mut outcome = EffectOutcome::not_dispatched(error.0);
                outcome.output =
                    json!({"taskId":self.handle,"interrupted":true,"stopReason":error.0});
                metadata["status"] = json!(outcome.status);
                metadata["managedProcessEnded"] = json!(true);
                metadata["notDispatched"] = json!(true);
                metadata["error"] = json!(error.0);
                if artifacts.finish(&metadata).is_err() {
                    artifact_failed(&mut outcome);
                }
                return Ok(outcome);
            }
        };
        let pid = child.id().expect("newly spawned child has a PID");
        let registered = async {
            port.command_started(pid).await?;
            if !self.background {
                return Ok(());
            }
            let reference = format!("local-shell-artifact://{}", self.handle);
            let artifacts = artifact_refs(&reference);
            port.background_shell_started(EffectOutcome {
                status: "success",
                output: json!({
                    "taskId":self.handle, "backgroundTaskId":self.handle,
                    "toolCallId":call.tool_call_id(), "command":self.command, "cwd":self.cwd,
                    "status":"running", "startedAt":now, "timeoutMs":self.timeout.as_millis(),
                    "artifactRef":reference, "artifactRefs":artifacts,
                }),
                error: None,
                artifacts,
                ended: false,
                materialization: None,
                not_dispatched: false,
            })
            .await
        }
        .await;
        if let Err(error) = registered {
            let ended = terminate(&mut child, pid).await;
            let mut outcome = EffectOutcome::failed(if ended {
                error.0
            } else {
                "execution_outcome_unknown"
            });
            if ended && error.0 == "CANCELLED" {
                outcome.status = "cancelled";
            }
            outcome.ended = ended;
            outcome.output = json!({"taskId":self.handle,"interrupted":true,"stopReason":error.0});
            metadata["status"] = json!(outcome.status);
            metadata["managedProcessEnded"] = json!(ended);
            metadata["error"] = json!(error.0);
            if artifacts.finish(&metadata).is_err() {
                artifact_failed(&mut outcome);
            }
            return Ok(outcome);
        }
        let mut stdout = child.stdout.take().expect("configured piped stdout");
        let mut stderr = child.stderr.take().expect("configured piped stderr");
        let mut out = CapturedStream::new(out);
        let mut err = CapturedStream::new(err);
        let result = {
            let completion = async {
                let (_, _, exit) =
                    tokio::try_join!(out.drain(&mut stdout), err.drain(&mut stderr), async {
                        child.wait().await.map_err(|_| "shell_wait_failed")
                    },)?;
                Ok::<_, &'static str>(exit)
            };
            let completion = tokio::time::timeout(self.timeout, completion);
            tokio::pin!(completion);
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            tick.tick().await;
            loop {
                tokio::select! { biased;
                    _ = cancel.cancelled() => break Err("CANCELLED"),
                    _ = tick.tick(), if !self.background => if let Err(error) = port.check().await { break Err(error.0) },
                    result = &mut completion => break result.unwrap_or(Err("shell_timeout")),
                }
            }
        };
        let ended = if result.is_err() || !group_absent(pid) {
            terminate(&mut child, pid).await
        } else {
            true
        };
        let mut outcome = match result {
            Ok(exit) if ended => EffectOutcome {
                status: if exit.success() { "success" } else { "failed" },
                output: json!({
                    "taskId": self.handle, "stdout": out.preview(), "stderr": err.preview(),
                    "exitCode": exit.code(), "timedOut": false, "cancelled": false,
                }),
                error: None,
                artifacts: vec![],
                ended,
                materialization: None,
                not_dispatched: false,
            },
            Ok(_) => {
                let mut unknown = EffectOutcome::failed("execution_outcome_unknown");
                unknown.output = json!({"taskId":self.handle});
                unknown
            }
            Err(reason) => {
                let mut failed = EffectOutcome::failed(if ended {
                    reason
                } else {
                    "execution_outcome_unknown"
                });
                if reason == "CANCELLED" {
                    failed.status = "cancelled";
                }
                failed.output = json!({
                    "taskId": self.handle, "timedOut": reason == "shell_timeout",
                    "cancelled": reason == "CANCELLED", "interrupted": true, "stopReason": reason,
                    "stdout":out.preview(), "stderr":err.preview(), "exitCode":null,
                });
                failed
            }
        };
        outcome.ended = ended;
        if out.preview_truncated() || err.preview_truncated() {
            outcome.output["truncated"] = json!(true);
        }
        metadata["status"] = json!(outcome.status);
        metadata["output"] = outcome.output.clone();
        metadata["managedProcessEnded"] = json!(ended);
        metadata["truncated"] = json!(out.artifact_truncated || err.artifact_truncated);
        let streams = tokio::join!(out.finish(), err.finish());
        if streams.0.is_err()
            || streams.1.is_err()
            || artifacts.finish(&metadata).is_err()
            || outcome.error == Some("shell_artifact_unavailable")
        {
            artifact_failed(&mut outcome);
            return Ok(outcome);
        }
        let reference = format!("local-shell-artifact://{}", self.handle);
        outcome.artifacts = artifact_refs(&reference);
        Ok(outcome)
    }
}

fn artifact_refs(reference: &str) -> Vec<String> {
    ["stdout", "stderr", "metadata"]
        .into_iter()
        .map(|name| format!("{reference}/{name}"))
        .collect()
}

struct ShellStop {
    args: Value,
    task_id: String,
    workspace: PathBuf,
    port: Option<EffectAdmission>,
}

impl ShellStop {
    fn prepare(args: Value, workspace: &Path) -> Result<Box<dyn PreparedEffect>, HostError> {
        validate_shape(&args, &["taskId", "reason"])?;
        let task_id = string(&args, "taskId")?.trim();
        if !peer_protocol::shell_task_id_valid(task_id) {
            return Err(HostError("invalid_task_id"));
        }
        if args
            .get("reason")
            .is_some_and(|reason| reason.as_str().is_none_or(|reason| reason.len() > 512))
        {
            return Err(HostError("invalid_stop_reason"));
        }
        Ok(Box::new(Self {
            task_id: task_id.into(),
            args,
            workspace: workspace.into(),
            port: None,
        }))
    }
}

impl PreparedEffect for ShellStop {
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port);
    }
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::ShellStop
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        peer_store::provider_execution_scopes(&self.workspace).map_err(Into::into)
    }
    fn start(
        mut self: Box<Self>,
        _: ProviderCall,
        _: CancellationToken,
    ) -> Result<EffectFuture, HostError> {
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        Ok(Box::pin(async move {
            port.stop_background_shell(self.task_id)
                .await
                .unwrap_or_else(|error| {
                    if error.0 == "execution_outcome_unknown" {
                        let mut outcome = EffectOutcome::failed(error.0);
                        outcome.ended = false;
                        outcome
                    } else {
                        EffectOutcome::not_dispatched(error.0)
                    }
                })
        }))
    }
}

fn artifact_failed(outcome: &mut EffectOutcome) {
    outcome.status = "failed";
    outcome.error = Some("execution_outcome_unknown");
    outcome.output["artifactError"] = json!("shell_artifact_unavailable");
}

async fn terminate(child: &mut tokio::process::Child, pid: u32) -> bool {
    if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    let _ = child.start_kill();
    let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait())
        .await
        .is_ok_and(|result| result.is_ok());
    for _ in 0..20 {
        if group_absent(pid) {
            break;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    reaped && group_absent(pid)
}

const PREVIEW_BYTES: usize = 65_536;
const ARTIFACT_BYTES: usize = 2_000_000;

struct CapturedStream {
    file: tokio::fs::File,
    preview: Vec<u8>,
    stored: usize,
    artifact_truncated: bool,
}

impl CapturedStream {
    fn new(file: std::fs::File) -> Self {
        Self {
            file: tokio::fs::File::from_std(file),
            preview: Vec::new(),
            stored: 0,
            artifact_truncated: false,
        }
    }

    async fn drain(&mut self, stream: &mut (impl AsyncRead + Unpin)) -> Result<(), &'static str> {
        let mut chunk = [0; 16_384];
        loop {
            let count = stream
                .read(&mut chunk)
                .await
                .map_err(|_| "shell_output_failed")?;
            if count == 0 {
                return Ok(());
            }
            let preview = count.min(PREVIEW_BYTES.saturating_sub(self.preview.len()));
            self.preview.extend_from_slice(&chunk[..preview]);
            let stored = count.min(ARTIFACT_BYTES.saturating_sub(self.stored));
            if stored != 0 {
                self.file
                    .write_all(&chunk[..stored])
                    .await
                    .map_err(|_| "shell_artifact_unavailable")?;
                self.stored += stored;
            }
            self.artifact_truncated |= stored < count;
        }
    }

    fn preview(&self) -> String {
        String::from_utf8_lossy(&self.preview).into_owned()
    }

    fn preview_truncated(&self) -> bool {
        self.stored > self.preview.len() || self.artifact_truncated
    }

    async fn finish(&mut self) -> std::io::Result<()> {
        if self.artifact_truncated {
            self.file.write_all(b"\n...[artifact truncated]\n").await?;
        }
        self.file.flush().await?;
        self.file.sync_all().await
    }
}

pub(crate) fn group_absent(pid: u32) -> bool {
    rustix::process::Pid::from_raw(pid as i32).is_some_and(|p| {
        rustix::process::test_kill_process_group(p) == Err(rustix::io::Errno::SRCH)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::effect_admission::AdmissionRequest;
    #[tokio::test]
    async fn cancellation_at_durable_starting_is_cancelled_without_spawn_and_seals_its_artifact() {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let mut effect = ShellProvider { background: false }
            .prepare(
                "local.shell.exec",
                json!({"command":"printf forbidden > should-not-exist"}),
                workspace.path(),
                root.path(),
            )
            .unwrap();
        let handle = effect.handle().unwrap().to_owned();
        let cancel = CancellationToken::new();
        let (port, mut requests) = EffectAdmission::channel(&cancel);
        effect.admission(port);
        let at = "2026-11-18T00:00:00.000Z";
        let outcome = effect
            .start(ProviderCall::new("ordinary", "call", at), cancel)
            .unwrap();
        let host = async {
            let mut starting = 0;
            while let Some(request) = requests.recv().await {
                match request {
                    AdmissionRequest::Check(reply) => {
                        reply.send(Ok(())).unwrap();
                    }
                    AdmissionRequest::CommandStarting(reply) => {
                        starting += 1;
                        reply.send(Err(HostError("CANCELLED"))).unwrap();
                    }
                    _ => panic!("no child or connection may be started after denied starting"),
                }
            }
            starting
        };
        let (outcome, starting) = tokio::join!(outcome, host);
        assert_eq!(starting, 1);
        assert_eq!(outcome.status, "cancelled");
        assert_eq!(outcome.error, Some("CANCELLED"));
        assert!(outcome.ended && outcome.not_dispatched);
        assert!(!workspace.path().join("should-not-exist").exists());
        let metadata: Value = serde_json::from_slice(
            &std::fs::read(
                root.path()
                    .join("shell-artifacts/2026-11-18")
                    .join(handle)
                    .join("metadata.json"),
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(metadata["status"], "cancelled");
        assert_eq!(metadata["notDispatched"], true);
        assert_eq!(metadata["managedProcessEnded"], true);
    }
}
