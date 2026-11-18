use super::*;
use std::path::Path;

const SELECTED: &str = "delete-selected";
const OTHER: &str = "delete-other";
const PLAN: &str = "goal-selected";

fn write_json(path: &Path, value: Value) {
    std::fs::write(path, format!("{value}\n")).unwrap();
}

fn seed(fixture: &Ordinary) {
    let conversations = fixture.home().join("conversations");
    let goals = fixture.home().join("goal-plans");
    std::fs::create_dir_all(conversations.join(".context-snapshots")).unwrap();
    std::fs::create_dir_all(goals.join("runner-progress")).unwrap();
    let row = |id| json!({"id":id,"title":id,"role":"default","updatedAt":"2026-01-01T00:00:00Z"});
    std::fs::write(
        conversations.join("index.jsonl"),
        format!("{}\n{}\n", row(SELECTED), row(OTHER)),
    )
    .unwrap();
    let goal = |plan, owner| {
        json!({"planId":plan,"conversationId":owner,"status":"completed",
        "runner":{"status":"completed"}})
    };
    std::fs::write(
        goals.join("index.jsonl"),
        format!("{}\n{}\n", goal(PLAN, SELECTED), goal("goal-other", OTHER)),
    )
    .unwrap();
    write_json(&goals.join(format!("{PLAN}.json")), goal(PLAN, SELECTED));
    write_json(&goals.join("goal-other.json"), goal("goal-other", OTHER));
    write_json(
        &goals.join("runner-progress").join(format!("{PLAN}.json")),
        json!({"planId":PLAN,"runner":{"status":"completed"}}),
    );
    for id in [SELECTED, OTHER] {
        write_json(
            &conversations.join(format!("{id}.jsonl")),
            json!({"id":"user-fixture",
            "role":"user","content":id,"createdAt":"2026-01-01T00:00:00Z"}),
        );
        write_json(
            &conversations
                .join(".context-snapshots")
                .join(format!("{id}.json")),
            json!({"fixture":id}),
        );
    }
    std::fs::create_dir_all(fixture.home().join("usage")).unwrap();
    std::fs::write(
        fixture.home().join("usage/requests.jsonl"),
        "untouched receipt\n",
    )
    .unwrap();
}

fn command(fixture: &Ordinary, id: &str, yes: bool) -> Command {
    let specimen = fixture.command(None);
    let mut cmd = Command::new(specimen.get_program());
    cmd.env_clear()
        .envs(specimen.get_envs().filter_map(|(k, v)| v.map(|v| (k, v))))
        .current_dir(fixture.workspace())
        .args(["sessions", "delete", id])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if yes {
        cmd.arg("--yes");
    }
    cmd
}

fn delete(fixture: &Ordinary, id: &str, yes: bool) -> Output {
    wait(command(fixture, id, yes).spawn().unwrap())
}

fn assert_deleted(fixture: &Ordinary) {
    let conversations = fixture.home().join("conversations");
    let goals = fixture.home().join("goal-plans");
    for path in [
        conversations.join(format!("{SELECTED}.jsonl")),
        conversations
            .join(".context-snapshots")
            .join(format!("{SELECTED}.json")),
        conversations.join(format!(".delete-{SELECTED}.json")),
        conversations.join("index.jsonl.lock"),
        conversations.join(format!("{SELECTED}.jsonl.lock")),
        goals.join(format!("{PLAN}.json")),
        goals.join("runner-progress").join(format!("{PLAN}.json")),
        goals.join("index.jsonl.lock"),
    ] {
        assert!(!path.exists(), "{path:?}");
    }
    assert_eq!(get(conversations.join("index.jsonl"))["id"], OTHER);
    assert_eq!(get(goals.join("index.jsonl"))["planId"], "goal-other");
    assert_eq!(
        get(conversations.join(format!("{OTHER}.jsonl")))["content"],
        OTHER
    );
    assert!(
        conversations
            .join(".context-snapshots")
            .join(format!("{OTHER}.json"))
            .is_file()
    );
    assert_eq!(get(goals.join("goal-other.json"))["conversationId"], OTHER);
    assert_eq!(get(goals.join(".changes.jsonl"))["reason"], "delete");
    assert_eq!(
        get(goals.join(".changes.jsonl"))["conversationId"],
        SELECTED
    );
    assert_eq!(
        std::fs::read_to_string(fixture.home().join("usage/requests.jsonl")).unwrap(),
        "untouched receipt\n"
    );
}

