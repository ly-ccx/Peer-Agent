use peer_core_rpc::{CoreServerConfig, PROTOCOL_VERSION, serve_io};
use peer_project_agent::{
    BotProfileStore, CreateBotProfile, CreateObjectiveRequest, MemoryStore, ObjectiveBudget,
    ObjectiveMilestone, ObjectiveStore, WriteMemoryRequest, now_iso, sha256_hex,
};
use peer_runtime::CancellationToken;
use peer_store::{ConversationStore, NewProjectConversation};
use serde_json::{Value, json};
use std::{fs, path::Path, time::Duration};
use tempfile::TempDir;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

struct ProjectTestClient {
    reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
    writer: tokio::io::WriteHalf<DuplexStream>,
    next_id: u64,
}

impl ProjectTestClient {
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
) -> (
    ProjectTestClient,
    tokio::task::JoinHandle<std::io::Result<()>>,
) {
    let (client_stream, server_stream) = tokio::io::duplex(512 * 1024);
    let (server_read, server_write) = tokio::io::split(server_stream);
    let (client_read, client_write) = tokio::io::split(client_stream);
    let shutdown = CancellationToken::new();
    let config = CoreServerConfig {
        reverse_request_timeout: Duration::from_secs(5),
        ..CoreServerConfig::new("0.1.0-test", data_home.to_path_buf())
    };
    let handle = tokio::spawn(serve_io(server_read, server_write, config, shutdown));
    let mut client = ProjectTestClient {
        reader: BufReader::new(client_read),
        writer: client_write,
        next_id: 1,
    };
    let init = client
        .call(
            "core.initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "client": { "name": "project-domain-test", "version": "0.1.0" },
            }),
        )
        .await;
    assert!(init["error"].is_null(), "init failed: {init}");
    (client, handle)
}

