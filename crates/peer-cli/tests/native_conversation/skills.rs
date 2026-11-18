use super::*;

fn skill(root: &Path, id: &str, description: &str, body: &str) -> std::path::PathBuf {
    let path = root.join("skills").join(id);
    std::fs::create_dir_all(&path).unwrap();
    let path = path.join("SKILL.md");
    std::fs::write(&path, format!("---\nname: Fixture Skill\ndescription: {description}\nwhen-to-use: On demand\nallowed-tools: [read_file]\n---\n{body}\n")).unwrap();
    path
}
fn settings(fixture: &Ordinary, disabled: &[&str]) {
    let root = fixture.home().join("skills");
    std::fs::create_dir_all(&root).unwrap();
    let workspace = std::fs::canonicalize(fixture.workspace()).unwrap();
    std::fs::write(
        root.join("settings.json"),
        json!({"workspaceDisabled":{workspace.to_str().unwrap():disabled}}).to_string(),
    )
    .unwrap();
}
fn functions(request: &Value) -> Vec<&str> {
    request["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|tool| tool["function"]["name"].as_str())
        .collect()
}
fn system(request: &Value) -> &str {
    request["messages"][0]["content"].as_str().unwrap()
}
fn saved_tool(request: &Value) -> Value {
    let content = request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|r| r["role"] == "tool")
        .unwrap()["content"]
        .as_str()
        .unwrap();
    serde_json::from_str(content).unwrap()
}

#[test]
fn public_ordinary_skill_projects_a_workspace_override_and_preserves_real_tool_evidence() {
    let fixture = Ordinary::new();
    skill(
        &fixture.home(),
        "shared",
        "Global summary",
        "GLOBAL-PRIVATE-BODY",
    );
    skill(
        &fixture.home(),
        "disabled",
        "Disabled summary",
        "DISABLED-PRIVATE-BODY",
    );
    let path = skill(
        &fixture.workspace(),
        "shared",
        "Workspace summary",
        "LOCAL-FIXTURE-BODY from {baseDir}",
    );
    settings(&fixture, &["disabled"]);
    let file_before = std::fs::read(&path).unwrap();
    let server = Server::new(vec![
        reply_tool(
            "skill__shared",
            json!({"userMessage":"Use fixture","path":"/a/model/value/is/not/a/path"}),
        ),
        reply_text("Done"),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--tools",
            "skill__shared",
            "--output-format",
            "json",
            "Use the mounted workspace skill",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let reply = fixture.assert_settled(&output, 2, 1);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(functions(&requests[0]), ["skill__shared"]);
    assert_eq!(
        requests[0]["tools"][0]["function"]["description"],
        "Workspace summary\nOn demand"
    );
    assert!(system(&requests[0]).contains("Mounted Skills for this request: skill__shared"));
    assert!(!requests[0].to_string().contains("LOCAL-FIXTURE-BODY"));
    assert!(!system(&requests[1]).contains("LOCAL-FIXTURE-BODY"));
    let observed = saved_tool(&requests[1]);
    assert_eq!(observed["output"]["kind"], "skill_instructions");
    assert_eq!(observed["output"]["scope"], "workspace");
    assert_eq!(observed["output"]["allowedTools"], json!(["read_file"]));
    let instructions = observed["output"]["instructions"].as_str().unwrap();
    assert!(instructions.contains("LOCAL-FIXTURE-BODY"));
    assert!(
        instructions.contains(
            std::fs::canonicalize(path.parent().unwrap())
                .unwrap()
                .to_str()
                .unwrap()
        )
    );
    assert!(!instructions.contains("GLOBAL-PRIVATE-BODY"));
    let store = ConversationStore::new(fixture.home());
    let row = store
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let call = row
        .history
        .messages
        .iter()
        .find(|m| m["segments"].is_array())
        .unwrap();
    let result = &call["segments"][0]["result"];
    assert_eq!(result["capabilityId"], "local.skill.shared");
    assert_eq!(result["evidence"]["skillId"], "shared");
    assert_eq!(
        result["evidence"]["permissionGrantId"],
        call["permissionGrants"][0]["grantId"]
    );
    assert_eq!(call["permissionGrants"][0]["granted"], true);
    assert_eq!(std::fs::read(path).unwrap(), file_before);
}

#[test]
fn public_ordinary_disabled_and_scope_excluded_skills_never_enter_projection() {
    for disabled in [false, true] {
        let fixture = Ordinary::new();
        skill(
            &fixture.home(),
            "example",
            "Owned package",
            "DO NOT SEND BODY",
        );
        if disabled {
            settings(&fixture, &["example"]);
        }
        let server = Server::new(vec![reply_text("Done")]);
        let output = fixture.run(
            Some(&server),
            &["--tools", "read_file", "Answer directly"],
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert_eq!(functions(&requests[0]), ["read_file"]);
        assert!(!system(&requests[0]).contains("Mounted Skills for this request"));
        assert!(!requests[0].to_string().contains("DO NOT SEND BODY"));
    }
}

#[test]
fn public_ordinary_large_skill_loads_an_immutable_result_through_the_same_conversation_reader() {
    let fixture = Ordinary::new();
    let body = "Useful fixture data.\n".repeat(420) + "SUCCESSFUL-FIXTURE-TAIL";
    skill(&fixture.home(), "large", "Large fixture", &body);
    let server = Server::new(vec![
        reply_tool("skill__large", json!({})),
        "FIXTURE_READ_SKILL_REFERENCE".into(),
        reply_text("Saved body retrieved"),
    ]);
    let output = fixture.run(
        Some(&server),
        &["--output-format", "json", "Load and read full Skill"],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 3, 2);
    let requests = server.requests.lock().unwrap();
    assert!(functions(&requests[1]).contains(&"read_tool_result"));
    let preview = saved_tool(&requests[1]);
    assert_eq!(preview["truncated"], true);
    assert!(!preview.to_string().contains("SUCCESSFUL-FIXTURE-TAIL"));
    let content = saved_tool(&requests[2]);
    assert!(
        content["output"]["content"]
            .as_str()
            .unwrap()
            .contains("SUCCESSFUL-FIXTURE-TAIL")
    );
    let range = &content["output"];
    assert_eq!(range["complete"], false);
    assert_eq!(
        range["offset"].as_u64().unwrap() + range["bytes"].as_u64().unwrap(),
        range["totalBytes"].as_u64().unwrap()
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    let store = ConversationStore::new(fixture.home());
    let history = store
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let results: Vec<_> = history
        .history
        .messages
        .iter()
        .flat_map(|r| r["segments"].as_array().into_iter().flatten())
        .map(|r| &r["result"])
        .filter(|r| r["capabilityId"].is_string())
        .collect();
    assert_eq!(results[1]["capabilityId"], "local.tool-result.read");
    assert_eq!(results[1]["status"], "success");
}

#[test]
fn public_ordinary_skill_mount_revocation_prevents_effect_and_fresh_work_recovers() {
    let fixture = Ordinary::new();
    skill(
        &fixture.home(),
        "revoked",
        "Initially enabled",
        "REVOKED-BODY-MUST-NOT-LEAVE",
    );
    let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let (received, request) = std::sync::mpsc::channel();
    let (advance, released) = std::sync::mpsc::channel();
    let mut command = fixture.command(None);
    command
        .env(
            "PEER_MODEL_BASE_URL",
            format!("http://{}", listener.local_addr().unwrap()),
        )
        .env("PEER_MODEL_API_KEY", "controlled-fixture")
        .env("PEER_MODEL_ID", "model")
        .args(["--output-format", "json", "Use the Skill"]);
    let worker = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let (body, _, _, _) = read_request(&mut socket);
        received.send(body).unwrap();
        released.recv_timeout(Duration::from_secs(8)).unwrap();
        let response = reply_tool("skill__revoked", json!({}));
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
            response.len()
        );
    });
    let child = command.spawn().unwrap();
    let first = request.recv_timeout(Duration::from_secs(8)).unwrap();
    assert!(functions(&first).contains(&"skill__revoked"));
    settings(&fixture, &["revoked"]);
    advance.send(()).unwrap();
    let output = wait(child);
    worker.join().unwrap();
    assert!(!output.status.success());
    let outcome: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome["error"], "native_skill_source_changed", "{outcome}");
    let outcome = fixture.assert_settled(&output, 1, 0);
    let history = ConversationStore::new(fixture.home())
        .read_committed(
            outcome["sessionId"].as_str().unwrap(),
            None,
            8 * 1024 * 1024,
        )
        .unwrap();
    assert!(
        history
            .history
            .messages
            .iter()
            .all(|row| !row.to_string().contains("REVOKED-BODY"))
    );
    let next = Server::new(vec![reply_text("Fresh scope is back")]);
    let output = fixture.run(Some(&next), &["Answer independently"], None);
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!functions(&next.requests.lock().unwrap()[0]).contains(&"skill__revoked"));
}

