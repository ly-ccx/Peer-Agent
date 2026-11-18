use super::*;
use std::{
    fs,
    io::Read,
    process::{Child, Output},
    thread,
    time::{Duration, Instant},
};

struct Owned(Option<Child>);
impl Drop for Owned {
    fn drop(&mut self) {
        if let Some(child) = &mut self.0 {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
impl Owned {
    fn spawn(home: &Path, args: &[&str]) -> Self {
        Self(Some(
            Command::new(binary())
                .args(args)
                .env_clear()
                .env("PATH", "/nonexistent")
                .env("PEER_AGENT_HOME", home)
                .current_dir(home)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap(),
        ))
    }
    fn signal(&mut self) {
        let child = self.0.as_mut().unwrap();
        assert!(child.try_wait().unwrap().is_none());
        assert!(
            Command::new("/bin/kill")
                .args(["-TERM", &child.id().to_string()])
                .status()
                .unwrap()
                .success()
        );
    }
    fn finish(mut self) -> Output {
        let deadline = Instant::now() + Duration::from_secs(5);
        let child = self.0.as_mut().unwrap();
        while child.try_wait().unwrap().is_none() {
            assert!(Instant::now() < deadline, "owned export did not stop");
            thread::sleep(Duration::from_millis(10));
        }
        self.0.take().unwrap().wait_with_output().unwrap()
    }
}
fn fixture(root: &Path) -> Vec<u8> {
    let dir = root.join("conversations");
    fs::create_dir(&dir).unwrap();
    fs::write(
        dir.join("index.jsonl"),
        b"{\"id\":\"a\",\"title\":\"large\",\"contentRevision\":1}\n",
    )
    .unwrap();
    let body = format!(
        "{}\n",
        json!({"id":"m","role":"assistant","content":"x".repeat(2*1024*1024)})
    )
    .into_bytes();
    fs::write(dir.join("a.jsonl"), &body).unwrap();
    body
}
#[test]
fn blocked_stdout_cancels_and_broken_pipe_fails_without_preventing_a_later_export() {
    let root = tempfile::tempdir().unwrap();
    let before = fixture(root.path());
    let mut child = Owned::spawn(root.path(), &["export", "a"]);
    wait_for_stdout(child.0.as_ref().unwrap());
    child.signal();
    let out = child.finish();
    assert_eq!(
        out.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!out.stdout.is_empty());
    assert!(out.stdout.len() < before.len());
    assert_eq!(
        fs::read(root.path().join("conversations/a.jsonl")).unwrap(),
        before
    );

    let mut broken = Owned::spawn(root.path(), &["export", "a"]);
    drop(broken.0.as_mut().unwrap().stdout.take());
    let out = broken.finish();
    assert_eq!(
        out.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let target = root.path().join("later.md");
    assert!(
        run(
            root.path(),
            &["export", "a", "--output", target.to_str().unwrap()]
        )
        .status
        .success()
    );
    let mut text = String::new();
    fs::File::open(target)
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert!(text.contains(&"x".repeat(2 * 1024 * 1024)));
    assert_eq!(
        fs::read(root.path().join("conversations/a.jsonl")).unwrap(),
        before
    );
}

fn wait_for_stdout(child: &Child) {
    let stdout = child.stdout.as_ref().unwrap();
    let mut fds = [rustix::event::PollFd::new(
        stdout,
        rustix::event::PollFlags::IN,
    )];
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let timeout = deadline.saturating_duration_since(Instant::now());
        assert!(!timeout.is_zero(), "export did not start writing to stdout");
        let timeout = rustix::event::Timespec {
            tv_sec: timeout.as_secs().try_into().unwrap(),
            tv_nsec: timeout.subsec_nanos().into(),
        };
        match rustix::event::poll(&mut fds, Some(&timeout)) {
            Err(rustix::io::Errno::INTR) => continue,
            result => assert_eq!(result.unwrap(), 1),
        }
        assert!(fds[0].revents().contains(rustix::event::PollFlags::IN));
        return;
    }
}
#[test]
fn signal_during_publication_lock_wait_preserves_old_target_and_later_force_succeeds() {
    let root = tempfile::tempdir().unwrap();
    fixture(root.path());
    let output = root.path().join("output");
    fs::create_dir(&output).unwrap();
    let target = output.join("reading.md");
    fs::write(&target, b"old reading copy").unwrap();
    let parent = fs::File::open(&output).unwrap();
    rustix::fs::flock(&parent, rustix::fs::FlockOperation::LockExclusive).unwrap();
    let args = [
        "export",
        "a",
        "--output",
        target.to_str().unwrap(),
        "--force",
    ];
    let mut child = Owned::spawn(root.path(), &args);
    let deadline = Instant::now() + Duration::from_secs(5);
    while fs::read_dir(&output).unwrap().count() == 1 {
        assert!(
            Instant::now() < deadline,
            "export did not reach private output preparation"
        );
        assert!(child.0.as_mut().unwrap().try_wait().unwrap().is_none());
        thread::sleep(Duration::from_millis(10));
    }
    child.signal();
    let out = child.finish();
    assert_eq!(
        out.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(fs::read(&target).unwrap(), b"old reading copy");
    assert_eq!(fs::read_dir(&output).unwrap().count(), 1);
    drop(parent);
    assert!(run(root.path(), &args).status.success());
    assert_ne!(fs::read(&target).unwrap(), b"old reading copy");
    assert_eq!(fs::read_dir(output).unwrap().count(), 1);
}

#[test]
fn broken_publication_receipt_reports_unknown_retains_the_copy_and_fresh_force_recovers() {
    let root = tempfile::tempdir().unwrap();
    let before = fixture(root.path());
    let target = root.path().join("published.md");
    let args = ["export", "a", "--output", target.to_str().unwrap()];
    let mut child = Owned::spawn(root.path(), &args);
    drop(child.0.as_mut().unwrap().stdout.take());
    let out = child.finish();
    assert_eq!(out.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&out.stderr).contains("export_publication_unknown"));
    let committed = fs::read(&target).unwrap();
    assert!(committed.len() > 2 * 1024 * 1024);
    assert_eq!(
        fs::read(root.path().join("conversations/a.jsonl")).unwrap(),
        before
    );
    assert_eq!(run(root.path(), &args).status.code(), Some(2));
    let mut fresh = args.to_vec();
    fresh.push("--force");
    assert!(run(root.path(), &fresh).status.success());
    assert_eq!(fs::read(target).unwrap(), committed);
}
