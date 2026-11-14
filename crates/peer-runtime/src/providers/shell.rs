use super::*;
use std::{process::Stdio, time::Duration};
use tokio::io::AsyncReadExt;
pub(super) struct ShellProvider;
struct ShellEffect {
    args: Value,
    cwd: PathBuf,
    command: String,
    timeout: Duration,
    handle: String,
    home: PathBuf,
    risk: HostShellRisk,
}
impl CapabilityProvider for ShellProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        vec![(
            "bash".into(),
            json!({"capabilityId":"local.shell.exec","displayName":"Run shell command","description":"Run a bounded foreground shell command in the active workspace with governed approval. This native migration adapter starts a fresh shell per call; background and persistent shell sessions are unavailable.","riskLevel":"L3_sensitive","modeScopes":["goal"],"inputSchema":{"type":"object","properties":{"command":{"type":"string"},"cwd":{"type":"string"},"timeoutMs":{"type":"number"},"background":{"type":"boolean"}},"required":["command"],"additionalProperties":false}}),
        )]
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != "local.shell.exec" {
            return Err(HostError("tool_not_projected"));
        }
        validate_shape(&args, &["command", "cwd", "timeoutMs", "background"])?;
        if args.get("background").is_some_and(|v| v != false) {
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
            timeout: Duration::from_millis(timeout),
            handle: format!("shell_{}", uuid::Uuid::new_v4()),
            home: home.into(),
            risk,
        }))
    }
}
impl PreparedEffect for ShellEffect {
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
    fn start(
        self: Box<Self>,
        host: &NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        if cancel.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let directory = self
            .home
            .join("shell-artifacts")
            .join(&now[..10])
            .join(&self.handle);
        std::fs::create_dir_all(&directory).map_err(|_| HostError("shell_artifact_unavailable"))?;
        let metadata = json!({"taskId":self.handle,"toolCallId":grant.facts()["toolCallId"],"command":self.command,"cwd":self.cwd,"startedAt":now,"status":"running"});
        std::fs::write(
            directory.join("metadata.json"),
            serde_json::to_vec(&metadata).map_err(|_| HostError("shell_artifact_unavailable"))?,
        )
        .map_err(|_| HostError("shell_artifact_unavailable"))?;
        host.validate_permission(grant, &self.args, now)?;
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
        let mut child = command
            .spawn()
            .map_err(|_| HostError("shell_spawn_failed"))?;
        let pid = child.id().expect("newly spawned child has a PID");
        let mut stdout = child
            .stdout
            .take()
            .expect("spawned stdout was configured as piped");
        let mut stderr = child
            .stderr
            .take()
            .expect("spawned stderr was configured as piped");
        Ok(Box::pin(async move {
            async fn read(
                r: &mut (impl tokio::io::AsyncRead + Unpin),
            ) -> Result<Vec<u8>, &'static str> {
                let mut out = Vec::new();
                r.take(65537)
                    .read_to_end(&mut out)
                    .await
                    .map_err(|_| "shell_output_failed")?;
                if out.len() > 65536 {
                    return Err("shell_output_limit");
                }
                Ok(out)
            }
            let completion = async {
                let (out, err, status) =
                    tokio::try_join!(read(&mut stdout), read(&mut stderr), async {
                        child.wait().await.map_err(|_| "shell_wait_failed")
                    })?;
                Ok::<_, &'static str>((out, err, status))
            };
            let outcome = tokio::select! {biased;_=cancel.cancelled()=>Err("CANCELLED"),r=tokio::time::timeout(self.timeout,completion)=>r.unwrap_or(Err("shell_timeout"))};
            let mut ended = group_absent(pid);
            if outcome.is_err() || !ended {
                if let Some(pid) = rustix::process::Pid::from_raw(pid as i32) {
                    let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
                }
                let _ = child.start_kill();
                let reaped = tokio::time::timeout(Duration::from_secs(2), child.wait())
                    .await
                    .is_ok_and(|r| r.is_ok());
                for _ in 0..20 {
                    if group_absent(pid) {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                ended = reaped && group_absent(pid);
            }
            let (status, output, error) = match outcome {
                Ok((out, err, exit)) if ended => (
                    if exit.success() { "success" } else { "failed" },
                    json!({"taskId":self.handle,"stdout":String::from_utf8_lossy(&out),"stderr":String::from_utf8_lossy(&err),"exitCode":exit.code(),"timedOut":false,"cancelled":false}),
                    None,
                ),
                Ok(_) => (
                    "failed",
                    json!({"taskId":self.handle}),
                    Some("execution_outcome_unknown"),
                ),
                Err(reason) => (
                    if reason == "CANCELLED" {
                        "cancelled"
                    } else {
                        "failed"
                    },
                    json!({"taskId":self.handle,"timedOut":reason=="shell_timeout","cancelled":reason=="CANCELLED","interrupted":true,"stopReason":reason}),
                    Some(if ended {
                        reason
                    } else {
                        "execution_outcome_unknown"
                    }),
                ),
            };
            let mut metadata = metadata;
            metadata["status"] = json!(status);
            metadata["output"] = output.clone();
            metadata["managedProcessEnded"] = json!(ended);
            let artifact = || -> std::io::Result<()> {
                for (name, bytes) in [
                    (
                        "stdout.txt",
                        output["stdout"].as_str().unwrap_or("").as_bytes().to_vec(),
                    ),
                    (
                        "stderr.txt",
                        output["stderr"].as_str().unwrap_or("").as_bytes().to_vec(),
                    ),
                    ("metadata.json", serde_json::to_vec(&metadata)?),
                ] {
                    let mut f = std::fs::File::create(directory.join(name))?;
                    std::io::Write::write_all(&mut f, &bytes)?;
                    f.sync_all()?;
                }
                std::fs::File::open(&directory)?.sync_all()
            };
            if artifact().is_err() {
                return EffectOutcome {
                    status: "failed",
                    output,
                    error: Some("execution_outcome_unknown"),
                    artifacts: vec![],
                    ended,
                    materialization: None,
                };
            }
            let reference = format!("local-shell-artifact://{}", self.handle);
            EffectOutcome {
                status,
                output,
                error,
                artifacts: vec![
                    format!("{reference}/stdout"),
                    format!("{reference}/stderr"),
                    format!("{reference}/metadata"),
                ],
                ended,
                materialization: None,
            }
        }))
    }
}
fn group_absent(pid: u32) -> bool {
    rustix::process::Pid::from_raw(pid as i32).is_some_and(|p| {
        rustix::process::test_kill_process_group(p) == Err(rustix::io::Errno::SRCH)
    })
}
