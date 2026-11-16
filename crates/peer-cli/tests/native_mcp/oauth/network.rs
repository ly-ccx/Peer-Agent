//! The real SDK/Vault/public entry, with local TLS and an actual CONNECT proxy.
use super::*;
use crate::native_network::{clean_network, tls};
fn trusted(f: &Fixture) -> std::path::PathBuf {
    let path = f.root.path().join("oauth-ca.pem");
    std::fs::write(&path, tls::CA).unwrap();
    path
}
fn routed(f: &Fixture, action: &str, proxy: &tls::ConnectProxy) -> Command {
    let mut command = command(f, action);
    clean_network(&mut command);
    command
        .env("HTTPS_PROXY", &proxy.url)
        .env("NO_PROXY", "")
        .env("PEER_EXTRA_CA_CERTS", trusted(f));
    command
}
#[test]
fn native_tls_oauth_refresh_uses_local_approved_numeric_connect_and_original_host() {
    let server = Server::new(vec![]);
    let f = Fixture::new(&server);
    let mut oauth = OAuth::new("");
    let front = tls::TlsFront::for_url(&oauth.base, false);
    let proxy = tls::ConnectProxy::new(front.address);
    let public = format!("https://localhost:{}", front.address.port());
    oauth.public_base(&public);
    setup(&f, &oauth);
    let output = routed(&f, "refresh", &proxy).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(oauth.tokens().len(), 1);
    let connects = proxy.headers.lock().unwrap();
    assert!(!connects.is_empty());
    assert!(
        connects
            .iter()
            .all(|h| h.starts_with(&format!("CONNECT {} HTTP/1.1", front.address)))
    );
    assert!(
        connects
            .iter()
            .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
    );
    let origin = oauth.requests.lock().unwrap();
    assert!(
        origin
            .iter()
            .all(|(h, _)| !h.to_lowercase().contains("proxy-authorization"))
    );
    assert!(origin.iter().all(|(h, _)| {
        h.to_lowercase()
            .contains(&format!("host: localhost:{}", front.address.port()))
    }));
    let public = format!(
        "{}{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
        std::fs::read_to_string(f.root.path().join("mcp-credentials.json")).unwrap()
    );
    for secret in [
        "synthetic-proxy-secret",
        "oauth-refreshed-secret",
        "oauth-new-refresh-secret",
    ] {
        assert!(!public.contains(secret));
    }
}
#[test]
fn proxied_tls_native_oauth_login_refresh_vault_and_tool_evidence_form_one_rust_chain() {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("OAuth proxy verified"),
    ]);
    let f = Fixture::new(&server);
    let mut oauth = OAuth::new("");
    let front = tls::TlsFront::for_url(&oauth.base, false);
    let proxy = tls::ConnectProxy::new(front.address);
    let public = format!("https://localhost:{}", front.address.port());
    oauth.public_base(&public);
    setup(&f, &oauth);
    let pending = pending_command(routed(&f, "auth", &proxy));
    let authorization = pending.url.clone();
    assert!(callback(&authorization, &format!("{public}/issuer"), false).contains("200 OK"));
    let out = pending.output();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out = routed(&f, "refresh", &proxy).output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(oauth.tokens().len(), 2);
    let before = proxy.headers.lock().unwrap().clone();
    assert!(
        before
            .iter()
            .all(|h| h.starts_with(&format!("CONNECT {} HTTP/1.1", front.address)))
    );
    let mut run = credentials::run(&f);
    clean_network(&mut run);
    run.env("HTTPS_PROXY", &proxy.url)
        .env("PEER_EXTRA_CA_CERTS", trusted(&f))
        .env(
            "NO_PROXY",
            format!(
                "127.0.0.1:{}",
                url::Url::parse(&server.url).unwrap().port().unwrap()
            ),
        );
    let out = run.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let origin = oauth.requests.lock().unwrap();
    assert_eq!(
        origin
            .iter()
            .filter(|(_, b)| b.contains("tools/call"))
            .count(),
        1
    );
    assert!(
        origin
            .iter()
            .all(|(h, _)| !h.to_lowercase().contains("proxy-authorization"))
    );
    let rows = f.history();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(row["permissionGrants"][0]["granted"], true);
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["evidenceKind"],
        "local_mcp_tool_call"
    );
    let history = serde_json::to_string(&rows).unwrap();
    assert!(history.contains("[REDACTED]"));
    for secret in [
        "synthetic-proxy-secret",
        "oauth-refreshed-secret",
        "oauth-new-refresh-secret",
        "synthetic-code",
    ] {
        assert!(!history.contains(secret));
    }
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[test]
fn oauth_tls_or_discovered_address_failures_and_token_redirects_preserve_vault_without_replay() {
    for mode in [
        "untrusted",
        "wrong-name",
        "metadata-address",
        "redirect",
        "oversize",
    ] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        let mut oauth = OAuth::new(mode);
        let front = tls::TlsFront::for_url(&oauth.base, mode == "wrong-name");
        let proxy = tls::ConnectProxy::new(front.address);
        let public = format!("https://localhost:{}", front.address.port());
        oauth.public_base(&public);
        setup(&f, &oauth);
        let file = f.root.path().join("mcp-credentials.json");
        let before = std::fs::read(&file).unwrap();
        let history = f.history();
        let mut command = routed(&f, "refresh", &proxy);
        if mode == "untrusted" {
            command.env_remove("PEER_EXTRA_CA_CERTS");
        }
        let out = command.output().unwrap();
        assert!(!out.status.success(), "{mode} must fail");
        assert_eq!(std::fs::read(&file).unwrap(), before);
        assert_eq!(f.history(), history);
        assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
        let count = if matches!(mode, "redirect" | "oversize") {
            1
        } else {
            0
        };
        assert_eq!(oauth.tokens().len(), count, "{mode}");
        assert!(
            proxy
                .headers
                .lock()
                .unwrap()
                .iter()
                .all(|h| h.starts_with(&format!("CONNECT {} HTTP/1.1", front.address))),
            "untrusted metadata or redirect must never change proxy destination"
        );
        assert!(server.requests.lock().unwrap().is_empty());
        assert!(!String::from_utf8_lossy(&out.stderr).contains("oauth-refreshed-secret"));
        // Existing generation is preserved; explicit corrected trust and the
        // same fixture source can be used by a later credential action.
        if mode == "untrusted" {
            let out = routed(&f, "refresh", &proxy).output().unwrap();
            assert!(
                out.status.success(),
                "{}",
                String::from_utf8_lossy(&out.stderr)
            );
            assert_eq!(oauth.tokens().len(), 1);
        }
    }
}

