use peer_core_rpc::{CoreServerConfig, PROTOCOL_VERSION, ResolvedTurnModel, serve_io};
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{ChatDialect, GenerationOptions, Wire},
    },
};
use peer_store::{ConversationStore, NewConversation};
use serde_json::{Value, json};
use std::{collections::VecDeque, path::Path, sync::Arc, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::TcpListener,
    sync::Mutex,
};

struct RpcTestClient {
    reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    buffered_notifications: VecDeque<Value>,
}

impl RpcTestClient {
    async fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_vec(value).expect("serialize request");
        line.push(b'\n');
        self.writer.write_all(&line).await.expect("write line");
        self.writer.flush().await.expect("flush line");
    }

    async fn recv_raw(&mut self) -> Option<Value> {
        let mut line = String::new();
        let n = self.reader.read_line(&mut line).await.expect("read line");
        if n == 0 {
            return None;
        }
        Some(serde_json::from_str(&line).expect("parse rpc frame"))
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;
        loop {
            let msg = self
                .recv_raw()
                .await
                .expect("stream ended waiting for reply");
            if msg.get("id").and_then(Value::as_u64) == Some(id) && !msg.get("method").is_some() {
                return msg;
            }
            self.buffered_notifications.push_back(msg);
        }
    }

    async fn next_event(&mut self) -> Value {
        if let Some(msg) = self.buffered_notifications.pop_front() {
            return msg;
        }
        self.recv_raw()
            .await
            .expect("unexpected EOF waiting for event")
    }

    async fn drain_until(&mut self, predicate: impl Fn(&Value) -> bool) -> Vec<Value> {
        let mut collected = Vec::new();
        let deadline = tokio::time::Instant::now() + Duration::from_secs(15);
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out draining events; collected: {collected:?}"
            );
            let msg = tokio::time::timeout(remaining, self.next_event())
                .await
                .expect("timeout waiting for event");
            let done = predicate(&msg);
            collected.push(msg);
            if done {
                return collected;
            }
        }
    }
}

async fn spawn_mock_openai_sse(
    responses: Vec<String>,
) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock tcp listener");
    let addr = listener.local_addr().expect("local addr");
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let recorded_bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded_ref = Arc::clone(&recorded_bodies);

    let handle = tokio::spawn(async move {
        for sse_body in responses {
            let Ok((mut socket, _)) = listener.accept().await else {
                break;
            };
            let req_text = read_http_request(&mut socket).await;
            if let Some((_, body_str)) = req_text.split_once("\r\n\r\n")
                && let Ok(parsed) = serde_json::from_str::<Value>(body_str)
            {
                recorded_ref.lock().await.push(parsed);
            }
            let header = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
                sse_body.len()
            );
            let _ = socket.write_all(header.as_bytes()).await;
            let _ = socket.write_all(sse_body.as_bytes()).await;
            let _ = socket.shutdown().await;
        }
    });

    (endpoint, recorded_bodies, handle)
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::with_capacity(8192);
    let mut tmp = [0u8; 4096];
    let mut header_end = None;
    let mut content_length = 0usize;

    loop {
        let n = socket.read(&mut tmp).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
        if header_end.is_none()
            && let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n")
        {
            let end = pos + 4;
            header_end = Some(end);
            let headers_str = String::from_utf8_lossy(&buf[..end]);
            for line in headers_str.lines() {
                if let Some((k, v)) = line.split_once(':')
                    && k.trim().eq_ignore_ascii_case("content-length")
                {
                    content_length = v.trim().parse::<usize>().unwrap_or(0);
                }
            }
        }
        if let Some(end) = header_end
            && buf.len() >= end + content_length
        {
            break;
        }
    }
    String::from_utf8_lossy(&buf).into_owned()
}

fn sse_text_and_thinking_response(thinking: &str, text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"reasoning_content\":{thinking}}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{\"content\":{text}}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":24,\"completion_tokens\":12,\"total_tokens\":36}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        thinking = json!(thinking),
        text = json!(text),
    )
}

