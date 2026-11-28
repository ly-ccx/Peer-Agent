use super::*;
use peer_protocol::{NativeProcessKind, NativeShellCommandBinding, NativeShellSession};

struct Intent {
    pending: ConversationPendingTool,
    binding: NativeShellCommandBinding,
    grant: Value,
    message: Value,
}

fn shell_intent(
    store: &ConversationStore,
    token: &mut ConversationExecutionToken,
    id: &str,
    name: &str,
    granted: bool,
) -> Intent {
    let args = json!({"command":"printf known"});
    let binding = NativeShellCommandBinding {
        tool_call_id: name.into(),
        dispatch_id: format!("{name}-dispatch"),
        generation: 1,
    };
    let pending = ConversationPendingTool {
        tool_call_id: binding.tool_call_id.clone(),
        message_id: format!("{name}-message"),
        dispatch_id: binding.dispatch_id.clone(),
        capability_id: "local.shell.exec".into(),
        args_digest: approval_args_digest(&args).unwrap(),
        phase: Dispatch::Prepared,
        declared_scopes: vec![],
        native_process: None,
    };
    let grant = json!({"grantId":format!("{name}-grant"),"toolCallId":name,"scope":"local.shell.exec",
        "granted":granted,"duration":if granted {"once"} else {"denied"},"decidedAt":AT});
    let message = json!({"id":pending.message_id,"role":"assistant","streamId":"stream",
        "content":"","permissionGrants":[grant],"segments":[{"type":"tool-call","toolCallId":name,"tool":"bash","args":args}]});
    let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    store.commit_message(&history, &message, AT, None).unwrap();
    store
        .prepare_conversation_tool(token, &pending, AT, None)
        .unwrap();
    store
        .dispatch_conversation_tool(token, name, AT, None)
        .unwrap();
    Intent {
        pending,
        binding,
        grant,
        message,
    }
}

fn session_process(token: &ConversationExecutionToken, intent: &Intent) -> NativeOwnedProcess {
    NativeOwnedProcess {
        schema_version: 1,
        kind: NativeProcessKind::Command,
        handle_id: "shell-session_12345678-1234-4abc-8def-123456789012".into(),
        tool_call_id: intent.binding.tool_call_id.clone(),
        dispatch_id: intent.binding.dispatch_id.clone(),
        execution: json!(token.identity()),
        generation: 0,
        state: Process::NotStarted,
        owner: token.owner().clone(),
        child: None,
        stop_observation: None,
    }
}

fn append_result(
    root: &Path,
    store: &ConversationStore,
    id: &str,
    intent: &Intent,
    process: &NativeOwnedProcess,
    actual_binding: bool,
) {
    let name = &intent.binding.tool_call_id;
    let result = json!({"toolCallId":name,"capabilityId":"local.shell.exec","status":"success",
        "output":{"exitCode":0},"outputPreview":{"kind":"json"},"completedAt":AT,
        "evidence":{"evidenceId":format!("{name}-evidence"),"toolCallId":name,"summary":"Observed",
          "artifactRefs":[],"shellSession":{"handleId":process.handle_id,"dispatchId":intent.binding.dispatch_id,
            "generation":if actual_binding {1} else {0}}}});
    let mut segments = intent.message["segments"].clone();
    segments[0]["result"] = result.clone();
    let history = store.read_committed(id, None, 8 * 1024 * 1024).unwrap();
    store
        .commit_terminal_message(
            &history,
            &intent.pending.message_id,
            &json!({"segments":segments}),
            AT,
            None,
        )
        .unwrap();
    EvidenceIndexStore::new(root)
        .register(
            &HostToolEvidence {
                conversation_id: id,
                plan_id: None,
                stream_id: Some("stream"),
                tool_name: "bash",
                capability_id: "local.shell.exec",
                tool_call_id: name,
                grant: &intent.grant,
                result: &result,
            },
            None,
        )
        .unwrap();
}

