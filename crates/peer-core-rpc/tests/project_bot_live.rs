use peer_core_rpc::{CoreServerConfig, ModelLoader, PROTOCOL_VERSION, ResolvedTurnModel, serve_io};
use peer_project_agent::{
    BotProfileStore, NativeProjectHost, SpawnCriterion, SpawnSessionRequest, build_session_report,
    host_resource_plan_from_plan, input_message_id, project_completion_review_for_plan,
    reconcile_unknown_outcome, sha256_hex,
};
use peer_protocol::{
    HostSurface, LocalAccessLevel, javascript_json_digest, javascript_json_string,
};
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{ChatDialect, GenerationOptions, Wire},
    },
};
use peer_store::{
    AcquireLease, ApprovalStore, DirectoryLock, ExecutionResourceStore, HostIdentity,
    HostLeaseStore, PolicyStore, ResourceReservation,
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::{TcpListener, TcpStream},
    sync::{Mutex, Notify},
};

struct LiveTestClient {
    reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    next_id: u64,
    notifications: VecDeque<Value>,
}

impl LiveTestClient {
    async fn send(&mut self, value: &Value) {
        let mut line = serde_json::to_vec(value).expect("serialize request");
        line.push(b'\n');
        self.writer.write_all(&line).await.expect("write line");
        self.writer.flush().await.expect("flush line");
    }

    async fn read_frame(&mut self) -> Value {
        let mut raw = String::new();
        let n = self.reader.read_line(&mut raw).await.expect("read line");
        assert!(n > 0, "unexpected EOF waiting for RPC frame");
        serde_json::from_str(&raw).expect("parse rpc frame")
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        self.send(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .await;

        loop {
            let msg = self.read_frame().await;
            if msg.get("method").is_some() && msg.get("id").is_none() {
                self.notifications.push_back(msg);
                continue;
            }
            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                assert!(
                    msg["error"].is_null(),
                    "{method} returned JSON-RPC error: {msg}"
                );
                return msg["result"].clone();
            }
        }
    }

    fn take_matching_notification<F>(&mut self, predicate: F) -> Option<Value>
    where
        F: FnMut(&Value) -> bool,
    {
        if let Some(pos) = self.notifications.iter().position(predicate) {
            self.notifications.remove(pos)
        } else {
            None
        }
    }

    async fn wait_for_notification<F>(
        &mut self,
        timeout_dur: Duration,
        description: &str,
        mut predicate: F,
    ) -> Value
    where
        F: FnMut(&Value) -> bool,
    {
        if let Some(found) = self.take_matching_notification(&mut predicate) {
            return found;
        }
        let deadline = tokio::time::Instant::now() + timeout_dur;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            assert!(
                !remaining.is_zero(),
                "timed out waiting for notification ({description}); buffered={:?}",
                self.notifications
            );
            let frame = tokio::time::timeout(remaining, self.read_frame())
                .await
                .unwrap_or_else(|_| {
                    panic!(
                        "timed out reading notification ({description}); buffered={:?}",
                        self.notifications
                    )
                });
            if frame.get("method").is_some() && frame.get("id").is_none() {
                if predicate(&frame) {
                    return frame;
                }
                self.notifications.push_back(frame);
            }
        }
    }

    async fn shutdown(mut self, handle: tokio::task::JoinHandle<std::io::Result<()>>) {
        let res = self.call("core.shutdown", json!({})).await;
        assert_eq!(res["ok"], true, "shutdown failed: {res}");
        drop(self);
        tokio::time::timeout(Duration::from_secs(5), handle)
            .await
            .expect("server join timeout")
            .expect("server task panic")
            .expect("server io error");
    }
}

async fn read_http_request(socket: &mut TcpStream) -> String {
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

fn sse_text_response(text: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"content\":{text}}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-1\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"stop\"}}],\"usage\":{{\"prompt_tokens\":16,\"completion_tokens\":8,\"total_tokens\":24}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        text = json!(text),
    )
}

fn sse_tool_call_response(call_id: &str, name: &str, arguments_json: &str) -> String {
    format!(
        concat!(
            "data: {{\"id\":\"chatcmpl-tool\",\"choices\":[{{\"index\":0,\"delta\":{{\"role\":\"assistant\",\"tool_calls\":[{{\"index\":0,\"id\":{call_id},\"type\":\"function\",\"function\":{{\"name\":{name},\"arguments\":{args}}}}}]}},\"finish_reason\":null}}]}}\n\n",
            "data: {{\"id\":\"chatcmpl-tool\",\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}],\"usage\":{{\"prompt_tokens\":20,\"completion_tokens\":10,\"total_tokens\":30}}}}\n\n",
            "data: [DONE]\n\n"
        ),
        call_id = json!(call_id),
        name = json!(name),
        args = json!(arguments_json),
    )
}

async fn write_sse_reply(socket: &mut TcpStream, sse_body: &str) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nConnection: close\r\nContent-Length: {}\r\n\r\n",
        sse_body.len()
    );
    let _ = socket.write_all(header.as_bytes()).await;
    let _ = socket.write_all(sse_body.as_bytes()).await;
    let _ = socket.shutdown().await;
}

async fn spawn_mock_sse_queue(
    responses: Vec<String>,
    fallback_text: &str,
) -> (String, Arc<Mutex<Vec<Value>>>, CancellationToken) {
    let listener = TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind mock tcp listener");
    let addr = listener.local_addr().expect("local addr");
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let queue = Arc::new(Mutex::new(VecDeque::from(responses)));
    let recorded = Arc::new(Mutex::new(Vec::new()));
    let stop = CancellationToken::new();
    let fallback = sse_text_response(fallback_text);

    let stop_srv = stop.clone();
    let recorded_srv = Arc::clone(&recorded);
    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = stop_srv.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break; };
                    let q = Arc::clone(&queue);
                    let rec = Arc::clone(&recorded_srv);
                    let fb = fallback.clone();
                    tokio::spawn(async move {
                        let req_text = read_http_request(&mut socket).await;
                        if let Some((_, body_str)) = req_text.split_once("\r\n\r\n")
                            && let Ok(parsed) = serde_json::from_str::<Value>(body_str)
                        {
                            rec.lock().await.push(parsed);
                        }
                        let body = q.lock().await.pop_front().unwrap_or(fb);
                        write_sse_reply(&mut socket, &body).await;
                    });
                }
            }
        }
    });

    (endpoint, recorded, stop)
}

fn make_test_loader(endpoint: String) -> ModelLoader {
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

async fn spawn_live_server(
    data_home: &Path,
    model_loader: Option<ModelLoader>,
) -> (LiveTestClient, tokio::task::JoinHandle<std::io::Result<()>>) {
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    let (server_read, server_write) = tokio::io::split(server_stream);
    let (client_read, client_write) = tokio::io::split(client_stream);
    let shutdown = CancellationToken::new();
    let mut config = CoreServerConfig::new("0.1.0-test", data_home.to_path_buf());
    config.reverse_request_timeout = Duration::from_secs(5);
    config.model_loader = model_loader;
    let handle = tokio::spawn(serve_io(server_read, server_write, config, shutdown));
    let mut client = LiveTestClient {
        reader: BufReader::new(client_read),
        writer: client_write,
        next_id: 1,
        notifications: VecDeque::new(),
    };
    let init = client
        .call(
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "project-bot-live-test", "version": "0.1.0" },
            }),
        )
        .await;
    assert_eq!(init["protocolVersion"], PROTOCOL_VERSION);
    (client, handle)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .expect("unix epoch")
        .as_millis() as i64
}

fn lease_path(data_home: &Path, workspace_id: &str) -> PathBuf {
    data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("host.lease")
}

fn yield_path(data_home: &Path, workspace_id: &str) -> PathBuf {
    data_home
        .join("project-runtime")
        .join(workspace_id)
        .join("host.yield")
}

#[cfg(unix)]
fn stat_token(meta: &fs::Metadata) -> String {
    use std::os::unix::fs::MetadataExt;
    let mtime_ns = i128::from(meta.mtime()) * 1_000_000_000 + i128::from(meta.mtime_nsec());
    let ctime_ns = i128::from(meta.ctime()) * 1_000_000_000 + i128::from(meta.ctime_nsec());
    format!(
        "{}:{}:{}:{}:{}",
        meta.dev(),
        meta.ino(),
        meta.len(),
        mtime_ns,
        ctime_ns
    )
}

#[tokio::test]
async fn host_configure_dormant_enable_status_and_graceful_shutdown() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-dormant");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    let (mut client, handle) = spawn_live_server(&home, None).await;

    let status0 = client.call("project.bot.hostStatus", json!({})).await;
    assert_eq!(status0["ok"], true);
    assert_eq!(status0["enabled"], false);
    assert_eq!(status0["surface"], "desktop");
    assert_eq!(status0["ownedWorkspaces"], json!([]));

    let created = client
        .call(
            "project.bot.create",
            json!({
                "path": ws_dir,
                "name": "Dormant Bot",
                "startFamiliarize": false,
            }),
        )
        .await;
    assert_eq!(created["ok"], true);
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(!lease_path(&home, &ws_id).exists());

    // Mutations must never acquire host.lease while host is dormant
    let offline_cancel = client
        .call(
            "project.bot.cancelSession",
            json!({
                "workspaceId": ws_id,
                "sessionId": "missing-session",
            }),
        )
        .await;
    assert_eq!(offline_cancel["ok"], false);
    assert_eq!(offline_cancel["code"], "HOST_OFFLINE");
    assert!(!lease_path(&home, &ws_id).exists());

    let configured = client
        .call(
            "project.bot.hostConfigure",
            json!({
                "enabled": true,
                "heartbeatIntervalMs": 60,
                "proactivity": "standard",
                "learnPreferences": true,
            }),
        )
        .await;
    assert_eq!(configured["ok"], true);
    assert_eq!(configured["enabled"], true);
    let owned = configured["ownedWorkspaces"].as_array().unwrap();
    assert!(owned.iter().any(|v| v.as_str() == Some(&ws_id)));

    let lease_file = lease_path(&home, &ws_id);
    assert!(lease_file.exists(), "host.lease should exist on enable");
    let lease_json: Value =
        serde_json::from_str(&fs::read_to_string(&lease_file).unwrap()).unwrap();
    assert_eq!(lease_json["surface"], "desktop");

    let status1 = client
        .call("project.bot.hostStatus", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(status1["enabled"], true);
    assert_eq!(status1["recoveryStatus"][&ws_id]["status"], "ready");

    client.shutdown(handle).await;
    assert!(
        !lease_file.exists(),
        "graceful shutdown must release host.lease"
    );
}

