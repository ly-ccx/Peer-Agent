//! Real native file tools, canonical permission and persisted Evidence.
use super::*;
#[test]
fn list_search_read_edit_read_cross_the_real_projection_grant_and_evidence_chain() {
    let server = Server::new(vec![
        reply_tool("list_files", json!({"path":"."})),
        reply_tool(
            "search_files",
            json!({"query":"source", "path":".","max_results":2}),
        ),
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_tool(
            "edit_file",
            json!({"path":"input.txt","old_string":"source","new_string":"edited"}),
        ),
        reply_tool("read_file", json!({"path":"input.txt"})),
        reply_text("File workflow complete."),
    ]);
    let f = Fixture::new(&server);
    let mut goal = get(f.root.path().join("goal-plans/p.json"));
    goal["delegationOrigin"]["capabilityAdmission"]["required"] =
        json!(["local.file.list", "local.file.search", "local.file.edit"]);
    put(f.root.path().join("goal-plans/p.json"), &goal);
    let output = f.command("exec", "p").output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
        "edited fact"
    );
    let receipt: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(receipt["toolCalls"], 5);
    let history = f.history();
    let tools = history
        .iter()
        .filter(|m| m["segments"].is_array())
        .collect::<Vec<_>>();
    assert_eq!(tools.len(), 5);
    for t in &tools {
        assert_eq!(t["permissionGrants"][0]["granted"], true);
        assert_eq!(t["segments"][0]["result"]["status"], "success");
        assert!(t["segments"][0]["result"]["evidence"].is_object());
    }
    let output = |i: usize| &tools[i]["segments"][0]["result"]["output"];
    assert_eq!(output(0)["entries"][0]["name"], "input.txt");
    assert_eq!(
        output(1)["matches"][0],
        json!({"path":"input.txt","line":1,"text":"source fact"})
    );
    assert_eq!(output(2)["content"], "source fact");
    assert_eq!(output(4)["content"], "edited fact");
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 6);
    let names = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["function"]["name"].as_str().unwrap())
        .collect::<Vec<_>>();
    for name in [
        "read_file",
        "list_files",
        "search_files",
        "edit_file",
        "write_file",
    ] {
        assert!(names.contains(&name));
    }
}

#[test]
fn actual_ts_file_provider_vectors_match_native_results_and_persisted_evidence() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/file-operations.json"
    ))
    .unwrap();
    for case in data["cases"].as_array().unwrap() {
        let steps = case["steps"].as_array().unwrap();
        let mut replies = steps
            .iter()
            .map(|s| {
                reply_tool(
                    match s["capability"].as_str().unwrap() {
                        "local.file.read" => "read_file",
                        "local.file.list" => "list_files",
                        "local.file.search" => "search_files",
                        "local.file.edit" => "edit_file",
                        _ => panic!("unknown fixture tool"),
                    },
                    s["args"].clone(),
                )
            })
            .collect::<Vec<_>>();
        replies.push(reply_text("File vectors complete."));
        let server = Server::new(replies);
        let f = Fixture::new(&server);
        std::fs::remove_file(f.root.path().join("workspace/input.txt")).unwrap();
        for (name, value) in case["files"].as_object().unwrap() {
            let path = f.root.path().join("workspace").join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            let bytes = if let Some(text) = value.as_str() {
                text.as_bytes().to_vec()
            } else if let Some(hex) = value["hex"].as_str() {
                hex.as_bytes()
                    .as_chunks::<2>()
                    .0
                    .iter()
                    .map(|s| u8::from_str_radix(std::str::from_utf8(s).unwrap(), 16).unwrap())
                    .collect()
            } else {
                value["repeat"]
                    .as_str()
                    .unwrap()
                    .repeat(value["count"].as_u64().unwrap() as usize)
                    .into_bytes()
            };
            std::fs::write(path, bytes).unwrap();
        }
        let out = f.run();
        assert!(
            out.status.success(),
            "{}: {}",
            case["name"],
            String::from_utf8_lossy(&out.stderr)
        );
        let history = f.history();
        let tools = history
            .iter()
            .filter(|m| m["segments"].is_array())
            .collect::<Vec<_>>();
        assert_eq!(tools.len(), steps.len());
        for (i, (step, message)) in steps.iter().zip(tools).enumerate() {
            assert_eq!(message["permissionGrants"][0]["granted"], true);
            let r = &message["segments"][0]["result"];
            let expected = &step["expected"];
            assert_eq!(
                r["status"],
                if expected["status"] == "completed" {
                    "success"
                } else {
                    "failed"
                },
                "{}/{}",
                case["name"],
                i
            );
            assert_eq!(
                r["error"]["code"], expected["error"],
                "{}/{}",
                case["name"], i
            );
            if expected["status"] == "completed" {
                assert_eq!(r["output"], expected["output"], "{}/{}", case["name"], i);
            }
            assert!(r["evidence"].is_object());
        }
    }
}

