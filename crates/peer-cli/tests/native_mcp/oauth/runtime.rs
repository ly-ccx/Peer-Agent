//! Native automatic refresh, original grant continuation and foreign revision fences.
use super::*;
fn fixture_helper() -> std::path::PathBuf {
    env!("CARGO_BIN_EXE_mcp-helper-test-fixture").into()
}
fn configure(f: &Fixture, oauth: &OAuth, expired: bool, helper: &Path) {
    put(
        f.root.path().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":format!("{}/mcp",oauth.base),"auth":{"mode":"oauth2","credentialRef":"mcp-cred:fixture"},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
    );
    let seed = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-cli/mcp-credential-peer.mjs"),
        )
        .arg(f.root.path())
        .arg(helper)
        .args([
            "oauth2",
            if expired { "expired" } else { "put" },
            &format!("{}/issuer", oauth.base),
        ])
        .output()
        .unwrap();
    assert!(
        seed.status.success(),
        "{}",
        String::from_utf8_lossy(&seed.stderr)
    );
}
fn wait_token(oauth: &OAuth) {
    let deadline = Instant::now() + Duration::from_secs(8);
    while oauth.tokens().is_empty() {
        assert!(Instant::now() < deadline, "runtime token POST deadline");
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn expired_oauth_is_refreshed_once_under_the_original_grant_and_context_continues() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("continued"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    configure(&f, &oauth, true, &fixture_helper());
    let output = credentials::run(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        oauth.tokens().len(),
        1,
        "expired token must be refreshed exactly once"
    );
    assert!(oauth.tokens()[0].contains("grant_type=refresh_token"));
    let requests = oauth.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(_, b)| serde_json::from_str::<Value>(b)
                .is_ok_and(|v| v["method"] == "initialize"))
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, b)| b.contains("tools/call"))
            .count(),
        2
    );
    let rows = f.history();
    let tools: Vec<_> = rows.iter().filter(|r| r["segments"].is_array()).collect();
    assert_eq!(tools.len(), 2);
    for row in tools {
        assert_eq!(row["permissionGrants"][0]["granted"], true);
        assert_eq!(row["segments"][0]["result"]["status"], "success");
        assert_eq!(
            row["segments"][0]["result"]["evidence"]["permissionGrantId"],
            row["permissionGrants"][0]["grantId"]
        );
    }
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("oauth-refreshed-secret")
    );
}

#[test]
fn natural_expiry_stops_the_old_connection_then_refreshes_before_the_second_call() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("renewed"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("short-lived");
    configure(&f, &oauth, true, &fixture_helper());
    let output = credentials::run(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(oauth.tokens().len(), 2);
    let requests = oauth.requests.lock().unwrap();
    let methods: Vec<_> = requests
        .iter()
        .filter_map(|(_, b)| serde_json::from_str::<Value>(b).ok())
        .filter_map(|v| v["method"].as_str().map(str::to_owned))
        .collect();
    assert_eq!(methods.iter().filter(|m| *m == "initialize").count(), 2);
    assert_eq!(methods.iter().filter(|m| *m == "tools/call").count(), 2);
    let rows = f.history();
    for row in rows.iter().filter(|r| r["segments"].is_array()) {
        assert_eq!(row["segments"][0]["result"]["status"], "success");
    }
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    let history = serde_json::to_string(&rows).unwrap();
    for secret in [
        "fixture-sensitive-secret",
        "rotated-access-1",
        "rotated-access-2",
        "oauth-new-refresh-secret",
    ] {
        assert!(!history.contains(secret));
    }
}

#[test]
fn denied_expired_oauth_never_reads_helper_or_contacts_the_identity_provider() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("denied"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    configure(&f, &oauth, true, &fixture_helper());
    let helper = std::fs::read(f.root.path().join("last-request.json")).unwrap();
    let metadata = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    PolicyStore::new(f.root.path())
        .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
        .unwrap();
    let output = credentials::run(&f).output().unwrap();
    assert!(output.status.success());
    assert_eq!(
        std::fs::read(f.root.path().join("last-request.json")).unwrap(),
        helper
    );
    assert_eq!(
        std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap(),
        metadata
    );
    assert!(oauth.requests.lock().unwrap().is_empty());
    assert!(
        serde_json::to_string(&f.history())
            .unwrap()
            .contains("permission_denied")
    );
}

#[test]
fn policy_registry_or_foreign_credential_change_during_refresh_cannot_continue_the_grant() {
    for change in ["policy", "registry", "credential"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("stopped"),
        ]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new("stall-token");
        configure(&f, &oauth, true, &fixture_helper());
        let child = OwnedChild(Some(credentials::run(&f).spawn().unwrap()));
        let deadline = Instant::now() + Duration::from_secs(8);
        while oauth.tokens().is_empty() {
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        match change {
            "policy" => {
                PolicyStore::new(f.root.path())
                    .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
                    .unwrap();
            }
            "registry" => {
                let file = f.root.path().join("mcp-registry.json");
                let mut v = get(&file);
                v["foreign"] = json!(true);
                put(file, &v);
            }
            _ => {
                let file = f.root.path().join("mcp-credentials.json");
                let mut v = get(&file);
                v["foreign"] = json!(true);
                put(file, &v);
            }
        }
        oauth.stall.store(false, Ordering::Release);
        let output = child.output();
        assert_eq!(oauth.tokens().len(), 1);
        assert!(
            !oauth
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(_, b)| b.contains("tools/call") || b.contains("initialize"))
        );
        let history = serde_json::to_string(&f.history()).unwrap();
        let code = match change {
            "policy" => "permission_policy_changed",
            "registry" => "mcp_oauth_binding_changed",
            _ => "BACKGROUND_VERSION_CHANGED",
        };
        assert!(
            history.contains(code) || String::from_utf8_lossy(&output.stderr).contains(code),
            "{change}: {history}; {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            f.budget(|_| {})["uncertainDispatches"]
                .as_array()
                .map_or(0, Vec::len),
            0
        );
        if change == "credential" {
            assert_eq!(
                get(f.root.path().join("mcp-credentials.json"))["foreign"],
                true
            );
        }
    }
}