#[tokio::test]
async fn create_familiarize_accept_readme_and_two_phase_delete() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let blank_dir = temp.path().join("blank-ws");
    let managed_dir = temp.path().join("managed-ws");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&blank_dir).unwrap();
    fs::create_dir_all(&managed_dir).unwrap();
    fs::write(managed_dir.join("README.md"), "# Existing repo\n").unwrap();

    let (endpoint, _rec, sse_stop) =
        spawn_mock_sse_queue(vec![sse_text_response("Familiarize complete")], "ok").await;
    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;

    let cfg = client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;
    assert_eq!(cfg["enabled"], true);

    let blank_created = client
        .call(
            "project.bot.create",
            json!({
                "path": blank_dir,
                "name": "Blank Bot",
                "startFamiliarize": true,
            }),
        )
        .await;
    assert_eq!(blank_created["ok"], true);
    assert_eq!(blank_created["familiarize"]["kind"], "blank");

    let managed_created = client
        .call(
            "project.bot.create",
            json!({
                "path": managed_dir,
                "name": "Managed Bot",
                "managed": true,
                "startFamiliarize": false,
            }),
        )
        .await;
    assert_eq!(managed_created["ok"], true);
    assert_eq!(managed_created["profile"]["managed"], true);
    assert!(managed_created["familiarize"].is_null());
    let ws_id = managed_created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    // acceptReadme fails before offer
    let no_offer = client
        .call("project.bot.acceptReadme", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(no_offer["ok"], false);
    assert_eq!(no_offer["code"], "OFFER_MISSING");

    // Set offer then acceptReadme twice (second is idempotent reused=true)
    let profile_store = BotProfileStore::new(&home);
    let mut prof = profile_store.read(&ws_id).unwrap();
    prof.readme_offer = Some(json!({ "offered": true }));
    profile_store.save(prof).unwrap();

    let accepted = client
        .call("project.bot.acceptReadme", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(accepted["ok"], true);
    let reused = client
        .call("project.bot.acceptReadme", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(reused["ok"], true);
    assert_eq!(reused["reused"], true);

    // startFamiliarize on non-empty workspace spawns research session
    let fam = client
        .call(
            "project.bot.startFamiliarize",
            json!({ "workspaceId": ws_id }),
        )
        .await;
    assert_eq!(fam["ok"], true);
    assert_eq!(fam["kind"], "research");
    assert!(fam["sessionId"].as_str().is_some_and(|s| !s.is_empty()));

    // 2-phase delete on managed bot
    let need_confirm = client
        .call(
            "project.bot.delete",
            json!({
                "workspaceId": ws_id,
                "phase": "prepare",
                "confirmManaged": false,
            }),
        )
        .await;
    assert_eq!(need_confirm["ok"], false);
    assert_eq!(need_confirm["code"], "CONFIRM_REQUIRED");

    let prepared = client
        .call(
            "project.bot.delete",
            json!({
                "workspaceId": ws_id,
                "phase": "prepare",
                "confirmManaged": true,
            }),
        )
        .await;
    assert_eq!(prepared["ok"], true);
    assert_eq!(prepared["archived"], true);
    assert!(!lease_path(&home, &ws_id).exists());

    let finalized = client
        .call(
            "project.bot.delete",
            json!({
                "workspaceId": ws_id,
                "phase": "finalize",
                "folderRemoved": true,
            }),
        )
        .await;
    assert_eq!(finalized["ok"], true);
    assert!(
        profile_store
            .read(&ws_id)
            .unwrap()
            .deletion_cleanup
            .is_none()
    );

    let changed = client
        .wait_for_notification(Duration::from_secs(3), "project.bot.changed", |n| {
            n["method"] == "project.bot.changed"
                && n["params"]["workspaceIds"]
                    .as_array()
                    .is_some_and(|arr| arr.iter().any(|w| w.as_str() == Some(&ws_id)))
        })
        .await;
    assert_eq!(changed["method"], "project.bot.changed");

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn live_submit_input_emits_push_events_and_commits_agent_reply() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-live");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    let (endpoint, _rec, sse_stop) = spawn_mock_sse_queue(
        vec![sse_text_response("Mock bot reply: hello user!")],
        "fallback",
    )
    .await;
    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;

    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({
                "path": ws_dir,
                "name": "Reply Bot",
                "startFamiliarize": false,
            }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    let sub = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "inp-live-1",
                "text": "Hello Bot",
                "surface": "desktop",
            }),
        )
        .await;
    assert_eq!(sub["ok"], true);
    assert_eq!(sub["delivery"], "queued");

    client
        .wait_for_notification(Duration::from_secs(5), "project.bot.activity", |n| {
            n["method"] == "project.bot.activity" && n["params"]["workspaceId"] == ws_id
        })
        .await;
    client
        .wait_for_notification(
            Duration::from_secs(5),
            "project.bot.conversationChanged",
            |n| {
                n["method"] == "project.bot.conversationChanged"
                    && n["params"]["workspaceId"] == ws_id
            },
        )
        .await;
    client
        .wait_for_notification(Duration::from_secs(5), "project.bot.changed", |n| {
            n["method"] == "project.bot.changed"
                && n["params"]["workspaceIds"]
                    .as_array()
                    .is_some_and(|arr| arr.iter().any(|w| w.as_str() == Some(&ws_id)))
        })
        .await;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let res = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = res["messages"].as_array().cloned().unwrap_or_default();
        let has_user = msgs
            .iter()
            .any(|m| m["role"] == "user" && m["content"] == "Hello Bot");
        let has_reply = msgs.iter().any(|m| {
            m["role"] == "assistant"
                && m["kind"] == "agent_reply"
                && m["replyTo"] == json!(["input-inp-live-1"])
                && m["fallback"] == false
                && m["content"]
                    .as_str()
                    .is_some_and(|c| c.contains("Mock bot reply: hello user!"))
        });
        if has_user && has_reply {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for assistant reply in conversation: {res}"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn yielded_response_resumes_automatically_and_original_turn_id_stops_it() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let (resumed_tx, resumed_rx) = tokio::sync::oneshot::channel();
    let (disconnected_tx, disconnected_rx) = tokio::sync::oneshot::channel();
    let req_count = Arc::new(AtomicUsize::new(0));
    let count = Arc::clone(&req_count);
    let mock = tokio::spawn(async move {
        let mut resumed = Some((resumed_tx, disconnected_tx));
        loop {
            let (mut socket, _) = listener.accept().await.unwrap();
            let raw = read_http_request(&mut socket).await;
            let request: Value =
                serde_json::from_str(raw.split_once("\r\n\r\n").unwrap().1).unwrap();
            let idx = count.fetch_add(1, Ordering::SeqCst);
            if idx < 14 {
                write_sse_reply(
                    &mut socket,
                    &sse_tool_call_response(
                        &format!("rpc-yield-{idx}"),
                        "list_files",
                        r#"{"path":"."}"#,
                    ),
                )
                .await;
            } else if let Some((resumed, disconnected)) = resumed.take() {
                resumed.send(request).unwrap();
                // Do not send a result: stopResponse must abort the live request,
                // not wait for the model to finish before settling the activity.
                let _ = socket.read(&mut [0_u8; 1]).await;
                disconnected.send(()).unwrap();
            } else {
                write_sse_reply(&mut socket, &sse_text_response("Unexpected extra reply")).await;
            }
        }
    });

    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-yield");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();
    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({"enabled": true, "heartbeatIntervalMs": 60}),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({
                "path": ws_dir, "name": "Yield Bot", "startFamiliarize": false,
            }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"].as_str().unwrap();
    let submitted = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id, "inputId": "rpc-yield", "text": "Inspect this project",
            }),
        )
        .await;
    assert_eq!(submitted["ok"], true);
    let first = client
        .wait_for_notification(Duration::from_secs(5), "first slice activity", |n| {
            n["method"] == "project.bot.activity"
                && n["params"]["workspaceId"] == ws_id
                && n["params"]["activity"]["turnId"].is_string()
        })
        .await;
    let first_id = first["params"]["activity"]["turnId"].as_str().unwrap();
    // The first slice performs fourteen actual tool round trips before yielding.
    let request = tokio::time::timeout(Duration::from_secs(20), resumed_rx)
        .await
        .unwrap_or_else(|_| {
            panic!(
                "next slice must send a request without a second client action; observed {} requests",
                req_count.load(Ordering::SeqCst)
            )
        })
        .unwrap();
    assert!(
        request["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| { m["role"] == "tool" && m["tool_call_id"] == "rpc-yield-13" })
    );
    let resumed = client
        .call("project.bot.hostStatus", json!({"workspaceId": ws_id}))
        .await;
    let activity = &resumed["activities"][ws_id];
    let resumed_id = activity["turnId"].as_str().unwrap();
    assert_ne!(resumed_id, first_id);
    assert!(activity["finishedAt"].is_null());
    let stop = client
        .call(
            "project.bot.stopResponse",
            json!({
                "workspaceId": ws_id, "turnId": first_id,
            }),
        )
        .await;
    assert_eq!(stop["ok"], true, "{stop}");
    tokio::time::timeout(Duration::from_secs(5), disconnected_rx)
        .await
        .expect("stop must disconnect the outstanding model request")
        .unwrap();
    client
        .wait_for_notification(Duration::from_secs(5), "resumed slice stops", |n| {
            n["method"] == "project.bot.activity"
                && n["params"]["workspaceId"] == ws_id
                && n["params"]["activity"]["turnId"] == resumed_id
                && n["params"]["activity"]["phase"] == "stopped"
                && n["params"]["activity"]["finishedAt"].is_string()
        })
        .await;
    let conv = client
        .call(
            "project.bot.readConversation",
            json!({"workspaceId": ws_id}),
        )
        .await;
    assert!(
        !conv["messages"]
            .as_array()
            .unwrap()
            .iter()
            .any(|m| m["kind"] == "agent_reply")
    );
    client.shutdown(handle).await;
    assert_eq!(req_count.load(Ordering::SeqCst), 15);
    mock.abort();
}