#[tokio::test]
async fn project_memory_objectives_and_profile_policy_roundtrip() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    fs::create_dir_all(&home).unwrap();

    // Create Bot profile & its canonical conversation in ConversationStore.
    let conv_store = ConversationStore::new(&home);
    let conv_meta = conv_store
        .create_project_conversation(
            &NewProjectConversation {
                id: Some("conv-bot-1"),
                title: "项目助理",
                workspace_id: "ws-1",
                workspace_path: None,
                role: "project_agent",
                parent_conversation_id: None,
                mode: "project_agent",
                created_at: &now_iso(),
            },
            None,
            None,
        )
        .unwrap();
    assert_eq!(conv_meta["id"], "conv-bot-1");

    let profiles = BotProfileStore::new(&home);
    profiles
        .create(&CreateBotProfile {
            workspace_id: "ws-1",
            display_name: "登录助手",
            managed: false,
            agent_conversation_id: "conv-bot-1",
            avatar_salt: "",
        })
        .unwrap();

    // Seed memory items + conflicting pair.
    let mem_store = MemoryStore::new(&home);
    let m1 = mem_store
        .write(&WriteMemoryRequest {
            scope: "project",
            workspace_id: Some("ws-1"),
            kind: "fact",
            text: "登录页在 src/login.tsx",
            trust: "stated",
            source_refs: vec!["m-user".into()],
            pinned: false,
            anchor_message_id: Some("m-user"),
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
        })
        .unwrap();
    let p_file = mem_store.project_file("ws-1").unwrap();
    let conf_a = json!({
        "id": "mem-conf-a", "scope": "project", "kind": "fact", "text": "Choice A",
        "trust": "verified", "sourceRefs": ["ev1"], "pinned": false, "status": "conflicted",
        "confirmedCount": 1, "createdAt": "2026-10-01T00:00:00.000Z", "updatedAt": "2026-10-01T00:00:00.000Z",
        "workspaceId": "ws-1", "topicKey": "choice", "topicValue": "a",
        "conflictId": "memory:mem-conf-a", "conflictsWith": ["mem-conf-b"]
    });
    let conf_b = json!({
        "id": "mem-conf-b", "scope": "project", "kind": "fact", "text": "Choice B",
        "trust": "verified", "sourceRefs": ["ev2"], "pinned": false, "status": "conflicted",
        "confirmedCount": 1, "createdAt": "2026-10-01T00:00:00.000Z", "updatedAt": "2026-10-01T00:00:00.000Z",
        "workspaceId": "ws-1", "topicKey": "choice", "topicValue": "b",
        "conflictId": "memory:mem-conf-a", "conflictsWith": ["mem-conf-a"]
    });
    {
        use std::io::Write;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p_file)
            .unwrap();
        writeln!(f, "{conf_a}\n{conf_b}").unwrap();
    }

    // Seed an objective + TS watch-state.json runtime overlay.
    let obj_store = ObjectiveStore::new(&home);
    let (obj, _) = obj_store
        .create(&CreateObjectiveRequest {
            workspace_id: "ws-1",
            project_agent_conversation_id: "conv-bot-1",
            origin_message_id: "input-0",
            title: "守护登录测试",
            outcome: "保持 auth 测试全绿",
            autonomy: "propose",
            created_by: "user_request",
            watches: vec![json!({
                "watchId": "w-auth",
                "kind": "schedule",
                "probe": { "type": "deterministic", "check": "file_hash", "spec": { "path": "package.json" } }
            })],
            milestones: vec![ObjectiveMilestone {
                id: "ms-1".into(),
                title: "接入核心".into(),
                status: "active".into(),
                session_ids: vec![],
            }],
            success_signals: vec![],
            budget: Some(ObjectiveBudget::default()),
            deadline: None,
            request_id: None,
        })
        .unwrap();

    let watch_hash = sha256_hex(format!("{}:w-auth", obj.objective_id).as_bytes());
    let today_at = now_iso();
    let watch_state_dir = home.join("project-runtime").join("ws-1").join("objectives");
    fs::create_dir_all(&watch_state_dir).unwrap();
    fs::write(
        watch_state_dir.join("watch-state.json"),
        json!({
            "schemaVersion": 1,
            "watches": {
                watch_hash: { "lastDigest": "abc123", "lastObservationAt": today_at }
            },
            "reservations": {
                "exec-1": { "objectiveId": obj.objective_id, "executionKey": "k-1", "at": today_at, "status": "completed" }
            }
        })
        .to_string(),
    )
    .unwrap();

    let (mut client, server_handle) = spawn_server(&home).await;

    // --- 1. project.memory.* ---
    let listed = client
        .call(
            "project.memory.list",
            json!({ "workspaceId": "ws-1", "ids": [m1.id] }),
        )
        .await["result"]
        .clone();
    assert_eq!(listed["ok"], true);
    assert_eq!(listed["memoryEnabled"], true);
    assert_eq!(listed["items"].as_array().unwrap().len(), 1);

    let pinned = client
        .call(
            "project.memory.pin",
            json!({ "workspaceId": "ws-1", "id": m1.id, "pinned": true }),
        )
        .await["result"]
        .clone();
    assert_eq!(pinned["ok"], true);
    assert_eq!(pinned["item"]["pinned"], true);

    let forgot = client
        .call(
            "project.memory.forget",
            json!({ "workspaceId": "ws-1", "id": m1.id }),
        )
        .await["result"]
        .clone();
    assert_eq!(forgot["ok"], true);
    assert_eq!(forgot["item"]["status"], "forgotten");

    let restored = client
        .call(
            "project.memory.restore",
            json!({ "workspaceId": "ws-1", "id": m1.id }),
        )
        .await["result"]
        .clone();
    assert_eq!(restored["ok"], true);
    assert_eq!(restored["item"]["status"], "active");

    let edited = client
        .call(
            "project.memory.edit",
            json!({ "workspaceId": "ws-1", "id": m1.id, "text": "登录页在 src/auth/login.tsx" }),
        )
        .await["result"]
        .clone();
    assert_eq!(edited["ok"], true);
    assert_eq!(edited["revokedId"], m1.id);
    assert_eq!(edited["item"]["text"], "登录页在 src/auth/login.tsx");

    let conflict_req = client
        .call(
            "project.memory.restore",
            json!({ "workspaceId": "ws-1", "id": "mem-conf-a" }),
        )
        .await["result"]
        .clone();
    assert_eq!(conflict_req["ok"], false);
    assert_eq!(conflict_req["code"], "CONFLICT_CHOICE_REQUIRED");

    let conflict_wrong_ws = client
        .call(
            "project.memory.restore",
            json!({ "workspaceId": "ws-2", "id": "mem-conf-b", "resolveConflict": true }),
        )
        .await["result"]
        .clone();
    assert_eq!(conflict_wrong_ws["ok"], false);
    assert_eq!(conflict_wrong_ws["code"], "NOT_FOUND");

    let resolved = client
        .call(
            "project.memory.restore",
            json!({ "workspaceId": "ws-1", "id": "mem-conf-b", "resolveConflict": true }),
        )
        .await["result"]
        .clone();
    assert_eq!(resolved["ok"], true);
    assert_eq!(resolved["item"]["status"], "active");

    let sw = client
        .call(
            "project.memory.setSwitches",
            json!({ "workspaceId": "ws-1", "memoryEnabled": false }),
        )
        .await["result"]
        .clone();
    assert_eq!(sw["ok"], true);
    assert_eq!(sw["memoryEnabled"], false);

    // --- 2. project.objectives.* ---
    let obj_list = client
        .call("project.objectives.list", json!({ "workspaceId": "ws-1" }))
        .await["result"]
        .clone();
    assert_eq!(obj_list["ok"], true);
    assert_eq!(obj_list["items"].as_array().unwrap().len(), 1);
    assert_eq!(obj_list["items"][0]["watches"][0]["lastDigest"], "abc123");
    assert_eq!(obj_list["items"][0]["usage"]["probes"], 1);

    let update_ok = client
        .call(
            "project.objectives.update",
            json!({
                "workspaceId": "ws-1",
                "objectiveId": obj.objective_id,
                "requestId": "req-upd-1",
                "expectedVersion": 1,
                "patch": {
                    "autonomy": "act",
                    "autoAccept": true,
                    "budget": { "maxAutoSessionsPerDay": 2, "maxProbeRunsPerDay": 120 }
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(update_ok["ok"], true, "update failed: {update_ok}");
    assert_eq!(update_ok["item"]["version"], 2);
    assert_eq!(update_ok["item"]["autonomy"], "act");
    assert_eq!(update_ok["item"]["autoAccept"], true);
    assert_eq!(update_ok["conversationId"], "conv-bot-1");
    assert!(
        update_ok["appendedMessage"]["content"]
            .as_str()
            .unwrap()
            .contains("允许这个目标自动签收任务")
    );

    // Idempotent replay with same requestId returns saved result without bumping version.
    let update_replay = client
        .call(
            "project.objectives.update",
            json!({
                "workspaceId": "ws-1",
                "objectiveId": obj.objective_id,
                "requestId": "req-upd-1",
                "patch": {
                    "autonomy": "act",
                    "autoAccept": true,
                    "budget": { "maxAutoSessionsPerDay": 2, "maxProbeRunsPerDay": 120 }
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(update_replay["ok"], true);
    assert_eq!(update_replay["replayed"], true);
    assert_eq!(update_replay["item"]["version"], 2);

    // Reused requestId with altered payload fails cleanly.
    let reused = client
        .call(
            "project.objectives.update",
            json!({
                "workspaceId": "ws-1",
                "objectiveId": obj.objective_id,
                "requestId": "req-upd-1",
                "patch": { "autonomy": "propose" }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(reused["ok"], false);
    assert_eq!(reused["code"], "REQUEST_ID_REUSED");

    // Unproven done milestone (empty sessionIds) rejected.
    let unproven = client
        .call(
            "project.objectives.update",
            json!({
                "workspaceId": "ws-1",
                "objectiveId": obj.objective_id,
                "requestId": "req-unproven",
                "patch": {
                    "milestones": [{ "id": "ms-1", "title": "接入核心", "status": "done", "sessionIds": [] }]
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(unproven["ok"], false);
    assert_eq!(unproven["code"], "MILESTONE_UNPROVEN");

    let paused = client
        .call(
            "project.objectives.pause",
            json!({ "workspaceId": "ws-1", "objectiveId": obj.objective_id, "requestId": "req-pause-1" }),
        )
        .await["result"]
        .clone();
    assert_eq!(paused["ok"], true);
    assert_eq!(paused["item"]["status"], "paused");

    let resumed = client
        .call(
            "project.objectives.resume",
            json!({ "workspaceId": "ws-1", "objectiveId": obj.objective_id, "requestId": "req-resume-1" }),
        )
        .await["result"]
        .clone();
    assert_eq!(resumed["ok"], true);
    assert_eq!(resumed["item"]["status"], "active");

    let deleted = client
        .call(
            "project.objectives.delete",
            json!({ "workspaceId": "ws-1", "objectiveId": obj.objective_id, "requestId": "req-del-1" }),
        )
        .await["result"]
        .clone();
    assert_eq!(deleted["ok"], true);
    assert_eq!(deleted["item"]["status"], "abandoned");

    // --- 3. project.profile.* unknownOutcomePolicy ---
    let initial_pol = client
        .call(
            "project.profile.readUnknownOutcomePolicy",
            json!({ "workspaceId": "ws-1" }),
        )
        .await["result"]
        .clone();
    assert_eq!(initial_pol["ok"], true);
    assert_eq!(initial_pol["policy"]["tier"], "ask");

    let delegated_pol = client
        .call(
            "project.profile.setUnknownOutcomePolicy",
            json!({ "workspaceId": "ws-1", "tier": "bot_verified" }),
        )
        .await["result"]
        .clone();
    assert_eq!(delegated_pol["ok"], true);
    assert_eq!(delegated_pol["policy"]["tier"], "bot_verified");
    assert_eq!(delegated_pol["policy"]["revision"], 1);

    let missing_pol = client
        .call(
            "project.profile.readUnknownOutcomePolicy",
            json!({ "workspaceId": "missing" }),
        )
        .await["result"]
        .clone();
    assert_eq!(missing_pol["ok"], false);
    assert_eq!(missing_pol["code"], "workspace_not_found");

    let _ = client.call("core.shutdown", json!({})).await;
    drop(client);
    server_handle.await.unwrap().unwrap();
}
