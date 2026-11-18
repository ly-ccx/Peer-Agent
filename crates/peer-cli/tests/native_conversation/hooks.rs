use super::*;
fn hook_file(fixture: &Ordinary, relative: &str, value: Value) {
    let file = fixture.root.path().join(relative);
    std::fs::create_dir_all(file.parent().unwrap()).unwrap();
    put(file, &value);
}
fn results(fixture: &Ordinary) -> Vec<Value> {
    let meta = fixture.metadata();
    let store = ConversationStore::new(fixture.home());
    let history = store
        .read_committed(meta["id"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    history
        .history
        .messages
        .into_iter()
        .flat_map(|message| message["segments"].as_array().cloned().unwrap_or_default())
        .filter_map(|segment| segment.get("result").cloned())
        .collect()
}

#[test]
fn public_hook_allows_through_original_grant_and_records_pre_and_post_observations() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("source.txt"),
        "owned fixture source",
    )
    .unwrap();
    hook_file(
        &fixture,
        "data/hooks/hooks.json",
        json!({"hooks":{"PreToolUse":[
            {"id":"global-check","command":r#"/bin/cat > fixture-pre.json; printf '%s' '{"decision":"allow","reason":"checked"}'"#,"match":{"capabilityId":"local.file.read"}}
        ]}}),
    );
    hook_file(
        &fixture,
        "workspace/.peer/hooks.json",
        json!({"hooks":{"PostToolUse":[
            {"id":"workspace-check","command":r#"/bin/cat > fixture-post.json; printf '%s' '{"decision":"deny","reason":"observation only"}'"#,"match":{"argumentsPattern":"source.txt"}}
        ]}}),
    );
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"source.txt"})),
        reply_text("Done"),
    ]);
    let output = fixture.run(
        Some(&server),
        &["--output-format", "json", "Read source"],
        None,
    );
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 2, 1);
    let results = results(&fixture);
    assert_eq!(results[0]["status"], "success");
    let evidence = &results[0]["evidence"];
    assert_eq!(evidence["hooks"][0]["id"], "global-check");
    assert_eq!(evidence["hooks"][0]["decision"], "allow");
    assert_eq!(evidence["hooks"][1]["id"], "workspace-check");
    assert_eq!(evidence["hooks"][1]["decision"], "deny");
    assert_eq!(evidence["hookFinalDecision"], "allow");
    let pre = get(fixture.workspace().join("fixture-pre.json"));
    let post = get(fixture.workspace().join("fixture-post.json"));
    assert_eq!(pre["event"], "PreToolUse");
    assert_eq!(post["event"], "PostToolUse");
    assert_eq!(pre["call"]["toolCallId"], results[0]["toolCallId"]);
    assert_eq!(post["result"]["status"], "success");
    assert_eq!(post["result"]["toolCallId"], pre["call"]["toolCallId"]);
    assert_eq!(pre["conversationId"], fixture.metadata()["id"]);
    let requests = server.requests.lock().unwrap();
    assert!(!requests[1].to_string().contains("observation only"));
}

#[test]
fn public_hook_deny_and_timeout_do_not_dispatch_the_provider_even_with_full_access() {
    for (command, timeout_ms, outcome) in [
        (
            r#"printf '%s' '{"decision":"deny","reason":"policy"}'"#,
            3000,
            "ok",
        ),
        ("exec /bin/sleep 30", 120, "timeout"),
    ] {
        let fixture = Ordinary::new();
        hook_file(
            &fixture,
            "workspace/.peer/hooks.json",
            json!({"hooks":{"PreToolUse":[
                {"id":"policy","command":command,"timeoutMs":timeout_ms,"match":{"capabilityId":"local.shell.exec"}}
            ]}}),
        );
        let server = Server::new(vec![
            reply_tool("bash", json!({"command":"/usr/bin/touch must-not-exist"})),
            reply_text("Denied"),
        ]);
        let output = fixture.run(
            Some(&server),
            &[
                "--access",
                "full",
                "--output-format",
                "json",
                "Use a local tool",
            ],
            None,
        );
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.assert_settled(&output, 2, 1);
        let result = &results(&fixture)[0];
        assert_eq!(result["status"], "denied");
        assert_eq!(result["error"]["code"], "hook_denied");
        assert_eq!(result["evidence"]["hooks"][0]["outcome"], outcome);
        assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
        assert!(!fixture.workspace().join("must-not-exist").exists());
    }
}