#[tokio::test]
async fn stop_response_aborts_slow_turn_and_retry_completes() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let req_count = Arc::new(AtomicUsize::new(0));
    let first_seen = Arc::new(Notify::new());
    let sse_stop = CancellationToken::new();

    {
        let req_count_srv = Arc::clone(&req_count);
        let first_seen_srv = Arc::clone(&first_seen);
        let stop_srv = sse_stop.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stop_srv.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        let n = req_count_srv.fetch_add(1, Ordering::SeqCst);
                        let notify = Arc::clone(&first_seen_srv);
                        let stop_conn = stop_srv.clone();
                        tokio::spawn(async move {
                            let _ = read_http_request(&mut socket).await;
                            if n == 0 {
                                notify.notify_one();
                                // Hold connection open until cancelled/shutdown
                                tokio::select! {
                                    _ = stop_conn.cancelled() => {}
                                    _ = tokio::time::sleep(Duration::from_secs(10)) => {}
                                }
                            } else {
                                write_sse_reply(
                                    &mut socket,
                                    &sse_text_response("Recovered reply after retry"),
                                )
                                .await;
                            }
                        });
                    }
                }
            }
        });
    }

    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-stop-retry");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({ "path": ws_dir, "name": "Stop Bot", "startFamiliarize": false }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "inp-stop-1",
                "text": "Run slow turn",
            }),
        )
        .await;

    let act = client
        .wait_for_notification(Duration::from_secs(5), "thinking activity", |n| {
            n["method"] == "project.bot.activity"
                && n["params"]["workspaceId"] == ws_id
                && n["params"]["activity"]["turnId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty())
        })
        .await;
    let turn_id = act["params"]["activity"]["turnId"]
        .as_str()
        .unwrap()
        .to_owned();
    tokio::time::timeout(Duration::from_secs(5), first_seen.notified())
        .await
        .expect("first SSE request should arrive");

    let stop_res = client
        .call(
            "project.bot.stopResponse",
            json!({ "workspaceId": ws_id, "turnId": turn_id }),
        )
        .await;
    assert_eq!(stop_res["ok"], true, "stopResponse failed: {stop_res}");
    assert_eq!(stop_res["stopping"], true);

    // Wait until turn finishes (activity becomes idle / finishedAt set)
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let st = client
            .call("project.bot.hostStatus", json!({ "workspaceId": ws_id }))
            .await;
        if st["agentStatuses"][&ws_id].as_str() == Some("idle")
            || st["activities"][&ws_id]["finishedAt"].is_string()
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for stopped turn to settle: {st}"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    let ret = client
        .call(
            "project.bot.retry",
            json!({ "workspaceId": ws_id, "turnId": turn_id }),
        )
        .await;
    assert_eq!(ret["ok"], true, "retry failed: {ret}");
    assert_eq!(
        ret["requeued"], 1,
        "retry did not requeue stopped input: {ret}"
    );

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let conv = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = conv["messages"].as_array().cloned().unwrap_or_default();
        if msgs.iter().any(|m| {
            m["role"] == "assistant"
                && m["content"]
                    .as_str()
                    .is_some_and(|c| c.contains("Recovered reply after retry"))
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for retried assistant reply: {conv}"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn cancel_resume_confirm_result_and_handoff_answer() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-sessions");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();
    let git_init = Command::new("git")
        .args(["init"])
        .current_dir(&ws_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(git_init.status.success());

    // Seed workspace, question, sessions & review token before enabling host
    let seed_host =
        NativeProjectHost::new_for_surface(&home, HostSurface::Desktop, "0.1.0-test", None)
            .unwrap();
    let (entry, mut profile) = seed_host
        .bind_workspace(&ws_dir, Some("SessionBot"))
        .unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.take().unwrap();
    profile.agent_conversation_id = Some(conv_id.clone());
    profile.acceptance_policy = Some("confirm".to_owned());
    BotProfileStore::new(&home).save(profile).unwrap();

    let policy_store = PolicyStore::new(&home);
    let ts = peer_project_agent::now_iso();
    policy_store
        .initialize(LocalAccessLevel::FullLocal, &ts, None)
        .unwrap();
    let pol = policy_store.read_or_register(&ws_id, &ts).unwrap();
    policy_store
        .update_existing(
            &ws_id,
            pol.revision,
            LocalAccessLevel::FullLocal,
            &peer_project_agent::now_iso(),
        )
        .unwrap();

    // Consume an anchor input for spawning test sessions
    seed_host
        .submit_user_input(&ws_id, "seed-inp-1", "Run tasks", None)
        .unwrap();
    seed_host
        .inputs()
        .consume(&ws_id, &conv_id, seed_host.conversations(), true)
        .unwrap();

    // Append question card message q-1 for handoff / question closure verification
    seed_host
        .conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "q-1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Pick an option?",
                "question": { "prompt": "Pick an option?", "options": ["A", "B"] },
                "createdAt": "2026-11-22T01:00:00.000Z",
            }),
            "2026-11-22T01:00:00.000Z",
            None,
        )
        .unwrap();

    seed_host.ensure_lease(&ws_id).unwrap();
    // Session 1: manual completion review -> confirm -> worker finishes -> result acceptance
    let s1 = seed_host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws_dir.clone(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("seed-inp-1").unwrap()],
                input_id: "seed-inp-1".into(),
                surface: "desktop".into(),
                title: "Manual Review Session".into(),
                brief: "Finish manual task".into(),
                kind: "implement".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("m1".into()),
                    kind: "manual".into(),
                    description: "Manual review".into(),
                    command: None,
                    path: None,
                    expect: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();
    seed_host
        .conversations()
        .append_message_idempotent(
            &s1.session_id,
            &json!({
                "id": "rep-s1",
                "role": "assistant",
                "content": "Manual task draft complete",
                "createdAt": "2026-11-22T01:02:00.000Z",
            }),
            "2026-11-22T01:02:00.000Z",
            None,
        )
        .unwrap();
    let mut plan1 = seed_host.supervisor().read_plan(&s1.plan_id).unwrap();
    plan1["delegationOrigin"]["phase"] = json!("running");
    plan1["runner"] = json!({
        "enabled": true,
        "status": "blocked",
        "blockedReason": "manual_dod_confirmation_required",
    });
    seed_host.supervisor().save_plan_json(&plan1).unwrap();
    let child_msgs = seed_host
        .conversations()
        .read_committed(&s1.conversation_id, None, 4 * 1024 * 1024)
        .map(|s| s.history.messages)
        .unwrap_or_default();
    let report = build_session_report(&plan1, &s1.session_id, "executing", &child_msgs);
    let review = project_completion_review_for_plan(&plan1, &report).unwrap();
    let review_token = review["reviewToken"].as_str().unwrap().to_owned();

    // Session 2: paused session for cancelSession & resumeSession
    let s2 = seed_host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws_dir.clone(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("seed-inp-1").unwrap()],
                input_id: "seed-inp-1".into(),
                surface: "desktop".into(),
                title: "Cancel Resume Session".into(),
                brief: "Paused then resumed".into(),
                kind: "implement".into(),
                read_only: false,
                required_capabilities: vec![],
                success_criteria: vec![SpawnCriterion {
                    id: Some("m2".into()),
                    kind: "manual".into(),
                    description: "Manual criterion".into(),
                    command: None,
                    path: None,
                    expect: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();
    seed_host
        .supervisor()
        .control_session(&ws_id, &s2.session_id, "pause", "user_pause", true)
        .unwrap();
    seed_host.release_all_leases();
    drop(seed_host);

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let sse_stop = CancellationToken::new();
    {
        let stop_srv = sse_stop.clone();
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stop_srv.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        tokio::spawn(async move {
                            let req_text = read_http_request(&mut socket).await;
                            let body_str = req_text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
                            let has_tool_result = body_str.contains(r#""role":"tool""#)
                                || body_str.contains(r#""role": "tool""#);
                            let sse = if !has_tool_result
                                && body_str.contains("Delegated Task: Manual Review Session")
                            {
                                sse_tool_call_response(
                                    "tc-s1-write",
                                    "write_file",
                                    r#"{"path":"manual_work.txt","content":"manual work done\n"}"#,
                                )
                            } else {
                                sse_text_response("Worker s1 completed after confirmation")
                            };
                            write_sse_reply(&mut socket, &sse).await;
                        });
                    }
                }
            }
        });
    }
    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;

    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    // 1. Question answer guard over submitInput while q-1 is still active
    let ans_ok = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "ans-q1-1",
                "text": "A",
                "answerTo": "card:question:reply:q-1",
            }),
        )
        .await;
    assert_eq!(ans_ok["ok"], true, "ans_ok failed: {ans_ok}");
    let ans_closed = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "ans-q1-2",
                "text": "B",
                "answerTo": "card:question:reply:q-1",
            }),
        )
        .await;
    assert_eq!(ans_closed["ok"], false);
    assert_eq!(ans_closed["code"], "QUESTION_CLOSED");

    // 2. resumeSession with requestId idempotency (from paused -> queued), then cancelSession
    let res1 = client
        .call(
            "project.bot.resumeSession",
            json!({
                "workspaceId": ws_id,
                "sessionId": s2.session_id,
                "requestId": "req-idem-1",
            }),
        )
        .await;
    assert_eq!(res1["ok"], true, "resumeSession failed: {res1}");
    let res_idem = client
        .call(
            "project.bot.resumeSession",
            json!({
                "workspaceId": ws_id,
                "sessionId": s2.session_id,
                "requestId": "req-idem-1",
            }),
        )
        .await;
    assert_eq!(res_idem["ok"], true);
    assert_eq!(res_idem["session"]["sessionId"], s2.session_id);

    let cancelled = client
        .call(
            "project.bot.cancelSession",
            json!({
                "workspaceId": ws_id,
                "sessionId": s2.session_id,
                "reason": "test_cancel",
            }),
        )
        .await;
    assert_eq!(cancelled["ok"], true, "cancelSession failed: {cancelled}");
    assert_eq!(cancelled["session"]["status"], "cancelled");

    // 2. confirmResult manual_completion wrong token -> fail; valid reviewToken -> ok
    let bad_confirm = client
        .call(
            "project.bot.confirmResult",
            json!({
                "workspaceId": ws_id,
                "sessionId": s1.session_id,
                "stage": "manual_completion",
                "reviewToken": "wrong-token",
            }),
        )
        .await;
    assert_eq!(bad_confirm["ok"], false);

    let manual_ok = client
        .call(
            "project.bot.confirmResult",
            json!({
                "workspaceId": ws_id,
                "sessionId": s1.session_id,
                "stage": "manual_completion",
                "reviewToken": review_token,
            }),
        )
        .await;
    assert_eq!(manual_ok["ok"], true, "manual confirm failed: {manual_ok}");

    // Wait for worker s1 to finish so result_acceptance can run
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let sess = client
            .call(
                "project.bot.getSession",
                json!({ "workspaceId": ws_id, "sessionId": s1.session_id }),
            )
            .await;
        if matches!(
            sess["session"]["status"].as_str(),
            Some("completed" | "result_ready")
        ) && sess["session"]["origin"]["phase"].as_str() == Some("completed")
        {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for s1 to complete: {sess}"
        );
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    let accepted = client
        .call(
            "project.bot.confirmResult",
            json!({
                "workspaceId": ws_id,
                "sessionId": s1.session_id,
                "stage": "result_acceptance",
            }),
        )
        .await;
    assert_eq!(accepted["ok"], true, "result_acceptance failed: {accepted}");
    assert!(accepted["decision"]["acceptedBy"].is_string());

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn decide_approval_stale_image_scope_and_replay() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-image-approvals");
    fs::create_dir_all(&ws_dir).unwrap();
    let host = NativeProjectHost::new_for_surface(&home, HostSurface::Desktop, "0.1.0-test", None)
        .unwrap();
    let (entry, profile) = host.bind_workspace(&ws_dir, Some("Image Bot")).unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.unwrap();
    let at = peer_project_agent::now_iso();
    let policies = PolicyStore::new(&home);
    policies
        .initialize(LocalAccessLevel::AskBeforeLocal, &at, None)
        .unwrap();
    let policy = policies.read_or_register(&ws_id, &at).unwrap();
    let stamp = format!("bot:{ws_id}:{conv_id}:{}", policy.revision);
    let image = ws_dir.join("shot.png");
    let scope = json!({"capabilityId": "local.image.read", "action": "read_image_for_model",
        "path": image, "workspacePath": ws_dir, "fileIdentity": {"dev": 1, "ino": 2,
        "size": 123, "mtimeMs": 4.125, "ctimeMs": 5.125}});
    let row = |id, capability, state| {
        json!({"approvalId": id, "workspaceId": ws_id,
        "conversationId": conv_id, "capabilityId": capability, "state": state,
        "summary": "permission fixture", "policyRevision": stamp, "createdAt": at,
        "argsDigest": javascript_json_digest(&json!({"path": image, "fileIdentity": scope["fileIdentity"]})).unwrap()})
    };
    let other = row("other", "local.file.write", "open");
    let mut rows = vec![other.clone(), row("ordinary", "local.file.write", "stale")];
    for (id, state) in [
        ("task", "stale"),
        ("once", "stale"),
        ("missing", "stale"),
        ("invalid", "stale"),
        ("reject", "stale"),
        ("cancel", "stale"),
        ("expired", "stale"),
        ("drifted", "stale"),
        ("open-task", "open"),
        ("open-reject", "open"),
    ] {
        let mut image_row = row(id, "local.image.read", state);
        if id != "missing" {
            image_row["imageReadScope"] = scope.clone();
        }
        if id == "invalid" {
            image_row["imageReadScope"]["fileIdentity"]["ctimeMs"] = Value::Null;
        }
        if id == "expired" {
            image_row["deadlineAt"] = json!("2020-01-01T00:00:00.000Z");
        }
        if id == "drifted" {
            image_row["policyRevision"] = json!(format!("bot:{ws_id}:{conv_id}:0"));
        }
        rows.push(image_row);
    }
    let dir = home.join("project-runtime").join(&ws_id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(
        dir.join("approvals.jsonl"),
        rows.iter()
            .map(|row| format!("{row}\n"))
            .collect::<String>(),
    )
    .unwrap();

    let (mut client, handle) = spawn_live_server(&home, None).await;
    let params = |id, decision, duration| {
        json!({"workspaceId": ws_id, "approvalId": id,
        "decision": decision, "duration": duration})
    };
    let method = "project.bot.decideApproval";
    let mut request = params("task", "approve", "task");
    // Neither capability nor scope from IPC may substitute the durable request.
    request["capabilityId"] = json!("local.file.write");
    request["imageReadScope"] = json!({"path": "/spoofed.png"});
    let before = now_ms();
    let approved = client.call(method, request.clone()).await;
    assert_eq!(approved["ok"], true, "{approved}");
    assert_eq!(approved["approval"]["state"], "approved");
    assert_eq!(client.call(method, request).await, approved);
    for (id, code) in [
        ("ordinary", "NOT_FOUND"),
        ("missing", "IMAGE_AUTHORIZATION_UNAVAILABLE"),
        ("invalid", "IMAGE_AUTHORIZATION_UNAVAILABLE"),
    ] {
        assert_eq!(
            client.call(method, params(id, "approve", "task")).await,
            json!({"ok": false, "code": code}),
            "{id}"
        );
    }
    for (id, decision, duration, state, reason) in [
        ("once", "approve", "once", "approved", Value::Null),
        (
            "reject",
            "reject",
            "denied",
            "denied",
            json!("local_user_denied"),
        ),
        (
            "cancel",
            "cancel",
            "denied",
            "cancelled",
            json!("permission_cancelled"),
        ),
        (
            "expired",
            "approve",
            "task",
            "expired",
            json!("permission_timeout"),
        ),
        (
            "drifted",
            "approve",
            "task",
            "expired",
            json!("permission_policy_changed"),
        ),
        // A persisted open row cannot stand in for a live waiter.
        (
            "open-task",
            "approve",
            "task",
            "expired",
            json!("permission_unavailable"),
        ),
        (
            "open-reject",
            "reject",
            "denied",
            "expired",
            json!("permission_unavailable"),
        ),
    ] {
        let response = client.call(method, params(id, decision, duration)).await;
        assert_eq!(response["ok"], true, "{id}: {response}");
        assert_eq!(response["approval"]["state"], state, "{id}");
        assert_eq!(response["approval"]["decisionReason"], reason, "{id}");
    }
    let stored = ApprovalStore::new(&home).list(Some(&ws_id), None).unwrap();
    assert!(stored.contains(&other));
    for id in ["ordinary", "missing", "invalid"] {
        assert_eq!(
            stored.iter().find(|r| r["approvalId"] == id).unwrap()["state"],
            "stale"
        );
    }
    let grants: Vec<_> = stored
        .iter()
        .filter(|r| r.get("imageReadGrant").is_some())
        .collect();
    let [grant] = grants.as_slice() else {
        panic!("expected one grant, got {grants:?}")
    };
    assert_eq!(grant["kind"], "image_read_grant");
    assert_eq!(grant["state"], "approved");
    assert_eq!(grant["decidedBy"], "local_ui");
    let expires = grant["imageReadGrant"]["expiresAt"].as_i64().unwrap();
    let issued = peer_project_agent::parse_iso_ms(grant["decidedAt"].as_str().unwrap()).unwrap();
    assert!((before..=now_ms()).contains(&issued));
    assert_eq!(expires - issued, 1_800_000);
    assert_eq!(
        grant["imageReadGrant"],
        json!({"schemaVersion": 1, "grantId": grant["approvalId"],
        "workspaceId": ws_id, "conversationId": conv_id, "policyRevision": stamp, "expiresAt": expires,
        "scope": scope})
    );
    client.shutdown(handle).await;
}

