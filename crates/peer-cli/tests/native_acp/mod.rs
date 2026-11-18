//! Exercise the public stdio process against the real ordinary Host and Store.
use super::*;
use std::{
    io::{BufRead, BufReader},
    process::{Child, ChildStdin},
    sync::mpsc,
};

struct Client {
    child: Child,
    input: Option<ChildStdin>,
    output: mpsc::Receiver<String>,
    pump: Option<thread::JoinHandle<()>>,
}
impl Client {
    fn start(root: &Path, server: &Server) -> Self {
        Self::spawn(root, |command| {
            command
                .env("PEER_MODEL_BASE_URL", &server.url)
                .env("PEER_MODEL_API_KEY", "isolated-test-only")
                .env("PEER_MODEL_ID", "model");
        })
    }
    fn spawn(root: &Path, configure: impl FnOnce(&mut Command)) -> Self {
        let mut command = Command::new(native_test_binary());
        command
            .arg("acp")
            .env_clear()
            .env("PATH", "/nonexistent")
            .env("HOME", root.join("home"))
            .env("PEER_AGENT_HOME", root.join("data"))
            .env("NO_PROXY", "*")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        configure(&mut command);
        let mut child = command.spawn().unwrap();
        let input = child.stdin.take();
        let reader = BufReader::new(child.stdout.take().unwrap());
        let (send, output) = mpsc::channel();
        let pump = thread::spawn(move || {
            for line in reader.lines() {
                if send.send(line.unwrap()).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            input,
            output,
            pump: Some(pump),
        }
    }
    fn send(&mut self, mut message: Value) {
        message["jsonrpc"] = json!("2.0");
        writeln!(self.input.as_mut().unwrap(), "{message}").unwrap();
    }
    fn next(&self) -> Value {
        let line = self.output.recv_timeout(Duration::from_secs(8)).unwrap();
        let response: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(response["jsonrpc"], "2.0", "{line}");
        response
    }
    fn request(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(json!({"id":id,"method":method,"params":params}));
        let response = self.next();
        assert_eq!(response["id"], id, "{response}");
        response
    }
    fn create(&mut self, id: u64, cwd: &Path) -> String {
        let response = self.request(id, "session/new", json!({"cwd":cwd,"mcpServers":[]}));
        response["result"]["sessionId"].as_str().unwrap().to_owned()
    }
    fn prompt(&mut self, id: u64, session: &str, text: &str) {
        self.send(json!({"id":id,"method":"session/prompt","params":{
            "sessionId":session,"prompt":[{"type":"text","text":text}]
        }}));
    }
    fn finish(&mut self) {
        self.input.take();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            if let Some(status) = self.child.try_wait().unwrap() {
                assert!(status.success(), "{status}");
                return;
            }
            assert!(
                Instant::now() < deadline,
                "ACP did not reap after stdin EOF"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(pump) = self.pump.take() {
            let _ = pump.join();
        }
    }
}

#[test]
fn native_acp_two_prompts_keep_permission_and_conversation_isolated() {
    let root = tempfile::tempdir().unwrap();
    let dirs = [root.path().join("first"), root.path().join("second")];
    for dir in &dirs {
        std::fs::create_dir(dir).unwrap();
    }
    let tool = || {
        reply_tool(
            "write_file",
            json!({"path":"effect.txt","content":"only once"}),
        )
    };
    let server = Server::new(vec![
        tool(),
        tool(),
        reply_text("Done"),
        reply_text("Continued"),
    ]);
    let mut client = Client::start(root.path(), &server);
    writeln!(client.input.as_mut().unwrap(), "{{broken").unwrap();
    assert_eq!(client.next()["error"]["code"], -32700);
    assert_eq!(
        client.request(1, "session/new", json!({"cwd":dirs[0],"mcpServers":[]}))["error"]["code"],
        -32600
    );
    assert_eq!(
        client.request(2, "initialize", json!({"protocolVersion":1}))["result"]["protocolVersion"],
        1
    );
    let sessions = [client.create(3, &dirs[0]), client.create(4, &dirs[1])];
    client.prompt(10, &sessions[0], "First workspace");
    client.prompt(11, &sessions[1], "Second workspace");
    let mut approval = std::collections::BTreeMap::new();
    let mut calls = std::collections::BTreeMap::new();
    while approval.len() < 2 {
        let message = client.next();
        let session = message["params"]["sessionId"]
            .as_str()
            .expect("owned session event");
        match message["method"].as_str() {
            Some("session/request_permission") => {
                assert_eq!(
                    calls.get(session),
                    message["params"]["toolCall"]["toolCallId"]
                        .as_str()
                        .map(str::to_owned)
                        .as_ref()
                );
                approval.insert(session.to_owned(), message["id"].clone());
            }
            Some("session/update") => {
                let update = &message["params"]["update"];
                assert_eq!(update["sessionUpdate"], "tool_call");
                calls.insert(
                    session.to_owned(),
                    update["toolCallId"].as_str().unwrap().to_owned(),
                );
            }
            _ => panic!("unexpected {message}"),
        }
    }
    assert_ne!(calls[&sessions[0]], calls[&sessions[1]]);
    let reentry = client.request(
        12,
        "session/prompt",
        json!({"sessionId":sessions[0],"prompt":[{"type":"text","text":"Reentry"}]}),
    );
    assert_eq!(reentry["error"]["code"], -32600);
    let configuration = client.request(
        16,
        "session/set_config_option",
        json!({"sessionId":sessions[0],"configId":"model","value":json!(["env", "model"]).to_string()}),
    );
    assert_eq!(
        configuration["error"]["message"],
        "Session has an active prompt"
    );
    client.send(json!({"method":"session/cancel","params":{"sessionId":sessions[1]}}));
    for session in sessions.iter().rev() {
        client.send(json!({"id":approval[session],"result":{
            "outcome":{"outcome":"selected","optionId":"allow-once"}
        }}));
    }
    let mut done = std::collections::BTreeMap::new();
    while done.len() < 2 {
        let message = client.next();
        if let Some(id) = message["id"].as_u64() {
            done.insert(id, message["result"]["stopReason"].clone());
        }
    }
    assert_eq!(done[&10], "end_turn");
    assert_eq!(done[&11], "cancelled");
    assert_eq!(
        std::fs::read_to_string(dirs[0].join("effect.txt")).unwrap(),
        "only once"
    );
    assert!(!dirs[1].join("effect.txt").exists());
    let evidence = peer_store::EvidenceIndexStore::new(root.path().join("data"));
    for call in calls.values() {
        let rows = evidence
            .find(&[format!("tool-result://{call}")], None)
            .unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0]["toolCallId"], *call);
    }

    client.prompt(13, &sessions[0], "Continue here");
    loop {
        let message = client.next();
        if message["id"] == 13 {
            assert_eq!(message["result"]["stopReason"], "end_turn", "{message}");
            break;
        }
    }
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    let previous: Vec<_> = requests.last().unwrap()["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|message| message["role"] == "user")
        .map(|message| message["content"].as_str().unwrap())
        .collect();
    assert_eq!(previous, vec!["First workspace", "Continue here"]);
    client.finish();
}

#[test]
fn native_acp_eof_at_approval_stops_original_run_without_tool_effect() {
    let root = tempfile::tempdir().unwrap();
    let server = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"effect.txt","content":"unexpected"}),
    )]);
    let mut client = Client::start(root.path(), &server);
    client.request(1, "initialize", json!({"protocolVersion":1}));
    let session = client.create(2, root.path());
    client.prompt(3, &session, "Write once");
    loop {
        if client.next()["method"] == "session/request_permission" {
            break;
        }
    }
    client.finish();
    assert!(!root.path().join("effect.txt").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let index =
        std::fs::read_to_string(root.path().join("data/conversations/index.jsonl")).unwrap();
    let row: Value = serde_json::from_str(index.trim()).unwrap();
    assert_eq!(row["runtimeExecution"]["phase"], "stopped");
    assert_eq!(row["runtimeExecution"]["usageCommitted"], true);
}

