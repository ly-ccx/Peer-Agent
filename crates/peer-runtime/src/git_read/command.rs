//! Actual process ownership, cumulative byte accounting and bounded execution.
use super::*;
use std::{
    process::Stdio,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
};
use tokio::{
    io::{AsyncRead, AsyncReadExt},
    process::Command,
};
pub(crate) struct Output {
    pub code: i32,
    pub stdout: Vec<u8>,
    pub stderr: Vec<u8>,
    pub execution_elapsed: Duration,
}
/// Reconciliation keeps its absolute total deadline. A tool separately owns
/// bounded Host admission, then charges only its real launched command window.
#[derive(Clone, Copy)]
pub(crate) enum Deadline {
    Total(tokio::time::Instant),
    Execution(Duration),
}
pub(crate) struct Request<'a> {
    pub binary: &'a Path,
    pub cwd: &'a Path,
    pub binding: &'a [String],
    pub filters: &'a [String],
    pub common: Option<&'a Path>,
    pub args: &'a [&'a str],
    pub budget: &'a mut usize,
    pub deadline: Deadline,
    pub authority: &'a dyn GitReadAuthority,
    pub cancel: &'a CancellationToken,
}
async fn collect(
    mut input: impl AsyncRead + Unpin,
    budget: Arc<AtomicUsize>,
) -> Result<Vec<u8>, GitReadError> {
    let mut output = Vec::new();
    let mut buf = [0; 4096];
    loop {
        let count = input
            .read(&mut buf)
            .await
            .map_err(|_| GitReadError::new("git_query_failed"))?;
        if count == 0 {
            return Ok(output);
        }
        // Keep the shared stdout/stderr reservation atomic without depending
        // on the newer try_update API (the CLI's MSRV remains 1.88).
        let mut available = budget.load(Ordering::Acquire);
        loop {
            let remaining = available
                .checked_sub(count)
                .ok_or_else(|| GitReadError::new("git_query_output_limit"))?;
            match budget.compare_exchange_weak(
                available,
                remaining,
                Ordering::AcqRel,
                Ordering::Acquire,
            ) {
                Ok(_) => break,
                Err(current) => available = current,
            }
        }
        output.extend_from_slice(&buf[..count]);
    }
}
pub(crate) async fn run(request: Request<'_>) -> Result<Output, GitReadError> {
    let mut command = Command::new(request.binary);
    command
        .args([
            "--no-pager",
            "--no-optional-locks",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.untrackedCache=false",
            "-c",
            "core.hooksPath=/dev/null",
            "-c",
            "gc.auto=0",
            "-c",
            "maintenance.auto=false",
            "-c",
            "core.quotePath=false",
            "-c",
            "log.showSignature=false",
            "-c",
            "status.submoduleSummary=false",
        ])
        .args(request.binding)
        .args(request.filters)
        .args(request.args)
        .current_dir(request.cwd)
        .env_clear()
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    for (key, value) in std::env::vars_os() {
        let name = key.to_string_lossy().to_ascii_uppercase();
        if !name.starts_with("GIT_") && !matches!(name.as_str(), "PAGER" | "LESS" | "LV") {
            command.env(key, value);
        }
    }
    for (key, value) in [
        ("GIT_OPTIONAL_LOCKS", "0"),
        ("GIT_TERMINAL_PROMPT", "0"),
        ("GIT_NO_LAZY_FETCH", "1"),
        ("GIT_ATTR_NOSYSTEM", "1"),
        ("GIT_ALLOW_PROTOCOL", ""),
        ("GIT_NO_REPLACE_OBJECTS", "1"),
        ("LC_ALL", "C"),
        ("LANG", "C"),
    ] {
        command.env(key, value);
    }
    if let Some(common) = request.common {
        command.env("GIT_COMMON_DIR", common);
    }
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(crate::recorder::CREATE_NO_WINDOW);
    }
    request.authority.check().await?;
    let (admission_deadline, admission_error) = match request.deadline {
        Deadline::Total(deadline) => (deadline, "git_query_timeout"),
        Deadline::Execution(_) => (
            tokio::time::Instant::now() + Duration::from_secs(5),
            "git_query_admission_timeout",
        ),
    };
    tokio::time::timeout_at(admission_deadline, request.authority.starting())
        .await
        .map_err(|_| GitReadError::new(admission_error))??;
    request.authority.check().await?;
    if request.cancel.is_cancelled() {
        return Err(GitReadError::new("git_query_cancelled"));
    }
    let execution_start = tokio::time::Instant::now();
    let deadline = match request.deadline {
        Deadline::Total(deadline) => deadline,
        Deadline::Execution(wait) => execution_start + wait,
    };
    if execution_start >= deadline {
        return Err(GitReadError::new("git_query_timeout"));
    }
    let mut child = command.spawn().map_err(|e| {
        GitReadError::new(match e.kind() {
            std::io::ErrorKind::NotFound => "git_unavailable",
            std::io::ErrorKind::PermissionDenied => "git_execution_permission_denied",
            _ => "git_query_spawn_failed",
        })
    })?;
    // Capture the group while still owned. child.id() becomes None when wait
    // reaps the parent, even if a descendant still holds its output pipes.
    let pid = child.id().expect("spawned process has pid");
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let mut registration = Box::pin(request.authority.spawned(pid));
    let mut registered = false;
    let recorded = tokio::select! {biased;
        _=request.cancel.cancelled()=>Err(GitReadError::new("git_query_cancelled")),
        _=tokio::time::sleep_until(deadline)=>Err(GitReadError::new("git_query_timeout")),
        result=&mut registration=>{registered=true;result}
    };
    if let Err(error) = recorded {
        let stopped = stop_group(pid, &mut child).await;
        // Join the recorder/ack owner after stopping Git. Cancelling an input
        // future must not abandon its own OS observation subprocess or reply.
        if !registered {
            let _ = registration.await;
        }
        stopped?;
        return Err(error);
    }
    let budget = Arc::new(AtomicUsize::new(*request.budget));
    let result = {
        let work = async {
            tokio::try_join!(
                collect(stdout, budget.clone()),
                collect(stderr, budget.clone()),
                async {
                    child
                        .wait()
                        .await
                        .map_err(|_| GitReadError::new("git_query_failed"))
                }
            )
        };
        tokio::pin!(work);
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.tick().await;
        loop {
            tokio::select! {biased;
                _=request.cancel.cancelled()=>break Err(GitReadError::new("git_query_cancelled")),
                _=tokio::time::sleep_until(deadline)=>break Err(GitReadError::new("git_query_timeout")),
                _=tick.tick()=>if let Err(e)=request.authority.check().await {break Err(e)},
                result=&mut work=>break result,
            }
        }
    };
    *request.budget = budget.load(Ordering::Acquire);
    match result {
        Ok((out, err, status)) => {
            if !crate::providers::group_absent(pid) {
                stop_group(pid, &mut child).await?;
                return Err(GitReadError::new("git_query_child_leak"));
            }
            Ok(Output {
                code: status
                    .code()
                    .ok_or_else(|| GitReadError::new("git_query_failed"))?,
                stdout: out,
                stderr: err,
                execution_elapsed: execution_start.elapsed(),
            })
        }
        Err(e) => {
            stop_group(pid, &mut child).await?;
            Err(e)
        }
    }
}
async fn stop_group(pid: u32, child: &mut tokio::process::Child) -> Result<(), GitReadError> {
    if crate::recorder::stop_owned_group(child, pid, Duration::from_secs(2)).await {
        Ok(())
    } else {
        Err(GitReadError {
            code: "git_query_stop_unconfirmed",
            ended: false,
        })
    }
}
