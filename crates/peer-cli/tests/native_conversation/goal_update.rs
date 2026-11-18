use super::*;
use crate::native_conversation::goal_read::last_tool;

#[test]
fn public_goal_update_uses_an_actual_file_observation_for_the_owned_leaf() {
    let fixture = Ordinary::new();
    std::fs::write(fixture.workspace().join("actual.txt"), "Observed content\n").unwrap();
    let home = fixture.home();
    let mut id = Value::Null;
    let mut observation = Value::Null;
    let mut published = Vec::new();
    let mut turn = 0;
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => reply_tool(
                    "goal_create_plan",
                    json!({"title":"Observe the workspace","goal":"Record one verified observation",
                        "tasks":[{"taskId":"read","title":"Read actual.txt"}, {"taskId":"other","title":"Leave this open"}],
                        "successCriteria":[{"id":"found","kind":"file-exists","path":"actual.txt"}]}),
                ),
                2 => {
                    id = last_tool(request)["output"]["planId"].clone();
                    assert!(id.is_string());
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":id,"taskId":"read","status":"completed",
                            "evidenceRefs":["tool-result://fixture-that-never-ran"]}),
                    )
                }
                3 => {
                    assert_eq!(last_tool(request)["status"], "failed");
                    let body = home
                        .join("goal-plans")
                        .join(format!("{}.json", id.as_str().unwrap()));
                    assert_eq!(get(body)["tasks"][0]["status"], "pending");
                    reply_tool("read_file", json!({"path":"actual.txt"}))
                }
                4 => {
                    let actual = last_tool(request);
                    assert_eq!(actual["kind"], "local_file_ref", "{actual}");
                    assert_eq!(actual["path"], "actual.txt");
                    assert_eq!(actual["preview"], "Observed content\n");
                    observation = actual["evidenceRefs"][0].clone();
                    assert!(observation.as_str().unwrap().starts_with("tool-result://"));
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":id,"taskId":"read","status":"completed","evidenceRefs":[observation],
                            "result":"Read actual.txt", "criterionResults":[{"criterionId":"found","passed":true,"evidenceRef":observation}]}),
                    )
                }
                5 => {
                    let update = last_tool(request);
                    assert_eq!(update["status"], "success", "{update}");
                    assert_eq!(update["output"]["taskId"], "read");
                    let body = home
                        .join("goal-plans")
                        .join(format!("{}.json", id.as_str().unwrap()));
                    published = std::fs::read(body).unwrap();
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":id,"taskId":"read","status":"completed","evidenceRefs":[observation],
                            "result":"Read actual.txt", "criterionResults":[{"criterionId":"found","passed":true,"evidenceRef":observation}]}),
                    )
                }
                6 => {
                    assert_eq!(last_tool(request)["status"], "success");
                    let body = home
                        .join("goal-plans")
                        .join(format!("{}.json", id.as_str().unwrap()));
                    assert_eq!(std::fs::read(body).unwrap(), published);
                    reply_tool("goal_get_plan", json!({"planId":id}))
                }
                7 => {
                    let plan = last_tool(request)["output"]["plan"].clone();
                    assert_eq!(plan["tasks"][0]["status"], "completed");
                    assert_eq!(plan["tasks"][0]["evidenceRefs"], json!([observation]));
                    assert_eq!(plan["tasks"][1]["status"], "pending");
                    assert_eq!(plan["criterionResults"][0]["criterionId"], "found");
                    assert_eq!(plan["criterionResults"][0]["evidenceRef"], observation);
                    assert_eq!(plan["progress"]["completed"], 1);
                    reply_text("One leaf verified.")
                }
                8 | 10 => {
                    let tools = request["tools"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .filter_map(|tool| tool["function"]["name"].as_str())
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
                    let body = request.to_string();
                    let mission = if turn == 8 {
                        "Identify the primary files"
                    } else {
                        "Identify the read-only verification path"
                    };
                    assert!(body.contains(mission), "{body}");
                    assert!(!body.contains("Read the actual fixture"));
                    assert!(!body.contains("First worker report"));
                    assert!(!body.contains("request_explorer"));
                    reply_tool("read_file", json!({"path":"actual.txt"}))
                }
                9 | 11 => {
                    let actual = last_tool(request);
                    assert_eq!(actual["preview"], "Observed content\n");
                    assert_ne!(actual["evidenceRefs"][0], observation);
                    let summary = if turn == 9 {
                        "First worker report"
                    } else {
                        "Second worker report"
                    };
                    reply_text(&json!({"summary": summary,"evidenceRefs":[actual["evidenceRefs"][0],"tool-result://fabricated"]}).to_string())
                }
                _ => panic!("unexpected model request {turn}"),
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&server),
        &[
            "--mode",
            "chat",
            "--output-format",
            "json",
            "Read the actual fixture",
        ],
        None,
    );
    assert_eq!(output.status.code(), Some(6), "{output:?}");
    let outcome = fixture.assert_settled(&output, 7, 8);
    assert_eq!(outcome["result"], "One leaf verified.");
    assert_eq!(outcome["usage"]["providerRequestCount"], 11);
    assert_eq!(
        outcome["goal"]["exitReason"],
        "runner_continuation_required"
    );
    assert_eq!(outcome["goal"]["runnerStatus"], "idle");
    let plan_id = outcome["goal"]["planId"].as_str().unwrap();
    let plan = get(fixture
        .home()
        .join("goal-plans")
        .join(format!("{plan_id}.json")));
    let runner = &plan["runner"];
    assert_eq!(runner["inspectPlan"]["requiredBeforeAct"], true);
    assert_eq!(
        runner["inspectPlan"]["questions"].as_array().unwrap().len(),
        2
    );
    assert_eq!(runner["phase"], "plan_scaffold");
    let workers = runner["explorers"].as_array().unwrap();
    assert_eq!(workers.len(), 2);
    assert_eq!(plan["tasks"][1]["status"], "pending");
    assert_eq!(
        plan["tasks"][0]["evidenceRefs"].as_array().unwrap().len(),
        1
    );
    let evidence_index = peer_store::EvidenceIndexStore::new(fixture.home());
    for worker in workers {
        assert_eq!(worker["status"], "completed");
        let refs = worker["report"]["evidenceRefs"].as_array().unwrap();
        assert_eq!(refs.len(), 1);
        let reference = refs[0].as_str().unwrap();
        assert_ne!(reference, "tool-result://fabricated");
        let evidence = evidence_index.find(&[reference.into()], None).unwrap();
        assert_eq!(evidence[0]["planId"], plan_id);
        assert_eq!(evidence[0]["toolName"], "read_file");
        assert_ne!(plan["tasks"][0]["evidenceRefs"][0], reference);
    }
    assert_ne!(
        workers[0]["report"]["evidenceRefs"],
        workers[1]["report"]["evidenceRefs"]
    );
}

