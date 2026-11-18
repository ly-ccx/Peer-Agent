use super::*;

pub(super) const CONTRACT: &str =
    include_str!("../../../../packages/protocol/contracts/native-cli/goal-read-tool.json");

fn conversation(home: &Path) -> Value {
    let index = std::fs::read_to_string(home.join("conversations/index.jsonl")).unwrap();
    serde_json::from_str::<Value>(index.lines().next().unwrap()).unwrap()["id"].clone()
}

pub(super) fn last_tool(request: &Value) -> Value {
    request["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|message| message["role"] == "tool")
        .map(|message| serde_json::from_str(message["content"].as_str().unwrap()).unwrap())
        .expect("paired tool output in real provider request")
}

fn seed(home: &Path, case: &str, fixture: &Value) {
    let selected = conversation(home);
    let directory = home.join("goal-plans");
    std::fs::create_dir_all(&directory).unwrap();
    let mut body = fixture["canonicalPlan"].clone();
    body["conversationId"] = selected.clone();
    body["runTrace"] = json!({"events":[{"diagnostic":"private fixture must stay local"}]});
    body["tasks"][0]["opaque"] = json!("private task detail must stay local");
    let mut row = fixture["canonicalIndex"].clone();
    row["conversationId"] = selected.clone();
    if case == "large" {
        body["goal"] = json!(format!("{} END OF SAVED GOAL", "界".repeat(3500)));
        body["tasks"][0]["result"] = json!("long result ".repeat(1500));
    }
    if case == "oversized" {
        body["goal"] = json!("z".repeat(512 * 1024));
    }
    put(directory.join("fixture-goal.json"), &body);
    let mut index = format!("{row}\n");
    if case == "canonical" {
        let mut cancelled = body.clone();
        cancelled["planId"] = json!("cancelled-goal");
        cancelled["status"] = json!("cancelled");
        put(directory.join("cancelled-goal.json"), &cancelled);
        let mut cancelled_row = row.clone();
        cancelled_row["planId"] = json!("cancelled-goal");
        // A stale index must not publish a cancelled plan as accepted.
        index.push_str(&format!("{cancelled_row}\n"));
        let mut foreign = body.clone();
        foreign["planId"] = json!("foreign-goal");
        foreign["conversationId"] = json!("other-conversation");
        foreign["goal"] = json!("sensitive unrelated goal");
        put(directory.join("foreign-goal.json"), &foreign);
        let mut foreign_row = row;
        foreign_row["planId"] = json!("foreign-goal");
        foreign_row["conversationId"] = json!("other-conversation");
        index.push_str(&format!("{foreign_row}\n"));
    }
    if case == "corrupt" {
        index.push_str("{\"planId\":");
    }
    std::fs::write(directory.join("index.jsonl"), index).unwrap();
}

#[test]
fn public_goal_read_lists_and_reads_owned_plans_and_excludes_foreign_ids() {
    let fixture = Ordinary::new();
    let home = fixture.home();
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let source = contract.clone();
    let mut turn = 0;
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => {
                    seed(&home, "canonical", &source);
                    reply_tool("goal_get_plan", json!({}))
                }
                2 => {
                    let listed = last_tool(request);
                    let plans = listed["output"]["plans"].as_array().unwrap();
                    assert_eq!(plans.len(), 1);
                    for (key, expected) in source["expectedListItem"].as_object().unwrap() {
                        assert_eq!(plans[0][key], *expected, "{key}");
                    }
                    reply_tool("goal_get_plan", json!({"planId":"fixture-goal"}))
                }
                3 => {
                    let detailed = last_tool(request);
                    let plan = &detailed["output"]["plan"];
                    for (key, expected) in source["expectedDetail"].as_object().unwrap() {
                        assert_eq!(plan[key], *expected, "{key}");
                    }
                    assert!(!detailed.to_string().contains("must stay local"));
                    let progress = home.join("goal-plans/runner-progress");
                    std::fs::create_dir(&progress).unwrap();
                    let changed_at = "2026-11-14T05:00:00.000Z";
                    put(
                        progress.join("fixture-goal.json"),
                        &json!({
                            "planId":"fixture-goal","status":"paused","updatedAt":changed_at,
                            "runner":{"enabled":true,"status":"paused","updatedAt":changed_at},
                        }),
                    );
                    reply_tool("goal_get_plan", json!({"planId":"fixture-goal"}))
                }
                4 => {
                    let paused = &last_tool(request)["output"]["plan"];
                    assert_eq!(paused["status"], "paused");
                    assert_eq!(paused["runner"]["status"], "paused");
                    assert_eq!(paused["tasks"][0]["taskId"], "verify-tree");
                    reply_tool("goal_get_plan", json!({"planId":"foreign-goal"}))
                }
                5 => {
                    assert_eq!(
                        last_tool(request)["output"],
                        json!({"ok":false,"plan":null})
                    );
                    assert!(!request.to_string().contains("sensitive unrelated goal"));
                    reply_tool("goal_get_plan", json!({"planId":"absent-goal"}))
                }
                _ => {
                    assert_eq!(
                        last_tool(request)["output"],
                        json!({"ok":false,"plan":null})
                    );
                    reply_text("Read verified.")
                }
            }
        },
        false,
        false,
        vec![],
    );
    let result = fixture.run(
        Some(&server),
        &[
            "--mode",
            "plan",
            "--output-format",
            "json",
            "--tools",
            "goal_get_plan",
            "Read plan",
        ],
        None,
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    fixture.assert_settled(&result, 6, 5);
    let requests = server.requests.lock().unwrap();
    let definitions = requests[0]["tools"].as_array().unwrap();
    assert_eq!(definitions.len(), 1);
    let definition = &definitions[0];
    assert_eq!(definition["function"]["name"], "goal_get_plan");
    assert_eq!(
        definition["function"]["parameters"],
        contract["manifest"]["inputSchema"]
    );
    assert_eq!(
        definition["function"]["description"],
        contract["manifest"]["description"]
    );
    assert_eq!(
        get(fixture.home().join("goal-plans/fixture-goal.json"))["status"],
        "accepted"
    );
}

