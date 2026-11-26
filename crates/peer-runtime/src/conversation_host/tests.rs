//! Actual ordinary production Host with real HTTP and original canonical Stores.
use super::*;
mod retry;
use crate::model::{
    ModelConfig,
    wire::{GenerationOptions, Wire},
};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Instant,
};
struct NoInput;
impl PermissionInput for NoInput {
    fn decide<'a>(
        &'a mut self,
        _prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async { LocalPermissionDecision::Unavailable })
    }
}
fn stream(kind: &str) -> String {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    fixture["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["wire"] == "openai-chat" && c["kind"] == kind)
        .unwrap()["stream"]
        .as_str()
        .unwrap()
        .into()
}
fn server(streams: Vec<String>) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    server_with_reply_gate(streams, |_| {})
}
fn server_with_reply_gate(
    streams: Vec<String>,
    before_reply: impl FnMut(usize) + Send + 'static,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    raw_server_with_reply_gate(
        streams
            .into_iter()
            .map(|body| retry::sse_response(&body, body.len()))
            .collect(),
        before_reply,
    )
}
fn raw_server_with_reply_gate(
    responses: Vec<String>,
    mut before_reply: impl FnMut(usize) + Send + 'static,
) -> (String, std::thread::JoinHandle<Vec<Value>>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    listener.set_nonblocking(true).unwrap();
    let handle = std::thread::spawn(move || {
        let mut requests = vec![];
        for (request_index, response) in responses.into_iter().enumerate() {
            let deadline = Instant::now() + Duration::from_secs(20);
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    e => panic!("ordinary controlled socket: {e:?}"),
                }
            };
            // Darwin may inherit O_NONBLOCK from the listening socket. This
            // worker uses bounded blocking I/O, just like the public CLI fixture.
            #[cfg(unix)]
            eprintln!(
                "ordinary HTTP request {request_index}: inherited_nonblocking={}",
                rustix::fs::fcntl_getfl(&socket)
                    .unwrap()
                    .contains(rustix::fs::OFlags::NONBLOCK)
            );
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            let mut head = vec![];
            while !head.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                socket.read_exact(&mut b).unwrap_or_else(|error| {
                    panic!(
                        "ordinary request {request_index}, header bytes {}: {error}",
                        head.len()
                    )
                });
                head.push(b[0]);
                assert!(head.len() < 32768);
            }
            let head = String::from_utf8(head).unwrap();
            let n = head
                .lines()
                .find_map(|s| {
                    s.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(n < 1024 * 1024);
            let mut bytes = vec![0; n];
            socket.read_exact(&mut bytes).unwrap();
            requests.push(serde_json::from_slice(&bytes).unwrap());
            before_reply(request_index);
            socket.write_all(response.as_bytes()).unwrap();
        }
        requests
    });
    (endpoint, handle)
}
fn model(endpoint: String) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint,
            model: "model".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(5),
    )
    .unwrap()
}
fn tool_stream(name: &str, args: Value) -> String {
    let call = json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"ordinary-upstream","type":"function","function":{"name":name,"arguments":args.to_string()}}]},"finish_reason":"tool_calls"}]});
    format!(
        "data: {call}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":20,\"completion_tokens\":3,\"total_tokens\":23}}}}\n\ndata: [DONE]\n\n"
    )
}
fn create_conversation(root: &Path, workspace: &Path) -> String {
    ConversationStore::new(root)
        .create(
            &NewConversation {
                title: "ordinary abnormal exit",
                workspace_path: std::fs::canonicalize(workspace).unwrap().to_str(),
                mode: "chat",
                created_at: &now(),
            },
            None,
        )
        .unwrap()["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn running_child(root: &Path, conversation: &str) -> peer_protocol::NativeProcessRecorder {
    use peer_protocol::{NativeProcessState, NativeShellSession};
    let deadline = Instant::now() + Duration::from_secs(8);
    loop {
        let run = ConversationStore::new(root)
            .read_conversation_execution(conversation)
            .unwrap();
        if let Some(run) = run {
            let foreground = run
                .handles
                .iter()
                .filter_map(NativeShellSession::from_handle)
                .filter(|shell| shell.command.is_some())
                .map(|shell| shell.process);
            if let Some(child) = foreground
                .chain(
                    run.pending_tools
                        .into_iter()
                        .filter_map(|p| p.native_process),
                )
                .find(|p| p.state == NativeProcessState::Running)
                .and_then(|p| p.child)
            {
                return child;
            }
        }
        assert!(
            Instant::now() < deadline,
            "actual Shell child was never registered"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

fn canonical_tool(root: &Path, conversation: &str) -> Value {
    ConversationStore::new(root)
        .read_committed(conversation, None, 8 * 1024 * 1024)
        .unwrap()
        .history
        .messages
        .into_iter()
        .find(|m| {
            m["segments"]
                .as_array()
                .is_some_and(|s| s.iter().any(|s| s["type"] == "tool-call"))
        })
        .expect("actual canonical tool intent")
}

#[tokio::test]
async fn original_grant_revocation_stops_background_shell_during_the_next_model_request() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let conversation = create_conversation(root.path(), workspace.path());
    let (continued, observed) = std::sync::mpsc::channel();
    let (reply, paused) = std::sync::mpsc::channel();
    let (endpoint, served) = server_with_reply_gate(
        vec![
            tool_stream(
                "bash",
                json!({"command":"exec /bin/sleep 20","background":true,"timeoutMs":15000}),
            ),
            stream("text"),
        ],
        move |index| {
            if index == 1 {
                continued.send(()).unwrap();
                paused.recv_timeout(Duration::from_secs(4)).unwrap();
            }
        },
    );
    let first_model = model(endpoint);
    let access = ConversationAccess::new(LocalAccessLevel::FullLocal);
    let runtime = NativeConversationRuntime::new(root.path(), access.clone());
    let cancel = CancellationToken::new();
    let options = ConversationOptions {
        workspace: workspace.path(),
        conversation_id: Some(&conversation),
        resume_from: None,
        prompt: "Launch one bounded background operation",
        image_paths: &[],
        provider_id: "fixture",
        mode: RuntimeMode::Chat,
        effort: "default",
        persist_model_selection: false,
        allowlist: None,
        max_turns: None,
    };
    let mut permission = NoInput;
    let run = runtime.execute(&options, &first_model, &mut permission, &cancel);
    let revoke = async {
        tokio::task::spawn_blocking(move || observed.recv_timeout(Duration::from_secs(4)))
            .await
            .unwrap()
            .unwrap();
        let child = running_child(root.path(), &conversation).await;
        let saved = canonical_tool(root.path(), &conversation);
        assert_eq!(
            saved["segments"][0]["result"]["output"]["status"],
            "running"
        );
        tokio::time::sleep(Duration::from_millis(350)).await;
        assert!(!crate::providers::group_absent(child.pid));
        access.set(LocalAccessLevel::AskBeforeLocal).unwrap();
        tokio::time::timeout(Duration::from_secs(3), async {
            while !crate::providers::group_absent(child.pid) {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        reply.send(()).unwrap();
        saved
    };
    let (outcome, saved) = tokio::join!(run, revoke);
    assert!(outcome.unwrap().error.is_none());
    assert_eq!(served.join().unwrap().len(), 2);
    let store = ConversationStore::new(root.path());
    let settled = store
        .read_conversation_execution(&conversation)
        .unwrap()
        .unwrap();
    assert!(settled.permits_new_run() && settled.handles.is_empty());
    assert_eq!(canonical_tool(root.path(), &conversation), saved);
}

#[derive(Clone, Copy, Debug)]
enum Interruption {
    Cancel,
    Revoke,
    ForeignMessage,
    ForeignGrant,
}
#[cfg(unix)]
#[tokio::test]
async fn actual_shell_interruptions_drain_owned_child_keep_facts_and_admit_later_work() {
    for interruption in [
        Interruption::Cancel,
        Interruption::Revoke,
        Interruption::ForeignMessage,
        Interruption::ForeignGrant,
    ] {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let conversation = create_conversation(root.path(), workspace.path());
        let (endpoint, served) = server(vec![tool_stream(
            "bash",
            json!({"command":"printf entered > entered; /bin/sleep 30"}),
        )]);
        let first_model = model(endpoint);
        let access = ConversationAccess::new(LocalAccessLevel::FullLocal);
        let runtime = NativeConversationRuntime::new(root.path(), access.clone());
        let cancel = CancellationToken::new();
        let options = ConversationOptions {
            workspace: workspace.path(),
            conversation_id: Some(&conversation),
            resume_from: None,
            prompt: "Run the bounded foreground command",
            image_paths: &[],
            provider_id: "fixture",
            mode: RuntimeMode::Chat,
            effort: "default",
            persist_model_selection: false,
            allowlist: None,
            max_turns: None,
        };
        let mut permission = NoInput;
        let run = runtime.execute(&options, &first_model, &mut permission, &cancel);
        let interrupt = async {
            let child = running_child(root.path(), &conversation).await;
            let deadline = Instant::now() + Duration::from_secs(5);
            while !std::fs::read(workspace.path().join("entered"))
                .is_ok_and(|bytes| bytes == b"entered")
            {
                assert!(
                    Instant::now() < deadline,
                    "command did not really enter the interpreter"
                );
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
            let original = canonical_tool(root.path(), &conversation);
            let store = ConversationStore::new(root.path());
            match interruption {
                Interruption::Cancel => cancel.cancel(),
                Interruption::Revoke => access.set(LocalAccessLevel::AskBeforeLocal).unwrap(),
                Interruption::ForeignMessage => {
                    let fresh = store
                        .read_committed(&conversation, None, 8 * 1024 * 1024)
                        .unwrap();
                    store.commit_message(&fresh, &json!({"id":"foreign-input","role":"user","content":"Preserve my later input","createdAt":now()}), &now(), None).unwrap();
                }
                Interruption::ForeignGrant => {
                    let fresh = store
                        .read_committed(&conversation, None, 8 * 1024 * 1024)
                        .unwrap();
                    let mut changed = original["permissionGrants"].clone();
                    changed[0]["reason"] = json!("foreign-record-do-not-overwrite");
                    store
                        .commit_terminal_message(
                            &fresh,
                            original["id"].as_str().unwrap(),
                            &json!({"permissionGrants":changed}),
                            &now(),
                            None,
                        )
                        .unwrap();
                }
            }
            (child, original)
        };
        let began = Instant::now();
        let (outcome, (child, original)) = tokio::join!(run, interrupt);
        let outcome = outcome.unwrap();
        assert!(
            began.elapsed() < Duration::from_secs(8),
            "{interruption:?}: cleanup was not bounded"
        );
        assert_eq!(
            served.join().unwrap().len(),
            1,
            "no model continuation after interruption"
        );
        assert_eq!(outcome.turns, 1);
        assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 23);
        assert!(
            crate::recorder::prove(&child).await.allows_settlement(),
            "{interruption:?}: actual child survived"
        );
        assert!(
            crate::providers::group_absent(child.pid),
            "{interruption:?}: actual group survived"
        );
        let store = ConversationStore::new(root.path());
        let stopped = store
            .read_conversation_execution(&conversation)
            .unwrap()
            .unwrap();
        assert!(
            stopped.usage_committed,
            "known charges survive {interruption:?}"
        );
        assert!(stopped.handles.is_empty());
        let facts = canonical_tool(root.path(), &conversation);
        let result = &facts["segments"][0]["result"];
        if matches!(interruption, Interruption::ForeignGrant) {
            assert_eq!(outcome.error, Some("conversation_tool_intent_changed"));
            assert_eq!(
                facts["permissionGrants"][0]["reason"],
                "foreign-record-do-not-overwrite"
            );
            assert!(
                result.is_null(),
                "do not overwrite foreign authorization facts"
            );
            assert!(!stopped.permits_new_run());
            assert_eq!(stopped.pending_tools.len(), 1);
        } else {
            assert!(!stopped.permits_new_run());
            assert_eq!(stopped.pending_tools.len(), 1);
            let pending = &stopped.pending_tools[0];
            assert_eq!(
                pending.phase,
                peer_protocol::ConversationDispatchPhase::OutcomeUnknown
            );
            assert_eq!(facts["permissionGrants"], original["permissionGrants"]);
            assert_eq!(result["status"], "failed");
            assert_eq!(result["error"]["code"], "execution_outcome_unknown");
            assert_eq!(
                result["evidence"]["shellSession"]["dispatchId"],
                pending.dispatch_id
            );
            assert_eq!(
                result["evidence"]["permissionGrantId"],
                original["permissionGrants"][0]["grantId"]
            );
            let call = result["toolCallId"].as_str().unwrap();
            assert!(
                !peer_store::EvidenceIndexStore::new(root.path())
                    .find(&[format!("tool-result://{call}")], None)
                    .unwrap()
                    .is_empty()
            );
            assert!(outcome.error.is_some());
        }
        if matches!(interruption, Interruption::ForeignMessage) {
            assert!(
                store
                    .read_committed(&conversation, None, 8 * 1024 * 1024)
                    .unwrap()
                    .history
                    .messages
                    .iter()
                    .any(
                        |m| m["id"] == "foreign-input" && m["content"] == "Preserve my later input"
                    )
            );
        }
        // An unresolved old effect does not block an independent conversation.
        let (endpoint, served) = server(vec![stream("text")]);
        let next = ConversationOptions {
            conversation_id: None,
            prompt: "A new independent task",
            image_paths: &[],
            ..options
        };
        let later = runtime
            .execute(
                &next,
                &model(endpoint),
                &mut NoInput,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(
            later.error, None,
            "{interruption:?}: later admission failed"
        );
        assert_eq!(later.turns, 1);
        assert_eq!(served.join().unwrap().len(), 1);
    }
}
#[tokio::test]
async fn actual_ask_denial_and_explicit_full_grant_have_real_evidence_and_effects() {
    for full in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let sentinel = workspace.path().join("approved.txt");
        let (endpoint, served) = server(vec![
            tool_stream("bash", json!({"command":"printf approved > approved.txt"})),
            stream("text"),
        ]);
        let runtime = NativeConversationRuntime::new(
            root.path(),
            ConversationAccess::new(if full {
                LocalAccessLevel::FullLocal
            } else {
                LocalAccessLevel::AskBeforeLocal
            }),
        );
        let outcome = runtime
            .execute(
                &ConversationOptions {
                    workspace: workspace.path(),
                    conversation_id: None,
                    resume_from: None,
                    prompt: "Run the requested command",
                    image_paths: &[],
                    provider_id: "fixture",
                    mode: RuntimeMode::Chat,
                    effort: "default",
                    persist_model_selection: false,
                    allowlist: None,
                    max_turns: None,
                },
                &model(endpoint),
                &mut NoInput,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(outcome.error, None);
        assert_eq!(sentinel.exists(), full);
        let facts = canonical_tool(root.path(), &outcome.session_id);
        assert_eq!(facts["permissionGrants"][0]["granted"], full);
        let result = &facts["segments"][0]["result"];
        assert_eq!(result["status"], if full { "success" } else { "denied" });
        let call = result["toolCallId"].as_str().unwrap();
        assert!(
            !peer_store::EvidenceIndexStore::new(root.path())
                .find(&[format!("tool-result://{call}")], None)
                .unwrap()
                .is_empty()
        );
        assert!(
            ConversationStore::new(root.path())
                .read_conversation_execution(&outcome.session_id)
                .unwrap()
                .unwrap()
                .permits_new_run()
        );
        assert_eq!(served.join().unwrap().len(), 2);
    }
}
#[tokio::test]
async fn actual_ordinary_model_file_grant_evidence_usage_stop_and_subsequent_run_use_no_goal() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    std::fs::write(workspace.path().join("input.txt"), "real ordinary source").unwrap();
    let (endpoint, served) = server(vec![stream("tool"), stream("text"), stream("text")]);
    let model = model(endpoint);
    let runtime = NativeConversationRuntime::new(
        root.path(),
        ConversationAccess::new(LocalAccessLevel::SessionLocal),
    );
    let options = ConversationOptions {
        workspace: workspace.path(),
        conversation_id: None,
        resume_from: None,
        prompt: "Read input.txt and answer",
        image_paths: &[],
        provider_id: "fixture",
        mode: RuntimeMode::Chat,
        effort: "default",
        persist_model_selection: false,
        allowlist: None,
        max_turns: None,
    };
    let outcome = runtime
        .execute(&options, &model, &mut NoInput, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(outcome.error, None);
    assert_eq!(outcome.content, "Native complete.");
    assert_eq!(outcome.turns, 2);
    assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 46);
    assert_eq!(outcome.lifetime_usage.unwrap()["totalTokens"], 46);
    let store = ConversationStore::new(root.path());
    let run = store
        .read_conversation_execution(&outcome.session_id)
        .unwrap()
        .unwrap();
    assert!(run.permits_new_run());
    let history = store
        .read_committed(&outcome.session_id, None, 8 * 1024 * 1024)
        .unwrap();
    let result = history
        .history
        .messages
        .iter()
        .flat_map(|m| m["segments"].as_array().into_iter().flatten())
        .find_map(|s| s.get("result"))
        .unwrap();
    assert_eq!(result["status"], "success");
    assert_eq!(result["output"]["content"], "real ordinary source");
    let call = result["toolCallId"].as_str().unwrap();
    assert!(
        !peer_store::EvidenceIndexStore::new(root.path())
            .find(&[format!("tool-result://{call}")], None)
            .unwrap()
            .is_empty()
    );
    assert!(
        !root
            .path()
            .join("project-runtime/coordination.sqlite")
            .exists()
    );
    assert!(!root.path().join("execution-resources.json").exists());
    assert_eq!(
        std::fs::read_dir(root.path().join("goal-plans"))
            .unwrap()
            .count(),
        1,
        "only the existing shared Evidence index, never a fabricated Goal"
    );
    let options = ConversationOptions {
        conversation_id: Some(&outcome.session_id),
        prompt: "Continue independently",
        image_paths: &[],
        ..options
    };
    let second = runtime
        .execute(&options, &model, &mut NoInput, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(second.error, None);
    assert_eq!(second.turns, 1);
    assert_eq!(second.lifetime_usage.unwrap()["totalTokens"], 69);
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 3);
    let system = requests[0]["messages"][0]["content"].as_str().unwrap();
    assert!(system.contains("Design-before-implementation"));
    assert!(!system.contains("Canonical Goal snapshot"));
    assert!(!system.contains("Current local task admission"));
    assert!(
        requests[1]["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["role"] == "tool"
                && m["content"].to_string().contains("real ordinary source"))
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("usage/requests.jsonl"))
            .unwrap()
            .lines()
            .count(),
        2
    );
}

#[tokio::test]
async fn interactive_user_input_self_grants_settles_stops_batch_and_continues() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let batch = json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [
                    {
                        "index": 0,
                        "id": "ask-1",
                        "type": "function",
                        "function": {
                            "name": "request_user_input",
                            "arguments": json!({"question": "Which plan?", "options": ["Option A", "Option B"]}).to_string()
                        }
                    },
                    {
                        "index": 1,
                        "id": "write-blocked",
                        "type": "function",
                        "function": {
                            "name": "write_file",
                            "arguments": json!({"path": "should-not-exist.txt", "content": "x"}).to_string()
                        }
                    }
                ]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let ask_stream = format!(
        "data: {batch}\n\ndata: {{\"choices\":[],\"usage\":{{\"prompt_tokens\":10,\"completion_tokens\":2,\"total_tokens\":12}}}}\n\ndata: [DONE]\n\n"
    );
    let (endpoint, served) = server(vec![ask_stream, stream("text")]);
    let model = model(endpoint);
    let runtime = NativeConversationRuntime::new(
        root.path(),
        ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
    );
    let options = ConversationOptions {
        workspace: workspace.path(),
        conversation_id: None,
        resume_from: None,
        prompt: "Need a choice",
        image_paths: &[],
        provider_id: "fixture",
        mode: RuntimeMode::Chat,
        effort: "default",
        persist_model_selection: false,
        allowlist: None,
        max_turns: None,
    };
    let outcome = runtime
        .execute_interactive(
            &options,
            &model,
            &mut NoInput,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(outcome.error, None);
    assert!(!workspace.path().join("should-not-exist.txt").exists());
    let row = canonical_tool(root.path(), &outcome.session_id);
    assert_eq!(row["permissionGrants"][0]["granted"], true);
    assert_eq!(
        row["permissionGrants"][0]["reason"],
        crate::providers::interaction::SELF_GRANT_REASON
    );
    let seg = row["segments"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["tool"] == "request_user_input")
        .unwrap();
    assert_eq!(seg["result"]["status"], "success");
    assert_eq!(seg["result"]["output"]["question"], "Which plan?");
    assert_eq!(
        seg["result"]["output"]["options"],
        json!(["Option A", "Option B"])
    );
    assert_eq!(seg["result"]["output"]["control"]["terminal"], true);

    let followup = runtime
        .execute_interactive(
            &ConversationOptions {
                conversation_id: Some(&outcome.session_id),
                prompt: "Option A",
                ..options
            },
            &model,
            &mut NoInput,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(followup.error, None);
    assert_eq!(followup.content, "Native complete.");
    let requests = served.join().unwrap();
    assert_eq!(requests.len(), 2);
    let manifest_desc = requests[0]["tools"]
        .as_array()
        .unwrap()
        .iter()
        .find(|t| t["function"]["name"] == "request_user_input")
        .unwrap()["function"]["description"]
        .as_str()
        .unwrap();
    assert!(manifest_desc.contains("stop the current turn to wait for their reply"));
}

#[tokio::test]
async fn session_approval_permits_identical_operation_until_access_revision_changes() {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    struct SessionInput(Arc<AtomicUsize>, Arc<std::sync::Mutex<Vec<Value>>>);
    impl PermissionInput for SessionInput {
        fn decide<'a>(
            &'a mut self,
            prompt: Value,
            _cancel: &'a CancellationToken,
        ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>>
        {
            self.0.fetch_add(1, Ordering::SeqCst);
            self.1.lock().unwrap().push(prompt);
            Box::pin(async { LocalPermissionDecision::ApproveSession })
        }
    }

    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let args = json!({"path": "session-file.txt", "content": "ok"});
    let (endpoint, _served) = server(vec![
        tool_stream("write_file", args.clone()),
        stream("text"),
        tool_stream("write_file", args.clone()),
        stream("text"),
        tool_stream("write_file", args.clone()),
        stream("text"),
    ]);
    let model = model(endpoint);
    let access = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
    let runtime = NativeConversationRuntime::new(root.path(), access.clone());
    let prompts_count = Arc::new(AtomicUsize::new(0));
    let seen_prompts = Arc::new(std::sync::Mutex::new(Vec::new()));
    let mut input = SessionInput(prompts_count.clone(), seen_prompts.clone());

    let first = runtime
        .execute_interactive(
            &ConversationOptions {
                workspace: workspace.path(),
                conversation_id: None,
                resume_from: None,
                prompt: "Write once",
                image_paths: &[],
                provider_id: "fixture",
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: None,
                max_turns: None,
            },
            &model,
            &mut input,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(first.error, None);
    assert_eq!(prompts_count.load(Ordering::SeqCst), 1);
    let captured = seen_prompts.lock().unwrap().clone();
    assert_eq!(captured[0]["capabilityId"], "local.file.write");
    assert_eq!(captured[0]["riskLevel"], "L2_local_write");
    let first_grant = canonical_tool(root.path(), &first.session_id);
    assert_eq!(
        first_grant["permissionGrants"][0]["reason"],
        "approved_for_tui_session"
    );
    assert_eq!(first_grant["permissionGrants"][0]["duration"], "session");

    let second = runtime
        .execute_interactive(
            &ConversationOptions {
                workspace: workspace.path(),
                conversation_id: Some(&first.session_id),
                resume_from: None,
                prompt: "Write twice without re-prompting",
                image_paths: &[],
                provider_id: "fixture",
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: None,
                max_turns: None,
            },
            &model,
            &mut input,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(second.error, None);
    assert_eq!(prompts_count.load(Ordering::SeqCst), 1);

    // Changing access policy bumps revision and invalidates prior session approvals.
    access.set(LocalAccessLevel::SessionLocal).unwrap();
    access.set(LocalAccessLevel::AskBeforeLocal).unwrap();
    let third = runtime
        .execute_interactive(
            &ConversationOptions {
                workspace: workspace.path(),
                conversation_id: Some(&first.session_id),
                resume_from: None,
                prompt: "Write after policy reset",
                image_paths: &[],
                provider_id: "fixture",
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: None,
                max_turns: None,
            },
            &model,
            &mut input,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(third.error, None);
    assert_eq!(prompts_count.load(Ordering::SeqCst), 2);
}

// A session delegated by a project Bot follows that Bot's saved policy
// (ADR101 §2.3, §6.1). The role profile never carries a copied level.
const POLICY_AT: &str = "2026-11-25T00:00:00.000Z";

fn seed_bot_policy(root: &tempfile::TempDir, workspace_id: &str, level: LocalAccessLevel) {
    let profile = root
        .path()
        .join("projects")
        .join(workspace_id)
        .join("profile.json");
    std::fs::create_dir_all(profile.parent().unwrap()).unwrap();
    std::fs::write(
        &profile,
        json!({
            "workspaceId": workspace_id,
            "displayName": "Policy Bot",
            "avatar": {},
            "status": "active",
            "agentConversationId": format!("bot-{workspace_id}"),
        })
        .to_string(),
    )
    .unwrap();
    peer_store::PolicyStore::new(root.path())
        .initialize(level, POLICY_AT, None)
        .unwrap();
}

#[test]
fn bot_owned_access_follows_the_saved_policy_instead_of_a_spawn_time_level() {
    let root = tempfile::tempdir().unwrap();
    seed_bot_policy(&root, "ws-policy", LocalAccessLevel::FullLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-policy").unwrap();
    assert!(access.follows_bot());
    assert_eq!(access.snapshot().unwrap(), (LocalAccessLevel::FullLocal, 1));
    assert_eq!(
        access.policy_revision("stream", 1).unwrap(),
        "bot:ws-policy:bot-ws-policy:1"
    );
    // The classic level command cannot change a Bot-owned policy.
    assert_eq!(
        access.set(LocalAccessLevel::SessionLocal).unwrap_err().0,
        "access_policy_bot_owned"
    );
    // A classic session keeps its own revision label.
    let classic = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
    assert!(!classic.follows_bot());
    assert_eq!(
        classic.policy_revision("stream", 0).unwrap(),
        "ordinary:stream:0"
    );

    // A policy saved while the session runs reaches its next call and ends the
    // approvals that were given under the earlier policy.
    assert!(
        access
            .remember_session_approval(1, "op".to_owned())
            .unwrap()
    );
    peer_store::PolicyStore::new(root.path())
        .update_existing("ws-policy", 1, LocalAccessLevel::AskBeforeLocal, POLICY_AT)
        .unwrap();
    assert_eq!(
        access.snapshot().unwrap(),
        (LocalAccessLevel::AskBeforeLocal, 2)
    );
    assert!(!access.has_session_approval(2, "op").unwrap());
    // Raising the policy back does not revive the earlier approval.
    peer_store::PolicyStore::new(root.path())
        .update_existing("ws-policy", 2, LocalAccessLevel::FullLocal, POLICY_AT)
        .unwrap();
    assert_eq!(access.snapshot().unwrap(), (LocalAccessLevel::FullLocal, 3));
    assert!(!access.has_session_approval(3, "op").unwrap());
    assert!(!access.has_session_approval(1, "op").unwrap());
}

#[test]
fn unreadable_or_foreign_bot_policy_rejects_instead_of_borrowing_another_level() {
    let root = tempfile::tempdir().unwrap();
    // No Bot owns this workspace.
    assert_eq!(
        ConversationAccess::for_bot(root.path(), "ws-missing")
            .unwrap_err()
            .0,
        "access_identity_invalid"
    );
    seed_bot_policy(&root, "ws-policy", LocalAccessLevel::FullLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-policy").unwrap();
    // The Bot's agent conversation was replaced: the session's principal is gone.
    let profile = root.path().join("projects/ws-policy/profile.json");
    let mut saved: Value = serde_json::from_slice(&std::fs::read(&profile).unwrap()).unwrap();
    saved["agentConversationId"] = json!("bot-replaced");
    std::fs::write(&profile, saved.to_string()).unwrap();
    assert_eq!(access.snapshot().unwrap_err().0, "access_identity_invalid");
    saved["agentConversationId"] = json!("bot-ws-policy");
    std::fs::write(&profile, saved.to_string()).unwrap();
    assert_eq!(access.snapshot().unwrap(), (LocalAccessLevel::FullLocal, 1));
    // A damaged policy store never becomes Full or any other level.
    std::fs::write(
        root.path().join("project-runtime/bot-access.sqlite"),
        b"not a policy store",
    )
    .unwrap();
    assert_eq!(
        access.snapshot().unwrap_err().0,
        "access_policy_unavailable"
    );
    assert_eq!(
        ConversationAccess::for_bot(root.path(), "ws-policy")
            .unwrap_err()
            .0,
        "access_policy_unavailable"
    );
}

/// A real Git repository with two configuration sources outside the workspace,
/// like a machine-wide system and user configuration.
#[cfg(unix)]
fn git_repository(directory: &Path, includes: &[PathBuf]) {
    let home = directory.join(".git-fixture-home");
    std::fs::create_dir_all(directory).unwrap();
    std::fs::write(directory.join("input.txt"), "owned source").unwrap();
    let git = |args: &[&str]| {
        let output = std::process::Command::new("/usr/bin/git")
            .args(args)
            .current_dir(directory)
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .env("HOME", &home)
            .env("GIT_CONFIG_NOSYSTEM", "1")
            .env("GIT_AUTHOR_NAME", "Host Fixture")
            .env("GIT_AUTHOR_EMAIL", "host@example.invalid")
            .env("GIT_COMMITTER_NAME", "Host Fixture")
            .env("GIT_COMMITTER_EMAIL", "host@example.invalid")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    git(&["init", "--initial-branch=main"]);
    git(&["add", "input.txt"]);
    git(&["commit", "-m", "owned original"]);
    for include in includes {
        git(&["config", "--add", "include.path", include.to_str().unwrap()]);
    }
}

#[cfg(unix)]
fn outside_includes(outside: &Path) -> [PathBuf; 2] {
    let first = outside.join("first.config");
    let second = outside.join("second.config");
    std::fs::write(&first, "[user]\n\tname = First outside source\n").unwrap();
    std::fs::write(&second, "[user]\n\temail = second@example.invalid\n").unwrap();
    [first, second]
}

#[derive(Clone, Copy)]
enum Answer {
    Once,
    Repeat,
    Deny,
}
struct Answering {
    answer: Answer,
    prompts: Arc<std::sync::Mutex<Vec<Value>>>,
}
impl PermissionInput for Answering {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        self.prompts.lock().unwrap().push(prompt);
        Box::pin(async move {
            match self.answer {
                Answer::Once => LocalPermissionDecision::Approve,
                Answer::Repeat => LocalPermissionDecision::ApproveSession,
                Answer::Deny => LocalPermissionDecision::Deny,
            }
        })
    }
}

#[cfg(unix)]
fn answering(answer: Answer) -> Answering {
    Answering {
        answer,
        prompts: Arc::default(),
    }
}

/// One real `git_query` of `path` through the ordinary Host and Git. It
/// returns the tool message of this call and the conversation outcome. A
/// denied read ends the turn, so that call consumes no model reply.
#[cfg(unix)]
async fn observe_repository(
    root: &tempfile::TempDir,
    access: &ConversationAccess,
    workspace: &Path,
    path: &str,
    conversation: Option<&str>,
    permission: &mut dyn PermissionInput,
    replies: usize,
) -> (Value, ConversationOutcome) {
    let mut streams = vec![tool_stream("git_query", json!({"path": path}))];
    if replies == 2 {
        streams.push(stream("text"));
    }
    let (endpoint, served) = server(streams);
    let runtime = NativeConversationRuntime::new(root.path(), access.clone());
    let outcome = runtime
        .execute_interactive(
            &ConversationOptions {
                workspace,
                conversation_id: conversation,
                resume_from: None,
                prompt: "Observe the repository",
                image_paths: &[],
                provider_id: "fixture",
                mode: RuntimeMode::Chat,
                effort: "default",
                persist_model_selection: false,
                allowlist: None,
                max_turns: None,
            },
            &model(endpoint),
            permission,
            None,
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(served.join().unwrap().len(), replies);
    (last_tool_message(root.path(), &outcome.session_id), outcome)
}

/// The canonical tool message of the latest call in a conversation.
fn last_tool_message(root: &Path, conversation: &str) -> Value {
    ConversationStore::new(root)
        .read_committed(conversation, None, 8 * 1024 * 1024)
        .unwrap()
        .history
        .messages
        .into_iter()
        .rfind(|m| {
            m["segments"]
                .as_array()
                .is_some_and(|s| s.iter().any(|s| s["type"] == "tool-call"))
        })
        .expect("actual canonical tool intent of this call")
}

/// Configuration sources of an observation that lie outside the workspace.
#[cfg(unix)]
fn outside_sources(message: &Value, workspace: &Path) -> Vec<String> {
    let workspace = workspace.canonicalize().unwrap();
    message["segments"][0]["result"]["output"]["configurationSources"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|source| source.as_str())
        .filter(|source| !Path::new(source).starts_with(&workspace))
        .map(str::to_owned)
        .collect()
}

/// The call succeeded, and every outside configuration source has its own
/// granted grant after the repository's own grant.
#[cfg(unix)]
fn assert_configuration_grants(message: &Value, workspace: &Path, reason: &str) -> Vec<String> {
    let result = &message["segments"][0]["result"];
    assert_eq!(result["status"], "success", "{result}");
    let sources = outside_sources(message, workspace);
    assert!(sources.len() >= 2, "{sources:?}");
    let grants = message["permissionGrants"].as_array().unwrap();
    assert_eq!(
        grants.len(),
        1 + sources.len(),
        "the repository and each outside source keep their own grant"
    );
    assert!(grants.iter().all(|grant| grant["granted"] == true));
    assert!(
        grants[1..].iter().all(|grant| grant["reason"] == reason),
        "{grants:?}"
    );
    sources
}

#[cfg(unix)]
#[tokio::test]
async fn delegated_git_query_reads_outside_configuration_without_a_prompt_under_full() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let includes = outside_includes(outside.path());
    // The repository is the workspace. Its effective configuration also comes
    // from files outside it, as with a machine-wide Git configuration.
    git_repository(workspace.path(), &includes);
    seed_bot_policy(&root, "ws-full", LocalAccessLevel::FullLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-full").unwrap();
    // Any request would be answered "unavailable": a Full Bot is not asked.
    let (message, outcome) =
        observe_repository(&root, &access, workspace.path(), ".", None, &mut NoInput, 2).await;
    assert_eq!(outcome.error, None);
    let sources = assert_configuration_grants(&message, workspace.path(), "host_policy_read");
    for include in &includes {
        let include = include.canonicalize().unwrap();
        assert!(
            sources.contains(&include.to_str().unwrap().to_owned()),
            "{sources:?}"
        );
    }
    assert_eq!(
        message["permissionGrants"][0]["reason"],
        "local_access_level_full"
    );
    assert_eq!(
        message["permissionGrants"][0]["metadata"]["policyRevision"],
        "bot:ws-full:bot-ws-full:1"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn a_policy_saved_while_the_session_runs_reaches_its_next_call() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    git_repository(workspace.path(), &outside_includes(outside.path()));
    seed_bot_policy(&root, "ws-live", LocalAccessLevel::FullLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-live").unwrap();
    let (before, outcome) =
        observe_repository(&root, &access, workspace.path(), ".", None, &mut NoInput, 2).await;
    assert_eq!(outcome.error, None);
    assert_configuration_grants(&before, workspace.path(), "host_policy_read");

    // The user lowers the Bot to "ask" while the same session keeps running.
    peer_store::PolicyStore::new(root.path())
        .update_existing("ws-live", 1, LocalAccessLevel::AskBeforeLocal, POLICY_AT)
        .unwrap();
    let mut permission = answering(Answer::Once);
    let (after, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        None,
        &mut permission,
        2,
    )
    .await;
    assert_eq!(outcome.error, None);
    // One decision covered every outside configuration source of that query.
    assert_eq!(permission.prompts.lock().unwrap().len(), 1);
    assert_configuration_grants(&after, workspace.path(), "approved_once_in_tui");
    assert_eq!(
        after["permissionGrants"][0]["metadata"]["policyRevision"],
        "bot:ws-live:bot-ws-live:2"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn repeating_the_configuration_decision_covers_later_queries_of_that_repository() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let includes = outside_includes(outside.path());
    git_repository(workspace.path(), &includes);
    git_repository(&workspace.path().join("second-repo"), &includes);
    seed_bot_policy(&root, "ws-ask", LocalAccessLevel::AskBeforeLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-ask").unwrap();
    let mut permission = answering(Answer::Repeat);

    // One decision for all outside configuration sources of the query.
    let (_, first) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        None,
        &mut permission,
        2,
    )
    .await;
    assert_eq!(first.error, None);
    assert_eq!(permission.prompts.lock().unwrap().len(), 1);
    let session = first.session_id;

    // The same repository in the same session needs no new decision.
    let (again, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        Some(&session),
        &mut permission,
        2,
    )
    .await;
    assert_eq!(outcome.error, None);
    assert_eq!(permission.prompts.lock().unwrap().len(), 1);
    assert_configuration_grants(&again, workspace.path(), "approved_for_tui_session");

    // Another repository has its own configuration and asks once.
    let (other, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        "second-repo",
        Some(&session),
        &mut permission,
        2,
    )
    .await;
    assert_eq!(outcome.error, None);
    assert_eq!(permission.prompts.lock().unwrap().len(), 2);
    assert_configuration_grants(&other, workspace.path(), "approved_for_tui_session");

    // A new policy revision ends the decision remembered under the old one.
    peer_store::PolicyStore::new(root.path())
        .update_existing("ws-ask", 1, LocalAccessLevel::SessionLocal, POLICY_AT)
        .unwrap();
    let (lowered, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        Some(&session),
        &mut permission,
        2,
    )
    .await;
    assert_eq!(outcome.error, None);
    assert_eq!(permission.prompts.lock().unwrap().len(), 3);
    assert_configuration_grants(&lowered, workspace.path(), "approved_for_tui_session");
    assert_eq!(
        lowered["permissionGrants"][0]["metadata"]["policyRevision"],
        "bot:ws-ask:bot-ws-ask:2"
    );
}

#[cfg(unix)]
#[tokio::test]
async fn denying_the_configuration_decision_denies_the_query_with_one_question() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    git_repository(workspace.path(), &outside_includes(outside.path()));
    seed_bot_policy(&root, "ws-deny", LocalAccessLevel::AskBeforeLocal);
    let access = ConversationAccess::for_bot(root.path(), "ws-deny").unwrap();
    let mut permission = answering(Answer::Deny);
    let (message, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        None,
        &mut permission,
        1,
    )
    .await;
    assert_eq!(permission.prompts.lock().unwrap().len(), 1);
    // The denied read ends the turn; nothing of the observation is published.
    assert_eq!(outcome.error, Some("git_read_permission_denied"));
    let result = &message["segments"][0]["result"];
    assert_ne!(result["status"], "success");
    assert!(result["output"]["configurationSources"].is_null());
    let grants = message["permissionGrants"].as_array().unwrap();
    assert_eq!(grants.len(), 2, "the repository read and the denied source");
    assert_eq!(grants[1]["granted"], false);
    assert_eq!(grants[1]["duration"], "denied");
    assert!(
        !root
            .path()
            .join("conversations")
            .join(format!("{}.tool-results", outcome.session_id))
            .exists()
    );
}

#[cfg(unix)]
#[tokio::test]
async fn classic_session_keeps_one_decision_per_outside_configuration_source() {
    let root = tempfile::tempdir().unwrap();
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    git_repository(workspace.path(), &outside_includes(outside.path()));
    // Not delegated by a Bot: the recorded per-path Git approval stays as is.
    let access = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
    let mut permission = answering(Answer::Once);
    let (message, outcome) = observe_repository(
        &root,
        &access,
        workspace.path(),
        ".",
        None,
        &mut permission,
        2,
    )
    .await;
    assert_eq!(outcome.error, None);
    let sources = assert_configuration_grants(&message, workspace.path(), "approved_once_in_tui");
    // Every outside configuration source was a decision of its own.
    assert_eq!(permission.prompts.lock().unwrap().len(), sources.len());
    assert!(
        permission
            .prompts
            .lock()
            .unwrap()
            .iter()
            .all(|prompt| prompt["scopes"][0]["path"].is_string())
    );
}

/// An independent Verifier has no way to ask. It still follows its Bot's
/// policy for the Git configuration of the repository it checks: under Full
/// the outside sources are admitted; otherwise the query is refused without a
/// question.
#[cfg(unix)]
#[tokio::test]
async fn verifier_reads_outside_configuration_only_under_the_bots_full_policy() {
    for (level, allowed) in [
        (LocalAccessLevel::FullLocal, true),
        (LocalAccessLevel::AskBeforeLocal, false),
    ] {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        git_repository(workspace.path(), &outside_includes(outside.path()));
        let workspace_id = format!("ws-verifier-{allowed}");
        seed_bot_policy(&root, &workspace_id, level);
        let access = ConversationAccess::for_bot(root.path(), &workspace_id).unwrap();
        let allowlist = ["local.git.query".to_owned()];
        let mut streams = vec![tool_stream("git_query", json!({"path": "."}))];
        if allowed {
            streams.push(stream("text"));
        }
        let (endpoint, served) = server(streams);
        let outcome = NativeConversationRuntime::new(root.path(), access)
            .execute_verification(
                &ConversationOptions {
                    workspace: workspace.path(),
                    conversation_id: None,
                    resume_from: None,
                    prompt: "Check the Git state of the repository",
                    image_paths: &[],
                    provider_id: "fixture",
                    mode: RuntimeMode::Chat,
                    effort: "default",
                    persist_model_selection: false,
                    allowlist: Some(&allowlist),
                    max_turns: Some(2),
                },
                &model(endpoint),
                // A Verifier never obtains a decision from a user.
                &mut NoInput,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(served.join().unwrap().len(), if allowed { 2 } else { 1 });
        let message = last_tool_message(root.path(), &outcome.session_id);
        let result = &message["segments"][0]["result"];
        let grants = message["permissionGrants"].as_array().unwrap();
        if allowed {
            assert_eq!(outcome.error, None);
            assert_configuration_grants(&message, workspace.path(), "host_policy_read");
            assert_eq!(grants[0]["reason"], "local_access_level_full");
        } else {
            assert_eq!(outcome.error, Some("git_read_permission_denied"));
            assert_ne!(result["status"], "success");
            assert!(result["output"]["configurationSources"].is_null());
            assert_eq!(
                grants.len(),
                2,
                "the repository read and the refused source"
            );
            assert_eq!(grants[0]["granted"], true);
            assert_eq!(grants[1]["granted"], false);
        }
    }
}
