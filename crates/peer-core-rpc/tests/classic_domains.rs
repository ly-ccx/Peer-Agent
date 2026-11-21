use peer_core_rpc::{CoreServerConfig, PROTOCOL_VERSION, ResolvedTurnModel, serve_io};
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{ChatDialect, GenerationOptions, Wire},
    },
};
use peer_store::ToolArtifactStore;
use serde_json::{Value, json};
use std::{fs, path::Path, sync::Arc, time::Duration};
use tempfile::TempDir;
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader, DuplexStream},
    net::TcpListener,
    sync::Mutex,
};

struct DomainTestClient {
    reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    next_id: u64,
}

impl DomainTestClient {
    async fn call(&mut self, method: &str, params: Value) -> Value {
        let id = self.next_id;
        self.next_id += 1;
        let mut line = serde_json::to_vec(&json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        }))
        .expect("serialize request");
        line.push(b'\n');
        self.writer.write_all(&line).await.expect("write line");
        self.writer.flush().await.expect("flush line");

        loop {
            let mut raw = String::new();
            let n = self.reader.read_line(&mut raw).await.expect("read line");
            assert!(n > 0, "unexpected EOF waiting for reply to {method}");
            let msg: Value = serde_json::from_str(&raw).expect("parse rpc frame");
            if msg.get("id").and_then(Value::as_u64) == Some(id) && msg.get("method").is_none() {
                return msg;
            }
        }
    }
}

async fn spawn_server(
    data_home: &Path,
    model_loader: Option<peer_core_rpc::ModelLoader>,
) -> (
    DomainTestClient,
    CancellationToken,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    let (server_read, server_write) = tokio::io::split(server_stream);
    let (client_read, client_write) = tokio::io::split(client_stream);
    let shutdown = CancellationToken::new();
    let config = CoreServerConfig {
        reverse_request_timeout: Duration::from_secs(5),
        model_loader,
        ..CoreServerConfig::new("0.1.0-test", data_home.to_path_buf())
    };
    let handle = tokio::spawn(serve_io(
        server_read,
        server_write,
        config,
        shutdown.clone(),
    ));
    let mut client = DomainTestClient {
        reader: BufReader::new(client_read),
        writer: client_write,
        next_id: 1,
    };
    let init = client
        .call(
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "domain-test", "version": "0.1.0" },
            }),
        )
        .await;
    assert!(init["error"].is_null(), "init failed: {init}");
    (client, shutdown, handle)
}

async fn read_http_request(socket: &mut tokio::net::TcpStream) -> String {
    let mut buf = Vec::new();
    let mut tmp = [0u8; 4096];
    let header_end = loop {
        let n = socket.read(&mut tmp).await.unwrap_or(0);
        if n == 0 {
            return String::from_utf8_lossy(&buf).into_owned();
        }
        buf.extend_from_slice(&tmp[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
    };
    let headers = String::from_utf8_lossy(&buf[..header_end]).to_ascii_lowercase();
    let content_len = headers
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length:")
                .and_then(|v| v.trim().parse::<usize>().ok())
        })
        .unwrap_or(0);
    while buf.len() < header_end + content_len {
        let n = socket.read(&mut tmp).await.unwrap_or(0);
        if n == 0 {
            break;
        }
        buf.extend_from_slice(&tmp[..n]);
    }
    String::from_utf8_lossy(&buf).into_owned()
}

