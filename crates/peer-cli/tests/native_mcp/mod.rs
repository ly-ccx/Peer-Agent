//! Real CLI -> native model HTTP -> granted Provider -> native MCP -> Evidence.
use super::*;
fn registry(f: &Fixture, mode: &str) {
    put(
        f.root.path().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","name":"Native MCP","enabled":true,"transport":"stdio","command":env!("CARGO_BIN_EXE_mcp-test-fixture"),"args":[mode],"env":{"MCP_FIXTURE_ROOT":f.root.path(),"MCP_SECRET":"fixture-sensitive-secret"},"tools":[{"name":"read_fact","description":"Read a synthetic fact","inputSchema":{"type":"object","properties":{}}}]}]}),
    );
}
fn requests(f: &Fixture) -> Vec<Value> {
    std::fs::read_to_string(f.root.path().join("mcp.requests"))
        .unwrap_or_default()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}
fn wait_file(f: &Fixture, name: &str) {
    let until = Instant::now() + Duration::from_secs(12);
    while !f.root.path().join(name).exists() {
        assert!(Instant::now() < until, "{name} not observed");
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn stdio_grant_transport_result_evidence_and_owned_stop_are_native() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("MCP verified"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "");
    let output = f.run();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let calls = requests(&f);
    assert_eq!(
        calls.iter().filter(|v| v["method"] == "initialize").count(),
        1
    );
    assert_eq!(
        calls.iter().filter(|v| v["method"] == "tools/call").count(),
        2
    );
    assert_eq!(calls[0]["params"]["capabilities"], json!({}));
    let history = f.history();
    let text = serde_json::to_string(&history).unwrap();
    assert!(text.contains("native MCP fact"));
    assert!(text.contains("local_mcp_tool_call"));
    assert!(text.contains("permissionGrantId"));
    assert!(text.contains("projectionId"));
    assert!(text.contains("[REDACTED]"));
    assert!(!text.contains("fixture-sensitive-secret"));
    assert!(text.contains("retained"));
    let pid: u32 = std::fs::read_to_string(f.root.path().join("mcp.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()),
        Err(rustix::io::Errno::SRCH)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}
#[test]
fn ask_denies_before_transport_and_does_not_turn_visibility_into_permission() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("Approval needed"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "");
    PolicyStore::new(f.root.path())
        .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
        .unwrap();
    let output = f.run();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!f.root.path().join("mcp.pid").exists());
    assert!(requests(&f).is_empty());
    assert!(
        serde_json::to_string(&f.history())
            .unwrap()
            .contains("permission_denied")
    );
}
#[test]
fn registry_change_during_initialize_invalidates_the_original_grant_before_tools_call() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("not dispatched"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "gate");
    let child = f.command("exec", "p").spawn().unwrap();
    let child = OwnedChild(Some(child));
    wait_file(&f, "mcp.ready");
    let path = f.root.path().join("mcp-registry.json");
    let mut changed = get(&path);
    changed["servers"][0]["name"] = json!("new revision");
    put(path, &changed);
    std::fs::write(f.root.path().join("mcp.release"), "go").unwrap();
    let output = child.output();
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!f.root.path().join("mcp.effect").exists());
    assert!(!requests(&f).iter().any(|v| v["method"] == "tools/call"));
    let b = f.budget(|_| {});
    assert_eq!(b["uncertainDispatches"].as_array().map_or(0, Vec::len), 0);
}
#[test]
fn remote_error_is_known_but_lost_or_oversized_results_preserve_unknown_effects() {
    for (mode, unknown) in [
        ("business_error", false),
        ("rpc_error", false),
        ("disconnect", true),
        ("oversize", true),
        ("large_valid", true),
    ] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("observed"),
        ]);
        let f = Fixture::new(&server);
        registry(&f, mode);
        let output = f.run();
        assert_eq!(
            output.status.code(),
            Some(if unknown { 1 } else { 0 }),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(f.root.path().join("mcp.effect").exists());
        let budget = f.budget(|_| {});
        assert_eq!(
            budget["uncertainDispatches"].as_array().map_or(0, Vec::len) > 0,
            unknown,
            "{mode}: {budget}"
        );
        assert_eq!(
            requests(&f)
                .iter()
                .filter(|v| v["method"] == "tools/call")
                .count(),
            1
        );
    }
}

