use crate::{NativeProjectHost, test_model::*};
use peer_runtime::CancellationToken;
use serde_json::json;
use std::time::Duration;
use tempfile::tempdir;

#[tokio::test]
async fn failure_hold_pauses_wake_drain_on_429_and_releases_on_user_input_or_expiry() {
    for user_trial in [true, false] {
        let home = tempdir().unwrap();
        let ws = tempdir().unwrap();
        let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
        let (entry, _) = host.bind_workspace(ws.path(), Some("Limited")).unwrap();
        let ws_id = entry.workspace_id;
        host.inbox()
            .append(
                &ws_id,
                &[json!({"eventId":"quota-event", "kind":"objective_signal"})],
            )
            .unwrap();
        let limited = start_http_mock_server(vec![Box::new(|_| {
            (
                429,
                "application/json\r\nRetry-After: 2",
                json!({"error":{"type":"rate_limit","message":"Try again later"}}).to_string(),
            )
        })]);
        let cancel = CancellationToken::new();
        let original_seq = host.inbox().read_cursor(&ws_id).seq;
        let tick = host
            .tick_foreground(&ws_id, &mock_model(&limited.endpoint), json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(tick.wake_turns_run, 1);
        let hold = host.failure_hold(&ws_id).expect("429 activates a hold");
        assert_eq!(hold.reason, "usage_limit");
        assert_eq!(hold.consecutive_holds, 1);
        let now = crate::parse_iso_ms(&crate::now_iso()).unwrap();
        assert!(
            (0..=2_000).contains(&(hold.hold_until_ms - now)),
            "{hold:?}"
        );
        assert_eq!(host.inbox().read_cursor(&ws_id).seq, original_seq);

        let recovered = if user_trial {
            start_mock_server(vec![
                Box::new(|_| sse_text("I’m available again.")),
                Box::new(|_| sse_text("NO_REPLY")),
            ])
        } else {
            start_mock_server(vec![Box::new(|_| sse_text("NO_REPLY"))])
        };
        let model = mock_model(&recovered.endpoint);
        let skipped = host
            .tick_foreground(&ws_id, &model, json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(skipped.wake_turns_run, 0);
        assert!(recovered.requests.lock().unwrap().is_empty());
        assert_eq!(host.inbox().read_cursor(&ws_id).seq, original_seq);
        if user_trial {
            host.submit_user_input(&ws_id, "recover-quota", "Are you available?", None)
                .unwrap();
        } else {
            let now = crate::parse_iso_ms(&crate::now_iso()).unwrap();
            tokio::time::sleep(Duration::from_millis(
                hold.hold_until_ms.saturating_sub(now).max(0) as u64 + 20,
            ))
            .await;
        }
        let tick = host
            .tick_foreground(&ws_id, &model, json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(tick.bot_turns_run, usize::from(user_trial));
        assert_eq!(tick.wake_turns_run, 1);
        assert!(host.failure_hold(&ws_id).is_none());
        assert_eq!(host.inbox().read_cursor(&ws_id).seq, original_seq + 1);
        assert_eq!(limited.requests.lock().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn circuit_open_activates_failure_hold_and_pauses_subsequent_wake_drain() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "test", Some(1)).unwrap();
    host.runner().set_retry_delays_ms(vec![]);
    let (entry, _) = host.bind_workspace(ws.path(), Some("CircuitHold")).unwrap();
    let ws_id = entry.workspace_id;
    host.inbox()
        .append(
            &ws_id,
            &[json!({"eventId":"trip-event", "kind":"objective_signal"})],
        )
        .unwrap();
    let original_seq = host.inbox().read_cursor(&ws_id).seq;
    let failing = start_http_mock_server(
        (0..5)
            .map(|_| {
                let handler: HttpScriptHandler = Box::new(|_: &serde_json::Value| {
                    (
                        400u16,
                        "application/json",
                        json!({"error":{"type":"invalid_request_error","message":"Bad request"}})
                            .to_string(),
                    )
                });
                handler
            })
            .collect(),
    );
    let model = mock_model(&failing.endpoint);
    let cancel = CancellationToken::new();
    for _ in 1..=5 {
        let tick = host
            .tick_foreground(&ws_id, &model, json!({}), &cancel)
            .await
            .unwrap();
        assert_eq!(tick.wake_turns_run, 1);
    }
    let blocked = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(blocked.wake_turns_run, 1);
    assert_eq!(
        blocked.last_turn.unwrap().end,
        crate::TurnEndKind::CircuitOpen
    );
    let hold = host
        .failure_hold(&ws_id)
        .expect("open circuit should activate circuit_open failure hold");
    assert_eq!(hold.reason, "circuit_open");
    assert_eq!(hold.consecutive_holds, 1);
    assert_eq!(host.inbox().read_cursor(&ws_id).seq, original_seq);

    let skipped = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(skipped.wake_turns_run, 0);
    assert_eq!(failing.requests.lock().unwrap().len(), 5);
}
