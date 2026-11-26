use crate::{NativeProjectHost, TurnEndKind, input_message_id, test_model::*};
use peer_runtime::CancellationToken;
use serde_json::json;
use std::{
    fs,
    sync::{Arc, Mutex},
};
use tempfile::tempdir;

#[tokio::test]
async fn natural_user_reply_commits_agent_reply_with_auto_sources_and_interactive_evidence() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Demo").unwrap();
    fs::write(
        home.path().join("settings.json"),
        json!({ "schemaVersion": 3, "projectAgent": { "shell": "bots", "interactiveResults": true } }).to_string(),
    ).unwrap();
    let host = NativeProjectHost::new_for_surface(
        home.path(),
        peer_protocol::HostSurface::Desktop,
        "test",
        Some(1),
    )
    .unwrap();
    host.set_interactive_bridge(Some(Arc::new(StubBridge)));
    let (entry, _) = host.bind_workspace(ws.path(), Some("Natural")).unwrap();
    let id = "natural-with-card";
    host.submit_user_input(
        &entry.workspace_id,
        id,
        "Inspect the README and prepare a card",
        None,
    )
    .unwrap();
    let evidence = Arc::new(Mutex::new(String::new()));
    let issued_evidence = Arc::clone(&evidence);
    let server = start_mock_server(vec![
        Box::new(|_| spawn_readme_for_natural_reply()),
        Box::new(|req| {
            assert!(extract_spawned_session_id(req).is_some());
            sse_tool_call(
                "direct-card",
                "publish_interactive_result",
                &json!({
                    "publication": {"kind": "create"},
                    "title": "Readme overview",
                    "textFallback": "The README is being reviewed.",
                    "program": "$status=\"all\"\nroot=Col([Title(\"Readme overview\")])",
                    "inputs": [{"bindingId": "rows", "source": {"kind": "model-data", "value": [{"id": "a"}]}}]
                }),
            )
        }),
        Box::new(move |req| {
            let result = last_tool_result_json(req).unwrap();
            assert_eq!(result["publicationStatus"], "published");
            *issued_evidence.lock().unwrap() = result["artifactRef"].as_str().unwrap().to_owned();
            sse_text("The overview is below. I’ll share the findings when the review is ready.")
        }),
    ]);
    let tick = host
        .tick_foreground(
            &entry.workspace_id,
            &mock_model(&server.endpoint),
            json!({}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let turn = tick.last_turn.unwrap();
    assert!(matches!(turn.end, TurnEndKind::ReplyCommitted { .. }));
    let reply = host
        .find_reply_for_input(&entry.workspace_id, id)
        .unwrap()
        .unwrap();
    assert_eq!(reply["kind"], "agent_reply");
    assert_eq!(reply["replyTo"], json!([input_message_id(id).unwrap()]));
    assert_eq!(reply["sources"], json!(turn.spawned_session_ids));
    assert_eq!(
        reply["meta"]["sessionStates"][0]["sessionId"],
        turn.spawned_session_ids[0]
    );
    assert_eq!(reply["meta"]["sessionStates"][0]["status"], "queued");
    let artifact = evidence.lock().unwrap().clone();
    assert!(artifact.starts_with("interactive-result://"));
    assert_eq!(reply["meta"]["evidenceRefs"][0], artifact);
    assert_eq!(turn.tool_calls, 2);
    assert_eq!(server.requests.lock().unwrap().len(), 3);
}

#[tokio::test]
async fn wake_turn_no_reply_settles_quietly_without_persisting_agent_reply() {
    for text in ["NO_REPLY", "**NO_REPLY**."] {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host.bind_workspace(ws.path(), Some("Quiet")).unwrap();
        let workspace = &entry.workspace_id;
        let cursor = host.inbox().read_cursor(workspace).seq;
        host.inbox()
            .append(
                workspace,
                &[json!({"eventId": "quiet", "kind": "objective_signal"})],
            )
            .unwrap();
        let server = start_mock_server(vec![Box::new(move |_| sse_text(text))]);
        let tick = host
            .tick_foreground(
                workspace,
                &mock_model(&server.endpoint),
                json!({}),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(tick.wake_turns_run, 1);
        let turn = tick.last_turn.unwrap();
        assert_eq!(
            turn.end,
            TurnEndKind::QuietSettled {
                reason: "no_reply_marker".into()
            }
        );
        assert_eq!(host.inbox().read_cursor(workspace).seq, cursor + 1);
        let messages = host
            .conversations()
            .read_committed(&profile.agent_conversation_id.unwrap(), None, 1024 * 1024)
            .unwrap()
            .history
            .messages;
        assert!(!messages.iter().any(|msg| msg["kind"] == "agent_reply"));
        assert_eq!(server.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn user_turn_pure_no_reply_without_work_triggers_repair_and_never_drops_user_message() {
    for repaired in [true, false] {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, profile) = host.bind_workspace(ws.path(), Some("Repair")).unwrap();
        let id = "direct-question";
        host.submit_user_input(&entry.workspace_id, id, "How is the project doing?", None)
            .unwrap();
        let server = start_mock_server(vec![
            Box::new(|_| sse_text("NO_REPLY")),
            Box::new(move |req| {
                assert!(req["messages"].as_array().unwrap().iter().any(|message| {
                    message["content"]
                        .as_str()
                        .is_some_and(|text| text.contains("This is a direct user message"))
                }));
                sse_text(if repaired {
                    "The project is ready."
                } else {
                    "NO_REPLY"
                })
            }),
        ]);
        let tick = host
            .tick_foreground(
                &entry.workspace_id,
                &mock_model(&server.endpoint),
                json!({}),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        let turn = tick.last_turn.unwrap();
        let messages = host
            .conversations()
            .read_committed(&profile.agent_conversation_id.unwrap(), None, 1024 * 1024)
            .unwrap()
            .history
            .messages;
        assert!(
            messages
                .iter()
                .any(|msg| msg["id"] == input_message_id(id).unwrap())
        );
        if repaired {
            assert!(matches!(turn.end, TurnEndKind::ReplyCommitted { .. }));
            assert!(messages.iter().any(
                |msg| msg["kind"] == "agent_reply" && msg["content"] == "The project is ready."
            ));
        } else {
            assert_eq!(
                turn.end,
                TurnEndKind::Failed {
                    code: "empty_model_response".into()
                }
            );
            assert!(!messages.iter().any(|msg| msg["kind"] == "agent_reply"));
            assert!(host.inputs().has_pending(&entry.workspace_id));
        }
        assert_eq!(server.requests.lock().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn user_turn_no_reply_after_spawn_synthesizes_natural_ack() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Demo").unwrap();
    let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("Ack")).unwrap();
    let id = "quiet-after-spawn";
    host.submit_user_input(&entry.workspace_id, id, "请检查 README 并汇报", None)
        .unwrap();
    let server = start_mock_server(vec![
        Box::new(|_| spawn_readme_for_natural_reply()),
        Box::new(|req| {
            assert!(extract_spawned_session_id(req).is_some());
            sse_text("NO_REPLY")
        }),
    ]);
    let tick = host
        .tick_foreground(
            &entry.workspace_id,
            &mock_model(&server.endpoint),
            json!({}),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    let turn = tick.last_turn.unwrap();
    assert!(matches!(turn.end, TurnEndKind::ReplyCommitted { .. }));
    let reply = host
        .find_reply_for_input(&entry.workspace_id, id)
        .unwrap()
        .unwrap();
    assert_eq!(reply["content"], "已安排后台处理，有结果我第一时间告诉你。");
    assert_eq!(reply["sources"], json!(turn.spawned_session_ids));
    assert_eq!(server.requests.lock().unwrap().len(), 2);
}

#[tokio::test]
async fn natural_user_retry_auto_cites_unreported_result_ready_session_for_anchor() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Demo").unwrap();
    let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("AutoCite")).unwrap();
    let ws_id = entry.workspace_id;
    let parent = profile.agent_conversation_id.unwrap();
    host.ensure_lease(&ws_id).unwrap();

    // Create a completed `result_ready` session bound to `input-auto-input`, then requeue the
    // originating user input to simulate a retry turn before any wake reply cited that session.
    let child = spawn_autonomy_fixture(&host, &ws_id, &parent, ws.path());
    host.supervisor().promote_queued(&ws_id, true).unwrap();
    let worker = start_mock_server(vec![Box::new(|_| sse_text("README checked."))]);
    let cancel = CancellationToken::new();
    host.run_promoted_session(
        &ws_id,
        &child.session_id,
        &mock_model(&worker.endpoint),
        None,
        &mut AutoAllowPermission,
        8,
        &cancel,
    )
    .await
    .unwrap();
    assert_eq!(
        host.supervisor().list_sessions(&ws_id)[0].status,
        "result_ready"
    );
    let drained = host.inbox().take_batch(&ws_id, i64::MAX, true);
    let _ = host.inbox().commit_batch(&ws_id, drained.through_seq, true);
    assert!(host.retry_stopped_input(&ws_id, "auto-input").unwrap());

    let bot = start_mock_server(vec![Box::new(|_| {
        sse_text("I checked the README and it is present.")
    })]);
    let tick = host
        .tick_foreground(&ws_id, &mock_model(&bot.endpoint), json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick.bot_turns_run, 1);
    let turn = tick.last_turn.unwrap();
    assert!(matches!(turn.end, TurnEndKind::ReplyCommitted { .. }));
    let reply = host
        .find_reply_for_input(&ws_id, "auto-input")
        .unwrap()
        .unwrap();
    assert_eq!(reply["sources"], json!([child.session_id]));
    assert_eq!(
        host.supervisor().list_sessions(&ws_id)[0].status,
        "accepted"
    );
}
