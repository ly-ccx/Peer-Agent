//! Shared execution seam through the actual native CLI; no duplicate executor.
use super::*;

#[test]
fn running_shell_rechecks_actual_policy_stops_its_group_and_admits_a_later_task() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf '%s' \"$$\" > running.tmp; /bin/mv running.tmp running.txt; /bin/sleep 20","timeoutMs":30000}),
        ),
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
    let pid =
        rustix::process::Pid::from_raw(std::fs::read_to_string(started).unwrap().parse().unwrap())
            .unwrap();
    assert!(rustix::process::test_kill_process_group(pid).is_ok());
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
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("execution_outcome_unknown"));
    assert_eq!(
        rustix::process::test_kill_process_group(pid),
        Err(rustix::io::Errno::SRCH)
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
    assert_eq!(tool["error"]["code"], "execution_outcome_unknown");
    assert_eq!(tool["output"]["stopReason"], "permission_policy_changed");
    assert_eq!(tool["output"]["interrupted"], true);
    let budget = f.budget(|_| {});
    assert_eq!(budget["uncertainDispatches"].as_array().unwrap().len(), 1);
    assert_eq!(
        budget["uncertainDispatches"][0]["nativeShellGrant"],
        message["permissionGrants"][0]
    );
    let artifact_metadata = std::fs::read_dir(f.root.path().join("shell-artifacts"))
        .unwrap()
        .map(|entry| {
            entry
                .unwrap()
                .path()
                .join(tool["output"]["taskId"].as_str().unwrap())
                .join("metadata.json")
        })
        .find(|path| path.is_file())
        .map(get)
        .expect("metadata from the original affected command");
    assert_eq!(
        artifact_metadata["output"]["stopReason"],
        tool["output"]["stopReason"]
    );
    assert_eq!(artifact_metadata["managedProcessEnded"], true);
    assert_eq!(server.requests.lock().unwrap().len(), 1);

    f.seed(
        "overlap",
        "overlap-chat",
        "overlap-session",
        "overlap-work",
        "overlap-epoch",
    );
    let overlapping = f.command("exec", "overlap").output().unwrap();
    assert!(!overlapping.status.success());
    assert!(String::from_utf8_lossy(&overlapping.stderr).contains("execution_resource_busy"));
    assert_eq!(server.requests.lock().unwrap().len(), 1);

    // A different work directory can proceed while the interrupted write
    // scope still requires its original reconciliation.
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let independent = f.root.path().join("independent");
    std::fs::create_dir(&independent).unwrap();
    let path = f.root.path().join("goal-plans/p2.json");
    let mut plan = get(&path);
    plan["targetWorkspacePath"] = json!(independent);
    put(path, &plan);
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(f.history(), history);
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn actual_interpreter_exit_without_a_command_frame_preserves_captured_output_and_unknown() {
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"printf 'actual error' >&2; exec /bin/sh -c 'exit 7'"}),
    )]);
    let f = Fixture::new(&server);
    let output = f.run();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("execution_outcome_unknown"));
    let history = f.history();
    let message = history
        .iter()
        .find(|m| m["segments"][0]["tool"] == "bash")
        .unwrap();
    let result = &message["segments"][0]["result"];
    assert_eq!(result["error"]["code"], "execution_outcome_unknown");
    assert!(result["output"]["exitCode"].is_null());
    assert_eq!(result["output"]["stderr"], "actual error");
    assert!(result["evidence"]["artifactRefs"].is_array());
    let budget = f.budget(|_| {});
    let unknown = &budget["uncertainDispatches"][0];
    assert_eq!(unknown["toolCallId"], result["toolCallId"]);
    assert_eq!(unknown["nativeShellGrant"], message["permissionGrants"][0]);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn explicit_exit_in_bash_command_returns_exit_code_and_keeps_shell_alive() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf 'actual error' >&2; exit 7"}),
        ),
        reply_tool("bash", json!({"command":"printf 'still-alive'; exit 0"})),
        reply_text("Handled non-zero exit and continued."),
    ]);
    let f = Fixture::new(&server);
    let output = f.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let history = f.history();
    let first = &history[1]["segments"][0]["result"];
    assert_eq!(first["status"], "failed");
    assert!(first["error"].is_null());
    assert_eq!(first["output"]["exitCode"], 7);
    assert_eq!(first["output"]["stderr"], "actual error");
    let second = &history[2]["segments"][0]["result"];
    assert_eq!(second["status"], "success");
    assert_eq!(second["output"]["exitCode"], 0);
    assert_eq!(second["output"]["stdout"], "still-alive");
    let budget = f.budget(|_| {});
    assert!(budget["uncertainDispatches"].as_array().unwrap().is_empty());
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}