fn sse_tool_call_response(call_id: &str, name: &str, arguments_json: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"chatcmpl-tool\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id},\"type\":\"function\",\"function\":{{\"name\":{name},\"arguments\":{args}}}}}]}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-tool\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":30,\"completion_tokens\":10,\"total_tokens\":40}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        call_id = json!(call_id),
        name = json!(name),
        args = json!(arguments_json),
    )
}

fn make_test_loader(endpoint: String) -> peer_core_rpc::ModelLoader {
    Arc::new(move |_home, _provider_id, effort, _fast, _cancel| {
        let ep = endpoint.clone();
        Box::pin(async move {
            let model = NativeModel::new(
                ModelConfig {
                    endpoint: ep,
                    model: "mock-gpt".into(),
                    provider: "openai".into(),
                    wire: Wire::Chat,
                    generation: GenerationOptions {
                        effort: effort.clone().unwrap_or_else(|| "default".into()),
                        chat_dialect: ChatDialect::Environment,
                        ..Default::default()
                    },
                },
                None,
                Duration::from_secs(15),
            )
            .map_err(|e| peer_core_rpc::RpcError::internal_error(e.code))?;
            Ok(ResolvedTurnModel {
                provider_id: "mock-openai".into(),
                effort: effort.unwrap_or_else(|| "default".into()),
                model,
            })
        })
    })
}

fn create_prepared_conversation(
    home: &Path,
    workspace: &Path,
    user_text: &str,
    assistant_message_id: &str,
) -> String {
    let store = ConversationStore::new(home);
    let now = peer_runtime::capability::now();
    let created = store
        .create(
            &NewConversation {
                title: "Test Chat",
                workspace_path: Some(workspace.to_str().unwrap()),
                mode: "chat",
                created_at: &now,
            },
            None,
        )
        .expect("create conversation");
    let conv_id = created["id"].as_str().unwrap().to_owned();
    store
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "msg-user-1",
                "role": "user",
                "content": user_text,
                "createdAt": now,
            }),
            &now,
            None,
        )
        .expect("append user msg");
    store
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": assistant_message_id,
                "role": "assistant",
                "content": "",
                "segments": [],
                "createdAt": now,
            }),
            &now,
            None,
        )
        .expect("append assistant placeholder");
    conv_id
}

async fn setup_test_server(
    home: &Path,
    endpoint: String,
    external_capabilities: Vec<Value>,
) -> (
    RpcTestClient,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
    let (server_read, server_write) = tokio::io::split(server_stream);
    let (client_read, client_write) = tokio::io::split(client_stream);
    let shutdown = CancellationToken::new();
    let mut config = CoreServerConfig::new("0.1.0-test", home.to_path_buf());
    config.model_loader = Some(make_test_loader(endpoint));
    let handle = tokio::spawn(serve_io(
        server_read,
        server_write,
        config,
        shutdown.clone(),
    ));

    let mut client = RpcTestClient {
        reader: BufReader::new(client_read),
        writer: client_write,
        buffered_notifications: VecDeque::new(),
    };
    let init = client
        .call(
            1,
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "test-desktop", "version": "0.1.0" },
                "externalCapabilities": external_capabilities,
            }),
        )
        .await;
    assert!(init.get("result").is_some(), "init failed: {init:?}");
    (client, shutdown, handle)
}