mod credentials;
mod http;
mod network;
mod oauth;
#[test]
fn streamable_json_sse_and_legacy_endpoint_sse_have_real_native_tool_loops() {
    for (legacy, sse) in [(false, false), (false, true), (true, true)] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("HTTP verified"),
        ]);
        let f = Fixture::new(&server);
        let mcp = http::Http::new(legacy, sse);
        put(
            f.root.path().join("mcp-registry.json"),
            &json!({"version":1,"servers":[{"id":"s","transport":if legacy{"sse"}else{"streamable_http"},"url":mcp.url,"headers":{"X-Fixture-Token":"synthetic-http-secret"},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
        );
        let output = f.run();
        assert_eq!(
            output.status.code(),
            Some(0),
            "legacy={legacy} sse={sse}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = mcp.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(_, v)| v["method"] == "tools/call")
                .count(),
            1
        );
        let (headers, _) = requests
            .iter()
            .find(|(_, v)| v["method"] == "tools/call")
            .unwrap();
        assert!(
            headers
                .to_lowercase()
                .contains("x-fixture-token: synthetic-http-secret")
        );
        if legacy {
            assert!(requests.iter().any(|(h, _)| h.starts_with("GET /mcp ")));
            assert!(headers.starts_with("POST /rpc "));
        } else {
            assert!(
                headers
                    .to_lowercase()
                    .contains("mcp-session-id: native-fixture-session")
            );
            assert!(
                headers
                    .to_lowercase()
                    .contains("mcp-protocol-version: 2025-11-25")
            );
        }
        assert!(
            serde_json::to_string(&f.history())
                .unwrap()
                .contains("native HTTP MCP fact")
        );
    }
}
#[test]
fn policy_revocation_after_initialize_prevents_tools_call_and_records_not_dispatched() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("revoked"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "gate");
    let child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    wait_file(&f, "mcp.ready");
    PolicyStore::new(f.root.path())
        .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
        .unwrap();
    std::fs::write(f.root.path().join("mcp.release"), "go").unwrap();
    let output = child.output();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!f.root.path().join("mcp.effect").exists());
    assert!(!requests(&f).iter().any(|v| v["method"] == "tools/call"));
    let history = serde_json::to_string(&f.history()).unwrap();
    assert!(history.contains("not_dispatched"));
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}
#[test]
fn hard_exit_recovers_original_mcp_child_without_replay_and_retains_external_unknown() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    registry(&f, "stall");
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    wait_file(&f, "mcp.effect");
    child.child().kill().unwrap();
    let _ = child.output();
    f.age_dead_lease();
    let output = f.command("recover", "p").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let raw: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(raw.to_string().contains("unfenced_external"));
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(ledger_rows(&f).len(), 1);
    assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
    let retry = f.command("recover", "p").output().unwrap();
    assert_eq!(retry.status.code(), Some(0));
    assert_eq!(ledger_rows(&f).len(), 1);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let directory = f.root.path().join("independent-worktree");
    std::fs::create_dir(&directory).unwrap();
    let path = f.root.path().join("goal-plans/p2.json");
    let mut goal = get(&path);
    goal["targetWorkspacePath"] = json!(directory);
    put(path, &goal);
    let output = f.command("exec", "p2").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
}

#[test]
fn initialize_failure_reaps_the_child_and_records_a_definite_not_dispatched_result() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("initialize failed"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "init_disconnect");
    let output = f.run();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!f.root.path().join("mcp.effect").exists());
    assert!(
        serde_json::to_string(&f.history())
            .unwrap()
            .contains("not_dispatched")
    );
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}
#[test]
fn signal_cancellation_stops_native_mcp_and_retains_the_sent_effect_as_unknown() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    registry(&f, "stall");
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    wait_file(&f, "mcp.effect");
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = child.output();
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let h = serde_json::to_string(&f.history()).unwrap();
    assert!(h.contains("execution_outcome_unknown"));
    assert!(h.contains("cancelled"));
    let pid: u32 = std::fs::read_to_string(f.root.path().join("mcp.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()),
        Err(rustix::io::Errno::SRCH)
    );
}
#[test]
fn actual_mcp_deadline_closes_the_owned_connection_without_retrying_the_sent_call() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    registry(&f, "stall");
    let start = Instant::now();
    let output = f.run();
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(start.elapsed() >= Duration::from_secs(30));
    assert!(start.elapsed() < Duration::from_secs(45));
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
    assert!(
        serde_json::to_string(&f.history())
            .unwrap()
            .contains("mcp_timeout")
    );
}