#[test]
fn public_goal_update_cannot_start_a_leaf_while_the_plan_needs_approval() {
    let fixture = Ordinary::new();
    let mut turn = 0;
    let mut id = Value::Null;
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => reply_tool(
                    "goal_create_plan",
                    json!({"title":"Wait","goal":"Wait for approval",
                    "tasks":[{"taskId":"work","title":"The unapproved work"}]}),
                ),
                2 => {
                    let creation = last_tool(request);
                    assert_eq!(creation["output"]["plan"]["status"], "awaiting_approval");
                    id = creation["output"]["planId"].clone();
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":id,"taskId":"work","status":"running"}),
                    )
                }
                3 => {
                    assert_eq!(last_tool(request)["status"], "failed");
                    reply_tool("goal_get_plan", json!({"planId":id}))
                }
                _ => {
                    let plan = last_tool(request)["output"]["plan"].clone();
                    assert_eq!(plan["status"], "awaiting_approval");
                    assert_eq!(plan["tasks"][0]["status"], "pending");
                    reply_text("Stayed pending.")
                }
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&server),
        &[
            "--mode",
            "plan",
            "--output-format",
            "json",
            "Keep the plan waiting",
        ],
        None,
    );
    assert!(output.status.success(), "{output:?}");
    fixture.assert_settled(&output, 4, 3);
}

