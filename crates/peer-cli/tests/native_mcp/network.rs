//! Public Host -> granted MCP, with actual isolated TLS/proxy connections.
use super::*;
use crate::native_network::{ForwardProxy, clean_network, tls};
use base64::{Engine as _, engine::general_purpose::STANDARD};

fn configure(f: &Fixture, endpoint: &str, legacy: bool) {
    put(
        f.root.path().join("mcp-registry.json"),
        &json!({"version":1,"servers":[{
            "id":"s","transport":if legacy {"sse"} else {"streamable_http"},"url":endpoint,
            "headers":{"X-Fixture-Token":"synthetic-http-secret"},
            "tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]
        }]}),
    );
}
fn model() -> Server {
    Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("MCP network verified"),
    ])
}
fn evidence(f: &Fixture, model: &Server, mcp: &http::Http) {
    let requests = mcp.requests.lock().unwrap();
    assert_eq!(
        requests
            .iter()
            .filter(|(_, v)| v["method"] == "initialize")
            .count(),
        1
    );
    assert_eq!(
        requests
            .iter()
            .filter(|(_, v)| v["method"] == "tools/call")
            .count(),
        1
    );
    assert!(
        requests
            .iter()
            .all(|(h, _)| !h.to_lowercase().contains("proxy-authorization"))
    );
    drop(requests);
    let history = f.history();
    let row = history
        .iter()
        .find(|row| row["segments"].is_array())
        .unwrap();
    assert_eq!(row["permissionGrants"][0]["granted"], true);
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert!(row["segments"][0]["result"]["evidence"].is_object());
    assert!(
        serde_json::to_string(&history)
            .unwrap()
            .contains("native HTTP MCP fact")
    );
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
}
fn ca(f: &Fixture) -> std::path::PathBuf {
    let path = f.root.path().join("synthetic-ca.pem");
    std::fs::write(&path, tls::CA).unwrap();
    path
}

#[test]
fn extra_ca_connect_proxy_and_both_sse_protocols_preserve_grant_evidence_and_secrets() {
    for (legacy, sse) in [(false, false), (false, true), (true, true)] {
        let server = model();
        let f = Fixture::new(&server);
        let encoded = STANDARD.encode("synthetic-user:synthetic-proxy-secret");
        let mcp = http::Http::echo(
            legacy,
            sse,
            format!("synthetic-user synthetic-proxy-secret Basic {encoded} {encoded}"),
        );
        let front = tls::TlsFront::for_url(&mcp.url, false);
        let proxy = tls::ConnectProxy::new(front.address);
        configure(&f, &front.url, legacy);
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        command
            .env("HTTPS_PROXY", &proxy.url)
            .env("NO_PROXY", "")
            .env("PEER_EXTRA_CA_CERTS", ca(&f));
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "legacy={legacy} sse={sse}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        evidence(&f, &server, &mcp);
        let connects = proxy.headers.lock().unwrap();
        assert_eq!(connects.len(), if legacy { 4 } else { 3 });
        assert!(
            connects
                .iter()
                .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
        );
        let public = format!(
            "{}{}{}{}",
            String::from_utf8_lossy(&out.stdout),
            String::from_utf8_lossy(&out.stderr),
            serde_json::to_string(&f.history()).unwrap(),
            serde_json::to_string(&*server.requests.lock().unwrap()).unwrap()
        );
        for secret in ["synthetic-user", "synthetic-proxy-secret", encoded.as_str()] {
            assert!(
                !public.contains(secret),
                "proxy credential reached public facts"
            );
        }
        assert!(public.contains("[REDACTED]"));
    }
}