#[test]
fn changed_refresh_scope_keeps_the_intent_and_never_initializes_or_replays_a_tool() {
    for mode in ["scope-expansion", "scope-narrowing"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("blocked"),
        ]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new(mode);
        configure(&f, &oauth, true, &fixture_helper());
        let before = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
        let output = credentials::run(&f).output().unwrap();
        assert!(output.status.success());
        assert_eq!(oauth.tokens().len(), 1);
        assert_refresh_recovery(&f, &before);
        assert!(
            !oauth
                .requests
                .lock()
                .unwrap()
                .iter()
                .any(|(_, b)| b.contains("tools/call") || b.contains("initialize"))
        );
        let history = serde_json::to_string(&f.history()).unwrap();
        assert!(history.contains("mcp_oauth_scope_changed"));
        assert!(history.contains("mcp_oauth_recovery_required"));
    }
}
#[test]
fn automatic_refresh_uses_the_real_encrypted_vault_and_keeps_tool_evidence_and_context_native() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("encrypted automatic refresh"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    let helper =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/examples/vault-fixture");
    std::fs::write(f.root.path().join(".synthetic-vault-key"), [29u8; 32]).unwrap();
    configure(&f, &oauth, true, &helper);
    let mut command = credentials::run(&f);
    command.env("PEER_CREDENTIAL_HELPER_PATH", &helper);
    let output = command.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(oauth.tokens().len(), 1);
    let rows = f.history();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["permissionGrantId"],
        row["permissionGrants"][0]["grantId"]
    );
    let encrypted = std::fs::read_to_string(f.root.path().join("credentials.vault.json")).unwrap();
    for secret in [
        "fixture-refresh-secret",
        "oauth-refreshed-secret",
        "refreshState",
        "previousTokens",
    ] {
        assert!(!encrypted.contains(secret));
    }
    assert!(
        !serde_json::to_string(&rows)
            .unwrap()
            .contains("oauth-refreshed-secret")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn cancellation_preserves_the_refresh_intent_then_explicit_auth_admits_a_later_native_task() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("later task"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("stall-token");
    configure(&f, &oauth, true, &fixture_helper());
    let before = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    let mut child = OwnedChild(Some(credentials::run(&f).spawn().unwrap()));
    wait_token(&oauth);
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = child.output();
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_refresh_recovery(&f, &before);
    assert_eq!(oauth.tokens().len(), 1);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
    let history = f.history();
    assert!(
        serde_json::to_string(&history)
            .unwrap()
            .contains("not_dispatched")
    );
    let blocked = command(&f, "refresh").output().unwrap();
    assert!(String::from_utf8_lossy(&blocked.stderr).contains("mcp_oauth_recovery_required"));
    oauth.stall.store(false, Ordering::Release);
    let pending = pending(&f);
    assert!(callback(&pending.url, &format!("{}/issuer", oauth.base), false).contains("200 OK"));
    assert!(pending.output().status.success());
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let mut next = f.command("exec", "p2");
    next.env("PEER_CREDENTIAL_HELPER_PATH", fixture_helper());
    let output = next.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(f.history(), history);
    assert_eq!(oauth.tokens().len(), 2);
    assert!(oauth.tokens()[1].contains("grant_type=authorization_code"));
    let rows = std::fs::read_to_string(f.root.path().join("conversations/c2.jsonl")).unwrap();
    let row = rows
        .lines()
        .filter_map(|s| serde_json::from_str::<Value>(s).ok())
        .find(|r| r["segments"].is_array())
        .unwrap();
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["permissionGrantId"],
        row["permissionGrants"][0]["grantId"]
    );
}

