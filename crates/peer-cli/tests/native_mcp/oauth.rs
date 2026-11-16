//! Actual native OAuth entry, SDK discovery/PKCE/refresh, Vault and tool loop.
use super::*;
use std::io::{BufRead, BufReader};
use std::sync::atomic::{AtomicBool, Ordering};
struct OAuth {
    base: String,
    origin: Arc<Mutex<String>>,
    stall: Arc<AtomicBool>,
    requests: Arc<Mutex<Vec<(String, String)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn request(socket: &mut TcpStream) -> Option<(String, String)> {
    socket.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    socket
        .set_write_timeout(Some(Duration::from_secs(2)))
        .ok()?;
    let mut bytes = Vec::new();
    let mut byte = [0];
    while !bytes.ends_with(b"\r\n\r\n") {
        if bytes.len() > 32768 {
            return None;
        }
        socket.read_exact(&mut byte).ok()?;
        bytes.push(byte[0]);
    }
    let headers = String::from_utf8(bytes).ok()?;
    let len = headers
        .lines()
        .find_map(|s| {
            s.to_ascii_lowercase()
                .strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    if len > 262144 {
        return None;
    }
    let mut bytes = vec![0; len];
    socket.read_exact(&mut bytes).ok()?;
    Some((headers, String::from_utf8(bytes).ok()?))
}
impl OAuth {
    fn new(mode: &'static str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let captured = requests.clone();
        let stall = Arc::new(AtomicBool::new(mode == "stall-token"));
        let stalled = stall.clone();
        let origin = Arc::new(Mutex::new(base.clone()));
        let published = origin.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                socket.set_nonblocking(false).unwrap();
                let Some((headers, body)) = request(&mut socket) else {
                    continue;
                };
                captured
                    .lock()
                    .unwrap()
                    .push((headers.clone(), body.clone()));
                let origin = published.lock().unwrap().clone();
                let line = headers.lines().next().unwrap();
                let path = line.split(' ').nth(1).unwrap();
                if path == "/mcp" && line.starts_with("GET ") {
                    let _ = write!(
                        socket,
                        "HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Bearer resource_metadata=\"{origin}/oauth-resource\", scope=\"mcp.read\"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    );
                    continue;
                }
                let (status, value) = if path.starts_with("/.well-known/oauth-protected-resource")
                    || path == "/oauth-resource"
                {
                    (
                        "200 OK",
                        json!({"resource":format!("{origin}/mcp"),"authorization_servers":[if mode=="metadata-address" {"https://169.254.169.254/issuer".to_owned()}else{format!("{origin}/issuer")}],"scopes_supported":["mcp.read"]}),
                    )
                } else if path.starts_with("/.well-known/") {
                    (
                        "200 OK",
                        json!({"issuer":format!("{origin}/issuer"),"authorization_endpoint":format!("{origin}/authorize"),"token_endpoint":format!("{origin}/token"),"registration_endpoint":format!("{origin}/register"),"response_types_supported":["code"],"code_challenge_methods_supported":["S256"],"grant_types_supported":["authorization_code","refresh_token"],"token_endpoint_auth_methods_supported":["none","client_secret_post"],"scopes_supported":["mcp.read"]}),
                    )
                } else if path == "/token" {
                    if stalled.load(Ordering::Acquire) {
                        socket
                            .set_read_timeout(Some(Duration::from_millis(50)))
                            .unwrap();
                        let deadline = Instant::now() + Duration::from_secs(10);
                        let mut byte = [0];
                        while stalled.load(Ordering::Acquire)
                            && !stopped.load(Ordering::Acquire)
                            && Instant::now() < deadline
                        {
                            match socket.read(&mut byte) {
                                Ok(0) => break,
                                Err(e)
                                    if matches!(
                                        e.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) => {}
                                _ => break,
                            }
                        }
                        if stalled.load(Ordering::Acquire) {
                            continue;
                        }
                    }
                    if mode == "redirect" {
                        let _ = write!(
                            socket,
                            "HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:9/leak\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                        );
                        continue;
                    }
                    if mode == "oversize" {
                        let body = "x".repeat(1024 * 1024 + 1);
                        let _ = write!(
                            socket,
                            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        continue;
                    }
                    if mode == "reject" {
                        (
                            "400 Bad Request",
                            json!({"error":"invalid_grant","error_description":"oauth-refreshed-secret"}),
                        )
                    } else {
                        (
                            "200 OK",
                            json!({"access_token":"oauth-refreshed-secret","refresh_token":"oauth-new-refresh-secret","token_type":"Bearer","expires_in":3600,"scope":"mcp.read"}),
                        )
                    }
                } else if path == "/register" {
                    let registration: Value = serde_json::from_str(&body).unwrap();
                    (
                        "201 Created",
                        json!({"client_id":"registered-client","client_secret":"registered-client-secret","redirect_uris":registration["redirect_uris"]}),
                    )
                } else if path == "/mcp" && line.starts_with("POST ") {
                    let v: Value = serde_json::from_str(&body).unwrap();
                    if v["id"].is_null() {
                        ("202 Accepted", Value::Null)
                    } else {
                        (
                            "200 OK",
                            json!({"jsonrpc":"2.0","id":v["id"],"result":if v["method"]=="initialize"{json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"oauth-fixture","version":"1"}})}else{json!({"content":[{"type":"text","text":"oauth-refreshed-secret"}]})}}),
                        )
                    }
                } else {
                    ("404 Not Found", json!({}))
                };
                let body = if value.is_null() {
                    String::new()
                } else {
                    value.to_string()
                };
                let _ = write!(
                    socket,
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        Self {
            base,
            origin,
            stall,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn public_base(&mut self, base: &str) {
        self.base = base.to_owned();
        *self.origin.lock().unwrap() = self.base.clone();
    }
    fn tokens(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(h, _)| h.starts_with("POST /token "))
            .map(|(_, b)| b.clone())
            .collect()
    }
}
impl Drop for OAuth {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !thread::panicking() {
                assert!(result.is_ok());
            }
        }
    }
}
fn setup(f: &Fixture, oauth: &OAuth) {
    credentials::setup(f, "oauth2");
    put(
        f.root.path().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{"id":"s","transport":"streamable_http","url":format!("{}/mcp",oauth.base),"auth":{"mode":"oauth2","credentialRef":"mcp-cred:fixture"},"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}]}),
    );
}
fn command(f: &Fixture, action: &str) -> Command {
    let mut c = Command::new(native_test_binary());
    c.args(["mcp", action, "s"])
        .env("PEER_AGENT_HOME", f.root.path())
        .env("HOME", f.root.path())
        .env("PATH", "/nonexistent")
        .env(
            "PEER_CREDENTIAL_HELPER_PATH",
            env!("CARGO_BIN_EXE_mcp-helper-test-fixture"),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}
fn assert_refresh_recovery(f: &Fixture, before: &[u8]) {
    use sha2::{Digest, Sha256};
    let before: Value = serde_json::from_slice(before).unwrap();
    let metadata = get(f.root.path().join("mcp-credentials.json"));
    let old = before["credentials"][0]["vaultKey"].as_str().unwrap();
    let new = metadata["credentials"][0]["vaultKey"].as_str().unwrap();
    assert_ne!(new, old);
    assert_eq!(
        metadata["credentials"][0]["oauth"]["tokenStatus"],
        "recovery_required"
    );
    let slot = |key: &str| {
        f.root.path().join(format!(
            "synthetic-{:x}.txt",
            Sha256::digest(key.as_bytes())
        ))
    };
    let original = get(slot(old));
    let pending = get(slot(new));
    assert_eq!(
        pending["refreshState"]["previousTokens"],
        original["oauth"]["tokens"]
    );
    assert_eq!(pending["refreshState"]["schemaVersion"], 1);
    assert!(pending["oauth"].get("tokens").is_none());
    for secret in [
        "fixture-sensitive-secret",
        "fixture-refresh-secret",
        "oauth-refreshed-secret",
    ] {
        assert!(!metadata.to_string().contains(secret));
    }
    let read = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-cli/mcp-credential-peer.mjs"),
        )
        .arg(f.root.path())
        .arg(env!("CARGO_BIN_EXE_mcp-helper-test-fixture"))
        .args(["oauth2", "read"])
        .output()
        .unwrap();
    assert!(!read.status.success());
    assert!(String::from_utf8_lossy(&read.stderr).contains("mcp_oauth_recovery_required"));
}
struct Pending {
    child: Option<OwnedChild>,
    reader: Option<thread::JoinHandle<()>>,
    url: url::Url,
}
impl Drop for Pending {
    fn drop(&mut self) {
        drop(self.child.take());
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Pending {
    fn output(mut self) -> Output {
        let output = self.child.take().unwrap().output();
        self.reader.take().unwrap().join().unwrap();
        output
    }
}
fn pending(f: &Fixture) -> Pending {
    pending_command(command(f, "auth"))
}
fn pending_command(mut command: Command) -> Pending {
    let mut child = command.spawn().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = std::sync::mpsc::channel();
    let reader = thread::spawn(move || {
        let mut line = String::new();
        let mut reader = BufReader::new(stdout);
        let _ = reader.read_line(&mut line);
        let _ = tx.send(line);
        let _ = std::io::copy(&mut reader, &mut std::io::sink());
    });
    let mut owned = Pending {
        child: Some(OwnedChild(Some(child))),
        reader: Some(reader),
        url: url::Url::parse("http://127.0.0.1").unwrap(),
    };
    let line = rx
        .recv_timeout(Duration::from_secs(10))
        .expect("authorization URL deadline");
    if line.is_empty() {
        let output = owned.child.take().unwrap().output();
        panic!(
            "authorization entry failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let pending: Value = serde_json::from_str(&line).expect("authorization_required JSON");
    assert_eq!(pending["status"], "authorization_required");
    owned.url = url::Url::parse(pending["authorizationUrl"].as_str().unwrap()).unwrap();
    owned
}
fn callback(authorization: &url::Url, issuer: &str, wrong_state: bool) -> String {
    let pairs = authorization
        .query_pairs()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(
        pairs.get("code_challenge_method").map(|v| v.as_ref()),
        Some("S256")
    );
    assert!(pairs["code_challenge"].len() >= 43);
    let mut redirect = url::Url::parse(&pairs["redirect_uri"]).unwrap();
    redirect
        .query_pairs_mut()
        .append_pair(
            "state",
            if wrong_state {
                "wrong-state"
            } else {
                &pairs["state"]
            },
        )
        .append_pair("code", "synthetic-code")
        .append_pair("iss", issuer);
    let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        socket,
        "GET {}?{} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n",
        redirect.path(),
        redirect.query().unwrap(),
        redirect.port().unwrap()
    )
    .unwrap();
    let mut reply = String::new();
    socket.read_to_string(&mut reply).unwrap();
    reply
}
#[test]
fn native_oauth_login_pkce_vault_cold_read_and_authorized_tool_loop() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("done"),
    ]);
    let f = Fixture::new(&server);
    let oauth = OAuth::new("");
    setup(&f, &oauth);
    let child = pending(&f);
    let url = child.url.clone();
    assert!(
        url.query_pairs()
            .any(|(k, v)| k == "scope" && v == "mcp.read")
    );
    let discovered = oauth.requests.lock().unwrap().clone();
    assert!(discovered[0].0.starts_with("GET /mcp "));
    assert!(discovered[1].0.starts_with("GET /oauth-resource "));
    assert!(callback(&url, &format!("{}/issuer", oauth.base), true).contains("400 Bad Request"));
    assert!(oauth.tokens().is_empty());
    assert!(callback(&url, &format!("{}/issuer", oauth.base), false).contains("200 OK"));
    let output = child.output();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let tokens = oauth.tokens();
    assert_eq!(tokens.len(), 1);
    assert!(tokens[0].contains("grant_type=authorization_code"));
    assert!(tokens[0].contains("code_verifier="));
    assert!(tokens[0].contains("resource="));
    let output = credentials::run(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(oauth.requests.lock().unwrap().iter().any(|(h, b)| {
        h.to_ascii_lowercase()
            .contains("authorization: bearer oauth-refreshed-secret")
            && b.contains("tools/call")
    }));
    let metadata = std::fs::read_to_string(f.root.path().join("mcp-credentials.json")).unwrap();
    let history = serde_json::to_string(&f.history()).unwrap();
    for secret in [
        "oauth-refreshed-secret",
        "oauth-new-refresh-secret",
        "synthetic-code",
    ] {
        assert!(!metadata.contains(secret));
        assert!(!history.contains(secret));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(secret));
    }
    assert!(history.contains("[REDACTED]"));
    let read = Command::new("node")
        .arg(
            Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../scripts/native-cli/mcp-credential-peer.mjs"),
        )
        .arg(f.root.path())
        .arg(env!("CARGO_BIN_EXE_mcp-helper-test-fixture"))
        .args(["oauth2", "read"])
        .output()
        .unwrap();
    assert!(read.status.success());
    let read: Value = serde_json::from_slice(&read.stdout).unwrap();
    assert_eq!(read["oauth"]["tokenStatus"], "available");
}
#[test]
fn explicit_native_refresh_rotates_vault_and_rejection_preserves_a_recovery_intent() {
    for mode in ["", "reject", "redirect", "oversize"] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new(mode);
        setup(&f, &oauth);
        let file = f.root.path().join("mcp-credentials.json");
        let before = std::fs::read(&file).unwrap();
        let output = command(&f, "refresh").output().unwrap();
        assert_eq!(
            output.status.success(),
            mode.is_empty(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let tokens = oauth.tokens();
        assert_eq!(tokens.len(), 1);
        assert!(tokens[0].contains("grant_type=refresh_token"));
        assert!(tokens[0].contains("fixture-refresh-secret"));
        if !mode.is_empty() {
            assert_refresh_recovery(&f, &before);
        } else {
            assert_ne!(std::fs::read(&file).unwrap(), before);
        }
        assert!(!String::from_utf8_lossy(&output.stderr).contains("oauth-refreshed-secret"));
        assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
    }
}

#[test]
fn native_dcr_is_encrypted_and_binding_change_during_login_prevents_publication() {
    for changed in [false, true] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new("");
        setup(&f, &oauth);
        credentials::setup_with(&f, "oauth2", "dcr");
        let file = f.root.path().join("mcp-credentials.json");
        let before = std::fs::read(&file).unwrap();
        let child = pending(&f);
        let url = child.url.clone();
        assert_eq!(
            oauth
                .requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(h, _)| h.starts_with("POST /register "))
                .count(),
            1
        );
        if changed {
            let registry = f.root.path().join("mcp-registry.json");
            let mut value = get(&registry);
            value["servers"][0]["name"] = json!("changed");
            put(registry, &value);
        }
        callback(&url, &format!("{}/issuer", oauth.base), false);
        let output = child.output();
        assert_eq!(
            output.status.success(),
            !changed,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let after = std::fs::read(&file).unwrap();
        if changed {
            assert_eq!(after, before);
        } else {
            assert_ne!(after, before);
            let text = String::from_utf8(after).unwrap();
            assert!(!text.contains("registered-client-secret"));
            assert!(text.contains("registered-client"));
        }
        assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
    }
}
#[test]
fn wrong_issuer_and_signal_cancellation_preserve_credentials_and_close_callback() {
    for mode in ["issuer", "cancel"] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        let oauth = OAuth::new("");
        setup(&f, &oauth);
        let file = f.root.path().join("mcp-credentials.json");
        let before = std::fs::read(&file).unwrap();
        let child = pending(&f);
        let url = child.url.clone();
        let redirect = url
            .query_pairs()
            .find(|(k, _)| k == "redirect_uri")
            .unwrap()
            .1
            .into_owned();
        let port = url::Url::parse(&redirect).unwrap().port().unwrap();
        if mode == "issuer" {
            callback(&url, "https://wrong.example/issuer", false);
        } else {
            let id = child.child.as_ref().unwrap().0.as_ref().unwrap().id();
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(id as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        }
        let output = child.output();
        assert_eq!(
            output.status.code(),
            Some(if mode == "cancel" { 4 } else { 3 }),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read(file).unwrap(), before);
        assert!(oauth.tokens().is_empty());
        assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
    }
}

mod network;

mod refresh;
