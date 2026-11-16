//! Actual isolated native host, network configuration and recovery.
use super::*;
mod tls;
fn clean_network(command: &mut Command) {
    for key in [
        "HTTP_PROXY",
        "http_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "ALL_PROXY",
        "all_proxy",
        "NO_PROXY",
        "no_proxy",
        "PEER_EXTRA_CA_CERTS",
        "NODE_EXTRA_CA_CERTS",
    ] {
        command.env_remove(key);
    }
    command.env("NO_PROXY", "*");
}
#[test]
fn explicit_ca_size_encoding_and_file_type_limits_preserve_inputs_and_admit_after_repair() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("verified"),
    ]);
    let f = Fixture::new(&server);
    let original = f.history();
    let config = std::fs::read(f.root.path().join("llm-providers.json")).unwrap();
    for fault in ["oversized", "utf8", "directory", "fifo"] {
        let file = f.root.path().join(fault);
        match fault {
            "oversized" => std::fs::write(&file, vec![b'x'; 1_048_577]).unwrap(),
            "utf8" => std::fs::write(&file, [0xff]).unwrap(),
            "directory" => std::fs::create_dir(&file).unwrap(),
            _ => assert!(
                Command::new("/usr/bin/mkfifo")
                    .arg(&file)
                    .status()
                    .unwrap()
                    .success()
            ),
        }
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        command.env("PEER_EXTRA_CA_CERTS", &file);
        let mut child = OwnedChild(Some(command.spawn().unwrap()));
        let deadline = Instant::now() + Duration::from_secs(8);
        while child.child().try_wait().unwrap().is_none() {
            assert!(
                Instant::now() < deadline,
                "invalid CA must fail without blocking"
            );
            thread::sleep(Duration::from_millis(10));
        }
        let out = child.output();
        assert!(!out.status.success(), "{fault}");
        assert!(
            String::from_utf8_lossy(&out.stderr).contains(if fault == "oversized" {
                "network_ca_limit"
            } else {
                "network_ca_invalid"
            })
        );
        assert!(server.requests.lock().unwrap().is_empty());
        assert_eq!(f.history(), original);
        assert_eq!(
            std::fs::read(f.root.path().join("llm-providers.json")).unwrap(),
            config
        );
    }
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    assert!(command.output().unwrap().status.success());
    tool_evidence(&f);
}
fn base_url(f: &Fixture, url: &str) {
    let file = f.root.path().join("llm-providers.json");
    let mut config = get(&file);
    config["channels"][0]["baseUrl"] = json!(url);
    put(file, &config);
}
fn tool_evidence(f: &Fixture) {
    let tool = f
        .history()
        .into_iter()
        .find(|m| m["segments"].is_array())
        .unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
}
pub(super) struct ForwardProxy {
    pub url: String,
    pub requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<std::sync::atomic::AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl ForwardProxy {
    pub fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        listener.set_nonblocking(true).unwrap();
        let requests = Arc::new(Mutex::new(vec![]));
        let captured = requests.clone();
        let stop = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let ended = stop.clone();
        let worker = thread::spawn(move || {
            while !ended.load(std::sync::atomic::Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut client, _)) => {
                        client.set_nonblocking(false).unwrap();
                        client
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        client
                            .set_write_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let bytes = tls::request(&mut client).unwrap();
                        let offset = bytes.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
                        let header = String::from_utf8_lossy(&bytes[..offset]);
                        captured.lock().unwrap().push(header.to_string());
                        let mut lines = header.lines();
                        let mut first = lines.next().unwrap().split_whitespace();
                        let method = first.next().unwrap();
                        let url = url::Url::parse(first.next().unwrap()).unwrap();
                        assert_eq!(url.host_str(), Some("127.0.0.1"));
                        let target = url.socket_addrs(|| None).unwrap()[0];
                        let mut backend = TcpStream::connect(target).unwrap();
                        backend
                            .set_read_timeout(Some(Duration::from_secs(3)))
                            .unwrap();
                        let path = format!(
                            "{}{}",
                            url.path(),
                            url.query().map(|s| format!("?{s}")).unwrap_or_default()
                        );
                        write!(backend, "{method} {path} HTTP/1.1\r\n").unwrap();
                        for line in lines.filter(|line| {
                            !line.is_empty()
                                && !line.to_lowercase().starts_with("proxy-authorization:")
                        }) {
                            write!(backend, "{line}\r\n").unwrap();
                        }
                        backend.write_all(b"\r\n").unwrap();
                        backend.write_all(&bytes[offset..]).unwrap();
                        let _ = std::io::copy(&mut backend, &mut client);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url: format!("http://synthetic-user:synthetic-proxy-secret@{address}"),
            requests,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for ForwardProxy {
    fn drop(&mut self) {
        self.stop.store(true, std::sync::atomic::Ordering::Release);
        self.worker.take().unwrap().join().unwrap();
    }
}
#[test]
fn count_and_generation_share_the_explicit_proxy_without_changing_prepared_payload_or_usage() {
    let streams: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let wire = "anthropic-messages";
    let reply = |kind: &str| {
        streams["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["wire"] == wire && c["kind"] == kind)
            .unwrap()["stream"]
            .as_str()
            .unwrap()
            .to_owned()
    };
    let server = Server::new(vec![reply("tool"), reply("text")]);
    let proxy = ForwardProxy::new();
    let f = Fixture::new(&server);
    f.use_wire(wire, "anthropic", "anthropic");
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    command.env("HTTP_PROXY", &proxy.url).env("NO_PROXY", "");
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    tool_evidence(&f);
    assert_eq!(server.count_requests.lock().unwrap().len(), 1);
    assert_eq!(server.requests.lock().unwrap().len(), 2);
    let requests = proxy.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(
        requests
            .iter()
            .filter(|h| h.contains("count_tokens"))
            .count(),
        1
    );
    assert!(
        requests
            .iter()
            .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
    );
    assert!(
        server
            .request_headers
            .lock()
            .unwrap()
            .iter()
            .all(|h| !h.to_lowercase().contains("proxy-authorization"))
    );
    let result: Value = serde_json::from_slice(&out.stdout).unwrap();
    assert_eq!(result["usage"]["providerRequestCount"], 2);
    assert_eq!(result["usage"]["totalTokens"], 46);
}
#[test]
fn physical_http_proxy_and_no_proxy_route_the_same_native_tool_loop() {
    for bypass in [false, true] {
        let server = Server::new(vec![
            reply_tool("read_file", json!({"path":"input.txt"})),
            reply_text("verified"),
        ]);
        let f = Fixture::new(&server);
        let route = if bypass {
            "http://127.0.0.1:1".to_owned()
        } else {
            server
                .url
                .replace("http://", "http://synthetic-user:synthetic-proxy-secret@")
        };
        if !bypass {
            base_url(&f, "http://unresolvable.invalid/v1");
        }
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        command
            .env("HTTP_PROXY", &route)
            .env("NO_PROXY", if bypass { "127.0.0.1" } else { "" });
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        tool_evidence(&f);
        assert_eq!(server.requests.lock().unwrap().len(), 2);
        for header in server.request_headers.lock().unwrap().iter() {
            assert_eq!(
                header.to_lowercase().contains("proxy-authorization: basic"),
                !bypass
            );
            assert_eq!(header.contains("http://unresolvable.invalid"), !bypass);
        }
        assert!(!String::from_utf8_lossy(&out.stdout).contains("synthetic-proxy-secret"));
        assert!(
            !serde_json::to_string(&f.history())
                .unwrap()
                .contains("synthetic-proxy-secret")
        );
    }
}
#[test]
fn extra_ca_https_connect_proxy_and_hostname_validation_keep_tls_and_evidence_boundaries() {
    for (wrong, bypass) in [(false, false), (false, true), (true, true)] {
        let server = Server::new(vec![
            reply_tool("read_file", json!({"path":"input.txt"})),
            reply_text("verified"),
        ]);
        let tls = tls::TlsFront::new(&server, wrong);
        let proxy = tls::ConnectProxy::new(tls.address);
        let f = Fixture::new(&server);
        base_url(&f, &tls.url);
        let original = f.history();
        let ca = f.root.path().join("ca.pem");
        std::fs::write(&ca, tls::CA).unwrap();
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        command
            .env("HTTPS_PROXY", &proxy.url)
            .env("NO_PROXY", if bypass { "127.0.0.1" } else { "" })
            .env("PEER_EXTRA_CA_CERTS", &ca);
        let out = command.output().unwrap();
        if wrong {
            assert!(!out.status.success());
            assert!(server.requests.lock().unwrap().is_empty());
            assert_eq!(f.history(), original);
        } else {
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            tool_evidence(&f);
            assert_eq!(server.requests.lock().unwrap().len(), 2);
        }
        let connects = proxy.headers.lock().unwrap();
        assert_eq!(connects.len(), if bypass { 0 } else { 2 });
        for h in connects.iter() {
            assert!(h.to_lowercase().contains("proxy-authorization: basic"));
        }
        assert!(
            server
                .request_headers
                .lock()
                .unwrap()
                .iter()
                .all(|h| !h.to_lowercase().contains("proxy-authorization"))
        );
        assert!(
            !format!(
                "{}{}",
                String::from_utf8_lossy(&out.stdout),
                String::from_utf8_lossy(&out.stderr)
            )
            .contains("synthetic-proxy-secret")
        );
    }
}
#[test]
fn unknown_ca_is_rejected_and_adding_explicit_trust_admits_a_later_task_without_disabling_tls() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("verified"),
    ]);
    let tls = tls::TlsFront::new(&server, false);
    let f = Fixture::new(&server);
    base_url(&f, &tls.url);
    let original = f.history();
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    command.env("NO_PROXY", "*");
    let out = command.output().unwrap();
    assert!(!out.status.success());
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(f.history(), original);
    // A sent TLS attempt may consume the current worker admission. Preserve it
    // and use the suite's existing explicit next-task admission, never replay it.
    let ca = f.root.path().join("ca.pem");
    std::fs::write(&ca, tls::CA).unwrap();
    f.seed("next", "nc", "ns", "nw", "ne");
    let mut command = f.command("exec", "next");
    clean_network(&mut command);
    command.env("NO_PROXY", "*").env("NODE_EXTRA_CA_CERTS", &ca);
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let history = std::fs::read_to_string(f.root.path().join("conversations/nc.jsonl")).unwrap();
    let tool = history
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .find(|row| row["segments"].is_array())
        .unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    assert!(!history.contains("synthetic-proxy-secret"));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}
#[test]
fn invalid_explicit_extra_ca_blocks_before_any_model_or_tool_and_same_task_recovers() {
    let server = Server::new(vec![
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("verified"),
    ]);
    let f = Fixture::new(&server);
    let file = f.root.path().join("extra-ca.pem");
    std::fs::write(&file, "not a certificate").unwrap();
    let original = f.history();
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    command.env("PEER_EXTRA_CA_CERTS", &file);
    let out = command.output().unwrap();
    assert!(
        !out.status.success(),
        "explicit invalid CA must not be ignored"
    );
    assert!(server.requests.lock().unwrap().is_empty());
    assert_eq!(f.history(), original);
    assert_eq!(std::fs::read_to_string(&file).unwrap(), "not a certificate");
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let tool = f
        .history()
        .into_iter()
        .find(|m| m["segments"].is_array())
        .unwrap();
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
}
