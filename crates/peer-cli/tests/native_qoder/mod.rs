//! Public CLI, synthetic official-format login files and actual HTTP/tool/store.
use super::*;
use base64::{Engine, engine::general_purpose::STANDARD};
use md5::{Digest, Md5};
fn configure(f: &Fixture, server: &Server) -> Vec<u8> {
    f.use_wire("qoder-private", "qoder", "qoder");
    let mut config = get(f.root.path().join("llm-providers.json"));
    config["channels"][0]["authMethod"] = json!("qoder_local_auth");
    config["models"][0]["model"] = json!("auto");
    put(f.root.path().join("llm-providers.json"), &config);
    let mut goal = get(f.root.path().join("goal-plans/p.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
    }
    put(f.root.path().join("goal-plans/p.json"), &goal);
    let root = f.root.path().join(".qoder");
    std::fs::create_dir_all(root.join(".auth")).unwrap();
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-formats.json"
    ))
    .unwrap();
    let case = data["credential"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| {
            c["key"] == "0123456789abcdef"
                && c["plain"] == r#"{"uid":"fixture","security_oauth_token":"SYNTHETIC"}"#
        })
        .unwrap();
    let cipher = case["encoded"].as_str().unwrap().as_bytes().to_vec();
    std::fs::write(root.join(".auth/user"), &cipher).unwrap();
    std::fs::write(root.join(".auth/machine_id"), "0123456789abcdef-fixture").unwrap();
    std::fs::create_dir_all(root.join(".cache")).unwrap();
    put(
        root.join(".cache/endpoint-cache.json"),
        &json!({"entries":{"prod":{"endpoint":server.url.trim_end_matches("/v1")}}}),
    );
    cipher
}
fn command(f: &Fixture) -> Command {
    command_plan(f, "p")
}
fn command_plan(f: &Fixture, plan: &str) -> Command {
    let mut command = f.command("exec", plan);
    for name in [
        "QODER_CONFIG_DIR",
        "QODER_CLI_HOME",
        "QODER_ACCESS_TOKEN",
        "QODER_PERSONAL_ACCESS_TOKEN",
        "QODER_PAT",
        "QODER_INFERENCE_ENDPOINT",
        "QODER_INFER_ENDPOINT",
        "QODER_ENV",
        "QODER_ENVIRONMENT",
        "QODER_CLIENT_TYPE",
        "QODER_BUSINESS_PRODUCT",
        "QODER_BUSINESS_TYPE",
        "QODER_SCENE",
        "QODER_SESSION_TYPE",
        "QODER_MODEL_SERVER_HOST",
    ] {
        command.env_remove(name);
    }
    command
}
fn wrapped(reply: String) -> String {
    reply
        .split('\n')
        .map(|line| {
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    line.into()
                } else {
                    format!("data: {}", json!({"status":200,"body":data}))
                }
            } else {
                line.into()
            }
        })
        .collect::<Vec<String>>()
        .join("\n")
}
#[test]
fn qoder_native_login_generated_auth_encoded_requests_tools_and_evidence_form_one_loop() {
    let server = Server::new(vec![
        wrapped(reply_tool("read_file", json!({"path":"input.txt"}))),
        wrapped(reply_tool(
            "write_file",
            json!({"path":"qoder.txt","content":"native Qoder"}),
        )),
        wrapped(reply_text("Native Qoder complete.")),
    ]);
    let f = Fixture::new(&server);
    let cipher = configure(&f, &server);
    let output = command(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["toolCalls"], 2);
    assert_eq!(result["goalAcceptance"], "pending");
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/qoder.txt")).unwrap(),
        "native Qoder"
    );
    assert_eq!(
        std::fs::read(f.root.path().join(".qoder/.auth/user")).unwrap(),
        cipher
    );
    let history = f.history();
    let calls: Vec<_> = history
        .iter()
        .filter(|v| v["segments"].is_array())
        .collect();
    assert_eq!(calls.len(), 2);
    for call in &calls {
        assert_eq!(call["segments"][0]["result"]["status"], "success");
        assert!(call["segments"][0]["result"]["evidence"].is_object());
    }
    assert!(
        f.root
            .path()
            .join("goal-plans/evidence-index.jsonl")
            .is_file()
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert!(server.count_requests.lock().unwrap().is_empty());
    for request in &*requests {
        assert_eq!(request["chat_task"], "FREE_INPUT");
        assert_eq!(request["model_config"]["key"], "auto");
        assert!(request["tools"].as_array().is_some_and(|a| !a.is_empty()));
    }
    assert!(
        requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool")
    );
    for (header, bytes) in server
        .request_headers
        .lock()
        .unwrap()
        .iter()
        .zip(server.request_bytes.lock().unwrap().iter())
    {
        assert!(header.starts_with("POST /algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1 "));
        let auth = header
            .lines()
            .find_map(|l| l.strip_prefix("authorization: "))
            .unwrap();
        assert!(auth.starts_with("Bearer COSY."));
        let envelope: Value =
            serde_json::from_slice(&STANDARD.decode(auth.split('.').nth(1).unwrap()).unwrap())
                .unwrap();
        assert_eq!(envelope["cosyVersion"], "1.0.39");
        assert!(!envelope["info"].as_str().unwrap().is_empty());
        let field = |name: &str| {
            header
                .lines()
                .find_map(|line| line.strip_prefix(name))
                .unwrap()
        };
        let preimage = [
            auth.split('.').nth(1).unwrap(),
            field("cosy-key: "),
            field("cosy-date: "),
            std::str::from_utf8(bytes).unwrap(),
            "/api/v2/service/pro/sse/agent_chat_generation",
        ]
        .join("\n");
        assert_eq!(
            auth.split('.').nth(2).unwrap(),
            format!("{:x}", Md5::digest(preimage.as_bytes()))
        );
    }
    let persisted = history
        .iter()
        .map(Value::to_string)
        .collect::<Vec<_>>()
        .join("\n");
    assert!(!persisted.contains("SYNTHETIC"));
    assert!(!persisted.contains("Bearer COSY"));
}
#[test]
fn qoder_denial_persists_without_effect_and_later_task_can_run() {
    let server = Server::new(vec![
        reply_tool(
            "write_file",
            json!({"path":"denied-qoder.txt","content":"never"}),
        ),
        reply_text("Denied."),
        reply_text("Later task accepted."),
    ]);
    let f = Fixture::new(&server);
    configure(&f, &server);
    let store = PolicyStore::new(f.root.path());
    let old = store.read_existing("w").unwrap();
    store
        .update_existing(
            "w",
            old.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let output = command(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!f.root.path().join("workspace/denied-qoder.txt").exists());
    assert_eq!(f.history()[1]["segments"][0]["result"]["status"], "denied");
    f.seed("next", "next-c", "next-s", "next-work", "next-epoch");
    let mut goal = get(f.root.path().join("goal-plans/next.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
        goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
    }
    put(f.root.path().join("goal-plans/next.json"), &goal);
    let output = command_plan(&f, "next").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
}
#[test]
fn qoder_corrupt_or_env_only_login_fails_before_network_and_preserves_source() {
    for env_only in [false, true] {
        let server = Server::new(vec![]);
        let f = Fixture::new(&server);
        configure(&f, &server);
        let path = f.root.path().join(".qoder/.auth/user");
        let bytes = b"invalid-cipher";
        std::fs::write(&path, bytes).unwrap();
        let mut command = command(&f);
        if env_only {
            command.env("QODER_ACCESS_TOKEN", "SYNTHETIC-ENV");
        }
        let output = command.output().unwrap();
        assert!(!output.status.success());
        let error = String::from_utf8_lossy(&output.stderr);
        assert!(
            error.contains(if env_only {
                "qoder_local_user_info_required"
            } else {
                "qoder_auth_invalid"
            }),
            "{error}"
        );
        assert!(server.requests.lock().unwrap().is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
    }
}
#[test]
fn qoder_credential_rotation_after_a_real_tool_blocks_the_next_send_without_erasing_evidence() {
    let server = Server::new(vec![reply_tool(
        "bash",
        json!({"command":"printf changed > ../.qoder/.auth/user"}),
    )]);
    let f = Fixture::new(&server);
    let original = configure(&f, &server);
    let output = command(&f).output().unwrap();
    assert!(!output.status.success());
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("qoder_auth_changed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
    let history = f.history();
    let tool = history.iter().find(|v| v["segments"].is_array()).unwrap();
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    assert_eq!(
        std::fs::read(f.root.path().join(".qoder/.auth/user")).unwrap(),
        b"changed"
    );
    let before = std::fs::read(f.root.path().join("conversations/c.jsonl")).unwrap();
    std::fs::write(f.root.path().join(".qoder/.auth/user"), original).unwrap();
    f.seed(
        "repaired",
        "repaired-c",
        "repaired-s",
        "repaired-work",
        "repaired-epoch",
    );
    let mut goal = get(f.root.path().join("goal-plans/repaired.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
        goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
    }
    put(f.root.path().join("goal-plans/repaired.json"), &goal);
    let output = command_plan(&f, "repaired").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read(f.root.path().join("conversations/c.jsonl")).unwrap(),
        before
    );
}
#[test]
fn qoder_sdk_encrypted_catalog_supplies_model_and_selected_context_tier_without_a_vm() {
    let server = Server::new(vec![reply_text("Encrypted catalog selected.")]);
    let f = Fixture::new(&server);
    configure(&f, &server);
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-requests.json"
    ))
    .unwrap();
    let case = &data["encryptedCatalogs"][1];
    let root = f.root.path().join(".qoder/.models");
    std::fs::create_dir_all(root.join("fixture")).unwrap();
    put(root.join("default"), &json!({"uid":"fixture"}));
    std::fs::write(
        root.join("fixture/catalog-v5"),
        case["encoded"].as_str().unwrap(),
    )
    .unwrap();
    let mut config = get(f.root.path().join("llm-providers.json"));
    config["models"][0]["model"] = json!("fixture");
    config["models"][0]["modelOptionValues"] = json!({"contextTier":"400K"});
    put(f.root.path().join("llm-providers.json"), &config);
    let mut goal = get(f.root.path().join("goal-plans/p.json"));
    for role in ["worker", "explorer", "verifier"] {
        goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("fixture");
    }
    put(f.root.path().join("goal-plans/p.json"), &goal);
    let output = command(&f).output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0]["model_config"]["key"], "fixture");
    assert_eq!(requests[0]["model_config"]["contextTier"], "400K");
    assert_eq!(requests[0]["model_config"]["max_input_tokens"], 400000);
    assert_eq!(requests[0]["model_config"]["display_name"], "Model");
    assert_eq!(
        std::fs::read_to_string(root.join("fixture/catalog-v5")).unwrap(),
        case["encoded"].as_str().unwrap()
    );
}
#[test]
fn qoder_outer_business_error_cannot_hide_behind_an_inner_executable_tool() {
    for (outer, code) in [
        (
            json!({"code":"10605","message":{"isQueued":true}}),
            "work_budget_limited",
        ),
        (
            json!({"statusCodeValue":"401","status":200}),
            "qoder_stream_rejected",
        ),
        (json!({"code":"103"}), "work_budget_limited"),
    ] {
        let raw = reply_tool(
            "write_file",
            json!({"path":"business-error-must-not-write.txt","content":"never"}),
        );
        let rejected = raw
            .split('\n')
            .map(|line| {
                if let Some(body) = line.strip_prefix("data: ").filter(|s| *s != "[DONE]") {
                    let mut event = outer.clone();
                    event["body"] = json!(body);
                    format!("data: {event}")
                } else {
                    line.into()
                }
            })
            .collect::<Vec<String>>()
            .join("\n");
        let server = Server::new(vec![rejected]);
        let f = Fixture::new(&server);
        configure(&f, &server);
        f.budget(|b| b["limits"] = json!({"maxModelRequests":1}));
        let output = command(&f).output().unwrap();
        assert!(
            !f.root
                .path()
                .join("workspace/business-error-must-not-write.txt")
                .exists(),
            "an outer business rejection must not expose the inner tool intent"
        );
        assert!(!output.status.success());
        assert!(String::from_utf8_lossy(&output.stderr).contains(code));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        assert!(f.history().iter().all(|v| !v["segments"].is_array()));
    }
}

mod legacy;

mod network;

mod retry;

mod options;

mod streams;
