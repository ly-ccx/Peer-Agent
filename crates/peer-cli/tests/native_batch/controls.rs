use super::*;
fn ready(f: &Fixture, child: &mut OwnedChild, first: usize, count: usize) {
    let deadline = Instant::now() + Duration::from_secs(10);
    for i in first..first + count {
        while !f
            .root
            .path()
            .join(format!("batch-worker-{i}-ready"))
            .exists()
        {
            assert!(child.child().try_wait().unwrap().is_none());
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
    }
}
fn finish(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.child().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "native batch command did not finish within the existing eight-second bound"
        );
        thread::sleep(Duration::from_millis(5));
    }
    child.output()
}
fn input(concurrency: usize) -> Value {
    json!({"queries":(0..8).map(|i|json!({"id":format!("lane-{i}"),"query":"source"})).collect::<Vec<_>>(),"max_concurrency":concurrency})
}
#[test]
fn requested_concurrency_and_the_global_worker_bound_are_observed_by_real_scans() {
    for concurrency in [1, 8] {
        let server = Server::new(vec![
            reply_tool("batch_search", input(concurrency)),
            reply_text("Batch completed."),
        ]);
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(
            f.command("exec", "p")
                .env("PEER_NATIVE_BATCH_BARRIER", "hold")
                .spawn()
                .unwrap(),
        ));
        let workers = concurrency.min(2);
        ready(&f, &mut child, 0, workers);
        thread::sleep(Duration::from_millis(100));
        assert!(
            !f.root
                .path()
                .join(format!("batch-worker-{workers}-ready"))
                .exists()
        );
        std::fs::write(f.root.path().join("batch-worker-resume"), "resume").unwrap();
        let out = finish(child);
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let h = f.history();
        let output = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"]
            ["output"];
        assert_eq!(output["completedCount"], 8);
        assert_eq!(output["concurrency"], concurrency);
        assert_eq!(output["aggregated"]["matches"][0]["hitCount"], 8);
    }
}
#[test]
fn cancellation_and_revocation_drain_every_worker_preserve_facts_and_allow_new_work() {
    for revoke in [false, true] {
        let server = Server::new(vec![
            reply_tool("batch_search", input(8)),
            reply_text("Observed stop."),
            reply_text("Later task."),
        ]);
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(
            f.command("exec", "p")
                .env("PEER_NATIVE_BATCH_BARRIER", "hold")
                .spawn()
                .unwrap(),
        ));
        ready(&f, &mut child, 0, 2);
        if revoke {
            let lease = f.root.path().join("project-runtime/w/host.lease");
            let before = get(&lease)["heartbeatAt"].clone();
            let deadline = Instant::now() + Duration::from_secs(8);
            while get(&lease)["heartbeatAt"] == before {
                assert!(
                    Instant::now() < deadline,
                    "batch scans starved the Host heartbeat"
                );
                assert!(child.child().try_wait().unwrap().is_none());
                thread::sleep(Duration::from_millis(10));
            }
            let store = PolicyStore::new(f.root.path());
            let p = store.read_existing("w").unwrap();
            store
                .update_existing(
                    "w",
                    p.revision,
                    peer_protocol::LocalAccessLevel::AskBeforeLocal,
                    AT,
                )
                .unwrap();
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::INT,
            )
            .unwrap();
        }
        let _out = finish(child);
        let h = f.history();
        let result = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
        assert_eq!(
            result["status"],
            if revoke { "failed" } else { "cancelled" }
        );
        assert_eq!(
            result["error"]["code"],
            if revoke {
                "permission_policy_changed"
            } else {
                "CANCELLED"
            }
        );
        assert_eq!(result["output"]["laneCount"], 8);
        assert_eq!(result["output"]["completedCount"], 0);
        assert!(result["evidence"].is_object());
        assert!(
            !f.root.path().join("batch-worker-2-ready").exists(),
            "queued work read after control stop"
        );
        f.seed("p2", "c2", "s2", "work2", "epoch2");
        let later = f.command("exec", "p2").output().unwrap();
        assert!(
            later.status.success(),
            "{}",
            String::from_utf8_lossy(&later.stderr)
        );
    }
}

