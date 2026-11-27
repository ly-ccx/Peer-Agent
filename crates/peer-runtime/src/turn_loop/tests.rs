//! Ordering harness only. Real grants/effects/Evidence are exercised by the
//! public Host suite; these scripted responses cannot execute a capability.
use super::*;
use serde_json::json;
use std::collections::VecDeque;
#[derive(Default)]
struct Host {
    turns: VecDeque<Result<ModelTurn, CapabilityError>>,
    events: Vec<String>,
    completed: Vec<Vec<String>>,
    request_cancel: Option<CancellationToken>,
    call_cancel: Option<CancellationToken>,
    call_error: Option<&'static str>,
    assistant_error: Option<&'static str>,
    complete_error: Option<&'static str>,
}
fn turn(text: &str, names: &[&str]) -> ModelTurn {
    ModelTurn {
        content: text.into(),
        thinking: String::new(),
        calls: names
            .iter()
            .map(|s| ModelToolCall {
                name: (*s).into(),
                arguments: json!({"original":true}),
                native_chat: None,
            })
            .collect(),
        usage: None,
        request_fingerprint: "fixture".into(),
        continuation: None,
    }
}
impl TurnHost for Host {
    async fn request(&mut self) -> Result<ModelTurn, TurnError> {
        self.events.push("request".into());
        if let Some(cancel) = self.request_cancel.take() {
            cancel.cancel()
        }
        self.turns
            .pop_front()
            .expect("unexpected extra cognition")
            .map_err(Into::into)
    }
    async fn record_assistant(&mut self, turn: &ModelTurn) -> Result<(), CapabilityError> {
        self.events.push(format!("assistant:{}", turn.content));
        self.assistant_error
            .map_or(Ok(()), |e| Err(CapabilityError(e)))
    }
    async fn execute_call(&mut self, call: ModelToolCall) -> Result<ToolStep, CapabilityError> {
        assert_eq!(call.arguments, json!({"original":true}));
        self.events.push(format!("call:{}", call.name));
        if let Some(cancel) = self.call_cancel.take() {
            cancel.cancel()
        }
        if let Some(error) = self.call_error {
            return Err(CapabilityError(error));
        }
        Ok(ToolStep::Continue(format!("committed:{}", call.name)))
    }
    async fn completed(
        &mut self,
        _continuation: Option<ModelContinuation>,
        ids: &[String],
    ) -> Result<(), CapabilityError> {
        self.events.push("completed".into());
        self.completed.push(ids.to_vec());
        self.complete_error
            .map_or(Ok(()), |e| Err(CapabilityError(e)))
    }
}
#[tokio::test]
async fn one_ordered_loop_uses_committed_result_ids_before_the_next_cognition() {
    let mut h = Host {
        turns: VecDeque::from([
            Ok(turn("observed", &["first", "second"])),
            Ok(turn("final", &[])),
        ]),
        ..Host::default()
    };
    let result = run(
        &mut h,
        Some(3),
        &CancellationToken::new(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.stop, LoopStop::Replied);
    assert_eq!(result.content, "final");
    assert_eq!(result.tool_calls, 2);
    assert_eq!(
        h.events,
        [
            "request",
            "assistant:observed",
            "call:first",
            "call:second",
            "completed",
            "request",
            "assistant:final"
        ]
    );
    assert_eq!(
        h.completed,
        vec![vec!["committed:first", "committed:second"]]
    );
}
#[tokio::test]
async fn an_explicit_cap_stops_after_settlement_without_another_request() {
    let mut h = Host {
        turns: VecDeque::from([Ok(turn("partial", &["first"]))]),
        ..Host::default()
    };
    let result = run(
        &mut h,
        Some(1),
        &CancellationToken::new(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.stop, LoopStop::MaxTurns);
    assert_eq!(result.content, "partial");
    assert_eq!(result.tool_calls, 1);
    assert_eq!(h.events.last().unwrap(), "completed");
}
#[tokio::test]
async fn an_unset_cap_does_not_introduce_a_hidden_sixty_four_turn_limit() {
    let mut turns: VecDeque<_> = (0..65).map(|_| Ok(turn("", &["next"]))).collect();
    turns.push_back(Ok(turn("complete", &[])));
    let mut h = Host {
        turns,
        ..Host::default()
    };
    let result = run(
        &mut h,
        None,
        &CancellationToken::new(),
        &CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(result.stop, LoopStop::Replied);
    assert_eq!(result.tool_calls, 65);
    assert_eq!(h.completed.len(), 65);
}
#[tokio::test]
async fn initial_cancel_and_zero_limit_admit_neither_cognition_nor_a_call() {
    for owned_cancel in [true, false] {
        let owned = CancellationToken::new();
        let external = CancellationToken::new();
        if owned_cancel {
            owned.cancel()
        } else {
            external.cancel()
        }
        let mut h = Host::default();
        assert!(matches!(
            run(&mut h, None, &owned, &external).await,
            Err(TurnError::Host(CapabilityError("CANCELLED")))
        ));
        assert!(h.events.is_empty());
    }
    let mut h = Host::default();
    assert!(matches!(
        run(
            &mut h,
            Some(0),
            &CancellationToken::new(),
            &CancellationToken::new()
        )
        .await,
        Err(TurnError::Host(CapabilityError("invalid_max_turns")))
    ));
    assert!(h.events.is_empty());
}
#[tokio::test]
async fn a_late_model_response_after_cancellation_cannot_record_text_or_dispatch() {
    let cancel = CancellationToken::new();
    let mut h = Host {
        turns: VecDeque::from([Ok(turn("late", &["forbidden"]))]),
        request_cancel: Some(cancel.clone()),
        ..Host::default()
    };
    assert!(matches!(
        run(&mut h, None, &cancel, &CancellationToken::new()).await,
        Err(TurnError::Host(CapabilityError("CANCELLED")))
    ));
    assert_eq!(h.events, ["request"]);
}
#[tokio::test]
async fn cancellation_after_one_actual_host_completion_cannot_admit_the_next_call() {
    let cancel = CancellationToken::new();
    let mut h = Host {
        turns: VecDeque::from([Ok(turn("", &["first", "forbidden"]))]),
        call_cancel: Some(cancel.clone()),
        ..Host::default()
    };
    assert!(matches!(
        run(&mut h, None, &cancel, &CancellationToken::new()).await,
        Err(TurnError::Host(CapabilityError("CANCELLED")))
    ));
    assert_eq!(h.events, ["request", "call:first"]);
    assert!(h.completed.is_empty());
}
#[tokio::test]
async fn provider_unknown_commit_and_continuation_errors_are_never_retried_by_the_loop() {
    let mut provider = Host {
        turns: VecDeque::from([Err(CapabilityError("provider_failed"))]),
        ..Host::default()
    };
    assert!(matches!(
        run(
            &mut provider,
            None,
            &CancellationToken::new(),
            &CancellationToken::new()
        )
        .await,
        Err(TurnError::Host(CapabilityError("provider_failed")))
    ));
    assert_eq!(provider.events, ["request"]);
    for (assistant_error, call_error, complete_error, wanted, events) in [
        (
            Some("history_changed"),
            None,
            None,
            "history_changed",
            vec!["request", "assistant:observed"],
        ),
        (
            None,
            Some("execution_outcome_unknown"),
            None,
            "execution_outcome_unknown",
            vec!["request", "assistant:observed", "call:first"],
        ),
        (
            None,
            None,
            Some("continuation_changed"),
            "continuation_changed",
            vec!["request", "assistant:observed", "call:first", "completed"],
        ),
    ] {
        let mut h = Host {
            turns: VecDeque::from([Ok(turn("observed", &["first"]))]),
            assistant_error,
            call_error,
            complete_error,
            ..Host::default()
        };
        let error = run(
            &mut h,
            None,
            &CancellationToken::new(),
            &CancellationToken::new(),
        )
        .await
        .err()
        .unwrap();
        assert_eq!(error.code(), wanted);
        assert_eq!(h.events, events);
    }
}
