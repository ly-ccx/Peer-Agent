//! Durable OAuth refresh ownership and existing-state recovery through the real CLI.
use super::*;

#[test]
fn failed_intent_staging_never_sends_tokens_or_changes_the_current_generation() {
    let server = Server::new(vec![]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    setup(&f, &oauth);
    let file = f.root.path().join("mcp-credentials.json");
    let before = std::fs::read(&file).unwrap();
    std::fs::write(f.root.path().join("mode"), "fail-set").unwrap();
    let output = command(&f, "refresh").output().unwrap();
    assert!(!output.status.success());
    assert!(oauth.tokens().is_empty());
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
    std::fs::remove_file(f.root.path().join("mode")).unwrap();
    let output = command(&f, "refresh").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(oauth.tokens().len(), 1);
}

#[test]
fn unknown_or_corrupt_refresh_intents_survive_both_auth_and_refresh_without_network_effects() {
    use sha2::{Digest, Sha256};
    for state in [
        Value::Null,
        json!({"schemaVersion":99}),
        json!({"schemaVersion":1,"operationId":"bad","previousTokens":{}}),
    ] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("blocked"),
        ]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new("");
        setup(&f, &oauth);
        let metadata = get(f.root.path().join("mcp-credentials.json"));
        let key = metadata["credentials"][0]["vaultKey"].as_str().unwrap();
        let slot = f.root.path().join(format!(
            "synthetic-{:x}.txt",
            Sha256::digest(key.as_bytes())
        ));
        let mut payload = get(&slot);
        payload["refreshState"] = state;
        put(&slot, &payload);
        let before = std::fs::read(&slot).unwrap();
        for action in ["auth", "refresh"] {
            let output = command(&f, action).output().unwrap();
            assert!(!output.status.success());
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("mcp_oauth_recovery_required")
            );
            assert_eq!(std::fs::read(&slot).unwrap(), before);
        }
        let output = credentials::run(&f).output().unwrap();
        assert!(output.status.success());
        assert!(
            serde_json::to_string(&f.history())
                .unwrap()
                .contains("mcp_oauth_recovery_required")
        );
        assert!(oauth.requests.lock().unwrap().is_empty());
        assert_eq!(std::fs::read(&slot).unwrap(), before);
    }
}

