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
    AcquireLease, ApprovalStore, ExecutionResourceStore, HostIdentity, HostLeaseStore, PolicyStore,
    ResourceReservation,
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
                                && body_str.contains("Delegated Task: Plan Gate Worker")
                            {
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
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for live worker open approval: {list}"
            );
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

    // File must be written on disk
    let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
    loop {
        if ws_dir.join("hello.txt").exists() {
            assert_eq!(
                fs::read_to_string(ws_dir.join("hello.txt")).unwrap(),
                "approved-content\n"
            );
            break;
        }
        assert!(
            tokio::time::Instant::now() < deadline,
            "timed out waiting for hello.txt"
        );
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
            assert!(
                tokio::time::Instant::now() < deadline,
                "timed out waiting for second live approval: {list}"
            );
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