#[test]
fn oauth_https_proxy_and_explicit_no_proxy_use_the_same_strict_origin_trust() {
    for bypass in [false, true] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        let mut oauth = OAuth::new("");
        let origin = tls::TlsFront::for_url(&oauth.base, false);
        let proxy = tls::ConnectProxy::new(origin.address);
        let proxy_tls = tls::TlsFront::for_url(&proxy.url, false);
        oauth.public_base(&format!("https://localhost:{}", origin.address.port()));
        setup(&f, &oauth);
        let mut command = routed(&f, "refresh", &proxy);
        let mut url = url::Url::parse(&proxy_tls.url).unwrap();
        url.set_username("synthetic-user").unwrap();
        url.set_password(Some("synthetic-proxy-secret")).unwrap();
        command
            .env("HTTPS_PROXY", url.as_str())
            .env("NO_PROXY", if bypass { "localhost" } else { "" });
        let out = command.output().unwrap();
        assert!(
            out.status.success(),
            "bypass={bypass}: {}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(oauth.tokens().len(), 1);
        let headers = proxy.headers.lock().unwrap();
        assert_eq!(headers.is_empty(), bypass);
        assert!(
            headers
                .iter()
                .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
        );
        assert!(
            headers
                .iter()
                .all(|h| h.starts_with(&format!("CONNECT {} HTTP/1.1", origin.address)))
        );
        assert!(
            oauth
                .requests
                .lock()
                .unwrap()
                .iter()
                .all(|(h, _)| !h.to_lowercase().contains("proxy-authorization"))
        );
    }
}