#[test]
fn explicit_ca_tls_failure_is_before_mcp_dispatch_and_later_task_can_use_added_trust() {
    for wrong in [false, true] {
        let server = Server::new(vec![
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("not dispatched"),
            reply_tool("mcp__s__read_fact", json!({})),
            reply_text("trusted"),
        ]);
        let f = Fixture::new(&server);
        let mcp = http::Http::new(false, false);
        let front = tls::TlsFront::for_url(&mcp.url, wrong);
        configure(&f, &front.url, false);
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        if wrong {
            command.env("PEER_EXTRA_CA_CERTS", ca(&f));
        }
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "model reports definite pre-dispatch failure: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert!(mcp.requests.lock().unwrap().is_empty());
        assert!(
            serde_json::to_string(&f.history())
                .unwrap()
                .contains("mcp_initialize_failed")
        );
        assert_eq!(
            f.budget(|_| {})["uncertainDispatches"]
                .as_array()
                .map_or(0, Vec::len),
            0
        );
        // Preserve the first task's history and use normal subsequent admission.
        let original = f.history();
        let trusted = tls::TlsFront::for_url(&mcp.url, false);
        configure(&f, &trusted.url, false);
        f.seed("next", "nc", "ns", "nw", "ne");
        let mut command = f.command("exec", "next");
        clean_network(&mut command);
        command.env("NODE_EXTRA_CA_CERTS", ca(&f));
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(f.history(), original);
        let next = std::fs::read_to_string(f.root.path().join("conversations/nc.jsonl")).unwrap();
        assert!(next.contains("native HTTP MCP fact"));
        assert!(next.contains("local_mcp_tool_call"));
        assert_eq!(
            mcp.requests
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, v)| v["method"] == "tools/call")
                .count(),
            1
        );
    }
}

#[test]
fn http_and_https_proxy_routes_and_no_proxy_apply_to_physical_mcp_requests() {
    for mode in ["http", "https", "bypass"] {
        let server = model();
        let f = Fixture::new(&server);
        let mcp = http::Http::echo(false, false, "synthetic-proxy-secret".into());
        let proxy = ForwardProxy::new();
        let front = tls::TlsFront::for_url(&proxy.url, false);
        configure(&f, &mcp.url, false);
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        if mode == "bypass" {
            command
                .env(
                    "HTTP_PROXY",
                    "http://synthetic-user:synthetic-proxy-secret@127.0.0.1:1",
                )
                .env("NO_PROXY", "127.0.0.1");
        } else {
            let mut route = if mode == "https" {
                url::Url::parse(&front.url).unwrap()
            } else {
                url::Url::parse(&proxy.url).unwrap()
            };
            route.set_username("synthetic-user").unwrap();
            route.set_password(Some("synthetic-proxy-secret")).unwrap();
            command.env("HTTP_PROXY", route.as_str()).env(
                "NO_PROXY",
                format!(
                    "127.0.0.1:{}",
                    url::Url::parse(&server.url).unwrap().port().unwrap()
                ),
            );
            if mode == "https" {
                command.env("PEER_EXTRA_CA_CERTS", ca(&f));
            }
        }
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "mode={mode}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        evidence(&f, &server, &mcp);
        let history = serde_json::to_string(&f.history()).unwrap();
        assert_eq!(
            history.contains("synthetic-proxy-secret"),
            mode == "bypass",
            "only the actual selected route enters protection"
        );
        let proxied = proxy.requests.lock().unwrap();
        assert_eq!(proxied.len(), if mode == "bypass" { 0 } else { 3 });
        assert!(
            proxied
                .iter()
                .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
        );
    }
}

