//! Actual production Desktop Store/Helper protocol -> native CLI -> MCP/Evidence.
use super::*;
pub(super) fn setup(f: &Fixture, kind: &str) {
    setup_with(f, kind, "put")
}
pub(super) fn setup_with(f: &Fixture, kind: &str, action: &str) {
    let output = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-cli/mcp-credential-peer.mjs"),
        )
        .arg(f.root.path())
        .arg(env!("CARGO_BIN_EXE_mcp-helper-test-fixture"))
        .arg(kind)
        .arg(action)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains("fixture-sensitive-secret"));
}
pub(super) fn run(f: &Fixture) -> Command {
    let mut command = f.command("exec", "p");
    command.env(
        "PEER_CREDENTIAL_HELPER_PATH",
        env!("CARGO_BIN_EXE_mcp-helper-test-fixture"),
    );
    command
}
fn auth(f: &Fixture, kind: &str) {
    let file = f.root.path().join("mcp-registry.json");
    let mut value = get(&file);
    value["servers"][0]["auth"] = json!({"mode":kind,"credentialRef":"mcp-cred:fixture","envName":"MCP_SECRET","headerName":"X-Fixture-Token"});
    put(file, &value);
}
#[test]
fn desktop_vault_env_is_resolved_only_after_grant_and_echo_is_redacted() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("done"),
    ]);
    let f = Fixture::new(&server);
    setup(&f, "stdio_env");
    registry(&f, "");
    auth(&f, "stdio_env");
    // The token must come from Helper, not the existing fixture env config.
    let file = f.root.path().join("mcp-registry.json");
    let mut value = get(&file);
    value["servers"][0]["env"]
        .as_object_mut()
        .unwrap()
        .remove("MCP_SECRET");
    put(file, &value);
    let output = run(&f).output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(f.root.path().join("mcp.effect").exists());
    let history = serde_json::to_string(&f.history()).unwrap();
    assert!(history.contains("[REDACTED]"));
    assert!(!history.contains("fixture-sensitive-secret"));
    assert!(
        !server
            .requests
            .lock()
            .unwrap()
            .iter()
            .any(|v| v.to_string().contains("fixture-sensitive-secret"))
    );
}
#[test]
fn bearer_header_and_existing_oauth_tokens_cross_the_real_http_transport() {
    for kind in ["http_bearer", "http_header", "oauth2"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("done"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, kind);
        let mcp = http::Http::new(false, false);
        put(
            f.root.path().join("mcp-registry.json"),
            &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":mcp.url,"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
        );
        auth(&f, kind);
        let output = run(&f).output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{kind}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let requests = mcp.requests.lock().unwrap();
        let headers = &requests
            .iter()
            .find(|(_, v)| v["method"] == "tools/call")
            .unwrap()
            .0
            .to_ascii_lowercase();
        assert!(headers.contains(if kind == "http_header" {
            "x-fixture-token: fixture-sensitive-secret"
        } else {
            "authorization: bearer fixture-sensitive-secret"
        }));
        assert!(
            !serde_json::to_string(&f.history())
                .unwrap()
                .contains("fixture-sensitive-secret")
        );
    }
}
#[test]
fn denied_auth_does_not_read_vault_or_start_mcp() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("denied"),
    ]);
    let f = Fixture::new(&server);
    setup(&f, "stdio_env");
    registry(&f, "");
    auth(&f, "stdio_env");
    let before = std::fs::read(f.root.path().join("last-request.json")).unwrap();
    PolicyStore::new(f.root.path())
        .update_existing("w", 1, peer_protocol::LocalAccessLevel::AskBeforeLocal, AT)
        .unwrap();
    let output = run(&f).output().unwrap();
    assert!(output.status.success());
    assert!(!f.root.path().join("mcp.pid").exists());
    assert_eq!(
        std::fs::read(f.root.path().join("last-request.json")).unwrap(),
        before
    );
}
#[test]
fn credential_rotation_during_initialize_invalidates_the_original_grant() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("not dispatched"),
    ]);
    let f = Fixture::new(&server);
    setup(&f, "stdio_env");
    registry(&f, "gate");
    auth(&f, "stdio_env");
    let child = OwnedChild(Some(run(&f).spawn().unwrap()));
    wait_file(&f, "mcp.ready");
    setup(&f, "stdio_env");
    std::fs::write(f.root.path().join("mcp.release"), "go").unwrap();
    let output = child.output();
    assert_eq!(output.status.code(), Some(1));
    assert!(!f.root.path().join("mcp.effect").exists());
    assert!(!requests(&f).iter().any(|r| r["method"] == "tools/call"));
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}
#[test]
fn helper_failure_has_no_mcp_effect_and_legacy_metadata_requires_desktop_migration() {
    for mode in ["error", "legacy"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("blocked"),
        ]);
        let f = Fixture::new(&server);
        setup(&f, "stdio_env");
        registry(&f, "");
        auth(&f, "stdio_env");
        if mode == "legacy" {
            put(
                f.root.path().join("mcp-credentials.json"),
                &json!({"version":1,"credentials":[]}),
            );
        } else {
            std::fs::write(f.root.path().join("mode"), "error").unwrap();
        }
        let output = run(&f).output().unwrap();
        assert!(!f.root.path().join("mcp.pid").exists());
        assert!(!f.root.path().join("mcp.effect").exists());
        if mode == "legacy" {
            assert_eq!(server.requests.lock().unwrap().len(), 0);
            assert!(String::from_utf8_lossy(&output.stderr).contains("migration_required"));
        }
        assert!(!String::from_utf8_lossy(&output.stderr).contains("synthetic-secret"));
    }
}