#[test]
fn persistent_shell_process_outlives_two_bound_calls_and_blocks_unproven_removal() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    let first = shell_intent(&store, &mut token, &id, "start", true);
    let mut process = session_process(&token, &first);
    store
        .register_conversation_shell_session(&mut token, &process, AT)
        .unwrap();
    process.generation = 1;
    process.state = Process::Starting;
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    process.state = Process::Running;
    process.child = Some(NativeProcessRecorder {
        pid: 100_021,
        pid_start: "child-start".into(),
        ..token.owner().clone()
    });
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    assert_eq!(
        store
            .end_conversation_handle(&mut token, &process.handle_id, AT)
            .err(),
        Some(StoreError::ExecutionBusy)
    );
    store
        .bind_conversation_shell_command(&mut token, &process.handle_id, &first.binding, AT)
        .unwrap();
    append_result(root.path(), &store, &id, &first, &process, false);
    assert_eq!(
        store
            .settle_conversation_tool(&mut token, "start", &first.pending.message_id, AT)
            .err(),
        Some(StoreError::ExecutionInvalid)
    );
    append_result(root.path(), &store, &id, &first, &process, true);
    store
        .settle_conversation_tool(&mut token, "start", &first.pending.message_id, AT)
        .unwrap();
    let idle = store.read_conversation_execution(&id).unwrap().unwrap();
    assert!(idle.pending_tools.is_empty());
    let live = NativeShellSession::from_handle(&idle.handles[0]).unwrap();
    assert_eq!(live.process, process);
    assert!(live.command.is_none());
    let second = shell_intent(&store, &mut token, &id, "next", true);
    store
        .bind_conversation_shell_command(&mut token, &process.handle_id, &second.binding, AT)
        .unwrap();
    append_result(root.path(), &store, &id, &second, &process, true);
    store
        .settle_conversation_tool(&mut token, "next", &second.pending.message_id, AT)
        .unwrap();
    let idle = store.read_conversation_execution(&id).unwrap().unwrap();
    assert!(idle.pending_tools.is_empty());
    assert_eq!(
        NativeShellSession::from_handle(&idle.handles[0])
            .unwrap()
            .process,
        process
    );
    process.state = Process::Ended;
    process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    store
        .end_conversation_handle(&mut token, &process.handle_id, AT)
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
fn persistent_shell_rejects_ungranted_binding_and_preserves_unknown_on_stop() {
    let (root, store, id) = seed();
    let mut token = claim(&store, &id, "stream");
    let first = shell_intent(&store, &mut token, &id, "first", true);
    let mut process = session_process(&token, &first);
    store
        .register_conversation_shell_session(&mut token, &process, AT)
        .unwrap();
    process.generation = 1;
    process.state = Process::Starting;
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    process.state = Process::Running;
    process.child = Some(NativeProcessRecorder {
        pid: 100_022,
        pid_start: "child-start".into(),
        ..token.owner().clone()
    });
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    store
        .bind_conversation_shell_command(&mut token, &process.handle_id, &first.binding, AT)
        .unwrap();
    append_result(root.path(), &store, &id, &first, &process, true);
    store
        .settle_conversation_tool(&mut token, "first", &first.pending.message_id, AT)
        .unwrap();
    let denied = shell_intent(&store, &mut token, &id, "denied", false);
    assert_eq!(
        store
            .bind_conversation_shell_command(&mut token, &process.handle_id, &denied.binding, AT)
            .err(),
        Some(StoreError::ExecutionChanged)
    );
    process.state = Process::Ended;
    process.stop_observation = Some(NativeProcessStop::OwnedCompletion);
    store
        .record_conversation_shell_process(&mut token, &process, AT)
        .unwrap();
    store
        .end_conversation_handle(&mut token, &process.handle_id, AT)
        .unwrap();
    stop(&store, &mut token);
    let run = store.read_conversation_execution(&id).unwrap().unwrap();
    assert!(run.handles.is_empty());
    assert_eq!(run.pending_tools[0].phase, Dispatch::OutcomeUnknown);
    assert!(!run.permits_new_run());
}
