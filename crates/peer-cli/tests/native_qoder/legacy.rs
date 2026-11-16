//! Existing local credentials and env tokens share the governed native Host.
use super::*;
pub(super) fn select(f: &Fixture, model: &str) {
    let mut config = get(f.root.path().join("llm-providers.json"));
    config["models"][0]["model"] = json!(model);
    put(f.root.path().join("llm-providers.json"), &config);
    let mut plan = get(f.root.path().join("goal-plans/p.json"));
    for role in ["worker", "explorer", "verifier"] {
        plan["delegationOrigin"]["modelSelection"][role]["modelId"] = json!(model);
    }
    put(f.root.path().join("goal-plans/p.json"), &plan);
}
#[test]
fn unknown_qoder_model_uses_native_json_bearer_with_real_tools_and_paired_evidence() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"legacy.txt","content":"native legacy"}),
        ),
        reply_text("Legacy complete."),
    ]);
    let f = Fixture::new(&server);
    let cipher = configure(&f, &server);
    select(&f, "unknown-model");
    let output = command(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/legacy.txt")).unwrap(),
        "native legacy"
    );
    assert_eq!(
        std::fs::read(f.root.path().join(".qoder/.auth/user")).unwrap(),
        cipher
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["lastRequestUsage"]["inputTokens"], 12);
    #[cfg(feature = "test-fixtures")]
    {
        use sha2::{Digest, Sha256};
        let bytes = server.request_bytes.lock().unwrap();
        assert_eq!(
            receipt["lastRequestUsage"]["requestFingerprint"],
            format!("{:x}", Sha256::digest(bytes.last().unwrap()))
        );
    }
    let history = f.history();
    let tool = history.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    let headers = server.request_headers.lock().unwrap();
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    for (header, body) in headers.iter().zip(requests.iter()) {
        assert!(header.starts_with("POST /v1/chat/completions "));
        assert!(header.contains("authorization: Bearer SYNTHETIC\r\n"));
        assert!(!header.contains("Bearer COSY."));
        assert_eq!(body["model"], "unknown-model");
        assert!(body["chat_task"].is_null());
        assert!(header.contains(&format!(
            "x-request-id: {}\r\n",
            body["metadata"]["context"]["request_id"].as_str().unwrap()
        )));
    }
    assert!(
        requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool")
    );
    assert!(
        !history
            .iter()
            .map(Value::to_string)
            .collect::<String>()
            .contains("SYNTHETIC")
    );
}
#[test]
fn legacy_env_tokens_keep_priority_without_reading_unrelated_local_login_files() {
    for (access, personal, pat, expected) in [
        ("  ACCESS  ", "PERSONAL", "PAT", "ACCESS"),
        (" ", " PERSONAL ", "PAT", "PERSONAL"),
        ("", "", " PAT ", "PAT"),
    ] {
        let server = Server::new(vec![reply_text("Environment credential selected.")]);
        let f = Fixture::new(&server);
        configure(&f, &server);
        select(&f, "unknown-model");
        let user = f.root.path().join(".qoder/.auth/user");
        std::fs::write(&user, b"unreadable-as-credentials").unwrap();
        std::fs::remove_file(f.root.path().join(".qoder/.auth/machine_id")).unwrap();
        let mut c = command(&f);
        c.env("QODER_ACCESS_TOKEN", access)
            .env("QODER_PERSONAL_ACCESS_TOKEN", personal)
            .env("QODER_PAT", pat);
        let output = c.output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read(&user).unwrap(), b"unreadable-as-credentials");
        assert!(
            server.request_headers.lock().unwrap()[0]
                .contains(&format!("authorization: Bearer {expected}\r\n"))
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(expected));
    }
}
#[test]
fn legacy_ignores_inference_endpoint_but_configured_base_overrides_environment_host() {
    let server = Server::new(vec![reply_text("Explicit legacy endpoint selected.")]);
    let f = Fixture::new(&server);
    configure(&f, &server);
    select(&f, "unknown-model");
    let mut c = command(&f);
    c.env("QODER_ACCESS_TOKEN", "SYNTHETIC-ENV")
        .env(
            "QODER_MODEL_SERVER_HOST",
            "must-not-receive-credentials.invalid",
        )
        .env(
            "QODER_INFERENCE_ENDPOINT",
            "https://also-must-not-receive-credentials.invalid",
        );
    let output = c.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert!(server.request_headers.lock().unwrap()[0].starts_with("POST /v1/chat/completions "));
}
#[test]
fn legacy_local_tokens_do_not_require_prepared_uid_but_expiry_and_types_still_bind() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-legacy.json"
    ))
    .unwrap();
    for case in data["credentials"].as_array().unwrap() {
        let server = Server::new(vec![reply_text("Local credential selected.")]);
        let f = Fixture::new(&server);
        configure(&f, &server);
        select(&f, "unknown-model");
        let path = f.root.path().join(".qoder/.auth/user");
        std::fs::write(&path, case["encoded"].as_str().unwrap()).unwrap();
        let output = command(&f).output().unwrap();
        if let Some(error) = case["error"].as_str() {
            assert!(!output.status.success());
            assert!(String::from_utf8_lossy(&output.stderr).contains(error));
            assert!(server.requests.lock().unwrap().is_empty());
        } else {
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert!(server.request_headers.lock().unwrap()[0].contains(&format!(
                "authorization: Bearer {}\r\n",
                case["token"].as_str().unwrap()
            )));
        }
        assert_eq!(
            std::fs::read_to_string(path).unwrap(),
            case["encoded"].as_str().unwrap()
        );
    }
}
#[test]
fn adding_catalog_metadata_after_a_tool_invalidates_legacy_dialect_and_preserves_the_tool_fact() {
    let script = r#"printf '%s' '{"chat":[{"key":"unknown-model"}]}' > ../.qoder/.auth/models"#;
    let server = Server::new(vec![reply_tool("bash", json!({"command":script}))]);
    let f = Fixture::new(&server);
    configure(&f, &server);
    select(&f, "unknown-model");
    let output = command(&f).output().unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("qoder_auth_changed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let history = f.history();
    let result = history.iter().find(|v| v["segments"].is_array()).unwrap();
    assert_eq!(result["segments"][0]["result"]["status"], "success");
    assert!(result["segments"][0]["result"]["evidence"].is_object());
}
