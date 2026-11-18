//! Public ordinary exec, independent of the delegated Goal fixture.
use super::*;
use peer_store::ConversationStore;
mod goal_create;
mod goal_intake;
mod goal_read;
mod hooks;
mod input_media;
mod model_errors;
mod recovery;
mod shell_artifacts;
mod shell_background;
mod shell_session;
mod skills;
struct Ordinary {
    root: tempfile::TempDir,
}
impl Ordinary {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir(root.path().join("workspace")).unwrap();
        std::fs::write(root.path().join(".native-cli-fixture"), "isolated").unwrap();
        Self { root }
    }
    fn home(&self) -> std::path::PathBuf {
        self.root.path().join("data")
    }
    fn workspace(&self) -> std::path::PathBuf {
        self.root.path().join("workspace")
    }
    fn command(&self, server: Option<&Server>) -> Command {
        let mut cmd = Command::new(native_test_binary());
        cmd.env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", self.root.path().join("private-home"))
            .env("PEER_AGENT_HOME", self.home())
            .env("NO_PROXY", "*")
            .current_dir(self.workspace())
            .arg("exec")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(server) = server {
            cmd.env("PEER_MODEL_API_KEY", "ordinary-controlled-key")
                .env("PEER_MODEL_BASE_URL", &server.url)
                .env("PEER_MODEL_ID", "model");
        }
        cmd
    }
    fn run(&self, server: Option<&Server>, args: &[&str], stdin: Option<&str>) -> Output {
        let mut cmd = self.command(server);
        cmd.args(args);
        if stdin.is_some() {
            cmd.stdin(Stdio::piped());
        }
        let mut child = cmd.spawn().unwrap();
        if let Some(input) = stdin {
            child
                .stdin
                .take()
                .unwrap()
                .write_all(input.as_bytes())
                .unwrap();
        }
        wait(child)
    }
    fn metadata(&self) -> Value {
        let rows = std::fs::read_to_string(self.home().join("conversations/index.jsonl")).unwrap();
        assert_eq!(rows.lines().count(), 1);
        serde_json::from_str(rows.trim()).unwrap()
    }
    fn assert_settled(&self, output: &Output, turns: usize, tools: usize) -> Value {
        let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(reply["turns"], turns);
        let id = reply["sessionId"].as_str().unwrap();
        let store = ConversationStore::new(self.home());
        let run = store.read_conversation_execution(id).unwrap().unwrap();
        assert!(run.permits_new_run());
        assert!(run.usage_committed && run.pending_tools.is_empty() && run.handles.is_empty());
        let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
        let mut count = 0;
        for message in &history.history.messages {
            for segment in message["segments"].as_array().into_iter().flatten() {
                if segment["type"] != "tool-call" {
                    continue;
                }
                count += 1;
                let result = &segment["result"];
                assert!(matches!(
                    result["status"].as_str(),
                    Some("success" | "failed" | "cancelled" | "denied")
                ));
                let call = result["toolCallId"].as_str().unwrap();
                assert!(
                    !peer_store::EvidenceIndexStore::new(self.home())
                        .find(&[format!("tool-result://{call}")], None)
                        .unwrap()
                        .is_empty()
                );
                assert!(
                    message["permissionGrants"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|g| g["toolCallId"] == call)
                );
            }
        }
        assert_eq!(count, tools);
        assert_eq!(
            std::fs::read_to_string(self.home().join("usage/requests.jsonl"))
                .unwrap()
                .lines()
                .count(),
            1
        );
        assert_eq!(self.metadata()["runtimeTurnCount"], 1);
        assert!(
            !self
                .home()
                .join("project-runtime/coordination.sqlite")
                .exists()
        );
        reply
    }
}
fn active_foreground_shell(
    run: &peer_protocol::ConversationExecution,
) -> Option<peer_protocol::NativeOwnedProcess> {
    run.handles
        .iter()
        .filter_map(peer_protocol::NativeShellSession::from_handle)
        .find(|session| {
            session.process.state == peer_protocol::NativeProcessState::Running
                && session.command.is_some()
        })
        .map(|session| session.process)
}