#[test]
fn invalid_mcp_proxy_fails_before_dispatch_without_erasing_history_and_repaired_route_admits_next_task()
 {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("not dispatched"),
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("repaired"),
    ]);
    let f = Fixture::new(&server);
    let mcp = http::Http::new(false, false);
    configure(&f, &mcp.url, false);
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    command
        .env(
            "HTTP_PROXY",
            "socks5://synthetic-user:synthetic-proxy-secret@127.0.0.1:1",
        )
        .env(
            "NO_PROXY",
            format!(
                "127.0.0.1:{}",
                url::Url::parse(&server.url).unwrap().port().unwrap()
            ),
        );
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(mcp.requests.lock().unwrap().is_empty());
    let old = f.history();
    let row = old.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["dispatchOutcome"],
        "not_dispatched"
    );
    assert_eq!(
        f.budget(|_| {})["uncertainDispatches"]
            .as_array()
            .map_or(0, Vec::len),
        0
    );
    assert!(
        !serde_json::to_string(&old)
            .unwrap()
            .contains("synthetic-proxy-secret")
    );
    f.seed("next", "nc", "ns", "nw", "ne");
    let mut command = f.command("exec", "next");
    clean_network(&mut command);
    assert!(command.output().unwrap().status.success());
    assert_eq!(f.history(), old);
    let next = std::fs::read_to_string(f.root.path().join("conversations/nc.jsonl")).unwrap();
    assert!(next.contains("native HTTP MCP fact"));
    assert_eq!(
        mcp.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, v)| v["method"] == "tools/call")
            .count(),
        1
    );
}

#[test]
fn proxied_duplex_cancel_closes_owned_connections_preserves_unknown_and_admits_later_work() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("later work"),
    ]);
    let f = Fixture::new(&server);
    let mcp = http::Http::duplex_fault(true);
    let front = tls::TlsFront::for_url(&mcp.url, false);
    let proxy = tls::ConnectProxy::new(front.address);
    configure(&f, &front.url, false);
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    command
        .env("HTTPS_PROXY", &proxy.url)
        .env("NO_PROXY", "")
        .env("PEER_EXTRA_CA_CERTS", ca(&f));
    let mut child = OwnedChild(Some(command.spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(8);
    while !mcp.events.lock().unwrap().contains(&"pong_received") {
        assert!(Instant::now() < deadline, "proxied control POST missing");
        thread::sleep(Duration::from_millis(10));
    }
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.child().try_wait().unwrap().is_none() {
        assert!(
            Instant::now() < deadline,
            "owned network futures failed to stop"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let out = child.output();
    assert_eq!(out.status.code(), Some(1));
    let deadline = Instant::now() + Duration::from_secs(1);
    while proxy.closed.load(std::sync::atomic::Ordering::Acquire)
        < proxy.headers.lock().unwrap().len()
    {
        assert!(
            Instant::now() < deadline,
            "native proxy socket did not reach EOF"
        );
        thread::sleep(Duration::from_millis(10));
    }
    let unknown = f.budget(|_| {})["uncertainDispatches"].clone();
    assert_eq!(unknown.as_array().unwrap().len(), 1);
    assert_eq!(
        mcp.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, v)| v["method"] == "tools/call")
            .count(),
        1
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let old = f.history();
    f.seed("next", "nc", "ns", "nw", "ne");
    let mut command = f.command("exec", "next");
    clean_network(&mut command);
    let denied = command.output().unwrap();
    assert!(
        !denied.status.success(),
        "unknown must still fence the original workspace"
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let directory = f.root.path().join("independent-worktree");
    std::fs::create_dir(&directory).unwrap();
    std::fs::write(directory.join("input.txt"), "synthetic later input").unwrap();
    let path = f.root.path().join("goal-plans/next.json");
    let mut goal = get(&path);
    goal["targetWorkspacePath"] = json!(directory);
    put(path, &goal);
    let mut command = f.command("exec", "next");
    clean_network(&mut command);
    let out = command.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(f.history(), old);
    assert_eq!(f.budget(|_| {})["uncertainDispatches"], unknown);
    let next = std::fs::read_to_string(f.root.path().join("conversations/nc.jsonl")).unwrap();
    let rows: Vec<Value> = next
        .lines()
        .map(|s| serde_json::from_str(s).unwrap())
        .collect();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(
        row["segments"][0]["result"]["capabilityId"],
        "local.file.read"
    );
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["output"]["content"],
        "synthetic later input"
    );
    assert!(row["segments"][0]["result"]["evidence"]["evidenceId"].is_string());
    assert_eq!(
        mcp.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, v)| v["method"] == "tools/call")
            .count(),
        1
    );
}
