//! Child module of the real Host suite; synthetic IdP and encrypted Vault only.
use super::*;
use std::sync::mpsc;
mod grok;
mod login;
mod network;

// Exact full-document comparison: only the accepted three hint projections
// may change. Every other root/channel/model field stays present and equal.
fn assert_hints(f: &Fixture, source: &[u8], token: Option<&Value>) {
    let mut expected: Value = serde_json::from_slice(source).unwrap();
    let channel = expected["channels"][0].as_object_mut().unwrap();
    channel.insert("oauthConfigured".into(), json!(token.is_some()));
    for key in ["oauthExpires", "oauthAccountId"] {
        channel.remove(key);
    }
    if let Some(token) = token {
        channel.insert("oauthExpires".into(), token["expires"].clone());
        if let Some(account) = token.get("accountId") {
            channel.insert("oauthAccountId".into(), account.clone());
        }
    }
    for model in expected["models"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .filter(|v| v["groupId"] == "provider")
    {
        for key in ["oauthConfigured", "oauthExpires", "oauthAccountId"] {
            model.as_object_mut().unwrap().remove(key);
        }
    }
    assert_eq!(get(f.root.path().join("llm-providers.json")), expected);
}

#[test]
fn unknown_refresh_intent_is_preserved_and_blocks_before_any_remote_request() {
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, true);
    let mut token = raw_token(&f);
    token["peerModelRefresh"] = json!({"schemaVersion":99,"futureOpaque":{"preserved":true}});
    vault(&f, "set", Some(&token));
    let bytes = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    let output = command(&f, "p").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_oauth_refresh_state_invalid"));
    assert!(idp.requests.lock().unwrap().is_empty());
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        bytes
    );
    assert_eq!(raw_token(&f), token);
}
fn helper() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/examples/vault-fixture")
}
fn vault(f: &Fixture, action: &str, value: Option<&Value>) -> Value {
    let mut request = json!({"version":1,"action":action,"key":"model/provider/oauth-tokens"});
    if let Some(value) = value {
        request["secret"] = json!(value.to_string());
    }
    let mut child = OwnedChild(Some(
        Command::new(helper())
            .env("PEER_AGENT_HOME", f.root.path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap(),
    ));
    child
        .child()
        .stdin
        .take()
        .unwrap()
        .write_all(request.to_string().as_bytes())
        .unwrap();
    let output = child.output();
    assert!(output.status.success());
    let response: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(response["ok"], true);
    response["data"].clone()
}
fn command(f: &Fixture, plan: &str) -> Command {
    let mut c = f.command("exec", plan);
    c.env("PEER_CREDENTIAL_HELPER_PATH", helper());
    c
}
fn configure(f: &Fixture, auth: &str, token_url: &str, model_base: &str, fresh: bool) -> Vec<u8> {
    std::fs::write(f.root.path().join(".synthetic-vault-key"), [17u8; 32]).unwrap();
    let google = auth == "oauth_google";
    let mut config = get(f.root.path().join("llm-providers.json"));
    config["channels"][0]["channelId"] = json!(if google { "google-ai" } else { "openai" });
    config["channels"][0]["authMethod"] = json!(auth);
    config["channels"][0]["oauthConfigured"] = json!(true);
    config["channels"][0]["oauthExpires"] = json!(1);
    config["channels"][0]["baseUrl"] = json!("https://must-not-receive-credentials.invalid");
    let model = if google {
        "gemini-2.5-pro"
    } else {
        "gpt-5.6-luna"
    };
    config["models"][0]["model"] = json!(model);
    config["models"][0]["maxOutputTokens"] = json!(16384);
    put(f.root.path().join("llm-providers.json"), &config);
    let mut goal = get(f.root.path().join("goal-plans/p.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!(model);
    }
    put(f.root.path().join("goal-plans/p.json"), &goal);
    put(
        f.root.path().join(".native-model-oauth-fixture.json"),
        &json!({"modelBaseUrl":model_base,"tokenUrl":token_url}),
    );
    let tokens = json!({"access":"synthetic-old-access","refresh":"synthetic-old-refresh","expires":if fresh {ms()+3600000}else{1},"accountId":"fixture-account","projectId":"fixture-project","futureOpaque":{"kept":true}});
    vault(f, "set", Some(&tokens));
    std::fs::read(f.root.path().join("llm-providers.json")).unwrap()
}
fn stream(wire: &str, kind: &str) -> String {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let stream = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["wire"] == wire && v["kind"] == kind)
        .unwrap()["stream"]
        .as_str()
        .unwrap();
    if wire != "gemini" {
        return stream.into();
    }
    stream
        .lines()
        .map(|line| {
            line.strip_prefix("data: ")
                .and_then(|v| serde_json::from_str::<Value>(v).ok())
                .map(|v| format!("data: {}", json!({"response":v})))
                .unwrap_or_else(|| line.into())
        })
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}
struct Idp {
    url: String,
    requests: Arc<Mutex<Vec<Value>>>,
    closed: Arc<std::sync::atomic::AtomicBool>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    gate: Option<mpsc::Sender<()>>,
    thread: Option<thread::JoinHandle<()>>,
}
impl Idp {
    fn new(body: String, status: &str, gated: bool, stall: bool) -> Self {
        Self::with_headers(body, status, gated, stall, "")
    }
    fn with_headers(body: String, status: &str, gated: bool, stall: bool, extra: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/token", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let stopped = stop.clone();
        let closed = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = closed.clone();
        let (release, receiver) = mpsc::channel();
        let mut gate = gated.then_some(receiver);
        let status = status.to_owned();
        let extra = extra.to_owned();
        let thread = thread::spawn(move || {
            while !stopped.load(std::sync::atomic::Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(e) => panic!("fixture accept {e}"),
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let (request, _, headers, _) = read_request(&mut socket);
                assert!(headers.starts_with("POST /token HTTP/"));
                captured.lock().unwrap().push(request);
                if let Some(gate) = gate.take()
                    && gate.recv_timeout(Duration::from_secs(10)).is_err()
                {
                    break;
                }
                let size = if stall { body.len() + 1000 } else { body.len() };
                let _ = write!(
                    socket,
                    "HTTP/1.1 {status}\r\n{extra}Content-Type: application/json\r\nContent-Length: {size}\r\nConnection: close\r\n\r\n{body}"
                );
                if stall {
                    socket
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(20);
                    let mut byte = [0];
                    while Instant::now() < deadline
                        && !stopped.load(std::sync::atomic::Ordering::Acquire)
                    {
                        match socket.read(&mut byte) {
                            Ok(0) => {
                                observed.store(true, std::sync::atomic::Ordering::Release);
                                break;
                            }
                            Err(e)
                                if matches!(
                                    e.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) => {}
                            _ => break,
                        }
                    }
                }
            }
        });
        Self {
            url,
            requests,
            closed,
            stop,
            gate: gated.then_some(release),
            thread: Some(thread),
        }
    }
    fn wait_request(&self) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while self.requests.lock().unwrap().is_empty() {
            assert!(Instant::now() < deadline, "no IdP request");
            thread::sleep(Duration::from_millis(10));
        }
    }
}
impl Drop for Idp {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.gate.take();
        if let Some(thread) = self.thread.take() {
            let result = thread.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn refreshed() -> String {
    json!({"access_token":"synthetic-new-access","refresh_token":"synthetic-new-refresh","expires_in":3600,"token_type":"Bearer","account_id":"fixture-account"}).to_string()
}
fn wait_output(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.child().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "native OAuth process did not settle"
        );
        thread::sleep(Duration::from_millis(10));
    }
    child.output()
}
fn seed_next(f: &Fixture) {
    f.seed("next", "next-c", "next-s", "next-work", "next-epoch");
    let path = f.root.path().join("goal-plans/next.json");
    let mut goal = get(&path);
    goal["delegationOrigin"]["modelSelection"]["worker"]["modelId"] = json!("gpt-5.6-luna");
    put(path, &goal);
}
fn raw_token(f: &Fixture) -> Value {
    serde_json::from_str(vault(f, "get-snapshot", None)["secret"].as_str().unwrap()).unwrap()
}
fn assert_pending_preserves_token(f: &Fixture, original: &Value) {
    let mut pending = raw_token(f);
    let marker = pending
        .as_object_mut()
        .unwrap()
        .remove("peerModelRefresh")
        .expect("persistent refresh intent");
    assert_eq!(marker["schemaVersion"], 1);
    assert_eq!(marker["phase"], "in_flight");
    assert_eq!(marker["authMethod"], "oauth_chatgpt");
    assert_eq!(&pending, original);
}

