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

#[test]
fn public_delegated_hook_denies_the_original_work_call_with_no_provider_effect() {
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"/usr/bin/touch goal-must-not-exist"}),
        ),
        reply_text("Goal policy completed"),
    ]);
    let fixture = Fixture::new(&server);
    std::fs::create_dir_all(fixture.root.path().join("workspace/.peer")).unwrap();
    put(
        fixture.root.path().join("workspace/.peer/hooks.json"),
        &json!({"hooks":{"PreToolUse":[
            {"id":"goal-policy","command":r#"printf '%s' '{"decision":"deny","reason":"goal-policy"}'"#,
             "match":{"capabilityId":"local.shell.exec"}}
        ]}}),
    );
    let output = fixture.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    assert!(
        !fixture
            .root
            .path()
            .join("workspace/goal-must-not-exist")
            .exists()
    );
    let history = fixture.history();
    let result = history
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .find(|segment| segment["result"]["capabilityId"] == "local.shell.exec")
        .map(|segment| &segment["result"])
        .expect("original canonical Tool Result");
    assert_eq!(result["status"], "denied");
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert_eq!(result["evidence"]["hooks"][0]["reason"], "goal-policy");
    let budget = fixture.budget(|_| {});
    assert_eq!(budget["toolCalls"], 1);
    assert!(
        budget["uncertainDispatches"]
            .as_array()
            .is_none_or(|v| v.is_empty())
    );
}

fn work_hook_config(fixture: &Fixture, hooks: Value) {
    let directory = fixture.root.path().join("workspace/.peer");
    std::fs::create_dir_all(&directory).unwrap();
    put(directory.join("hooks.json"), &json!({"hooks":hooks}));
}

fn work_hook_result(fixture: &Fixture, capability: &str) -> Value {
    fixture
        .history()
        .into_iter()
        .flat_map(|row| row["segments"].as_array().cloned().unwrap_or_default())
        .find_map(|segment| {
            let result = &segment["result"];
            (result["capabilityId"] == capability).then(|| result.clone())
        })
        .expect("original canonical Work Tool Result")
}