#[test]
fn public_goal_update_refuses_foreign_plan_ids_and_foreign_observations() {
    let fixture = Ordinary::new();
    std::fs::write(
        fixture.workspace().join("actual.txt"),
        "Foreign observation\n",
    )
    .unwrap();
    let mut setup_turn = 0;
    let setup = Server::scripted(
        move |request| {
            setup_turn += 1;
            match setup_turn {
                1 => reply_tool(
                    "goal_create_plan",
                    json!({"title":"Foreign","goal":"Work in the original conversation",
                    "tasks":[{"taskId":"read","title":"Read the fixture"}]}),
                ),
                2 => reply_tool("read_file", json!({"path":"actual.txt"})),
                3 => reply_text("Original conversation finished."),
                4 => reply_tool("read_file", json!({"path":"actual.txt"})),
                5 => reply_text(&json!({"summary":"Fixture read","evidenceRefs":last_tool(request)["evidenceRefs"]}).to_string()),
                _ => panic!("unexpected original conversation request {setup_turn}"),
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&setup),
        &["--output-format", "json", "Create the foreign plan"],
        None,
    );
    assert_eq!(output.status.code(), Some(6), "{output:?}");
    let sent = setup.requests.lock().unwrap();
    let foreign = last_tool(&sent[1])["output"]["planId"].clone();
    assert!(foreign.is_string());
    let observation = last_tool(&sent[2])["evidenceRefs"][0].clone();
    assert!(observation.is_string());
    drop(sent);
    let path = fixture
        .home()
        .join("goal-plans")
        .join(format!("{}.json", foreign.as_str().unwrap()));
    let before = std::fs::read(&path).unwrap();
    let mut turn = 0;
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => reply_tool(
                    "goal_update_task",
                    json!({"planId":foreign,"taskId":"read","status":"running"}),
                ),
                2 => {
                    assert_eq!(
                        last_tool(request)["error"]["message"],
                        "goal_plan_not_found"
                    );
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":"missing-plan","taskId":"read","status":"running"}),
                    )
                }
                3 => {
                    assert_eq!(
                        last_tool(request)["error"]["message"],
                        "goal_plan_not_found"
                    );
                    reply_tool(
                        "goal_create_plan",
                        json!({"title":"Current","goal":"Record only current evidence",
                        "tasks":[{"taskId":"read","title":"Read the fixture"}]}),
                    )
                }
                4 => {
                    let current = last_tool(request)["output"]["planId"].clone();
                    reply_tool(
                        "goal_update_task",
                        json!({"planId":current,"taskId":"read","status":"completed","evidenceRefs":[observation]}),
                    )
                }
                5 => {
                    assert_eq!(
                        last_tool(request)["error"]["message"],
                        "goal_task_completion_requires_evidence"
                    );
                    reply_text("No unrelated goal facts changed.")
                }
                6 => reply_tool("read_file", json!({"path":"actual.txt"})),
                7 => reply_text(&json!({"summary":"Current fixture read","evidenceRefs":last_tool(request)["evidenceRefs"]}).to_string()),
                _ => panic!("unexpected new conversation request {turn}"),
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&server),
        &[
            "--output-format",
            "json",
            "Do not inherit the foreign observations",
        ],
        None,
    );
    assert_eq!(output.status.code(), Some(6), "{output:?}");
    assert_eq!(std::fs::read(&path).unwrap(), before);
    assert_eq!(server.requests.lock().unwrap().len(), 7);
}

#[cfg(feature = "test-fixtures")]
#[test]
fn fixture_goal_update_crash_preserves_the_changed_leaf_without_replay() {
    let fixture = Ordinary::new();
    let home = fixture.home();
    let workspace = fixture.workspace().canonicalize().unwrap();
    std::fs::create_dir_all(&home).unwrap();
    std::fs::write(home.join(".native-cli-fixture"), "isolated").unwrap();
    let source = home.clone();
    let mut request_count = 0;
    let model = Server::scripted(
        move |_| {
            request_count += 1;
            assert_eq!(request_count, 1);
            let rows = std::fs::read_to_string(source.join("conversations/index.jsonl")).unwrap();
            let conversation: Value = serde_json::from_str(rows.lines().next().unwrap()).unwrap();
            let contract: Value =
                serde_json::from_str(crate::native_conversation::goal_read::CONTRACT).unwrap();
            let mut plan = contract["canonicalPlan"].clone();
            plan["conversationId"] = conversation["id"].clone();
            plan["originWorkspacePath"] = json!(workspace);
            plan["targetWorkspacePath"] = json!(workspace);
            let mut index = contract["canonicalIndex"].clone();
            index["conversationId"] = conversation["id"].clone();
            let directory = source.join("goal-plans");
            std::fs::create_dir_all(&directory).unwrap();
            put(directory.join("fixture-goal.json"), &plan);
            std::fs::write(directory.join("index.jsonl"), format!("{index}\n")).unwrap();
            reply_tool(
                "goal_update_task",
                json!({"planId":"fixture-goal","taskId":"read-result","status":"running"}),
            )
        },
        false,
        false,
        vec![],
    );
    let output = wait(
        fixture
            .command(Some(&model))
            .arg("Update once")
            .env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
            .spawn()
            .unwrap(),
    );
    assert_eq!(output.status.code(), Some(88), "{output:?}");
    let meta = fixture.metadata();
    let id = meta["id"].as_str().unwrap();
    let plan = home.join("goal-plans/fixture-goal.json");
    let before = std::fs::read(&plan).unwrap();
    let committed: Value = serde_json::from_slice(&before).unwrap();
    assert_eq!(committed["tasks"][0]["subtasks"][0]["status"], "running");
    assert_eq!(committed["status"], "executing");
    let change_log = home.join("goal-plans/.changes.jsonl");
    let changes = std::fs::read(&change_log).unwrap();
    for _ in 0..2 {
        assert_eq!(recovery::recover(&fixture, id).status.code(), Some(1));
        let execution = ConversationStore::new(&home)
            .read_conversation_execution(id)
            .unwrap()
            .unwrap();
        assert_eq!(execution.pending_tools.len(), 1);
        assert_eq!(
            execution.pending_tools[0].phase,
            peer_protocol::ConversationDispatchPhase::OutcomeUnknown
        );
        assert_eq!(std::fs::read(&plan).unwrap(), before);
        assert_eq!(std::fs::read(&change_log).unwrap(), changes);
    }
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}
