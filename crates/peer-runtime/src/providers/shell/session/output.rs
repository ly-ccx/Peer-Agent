//! Per-command data pipes. Descendants keep their original stdout/stderr even
//! after the interpreter has accepted another command.
use super::super::CapturedStream;
use rustix::fs::{self, Mode, OFlags};
use std::{
    fs::File,
    io::{self, Read},
    os::unix::fs::{FileTypeExt, MetadataExt},
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
    task::{Context, Poll, ready},
};
use tokio::{
    io::{AsyncRead, AsyncReadExt, BufReader, ReadBuf, unix::AsyncFd},
    sync::{Mutex, oneshot, watch},
    task::JoinSet,
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(in super::super) enum OutputStatus {
    Fresh,
    Draining,
    Sealed,
    Incomplete,
}

struct OutputFiles {
    out: Mutex<CapturedStream>,
    err: Mutex<CapturedStream>,
    status: watch::Sender<OutputStatus>,
}

#[derive(Clone)]
pub(in super::super) struct SessionOutput {
    files: Arc<OutputFiles>,
}

impl SessionOutput {
    pub(in super::super) fn new(out: CapturedStream, err: CapturedStream) -> Self {
        Self {
            files: Arc::new(OutputFiles {
                out: Mutex::new(out),
                err: Mutex::new(err),
                status: watch::Sender::new(OutputStatus::Fresh),
            }),
        }
    }

    pub(super) fn claim(&self) -> Result<OutputOwner, &'static str> {
        if !self.files.status.send_if_modified(|status| {
            if *status != OutputStatus::Fresh {
                return false;
            }
            *status = OutputStatus::Draining;
            true
        }) {
            return Err("shell_session_output_already_used");
        }
        Ok(OutputOwner(self.clone()))
    }

    pub(in super::super) fn observe(&self) -> watch::Receiver<OutputStatus> {
        self.files.status.subscribe()
    }

    pub(in super::super) async fn previews(&self) -> (String, String) {
        let out = self.files.out.lock().await.preview();
        let err = self.files.err.lock().await.preview();
        (out, err)
    }

    pub(in super::super) async fn truncated(&self) -> (bool, bool) {
        let out = self.files.out.lock().await;
        let err = self.files.err.lock().await;
        (
            out.preview_truncated() || err.preview_truncated(),
            out.artifact_truncated || err.artifact_truncated,
        )
    }

    #[cfg(test)]
    pub(super) async fn snapshot(&self) -> (OutputSnapshot, OutputSnapshot) {
        async fn get(stream: &Mutex<CapturedStream>) -> OutputSnapshot {
            let stream = stream.lock().await;
            OutputSnapshot {
                preview: stream.preview.clone(),
                stored: stream.stored,
                artifact_truncated: stream.artifact_truncated,
            }
        }
        (get(&self.files.out).await, get(&self.files.err).await)
    }
}

#[cfg(test)]
pub(super) struct OutputSnapshot {
    pub(super) preview: Vec<u8>,
    pub(super) stored: usize,
    pub(super) artifact_truncated: bool,
}

pub(super) struct OutputOwner(SessionOutput);

impl OutputOwner {
    pub(super) fn capture(
        self,
        pipes: CommandPipes,
        marker: Vec<u8>,
        drains: &mut JoinSet<()>,
    ) -> OutputCapture {
        let CommandPipes {
            out:
                Pipe {
                    stream: out,
                    keepalive: out_writer,
                    ..
                },
            err:
                Pipe {
                    stream: err,
                    keepalive: err_writer,
                    ..
                },
            _directory: directory,
        } = pipes;
        let (out_fence, stdout) = oneshot::channel();
        let (err_fence, stderr) = oneshot::channel();
        let (complete, framed) = oneshot::channel();
        // Keep the fence readers running after a timeout or lost control
        // packet. They own any bytes consumed while checking a split fence.
        drains.spawn(async move {
            let (out, err) = tokio::join!(
                capture_stream(out, &self.0.files.out, &marker, out_fence),
                capture_stream(err, &self.0.files.err, &marker, err_fence),
            );
            if framed.await.unwrap_or(false) && out.is_ok() && err.is_ok() {
                self.0.files.status.send_replace(OutputStatus::Sealed);
            }
            drop(directory);
        });
        OutputCapture {
            stdout,
            stderr,
            complete,
            _keepalive: [out_writer, err_writer],
        }
    }
}

type FenceResult = Result<(), &'static str>;

pub(super) struct OutputCapture {
    stdout: oneshot::Receiver<FenceResult>,
    stderr: oneshot::Receiver<FenceResult>,
    complete: oneshot::Sender<bool>,
    _keepalive: [File; 2],
}

impl OutputCapture {
    pub(super) async fn fences(&mut self) -> FenceResult {
        async fn receive(fence: &mut oneshot::Receiver<FenceResult>) -> FenceResult {
            fence.await.unwrap_or(Err("shell_output_failed"))
        }

        tokio::try_join!(receive(&mut self.stdout), receive(&mut self.stderr))?;
        Ok(())
    }

    pub(super) fn finish(self, framed: bool) {
        let _ = self.complete.send(framed);
        // Closing the temporary writers lets both readers observe real EOF.
    }
}