#[test]
fn public_ordinary_hook_ask_without_approval_does_not_read_the_source() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("source.txt"),
        "NATIVE-PRIVATE-SOURCE-SENTINEL",
    )
    .unwrap();
    hook_file(
        &fixture,
        "workspace/.peer/hooks.json",
        json!({"hooks":{"PreToolUse":[
            {"id":"review","command":r#"printf '%s' '{"decision":"ask"}'"#}
        ]}}),
    );
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"source.txt"})),
        reply_text("Denied"),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--access",
            "full",
            "--output-format",
            "json",
            "Try approved read",
        ],
        None,
    );
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|r| r.to_string().contains("NATIVE-PRIVATE-SOURCE-SENTINEL"))
    );
    assert!(
        output.status.success(),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 2, 1);
    assert_eq!(results(&fixture)[0]["status"], "denied");
    assert_eq!(
        results(&fixture)[0]["error"]["code"],
        "hook_approval_required"
    );
    assert_eq!(results(&fixture)[0]["evidence"]["hookFinalDecision"], "ask");
}

fn running_hook(fixture: &Ordinary) -> (String, u32) {
    let path = fixture.home().join("conversations/index.jsonl");
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(raw) = std::fs::read_to_string(&path)
            && let Ok(meta) = serde_json::from_str::<Value>(raw.trim())
            && let Some(process) =
                meta["runtimeExecution"]["handles"]
                    .as_array()
                    .and_then(|handles| {
                        handles
                            .iter()
                            .find_map(peer_store::conversation_hook_process)
                    })
            && let Some(child) = process.child
        {
            return (meta["id"].as_str().unwrap().to_owned(), child.pid);
        }
        assert!(
            Instant::now() < deadline,
            "Hook child identity never became durable"
        );
        thread::sleep(Duration::from_millis(10));
    }
}
fn long_hook(fixture: &Ordinary) {
    hook_file(
        fixture,
        "workspace/.peer/hooks.json",
        json!({"hooks":{"PreToolUse":[
            {"id":"long-pre","command":"exec /bin/sleep 30","timeoutMs":40000}
        ]}}),
    );
}
fn dead_group(pid: u32) -> bool {
    rustix::process::test_kill_process_group(rustix::process::Pid::from_raw(pid as i32).unwrap())
        == Err(rustix::io::Errno::SRCH)
}

#[test]
fn public_ordinary_hook_sigterm_reaps_the_group_and_preserves_the_observed_cancellation() {
    let fixture = Ordinary::new();
    long_hook(&fixture);
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"/usr/bin/touch target-untouched"}),
    )]);
    let child = fixture
        .command(Some(&server))
        .args(["--output-format", "json", "Use shell"])
        .spawn()
        .unwrap();
    let (_, pid) = running_hook(&fixture);
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait(child);
    assert_eq!(
        output.status.code(),
        Some(4),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 1, 1);
    assert_eq!(reply["error"], "CANCELLED");
    let result = &results(&fixture)[0];
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["evidence"]["hooks"][0]["outcome"], "CANCELLED");
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert!(dead_group(pid));
    assert!(!fixture.workspace().join("target-untouched").exists());
}

#[test]
fn public_ordinary_hook_owner_death_stops_recorded_group_but_keeps_its_unknown_outcome() {
    let fixture = Ordinary::new();
    long_hook(&fixture);
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"/usr/bin/touch must-not-replay"}),
    )]);
    let mut child = fixture
        .command(Some(&server))
        .args(["--output-format", "json", "Use shell"])
        .spawn()
        .unwrap();
    let (id, pid) = running_hook(&fixture);
    recovery::kill_after_store_publication(&fixture, &id, &mut child);
    let reply = recovery::recover(&fixture, &id);
    assert_eq!(
        reply.status.code(),
        Some(1),
        "{} {}",
        String::from_utf8_lossy(&reply.stdout),
        String::from_utf8_lossy(&reply.stderr)
    );
    let store = ConversationStore::new(fixture.home());
    let run = store.read_conversation_execution(&id).unwrap().unwrap();
    assert_eq!(run.handles.len(), 1);
    let process = peer_store::conversation_hook_process(&run.handles[0]).unwrap();
    assert_eq!(process.state, peer_protocol::NativeProcessState::Ended);
    assert_eq!(
        process.stop_observation,
        Some(peer_protocol::NativeProcessStop::OwnerDeadGroupAbsent)
    );
    assert!(peer_store::conversation_hook_observation(&run.handles[0]).is_none());
    assert_eq!(run.pending_tools.len(), 1);
    assert!(run.usage_committed);
    assert!(dead_group(pid));
    assert!(!fixture.workspace().join("must-not-replay").exists());
    assert!(results(&fixture).is_empty());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let fresh = Server::new(vec![reply_text("Independent request")]);
    let next = fixture.run(Some(&fresh), &["Another independent conversation"], None);
    assert!(
        next.status.success(),
        "{}",
        String::from_utf8_lossy(&next.stderr)
    );
    assert_eq!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .handles,
        run.handles
    );
}