#[test]
fn pinned_model_oauth_refresh_commits_encrypted_tokens_before_real_tools_and_preserves_opaque_fields()
 {
    for (auth, wire) in [
        ("oauth_chatgpt", "openai-responses"),
        ("oauth_google", "gemini"),
    ] {
        for fresh in [false, true] {
            let idp = Idp::new(refreshed(), "200 OK", false, false);
            let model = Server::new(vec![stream(wire, "tool"), stream(wire, "text")]);
            let f = Fixture::new(&model);
            let source = configure(&f, auth, &idp.url, &model.url, fresh);
            let output = command(&f, "p").output().unwrap();
            assert_eq!(
                output.status.code(),
                Some(0),
                "{auth}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(idp.requests.lock().unwrap().len(), usize::from(!fresh));
            assert_eq!(model.requests.lock().unwrap().len(), 2);
            assert!(model.count_requests.lock().unwrap().is_empty());
            let history = f.history();
            let calls: Vec<_> = history
                .iter()
                .filter(|m| m["segments"].is_array())
                .collect();
            assert_eq!(calls.len(), 1);
            assert_eq!(calls[0]["segments"][0]["result"]["status"], "success");
            assert!(calls[0]["segments"][0]["result"]["evidence"].is_object());
            let saved: Value =
                serde_json::from_str(vault(&f, "get", None)["secret"].as_str().unwrap()).unwrap();
            assert_eq!(saved["futureOpaque"], json!({"kept":true}));
            assert_eq!(
                saved["access"],
                if fresh {
                    "synthetic-old-access"
                } else {
                    "synthetic-new-access"
                }
            );
            assert_eq!(saved["projectId"], "fixture-project");
            if fresh {
                assert_eq!(
                    std::fs::read(f.root.path().join("llm-providers.json")).unwrap(),
                    source
                );
            } else {
                assert_hints(&f, &source, Some(&saved));
            }
            let persisted = serde_json::to_string(&history).unwrap();
            assert!(!persisted.contains("synthetic-new-access"));
            assert!(!persisted.contains("synthetic-new-refresh"));
            assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-new-access"));
            for headers in model.request_headers.lock().unwrap().iter() {
                assert!(headers.contains(&format!(
                    "authorization: Bearer {}",
                    if fresh {
                        "synthetic-old-access"
                    } else {
                        "synthetic-new-access"
                    }
                )));
                assert!(!headers.contains("x-goog-api-key:"));
                if auth == "oauth_chatgpt" {
                    assert!(headers.contains("chatgpt-account-id: fixture-account"));
                }
            }
            if auth == "oauth_google" {
                assert_eq!(
                    model.requests.lock().unwrap()[0]["project"],
                    "fixture-project"
                );
                assert!(model.requests.lock().unwrap()[1]["request"]["contents"].is_array());
            } else {
                assert!(model.requests.lock().unwrap()[0]["max_output_tokens"].is_null());
                assert!(
                    model.request_headers.lock().unwrap()[0].contains("originator: peer-agent")
                );
            }
            let ciphertext =
                std::fs::read_to_string(f.root.path().join("credentials.vault.json")).unwrap();
            assert!(!ciphertext.contains("synthetic-new-access"));
        }
    }
}

#[test]
fn late_refresh_cannot_overwrite_new_login_or_resurrect_logout_and_new_task_is_admitted() {
    for logout in [false, true] {
        let mut idp = Idp::new(refreshed(), "200 OK", true, false);
        let model = Server::new(vec![stream("openai-responses", "text")]);
        let f = Fixture::new(&model);
        configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
        let child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
        idp.wait_request();
        let next = json!({"access":"synthetic-new-login","refresh":"new-login-refresh","expires":ms()+3600000,"accountId":"fixture-account"});
        if logout {
            vault(&f, "delete", None);
        } else {
            vault(&f, "set", Some(&next));
        }
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        idp.gate.take().unwrap().send(()).unwrap();
        let output = wait_output(child);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains("model_credential_changed"));
        assert!(model.requests.lock().unwrap().is_empty());
        assert_eq!(
            std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
            before
        );
        if logout {
            vault(&f, "set", Some(&next));
        }
        f.seed("next", "next-c", "next-s", "next-work", "next-epoch");
        let mut goal = get(f.root.path().join("goal-plans/next.json"));
        goal["delegationOrigin"]["modelSelection"]["worker"]["modelId"] = json!("gpt-5.6-luna");
        put(f.root.path().join("goal-plans/next.json"), &goal);
        let output = command(&f, "next").output().unwrap();
        assert_eq!(
            output.status.code(),
            Some(0),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
        assert_eq!(model.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn cancelling_refresh_closes_socket_and_preserves_original_credentials_without_model_dispatch() {
    let idp = Idp::new("{\"access_token\":".into(), "200 OK", false, true);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    let before = raw_token(&f);
    let mut child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    idp.wait_request();
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let output = wait_output(child);
    assert_eq!(
        output.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let deadline = Instant::now() + Duration::from_secs(3);
    while !idp.closed.load(std::sync::atomic::Ordering::Acquire) {
        assert!(Instant::now() < deadline, "refresh socket not closed");
        thread::sleep(Duration::from_millis(10));
    }
    assert_pending_preserves_token(&f, &before);
    assert!(model.requests.lock().unwrap().is_empty());
    let output = command(&f, "p").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_oauth_refresh_pending"));
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
}

#[test]
fn rejected_redirected_invalid_and_oversized_refreshes_preserve_vault_and_never_dispatch_a_model() {
    for (body, status) in [
        (
            json!({"error":"synthetic-old-refresh"}).to_string(),
            "400 Bad Request",
        ),
        (refreshed(), "302 Found"),
        ("{not-json".into(), "200 OK"),
        (
            json!({"access_token":"new","expires_in":0}).to_string(),
            "200 OK",
        ),
        (
            json!({"access_token":"new","token_type":"MAC"}).to_string(),
            "200 OK",
        ),
        (json!({"expires_in":3600}).to_string(), "200 OK"),
        ("x".repeat(65537), "200 OK"),
    ] {
        let model = Server::new(vec![]);
        let idp = Idp::with_headers(
            body,
            status,
            false,
            false,
            &format!("Location: {}/redirected\r\n", model.url),
        );
        let f = Fixture::new(&model);
        configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
        let before = raw_token(&f);
        let output = command(&f, "p").output().unwrap();
        assert!(!output.status.success());
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
        assert!(model.requests.lock().unwrap().is_empty());
        assert_pending_preserves_token(&f, &before);
        assert!(!String::from_utf8_lossy(&output.stderr).contains("synthetic-old-refresh"));
        let again = command(&f, "p").output().unwrap();
        assert!(!again.status.success());
        assert!(String::from_utf8_lossy(&again.stderr).contains("model_oauth_refresh_pending"));
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn lost_conditional_commit_receipt_stops_then_new_task_uses_the_actual_committed_token_without_refresh_replay()
 {
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![stream("openai-responses", "text")]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    std::fs::write(f.root.path().join(".lose-compare-receipt"), "owned fault").unwrap();
    let output = command(&f, "p").output().unwrap();
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_oauth_commit_unknown"));
    assert!(model.requests.lock().unwrap().is_empty());
    let token: Value =
        serde_json::from_str(vault(&f, "get", None)["secret"].as_str().unwrap()).unwrap();
    assert_eq!(token["access"], "synthetic-new-access");
    seed_next(&f);
    let output = command(&f, "next").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[test]
fn credential_rotation_after_a_real_tool_stops_next_cognition_and_later_task_uses_new_login() {
    let args = serde_json::to_string(
        &json!({"command":"/bin/sh rotation-fixture.sh","timeoutMs":5000}).to_string(),
    )
    .unwrap();
    let old = serde_json::to_string(&json!({"path":"input.txt"}).to_string()).unwrap();
    let tool = stream("openai-responses", "tool")
        .replace("\"name\":\"read_file\"", "\"name\":\"bash\"")
        .replace(&old, &args);
    assert!(tool.contains("\"name\":\"bash\""));
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![tool, stream("openai-responses", "text")]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, true);
    let workspace = f.root.path().join("workspace");
    std::fs::write(workspace.join("rotation-fixture.sh"),
        "printf ready > rotation-shell.ready\nwhile [ ! -f rotation-shell.release ]; do /bin/sleep 0.02; done\n",
    ).unwrap();
    let child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(5);
    while !workspace.join("rotation-shell.ready").is_file() {
        assert!(
            Instant::now() < deadline,
            "No observed Shell child before rotation"
        );
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    vault(
        &f,
        "set",
        Some(
            &json!({"access":"synthetic-new-login","refresh":"new-login-refresh","expires":ms()+3600000,"accountId":"fixture-account","projectId":"fixture-project"}),
        ),
    );
    std::fs::write(workspace.join("rotation-shell.release"), "release").unwrap();
    let deadline = Instant::now() + Duration::from_secs(8);
    while !f
        .history()
        .iter()
        .any(|message| message["segments"][0]["result"]["status"] == "success")
    {
        assert!(
            Instant::now() < deadline,
            "The observed Shell result did not reach Store"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let output = wait_output(child);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_credential_changed"));
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    let history = f.history();
    assert_eq!(
        history.iter().filter(|m| m["segments"].is_array()).count(),
        1
    );
    assert_eq!(history[1]["segments"][0]["result"]["status"], "success");
    assert!(history[1]["segments"][0]["result"]["evidence"].is_object());
    seed_next(&f);
    let output = command(&f, "next").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    assert!(idp.requests.lock().unwrap().is_empty());
    assert!(
        model.request_headers.lock().unwrap()[1]
            .contains("authorization: Bearer synthetic-new-login")
    );
}

#[test]
fn legacy_helper_can_read_fresh_tokens_but_expired_tokens_require_upgrade_before_remote_refresh() {
    for fresh in [true, false] {
        let idp = Idp::new(refreshed(), "200 OK", false, false);
        let model = Server::new(vec![stream("openai-responses", "text")]);
        let f = Fixture::new(&model);
        configure(&f, "oauth_chatgpt", &idp.url, &model.url, fresh);
        let tokens = vault(&f, "get", None)["secret"]
            .as_str()
            .unwrap()
            .to_owned();
        std::fs::write(f.root.path().join("synthetic-secret.txt"), &tokens).unwrap();
        let mut command = f.command("exec", "p");
        command.env(
            "PEER_CREDENTIAL_HELPER_PATH",
            env!("CARGO_BIN_EXE_mcp-helper-test-fixture"),
        );
        let output = command.output().unwrap();
        assert_eq!(
            output.status.success(),
            fresh,
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(idp.requests.lock().unwrap().is_empty());
        assert_eq!(model.requests.lock().unwrap().len(), usize::from(fresh));
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("synthetic-secret.txt")).unwrap(),
            tokens
        );
        if !fresh {
            assert!(
                String::from_utf8_lossy(&output.stderr)
                    .contains("model_oauth_helper_upgrade_required")
            );
        }
    }
}

#[test]
fn metadata_expiry_hint_cannot_replace_actual_token_expiry_or_provider_binding() {
    for mode in ["missing-expiry", "missing-refresh", "wrong-provider"] {
        let idp = Idp::new(refreshed(), "200 OK", false, false);
        let model = Server::new(vec![stream("openai-responses", "text")]);
        let f = Fixture::new(&model);
        configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
        let mut token: Value =
            serde_json::from_str(vault(&f, "get", None)["secret"].as_str().unwrap()).unwrap();
        token.as_object_mut().unwrap().remove("expires");
        if mode == "missing-refresh" {
            token.as_object_mut().unwrap().remove("refresh");
        }
        if mode == "wrong-provider" {
            token["provider"] = json!("google");
        }
        vault(&f, "set", Some(&token));
        let path = f.root.path().join("llm-providers.json");
        let mut config = get(&path);
        config["channels"][0]["oauthExpires"] = json!(ms() + 3600000);
        put(&path, &config);
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        let output = command(&f, "p").output().unwrap();
        assert_eq!(
            output.status.success(),
            mode == "missing-expiry",
            "{mode}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            idp.requests.lock().unwrap().len(),
            usize::from(mode == "missing-expiry")
        );
        assert_eq!(
            model.requests.lock().unwrap().len(),
            usize::from(mode == "missing-expiry")
        );
        if mode != "missing-expiry" {
            assert_eq!(
                std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
                before
            );
        }
    }
}

#[test]
fn channel_disable_during_refresh_stops_commit_and_preserves_the_new_configuration() {
    let mut idp = Idp::new(refreshed(), "200 OK", true, false);
    let model = Server::new(vec![stream("openai-responses", "text")]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    let before = raw_token(&f);
    let child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    idp.wait_request();
    let path = f.root.path().join("llm-providers.json");
    let mut config = get(&path);
    config["channels"][0]["enabled"] = json!(false);
    config["channels"][0]["futureOpaque"] = json!({"preserved":true});
    put(&path, &config);
    let config_bytes = std::fs::read(&path).unwrap();
    idp.gate.take().unwrap().send(()).unwrap();
    let output = wait_output(child);
    assert!(!output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_configuration_changed"));
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(std::fs::read(&path).unwrap(), config_bytes);
    assert_pending_preserves_token(&f, &before);
    // The remote may already have rotated the old refresh token. Explicitly
    // supply a new login, rather than claiming the discarded token still works.
    vault(
        &f,
        "set",
        Some(
            &json!({"access":"reauthorized","refresh":"reauthorized-refresh","expires":ms()+3600000,"accountId":"fixture-account"}),
        ),
    );
    config["channels"][0]["enabled"] = json!(true);
    put(&path, &config);
    seed_next(&f);
    let output = command(&f, "next").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(model.requests.lock().unwrap().len(), 1);
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
}

#[test]
fn hard_exit_retains_refresh_intent_and_explicit_reauthorization_recovers_without_replaying_refresh()
 {
    let mut idp = Idp::new(refreshed(), "200 OK", true, false);
    let model = Server::new(vec![stream("openai-responses", "text")]);
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    let before = raw_token(&f);
    let mut child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    idp.wait_request();
    child.child().kill().unwrap();
    let output = wait_output(child);
    assert!(!output.status.success());
    idp.gate.take().unwrap().send(()).unwrap();
    assert_pending_preserves_token(&f, &before);
    let again = command(&f, "p").output().unwrap();
    assert!(!again.status.success());
    assert!(String::from_utf8_lossy(&again.stderr).contains("model_oauth_refresh_pending"));
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert!(model.requests.lock().unwrap().is_empty());
    f.age_dead_lease();
    let output = f.command("recover", "p").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_pending_preserves_token(&f, &before);
    vault(
        &f,
        "set",
        Some(
            &json!({"access":"reauthorized-after-crash","refresh":"fresh-authorized-refresh","expires":ms()+3600000,"accountId":"fixture-account"}),
        ),
    );
    seed_next(&f);
    let output = command(&f, "next").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}