#[test]
fn file_scan_limits_fail_explicitly_and_special_files_do_not_block_later_work() {
    let server = Server::new(vec![
        reply_tool("list_files", json!({"path":"many"})),
        reply_tool("search_files", json!({"path":"many","query":"needle"})),
        reply_tool("read_file", json!({"path":"pipe"})),
        reply_tool("list_files", json!({"path":"."})),
        reply_text("Bounded scans complete."),
    ]);
    let f = Fixture::new(&server);
    let many = f.root.path().join("workspace/many");
    std::fs::create_dir(&many).unwrap();
    for i in 0..16385 {
        std::fs::File::create(many.join(format!("file-{i}"))).unwrap();
    }
    let fifo = f.root.path().join("workspace/pipe");
    assert!(
        Command::new("/usr/bin/mkfifo")
            .arg(&fifo)
            .status()
            .unwrap()
            .success()
    );
    let at = Instant::now();
    let out = f.run();
    assert!(
        out.status.success(),
        "{}",
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(at.elapsed() < Duration::from_secs(15));
    let h = f.history();
    let results = h
        .iter()
        .flat_map(|m| m["segments"].as_array().into_iter().flatten())
        .map(|s| &s["result"])
        .collect::<Vec<_>>();
    assert_eq!(results[0]["error"]["code"], "file_collection_limit");
    assert_eq!(results[1]["error"]["code"], "file_collection_limit");
    assert_eq!(results[2]["error"]["code"], "not_a_file");
    assert_eq!(results[3]["status"], "success");
    assert!(
        results[3]["output"]["entries"]
            .as_array()
            .unwrap()
            .iter()
            .any(|e| e["name"] == "pipe" && e["type"] == "other")
    );
}

#[test]
fn failed_read_does_not_create_an_edit_snapshot_and_denial_preserves_content() {
    for denial in [false, true] {
        let server = Server::new(if denial {
            vec![
                reply_tool("read_file", json!({"path":"input.txt"})),
                reply_tool(
                    "edit_file",
                    json!({"path":"input.txt","old_string":"source","new_string":"edited"}),
                ),
                reply_text("Denied edit."),
            ]
        } else {
            vec![
                reply_tool("read_file", json!({"path":"input.txt","start_line":2})),
                reply_tool(
                    "edit_file",
                    json!({"path":"input.txt","old_string":"tail","new_string":"end"}),
                ),
                reply_text("Failed bounded read."),
            ]
        });
        let f = Fixture::new(&server);
        let original = if denial {
            "source fact".to_owned()
        } else {
            "unread tail".to_owned()
        };
        std::fs::write(f.root.path().join("workspace/input.txt"), &original).unwrap();
        if denial {
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
        }
        let out = f.run();
        assert!(
            out.status.success(),
            "{}",
            String::from_utf8_lossy(&out.stderr)
        );
        assert_eq!(
            std::fs::read_to_string(f.root.path().join("workspace/input.txt")).unwrap(),
            original
        );
        let h = f.history();
        let tools = h
            .iter()
            .flat_map(|m| m["segments"].as_array().into_iter().flatten())
            .collect::<Vec<_>>();
        if denial {
            assert_eq!(tools[1]["result"]["status"], "denied");
        } else {
            assert_eq!(
                tools[0]["result"]["error"]["code"],
                "start_line_out_of_range"
            );
            assert_eq!(tools[1]["result"]["error"]["code"], "read_required");
        }
    }
}
