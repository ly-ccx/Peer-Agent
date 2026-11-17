//! The fixture pause owns actual created directories; it never grants access.
use super::*;
fn ready(f: &Fixture, child: &mut OwnedChild) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.root.path().join("file-worker-ready").exists() {
        assert!(child.child().try_wait().unwrap().is_none());
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    assert!(f.root.path().join("workspace/new/deep").is_dir());
    assert!(!f.root.path().join("workspace/new/deep/file.txt").exists());
}
fn finish(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(10);
    while child.child().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "owned parent worker did not stop"
        );
        thread::sleep(Duration::from_millis(10));
    }
    child.output()
}
fn server() -> Server {
    Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"new/deep/file.txt","content":"must not be replayed"}),
        ),
        reply_text("Independent later task."),
    ])
}
fn recover_and_later(f: &Fixture, server: &Server) {
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let retry = f.run();
    assert!(!retry.status.success());
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "restart must not replay cognition/tool"
    );
    let out = f.command("recover", "p").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(
        receipt["facts"]["control"]["stopReceipt"]["unknownCalls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let budget = f.budget(|_| {});
    assert!(
        budget["uncertainDispatches"]
            .as_array()
            .unwrap()
            .iter()
            .all(|d| d.get("declaredScopes").is_none()),
        "directory effects cannot be narrowed by dropping their directory scope"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let blocked = f.command("exec", "p2").output().unwrap();
    assert!(
        !blocked.status.success(),
        "the partially-created namespace must stay protected"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let independent = f.root.path().join("independent-workspace");
    std::fs::create_dir(&independent).unwrap();
    let file = f.root.path().join("goal-plans/p2.json");
    let mut goal = get(&file);
    goal["targetWorkspacePath"] = json!(independent);
    put(&file, &goal);
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}
#[test]
fn parent_creation_then_revocation_cancellation_or_symlink_change_retains_unknown_and_drains() {
    for action in ["policy", "cancel", "symlink"] {
        let server = server();
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(
            f.command("exec", "p")
                .env("PEER_NATIVE_FILE_BARRIER", "parents")
                .spawn()
                .unwrap(),
        ));
        ready(&f, &mut child);
        match action {
            "policy" => {
                let lease = f.root.path().join("project-runtime/w/host.lease");
                let before = get(&lease)["heartbeatAt"].clone();
                let deadline = Instant::now() + Duration::from_secs(8);
                while get(&lease)["heartbeatAt"] == before {
                    assert!(
                        Instant::now() < deadline,
                        "Host heartbeat was blocked by its worker"
                    );
                    assert!(child.child().try_wait().unwrap().is_none());
                    thread::sleep(Duration::from_millis(10));
                }
                let store = PolicyStore::new(f.root.path());
                let old = store.read_existing("w").unwrap();
                store
                    .update_existing(
                        "w",
                        old.revision,
                        peer_protocol::LocalAccessLevel::AskBeforeLocal,
                        AT,
                    )
                    .unwrap();
                std::fs::write(f.root.path().join("file-worker-resume"), "resume").unwrap();
            }
            "cancel" => {
                rustix::process::kill_process(
                    rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                    rustix::process::Signal::TERM,
                )
                .unwrap();
            }
            "symlink" => {
                std::fs::rename(
                    f.root.path().join("workspace/new"),
                    f.root.path().join("retained-parents"),
                )
                .unwrap();
                std::fs::create_dir(f.root.path().join("outside")).unwrap();
                std::os::unix::fs::symlink(
                    f.root.path().join("outside"),
                    f.root.path().join("workspace/new"),
                )
                .unwrap();
                std::fs::write(f.root.path().join("file-worker-resume"), "resume").unwrap();
            }
            _ => unreachable!(),
        }
        let out = finish(child);
        assert!(!out.status.success());
        assert!(!f.root.path().join("workspace/new/deep/file.txt").exists());
        if action == "symlink" {
            assert!(f.root.path().join("retained-parents/deep").is_dir());
            assert!(
                std::fs::read_dir(f.root.path().join("outside"))
                    .unwrap()
                    .next()
                    .is_none()
            );
        } else {
            assert!(f.root.path().join("workspace/new/deep").is_dir());
        }
        recover_and_later(&f, &server);
    }
}
#[test]
fn hard_exit_after_parents_preserves_directory_effect_and_never_replays_the_write() {
    let server = server();
    let f = Fixture::new(&server);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_FILE_PARENT_FAULT", "after_parents")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(77),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(f.root.path().join("workspace/new/deep").is_dir());
    assert!(!f.root.path().join("workspace/new/deep/file.txt").exists());
    assert_eq!(
        f.history().len(),
        1,
        "no completed Tool Result was invented"
    );
    f.age_dead_lease();
    recover_and_later(&f, &server);
    assert!(f.root.path().join("workspace/new/deep").is_dir());
    assert!(!f.root.path().join("workspace/new/deep/file.txt").exists());
}
