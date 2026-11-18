use super::*;
use crate::native_conversation::goal_read::{CONTRACT, last_tool};

fn plans(fixture: &Ordinary) -> Vec<Value> {
    std::fs::read_to_string(fixture.home().join("goal-plans/index.jsonl"))
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect()
}

#[test]
fn public_goal_create_matches_old_store_across_modes_and_keeps_execution_gates() {
    for mode in ["chat", "plan", "goal"] {
        let fixture = Ordinary::new();
        let contract: Value = serde_json::from_str(CONTRACT).unwrap();
        let expected = contract["expectedCreation"][mode].clone();
        let draft = contract["draft"].clone();
        let manifest = contract["createManifest"].clone();
        let mut turn = 0;
        let server = Server::scripted(
            move |request| {
                turn += 1;
                match turn {
                    1 => {
                        let definition = request["tools"]
                            .as_array()
                            .unwrap()
                            .iter()
                            .find(|tool| tool["function"]["name"] == "goal_create_plan");
                        // Let a real unprojected call reach the previous binary during the baseline.
                        if let Some(definition) = definition {
                            assert_eq!(
                                definition["function"]["parameters"],
                                manifest["inputSchema"]
                            );
                        }
                        if mode == "plan" {
                            assert!(!request["tools"].to_string().contains("write_file"));
                        }
                        reply_tool("goal_create_plan", draft.clone())
                    }
                    2 => {
                        let creation = last_tool(request);
                        assert_eq!(creation["status"], "success", "{creation}");
                        let plan = &creation["output"]["plan"];
                        for (key, expected) in expected.as_object().unwrap() {
                            assert_eq!(plan[key], *expected, "{mode}: {key}");
                        }
                        reply_tool("goal_get_plan", json!({"planId":plan["planId"]}))
                    }
                    3 => {
                        assert_eq!(
                            last_tool(request)["output"]["plan"]["status"],
                            expected["status"]
                        );
                        if mode == "goal" {
                            return reply_tool(
                                "write_file",
                                json!({"path":"effect.txt","content":"authorized through the actual accepted Goal"}),
                            );
                        }
                        reply_text("Plan recorded.")
                    }
                    _ => {
                        assert_eq!(last_tool(request)["status"], "success");
                        reply_text("Fixture finished.")
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
                mode,
                "--access",
                "full",
                "--output-format",
                "json",
                "Track the fixture",
            ],
            None,
        );
        assert!(
            output.status.success(),
            "{mode}: {}",
            String::from_utf8_lossy(&output.stdout)
        );
        let extra = usize::from(mode == "goal");
        fixture.assert_settled(&output, 3 + extra, 2 + extra);
        let rows = plans(&fixture);
        assert_eq!(rows.len(), 1);
        let draft = get(fixture
            .home()
            .join("goal-plans")
            .join(format!("{}.json", rows[0]["planId"].as_str().unwrap())));
        assert_eq!(draft["conversationId"], fixture.metadata()["id"]);
        assert_eq!(draft["status"], rows[0]["status"]);
        assert_eq!(draft["tasks"][0]["status"], "pending");
        assert_eq!(
            fixture.workspace().join("effect.txt").exists(),
            mode == "goal"
        );
    }
}

#[test]
fn public_goal_create_reuses_duplicate_and_keeps_original_plan_on_conflict() {
    let fixture = Ordinary::new();
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let draft = contract["draft"].clone();
    let mut different = draft.clone();
    different["goal"] = json!("A different unsafely superseding goal");
    let mut first_id = Value::Null;
    let mut turn = 0;
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => reply_tool("goal_create_plan", draft.clone()),
                2 => {
                    first_id = last_tool(request)["output"]["planId"].clone();
                    assert!(first_id.is_string());
                    reply_tool("goal_create_plan", draft.clone())
                }
                3 => {
                    assert_eq!(last_tool(request)["output"]["planId"], first_id);
                    reply_tool("goal_create_plan", different.clone())
                }
                _ => {
                    assert_eq!(
                        last_tool(request)["error"]["message"],
                        "goal_active_requires_reconciliation"
                    );
                    reply_text("Original retained.")
                }
            }
        },
        false,
        false,
        vec![],
    );
    let output = fixture.run(
        Some(&server),
        &["--output-format", "json", "Create a plan"],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stdout)
    );
    fixture.assert_settled(&output, 4, 3);
    assert_eq!(plans(&fixture).len(), 1);
    let notifications =
        std::fs::read_to_string(fixture.home().join("goal-plans/.changes.jsonl")).unwrap();
    assert_eq!(notifications.lines().count(), 1);
    assert_eq!(plans(&fixture)[0]["version"], 1);
}