#[test]
fn real_pty_approval_grants_only_one_mcp_call_and_second_denial_does_not_dispatch() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("one allowed, one denied"),
    ]);
    let f = Fixture::new(&server);
    registry(&f, "");
    PolicyStore::new(f.root.path())
        .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
        .unwrap();
    let master =
        rustix::pty::openpt(rustix::pty::OpenptFlags::RDWR | rustix::pty::OpenptFlags::NOCTTY)
            .unwrap();
    rustix::io::fcntl_setfd(&master, rustix::io::FdFlags::CLOEXEC).unwrap();
    rustix::pty::grantpt(&master).unwrap();
    rustix::pty::unlockpt(&master).unwrap();
    let path = rustix::pty::ptsname(&master, Vec::new()).unwrap();
    let slave = rustix::fs::open(
        path.as_c_str(),
        rustix::fs::OFlags::RDWR | rustix::fs::OFlags::NOCTTY | rustix::fs::OFlags::CLOEXEC,
        rustix::fs::Mode::empty(),
    )
    .unwrap();
    let child = OwnedChild(Some(
        f.command("exec", "p")
            .stdin(Stdio::from(rustix::io::dup(&slave).unwrap()))
            .stderr(Stdio::from(slave))
            .spawn()
            .unwrap(),
    ));
    for answer in [b"y\n", b"n\n"] {
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut bytes = Vec::new();
        while !String::from_utf8_lossy(&bytes).contains("[y/N]") {
            assert!(Instant::now() < deadline, "approval prompt missing");
            let mut poll = [rustix::event::PollFd::new(
                &master,
                rustix::event::PollFlags::IN,
            )];
            if rustix::event::poll(
                &mut poll,
                Some(&rustix::event::Timespec {
                    tv_sec: 0,
                    tv_nsec: 20_000_000,
                }),
            )
            .unwrap()
                > 0
            {
                let mut chunk = [0; 8192];
                let n = rustix::io::read(&master, &mut chunk).unwrap();
                bytes.extend_from_slice(&chunk[..n]);
            }
        }
        rustix::io::write(&master, answer).unwrap();
    }
    let output = child.output();
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
    let calls: Vec<_> = f
        .history()
        .iter()
        .flat_map(|v| v["segments"].as_array().into_iter().flatten().cloned())
        .collect();
    assert_eq!(calls[0]["result"]["status"], "success");
    assert_eq!(calls[1]["result"]["status"], "denied");
    assert_ne!(calls[0]["toolCallId"], calls[1]["toolCallId"]);
}

struct FixtureMcpOwner(peer_runtime::recorder::Recorder);
impl Drop for FixtureMcpOwner {
    fn drop(&mut self) {
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        if runtime.block_on(peer_runtime::recorder::prove(&self.0))
            == peer_runtime::recorder::RecorderProof::Alive
        {
            let pid = rustix::process::Pid::from_raw(self.0.pid as i32).unwrap();
            if rustix::process::getpgid(Some(pid)).ok() == Some(pid) {
                let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
            }
        }
    }
}
#[test]
fn future_mcp_handle_metadata_blocks_recovery_without_erasing_it_then_original_identity_recovers() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    registry(&f, "stall");
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    wait_file(&f, "mcp.effect");
    child.child().kill().unwrap();
    let _ = child.output();
    f.age_dead_lease();
    let mut store = ExecutionResourceStore::open_existing_writable(f.root.path()).unwrap();
    let claim = store
        .snapshot()
        .unwrap()
        .into_iter()
        .find(|c| c["execution"]["planId"] == "p")
        .unwrap();
    let plan = peer_store::HostResourcePlan {
        execution: peer_protocol::normalize_session_execution_identity(&claim["execution"])
            .unwrap(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().join("workspace")),
        title: "Native task".into(),
        read_only: false,
    };
    let original = claim["handles"]
        .as_object()
        .unwrap()
        .values()
        .find(|h| h["nativeMcp"]["role"] == "connection")
        .unwrap()
        .clone();
    let _owner = FixtureMcpOwner(
        serde_json::from_value(original["nativeMcp"]["childRecorder"].clone()).unwrap(),
    );
    let mut future = original.clone();
    future["nativeMcp"]["schemaVersion"] = json!(99);
    store.mark_handle(&plan, &future, AT).unwrap();
    drop(store);
    let output = f.command("recover", "p").output().unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_execution_stop_unproven"));
    let mut store = ExecutionResourceStore::open_existing_writable(f.root.path()).unwrap();
    let retained = store.unsettled_handles(&plan).unwrap();
    assert!(retained.iter().any(|h| h == &future));
    store.mark_handle(&plan, &original, AT).unwrap();
    drop(store);
    if f.root.path().join("project-runtime/w/host.lease").exists() {
        f.age_dead_lease();
    }
    let output = f.command("recover", "p").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("unfenced_external"));
    assert_eq!(
        requests(&f)
            .iter()
            .filter(|v| v["method"] == "tools/call")
            .count(),
        1
    );
}

