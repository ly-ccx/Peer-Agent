//! Unique stdout owner: cancellation is observed even when a consumer stops reading.
use super::destination::check_cancel;
use std::{
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    sync::atomic::AtomicBool,
};

pub(super) fn copy(file: &mut File, cancel: &AtomicBool) -> io::Result<()> {
    file.seek(SeekFrom::Start(0))?;
    send(file, cancel)
}

pub(super) fn text(text: &str, cancel: &AtomicBool) -> io::Result<()> {
    send(text.as_bytes(), cancel)
}

#[cfg(unix)]
fn send(mut reader: impl Read, cancel: &AtomicBool) -> io::Result<()> {
    use std::os::fd::{AsFd, BorrowedFd};

    struct Flags<'a> {
        fd: BorrowedFd<'a>,
        before: rustix::fs::OFlags,
    }
    impl Drop for Flags<'_> {
        fn drop(&mut self) {
            let _ = rustix::fs::fcntl_setfl(self.fd, self.before);
        }
    }

    let stdout = io::stdout().lock();
    let before = rustix::fs::fcntl_getfl(&stdout)?;
    rustix::fs::fcntl_setfl(&stdout, before | rustix::fs::OFlags::NONBLOCK)?;
    let _guard = Flags {
        fd: stdout.as_fd(),
        before,
    };
    let mut bytes = [0u8; 65536];
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            return Ok(());
        }
        let mut at = 0;
        while at < n {
            check_cancel(cancel)?;
            match rustix::io::write(&stdout, &bytes[at..n]) {
                Ok(0) => {
                    return Err(io::Error::new(
                        io::ErrorKind::WriteZero,
                        "export_stdout_closed",
                    ));
                }
                Ok(count) => at += count,
                Err(rustix::io::Errno::INTR) => {}
                Err(rustix::io::Errno::AGAIN) => {
                    let mut fds = [rustix::event::PollFd::new(
                        &stdout,
                        rustix::event::PollFlags::OUT,
                    )];
                    match rustix::event::poll(
                        &mut fds,
                        Some(&rustix::event::Timespec {
                            tv_sec: 0,
                            tv_nsec: 25000000,
                        }),
                    ) {
                        Ok(_) | Err(rustix::io::Errno::INTR) => {}
                        Err(e) => return Err(e.into()),
                    }
                }
                Err(e) => return Err(e.into()),
            }
        }
    }
}

#[cfg(windows)]
fn send(mut reader: impl Read, cancel: &AtomicBool) -> io::Result<()> {
    use std::io::Write;
    let mut stdout = io::stdout().lock();
    let mut bytes = [0u8; 65536];
    loop {
        check_cancel(cancel)?;
        let n = reader.read(&mut bytes)?;
        if n == 0 {
            stdout.flush()?;
            return Ok(());
        }
        check_cancel(cancel)?;
        stdout.write_all(&bytes[..n])?;
    }
}