async fn capture_stream(
    mut stream: BufReader<PipeReader>,
    output: &Mutex<CapturedStream>,
    marker: &[u8],
    fence: oneshot::Sender<FenceResult>,
) -> FenceResult {
    let observed = {
        let mut captured = output.lock().await;
        super::frame::capture(&mut stream, marker, &mut captured).await
    };
    let _ = fence.send(observed);
    let synchronized = finish_stream(&mut stream, output).await;
    observed.and(synchronized)
}

impl Drop for OutputOwner {
    fn drop(&mut self) {
        self.0.files.status.send_if_modified(|status| {
            if *status != OutputStatus::Draining {
                return false;
            }
            *status = OutputStatus::Incomplete;
            true
        });
    }
}

pub(super) struct CommandPipes {
    out: Pipe,
    err: Pipe,
    _directory: tempfile::TempDir,
}

impl CommandPipes {
    pub(super) fn new() -> io::Result<Self> {
        let directory = tempfile::Builder::new().prefix("peer-shell-").tempdir()?;
        let dir = File::from(fs::open(
            directory.path(),
            OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC,
            Mode::empty(),
        )?);
        Ok(Self {
            out: Pipe::new(directory.path(), &dir, "stdout")?,
            err: Pipe::new(directory.path(), &dir, "stderr")?,
            _directory: directory,
        })
    }

    pub(super) fn paths(&self) -> (&Path, &Path) {
        (&self.out.path, &self.err.path)
    }

    pub(super) fn check_current(&self) -> io::Result<()> {
        self.out.check_current()?;
        self.err.check_current()
    }
}

struct Pipe {
    path: PathBuf,
    stream: BufReader<PipeReader>,
    // A serving read end cannot see EOF before the interpreter opens its writer.
    keepalive: File,
}

impl Pipe {
    fn new(directory: &Path, dir: &File, name: &str) -> io::Result<Self> {
        let path = directory.join(name);
        nix::unistd::mkfifo(
            &path,
            nix::sys::stat::Mode::S_IRUSR | nix::sys::stat::Mode::S_IWUSR,
        )
        .map_err(|errno| io::Error::from_raw_os_error(errno as i32))?;
        let flags = OFlags::NONBLOCK | OFlags::NOFOLLOW | OFlags::CLOEXEC;
        let receiver = File::from(fs::openat(
            dir,
            name,
            OFlags::RDONLY | flags,
            Mode::empty(),
        )?);
        let writer = File::from(fs::openat(
            dir,
            name,
            OFlags::WRONLY | flags,
            Mode::empty(),
        )?);
        let pipe = Self {
            path,
            stream: BufReader::new(PipeReader(AsyncFd::new(receiver)?)),
            keepalive: writer,
        };
        pipe.check_current()?;
        Ok(pipe)
    }

    fn check_current(&self) -> io::Result<()> {
        let receive = self.stream.get_ref().0.get_ref().metadata()?;
        let write = self.keepalive.metadata()?;
        let named = std::fs::symlink_metadata(&self.path)?;
        let same = |meta: &std::fs::Metadata| {
            meta.file_type().is_fifo() && meta.dev() == receive.dev() && meta.ino() == receive.ino()
        };
        if !same(&write) || !same(&named) {
            return Err(io::Error::other("shell_session_output_changed"));
        }
        Ok(())
    }
}

async fn finish_stream(
    stream: &mut BufReader<PipeReader>,
    captured: &Mutex<CapturedStream>,
) -> FenceResult {
    let mut chunk = [0; 16_384];
    loop {
        // A FIFO can lose its final writer after a nonblocking read
        // returned WouldBlock. Re-probe the FD if no event arrives.
        // A timer alone never counts as EOF or seals the artifact.
        let count =
            match tokio::time::timeout(super::FIFO_READ_RECHECK, stream.read(&mut chunk)).await {
                Ok(read) => read.map_err(|_| "shell_output_failed")?,
                Err(_) => continue,
            };
        if count == 0 {
            return captured
                .lock()
                .await
                .finish()
                .await
                .map_err(|_| "shell_artifact_unavailable");
        }
        captured.lock().await.append(&chunk[..count]).await?;
    }
}

struct PipeReader(AsyncFd<File>);

impl AsyncRead for PipeReader {
    fn poll_read(
        self: Pin<&mut Self>,
        context: &mut Context<'_>,
        output: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if output.remaining() == 0 {
            return Poll::Ready(Ok(()));
        }
        let file = &self.0;
        // Reading before parking also observes EOF if the last writer went
        // away before this reader registered its first readiness wait.
        match file.get_ref().read(output.initialize_unfilled()) {
            Ok(count) => {
                output.advance(count);
                return Poll::Ready(Ok(()));
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {}
            Err(error) => return Poll::Ready(Err(error)),
        }
        loop {
            let mut ready = ready!(file.poll_read_ready(context))?;
            match ready.try_io(|source| source.get_ref().read(output.initialize_unfilled())) {
                Ok(Ok(count)) => {
                    output.advance(count);
                    return Poll::Ready(Ok(()));
                }
                Ok(Err(error)) => return Poll::Ready(Err(error)),
                Err(_) => continue,
            }
        }
    }
}
