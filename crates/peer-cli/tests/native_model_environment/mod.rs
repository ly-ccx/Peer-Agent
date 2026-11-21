//! Actual public native env source -> canonical Host -> tool/grant/Evidence.
use super::*;
fn select(f: &Fixture, effort: &str) {
    let path = f.root.path().join("goal-plans/p.json");
    let mut goal = get(&path);
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role] = json!({"providerId":"openai-compatible","modelProviderId":"openai-compatible","family":"openai-compatible","modelId":"env-model","reasoningEffort":effort});
    }
    put(path, &goal);
}
fn command(f: &Fixture, server: &Server) -> Command {
    let mut c = f.command("exec", "p");
    c.env("PEER_MODEL_API_KEY", " synthetic-env-key ")
        .env("PEER_MODEL_ID", " env-model ")
        .env("PEER_MODEL_BASE_URL", format!("{}/", server.url))
        .env(
            "PEER_CREDENTIAL_HELPER_PATH",
            "/nonexistent/forbidden-helper",
        );
    c
}
#[test]
fn environment_source_executes_real_native_tools_without_configuration_or_helper_and_keeps_secrets_out_of_facts()
 {
    for effort in ["off", "low", "default", "high"] {
        let server = Server::new(vec![
            reply_tool("read_file", json!({"path":"input.txt"})),
            reply_text("verified"),
        ]);
        let f = Fixture::new(&server);
        select(&f, effort);
        std::fs::remove_file(f.root.path().join("llm-providers.json")).unwrap();
        let out = command(&f, &server).output().unwrap();
        assert_eq!(
            out.status.code(),
            Some(0),
            "{effort}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        let history = f.history();
        let tool = history.iter().find(|m| m["segments"].is_array()).unwrap();
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert!(tool["segments"][0]["result"]["evidence"].is_object());
        assert!(
            !serde_json::to_string(&history)
                .unwrap()
                .contains("synthetic-env-key")
        );
        assert!(!String::from_utf8_lossy(&out.stdout).contains("synthetic-env-key"));
        assert!(!String::from_utf8_lossy(&out.stderr).contains("synthetic-env-key"));
        assert!(!f.root.path().join("llm-providers.json").exists());
        assert!(!f.root.path().join("credentials.vault.json").exists());
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for request in requests.iter() {
            assert_eq!(request["model"], "env-model");
            if effort == "default" {
                assert!(request.get("reasoning_effort").is_none());
            } else {
                assert_eq!(request["reasoning_effort"], effort);
            }
        }
        assert!(
            server
                .request_headers
                .lock()
                .unwrap()
                .iter()
                .all(|s| s.contains("authorization: Bearer synthetic-env-key"))
        );
    }
}
#[test]
fn environment_credential_does_not_grant_local_access_or_override_an_explicit_file_binding() {
    let server = Server::new(vec![
        reply_tool("write_file", json!({"path":"denied.txt","content":"never"})),
        reply_text("denied"),
    ]);
    let f = Fixture::new(&server);
    select(&f, "default");
    let policy = PolicyStore::new(f.root.path());
    let old = policy.read_existing("w").unwrap();
    policy
        .update_existing(
            "w",
            old.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let out = command(&f, &server).output().unwrap();
    assert_eq!(
        out.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(!f.root.path().join("workspace/denied.txt").exists());
    assert_eq!(f.history()[1]["segments"][0]["result"]["status"], "denied");
    assert_eq!(f.history()[1]["permissionGrants"][0]["granted"], false);
    let server = Server::new(vec![reply_text("file binding")]);
    let f = Fixture::new(&server);
    let out = command(&f, &server).output().unwrap();
    assert!(out.status.success());
    assert_eq!(server.requests.lock().unwrap()[0]["model"], "model");
    assert!(
        server
            .request_headers
            .lock()
            .unwrap()
            .iter()
            .all(|s| !s.contains("synthetic-env-key"))
    );
}
#[test]
fn invalid_environment_selection_key_and_missing_key_block_before_remote_dispatch() {
    for mode in ["model", "effort", "key", "missing"] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        select(&f, if mode == "effort" { "max" } else { "default" });
        let mut c = command(&f, &server);
        if mode == "model" {
            c.env("PEER_MODEL_ID", "different");
        }
        if mode == "key" {
            c.env("PEER_MODEL_API_KEY", "bad\r\nheader");
        }
        if mode == "missing" {
            c.env_remove("PEER_MODEL_API_KEY");
        }
        let out = c.output().unwrap();
        assert!(!out.status.success());
        assert!(server.requests.lock().unwrap().is_empty());
        assert_eq!(f.history().len(), 1);
    }
}
