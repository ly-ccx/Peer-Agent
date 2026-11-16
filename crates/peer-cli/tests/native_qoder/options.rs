//! Actual native factory/Host requests compared with the complete public TS
//! sender, not only its pure builder. Every store and account is synthetic.
use super::*;
fn configure_case(f: &Fixture, server: &Server, c: &Value) {
    configure(f, server);
    legacy::select(f, c["model"].as_str().unwrap());
    if !c["catalog"].is_null() {
        put(f.root.path().join(".qoder/.auth/models"), &c["catalog"]);
    }
    let mut goal = get(f.root.path().join("goal-plans/p.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["reasoningEffort"] = c["effort"].clone();
    }
    put(f.root.path().join("goal-plans/p.json"), &goal);
    let mut config = get(f.root.path().join("llm-providers.json"));
    if let Some(options) = c.get("modelOptions") {
        config["models"][0]["modelOptions"] = options.clone();
    }
    config["models"][0]["modelOptionValues"] = c["modelOptionValues"].clone();
    config["models"][0]["maxOutputTokens"] = c["maxOutputTokens"].clone();
    put(f.root.path().join("llm-providers.json"), &config);
}
#[test]
fn complete_public_sender_metadata_vectors_reach_native_requests_tools_and_evidence() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-caller.json"
    ))
    .unwrap();
    for case in data["cases"].as_array().unwrap() {
        let server = Server::new(vec![
            reply_tool(
                "write_file",
                json!({"path":"caller.txt","content":case["name"]}),
            ),
            reply_text("Native caller complete."),
        ]);
        let f = Fixture::new(&server);
        configure_case(&f, &server, case);
        let config_path = f.root.path().join("llm-providers.json");
        let before = std::fs::read(&config_path).unwrap();
        let output = command(&f).output().unwrap();
        assert!(
            output.status.success(),
            "{}: {}",
            case["name"],
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read(&config_path).unwrap(), before);
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/caller.txt")).unwrap(),
            case["name"].as_str().unwrap()
        );
        let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(receipt["toolCalls"], 1);
        assert_eq!(receipt["usage"]["totalTokens"], 32);
        assert_eq!(receipt["contextAccounting"]["authoritativeInputTokens"], 12);
        if case["expectation"]["dialect"] == "prepared" {
            assert_eq!(
                receipt["contextAccounting"]["contextWindow"],
                case["expectation"]["window"]
            );
        }
        let history = f.history();
        let tool = history.iter().find(|m| m["segments"].is_array()).unwrap();
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert_eq!(tool["segments"][0]["result"]["status"], "success");
        assert!(tool["segments"][0]["result"]["evidence"].is_object());
        let headers = server.request_headers.lock().unwrap();
        let requests = server.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        for (header, request) in headers.iter().zip(requests.iter()) {
            if case["expectation"]["dialect"] == "prepared" {
                assert!(
                    header.starts_with("POST /algo/api/v2/service/pro/sse/agent_chat_generation?")
                );
                assert_eq!(
                    request["model_config"], case["expected"]["modelConfig"],
                    "{}",
                    case["name"]
                );
                assert_eq!(request["parameters"], case["expected"]["parameters"]);
            } else {
                assert!(header.starts_with("POST /v1/chat/completions "));
                assert_eq!(request["model"], case["model"]);
                assert_eq!(request["max_tokens"], case["maxOutputTokens"]);
                assert!(request["model_config"].is_null());
            }
        }
    }
}
#[test]
fn changing_selected_options_after_a_tool_blocks_old_request_then_fresh_work_uses_new_selection() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-caller.json"
    ))
    .unwrap();
    let case = &data["cases"][0];
    let server = Server::new(vec![
        reply_tool(
            "bash",
            json!({"command":"/bin/cp next-config.json ../llm-providers.json"}),
        ),
        reply_text("Fresh selection complete."),
    ]);
    let f = Fixture::new(&server);
    configure_case(&f, &server, case);
    let mut config = get(f.root.path().join("llm-providers.json"));
    config["models"][0]["modelOptionValues"] = json!({"contextTier":"small"});
    put(f.root.path().join("workspace/next-config.json"), &config);
    let output = command(&f).output().unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("model_configuration_changed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
    let history = f.history();
    let tool = history.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    f.seed("later", "later-c", "later-s", "later-work", "later-epoch");
    let mut goal = get(f.root.path().join("goal-plans/later.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = case["model"].clone();
        goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
    }
    put(f.root.path().join("goal-plans/later.json"), &goal);
    let output = command_plan(&f, "later").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert_eq!(requests[0]["model_config"]["contextTier"], "tier-large");
    assert_eq!(requests[1]["model_config"]["contextTier"], "tier-small");
    assert_eq!(f.history(), history);
}
