use super::*;
use base64::Engine;
#[test]
fn native_web_decodes_real_gzip_brotli_and_deflate_with_the_decoded_body_limit() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/web-fetch-cases.json"
    ))
    .unwrap();
    for c in data["realHttp"]["compressed"].as_array().unwrap() {
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(c["encoded"].as_str().unwrap())
            .unwrap();
        let page = Page::new(
            vec![http(
                200,
                &[
                    ("content-encoding", c["encoding"].as_str().unwrap()),
                    ("content-type", "text/plain"),
                ],
                &bytes,
            )],
            false,
        );
        let server = Server::new(vec![
            reply_tool("web_fetch", json!({"url":page.url})),
            reply_text("Compression observed."),
        ]);
        let f = Fixture::new(&server);
        success(&f.run());
        let (r, g) = result(&f);
        assert_eq!(g["granted"], true);
        assert!(r["evidence"].is_object());
        assert_eq!(page.headers.lock().unwrap().len(), 1);
        if c["oversized"] == true {
            assert_eq!(r["status"], "failed", "{}: {r}", c["name"]);
            assert_eq!(r["error"]["code"], "response_too_large");
            assert!(!f.root.path().join("web-artifacts").exists());
        } else {
            assert_eq!(r["status"], "success", "{}: {r}", c["name"]);
            assert_eq!(
                r["output"]["nativeContentRef"]["sha256"],
                c["contentSha256"]
            );
            assert_eq!(r["output"]["nativeContentRef"]["bytes"], c["contentBytes"]);
            assert!(
                page.headers.lock().unwrap()[0]
                    .to_lowercase()
                    .contains("accept-encoding:")
            );
        }
        // Enabling reqwest codecs for Web must not alter model requests.
        assert!(
            server
                .request_headers
                .lock()
                .unwrap()
                .iter()
                .all(|h| !h.to_lowercase().contains("accept-encoding:"))
        );
    }
}
#[test]
fn native_web_scalar_truncation_is_explicit_and_oversized_or_invalid_content_has_no_artifact() {
    for case in ["scalar", "body", "entity", "title", "broken-compression"] {
        let raw = match case {
            "scalar" => format!("x{}", "🦀".repeat(1_000_000)),
            "body" => "x".repeat(5_000_001),
            "entity" => "<title>&#55296;</title>".into(),
            "title" => format!("<title>{}</title>", "x".repeat(65537)),
            _ => "invalid compressed bytes".into(),
        };
        let mut headers = vec![("content-type", "text/plain")];
        if case == "broken-compression" {
            headers.push(("content-encoding", "gzip"));
        }
        let page = Page::new(vec![http(200, &headers, raw.as_bytes())], false);
        let server = Server::new(vec![
            reply_tool("web_fetch", json!({"url":page.url})),
            reply_text("Bounded."),
        ]);
        let f = Fixture::new(&server);
        success(&f.run());
        let (r, _) = result(&f);
        if case == "scalar" {
            assert_eq!(r["status"], "success", "{r}");
            let o = &r["output"];
            assert_eq!(o["contentTruncated"], true);
            assert_eq!(o["nativeContentRef"]["bytes"], 3_999_997);
            let id = o["artifactRef"]
                .as_str()
                .unwrap()
                .strip_prefix("local-web-artifact://")
                .unwrap();
            let day = &r["completedAt"].as_str().unwrap()[..10];
            let dir = f.root.path().join("web-artifacts").join(day).join(id);
            let body = std::fs::read_to_string(dir.join("content.txt")).unwrap();
            assert_eq!(body, format!("x{}", "🦀".repeat(999_999)));
            let m = get(dir.join("metadata.json"));
            assert_eq!(m["sourceContentChars"], 2_000_001);
            assert_eq!(m["contentChars"], 1_999_999);
        } else {
            assert_eq!(r["status"], "failed", "{case}: {r}");
            assert_eq!(
                r["error"]["code"],
                match case {
                    "body" => "response_too_large",
                    "entity" => "web_content_invalid",
                    "title" => "web_content_limit",
                    _ => "web_fetch_failed",
                }
            );
            assert!(!f.root.path().join("web-artifacts").exists());
        }
    }
}
#[test]
fn native_web_tls_uses_explicit_ca_checks_hostname_and_tunnels_through_the_configured_proxy() {
    use super::super::native_network::{
        clean_network,
        tls::{CA, ConnectProxy, TlsFront},
    };
    for case in ["untrusted", "trusted", "wrong-name", "proxy"] {
        let page = Page::new(vec![http(200, &[], b"TLS page fact")], false);
        let front = TlsFront::for_url(&page.url, case == "wrong-name");
        let proxy = ConnectProxy::new(front.address);
        let server = Server::new(vec![
            reply_tool(
                "web_fetch",
                json!({"url":front.url.replace("127.0.0.1","localhost")}),
            ),
            reply_text("TLS observation."),
        ]);
        let f = Fixture::new(&server);
        let ca = f.root.path().join("ca.pem");
        std::fs::write(&ca, CA).unwrap();
        let mut command = f.command("exec", "p");
        clean_network(&mut command);
        if case != "untrusted" {
            command.env("PEER_EXTRA_CA_CERTS", &ca);
        }
        if case == "proxy" {
            command
                .env("HTTPS_PROXY", &proxy.url)
                .env("NO_PROXY", "127.0.0.1");
        }
        success(&command.output().unwrap());
        let (r, _) = result(&f);
        if matches!(case, "untrusted" | "wrong-name") {
            assert_eq!(r["status"], "failed", "{case}: {r}");
            assert_eq!(r["error"]["code"], "web_fetch_failed");
            assert!(page.headers.lock().unwrap().is_empty());
            assert!(!f.root.path().join("web-artifacts").exists());
        } else {
            assert_eq!(r["status"], "success", "{case}: {r}");
            assert_eq!(page.headers.lock().unwrap().len(), 1);
        }
        if case == "proxy" {
            assert_eq!(proxy.headers.lock().unwrap().len(), 1);
            assert!(proxy.headers.lock().unwrap()[0].starts_with("CONNECT "));
        }
    }
}
#[test]
fn native_web_proxy_credentials_are_redacted_from_observation_and_both_artifact_formats() {
    use super::super::native_network::{ForwardProxy, clean_network};
    let page = Page::new(
        vec![http(
            200,
            &[("content-type", "text/html")],
            b"<title>synthetic-user</title><p>synthetic-proxy-secret synthetic-user</p>",
        )],
        false,
    );
    let proxy = ForwardProxy::new();
    let server = Server::new(vec![
        reply_tool("web_fetch", json!({"url":page.url})),
        reply_text("Redacted facts."),
    ]);
    let f = Fixture::new(&server);
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    let model_port = url::Url::parse(&server.url).unwrap().port().unwrap();
    command
        .env("HTTP_PROXY", &proxy.url)
        .env("NO_PROXY", format!("127.0.0.1:{model_port}"));
    success(&command.output().unwrap());
    let (r, _) = result(&f);
    assert_eq!(r["status"], "success", "{r}");
    assert_eq!(r["output"]["redacted"], true);
    assert_eq!(r["output"]["title"], "[REDACTED]");
    let reference: peer_store::ToolArtifactRef =
        serde_json::from_value(r["output"]["nativeContentRef"].clone()).unwrap();
    let saved = peer_store::ToolArtifactStore::new(f.root.path())
        .read_window("c", &reference, 0, 262144, &|| false)
        .unwrap();
    let id = r["output"]["artifactRef"]
        .as_str()
        .unwrap()
        .strip_prefix("local-web-artifact://")
        .unwrap();
    let day = &r["completedAt"].as_str().unwrap()[..10];
    let legacy = f.root.path().join("web-artifacts").join(day).join(id);
    for bytes in [
        serde_json::to_vec(&r).unwrap(),
        saved.bytes,
        std::fs::read(legacy.join("content.txt")).unwrap(),
        std::fs::read(legacy.join("metadata.json")).unwrap(),
        serde_json::to_vec(&server.requests.lock().unwrap().last().unwrap()).unwrap(),
    ] {
        let s = String::from_utf8(bytes).unwrap();
        assert!(!s.contains("synthetic-user"));
        assert!(!s.contains("synthetic-proxy-secret"));
        assert!(s.contains("[REDACTED]"));
    }
    let proxy_headers = proxy.requests.lock().unwrap();
    assert_eq!(proxy_headers.len(), 1);
    assert!(
        proxy_headers[0]
            .to_lowercase()
            .contains("proxy-authorization: basic ")
    );
    assert!(
        !page.headers.lock().unwrap()[0]
            .to_lowercase()
            .contains("proxy-authorization:")
    );
}
#[test]
fn native_web_http_error_redacts_the_final_url_without_rewriting_its_status() {
    use super::super::native_network::{ForwardProxy, clean_network};
    let page = Page::new(vec![http(404, &[], b"synthetic-proxy-secret")], false);
    let proxy = ForwardProxy::new();
    let server = Server::new(vec![
        reply_tool(
            "web_fetch",
            json!({"url":format!("{}/synthetic-user",page.url)}),
        ),
        reply_text("HTTP failure."),
    ]);
    let f = Fixture::new(&server);
    let mut command = f.command("exec", "p");
    clean_network(&mut command);
    let port = url::Url::parse(&server.url).unwrap().port().unwrap();
    command
        .env("HTTP_PROXY", &proxy.url)
        .env("NO_PROXY", format!("127.0.0.1:{port}"));
    success(&command.output().unwrap());
    let (r, _) = result(&f);
    assert_eq!(r["status"], "failed");
    assert_eq!(r["error"]["code"], "web_http_error");
    assert_eq!(r["output"]["httpStatus"], 404);
    assert_eq!(r["output"]["redacted"], true);
    assert_eq!(r["output"]["finalUrl"], format!("{}/[REDACTED]", page.url));
    assert!(!r.to_string().contains("synthetic-user"));
    assert!(!f.root.path().join("web-artifacts").exists());
}