#[test]
fn public_goal_create_rejects_cycles_and_cannot_import_a_claimed_completion() {
    for (task, expected) in [
        (
            json!({"taskId":"t","title":"Cycle","dependsOn":["t"]}),
            "goal_task_dependencies_invalid",
        ),
        (
            json!({"title":"False completion","status":"completed"}),
            "GOAL_SOURCE_INVALID",
        ),
    ] {
        let fixture = Ordinary::new();
        let mut first = true;
        let server = Server::scripted(
            move |request| {
                if std::mem::take(&mut first) {
                    return reply_tool(
                        "goal_create_plan",
                        json!({"title":"Fixture","goal":"Publish safely","tasks":[task]}),
                    );
                }
                assert_eq!(last_tool(request)["error"]["message"], expected);
                reply_text("Rejected without mutation.")
            },
            false,
            false,
            vec![],
        );
        let output = fixture.run(
            Some(&server),
            &["--output-format", "json", "Validate a draft"],
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        fixture.assert_settled(&output, 2, 1);
        assert!(!fixture.home().join("goal-plans/index.jsonl").exists());
    }
}

#[cfg(feature = "test-fixtures")]
#[test]
fn fixture_goal_creation_crash_preserves_the_plan_and_unsettled_call_without_replay() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let server = Server::new(vec![reply_tool(
        "goal_create_plan",
        contract["draft"].clone(),
    )]);
    let output = wait(
        fixture
            .command(Some(&server))
            .args(["--mode", "plan", "Create a plan once"])
            .env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
            .spawn()
            .unwrap(),
    );
    assert_eq!(output.status.code(), Some(88), "{output:?}");
    let meta = fixture.metadata();
    let id = meta["id"].as_str().unwrap();
    let read_execution = || {
        ConversationStore::new(fixture.home())
            .read_conversation_execution(id)
            .unwrap()
            .unwrap()
    };
    let before = read_execution();
    assert_eq!(before.pending_tools.len(), 1);
    assert_eq!(
        before.pending_tools[0].phase,
        peer_protocol::ConversationDispatchPhase::Dispatching
    );
    let rows = plans(&fixture);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["status"], "awaiting_approval");
    let directory = fixture.home().join("goal-plans");
    let files = [
        directory.join(format!("{}.json", rows[0]["planId"].as_str().unwrap())),
        directory.join("index.jsonl"),
        directory.join(".changes.jsonl"),
    ];
    let persisted = files.each_ref().map(|path| std::fs::read(path).unwrap());
    assert_eq!(recovery::recover(&fixture, id).status.code(), Some(1));
    let recovered = read_execution();
    assert!(recovered.stop.is_some());
    assert_eq!(recovered.pending_tools.len(), 1);
    assert_eq!(
        recovered.pending_tools[0].phase,
        peer_protocol::ConversationDispatchPhase::OutcomeUnknown
    );
    assert!(!recovered.permits_new_run());
    assert_eq!(recovery::recover(&fixture, id).status.code(), Some(1));
    assert_eq!(read_execution(), recovered);
    assert_eq!(
        files.each_ref().map(|path| std::fs::read(path).unwrap()),
        persisted
    );
    assert_eq!(server.requests.lock().unwrap().len(), 1);
}
