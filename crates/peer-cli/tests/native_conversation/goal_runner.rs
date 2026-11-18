use super::*;
use crate::native_conversation::goal_read::last_tool;

pub(super) fn assert_tick(request: &Value, tick: usize, phase: &str) {
    let messages = request["messages"].as_array().unwrap();
    let input = messages
        .iter()
        .rev()
        .find(|row| row["role"] == "user")
        .unwrap();
    assert!(
        input["content"]
            .as_str()
            .unwrap()
            .starts_with(&format!("Goal Runner tick {tick} for goal ")),
        "{input}"
    );
    let system = messages.iter().find(|row| row["role"] == "system").unwrap();
    let rendered = system["content"].as_str().unwrap();
    assert!(
        rendered.contains("Goal Runner execution contract:"),
        "{system}"
    );
    assert!(
        rendered.contains(&format!(
            "runner state: status=running; intent=execute; phase={phase}"
        )),
        "{system}"
    );
}

fn create_goal() -> String {
    reply_tool(
        "goal_create_plan",
        json!({"title":"Track the approved work","goal":"Observe an actual file","tasks":[{"title":"Read the fixture"}]}),
    )
}

#[test]
fn public_goal_runner_respects_the_explicit_cap_and_reports_real_stop() {
    let fixture = Ordinary::new();
    std::fs::write(fixture.workspace().join("actual.txt"), "Read at the cap").unwrap();
    let mut requests = 0;
    let model = Server::scripted(
        move |request| {
            requests += 1;
            match requests {
                1 => create_goal(),
                2 => reply_text("The goal is recorded."),
                3 => {
                    assert_tick(request, 1, "orient");
                    reply_tool("read_file", json!({"path":"actual.txt"}))
                }
                _ => panic!("sent past the explicit cap"),
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&model),
        &[
            "--mode",
            "goal",
            "--max-turns",
            "3",
            "--output-format",
            "json",
            "Ground this work",
        ],
        None,
    );
    assert_eq!(output.status.code(), Some(5), "{output:?}");
    let reply = fixture.assert_settled(&output, 3, 2);
    assert_eq!(reply["goal"]["runnerStatus"], "budget_exhausted");
    assert_eq!(reply["goal"]["exitReason"], "max_turns");
    assert_eq!(model.requests.lock().unwrap().len(), 3);
}

#[test]
fn public_goal_runner_rejects_a_stale_model_reply_and_recovers_an_interrupted_owner() {
    for hard_exit in [false, true] {
        let fixture = Ordinary::new();
        let home = fixture.home();
        let (entered, active) = std::sync::mpsc::channel();
        let (release, respond) = std::sync::mpsc::channel();
        let mut requests = 0;
        let model = Server::scripted(
            move |request| {
                requests += 1;
                match requests {
                    1 => create_goal(),
                    2 => reply_text("Goal recorded."),
                    3 => {
                        assert_tick(request, 1, "orient");
                        entered.send(()).unwrap();
                        let _ = respond.recv_timeout(Duration::from_secs(8));
                        reply_tool(
                            "write_file",
                            json!({"path":"late.txt","content":"stale call"}),
                        )
                    }
                    _ => panic!("a stopped Runner contacted the provider"),
                }
            },
            false,
            false,
            vec![],
        );
        let mut child = fixture
            .command(Some(&model))
            .args([
                "--mode",
                "goal",
                "--access",
                "full",
                "--output-format",
                "json",
                "Keep the Goal current",
            ])
            .spawn()
            .unwrap();
        active.recv_timeout(Duration::from_secs(8)).unwrap();
        let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
        let root = home.join("goal-plans");
        let row: Value =
            serde_json::from_str(&std::fs::read_to_string(root.join("index.jsonl")).unwrap())
                .unwrap();
        let path = root.join(format!("{}.json", row["planId"].as_str().unwrap()));
        let mut plan = get(&path);
        assert_eq!(plan["runner"]["status"], "running");
        assert_eq!(plan["runner"]["phase"], "orient");
        if hard_exit {
            child.kill().unwrap();
            let _ = wait(child);
            assert_eq!(get(&path), plan);
        } else {
            plan["title"] = json!("Updated while the original Runner waits");
            std::fs::write(&path, serde_json::to_vec(&plan).unwrap()).unwrap();
            release.send(()).unwrap();
            let output = wait(child);
            assert_eq!(output.status.code(), Some(1), "{output:?}");
            let reply = fixture.assert_settled(&output, 3, 1);
            assert_eq!(reply["error"], "GOAL_SOURCE_CHANGED");
        }
        if hard_exit {
            release.send(()).unwrap();
        }
        assert_eq!(recovery::recover(&fixture, &id).status.code(), Some(0));
        let stopped = get(&path);
        assert_eq!(stopped["title"], plan["title"]);
        assert_eq!(stopped["runner"]["status"], "blocked");
        assert_eq!(
            stopped["runner"]["blockedReason"],
            if hard_exit {
                "goal_runner_owner_interrupted"
            } else {
                "GOAL_SOURCE_CHANGED"
            }
        );
        assert_eq!(stopped["runner"]["turnCount"], 0);
        assert!(!fixture.workspace().join("late.txt").exists());
        let run = ConversationStore::new(&home)
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap();
        assert!(run.permits_new_run());
        assert_eq!(recovery::recover(&fixture, &id).status.code(), Some(0));
        assert_eq!(get(&path), stopped);
        assert_eq!(model.requests.lock().unwrap().len(), 3);
    }
}

#[test]
fn public_goal_runner_requires_independent_verifier_evidence_to_complete() {
    for case in ["valid", "forged", "manual", "missing"] {
        let fixture = Ordinary::new();
        std::fs::write(
            fixture.workspace().join("actual.txt"),
            "Evidence from the Runner",
        )
        .unwrap();
        let mut turns = 0;
        let mut id = Value::Null;
        let mut grounded = Value::Null;
        let model = Server::scripted(
            move |request| {
                turns += 1;
                match turns {
                    1 => reply_tool(
                        "goal_create_plan",
                        json!({
                            "title":"Complete an evidenced Goal", "goal":"Read one file",
                            "tasks":[{"taskId":"read","title":"Inspect the current file"}],
                            "successCriteria":if case == "manual" { json!(["Check manually"]) } else {
                                json!([{"id":"found","kind":"file-exists","path":"actual.txt"}])
                            }
                        }),
                    ),
                    2 => {
                        id = last_tool(request)["output"]["planId"].clone();
                        reply_text("The goal is recorded.")
                    }
                    3 => {
                        assert_tick(request, 1, "orient");
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    4 => {
                        assert_tick(request, 1, "orient");
                        grounded = last_tool(request)["evidenceRefs"][0].clone();
                        let mut update = json!({"planId":id,"taskId":"read","status":"completed","evidenceRefs":[grounded]});
                        if matches!(case, "valid" | "forged") {
                            update["criterionResults"] = json!([{"criterionId":"found","passed":true,"evidenceRef":grounded}]);
                        }
                        reply_tool("goal_update_task", update)
                    }
                    5 => {
                        assert_tick(request, 1, "orient");
                        let output = last_tool(request);
                        assert_eq!(output["status"], "success", "{output}");
                        assert_eq!(
                            output["output"]["plan"]["tasks"][0]["evidenceRefs"],
                            json!([grounded])
                        );
                        reply_text("The task used real evidence.")
                    }
                    6 => {
                        assert_verifier(request);
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    7 => {
                        assert_verifier(request);
                        let tool = last_tool(request);
                        assert_eq!(tool["preview"], "Evidence from the Runner");
                        let review_ref = tool["evidenceRefs"][0].clone();
                        assert_ne!(review_ref, grounded);
                        let evidence = if case == "valid" {
                            json!([review_ref, "tool-result://invented"])
                        } else {
                            json!([grounded, "tool-result://invented"])
                        };
                        reply_text(&json!({"passed":true,"summary":"Independent verdict","evidenceRefs":evidence}).to_string())
                    }
                    _ => panic!("unexpected Runner request {turns}"),
                }
            },
            false,
            false,
            vec![],
        );
        let output = fixture.run(
            Some(&model),
            &[
                "--mode",
                "goal",
                "--output-format",
                "json",
                "Read the actual file",
            ],
            None,
        );
        assert_eq!(
            output.status.code(),
            Some(if case == "valid" { 0 } else { 6 }),
            "{case}: {output:?}"
        );
        let dispatched = matches!(case, "valid" | "forged");
        let reply = fixture.assert_settled(&output, 5, if dispatched { 4 } else { 3 });
        let status = match case {
            "valid" => "completed",
            "manual" => "waiting_user",
            _ => "blocked",
        };
        assert_eq!(reply["goal"]["runnerStatus"], status);
        if case == "manual" {
            assert_eq!(
                reply["goal"]["exitReason"],
                "manual_dod_confirmation_required"
            );
        } else if case == "missing" {
            assert_eq!(
                reply["goal"]["exitReason"],
                "goal_verification_criterion_evidence_required"
            );
        } else if case == "forged" {
            assert_eq!(reply["goal"]["exitReason"], "goal_verifier_failed");
            assert_eq!(reply["goal"]["planStatus"], "executing");
        }
        let conversation = reply["sessionId"].as_str().unwrap();
        let rows = ConversationStore::new(fixture.home())
            .read_committed(conversation, None, 8 * 1024 * 1024)
            .unwrap();
        let user_rows = rows
            .history
            .messages
            .iter()
            .filter(|row| row["role"] == "user" && row["kind"] != "agent_activity")
            .collect::<Vec<_>>();
        assert_eq!(user_rows.len(), 1);
        assert_eq!(user_rows[0]["content"], "Read the actual file");
        let id = reply["goal"]["planId"].as_str().unwrap();
        let plan = get(fixture.home().join("goal-plans").join(format!("{id}.json")));
        assert_eq!(plan["runner"]["turnCount"], 1);
        assert_eq!(plan["runner"]["toolCallCount"], 2);
        assert_eq!(plan["runner"]["status"], status);
        assert_eq!(plan["runner"]["enabled"], false);
        if dispatched {
            let run = &plan["runner"]["verifierRuns"][0];
            assert_eq!(
                run["status"],
                if case == "valid" { "passed" } else { "failed" }
            );
            assert_eq!(run["planId"], id);
            assert_eq!(run["sourceRevision"].as_str().unwrap().len(), 64);
            let proof = run["report"]["toolEvidenceRefs"][0].as_str().unwrap();
            let evidence = peer_store::EvidenceIndexStore::new(fixture.home())
                .find(&[proof.into()], None)
                .unwrap();
            assert_eq!(evidence[0]["planId"], id);
            assert_eq!(evidence[0]["conversationId"], conversation);
            let worker_tool = rows
                .history
                .messages
                .iter()
                .find(|row| {
                    row["nativeVerifierId"] == run["verifierRunId"] && row["segments"].is_array()
                })
                .unwrap();
            assert_eq!(worker_tool["streamId"], evidence[0]["streamId"]);
            assert_eq!(worker_tool["nativeGoalPlanId"], id);
            assert_eq!(worker_tool["kind"], "agent_activity");
            assert!(!run["evidenceRefs"].to_string().contains("invented"));
            assert_eq!(
                run["evidenceRefs"].as_array().unwrap().len(),
                usize::from(case == "valid")
            );
        } else {
            assert!(plan["runner"]["verifierRuns"].is_null());
        }
    }
}

fn assert_verifier(request: &Value) {
    let rendered = request.to_string();
    assert!(rendered.contains("Verifier readonly contract"), "{request}");
    assert!(rendered.contains("Verifier mission for plan"), "{request}");
    assert!(!rendered.contains("Read the actual file"));
    assert!(!rendered.contains("Goal Runner tick"));
    let tools = request["tools"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|definition| definition["function"]["name"].as_str())
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
}

#[test]
fn public_goal_model_review_is_written_only_by_the_independent_verifier() {
    for passed in [true, false] {
        let fixture = Ordinary::new();
        std::fs::write(
            fixture.workspace().join("actual.txt"),
            "Inspect the real result",
        )
        .unwrap();
        let mut requests = 0;
        let mut id = Value::Null;
        let mut observation = Value::Null;
        let model = Server::scripted(
            move |request| {
                requests += 1;
                match requests {
                    1 => reply_tool(
                        "goal_create_plan",
                        json!({"title":"Judge the result","goal":"Ground the review",
                    "tasks":[{"taskId":"read","title":"Read actual.txt"}],
                    "successCriteria":[{"id":"quality","kind":"model_review","description":"Judge result quality"},
                                       {"id":"coverage","kind":"model_review","description":"Judge coverage"}]}),
                    ),
                    2 => {
                        id = last_tool(request)["output"]["planId"].clone();
                        assert!(id.is_string());
                        assert_eq!(
                            last_tool(request)["output"]["plan"]["successCriteria"][0]["kind"],
                            "model_review"
                        );
                        reply_text("Review criteria recorded.")
                    }
                    3 => {
                        assert_tick(request, 1, "orient");
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    4 => {
                        observation = last_tool(request)["evidenceRefs"][0].clone();
                        reply_tool(
                            "goal_update_task",
                            json!({"planId":id,"taskId":"read","status":"completed",
                        "evidenceRefs":[observation],
                        "criterionResults":[{"criterionId":"quality","passed":true,"evidenceRef":observation}]}),
                        )
                    }
                    5 => {
                        assert_eq!(
                            last_tool(request)["error"]["message"],
                            "model_review_requires_host_verifier"
                        );
                        reply_tool(
                            "goal_update_task",
                            json!({"planId":id,"taskId":"read","status":"completed","evidenceRefs":[observation]}),
                        )
                    }
                    6 => {
                        assert_eq!(
                            last_tool(request)["output"]["plan"]["tasks"][0]["evidenceRefs"],
                            json!([observation])
                        );
                        reply_text("The reader settled the actual task.")
                    }
                    7 => {
                        assert_verifier(request);
                        let system = request["messages"][0]["content"].as_str().unwrap();
                        assert!(
                            system.contains("quality (model_review) review=pending_this_verifier")
                        );
                        assert!(
                            system.contains("coverage (model_review) review=pending_this_verifier")
                        );
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    8 => {
                        let real = last_tool(request)["evidenceRefs"][0].clone();
                        assert_ne!(real, observation);
                        reply_text(&json!({"passed":passed,"evidenceRefs":[real],
                        "failedCriteria":if passed {json!([])} else {json!([{"criterionId":"coverage","reason":"Coverage was insufficient","evidenceRefs":[real]}])}}).to_string())
                    }
                    _ => panic!("unexpected semantic review request {requests}"),
                }
            },
            false,
            false,
            vec![],
        );
        let result = fixture.run(
            Some(&model),
            &[
                "--mode",
                "goal",
                "--output-format",
                "json",
                "--max-turns",
                "8",
                "Judge the actual result",
            ],
            None,
        );
        assert_eq!(
            result.status.code(),
            Some(if passed { 0 } else { 6 }),
            "{result:?}"
        );
        let output = fixture.assert_settled(&result, 6, 5);
        let id = output["goal"]["planId"].as_str().unwrap();
        let plan = get(fixture.home().join("goal-plans").join(format!("{id}.json")));
        assert_eq!(plan["criterionResults"], json!([]));
        let verifier = &plan["runner"]["verifierRuns"][0];
        let reviews = plan["modelReviews"].as_array().unwrap();
        assert_eq!(reviews.len(), 2);
        for (row, id) in reviews.iter().zip(["quality", "coverage"]) {
            assert_eq!(row["criterionId"], id);
            assert_eq!(row["sourceRevision"], verifier["sourceRevision"]);
            assert_eq!(row["verifierRunId"], verifier["verifierRunId"]);
            assert_eq!(row["evidenceRefs"], verifier["evidenceRefs"]);
            assert_eq!(row["passed"], passed);
        }
    }
}

#[test]
fn public_goal_verifier_owns_completed_intake_and_rejects_late_or_unprojected_results() {
    for case in ["valid", "write", "stale", "hard", "budget", "review_budget"] {
        let fixture = Ordinary::new();
        std::fs::write(fixture.workspace().join("actual.txt"), "Existing fixture").unwrap();
        let home = fixture.home();
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, proceed) = std::sync::mpsc::channel();
        let mut plan_id = String::new();
        let mut turns = 0;
        let model = Server::scripted(
            move |request| {
                turns += 1;
                match turns {
                    1 => create_goal(),
                    2 => {
                        plan_id = last_tool(request)["output"]["planId"]
                            .as_str()
                            .unwrap()
                            .to_owned();
                        reply_tool(
                            "goal_update_task",
                            json!({"planId":plan_id,"taskId":"task-1","status":"running"}),
                        )
                    }
                    3 => reply_tool("read_file", json!({"path":"actual.txt"})),
                    4 => {
                        let reference = last_tool(request)["evidenceRefs"][0].clone();
                        reply_tool(
                            "goal_update_task",
                            json!({"planId":plan_id,"taskId":"task-1","status":"completed","evidenceRefs":[reference]}),
                        )
                    }
                    5 => {
                        let output = last_tool(request);
                        assert_eq!(output["output"]["plan"]["status"], "completed");
                        reply_text("All leaves settled during intake.")
                    }
                    6 => {
                        assert_verifier(request);
                        if case == "write" {
                            return reply_tool(
                                "write_file",
                                json!({"path":"forbidden.txt","content":"bad"}),
                            );
                        }
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    7 => {
                        assert_verifier(request);
                        let reference = last_tool(request)["evidenceRefs"][0].clone();
                        assert!(reference.is_string());
                        if case == "stale" {
                            let path = home.join("goal-plans").join(format!("{plan_id}.json"));
                            let mut changed = get(&path);
                            changed["goal"] = json!("Criteria changed during independent review.");
                            std::fs::write(path, serde_json::to_vec(&changed).unwrap()).unwrap();
                        } else if case == "hard" {
                            entered.send(()).unwrap();
                            let _ = proceed.recv_timeout(Duration::from_secs(8));
                        }
                        reply_text(&json!({"passed":true,"evidenceRefs":[reference]}).to_string())
                    }
                    _ => panic!("unexpected independent review request {turns}"),
                }
            },
            false,
            false,
            vec![],
        );
        let mut command = fixture.command(Some(&model));
        if case == "budget" {
            command.args(["--max-turns", "5"]);
        } else if case == "review_budget" {
            command.args(["--max-turns", "6"]);
        }
        let mut child = command
            .args([
                "--mode",
                "goal",
                "--access",
                "full",
                "--output-format",
                "json",
                "Complete actual observation",
            ])
            .spawn()
            .unwrap();
        if case == "hard" {
            waiting.recv_timeout(Duration::from_secs(8)).unwrap();
            child.kill().unwrap();
        }
        let output = wait(child);
        if case == "hard" {
            release.send(()).unwrap();
        }
        let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
        if case != "hard" {
            let code = match case {
                "valid" => 0,
                "budget" | "review_budget" => 5,
                _ => 1,
            };
            assert_eq!(output.status.code(), Some(code), "{case}: {output:?}");
            let run = fixture.assert_settled(
                &output,
                5,
                if matches!(case, "write" | "budget") {
                    4
                } else {
                    5
                },
            );
            if case == "write" {
                assert_eq!(run["error"], "tool_not_projected");
            } else if case == "stale" {
                assert_eq!(run["error"], "GOAL_SOURCE_CHANGED");
            } else if code == 5 {
                assert_eq!(run["goal"]["exitReason"], "max_turns");
            }
        }
        assert_eq!(recovery::recover(&fixture, &id).status.code(), Some(0));
        let goals = fixture.home().join("goal-plans");
        let index: Value =
            serde_json::from_str(&std::fs::read_to_string(goals.join("index.jsonl")).unwrap())
                .unwrap();
        let path = goals.join(format!("{}.json", index["planId"].as_str().unwrap()));
        let plan = get(&path);
        assert_eq!(plan["runner"]["turnCount"], 0);
        assert_eq!(
            plan["runner"]["status"],
            match case {
                "valid" => "completed",
                "budget" | "review_budget" => "budget_exhausted",
                _ => "blocked",
            }
        );
        assert_eq!(
            plan["status"],
            if case == "valid" {
                "completed"
            } else {
                "executing"
            }
        );
        assert_eq!(plan["tasks"][0]["status"], "completed");
        let worker = &plan["runner"]["verifierRuns"][0];
        if case == "budget" {
            assert!(worker.is_null());
        } else {
            assert_eq!(
                worker["status"],
                if case == "valid" { "passed" } else { "failed" }
            );
        }
        if case == "hard" || case == "stale" {
            assert_eq!(worker["failureReason"], "goal_verifier_owner_interrupted");
            assert!(worker["report"].is_null());
        }
        if case == "stale" {
            assert_eq!(plan["goal"], "Criteria changed during independent review.");
        }
        assert!(plan["runner"]["nativeVerifierId"].is_null());
        assert!(!fixture.workspace().join("forbidden.txt").exists());
        assert_eq!(recovery::recover(&fixture, &id).status.code(), Some(0));
        assert_eq!(get(&path), plan);
        assert_eq!(
            model.requests.lock().unwrap().len(),
            match case {
                "budget" => 5,
                "write" | "review_budget" => 6,
                _ => 7,
            }
        );
    }
}

#[test]
fn public_goal_repairs_grounded_review_under_the_same_owner() {
    for case in ["success", "exhausted", "budget", "denied", "hard"] {
        let fixture = Ordinary::new();
        let file = fixture.workspace().join("actual.txt");
        std::fs::write(&file, "initial result").unwrap();
        if case == "denied" {
            let directory = fixture.workspace().join(".peer");
            std::fs::create_dir(&directory).unwrap();
            std::fs::write(directory.join("hooks.json"), json!({"hooks":{"PreToolUse":[
                {"id":"deny-repair","command":r#"printf '%s' '{"decision":"deny","reason":"fixture policy"}'"#,
                 "timeoutMs":3000,"match":{"capabilityId":"local.file.write"}}
            ]}}).to_string()).unwrap();
        }
        let (entered, waiting) = std::sync::mpsc::channel();
        let (release, proceed) = std::sync::mpsc::channel();
        let mut requests = 0;
        let mut plan_id = Value::Null;
        let model = Server::scripted(
            move |request| {
                requests += 1;
                match requests {
                    1 => reply_tool(
                        "goal_create_plan",
                        json!({"title":"Repair the verified result","goal":"The work must contain the repair marker.",
                            "tasks":[{"taskId":"check","title":"Check actual.txt"}],
                            "successCriteria":[{"id":"marker","kind":"model_review","description":"Independently verify the repaired marker"}]}),
                    ),
                    2 => {
                        plan_id = last_tool(request)["output"]["planId"].clone();
                        reply_text("Start the goal.")
                    }
                    3 => reply_tool("read_file", json!({"path":"actual.txt"})),
                    4 => reply_tool(
                        "goal_update_task",
                        json!({"planId":plan_id,"taskId":"check","status":"completed",
                               "evidenceRefs":last_tool(request)["evidenceRefs"]}),
                    ),
                    5 => reply_text("The initial check is recorded."),
                    6 => {
                        assert_verifier(request);
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    7 | 10 | 13 if requests == 7 || case == "exhausted" => {
                        let refs = &last_tool(request)["evidenceRefs"];
                        assert!(refs[0].is_string());
                        reply_text(&json!({"passed":false,"summary":"The repair marker was absent",
                            "failedCriteria":[{"criterionId":"marker","reason":"Expected revised content","evidenceRefs":refs}],
                            "evidenceRefs":refs}).to_string())
                    }
                    8 | 11 if requests == 8 || case == "exhausted" => {
                        assert_tick(request, if requests == 8 { 2 } else { 3 }, "repair");
                        let system = request["messages"][0]["content"].as_str().unwrap();
                        assert!(system.contains(
                            "Independent verification failed: The repair marker was absent"
                        ));
                        assert!(system.contains("Expected revised content"));
                        if case == "exhausted" {
                            reply_text("The result could not be repaired.")
                        } else {
                            reply_tool(
                                "write_file",
                                json!({
                                    "path":"actual.txt","content":"repaired result","allow_overwrite":true
                                }),
                            )
                        }
                    }
                    9 if case == "hard" => {
                        assert_eq!(last_tool(request)["status"], "success");
                        entered.send(()).unwrap();
                        let _ = proceed.recv_timeout(Duration::from_secs(8));
                        reply_text("This result must not be consumed after exit.")
                    }
                    9 | 12 if case == "exhausted" => {
                        assert_verifier(request);
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    9 => {
                        assert_eq!(last_tool(request)["status"], "success");
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    10 => reply_tool(
                        "goal_update_task",
                        json!({"planId":plan_id,"taskId":"check","status":"completed","result":"File repaired",
                               "evidenceRefs":last_tool(request)["evidenceRefs"]}),
                    ),
                    11 => {
                        assert_eq!(last_tool(request)["status"], "success");
                        reply_text("The repair happened.")
                    }
                    12 => {
                        assert_verifier(request);
                        reply_tool("read_file", json!({"path":"actual.txt"}))
                    }
                    13 => {
                        let tool = last_tool(request);
                        assert_eq!(tool["preview"], "repaired result", "{tool}");
                        reply_text(
                            &json!({"passed":true,"evidenceRefs":tool["evidenceRefs"]}).to_string(),
                        )
                    }
                    _ => panic!("unexpected repair request {requests} in {case}"),
                }
            },
            false,
            false,
            vec![],
        );
        let mut command = fixture.command(Some(&model));
        if case == "budget" {
            command.args(["--max-turns", "8"]);
        }
        let mut child = command
            .args([
                "--mode",
                "goal",
                "--access",
                "full",
                "--output-format",
                "json",
                "Repair after grounded verification",
            ])
            .spawn()
            .unwrap();
        if case == "hard" {
            waiting.recv_timeout(Duration::from_secs(8)).unwrap();
            child.kill().unwrap();
        }
        let result = wait(child);
        if case == "hard" {
            release.send(()).unwrap();
        }
        let expected_reason = match case {
            "success" => Value::Null,
            "exhausted" => json!("goal_verifier_failed"),
            "budget" => json!("max_turns"),
            "denied" => json!("permission_denied"),
            "hard" => json!("goal_runner_owner_interrupted"),
            _ => unreachable!(),
        };
        if case != "hard" {
            let (code, turns, tools) = match case {
                "success" => (0, 9, 8),
                "exhausted" => (6, 7, 6),
                "budget" => (5, 6, 5),
                "denied" => (1, 6, 5),
                _ => unreachable!(),
            };
            assert_eq!(result.status.code(), Some(code), "{case}: {result:?}");
            let reply = fixture.assert_settled(&result, turns, tools);
            if case == "denied" {
                assert_eq!(reply["error"], expected_reason);
            } else {
                assert_eq!(
                    reply["goal"]["exitReason"], expected_reason,
                    "{case}: {reply}"
                );
            }
        }
        let session = fixture.metadata()["id"].as_str().unwrap().to_owned();
        assert_eq!(recovery::recover(&fixture, &session).status.code(), Some(0));
        let goals = fixture.home().join("goal-plans");
        let index = get(goals.join("index.jsonl"));
        let path = goals.join(format!("{}.json", index["planId"].as_str().unwrap()));
        let plan = get(&path);
        let runs = plan["runner"]["verifierRuns"].as_array().unwrap();
        assert_eq!(
            runs.len(),
            match case {
                "success" => 2,
                "exhausted" => 3,
                _ => 1,
            }
        );
        let repairs = runs
            .iter()
            .filter(|row| row["nativeRepair"].is_object())
            .collect::<Vec<_>>();
        assert_eq!(repairs.len(), if case == "exhausted" { 2 } else { 1 });
        let execution = ConversationStore::new(fixture.home())
            .read_conversation_execution(&session)
            .unwrap()
            .unwrap();
        for row in repairs {
            assert_eq!(row["status"], "failed");
            assert_eq!(
                row["nativeRepair"]["streamId"],
                execution.identity.stream_id
            );
            assert!(row["nativeRepair"]["startedAt"].is_string());
            assert!(
                row["nativeRepair"]["settledAt"].is_string(),
                "{case}: {row}"
            );
            if matches!(case, "budget" | "denied" | "hard") {
                assert_eq!(
                    row["nativeRepair"]["stopReason"], expected_reason,
                    "{case}: {row}"
                );
            }
        }
        assert_eq!(plan["runner"]["blockedReason"], expected_reason);
        if case == "success" {
            assert_eq!(plan["status"], "completed");
            assert_eq!(runs[1]["status"], "passed");
            assert_ne!(runs[0]["verifierRunId"], runs[1]["verifierRunId"]);
            assert_ne!(runs[0]["sourceRevision"], runs[1]["sourceRevision"]);
            assert_ne!(runs[0]["evidenceRefs"], runs[1]["evidenceRefs"]);
            assert_eq!(
                plan["modelReviews"][1]["verifierRunId"],
                runs[1]["verifierRunId"]
            );
        } else {
            assert_eq!(plan["status"], "executing");
        }
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            if matches!(case, "budget" | "hard" | "success") {
                "repaired result"
            } else {
                "initial result"
            }
        );
        assert_eq!(recovery::recover(&fixture, &session).status.code(), Some(0));
        assert_eq!(get(&path), plan);
        assert_eq!(
            model.requests.lock().unwrap().len(),
            match case {
                "success" | "exhausted" => 13,
                "hard" => 9,
                _ => 8,
            }
        );
    }
}
