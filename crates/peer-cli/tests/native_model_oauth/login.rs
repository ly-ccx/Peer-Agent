mod reconcile;
use super::*;
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::io::BufRead;
fn cli(f: &Fixture, action: &str) -> Command {
    let mut c = Command::new(native_test_binary());
    c.args(["models", action, "provider"])
        .env("PEER_AGENT_HOME", f.root.path())
        .env("HOME", f.root.path())
        .env("PEER_CREDENTIAL_HELPER_PATH", helper())
        .env("PATH", "/nonexistent")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    c
}
fn setup(f: &Fixture, auth: &str, idp: &Idp, model: &Server) -> Vec<u8> {
    configure(f, auth, &idp.url, &model.url, false);
    let path = f.root.path().join("llm-providers.json");
    let mut value = get(&path);
    value["channels"][0]["oauthConfigured"] = json!(false);
    value["channels"][0]["oauthProjectId"] = json!("fixture-project");
    value["models"][0]["oauthConfigured"] = json!(false);
    put(&path, &value);
    put(
        f.root.path().join(".native-model-login-fixture.json"),
        &json!({"authorizationUrl":idp.url.replace("/token","/authorize"),"tokenUrl":idp.url,"callbackPort":0}),
    );
    std::fs::read(path).unwrap()
}
fn body(auth: &str) -> String {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-oauth.json"
    ))
    .unwrap();
    data["loginCases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["authMethod"] == auth)
        .unwrap()["response"]
        .to_string()
}
struct Login {
    child: Option<OwnedChild>,
    reader: Option<thread::JoinHandle<Vec<u8>>>,
    url: url::Url,
}
impl Drop for Login {
    fn drop(&mut self) {
        drop(self.child.take());
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Login {
    fn start(f: &Fixture) -> Self {
        let mut child = OwnedChild(Some(cli(f, "auth").spawn().unwrap()));
        let stdout = child.child().stdout.take().unwrap();
        let (send, recv) = mpsc::channel();
        let reader = thread::spawn(move || {
            let mut reader = std::io::BufReader::new(stdout);
            let mut first = String::new();
            reader.read_line(&mut first).unwrap();
            let _ = send.send(first.clone());
            let mut bytes = first.into_bytes();
            reader.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let first = recv
            .recv_timeout(Duration::from_secs(5))
            .expect("authorization URL must be presented");
        let value: Value = serde_json::from_str(&first).unwrap();
        assert_eq!(value["status"], "authorization_required");
        let url = url::Url::parse(value["authorizationUrl"].as_str().unwrap()).unwrap();
        assert_eq!(
            url.query_pairs()
                .find(|(k, _)| k == "code_challenge_method")
                .unwrap()
                .1,
            "S256"
        );
        Self {
            child: Some(child),
            reader: Some(reader),
            url,
        }
    }
    fn redirect(&self) -> url::Url {
        url::Url::parse(
            &self
                .url
                .query_pairs()
                .find(|(k, _)| k == "redirect_uri")
                .unwrap()
                .1,
        )
        .unwrap()
    }
    fn state(&self) -> String {
        self.url
            .query_pairs()
            .find(|(k, _)| k == "state")
            .unwrap()
            .1
            .into_owned()
    }
    fn raw(&self, request: &str) -> String {
        let redirect = self.redirect();
        let mut socket = TcpStream::connect(("127.0.0.1", redirect.port().unwrap())).unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket
            .set_write_timeout(Some(Duration::from_secs(4)))
            .unwrap();
        socket.write_all(request.as_bytes()).unwrap();
        let mut out = String::new();
        socket.read_to_string(&mut out).unwrap();
        out
    }
    fn callback(&self, query: &str) -> String {
        let u = self.redirect();
        self.raw(&format!(
            "GET {}?{query} HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
            u.path(),
            u.port().unwrap()
        ))
    }
    fn approve(&self) {
        assert!(
            self.callback(&format!(
                "code=synthetic-code-{}&state={}",
                self.state(),
                self.state()
            ))
            .starts_with("HTTP/1.1 200")
        );
    }
    fn finish(mut self) -> Output {
        let mut out = wait_output(self.child.take().unwrap());
        out.stdout = self.reader.take().unwrap().join().unwrap();
        out
    }
    fn signal(&mut self) {
        rustix::process::kill_process(
            rustix::process::Pid::from_raw(self.child.as_mut().unwrap().child().id() as i32)
                .unwrap(),
            rustix::process::Signal::TERM,
        )
        .unwrap();
    }
}
fn state(f: &Fixture) -> Value {
    let output = cli(f, "status").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    serde_json::from_slice(&output.stdout).unwrap()
}

#[test]
fn account_logout_waits_for_the_shared_config_writer_without_deleting_credentials_then_recovers() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    let config = setup(&f, "oauth_chatgpt", &idp, &model);
    let original = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    let lock = peer_store::DirectoryLock::acquire(
        &f.root.path().join("llm-providers.json"),
        Duration::ZERO,
        None,
    )
    .unwrap();
    let output = cli(&f, "logout").output().unwrap();
    assert_eq!(
        output.status.code(),
        Some(3),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stderr).contains("model_config_lock_busy"));
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        original
    );
    assert_eq!(
        std::fs::read(f.root.path().join("llm-providers.json")).unwrap(),
        config
    );
    assert!(idp.requests.lock().unwrap().is_empty());
    lock.release().unwrap();
    assert!(cli(&f, "logout").output().unwrap().status.success());
    assert_eq!(state(&f)["status"], "not_logged_in");
    let login = Login::start(&f);
    login.approve();
    assert!(login.finish().status.success());
    assert_eq!(state(&f)["status"], "authenticated");
}
fn login_redirect_from_output(output: &Output) -> String {
    let text = String::from_utf8_lossy(&output.stdout);
    let value: Value = serde_json::from_str(text.lines().next().unwrap()).unwrap();
    let url = url::Url::parse(value["authorizationUrl"].as_str().unwrap()).unwrap();
    url.query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .unwrap()
        .1
        .into_owned()
}
fn assert_no_secrets(out: &Output, form: &Value) {
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    for secret in [
        "synthetic-login-access",
        "synthetic-login-refresh",
        form["code_verifier"].as_str().unwrap(),
        form["code"].as_str().unwrap(),
    ] {
        assert!(!text.contains(secret));
    }
}
#[test]
fn native_browser_login_then_real_tool_loop_uses_vault_instead_of_stale_configuration_hints() {
    for (auth, wire) in [
        ("oauth_chatgpt", "openai-responses"),
        ("oauth_google", "gemini"),
    ] {
        let idp = Idp::new(body(auth), "200 OK", false, false);
        let model = Server::new(vec![stream(wire, "tool"), stream(wire, "text")]);
        let f = Fixture::new(&model);
        let source = setup(&f, auth, &idp, &model);
        vault(&f, "delete", None);
        assert_eq!(state(&f)["status"], "not_logged_in");
        let login = Login::start(&f);
        let challenge = login
            .url
            .query_pairs()
            .find(|(k, _)| k == "code_challenge")
            .unwrap()
            .1
            .into_owned();
        assert!(
            login
                .callback("state=forged&code=forged")
                .starts_with("HTTP/1.1 400")
        );
        assert!(idp.requests.lock().unwrap().is_empty());
        login.approve();
        let out = login.finish();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let forms = idp.requests.lock().unwrap();
        assert_eq!(forms.len(), 1);
        assert_eq!(forms[0]["grant_type"], "authorization_code");
        assert_eq!(forms[0]["redirect_uri"], login_redirect_from_output(&out));
        let verifier = forms[0]["code_verifier"].as_str().unwrap();
        assert_eq!(verifier.len(), 43);
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())),
            challenge
        );
        assert_no_secrets(&out, &forms[0]);
        drop(forms);
        assert_eq!(state(&f)["status"], "authenticated");
        assert_eq!(raw_token(&f)["access"], "synthetic-login-access");
        let out = command(&f, "p").output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(model.requests.lock().unwrap().len(), 2);
        let history = f.history();
        let tool = history.iter().find(|v| v["segments"].is_array()).unwrap();
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert!(tool["segments"][0]["result"]["evidence"].is_object());
        assert_hints(&f, &source, Some(&raw_token(&f)));
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
    }
}
#[test]
fn explicit_reauthorization_replaces_unknown_refresh_state_and_logout_is_idempotent() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    let source = setup(&f, "oauth_chatgpt", &idp, &model);
    let mut old = raw_token(&f);
    old["peerModelRefresh"] = json!({"schemaVersion":99});
    vault(&f, "set", Some(&old));
    assert_eq!(state(&f)["status"], "recovery_required");
    let login = Login::start(&f);
    login.approve();
    assert!(login.finish().status.success());
    assert!(raw_token(&f).get("peerModelRefresh").is_none());
    for _ in 0..2 {
        assert!(cli(&f, "logout").output().unwrap().status.success());
        assert_eq!(state(&f)["status"], "not_logged_in");
    }
    assert!(vault(&f, "get-snapshot", None)["secret"].is_null());
    assert!(model.requests.lock().unwrap().is_empty());
    assert_hints(&f, &source, None);
}
#[test]
fn late_browser_exchange_cannot_overwrite_new_login_logout_or_changed_channel() {
    for action in ["login", "logout", "config"] {
        let mut idp = Idp::new(body("oauth_chatgpt"), "200 OK", true, false);
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        setup(&f, "oauth_chatgpt", &idp, &model);
        let login = Login::start(&f);
        peer_store::ModelConfigStore::new(f.root.path())
            .begin(Duration::ZERO, None)
            .unwrap()
            .finish()
            .unwrap();
        login.approve();
        idp.wait_request();
        peer_store::ModelConfigStore::new(f.root.path())
            .begin(Duration::ZERO, None)
            .unwrap()
            .finish()
            .unwrap();
        if action == "login" {
            vault(
                &f,
                "set",
                Some(
                    &json!({"access":"newer-login","refresh":"newer-refresh","expires":ms()+3600000,"accountId":"new-account"}),
                ),
            );
        }
        if action == "logout" {
            vault(&f, "delete", None);
        }
        if action == "config" {
            let path = f.root.path().join("llm-providers.json");
            let mut value = get(&path);
            value["channels"][0]["enabled"] = json!(false);
            put(path, &value);
        }
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        idp.gate.take().unwrap().send(()).unwrap();
        assert!(!login.finish().status.success());
        assert_eq!(
            std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
            before
        );
        assert!(model.requests.lock().unwrap().is_empty());
        let next = Login::start(&f);
        next.approve();
        assert!(next.finish().status.success());
        assert_eq!(state(&f)["status"], "authenticated");
    }
}

