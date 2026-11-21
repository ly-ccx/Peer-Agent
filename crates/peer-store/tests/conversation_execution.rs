use peer_protocol::{
    ConversationDispatchPhase as Dispatch, ConversationExecutionPhase as Phase,
    ConversationPendingTool, ConversationStopObservation, NativeOwnedProcess,
    NativeProcessRecorder, NativeProcessState as Process, NativeProcessStop, RuntimeTurnUsage,
    UsageAmounts, approval_args_digest, normalize_conversation_execution,
};
use peer_store::{
    ConversationExecutionToken, ConversationModelSelection, ConversationStore, EvidenceIndexStore,
    HostToolEvidence, NewConversation, NewConversationExecution, StoreError,
};
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::Command,
    time::{Duration, Instant},
};
const AT: &str = "2026-11-18T00:00:00.000Z";
#[path = "conversation_execution/persistent_shell.rs"]
mod persistent_shell;
#[path = "conversation_execution/recovery.rs"]
mod recovery;
fn owner() -> NativeProcessRecorder {
    NativeProcessRecorder {
        boot_id: "fixture-boot".into(),
        pid: std::process::id(),
        pid_start: "fixture-start".into(),
        host_id: "fixture-host".into(),
        acquired_at: AT.into(),
    }
}
fn seed() -> (tempfile::TempDir, ConversationStore, String) {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let id = create(&store);
    let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store
        .commit_message(
            &h,
            &json!({"id":"question","role":"user","content":"hello"}),
            AT,
            None,
        )
        .unwrap();
    (root, store, id)
}
fn create(store: &ConversationStore) -> String {
    store
        .create(
            &NewConversation {
                title: "Isolated ordinary execution",
                workspace_path: None,
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
fn claim(store: &ConversationStore, id: &str, stream: &str) -> ConversationExecutionToken {
    let h = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    store
        .claim_conversation_execution(
            &h,
            &NewConversationExecution {
                stream_id: stream,
                engine: "peer-native",
                owner: &owner(),
                attribution: &json!({"id":stream,"streamId":stream,
        "at":AT,"modelProviderId":"group::provider","model":"model","role":"chat"}),
                selected_model: None,
                at: AT,
            },
            None,
        )
        .unwrap()
        .0
}
#[test]
fn model_selection_and_ordinary_run_claim_use_the_same_current_metadata() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let first = ConversationModelSelection {
        provider_id: "group",
        model: "model",
        effort: "low",
    };
    let next = ConversationModelSelection {
        effort: "high",
        ..first
    };
    let row = store
        .create_with_model(
            &NewConversation {
                title: "Isolated model update",
                workspace_path: Some("/workspace"),
                mode: "chat",
                created_at: AT,
            },
            Some(&first),
            None,
        )
        .unwrap();
    let id = row["id"].as_str().unwrap();
    store
        .update_chat_model(id, "/workspace", &next, AT)
        .unwrap();
    let current = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    let intent = NewConversationExecution {
        stream_id: "stream",
        engine: "peer-native",
        owner: &owner(),
        attribution: &json!({"id":"stream","streamId":"stream",
            "at":AT,"modelProviderId":"group::model","model":"model","role":"chat"}),
        selected_model: Some(&first),
        at: AT,
    };
    assert_eq!(
        store
            .claim_conversation_execution(&current, &intent, None)
            .err()
            .unwrap()
            .error(),
        StoreError::VersionChanged
    );
    assert!(store.read_conversation_execution(id).unwrap().is_none());
    let mut run = store
        .claim_conversation_execution(
            &current,
            &NewConversationExecution {
                selected_model: Some(&next),
                ..intent
            },
            None,
        )
        .unwrap()
        .0;
    assert_eq!(
        store.update_chat_model(id, "/workspace", &first, AT),
        Err(StoreError::ExecutionBusy)
    );
    assert_eq!(
        store.read_metadata(id).unwrap().metadata.unwrap()["effort"],
        "high"
    );
    stop(&store, &mut run);
    store
        .update_chat_model(id, "/workspace", &first, AT)
        .unwrap();
    assert_eq!(
        store.read_metadata(id).unwrap().metadata.unwrap()["effort"],
        "low"
    );
}

#[test]
fn resume_claim_requires_the_same_stopped_execution_under_the_writer_lock() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "first");
    stop(&store, &mut token);
    let stopped = store.read_conversation_execution(&id).unwrap().unwrap();
    let intent = NewConversationExecution {
        stream_id: "resumed",
        engine: "peer-native",
        owner: &owner(),
        attribution: &json!({"id":"resumed","streamId":"resumed","at":AT,
            "modelProviderId":"group::model","model":"model","role":"chat"}),
        selected_model: None,
        at: AT,
    };
    let snapshot = || store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let mut newer = claim(&store, &id, "another-turn");
    stop(&store, &mut newer);
    let index = root.path().join("conversations/index.jsonl");
    let existing = fs::read(&index).unwrap();
    assert_eq!(
        store
            .claim_resumed_conversation_execution(&snapshot(), &intent, &stopped, None)
            .err()
            .unwrap()
            .error(),
        StoreError::ExecutionChanged
    );
    assert_eq!(fs::read(&index).unwrap(), existing);
    // Simulate an offline legacy replacement after the UI observed the prior stop.
    let mut replacement: Value = serde_json::from_slice(&existing).unwrap();
    replacement
        .as_object_mut()
        .unwrap()
        .remove("runtimeExecution");
    let bytes = format!("{replacement}\n");
    fs::write(&index, &bytes).unwrap();
    assert_eq!(
        store
            .claim_resumed_conversation_execution(&snapshot(), &intent, &stopped, None)
            .err()
            .unwrap()
            .error(),
        StoreError::ExecutionUnrecorded
    );
    assert_eq!(fs::read(&index).unwrap(), bytes.as_bytes());
    fs::write(&index, existing).unwrap();
    let latest = store.read_conversation_execution(&id).unwrap().unwrap();
    assert!(
        store
            .claim_resumed_conversation_execution(&snapshot(), &intent, &latest, None)
            .is_ok()
    );
}