#[tokio::test]
async fn decide_approval_plan_live_worker_and_policy_drift() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-approvals");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    // Seed workspace and update access policy to AskBeforeLocal before starting server
    let seed_host =
        NativeProjectHost::new_for_surface(&home, HostSurface::Desktop, "0.1.0-test", None)
            .unwrap();
    let (entry, prof) = seed_host
        .bind_workspace(&ws_dir, Some("Approval Bot"))
        .unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = prof.agent_conversation_id.unwrap();

    let policy_store = PolicyStore::new(&home);
    let ts = peer_project_agent::now_iso();
    policy_store
        .initialize(LocalAccessLevel::AskBeforeLocal, &ts, None)
        .unwrap();
    let pol = policy_store.read_or_register(&ws_id, &ts).unwrap();
    policy_store
        .update_existing(
            &ws_id,
            pol.revision,
            LocalAccessLevel::AskBeforeLocal,
            &peer_project_agent::now_iso(),
        )
        .unwrap();

    // Seed a plan approval awaiting_approval
    seed_host.ensure_lease(&ws_id).unwrap();
    seed_host
        .submit_user_input(&ws_id, "ap-inp-1", "Run write task", None)
        .unwrap();
    seed_host
        .inputs()
        .consume(&ws_id, &conv_id, seed_host.conversations(), true)
        .unwrap();

    let s_plan = seed_host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws_dir.clone(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("ap-inp-1").unwrap()],
                input_id: "ap-inp-1".into(),
                surface: "desktop".into(),
                title: "Plan Gate Worker".into(),
                brief: "Write hello.txt".into(),
                kind: "implement".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("f1".into()),
                    kind: "file-exists".into(),
                    description: "hello.txt created".into(),
                    command: None,
                    path: Some("hello.txt".into()),
                    expect: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();
    seed_host.release_all_leases();
    let mut plan = seed_host.supervisor().read_plan(&s_plan.plan_id).unwrap();
    plan["delegationOrigin"]["phase"] = json!("awaiting_approval");
    seed_host.supervisor().save_plan_json(&plan).unwrap();

    let plan_digest = sha256_hex(b"plan-1");
    let approval_store = ApprovalStore::new(&home);
    drop(seed_host);

    // Request-content-aware SSE mock so verifier / bot turns never consume worker tool calls
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let sse_stop = CancellationToken::new();
    {
        let stop_srv = sse_stop.clone();
        let index = home.join("conversations/index.jsonl");
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    biased;
                    _ = stop_srv.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        let index = index.clone();
                        tokio::spawn(async move {
                            let req_text = read_http_request(&mut socket).await;
                            let body_str = req_text.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
                            let has_tool_result = body_str.contains(r#""role":"tool""#)
                                || body_str.contains(r#""role": "tool""#);
                            let plan_worker_call = !has_tool_result
                                && body_str.contains("Delegated Task: Plan Gate Worker");
                            let index_lock = if plan_worker_call {
                                // A writer in another runtime owns the shared index while the
                                // approved worker receives the write tool call.
                                Some(tokio::task::spawn_blocking(move || {
                                    DirectoryLock::acquire(&index, Duration::from_secs(2), None).unwrap()
                                }).await.unwrap())
                            } else {
                                None
                            };
                            let sse = if plan_worker_call {
                                sse_tool_call_response(
                                    "tc-write-1",
                                    "write_file",
                                    r#"{"path":"hello.txt","content":"approved-content\n"}"#,
                                )
                            } else if !has_tool_result
                                && body_str.contains("Delegated Task: Drift Worker")
                            {
                                sse_tool_call_response(
                                    "tc-write-2",
                                    "write_file",
                                    r#"{"path":"drift.txt","content":"must-not-write"}"#,
                                )
                            } else {
                                sse_text_response("Completed cleanly.")
                            };
                            write_sse_reply(&mut socket, &sse).await;
                            if let Some(lock) = index_lock {
                                // Hold past the former 100 ms Rust-only index budget.
                                tokio::time::sleep(Duration::from_millis(450)).await;
                                lock.release().unwrap();
                            }
                        });
                    }
                }
            }
        });
    }

    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    // Open the live plan approval after hostConfigure so startup recovery does not stale it
    approval_store
        .open(
            &peer_store::HostApproval {
                approval_id: "plan:ap-1",
                workspace_id: Some(&ws_id),
                conversation_id: &conv_id,
                stream_id: "plan-stream",
                plan_id: Some(&s_plan.plan_id),
                session_id: Some(&s_plan.session_id),
                capability_id: "goal.plan",
                args_digest: &plan_digest,
                policy_revision: "legacy",
                created_at: &peer_project_agent::now_iso(),
                deadline_at: None,
            },
            None,
        )
        .unwrap();

    // 1. Decide plan approval -> promotes and starts worker session s_plan
    let plan_dec = client
        .call(
            "project.bot.decideApproval",
            json!({
                "workspaceId": ws_id,
                "approvalId": "plan:ap-1",
                "decision": "approve",
            }),
        )
        .await;
    assert_eq!(
        plan_dec["ok"], true,
        "plan decideApproval failed: {plan_dec}"
    );
    assert_eq!(plan_dec["approval"]["state"], "approved");

    // 2. Wait for live worker tool approval (`local.file.write`) in listApprovals
    let open_ap_id = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        loop {
            let list = client
                .call("project.bot.listApprovals", json!({ "workspaceId": ws_id }))
                .await;
            let items = list["approvals"].as_array().cloned().unwrap_or_default();
            if let Some(found) = items
                .iter()
                .find(|r| r["state"] == "open" && r["approvalId"].as_str() != Some("plan:ap-1"))
            {
                break found["approvalId"].as_str().unwrap().to_owned();
            }
            if tokio::time::Instant::now() >= deadline {
                let session = client
                    .call(
                        "project.bot.getSession",
                        json!({ "workspaceId": ws_id, "sessionId": s_plan.session_id, "detail": "report" }),
                    )
                    .await;
                panic!(
                    "timed out waiting for live worker open approval: approvals={list}; session={session}"
                );
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    };

    let live_dec = client
        .call(
            "project.bot.decideApproval",
            json!({
                "workspaceId": ws_id,
                "approvalId": open_ap_id,
                "decision": "approve",
                "duration": "once",
            }),
        )
        .await;
    assert_eq!(live_dec["ok"], true, "live approve failed: {live_dec}");
    assert_eq!(live_dec["approval"]["state"], "approved");

    // The file can become visible before the worker has finished writing it.
    let output_path = ws_dir.join("hello.txt");
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        match fs::read_to_string(&output_path) {
            Ok(content) if content == "approved-content\n" => break,
            observed => assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for approved contents in hello.txt: {observed:?}"
            ),
        }
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // 3. Policy drift on a second live worker open approval
    // Wait for first session to become completed first so slot is free
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let sess = client
            .call(
                "project.bot.getSession",
                json!({ "workspaceId": ws_id, "sessionId": s_plan.session_id }),
            )
            .await;
        if matches!(
            sess["session"]["status"].as_str(),
            Some("completed" | "result_ready")
        ) && sess["session"]["origin"]["phase"].as_str() == Some("completed")
        {
            break;
        }
        assert!(tokio::time::Instant::now() < deadline);
        tokio::time::sleep(Duration::from_millis(30)).await;
    }

    // Spawn second worker while host is active & promote via resumeSession
    let host_ref =
        NativeProjectHost::new_for_surface(&home, HostSurface::Tui, "0.1.0-test", None).unwrap();
    let s2 = host_ref
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws_dir.clone(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("ap-inp-1").unwrap()],
                input_id: "ap-inp-1".into(),
                surface: "desktop".into(),
                title: "Drift Worker".into(),
                brief: "Attempt write drift.txt".into(),
                kind: "implement".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("m-drift".into()),
                    kind: "manual".into(),
                    description: "Drift check".into(),
                    command: None,
                    path: None,
                    expect: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();
    host_ref
        .supervisor()
        .control_session(&ws_id, &s2.session_id, "pause", "prep_drift", true)
        .unwrap();
    drop(host_ref);

    client
        .call(
            "project.bot.resumeSession",
            json!({ "workspaceId": ws_id, "sessionId": s2.session_id, "requestId": "req-drift" }),
        )
        .await;

    let drift_ap_id = {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(6);
        loop {
            let list = client
                .call("project.bot.listApprovals", json!({ "workspaceId": ws_id }))
                .await;
            let items = list["approvals"].as_array().cloned().unwrap_or_default();
            if let Some(found) = items.iter().find(|r| {
                r["state"] == "open" && r["approvalId"].as_str() != Some(open_ap_id.as_str())
            }) {
                break found["approvalId"].as_str().unwrap().to_owned();
            }
            if tokio::time::Instant::now() >= deadline {
                let session = client
                    .call(
                        "project.bot.getSession",
                        json!({ "workspaceId": ws_id, "sessionId": s2.session_id, "detail": "report" }),
                    )
                    .await;
                panic!(
                    "timed out waiting for second live approval: approvals={list}; session={session}"
                );
            }
            tokio::time::sleep(Duration::from_millis(30)).await;
        }
    };

    // Bump policy revision so stored policyRevision no longer matches!
    let cur_pol = policy_store.read_existing(&ws_id).unwrap();
    policy_store
        .update_existing(
            &ws_id,
            cur_pol.revision,
            LocalAccessLevel::RestrictedLocal,
            &peer_project_agent::now_iso(),
        )
        .unwrap();

    let drifted = client
        .call(
            "project.bot.decideApproval",
            json!({
                "workspaceId": ws_id,
                "approvalId": drift_ap_id,
                "decision": "approve",
            }),
        )
        .await;
    assert_eq!(
        drifted["ok"], true,
        "drifted decideApproval failed: {drifted}"
    );
    assert_eq!(drifted["approval"]["state"], "expired");
    assert_eq!(
        drifted["approval"]["decisionReason"],
        "permission_policy_changed"
    );
    assert!(!ws_dir.join("drift.txt").exists());

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn request_claim_closure_and_decide_obligation_emit_grants() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-obligation");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();
    let git_init = Command::new("git")
        .args(["init"])
        .current_dir(&ws_dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(git_init.status.success());

    let host = NativeProjectHost::new_for_surface(&home, HostSurface::Desktop, "0.1.0-test", None)
        .unwrap();
    let (entry, prof) = host.bind_workspace(&ws_dir, Some("Obl Bot")).unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = prof.agent_conversation_id.unwrap();
    host.ensure_lease(&ws_id).unwrap();
    host.submit_user_input(&ws_id, "in-o1", "Run write task", None)
        .unwrap();
    host.inputs()
        .consume(&ws_id, &conv_id, host.conversations(), true)
        .unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws_dir.clone(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("in-o1").unwrap()],
                input_id: "in-o1".into(),
                surface: "desktop".into(),
                title: "Obligation Test".into(),
                brief: "Check close claim".into(),
                kind: "code".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c1".into()),
                    kind: "file-exists".into(),
                    description: "ok".into(),
                    command: None,
                    path: Some("Cargo.toml".into()),
                    expect: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();

    host.supervisor()
        .control_session(&ws_id, &spawned.session_id, "cancel", "stop", true)
        .unwrap();
    let plan = host
        .supervisor()
        .find_plan_by_session(&ws_id, &spawned.session_id)
        .unwrap();
    let host_plan = host_resource_plan_from_plan(&plan).unwrap();
    let mut rstore = ExecutionResourceStore::initialize(&home, None).unwrap();
    rstore
        .reserve(
            &host_plan,
            ResourceReservation {
                host_epoch: "epoch-1",
                scopes: &[],
                record_conflict: false,
            },
            "2026-11-20T10:00:00.000Z",
        )
        .unwrap();
    rstore
        .activate(&host_plan, "epoch-1", "2026-11-20T10:00:01.000Z")
        .unwrap();
    rstore
        .protect(
            &host_plan,
            Some("epoch-1"),
            Some("op-1"),
            "draining",
            &[String::from("call-u1")],
            "2026-11-20T10:00:02.000Z",
        )
        .unwrap();
    let claim = rstore.claims_for(&host_plan).unwrap().pop().unwrap();
    let claim_id = claim["claimId"].as_str().unwrap().to_owned();
    let work = json!({
        "budget": {
            "uncertainDispatches": [{
                "toolCallId": "call-u1",
                "capabilityId": "local.file.write"
            }]
        }
    });
    let recon = reconcile_unknown_outcome(&home, &plan, &claim_id, Some(&work))
        .await
        .unwrap();
    assert_eq!(recon["ok"], true);
    host.release_all_leases();
    drop(host);

    let (mut client, handle) = spawn_live_server(&home, None).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    // 1. Request closure -> revoke
    let req1 = client
        .call(
            "project.bot.requestClaimClosure",
            json!({
                "workspaceId": ws_id,
                "sessionId": spawned.session_id,
            }),
        )
        .await;
    assert_eq!(req1["ok"], true, "requestClaimClosure failed: {req1}");
    let grant1 = req1["grantId"].as_str().unwrap().to_owned();
    client
        .wait_for_notification(Duration::from_secs(3), "obligationGrants req1", |n| {
            n["method"] == "project.bot.obligationGrants" && n["params"]["grantId"] == grant1
        })
        .await;

    let rev = client
        .call(
            "project.bot.decideObligation",
            json!({
                "workspaceId": ws_id,
                "grantId": grant1,
                "decision": "revoke",
            }),
        )
        .await;
    assert_eq!(rev["ok"], true, "decideObligation revoke failed: {rev}");
    client
        .wait_for_notification(Duration::from_secs(3), "obligationGrants revoke", |n| {
            n["method"] == "project.bot.obligationGrants"
                && n["params"]["grantId"] == grant1
                && n["params"]["decision"] == "revoke"
        })
        .await;

    // 2. Re-request closure -> confirm
    let req2 = client
        .call(
            "project.bot.requestClaimClosure",
            json!({
                "workspaceId": ws_id,
                "sessionId": spawned.session_id,
            }),
        )
        .await;
    assert_eq!(
        req2["ok"], true,
        "second requestClaimClosure failed: {req2}"
    );
    let grant2 = req2["grantId"].as_str().unwrap().to_owned();

    let conf = client
        .call(
            "project.bot.decideObligation",
            json!({
                "workspaceId": ws_id,
                "grantId": grant2,
                "decision": "confirm",
            }),
        )
        .await;
    assert_eq!(conf["ok"], true, "decideObligation confirm failed: {conf}");
    client
        .wait_for_notification(Duration::from_secs(3), "obligationGrants confirm", |n| {
            n["method"] == "project.bot.obligationGrants"
                && n["params"]["grantId"] == grant2
                && n["params"]["decision"] == "confirm"
        })
        .await;

    client.shutdown(handle).await;
}

