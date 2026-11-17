//! Deterministic worker barriers are compiled only in the fixture binary.
//! They pause real native I/O before mutation, not the permission implementation.
use super::*;
fn ready(f: &Fixture, child: &mut OwnedChild) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !f.root.path().join("file-worker-ready").exists() {
        assert!(
            child.child().try_wait().unwrap().is_none(),
            "worker exited before fixture barrier"
        );
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
}
fn finish(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.child().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    child.output()
}
fn replies() -> Vec<String> {
    vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_tool(
            "edit_file",
            json!({"path":"input.txt","old_string":"source","new_string":"edited"}),
        ),
        reply_text("Later task."),
    ]
}
#[test]
fn paused_file_worker_keeps_heartbeat_and_rechecks_policy_and_read_snapshot() {
    for policy_change in [false, true] {
        let server = Server::new(replies());
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(
            f.command("exec", "p")
                .env("PEER_NATIVE_FILE_BARRIER", "edit")
                .spawn()
                .unwrap(),
        ));
        ready(&f, &mut child);
        if policy_change {
            let lease = f.root.path().join("project-runtime/w/host.lease");
            let before = get(&lease)["heartbeatAt"].clone();
            let deadline = Instant::now() + Duration::from_secs(8);
            while get(&lease)["heartbeatAt"] == before {
                assert!(
                    Instant::now() < deadline,
                    "file worker blocked the actual Host heartbeat"
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
        } else {
            std::fs::write(f.root.path().join("workspace/input.txt"), "external change").unwrap();
        }
        std::fs::write(f.root.path().join("file-worker-resume"), "resume").unwrap();
        let _result = finish(child);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
            if policy_change {
                "source fact"
            } else {
                "external change"
            }
        );
        let h = f.history();
        let result = &h
            .iter()
            .flat_map(|m| m["segments"].as_array().into_iter().flatten())
            .find(|s| s["tool"] == "edit_file")
            .unwrap()["result"];
        assert_eq!(result["status"], "failed");
        assert_eq!(
            result["error"]["code"],
            if policy_change {
                "permission_policy_changed"
            } else {
                "file_changed_since_read"
            }
        );
        assert!(result["evidence"].is_object());
    }
}
#[test]
fn cancelling_file_worker_drains_it_and_a_later_task_can_run() {
    let server = Server::new(replies());
    let f = Fixture::new(&server);
    let mut child = OwnedChild(Some(
        f.command("exec", "p")
            .env("PEER_NATIVE_FILE_BARRIER", "edit")
            .spawn()
            .unwrap(),
    ));
    ready(&f, &mut child);
    let at = Instant::now();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let result = finish(child);
    assert_eq!(
        result.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(at.elapsed() < Duration::from_secs(3));
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        "source fact"
    );
    let old = f.history();
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let out = f.command("exec", "p2").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(f.history(), old);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}
#[test]
fn hard_exit_after_edit_preserves_unknown_effect_without_replaying_it() {
    let server = Server::new(replies());
    let f = Fixture::new(&server);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "edit_file")
        .output()
        .unwrap();
    assert_eq!(
        out.status.code(),
        Some(77),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        "edited fact"
    );
    f.age_dead_lease();
    let out = f.run();
    assert!(!out.status.success());
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    let out = f.command("recover", "p").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    let b = f.budget(|_| {});
    assert_eq!(b["uncertainDispatches"].as_array().unwrap().len(), 1);
    let history = f.history();
    assert!(
        history
            .iter()
            .flat_map(|m| m["segments"].as_array().into_iter().flatten())
            .all(|s| s["tool"] != "edit_file")
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let out = f.command("exec", "p2").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(f.history(), history);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        "edited fact"
    );
}