#[test]
fn helper_cancellation_reaps_the_secret_reader_before_any_mcp_startup() {
    let server = Server::new(vec![reply_tool("mcp__s__read_fact", json!({}))]);
    let f = Fixture::new(&server);
    setup(&f, "stdio_env");
    registry(&f, "");
    auth(&f, "stdio_env");
    std::fs::remove_file(f.root.path().join("last-request.json")).unwrap();
    std::fs::write(f.root.path().join("mode"), "sleep").unwrap();
    let child = OwnedChild(Some(run(&f).spawn().unwrap()));
    wait_file(&f, "last-request.json");
    assert_eq!(
        get(f.root.path().join("last-request.json"))["action"],
        "get"
    );
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.0.as_ref().unwrap().id() as i32).unwrap(),
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
    assert!(!f.root.path().join("mcp.pid").exists());
    for entry in std::fs::read_dir(f.root.path()).unwrap() {
        let name = entry.unwrap().file_name();
        if let Some(pid) = name
            .to_str()
            .and_then(|v| v.strip_prefix("pid-"))
            .and_then(|v| v.parse::<i32>().ok())
        {
            assert_eq!(
                rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid).unwrap()),
                Err(rustix::io::Errno::SRCH)
            );
        }
    }
}

#[test]
fn unbound_expired_oauth_and_mismatched_or_future_vault_envelopes_never_start_mcp() {
    use sha2::{Digest, Sha256};
    for mode in ["expired", "future", "mismatch"] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("blocked"),
        ]);
        let f = Fixture::new(&server);
        if mode == "expired" {
            setup_with(&f, "oauth2", "expired");
            put(
                f.root.path().join("mcp-registry.json"),
                &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":"http://127.0.0.1:9","auth":{"mode":"oauth2","credentialRef":"mcp-cred:fixture"},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
            );
        } else {
            setup(&f, "stdio_env");
            registry(&f, "");
            auth(&f, "stdio_env");
            let metadata = get(f.root.path().join("mcp-credentials.json"));
            let key = metadata["credentials"][0]["vaultKey"].as_str().unwrap();
            let file = f.root.path().join(format!(
                "synthetic-{:x}.txt",
                Sha256::digest(key.as_bytes())
            ));
            let mut payload = get(&file);
            if mode == "future" {
                payload["version"] = json!(2);
            } else {
                payload["credentialRef"] = json!("mcp-cred:someone-else");
            }
            put(file, &payload);
        }
        let output = run(&f).output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!f.root.path().join("mcp.pid").exists());
        let history = serde_json::to_string(&f.history()).unwrap();
        assert!(history.contains(if mode == "expired" {
            "mcp_oauth_authorization_required"
        } else {
            "mcp_credential_invalid"
        }));
        assert_eq!(
            f.budget(|_| {})["uncertainDispatches"]
                .as_array()
                .map_or(0, Vec::len),
            0
        );
    }
}