#[test]
fn already_observed_lanes_survive_control_stop_without_starting_queued_reads() {
    for revoke in [false, true] {
        let server = Server::new(vec![
            reply_tool("batch_search", input(8)),
            reply_text("Partial observation retained."),
            reply_text("Later task."),
        ]);
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(
            f.command("exec", "p")
                .env("PEER_NATIVE_BATCH_BARRIER", "after-first")
                .spawn()
                .unwrap(),
        ));
        // Lane2 can occupy a worker only after lane0 has really completed.
        // Lane1 and lane2 are then held before their file reads.
        ready(&f, &mut child, 1, 2);
        if revoke {
            let store = PolicyStore::new(f.root.path());
            let p = store.read_existing("w").unwrap();
            store
                .update_existing(
                    "w",
                    p.revision,
                    peer_protocol::LocalAccessLevel::AskBeforeLocal,
                    AT,
                )
                .unwrap();
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::INT,
            )
            .unwrap();
        }
        let _out = finish(child);
        let h = f.history();
        let result = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
        assert_eq!(
            result["status"],
            if revoke { "failed" } else { "cancelled" }
        );
        assert_eq!(result["output"]["status"], "partial");
        assert_eq!(result["output"]["completedCount"], 1);
        assert_eq!(result["output"]["lanes"][0]["status"], "completed");
        assert_eq!(
            result["output"]["aggregated"]["matches"][0]["text"],
            "source fact"
        );
        assert_eq!(
            result["output"]["aggregated"]["matches"][0]["laneIds"],
            json!(["lane-0"])
        );
        assert!(!f.root.path().join("batch-worker-3-ready").exists());
        f.seed("p2", "c2", "s2", "work2", "epoch2");
        let later = f.command("exec", "p2").output().unwrap();
        assert!(
            later.status.success(),
            "{}",
            String::from_utf8_lossy(&later.stderr)
        );
    }
}

#[test]
fn hard_exit_after_batch_observation_keeps_unknown_and_recovery_never_replays_it() {
    let server = Server::new(vec![
        reply_tool("batch_search", input(8)),
        reply_text("Later task."),
    ]);
    let f = Fixture::new(&server);
    let out = f
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_FAULT_AFTER_EFFECT", "batch_search")
        .output()
        .unwrap();
    assert_eq!(out.status.code(), Some(77));
    assert_eq!(f.history().len(), 1);
    f.age_dead_lease();
    let retry = f.command("exec", "p").output().unwrap();
    assert!(!retry.status.success());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let out = f.command("recover", "p").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let facts: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(facts["facts"]["control"]["phase"], "reconciling");
    assert_eq!(
        facts["facts"]["control"]["stopReceipt"]["unknownCalls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(f.history().len(), 1);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let unknown = f.budget(|_| {});
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let blocked = f.command("exec", "p2").output().unwrap();
    assert!(!blocked.status.success());
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("execution_resource_busy"));
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    // An undeclared interrupted batch retains the original conservative
    // namespace protection. Use a genuinely independent directory, not a new
    // task ID inside that protected namespace, and never clear the old unknown.
    let directory = f.root.path().join("independent-workspace");
    std::fs::create_dir(&directory).unwrap();
    f.seed("p3", "c3", "s3", "work3", "epoch3");
    let path = f.root.path().join("goal-plans/p3.json");
    let mut goal = get(&path);
    goal["targetWorkspacePath"] = json!(directory);
    put(&path, &goal);
    let later = f.command("exec", "p3").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert_eq!(f.budget(|_| {}), unknown);
    assert_eq!(f.history().len(), 1);
}

#[test]
fn continuously_ready_authorization_does_not_starve_the_real_signal_watcher() {
    let server = Server::new(vec![
        reply_tool("batch_search", input(8)),
        reply_text("Later task."),
    ]);
    let f = Fixture::new(&server);
    let mut child = OwnedChild(Some(
        f.command("exec", "p")
            .env("PEER_NATIVE_BATCH_BARRIER", "hold")
            .env("PEER_NATIVE_AUTH_CONTROL_BARRIER", "slow")
            .spawn()
            .unwrap(),
    ));
    ready(&f, &mut child, 0, 2);
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::INT,
    )
    .unwrap();
    let started = Instant::now();
    let _out = finish(child);
    let elapsed = started.elapsed();
    put(
        f.root.path().join("batch-cancel-timing.json"),
        &json!({"signalToCommandExitMs":elapsed.as_millis(),"boundMs":8000,"controlledSynchronousCheckMs":100}),
    );
    assert!(elapsed < Duration::from_secs(8));
    let h = f.history();
    let result = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["error"]["code"], "CANCELLED");
    assert_eq!(result["output"]["completedCount"], 0);
    assert!(!f.root.path().join("batch-worker-2-ready").exists());
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
}
