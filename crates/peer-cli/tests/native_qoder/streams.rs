//! Qoder's existing sparse Chat and content-block variants cross the real Host.
use super::*;
fn vectors() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/qoder-streams.json"
    ))
    .unwrap()
}
#[test]
fn complete_sparse_qoder_streams_execute_only_their_validated_tools_and_keep_evidence() {
    for c in vectors()["cases"].as_array().unwrap() {
        let calls = c["expected"]["calls"].as_array().unwrap();
        let mut replies = vec![c["stream"].as_str().unwrap().to_owned()];
        if !calls.is_empty() {
            replies.push(reply_text("Native variant complete."));
        }
        let server = Server::new(replies);
        let f = Fixture::new(&server);
        configure(&f, &server);
        let output = command(&f).output().unwrap();
        assert!(
            output.status.success(),
            "{}: {}",
            c["name"],
            String::from_utf8_lossy(&output.stderr)
        );
        let r: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(r["toolCalls"], calls.len());
        assert_eq!(
            server.requests.lock().unwrap().len(),
            if calls.is_empty() { 1 } else { 2 }
        );
        for call in calls {
            assert_eq!(
                std::fs::read_to_string(
                    f.root
                        .path()
                        .join("workspace")
                        .join(call["arguments"]["path"].as_str().unwrap())
                )
                .unwrap(),
                "native"
            );
        }
        let history = f.history();
        let tools = history
            .iter()
            .filter(|m| m["segments"].is_array())
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), calls.len());
        for tool in tools {
            assert_eq!(tool["permissionGrants"][0]["granted"], true);
            assert_eq!(tool["segments"][0]["result"]["status"], "success");
            assert!(tool["segments"][0]["result"]["evidence"].is_object());
        }
        if c["expected"]["usage"].is_null() {
            assert_eq!(f.budget(|_| {})["unknownUsage"], true);
        } else {
            assert_eq!(
                r["usage"]["totalTokens"],
                c["expected"]["usage"]["totalTokens"].as_u64().unwrap()
                    + if calls.is_empty() { 0 } else { 16 }
            );
        }
        if !c["expected"]["thinking"].as_str().unwrap().is_empty() {
            let persisted = serde_json::to_string(&history).unwrap();
            assert!(
                !persisted.contains("Observed thought."),
                "thinking is live continuation, not persisted history"
            );
        }
    }
}
#[test]
fn incomplete_or_conflicting_qoder_variants_cannot_execute_and_later_tasks_can_run() {
    let data = vectors();
    let chat = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "plain-sparse-chat-tool")
        .unwrap()["stream"]
        .as_str()
        .unwrap();
    let block = data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "plain-sparse-block-tool-stop")
        .unwrap()["stream"]
        .as_str()
        .unwrap();
    let evil = json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"other-id","function":{"name":"write_file","arguments":"{}"}}]}}]});
    let rejected=vec![chat.replace("data: [DONE]\n\n",""),block.replace("data: {\"type\":\"message_stop\"}\n\n",""),
        chat.replace("data: [DONE]",&format!("data: {evil}\n\ndata: [DONE]")),
        chat.replace("data: [DONE]", "data: {\"error\":{\"message\":\"rejected\"}}\n\ndata: [DONE]"),
        block.replace("data: {\"type\":\"content_block_stop\",\"index\":0}\n\n", ""),
        chat.replace("data: [DONE]", "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"length\"}]}\n\ndata: [DONE]")];
    for stream in rejected {
        let known = stream.contains("\"prompt_tokens\"");
        let server = Server::new(vec![stream, reply_text("Later safe task.")]);
        let f = Fixture::new(&server);
        configure(&f, &server);
        let output = command(&f).output().unwrap();
        assert!(!output.status.success());
        assert!(!f.root.path().join("workspace/stream.txt").exists());
        assert_eq!(server.requests.lock().unwrap().len(), 1);
        if known {
            assert_eq!(ledger_rows(&f)[0]["totalTokens"], 16);
            assert_eq!(f.budget(|_| {})["tokens"], 16);
        } else {
            assert_eq!(f.budget(|_| {})["unknownUsage"], true);
        }
        assert!(f.history().iter().all(|m| !m["segments"].is_array()));
        let original = f.history();
        f.seed("later", "later-c", "later-s", "later-work", "later-epoch");
        let mut goal = get(f.root.path().join("goal-plans/later.json"));
        for role in ["worker", "explorer", "verifier"] {
            goal["delegationOrigin"]["modelSelection"][role]["modelId"] = json!("auto");
            goal["delegationOrigin"]["modelSelection"][role]["family"] = json!("qoder");
        }
        put(f.root.path().join("goal-plans/later.json"), &goal);
        assert!(command_plan(&f, "later").output().unwrap().status.success());
        assert_eq!(f.history(), original);
    }
}