#[test]
fn public_goal_uses_the_mounted_skill_through_worker_admission_and_evidence() {
    let server = Server::new(vec![
        reply_tool("skill__goal_notes", json!({})),
        reply_text("Goal fixture done"),
    ]);
    let fixture = Fixture::new(&server);
    skill(
        &fixture.root.path().join("workspace"),
        "goal_notes",
        "Authorized workspace package",
        "SCOPED-GOAL-FIXTURE",
    );
    let output = fixture.run();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(functions(&requests[0]).contains(&"skill__goal_notes"));
    assert_eq!(
        saved_tool(&requests[1])["output"]["instructions"],
        "SCOPED-GOAL-FIXTURE\n"
    );
    let history = fixture.history();
    let observed = history
        .iter()
        .flat_map(|row| row["segments"].as_array().into_iter().flatten())
        .find(|row| row["result"]["capabilityId"] == "local.skill.goal_notes")
        .unwrap();
    let receipt = &observed["result"];
    assert_eq!(receipt["status"], "success");
    assert_eq!(receipt["evidence"]["skillId"], "goal_notes");
}

#[test]
fn public_skill_preserves_a_legacy_install_id_and_rejects_an_unprojected_call() {
    let fixture = Ordinary::new();
    skill(
        &fixture.home(),
        "old.notes",
        "Existing package id",
        "PROTECTED-RESULT",
    );
    let server = Server::new(vec![reply_tool("skill__old_notes_bad_alias", json!({}))]);
    let output = fixture.run(
        Some(&server),
        &[
            "--tools",
            "local.skill.old.notes",
            "--output-format",
            "json",
            "Select the installed Skill",
        ],
        None,
    );
    assert!(!output.status.success());
    let result = fixture.assert_settled(&output, 1, 0);
    assert_eq!(result["error"], "tool_not_projected");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    let aliases = functions(&requests[0]);
    assert_eq!(aliases.len(), 1);
    assert!(aliases[0].starts_with("skill__old_notes_"));
    assert!(peer_runtime::providers::wire_skill_name(aliases[0]));
    assert!(!requests[0].to_string().contains("PROTECTED-RESULT"));
}