#[test]
fn native_acp_disconnect_drains_actual_shell_group_and_keeps_known_usage() {
    let root = tempfile::tempdir().unwrap();
    let command = "printf '%s\\n' \"$$\" > pid.partial && /bin/mv pid.partial ready.pid; /bin/sleep 30; printf unexpected > late.txt";
    let server = Server::new(vec![reply_tool("bash", json!({"command":command}))]);
    let mut client = Client::start(root.path(), &server);
    client.request(1, "initialize", json!({"protocolVersion":1}));
    let session = client.create(2, root.path());
    client.prompt(3, &session, "Start an owned command");
    loop {
        let message = client.next();
        if message["method"] == "session/request_permission" {
            client.send(json!({"id":message["id"],"result":{
                "outcome":{"outcome":"selected","optionId":"allow-once"}
            }}));
            break;
        }
    }
    let deadline = Instant::now() + Duration::from_secs(8);
    let pid = loop {
        if let Ok(raw) = std::fs::read_to_string(root.path().join("ready.pid")) {
            break raw.trim().parse::<i32>().unwrap();
        }
        assert!(
            Instant::now() < deadline,
            "the owned Shell never published its PID"
        );
        thread::sleep(Duration::from_millis(10));
    };
    let pid = rustix::process::Pid::from_raw(pid).unwrap();
    assert!(rustix::process::test_kill_process(pid).is_ok());
    client.finish();
    assert_eq!(
        rustix::process::test_kill_process_group(pid),
        Err(rustix::io::Errno::SRCH)
    );
    assert!(!root.path().join("late.txt").exists());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let data = root.path().join("data");
    let row: Value = serde_json::from_str(
        std::fs::read_to_string(data.join("conversations/index.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap();
    let run = &row["runtimeExecution"];
    assert_eq!(run["phase"], "stopped");
    assert_eq!(run["usageCommitted"], true);
    assert_eq!(run["usage"]["totalTokens"], 16);
    assert_eq!(run["pendingTools"], json!([]));
}

#[test]
fn native_acp_model_effort_and_window_are_session_local_in_wire_and_store() {
    let root = tempfile::tempdir().unwrap();
    let workspaces = [root.path().join("a"), root.path().join("b")];
    for workspace in &workspaces {
        std::fs::create_dir(workspace).unwrap();
    }
    let server = Server::new(vec![
        reply_text("Done"),
        reply_text("Done"),
        reply_text("After switch"),
    ]);
    let data = root.path().join("data");
    std::fs::create_dir(&data).unwrap();
    let models: Vec<_> = [("model-a", "Model A"), ("model-b", "Model B")]
        .into_iter()
        .map(|(id, label)| {
            json!({"id":id,"groupId":"test-channel","model":id,"enabled":true,"isDefault":id=="model-a",
                "modelLabel":label,"supportsReasoning":true,"contextWindow":32768,
                "reasoningEffortLevels":["low","high"],"reasoningDefaultEffort":"low",
                "reasoningEffortMap":{"low":"low","high":"high"},
                "modelOptions":[{"id":"context","label":"Context","kind":"select","defaultValue":"small",
                    "choices":[{"value":"small","label":"32K","contextWindow":32768},
                               {"value":"large","label":"128K","contextWindow":131072}]}],
                "modelOptionValues":{"context":"small"}})
        })
        .collect();
    let config = data.join("llm-providers.json");
    let original = serde_json::to_vec(&json!({"version":2,
        "channels":[{"id":"test-channel","name":"Fixture channel","providerType":"openai","baseUrl":server.url,
                     "wireOverride":"openai-chat","authMethod":"api_key","apiKeyConfigured":true,"enabled":true}],
        "models":models})).unwrap();
    std::fs::write(&config, &original).unwrap();
    let helper = root.path().join("isolated-helper");
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(
        &helper,
        "#!/bin/sh\nread request\nprintf '%s\\n' '{\"version\":1,\"ok\":true,\"data\":{\"secret\":\"controlled-only\"}}'\n",
    ).unwrap();
    std::fs::set_permissions(&helper, std::fs::Permissions::from_mode(0o700)).unwrap();

    let mut client = Client::spawn(root.path(), |command| {
        command.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    });
    client.request(1, "initialize", json!({"protocolVersion":1}));
    let first = client.request(
        2,
        "session/new",
        json!({"cwd":workspaces[0],"mcpServers":[]}),
    );
    let first_session = first["result"]["sessionId"].as_str().unwrap();
    assert_eq!(
        first["result"]["configOptions"][0]["options"][0]["name"],
        "Fixture channel"
    );
    assert_eq!(
        first["result"]["configOptions"][2]["currentValue"],
        "\"small\""
    );
    let second_session = client.create(3, &workspaces[1]);
    let selected_model = json!(["test-channel", "model-b"]).to_string();
    for (id, (option, value)) in [
        ("model", selected_model.as_str()),
        ("reasoning_effort", "high"),
        ("context_window", "\"large\""),
    ]
    .into_iter()
    .enumerate()
    {
        let response = client.request(
            id as u64 + 4,
            "session/set_config_option",
            json!({"sessionId":first_session,"configId":option,"value":value}),
        );
        assert!(
            response["result"]["configOptions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|entry| entry["id"] == option && entry["currentValue"] == value)
        );
    }
    client.prompt(10, first_session, "Isolated A");
    client.prompt(11, &second_session, "Isolated B");
    let mut completed = 0;
    while completed < 2 {
        let message = client.next();
        if matches!(message["id"].as_u64(), Some(10 | 11)) {
            assert_eq!(message["result"]["stopReason"], "end_turn", "{message}");
            completed += 1;
        }
    }
    {
        let records = server.requests.lock().unwrap();
        assert_eq!(records.len(), 2);
        for (message, expected_model, expected_effort) in [
            ("Isolated A", "model-b", "high"),
            ("Isolated B", "model-a", "low"),
        ] {
            let request = records
                .iter()
                .find(|request| {
                    request["messages"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .any(|row| row["role"] == "user" && row["content"] == message)
                })
                .unwrap();
            assert_eq!(request["model"], expected_model);
            assert_eq!(request["reasoning_effort"], expected_effort);
        }
    }
    let rows_for = || {
        std::fs::read_to_string(data.join("conversations/index.jsonl"))
            .unwrap()
            .lines()
            .map(|row| serde_json::from_str::<Value>(row).unwrap())
            .collect::<Vec<_>>()
    };
    let rows = rows_for();
    assert_eq!(rows.len(), 2);
    for (i, (workspace, window)) in workspaces.iter().zip([131072, 32768]).enumerate() {
        let canonical = std::fs::canonicalize(workspace).unwrap();
        let row = rows
            .iter()
            .find(|row| row["workspacePath"] == canonical.to_str().unwrap())
            .unwrap();
        assert_eq!(row["modelProviderId"], "test-channel");
        assert_eq!(row["model"], ["model-b", "model-a"][i]);
        assert_eq!(row["effort"], ["high", "low"][i]);
        let id = row["id"].as_str().unwrap();
        let path = data
            .join("conversations/.context-snapshots")
            .join(format!("{id}.json"));
        let snapshot = get(path);
        assert_eq!(snapshot["conversationId"], id);
        assert_eq!(snapshot["contextWindow"], window);
    }
    let workspace = std::fs::canonicalize(&workspaces[0]).unwrap();
    let first_row = |rows: Vec<Value>| {
        rows.into_iter()
            .find(|row| row["workspacePath"] == workspace.to_str().unwrap())
            .unwrap()
    };
    let before = first_row(rows);
    let select = |value: &str| json!({"sessionId":first_session,"configId":"model","value":value});
    let model_a = json!(["test-channel", "model-a"]).to_string();
    let lock = data.join("conversations/index.jsonl.lock");
    std::fs::create_dir(&lock).unwrap();
    let rejected = client.request(12, "session/set_config_option", select(&model_a));
    assert_eq!(rejected["error"]["code"], -32603);
    assert_eq!(first_row(rows_for()), before);
    std::fs::remove_dir(&lock).unwrap();
    let actual = client.request(
        13,
        "session/set_config_option",
        json!({"sessionId":first_session,"configId":"context_window","value":"\"large\""}),
    );
    assert_eq!(
        actual["result"]["configOptions"][0]["currentValue"],
        selected_model
    );
    let switched = client.request(14, "session/set_config_option", select(&model_a));
    assert_eq!(
        switched["result"]["configOptions"][0]["currentValue"],
        model_a
    );
    let after = first_row(rows_for());
    assert_eq!(after["model"], "model-a");
    assert_eq!(after["effort"], "high");
    assert!(after["contextSnapshot"].is_null());
    for key in [
        "id",
        "contentRevision",
        "messageCount",
        "runtimeExecution",
        "lifetimeUsage",
    ] {
        assert_eq!(after[key], before[key], "{key}");
    }
    client.prompt(15, first_session, "After switching model");
    loop {
        let message = client.next();
        if message["id"] == 15 {
            assert_eq!(message["result"]["stopReason"], "end_turn", "{message}");
            break;
        }
    }
    client.finish();
    let records = server.requests.lock().unwrap();
    assert_eq!(records.len(), 3);
    assert_eq!(records[2]["model"], "model-a");
    assert_eq!(records[2]["reasoning_effort"], "high");
    assert_eq!(std::fs::read(&config).unwrap(), original);
}

#[test]
fn native_acp_skill_uses_the_ordinary_host_and_keeps_evidence() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    let dir = workspace.join("skills/notes");
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(
        dir.join("SKILL.md"),
        "---\ndescription: Local test package\n---\nACP-SKILL-BODY",
    )
    .unwrap();
    let server = Server::new(vec![
        reply_tool("skill__notes", json!({})),
        reply_text("Done"),
    ]);
    let mut client = Client::start(root.path(), &server);
    client.request(1, "initialize", json!({"protocolVersion":1}));
    let session = client.create(2, &workspace);
    client.prompt(3, &session, "Load notes");
    let mut call = None;
    while call.is_none() {
        let message = client.next();
        if message["params"]["update"]["sessionUpdate"] == "tool_call" {
            call = message["params"]["update"]["toolCallId"]
                .as_str()
                .map(str::to_owned);
        }
        assert_ne!(message["id"], 3, "{message}");
    }
    loop {
        let message = client.next();
        if message["id"] == 3 {
            assert_eq!(message["result"]["stopReason"], "end_turn");
            break;
        }
    }
    client.finish();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(!requests[0].to_string().contains("ACP-SKILL-BODY"));
    assert!(requests[1].to_string().contains("ACP-SKILL-BODY"));
    let id = call.unwrap();
    let evidence = peer_store::EvidenceIndexStore::new(root.path().join("data"))
        .find(&[format!("tool-result://{id}")], None)
        .unwrap();
    assert_eq!(evidence[0]["capabilityId"], "local.skill.notes");
}

#[test]
fn native_acp_hook_ask_uses_real_editor_approval_and_canonical_evidence() {
    let root = tempfile::tempdir().unwrap();
    let workspace = root.path().join("workspace");
    std::fs::create_dir_all(workspace.join(".peer")).unwrap();
    std::fs::write(workspace.join("source.txt"), "APPROVED-ACP-FIXTURE").unwrap();
    put(
        workspace.join(".peer/hooks.json"),
        &json!({"hooks":{"PreToolUse":[
            {"id":"review","command":r#"printf '%s' '{"decision":"ask"}'"#}
        ]}}),
    );
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"source.txt"})),
        reply_text("Done"),
    ]);
    let mut client = Client::start(root.path(), &server);
    client.request(1, "initialize", json!({"protocolVersion":1}));
    let session = client.create(2, &workspace);
    client.prompt(3, &session, "Read the source");
    let approval = loop {
        let message = client.next();
        assert_ne!(message["id"], 3, "{message}");
        if message["method"] == "session/request_permission" {
            break message;
        }
    };
    assert_eq!(approval["params"]["sessionId"], session);
    let call = approval["params"]["toolCall"]["toolCallId"]
        .as_str()
        .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    client.send(json!({"id":approval["id"],"result":{"outcome":{"outcome":"selected","optionId":"allow-once"}}}));
    loop {
        let message = client.next();
        if message["id"] == 3 {
            assert_eq!(message["result"]["stopReason"], "end_turn", "{message}");
            break;
        }
    }
    client.finish();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].to_string().contains("APPROVED-ACP-FIXTURE"));
    let store = peer_store::EvidenceIndexStore::new(root.path().join("data"));
    let records = store
        .find(&[format!("tool-result://{call}")], None)
        .unwrap();
    assert_eq!(records.len(), 1);
    assert_eq!(records[0]["capabilityId"], "local.file.read");
}
