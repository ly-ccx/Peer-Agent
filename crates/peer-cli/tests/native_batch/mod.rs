//! Existing CLI batch search through the real native model/Host/store chain.
use super::*;
fn contract() -> Value {
    serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/batch-search.json"
    ))
    .unwrap()
}
fn saved_output(f: &Fixture, result: &Value) -> Value {
    if result["output"]["kind"] == "local_tool_result_ref" {
        let reference: peer_store::ToolArtifactRef =
            serde_json::from_value(result["output"]["nativeContentRef"].clone()).unwrap();
        let window = peer_store::ToolArtifactStore::new(f.root.path())
            .read_window("c", &reference, 0, 262144, &|| false)
            .unwrap();
        assert!(window.complete);
        serde_json::from_slice(&window.bytes).unwrap()
    } else {
        result["output"].clone()
    }
}
fn files(f: &Fixture) {
    for (name, body) in contract()["files"].as_object().unwrap() {
        let path = f.root.path().join("workspace").join(name);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body.as_str().unwrap()).unwrap();
    }
}
#[test]
fn batch_search_returns_real_matches_and_one_grant_evidence_pair() {
    let c = contract();
    let case = &c["cases"][0];
    let server = Server::new(vec![
        reply_tool("batch_search", case["input"].clone()),
        reply_text("Batch observations received."),
    ]);
    let f = Fixture::new(&server);
    files(&f);
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let tools: Vec<_> = h.iter().filter(|m| m["segments"].is_array()).collect();
    assert_eq!(tools.len(), 1);
    let tool = tools[0];
    assert_eq!(tool["permissionGrants"][0]["granted"], true);
    assert_eq!(tool["segments"][0]["result"]["status"], "success");
    assert_eq!(tool["segments"][0]["result"]["output"], case["output"]);
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests[0]["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t["function"]["name"] == "batch_search")
    );
    assert!(
        requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool"
                && m["content"].as_str().unwrap_or("").contains("alpha beta"))
    );
}

#[test]
fn actual_ts_batch_vectors_preserve_partial_failure_order_and_duplicate_hits() {
    let data = contract();
    for case in data["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| !c["output"].is_null())
    {
        let server = Server::new(vec![
            reply_tool("batch_search", case["input"].clone()),
            reply_text("Batch facts received."),
        ]);
        let f = Fixture::new(&server);
        files(&f);
        let out = f.run();
        assert!(
            out.status.success(),
            "{}: {}",
            case["name"],
            String::from_utf8_lossy(&out.stderr)
        );
        let h = f.history();
        let tool = h.iter().find(|m| m["segments"].is_array()).unwrap();
        let result = &tool["segments"][0]["result"];
        let mut expected = case["output"].clone();
        // Original OS-dependent errors remain in the oracle resource. The
        // native FileProvider reports the registered stable missing-path code.
        for lane in expected["lanes"].as_array_mut().unwrap() {
            if lane["status"] == "failed" {
                lane["errorMessage"] = json!("file_unavailable");
            }
        }
        assert_eq!(saved_output(&f, result), expected, "{}", case["name"]);
        assert_eq!(
            result["status"],
            if case["status"] == "failed" {
                "failed"
            } else {
                "success"
            }
        );
        if case["status"] == "failed" {
            assert_eq!(result["error"]["code"], "all_search_lanes_failed");
        }
        // Execution failure does not retroactively erase real read authority.
        assert_eq!(tool["permissionGrants"][0]["granted"], true);
        assert!(result["evidence"].is_object());
    }
}
#[test]
fn ask_denies_the_entire_batch_before_any_scan_and_keeps_real_evidence() {
    let server = Server::new(vec![
        reply_tool("batch_search", json!({"queries":[{"query":"source"}]})),
        reply_text("Denied."),
    ]);
    let f = Fixture::new(&server);
    let store = PolicyStore::new(f.root.path());
    let p = store.read_existing("w").unwrap();
    store
        .update_existing(
            "w",
            p.revision,
            peer_protocol::LocalAccessLevel::AskBeforeLocal,
            AT,
        )
        .unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let tool = h.iter().find(|m| m["segments"].is_array()).unwrap();
    assert_eq!(tool["permissionGrants"][0]["granted"], false);
    assert_eq!(tool["segments"][0]["result"]["status"], "denied");
    assert_eq!(tool["segments"][0]["result"]["output"], json!({}));
    assert!(tool["segments"][0]["result"]["evidence"].is_object());
}
#[test]
fn per_lane_resource_pressure_preserves_the_other_lane_and_later_task_admission() {
    let server = Server::new(vec![
        reply_tool(
            "batch_search",
            json!({"queries":[{"id":"good","query":"source","path":"input.txt"},{"id":"large","query":"needle","path":"large.txt"}]}),
        ),
        reply_text("Partial results."),
        reply_text("Later task."),
    ]);
    let f = Fixture::new(&server);
    std::fs::write(
        f.root.path().join("workspace/large.txt"),
        "needle".repeat(50000),
    )
    .unwrap();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    let h = f.history();
    let result = &h.iter().find(|m| m["segments"].is_array()).unwrap()["segments"][0]["result"];
    assert_eq!(result["status"], "success");
    assert_eq!(result["output"]["status"], "partial");
    assert_eq!(result["output"]["completedCount"], 1);
    assert_eq!(result["output"]["failedCount"], 1);
    assert_eq!(
        result["output"]["lanes"][1]["errorMessage"],
        "file_result_limit"
    );
    assert_eq!(
        result["output"]["aggregated"]["matches"][0]["text"],
        "source fact"
    );
    f.seed("p2", "c2", "s2", "work2", "epoch2");
    let later = f.command("exec", "p2").output().unwrap();
    assert!(
        later.status.success(),
        "{}",
        String::from_utf8_lossy(&later.stderr)
    );
}

#[cfg(feature = "test-fixtures")]
mod controls;
