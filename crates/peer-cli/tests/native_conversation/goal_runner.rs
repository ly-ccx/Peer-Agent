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