fn wait(mut child: std::process::Child) -> Output {
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let output = child.wait_with_output().unwrap();
            panic!(
                "ordinary exec did not terminate: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
        thread::sleep(Duration::from_millis(10));
    }
}
#[test]
fn public_ordinary_exec_runs_one_native_model_tool_evidence_and_billing_chain_without_goal() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"created.txt","content":"native ordinary file"}),
        ),
        reply_tool("read_file", json!({"path":"created.txt"})),
        reply_tool("bash", json!({"command":"printf ordinary-shell"})),
        reply_text("Native ordinary complete."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--output-format",
            "json",
            "--tools",
            "file,bash",
            "--access",
            "full",
            "Write, read and run",
        ],
        None,
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 4, 3);
    assert_eq!(reply["ok"], true);
    assert_eq!(reply["result"], "Native ordinary complete.");
    assert_eq!(reply["usage"]["totalTokens"], 64);
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("created.txt")).unwrap(),
        "native ordinary file"
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(
        requests[3]["messages"]
            .to_string()
            .contains("ordinary-shell")
    );
}
#[test]
fn public_ordinary_prompt_stdin_precedence_qualified_model_and_plan_projection() {
    for positional in [false, true] {
        let fixture = Ordinary::new();
        let server = Server::new(vec![reply_text("Plan complete.")]);
        let mut args = vec![
            "--output-format",
            "json",
            "--mode",
            "plan",
            "--model",
            "openai-compatible::model",
            "--tools",
            "file",
        ];
        if positional {
            args.push("Argument prompt");
        }
        let output = fixture.run(Some(&server), &args, Some("Stdin prompt"));
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.assert_settled(&output, 1, 0);
        let requests = server.requests.lock().unwrap();
        let request = &requests[0];
        assert_eq!(
            request["messages"]
                .as_array()
                .unwrap()
                .iter()
                .find(|m| m["role"] == "user")
                .unwrap()["content"],
            if positional {
                "Argument prompt"
            } else {
                "Stdin prompt"
            }
        );
        assert!(!request["tools"].to_string().contains("write_file"));
        assert!(!request["tools"].to_string().contains("bash"));
    }
}
#[test]
fn public_ordinary_invalid_inputs_and_non_tty_ask_have_no_data_or_model_effects() {
    for (args, code) in [
        (vec!["--access", "ask", "prompt"], 2),
        (vec!["--tools", "browser", "prompt"], 2),
        (vec!["--mode", "invalid", "prompt"], 2),
        (vec!["--max-turns", "0", "prompt"], 2),
        (vec!["prompt"], 3),
        (vec![], 2),
    ] {
        let fixture = Ordinary::new();
        let output = fixture.run(None, &args, None);
        assert_eq!(
            output.status.code(),
            Some(code),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(output.stdout.is_empty());
        assert!(!fixture.home().exists());
    }
}
#[test]
fn public_ordinary_malformed_hook_config_is_preserved_and_blocks_before_model_send() {
    for path in ["data/hooks/hooks.json", "workspace/.peer/hooks.json"] {
        let fixture = Ordinary::new();
        let file = fixture.root.path().join(path);
        std::fs::create_dir_all(file.parent().unwrap()).unwrap();
        std::fs::write(&file, "preserve the configured extension").unwrap();
        let server = Server::new(vec![]);
        let output = fixture.run(Some(&server), &["prompt"], None);
        assert_eq!(
            output.status.code(),
            Some(1),
            "{path}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stderr).contains("HISTORY_CORRUPT"));
        assert_eq!(
            std::fs::read_to_string(file).unwrap(),
            "preserve the configured extension"
        );
        assert!(!fixture.home().join("conversations").exists());
        assert!(server.requests.lock().unwrap().is_empty());
    }
}
#[test]
fn public_ordinary_max_turns_is_error_after_real_tool_evidence_and_final_usage_commit() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("input.txt"),
        "actual bounded source",
    )
    .unwrap();
    let server = Server::new(vec![reply_tool("read_file", json!({"path":"input.txt"}))]);
    let output = fixture.run(
        Some(&server),
        &[
            "--output-format",
            "json",
            "--max-turns",
            "1",
            "Read the file",
        ],
        None,
    );
    assert_eq!(
        output.status.code(),
        Some(5),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 1, 1);
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "agent_loop_exhausted");
    assert_eq!(reply["usage"]["totalTokens"], 16);
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
#[test]
fn public_ordinary_sigterm_during_open_stdin_has_no_unowned_reader_or_data_effects() {
    let fixture = Ordinary::new();
    let (reader, writer) = rustix::pipe::pipe().unwrap();
    let child = fixture
        .command(None)
        .stdin(Stdio::from(reader.try_clone().unwrap()))
        .spawn()
        .unwrap();
    let mut input = std::fs::File::from(writer);
    // The pipe remains open: EOF is not what makes this process exit.
    // Observe actual consumption instead of assuming a startup delay means the
    // signal listener and stdin owner are ready. The parent only observes its
    // duplicate read descriptor and never consumes from it.
    input.write_all(b"x").unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    while rustix::io::ioctl_fionread(&reader).unwrap() != 0 {
        assert!(
            Instant::now() < deadline,
            "ordinary stdin was never consumed"
        );
        thread::sleep(Duration::from_millis(10));
    }
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait(child);
    drop(input);
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!fixture.home().exists());
}

