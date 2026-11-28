use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
struct Device {
    base: String,
    mode: Arc<Mutex<String>>,
    requests: Arc<Mutex<Vec<(String, Value, u128)>>>,
    stop: Arc<AtomicBool>,
    closed: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Device {
    fn new(mode: &str) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let origin = base.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let ended = stop.clone();
        let closed = Arc::new(AtomicBool::new(false));
        let observed = closed.clone();
        let mode = Arc::new(Mutex::new(mode.to_owned()));
        let selected = mode.clone();
        let requests = Arc::new(Mutex::new(vec![]));
        let rows = requests.clone();
        let worker = thread::spawn(move || {
            let started = Instant::now();
            let mut device_count = 0;
            let mut polls = 0;
            while !ended.load(Ordering::Acquire) {
                let (mut socket, _) = match listener.accept() {
                    Ok(v) => v,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5));
                        continue;
                    }
                    Err(_) => break,
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let (body, _, headers, _) = read_request(&mut socket);
                let path = headers
                    .lines()
                    .next()
                    .unwrap()
                    .split(' ')
                    .nth(1)
                    .unwrap()
                    .to_owned();
                rows.lock().unwrap().push((
                    path.clone(),
                    body.clone(),
                    started.elapsed().as_millis(),
                ));
                let mode = selected.lock().unwrap().clone();
                let (status, value) = match path.as_str() {
                    "/device" => {
                        device_count += 1;
                        polls = 0;
                        (
                            200,
                            if mode == "bad-url" {
                                json!({"device_code":"secret-device","user_code":"CODE","verification_uri":"https://untrusted.invalid/activate","expires_in":900,"interval":1})
                            } else {
                                json!({"device_code":format!("synthetic-device-{device_count}"),"user_code":if mode=="secret-code"{"synthetic-device-1"}else{"TEST-CODE"},"verification_uri":format!("{origin}/verify"),"expires_in":if mode=="expired"{2}else{900},"interval":1})
                            },
                        )
                    }
                    "/token" => {
                        polls += 1;
                        assert_eq!(
                            body["grant_type"],
                            "urn:ietf:params:oauth:grant-type:device_code"
                        );
                        if mode == "denied" {
                            (400, json!({"error":"access_denied"}))
                        } else if mode == "pending" || mode == "expired" {
                            (400, json!({"error":"authorization_pending"}))
                        } else if mode == "slow" && polls == 1 {
                            (400, json!({"error":"slow_down"}))
                        } else {
                            (
                                200,
                                json!({"access_token":"synthetic-device-access","refresh_token":"synthetic-device-refresh","expires_in":3600,"scope":if mode=="no-scope"{"openid"}else{"api:access grok-cli:access"}}),
                            )
                        }
                    }
                    "/userinfo" => {
                        assert!(
                            headers
                                .to_ascii_lowercase()
                                .contains("authorization: bearer synthetic-device-access")
                        );
                        (
                            200,
                            json!({"email":"fixture@grok.invalid","sub":"fixture-grok-user"}),
                        )
                    }
                    _ => (404, json!({})),
                };
                let data = value.to_string();
                let length = if mode == "stall" && path == "/token" {
                    data.len() + 1000
                } else {
                    data.len()
                };
                let _ = write!(
                    socket,
                    "HTTP/1.1 {status} Fixture\r\nContent-Type: application/json\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n{data}"
                );
                if mode == "stall" && path == "/token" {
                    socket
                        .set_read_timeout(Some(Duration::from_millis(50)))
                        .unwrap();
                    let deadline = Instant::now() + Duration::from_secs(10);
                    let mut byte = [0];
                    while !ended.load(Ordering::Acquire) && Instant::now() < deadline {
                        match socket.read(&mut byte) {
                            Ok(0) => {
                                observed.store(true, Ordering::Release);
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
            base,
            mode,
            requests,
            stop,
            closed,
            worker: Some(worker),
        }
    }
    fn count(&self, path: &str) -> usize {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(p, _, _)| p == path)
            .count()
    }
}
impl Drop for Device {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let result = worker.join();
            if !std::thread::panicking() {
                result.unwrap();
            }
        }
    }
}
fn setup(f: &Fixture, device: &Device, version: &Server, model: &Server) {
    grok_config(
        f,
        &format!("{}/token", device.base),
        &model.url,
        &version.url,
        true,
    );
    put(
        f.root.path().join(".native-model-login-fixture.json"),
        &json!({"deviceUrl":format!("{}/device",device.base),"tokenUrl":format!("{}/token",device.base),"userinfoUrl":format!("{}/userinfo",device.base),"waitMs":30000}),
    );
}
pub(super) fn account(f: &Fixture, action: &str) -> Command {
    let mut cmd = Command::new(native_test_binary());
    cmd.args(["models", action, "provider"])
        .env("PEER_AGENT_HOME", f.root.path())
        .env("HOME", f.root.path())
        .env("PATH", "/nonexistent")
        .env("PEER_CREDENTIAL_HELPER_PATH", helper())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd
}
fn version() -> Server {
    Server::new(vec!["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\n1.0.77\n".into()])
}
fn prompt(child: &mut OwnedChild) -> Value {
    use std::io::BufRead;
    let mut text = String::new();
    std::io::BufReader::new(child.child().stdout.as_mut().unwrap())
        .read_line(&mut text)
        .unwrap();
    let value: Value = serde_json::from_str(&text).unwrap();
    assert_eq!(value["status"], "authorization_required");
    assert_eq!(value["userCode"], "TEST-CODE");
    assert!(value["expiresAt"].is_string());
    assert!(!text.contains("synthetic-device"));
    value
}
#[test]
fn native_device_login_and_slow_down_commit_only_after_success_then_run_real_native_tools() {
    for mode in ["ok", "slow"] {
        let device = Device::new(mode);
        let version = version();
        let model = Server::new(vec![
            stream("openai-responses", "tool"),
            stream("openai-responses", "text"),
        ]);
        let f = Fixture::new(&model);
        setup(&f, &device, &version, &model);
        let before = f.history();
        let output = account(&f, "auth").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        let lines = String::from_utf8(output.stdout).unwrap();
        let rows = lines
            .lines()
            .map(|line| serde_json::from_str::<Value>(line).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(rows[0]["userCode"], "TEST-CODE");
        assert_eq!(rows[1]["status"], "credential_updated");
        assert!(!lines.contains("synthetic-device"));
        assert_eq!(f.history(), before);
        let requests = device.requests.lock().unwrap();
        let polls = requests
            .iter()
            .filter(|(p, _, _)| p == "/token")
            .collect::<Vec<_>>();
        assert_eq!(polls.len(), if mode == "slow" { 2 } else { 1 });
        assert!(polls[0].2 >= 1000);
        if mode == "slow" {
            assert!(polls[1].2 - polls[0].2 >= 6000);
        }
        drop(requests);
        let token: Value =
            serde_json::from_str(vault(&f, "get", None)["secret"].as_str().unwrap()).unwrap();
        assert_eq!(token["email"], "fixture@grok.invalid");
        assert_eq!(token["userId"], "fixture-grok-user");
        assert_eq!(token["provider"], "grok");
        let output = command(&f, "p").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(device.count("/token"), if mode == "slow" { 2 } else { 1 });
        let rows = f.history();
        let tool = rows.iter().find(|r| r["segments"].is_array()).unwrap();
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert_eq!(
            tool["permissionGrants"][0]["toolCallId"],
            tool["segments"][0]["result"]["evidence"]["toolCallId"]
        );
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        let status = account(&f, "status").output().unwrap();
        assert!(status.status.success());
        assert!(String::from_utf8_lossy(&status.stdout).contains("authenticated"));
    }
}
#[test]
fn denied_expired_untrusted_url_and_missing_api_scope_preserve_prior_encrypted_credential() {
    for mode in ["denied", "expired", "bad-url", "no-scope", "secret-code"] {
        let device = Device::new(mode);
        let version = version();
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        setup(&f, &device, &version, &model);
        let vault_file = f.root.path().join("credentials.vault.json");
        let before = std::fs::read(&vault_file).unwrap();
        let config = std::fs::read(f.root.path().join("llm-providers.json")).unwrap();
        let output = account(&f, "auth").output().unwrap();
        assert!(!output.status.success(), "{mode}");
        assert_eq!(std::fs::read(&vault_file).unwrap(), before);
        assert_eq!(
            std::fs::read(f.root.path().join("llm-providers.json")).unwrap(),
            config
        );
        assert!(model.requests.lock().unwrap().is_empty());
        assert_eq!(device.count("/userinfo"), 0);
        assert!(!String::from_utf8_lossy(&output.stdout).contains("synthetic-device"));
    }
}
#[cfg(unix)]
#[test]
fn cancelling_device_wait_or_active_poll_joins_http_and_new_device_grant_can_run_a_later_task() {
    for mode in ["pending", "stall"] {
        let device = Device::new(mode);
        let version = version();
        let model = Server::new(vec![
            stream("openai-responses", "tool"),
            stream("openai-responses", "text"),
        ]);
        let f = Fixture::new(&model);
        setup(&f, &device, &version, &model);
        let file = f.root.path().join("credentials.vault.json");
        let before = std::fs::read(&file).unwrap();
        let mut child = OwnedChild(Some(account(&f, "auth").spawn().unwrap()));
        prompt(&mut child);
        if mode == "stall" {
            let end = Instant::now() + Duration::from_secs(5);
            while device.count("/token") == 0 {
                assert!(Instant::now() < end);
                thread::sleep(Duration::from_millis(5));
            }
        }
        assert!(
            Command::new("/bin/kill")
                .args(["-TERM", &child.child().id().to_string()])
                .status()
                .unwrap()
                .success()
        );
        let output = wait_output(child);
        assert_eq!(
            output.status.code(),
            Some(peer_protocol::CliExit::Cancelled as i32)
        );
        assert_eq!(std::fs::read(&file).unwrap(), before);
        if mode == "stall" {
            let end = Instant::now() + Duration::from_secs(2);
            while !device.closed.load(Ordering::Acquire) {
                assert!(Instant::now() < end);
                thread::sleep(Duration::from_millis(5));
            }
        }
        *device.mode.lock().unwrap() = "ok".into();
        let output = account(&f, "auth").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(device.count("/device"), 2);
        let rows = device.requests.lock().unwrap();
        let last = rows.iter().rfind(|(p, _, _)| p == "/token").unwrap();
        assert_eq!(last.1["device_code"], "synthetic-device-2");
        drop(rows);
        let output = command(&f, "p").output().unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn a_new_login_or_changed_channel_while_waiting_for_user_stops_before_the_device_poll() {
    for rotate in [true, false] {
        let device = Device::new("ok");
        let version = version();
        let model = Server::new(vec![]);
        let f = Fixture::new(&model);
        setup(&f, &device, &version, &model);
        let mut child = OwnedChild(Some(account(&f, "auth").spawn().unwrap()));
        prompt(&mut child);
        let mut token = raw_token(&f);
        if rotate {
            token["access"] = json!("newer-login");
            vault(&f, "set", Some(&token));
        } else {
            let file = f.root.path().join("llm-providers.json");
            let mut data = get(&file);
            data["channels"][0]["enabled"] = json!(false);
            put(file, &data);
        }
        let output = wait_output(child);
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(if rotate {
            "model_credential_changed"
        } else {
            "model_configuration_changed"
        }));
        assert_eq!(device.count("/token"), 0);
        assert_eq!(raw_token(&f), token);
    }
}