#[tokio::test]
async fn takeover_host_and_external_yield_handoff() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-takeover");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    let (mut client, handle) = spawn_live_server(&home, None).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    let created = client
        .call(
            "project.bot.create",
            json!({ "path": ws_dir, "name": "Takeover Bot", "startFamiliarize": false }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();
    assert!(lease_path(&home, &ws_id).exists());

    // 1. Self already host
    let already = client
        .call("project.bot.takeoverHost", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(already["ok"], true);
    assert_eq!(already["requested"], false);
    assert_eq!(already["alreadyHost"], true);

    // 2. External requester asks for yield -> heartbeat detects & releases lease
    let lease_store = HostLeaseStore::new(&home);
    let foreign = HostIdentity::new("tui-peer-1", HostSurface::Tui, 99991, "0.1.0").unwrap();
    let req_takeover = lease_store
        .request_takeover(&ws_id, &foreign, now_ms())
        .unwrap();
    assert!(req_takeover);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(3);
    loop {
        if !lease_path(&home, &ws_id).exists() {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for heartbeat to release lease after host.yield"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // 3. Foreign host acquires lease -> calling takeoverHost from Desktop writes host.yield
    match lease_store.acquire(&ws_id, &foreign, now_ms()).unwrap() {
        AcquireLease::Acquired { token, .. } => {
            drop(token);
        }
        AcquireLease::Held(rec) => panic!("unexpected lease held by {}", rec.host_id),
    }

    let ask_takeover = client
        .call("project.bot.takeoverHost", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(
        ask_takeover["ok"], true,
        "takeoverHost failed: {ask_takeover}"
    );
    assert_eq!(ask_takeover["requested"], true);
    assert!(yield_path(&home, &ws_id).exists());

    client.shutdown(handle).await;
}

#[tokio::test]
async fn recovery_inspect_restore_and_retain_all_over_rpc() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-fork");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    // Seed a forked coordination directory matching coordination_recovery::tests::seed_forked_workspace
    let seed_host =
        NativeProjectHost::new_for_surface(&home, HostSurface::Desktop, "0.1.0-test", None)
            .unwrap();
    let (entry, _) = seed_host.bind_workspace(&ws_dir, Some("Fork RPC")).unwrap();
    let ws_id = entry.workspace_id;
    let ws_runtime_dir = home.join("project-runtime").join(&ws_id);
    let cp_dir = ws_runtime_dir.join("checkpoints");
    fs::create_dir_all(&cp_dir).unwrap();

    let make_cp = |owner: &str, payload: Value| -> String {
        let bytes = serde_json::to_vec(&payload).unwrap();
        let mut buf = Vec::new();
        buf.extend_from_slice(owner.as_bytes());
        buf.push(b'\n');
        buf.extend_from_slice(&bytes);
        let name = format!("{}.json", sha256_hex(&buf));
        fs::write(cp_dir.join(&name), bytes).unwrap();
        name
    };
    let make_work = |wid: &str, note: Option<&str>, anchors: Value| -> Value {
        let native_ref = make_cp(
            &format!("{wid}:attempt"),
            json!({ "provider": "test", "messages": [] }),
        );
        let job_ref = make_cp(
            wid,
            json!({
                "job": { "workId": wid, "kind": "user", "userInputs": [{ "inputId": wid, "text": "task" }] },
                "outcome": { "yielded": true, "rounds": [{ "toolCalls": [{ "toolCallId": "tc-1", "result": { "ok": true } }] }] }
            }),
        );
        let mut w = json!({
            "workId": wid,
            "workspaceId": ws_id,
            "parentConversationId": "parent",
            "state": "runnable",
            "anchorInputIds": anchors,
            "sessionIds": [],
            "checkpointRef": job_ref,
            "nativeCheckpointRef": native_ref,
            "budget": {
                "tokens": 7,
                "toolCalls": 1,
                "attempts": { "attempt": { "role": "project_agent", "checkpointRef": native_ref, "pendingTools": [] } }
            }
        });
        if let Some(n) = note {
            w["note"] = json!(n);
        }
        w
    };

    let conflict = make_work("conflict", None, json!(["conflict"]));
    let safe = make_work("safe", None, json!(["safe"]));
    let legacy_file = ws_runtime_dir.join("coordination.jsonl");
    let events = [
        json!({ "schemaVersion": 1, "revision": 1, "kind": "work", "work": { "workId": "done", "state": "delivered", "anchorInputIds": ["finished-input"] } }),
        json!({ "schemaVersion": 1, "revision": 2, "kind": "work", "work": conflict }),
        json!({ "schemaVersion": 1, "revision": 3, "kind": "work", "work": safe }),
    ];
    let mut legacy_raw = String::new();
    for ev in &events {
        legacy_raw.push_str(&serde_json::to_string(ev).unwrap());
        legacy_raw.push('\n');
    }
    fs::write(&legacy_file, &legacy_raw).unwrap();
    #[cfg(unix)]
    let legacy_ver = stat_token(&fs::symlink_metadata(&legacy_file).unwrap());
    #[cfg(not(unix))]
    let legacy_ver = format!("0:0:{}:0:0", legacy_raw.len());
    let generation = uuid::Uuid::new_v4().to_string();

    let v2_dir = ws_runtime_dir.join("coordination-v2");
    fs::create_dir_all(v2_dir.join("segments")).unwrap();
    let seg_event = {
        let mut c2 = safe;
        c2["note"] = json!("current");
        let mut body = json!({
            "schemaVersion": 1,
            "storageVersion": 2,
            "revision": 4,
            "previousHash": "",
            "kind": "work",
            "work": c2,
        });
        let digest = javascript_json_digest(&body).unwrap();
        body["hash"] = json!(digest);
        body
    };
    let seg_hash = seg_event["hash"].as_str().unwrap().to_owned();
    let seg_line = format!("{}\n", javascript_json_string(&seg_event).unwrap());
    fs::write(v2_dir.join("segments/000000000001.jsonl"), seg_line).unwrap();
    fs::write(
        v2_dir.join("manifest.json"),
        serde_json::to_vec(&json!({
            "schemaVersion": 2,
            "minimumReaderVersion": 2,
            "minimumWriterVersion": 2,
            "generation": generation,
            "legacyFile": "coordination.jsonl",
            "legacyVersion": legacy_ver,
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        v2_dir.join("head.json"),
        serde_json::to_vec(&json!({
            "generation": generation,
            "legacyVersion": legacy_ver,
            "revision": 4,
            "hash": seg_hash,
            "minimumWriterVersion": 2,
        }))
        .unwrap(),
    )
    .unwrap();

    // Fork legacy file past v2 baseline
    let mut forked_conflict = conflict;
    forked_conflict["note"] = json!("legacy");
    forked_conflict["anchorInputIds"] = json!(["legacy-input"]);
    legacy_raw.push_str(
        &serde_json::to_string(&json!({
            "schemaVersion": 1,
            "epoch": "legacy-owner",
            "revision": 4,
            "kind": "work",
            "work": forked_conflict,
        }))
        .unwrap(),
    );
    legacy_raw.push('\n');
    fs::write(&legacy_file, &legacy_raw).unwrap();
    drop(seed_host);

    let (mut client, handle) = spawn_live_server(&home, None).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    let inspected = client
        .call(
            "project.bot.recovery",
            json!({ "workspaceId": ws_id, "action": "inspect" }),
        )
        .await;
    assert_eq!(
        inspected["ok"], true,
        "recovery inspect failed: {inspected}"
    );
    let token = inspected["view"]["planToken"].as_str().unwrap().to_owned();

    let bad_restore = client
        .call(
            "project.bot.recovery",
            json!({
                "workspaceId": ws_id,
                "action": "restore",
                "planToken": "0".repeat(64),
            }),
        )
        .await;
    assert_eq!(bad_restore["ok"], false);

    let restored = client
        .call(
            "project.bot.recovery",
            json!({
                "workspaceId": ws_id,
                "action": "restore",
                "planToken": token,
            }),
        )
        .await;
    assert_eq!(restored["ok"], true, "recovery restore failed: {restored}");
    assert_eq!(restored["view"]["canContinue"], true);
    assert!(
        ws_runtime_dir.join("coordination.jsonl").is_dir(),
        "coordination.jsonl should be archived to a directory"
    );

    let reinspected = client
        .call(
            "project.bot.recovery",
            json!({ "workspaceId": ws_id, "action": "inspect" }),
        )
        .await;
    let next_token = reinspected["view"]["planToken"]
        .as_str()
        .unwrap()
        .to_owned();

    let retained = client
        .call(
            "project.bot.recovery",
            json!({
                "workspaceId": ws_id,
                "action": "retain_all",
                "planToken": next_token,
            }),
        )
        .await;
    assert_eq!(
        retained["ok"], true,
        "recovery retain_all failed: {retained}"
    );
    assert_eq!(retained["view"]["works"], json!([]));
    assert_eq!(retained["view"]["sessions"], json!([]));

    client.shutdown(handle).await;
}

#[tokio::test]
async fn bot_get_reports_path_exists_and_rebind_folder_preserves_bot_and_clears_managed() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_a = temp.path().join("bot-a");
    let ws_b = temp.path().join("bot-b");
    let ws_next = temp.path().join("bot-a-rebound");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_a).unwrap();
    fs::create_dir_all(&ws_b).unwrap();
    fs::create_dir_all(&ws_next).unwrap();

    let (mut client, handle) = spawn_live_server(&home, None).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    let created_a = client
        .call(
            "project.bot.create",
            json!({
                "workspacePath": ws_a.to_str().unwrap(),
                "displayName": "Bot A",
                "managed": true,
                "startFamiliarize": false,
            }),
        )
        .await;
    assert_eq!(created_a["ok"], true, "create A failed: {created_a}");
    let ws_a_id = created_a["workspaceId"].as_str().unwrap().to_owned();
    let conv_a_id = created_a["profile"]["agentConversationId"]
        .as_str()
        .unwrap()
        .to_owned();

    let created_b = client
        .call(
            "project.bot.create",
            json!({
                "workspacePath": ws_b.to_str().unwrap(),
                "displayName": "Bot B",
                "managed": false,
                "startFamiliarize": false,
            }),
        )
        .await;
    assert_eq!(created_b["ok"], true, "create B failed: {created_b}");

    // Existing folder -> pathExists: true
    let got_before = client
        .call("project.bot.get", json!({ "workspaceId": ws_a_id }))
        .await;
    assert_eq!(got_before["ok"], true);
    assert_eq!(got_before["path"], ws_a.to_str().unwrap());
    assert_eq!(got_before["pathExists"], true);

    // Removing the directory causes pathExists: false
    fs::remove_dir_all(&ws_a).unwrap();
    let got_missing = client
        .call("project.bot.get", json!({ "workspaceId": ws_a_id }))
        .await;
    assert_eq!(got_missing["ok"], true);
    assert_eq!(got_missing["pathExists"], false);

    // Reject missing target folder & path conflict
    let err_missing = client
        .call(
            "project.bot.rebindFolder",
            json!({
                "workspaceId": ws_a_id,
                "workspacePath": temp.path().join("does-not-exist").to_str().unwrap(),
            }),
        )
        .await;
    assert_eq!(err_missing["ok"], false);
    assert_eq!(err_missing["code"], "FOLDER_NOT_FOUND");

    let err_taken = client
        .call(
            "project.bot.rebindFolder",
            json!({
                "workspaceId": ws_a_id,
                "workspacePath": ws_b.to_str().unwrap(),
            }),
        )
        .await;
    assert_eq!(err_taken["ok"], false);
    assert_eq!(err_taken["code"], "PATH_TAKEN");

    // Rebinding managed bot to ws_next preserves ID/conversation, clears managed, updates path
    let rebound = client
        .call(
            "project.bot.rebindFolder",
            json!({
                "workspaceId": ws_a_id,
                "workspacePath": ws_next.to_str().unwrap(),
            }),
        )
        .await;
    assert_eq!(rebound["ok"], true, "rebind failed: {rebound}");
    assert_eq!(rebound["workspaceId"], ws_a_id);
    assert_eq!(rebound["path"], ws_next.to_str().unwrap());
    assert_eq!(rebound["previousPath"], ws_a.to_str().unwrap());
    assert_eq!(rebound["pathExists"], true);
    assert_eq!(rebound["unchanged"], false);
    assert_eq!(rebound["profile"]["managed"], false);
    assert_eq!(rebound["profile"]["agentConversationId"], conv_a_id);

    let reg_entry = peer_project_agent::ProjectRegistry::new(&home)
        .get(&ws_a_id)
        .unwrap()
        .unwrap();
    assert_eq!(reg_entry.path, ws_next.to_str().unwrap());
    assert_eq!(
        reg_entry.previous_paths,
        vec![ws_a.to_str().unwrap().to_owned()]
    );

    let conv_meta = peer_store::ConversationStore::new(&home)
        .read_metadata(&conv_a_id)
        .unwrap()
        .metadata
        .unwrap();
    assert_eq!(conv_meta["workspacePath"], ws_next.to_str().unwrap());

    let got_after = client
        .call("project.bot.get", json!({ "workspaceId": ws_a_id }))
        .await;
    assert_eq!(got_after["ok"], true);
    assert_eq!(got_after["path"], ws_next.to_str().unwrap());
    assert_eq!(got_after["pathExists"], true);
    assert_eq!(got_after["profile"]["managed"], false);

    // Idempotent rebind to same path
    let idempotent = client
        .call(
            "project.bot.rebindFolder",
            json!({
                "workspaceId": ws_a_id,
                "workspacePath": ws_next.to_str().unwrap(),
            }),
        )
        .await;
    assert_eq!(idempotent["ok"], true);
    assert_eq!(idempotent["unchanged"], true);
    assert_eq!(idempotent["pathExists"], true);

    client.shutdown(handle).await;
}

#[tokio::test]
async fn heartbeat_does_not_replay_failed_turn_until_explicit_retry() {
    use tokio::io::AsyncWriteExt;

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        listener.local_addr().unwrap()
    );
    let req_count = Arc::new(AtomicUsize::new(0));
    let sse_stop = CancellationToken::new();
    let (first_received, first_request) = tokio::sync::oneshot::channel();
    let (fail_first, first_failure) = tokio::sync::oneshot::channel();
    {
        let req_count = Arc::clone(&req_count);
        let stop = sse_stop.clone();
        tokio::spawn(async move {
            let mut first = Some((first_received, first_failure));
            loop {
                tokio::select! {
                    biased;
                    _ = stop.cancelled() => break,
                    accepted = listener.accept() => {
                        let Ok((mut socket, _)) = accepted else { break; };
                        let req_count = Arc::clone(&req_count);
                        let first = first.take();
                        tokio::spawn(async move {
                            let _ = read_http_request(&mut socket).await;
                            req_count.fetch_add(1, Ordering::SeqCst);
                            if let Some((received, fail)) = first {
                                let _ = received.send(());
                                let _ = fail.await;
                                let body = json!([{
                                    "error": {
                                        "code": 400,
                                        "status": "INVALID_ARGUMENT",
                                        "message": "bad schema"
                                    }
                                }]).to_string();
                                let resp = format!(
                                    "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                                    body.len(),
                                    body
                                );
                                let _ = socket.write_all(resp.as_bytes()).await;
                            } else {
                                write_sse_reply(
                                    &mut socket,
                                    &sse_text_response("Recovered after manual retry"),
                                )
                                .await;
                            }
                        });
                    }
                }
            }
        });
    }

    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-hb-pause");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();

    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 50 }),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({ "path": ws_dir, "name": "HB Bot", "startFamiliarize": false }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    let input = json!({
        "workspaceId": ws_id,
        "inputId": "inp-hb-fail-1",
        "text": "Trigger single failure",
    });
    let submitted = client.call("project.bot.submitInput", input.clone()).await;
    assert_eq!(submitted["ok"], true);
    tokio::time::timeout(Duration::from_secs(10), first_request)
        .await
        .expect("first model request")
        .unwrap();
    // A duplicate submission may queue another host wake, but does not add an input.
    let duplicate = client.call("project.bot.submitInput", input).await;
    assert_eq!(duplicate["ok"], true);
    fail_first.send(()).unwrap();

    // Wait for the first failure card with HTTP 400 detail.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    let failed_turn_id = loop {
        let conv = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = conv["messages"].as_array().cloned().unwrap_or_default();
        if let Some(card) = msgs.iter().find(|m| m["card"] == "agent_unavailable") {
            let content = card["content"].as_str().unwrap_or("");
            assert!(
                content.contains("HTTP 400 (model_http_rejected): INVALID_ARGUMENT: bad schema"),
                "unexpected failure card content: {content}"
            );
            break card["turnId"].as_str().unwrap().to_owned();
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for failure card: {conv}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    };

    let wake = client
        .call("project.bot.wake", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(wake["woken"], true);
    // Give both the ordinary wake and the heartbeat a chance to run.
    tokio::time::sleep(Duration::from_millis(320)).await;
    assert_eq!(
        req_count.load(Ordering::SeqCst),
        1,
        "heartbeat must not re-fire failed turn automatically"
    );
    let conv_paused = client
        .call(
            "project.bot.readConversation",
            json!({ "workspaceId": ws_id }),
        )
        .await;
    let cards_paused = conv_paused["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["card"] == "agent_unavailable")
        .count();
    assert_eq!(cards_paused, 1);

    // Explicit manual retry clears the heartbeat pause and runs the turn cleanly.
    let ret = client
        .call(
            "project.bot.retry",
            json!({ "workspaceId": ws_id, "turnId": failed_turn_id }),
        )
        .await;
    assert_eq!(ret["ok"], true, "retry failed: {ret}");

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let conv = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = conv["messages"].as_array().cloned().unwrap_or_default();
        if msgs.iter().any(|m| {
            m["role"] == "assistant"
                && m["content"]
                    .as_str()
                    .is_some_and(|c| c.contains("Recovered after manual retry"))
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for retried reply: {conv}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
    assert_eq!(req_count.load(Ordering::SeqCst), 2);

    sse_stop.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn explicit_reverification_withdrawal_cancels_the_live_request_and_notifies() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let workspace = temp.path().join("verify-workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&workspace).unwrap();
    fs::write(workspace.join("README.md"), "Retained Worker evidence").unwrap();

    let socket = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!(
        "http://{}/v1/chat/completions",
        socket.local_addr().unwrap()
    );
    let (requested_tx, requested_rx) = tokio::sync::oneshot::channel();
    let verifier = tokio::spawn(async move {
        let (mut stream, _) = socket.accept().await.unwrap();
        let request = read_http_request(&mut stream).await;
        assert!(request.contains("Check verification liveness"), "{request}");
        requested_tx.send(()).unwrap();
        let mut data = [0];
        assert_eq!(
            stream.read(&mut data).await.unwrap(),
            0,
            "cancel should close the outstanding verifier request"
        );
    });
    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({"enabled": true, "heartbeatIntervalMs": 5000}),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({
                "path": workspace, "name": "Verifier Cancel Test", "startFamiliarize": false,
            }),
        )
        .await;
    let ws = created["profile"]["workspaceId"].as_str().unwrap();
    let parent = created["profile"]["agentConversationId"].as_str().unwrap();
    let plan_id = "plan-explicit-verify";
    let sid = "explicit-verify";
    let fixture = NativeProjectHost::new(&home, "test-fixture", Some(1)).unwrap();
    fixture.supervisor().save_plan_json(&json!({
        "planId": plan_id, "conversationId": sid, "title": "Explicit verify fixture",
        "targetWorkspacePath": workspace, "status": "completed",
        "updatedAt": "2026-11-26T00:00:00.000Z",
        "successCriteria": [{"id":"exists","kind":"file-exists","path":"README.md"}],
        "delegationOrigin": {
            "workspaceId": ws, "sessionId": sid, "parentConversationId": parent, "phase": "completed",
            "readOnly": true, "independentVerifier": "not_required", "lastWorkerOutput": "Durable worker report"
        }
    })).unwrap();

    let verify_id = client.next_id;
    client.next_id += 1;
    client
        .send(
            &json!({"jsonrpc":"2.0", "id": verify_id, "method":"project.bot.verifySession",
        "params":{"workspaceId":ws, "sessionId":sid, "focus":"Check verification liveness"}}),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(5), requested_rx)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        fixture.supervisor().read_plan(plan_id).unwrap()["delegationOrigin"]["phase"],
        "verifying"
    );
    let cancel_id = client.next_id;
    client.next_id += 1;
    client
        .send(
            &json!({"jsonrpc":"2.0", "id":cancel_id, "method":"project.bot.cancelSession",
        "params":{"workspaceId":ws, "sessionId":sid, "reason":"user_withdrawn"}}),
        )
        .await;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut saw_cancel = false;
        let mut saw_verify = false;
        let mut saw_conversation_change = false;
        while !(saw_cancel && saw_verify && saw_conversation_change) {
            let frame = client.read_frame().await;
            if frame["id"] == cancel_id {
                assert_eq!(frame["result"]["ok"], true, "{frame}");
                saw_cancel = true;
            } else if frame["id"] == verify_id {
                assert_eq!(frame["result"]["ok"], false, "{frame}");
                assert!(
                    matches!(
                        frame["result"]["code"].as_str(),
                        Some("CANCELLED" | "session_state_changed")
                    ),
                    "{frame}"
                );
                saw_verify = true;
            } else if frame["method"] == "project.bot.conversationChanged"
                && frame["params"]["workspaceId"] == ws
            {
                saw_conversation_change = true;
            }
        }
        verifier.await.unwrap();
    })
    .await
    .unwrap();
    let plan = fixture.supervisor().read_plan(plan_id).unwrap();
    assert_eq!(plan["delegationOrigin"]["phase"], "cancelled");
    assert_eq!(
        plan["delegationOrigin"]["cancellation"]["disposition"],
        "user_withdrawn"
    );
    assert_eq!(
        plan["delegationOrigin"]["lastWorkerOutput"],
        "Durable worker report"
    );
    assert_eq!(plan["runner"]["verifierRuns"][0]["status"], "interrupted");
    assert!(plan["resultAcceptance"].is_null());
    client.shutdown(handle).await;
}

#[tokio::test]
async fn submit_input_preempts_inflight_slow_background_wake_and_replies_promptly() {
    let home = TempDir::new().unwrap();
    let ws = TempDir::new().unwrap();
    let ws_dir = ws.path().to_string_lossy().into_owned();

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let wake_reached = Arc::new(Notify::new());
    let wake_reached_srv = Arc::clone(&wake_reached);
    let stop_srv = CancellationToken::new();
    let stop_srv_clone = stop_srv.clone();
    let req_idx = Arc::new(AtomicUsize::new(0));
    let req_idx_srv = Arc::clone(&req_idx);

    tokio::spawn(async move {
        loop {
            tokio::select! {
                biased;
                _ = stop_srv_clone.cancelled() => break,
                accepted = listener.accept() => {
                    let Ok((mut socket, _)) = accepted else { break; };
                    let idx = req_idx_srv.fetch_add(1, Ordering::SeqCst);
                    let notify = Arc::clone(&wake_reached_srv);
                    let stop_conn = stop_srv_clone.clone();
                    tokio::spawn(async move {
                        let _ = read_http_request(&mut socket).await;
                        if idx == 0 {
                            // First call is the invisible background wake turn: stall until preempted.
                            notify.notify_one();
                            stop_conn.cancelled().await;
                            let _ = socket.shutdown().await;
                        } else if idx == 1 {
                            write_sse_reply(&mut socket, &sse_text_response("立即回复用户消息")).await;
                        } else {
                            write_sse_reply(&mut socket, &sse_text_response("NO_REPLY")).await;
                        }
                    });
                }
            }
        }
    });

    let (mut client, handle) =
        spawn_live_server(home.path(), Some(make_test_loader(endpoint))).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({ "path": ws_dir, "name": "Preempt Bot", "startFamiliarize": false }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    // Enqueue a background wake inbox event; heartbeat wakes the workspace and stalls in request #0.
    let inbox = peer_project_agent::ProjectInbox::new(home.path());
    inbox
        .append(
            &ws_id,
            &[json!({ "eventId": "ev-stall-1", "kind": "objective_signal" })],
        )
        .unwrap();

    // Startup recovery and context assembly run before the provider request.
    // Measure preemption separately once the background wake is in flight.
    tokio::time::timeout(Duration::from_secs(15), wake_reached.notified())
        .await
        .expect("background wake turn should start and block on slow provider");

    // While the invisible wake holds the workspace lock, submit a fresh user input.
    let sub = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "inp-preempt-live",
                "text": "立刻回我",
                "surface": "desktop",
            }),
        )
        .await;
    assert_eq!(sub["ok"], true);

    // User input must preempt the slow wake and receive its reply well before any model timeout.
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let conv = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = conv["messages"].as_array().cloned().unwrap_or_default();
        assert!(
            !msgs.iter().any(|m| m["card"] == "agent_stopped"),
            "preempted background wake must not surface an agent_stopped card: {msgs:?}"
        );
        if msgs.iter().any(|m| {
            m["kind"] == "agent_reply"
                && m["content"] == "立即回复用户消息"
                && m["replyTo"] == json!(["input-inp-preempt-live"])
        }) {
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for preempted user reply: {conv}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    stop_srv.cancel();
    client.shutdown(handle).await;
}

#[tokio::test]
async fn model_load_failure_surfaces_unavailable_card_instead_of_silent_received_hang() {
    let home = TempDir::new().unwrap();
    let ws = TempDir::new().unwrap();
    let ws_dir = ws.path().to_string_lossy().into_owned();

    let failing_loader: ModelLoader = Arc::new(|_home, _provider_id, _effort, _fast, _cancel| {
        Box::pin(async {
            Err(peer_core_rpc::RpcError::internal_error(
                "oauth token expired at https://private-proxy.example with Bearer private-token",
            ))
        })
    });

    let (mut client, handle) = spawn_live_server(home.path(), Some(failing_loader)).await;
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;
    let created = client
        .call(
            "project.bot.create",
            json!({ "path": ws_dir, "name": "ModelErr Bot", "startFamiliarize": false }),
        )
        .await;
    let ws_id = created["profile"]["workspaceId"]
        .as_str()
        .unwrap()
        .to_owned();

    let sub = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "inp-model-err-1",
                "text": "还在吗？",
                "surface": "desktop",
            }),
        )
        .await;
    assert_eq!(sub["ok"], true);

    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        let conv = client
            .call(
                "project.bot.readConversation",
                json!({ "workspaceId": ws_id }),
            )
            .await;
        let msgs = conv["messages"].as_array().cloned().unwrap_or_default();
        if let Some(card) = msgs.iter().find(|m| m["card"] == "agent_unavailable") {
            let content = card["content"].as_str().unwrap_or("");
            assert!(content.contains("无法加载模型"), "{content}");
            let payload = conv.to_string();
            for private_detail in [
                "oauth token expired",
                "private-proxy.example",
                "private-token",
            ] {
                assert!(!payload.contains(private_detail), "{payload}");
            }
            assert_eq!(card["meta"]["errorCode"], "MODEL_UNAVAILABLE");
            assert_eq!(card["replyTo"], json!(["input-inp-model-err-1"]));
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for MODEL_UNAVAILABLE card: {conv}"
        );
        tokio::time::sleep(Duration::from_millis(25)).await;
    }

    // Subsequent heartbeats must NOT spam duplicate error cards for the same input.
    tokio::time::sleep(Duration::from_millis(250)).await;
    let conv_after = client
        .call(
            "project.bot.readConversation",
            json!({ "workspaceId": ws_id }),
        )
        .await;
    let card_count = conv_after["messages"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|m| m["card"] == "agent_unavailable")
        .count();
    assert_eq!(
        card_count, 1,
        "heartbeat must not spam duplicate model-error cards"
    );

    client.shutdown(handle).await;
}

