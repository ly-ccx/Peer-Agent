//! Public Host seam; original observations must survive workspace mutation.
use super::*;
#[test]
fn large_file_read_is_persisted_as_an_immutable_snapshot_before_model_continuation() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("Snapshot read."),
    ]);
    let f = Fixture::new(&server);
    let text = "original🦀 fact\n".repeat(10000);
    std::fs::write(f.root.path().join("workspace/input.txt"), &text).unwrap();
    let output = f.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let h = f.history();
    let m = h.iter().find(|m| m["segments"].is_array()).unwrap();
    let result = &m["segments"][0]["result"];
    assert_eq!(result["status"], "success", "{result}");
    let out = &result["output"];
    assert_eq!(out["kind"], "local_file_ref");
    assert_eq!(out["truncated"], true);
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(out["nativeContentRef"].clone()).unwrap();
    assert_eq!(reference.bytes, text.len() as u64);
    assert_eq!(out["chars"], text.encode_utf16().count());
    assert!(out["preview"].as_str().unwrap().encode_utf16().count() <= 1200);
    assert_eq!(m["permissionGrants"][0]["granted"], true);
    assert!(result["evidence"].is_object());
    let store = peer_store::ToolArtifactStore::new(f.root.path());
    std::fs::write(
        f.root.path().join("workspace/input.txt"),
        "changed current workspace",
    )
    .unwrap();
    let w = store
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    assert!(w.complete);
    assert_eq!(w.bytes, text.as_bytes());
    let req = server.requests.lock().unwrap();
    assert_eq!(req.len(), 2);
    let model_content = req[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    assert!(!model_content.contains(&text));
    assert!(model_content.contains(&reference.sha256));
}
#[test]
fn write_above_previous_argument_and_file_limits_crosses_the_actual_grant_chain() {
    let content = "w".repeat(90 * 1024);
    let server = Server::new(vec![
        reply_tool("write_file", json!({"path":"large.txt","content":content})),
        reply_text("Large write complete."),
    ]);
    let f = Fixture::new(&server);
    let output = f.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/large.txt")).unwrap(),
        content
    );
    let h = f.history();
    let m = h.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(m["permissionGrants"][0]["granted"], true);
    assert_eq!(m["segments"][0]["result"]["status"], "success");
}

