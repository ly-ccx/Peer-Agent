//! A connection owns one bounded NDJSON reader and serializes protocol writes.
//! The editor keeps stdin open while prompts or approvals are in progress.
use peer_runtime::CancellationToken;
use rustix::{
    event::{PollFd, PollFlags, poll},
    fs::{OFlags, fcntl_getfl, fcntl_setfl},
    io::{Errno, read, write},
};
use serde_json::Value;
use std::{io, os::fd::AsFd, time::Duration};

const MAX_FRAME: usize = 2 * 1024 * 1024;
const IO_POLL: Duration = Duration::from_millis(10);
const WRITE_LIMIT: Duration = Duration::from_secs(5);
const EMPTY_POLL: rustix::event::Timespec = rustix::event::Timespec {
    tv_sec: 0,
    tv_nsec: 0,
};

struct Nonblocking<F: AsFd> {
    source: F,
    original: OFlags,
}
impl<F: AsFd> Nonblocking<F> {
    fn new(source: F) -> io::Result<Self> {
        let original = fcntl_getfl(&source)?;
        fcntl_setfl(&source, original | OFlags::NONBLOCK)?;
        Ok(Self { source, original })
    }
}
impl<F: AsFd> Drop for Nonblocking<F> {
    fn drop(&mut self) {
        let _ = fcntl_setfl(&self.source, self.original);
    }
}

async fn ready(fd: &impl AsFd, flag: PollFlags, shutdown: &CancellationToken) -> io::Result<bool> {
    loop {
        if shutdown.is_cancelled() {
            return Ok(false);
        }
        let mut requests = [PollFd::new(fd, flag)];
        match poll(&mut requests, Some(&EMPTY_POLL)) {
            Ok(0) => {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => return Ok(false),
                    _ = tokio::time::sleep(IO_POLL) => {}
                }
            }
            Ok(_) => return Ok(true),
            Err(Errno::INTR) => {}
            Err(error) => return Err(error.into()),
        }
    }
}

pub(super) struct Reader<F: AsFd> {
    input: Nonblocking<F>,
    retained: Vec<u8>,
    cursor: usize,
}
impl<F: AsFd> Reader<F> {
    pub(super) fn new(input: F) -> io::Result<Self> {
        Ok(Self {
            input: Nonblocking::new(input)?,
            retained: Vec::new(),
            cursor: 0,
        })
    }

    pub(super) async fn next_frame(
        &mut self,
        shutdown: &CancellationToken,
    ) -> io::Result<Option<Vec<u8>>> {
        let mut searched = 0;
        loop {
            if shutdown.is_cancelled() {
                return Ok(None);
            }
            let remaining = &self.retained[self.cursor..];
            if let Some(next) = remaining[searched..].iter().position(|b| *b == b'\n') {
                let newline = searched + next;
                if newline > MAX_FRAME {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "ACP input frame too large",
                    ));
                }
                let line = remaining[..newline].to_vec();
                self.cursor += newline + 1;
                return Ok(Some(line));
            }
            if remaining.len() > MAX_FRAME {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "ACP input frame too large",
                ));
            }
            searched = remaining.len();
            if self.cursor != 0 {
                self.retained.drain(..self.cursor);
                self.cursor = 0;
            }
            if !ready(&self.input.source, PollFlags::IN, shutdown).await? {
                return Ok(None);
            }
            let mut buffer = [0u8; 4096];
            match read(&self.input.source, &mut buffer) {
                Ok(0) if self.retained.is_empty() => return Ok(None),
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::UnexpectedEof,
                        "Incomplete ACP input frame",
                    ));
                }
                Ok(n) => self.retained.extend_from_slice(&buffer[..n]),
                Err(Errno::INTR | Errno::AGAIN) => {}
                Err(error) => return Err(error.into()),
            }
            tokio::task::yield_now().await;
        }
    }
}

pub(super) struct Writer<F: AsFd> {
    output: tokio::sync::Mutex<Nonblocking<F>>,
    shutdown: CancellationToken,
}
struct PartialFrame<'a> {
    shutdown: &'a CancellationToken,
    incomplete: bool,
}
impl Drop for PartialFrame<'_> {
    fn drop(&mut self) {
        if self.incomplete {
            self.shutdown.cancel();
        }
    }
}
impl<F: AsFd> Writer<F> {
    pub(super) fn new(output: F, shutdown: &CancellationToken) -> io::Result<Self> {
        Ok(Self {
            output: tokio::sync::Mutex::new(Nonblocking::new(output)?),
            shutdown: shutdown.clone(),
        })
    }

    pub(super) async fn send(&self, message: &Value) -> io::Result<()> {
        let result = tokio::time::timeout(WRITE_LIMIT, self.send_inner(message))
            .await
            .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()));
        if result.is_err() {
            self.shutdown.cancel();
        }
        result
    }

    async fn send_inner(&self, message: &Value) -> io::Result<()> {
        let output = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => return Err(io::ErrorKind::Interrupted.into()),
            target = self.output.lock() => target,
        };
        let mut frame = serde_json::to_vec(message)?;
        if frame.len() > MAX_FRAME {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "ACP output frame too large",
            ));
        }
        frame.push(b'\n');
        let mut emission = PartialFrame {
            shutdown: &self.shutdown,
            incomplete: false,
        };
        let mut pending = frame.as_slice();
        while !pending.is_empty() {
            if !ready(&output.source, PollFlags::OUT, &self.shutdown).await? {
                return Err(io::ErrorKind::Interrupted.into());
            }
            match write(&output.source, pending) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(n) => {
                    pending = &pending[n..];
                    emission.incomplete = !pending.is_empty();
                }
                Err(Errno::INTR | Errno::AGAIN) => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(())
    }
}