#[tokio::test]
async fn queued_question_answer_clears_needs_you_before_consume_and_emits_on_consume() {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().join("home");
    let ws_dir = dir.path().join("ws-queued-attention");
    std::fs::create_dir_all(&ws_dir).unwrap();

    // Seed bot + open reply question
    let seed_host = NativeProjectHost::new(&home, "0.1.0-test", Some(2)).unwrap();
    let (entry, profile) = seed_host
        .bind_workspace(&ws_dir, Some("QueuedAttentionBot"))
        .unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.clone().unwrap();
    seed_host
        .conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "reply-q-live",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Which option?",
                "createdAt": "2026-11-27T03:01:00.000Z",
                "question": { "options": ["Option 1", "Option 2"] }
            }),
            "2026-11-27T03:01:00.000Z",
            None,
        )
        .unwrap();
    // Initialize coordination index so view="cards" succeeds cleanly.
    let _ = seed_host.ensure_lease(&ws_id);
    seed_host
        .recover_workspace_barrier(&ws_id, &CancellationToken::new())
        .await
        .unwrap();
    let _ = seed_host.release_lease(&ws_id);
    drop(seed_host);

    // Mock model server that holds the response until we release a gate so we can
    // prove `conversationChanged` fires immediately after `consume()`, BEFORE the turn ends.
    let (release_tx, release_rx) = tokio::sync::oneshot::channel::<()>();
    let release_rx = Arc::new(tokio::sync::Mutex::new(Some(release_rx)));
    let (model_started_tx, model_started_rx) = tokio::sync::oneshot::channel::<()>();
    let model_started_tx = Arc::new(tokio::sync::Mutex::new(Some(model_started_tx)));

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let sse_stop = CancellationToken::new();
    let sse_cancel = sse_stop.clone();
    {
        let release_rx = Arc::clone(&release_rx);
        let model_started_tx = Arc::clone(&model_started_tx);
        tokio::spawn(async move {
            loop {
                tokio::select! {
                    _ = sse_cancel.cancelled() => break,
                    Ok((mut stream, _)) = listener.accept() => {
                        let _ = read_http_request(&mut stream).await;
                        if let Some(tx) = model_started_tx.lock().await.take() {
                            let _ = tx.send(());
                        }
                        if let Some(rx) = release_rx.lock().await.take() {
                            let _ = rx.await;
                        }
                        let body = "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Option 1 received.\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n";
                        let resp = format!(
                            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                            body.len()
                        );
                        let _ = stream.write_all(resp.as_bytes()).await;
                    }
                }
            }
        });
    }

    let (mut client, handle) = spawn_live_server(&home, Some(make_test_loader(endpoint))).await;

    // 1. Before answering (host still disabled so consume() CANNOT run yet):
    let list_before = client.call("project.bot.list", json!({})).await;
    assert_eq!(list_before["items"][0]["state"]["needsYou"], 1);
    let att_before = client
        .call("project.bot.listAttention", json!({ "workspaceId": ws_id }))
        .await;
    assert_eq!(att_before["items"].as_array().unwrap().len(), 1);
    let cards_before = client
        .call(
            "project.bot.readConversation",
            json!({ "workspaceId": ws_id, "view": "cards" }),
        )
        .await;
    assert_eq!(
        cards_before["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cardId"] == "card:question:reply:reply-q-live")
            .unwrap()["resolvedState"],
        "open"
    );

    // 2. Submit answer while host is disabled -> stays unconsumed in input-queue.jsonl!
    let submit = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "ans-live-1",
                "text": "Option 1",
                "answerTo": "card:question:reply:reply-q-live",
            }),
        )
        .await;
    assert_eq!(submit["ok"], true, "submitInput failed: {submit}");

    // Immediately after submit (BEFORE consume()), needsYou / listAttention / cards must all reflect closure!
    let list_queued = client.call("project.bot.list", json!({})).await;
    assert_eq!(list_queued["items"][0]["state"]["needsYou"], 0);
    let att_queued = client
        .call("project.bot.listAttention", json!({ "workspaceId": ws_id }))
        .await;
    assert!(att_queued["items"].as_array().unwrap().is_empty());
    let cards_queued = client
        .call(
            "project.bot.readConversation",
            json!({ "workspaceId": ws_id, "view": "cards" }),
        )
        .await;
    assert_eq!(
        cards_queued["cards"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["cardId"] == "card:question:reply:reply-q-live")
            .unwrap()["resolvedState"],
        "resolved"
    );

    // Second submission for the same closed question must be rejected as QUESTION_CLOSED.
    let dup = client
        .call(
            "project.bot.submitInput",
            json!({
                "workspaceId": ws_id,
                "inputId": "ans-live-2",
                "text": "Option 1",
                "answerTo": "card:question:reply:reply-q-live",
            }),
        )
        .await;
    assert_eq!(dup["ok"], false);
    assert_eq!(dup["code"], "QUESTION_CLOSED");

    // 3. Enable host so consume() runs and the model turn blocks on our gate.
    //    `conversationChanged` with `conversationId` must fire immediately upon consume(),
    //    BEFORE the gated model turn completes!
    client.notifications.clear();
    client
        .call(
            "project.bot.hostConfigure",
            json!({ "enabled": true, "heartbeatIntervalMs": 60 }),
        )
        .await;

    tokio::time::timeout(Duration::from_secs(5), model_started_rx)
        .await
        .expect("model turn did not start")
        .unwrap();

    let consumed_notif = client
        .wait_for_notification(
            Duration::from_secs(3),
            "conversationChanged after consume before turn finishes",
            |n| {
                n["method"] == "project.bot.conversationChanged"
                    && n["params"]["workspaceId"] == ws_id
                    && n["params"]["conversationId"] == conv_id
            },
        )
        .await;
    assert_eq!(consumed_notif["params"]["conversationId"], conv_id);

    // Release gated model turn and shut down cleanly.
    let _ = release_tx.send(());
    sse_stop.cancel();
    client.shutdown(handle).await;
}