#[test]
fn public_delegated_hook_uses_existing_approval_and_observes_provider_result() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"work-approved","content":"actual effect"}),
        ),
        reply_text("Worker done"),
    ]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PreToolUse":[{
                "id":"must-confirm","command":r#"printf '%s' '{"decision":"ask"}'"#,
                "match":{"capabilityId":"local.file.write"}
            }],
            "PostToolUse":[{
                "id":"observe-write","command":r#"/bin/cat > hook-observed.json; printf '%s' '{"decision":"deny"}'"#,
                "match":{"capabilityId":"local.file.write"}
            }]
        }),
    );
    let (master, child) = permission_pty(&fixture);
    wait_permission_prompt(&master);
    assert!(!fixture.root.path().join("workspace/work-approved").exists());
    rustix::io::write(&master, b"y\n").unwrap();
    wait_permission_decision(&fixture, "approved");
    let output = wait_permission_episode(child);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/work-approved")).unwrap(),
        "actual effect"
    );
    let result = work_hook_result(&fixture, "local.file.write");
    let observed = get(fixture.root.path().join("workspace/hook-observed.json"));
    assert_eq!(observed["result"]["toolCallId"], result["toolCallId"]);
    assert_eq!(observed["result"]["status"], "success");
    assert_eq!(result["status"], "success");
    assert_eq!(result["evidence"]["hookFinalDecision"], "ask");
    assert_eq!(result["evidence"]["hooks"][1]["decision"], "deny");
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn public_delegated_hook_ask_rejects_headless_and_revokes_waiting_approval() {
    for revoke in [false, true] {
        let server = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"work-not-approved","content":"never"}),
            ),
            reply_text("Worker denied"),
        ]);
        let fixture = Fixture::new(&server);
        work_hook_config(
            &fixture,
            json!({
                "PreToolUse":[{"id":"confirm","command":r#"printf '%s' '{"decision":"ask"}'"#}]
            }),
        );
        let output = if revoke {
            let (master, child) = permission_pty(&fixture);
            wait_permission_prompt(&master);
            work_hook_config(&fixture, json!({}));
            wait_permission_decision(&fixture, "cancelled");
            wait_permission_episode(child)
        } else {
            fixture.run()
        };
        assert_eq!(
            output.status.success(),
            !revoke,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result = work_hook_result(&fixture, "local.file.write");
        assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
        assert_eq!(result["evidence"]["hooks"][0]["decision"], "ask");
        assert_eq!(
            result["error"]["code"],
            if revoke {
                "native_hook_source_changed"
            } else {
                "hook_approval_required"
            }
        );
        assert!(
            !fixture
                .root
                .path()
                .join("workspace/work-not-approved")
                .exists()
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            if revoke { 1 } else { 2 }
        );
    }
}

fn wait_for_work_hook(fixture: &Fixture) -> u32 {
    let dir = fixture
        .root
        .path()
        .join("project-runtime/w/coordination-v2/segments");
    let pid_file = fixture.root.path().join("workspace/hook-child.pid");
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        if let Ok(value) = std::fs::read_to_string(&pid_file)
            && let Ok(pid) = value.trim().parse::<u32>()
            && std::fs::read_dir(&dir)
                .into_iter()
                .flatten()
                .flatten()
                .any(|entry| {
                    std::fs::read_to_string(entry.path()).is_ok_and(|text| {
                        text.contains("\"nativeHooks\"")
                            && text.contains("\"state\":\"running\"")
                            && text.contains(&format!("\"pid\":{pid}"))
                    })
                })
        {
            return pid;
        }
        assert!(
            Instant::now() < deadline,
            "Hook child identity was not persisted"
        );
        thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn public_delegated_hook_reaps_real_child_after_owner_death_and_retains_unknown() {
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"work-unknown","content":"must never dispatch"}),
    )]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PreToolUse":[{
                "id":"hard-stop","timeoutMs":30000,
                "command":"printf '%s' \"$$\" > hook-child.pid; exec /bin/sleep 30"
            }]
        }),
    );
    let mut owner = OwnedChild(Some(fixture.command("exec", "p").spawn().unwrap()));
    let pid = wait_for_work_hook(&fixture);
    owner.child().kill().unwrap();
    let _ = owner.output();
    fixture.age_dead_lease();
    let reply = fixture.command("recover", "p").output().unwrap();
    assert!(
        reply.status.success(),
        "{}",
        String::from_utf8_lossy(&reply.stderr)
    );
    let after = fixture.budget(|_| {});
    let uncertain = after["uncertainDispatches"].as_array().unwrap();
    assert_eq!(uncertain.len(), 1);
    assert_eq!(uncertain[0]["nativeHooks"]["providerPhase"], "prepared");
    let hook = &uncertain[0]["nativeHooks"]["handles"][0];
    assert_eq!(hook["process"]["state"], "ended");
    assert_eq!(
        hook["process"]["stopObservation"],
        "owner_dead_group_absent"
    );
    assert!(hook.get("observation").is_none());
    assert_eq!(hook["process"]["child"]["pid"], pid);
    assert!(dead_group(pid));
    assert!(!fixture.root.path().join("workspace/work-unknown").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let second = fixture.command("recover", "p").output().unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(fixture.budget(|_| {}), after);
}

#[test]
fn public_delegated_hook_post_cancel_preserves_real_provider_result() {
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"post-effect","content":"already observed"}),
    )]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PostToolUse":[{
                "id":"post-stop","timeoutMs":30000,
                "command":"printf '%s' \"$$\" > hook-child.pid; exec /bin/sleep 30"
            }]
        }),
    );
    let mut owner = OwnedChild(Some(fixture.command("exec", "p").spawn().unwrap()));
    let pid = wait_for_work_hook(&fixture);
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(owner.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait_permission_episode(owner);
    assert!(
        !output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    let result = work_hook_result(&fixture, "local.file.write");
    assert_eq!(result["status"], "success");
    assert_eq!(result["evidence"]["hooks"][0]["event"], "PostToolUse");
    assert_eq!(result["evidence"]["hooks"][0]["outcome"], "CANCELLED");
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/post-effect")).unwrap(),
        "already observed"
    );
    assert!(dead_group(pid));
}

