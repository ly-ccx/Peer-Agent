//! Actual ordinary production Host with real HTTP and original canonical Stores.
use super::*;
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
        for (request_index, body) in streams.into_iter().enumerate() {
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
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
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