#[test]
fn public_session_delete_checks_confirmation_and_cascades_only_the_selected_session() {
    let fixture = Ordinary::new();
    seed(&fixture);
    let owned_plan = fixture.home().join(format!("goal-plans/{PLAN}.json"));
    let mut body = get(&owned_plan);
    body["runner"]["runTrace"] = json!("former runner history".repeat(280_000));
    write_json(&owned_plan, body);
    let denied = delete(&fixture, SELECTED, false);
    assert_eq!(denied.status.code(), Some(2), "{denied:?}");
    assert!(String::from_utf8_lossy(&denied.stderr).contains("needs a TTY or --yes"));
    assert!(
        fixture
            .home()
            .join(format!("conversations/{SELECTED}.jsonl"))
            .is_file()
    );
    assert!(
        fixture
            .home()
            .join(format!("goal-plans/{PLAN}.json"))
            .is_file()
    );
    assert!(
        !fixture
            .home()
            .join(format!("conversations/.delete-{SELECTED}.json"))
            .exists()
    );
    let result = delete(&fixture, SELECTED, true);
    assert_eq!(result.status.code(), Some(0), "{result:?}");
    assert_eq!(
        String::from_utf8_lossy(&result.stdout),
        format!("Deleted session {SELECTED}.\n")
    );
    assert_deleted(&fixture);
    let missing = delete(&fixture, SELECTED, true);
    assert_eq!(missing.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&missing.stderr).contains("session not found"));
    assert_deleted(&fixture);
}

#[test]
fn public_session_delete_preserves_foreign_lock_foreign_goal_and_legacy_active_stream() {
    for case in [
        "lock",
        "scope",
        "stream",
        "runner",
        "legacy_unknown",
        "encoded_unknown",
    ] {
        let fixture = Ordinary::new();
        seed(&fixture);
        let expected = match case {
            "lock" => {
                std::fs::create_dir(fixture.home().join("goal-plans/index.jsonl.lock")).unwrap();
                "STORE_LOCK_BUSY"
            }
            "scope" => {
                write_json(
                    &fixture.home().join(format!("goal-plans/{PLAN}.json")),
                    json!({"planId":PLAN,"conversationId":OTHER}),
                );
                "GOAL_SOURCE_CHANGED"
            }
            "stream" => {
                write_json(
                    &fixture
                        .home()
                        .join(format!("conversations/{SELECTED}.stream.json")),
                    json!({"conversationId":SELECTED,"version":1}),
                );
                "BACKGROUND_STREAM_STATE_INVALID"
            }
            "runner" => {
                write_json(
                    &fixture.home().join(format!("goal-plans/{PLAN}.json")),
                    json!({"planId":PLAN,"conversationId":SELECTED,"runner":{"status":"running"}}),
                );
                "conversation_execution_busy"
            }
            "legacy_unknown" | "encoded_unknown" => {
                let result = json!({"ok":false,"error":"cancelled_outcome_unknown"});
                let result = if case == "encoded_unknown" {
                    json!(result.to_string())
                } else {
                    result
                };
                write_json(
                    &fixture
                        .home()
                        .join(format!("conversations/{SELECTED}.jsonl")),
                    json!({"id":"legacy-turn","role":"assistant","kind":"agent_turn",
                        "rounds":[{"toolCalls":[{"name":"bash","result":result}]}]}),
                );
                "conversation_execution_busy"
            }
            _ => unreachable!(),
        };
        let files = [
            fixture.home().join("conversations/index.jsonl"),
            fixture.home().join("goal-plans/index.jsonl"),
            fixture.home().join(format!("goal-plans/{PLAN}.json")),
            fixture
                .home()
                .join(format!("conversations/{SELECTED}.jsonl")),
        ];
        let saved = files.each_ref().map(|path| std::fs::read(path).unwrap());
        let result = delete(&fixture, SELECTED, true);
        assert_eq!(result.status.code(), Some(1), "{case}: {result:?}");
        assert!(
            String::from_utf8_lossy(&result.stderr).contains(expected),
            "{case}: {result:?}"
        );
        assert_eq!(
            files.each_ref().map(|path| std::fs::read(path).unwrap()),
            saved
        );
        if case == "lock" {
            let lock = fixture.home().join("goal-plans/index.jsonl.lock");
            assert_eq!(std::fs::read_dir(&lock).unwrap().count(), 0);
            std::fs::remove_dir(lock).unwrap();
            let result = delete(&fixture, SELECTED, true);
            assert_eq!(result.status.code(), Some(0), "{result:?}");
            assert_deleted(&fixture);
        }
    }
}

#[test]
fn fixture_session_delete_recovers_its_actual_locks_and_each_published_phase() {
    for stage in [
        "after_history_lock",
        "after_locks",
        "after_conversation",
        "after_goals",
        "after_notification",
    ] {
        let fixture = Ordinary::new();
        seed(&fixture);
        std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
        let result = wait(
            command(&fixture, SELECTED, true)
                .env("PEER_NATIVE_DELETE_FAULT", stage)
                .spawn()
                .unwrap(),
        );
        assert_eq!(result.status.code(), Some(88), "{stage}: {result:?}");
        assert!(
            fixture
                .home()
                .join("conversations/index.jsonl.lock/owner")
                .is_file()
        );
        let lock = fixture.home().join("goal-plans/index.jsonl.lock");
        assert_eq!(lock.join("owner").is_file(), stage != "after_history_lock");
        assert_eq!(delete(&fixture, SELECTED, false).status.code(), Some(2));
        if stage == "after_locks" {
            let original = lock.with_extension("original");
            std::fs::rename(&lock, &original).unwrap();
            std::fs::create_dir(&lock).unwrap();
            let marker = std::fs::read(original.join("owner")).unwrap();
            std::fs::write(lock.join("owner"), &marker).unwrap();
            let denied = delete(&fixture, SELECTED, true);
            assert_eq!(denied.status.code(), Some(1), "{denied:?}");
            assert_eq!(std::fs::read(lock.join("owner")).unwrap(), marker);
            std::fs::remove_file(lock.join("owner")).unwrap();
            std::fs::remove_dir(&lock).unwrap();
            std::fs::rename(original, lock).unwrap();
        }
        let restored = delete(&fixture, SELECTED, true);
        assert_eq!(restored.status.code(), Some(0), "{stage}: {restored:?}");
        assert_deleted(&fixture);
    }
}