#[test]
fn public_ordinary_legacy_v3_settings_never_override_explicit_ask_policy() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    let settings = fixture.home().join("settings.json");
    std::fs::write(&settings, LEGACY_V3_SETTINGS).unwrap();
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"not-approved.txt","content":"must not be written"}),
        ),
        reply_text("Write denied."),
    ]);
    let mut command = fixture.command(Some(&server));
    command.args([
        "--output-format",
        "json",
        "--access",
        "ask",
        "Write only if approved",
    ]);
    let (master, child) = permission_command_pty(command);
    wait_permission_prompt(&master);
    rustix::io::write(&master, b"n\n").unwrap();
    let out = wait_permission_episode(child);
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    fixture.assert_settled(&out, 2, 1);
    assert!(!fixture.workspace().join("not-approved.txt").exists());
    assert_eq!(std::fs::read(settings).unwrap(), LEGACY_V3_SETTINGS);
    let approvals = peer_store::ApprovalStore::new(fixture.home())
        .list(None, None)
        .unwrap();
    assert_eq!(approvals.len(), 1);
    assert_eq!(approvals[0]["state"], "denied");
    assert_eq!(approvals[0]["decidedBy"], "local_ui");

    let requests = server.requests.lock().unwrap();
    let system = requests[0]["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Always write your replies to the user in English"));
    for metadata in ["themeMode", "projectAgent", "full_local"] {
        assert!(!system.contains(metadata));
    }
}

#[test]
fn public_ordinary_real_pty_approve_deny_and_cancel_have_canonical_decision_ownership() {
    for answer in [Some(true), Some(false), None] {
        let fixture = Ordinary::new();
        let server = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"approved.txt","content":"actual once grant"}),
            ),
            reply_text("Finished."),
        ]);
        let mut command = fixture.command(Some(&server));
        command.args([
            "--output-format",
            "json",
            "--access",
            "ask",
            "Write only if approved",
        ]);
        let (master, mut child) = permission_command_pty(command);
        wait_permission_prompt(&master);
        if let Some(answer) = answer {
            rustix::io::write(&master, if answer { b"y\n" } else { b"n\n" }).unwrap();
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        }
        let output = wait_permission_episode(child);
        assert_eq!(
            output.status.code(),
            Some(if answer.is_some() { 0 } else { 4 }),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.assert_settled(&output, if answer.is_some() { 2 } else { 1 }, 1);
        assert_eq!(
            fixture.workspace().join("approved.txt").exists(),
            answer == Some(true)
        );
        let rows = peer_store::ApprovalStore::new(fixture.home())
            .list(None, None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(
            rows[0]["state"],
            match answer {
                Some(true) => "approved",
                Some(false) => "denied",
                None => "cancelled",
            }
        );
        assert_eq!(
            rows[0]["decidedBy"],
            if answer.is_some() {
                "local_ui"
            } else {
                "policy"
            }
        );
        assert!(rows[0]["deadlineAt"].is_string());
        if answer.is_none() {
            assert_eq!(rows[0]["decisionReason"], "permission_cancelled");
            assert_eq!(server.requests.lock().unwrap().len(), 1);
        }
    }
}