#[tokio::test]
async fn classic_conversations_lifecycle_windowing_and_cascade_delete() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws = temp.path().join("workspace");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws).unwrap();

    let (mut client, _shutdown, server_handle) = spawn_server(&home, None).await;

    let c1 = client
        .call(
            "classic.conversations.create",
            json!({ "title": "", "workspacePath": ws.to_string_lossy(), "mode": "plan", "fastMode": true }),
        )
        .await["result"]
        .clone();
    let c1_id = c1["id"].as_str().unwrap().to_owned();
    assert_eq!(c1["mode"], "plan");
    assert_eq!(c1["fastMode"], true);

    let c2 = client
        .call(
            "classic.conversations.create",
            json!({ "title": "Old Archive Target", "workspacePath": ws.to_string_lossy(), "mode": "chat" }),
        )
        .await["result"]
        .clone();
    let c2_id = c2["id"].as_str().unwrap().to_owned();

    let appended = client
        .call(
            "classic.conversations.appendMessage",
            json!({
                "id": c1_id,
                "message": { "id": "m-user-1", "role": "user", "content": "Inspect deployment scripts" }
            }),
        )
        .await["result"]
        .clone();
    assert!(appended.get("messages").is_none());
    assert_eq!(appended["messageCount"], 1);
    assert_eq!(appended["title"], "Inspect deployme…");

    let _ = client
        .call(
            "classic.conversations.appendMessage",
            json!({
                "id": c1_id,
                "message": { "id": "m-assistant-1", "role": "assistant", "content": "Draft" }
            }),
        )
        .await;

    let updated_last = client
        .call(
            "classic.conversations.updateLastMessage",
            json!({ "id": c1_id, "content": "Updated reply" }),
        )
        .await["result"]
        .clone();
    assert_eq!(updated_last["messages"][1]["content"], "Updated reply");

    let page = client
        .call(
            "classic.conversations.get",
            json!({ "id": c1_id, "limit": 1 }),
        )
        .await["result"]
        .clone();
    assert_eq!(page["window"].as_array().unwrap().len(), 1);
    assert_eq!(page["window"][0]["id"], "m-assistant-1");
    assert_eq!(page["hasMore"], true);

    let older_page = client
        .call(
            "classic.conversations.get",
            json!({ "id": c1_id, "limit": 1, "before": page["cursor"] }),
        )
        .await["result"]
        .clone();
    assert_eq!(older_page["window"][0]["id"], "m-user-1");

    // Empty replace refused without allowEmpty
    let replace_err = client
        .call(
            "classic.conversations.replaceMessages",
            json!({ "id": c1_id, "messages": [], "allowEmpty": false }),
        )
        .await;
    assert!(replace_err["error"].is_object());

    let replace_ok = client
        .call(
            "classic.conversations.replaceMessages",
            json!({ "id": c1_id, "messages": [{ "id": "m-only", "role": "user", "content": "Compact" }] }),
        )
        .await["result"]
        .clone();
    assert_eq!(replace_ok["messageCount"], 1);

    let _ = client
        .call(
            "classic.conversations.updateTitle",
            json!({ "id": c1_id, "title": "Renamed Topic", "source": "manual" }),
        )
        .await;
    let _ = client
        .call(
            "classic.conversations.updateMode",
            json!({ "id": c1_id, "mode": "goal" }),
        )
        .await;
    let _ = client
        .call(
            "classic.conversations.updateFastMode",
            json!({ "id": c1_id, "fastMode": false }),
        )
        .await;
    let _ = client
        .call(
            "classic.conversations.updatePreferredExecutionIsolation",
            json!({ "id": c1_id, "preferredExecutionIsolation": "worktree" }),
        )
        .await;
    let me = client
        .call(
            "classic.conversations.updateModelEffort",
            json!({ "id": c1_id, "modelProviderId": "prov::m1", "effort": "high" }),
        )
        .await["result"]
        .clone();
    assert_eq!(me["modelProviderId"], "prov::m1");
    assert_eq!(me["effort"], "high");

    // Omitting modelProviderId keeps prov::m1
    let me2 = client
        .call(
            "classic.conversations.updateModelEffort",
            json!({ "id": c1_id, "effort": "low" }),
        )
        .await["result"]
        .clone();
    assert_eq!(me2["modelProviderId"], "prov::m1");
    assert_eq!(me2["effort"], "low");

    let search = client
        .call(
            "classic.conversations.search",
            json!({ "query": "renamed" }),
        )
        .await["result"]
        .clone();
    assert_eq!(search.as_array().unwrap().len(), 1);
    assert_eq!(search[0]["id"], c1_id);

    let _ = client
        .call("classic.conversations.pin", json!({ "id": c1_id }))
        .await;
    let _ = client
        .call(
            "classic.conversations.reorderPinned",
            json!({ "ids": [c1_id] }),
        )
        .await;
    let _ = client
        .call("classic.conversations.unpin", json!({ "id": c1_id }))
        .await;

    let paginated = client
        .call(
            "classic.conversations.list",
            json!({ "workspacePath": ws.to_string_lossy(), "limit": 1, "paginated": true }),
        )
        .await["result"]
        .clone();
    assert_eq!(paginated["total"], 2);
    assert_eq!(paginated["hasMore"], true);

    let archived = client
        .call("classic.conversations.archive", json!({ "id": c2_id }))
        .await["result"]
        .clone();
    assert_eq!(archived["status"], "archived");
    let restored = client
        .call("classic.conversations.restore", json!({ "id": c2_id }))
        .await["result"]
        .clone();
    assert_eq!(restored["status"], "active");

    let auto_arc = client
        .call(
            "classic.conversations.autoArchive",
            json!({ "before": "2099-01-01T00:00:00Z", "excludeIds": [c1_id] }),
        )
        .await["result"]
        .clone();
    assert_eq!(auto_arc["archivedCount"], 1);
    assert_eq!(auto_arc["archivedIds"], json!([c2_id]));

    let usage = client
        .call(
            "classic.conversations.addUsage",
            json!({ "id": c1_id, "usage": { "inputTokens": 42, "outputTokens": 8 } }),
        )
        .await["result"]
        .clone();
    assert_eq!(usage["inputTokens"], 42);

    // Seed goal plan & tool artifact under c1_id, then verify delete cascades and cleans up
    let plan_id = "plan-cascade-1";
    fs::create_dir_all(home.join("goal-plans")).unwrap();
    fs::write(
        home.join("goal-plans/index.jsonl"),
        format!(
            "{}\n",
            json!({
                "planId": plan_id,
                "conversationId": c1_id,
                "status": "completed",
                "title": "Cascaded goal",
            })
        ),
    )
    .unwrap();
    let plan_path = home.join("goal-plans").join(format!("{plan_id}.json"));
    fs::write(
        &plan_path,
        serde_json::to_vec(&json!({
            "planId": plan_id,
            "conversationId": c1_id,
            "status": "completed",
            "title": "Cascaded goal",
            "runner": { "status": "completed" },
        }))
        .unwrap(),
    )
    .unwrap();
    let artifact_ref = ToolArtifactStore::new(&home)
        .publish_utf8(&c1_id, "large output", &|| false)
        .unwrap();
    let artifact_path = ToolArtifactStore::new(&home)
        .path(&c1_id, &artifact_ref)
        .unwrap();
    assert!(artifact_path.exists());

    let remaining = client
        .call("classic.conversations.delete", json!({ "id": c1_id }))
        .await["result"]
        .clone();
    assert_eq!(remaining.as_array().unwrap().len(), 1);
    assert_eq!(remaining[0]["id"], c2_id);
    assert!(!artifact_path.exists());
    assert!(!plan_path.exists());

    let _ = client.call("core.shutdown", json!({})).await;
    server_handle.await.unwrap().unwrap();
}

