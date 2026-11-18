//! Ordered command exchange over one owned POSIX shell process group.
//! The caller must hold the actual live registration and effect admission.
mod cwd;
mod frame;
mod output;
#[cfg(test)]
mod tests;

use super::{group_absent, terminate};
use crate::CancellationToken;
use output::{CommandPipes, OutputCapture};
pub(super) use output::{OutputStatus, SessionOutput};
use std::{
    future::Future,
    io,
    os::{fd::OwnedFd, unix::net::UnixStream},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    io::AsyncWriteExt,
    net::unix::{OwnedReadHalf, OwnedWriteHalf},
    process::Child,
    task::JoinSet,
};

const CONTROL: u8 = 3;
const OUTPUT_FENCE: u8 = 4;
const ERROR_FENCE: u8 = 5;
const ADMISSION_LIMIT: Duration = Duration::from_secs(5);
const FIFO_READ_RECHECK: Duration = Duration::from_millis(100);
const MAX_DRAINING_OUTPUTS: usize = 32;

pub(super) struct ShellSession {
    child: Child,
    pid: u32,
    input: OwnedWriteHalf,
    control: OwnedReadHalf,
    drains: JoinSet<()>,
    bootstrapped: bool,
    ready: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct Exit {
    pub(super) code: u8,
    pub(super) cwd: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub(super) struct ExchangeError {
    pub(super) code: &'static str,
    // A partial pipe write might already have submitted a command.
    pub(super) may_have_dispatched: bool,
}

pub(super) struct Exchange<'a> {
    pub(super) command: &'a str,
    pub(super) cwd: &'a Path,
    pub(super) change_cwd: bool,
    pub(super) timeout: Duration,
    pub(super) cancel: &'a CancellationToken,
    pub(super) output: &'a SessionOutput,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum AdmissionPoint {
    DirectoryChange,
    CommandWrite,
}

impl ShellSession {
    /// The Host records spawn intent before this call, then binds pid and the
    /// actual recorder before allowing the first exchange.
    pub(super) fn spawn(cwd: &Path) -> io::Result<Self> {
        Self::spawn_with(cwd, Path::new("/bin/sh"))
    }

    fn spawn_with(cwd: &Path, program: &Path) -> io::Result<Self> {
        let (receive, send) = UnixStream::pair()?;
        receive.set_nonblocking(true)?;
        let (control, input) = tokio::net::UnixStream::from_std(receive)?.into_split();
        let mut command = tokio::process::Command::new(program);
        command
            .arg("-s")
            .current_dir(cwd)
            .env_remove("ENV")
            .env_remove("BASH_ENV")
            .stdin(Stdio::from(OwnedFd::from(send)))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0)
            .kill_on_drop(true);
        let child = command.spawn()?;
        let pid = child.id().expect("newly spawned shell has a PID");
        Ok(Self {
            child,
            pid,
            input,
            control,
            drains: JoinSet::new(),
            bootstrapped: false,
            ready: true,
        })
    }

    pub(super) fn pid(&self) -> u32 {
        self.pid
    }

