//! Bounded process adapter for user-configured Hooks. A Host owns reservation,
//! child identity, current authority and the terminal publication.
use crate::{
    CancellationToken,
    capability::CapabilityError as HostError,
    hook_policy::{HookDecision, HookVerdict, hook_verdict},
    recorder::{group_absent, stop_owned_group},
};
use peer_store::{HookDefinition, HookPhase};
use serde_json::{Value, json};
use std::{
    path::Path,
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, AsyncWriteExt},
    process::{Child, Command},
};

const LIMIT: usize = 64 * 1024;

pub(crate) trait HookProcessOwner {
    fn starting(&mut self) -> Result<(), HostError>;
    async fn spawned(&mut self, pid: u32) -> Result<(), HostError>;
    fn current(&mut self) -> Result<(), HostError>;
}

pub(crate) struct HookObservation {
    pub verdict: HookVerdict,
    pub exit_code: Option<i32>,
    pub duration_ms: u64,
    pub ended: bool,
    pub interrupted: Option<HostError>,
}

pub(crate) fn rule_digest(hook: &HookDefinition) -> Result<String, HostError> {
    peer_protocol::javascript_json_digest(&json!({
        "id":hook.id,"command":hook.command,"capability":hook.capability_pattern,
        "arguments":hook.argument_pattern,"timeoutMs":hook.timeout_ms,"failOpen":hook.fail_open
    }))
    .map_err(|_| HostError("hook_config_invalid"))
}

pub(crate) fn decision_name(decision: HookDecision) -> &'static str {
    match decision {
        HookDecision::Allow => "allow",
        HookDecision::Ask => "ask",
        HookDecision::Deny => "deny",
    }
}

pub(crate) fn evidence_record(
    hook: &HookDefinition,
    phase: HookPhase,
    digest: &str,
    handle: &str,
    observation: &HookObservation,
) -> Value {
    let safe =
        |text: &str| -> String { text.chars().filter(|c| !c.is_control()).take(256).collect() };
    let id = if hook.id == hook.command {
        format!("hook-{}", &digest[..16])
    } else {
        safe(&hook.id)
    };
    json!({"id":id,"hookId":id,"event":phase.name(),"ruleDigest":digest,
        "handleId":handle,"decision":decision_name(observation.verdict.decision),
        "reason":observation.verdict.reason.as_deref().map(safe),"outcome":observation.verdict.outcome,
        "exitCode":observation.exit_code,"durationMs":observation.duration_ms})
}

pub(crate) async fn run_hook(
    hook: &HookDefinition,
    phase: HookPhase,
    workspace: &Path,
    input: &[u8],
    cancel: &CancellationToken,
    owner: &mut impl HookProcessOwner,
) -> Result<HookObservation, HostError> {
    if input.len() > 1024 * 1024 {
        return Err(HostError("hook_input_limit"));
    }
    owner.current()?;
    if cancel.is_cancelled() {
        return Err(HostError("CANCELLED"));
    }
    let started = Instant::now();
    let verdict = |exit, stdout: &[u8], failure, ended, interrupted| HookObservation {
        verdict: hook_verdict(phase, exit, stdout, failure, hook.fail_open),
        exit_code: exit,
        duration_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        ended,
        interrupted,
    };
    let mut command = Command::new("/bin/sh");
    command
        .arg("-c")
        .arg(&hook.command)
        .current_dir(workspace)
        .env_clear()
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .process_group(0);
    for key in ["PATH", "LANG", "LC_ALL", "LC_CTYPE", "TZ"] {
        if let Some(value) = std::env::var_os(key) {
            command.env(key, value);
        }
    }
    if let Err(error) = owner.starting() {
        return Ok(verdict(None, b"", Some(error.0), true, Some(error)));
    }
    let Ok(mut child) = command.spawn() else {
        return Ok(verdict(None, b"", Some("spawn_error"), true, None));
    };
    // The configured timeout governs the spawned command. The Host can take
    // time to persist its launch intent before the command exists.
    let deadline = tokio::time::Instant::now() + Duration::from_millis(hook.timeout_ms);
    let pid = child.id().expect("newly spawned hook has a PID");
    if let Err(error) = owner.spawned(pid).await {
        let ended = stop(&mut child, pid).await;
        return Ok(verdict(None, b"", Some(error.0), ended, Some(error)));
    }
    let mut input_pipe = child.stdin.take().expect("hook stdin pipe");
    let mut stdout = child.stdout.take().expect("hook stdout pipe");
    let mut stderr = child.stderr.take().expect("hook stderr pipe");
    let completed = {
        let completion = async {
            let send = async {
                let result = input_pipe.write_all(input).await;
                drop(input_pipe);
                match result {
                    Ok(()) => Ok(()),
                    Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => Ok(()),
                    Err(_) => Err(HostError("stdin_error")),
                }
            };
            let wait = async { child.wait().await.map_err(|_| HostError("wait_error")) };
            let (_, stdout, _, status) =
                tokio::try_join!(send, read(&mut stdout), read(&mut stderr), wait)?;
            Ok::<_, HostError>((stdout, status.code()))
        };
        let completion = tokio::time::timeout_at(deadline, completion);
        tokio::pin!(completion);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        loop {
            tokio::select! { biased;
                _=cancel.cancelled()=>break Err((HostError("CANCELLED"),true)),
                _=tick.tick()=>if let Err(error)=owner.current(){break Err((error,true));},
                outcome=&mut completion=>break outcome
                    .unwrap_or(Err(HostError("timeout"))).map_err(|error|(error,false)),
            }
        }
    };
    match completed {
        Ok((stdout, exit)) if group_absent(pid) => {
            if let Err(error) = owner.current() {
                return Ok(verdict(exit, b"", Some(error.0), true, Some(error)));
            }
            Ok(verdict(exit, &stdout, None, true, None))
        }
        Ok((_, exit)) => {
            let ended = stop(&mut child, pid).await;
            Ok(verdict(exit, b"", Some("descendants_running"), ended, None))
        }
        Err((error, interrupted)) => {
            let ended = stop(&mut child, pid).await;
            Ok(verdict(
                None,
                b"",
                Some(error.0),
                ended,
                interrupted.then_some(error),
            ))
        }
    }
}

