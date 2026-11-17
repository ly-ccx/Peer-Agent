//! Shared execution seam through the actual native CLI; no duplicate executor.
use super::*;

#[test]
fn running_shell_rechecks_actual_policy_stops_its_group_and_admits_a_later_task() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf started > running.txt; exec /bin/sleep 20","timeoutMs":30000}),
        ),
        reply_text("Policy change observed."),
        reply_text("Later task."),
    ]);
    let f = Fixture::new(&server);
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    let started = f.root.path().join("workspace/running.txt");
    let deadline = Instant::now() + Duration::from_secs(8);
    while !started.exists() {
        assert!(
            child.child().try_wait().unwrap().is_none(),
            "shell exited before actual effect"
        );
        assert!(Instant::now() < deadline, "owned shell never started");
        thread::sleep(Duration::from_millis(10));
    }
    let store = PolicyStore::new(f.root.path());
    let policy = store.read_existing("w").unwrap();
    store
        .update_existing(
            "w",
            policy.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.child().try_wait().unwrap().is_none() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(10));
    }
    let stopped = child.child().try_wait().unwrap().is_some();
    if !stopped {
        // Preserve the failing six-second observation, then ask the real owner
        // to clean its own group before failing; never orphan a test sleeper.
        rustix::process::kill_process(
            rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
            rustix::process::Signal::TERM,
        )
        .unwrap();
        let cleanup = Instant::now() + Duration::from_secs(6);
        while child.child().try_wait().unwrap().is_none() {
            assert!(Instant::now() < cleanup);
            thread::sleep(Duration::from_millis(10));
        }
    }
    let result = child.output();
    assert!(
        stopped,
        "policy withdrawal did not stop the actually running shell before the original six-second boundary"
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    let history = f.history();
    let message = history
        .iter()
        .find(|m| m["segments"][0]["tool"] == "bash")
        .unwrap();
    assert_eq!(
        message["permissionGrants"][0]["granted"], true,
        "previous actual grant stays factual"
    );
    let tool = &message["segments"][0]["result"];
    assert_eq!(tool["error"]["code"], "permission_policy_changed");
    assert_eq!(tool["output"]["stopReason"], "permission_policy_changed");
    assert_eq!(tool["output"]["interrupted"], true);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(f.history(), history);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}