#[test]
fn public_ordinary_sigterm_drains_actual_shell_group_and_keeps_known_charges_and_evidence() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"printf dispatched > entered; /bin/sleep 30"}),
    )]);
    let mut cmd = fixture.command(Some(&server));
    cmd.args([
        "--output-format",
        "json",
        "--access",
        "full",
        "Run foreground command",
    ]);
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(12);
    let process = loop {
        let meta = std::fs::read_to_string(fixture.home().join("conversations/index.jsonl"))
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(s.trim()).ok());
        let process = meta
            .and_then(|m| {
                peer_protocol::normalize_conversation_execution(&m["runtimeExecution"]).ok()
            })
            .and_then(|r| active_foreground_shell(&r))
            .filter(|_| {
                std::fs::read(fixture.workspace().join("entered"))
                    .is_ok_and(|bytes| bytes == b"dispatched")
            });
        if let Some(process) = process {
            break process;
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "CLI exited before actual Shell registration"
        );
        assert!(
            Instant::now() < deadline,
            "owned Shell process never registered"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let managed = process.child.unwrap();
    let interrupted = Instant::now();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait(child);
    assert!(interrupted.elapsed() < Duration::from_secs(8));
    assert_eq!(
        output.status.code(),
        Some(1),
        "{} {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(reply["error"], "execution_outcome_unknown");
    assert_eq!(reply["usage"]["totalTokens"], 16);
    let id = reply["sessionId"].as_str().unwrap();
    let store = ConversationStore::new(fixture.home());
    let run = store.read_conversation_execution(id).unwrap().unwrap();
    assert!(run.handles.is_empty() && run.usage_committed && run.stop.is_some());
    assert!(!run.permits_new_run());
    let pending = &run.pending_tools[0];
    assert_eq!(
        pending.phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    let message = history
        .history
        .messages
        .iter()
        .find(|row| row["id"] == pending.message_id)
        .unwrap();
    let tool = message["segments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["toolCallId"] == pending.tool_call_id)
        .unwrap();
    assert_eq!(
        tool["result"]["evidence"]["shellSession"]["handleId"],
        process.handle_id
    );
    assert_eq!(tool["result"]["error"]["code"], "execution_outcome_unknown");
    let grant = &message["permissionGrants"][0];
    assert_eq!(
        tool["result"]["evidence"]["permissionGrantId"],
        grant["grantId"]
    );
    assert!(
        !peer_store::EvidenceIndexStore::new(fixture.home())
            .find(&[format!("tool-result://{}", pending.tool_call_id)], None)
            .unwrap()
            .is_empty()
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let pid = rustix::process::Pid::from_raw(managed.pid as i32).unwrap();
    assert_eq!(
        rustix::process::test_kill_process(pid),
        Err(rustix::io::Errno::SRCH)
    );
    assert_eq!(
        rustix::process::test_kill_process_group(pid),
        Err(rustix::io::Errno::SRCH)
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn public_ordinary_mcp_reuses_one_native_connection_and_drains_it_after_two_known_results() {
    let fixture = Ordinary::new();
    std::fs::create_dir(fixture.home()).unwrap();
    put(
        fixture.home().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","name":"Ordinary MCP","enabled":true,"transport":"stdio","command":env!("CARGO_BIN_EXE_mcp-test-fixture"),"args":[],"env":{"MCP_FIXTURE_ROOT":fixture.root.path(),"MCP_SECRET":"ordinary-mcp-secret"},"tools":[{"name":"read_fact","description":"Read a synthetic fact","inputSchema":{"type":"object","properties":{}}}]}]}),
    );
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("Ordinary MCP verified."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--output-format",
            "json",
            "--access",
            "full",
            "Read two facts",
        ],
        None,
    );
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 3, 2);
    let calls = std::fs::read_to_string(fixture.root.path().join("mcp.requests"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(
        calls.iter().filter(|c| c["method"] == "initialize").count(),
        1
    );
    assert_eq!(
        calls.iter().filter(|c| c["method"] == "tools/call").count(),
        2
    );
    let history = std::fs::read_to_string(fixture.home().join(format!(
        "conversations/{}.jsonl",
        fixture.metadata()["id"].as_str().unwrap()
    )))
    .unwrap();
    assert!(history.contains("native MCP fact"));
    assert!(history.contains("[REDACTED]"));
    assert!(!history.contains("ordinary-mcp-secret"));
    let pid: i32 = std::fs::read_to_string(fixture.root.path().join("mcp.pid"))
        .unwrap()
        .parse()
        .unwrap();
    assert_eq!(
        rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap()),
        Err(rustix::io::Errno::SRCH)
    );
}