#[cfg(feature = "test-fixtures")]
#[test]
fn public_delegated_hook_with_missing_start_identity_remains_unproven() {
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"uncertain-start","content":"never replay"}),
    )]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PreToolUse":[{"id":"missing-start","command":"printf effect > hook-unproven"}]
        }),
    );
    let original = fixture
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_HOOK_FAULT", "after_starting")
        .output()
        .unwrap();
    assert_eq!(original.status.code(), Some(77));
    fixture.age_dead_lease();
    let recovery = fixture.command("recover", "p").output().unwrap();
    assert!(!recovery.status.success());
    assert!(String::from_utf8_lossy(&recovery.stderr).contains("native_execution_stop_unproven"));
    let budget = fixture.budget(|_| {});
    let hooks = budget["attempts"]
        .as_object()
        .unwrap()
        .values()
        .next()
        .unwrap()["pendingTools"][0]["nativeHooks"]
        .clone();
    assert_eq!(hooks["handles"][0]["process"]["state"], "starting");
    assert!(hooks["handles"][0]["process"].get("child").is_none());
    assert!(hooks["handles"][0].get("observation").is_none());
    assert!(
        !fixture
            .root
            .path()
            .join("workspace/uncertain-start")
            .exists()
    );
    assert!(!fixture.root.path().join("workspace/hook-unproven").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn observed_delegated_pre_hook_recovers_unlaunched_original_provider_call() {
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"pre-crash-target","content":"never dispatch"}),
    )]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PreToolUse":[{
                "id":"seen-pre","command":r#"printf '%s' '{"decision":"deny","reason":"verified pre"}'"#
            }]
        }),
    );
    let original = fixture
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_HOOK_FAULT", "after_pre_observed")
        .output()
        .unwrap();
    assert_eq!(original.status.code(), Some(77));
    fixture.age_dead_lease();
    let first = fixture.command("recover", "p").output().unwrap();
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let result = work_hook_result(&fixture, "local.file.write");
    assert_eq!(result["status"], "cancelled");
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
    assert_eq!(result["evidence"]["hooks"][0]["reason"], "verified pre");
    assert!(
        !fixture
            .root
            .path()
            .join("workspace/pre-crash-target")
            .exists()
    );
    let after = fixture.budget(|_| {});
    assert!(
        after["uncertainDispatches"]
            .as_array()
            .is_none_or(|xs| xs.is_empty())
    );
    let second = fixture.command("recover", "p").output().unwrap();
    assert!(
        second.status.success(),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(work_hook_result(&fixture, "local.file.write"), result);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn observed_delegated_provider_result_survives_unproven_post_hook_start() {
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"post-crash-target","content":"observed before the crash"}),
    )]);
    let fixture = Fixture::new(&server);
    work_hook_config(
        &fixture,
        json!({
            "PostToolUse":[{"id":"must-retain-result","command":"printf effect > post-unproven"}]
        }),
    );
    let original = fixture
        .command("exec", "p")
        .env("PEER_NATIVE_EPISODE_HOOK_FAULT", "after_post_starting")
        .output()
        .unwrap();
    assert_eq!(original.status.code(), Some(77));
    assert_eq!(
        std::fs::read_to_string(fixture.root.path().join("workspace/post-crash-target")).unwrap(),
        "observed before the crash"
    );
    fixture.age_dead_lease();
    let recovery = fixture.command("recover", "p").output().unwrap();
    assert!(!recovery.status.success());
    assert!(String::from_utf8_lossy(&recovery.stderr).contains("native_execution_stop_unproven"));
    let result = work_hook_result(&fixture, "local.file.write");
    assert_eq!(result["status"], "success");
    let reference = format!("tool-result://{}", result["toolCallId"].as_str().unwrap());
    let indexed = peer_store::EvidenceIndexStore::new(fixture.root.path())
        .find(&[reference], None)
        .unwrap();
    assert_eq!(indexed.len(), 1);
    assert_eq!(indexed[0]["toolCallId"], result["toolCallId"]);
    assert!(!fixture.root.path().join("workspace/post-unproven").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