#[test]
fn cancellation_of_proxied_token_exchange_preserves_generation_closes_socket_and_allows_explicit_relogin()
 {
    let server = Server::new(vec![
        reply_tool("mcp__s__read_fact", json!({})),
        reply_text("after explicit relogin"),
    ]);
    let f = Fixture::new(&server);
    let mut oauth = OAuth::new("stall-token");
    let origin = tls::TlsFront::for_url(&oauth.base, false);
    let proxy = tls::ConnectProxy::new(origin.address);
    let public = format!("https://localhost:{}", origin.address.port());
    oauth.public_base(&public);
    setup(&f, &oauth);
    let file = f.root.path().join("mcp-credentials.json");
    let before = std::fs::read(&file).unwrap();
    let history = f.history();
    let mut child = OwnedChild(Some(routed(&f, "refresh", &proxy).spawn().unwrap()));
    let deadline = Instant::now() + Duration::from_secs(8);
    while oauth.tokens().is_empty() {
        assert!(
            Instant::now() < deadline,
            "token POST did not reach fixture"
        );
        thread::sleep(Duration::from_millis(10));
    }
    rustix::process::kill_process(
        rustix::process::Pid::from_raw(child.child().id() as i32).unwrap(),
        rustix::process::Signal::TERM,
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(6);
    while child.child().try_wait().unwrap().is_none() {
        assert!(Instant::now() < deadline, "OAuth owner failed to settle");
        thread::sleep(Duration::from_millis(10));
    }
    let out = child.output();
    assert_eq!(out.status.code(), Some(4));
    assert_eq!(std::fs::read(&file).unwrap(), before);
    assert_eq!(f.history(), history);
    assert!(!f.root.path().join("mcp-credentials.json.lock").exists());
    assert_eq!(oauth.tokens().len(), 1);
    let deadline = Instant::now() + Duration::from_secs(1);
    while proxy.closed.load(Ordering::Acquire) < proxy.headers.lock().unwrap().len() {
        assert!(Instant::now() < deadline, "owned token socket stayed open");
        thread::sleep(Duration::from_millis(10));
    }
    // A sent refresh is not replayed or assumed still usable. Use the supported
    // explicit login, preserve prior facts, then admit the original ready task.
    oauth.stall.store(false, Ordering::Release);
    let pending = pending_command(routed(&f, "auth", &proxy));
    let authorization = pending.url.clone();
    assert!(callback(&authorization, &format!("{public}/issuer"), false).contains("200 OK"));
    let out = pending.output();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(oauth.tokens().len(), 2);
    assert!(oauth.tokens()[1].contains("grant_type=authorization_code"));
    let mut run = credentials::run(&f);
    clean_network(&mut run);
    run.env("HTTPS_PROXY", &proxy.url)
        .env("PEER_EXTRA_CA_CERTS", trusted(&f))
        .env(
            "NO_PROXY",
            format!(
                "127.0.0.1:{}",
                url::Url::parse(&server.url).unwrap().port().unwrap()
            ),
        );
    let out = run.output().unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let rows = f.history();
    let row = rows.iter().find(|r| r["segments"].is_array()).unwrap();
    assert_eq!(row["permissionGrants"][0]["granted"], true);
    assert_eq!(row["segments"][0]["result"]["status"], "success");
    assert_eq!(
        row["segments"][0]["result"]["evidence"]["evidenceKind"],
        "local_mcp_tool_call"
    );
    assert_eq!(
        oauth
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(_, b)| b.contains("tools/call"))
            .count(),
        1
    );
}