fn usage(input: u64, output: u64, requests: u64) -> RuntimeTurnUsage {
    RuntimeTurnUsage {
        provider_request_count: requests,
        amounts: UsageAmounts {
            input_tokens: input,
            output_tokens: output,
            total_tokens: input + output,
            ..Default::default()
        },
    }
}
fn stop(store: &ConversationStore, token: &mut ConversationExecutionToken) {
    store.stop_conversation_admission(token, AT).unwrap();
    store
        .finish_conversation_execution(
            token,
            &ConversationStopObservation {
                owner: token.owner().clone(),
                observed_at: AT.into(),
                runner_idle: true,
                admission_closed: true,
                handles_ended: true,
            },
            AT,
        )
        .unwrap();
}
fn call() -> ConversationPendingTool {
    ConversationPendingTool {
        tool_call_id: "call".into(),
        dispatch_id: "dispatch".into(),
        message_id: "answer".into(),
        capability_id: "local.file.read".into(),
        args_digest: approval_args_digest(&json!({"path":"a"})).unwrap(),
        phase: Dispatch::Prepared,
        declared_scopes: vec![],
        native_process: None,
    }
}
fn index(root: &Path) -> Value {
    serde_json::from_str(
        fs::read_to_string(root.join("conversations/index.jsonl"))
            .unwrap()
            .trim(),
    )
    .unwrap()
}
fn write_index(root: &Path, row: &Value) {
    fs::write(root.join("conversations/index.jsonl"), format!("{row}\n")).unwrap();
}
#[test]
fn publication_is_continuous_metadata_only_and_cannot_span_external_history_or_model() {
    let (root, store, id) = seed();
    let old = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let body = fs::read(root.path().join(format!("conversations/{id}.jsonl"))).unwrap();
    let (mut token, first) = store
        .claim_conversation_execution(
            &old,
            &NewConversationExecution {
                stream_id: "stream",
                engine: "peer-native",
                owner: &owner(),
                attribution: &json!({"id":"stream"}),
                selected_model: None,
                at: AT,
            },
            None,
        )
        .unwrap();
    let second = store
        .observe_conversation_usage(&mut token, &usage(10, 2, 1), false, AT)
        .unwrap();
    let chain = first.chain(second).unwrap();
    let current = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    assert_eq!(
        chain
            .advance(&id, old.history.content_revision, &old.source_revision)
            .unwrap(),
        current.source_revision
    );
    assert_eq!(
        body,
        fs::read(root.path().join(format!("conversations/{id}.jsonl"))).unwrap()
    );
    assert_eq!(current.history, old.history);
    assert_eq!(
        chain
            .advance("other", old.history.content_revision, &old.source_revision)
            .err(),
        Some(StoreError::ContextConflict)
    );
    let external = store
        .commit_message(
            &current,
            &json!({"id":"foreign","role":"user","content":"new input"}),
            AT,
            None,
        )
        .unwrap()
        .snapshot;
    let late = store
        .observe_conversation_usage(&mut token, &usage(15, 4, 2), true, AT)
        .unwrap();
    assert_eq!(
        late.advance(
            &id,
            current.history.content_revision,
            &current.source_revision
        )
        .err(),
        Some(StoreError::ContextConflict)
    );
    assert!(chain.chain(late).is_err());
    let before_model = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let mut meta = index(root.path());
    meta["modelProviderId"] = json!("external-model");
    write_index(root.path(), &meta);
    let latest = store
        .observe_conversation_usage(&mut token, &usage(16, 4, 3), true, AT)
        .unwrap();
    assert!(
        latest
            .advance(
                &id,
                external.history.content_revision,
                &before_model.source_revision
            )
            .is_err()
    );
    assert!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .unknown_usage
    );
}
#[test]
fn actual_ledger_receipt_deduplicates_final_aggregate_and_only_then_allows_next_run() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    store
        .observe_conversation_usage(&mut token, &usage(10, 2, 1), false, AT)
        .unwrap();
    store
        .observe_conversation_usage(&mut token, &usage(17, 3, 2), false, AT)
        .unwrap();
    assert_eq!(
        store
            .observe_conversation_usage(&mut token, &usage(10, 2, 1), false, AT)
            .err(),
        Some(StoreError::UsageConflict)
    );
    assert_eq!(
        store
            .commit_conversation_usage(&token)
            .err()
            .map(|e| e.code()),
        Some("conversation_execution_changed")
    );
    stop(&store, &mut token);
    assert_eq!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .phase,
        Phase::RecoveryRequired
    );
    assert!(!root.path().join("usage/requests.jsonl").exists());
    let receipt = store.commit_conversation_usage(&token).unwrap();
    assert_eq!(receipt.receipt().unwrap()["ledgerRow"]["totalTokens"], 20);
    let bytes = fs::read(root.path().join("usage/requests.jsonl")).unwrap();
    // Reopen and repeat before the acknowledgment: the real ledger is the dedupe authority.
    let reopened = ConversationStore::new(root.path());
    let again = reopened.commit_conversation_usage(&token).unwrap();
    assert_eq!(
        again.receipt().unwrap()["ledgerRow"],
        receipt.receipt().unwrap()["ledgerRow"]
    );
    // The durable JS-compatible encoding represents numeric 0.0 as 0.
    assert_eq!(
        approval_args_digest(&again.receipt().unwrap()["lifetimeUsage"]).unwrap(),
        approval_args_digest(&receipt.receipt().unwrap()["lifetimeUsage"]).unwrap()
    );
    assert_eq!(
        bytes,
        fs::read(root.path().join("usage/requests.jsonl")).unwrap()
    );
    reopened
        .acknowledge_conversation_usage(&mut token, again, AT)
        .unwrap();
    assert!(
        reopened
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .permits_new_run()
    );
    assert_eq!(index(root.path())["runtimeTurnCount"], 1);
    assert_eq!(index(root.path())["lifetimeUsage"]["inputTokens"], 17);
    assert_eq!(index(root.path())["lifetimeUsage"]["outputTokens"], 3);
    let _next = claim(&reopened, &id, "next-stream");
    assert_eq!(
        fs::read_to_string(root.path().join("usage/requests.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}
#[test]
fn known_charges_commit_after_cognition_closes_even_while_tool_stop_remains_unproven() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    store
        .observe_conversation_usage(&mut token, &usage(17, 3, 2), true, AT)
        .unwrap();
    store
        .prepare_conversation_tool(&mut token, &call(), AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(&mut token, "call", AT, None)
        .unwrap();
    store.register_conversation_handle(&mut token, &json!({"handleId":"still-owned","toolCallId":"call","state":"active","metadata":{"kind":"effect"}}), AT).unwrap();
    store.stop_conversation_admission(&mut token, AT).unwrap();
    // Closing cognition freezes the aggregate; neither a late callback nor a
    // usage receipt can reopen execution or declare a still-owned handle ended.
    assert_eq!(
        store
            .observe_conversation_usage(&mut token, &usage(18, 4, 3), false, AT)
            .err(),
        Some(StoreError::ExecutionChanged)
    );
    let receipt = store.commit_conversation_usage(&token).unwrap();
    store
        .acknowledge_conversation_usage(&mut token, receipt, AT)
        .unwrap();
    let run = store.read_conversation_execution(&id).unwrap().unwrap();
    assert_eq!(run.phase, Phase::Stopping);
    assert!(run.stop.is_none());
    assert!(run.usage_committed && run.unknown_usage);
    assert_eq!(run.handles.len(), 1);
    assert_eq!(run.pending_tools[0].phase, Dispatch::Dispatching);
    assert!(!run.permits_new_run());
    assert_eq!(
        fs::read_to_string(root.path().join("usage/requests.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
    let again = store.commit_conversation_usage(&token).unwrap();
    store
        .acknowledge_conversation_usage(&mut token, again, AT)
        .unwrap();
    assert_eq!(
        fs::read_to_string(root.path().join("usage/requests.jsonl"))
            .unwrap()
            .lines()
            .count(),
        1
    );
}

#[test]
fn only_bound_mcp_connections_may_outlive_known_tool_settlement_and_still_block_stop() {
    for valid_connection in [false, true] {
        let (root, store, id) = seed();
        let mut token = claim(&store, &id, "stream");
        let mut pending = call();
        pending.capability_id = "local.mcp.fixture.read".into();
        store
            .prepare_conversation_tool(&mut token, &pending, AT, None)
            .unwrap();
        store
            .dispatch_conversation_tool(&mut token, "call", AT, None)
            .unwrap();
        let mut recorder = token.owner().clone();
        if !valid_connection {
            recorder.pid_start = "foreign-owner".into();
        }
        let handle = json!({"handleId":"connection","toolCallId":"call","state":"active","metadata":{"kind":"mcp_connection","nativeMcp":{"schemaVersion":1,"role":"connection","ownerRecorder":recorder,"registryRevision":"registry","transport":"streamable_http"}}});
        store
            .register_conversation_handle(&mut token, &handle, AT)
            .unwrap();
        let grant = json!({"grantId":"grant","toolCallId":"call","granted":true,"duration":"once","decidedAt":AT});
        let result = json!({"toolCallId":"call","capabilityId":pending.capability_id,"status":"success","outputPreview":{"text":"observed remote reply"},"evidence":{"toolCallId":"call","evidenceId":"mcp-result","summary":"completed","artifactRefs":[]},"completedAt":AT});
        let message = json!({"id":"answer","role":"assistant","streamId":"stream","content":"","permissionGrants":[grant],"segments":[{"type":"tool-call","toolCallId":"call","tool":"mcp_read","args":{"path":"a"},"result":result}]});
        let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        store.commit_message(&h, &message, AT, None).unwrap();
        EvidenceIndexStore::new(root.path())
            .register(
                &HostToolEvidence {
                    conversation_id: &id,
                    plan_id: None,
                    stream_id: Some("stream"),
                    tool_name: "mcp_read",
                    capability_id: &pending.capability_id,
                    tool_call_id: "call",
                    grant: &grant,
                    result: &result,
                },
                None,
            )
            .unwrap();
        let settled = store.settle_conversation_tool(&mut token, "call", "answer", AT);
        assert_eq!(settled.is_ok(), valid_connection);
        store.stop_conversation_admission(&mut token, AT).unwrap();
        let observation = ConversationStopObservation {
            owner: token.owner().clone(),
            observed_at: AT.into(),
            runner_idle: true,
            admission_closed: true,
            handles_ended: true,
        };
        assert_eq!(
            store
                .finish_conversation_execution(&mut token, &observation, AT)
                .err(),
            Some(StoreError::ExecutionBusy)
        );
        assert_eq!(
            store
                .read_conversation_execution(&id)
                .unwrap()
                .unwrap()
                .handles
                .len(),
            1
        );
        if valid_connection {
            store
                .end_conversation_handle(&mut token, "connection", AT)
                .unwrap();
            store
                .finish_conversation_execution(&mut token, &observation, AT)
                .unwrap();
            assert!(
                store
                    .read_conversation_execution(&id)
                    .unwrap()
                    .unwrap()
                    .permits_new_run()
            );
        }
    }
}
#[test]
fn dispatched_unknown_blocks_same_conversation_without_blocking_independent_work() {
    let (_root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    store
        .prepare_conversation_tool(&mut token, &call(), AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(&mut token, "call", AT, None)
        .unwrap();
    assert_eq!(
        store
            .dispatch_conversation_tool(&mut token, "call", AT, None)
            .err(),
        Some(StoreError::ExecutionChanged)
    );
    stop(&store, &mut token);
    let run = store.read_conversation_execution(&id).unwrap().unwrap();
    assert_eq!(run.pending_tools[0].phase, Dispatch::OutcomeUnknown);
    assert!(!run.permits_new_run());
    let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    assert_eq!(
        store
            .claim_conversation_execution(
                &h,
                &NewConversationExecution {
                    stream_id: "new",
                    engine: "peer-native",
                    owner: &owner(),
                    attribution: &json!({"id":"new"}),
                    selected_model: None,
                    at: AT
                },
                None
            )
            .err()
            .map(|e| e.code()),
        Some("conversation_execution_busy")
    );
    let other = create(&store);
    let mut next = claim(&store, &other, "independent");
    stop(&store, &mut next);
    assert!(
        store
            .read_conversation_execution(&other)
            .unwrap()
            .unwrap()
            .permits_new_run()
    );
    assert_eq!(
        store.read_conversation_execution(&id).unwrap().unwrap(),
        run
    );
}
#[test]
fn process_lifecycle_requires_original_identity_generation_and_actual_ended_facts() {
    let (_root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    store
        .prepare_conversation_tool(&mut token, &call(), AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(&mut token, "call", AT, None)
        .unwrap();
    let mut process = NativeOwnedProcess {
        schema_version: 1,
        kind: peer_protocol::NativeProcessKind::Command,
        handle_id: "handle".into(),
        tool_call_id: "call".into(),
        dispatch_id: "dispatch".into(),
        execution: serde_json::to_value(token.identity()).unwrap(),
        generation: 0,
        state: Process::NotStarted,
        owner: token.owner().clone(),
        child: None,
        stop_observation: None,
    };
    // Ordinary identity must never become a Goal/Work identity through the legacy parser.
    assert!(!process.valid());
    store
        .record_conversation_process(&mut token, &process, AT)
        .unwrap();
    process.generation = 1;
    process.state = Process::Starting;
    store
        .record_conversation_process(&mut token, &process, AT)
        .unwrap();
    let starting = process.clone();
    process.state = Process::Running;
    let mut child = owner();
    child.pid += 1;
    child.pid_start = "child-start".into();
    process.child = Some(child);
    store
        .record_conversation_process(&mut token, &process, AT)
        .unwrap();
    assert_eq!(
        store
            .record_conversation_process(&mut token, &starting, AT)
            .err(),
        Some(StoreError::ExecutionChanged)
    );
    store.stop_conversation_admission(&mut token, AT).unwrap();
    let observed = ConversationStopObservation {
        owner: token.owner().clone(),
        observed_at: AT.into(),
        runner_idle: true,
        admission_closed: true,
        handles_ended: true,
    };
    assert_eq!(
        store
            .finish_conversation_execution(&mut token, &observed, AT)
            .err(),
        Some(StoreError::ExecutionBusy)
    );
    process.state = Process::Ended;
    process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
    store
        .record_conversation_process(&mut token, &process, AT)
        .unwrap();
    store
        .finish_conversation_execution(&mut token, &observed, AT)
        .unwrap();
    assert_eq!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .phase,
        Phase::RecoveryRequired
    );
}
#[test]
fn canonical_grant_result_and_registered_evidence_are_required_before_pending_is_removed() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    store
        .prepare_conversation_tool(&mut token, &call(), AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(&mut token, "call", AT, None)
        .unwrap();
    let grant = json!({"grantId":"grant","toolCallId":"call","granted":true,"duration":"once","decidedAt":AT});
    let result = json!({"toolCallId":"call","capabilityId":"local.file.read","status":"success","outputPreview":{"text":"actual result"},
        "evidence":{"toolCallId":"call","evidenceId":"actual-evidence","summary":"read completed","artifactRefs":[]},"completedAt":AT});
    let message = json!({"id":"answer","role":"assistant","streamId":"stream","content":"[Tool result] is only prose",
        "permissionGrants":[grant],"segments":[{"type":"tool-call","toolCallId":"call","tool":"read_file","args":{"path":"a"},"result":result}]});
    let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store.commit_message(&h, &message, AT, None).unwrap();
    assert_eq!(
        store
            .settle_conversation_tool(&mut token, "call", "answer", AT)
            .err(),
        Some(StoreError::EvidenceInvalid)
    );
    EvidenceIndexStore::new(root.path())
        .register(
            &HostToolEvidence {
                conversation_id: &id,
                plan_id: None,
                stream_id: Some("stream"),
                tool_name: "read_file",
                capability_id: "local.file.read",
                tool_call_id: "call",
                grant: &grant,
                result: &result,
            },
            None,
        )
        .unwrap();
    store
        .settle_conversation_tool(&mut token, "call", "answer", AT)
        .unwrap();
    stop(&store, &mut token);
    assert!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .permits_new_run()
    );
}
#[test]
fn malformed_future_or_foreign_execution_is_preserved_and_never_becomes_unowned() {
    let (root, store, id) = seed();
    let _token = claim(&store, &id, "stream");
    let original = index(root.path());
    for (pointer, value) in [
        ("/schemaVersion", json!(2)),
        ("/owner/future", json!(true)),
        ("/identity/conversationId", json!("foreign")),
        (
            "/usage",
            json!({"usageScope":"runtime_turn","providerRequestCount":1,"inputTokens":5,"totalTokens":5}),
        ),
        ("/pendingTools", json!([{"toolCallId":"unknown"}])),
    ] {
        let mut changed = original.clone();
        let run = &mut changed["runtimeExecution"];
        if pointer == "/owner/future" {
            run["owner"]["future"] = value;
        } else {
            *run.pointer_mut(pointer).unwrap() = value;
        }
        write_index(root.path(), &changed);
        let before = fs::read(root.path().join("conversations/index.jsonl")).unwrap();
        assert_eq!(
            store.read_conversation_execution(&id).err(),
            Some(StoreError::ExecutionInvalid)
        );
        let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        assert_eq!(
            store
                .claim_conversation_execution(
                    &h,
                    &NewConversationExecution {
                        stream_id: "other",
                        engine: "peer-native",
                        owner: &owner(),
                        attribution: &json!({"id":"other"}),
                        selected_model: None,
                        at: AT
                    },
                    None
                )
                .err()
                .map(|e| e.code()),
            Some("conversation_execution_invalid")
        );
        assert_eq!(
            before,
            fs::read(root.path().join("conversations/index.jsonl")).unwrap()
        );
    }
    assert!(normalize_conversation_execution(&original["runtimeExecution"]).is_ok());
}
#[test]
#[ignore = "subprocess fixture only"]
fn claim_child() {
    let root = std::env::var_os("PEER_EXECUTION_TEST_ROOT").unwrap();
    let root = Path::new(&root);
    let id = std::env::var("PEER_EXECUTION_TEST_ID").unwrap();
    let name = std::env::var("PEER_EXECUTION_TEST_CHILD").unwrap();
    let store = ConversationStore::new(root);
    let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    fs::write(root.join(format!("ready-{name}")), b"ready").unwrap();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !root.join("go").exists() {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    let result = store.claim_conversation_execution(
        &h,
        &NewConversationExecution {
            stream_id: &name,
            engine: "peer-native",
            owner: &owner(),
            attribution: &json!({"id":name}),
            selected_model: None,
            at: AT,
        },
        None,
    );
    fs::write(
        root.join(format!("result-{name}")),
        match result {
            Ok(_) => "claimed",
            Err(e)
                if matches!(
                    e.error(),
                    StoreError::VersionChanged | StoreError::ExecutionBusy | StoreError::LockBusy
                ) =>
            {
                // The original short Store lock has a bounded wait. Its real
                // timeout denies this claimant; it never minted execution.
                if e.error() == StoreError::LockBusy {
                    assert!(e.into_cleanup().is_none());
                }
                "blocked"
            }
            Err(e) => panic!("unexpected {e:?}"),
        },
    )
    .unwrap();
}
#[test]
fn actual_competing_processes_cannot_claim_the_same_source_twice() {
    let (root, store, id) = seed();
    let exe = std::env::current_exe().unwrap();
    let mut children: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|name| {
            Command::new(&exe)
                .args(["--exact", "claim_child", "--ignored"])
                .env("PEER_EXECUTION_TEST_ROOT", root.path())
                .env("PEER_EXECUTION_TEST_ID", &id)
                .env("PEER_EXECUTION_TEST_CHILD", name)
                .stdout(fs::File::create(root.path().join(format!("child-{name}.stdout"))).unwrap())
                .stderr(fs::File::create(root.path().join(format!("child-{name}.stderr"))).unwrap())
                .spawn()
                .unwrap()
        })
        .collect();
    let deadline = Instant::now() + Duration::from_secs(10);
    while !["one", "two"]
        .into_iter()
        .all(|name| root.path().join(format!("ready-{name}")).exists())
    {
        assert!(Instant::now() < deadline);
        std::thread::sleep(Duration::from_millis(5));
    }
    fs::write(root.path().join("go"), b"go").unwrap();
    let statuses: Vec<_> = children
        .iter_mut()
        .map(|child| child.wait().unwrap())
        .collect();
    if statuses.iter().any(|s| !s.success()) {
        let diagnostics = ["one", "two"].map(|name| {
            format!(
                "{name}: stdout={} stderr={}",
                fs::read_to_string(root.path().join(format!("child-{name}.stdout"))).unwrap(),
                fs::read_to_string(root.path().join(format!("child-{name}.stderr"))).unwrap()
            )
        });
        let retained = root.keep();
        panic!("claim subprocess failed: {statuses:?}; retained={retained:?}; {diagnostics:?}");
    }
    let mut results: Vec<_> = ["one", "two"]
        .into_iter()
        .map(|name| fs::read_to_string(root.path().join(format!("result-{name}"))).unwrap())
        .collect();
    results.sort();
    assert_eq!(results, ["blocked", "claimed"]);
    assert_eq!(
        store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .phase,
        Phase::Active
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn hard_exit_after_index_retains_actual_owner_and_never_replays_or_expires_it() {
    let (root, store, id) = seed();
    fs::write(root.path().join(".native-cli-fixture"), b"isolated").unwrap();
    fs::write(root.path().join("go"), b"go").unwrap();
    let output = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "claim_child", "--ignored"])
        .env("PEER_EXECUTION_TEST_ROOT", root.path())
        .env("PEER_EXECUTION_TEST_ID", &id)
        .env("PEER_EXECUTION_TEST_CHILD", "crashed-stream")
        .env("PEER_CONVERSATION_EXECUTION_FAULT", "after_index")
        .output()
        .unwrap();
    assert_eq!(
        output.status.code(),
        Some(87),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let run = store.read_conversation_execution(&id).unwrap().unwrap();
    assert_eq!(run.phase, Phase::Active);
    assert_eq!(run.identity.stream_id, "crashed-stream");
    let path = root.path().join("conversations/index.jsonl");
    let before = fs::read(&path).unwrap();
    let h = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let intent = NewConversationExecution {
        stream_id: "attempted-replacement",
        engine: "peer-native",
        owner: &owner(),
        attribution: &json!({"id":"attempted-replacement"}),
        selected_model: None,
        at: AT,
    };
    assert_eq!(
        store
            .claim_conversation_execution(&h, &intent, None)
            .err()
            .map(|e| e.code()),
        Some("STORE_LOCK_BUSY")
    );
    assert_eq!(before, fs::read(&path).unwrap());
    // Explicit offline maintenance in this owned fixture only: the sole writer
    // is authoritatively wait()ed above. Preserve diagnostics before removing its
    // empty mkdir locks. No production lock expiry/death inference is introduced.
    fs::copy(&path, root.path().join("diagnostic-index.jsonl")).unwrap();
    fs::remove_dir(root.path().join("conversations/index.jsonl.lock")).unwrap();
    fs::remove_dir(root.path().join(format!("conversations/{id}.jsonl.lock"))).unwrap();
    assert_eq!(
        store
            .claim_conversation_execution(&h, &intent, None)
            .err()
            .map(|e| e.code()),
        Some("conversation_execution_busy")
    );
    assert_eq!(
        store.read_conversation_execution(&id).unwrap().unwrap(),
        run
    );
    let other = create(&store);
    let mut independent = claim(&store, &other, "new-independent");
    stop(&store, &mut independent);
    assert!(
        store
            .read_conversation_execution(&other)
            .unwrap()
            .unwrap()
            .permits_new_run()
    );
}

#[test]
fn real_usage_receipt_cannot_acknowledge_another_data_root_even_with_copied_ids() {
    let (root, store, id) = seed();
    let mut first = claim(&store, &id, "stream");
    store
        .observe_conversation_usage(&mut first, &usage(5, 2, 1), false, AT)
        .unwrap();
    stop(&store, &mut first);
    let other = tempfile::tempdir().unwrap();
    fs::create_dir(other.path().join("conversations")).unwrap();
    let mut meta = index(root.path());
    meta.as_object_mut().unwrap().remove("runtimeExecution");
    write_index(other.path(), &meta);
    fs::copy(
        root.path().join(format!("conversations/{id}.jsonl")),
        other.path().join(format!("conversations/{id}.jsonl")),
    )
    .unwrap();
    let other_store = ConversationStore::new(other.path());
    let mut second = claim(&other_store, &id, "stream");
    other_store
        .observe_conversation_usage(&mut second, &usage(5, 2, 1), false, AT)
        .unwrap();
    stop(&other_store, &mut second);
    assert_eq!(
        other_store
            .commit_conversation_usage(&first)
            .err()
            .map(|e| e.code()),
        Some("conversation_execution_changed")
    );
    let receipt = store.commit_conversation_usage(&first).unwrap();
    assert_eq!(
        other_store
            .acknowledge_conversation_usage(&mut second, receipt, AT)
            .err()
            .map(|e| e.code()),
        Some("USAGE_LEDGER_CONFLICT")
    );
    assert!(
        !other_store
            .read_conversation_execution(&id)
            .unwrap()
            .unwrap()
            .usage_committed
    );
    assert!(!other.path().join("usage/requests.jsonl").exists());
}

#[test]
fn update_ordinary_mode_and_model_reject_busy_conversations() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let first = ConversationModelSelection {
        provider_id: "openai",
        model: "gpt-4o",
        effort: "low",
    };
    let next = ConversationModelSelection {
        provider_id: "anthropic",
        model: "claude-3-7-sonnet",
        effort: "high",
    };
    let id = store
        .create_with_model(
            &NewConversation {
                title: "mode",
                workspace_path: Some("/workspace"),
                mode: "chat",
                created_at: AT,
            },
            Some(&first),
            None,
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .update_ordinary_mode(&id, "/workspace", "plan", AT)
        .unwrap();
    assert_eq!(
        store.read_metadata(&id).unwrap().metadata.unwrap()["mode"],
        "plan"
    );
    store
        .update_ordinary_model(&id, "/workspace", &next, AT)
        .unwrap();
    let meta = store.read_metadata(&id).unwrap().metadata.unwrap();
    assert_eq!(meta["model"], "claude-3-7-sonnet");
    assert_eq!(meta["effort"], "high");

    let mut run = claim(&store, &id, "stream");
    assert_eq!(
        store.update_ordinary_mode(&id, "/workspace", "chat", AT),
        Err(StoreError::ExecutionBusy)
    );
    assert_eq!(
        store.update_ordinary_model(&id, "/workspace", &first, AT),
        Err(StoreError::ExecutionBusy)
    );
    stop(&store, &mut run);
}