#[test]
fn public_session_delete_refuses_a_live_native_owner_and_succeeds_after_stop() {
    let fixture = Ordinary::new();
    let (entered, waiting) = std::sync::mpsc::channel();
    let (release, proceed) = std::sync::mpsc::channel();
    let model = Server::scripted(
        move |_| {
            entered.send(()).unwrap();
            proceed.recv_timeout(Duration::from_secs(8)).unwrap();
            reply_text("The live run finished.")
        },
        false,
        false,
        vec![],
    );
    let child = fixture
        .command(Some(&model))
        .args(["--output-format", "json", "Keep the live session"])
        .spawn()
        .unwrap();
    waiting.recv_timeout(Duration::from_secs(8)).unwrap();
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    let denied = delete(&fixture, &id, true);
    assert_eq!(denied.status.code(), Some(1), "{denied:?}");
    assert!(String::from_utf8_lossy(&denied.stderr).contains("conversation_execution_busy"));
    release.send(()).unwrap();
    let run = wait(child);
    assert_eq!(run.status.code(), Some(0), "{run:?}");
    let done = delete(&fixture, &id, true);
    assert_eq!(done.status.code(), Some(0), "{done:?}");
}

#[test]
fn fixture_session_delete_retains_actual_unresolved_dispatch_even_after_recovery() {
    let fixture = Ordinary::new();
    std::fs::create_dir_all(fixture.home()).unwrap();
    std::fs::write(fixture.home().join(".native-cli-fixture"), "isolated").unwrap();
    let model = Server::new(vec![reply_tool(
        "write_file",
        json!({"path":"observed.txt","content":"fixture effect"}),
    )]);
    let child = fixture
        .command(Some(&model))
        .env("PEER_NATIVE_ORDINARY_FAULT", "after_effect")
        .args(["--access", "full", "Watch the fixture effect"])
        .spawn()
        .unwrap();
    assert_eq!(wait(child).status.code(), Some(88));
    let id = fixture.metadata()["id"].as_str().unwrap().to_owned();
    assert_eq!(recovery::recover(&fixture, &id).status.code(), Some(1));
    let body = fixture.home().join(format!("conversations/{id}.jsonl"));
    let before = std::fs::read(&body).unwrap();
    let run = ConversationStore::new(fixture.home())
        .read_conversation_execution(&id)
        .unwrap()
        .unwrap();
    assert_eq!(run.pending_tools.len(), 1);
    assert!(run.stop.is_some());
    assert_eq!(delete(&fixture, &id, true).status.code(), Some(1));
    assert_eq!(std::fs::read(body).unwrap(), before);
    assert_eq!(
        ConversationStore::new(fixture.home())
            .read_conversation_execution(&id)
            .unwrap(),
        Some(run)
    );
    assert_eq!(
        std::fs::read_to_string(fixture.workspace().join("observed.txt")).unwrap(),
        "fixture effect"
    );
    assert_eq!(model.requests.lock().unwrap().len(), 1);
}

#[test]
fn closed_stdout_preserves_the_outcome_of_shell_commands_and_file_publications() {
    let fixture = Ordinary::new();
    seed(&fixture);
    let destination = fixture.workspace().join("saved.md");
    let exported = destination.to_str().unwrap();
    let commands: &[&[&str]] = &[
        &["--help"],
        &["sessions", "list"],
        &["export", SELECTED],
        &["export", SELECTED, "--output", exported],
        &["sessions", "delete", SELECTED, "--yes"],
    ];
    for args in commands {
        let specimen = fixture.command(None);
        let mut child = Command::new(specimen.get_program())
            .env_clear()
            .envs(
                specimen
                    .get_envs()
                    .filter_map(|(key, value)| value.map(|value| (key, value))),
            )
            .current_dir(fixture.workspace())
            .args(*args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        drop(child.stdout.take().unwrap());
        let output = wait(child);
        assert!(
            output.status.success() && output.stderr.is_empty(),
            "{args:?}: {output:?}"
        );
    }
    assert!(
        std::fs::read_to_string(&destination)
            .unwrap()
            .contains(SELECTED)
    );
    assert_deleted(&fixture);
}
