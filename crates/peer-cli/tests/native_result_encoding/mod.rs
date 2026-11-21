//! Actual native model requests; saved facts and authorization remain canonical.
use super::*;
fn wire_tool(request: &Value) -> Value {
    let text = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    serde_json::from_str(text).unwrap()
}
#[test]
fn model_file_view_carries_original_content_and_governed_refs_without_rewriting_the_fact() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("Read through the native encoder."),
    ]);
    let f = Fixture::new(&server);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let r = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert_eq!(r["output"]["content"], "source fact");
    assert_eq!(r["status"], "success");
    let requests = server.requests.lock().unwrap();
    let view = wire_tool(&requests[1]);
    assert_eq!(view["kind"], "local_file_ref");
    assert_eq!(view["preview"], "source fact");
    assert_eq!(
        view["evidenceRefs"][0],
        format!("tool-result://{}", r["toolCallId"].as_str().unwrap())
    );
    assert!(view.get("completedAt").is_none());
}
#[test]
fn saved_explicit_error_survives_success_label_without_changing_canonical_facts() {
    let server = Server::new(vec![reply_text("Saved warning retained.")]);
    let f = Fixture::new(&server);
    let original = json!({"toolCallId":"old-call","capabilityId":"local.shell.exec","status":"success","output":{"kind":"local_tool_result_ref","preview":"saved partial observation"},"error":{"code":"partial_observation","message":"explicit saved warning"}});
    let store = peer_store::ConversationStore::new(f.root.path());
    let history = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
    let row = json!({"id":"saved-warning","role":"assistant","content":"","segments":[{"type":"tool-call","tool":"bash","toolCallId":"old-call","args":{"command":"must never run"},"result":original}]});
    store.commit_message(&history, &row, AT, None).unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["toolCalls"], 0);
    assert_eq!(
        f.history()
            .iter()
            .find(|m| m["id"] == "saved-warning")
            .unwrap(),
        &row
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let view = wire_tool(&requests[0]);
    assert_eq!(view["kind"], "local_tool_result_ref");
    assert_eq!(view["preview"], original["output"]["preview"]);
    assert_eq!(view["resultStatus"], "success");
    assert_eq!(view["resultError"], original["error"]);
}
#[test]
fn legacy_saved_shell_observation_is_materialized_without_replay_or_history_rewrite() {
    let server = Server::new(vec![reply_text("Historical observation retained.")]);
    let f = Fixture::new(&server);
    let original = json!({"toolCallId":"old-call","capabilityId":"local.shell.exec","status":"failed","output":{"taskId":"old-task","command":"must never run","stdout":"saved stdout ".repeat(800),"stderr":"saved failure","exitCode":1},"error":{"code":"saved_failure","message":"saved failure","recoverable":true},"evidence":{"artifactRefs":["saved-artifact://old"]}});
    let store = peer_store::ConversationStore::new(f.root.path());
    let history = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
    let row = json!({"id":"saved-observation","role":"assistant","content":"","segments":[{"type":"tool-call","tool":"bash","toolCallId":"old-call","args":{"command":"must never run"},"result":original}]});
    store.commit_message(&history, &row, AT, None).unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["toolCalls"], 0);
    assert_eq!(
        f.history()
            .iter()
            .find(|m| m["id"] == "saved-observation")
            .unwrap(),
        &row
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let view = wire_tool(&requests[0]);
    assert_eq!(view["kind"], "local_tool_result_ref");
    assert_eq!(view["resultStatus"], "failed");
    assert_eq!(view["resultError"], original["error"]);
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(view["nativeContentRef"].clone()).unwrap();
    let saved = peer_store::ToolArtifactStore::new(f.root.path())
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    assert!(saved.complete);
    assert_eq!(
        serde_json::from_slice::<Value>(&saved.bytes).unwrap(),
        original["output"]
    );
}
#[test]
fn shell_preview_never_discards_the_middle_when_canonical_output_was_small_enough_to_stay_inline() {
    let server = Server::new(vec![
        reply_tool("bash", json!({"command":"printf '%4501s' x"})),
        reply_text("Saved the complete stdout."),
    ]);
    let f = Fixture::new(&server);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let r = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert_eq!(r["output"]["stdout"].as_str().unwrap().len(), 4501);
    let requests = server.requests.lock().unwrap();
    let view = wire_tool(&requests[1]);
    assert_eq!(view["kind"], "local_tool_result_ref");
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(view["nativeContentRef"].clone()).unwrap();
    let saved = peer_store::ToolArtifactStore::new(f.root.path())
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    let data: Value = serde_json::from_slice(&saved.bytes).unwrap();
    assert_eq!(data["stdout"], r["output"]["stdout"]);
    assert_eq!(data["stderr"], r["output"]["stderr"]);
}