#[tokio::test]
async fn streaming_deltas_thinking_usage_and_single_row_jsonl_commit() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let (endpoint, recorded, server_task) =
        spawn_mock_openai_sse(vec![sse_text_and_thinking_response(
            "Let me think.",
            "Hello from Rust core!",
        )])
        .await;

    let assistant_id = "msg-assistant-1";
    let conv_id =
        create_prepared_conversation(home.path(), workspace.path(), "Hi there", assistant_id);
    let (mut client, _shutdown, rpc_task) = setup_test_server(home.path(), endpoint, vec![]).await;

    let send_res = client
        .call(
            2,
            "classic.chat.send",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-1",
                "assistantMessageId": assistant_id,
                "workspacePath": workspace.path().to_string_lossy(),
                "mode": "chat",
                "persistModelSelection": true,
            }),
        )
        .await;
    assert_eq!(send_res["result"]["accepted"], true);

    let events = client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:done"))
        .await;

    let thinking: String = events
        .iter()
        .filter(|e| e["method"] == "chat:stream:thinking")
        .filter_map(|e| e["params"]["content"].as_str())
        .collect();
    assert_eq!(thinking, "Let me think.");

    let text: String = events
        .iter()
        .filter(|e| e["method"] == "chat:stream:delta")
        .filter_map(|e| e["params"]["content"].as_str())
        .collect();
    assert_eq!(text, "Hello from Rust core!");

    assert!(events.iter().any(|e| {
        e["method"] == "chat:stream:usage" && e["params"]["usage"]["inputTokens"] == 24
    }));

    let done = events
        .iter()
        .find(|e| e["method"] == "chat:stream:done")
        .unwrap();
    assert_eq!(done["params"]["conversationId"], conv_id);
    assert_eq!(done["params"]["usage"]["totalTokens"], 36);

    let store = ConversationStore::new(home.path());
    let committed = store.read_committed(&conv_id, None, 1024 * 1024).unwrap();
    assert_eq!(committed.history.messages.len(), 2);
    let assistant_row = &committed.history.messages[1];
    assert_eq!(assistant_row["id"], assistant_id);
    assert_eq!(assistant_row["content"], "Hello from Rust core!");
    assert_eq!(assistant_row["thinkingContent"], "Let me think.");
    assert_eq!(assistant_row["interrupted"], false);
    assert_eq!(recorded.lock().await.len(), 1);

    let _ = client.call(99, "core.shutdown", json!({})).await;
    drop(client);
    rpc_task.await.unwrap().unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn builtin_file_write_prompts_permission_approves_and_commits_grants() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let target_file = workspace.path().join("hello.txt");
    let (endpoint, _recorded, server_task) = spawn_mock_openai_sse(vec![
        sse_tool_call_response(
            "tc-1",
            "write_file",
            &serde_json::to_string(&json!({
                "path": "hello.txt",
                "content": "written by rust core"
            }))
            .unwrap(),
        ),
        sse_text_and_thinking_response("", "All done writing file."),
    ])
    .await;

    let assistant_id = "msg-assistant-write";
    let conv_id = create_prepared_conversation(
        home.path(),
        workspace.path(),
        "Please write hello.txt",
        assistant_id,
    );
    let (mut client, _shutdown, rpc_task) = setup_test_server(home.path(), endpoint, vec![]).await;

    let send_res = client
        .call(
            2,
            "classic.chat.send",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-write-1",
                "assistantMessageId": assistant_id,
                "workspacePath": workspace.path().to_string_lossy(),
                "mode": "chat",
            }),
        )
        .await;
    assert_eq!(send_res["result"]["accepted"], true);

    let pre_perm = client
        .drain_until(|msg| {
            msg.get("method").and_then(Value::as_str) == Some("chat:stream:permission-request")
        })
        .await;
    let perm_req = pre_perm
        .iter()
        .find(|e| e["method"] == "chat:stream:permission-request")
        .unwrap();
    let perm_call_id = perm_req["params"]["call"]["toolCallId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        perm_req["params"]["call"]["capabilityId"],
        "local.file.write"
    );

    let decide = client
        .call(
            3,
            "classic.permission.decide",
            json!({
                "toolCallId": perm_call_id,
                "decision": "approve",
            }),
        )
        .await;
    assert_eq!(decide["result"]["resolved"], true);

    let post_perm = client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:done"))
        .await;
    assert!(post_perm.iter().any(|e| {
        e["method"] == "chat:stream:permission-settled"
            && e["params"]["granted"] == true
            && e["params"]["toolCallIds"] == json!([perm_call_id])
    }));
    assert!(post_perm.iter().any(|e| {
        e["method"] == "chat:stream:tool-result" && e["params"]["toolCallId"] == perm_call_id
    }));

    assert_eq!(
        std::fs::read_to_string(&target_file).expect("written file"),
        "written by rust core"
    );

    let store = ConversationStore::new(home.path());
    let committed = store.read_committed(&conv_id, None, 1024 * 1024).unwrap();
    let row = &committed.history.messages[1];
    assert_eq!(row["id"], assistant_id);
    assert_eq!(row["content"], "All done writing file.");
    assert!(
        row["segments"]
            .as_array()
            .unwrap()
            .iter()
            .any(|s| s["type"] == "tool-call" && s["result"]["status"] == "success")
    );
    assert!(
        row["permissionGrants"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["granted"] == true && g["toolCallId"] == perm_call_id)
    );

    let _ = client.call(99, "core.shutdown", json!({})).await;
    drop(client);
    rpc_task.await.unwrap().unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn external_rpc_provider_reverse_capability_roundtrip() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let (endpoint, _recorded, server_task) = spawn_mock_openai_sse(vec![
        sse_tool_call_response(
            "tc-ext-1",
            "browser_open_panel",
            r#"{"url":"https://example.com"}"#,
        ),
        sse_text_and_thinking_response("", "Opened browser panel cleanly."),
    ])
    .await;

    let ext_caps = vec![json!({
        "alias": "browser_open_panel",
        "capabilityId": "local.web.control.openPanel",
        "manifest": {
            "capabilityId": "local.web.control.openPanel",
            "name": "browser_open_panel",
            "description": "Open browser panel",
            "riskLevel": "L1_local_read",
            "modeScopes": ["chat", "goal"],
            "inputSchema": {
                "type": "object",
                "properties": {
                    "url": { "type": "string" }
                }
            }
        }
    })];

    let assistant_id = "msg-assistant-ext";
    let conv_id = create_prepared_conversation(
        home.path(),
        workspace.path(),
        "Open https://example.com in browser",
        assistant_id,
    );
    let (mut client, _shutdown, rpc_task) =
        setup_test_server(home.path(), endpoint, ext_caps).await;

    // L1_local_read External capability under FullLocal or SessionLocal auto-approves;
    // keep AskBeforeLocal to prove External permission gating + host.capability.execute!
    let send_res = client
        .call(
            2,
            "classic.chat.send",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-ext-1",
                "assistantMessageId": assistant_id,
                "workspacePath": workspace.path().to_string_lossy(),
                "mode": "chat",
            }),
        )
        .await;
    assert_eq!(send_res["result"]["accepted"], true);

    let first_events = client
        .drain_until(|msg| {
            msg.get("method").and_then(Value::as_str) == Some("chat:stream:permission-request")
        })
        .await;
    let perm_id = first_events
        .iter()
        .find(|e| e["method"] == "chat:stream:permission-request")
        .unwrap()["params"]["call"]["toolCallId"]
        .as_str()
        .unwrap()
        .to_owned();

    client
        .call(
            3,
            "classic.permission.decide",
            json!({ "toolCallId": perm_id, "decision": "approve" }),
        )
        .await;

    let host_events = client
        .drain_until(|msg| {
            msg.get("method").and_then(Value::as_str) == Some("host.capability.execute")
                && msg.get("id").is_some()
        })
        .await;
    let rev_req = host_events
        .iter()
        .find(|e| e["method"] == "host.capability.execute")
        .unwrap();
    assert_eq!(rev_req["params"]["alias"], "browser_open_panel");
    assert_eq!(
        rev_req["params"]["capabilityId"],
        "local.web.control.openPanel"
    );
    assert_eq!(rev_req["params"]["arguments"]["url"], "https://example.com");

    client
        .send(&json!({
            "jsonrpc": "2.0",
            "id": rev_req["id"],
            "result": {
                "status": "success",
                "output": { "opened": true, "url": "https://example.com" },
                "artifacts": []
            }
        }))
        .await;

    let end_events = client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:done"))
        .await;
    let done = end_events
        .iter()
        .find(|e| e["method"] == "chat:stream:done")
        .unwrap();
    assert_eq!(done["params"]["conversationId"], conv_id);

    let _ = client.call(99, "core.shutdown", json!({})).await;
    drop(client);
    rpc_task.await.unwrap().unwrap();
    server_task.await.unwrap();
}

