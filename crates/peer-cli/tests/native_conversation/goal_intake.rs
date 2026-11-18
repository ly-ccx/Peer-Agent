use super::*;

fn tool_records(fixture: &Ordinary) -> Vec<(Value, Value)> {
    ConversationStore::new(fixture.home())
        .read_committed(
            fixture.metadata()["id"].as_str().unwrap(),
            None,
            8 * 1024 * 1024,
        )
        .unwrap()
        .history
        .messages
        .into_iter()
        .filter_map(|message| {
            let result = message["segments"][0].get("result")?;
            Some((message["permissionGrants"][0].clone(), result.clone()))
        })
        .collect()
}

fn assert_denied(facts: &(Value, Value), reason: &str) {
    let (grant, result) = facts;
    assert_eq!(grant["granted"], false);
    assert_eq!(grant["reason"], reason);
    assert_eq!(result["status"], "denied");
    assert_eq!(result["error"]["code"], reason);
    assert_eq!(result["evidence"]["dispatchOutcome"], "not_dispatched");
}

fn write_reply() -> String {
    reply_tool(
        "write_file",
        json!({"path":"effect.txt","content":"owned effect"}),
    )
}

fn plan_path(home: &Path) -> std::path::PathBuf {
    home.join("goal-plans/intake-plan.json")
}

fn install_plan(home: &Path, workspace: &Path, case: &str) {
    let conversation = serde_json::from_str::<Value>(
        std::fs::read_to_string(home.join("conversations/index.jsonl"))
            .unwrap()
            .lines()
            .next()
            .unwrap(),
    )
    .unwrap()["id"]
        .clone();
    let selected = if case == "other-conversation" {
        json!("unrelated-conversation")
    } else {
        conversation
    };
    let directory = home.join("goal-plans");
    std::fs::create_dir_all(&directory).unwrap();
    let workspace = if case == "other-workspace" {
        home
    } else {
        workspace
    };
    let mut plan = json!({
        "planId":"intake-plan","conversationId":selected,"status":"accepted",
        "title":"Fixture goal","goal":"Fixture effect","workflowKind":"goal_self_driven",
        "originWorkspacePath":workspace,"targetWorkspacePath":workspace,"version":1,
        "createdAt":AT,"updatedAt":AT,"tasks":[{"taskId":"work","title":"Fixture task","status":"pending"}],
        "activation":{"kind":"accepted_goal","acceptedAt":AT,"acceptedBy":"user"},
    });
    match case {
        "waiting" => plan["status"] = json!("awaiting_approval"),
        "rejected" => plan["approval"] = json!({"decision":"reject"}),
        "delegated" => plan["delegationOrigin"] = json!({"phase":"running"}),
        _ => {}
    }
    put(plan_path(home), &plan);
    std::fs::write(
        directory.join("index.jsonl"),
        format!(
            "{}\n",
            json!({"planId":"intake-plan","conversationId":selected,"status":"accepted"})
        ),
    )
    .unwrap();
    if case == "runner-paused" {
        std::fs::create_dir(directory.join("runner-progress")).unwrap();
        put(
            directory.join("runner-progress/intake-plan.json"),
            &json!({"planId":"intake-plan","status":"paused","updatedAt":AT,
                "runner":{"status":"paused","enabled":true,"updatedAt":AT}}),
        );
    }
}

fn plan_server(fixture: &Ordinary, case: &'static str) -> Server {
    let home = fixture.home();
    let workspace = fixture.workspace();
    let mut first = true;
    Server::scripted(
        move |_| {
            if std::mem::take(&mut first) {
                install_plan(&home, &workspace, case);
                write_reply()
            } else {
                reply_text("Finished.")
            }
        },
        false,
        false,
        vec![],
    )
}

