use super::*;
use crate::native_conversation::goal_read::last_tool;

fn plan(fixture: &Ordinary) -> Value {
    let root = fixture.home().join("goal-plans");
    let index = std::fs::read_to_string(root.join("index.jsonl")).unwrap();
    let row: Value = serde_json::from_str(index.trim()).unwrap();
    get(root.join(format!("{}.json", row["planId"].as_str().unwrap())))
}

fn parent_replies() -> [String; 3] {
    [
        reply_tool(
            "goal_create_plan",
            json!({"title":"Inspect fixture","goal":"Use only actual read evidence",
            "tasks":[{"taskId":"inspect","title":"Keep the parent goal pending"}]}),
        ),
        reply_tool(
            "request_explorer",
            json!({"question":"What is in the test file?","reason":"Read to ground the plan",
            "scope":{"include":["actual.txt"],"exclude":["other.txt"]}}),
        ),
        reply_text("Explorer was requested."),
    ]
}

#[test]
fn public_goal_explorer_runs_readonly_with_its_own_history_and_authoritative_evidence() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("actual.txt"),
        "exact Explorer observation\n",
    )
    .unwrap();
    let mut replies = parent_replies().into_iter();
    let mut turn = 0;
    let model = Server::scripted(
        move |request| {
            turn += 1;
            if let Some(reply) = replies.next() {
                if turn == 3 {
                    let registered = last_tool(request);
                    assert_eq!(registered["output"]["registered"], true, "{registered}");
                    assert_ne!(registered["output"]["completed"], true);
                }
                return reply;
            }
            if turn == 4 {
                let tools = request["tools"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|v| v["function"]["name"].as_str().unwrap())
                    .collect::<std::collections::BTreeSet<_>>();
                assert_eq!(
                    tools,
                    [
                        "batch_search",
                        "git_query",
                        "list_files",
                        "read_file",
                        "search_files"
                    ]
                    .into_iter()
                    .collect()
                );
                assert!(!request.to_string().contains("private parent request"));
                assert!(request.to_string().contains("Explorer readonly contract"));
                return reply_tool("read_file", json!({"path":"actual.txt"}));
            }
            let actual = last_tool(request);
            assert_eq!(actual["preview"], "exact Explorer observation\n");
            reply_text(&json!({"summary":"Read the exact test file", "confidence":"high", "evidenceRefs":["tool-result://invented"],
            "findings":[{"claim":"Observed file content","evidenceRefs":[actual["evidenceRefs"][0]]},
            {"claim":"Unobserved claim","evidenceRefs":["tool-result://invented"]}]}).to_string())
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&model),
        &[
            "--access",
            "full",
            "--output-format",
            "json",
            "private parent request",
        ],
        None,
    );
    assert!(output.status.success(), "{output:?}");
    let result = fixture.assert_settled(&output, 3, 3);
    assert_eq!(result["result"], "Explorer was requested.");
    assert_eq!(result["usage"]["providerRequestCount"], 5);
    let plan = plan(&fixture);
    let worker = &plan["runner"]["explorers"][0];
    assert_eq!(plan["tasks"][0]["status"], "pending");
    assert_eq!(worker["status"], "completed");
    assert_eq!(worker["report"]["findings"].as_array().unwrap().len(), 1);
    assert_eq!(
        worker["report"]["findings"][0]["claim"],
        "Observed file content"
    );
    let ref_value = worker["report"]["evidenceRefs"][0]
        .as_str()
        .unwrap()
        .to_owned();
    assert_ne!(ref_value, "tool-result://invented");
    let evidence = peer_store::EvidenceIndexStore::new(fixture.home())
        .find(&[ref_value], None)
        .unwrap();
    assert_eq!(evidence[0]["toolName"], "read_file");
    assert_eq!(evidence[0]["planId"], plan["planId"]);
    let history = ConversationStore::new(fixture.home())
        .read_committed(result["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let worker_rows = history
        .history
        .messages
        .iter()
        .filter(|row| row["nativeExplorerId"] == worker["explorerId"])
        .collect::<Vec<_>>();
    assert_eq!(worker_rows.len(), 3);
    assert!(
        worker_rows
            .iter()
            .all(|row| row["kind"] == "agent_activity")
    );
}

#[test]
fn public_goal_explorer_denies_outside_git_and_file_reads_even_under_full_access() {
    let fixture = Ordinary::new();
    let outside = tempfile::tempdir().unwrap();
    let secret = outside.path().join("out.txt");
    std::fs::write(&secret, "fixture not admitted to Explorer").unwrap();
    std::os::unix::fs::symlink(&secret, fixture.workspace().join("alias.txt")).unwrap();
    let mut replies = parent_replies().to_vec();
    replies.push(reply_tool(
        "git_query",
        json!({"path":outside.path(),"operation":"snapshot"}),
    ));
    replies.push(reply_tool("read_file", json!({"path":secret})));
    replies.push(reply_tool("list_files", json!({"path":outside.path()})));
    replies.push(reply_tool(
        "search_files",
        json!({"path":"alias.txt","query":"not admitted"}),
    ));
    replies.push(reply_text(
        "{\"evidenceRefs\":[\"tool-result://made-up\"],\"summary\":\"Unsupported claim\"}",
    ));
    let model = Server::new(replies);
    let output = fixture.run(
        Some(&model),
        &[
            "--access",
            "full",
            "--output-format",
            "json",
            "Run the bounded Explorer",
        ],
        None,
    );
    assert!(!output.status.success());
    let result = fixture.assert_settled(&output, 3, 6);
    assert_eq!(result["error"], "explorer_completed_without_tool_evidence");
    let worker = plan(&fixture)["runner"]["explorers"][0].clone();
    assert_eq!(worker["status"], "failed");
    assert!(worker["report"].is_null());
    let history = ConversationStore::new(fixture.home())
        .read_committed(result["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let denied = history
        .history
        .messages
        .iter()
        .flat_map(|message| message["permissionGrants"].as_array().into_iter().flatten())
        .filter(|grant| grant["reason"] == "explorer_scope_denied" && grant["granted"] == false)
        .count();
    assert_eq!(denied, 4);
    assert!(!model.requests.lock().unwrap().iter().any(|request| {
        request
            .to_string()
            .contains("fixture not admitted to Explorer")
    }));
}

#[test]
fn public_goal_explorer_batch_rechecks_each_actual_lane_before_reading() {
    let fixture = Ordinary::new();
    let outside = tempfile::tempdir().unwrap();
    std::fs::write(outside.path().join("private.txt"), "needle never admitted").unwrap();
    let mut replies = parent_replies().to_vec();
    replies.push(reply_tool(
        "batch_search",
        json!({"queries":[{"id":"outside","query":"needle","path":outside.path()}]}),
    ));
    let model = Server::new(replies);
    let output = fixture.run(
        Some(&model),
        &[
            "--access",
            "full",
            "--output-format",
            "json",
            "Run a single Explorer",
        ],
        None,
    );
    let reply: Value = serde_json::from_slice(&output.stdout).unwrap();
    let store = ConversationStore::new(fixture.home());
    let history = store
        .read_committed(reply["sessionId"].as_str().unwrap(), None, 8 * 1024 * 1024)
        .unwrap();
    let result = history
        .history
        .messages
        .iter()
        .flat_map(|message| message["segments"].as_array().into_iter().flatten())
        .find(|segment| segment["tool"] == "batch_search")
        .map(|segment| &segment["result"])
        .unwrap_or_else(|| panic!("expected an actual batch Tool Result: {reply}"));
    assert_ne!(result["status"], "success");
    assert!(
        result["evidence"]["readScopeDecisions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|grant| {
                grant["reason"] == "explorer_scope_denied" && grant["granted"] == false
            })
    );
    assert!(!result.to_string().contains("needle never admitted"));
    assert_eq!(plan(&fixture)["runner"]["explorers"][0]["status"], "failed");
}

#[test]
fn public_goal_explorer_inherits_the_explicit_tool_allowlist() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("actual.txt"),
        "Allowed observation\n",
    )
    .unwrap();
    let mut replies = parent_replies().into_iter();
    let mut worker_calls = 0;
    let model = Server::scripted(
        move |request| {
            if let Some(reply) = replies.next() {
                return reply;
            }
            worker_calls += 1;
            let tools = request["tools"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value["function"]["name"].as_str().unwrap())
                .collect::<Vec<_>>();
            assert_eq!(tools, ["read_file"]);
            if worker_calls == 1 {
                reply_tool("read_file", json!({"path":"actual.txt"}))
            } else {
                assert_eq!(last_tool(request)["preview"], "Allowed observation\n");
                reply_text("{\"summary\":\"Observed with the user-selected tool\"}")
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&model),
        &[
            "--tools",
            "goal_create_plan,request_explorer,read_file",
            "--output-format",
            "json",
            "Use only these tools",
        ],
        None,
    );
    assert!(output.status.success(), "{output:?}");
    fixture.assert_settled(&output, 3, 3);
    assert_eq!(
        plan(&fixture)["runner"]["explorers"][0]["status"],
        "completed"
    );
}

#[test]
fn public_goal_explorer_waits_for_real_worker_stop_and_recovers_a_dead_owner_without_replay() {
    for hard_exit in [false, true] {
        let fixture = Ordinary::new();
        let mut replies = parent_replies().into_iter();
        let (entered, worker_waiting) = std::sync::mpsc::channel();
        let (release, worker_release) = std::sync::mpsc::channel();
        let model = Server::scripted(
            move |_| {
                if let Some(reply) = replies.next() {
                    return reply;
                }
                entered.send(()).unwrap();
                let _ = worker_release.recv_timeout(Duration::from_secs(8));
                reply_tool("read_file", json!({"path":"late.txt"}))
            },
            false,
            false,
            vec![],
        );
        let mut command = fixture.command(Some(&model));
        let mut child = command
            .args(["--output-format", "json", "Start the owned Explorer"])
            .spawn()
            .unwrap();
        worker_waiting.recv_timeout(Duration::from_secs(8)).unwrap();
        let before = plan(&fixture);
        assert_eq!(before["runner"]["explorers"][0]["status"], "running");
        if hard_exit {
            child.kill().unwrap();
        } else {
            rustix::process::kill_process(
                rustix::process::Pid::from_raw(child.id() as i32).unwrap(),
                rustix::process::Signal::TERM,
            )
            .unwrap();
        }
        let outcome = wait(child);
        release.send(()).unwrap();
        let meta = fixture.metadata();
        let id = meta["id"].as_str().unwrap();
        if hard_exit {
            assert_eq!(plan(&fixture), before);
            assert_eq!(recovery::recover(&fixture, id).status.code(), Some(0));
        } else {
            let reply: Value = serde_json::from_slice(&outcome.stdout).unwrap();
            assert_eq!(reply["error"], "CANCELLED");
        }
        let after = plan(&fixture);
        let worker = &after["runner"]["explorers"][0];
        assert_eq!(worker["status"], "failed");
        assert_eq!(
            worker["failureReason"],
            if hard_exit {
                "explorer_owner_interrupted"
            } else {
                "CANCELLED"
            }
        );
        assert!(worker["report"].is_null());
        let store = ConversationStore::new(fixture.home());
        let facts = store.read_conversation_execution(id).unwrap().unwrap();
        assert!(facts.permits_new_run());
        assert_eq!(recovery::recover(&fixture, id).status.code(), Some(0));
        assert_eq!(plan(&fixture), after);
        assert_eq!(model.requests.lock().unwrap().len(), 4);
    }
}