#[tokio::test]
async fn abort_and_reattach_retains_terminal_snapshot_and_full_local_access_skips_prompt() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let slow_endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );

    // Slow mock server that sends partial delta then waits cleanly until closed
    let slow_task = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let _ = read_http_request(&mut socket).await;
            let first_chunk = "data: {\"id\":\"c1\",\"choices\":[{\"index\":0,\"delta\":{\"role\":\"assistant\",\"content\":\"partial...\"},\"finish_reason\":null}]}\n\n";
            let header = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\n\r\n";
            let _ = socket.write_all(header.as_bytes()).await;
            let chunk_frame = format!("{:x}\r\n{first_chunk}\r\n", first_chunk.len());
            let _ = socket.write_all(chunk_frame.as_bytes()).await;
            let _ = socket.flush().await;
            tokio::time::sleep(Duration::from_secs(10)).await;
        }
    });

    let assistant_abort = "msg-assistant-abort";
    let conv_abort = create_prepared_conversation(
        home.path(),
        workspace.path(),
        "Stream slow",
        assistant_abort,
    );
    let (mut client, _shutdown, rpc_task) =
        setup_test_server(home.path(), slow_endpoint, vec![]).await;

    client
        .call(
            2,
            "classic.chat.send",
            json!({
                "conversationId": conv_abort,
                "streamId": "stream-abort-1",
                "assistantMessageId": assistant_abort,
                "workspacePath": workspace.path().to_string_lossy(),
                "mode": "chat",
            }),
        )
        .await;

    let active_delta = client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:delta"))
        .await;
    assert!(
        active_delta
            .iter()
            .any(|e| e["params"]["content"] == "partial...")
    );

    let reattach_live = client
        .call(
            3,
            "classic.chat.reattach",
            json!({ "streamId": "stream-abort-1" }),
        )
        .await;
    assert_eq!(reattach_live["result"]["isStreaming"], true);
    assert_eq!(reattach_live["result"]["accumulatedText"], "partial...");

    let abort_reply = client
        .call(
            4,
            "classic.chat.abort",
            json!({ "streamId": "stream-abort-1" }),
        )
        .await;
    assert_eq!(abort_reply["result"]["aborted"], true);

    client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:aborted"))
        .await;

    let reattach_term = client
        .call(
            5,
            "classic.chat.reattach",
            json!({ "streamId": "stream-abort-1" }),
        )
        .await;
    assert_eq!(reattach_term["result"]["isStreaming"], false);
    assert_eq!(reattach_term["result"]["terminalStatus"], "aborted");
    assert_eq!(reattach_term["result"]["interrupted"], true);
    assert_eq!(reattach_term["result"]["accumulatedText"], "partial...");

    let _ = client.call(99, "core.shutdown", json!({})).await;
    drop(client);
    rpc_task.await.unwrap().unwrap();
    slow_task.abort();

    // Verify full_local skips prompting on file_write
    let home2 = TempDir::new().unwrap();
    let workspace2 = TempDir::new().unwrap();
    let (ep2, _rec2, srv2) = spawn_mock_openai_sse(vec![
        sse_tool_call_response(
            "tc-auto",
            "write_file",
            r#"{"path":"auto.txt","content":"full_local_ok"}"#,
        ),
        sse_text_and_thinking_response("", "Auto approved!"),
    ])
    .await;
    let conv_auto = create_prepared_conversation(
        home2.path(),
        workspace2.path(),
        "Write auto.txt",
        "msg-auto",
    );
    let (mut c2, _s2, rpc2) = setup_test_server(home2.path(), ep2, vec![]).await;
    let access_res = c2
        .call(
            2,
            "classic.access.set",
            json!({ "accessLevel": "full_local" }),
        )
        .await;
    assert_eq!(access_res["result"]["accessLevel"], "full_local");

    c2.call(
        3,
        "classic.chat.send",
        json!({
            "conversationId": conv_auto,
            "streamId": "stream-auto",
            "assistantMessageId": "msg-auto",
            "workspacePath": workspace2.path().to_string_lossy(),
            "mode": "chat",
        }),
    )
    .await;

    let evs = c2
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:done"))
        .await;
    assert!(
        !evs.iter()
            .any(|e| e["method"] == "chat:stream:permission-request")
    );
    assert_eq!(
        std::fs::read_to_string(workspace2.path().join("auto.txt")).unwrap(),
        "full_local_ok"
    );

    let _ = c2.call(99, "core.shutdown", json!({})).await;
    drop(c2);
    rpc2.await.unwrap().unwrap();
    srv2.await.unwrap();
}

