//! Same production network Module for token exchange and generation.
use super::*;
#[test]
fn oauth_refresh_and_native_tools_use_proxy_once_and_pre_send_proxy_failure_is_recoverable() {
    let idp = Idp::new(refreshed(), "200 OK", false, false);
    let model = Server::new(vec![
        stream("openai-responses", "tool"),
        stream("openai-responses", "text"),
    ]);
    let proxy = native_network::ForwardProxy::new();
    let f = Fixture::new(&model);
    configure(&f, "oauth_chatgpt", &idp.url, &model.url, false);
    let old = raw_token(&f);
    let out = command(&f, "p")
        .env("NO_PROXY", "")
        .env("HTTP_PROXY", "socks://not-supported.invalid")
        .output()
        .unwrap();
    assert!(!out.status.success());
    assert!(String::from_utf8_lossy(&out.stderr).contains("network_proxy_invalid"));
    assert!(idp.requests.lock().unwrap().is_empty());
    assert!(model.requests.lock().unwrap().is_empty());
    assert_eq!(raw_token(&f), old);
    seed_next(&f);
    let out = command(&f, "next")
        .env("NO_PROXY", "")
        .env("HTTP_PROXY", &proxy.url)
        .output()
        .unwrap();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert_eq!(raw_token(&f)["access"], "synthetic-new-access");
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    let headers = proxy.requests.lock().unwrap();
    assert_eq!(headers.len(), 3);
    assert_eq!(headers.iter().filter(|h| h.contains("/token ")).count(), 1);
    assert!(
        headers
            .iter()
            .all(|h| h.to_lowercase().contains("proxy-authorization: basic"))
    );
    let history =
        std::fs::read_to_string(f.root.path().join("conversations/next-c.jsonl")).unwrap();
    let tool = history
        .lines()
        .map(|s| serde_json::from_str::<Value>(s).unwrap())
        .find(|v| v["segments"].is_array())
        .unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    assert!(!history.contains("synthetic-proxy-secret"));
    assert!(!String::from_utf8_lossy(&out.stdout).contains("synthetic-proxy-secret"));
}
