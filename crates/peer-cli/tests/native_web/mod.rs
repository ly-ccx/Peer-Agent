//! Static web capability through the public executable and real local HTTP.
use super::*;
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "test-fixtures")]
mod recovery;
mod transport;
#[derive(Debug, PartialEq, Eq)]
enum SocketObservation {
    Eof,
    Reset,
    Bytes,
    Error(std::io::ErrorKind, Option<i32>),
    StillOpen,
}
impl SocketObservation {
    fn closed(&self) -> bool {
        matches!(self, Self::Eof | Self::Reset)
    }
}
fn observe_socket(
    stream: &mut TcpStream,
    stop: &AtomicBool,
    deadline: Instant,
) -> SocketObservation {
    while Instant::now() < deadline && !stop.load(Ordering::Acquire) {
        match stream.read(&mut [0]) {
            Ok(0) => return SocketObservation::Eof,
            Ok(_) => return SocketObservation::Bytes,
            Err(error) if error.kind() == std::io::ErrorKind::ConnectionReset => {
                return SocketObservation::Reset;
            }
            Err(error)
                if matches!(
                    error.kind(),
                    std::io::ErrorKind::WouldBlock
                        | std::io::ErrorKind::TimedOut
                        | std::io::ErrorKind::Interrupted
                ) => {}
            Err(error) => return SocketObservation::Error(error.kind(), error.raw_os_error()),
        }
    }
    SocketObservation::StillOpen
}
struct Page {
    url: String,
    headers: Arc<Mutex<Vec<String>>>,
    body_sent: Arc<AtomicBool>,
    socket: Arc<Mutex<Option<SocketObservation>>>,
    stop: Arc<AtomicBool>,
    owner: Option<thread::JoinHandle<()>>,
}
impl Page {
    fn new(responses: Vec<Vec<u8>>, stall: bool) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let headers = Arc::new(Mutex::new(Vec::new()));
        let captured = headers.clone();
        let body_sent = Arc::new(AtomicBool::new(false));
        let sent = body_sent.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let end = stop.clone();
        let socket = Arc::new(Mutex::new(None));
        let observed = socket.clone();
        let owner = thread::spawn(move || {
            let mut responses = responses.into_iter();
            while !end.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut s, _)) => {
                        s.set_nonblocking(false).unwrap();
                        s.set_read_timeout(Some(Duration::from_millis(100)))
                            .unwrap();
                        s.set_write_timeout(Some(Duration::from_secs(3))).unwrap();
                        let mut h = Vec::new();
                        let deadline = Instant::now() + Duration::from_secs(3);
                        while !h.ends_with(b"\r\n\r\n")
                            && h.len() < 32768
                            && Instant::now() < deadline
                            && !end.load(Ordering::Acquire)
                        {
                            let mut byte = [0];
                            match s.read(&mut byte) {
                                Ok(1) => h.push(byte[0]),
                                Ok(_) => break,
                                Err(e)
                                    if matches!(
                                        e.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                    ) => {}
                                Err(_) => break,
                            }
                        }
                        captured.lock().unwrap().push(String::from_utf8(h).unwrap());
                        let response = responses.next().unwrap_or_else(|| http(200, &[], b"later"));
                        if s.write_all(&response).and_then(|_| s.flush()).is_ok() {
                            sent.store(true, Ordering::Release);
                        }
                        if stall {
                            let result = observe_socket(
                                &mut s,
                                &end,
                                Instant::now() + Duration::from_secs(15),
                            );
                            observed.lock().unwrap().get_or_insert(result);
                        }
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(5))
                    }
                    Err(_) => break,
                }
            }
        });
        Self {
            url,
            headers,
            body_sent,
            socket,
            stop,
            owner: Some(owner),
        }
    }
    fn wait_for_body(&self, child: &mut OwnedChild) {
        let deadline = Instant::now() + Duration::from_secs(8);
        while !self.body_sent.load(Ordering::Acquire) {
            assert!(
                child.child().try_wait().unwrap().is_none(),
                "exited before the fixture wrote the HTTP body"
            );
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
    }
}
fn finish(mut child: OwnedChild) -> Output {
    let deadline = Instant::now() + Duration::from_secs(8);
    while child.child().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "web Host did not settle");
        thread::sleep(Duration::from_millis(5));
    }
    child.output()
}
#[test]
fn web_socket_probe_distinguishes_peer_reset_eof_and_live_connection() {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            for (mode, expected) in [
                ("eof", SocketObservation::Eof),
                ("reset", SocketObservation::Reset),
                ("bytes", SocketObservation::Bytes),
                ("live", SocketObservation::StillOpen),
            ] {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
                let (mut observed, _) = listener.accept().unwrap();
                observed
                    .set_read_timeout(Some(Duration::from_millis(25)))
                    .unwrap();
                peer.set_nonblocking(true).unwrap();
                let mut peer = Some(tokio::net::TcpStream::from_std(peer).unwrap());
                match mode {
                    "reset" => {
                        peer.as_ref()
                            .unwrap()
                            .set_linger(Some(Duration::ZERO))
                            .unwrap();
                        drop(peer.take());
                    }
                    "eof" => drop(peer.take()),
                    "bytes" => {
                        let peer = peer.as_ref().unwrap();
                        peer.writable().await.unwrap();
                        assert_eq!(peer.try_write(b"x").unwrap(), 1);
                    }
                    _ => {}
                }
                let seen = observe_socket(
                    &mut observed,
                    &AtomicBool::new(false),
                    Instant::now() + Duration::from_millis(100),
                );
                assert_eq!(seen, expected, "{mode}");
                assert_eq!(seen.closed(), matches!(mode, "eof" | "reset"));
                drop(peer);
            }
        });
}
#[test]
fn native_web_timeout_cancel_and_revocation_close_the_actual_body_socket() {
    for kind in ["timeout", "cancel", "revoke"] {
        let page = Page::new(vec![b"HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 100000\r\nConnection: close\r\n\r\npartial".to_vec()], true);
        let server = Server::new(vec![
            reply_tool(
                "web_fetch",
                json!({"url":page.url,"timeoutMs":if kind=="timeout" {500} else {120000}}),
            ),
            reply_text("Observed."),
            reply_text("Later task."),
        ]);
        let f = Fixture::new(&server);
        let mut child = OwnedChild(Some(f.command("exec", "p").spawn().unwrap()));
        page.wait_for_body(&mut child);
        if kind == "cancel" {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        } else if kind == "revoke" {
            let p = PolicyStore::new(f.root.path());
            let old = p.read_existing("w").unwrap();
            p.update_existing(
                "w",
                old.revision,
                peer_protocol::LocalAccessLevel::AskBeforeLocal,
                AT,
            )
            .unwrap();
        }
        let out = finish(child);
        if kind == "cancel" {
            assert_eq!(out.status.code(), Some(4));
        } else {
            success(&out);
        }
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(observation) = page.socket.lock().unwrap().as_ref() {
                assert!(
                    observation.closed(),
                    "{kind}: socket observation {observation:?}"
                );
                break;
            }
            assert!(
                Instant::now() < deadline,
                "{kind}: no closure observation after CLI exit ({:?})",
                out.status,
            );
            thread::sleep(Duration::from_millis(5));
        }
        let (r, grant) = result(&f);
        assert_eq!(
            r["error"]["code"],
            match kind {
                "timeout" => "timeout",
                "cancel" => "CANCELLED",
                _ => "permission_policy_changed",
            },
            "{kind}: {r}"
        );
        assert_eq!(grant["granted"], true);
        assert!(r["evidence"].is_object());
        assert!(!f.root.path().join("web-artifacts").exists());
        assert_eq!(page.headers.lock().unwrap().len(), 1);
        f.seed("p2", "c2", "s2", "work2", "epoch2");
        success(&f.command("exec", "p2").output().unwrap());
    }
}
#[test]
fn native_web_real_pty_approval_controls_the_first_network_request() {
    for allow in [true, false] {
        let page = Page::new(vec![http(200, &[], b"approved HTTP fact")], false);
        let server = Server::new(vec![
            reply_tool("web_fetch", json!({"url":page.url})),
            reply_text("Decision applied."),
        ]);
        let f = Fixture::new(&server);
        let p = PolicyStore::new(f.root.path());
        let old = p.read_existing("w").unwrap();
        p.update_existing(
            "w",
            old.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
        let (master, child) = permission_pty(&f);
        wait_permission_prompt(&master);
        assert!(page.headers.lock().unwrap().is_empty());
        assert!(!f.root.path().join("web-artifacts").exists());
        rustix::io::write(&master, if allow { b"y\n" } else { b"n\n" }).unwrap();
        wait_permission_decision(&f, if allow { "approved" } else { "denied" });
        success(&wait_permission_episode(child));
        let (r, g) = result(&f);
        assert_eq!(g["granted"], allow);
        assert_eq!(r["status"], if allow { "success" } else { "denied" }, "{r}");
        assert_eq!(page.headers.lock().unwrap().len(), usize::from(allow));
    }
}
impl Drop for Page {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.owner.take().unwrap().join().unwrap();
    }
}
fn http(status: u16, headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
    let mut out = format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
        body.len()
    );
    for (k, v) in headers {
        out.push_str(&format!("{k}: {v}\r\n"));
    }
    out.push_str("\r\n");
    [out.into_bytes(), body.to_vec()].concat()
}
fn result(f: &Fixture) -> (Value, Value) {
    let h = f.history();
    let m = h
        .iter()
        .find(|m| m["segments"].is_array())
        .expect("tool history");
    (
        m["segments"][0]["result"].clone(),
        m["permissionGrants"][0].clone(),
    )
}
fn success(output: &Output) {
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn native_web_http_publishes_legacy_and_immutable_facts_before_model_continuation() {
    let body = b"<title>Page &amp; title</title><script>hidden()</script><p>Saved &lt;fact&gt;</p>";
    let page = Page::new(
        vec![http(200, &[("content-type", "text/html")], body)],
        false,
    );
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":format!("{}/facts",page.url)})),
        reply_text("Saved web observation."),
    ]);
    let f = Fixture::new(&server);
    success(&f.run());
    let (r, grant) = result(&f);
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(grant["granted"], true);
    assert!(r["evidence"].is_object());
    let o = &r["output"];
    assert_eq!(o["title"], "Page & title");
    assert_eq!(o["rendered"], false);
    assert_eq!(o["waitForRenderRequested"], true);
    assert_eq!(o["contentTruncated"], false);
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(o["nativeContentRef"].clone()).unwrap();
    let store = peer_store::ToolArtifactStore::new(f.root.path());
    let saved = store
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    assert!(saved.complete);
    assert_eq!(
        String::from_utf8(saved.bytes.clone()).unwrap(),
        "Page & title Saved <fact>"
    );
    let id = o["artifactRef"]
        .as_str()
        .unwrap()
        .strip_prefix("local-web-artifact://")
        .unwrap();
    let date = r["completedAt"].as_str().unwrap().get(..10).unwrap();
    let dir = f.root.path().join("web-artifacts").join(date).join(id);
    assert_eq!(std::fs::read(dir.join("content.txt")).unwrap(), saved.bytes);
    let meta = get(dir.join("metadata.json"));
    assert_eq!(meta["nativeContentRef"], o["nativeContentRef"]);
    assert_eq!(meta["contentHash"], reference.sha256);
    assert_eq!(o["artifactRefs"].as_array().unwrap().len(), 2);
    std::fs::write(dir.join("content.txt"), "changed legacy copy").unwrap();
    assert_eq!(
        store
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap()
            .bytes,
        saved.bytes
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests[1].to_string().contains(&reference.sha256));
    let h = page.headers.lock().unwrap();
    assert_eq!(h.len(), 1);
    assert!(h[0].contains("Peer-Agent/1.0"));
    assert!(!h[0].to_lowercase().contains("authorization:"));
    assert!(!h[0].to_lowercase().contains("cookie:"));
}
#[test]
fn native_web_denial_and_readonly_policy_create_no_request_or_web_directory() {
    for level in [
        peer_protocol::LocalAccessLevel::AskBeforeLocal,
        peer_protocol::LocalAccessLevel::RestrictedLocal,
    ] {
        let page = Page::new(vec![], false);
        let server = Server::new(vec![
            reply_tool("web_fetch", json!({"url":page.url})),
            reply_text("Denied."),
        ]);
        let f = Fixture::new(&server);
        let p = PolicyStore::new(f.root.path());
        let old = p.read_existing("w").unwrap();
        p.update_existing("w", old.revision, level, AT).unwrap();
        success(&f.run());
        let (r, grant) = result(&f);
        assert_eq!(r["status"], "denied", "{r}");
        assert_eq!(grant["granted"], false);
        assert!(r["evidence"].is_object());
        assert!(page.headers.lock().unwrap().is_empty());
        assert!(!f.root.path().join("web-artifacts").exists());
    }
}
#[test]
fn native_web_redirect_and_http_failures_keep_real_status_without_success_artifacts() {
    for (case, code, count) in [
        ("404", "web_http_error", 1),
        ("missing", "redirect_without_location", 1),
        ("loop", "too_many_redirects", 6),
        ("scheme", "unsupported_protocol", 1),
        ("credentials", "web_url_credentials", 0),
    ] {
        let response = match case {
            "404" => http(404, &[], b"untrusted error"),
            "missing" => http(302, &[], b""),
            "scheme" => http(302, &[("location", "file:///not-read")], b""),
            _ => http(302, &[("location", "/loop")], b""),
        };
        let page = Page::new(vec![response; 6], false);
        let url = if case == "credentials" {
            page.url.replacen("http://", "http://user:secret@", 1)
        } else {
            page.url.clone()
        };
        let server = Server::new(vec![
            reply_tool("web_fetch", json!({"url":url})),
            reply_text("Failure preserved."),
        ]);
        let f = Fixture::new(&server);
        success(&f.run());
        let (r, grant) = result(&f);
        assert_eq!(r["status"], "failed", "{case}: {r}");
        assert_eq!(r["error"]["code"], code, "{case}: {r}");
        assert_eq!(grant["granted"], true);
        if case == "404" {
            assert_eq!(r["output"]["httpStatus"], 404);
            assert_eq!(r["output"]["errorDetail"], "http_404");
        }
        assert_eq!(page.headers.lock().unwrap().len(), count);
        assert!(!f.root.path().join("web-artifacts").exists());
    }
}
#[test]
fn native_web_cross_origin_redirect_does_not_forward_model_credentials() {
    let dest = Page::new(vec![http(200, &[], b"final fact")], false);
    let page = Page::new(
        vec![http(
            302,
            &[
                ("location", &format!("{}/final", dest.url)),
                ("set-cookie", "private=source"),
            ],
            b"",
        )],
        false,
    );
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url,"waitForRender":false})),
        reply_text("Redirected."),
    ]);
    let f = Fixture::new(&server);
    success(&f.run());
    let (r, _) = result(&f);
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["finalUrl"], format!("{}/final", dest.url));
    assert_eq!(r["output"]["waitForRenderRequested"], false);
    for p in [&page, &dest] {
        let h = p.headers.lock().unwrap();
        assert_eq!(h.len(), 1);
        assert!(!h[0].to_lowercase().contains("authorization:"));
        assert!(!h[0].to_lowercase().contains("cookie:"));
    }
}
#[test]
fn native_web_saved_content_is_readable_through_the_projected_tool_and_real_grant() {
    let body = "immutable HTTP observation\n";
    let expected_root = tempfile::tempdir().unwrap();
    std::fs::create_dir(expected_root.path().join("conversations")).unwrap();
    std::fs::write(expected_root.path().join("conversations/c.jsonl"), "{}").unwrap();
    let reference = peer_store::ToolArtifactStore::new(expected_root.path())
        .publish_utf8("c", body, &|| false)
        .unwrap();
    let page = Page::new(vec![http(200, &[], body.as_bytes())], false);
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url})),
        reply_tool(
            "read_tool_result",
            json!({"reference":reference,"offset":0,"length":4096}),
        ),
        reply_text("Saved content read through the tool."),
    ]);
    let f = Fixture::new(&server);
    success(&f.run());
    let h = f.history();
    let tools = h
        .iter()
        .filter(|m| m["segments"].is_array())
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 2);
    for m in &tools {
        assert_eq!(m["permissionGrants"][0]["granted"], true);
        assert_eq!(m["segments"][0]["result"]["status"], "success");
        assert!(m["segments"][0]["result"]["evidence"].is_object());
    }
    assert_eq!(
        tools[0]["segments"][0]["result"]["output"]["nativeContentRef"],
        json!(reference)
    );
    assert_eq!(tools[1]["segments"][0]["tool"], "read_tool_result");
    assert!(
        server.requests.lock().unwrap()[2]
            .to_string()
            .contains("immutable HTTP observation")
    );
    assert_eq!(page.headers.lock().unwrap().len(), 1);
}
