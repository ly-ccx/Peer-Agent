use super::*;

fn recovery_command(fixture: &Ordinary, id: &str) -> Command {
    let cmd = fixture.command(None);
    // Replace exec with the management command; no model configuration exists.
    let mut actual = Command::new(cmd.get_program());
    actual
        .env_clear()
        .envs(cmd.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))))
        .current_dir(fixture.workspace())
        .args(["recover", "--session", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    actual
}
pub(super) fn recover(fixture: &Ordinary, id: &str) -> Output {
    wait(recovery_command(fixture, id).spawn().unwrap())
}
fn run_facts(fixture: &Ordinary, id: &str) -> peer_protocol::ConversationExecution {
    ConversationStore::new(fixture.home())
        .read_conversation_execution(id)
        .unwrap()
        .unwrap()
}
pub(super) fn kill_after_store_publication(
    fixture: &Ordinary,
    id: &str,
    child: &mut std::process::Child,
) {
    // Observe the end of the actual short Store transaction before testing a
    // crash in the long-running effect. A crash inside a mkdir lock is a
    // separate blocked-recovery case; no unowned lock is deleted here.
    let dir = fixture.home().join("conversations");
    let index =
        peer_store::DirectoryLock::acquire(&dir.join("index.jsonl"), Duration::from_secs(2), None)
            .unwrap();
    let body = peer_store::DirectoryLock::acquire(
        &dir.join(format!("{id}.jsonl")),
        Duration::from_secs(2),
        None,
    )
    .unwrap();
    child.kill().unwrap();
    child.wait().unwrap();
    drop(body);
    drop(index);
}

#[test]
fn public_ordinary_owner_death_after_actual_effect_preserves_unknown_and_bills_once_without_replay()
{
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"effect.txt","content":"one actual effect"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    let output = wait(
        cmd.args(["--access", "full", "Write once"])
            .env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
            .spawn()
            .unwrap(),
    );
    assert_eq!(
        output.status.code(),
        Some(88),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let meta = fixture.metadata();
    let id = meta["id"].as_str().unwrap();
    let before = run_facts(&fixture, id);
    assert_eq!(before.pending_tools.len(), 1);
    assert_eq!(before.usage.as_ref().unwrap().amounts.total_tokens, 16);
    assert!(!before.usage_committed && before.stop.is_none());
    let output = recover(&fixture, id);
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["status"], "recovery_observed");
    let recovered = run_facts(&fixture, id);
    assert!(recovered.stop.is_some() && recovered.usage_committed);
    assert_eq!(
        recovered.pending_tools[0].phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    assert!(!recovered.permits_new_run());
    let ledger = std::fs::read(fixture.home().join("usage/requests.jsonl")).unwrap();
    assert_eq!(std::str::from_utf8(&ledger).unwrap().lines().count(), 1);
    let again = recover(&fixture, id);
    assert_eq!(again.status.code(), Some(1));
    assert_eq!(run_facts(&fixture, id), recovered);
    assert_eq!(
        std::fs::read(fixture.home().join("usage/requests.jsonl")).unwrap(),
        ledger
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("effect.txt")).unwrap(),
        "one actual effect"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    // Independent later work receives a fresh owner/cancellation domain.
    let next = Server::new(vec![reply_text("Independent work complete.")]);
    let output = fixture.run(
        Some(&next),
        &["--output-format", "json", "Independent work"],
        None,
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let next_id: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_ne!(next_id["sessionId"], id);
    assert!(run_facts(&fixture, next_id["sessionId"].as_str().unwrap()).permits_new_run());
    assert_eq!(run_facts(&fixture, id), recovered);
}

#[test]
fn public_ordinary_recovery_rejects_live_owner_without_mutation_or_killing_its_child() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![reply_tool("bash", json!({"command":"/bin/sleep 30"}))]);
    let mut cmd = fixture.command(Some(&server));
    let mut child = cmd
        .args(["--access", "full", "Wait in an owned shell"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let before = loop {
        let path = fixture.home().join("conversations/index.jsonl");
        if let Ok(raw) = std::fs::read_to_string(path)
            && let Ok(meta) = serde_json::from_str::<Value>(raw.trim())
            && let Ok(run) =
                peer_protocol::normalize_conversation_execution(&meta["runtimeExecution"])
            && run.pending_tools.iter().any(|p| {
                p.native_process
                    .as_ref()
                    .is_some_and(|p| p.state == peer_protocol::NativeProcessState::Running)
            })
        {
            break run;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "real shell did not start: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    let output = recover(&fixture, &before.identity.conversation_id);
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_execution_owner_live"));
    assert_eq!(
        run_facts(&fixture, &before.identity.conversation_id),
        before
    );
    assert!(child.try_wait().unwrap().is_none());
    let recorded = before.pending_tools[0]
        .native_process
        .as_ref()
        .unwrap()
        .child
        .as_ref()
        .unwrap();
    let pid = rustix::process::Pid::from_raw(recorded.pid as i32).unwrap();
    assert!(rustix::process::test_kill_process(pid).is_ok());
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait(child);
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(run_facts(&fixture, &before.identity.conversation_id).permits_new_run());
}

#[test]
fn public_ordinary_recovery_invalid_or_missing_session_creates_no_data() {
    let fixture = Ordinary::new();
    for id in ["../escape", "missing"] {
        assert_eq!(recover(&fixture, id).status.code(), Some(1));
        assert!(!fixture.home().exists());
    }
}

#[cfg(target_os = "macos")]
#[test]
fn public_ordinary_timezone_change_cannot_take_over_or_stop_a_live_native_owner() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![reply_tool("bash", json!({"command":"/bin/sleep 60"}))]);
    let mut cmd = fixture.command(Some(&server));
    let mut child = cmd
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .args(["--access", "full", "A live owned shell"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let before = loop {
        if let Ok(raw) = std::fs::read_to_string(fixture.home().join("conversations/index.jsonl"))
            && let Ok(meta) = serde_json::from_str::<Value>(raw.trim())
            && let Ok(run) =
                peer_protocol::normalize_conversation_execution(&meta["runtimeExecution"])
            && run.pending_tools.iter().any(|p| {
                p.native_process
                    .as_ref()
                    .is_some_and(|p| p.state == peer_protocol::NativeProcessState::Running)
            })
        {
            break run;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "owned shell did not start: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    assert!(before.owner.pid_start.starts_with("macos-v2:"));
    let mut recover = recovery_command(&fixture, &before.identity.conversation_id);
    let output = wait(
        recover
            .env("TZ", "Asia/Shanghai")
            .env("LC_ALL", "en_US.UTF-8")
            .spawn()
            .unwrap(),
    );
    let actual = run_facts(&fixture, &before.identity.conversation_id);
    let pid = rustix::process::Pid::from_raw(child.id() as i32).unwrap();
    let alive = child.try_wait().unwrap().is_none();
    if alive {
        rustix::process::kill_process(pid, rustix::process::Signal::TERM).unwrap();
    }
    let stopped = wait(child);
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_execution_owner_live"));
    assert_eq!(
        actual, before,
        "live owner was mutated by a different TZ/locale"
    );
    assert!(alive, "live CLI was incorrectly stopped by recovery");
    assert_eq!(stopped.status.code(), Some(4));
    assert!(run_facts(&fixture, &before.identity.conversation_id).permits_new_run());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[cfg(target_os = "macos")]
#[test]
fn fixture_ordinary_legacy_display_start_with_existing_pid_stays_unproven_and_unchanged() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"never.txt","content":"must not execute"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    cmd.env("PEER_NATIVE_ORDINARY_FAULT", "after_prepared")
        .args(["--access", "full", "Prepare one call"]);
    assert_eq!(wait(cmd.spawn().unwrap()).status.code(), Some(88));
    let mut meta = fixture.metadata();
    let id = meta["id"].as_str().unwrap().to_owned();
    // Synthetic old control record, actual still-live OS PID. No running Host
    // watches this fixture, so changing its record cannot cancel a real task.
    let pid = std::process::id();
    let old = Command::new("/bin/ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("TZ", "UTC")
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert!(old.status.success());
    meta["runtimeExecution"]["owner"]["pid"] = json!(pid);
    meta["runtimeExecution"]["owner"]["pidStart"] = json!(format!(
        "macos:{}",
        String::from_utf8_lossy(&old.stdout).trim()
    ));
    let index = fixture.home().join("conversations/index.jsonl");
    let original = format!("{meta}\n");
    std::fs::write(&index, &original).unwrap();
    let mut command = recovery_command(&fixture, &id);
    let output = wait(
        command
            .env("TZ", "Asia/Shanghai")
            .env("LC_ALL", "C")
            .spawn()
            .unwrap(),
    );
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("native_execution_owner_unknown"));
    assert_eq!(std::fs::read_to_string(&index).unwrap(), original);
    assert!(!fixture.workspace().join("never.txt").exists());
    assert!(!fixture.home().join("usage/requests.jsonl").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn fixture_ordinary_recovery_cancels_only_the_original_calls_open_approval() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"never.txt","content":"must not execute"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    cmd.env("PEER_NATIVE_ORDINARY_FAULT", "after_prepared")
        .args(["--access", "full", "Prepare a call"]);
    assert_eq!(wait(cmd.spawn().unwrap()).status.code(), Some(88));
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    let run = run_facts(&fixture, &id);
    let pending = &run.pending_tools[0];
    let ids = [
        format!(
            "approval-{}-11111111-1111-4111-8111-111111111111",
            pending.tool_call_id
        ),
        "approval-call-foreign-22222222-2222-4222-8222-222222222222".into(),
        format!(
            "approval-{}-other-call-33333333-3333-4333-8333-333333333333",
            pending.tool_call_id
        ),
        format!(
            "approval-{}-44444444-4444-4444-8444-444444444444",
            pending.tool_call_id
        ),
    ];
    let store = peer_store::ApprovalStore::new(fixture.home());
    for (i, approval_id) in ids.iter().enumerate() {
        let row = store
            .open(
                &peer_store::HostApproval {
                    approval_id,
                    workspace_id: None,
                    conversation_id: &id,
                    stream_id: &run.identity.stream_id,
                    plan_id: None,
                    session_id: None,
                    capability_id: &pending.capability_id,
                    args_digest: &pending.args_digest,
                    policy_revision: "ordinary:fixture:0",
                    created_at: &run.updated_at,
                    deadline_at: None,
                },
                None,
            )
            .unwrap();
        if i == 3 {
            store
                .decide(
                    &row,
                    peer_store::ApprovalState::Approved,
                    peer_store::ApprovalDecision::LocalUser,
                    &run.updated_at,
                    None,
                    None,
                )
                .unwrap();
        }
    }
    let before = store.list(None, None).unwrap();
    let output = recover(&fixture, &id);
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.workspace().join("never.txt").exists());
    let after = store.list(None, None).unwrap();
    let matching = after.iter().find(|r| r["approvalId"] == ids[0]).unwrap();
    assert_eq!(matching["state"], "cancelled");
    assert_eq!(matching["decidedBy"], "policy");
    assert_eq!(matching["decisionReason"], "permission_cancelled");
    for id in &ids[1..] {
        assert_eq!(
            after.iter().find(|r| r["approvalId"] == *id),
            before.iter().find(|r| r["approvalId"] == *id)
        );
    }
    assert_eq!(recover(&fixture, &id).status.code(), Some(0));
    assert_eq!(store.list(None, None).unwrap(), after);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn fixture_ordinary_recovery_cancellation_and_killed_recoverer_release_actual_exclusive_guard() {
    for signal in [rustix::process::Signal::TERM, rustix::process::Signal::KILL] {
        let fixture = Ordinary::new();
        std::fs::create_dir_all(fixture.home()).unwrap();
        std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
        let server = Server::new(vec![reply_tool(
            "write_file",
            json!({"path":"once.txt","content":"actual original effect"}),
        )]);
        let mut original = fixture.command(Some(&server));
        original
            .env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
            .args(["--access", "full", "One effect"]);
        assert_eq!(wait(original.spawn().unwrap()).status.code(), Some(88));
        let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
        let before = run_facts(&fixture, &id);
        let mut cmd = Command::new(native_test_binary());
        cmd.env_clear()
            .env("HOME", fixture.root.path().join("private-home"))
            .env("PATH", "/nonexistent")
            .env("PEER_AGENT_HOME", fixture.home())
            .env("PEER_NATIVE_ORDINARY_FAULT", "hold_recovery")
            .args(["recover", "--session", &id])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = cmd.spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !fixture.home().join("recovery-ready").exists() {
            if Instant::now() >= deadline || child.try_wait().unwrap().is_some() {
                let _ = child.kill();
                let output = child.wait_with_output().unwrap();
                panic!(
                    "recoverer did not acquire guard: {}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            thread::sleep(Duration::from_millis(10));
        }
        let competing = recover(&fixture, &id);
        assert_eq!(competing.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&competing.stderr).contains("STORE_LOCK_BUSY"));
        assert_eq!(run_facts(&fixture, &id), before);
        rustix::process::kill_process(
            rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
            signal,
        )
        .unwrap();
        let output = wait(child);
        if signal == rustix::process::Signal::TERM {
            assert_eq!(output.status.code(), Some(4));
        }
        assert_eq!(run_facts(&fixture, &id), before);
        let after = recover(&fixture, &id);
        assert_eq!(after.status.code(), Some(1));
        let facts = run_facts(&fixture, &id);
        assert!(facts.usage_committed && facts.stop.is_some());
        assert_eq!(
            facts.pending_tools[0].phase,
            peer_protocol::ConversationDispatchPhase::OutcomeUnknown
        );
    }
}

#[test]
fn fixture_ordinary_recovery_keeps_starting_gap_unproven_and_future_schema_untouched() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"printf actual-effect"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    cmd.env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
        .args(["--access", "full", "One shell"]);
    assert_eq!(wait(cmd.spawn().unwrap()).status.code(), Some(88));
    let mut metadata = fixture.metadata();
    let id = metadata["id"].as_str().unwrap().to_owned();
    let process = metadata["runtimeExecution"]["pendingTools"][0]["nativeProcess"]
        .as_object_mut()
        .unwrap();
    process.insert("state".into(), json!("starting"));
    process.remove("child");
    process.remove("stopObservation");
    let index = fixture.home().join("conversations/index.jsonl");
    std::fs::write(&index, format!("{metadata}\n")).unwrap();
    let output = recover(&fixture, &id);
    assert_eq!(output.status.code(), Some(1));
    let facts = run_facts(&fixture, &id);
    assert!(facts.stop.is_none() && facts.usage_committed);
    assert_eq!(
        facts.pending_tools[0]
            .native_process
            .as_ref()
            .unwrap()
            .state,
        peer_protocol::NativeProcessState::Starting
    );
    assert_eq!(
        facts.pending_tools[0].phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    assert_eq!(recover(&fixture, &id).status.code(), Some(1));
    assert_eq!(run_facts(&fixture, &id), facts);
    metadata = fixture.metadata();
    metadata["runtimeExecution"]["schemaVersion"] = json!(2);
    let bytes = format!("{metadata}\n");
    std::fs::write(&index, &bytes).unwrap();
    assert_eq!(recover(&fixture, &id).status.code(), Some(1));
    assert_eq!(std::fs::read_to_string(&index).unwrap(), bytes);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn fixture_ordinary_recovery_preserves_unowned_locks_and_reports_supported_diagnosis() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"once.txt","content":"actual effect"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    cmd.env("PEER_NATIVE_ORDINARY_FAULT", "after_effect").args([
        "--access",
        "full",
        "One controlled effect",
    ]);
    assert_eq!(wait(cmd.spawn().unwrap()).status.code(), Some(88));
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    let before = run_facts(&fixture, &id);
    let index = fixture.home().join("conversations/index.jsonl");
    let bytes = std::fs::read(&index).unwrap();
    let lock = fixture.home().join("conversations/index.jsonl.lock");
    std::fs::create_dir(&lock).unwrap();
    std::fs::write(lock.join("diagnostic"), "unowned - preserve").unwrap();
    let output = recover(&fixture, &id);
    assert_eq!(output.status.code(), Some(1));
    let error = String::from_utf8_lossy(&output.stderr);
    assert!(
        error.contains("STORE_LOCK_BUSY")
            && error.contains("index.jsonl.lock")
            && error.contains("离线维护"),
        "{error}"
    );
    assert_eq!(std::fs::read(&index).unwrap(), bytes);
    assert_eq!(run_facts(&fixture, &id), before);
    assert_eq!(
        std::fs::read_to_string(lock.join("diagnostic")).unwrap(),
        "unowned - preserve"
    );
    assert!(!fixture.home().join("usage/requests.jsonl").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn fixture_ordinary_uncertain_initial_claim_closes_only_its_genuine_empty_owner_before_sending() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let server = Server::new(vec![]);
    let mut cmd = fixture.command(Some(&server));
    cmd.env("PEER_CONVERSATION_EXECUTION_FAULT", "uncertain_claim")
        .args([
            "--output-format",
            "json",
            "Preserve this unsubmitted intent",
        ]);
    let output = wait(cmd.spawn().unwrap());
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(report["turns"], 0);
    assert_eq!(report["ok"], false);
    assert!(report["error"].as_str().unwrap().contains("UNCERTAIN"));
    let id = report["sessionId"].as_str().unwrap();
    let facts = run_facts(&fixture, id);
    assert!(facts.permits_new_run() && facts.stop.is_some() && facts.pending_tools.is_empty());
    assert!(facts.usage.is_none() && facts.handles.is_empty());
    assert!(
        ConversationStore::new(fixture.home())
            .read_committed(id, None, 8 * 1024 * 1024)
            .unwrap()
            .history
            .messages
            .is_empty()
    );
    assert!(!fixture.home().join("usage/requests.jsonl").exists());
    assert!(server.requests.lock().unwrap().is_empty());
    let again = recover(&fixture, id);
    assert_eq!(again.status.code(), Some(0));
    assert_eq!(run_facts(&fixture, id), facts);
    let later = Server::new(vec![reply_text("New independent request completed.")]);
    let output = fixture.run(
        Some(&later),
        &["--output-format", "json", "A new request"],
        None,
    );
    assert_eq!(output.status.code(), Some(0));
    assert_eq!(later.requests.lock().unwrap().len(), 1);
}

#[test]
fn fixture_ordinary_recovery_prepared_grant_result_and_billing_crash_windows() {
    for stage in [
        "after_prepared",
        "after_grant",
        "after_tool_facts",
        "before_billing",
    ] {
        let fixture = Ordinary::new();
        std::fs::create_dir_all(fixture.home()).unwrap();
        std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
        let server = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"once.txt","content":"original actual effect"}),
            ),
            reply_text("done"),
        ]);
        let mut cmd = fixture.command(Some(&server));
        cmd.env("PEER_NATIVE_ORDINARY_FAULT", stage).args([
            "--access",
            "full",
            "One controlled write",
        ]);
        let output = wait(cmd.spawn().unwrap());
        assert_eq!(
            output.status.code(),
            Some(88),
            "{stage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let meta = fixture.metadata();
        let id = meta["id"].as_str().unwrap();
        let store = ConversationStore::new(fixture.home());
        let old = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
        let grant_before = old.history.messages.iter().find_map(|m| {
            m["permissionGrants"]
                .as_array()
                .filter(|g| !g.is_empty())
                .cloned()
        });
        let output = recover(&fixture, id);
        assert_eq!(
            output.status.code(),
            Some(0),
            "{stage}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let settled = run_facts(&fixture, id);
        assert!(settled.permits_new_run(), "{stage}: {settled:?}");
        let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
        let message = history
            .history
            .messages
            .iter()
            .find(|m| {
                m["segments"]
                    .as_array()
                    .is_some_and(|s| s.iter().any(|s| s["type"] == "tool-call"))
            })
            .unwrap();
        let segment = &message["segments"][0];
        if matches!(stage, "after_prepared" | "after_grant") {
            assert!(!fixture.workspace().join("once.txt").exists());
            assert_eq!(segment["result"]["status"], "cancelled");
            assert_eq!(
                segment["result"]["evidence"]["dispatchOutcome"],
                "not_dispatched"
            );
            if stage == "after_prepared" {
                assert_eq!(message["permissionGrants"][0]["granted"], false);
            }
        } else {
            assert_eq!(
                std::fs::read_to_string(fixture.workspace().join("once.txt")).unwrap(),
                "original actual effect"
            );
            assert_eq!(segment["result"]["status"], "success");
        }
        if let Some(grant) = grant_before {
            assert_eq!(message["permissionGrants"], json!(grant));
        }
        let ledger = std::fs::read(fixture.home().join("usage/requests.jsonl")).unwrap();
        assert_eq!(std::str::from_utf8(&ledger).unwrap().lines().count(), 1);
        let again = recover(&fixture, id);
        assert_eq!(again.status.code(), Some(0));
        assert_eq!(run_facts(&fixture, id), settled);
        assert_eq!(
            std::fs::read(fixture.home().join("usage/requests.jsonl")).unwrap(),
            ledger
        );
        assert_eq!(
            server.requests.lock().unwrap().len(),
            if stage == "before_billing" { 2 } else { 1 }
        );
    }
}

#[test]
fn public_ordinary_recovery_stops_only_recorded_shell_after_actual_owner_kill() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![reply_tool("bash", json!({"command":"/bin/sleep 60"}))]);
    let mut cmd = fixture.command(Some(&server));
    let mut child = cmd
        .args(["--access", "full", "Wait in shell"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    let before = loop {
        if let Ok(raw) = std::fs::read_to_string(fixture.home().join("conversations/index.jsonl"))
            && let Ok(meta) = serde_json::from_str::<Value>(raw.trim())
            && let Ok(run) =
                peer_protocol::normalize_conversation_execution(&meta["runtimeExecution"])
            && run.pending_tools.iter().any(|p| {
                p.native_process
                    .as_ref()
                    .is_some_and(|p| p.state == peer_protocol::NativeProcessState::Running)
            })
        {
            break run;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            let output = child.wait_with_output().unwrap();
            panic!(
                "Shell failed to start: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    };
    kill_after_store_publication(&fixture, &before.identity.conversation_id, &mut child);
    let process = before.pending_tools[0].native_process.as_ref().unwrap();
    let recorded = process.child.as_ref().unwrap();
    let pid = rustix::process::Pid::from_raw(recorded.pid as i32).unwrap();
    assert!(rustix::process::test_kill_process(pid).is_ok());
    let output = recover(&fixture, &before.identity.conversation_id);
    // Always clean up this test-owned group before reporting an assertion.
    let absent = rustix::process::test_kill_process_group(pid) == Err(rustix::io::Errno::SRCH);
    if !absent {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    assert_eq!(
        output.status.code(),
        Some(1),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    if !absent {
        let actual = Command::new("/bin/ps")
            .args(["-ax", "-o", "pid=,ppid=,pgid=,stat=,command="])
            .output()
            .unwrap();
        let group = String::from_utf8_lossy(&actual.stdout)
            .lines()
            .filter(|line| {
                line.split_whitespace().nth(2) == Some(recorded.pid.to_string().as_str())
            })
            .collect::<Vec<_>>()
            .join("\n");
        let facts = run_facts(&fixture, &before.identity.conversation_id);
        let retained = fixture.root.keep();
        panic!(
            "recovery did not actually stop its recorded Shell group; retained={retained:?}; stderr={}; stdout={}; facts={facts:?}; group={group}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
    }
    let facts = run_facts(&fixture, &before.identity.conversation_id);
    assert!(facts.stop.is_some() && facts.usage_committed && facts.handles.is_empty());
    let pending = &facts.pending_tools[0];
    assert_eq!(
        pending.phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    assert_eq!(
        pending.native_process.as_ref().unwrap().stop_observation,
        Some(peer_protocol::NativeProcessStop::OwnerDeadGroupAbsent)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}

#[test]
fn public_ordinary_recovery_stops_recorded_mcp_stdio_and_keeps_remote_effect_unknown() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    put(
        fixture.home().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","name":"Recovery MCP","enabled":true,"transport":"stdio","command":env!("CARGO_BIN_EXE_mcp-test-fixture"),"args":["stall"],"env":{"MCP_FIXTURE_ROOT":fixture.root.path()},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
    );
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let mut cmd = fixture.command(Some(&server));
    let mut child = cmd
        .args(["--access", "full", "One MCP effect"])
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !fixture.root.path().join("mcp.effect").exists() {
        if child.try_wait().unwrap().is_some() || Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "MCP effect failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    let before = run_facts(&fixture, &id);
    assert_eq!(before.handles.len(), 2);
    kill_after_store_publication(&fixture, &id, &mut child);
    let mcp_pid = std::fs::read_to_string(fixture.root.path().join("mcp.pid"))
        .unwrap()
        .parse::<i32>()
        .unwrap();
    let pid = rustix::process::Pid::from_raw(mcp_pid).unwrap();
    assert!(rustix::process::test_kill_process(pid).is_ok());
    let output = recover(&fixture, &id);
    let absent = rustix::process::test_kill_process_group(pid) == Err(rustix::io::Errno::SRCH);
    if !absent {
        let _ = rustix::process::kill_process_group(pid, rustix::process::Signal::KILL);
    }
    assert!(
        absent,
        "recorded MCP group did not stop: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(output.status.code(), Some(1));
    let facts = run_facts(&fixture, &id);
    assert!(facts.stop.is_some() && facts.usage_committed && facts.handles.is_empty());
    assert_eq!(
        facts.pending_tools[0].phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    let again = recover(&fixture, &id);
    assert_eq!(again.status.code(), Some(1));
    assert_eq!(run_facts(&fixture, &id), facts);
    let requests = std::fs::read_to_string(fixture.root.path().join("mcp.requests")).unwrap();
    assert_eq!(
        requests
            .lines()
            .filter(|l| l.contains("tools/call"))
            .count(),
        1
    );
}
