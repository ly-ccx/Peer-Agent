//! Public native Grok subscription entry, shared encrypted Vault, actual HTTP and tools.
use super::*;
mod device;
mod pinned_network;
mod transport;
fn grok_config(f: &Fixture, token: &str, base: &str, version: &str, fresh: bool) {
    configure(f, "oauth_grok", token, base, fresh);
    let file = f.root.path().join("llm-providers.json");
    let mut config = get(&file);
    config["channels"][0]["channelId"] = json!("grok");
    config["models"][0]["model"] = json!("grok-4.5");
    put(file, &config);
    let file = f.root.path().join("goal-plans/p.json");
    let mut goal = get(&file);
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("grok-4.5");
    }
    put(file, &goal);
    let file = f.root.path().join(".native-model-oauth-fixture.json");
    let mut fixture = get(&file);
    fixture["versionUrl"] = json!(version);
    put(file, &fixture);
    let mut tokens: Value =
        serde_json::from_str(vault(f, "get", None)["secret"].as_str().unwrap()).unwrap();
    tokens["scope"] = json!("api:access grok-cli:access");
    tokens["provider"] = json!("grok");
    tokens["issuer"] = json!("https://auth.x.ai");
    tokens["clientId"] = json!("b1a00492-073a-47ea-816f-4c329264a828");
    vault(f, "set", Some(&tokens));
}
#[test]
fn native_grok_subscription_refreshes_then_runs_the_real_tool_and_keeps_channel_headers_separate() {
    let idp=Idp::new(json!({"access_token":"synthetic-grok-access","refresh_token":"synthetic-grok-refresh","expires_in":3600,"scope":"grok-cli:access api:access"}).to_string(),"200 OK",false,false);
    let version = Server::new(vec!["HTTP/1.1 200 OK\r\nContent-Type: text/plain\r\nContent-Length: 7\r\nConnection: close\r\n\r\n1.0.77\n".into()]);
    let model = Server::new(vec![
        stream("openai-responses", "tool"),
        stream("openai-responses", "text"),
    ]);
    let f = Fixture::new(&model);
    grok_config(&f, &idp.url, &model.url, &version.url, false);
    let output = command(&f, "p").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(idp.requests.lock().unwrap().len(), 1);
    assert_eq!(version.requests.lock().unwrap().len(), 1);
    assert_eq!(model.requests.lock().unwrap().len(), 2);
    let rows = f.history();
    let tool = rows.iter().find(|v| v["segments"].is_array()).unwrap();
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    for headers in model.request_headers.lock().unwrap().iter() {
        assert!(headers.contains("x-grok-client-version: 1.0.77"));
        assert!(headers.contains("x-xai-token-auth: xai-grok-cli"));
        assert!(!headers.contains("chatgpt-account-id:"));
        assert!(headers.contains("Bearer synthetic-grok-access"));
    }
}