async fn read(pipe: &mut (impl AsyncRead + Unpin)) -> Result<Vec<u8>, HostError> {
    let mut bytes = Vec::new();
    pipe.take((LIMIT + 1) as u64)
        .read_to_end(&mut bytes)
        .await
        .map_err(|_| HostError("read_error"))?;
    if bytes.len() > LIMIT {
        return Err(HostError("output_limit"));
    }
    Ok(bytes)
}

async fn stop(child: &mut Child, pid: u32) -> bool {
    stop_owned_group(child, pid, Duration::from_millis(2200)).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hook_policy::HookDecision;

    struct Owner {
        started: bool,
        pid: Option<u32>,
        cancel_after_spawn: Option<CancellationToken>,
        preparation_delay: Duration,
    }
    impl HookProcessOwner for Owner {
        fn starting(&mut self) -> Result<(), HostError> {
            assert!(!self.started);
            self.started = true;
            std::thread::sleep(self.preparation_delay);
            Ok(())
        }
        async fn spawned(&mut self, pid: u32) -> Result<(), HostError> {
            assert!(self.started);
            assert!(
                crate::recorder::process_recorder(pid, "hook-test", "2026-11-18T00:00:00Z",)
                    .await
                    .is_some(),
                "the actual child must be observable, including fast exit"
            );
            self.pid = Some(pid);
            if let Some(cancel) = &self.cancel_after_spawn {
                cancel.cancel();
            }
            Ok(())
        }
        fn current(&mut self) -> Result<(), HostError> {
            Ok(())
        }
    }
    fn hook(command: &str, timeout_ms: u64) -> HookDefinition {
        HookDefinition {
            id: "fixture".into(),
            command: command.into(),
            capability_pattern: "*".into(),
            argument_pattern: None,
            timeout_ms,
            fail_open: false,
        }
    }

    #[tokio::test]
    async fn fast_legacy_hook_can_finish_without_reading_the_pipe() {
        let root = tempfile::tempdir().unwrap();
        let mut owner = Owner {
            started: false,
            pid: None,
            cancel_after_spawn: None,
            preparation_delay: Duration::ZERO,
        };
        let input = vec![b'x'; 128 * 1024];
        let result = run_hook(
            &hook(
                r#"printf '%s' '{"decision":"deny","reason":"fixture"}'; exit 3"#,
                3000,
            ),
            HookPhase::PreToolUse,
            root.path(),
            &input,
            &CancellationToken::new(),
            &mut owner,
        )
        .await
        .unwrap();
        assert!(result.ended && group_absent(owner.pid.unwrap()));
        assert_eq!(result.exit_code, Some(3));
        assert_eq!(result.verdict.decision, HookDecision::Deny);
        assert_eq!(result.verdict.reason.as_deref(), Some("fixture"));
        assert!(result.interrupted.is_none());
        assert!(result.duration_ms < 3000);
    }

    #[tokio::test]
    async fn durable_preparation_does_not_consume_the_running_command_deadline() {
        let root = tempfile::tempdir().unwrap();
        let mut owner = Owner {
            started: false,
            pid: None,
            cancel_after_spawn: None,
            preparation_delay: Duration::from_millis(1000),
        };
        let result = run_hook(
            &hook(
                r#"/bin/sleep 0.15; printf '%s' '{"decision":"deny","reason":"policy"}'"#,
                700,
            ),
            HookPhase::PreToolUse,
            root.path(),
            b"{}",
            &CancellationToken::new(),
            &mut owner,
        )
        .await
        .unwrap();
        assert!(result.ended && group_absent(owner.pid.unwrap()));
        assert_eq!(result.verdict.outcome, "ok");
        assert_eq!(result.verdict.decision, HookDecision::Deny);
        assert_eq!(result.verdict.reason.as_deref(), Some("policy"));
    }

    #[tokio::test]
    async fn real_timeout_and_cancellation_reap_the_owned_process() {
        let root = tempfile::tempdir().unwrap();
        for reason in ["timeout", "CANCELLED"] {
            let cancel = CancellationToken::new();
            let mut owner = Owner {
                started: false,
                pid: None,
                cancel_after_spawn: (reason == "CANCELLED").then(|| cancel.clone()),
                preparation_delay: Duration::ZERO,
            };
            let result = run_hook(
                &hook("exec /bin/sleep 30", 100),
                HookPhase::PreToolUse,
                root.path(),
                b"{}",
                &cancel,
                &mut owner,
            )
            .await
            .unwrap();
            assert!(result.ended && group_absent(owner.pid.unwrap()));
            assert_eq!(result.verdict.outcome, reason);
            assert_eq!(result.verdict.decision, HookDecision::Deny);
        }
    }
}