#[test]
fn cancellation_after_browser_callback_while_a_config_writer_owns_the_lock_has_no_exchange_and_later_login_works()
 {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let mut login = Login::start(&f);
    let guard = peer_store::ModelConfigStore::new(f.root.path())
        .begin(Duration::ZERO, None)
        .unwrap();
    let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    login.approve();
    login.signal();
    let result = login.finish();
    assert_eq!(
        result.status.code(),
        Some(4),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert!(idp.requests.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        before
    );
    guard.finish().unwrap();
    let login = Login::start(&f);
    login.approve();
    assert!(login.finish().status.success());
    assert_eq!(state(&f)["status"], "authenticated");
}

#[test]
fn refresh_config_commit_wait_preserves_pending_then_explicit_native_auth_and_new_task_recover() {
    let mut idp = Idp::new(refreshed(), "200 OK", true, false);
    let model = Server::new(vec![stream("openai-responses", "text")]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let child = OwnedChild(Some(command(&f, "p").spawn().unwrap()));
    idp.wait_request();
    let guard = peer_store::ModelConfigStore::new(f.root.path())
        .begin(Duration::ZERO, None)
        .unwrap();
    let pending = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    idp.gate.take().unwrap().send(()).unwrap();
    let result = wait_output(child);
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("model_config_lock_busy"));
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        pending
    );
    guard.finish().unwrap();
    assert_eq!(state(&f)["status"], "recovery_required");
    let login = Login::start(&f);
    login.approve();
    assert!(login.finish().status.success());
    seed_next(&f);
    let result = command(&f, "next").output().unwrap();
    assert_eq!(
        result.status.code(),
        Some(0),
        "{}",
        String::from_utf8_lossy(&result.stderr)
    );
    assert_eq!(idp.requests.lock().unwrap().len(), 2);
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}
#[test]
fn denial_signal_timeout_and_port_conflict_preserve_credentials_and_release_callback_owner() {
    for action in ["deny", "cancel", "timeout", "occupied"] {
        let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        setup(&f, "oauth_chatgpt", &idp, &model);
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        if action == "occupied" {
            let owner = TcpListener::bind("127.0.0.1:0").unwrap();
            let path = f.root.path().join(".native-model-login-fixture.json");
            let mut value = get(&path);
            value["callbackPort"] = json!(owner.local_addr().unwrap().port());
            put(path, &value);
            let out = cli(&f, "auth").output().unwrap();
            assert!(!out.status.success());
            assert!(out.stdout.is_empty());
            assert!(
                String::from_utf8_lossy(&out.stderr).contains("model_oauth_callback_unavailable")
            );
        } else {
            if action == "timeout" {
                let path = f.root.path().join(".native-model-login-fixture.json");
                let mut value = get(&path);
                value["waitMs"] = json!(200);
                put(path, &value);
            }
            let mut login = Login::start(&f);
            let port = login.redirect().port().unwrap();
            if action == "deny" {
                assert!(
                    login
                        .callback(&format!("error=access_denied&state={}", login.state()))
                        .starts_with("HTTP/1.1 200")
                );
            }
            if action == "cancel" {
                login.signal();
            }
            let out = login.finish();
            assert!(!out.status.success());
            if action == "cancel" {
                assert_eq!(out.status.code(), Some(4));
            }
            assert!(TcpStream::connect(("127.0.0.1", port)).is_err());
        }
        assert_eq!(
            std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
            before
        );
        assert!(idp.requests.lock().unwrap().is_empty());
    }
}
#[test]
fn callback_confusion_is_bounded_without_exchanging_any_code() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let before = raw_token(&f);
    let login = Login::start(&f);
    let u = login.redirect();
    let state = login.state();
    for _ in 0..4 {
        for request in [
            format!(
                "GET {}?state={state}&state={state}&code=one HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
                u.path(),
                u.port().unwrap()
            ),
            format!(
                "GET {}?state={state}&code=one&code=two HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
                u.path(),
                u.port().unwrap()
            ),
            format!(
                "GET {}?state={state}&code=one HTTP/1.1\r\nHost: attacker.invalid\r\n\r\n",
                u.path()
            ),
            format!(
                "POST {}?state={state}&code=one HTTP/1.1\r\nHost: localhost:{}\r\n\r\n",
                u.path(),
                u.port().unwrap()
            ),
        ] {
            assert!(login.raw(&request).starts_with("HTTP/1.1 400"));
        }
    }
    let out = login.finish();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("model_oauth_callback_limit"));
    assert!(idp.requests.lock().unwrap().is_empty());
    assert_eq!(raw_token(&f), before);
}
#[test]
fn rejected_redirected_or_invalid_login_tokens_never_commit_or_leak_credentials() {
    for (response, status) in [
        ("{broken".into(), "200 OK"),
        (body("oauth_chatgpt"), "302 Found"),
        ("x".repeat(65537), "200 OK"),
        (
            json!({"access_token":"secret","expires_in":0}).to_string(),
            "200 OK",
        ),
        (
            json!({"access_token":"secret","token_type":"MAC"}).to_string(),
            "200 OK",
        ),
        (
            json!({"access_token":"secret","expires_in":3600}).to_string(),
            "200 OK",
        ),
    ] {
        let model = Server::new(vec![]);
        let idp = Idp::with_headers(
            response,
            status,
            false,
            false,
            &format!("Location: {}/redirected\r\n", model.url),
        );
        let f = Fixture::new(&model);
        setup(&f, "oauth_chatgpt", &idp, &model);
        let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
        let login = Login::start(&f);
        login.approve();
        let out = login.finish();
        assert!(!out.status.success());
        assert_eq!(
            std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
            before
        );
        assert!(model.requests.lock().unwrap().is_empty());
        assert_eq!(idp.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn a_new_credential_while_waiting_for_the_browser_blocks_before_code_exchange() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let login = Login::start(&f);
    vault(
        &f,
        "set",
        Some(
            &json!({"access":"newer","refresh":"newer-refresh","expires":ms()+3600000,"accountId":"newer-account"}),
        ),
    );
    let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    login.approve();
    assert!(!login.finish().status.success());
    assert!(idp.requests.lock().unwrap().is_empty());
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        before
    );
}

#[test]
fn cancellation_during_login_exchange_closes_socket_and_preserves_original_vault() {
    let idp = Idp::new("{\"access_token\":".into(), "200 OK", false, true);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let before = std::fs::read(f.root.path().join("credentials.vault.json")).unwrap();
    let mut login = Login::start(&f);
    login.approve();
    idp.wait_request();
    login.signal();
    let out = login.finish();
    assert_eq!(out.status.code(), Some(4));
    let deadline = Instant::now() + Duration::from_secs(3);
    while !idp.closed.load(std::sync::atomic::Ordering::Acquire) {
        assert!(Instant::now() < deadline, "login socket not closed");
        thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(
        std::fs::read(f.root.path().join("credentials.vault.json")).unwrap(),
        before
    );
    assert!(model.requests.lock().unwrap().is_empty());
}

#[test]
fn old_helper_requires_upgrade_before_login_url_but_can_report_fresh_credential_status() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let old = Path::new(env!("CARGO_BIN_EXE_mcp-helper-test-fixture"));
    std::fs::write(
        f.root.path().join("synthetic-secret.txt"),
        json!({"access":"legacy","expires":ms()+3600000,"accountId":"account"}).to_string(),
    )
    .unwrap();
    let out = cli(&f, "auth")
        .env("PEER_CREDENTIAL_HELPER_PATH", old)
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(out.stdout.is_empty());
    assert!(String::from_utf8_lossy(&out.stderr).contains("model_oauth_helper_upgrade_required"));
    let out = cli(&f, "status")
        .env("PEER_CREDENTIAL_HELPER_PATH", old)
        .output()
        .unwrap();
    assert!(out.status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&out.stdout).unwrap()["status"],
        "authenticated"
    );
    assert!(idp.requests.lock().unwrap().is_empty());
}