    pub(super) fn cwd(&mut self) -> Result<PathBuf, &'static str> {
        if self
            .child
            .try_wait()
            .map_err(|_| "shell_wait_failed")?
            .is_some()
        {
            return Err("shell_session_closed");
        }
        let cwd = cwd::observe(self.pid).ok_or("shell_session_cwd_unproven")?;
        if self
            .child
            .try_wait()
            .map_err(|_| "shell_wait_failed")?
            .is_some()
        {
            return Err("shell_session_closed");
        }
        Ok(cwd)
    }

    /// Poll the Host's admission future after preparation and check the
    /// actual directory again at the pipe-write boundary.
    pub(super) async fn exchange<F: Future<Output = Result<(), &'static str>>>(
        &mut self,
        call: Exchange<'_>,
        mut admit: impl FnMut(AdmissionPoint) -> F,
    ) -> Result<Exit, ExchangeError> {
        let before_write = |code| ExchangeError {
            code,
            may_have_dispatched: false,
        };
        if !self.ready {
            return Err(before_write("shell_session_closed"));
        }
        while self.drains.try_join_next().is_some() {}
        if self.drains.len() >= MAX_DRAINING_OUTPUTS {
            return Err(before_write("shell_session_output_limit"));
        }
        let original = self.cwd().map_err(before_write)?;
        if !call.change_cwd && original != call.cwd {
            return Err(before_write("shell_session_cwd_changed"));
        }
        let pipes =
            CommandPipes::new().map_err(|_| before_write("shell_session_output_unavailable"))?;
        let (stdout, stderr) = pipes.paths();
        let frame = frame::CommandFrame::new(call.command, stdout, stderr).map_err(before_write)?;
        let deadline = tokio::time::Instant::now() + ADMISSION_LIMIT;
        let admitted_cwd = if call.change_cwd && original != call.cwd {
            let change = frame::CommandFrame::change_directory(call.cwd).map_err(before_write)?;
            authorize(
                call.cancel,
                &mut admit,
                AdmissionPoint::DirectoryChange,
                deadline,
            )
            .await
            .map_err(before_write)?;
            if self.cwd().map_err(before_write)? != original {
                return Err(before_write("shell_session_cwd_changed"));
            }
            let changed = self
                .run_frame(change, None, call.cancel, deadline)
                .await
                .map_err(before_write)?;
            if changed.code != 0 || changed.cwd != call.cwd {
                return Err(before_write("shell_session_cwd_changed"));
            }
            changed.cwd
        } else {
            original
        };
        authorize(
            call.cancel,
            &mut admit,
            AdmissionPoint::CommandWrite,
            deadline,
        )
        .await
        .map_err(before_write)?;
        if self.cwd().map_err(before_write)? != admitted_cwd {
            return Err(before_write("shell_session_cwd_changed"));
        }
        if tokio::time::Instant::now() >= deadline || call.cancel.is_cancelled() {
            return Err(before_write(if call.cancel.is_cancelled() {
                "CANCELLED"
            } else {
                "shell_session_admission_timeout"
            }));
        }
        pipes
            .check_current()
            .map_err(|_| before_write("shell_session_output_changed"))?;
        let output = call.output.claim().map_err(before_write)?;
        let mut capture = output.capture(pipes, frame.marker.clone(), &mut self.drains);
        let deadline = tokio::time::Instant::now() + call.timeout;
        let result = self
            .run_frame(frame, Some(&mut capture), call.cancel, deadline)
            .await;
        capture.finish(result.is_ok());
        result.map_err(|code| ExchangeError {
            code,
            may_have_dispatched: true,
        })
    }

    async fn run_frame(
        &mut self,
        frame: frame::CommandFrame,
        output: Option<&mut OutputCapture>,
        cancel: &CancellationToken,
        deadline: tokio::time::Instant,
    ) -> Result<Exit, &'static str> {
        self.ready = false;
        let operation = async {
            if !self.bootstrapped {
                // Stdin is a full-duplex socket. The shell duplicates it for
                // control replies. Neither that descriptor nor stdin is
                // available inside model payloads.
                let init = format!("exec {CONTROL}>&0\n");
                self.input
                    .write_all(init.as_bytes())
                    .await
                    .map_err(|_| "shell_session_write_failed")?;
                self.bootstrapped = true;
            }
            self.input
                .write_all(frame.script.as_bytes())
                .await
                .map_err(|_| "shell_session_write_failed")?;
            let control = frame::exit_code(&mut self.control, &frame.marker);
            let code = if let Some(capture) = output {
                let (_, code) = tokio::try_join!(capture.fences(), control)?;
                code
            } else {
                control.await?
            };
            let cwd = self.cwd()?;
            Ok(Exit { code, cwd })
        };
        let result = tokio::select! {
            biased;
            _ = cancel.cancelled() => Err("CANCELLED"),
            result = tokio::time::timeout_at(deadline, operation) =>
                result.unwrap_or(Err("shell_timeout")),
        };
        self.ready = result.is_ok();
        result
    }

    pub(super) fn after_output(&mut self, task: impl Future<Output = ()> + Send + 'static) {
        self.drains.spawn(task);
    }

    /// Consumes this owner. Only this actual wait and group observation can
    /// acknowledge the handle as ended or allow a new shell generation.
    pub(super) async fn stop(mut self) -> bool {
        let stopped = match self.child.try_wait() {
            Ok(None) => terminate(&mut self.child, self.pid).await,
            // Once reaped, the PID alone cannot authorize a signal. Preserve
            // any remaining or replaced group as unproven.
            Ok(Some(_)) => group_absent(self.pid),
            Err(_) => false,
        };
        if stopped {
            let drained = async { while self.drains.join_next().await.is_some() {} };
            let _ = tokio::time::timeout(Duration::from_secs(2), drained).await;
        }
        // Dropping the join set cancels any drain that still has an unclosed
        // writer, and its output receipt remains incomplete.
        stopped
    }
}

async fn authorize<F: Future<Output = Result<(), &'static str>>>(
    cancel: &CancellationToken,
    admit: &mut impl FnMut(AdmissionPoint) -> F,
    point: AdmissionPoint,
    deadline: tokio::time::Instant,
) -> Result<(), &'static str> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err("CANCELLED"),
        result = tokio::time::timeout_at(deadline, admit(point)) =>
            result.unwrap_or(Err("shell_session_admission_timeout")),
    }
}
