use peer_store::{ToolArtifactError as Error, ToolArtifactRef, ToolArtifactStore};
use serde_json::json;
use std::{
    fs,
    io::{self, Read, Seek, SeekFrom},
    os::unix::fs::{MetadataExt, symlink},
    path::Path,
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn fixture() -> (tempfile::TempDir, ToolArtifactStore) {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("conversations")).unwrap();
    fs::write(
        root.path().join("conversations/c.jsonl"),
        b"{\"id\":\"user\"}\n",
    )
    .unwrap();
    let store = ToolArtifactStore::new(root.path());
    (root, store)
}
fn directory(root: &Path) -> std::path::PathBuf {
    root.join("conversations/c.tool-results")
}
#[test]
fn immutable_dedupe_windows_and_restart() {
    let (root, store) = fixture();
    let text = "原始快照🦀\n".repeat(12000);
    let r = store.publish_utf8("c", &text, &|| false).unwrap();
    let p = store.path("c", &r).unwrap();
    let before = fs::metadata(&p).unwrap();
    assert_eq!(r.bytes, text.len() as u64);
    assert_eq!(before.mode() & 0o777, 0o600);
    assert_eq!(
        fs::metadata(directory(root.path())).unwrap().mode() & 0o777,
        0o700
    );
    assert_eq!(store.publish_utf8("c", &text, &|| false).unwrap(), r);
    assert_eq!(fs::metadata(&p).unwrap().ino(), before.ino());
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 1);
    let cold = ToolArtifactStore::new(root.path());
    let w = cold.read_window("c", &r, 7, 101, &|| false).unwrap();
    assert_eq!(w.bytes, text.as_bytes()[7..108]);
    assert!(!w.complete);
    assert_eq!(w.total_bytes, r.bytes);
    assert_eq!(w.offset, 7);
    let small = cold
        .publish_json(
            "c",
            &json!({"original":"事实🦀","status":"completed"}),
            &|| false,
        )
        .unwrap();
    let w = cold.read_window("c", &small, 0, 262144, &|| false).unwrap();
    assert!(w.complete);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&w.bytes).unwrap(),
        json!({"original":"事实🦀","status":"completed"})
    );
    assert_eq!(
        cold.read_window("c", &r, 0, 262145, &|| false).unwrap_err(),
        Error::Invalid
    );
    assert_eq!(
        cold.read_window("other", &r, 0, 10, &|| false).unwrap_err(),
        Error::Invalid
    );
    for mutate in ["id", "hash", "version", "size"] {
        let mut bad = r.clone();
        match mutate {
            "id" => bad.conversation_id = "../escape".into(),
            "hash" => bad.sha256 = "A".repeat(64),
            "version" => bad.schema_version = 2,
            _ => bad.bytes = 134217729,
        }
        assert_eq!(cold.path("c", &bad).unwrap_err(), Error::Invalid);
    }
    let mut future = serde_json::to_value(&r).unwrap();
    future["path"] = json!("/tmp/arbitrary");
    assert!(serde_json::from_value::<ToolArtifactRef>(future).is_err());
}
#[test]
fn corrupt_missing_and_special_objects_are_not_rebuilt_or_evicted() {
    let (root, store) = fixture();
    let r = store
        .publish_utf8("c", "historical bytes", &|| false)
        .unwrap();
    let p = store.path("c", &r).unwrap();
    fs::write(&p, b"tampered content").unwrap();
    let corrupt = fs::read(&p).unwrap();
    assert_eq!(
        store
            .publish_utf8("c", "historical bytes", &|| false)
            .unwrap_err(),
        Error::Corrupt
    );
    assert_eq!(
        store.read_window("c", &r, 0, 99, &|| false).unwrap_err(),
        Error::Corrupt
    );
    assert_eq!(fs::read(&p).unwrap(), corrupt);
    fs::remove_file(&p).unwrap();
    assert_eq!(
        store.read_window("c", &r, 0, 99, &|| false).unwrap_err(),
        Error::Missing
    );
    let outside = root.path().join("outside");
    fs::write(&outside, b"do not change").unwrap();
    symlink(&outside, &p).unwrap();
    assert_eq!(
        store
            .publish_utf8("c", "historical bytes", &|| false)
            .unwrap_err(),
        Error::Invalid
    );
    assert_eq!(fs::read(&outside).unwrap(), b"do not change");
    fs::remove_file(&p).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg("-m")
            .arg("600")
            .arg(&p)
            .status()
            .unwrap()
            .success()
    );
    assert_eq!(
        store.read_window("c", &r, 0, 99, &|| false).unwrap_err(),
        Error::Corrupt
    );
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 1);
}
#[test]
fn quota_preserves_partial_files_and_existing_facts() {
    let (root, store) = fixture();
    let r = store.publish_utf8("c", "retained", &|| false).unwrap();
    let partial = directory(root.path()).join(".partial-unknown");
    let f = fs::File::create(&partial).unwrap();
    f.set_len(268435456).unwrap();
    assert_eq!(
        store.publish_utf8("c", "new", &|| false).unwrap_err(),
        Error::Limit
    );
    assert_eq!(store.publish_utf8("c", "retained", &|| false).unwrap(), r);
    assert_eq!(fs::metadata(&partial).unwrap().len(), 268435456);
    fs::remove_file(&partial).unwrap();
    for i in 0..4094 {
        fs::write(directory(root.path()).join(format!(".partial-{i}")), []).unwrap();
    }
    assert!(store.publish_utf8("c", "last admitted", &|| false).is_ok());
    assert_eq!(
        store
            .publish_utf8("c", "one too many", &|| false)
            .unwrap_err(),
        Error::Limit
    );
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 4096);
}
struct Stream {
    position: u64,
    length: u64,
    pass: usize,
    change: bool,
    maximum: usize,
}
impl Read for Stream {
    fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
        self.maximum = self.maximum.max(b.len());
        let n = b.len().min((self.length - self.position) as usize);
        b[..n].fill(if self.change && self.pass > 1 {
            b'b'
        } else {
            b'a'
        });
        self.position += n as u64;
        Ok(n)
    }
}
impl Seek for Stream {
    fn seek(&mut self, s: SeekFrom) -> io::Result<u64> {
        match s {
            SeekFrom::Start(0) => {
                self.position = 0;
                self.pass += 1
            }
            SeekFrom::Current(0) => (),
            _ => return Err(io::Error::other("test seek")),
        };
        Ok(self.position)
    }
}
#[test]
fn streaming_large_text_limits_invalid_utf8_and_source_change() {
    let (root, store) = fixture();
    let mut stream = Stream {
        position: 0,
        length: 100 * 1024 * 1024,
        pass: 0,
        change: false,
        maximum: 0,
    };
    let r = store
        .publish_utf8_reader("c", &mut stream, &|| false)
        .unwrap();
    assert_eq!(r.bytes, 100 * 1024 * 1024);
    assert!(stream.maximum <= 65536);
    let w = store
        .read_window("c", &r, r.bytes - 7, 100, &|| false)
        .unwrap();
    assert_eq!(w.bytes, b"aaaaaaa");
    assert!(!w.complete);
    let mut too_large = Stream {
        position: 0,
        length: 134217729,
        pass: 0,
        change: false,
        maximum: 0,
    };
    assert_eq!(
        store
            .publish_utf8_reader("c", &mut too_large, &|| false)
            .unwrap_err(),
        Error::Limit
    );
    let mut invalid = io::Cursor::new([255u8]);
    assert_eq!(
        store
            .publish_utf8_reader("c", &mut invalid, &|| false)
            .unwrap_err(),
        Error::Invalid
    );
    let mut changed = Stream {
        position: 0,
        length: 32,
        pass: 0,
        change: true,
        maximum: 0,
    };
    assert_eq!(
        store
            .publish_utf8_reader("c", &mut changed, &|| false)
            .unwrap_err(),
        Error::Changed
    );
    assert_eq!(
        fs::read_dir(directory(root.path())).unwrap().count(),
        2,
        "changed second pass is retained as an unpublished partial"
    );
    assert_eq!(
        fs::metadata(store.path("c", &r).unwrap()).unwrap().len(),
        r.bytes
    );
}
#[test]
fn cancellation_missing_conversation_and_directory_escape() {
    let (root, store) = fixture();
    assert_eq!(
        store.publish_utf8("c", "cancelled", &|| true).unwrap_err(),
        Error::Cancelled
    );
    assert!(!directory(root.path()).exists());
    assert_eq!(
        store
            .publish_utf8("missing", "data", &|| false)
            .unwrap_err(),
        Error::Missing
    );
    assert!(
        !root
            .path()
            .join("conversations/missing.tool-results")
            .exists()
    );
    let outside = tempfile::tempdir().unwrap();
    symlink(outside.path(), directory(root.path())).unwrap();
    assert_eq!(
        store.publish_utf8("c", "data", &|| false).unwrap_err(),
        Error::Invalid
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
#[test]
fn child_process() {
    let Ok(home) = std::env::var("PEER_ARTIFACT_CHILD_HOME") else {
        return;
    };
    if std::env::var_os("PEER_ARTIFACT_HOLD_LOCK").is_some() {
        let d = fs::File::open(directory(Path::new(&home))).unwrap();
        rustix::fs::flock(&d, rustix::fs::FlockOperation::LockExclusive).unwrap();
        fs::write(
            directory(Path::new(&home)).join(".partial-interrupted"),
            b"uncertain partial",
        )
        .unwrap();
        fs::write(Path::new(&home).join("child-ready"), b"ready").unwrap();
        loop {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
    ToolArtifactStore::new(home)
        .publish_utf8("c", &"parallel immutable\n".repeat(50000), &|| false)
        .unwrap();
}
fn child(home: &Path) -> Command {
    let mut c = Command::new(std::env::current_exe().unwrap());
    c.args(["--exact", "child_process", "--nocapture"])
        .env("PEER_ARTIFACT_CHILD_HOME", home)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    c
}
#[test]
fn independent_process_dedupe_and_killed_owner_recovery() {
    let (root, store) = fixture();
    let mut children = (0..4)
        .map(|_| child(root.path()).spawn().unwrap())
        .collect::<Vec<_>>();
    for c in children.drain(..) {
        let out = c.wait_with_output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
    }
    assert_eq!(fs::read_dir(directory(root.path())).unwrap().count(), 1);
    let mut held = child(root.path())
        .env("PEER_ARTIFACT_HOLD_LOCK", "1")
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while !root.path().join("child-ready").exists() {
        if Instant::now() >= deadline {
            let _ = held.kill();
            panic!("child lock timeout");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let start = Instant::now();
    assert_eq!(
        store
            .publish_utf8("c", "blocked", &|| start.elapsed()
                > Duration::from_millis(60))
            .unwrap_err(),
        Error::Cancelled
    );
    held.kill().unwrap();
    held.wait().unwrap();
    let next = store.publish_utf8("c", "later task", &|| false).unwrap();
    assert_eq!(
        store
            .read_window("c", &next, 0, 100, &|| false)
            .unwrap()
            .bytes,
        b"later task"
    );
    assert_eq!(
        fs::read(directory(root.path()).join(".partial-interrupted")).unwrap(),
        b"uncertain partial"
    );
}
#[test]
fn published_link_after_crash_is_verified_without_replay_or_cleanup() {
    let (root, store) = fixture();
    let r = store
        .publish_utf8("c", "completed observation", &|| false)
        .unwrap();
    let p = store.path("c", &r).unwrap();
    let temp = directory(root.path()).join(".partial-before-unlink");
    fs::hard_link(&p, &temp).unwrap();
    let before = fs::metadata(&p).unwrap();
    assert_eq!(
        store
            .publish_utf8("c", "completed observation", &|| false)
            .unwrap(),
        r
    );
    assert_eq!(fs::metadata(&p).unwrap().ino(), before.ino());
    assert_eq!(fs::metadata(&temp).unwrap().ino(), before.ino());
    assert_eq!(
        store.read_window("c", &r, 0, 100, &|| false).unwrap().bytes,
        b"completed observation"
    );
}
#[test]
fn shared_resource_matches_implementation_budgets_and_codes() {
    let v: serde_json::Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/tool-artifacts.json"
    ))
    .unwrap();
    assert_eq!(
        v["limits"],
        json!({"artifactBytes":134217728,"conversationBytes":268435456,"entries":4096,"pathBytes":4194304,"chunkBytes":65536,"windowBytes":262144,"inlineChars":6000,"previewChars":1200})
    );
    for e in [
        Error::Invalid,
        Error::Missing,
        Error::Corrupt,
        Error::Changed,
        Error::Limit,
        Error::Busy,
        Error::Unavailable,
        Error::CommitUnknown,
        Error::Cancelled,
    ] {
        assert!(v["errors"].as_array().unwrap().contains(&json!(e.code())));
    }
}

#[test]
fn unicode_chunk_boundary_and_directory_replacement_preserve_original_bytes() {
    let (root, store) = fixture();
    let text = format!("{}🦀结尾", "a".repeat(65535));
    let r = store
        .publish_utf8_reader("c", &mut io::Cursor::new(text.as_bytes()), &|| false)
        .unwrap();
    assert_eq!(
        store
            .read_window("c", &r, 65534, 100, &|| false)
            .unwrap()
            .bytes,
        &text.as_bytes()[65534..]
    );
    struct Replaced {
        root: std::path::PathBuf,
        outside: std::path::PathBuf,
        pass: u8,
        bytes: io::Cursor<Vec<u8>>,
    }
    impl Seek for Replaced {
        fn seek(&mut self, s: SeekFrom) -> io::Result<u64> {
            if matches!(s, SeekFrom::Start(0)) {
                self.pass += 1;
                if self.pass == 2 {
                    fs::rename(directory(&self.root), self.root.join("displaced"))?;
                    symlink(&self.outside, directory(&self.root))?;
                }
            }
            self.bytes.seek(s)
        }
    }
    impl Read for Replaced {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            self.bytes.read(b)
        }
    }
    let outside = tempfile::tempdir().unwrap();
    let mut reader = Replaced {
        root: root.path().into(),
        outside: outside.path().into(),
        pass: 0,
        bytes: io::Cursor::new(b"second observation".to_vec()),
    };
    assert_eq!(
        store
            .publish_utf8_reader("c", &mut reader, &|| false)
            .unwrap_err(),
        Error::Changed
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
    let displaced = root.path().join("displaced");
    assert_eq!(
        fs::read(displaced.join(store.path("c", &r).unwrap().file_name().unwrap())).unwrap(),
        text.as_bytes()
    );
    assert_eq!(fs::read_dir(&displaced).unwrap().count(), 2);
    fs::remove_file(directory(root.path())).unwrap();
    fs::rename(displaced, directory(root.path())).unwrap();
    let next = store
        .publish_utf8("c", "later observation", &|| false)
        .unwrap();
    assert!(
        store
            .read_window("c", &next, 0, 100, &|| false)
            .unwrap()
            .complete
    );
}
#[test]
fn interruption_during_second_pass_retains_partial_and_admits_later_task() {
    use std::{cell::Cell, rc::Rc};
    let (root, store) = fixture();
    struct Interrupted {
        pass: u8,
        cancelled: Rc<Cell<bool>>,
        content: io::Cursor<Vec<u8>>,
    }
    impl Seek for Interrupted {
        fn seek(&mut self, s: SeekFrom) -> io::Result<u64> {
            if matches!(s, SeekFrom::Start(0)) {
                self.pass += 1;
            }
            self.content.seek(s)
        }
    }
    impl Read for Interrupted {
        fn read(&mut self, b: &mut [u8]) -> io::Result<usize> {
            let n = self.content.read(b)?;
            if self.pass == 2 {
                self.cancelled.set(true);
            }
            Ok(n)
        }
    }
    let cancelled = Rc::new(Cell::new(false));
    let mut reader = Interrupted {
        pass: 0,
        cancelled: cancelled.clone(),
        content: io::Cursor::new(b"original observation".to_vec()),
    };
    assert_eq!(
        store
            .publish_utf8_reader("c", &mut reader, &|| cancelled.get())
            .unwrap_err(),
        Error::Cancelled
    );
    let partials = fs::read_dir(directory(root.path()))
        .unwrap()
        .map(|e| e.unwrap().path())
        .collect::<Vec<_>>();
    assert_eq!(partials.len(), 1);
    assert!(
        partials[0]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .starts_with(".partial-")
    );
    let next = store.publish_utf8("c", "next", &|| false).unwrap();
    assert_eq!(
        store
            .read_window("c", &next, 0, 100, &|| false)
            .unwrap()
            .bytes,
        b"next"
    );
    assert!(partials[0].exists());
}
