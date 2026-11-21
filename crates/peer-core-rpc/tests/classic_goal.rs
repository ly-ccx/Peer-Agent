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
use std::{
    collections::VecDeque,
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::Duration,
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::TcpListener,
    sync::{Mutex, Notify},
};

struct RpcGoalTestClient {
    reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    buffered_notifications: VecDeque<Value>,
}

impl RpcGoalTestClient {
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

    async fn call_with_host<F>(
        &mut self,
        id: u64,
        method: &str,
        params: Value,
        mut host_handler: F,
    ) -> Value
    where
        F: FnMut(&str, Value) -> Result<Value, (i32, String)>,
    {
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
            if let Some(rev_method) = msg.get("method").and_then(Value::as_str)
                && msg.get("id").is_some()
            {
                let rev_id = msg["id"].clone();
                let rev_params = msg.get("params").cloned().unwrap_or(Value::Null);
                let reply = match host_handler(rev_method, rev_params) {
                    Ok(result) => json!({ "jsonrpc": "2.0", "id": rev_id, "result": result }),
                    Err((code, message)) => {
                        json!({ "jsonrpc": "2.0", "id": rev_id, "error": { "code": code, "message": message } })
                    }
                };
                self.send(&reply).await;
                continue;
            }
            if msg.get("id").and_then(Value::as_u64) == Some(id) && msg.get("method").is_none() {
                return msg;
            }
            self.buffered_notifications.push_back(msg);
        }
    }

    async fn call(&mut self, id: u64, method: &str, params: Value) -> Value {
        self.call_with_host(id, method, params, |m, _| {
            Err((-32601, format!("Method not found: {m}")))
        })
        .await
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

async fn spawn_dynamic_mock_openai_sse<F>(
    handler: F,
) -> (String, Arc<Mutex<Vec<Value>>>, tokio::task::JoinHandle<()>)
where
    F: FnMut(usize, &Value) -> std::pin::Pin<Box<dyn std::future::Future<Output = String> + Send>>
        + Send
        + 'static,
{
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock tcp listener");
    let addr = listener.local_addr().expect("local addr");
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let recorded_bodies = Arc::new(Mutex::new(Vec::new()));
    let recorded_ref = Arc::clone(&recorded_bodies);

    let handle = tokio::spawn(async move {
        let mut handler = handler;
        let mut step = 0usize;
        while let Ok((mut socket, _)) = listener.accept().await {
            let req_text = read_http_request(&mut socket).await;
            let parsed = req_text
                .split_once("\r\n\r\n")
                .and_then(|(_, body)| serde_json::from_str::<Value>(body).ok())
                .unwrap_or(Value::Null);
            recorded_ref.lock().await.push(parsed.clone());
            let sse_body = handler(step, &parsed).await;
            step += 1;
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

fn sse_text_response(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text}}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":20,\"completion_tokens\":8,\"total_tokens\":28}}}}\n\n",
            "data: [DONE]\n\n"
        ),
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

fn extract_last_evidence_ref(req_body: &Value) -> String {
    let messages = req_body["messages"].as_array().expect("messages array");
    for msg in messages.iter().rev() {
        if msg["role"] == "tool"
            && let Some(content) = msg["content"].as_str()
            && let Ok(parsed) = serde_json::from_str::<Value>(content)
        {
            if let Some(arr) = parsed["evidenceRefs"].as_array()
                && let Some(first) = arr.first().and_then(Value::as_str)
            {
                return first.to_owned();
            }
            if let Some(ev) = parsed["evidence"]["evidenceRef"].as_str() {
                return ev.to_owned();
            }
            if let Some(arr) = parsed["evidence"]["artifactRefs"].as_array()
                && let Some(first) = arr.first().and_then(Value::as_str)
            {
                return first.to_owned();
            }
        }
    }
    panic!("no evidenceRef found in tool messages: {req_body}");
}

fn extract_system_and_user_text(req_body: &Value) -> String {
    req_body["messages"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
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

fn spawn_test_server(
    home: &Path,
    endpoint: String,
) -> (
    RpcGoalTestClient,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    let (server_read, server_write) = tokio::io::split(server_stream);
    let (client_read, client_write) = tokio::io::split(client_stream);
    let shutdown = CancellationToken::new();
    let mut config = CoreServerConfig::new("0.1.0-test", home.to_path_buf());
    config.model_loader = Some(make_test_loader(endpoint));
    config.reverse_request_timeout = Duration::from_secs(5);
    let handle = tokio::spawn(serve_io(
        server_read,
        server_write,
        config,
        shutdown.clone(),
    ));
    (
        RpcGoalTestClient {
            reader: BufReader::new(client_read),
            writer: client_write,
            buffered_notifications: VecDeque::new(),
        },
        shutdown,
        handle,
    )
}

async fn init_client(client: &mut RpcGoalTestClient, next_id: &mut u64) {
    *next_id += 1;
    let init = client
        .call(
            *next_id,
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "peer-desktop-test", "version": "1.0.0" },
                "externalCapabilities": [],
            }),
        )
        .await;
    assert_eq!(
        init["result"]["capabilities"]["domains"],
        json!([
            "core",
            "classic.chat",
            "classic.goal",
            "classic.conversations",
            "classic.usage",
            "classic.skills",
            "classic.mcp",
            "classic.llm"
        ])
    );
    *next_id += 1;
    let access = client
        .call(
            *next_id,
            "classic.access.set",
            json!({ "accessLevel": "full_local" }),
        )
        .await;
    assert_eq!(access["result"]["ok"], true);
}

fn create_goal_conversation(
    home: &Path,
    workspace: &Path,
    user_text: Option<&str>,
    assistant_message_id: Option<&str>,
) -> String {
    let store = ConversationStore::new(home);
    let now = peer_runtime::capability::now();
    let created = store
        .create(
            &NewConversation {
                title: "Test Goal",
                workspace_path: Some(workspace.to_str().unwrap()),
                mode: "goal",
                created_at: &now,
            },
            None,
        )
        .expect("create conversation");
    let conv_id = created["id"].as_str().unwrap().to_owned();
    if let Some(text) = user_text {
        store
            .append_message_idempotent(
                &conv_id,
                &json!({
                    "id": "msg-user-1",
                    "role": "user",
                    "content": text,
                    "createdAt": now,
                }),
                &now,
                None,
            )
            .expect("append user msg");
    }
    if let Some(asst_id) = assistant_message_id {
        store
            .append_message_idempotent(
                &conv_id,
                &json!({
                    "id": asst_id,
                    "role": "assistant",
                    "content": "",
                    "segments": [],
                    "createdAt": now,
                }),
                &now,
                None,
            )
            .expect("append assistant placeholder");
    }
    conv_id
}

fn seed_plan(home: &Path, plan: &Value) {
    let dir = home.join("goal-plans");
    std::fs::create_dir_all(&dir).unwrap();
    let plan_id = plan["planId"].as_str().unwrap();
    std::fs::write(
        dir.join(format!("{plan_id}.json")),
        serde_json::to_vec_pretty(plan).unwrap(),
    )
    .unwrap();
    let index_row = json!({
        "planId": plan_id,
        "title": plan["title"],
        "status": plan["status"],
        "workflowKind": plan["workflowKind"],
        "conversationId": plan["conversationId"],
        "originWorkspacePath": plan["originWorkspacePath"],
        "targetWorkspacePath": plan["targetWorkspacePath"],
        "version": plan["version"],
        "createdAt": plan["createdAt"],
        "updatedAt": plan["updatedAt"],
        "percent": 0,
    });
    let index_path = dir.join("index.jsonl");
    let mut existing = std::fs::read_to_string(&index_path).unwrap_or_default();
    existing.push_str(&serde_json::to_string(&index_row).unwrap());
    existing.push('\n');
    std::fs::write(index_path, existing).unwrap();
}

#[tokio::test]
async fn classic_chat_send_goal_mode_promotes_intake_and_emits_plan_changed() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let conv_id = create_goal_conversation(
        home.path(),
        workspace.path(),
        Some("Build release checklist"),
        Some("asst-goal-chat-1"),
    );

    let now = peer_runtime::capability::now();
    let intake_plan = json!({
        "planId": "plan-intake-rpc-1",
        "conversationId": conv_id,
        "originWorkspacePath": workspace.path(),
        "targetWorkspacePath": workspace.path(),
        "title": "",
        "goal": "Build release checklist",
        "tasks": [{ "taskId": "task-draft", "title": "intake", "status": "pending" }],
        "successCriteria": [],
        "status": "executing",
        "workflowKind": "goal_self_driven",
        "activation": { "kind": "intake", "sourceMessageId": "msg-user-1" },
        "version": 1,
        "createdAt": now,
        "updatedAt": now,
        "progress": { "total": 1, "completed": 0, "failed": 0, "blocked": 0, "percent": 0 }
    });
    seed_plan(home.path(), &intake_plan);

    let (endpoint, _bodies, server_task) = spawn_dynamic_mock_openai_sse(|step, _body| {
        Box::pin(async move {
            match step {
                0 => sse_tool_call_response(
                    "call-11111111-1111-4111-8111-111111111111",
                    "goal_create_plan",
                    &json!({
                        "title": "Release Checklist Goal",
                        "goal": "Create checklist artifact",
                        "tasks": [{ "taskId": "t1", "title": "Write checklist.md" }]
                    })
                    .to_string(),
                ),
                _ => sse_text_response("Goal plan promoted and ready."),
            }
        })
    })
    .await;

    let (mut client, shutdown, core_task) = spawn_test_server(home.path(), endpoint);
    let mut id = 0;
    init_client(&mut client, &mut id).await;

    id += 1;
    let send_reply = client
        .call(
            id,
            "classic.chat.send",
            json!({
                "conversationId": conv_id,
                "streamId": "stream-goal-intake-1",
                "assistantMessageId": "asst-goal-chat-1",
                "workspacePath": workspace.path(),
                "mode": "goal",
            }),
        )
        .await;
    assert_eq!(send_reply["result"]["accepted"], true);

    let events = client
        .drain_until(|ev| ev["method"] == "chat:stream:done")
        .await;

    let plan_changed = events
        .iter()
        .find(|ev| {
            ev["method"] == "goalPlans:changed"
                && ev["params"]["changeKind"] == "goal-accepted"
                && ev["params"]["planId"] == "plan-intake-rpc-1"
        })
        .expect("goalPlans:changed goal-accepted notification");
    assert_eq!(plan_changed["params"]["conversationId"], conv_id);

    let saved: Value = serde_json::from_slice(
        &std::fs::read(home.path().join("goal-plans/plan-intake-rpc-1.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["status"], "accepted");
    assert_eq!(saved["activation"]["kind"], "accepted_goal");
    assert_eq!(saved["title"], "Release Checklist Goal");

    id += 1;
    let _ = client.call(id, "core.shutdown", json!({})).await;
    shutdown.cancel();
    server_task.abort();
    core_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn classic_goal_start_worktree_handoff_verifier_and_visual_repair_loop() {
    let home = TempDir::new().unwrap();
    let origin = TempDir::new().unwrap();
    let worktree = TempDir::new().unwrap();
    let conv_id =
        create_goal_conversation(home.path(), origin.path(), Some("Implement feature"), None);

    let now = peer_runtime::capability::now();
    let plan_id = "plan-worktree-visual-1";
    let plan = json!({
        "planId": plan_id,
        "conversationId": conv_id,
        "originWorkspacePath": origin.path(),
        "targetWorkspacePath": origin.path(),
        "title": "Worktree Visual Feature",
        "goal": "Create output.txt in worktree and pass visual review",
        "tasks": [{
            "taskId": "task-1",
            "title": "Write output.txt",
            "status": "pending",
            "involvedFiles": ["output.txt"],
        }],
        "successCriteria": [{
            "id": "c-review",
            "kind": "model_review",
            "description": "output.txt exists and meets requirements",
        }],
        "status": "accepted",
        "workflowKind": "goal_self_driven",
        "activation": { "kind": "accepted_goal", "acceptedAt": now, "acceptedBy": "user" },
        "version": 1,
        "createdAt": now,
        "updatedAt": now,
        "progress": { "total": 1, "completed": 0, "failed": 0, "blocked": 0, "percent": 0 },
    });
    seed_plan(home.path(), &plan);

    let repair_saw_visual_defect = Arc::new(AtomicUsize::new(0));
    let defect_seen_flag = Arc::clone(&repair_saw_visual_defect);
    let plan_id_owned = plan_id.to_owned();

    let (endpoint, _bodies, server_task) = spawn_dynamic_mock_openai_sse(move |step, body| {
        let body = body.clone();
        let pid = plan_id_owned.clone();
        let defect_flag = Arc::clone(&defect_seen_flag);
        Box::pin(async move {
            match step {
                // Tick 1 (Orient): write v1 in worktree
                0 => sse_tool_call_response(
                    "call-tick1-write",
                    "write_file",
                    &json!({ "path": "output.txt", "content": "v1 draft\n" }).to_string(),
                ),
                // Tick 1: mark task completed with real write evidence
                1 => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_tool_call_response(
                        "call-tick1-update",
                        "goal_update_task",
                        &json!({
                            "planId": pid,
                            "taskId": "task-1",
                            "status": "completed",
                            "evidenceRefs": [ev_ref],
                            "result": "Wrote output.txt v1",
                        })
                        .to_string(),
                    )
                }
                // Tick 1: text reply
                2 => sse_text_response("Completed v1 deliverable."),
                // Text Verifier 1: read_file to acquire scoped verifier evidence
                3 => sse_tool_call_response(
                    "call-ver1-read",
                    "read_file",
                    &json!({ "path": "output.txt" }).to_string(),
                ),
                // Text Verifier 1: pass
                4 => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_text_response(
                        &json!({
                            "passed": true,
                            "failedCriteria": [],
                            "missingEvidence": [],
                            "risks": [],
                            "evidenceRefs": [ev_ref],
                            "summary": "Text verifier 1 passed.",
                            "recommendedNextAction": "complete",
                        })
                        .to_string(),
                    )
                }
                // After Text Verifier 1 passes, host visual review fails -> Tick 2 (Repair)!
                5 => {
                    let full_prompt = extract_system_and_user_text(&body);
                    if full_prompt.contains("Header overlaps navbar")
                        || full_prompt.contains("Visual verification failed")
                    {
                        defect_flag.fetch_add(1, Ordering::SeqCst);
                    }
                    sse_tool_call_response(
                        "call-tick2-read",
                        "read_file",
                        &json!({ "path": "output.txt" }).to_string(),
                    )
                }
                // Tick 2: overwrite existing output.txt now that snapshot is read
                6 => sse_tool_call_response(
                    "call-tick2-write",
                    "write_file",
                    &json!({ "path": "output.txt", "content": "v2 fixed\n", "allow_overwrite": true })
                        .to_string(),
                ),
                // Tick 2: update task evidence with new write evidence
                7 => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_tool_call_response(
                        "call-tick2-update",
                        "goal_update_task",
                        &json!({
                            "planId": pid,
                            "taskId": "task-1",
                            "status": "completed",
                            "evidenceRefs": [ev_ref],
                            "result": "Fixed layout and updated output.txt v2",
                        })
                        .to_string(),
                    )
                }
                // Tick 2: text reply
                8 => sse_text_response("Fixed visual defect in v2."),
                // Text Verifier 2: read_file to inspect fixed output.txt
                9 => sse_tool_call_response(
                    "call-ver2-read",
                    "read_file",
                    &json!({ "path": "output.txt" }).to_string(),
                ),
                // Text Verifier 2: pass
                _ => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_text_response(
                        &json!({
                            "passed": true,
                            "failedCriteria": [],
                            "missingEvidence": [],
                            "risks": [],
                            "evidenceRefs": [ev_ref],
                            "summary": "Text verifier 2 passed.",
                            "recommendedNextAction": "complete",
                        })
                        .to_string(),
                    )
                }
            }
        })
    })
    .await;

    let (mut client, shutdown, core_task) = spawn_test_server(home.path(), endpoint);
    let mut id = 0;
    init_client(&mut client, &mut id).await;

    let mut prep_calls = 0usize;
    let mut visual_calls = 0usize;
    let plan_file = home.path().join(format!("goal-plans/{plan_id}.json"));
    let wt_str = worktree.path().to_str().unwrap().to_owned();
    let origin_str = origin.path().to_str().unwrap().to_owned();

    id += 1;
    let start_reply = client
        .call_with_host(
            id,
            "classic.goal.start",
            json!({
                "planId": plan_id,
                "options": { "awaitIdle": true },
            }),
            |method, params| match method {
                "host.goal.prepareWorkspace" => {
                    prep_calls += 1;
                    assert_eq!(params["planId"], plan_id);
                    let mut p: Value =
                        serde_json::from_slice(&std::fs::read(&plan_file).unwrap()).unwrap();
                    p["deliveryBinding"] = json!({
                        "executionIsolation": "worktree",
                        "worktreePath": wt_str,
                        "targetWorkspacePath": origin_str,
                    });
                    std::fs::write(&plan_file, serde_json::to_vec_pretty(&p).unwrap()).unwrap();
                    Ok(json!({ "workspacePath": wt_str }))
                }
                "host.goal.runVisualVerification" => {
                    visual_calls += 1;
                    let canonical_wt = std::fs::canonicalize(&wt_str).unwrap();
                    assert_eq!(
                        std::fs::canonicalize(params["workspacePath"].as_str().unwrap()).unwrap(),
                        canonical_wt
                    );
                    if visual_calls == 1 {
                        Ok(json!({
                            "required": true,
                            "passed": false,
                            "report": {
                                "passed": false,
                                "summary": "Visual check detected overlap",
                                "findings": [{ "summary": "Header overlaps navbar" }],
                                "evidenceRefs": ["desktop-preview://shot-1"],
                            }
                        }))
                    } else {
                        Ok(json!({
                            "required": true,
                            "passed": true,
                            "report": {
                                "passed": true,
                                "summary": "Visual verification passed",
                                "evidenceRefs": ["desktop-preview://shot-2"],
                            }
                        }))
                    }
                }
                other => Err((-32601, format!("Unexpected host method: {other}"))),
            },
        )
        .await;

    assert_eq!(prep_calls, 1);
    assert_eq!(visual_calls, 2);
    assert_eq!(repair_saw_visual_defect.load(Ordering::SeqCst), 1);

    let res = &start_reply["result"];
    assert_eq!(res["planStatus"], "completed");
    assert_eq!(res["runner"]["status"], "completed");
    assert_eq!(res["runner"]["visualVerification"]["passed"], true);
    assert_eq!(
        std::fs::read_to_string(worktree.path().join("output.txt")).unwrap(),
        "v2 fixed\n"
    );
    assert!(!origin.path().join("output.txt").exists());

    let mut events = Vec::new();
    while let Some(ev) = client.buffered_notifications.pop_front() {
        events.push(ev);
    }
    assert!(events.iter().any(|ev| {
        ev["method"] == "goalRunner:changed" && ev["params"]["type"] == "goalRunner:started"
    }));
    assert!(events.iter().any(|ev| {
        ev["method"] == "goalRunner:changed"
            && ev["params"]["type"] == "goalRunner:streamStarted"
            && ev["params"]["streamId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
            && ev["params"]["assistantMessageId"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
    }));
    assert!(events.iter().any(|ev| {
        ev["method"] == "goalRunner:changed"
            && ev["params"]["type"] == "goalRunner:visualRepairStarted"
    }));
    assert!(events.iter().any(|ev| {
        ev["method"] == "goalRunner:changed" && ev["params"]["type"] == "goalRunner:completed"
    }));
    assert!(events.iter().any(|ev| ev["method"] == "chat:stream:delta"));
    assert!(events.iter().any(|ev| ev["method"] == "chat:stream:done"));

    id += 1;
    let state_reply = client
        .call(id, "classic.goal.getState", json!({ "planId": plan_id }))
        .await;
    assert_eq!(state_reply["result"]["planStatus"], "completed");
    assert_eq!(state_reply["result"]["runner"]["status"], "completed");

    id += 1;
    let _ = client.call(id, "core.shutdown", json!({})).await;
    shutdown.cancel();
    server_task.abort();
    core_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn classic_goal_pause_resume_and_clear_lifecycle() {
    let home = TempDir::new().unwrap();
    let workspace = TempDir::new().unwrap();
    let conv_id = create_goal_conversation(home.path(), workspace.path(), Some("Run task"), None);

    let now = peer_runtime::capability::now();
    let plan_id = "plan-pause-resume-1";
    let plan = json!({
        "planId": plan_id,
        "conversationId": conv_id,
        "originWorkspacePath": workspace.path(),
        "targetWorkspacePath": workspace.path(),
        "title": "Pause Resume Goal",
        "goal": "Create file after resume",
        "tasks": [{
            "taskId": "t1",
            "title": "Write result.txt",
            "status": "pending",
            "involvedFiles": ["result.txt"],
        }],
        "successCriteria": [{ "id": "c1", "kind": "model_review", "description": "Exists" }],
        "status": "accepted",
        "workflowKind": "goal_self_driven",
        "activation": { "kind": "accepted_goal", "acceptedAt": now, "acceptedBy": "user" },
        "version": 1,
        "createdAt": now,
        "updatedAt": now,
        "progress": { "total": 1, "completed": 0, "failed": 0, "blocked": 0, "percent": 0 },
    });
    seed_plan(home.path(), &plan);

    let pause_gate = Arc::new(Notify::new());
    let first_tick_entered = Arc::new(Notify::new());
    let gate_clone = Arc::clone(&pause_gate);
    let entered_clone = Arc::clone(&first_tick_entered);
    let pid_owned = plan_id.to_owned();

    let (endpoint, _bodies, server_task) = spawn_dynamic_mock_openai_sse(move |step, body| {
        let body = body.clone();
        let gate = Arc::clone(&gate_clone);
        let entered = Arc::clone(&entered_clone);
        let pid = pid_owned.clone();
        Box::pin(async move {
            match step {
                0 => {
                    entered.notify_waiters();
                    gate.notified().await;
                    sse_text_response("Interrupted")
                }
                1 => sse_tool_call_response(
                    "call-res-w1",
                    "write_file",
                    &json!({ "path": "result.txt", "content": "resumed ok\n" }).to_string(),
                ),
                2 => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_tool_call_response(
                        "call-res-u1",
                        "goal_update_task",
                        &json!({
                            "planId": pid,
                            "taskId": "t1",
                            "status": "completed",
                            "evidenceRefs": [ev_ref],
                            "result": "Done",
                        })
                        .to_string(),
                    )
                }
                3 => sse_text_response("Finished after resume."),
                4 => sse_tool_call_response(
                    "call-res-vr1",
                    "read_file",
                    &json!({ "path": "result.txt" }).to_string(),
                ),
                _ => {
                    let ev_ref = extract_last_evidence_ref(&body);
                    sse_text_response(
                        &json!({
                            "passed": true,
                            "failedCriteria": [],
                            "missingEvidence": [],
                            "risks": [],
                            "evidenceRefs": [ev_ref],
                            "summary": "Verified after resume.",
                            "recommendedNextAction": "complete",
                        })
                        .to_string(),
                    )
                }
            }
        })
    })
    .await;

    let (mut client, shutdown, core_task) = spawn_test_server(home.path(), endpoint);
    let mut id = 0;
    init_client(&mut client, &mut id).await;

    id += 1;
    let start_reply = client
        .call(id, "classic.goal.start", json!({ "planId": plan_id }))
        .await;
    assert_eq!(start_reply["result"]["runner"]["status"], "running");

    first_tick_entered.notified().await;

    id += 1;
    let pause_reply = client
        .call(
            id,
            "classic.goal.pause",
            json!({ "planId": plan_id, "reason": "paused" }),
        )
        .await;
    assert_eq!(pause_reply["result"]["planStatus"], "paused");
    assert_eq!(pause_reply["result"]["runner"]["status"], "paused");
    pause_gate.notify_waiters();

    id += 1;
    let resume_reply = client
        .call(
            id,
            "classic.goal.resume",
            json!({
                "planId": plan_id,
                "options": { "awaitIdle": true },
            }),
        )
        .await;
    assert_eq!(resume_reply["result"]["planStatus"], "completed");
    assert_eq!(resume_reply["result"]["runner"]["status"], "completed");
    assert_eq!(
        std::fs::read_to_string(workspace.path().join("result.txt")).unwrap(),
        "resumed ok\n"
    );

    id += 1;
    let clear_reply = client
        .call(
            id,
            "classic.goal.clear",
            json!({ "planId": plan_id, "reason": "cleared" }),
        )
        .await;
    assert_eq!(clear_reply["result"]["planStatus"], "cancelled");
    assert_eq!(clear_reply["result"]["runner"]["status"], "idle");
    assert_eq!(clear_reply["result"]["runner"]["blockedReason"], "cleared");

    id += 1;
    let _ = client.call(id, "core.shutdown", json!({})).await;
    shutdown.cancel();
    server_task.abort();
    core_task.await.unwrap().unwrap();
}
