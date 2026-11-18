use super::*;

#[test]
fn public_exec_distinguishes_unavailable_model_configuration_from_bad_selection() {
    let fixture = Ordinary::new();
    std::fs::create_dir(fixture.home()).unwrap();
    let config = fixture.home().join("llm-providers.json");
    let damaged = b"{incomplete";
    std::fs::write(&config, damaged).unwrap();
    let result = fixture.run(None, &["Inspect the workspace"], None);
    assert_eq!(result.status.code(), Some(3), "{result:?}");
    assert!(result.stdout.is_empty());
    assert!(String::from_utf8_lossy(&result.stderr).contains("model_config_invalid"));
    assert_eq!(std::fs::read(&config).unwrap(), damaged);
    assert!(!fixture.home().join("conversations").exists());

    let server = Server::new(vec![]);
    let result = fixture.run(
        Some(&server),
        &["--model", "missing", "Inspect the workspace"],
        None,
    );
    assert_eq!(result.status.code(), Some(2), "{result:?}");
    assert!(result.stdout.is_empty());
    assert!(server.requests.lock().unwrap().is_empty());
    assert!(!fixture.home().join("conversations").exists());
}

#[test]
fn public_exec_distinguishes_model_access_rejection_from_other_http_errors() {
    for (status, reason, body, exit, error) in [
        (
            401,
            "Unauthorized",
            "maximum context length",
            3,
            "model_auth_rejected",
        ),
        (403, "Forbidden", "", 3, "model_auth_rejected"),
        (
            407,
            "Proxy Authentication Required",
            "",
            1,
            "model_http_rejected",
        ),
        (
            503,
            "Service Unavailable",
            "credential unavailable",
            1,
            "model_http_rejected",
        ),
    ] {
        let fixture = Ordinary::new();
        let rejected = format!(
            "HTTP/1.1 {status} {reason}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
        let server = Server::new(vec![
            reply_tool("write_file", json!({"path":"effect.txt","content":"once"})),
            rejected,
        ]);
        let output = fixture.run(
            Some(&server),
            &["--access", "full", "--output-format", "json", "Write once"],
            None,
        );
        assert_eq!(
            output.status.code(),
            Some(exit),
            "{status}: {} {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        );
        let result = fixture.assert_settled(&output, 2, 1);
        assert_eq!(result["ok"], false);
        assert!(result["result"].is_null());
        assert_eq!(result["error"], error);
        assert_eq!(result["usage"]["totalTokens"], 16);
        assert_eq!(result["usage"]["providerRequestCount"], 2);
        assert_eq!(fixture.metadata()["runtimeExecution"]["unknownUsage"], true);
        assert!(output.stderr.is_empty());
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        assert_eq!(
            std::fs::read_to_string(fixture.workspace().join("effect.txt")).unwrap(),
            "once"
        );
    }
}

#[test]
fn public_exec_preserves_confirmed_effect_when_compaction_request_loses_model_access() {
    let fixture = Ordinary::new();
    let server = Server::new(vec![
        reply_tool("write_file", json!({"path":"effect.txt","content":"once"})),
        overflow_reply(),
        "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
    ]);
    let output = fixture.run(
        Some(&server),
        &["--access", "full", "--output-format", "json", "Write once"],
        None,
    );
    assert_eq!(output.status.code(), Some(3), "{output:?}");
    let result = fixture.assert_settled(&output, 2, 1);
    assert_eq!(result["error"], "model_auth_rejected");
    assert_eq!(result["usage"]["totalTokens"], 16);
    assert_eq!(result["usage"]["providerRequestCount"], 3);
    assert_eq!(fixture.metadata()["runtimeExecution"]["unknownUsage"], true);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    let store = ConversationStore::new(fixture.home());
    let id = result["sessionId"].as_str().unwrap();
    let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    assert!(
        history
            .history
            .messages
            .iter()
            .all(|message| message.get("_compaction").is_none()),
        "the denied summary did not commit a compaction marker"
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("effect.txt")).unwrap(),
        "once"
    );
}

#[test]
fn closed_stdout_preserves_the_settled_exit_and_does_not_retry_an_effect() {
    for (last_reply, exit) in [
        (reply_text("Delivered."), 0),
        (
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            3,
        ),
    ] {
        let fixture = Ordinary::new();
        let model = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"effect.txt","content":"confirmed"}),
            ),
            last_reply,
        ]);
        let mut child = fixture
            .command(Some(&model))
            .args([
                "--mode",
                "chat",
                "--access",
                "full",
                "--output-format",
                "json",
                "Write the fixture exactly once",
            ])
            .spawn()
            .unwrap();
        drop(child.stdout.take().unwrap());
        let output = wait(child);
        assert_eq!(output.status.code(), Some(exit), "{output:?}");
        assert!(output.stderr.is_empty(), "{output:?}");
        assert_eq!(model.requests.lock().unwrap().len(), 2);
        assert_eq!(
            std::fs::read_to_string(fixture.workspace().join("effect.txt")).unwrap(),
            "confirmed"
        );
        let metadata = fixture.metadata();
        let id = metadata["id"].as_str().unwrap();
        let store = ConversationStore::new(fixture.home());
        let run = store.read_conversation_execution(id).unwrap().unwrap();
        assert!(run.permits_new_run() && run.usage_committed && run.pending_tools.is_empty());
        let history = store.read_committed(id, None, 1024 * 1024).unwrap();
        let calls = history
            .history
            .messages
            .iter()
            .filter_map(|row| row["segments"].as_array())
            .flatten()
            .filter(|segment| segment["type"] == "tool-call")
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["result"]["status"], "success");
        let call_id = calls[0]["toolCallId"].as_str().unwrap();
        assert_eq!(
            peer_store::EvidenceIndexStore::new(fixture.home())
                .find(&[format!("tool-result://{call_id}")], None)
                .unwrap()
                .len(),
            1
        );
    }
}