#[test]
fn hard_exit_does_not_turn_credential_pending_into_a_proof_that_the_tool_was_not_dispatched() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("stall-token");
    configure(&f, &oauth, true, &fixture_helper());
    let before = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    let mut child = OwnedChild(Some(credentials::run(&f).spawn().unwrap()));
    wait_token(&oauth);
    child.child().kill().unwrap();
    let _ = child.output();
    assert_refresh_recovery(&f, &before);
    let metadata = std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap();
    assert!(f.root.path().join("mcp-credentials.json.lock").is_dir());
    f.age_dead_lease();
    let recovered = f.command("recover", "p").output().unwrap();
    assert!(
        recovered.status.success(),
        "{}",
        String::from_utf8_lossy(&recovered.stderr)
    );
    assert!(String::from_utf8_lossy(&recovered.stdout).contains("unfenced_external"));
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        1
    );
    assert_eq!(
        std::fs::read(f.root.path().join("mcp-credentials.json")).unwrap(),
        metadata
    );
    assert_eq!(oauth.tokens().len(), 1);
    assert!(
        !oauth
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|(_, b)| b.contains("tools/call"))
    );
    let blocked = credentials::run(&f).output().unwrap();
    assert!(!blocked.status.success());
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        1
    );
}

#[test]
fn runtime_refresh_through_strict_tls_numeric_connect_keeps_the_model_and_tool_evidence_native() {
    use crate::native_network::{clean_network, tls};
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("proxied automatic refresh"),
    ]);
    let f = Fixture::new(&server);
    let mut oauth = OAuth::new("");
    let front = tls::TlsFront::for_url(&oauth.base, false);
    let proxy = tls::ConnectProxy::new(front.address);
    oauth.public_base(&format!("https://localhost:{}", front.address.port()));
    configure(&f, &oauth, true, &fixture_helper());
    let ca = f.root.path().join("ca.pem");
    std::fs::write(&ca, tls::CA).unwrap();
    let mut run = credentials::run(&f);
    clean_network(&mut run);
    run.env("HTTPS_PROXY", &proxy.url)
        .env("PEER_EXTRA_CA_CERTS", &ca)
        .env(
            "NO_PROXY",
            format!(
                "127.0.0.1:{}",
                url::Url::parse(&server.url).unwrap().port().unwrap()
            ),
        );
    let output = run.output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(oauth.tokens().len(), 1);
    let origin = oauth.requests.lock().unwrap().clone();
    let connects = proxy.headers.lock().unwrap().clone();
    put(
        f.root.path().join("automatic-proxy-trace.json"),
        &json!({"synthetic":true,"origin":origin,"connects":connects}),
    );
    let oauth_requests = origin
        .iter()
        .filter(|(_, b)| !serde_json::from_str::<Value>(b).is_ok_and(|v| v["method"].is_string()))
        .count();
    let numeric = format!("CONNECT {} HTTP/1.1", front.address);
    let configured = format!("CONNECT localhost:{} HTTP/1.1", front.address.port());
    assert_eq!(
        connects.iter().filter(|h| h.starts_with(&numeric)).count(),
        oauth_requests,
        "every OAuth request pins its approved numeric target"
    );
    assert_eq!(
        connects
            .iter()
            .filter(|h| h.starts_with(&configured))
            .count(),
        origin.len() - oauth_requests,
        "ordinary MCP retains its configured hostname route"
    );
    assert!(
        connects
            .iter()
            .all(|h| h.starts_with(&numeric) || h.starts_with(&configured))
    );
    assert!(
        connects
            .iter()
            .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
    );
    assert!(
        oauth
            .requests
            .lock()
            .unwrap()
            .iter()
            .all(|(h, _)| !h.to_lowercase().contains("proxy-authorization"))
    );
    let rows = f.history();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["permissionGrantId"],
        row["permissionGrants"][0]["grantId"]
    );
    for secret in ["synthetic-proxy-secret", "oauth-refreshed-secret"] {
        assert!(!serde_json::to_string(&rows).unwrap().contains(secret));
    }
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}