#[test]
fn public_goal_intake_blocks_file_shell_and_hooks_without_a_plan_but_allows_reads() {
    let fixture = Ordinary::new();
    let hooks = fixture.workspace().join(".peer/hooks.json");
    std::fs::create_dir(hooks.parent().unwrap()).unwrap();
    put(
        hooks,
        &json!({"hooks":{"PreToolUse":[{
            "id":"fixture-write-hook","match":{"capabilityId":"local.file.write"},
            "command":"/bin/cat >/dev/null; /usr/bin/touch hook-effect.txt; printf '%s' '{\"decision\":\"allow\"}'"
        }]}}),
    );
    std::fs::write(
        fixture.workspace().join("readable.txt"),
        "read-only fixture",
    )
    .unwrap();
    let server = Server::new(vec![
        write_reply(),
        reply_tool("bash", json!({"command":"/usr/bin/touch shell-effect.txt"})),
        reply_tool("read_file", json!({"path":"readable.txt"})),
        reply_text("Effects remained gated."),
    ]);
    let output = fixture.run(
        Some(&server),
        &[
            "--output-format",
            "json",
            "--mode",
            "goal",
            "--access",
            "full",
            "Try fixture tools",
        ],
        None,
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    fixture.assert_settled(&output, 4, 3);
    let facts = tool_records(&fixture);
    assert_denied(&facts[0], "goal_intake_required");
    assert_denied(&facts[1], "goal_intake_required");
    assert_eq!(facts[2].1["status"], "success");
    for path in ["effect.txt", "shell-effect.txt", "hook-effect.txt"] {
        assert!(!fixture.workspace().join(path).exists(), "{path}");
    }
    assert!(!fixture.home().join("goal-plans/index.jsonl").exists());
    assert!(
        server.requests.lock().unwrap()[1]
            .to_string()
            .contains("goal_intake_required")
    );
}

#[test]
fn public_goal_intake_reads_canonical_status_and_checks_conversation_and_workspace() {
    for case in [
        "accepted",
        "other-conversation",
        "other-workspace",
        "waiting",
        "rejected",
        "runner-paused",
        "delegated",
    ] {
        let fixture = Ordinary::new();
        let server = plan_server(&fixture, case);
        let output = fixture.run(
            Some(&server),
            &[
                "--output-format",
                "json",
                "--mode",
                "goal",
                "--access",
                "full",
                "Try a fixture write",
            ],
            None,
        );
        assert!(
            output.status.success(),
            "{case}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.assert_settled(&output, 2, 1);
        let effects = tool_records(&fixture);
        assert_eq!(
            fixture.workspace().join("effect.txt").exists(),
            case == "accepted",
            "{case}: {effects:?}"
        );
        if case == "accepted" {
            assert_eq!(effects[0].0["granted"], true);
            assert_eq!(effects[0].1["status"], "success");
        } else {
            assert_denied(&effects[0], "goal_intake_required");
        }
    }
}

#[test]
fn public_goal_intake_still_requires_real_approval_and_rechecks_after_the_answer() {
    for revoked in [false, true] {
        let fixture = Ordinary::new();
        let server = plan_server(&fixture, "accepted");
        let mut command = fixture.command(Some(&server));
        command.args([
            "--output-format",
            "json",
            "--mode",
            "goal",
            "--access",
            "ask",
            "Try a fixture write",
        ]);
        let (terminal, child) = permission_command_pty(command);
        wait_permission_prompt(&terminal);
        if revoked {
            let mut plan = get(plan_path(&fixture.home()));
            plan["status"] = json!("paused");
            put(plan_path(&fixture.home()), &plan);
        }
        rustix::io::write(&terminal, if revoked { b"y\n" } else { b"n\n" }).unwrap();
        let output = wait_permission_episode(child);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        fixture.assert_settled(&output, 2, 1);
        assert!(!fixture.workspace().join("effect.txt").exists());
        let facts = tool_records(&fixture);
        if revoked {
            assert_denied(&facts[0], "goal_intake_changed");
        } else {
            assert_eq!(facts[0].0["granted"], false);
            assert_eq!(facts[0].1["error"]["code"], "permission_denied");
        }
        let decisions = peer_store::ApprovalStore::new(fixture.home())
            .list(None, None)
            .unwrap();
        assert_eq!(
            decisions[0]["state"],
            if revoked { "approved" } else { "denied" }
        );
    }
}