#[test]
fn public_goal_read_retrieves_large_observation_from_the_saved_artifact() {
    let fixture = Ordinary::new();
    let home = fixture.home();
    let contract: Value = serde_json::from_str(CONTRACT).unwrap();
    let mut turn = 0;
    let mut reference = Value::Null;
    let mut saved = String::new();
    let server = Server::scripted(
        move |request| {
            turn += 1;
            match turn {
                1 => {
                    seed(&home, "large", &contract);
                    reply_tool("goal_get_plan", json!({"planId":"fixture-goal"}))
                }
                2 => {
                    let output = last_tool(request);
                    assert_eq!(output["retrieval"]["tool"], "read_tool_result");
                    reference = output["nativeContentRef"].clone();
                    let mut changed = get(home.join("goal-plans/fixture-goal.json"));
                    changed["goal"] = json!("New source after observation");
                    put(home.join("goal-plans/fixture-goal.json"), &changed);
                    reply_tool(
                        "read_tool_result",
                        json!({"reference":reference,"offset":0,"length":2048}),
                    )
                }
                _ => {
                    let output = last_tool(request)["output"].clone();
                    let content = output["content"].as_str().unwrap();
                    assert!(!content.is_empty());
                    assert_eq!(output["offset"], saved.len());
                    saved.push_str(content);
                    if saved.len() < output["totalBytes"].as_u64().unwrap() as usize {
                        return reply_tool(
                            "read_tool_result",
                            json!({
                                "reference":reference,"offset":saved.len(),"length":2048,
                            }),
                        );
                    }
                    let recovered: Value = serde_json::from_str(&saved).unwrap();
                    assert!(
                        recovered["plan"]["goal"]
                            .as_str()
                            .unwrap()
                            .ends_with("END OF SAVED GOAL")
                    );
                    assert!(!recovered.to_string().contains("must stay local"));
                    assert!(!recovered.to_string().contains("New source"));
                    reply_text("Saved result recovered.")
                }
            }
        },
        false,
        false,
        vec![],
    );
    let result = fixture.run(
        Some(&server),
        &["--output-format", "json", "Read a large plan"],
        None,
    );
    assert!(
        result.status.success(),
        "{}",
        String::from_utf8_lossy(&result.stdout)
    );
    let turns = server.requests.lock().unwrap().len();
    assert!(turns > 3);
    fixture.assert_settled(&result, turns, turns - 1);
}

#[test]
fn public_goal_read_keeps_source_errors_explicit_and_can_list_an_empty_conversation() {
    for case in ["empty", "corrupt", "oversized"] {
        let fixture = Ordinary::new();
        let home = fixture.home();
        let contract: Value = serde_json::from_str(CONTRACT).unwrap();
        let mut first = true;
        let server = Server::scripted(
            move |request| {
                if std::mem::take(&mut first) {
                    if case != "empty" {
                        seed(&home, case, &contract);
                    }
                    return reply_tool("goal_get_plan", json!({}));
                }
                let result = last_tool(request);
                if case == "empty" {
                    assert_eq!(result["output"], json!({"ok":true,"plans":[]}));
                } else {
                    assert_eq!(result["status"], "failed");
                    assert!(result["error"]["message"].is_string(), "{result}");
                    assert!(!result.to_string().contains("fixture-goal"));
                }
                reply_text("Result observed.")
            },
            false,
            false,
            vec![],
        );
        let output = fixture.run(
            Some(&server),
            &["--output-format", "json", "Check the store"],
            None,
        );
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
        fixture.assert_settled(&output, 2, 1);
    }
}