#[test]
fn public_ordinary_post_hook_interruption_keeps_the_already_observed_provider_effect() {
    let fixture = Ordinary::new();
    hook_file(
        &fixture,
        "workspace/.peer/hooks.json",
        json!({"hooks":{"PostToolUse":[
            {"id":"long-post","command":"exec /bin/sleep 30","timeoutMs":40000}
        ]}}),
    );
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"owned-effect.txt","content":"observed provider effect"}),
    )]);
    let child = fixture
        .command(Some(&server))
        .args(["--output-format", "json", "Write file"])
        .spawn()
        .unwrap();
    let (_, pid) = running_hook(&fixture);
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait(child);
    assert_eq!(
        output.status.code(),
        Some(4),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 1, 1);
    let result = &results(&fixture)[0];
    assert_eq!(result["status"], "success");
    assert_eq!(result["evidence"]["hooks"][0]["event"], "PostToolUse");
    assert_eq!(result["evidence"]["hooks"][0]["outcome"], "CANCELLED");
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("owned-effect.txt")).unwrap(),
        "observed provider effect"
    );
    assert!(dead_group(pid));
}

#[cfg(feature = "test-fixtures")]
#[test]
fn observed_pre_hook_survives_a_host_crash_before_provider_dispatch() {
    let mut fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    hook_file(
        &fixture,
        "workspace/.peer/hooks.json",
        json!({"hooks":{"PreToolUse":[
            {"id":"known-pre","command":r#"printf '%s' '{"decision":"deny","reason":"known before crash"}'"#}
        ]}}),
    );
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"untouched","content":"never"}),
    )]);
    let child = fixture
        .command(Some(&server))
        .args(["--output-format", "json", "Write file"])
        .env("PEER_NATIVE_ORDINARY_FAULT", "after_hook_observed")
        .spawn()
        .unwrap();
    let output = wait(child);
    assert_eq!(output.status.code(), Some(88));
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    let resumed = recovery::recover(&fixture, &id);
    if !resumed.status.success() {
        fixture.root.disable_cleanup(true);
        eprintln!("Recovery fixture: {}", fixture.root.path().display());
        let hooks = fixture.metadata()["runtimeExecution"]["handles"]
            .as_array()
            .unwrap()
            .clone();
        eprintln!("Provider results: {}", json!(results(&fixture)));
        eprintln!(
            "Parsed hook: {:?}",
            peer_store::conversation_hook_observation(&hooks[0])
        );
    }
    assert!(
        resumed.status.success(),
        "{} {}",
        String::from_utf8_lossy(&resumed.stdout),
        String::from_utf8_lossy(&resumed.stderr)
    );
    let result = &results(&fixture)[0];
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["evidence"]["hooks"][0]["id"], "known-pre");
    assert_eq!(
        result["evidence"]["hooks"][0]["reason"],
        "known before crash"
    );
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert!(!fixture.workspace().join("untouched").exists());
}

#[test]
fn public_ordinary_hook_configuration_replacement_stops_the_original_child_before_provider_dispatch()
 {
    let fixture = Ordinary::new();
    long_hook(&fixture);
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"must-not-write","content":"never"}),
    )]);
    let child = fixture
        .command(Some(&server))
        .args(["--output-format", "json", "Write under existing Hook"])
        .spawn()
        .unwrap();
    let (_, pid) = running_hook(&fixture);
    hook_file(&fixture, "workspace/.peer/hooks.json", json!({"hooks":{}}));
    let output = wait(child);
    assert_eq!(
        output.status.code(),
        Some(1),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 1, 1);
    assert_eq!(reply["error"], "native_hook_source_changed");
    let result = &results(&fixture)[0];
    assert_eq!(result["status"], "denied");
    assert_eq!(
        result["evidence"]["hooks"][0]["outcome"],
        "native_hook_source_changed"
    );
    assert!(dead_group(pid));
    assert!(!fixture.workspace().join("must-not-write").exists());
    let later = Server::new(vec![reply_text("New configuration observed")]);
    let fresh = fixture.run(Some(&later), &["Continue independently"], None);
    assert!(
        fresh.status.success(),
        "{}",
        String::from_utf8_lossy(&fresh.stderr)
    );
}