#[test]
fn structured_list_output_is_saved_as_json_without_erasing_the_canonical_result() {
    let server = Server::new(vec![
        reply_tool("list_files", json!({"path":"."})),
        reply_text("Listed."),
    ]);
    let f = Fixture::new(&server);
    for i in 0..400 {
        std::fs::write(
            f.root.path().join(format!("workspace/item-{i:04}.txt")),
            "fact",
        )
        .unwrap();
    }
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let m = h.iter().find(|m| m["segments"].is_array()).unwrap();
    let r = &m["segments"][0]["result"];
    assert_eq!(r["status"], "success");
    assert_eq!(r["output"]["kind"], "local_tool_result_ref");
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(r["output"]["nativeContentRef"].clone()).unwrap();
    assert_eq!(reference.format, peer_store::ToolArtifactFormat::Json);
    let window = peer_store::ToolArtifactStore::new(f.root.path())
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    assert!(window.complete);
    let original: Value = serde_json::from_slice(&window.bytes).unwrap();
    assert_eq!(original["entries"].as_array().unwrap().len(), 401);
    assert_eq!(m["permissionGrants"][0]["granted"], true);
    assert!(r["evidence"].is_object());
}
fn saved_reference(text: &str) -> peer_store::ToolArtifactRef {
    let root = tempfile::tempdir().unwrap();
    std::fs::create_dir(root.path().join("conversations")).unwrap();
    std::fs::write(root.path().join("conversations/c.jsonl"), "{}").unwrap();
    peer_store::ToolArtifactStore::new(root.path())
        .publish_utf8("c", text, &|| false)
        .unwrap()
}
#[test]
fn snapshot_reader_uses_live_grant_evidence_and_rejects_cross_conversation_or_damage() {
    for case in ["original", "foreign", "corrupt"] {
        let text = "immutable saved fact 🦀";
        let mut reference = saved_reference(text);
        if case == "foreign" {
            reference.conversation_id = "foreign".into();
        }
        let server = Server::new(vec![
            reply_tool(
                "read_tool_result",
                json!({"reference":reference,"offset":0,"length":4096}),
            ),
            reply_tool("read_file", json!({"path":"input.txt"})),
            reply_text("Later tool admitted."),
        ]);
        let f = Fixture::new(&server);
        let store = peer_store::ToolArtifactStore::new(f.root.path());
        if case == "foreign" {
            std::fs::write(f.root.path().join("conversations/foreign.jsonl"), "{}").unwrap();
        }
        assert_eq!(
            store
                .publish_utf8(&reference.conversation_id, text, &|| false)
                .unwrap(),
            reference
        );
        let path = store.path(&reference.conversation_id, &reference).unwrap();
        if case == "corrupt" {
            std::fs::write(&path, "externally damaged").unwrap();
        }
        let original = std::fs::read(&path).unwrap();
        let output = f.run();
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let h = f.history();
        let tools = h
            .iter()
            .filter(|m| m["segments"].is_array())
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), 2);
        let result = &tools[0]["segments"][0]["result"];
        assert_eq!(tools[0]["permissionGrants"][0]["granted"], true);
        assert!(result["evidence"].is_object());
        if case == "original" {
            assert_eq!(result["status"], "success");
            assert_eq!(result["output"]["content"], text);
            assert_eq!(result["output"]["complete"], true);
        } else {
            assert_eq!(result["status"], "failed");
            assert_eq!(
                result["error"]["code"],
                if case == "foreign" {
                    "artifact_invalid"
                } else {
                    "artifact_corrupt"
                }
            );
        }
        assert_eq!(tools[1]["segments"][0]["result"]["status"], "success");
        assert_eq!(std::fs::read(&path).unwrap(), original);
    }
}
#[test]
fn archive_quota_failure_preserves_pending_dispatch_and_recovery_never_replays_it() {
    use std::os::unix::fs::PermissionsExt;
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("New task admitted."),
    ]);
    let f = Fixture::new(&server);
    let text = "large observed content\n".repeat(1000);
    std::fs::write(f.root.path().join("workspace/input.txt"), &text).unwrap();
    let dir = f.root.path().join("conversations/c.tool-results");
    std::fs::create_dir(&dir).unwrap();
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).unwrap();
    let partial = dir.join(".partial-retained");
    let file = std::fs::File::create(&partial).unwrap();
    file.set_len(268435456).unwrap();
    let out = f.run();
    assert!(!out.status.success());
    // Stop/reconciliation deliberately takes precedence over the archive error:
    // the original dispatch remains unknown rather than claiming no effect.
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("execution_outcome_unknown"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        f.history().len(),
        1,
        "unpublished content cannot become a successful result"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let retry = f.run();
    assert!(!retry.status.success());
    assert_eq!(
        server.requests.lock().unwrap().len(),
        1,
        "no model or tool replay"
    );
    let recovered = f.command("recover", "p").output().unwrap();
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    let receipt: Value = serde_json::from_slice(&recovered.stdout).unwrap();
    assert_eq!(
        receipt["facts"]["control"]["stopReceipt"]["unknownCalls"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert_eq!(std::fs::metadata(&partial).unwrap().len(), 268435456);
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        text
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let blocked = f.command("exec", "p2").output().unwrap();
    assert!(
        !blocked.status.success(),
        "the unresolved original scope stays protected"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let independent = f.root.path().join("independent-workspace");
    std::fs::create_dir(&independent).unwrap();
    let path = f.root.path().join("goal-plans/p2.json");
    let mut goal = get(&path);
    goal["targetWorkspacePath"] = json!(independent);
    put(&path, &goal);
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn cancellation_joins_the_real_snapshot_reader_waiting_on_an_os_lock() {
    let text = "saved observation";
    let reference = saved_reference(text);
    let server = Server::new(vec![
        reply_tool("read_tool_result", json!({"reference":reference})),
        reply_text("Fresh task."),
    ]);
    let f = Fixture::new(&server);
    let store = peer_store::ToolArtifactStore::new(f.root.path());
    store.publish_utf8("c", text, &|| false).unwrap();
    let directory = store
        .path("c", &reference)
        .unwrap()
        .parent()
        .unwrap()
        .to_owned();
    let lock = std::fs::File::open(&directory).unwrap();
    rustix::fs::flock(&lock, rustix::fs::FlockOperation::LockExclusive).unwrap();
    let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let dir = f
            .root
            .path()
            .join("project-runtime/w/coordination-v2/segments");
        let dispatched = std::fs::read_dir(dir)
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .any(|e| {
                std::fs::read_to_string(e.path())
                    .is_ok_and(|s| s.contains("\"capabilityId\":\"local.tool-result.read\""))
            });
        if dispatched {
            break;
        }
        assert!(
            child.child().try_wait().unwrap().is_none(),
            "reader stopped before dispatch"
        );
        assert!(Instant::now() < deadline, "dispatch observation timeout");
        thread::sleep(Duration::from_millis(10));
    }
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while child.child().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "owned reader failed to join after cancellation"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let out = child.output();
    assert_eq!(
        out.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let r = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert!(r["output"]["content"].is_null());
    assert_eq!(
        r["status"], "cancelled",
        "structured cancellation must not become an ordinary failure"
    );
    drop(lock);
    assert_eq!(
        store
            .read_window("c", &reference, 0, 100, &|| false)
            .unwrap()
            .bytes,
        text.as_bytes()
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
}

#[test]
fn file_v2_pressure_rejects_before_write_and_never_publishes_a_partial_read() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("Oversized read refused."),
    ]);
    let f = Fixture::new(&server);
    std::fs::write(
        f.root.path().join("workspace/input.txt"),
        vec![b'x'; 2000001],
    )
    .unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let r = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert_eq!(r["status"], "failed");
    assert_eq!(r["error"]["code"], "file_too_large");
    assert!(!f.root.path().join("conversations/c.tool-results").exists());
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"too-large.txt","content":"x".repeat(131073)}),
    )]);
    let f = Fixture::new(&server);
    let out = f.run();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("file_write_too_large"));
    assert!(!f.root.path().join("workspace/too-large.txt").exists());
    assert_eq!(f.history().len(), 1);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn escaped_output_beyond_the_old_result_budget_remains_editable_and_keeps_its_original_snapshot() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_tool(
            "edit_file",
            json!({"path":"input.txt","old_string":"tail","new_string":"end"}),
        ),
        reply_text("Edited after archived read."),
    ]);
    let f = Fixture::new(&server);
    let original = format!("{}tail", "\u{1}".repeat(60000));
    std::fs::write(f.root.path().join("workspace/input.txt"), &original).unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let tools = h
        .iter()
        .flat_map(|m| m["segments"].as_array().into_iter().flatten())
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 2);
    assert_eq!(tools[0]["result"]["status"], "success");
    assert_eq!(tools[1]["result"]["status"], "success");
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(tools[0]["result"]["output"]["nativeContentRef"].clone()).unwrap();
    assert_eq!(
        peer_store::ToolArtifactStore::new(f.root.path())
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap()
            .bytes,
        original.as_bytes()
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        format!("{}end", "\u{1}".repeat(60000))
    );
}
