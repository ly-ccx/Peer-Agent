//! Public CLI recovery against the actual encrypted Helper and config Store.
use super::*;
fn models(f: &Fixture) -> Command {
    let mut command = Command::new(native_test_binary());
    command
        .arg("models")
        .env("PEER_AGENT_HOME", f.root.path())
        .env("HOME", f.root.path())
        .env("PATH", "/nonexistent")
        .env("PEER_CREDENTIAL_HELPER_PATH", "/forbidden-helper")
        .env_remove("PEER_MODEL_API_KEY");
    command
}

fn bytes(f: &Fixture, name: &str) -> Vec<u8> {
    std::fs::read(f.root.path().join(name)).unwrap()
}
fn result(out: &Output) -> Value {
    serde_json::from_str(String::from_utf8_lossy(&out.stdout).lines().last().unwrap()).unwrap()
}
#[test]
fn reconciliation_repairs_only_known_hints_and_is_readonly_when_already_synced() {
    let auth = "oauth_chatgpt";
    let idp = Idp::new(body(auth), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, auth, &idp, &model);
    let file = f.root.path().join("llm-providers.json");
    let mut config = get(&file);
    config["futureRoot"] = json!({"preserved":[1,2]});
    config["channels"][0]["futureChannel"] = json!({"kept":true});
    config["models"][0]["futureModel"] = json!({"kept":true});
    config["models"][0]["oauthAccountId"] = json!("stale-override");
    config["models"][0]["oauthExpires"] = json!(3);
    put(&file, &config);
    let original = bytes(&f, "llm-providers.json");
    let vault_before = bytes(&f, "credentials.vault.json");
    let history_before = f.history();
    let token = raw_token(&f);
    assert_eq!(state(&f)["status"], "refresh_required");
    assert_eq!(bytes(&f, "llm-providers.json"), original);
    let mut list = models(&f);
    assert!(list.output().unwrap().stdout.is_empty());
    let out = cli(&f, "reconcile").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        result(&out),
        json!({"status":"metadata_reconciled","channelId":"provider","metadataStatus":"synced"})
    );
    assert_hints(&f, &original, Some(&token));
    assert_eq!(bytes(&f, "credentials.vault.json"), vault_before);
    let store = peer_store::ModelConfigStore::new(f.root.path());
    let revision = store.read().unwrap().source_revision;
    let synced = bytes(&f, "llm-providers.json");
    assert!(cli(&f, "reconcile").output().unwrap().status.success());
    assert_eq!(store.read().unwrap().source_revision, revision);
    assert_eq!(bytes(&f, "llm-providers.json"), synced);
    let mut list = models(&f);
    let out = list.output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("provider\t"));
    vault(&f, "delete", None);
    let absent = bytes(&f, "credentials.vault.json");
    assert!(cli(&f, "reconcile").output().unwrap().status.success());
    assert_hints(&f, &original, None);
    assert_eq!(bytes(&f, "credentials.vault.json"), absent);
    assert!(idp.requests.lock().unwrap().is_empty());
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(f.history(), history_before);
}
#[test]
fn unknown_pending_corrupt_wrong_provider_and_unreadable_credentials_are_preserved() {
    for fault in ["pending", "unknown", "corrupt", "provider", "unreadable"] {
        let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        setup(&f, "oauth_chatgpt", &idp, &model);
        let mut token = raw_token(&f);
        match fault {
            "pending" => {
                token["peerModelRefresh"] = json!({"schemaVersion":1,"phase":"in_flight","attemptId":"11111111-1111-4111-8111-111111111111","authMethod":"oauth_chatgpt","createdAt":ms()})
            }
            "unknown" => token["peerModelRefresh"] = json!({"schemaVersion":99}),
            "corrupt" => token = json!("unrecognized-token"),
            "provider" => token["provider"] = json!("google"),
            _ => {}
        }
        vault(&f, "set", Some(&token));
        if fault == "unreadable" {
            std::fs::write(f.root.path().join(".synthetic-vault-key"), [18u8; 32]).unwrap();
        }
        let config = bytes(&f, "llm-providers.json");
        let encrypted = bytes(&f, "credentials.vault.json");
        let out = cli(&f, "reconcile").output().unwrap();
        assert!(!out.status.success(), "{fault}");
        assert!(out.stdout.is_empty());
        assert_eq!(bytes(&f, "llm-providers.json"), config);
        assert_eq!(bytes(&f, "credentials.vault.json"), encrypted);
        assert!(idp.requests.lock().unwrap().is_empty());
        assert!(model.requests.lock().unwrap().is_empty());
    }
}
fn full_config(f: &Fixture) -> Vec<u8> {
    let file = f.root.path().join("llm-providers.json");
    let mut value = get(&file);
    value["padding"] = json!("");
    let size = value.to_string().len();
    value["padding"] = json!("x".repeat(1_048_576 - size));
    let raw = value.to_string();
    assert_eq!(raw.len(), 1_048_576);
    std::fs::write(file, &raw).unwrap();
    raw.into_bytes()
}
#[test]
fn known_login_survives_real_metadata_size_failure_and_reconcile_repairs_without_code_replay() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let before = full_config(&f);
    let login = Login::start(&f);
    login.approve();
    let out = login.finish();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(
        result(&out),
        json!({"status":"credential_updated","channelId":"provider","metadataStatus":"rebuild_required","nextAction":"peer-native models reconcile provider"})
    );
    assert_eq!(bytes(&f, "llm-providers.json"), before);
    assert_eq!(raw_token(&f)["access"], "synthetic-login-access");
    let encrypted = bytes(&f, "credentials.vault.json");
    assert_eq!(state(&f)["status"], "authenticated");
    let out = cli(&f, "reconcile").output().unwrap();
    assert_eq!(out.status.code(), Some(1));
    assert_eq!(result(&out)["metadataStatus"], "rebuild_required");
    let file = f.root.path().join("llm-providers.json");
    let mut config = get(&file);
    config.as_object_mut().unwrap().remove("padding");
    put(&file, &config);
    let original = bytes(&f, "llm-providers.json");
    assert!(cli(&f, "reconcile").output().unwrap().status.success());
    assert_hints(&f, &original, Some(&raw_token(&f)));
    assert_eq!(bytes(&f, "credentials.vault.json"), encrypted);
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert!(model.requests.lock().unwrap().is_empty());
    let before = full_config(&f);
    let out = cli(&f, "logout").output().unwrap();
    assert!(out.status.success());
    assert_eq!(result(&out)["status"], "credential_removed");
    assert_eq!(result(&out)["metadataStatus"], "rebuild_required");
    assert_eq!(state(&f)["status"], "not_logged_in");
    assert_eq!(bytes(&f, "llm-providers.json"), before);
    let mut config = get(&file);
    config.as_object_mut().unwrap().remove("padding");
    put(&file, &config);
    let source = bytes(&f, "llm-providers.json");
    assert!(cli(&f, "reconcile").output().unwrap().status.success());
    assert_hints(&f, &source, None);
}
#[test]
fn known_login_with_displaced_config_owner_reports_unknown_and_preserves_new_credential() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    let source = setup(&f, "oauth_chatgpt", &idp, &model);
    std::fs::write(f.root.path().join(".displace-config-after-compare"), "once").unwrap();
    let login = Login::start(&f);
    login.approve();
    let out = login.finish();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(result(&out)["status"], "credential_updated");
    assert_eq!(result(&out)["metadataStatus"], "commit_unknown");
    assert_eq!(bytes(&f, "llm-providers.json"), source);
    assert_eq!(raw_token(&f)["access"], "synthetic-login-access");
    let encrypted = bytes(&f, "credentials.vault.json");
    assert!(f.root.path().join("llm-providers.json.lock").is_dir());
    // Both owners were created by this fixture; no product process or personal
    // lock is removed. Explicitly settle this simulated ownership incident.
    for path in ["llm-providers.json.lock", "displaced-config-lock"] {
        std::fs::remove_dir(f.root.path().join(path)).unwrap();
    }
    assert_eq!(state(&f)["status"], "authenticated");
    assert!(cli(&f, "reconcile").output().unwrap().status.success());
    assert_hints(&f, &source, Some(&raw_token(&f)));
    assert_eq!(bytes(&f, "credentials.vault.json"), encrypted);
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
}
#[test]
fn automatic_refresh_metadata_failure_does_not_invalidate_fresh_token_or_tool_evidence() {
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![
        stream("openai-responses", "tool"),
        stream("openai-responses", "text"),
    ]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    let source = full_config(&f);
    let out = command(&f, "p").output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(bytes(&f, "llm-providers.json"), source);
    assert_eq!(raw_token(&f)["access"], "synthetic-new-access");
    let history = f.history();
    let tool = history.iter().find(|v| v["segments"].is_array()).unwrap();
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert_eq!(model.requests.lock().unwrap().len(), 2);
}
