use crate::{NativeProjectHost, TurnEndKind, test_model::*};
use peer_runtime::CancellationToken;
use serde_json::{Value, json};
use std::fs;
use tempfile::tempdir;

#[derive(Clone, Copy)]
enum Checkpoint {
    Compatible,
    Missing,
    IncompatibleRoute,
}

async fn retry_persisted_wake(mode: Checkpoint) {
    let home = tempdir().unwrap();
    let project = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "wake-test", Some(1)).unwrap();
    let (entry, profile) = host
        .bind_workspace(project.path(), Some("Wake retry"))
        .unwrap();
    let workspace_id = &entry.workspace_id;
    let conversation_id = profile.agent_conversation_id.unwrap();
    let cancel = CancellationToken::new();
    let original_event = json!({"eventId":"wake-to-retry", "kind":"objective_signal"});
    host.inbox()
        .append(workspace_id, &[original_event])
        .unwrap();

    let server = start_http_mock_server(vec![
        Box::new(|_| {
            (
                200,
                "text/event-stream",
                sse_tool_call("wake-tool", "get_session", &json!({"sessionId":"absent"})),
            )
        }),
        Box::new(|_| {
            (
                429,
                "application/json\r\nRetry-After: 600",
                json!({"error":{"type":"rate_limit","message":"Try again later"}}).to_string(),
            )
        }),
        Box::new(|_| (200, "text/event-stream", sse_text("已恢复先前的进展。"))),
        Box::new(|_| (200, "text/event-stream", sse_text("NO_REPLY"))),
    ]);
    let model = mock_model(&server.endpoint);
    let tick = host
        .tick_foreground(workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!((tick.bot_turns_run, tick.wake_turns_run), (0, 1));
    let failed = tick.last_turn.unwrap();
    assert!(matches!(failed.end, TurnEndKind::Failed { .. }));
    assert_eq!(failed.tool_calls, 1);
    assert!(host.failure_hold(workspace_id).is_some());
    assert_eq!(host.inbox().read_cursor(workspace_id).seq, 0);
    assert_eq!(server.requests.lock().unwrap().len(), 2);

    let runtime_dir = home.path().join("project-runtime").join(workspace_id);
    let cursor_path = runtime_dir.join("inbox-cursor.json");
    let cursor: Value = serde_json::from_slice(&fs::read(&cursor_path).unwrap()).unwrap();
    assert_eq!(cursor["failedWake"]["turnId"], failed.turn_id);
    assert_eq!(cursor["failedWake"]["eventIds"], json!(["wake-to-retry"]));
    assert_eq!(cursor["failedWake"]["retryRequested"], false);
    let trace_path = runtime_dir
        .join("turns")
        .join(format!("{}.json", failed.turn_id));
    let mut trace: Value = serde_json::from_slice(&fs::read(&trace_path).unwrap()).unwrap();
    let checkpoint = &trace["providerCheckpoint"];
    assert_eq!(checkpoint["anchors"], json!([]));
    assert_eq!(checkpoint["conversationId"], conversation_id);
    assert_eq!(checkpoint["wakeEventIds"], json!(["wake-to-retry"]));
    let pair = checkpoint["messages"].as_array().unwrap().clone();
    assert_eq!(pair.len(), 2);
    assert_eq!(pair[0]["tool_calls"][0]["id"], "wake-tool");
    assert_eq!(pair[1]["tool_call_id"], "wake-tool");
    match mode {
        Checkpoint::Compatible => {}
        Checkpoint::Missing => fs::remove_file(trace_path).unwrap(),
        Checkpoint::IncompatibleRoute => {
            trace["providerCheckpoint"]["route"] = json!("not-the-original-route");
            fs::write(trace_path, serde_json::to_vec(&trace).unwrap()).unwrap();
        }
    }
    host.inbox()
        .append(
            workspace_id,
            &[json!({"eventId":"later-wake", "kind":"objective_signal"})],
        )
        .unwrap();
    let held = host
        .tick_foreground(workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(held.wake_turns_run, 0);

    // The batch and explicit intent survive host recreation; duplicate clicks leave one retry.
    for _ in 0..2 {
        let retry = host.retry_turn(workspace_id, &failed.turn_id).unwrap();
        assert_eq!(retry["ok"], true);
        assert_eq!(retry["requeued"], 0);
    }
    let cursor: Value = serde_json::from_slice(&fs::read(&cursor_path).unwrap()).unwrap();
    assert_eq!(cursor["failedWake"]["retryRequested"], true);
    host.release_lease(workspace_id).unwrap();
    drop(host);
    let host = NativeProjectHost::new(home.path(), "wake-test", Some(1)).unwrap();
    let tick = host
        .tick_foreground(workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!((tick.bot_turns_run, tick.wake_turns_run), (0, 1));
    let recovered = tick.last_turn.unwrap();
    assert!(matches!(recovered.end, TurnEndKind::ReplyCommitted { .. }));
    assert_eq!(recovered.tool_calls, 0);
    let compatible = matches!(mode, Checkpoint::Compatible);
    {
        let requests = server.requests.lock().unwrap();
        assert_eq!(
            requests.len(),
            3,
            "explicit recovery issued exactly one provider request"
        );
        let messages = requests[2]["messages"].as_array().unwrap();
        let wake = messages
            .iter()
            .find(|m| {
                m["role"] == "user"
                    && m["content"]
                        .as_str()
                        .is_some_and(|s| s.contains("wake-to-retry"))
            })
            .unwrap();
        assert!(!wake["content"].as_str().unwrap().contains("later-wake"));
        assert_eq!(
            messages.iter().filter(|m| m["role"] == "tool").count(),
            usize::from(compatible)
        );
        if compatible {
            assert_eq!(
                messages[messages.len() - 2]["tool_calls"],
                pair[0]["tool_calls"]
            );
            assert_eq!(messages.last().unwrap(), &pair[1]);
        }
    }
    let messages =
        crate::read_full_conversation_messages(host.conversations(), &conversation_id).unwrap();
    let failed_turn = messages.iter().find(|m| m["id"] == failed.turn_id).unwrap();
    let completed_turn = messages
        .iter()
        .find(|m| m["id"] == recovered.turn_id)
        .unwrap();
    assert_eq!(completed_turn["userInputs"], json!([]));
    assert_eq!(
        completed_turn["meta"]["workId"],
        failed_turn["meta"]["workId"]
    );
    assert_eq!(
        completed_turn["meta"]["providerCheckpointResumedFrom"].as_str(),
        compatible.then_some(failed.turn_id.as_str())
    );
    assert!(host.failure_hold(workspace_id).is_none());
    let cursor: Value = serde_json::from_slice(&fs::read(&cursor_path).unwrap()).unwrap();
    assert_eq!(cursor["seq"], 1);
    assert!(cursor.get("failedWake").is_none());
    assert_eq!(host.inbox().list_recent(workspace_id, 10).len(), 2);
    assert!(
        !host
            .inbox()
            .request_wake_retry(workspace_id, &conversation_id, &failed.turn_id)
            .unwrap()
    );

    host.retry_turn(workspace_id, &failed.turn_id).unwrap();
    let later = host
        .tick_foreground(workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(later.wake_turns_run, 1);
    assert_eq!(host.inbox().read_cursor(workspace_id).seq, 2);
    let idle = host
        .tick_foreground(workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(idle.wake_turns_run, 0);
    let requests = server.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    let later_messages = requests[3]["messages"].to_string();
    assert!(later_messages.contains("later-wake"));
    assert!(!later_messages.contains("wake-to-retry"));
}

#[tokio::test]
async fn explicit_wake_retry_restores_completed_native_pairs() {
    retry_persisted_wake(Checkpoint::Compatible).await;
}

#[tokio::test]
async fn explicit_wake_retry_reruns_same_batch_without_checkpoint() {
    retry_persisted_wake(Checkpoint::Missing).await;
}

#[tokio::test]
async fn explicit_wake_retry_rejects_incompatible_checkpoint_but_keeps_batch() {
    retry_persisted_wake(Checkpoint::IncompatibleRoute).await;
}
