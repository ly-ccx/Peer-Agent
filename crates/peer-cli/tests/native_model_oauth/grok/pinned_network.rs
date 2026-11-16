//! Exercise production-pinned URLs, TLS names and the featureless executable.
//! A mandatory explicit CONNECT proxy routes every request to this owned server.
use super::*;
use crate::native_network::{
    clean_network,
    tls::{ConnectProxy, TlsFront},
};
use std::sync::atomic::{AtomicBool, Ordering};
struct Cloud {
    url: String,
    requests: Arc<Mutex<Vec<(String, Value)>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Cloud {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let rows = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            let mut model_count = 0;
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
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let (body, _, headers, _) = read_request(&mut socket);
                let first = headers.lines().next().unwrap();
                let (content_type, data) = if first.starts_with("GET /cli/stable ") {
                    ("text/plain", "1.0.77\n".into())
                } else if first.starts_with("POST /oauth2/device/code ") {
                    ("application/json", json!({"device_code":"pinned-secret-device","user_code":"PINNED-CODE","verification_uri":"https://auth.x.ai/activate","expires_in":900,"interval":1}).to_string())
                } else if first.starts_with("POST /oauth2/token ") {
                    assert!(matches!(
                        body["grant_type"].as_str(),
                        Some("refresh_token" | "urn:ietf:params:oauth:grant-type:device_code")
                    ));
                    ("application/json", json!({"access_token":"pinned-synthetic-access","refresh_token":"pinned-synthetic-refresh","expires_in":3600,"scope":"api:access grok-cli:access"}).to_string())
                } else if first.starts_with("GET /oauth2/userinfo ") {
                    (
                        "application/json",
                        json!({"email":"pinned@grok.invalid","sub":"pinned-user"}).to_string(),
                    )
                } else {
                    assert!(
                        first.starts_with("POST /v1/responses "),
                        "unexpected origin path: {first}"
                    );
                    model_count += 1;
                    (
                        "text/event-stream",
                        stream(
                            "openai-responses",
                            if model_count % 2 == 1 { "tool" } else { "text" },
                        ),
                    )
                };
                rows.lock().unwrap().push((headers, body));
                write!(socket, "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{data}", data.len()).unwrap();
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for Cloud {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        let result = self.worker.take().unwrap().join();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}
fn network(c: &mut Command, f: &Fixture, proxy: &ConnectProxy) {
    clean_network(c);
    c.env("HTTPS_PROXY", &proxy.url)
        .env("NO_PROXY", "")
        .env("PEER_EXTRA_CA_CERTS", f.root.path().join("grok-ca.pem"));
}
#[test]
fn pinned_grok_urls_device_refresh_and_tool_evidence_work_without_endpoint_overrides() {
    for login in [false, true] {
        let cloud = Cloud::new();
        let front = TlsFront::with_certificate(
            &cloud.url,
            include_bytes!("../../fixtures/grok-network/server.pem"),
            include_bytes!("../../fixtures/grok-network/server.key"),
        );
        let proxy = ConnectProxy::new(front.address);
        let seed = Server::new(vec![]);
        let f = Fixture::new(&seed);
        grok_config(
            &f,
            "http://127.0.0.1:1/token",
            "http://127.0.0.1:1",
            "http://127.0.0.1:1",
            false,
        );
        std::fs::remove_file(f.root.path().join(".native-model-oauth-fixture.json")).unwrap();
        std::fs::write(
            f.root.path().join("grok-ca.pem"),
            include_bytes!("../../fixtures/grok-network/ca.pem"),
        )
        .unwrap();
        let before = f.history();
        if login {
            let mut auth = device::account(&f, "auth");
            network(&mut auth, &f, &proxy);
            let out = auth.output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            let text = String::from_utf8(out.stdout).unwrap();
            assert!(text.contains("PINNED-CODE") && text.contains("https://auth.x.ai/activate"));
            assert!(text.contains("credential_updated"));
            assert!(
                !text.contains("pinned-secret-device") && !text.contains("pinned-synthetic-access")
            );
            assert_eq!(f.history(), before);
        }
        let mut exec = command(&f, "p");
        network(&mut exec, &f, &proxy);
        let out = exec.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        let tool = f
            .history()
            .into_iter()
            .find(|r| r["segments"].is_array())
            .unwrap();
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert_eq!(
            tool["permissionGrants"][0]["toolCallId"],
            tool["segments"][0]["result"]["evidence"]["toolCallId"]
        );
        let tokens: Value =
            serde_json::from_str(vault(&f, "get", None)["secret"].as_str().unwrap()).unwrap();
        assert_eq!(tokens["access"], "pinned-synthetic-access");
        let rows = cloud.requests.lock().unwrap();
        let mut counts = [0usize; 5];
        for (headers, body) in rows.iter() {
            let h = headers.to_ascii_lowercase();
            assert!(!h.contains("proxy-authorization:") && !h.contains("chatgpt-account-id:"));
            if h.starts_with("get /cli/stable ") {
                counts[0] += 1;
                assert!(h.contains("host: x.ai\r\n"));
                assert!(!h.contains("authorization:") && !h.contains("x-xai-token-auth:"));
            } else if h.starts_with("post /oauth2/device/code ") {
                counts[1] += 1;
                assert!(h.contains("host: auth.x.ai\r\n"));
                assert_eq!(body["client_id"], "b1a00492-073a-47ea-816f-4c329264a828");
                assert!(!h.contains("authorization:"));
            } else if h.starts_with("post /oauth2/token ") {
                counts[2] += 1;
                assert!(h.contains("host: auth.x.ai\r\n"));
                assert!(!h.contains("authorization:"));
                assert_eq!(
                    body["grant_type"],
                    if login {
                        "urn:ietf:params:oauth:grant-type:device_code"
                    } else {
                        "refresh_token"
                    }
                );
            } else if h.starts_with("get /oauth2/userinfo ") {
                counts[3] += 1;
                assert!(h.contains("host: auth.x.ai\r\n"));
                assert!(h.contains("authorization: bearer pinned-synthetic-access"));
            } else {
                counts[4] += 1;
                assert!(h.contains("host: cli-chat-proxy.grok.com\r\n"));
                assert!(h.contains("x-grok-client-version: 1.0.77"));
                assert!(h.contains("x-xai-token-auth: xai-grok-cli"));
                assert!(h.contains("authorization: bearer pinned-synthetic-access"));
            }
        }
        assert_eq!(counts, [1, usize::from(login), 1, usize::from(login), 2]);
        assert_eq!(proxy.headers.lock().unwrap().len(), rows.len());
        assert!(seed.requests.lock().unwrap().is_empty());
        assert!(
            !serde_json::to_string(&f.history())
                .unwrap()
                .contains("pinned-secret-device")
        );
    }
}