#[test]
fn streamable_http_answers_server_ping_while_waiting_for_the_tool_result() {
    for same_id in [false, true] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("duplex verified"),
        ]);
        let f = Fixture::new(&server);
        let mcp = http::Http::duplex(same_id);
        put(
            f.root.path().join("mcp-registry.json"),
            &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":mcp.url,"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
        );
        let output = f.run();
        put(
            f.root.path().join("mcp-http-trace.json"),
            &json!({"events":*mcp.events.lock().unwrap(),"requests":*mcp.requests.lock().unwrap()}),
        );
        assert_eq!(
            output.status.code(),
            Some(0),
            "same_id={same_id}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            *mcp.events.lock().unwrap(),
            ["ping_queued", "pong_received", "tool_result_sent"].repeat(2)
        );
        let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["toolCalls"], 2);
        assert_eq!(server.requests.lock().unwrap().len(), 3);
        let requests = mcp.requests.lock().unwrap();
        for (headers, _) in requests.iter().filter(|(_, v)| v["method"] == "tools/call") {
            assert!(
                headers
                    .to_lowercase()
                    .contains("mcp-protocol-version: 2025-11-25"),
                "tool data changed negotiated protocol: {headers}"
            );
        }
        assert!(
            serde_json::to_string(&f.history())
                .unwrap()
                .contains("untrusted-result-not-negotiation")
        );
        let (_, call) = requests
            .iter()
            .find(|(_, v)| v["method"] == "tools/call")
            .unwrap();
        let (_, pong) = requests
            .iter()
            .find(|(_, v)| v["method"].is_null() && v.get("result").is_some())
            .expect("actual JSON-RPC ping response");
        assert_eq!(pong["result"], json!({}));
        assert_eq!(
            pong["id"],
            if same_id {
                call["id"].clone()
            } else {
                json!("server-ping")
            }
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(_, v)| v["method"] == "tools/call")
                .count(),
            2
        );
        assert_eq!(
            f.budget(|_| {})["uncertainDispatches"]
                .as_array()
                .map_or(0, Vec::len),
            0
        );
        assert!(
            serde_json::to_string(&f.history())
                .unwrap()
                .contains("native HTTP MCP fact")
        );
    }
}

#[test]
fn http_control_rejection_and_cancellation_keep_the_original_tool_unknown_without_retry() {
    for stall in [false, true] {
        let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
        let f = Fixture::new(&server);
        let mcp = http::Http::duplex_fault(stall);
        put(
            f.root.path().join("mcp-registry.json"),
            &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":mcp.url,"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
        );
        let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
        let deadline = Instant::now() + Duration::from_secs(8);
        while !mcp.events.lock().unwrap().contains(&"pong_received") {
            assert!(Instant::now() < deadline, "control POST missing");
            thread::sleep(Duration::from_millis(10));
        }
        if stall {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        }
        let deadline = Instant::now() + Duration::from_secs(6);
        while child.child().try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "owned control request failed to stop"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let output = child.output();
        put(
            f.root.path().join("mcp-http-trace.json"),
            &json!({"events":*mcp.events.lock().unwrap(),"requests":*mcp.requests.lock().unwrap()}),
        );
        assert_eq!(
            output.status.code(),
            Some(1),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            f.budget(|_| {})["uncertainDispatches"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        let requests = mcp.requests.lock().unwrap();
        assert_eq!(
            requests
                .iter()
                .filter(|(_, v)| v["method"] == "tools/call")
                .count(),
            1
        );
        assert_eq!(
            requests
                .iter()
                .filter(|(_, v)| v["method"].is_null() && v.get("result").is_some())
                .count(),
            1
        );
        assert_eq!(ledger_rows(&f).len(), 1);
        assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
        if stall {
            let deadline = Instant::now() + Duration::from_secs(1);
            while !mcp.events.lock().unwrap().contains(&"control_closed") {
                assert!(Instant::now() < deadline, "control socket stayed open");
                thread::sleep(Duration::from_millis(10));
            }
        }
    }
}

#[test]
fn cancellation_during_initialize_is_a_cancelled_not_dispatched_fact_and_reaps_the_server() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    registry(&f, "gate");
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    wait_file(&f, "mcp.ready");
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.child().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(10));
    }
    let output = child.output();
    assert_eq!(output.status.code(), Some(4));
    let history = f.history();
    let result = &history[1]["segments"][0]["result"];
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert!(!f.root.path().join("mcp.effect").exists());
    assert!(!requests(&f).iter().any(|v| v["method"] == "tools/call"));
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
    let pid: u32 = std::fs::read_to_string(f.root.path().join("mcp.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()),
        Err(rustix::io::Errno::SRCH)
    );
    assert_eq!(ledger_rows(&f).len(), 1);
    assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
}