#[test]
fn cancellation_during_helper_negotiation_reports_cancel_and_reaps_the_owned_helper() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    std::fs::write(f.root.path().join("mode"), "sleep").unwrap();
    let old = Path::new(env!("CARGO_BIN_EXE_mcp-helper-test-fixture"));
    let mut child = OwnedChild(Some(
        cli(&f, "auth")
            .env("PEER_CREDENTIAL_HELPER_PATH", old)
            .spawn()
            .unwrap(),
    ));
    let began = Instant::now();
    let helper_pid = loop {
        let pid = std::fs::read_dir(f.root.path())
            .unwrap()
            .filter_map(|entry| {
                entry
                    .unwrap()
                    .file_name()
                    .to_str()
                    .and_then(|s| s.strip_prefix("pid-"))
                    .and_then(|s| s.parse::<u32>().ok())
            })
            .next();
        if let Some(pid) = pid {
            break pid;
        }
        assert!(began.elapsed() < Duration::from_secs(5));
        thread::sleep(Duration::from_millis(5));
    };
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let out = wait_output(child);
    assert_eq!(out.status.code(), Some(4));
    assert!(out.stdout.is_empty());
    assert!(
        !Command::new("/bin/kill")
            .args(["-0", &helper_pid.to_string()])
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success()
    );
    assert!(idp.requests.lock().unwrap().is_empty());
}
#[test]
fn lost_login_commit_receipt_is_reconciled_by_status_without_code_replay() {
    let idp = Idp::new(body("oauth_chatgpt"), "200 OK", false, false);
    let model = Server::new(vec![]);
    let f = Fixture::new(&model);
    setup(&f, "oauth_chatgpt", &idp, &model);
    let login = Login::start(&f);
    std::fs::write(f.root.path().join(".lose-compare-receipt"), "once").unwrap();
    login.approve();
    let out = login.finish();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("model_oauth_commit_unknown"));
    assert_eq!(state(&f)["status"], "authenticated");
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
}