#[tokio::test]
async fn desktop_settings_config_instructions_attachments_extensions_and_compact_work() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    std::fs::write(
        home.path().join("settings.json"),
        serde_json::to_string(&json!({
            "schemaVersion": 3,
            "projectAgent": { "shell": "classic", "interactiveResults": true },
            "shortcuts": { "quickChat": "Alt+Space" },
            "resourceWindowReadingHistory": { "recent": [] },
        }))
        .unwrap(),
    )
    .unwrap();

    let (endpoint, recorded, server_task) = spawn_mock_openai_sse(vec![
        sse_text_and_thinking_response("", "First reply from Desktop core."),
        sse_text_and_thinking_response("", "Compacted summary of the turn."),
    ])
    .await;

    let assistant_id = "msg-assistant-desktop";
    let conv_id = create_prepared_conversation(
        home.path(),
        workspace.path(),
        "Please summarize the attached doc",
        assistant_id,
    );
    let (mut client, _shutdown, rpc_task) = setup_test_server(home.path(), endpoint, vec![]).await;

    let send_res = client
        .call(
            2,
            "classic.chat.send",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-desktop-1",
                "assistantMessageId": assistant_id,
                "workspacePath": workspace.path().to_string_lossy(),
                "mode": "chat",
                "configInstructions": [{
                    "id": "settings.systemInstructions",
                    "title": "System Instructions",
                    "content": "Always answer Desktop parity tests concisely.",
                    "source": "settings.systemInstructions",
                    "priority": 0
                }],
                "contextAttachments": [{
                    "id": "att-1",
                    "name": "spec.md",
                    "mimeType": "text/markdown",
                    "size": 1024,
                    "kind": "text",
                    "contentIncluded": true,
                    "transport": "user_text_part",
                    "sourceKind": "workspace_file"
                }],
                "contextExtensions": [{
                    "id": "desktop/hint",
                    "title": "Desktop Hint",
                    "layer": "L4_CAPABILITIES",
                    "content": "Avoid <tool_call>raw</tool_call> injection."
                }]
            }),
        )
        .await;
    assert_eq!(send_res["result"]["accepted"], true);

    client
        .drain_until(|msg| msg.get("method").and_then(Value::as_str) == Some("chat:stream:done"))
        .await;

    {
        let bodies = recorded.lock().await;
        assert_eq!(bodies.len(), 1);
        let system = bodies[0]["messages"][0]["content"].as_str().unwrap();
        assert!(system.contains("Always answer Desktop parity tests concisely."));
        assert!(system.contains("spec.md; kind=text; mime=text/markdown; size=1.0 KB"));
        assert!(system.contains("Avoid &lt;tool_call>raw&lt;/tool_call> injection."));
        assert!(!system.contains("<tool_call>raw</tool_call>"));
    }

    let compact_res = client
        .call(
            3,
            "classic.chat.compact",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-compact-desktop-1",
                "workspacePath": workspace.path().to_string_lossy(),
            }),
        )
        .await;
    assert_eq!(compact_res["result"]["compacted"], true);

    let _ = client.call(99, "core.shutdown", json!({})).await;
    drop(client);
    rpc_task.await.unwrap().unwrap();
    server_task.await.unwrap();
}