#[test]
fn real_encrypted_vault_retains_interrupted_refresh_and_explicit_login_restores_tool_execution() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("encrypted recovery"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("stall-token");
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/examples/vault-fixture");
    std::fs::write(f.root.path().join(".synthetic-vault-key"), [23u8; 32]).unwrap();
    let peer = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../scripts/native-cli/mcp-credential-peer.mjs");
    let seed = Command::new("node")
        .arg(&peer)
        .arg(f.root.path())
        .arg(&helper)
        .args(["oauth2", "put"])
        .output()
        .unwrap();
    assert!(
        seed.status.success(),
        "{}",
        String::from_utf8_lossy(&seed.stderr)
    );
    put(
        f.root.path().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":format!("{}/mcp",oauth.base),"auth":{"mode":"oauth2","credentialRef":"mcp-cred:fixture"},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
    );
    let mut refresh = command(&f, "refresh");
    refresh.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    let mut child = OwnedChild(Some(refresh.spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(8);
    while oauth.tokens().is_empty() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = child.output();
    assert_eq!(output.status.code(), Some(4));
    let metadata = get(f.root.path().join("mcp-credentials.json"));
    assert_eq!(
        metadata["credentials"][0]["oauth"]["tokenStatus"],
        "recovery_required"
    );
    let read = Command::new("node")
        .arg(&peer)
        .arg(f.root.path())
        .arg(&helper)
        .args(["oauth2", "read"])
        .output()
        .unwrap();
    assert!(String::from_utf8_lossy(&read.stderr).contains("mcp_oauth_recovery_required"));
    let mut retry = command(&f, "refresh");
    retry.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    assert!(!retry.output().unwrap().status.success());
    assert_eq!(oauth.tokens().len(), 1);
    let encrypted = std::fs::read_to_string(f.root.path().join("credentials.vault.json")).unwrap();
    for secret in [
        "fixture-sensitive-secret",
        "fixture-refresh-secret",
        "previousTokens",
        "refreshState",
    ] {
        assert!(!encrypted.contains(secret));
    }
    oauth.stall.store(false, Ordering::Release);
    let mut auth = command(&f, "auth");
    auth.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    let pending = pending_command(auth);
    assert!(callback(&pending.url, &format!("{}/issuer", oauth.base), false).contains("200 OK"));
    let output = pending.output();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut run = credentials::run(&f);
    run.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    let output = run.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let rows = f.history();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(row["permissionGrants"][0]["granted"], true);
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["evidenceKind"],
        "local_mcp_tool_call"
    );
    assert_eq!(oauth.tokens().len(), 2);
    assert!(oauth.tokens()[1].contains("grant_type=authorization_code"));
}

#[test]
fn failed_refresh_is_durable_and_cannot_reuse_the_previous_token_on_restart() {
    let server = Server::new(vec![]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("reject");
    setup(&f, &oauth);
    let first = command(&f, "refresh").output().unwrap();
    assert!(!first.status.success());
    assert_eq!(oauth.tokens().len(), 1);
    let requests = oauth.requests.lock().unwrap().len();
    let second = command(&f, "refresh").output().unwrap();
    assert!(!second.status.success());
    assert!(
        String::from_utf8_lossy(&second.stderr).contains("mcp_oauth_recovery_required"),
        "{}",
        String::from_utf8_lossy(&second.stderr)
    );
    assert_eq!(oauth.tokens().len(), 1, "old refresh must not be resent");
    assert_eq!(oauth.requests.lock().unwrap().len(), requests);
    assert!(server.requests.lock().unwrap().is_empty());
}

#[test]
fn refresh_publication_failures_keep_the_intent_until_explicit_relogin_and_real_tool_evidence() {
    for failure in ["registry", "helper", "owner"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("recovered"),
        ]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new("stall-token");
        setup(&f, &oauth);
        let file = f.root.path().join("mcp-credentials.json");
        let before = std::fs::read(&file).unwrap();
        let history = f.history();
        let child = OwnedChild(Some(command(&f, "refresh").spawn().unwrap()));
        let deadline = Instant::now() + Duration::from_secs(8);
        while oauth.tokens().is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        match failure {
            "registry" => {
                let path = f.root.path().join("mcp-registry.json");
                let mut registry = get(&path);
                registry["future"] = json!("new-source");
                put(path, &registry);
            }
            "helper" => std::fs::write(f.root.path().join("mode"), "error").unwrap(),
            _ => {
                let lock = f.root.path().join("mcp-credentials.json.lock");
                std::fs::rename(&lock, f.root.path().join("retired-lock")).unwrap();
                std::fs::create_dir(&lock).unwrap();
            }
        }
        oauth.stall.store(false, Ordering::Release);
        let output = child.output();
        assert!(!output.status.success(), "{failure}");
        assert_eq!(oauth.tokens().len(), 1);
        assert_eq!(f.history(), history);
        if failure == "helper" {
            std::fs::remove_file(f.root.path().join("mode")).unwrap();
        }
        assert_refresh_recovery(&f, &before);
        if failure == "owner" {
            // Isolated fixture maintenance after wait/reap; never steal a live lock.
            let lock = f.root.path().join("mcp-credentials.json.lock");
            assert!(lock.is_dir());
            assert_eq!(std::fs::read_dir(&lock).unwrap().count(), 0);
            std::fs::rename(lock, f.root.path().join("preserved-foreign-lock")).unwrap();
        }
        let output = command(&f, "refresh").output().unwrap();
        assert!(String::from_utf8_lossy(&output.stderr).contains("mcp_oauth_recovery_required"));
        assert_eq!(oauth.tokens().len(), 1);
        let pending = pending(&f);
        assert!(
            callback(&pending.url, &format!("{}/issuer", oauth.base), false).contains("200 OK")
        );
        let output = pending.output();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(oauth.tokens().len(), 2);
        assert!(oauth.tokens()[1].contains("grant_type=authorization_code"));
        let output = credentials::run(&f).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let rows = f.history();
        let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
        assert_eq!(row["permissionGrants"][0]["granted"], true);
        assert_eq!(row["segments"][0]["result"]["status"], "success");
        assert_eq!(
            row["segments"][0]["result"]["evidence"]["evidenceKind"],
            "local_mcp_tool_call"
        );
        assert_eq!(
            oauth
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, b)| b.contains("tools/call"))
                .count(),
            1
        );
    }
}

#[test]
fn hard_killed_refresh_preserves_the_orphan_lock_and_blocks_tools_and_second_refresh() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("blocked"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("stall-token");
    setup(&f, &oauth);
    let before = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    let mut child = OwnedChild(Some(command(&f, "refresh").spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(8);
    while oauth.tokens().is_empty() {
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    child.child().kill().unwrap();
    let output = child.output();
    assert!(!output.status.success());
    assert!(f.root.path().join("mcp-credentials.json.lock").is_dir());
    assert_refresh_recovery(&f, &before);
    let second = command(&f, "refresh").output().unwrap();
    assert!(!second.status.success());
    assert_eq!(oauth.tokens().len(), 1);
    let output = credentials::run(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let history = serde_json::to_string(&f.history()).unwrap();
    assert!(history.contains("mcp_oauth_recovery_required"));
    assert!(
        !oauth
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, b)| b.contains("tools/call"))
    );
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}

#[test]
fn explicit_refresh_cannot_invent_an_unknown_previous_grant_from_new_response_scopes() {
    let server = Server::new(vec![]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    setup(&f, &oauth);
    credentials::setup_with(&f, "oauth2", "unscoped");
    let before = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    let output = command(&f, "refresh").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("mcp_oauth_scope_changed"));
    assert_eq!(oauth.tokens().len(), 1);
    assert_refresh_recovery(&f, &before);
    let again = command(&f, "refresh").output().unwrap();
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("mcp_oauth_recovery_required"));
    assert_eq!(oauth.tokens().len(), 1);
}