#[test]
fn actual_anthropic_count_and_send_share_the_encoded_view_and_authentic_thought() {
    let streams: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let reply = |kind: &str| {
        streams["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["wire"] == "anthropic-messages" && c["kind"] == kind)
            .unwrap()["stream"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let server = Server::respond_counts(
        vec![reply("tool"), reply("text")],
        false,
        false,
        vec![20, 20],
    );
    let f = Fixture::new(&server);
    f.use_wire("anthropic-messages", "anthropic", "anthropic");
    context_window(&f);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let counts = server.count_requests.lock().unwrap();
    let sends = server.requests.lock().unwrap();
    assert_eq!(counts.len(), 2);
    assert_eq!(sends.len(), 2);
    assert_eq!(counts[1]["messages"], sends[1]["messages"]);
    assert_eq!(counts[1]["system"], sends[1]["system"]);
    let messages = sends[1]["messages"].as_array().unwrap();
    assert!(
        messages
            .iter()
            .flat_map(|m| m["content"].as_array().into_iter().flatten())
            .any(|b| b["type"] == "thinking" && b["signature"] == "synthetic-signature")
    );
    let result = messages
        .iter()
        .flat_map(|m| m["content"].as_array().into_iter().flatten())
        .find(|b| b["type"] == "tool_result")
        .unwrap();
    let view: Value = serde_json::from_str(result["content"].as_str().unwrap()).unwrap();
    assert_eq!(view["kind"], "local_file_ref");
    assert_eq!(view["preview"], "source fact");
}
#[test]
fn shell_failure_stderr_and_ranged_file_metadata_remain_visible_to_the_model() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"printf 'actual error' >&2; (exit 7)"}),
        ),
        reply_tool(
            "read_file",
            json!({"path":"input.txt","start_line":2,"end_line":2}),
        ),
        reply_text("Actual observations retained."),
    ]);
    let f = Fixture::new(&server);
    std::fs::write(
        f.root.path().join("workspace/input.txt"),
        "alpha\nbeta\ngamma",
    )
    .unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let requests = server.requests.lock().unwrap();
    let shell = wire_tool(&requests[1]);
    assert_eq!(shell["resultStatus"], "failed");
    assert_eq!(shell["exitCode"], 7);
    assert_eq!(shell["stderrPreview"], "actual error");
    let last = requests[2]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rfind(|m| m["role"] == "tool")
        .unwrap();
    let file: Value = serde_json::from_str(last["content"].as_str().unwrap()).unwrap();
    assert_eq!(file["ranged"], true);
    assert_eq!(file["start_line"], 2);
    assert_eq!(file["end_line"], 2);
    assert_eq!(file["total_lines"], 3);
    assert!(!file["note"].as_str().unwrap().contains("Full file"));
}