#[tokio::test]
async fn classic_usage_skills_mcp_and_llm_domains_roundtrip() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws = temp.path().join("workspace");
    let borrow = temp.path().join("borrow");
    fs::create_dir_all(home.join("usage")).unwrap();
    fs::create_dir_all(ws.join("skills/ws-skill")).unwrap();
    fs::create_dir_all(home.join("skills/global-skill")).unwrap();
    fs::create_dir_all(borrow.join("borrow-skill")).unwrap();

    // 1. Seed Usage request log + provider pricing/label
    fs::write(
        home.join("llm-providers.json"),
        serde_json::to_vec(&json!({
            "version": 2,
            "channels": [{
                "id": "prov-1",
                "groupId": "prov-1",
                "name": "OpenAI",
                "authMethod": "api_key",
                "apiKeyConfigured": true,
                "enabled": true
            }],
            "models": [{
                "id": "prov-1::gpt-5",
                "groupId": "prov-1",
                "model": "gpt-5",
                "modelLabel": "GPT 5 Pro",
                "enabled": true
            }]
        }))
        .unwrap(),
    )
    .unwrap();
    fs::write(
        home.join("usage/requests.jsonl"),
        format!(
            "{}\n{}\n",
            json!({
                "id": "u1",
                "at": "2026-11-21T02:00:00Z",
                "conversationId": "conv-u",
                "modelProviderId": "prov-1::gpt-5",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 100,
                "outputTokens": 20,
                "cacheReadTokens": 0,
                "cacheWriteTokens": 0,
                "estimatedCostUsd": 0.02,
                "pricingSource": "manual"
            }),
            json!({
                "id": "u2",
                "at": "2026-11-21T02:01:00Z",
                "conversationId": "conv-u",
                "modelProviderId": "prov-1::gpt-5",
                "model": "gpt-5",
                "providerName": "OpenAI",
                "inputTokens": 50,
                "outputTokens": 10,
                "cacheReadTokens": 150,
                "cacheWriteTokens": 0,
                "estimatedCostUsd": 0.01,
                "pricingSource": "manual"
            }),
        ),
    )
    .unwrap();

    // 2. Seed Skills
    fs::write(
        home.join("skills/global-skill/SKILL.md"),
        "---\ndescription: Global helper skill\n---\nGlobal body\n",
    )
    .unwrap();
    fs::write(
        ws.join("skills/ws-skill/SKILL.md"),
        "---\ndescription: Workspace helper skill\n---\nWorkspace body\n",
    )
    .unwrap();
    fs::write(
        borrow.join("borrow-skill/SKILL.md"),
        "---\ndescription: Borrowed helper skill\n---\nBorrowed body\n",
    )
    .unwrap();

    // 3. Seed redacted MCP credential (sha256("mcp-cred:demo") precomputed)
    let cred_ref = "mcp-cred:demo";
    let vault_key = format!(
        "mcp/843e2c2ce99608efcd48c7739f727f417f50c243bcf0c4a25df62bbc573d44aa/{}",
        uuid::Uuid::new_v4()
    );
    fs::write(
        home.join("mcp-credentials.json"),
        serde_json::to_vec(&json!({
            "version": 2,
            "credentials": [{
                "id": "demo",
                "credentialRef": cred_ref,
                "kind": "http_bearer",
                "target": "header",
                "label": "Demo Bearer",
                "vaultKey": vault_key,
                "lastFour": "abcd",
                "createdAt": "2026-11-21T00:00:00Z",
                "updatedAt": "2026-11-21T00:00:00Z",
                "storage": "vault"
            }]
        }))
        .unwrap(),
    )
    .unwrap();

    // 4. Mock OpenAI SSE server for classic.llm.complete
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let endpoint = format!("http://{addr}/v1/chat/completions");
    let bodies = Arc::new(Mutex::new(Vec::<Value>::new()));
    let bodies_ref = Arc::clone(&bodies);
    let mock_http = tokio::spawn(async move {
        if let Ok((mut socket, _)) = listener.accept().await {
            let req = read_http_request(&mut socket).await;
            if let Some((_, body)) = req.split_once("\r\n\r\n")
                && let Ok(parsed) = serde_json::from_str::<Value>(body)
            {
                bodies_ref.lock().await.push(parsed);
            }
            let sse = [
                format!(
                    "data: {}\n\n",
                    json!({ "id": "c1", "choices": [{ "index": 0, "delta": { "role": "assistant", "content": "One-shot ok" }, "finish_reason": null }] })
                ),
                format!(
                    "data: {}\n\n",
                    json!({ "id": "c1", "choices": [{ "index": 0, "delta": {}, "finish_reason": "stop" }] })
                ),
                "data: [DONE]\n\n".to_owned(),
            ]
            .join("");
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse.len(),
                sse
            );
            let _ = socket.write_all(resp.as_bytes()).await;
        }
    });

    let endpoint_for_loader = endpoint.clone();
    let loader: peer_core_rpc::ModelLoader = Arc::new(move |_, _, _, _, _| {
        let ep = endpoint_for_loader.clone();
        Box::pin(async move {
            let generation = GenerationOptions {
                chat_dialect: ChatDialect::Environment,
                ..Default::default()
            };
            let model = NativeModel::new(
                ModelConfig {
                    endpoint: ep,
                    model: "gpt-5".into(),
                    provider: "mock-openai".into(),
                    wire: Wire::Chat,
                    generation,
                },
                None,
                Duration::from_secs(10),
            )
            .unwrap();
            Ok(ResolvedTurnModel {
                provider_id: "prov-1::gpt-5".into(),
                effort: "default".into(),
                model,
            })
        })
    });

    let (mut client, _shutdown, server_handle) = spawn_server(&home, Some(loader)).await;

    // Usage checks
    let stats = client.call("classic.usage.stats", json!({})).await["result"].clone();
    assert_eq!(stats["notes"]["scope"], "request_snapshot");
    assert_eq!(stats["byModel"][0]["label"], "GPT 5 Pro");

    let daily = client
        .call(
            "classic.usage.daily",
            json!({ "range": "7d", "now": "2026-11-21T03:00:00Z", "localOffsetMinutes": 0 }),
        )
        .await["result"]
        .clone();
    assert_eq!(daily["totals"]["activeDayCount"], 1);

    let day = client
        .call(
            "classic.usage.day",
            json!({ "date": "2026-11-21", "now": "2026-11-21T03:00:00Z", "localOffsetMinutes": 0 }),
        )
        .await["result"]
        .clone();
    assert_eq!(day["hours"][2]["requestCount"], 2);

    let cache = client.call("classic.usage.cacheHitRate", json!({})).await["result"].clone();
    assert_eq!(cache["byForm"]["first"]["count"], 1);
    assert_eq!(cache["byForm"]["steady"]["count"], 1);

    // Skills checks
    let skills = client
        .call(
            "classic.skills.list",
            json!({ "activeWorkspace": ws.to_string_lossy() }),
        )
        .await["result"]
        .clone();
    assert_eq!(skills.as_array().unwrap().len(), 2);

    let disabled_skills = client
        .call(
            "classic.skills.disable",
            json!({ "skillId": "ws-skill", "activeWorkspace": ws.to_string_lossy() }),
        )
        .await["result"]
        .clone();
    assert_eq!(
        disabled_skills
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["skillId"] == "ws-skill")
            .unwrap()["enabled"],
        false
    );

    let avail = client
        .call(
            "classic.skills.listAvailable",
            json!({ "sourceRoots": [borrow.to_string_lossy()] }),
        )
        .await["result"]
        .clone();
    assert_eq!(avail[0]["skillId"], "borrow-skill");

    let linked = client
        .call(
            "classic.skills.link",
            json!({ "skillId": "borrow-skill", "sourceRoots": [borrow.to_string_lossy()] }),
        )
        .await["result"]
        .clone();
    assert_eq!(linked["ok"], true);

    let detail = client
        .call(
            "classic.skills.getDetail",
            json!({ "skillId": "borrow-skill", "activeWorkspace": ws.to_string_lossy() }),
        )
        .await["result"]
        .clone();
    assert_eq!(detail["instructions"], "Borrowed body\n");

    let unlinked = client
        .call(
            "classic.skills.unlink",
            json!({ "skillId": "borrow-skill" }),
        )
        .await["result"]
        .clone();
    assert_eq!(unlinked["ok"], true);

    let uninstall_ws = client
        .call(
            "classic.skills.uninstall",
            json!({ "skillId": "ws-skill", "activeWorkspace": ws.to_string_lossy() }),
        )
        .await["result"]
        .clone();
    assert_eq!(uninstall_ws["error"], "workspace-skill-not-uninstallable");

    // MCP checks
    let mcp_added = client
        .call(
            "classic.mcp.upsertServer",
            json!({
                "displayName": "Test MCP",
                "url": "https://example.invalid/mcp",
                "headers": { "Authorization": "Bearer secret" },
                "auth": { "mode": "http_bearer", "credentialRef": "demo" },
                "tools": [{ "name": "ping", "description": "Ping" }]
            }),
        )
        .await["result"]
        .clone();
    let mcp_id = mcp_added["id"].as_str().unwrap().to_owned();
    assert!(mcp_added.get("headers").is_none());

    let mcp_creds = client.call("classic.mcp.listCredentials", json!({})).await["result"].clone();
    assert_eq!(mcp_creds[0]["credentialRef"], "mcp-cred:demo");
    assert!(mcp_creds[0].get("vaultKey").is_none());

    let mcp_caps = client.call("classic.mcp.listCapabilities", json!({})).await["result"].clone();
    assert_eq!(mcp_caps.as_array().unwrap().len(), 1);

    let _ = client
        .call(
            "classic.mcp.setToolVisibility",
            json!({ "serverId": mcp_id, "toolName": "ping", "visible": false }),
        )
        .await;
    let caps_hidden =
        client.call("classic.mcp.listCapabilities", json!({})).await["result"].clone();
    assert_eq!(caps_hidden, json!([]));

    let mcp_removed = client
        .call("classic.mcp.uninstall", json!({ "serverId": mcp_id }))
        .await["result"]
        .clone();
    assert_eq!(mcp_removed["servers"], json!([]));
    assert_eq!(mcp_removed["boundCredentialRef"], "mcp-cred:demo");

    // LLM catalog & completion checks
    let catalog = client.call("classic.llm.catalog", json!({})).await["result"].clone();
    assert_eq!(catalog.as_array().unwrap().len(), 1);
    assert_eq!(catalog[0]["modelId"], "gpt-5");

    let empty_complete = client
        .call("classic.llm.complete", json!({ "prompt": "   " }))
        .await["result"]
        .clone();
    assert_eq!(empty_complete["success"], false);

    let complete = client
        .call(
            "classic.llm.complete",
            json!({ "id": "prov-1::gpt-5", "prompt": "Say hello", "maxTokens": 120 }),
        )
        .await["result"]
        .clone();
    assert_eq!(complete["success"], true);
    assert_eq!(complete["text"], "One-shot ok");
    assert_eq!(bodies.lock().await.len(), 1);

    let _ = client.call("core.shutdown", json!({})).await;
    server_handle.await.unwrap().unwrap();
    let _ = mock_http.await;
}