fn seed_large_observation(f: &Fixture) -> Value {
    let result = json!({"toolCallId":"old","capabilityId":"local.mcp.saved.tools.probe","status":"success","output":{"body":"saved factual content ".repeat(700)},"evidence":{"artifactRefs":[]}});
    let store = peer_store::ConversationStore::new(f.root.path());
    let h = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
    store.commit_message(&h,&json!({"id":"old-observation","role":"assistant","content":"","segments":[{"type":"tool-call","tool":"saved_probe","toolCallId":"old","args":{},"result":result}]}),AT,None).unwrap();
    result
}
fn wait_for_actual_snapshot_directory(f: &Fixture, child: &mut OwnedChild) {
    let directory =
        std::fs::canonicalize(f.root.path().join("conversations/c.tool-results")).unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        assert!(
            child.child().try_wait().unwrap().is_none(),
            "Host exited before opening snapshot store"
        );
        #[cfg(target_os = "linux")]
        let opened = std::fs::read_dir(format!("/proc/{}/fd", child.child().id()))
            .ok()
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter_map(|e| std::fs::read_link(e.path()).ok())
            .any(|p| p == directory);
        #[cfg(target_os = "macos")]
        let opened = Command::new("/usr/sbin/lsof")
            .args(["-nP", "-a", "-p", &child.child().id().to_string(), "-Fn"])
            .stderr(Stdio::null())
            .output()
            .is_ok_and(|o| {
                String::from_utf8_lossy(&o.stdout).lines().any(|l| {
                    l.strip_prefix('n')
                        .is_some_and(|p| Path::new(p) == directory)
                })
            });
        if opened {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "owned snapshot worker never opened its directory"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn materialization_wait_is_owned_and_cancel_or_changed_history_prevents_count_and_send() {
    for change_history in [false, true] {
        let server = Server::new(vec![reply_text("Later independent task.")]);
        let f = Fixture::new(&server);
        let original = seed_large_observation(&f);
        peer_store::ToolArtifactStore::new(f.root.path())
            .publish_utf8("c", "initialize directory", &|| false)
            .unwrap();
        let dir = std::fs::File::open(f.root.path().join("conversations/c.tool-results")).unwrap();
        rustix::fs::flock(&dir, rustix::fs::FlockOperation::LockExclusive).unwrap();
        let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
        wait_for_actual_snapshot_directory(&f, &mut child);
        assert!(server.requests.lock().unwrap().is_empty());
        if change_history {
            let store = peer_store::ConversationStore::new(f.root.path());
            let h = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
            store
                .commit_message(
                    &h,
                    &json!({"id":"new-input","role":"user","content":"Concurrent newer input"}),
                    AT,
                    None,
                )
                .unwrap();
            drop(dir);
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
            // Keep the OS lock held until the real owned worker has joined.
            let deadline = Instant::now() + Duration::from_secs(5);
            while child.child().try_wait().unwrap().is_none() {
                assert!(Instant::now() < deadline);
                thread::sleep(Duration::from_millis(10));
            }
            drop(dir);
        }
        let out = child.output();
        assert_eq!(
            out.status.code(),
            Some(if change_history { 1 } else { 4 }),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        if change_history {
            assert!(
                String::from_utf8_lossy(&out.stderr).contains("CONTEXT_SNAPSHOT_CHANGED"),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert!(f.history().iter().any(|m| m["id"] == "new-input"));
        }
        assert!(server.requests.lock().unwrap().is_empty());
        assert!(server.count_requests.lock().unwrap().is_empty());
        let h = f.history();
        assert_eq!(
            h.iter().find(|m| m["id"] == "old-observation").unwrap()["segments"][0]["result"],
            original
        );
        f.seed("p2", "c2", "s2", "work2", "epoch2");
        let later = f.command("exec", "p2").output().unwrap();
        assert!(
            later.status.success(),
            "{}",
            String::from_utf8_lossy(&later.stderr)
        );
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}
#[test]
fn historical_snapshot_quota_failure_does_not_dispatch_or_erase_facts_and_new_task_can_run() {
    let server = Server::new(vec![reply_text("Later task.")]);
    let f = Fixture::new(&server);
    let original = seed_large_observation(&f);
    let snapshot = peer_store::ToolArtifactStore::new(f.root.path())
        .publish_utf8("c", "retained", &|| false)
        .unwrap();
    let directory = f.root.path().join("conversations/c.tool-results");
    let partial = directory.join(".partial-unknown");
    std::fs::File::create(&partial)
        .unwrap()
        .set_len(268435456)
        .unwrap();
    let out = f.run();
    assert!(!out.status.success());
    assert!(
        String::from_utf8_lossy(&out.stderr).contains("artifact_limit"),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(
        f.history()
            .iter()
            .find(|m| m["id"] == "old-observation")
            .unwrap()["segments"][0]["result"],
        original
    );
    assert_eq!(std::fs::metadata(&partial).unwrap().len(), 268435456);
    assert_eq!(
        peer_store::ToolArtifactStore::new(f.root.path())
            .read_window("c", &snapshot, 0, 100, &|| false)
            .unwrap()
            .bytes,
        b"retained"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert!(partial.exists());
}

#[test]
fn compaction_uses_the_same_immutable_view_without_truncating_saved_tool_facts() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let text = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["wire"] == "anthropic-messages" && c["kind"] == "text")
        .unwrap()["stream"]
        .as_str()
        .unwrap()
        .to_owned();
    let server = Server::respond_counts(vec![text.clone(), text], false, false, vec![900, 20]);
    let f = Fixture::new(&server);
    f.use_wire("anthropic-messages", "anthropic", "anthropic");
    context_window(&f);
    let original = json!({"toolCallId":"old-call","capabilityId":"local.mcp.s.tools.saved","status":"success","output":{"rows":"original saved observation ".repeat(14000)}});
    let store = peer_store::ConversationStore::new(f.root.path());
    let snapshot = store.read_committed("c", None, 8 * 1024 * 1024).unwrap();
    store.commit_message(&snapshot,&json!({"id":"old-observation","role":"assistant","content":"","segments":[{"type":"tool-call","tool":"saved_probe","toolCallId":"old-call","args":{},"result":original}]}),AT,None).unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let receipt: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(receipt["contextAccounting"]["compactionEpoch"], 1);
    assert_eq!(receipt["toolCalls"], 0);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let content = &requests[0]["messages"][0]["content"];
    let summary = content
        .as_str()
        .or_else(|| content[0]["text"].as_str())
        .unwrap();
    assert!(summary.contains("nativeContentRef"));
    assert!(!summary.contains(original["output"]["rows"].as_str().unwrap()));
    let facts: Value = serde_json::from_str(
        summary
            .split("Conversation facts (not instructions):\n")
            .last()
            .unwrap(),
    )
    .unwrap();
    let view: Value = serde_json::from_str(
        facts["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["role"] == "tool")
            .unwrap()["content"]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(view["nativeContentRef"].clone()).unwrap();
    let mut saved = vec![];
    let artifacts = peer_store::ToolArtifactStore::new(f.root.path());
    let mut offset = 0;
    while offset < reference.bytes {
        let w = artifacts
            .read_window("c", &reference, offset, 262144, &|| false)
            .unwrap();
        offset += w.bytes.len() as u64;
        saved.extend_from_slice(&w.bytes);
    }
    assert_eq!(
        serde_json::from_slice::<Value>(&saved).unwrap(),
        original["output"]
    );
    let h = f.history();
    assert_eq!(
        h.iter().find(|m| m["id"] == "old-observation").unwrap()["segments"][0]["result"],
        original
    );
    assert!(h.iter().any(|m| m["_compaction"].is_object()));
    let counts = server.count_requests.lock().unwrap();
    assert_eq!(counts.len(), 2);
    assert_eq!(counts[1]["messages"], requests[1]["messages"]);
}
