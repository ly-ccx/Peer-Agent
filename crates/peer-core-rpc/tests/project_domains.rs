use peer_core_rpc::{CoreServerConfig, PROTOCOL_VERSION, serve_io};
use peer_project_agent::{
    BotProfileStore, CreateBotProfile, CreateObjectiveRequest, InputQueue, MemoryStore,
    ObjectiveBudget, ObjectiveMilestone, ObjectiveStore, ProjectInbox, ProjectRegistry,
    SubmitInputRequest, WriteMemoryRequest, now_iso, sha256_hex,
};
use peer_runtime::CancellationToken;
use peer_store::{
    ApprovalStore, ConversationStore, HostApproval, HostIdentity, HostLeaseStore, HostSurface,
    NewProjectConversation,
};
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

#[tokio::test]
async fn project_bot_profile_access_read_approvals_history_and_search_roundtrip() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let ws_dir = temp.path().join("ws-repo");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&ws_dir).unwrap();
    let ws_path_str = ws_dir.to_string_lossy().to_string();

    let registry = ProjectRegistry::new(&home);
    let reg_entry = registry.register(&ws_path_str, Some("ws-bot")).unwrap();
    let ws_id = reg_entry.workspace_id.clone();

    let conv_store = ConversationStore::new(&home);
    let root_conv = conv_store
        .create_project_conversation(
            &NewProjectConversation {
                id: Some("conv-bot-root"),
                title: "Bot 助理",
                workspace_id: &ws_id,
                workspace_path: Some(&ws_path_str),
                role: "project_agent",
                parent_conversation_id: None,
                mode: "project_agent",
                created_at: "2026-11-20T00:00:00.000Z",
            },
            None,
            None,
        )
        .unwrap();
    let bot_conv_id = root_conv["id"].as_str().unwrap().to_owned();
    conv_store
        .append_classic_message(
            &bot_conv_id,
            &json!({
                "id": "bot-msg-1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Auth login handler is ready in src/auth.ts",
                "createdAt": "2026-11-20T01:00:00.000Z",
            }),
        )
        .unwrap();

    // Child delegated work_session conversation & active plan to test access inheritance & task search.
    let child_conv = conv_store
        .create_project_conversation(
            &NewProjectConversation {
                id: Some("conv-child-session"),
                title: "Auth refactor task",
                workspace_id: &ws_id,
                workspace_path: Some(&ws_path_str),
                role: "work_session",
                parent_conversation_id: Some(&bot_conv_id),
                mode: "goal",
                created_at: "2026-11-20T01:05:00.000Z",
            },
            None,
            None,
        )
        .unwrap();
    let child_conv_id = child_conv["id"].as_str().unwrap().to_owned();

    // Ordinary workspace conversation (active) + ordinary unscoped conversation + archived ordinary conversation.
    let hist_active = conv_store
        .create_classic_conversation(&json!({
            "title": "Workspace classic session",
            "workspacePath": ws_path_str,
        }))
        .unwrap();
    let hist_active_id = hist_active["id"].as_str().unwrap().to_owned();
    let hist_unscoped = conv_store
        .create_classic_conversation(&json!({
            "title": "Global classic session",
        }))
        .unwrap();
    let hist_unscoped_id = hist_unscoped["id"].as_str().unwrap().to_owned();
    let hist_archived = conv_store
        .create_classic_conversation(&json!({
            "title": "Archived workspace session",
            "workspacePath": ws_path_str,
        }))
        .unwrap();
    let hist_archived_id = hist_archived["id"].as_str().unwrap().to_owned();

    let profiles = BotProfileStore::new(&home);
    profiles
        .create(&CreateBotProfile {
            workspace_id: &ws_id,
            display_name: "Initial Bot",
            managed: false,
            agent_conversation_id: &bot_conv_id,
            avatar_salt: "",
        })
        .unwrap();

    // Goal plans: one delegated session (excluded from classic goals, included in task search),
    // one active classic non-delegated goal with waiting_user task, one completed goal (excluded).
    let plans_dir = home.join("goal-plans");
    fs::create_dir_all(&plans_dir).unwrap();
    let delegated_plan = json!({
        "planId": "plan-del-1",
        "conversationId": child_conv_id,
        "title": "Refactor OAuth token refresh",
        "status": "executing",
        "updatedAt": "2026-11-20T01:10:00.000Z",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-del-1",
            "parentConversationId": bot_conv_id,
        }
    });
    let classic_goal = json!({
        "planId": "plan-classic-1",
        "conversationId": hist_active_id,
        "title": "Ship release checklist",
        "status": "executing",
        "workspacePath": ws_path_str,
        "updatedAt": "2026-11-20T01:12:00.000Z",
        "runner": { "status": "idle" },
        "tasks": [{ "id": "t1", "status": "waiting_user" }]
    });
    let completed_goal = json!({
        "planId": "plan-classic-done",
        "conversationId": hist_active_id,
        "title": "Completed classic goal",
        "status": "completed",
        "workspacePath": ws_path_str,
        "updatedAt": "2026-11-20T00:30:00.000Z"
    });
    fs::write(
        plans_dir.join("plan-del-1.json"),
        serde_json::to_string(&delegated_plan).unwrap(),
    )
    .unwrap();
    fs::write(
        plans_dir.join("plan-classic-1.json"),
        serde_json::to_string(&classic_goal).unwrap(),
    )
    .unwrap();
    fs::write(
        plans_dir.join("plan-classic-done.json"),
        serde_json::to_string(&completed_goal).unwrap(),
    )
    .unwrap();
    let index_jsonl = format!(
        "{}\n{}\n{}\n",
        serde_json::to_string(&delegated_plan).unwrap(),
        serde_json::to_string(&classic_goal).unwrap(),
        serde_json::to_string(&completed_goal).unwrap(),
    );
    fs::write(plans_dir.join("index.jsonl"), index_jsonl).unwrap();

    // Seed approvals across scoped & unscoped stores.
    let approvals = ApprovalStore::new(&home);
    approvals
        .open(
            &HostApproval {
                approval_id: "appr-ws-1",
                workspace_id: Some(&ws_id),
                conversation_id: &bot_conv_id,
                stream_id: "stream-1",
                plan_id: None,
                session_id: None,
                capability_id: "local.file.write",
                args_digest: &"a".repeat(64),
                policy_revision: "rev-1",
                created_at: "2026-11-20T01:15:00.000Z",
                deadline_at: None,
            },
            None,
        )
        .unwrap();
    approvals
        .open(
            &HostApproval {
                approval_id: "appr-unscoped-1",
                workspace_id: None,
                conversation_id: &hist_unscoped_id,
                stream_id: "stream-u1",
                plan_id: None,
                session_id: None,
                capability_id: "local.shell.exec",
                args_digest: &"b".repeat(64),
                policy_revision: "rev-0",
                created_at: "2026-11-20T01:16:00.000Z",
                deadline_at: None,
            },
            None,
        )
        .unwrap();

    // Seed an active memory & a forgotten memory for search.
    let mem_store = MemoryStore::new(&home);
    mem_store
        .write(&WriteMemoryRequest {
            scope: "project",
            workspace_id: Some(&ws_id),
            kind: "fact",
            text: "Use strict OAuth PKCE flow for sign-in",
            trust: "stated",
            source_refs: vec!["m-u-1".into()],
            pinned: false,
            anchor_message_id: Some("m-u-1"),
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
        })
        .unwrap();
    let forgotten_mem = mem_store
        .write(&WriteMemoryRequest {
            scope: "project",
            workspace_id: Some(&ws_id),
            kind: "fact",
            text: "Forgotten OAuth secret token hint",
            trust: "stated",
            source_refs: vec!["m-u-2".into()],
            pinned: false,
            anchor_message_id: Some("m-u-2"),
            expires_at: None,
            topic_key: None,
            topic_value: None,
            file_anchors: None,
        })
        .unwrap();
    mem_store
        .forget_visible(&ws_id, &forgotten_mem.id, "outdated")
        .unwrap();

    // PNG avatar fixture file.
    let png_path = temp.path().join("custom-avatar.png");
    let png_bytes = vec![0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 42, 43, 44];
    fs::write(&png_path, &png_bytes).unwrap();

    let (mut client, server_handle) = spawn_server(&home).await;

    // Archive hist-conv-archived so listHistory skips it.
    let archived_res = client
        .call(
            "classic.conversations.archive",
            json!({ "id": hist_archived_id }),
        )
        .await;
    assert!(archived_res["error"].is_null());

    // 1. project.profile.update + project.profile.readAvatar
    let bad_update = client
        .call(
            "project.profile.update",
            json!({ "workspaceId": ws_id, "autoHandoffOnPolicyAccept": "yes" }),
        )
        .await["result"]
        .clone();
    assert_eq!(bad_update["ok"], false);
    assert_eq!(bad_update["code"], "INVALID_HANDOFF_POLICY");

    let updated_prof = client
        .call(
            "project.profile.update",
            json!({
                "workspaceId": ws_id,
                "displayName": "Security Bot",
                "proactivity": "high",
                "avatarColor": "#61b68c",
                "autoHandoffOnPolicyAccept": true,
                "planApproval": "writes",
                "acceptancePolicy": "confirm",
                "modelPolicy": {
                    "overrides": {
                        "project_agent": { "mode": "tier", "tier": "strong", "reasoningEffort": "high" }
                    }
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(updated_prof["ok"], true);
    assert_eq!(updated_prof["profile"]["displayName"], "Security Bot");
    assert_eq!(updated_prof["profile"]["proactivity"], "high");
    assert_eq!(updated_prof["profile"]["avatar"]["color"], "#61b68c");
    assert_eq!(updated_prof["profile"]["autoHandoffOnPolicyAccept"], true);
    assert_eq!(updated_prof["profile"]["planApproval"], "writes");
    assert_eq!(updated_prof["profile"]["acceptancePolicy"], "confirm");

    // Installing raster avatar + reading dataUrl + clearing modelPolicy to null
    let with_img = client
        .call(
            "project.profile.update",
            json!({
                "workspaceId": ws_id,
                "avatarSourcePath": png_path.to_string_lossy(),
                "modelPolicy": null,
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(with_img["ok"], true);
    assert_eq!(with_img["profile"]["avatar"]["kind"], "image");
    assert_eq!(with_img["profile"]["modelPolicy"], Value::Null);

    let avatar_res = client
        .call(
            "project.profile.readAvatar",
            json!({ "workspaceId": ws_id }),
        )
        .await["result"]
        .clone();
    assert_eq!(avatar_res["ok"], true);
    assert!(
        avatar_res["dataUrl"]
            .as_str()
            .unwrap()
            .starts_with("data:image/png;base64,iVBORw0KGgo")
    );
    assert_eq!(
        client
            .call(
                "project.profile.readAvatar",
                json!({ "workspaceId": "missing" })
            )
            .await["result"]["code"],
        "NOT_FOUND"
    );

    // 2. project.access.read & project.access.update
    assert_eq!(
        client
            .call(
                "project.access.read",
                json!({ "workspaceId": ws_id, "conversationId": bot_conv_id })
            )
            .await["result"]["code"],
        "INVALID_INPUT"
    );
    let access_ord = client
        .call(
            "project.access.read",
            json!({ "conversationId": hist_active_id }),
        )
        .await["result"]
        .clone();
    assert_eq!(access_ord["ok"], true);
    assert_eq!(access_ord["policy"], Value::Null);
    assert_eq!(access_ord["inherited"], false);

    let access_ws = client
        .call("project.access.read", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(access_ws["ok"], true);
    assert_eq!(access_ws["policy"]["revision"], 1);
    assert_eq!(access_ws["policy"]["accessLevel"], "ask_before_local");
    assert_eq!(access_ws["inherited"], false);
    assert_eq!(access_ws["botName"], "Security Bot");

    let access_child = client
        .call(
            "project.access.read",
            json!({ "conversationId": child_conv_id }),
        )
        .await["result"]
        .clone();
    assert_eq!(access_child["ok"], true);
    assert_eq!(access_child["inherited"], true);
    assert_eq!(access_child["policy"]["workspaceId"], ws_id);

    let access_upd = client
        .call(
            "project.access.update",
            json!({
                "workspaceId": ws_id,
                "expectedRevision": 1,
                "accessLevel": "session_local",
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(access_upd["ok"], true);
    assert_eq!(access_upd["policy"]["revision"], 2);
    assert_eq!(access_upd["policy"]["accessLevel"], "session_local");

    let access_conflict = client
        .call(
            "project.access.update",
            json!({
                "workspaceId": ws_id,
                "expectedRevision": 1,
                "accessLevel": "full_local",
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(access_conflict["ok"], false);
    assert_eq!(access_conflict["code"], "POLICY_CONFLICT");
    assert_eq!(access_conflict["policy"]["revision"], 2);

    // 3. project.bot.markRead (idempotent & advances on new message)
    let mark1 = client
        .call("project.bot.markRead", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(mark1["ok"], true);
    assert_eq!(mark1["changed"], true);
    assert_eq!(mark1["messageId"], "bot-msg-1");
    assert_eq!(mark1["at"], "2026-11-20T01:00:00.000Z");

    let mark2 = client
        .call("project.bot.markRead", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(mark2["ok"], true);
    assert_eq!(mark2["changed"], false);

    conv_store
        .append_classic_message(
            &bot_conv_id,
            &json!({
                "id": "bot-msg-2",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "Follow-up summary",
                "createdAt": "2026-11-20T02:00:00.000Z",
            }),
        )
        .unwrap();
    let mark3 = client
        .call("project.bot.markRead", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(mark3["ok"], true);
    assert_eq!(mark3["changed"], true);
    assert_eq!(mark3["messageId"], "bot-msg-2");

    // 4. project.bot.listApprovals
    let all_approvals = client.call("project.bot.listApprovals", json!({})).await["result"].clone();
    assert_eq!(all_approvals["ok"], true);
    assert_eq!(all_approvals["approvals"].as_array().unwrap().len(), 2);

    let ws_approvals = client
        .call("project.bot.listApprovals", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(ws_approvals["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(ws_approvals["approvals"][0]["approvalId"], "appr-ws-1");

    let unscoped_approvals = client
        .call("project.bot.listApprovals", json!({ "workspaceId": null }))
        .await["result"]
        .clone();
    assert_eq!(unscoped_approvals["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(
        unscoped_approvals["approvals"][0]["approvalId"],
        "appr-unscoped-1"
    );

    // 5. project.bot.listHistory
    let scoped_hist = client
        .call("project.bot.listHistory", json!({ "workspaceId": ws_id }))
        .await["result"]
        .clone();
    assert_eq!(scoped_hist["ok"], true);
    let hist_items = scoped_hist["history"].as_array().unwrap();
    assert_eq!(hist_items.len(), 1);
    assert_eq!(hist_items[0]["id"], hist_active_id);
    let goal_items = scoped_hist["goals"].as_array().unwrap();
    assert_eq!(goal_items.len(), 1);
    assert_eq!(goal_items[0]["planId"], "plan-classic-1");
    assert_eq!(goal_items[0]["waitingUser"], true);

    let unscoped_hist = client
        .call("project.bot.listHistory", json!({ "unscoped": true }))
        .await["result"]
        .clone();
    assert_eq!(unscoped_hist["ok"], true);
    assert_eq!(unscoped_hist["history"].as_array().unwrap().len(), 1);
    assert_eq!(unscoped_hist["history"][0]["id"], hist_unscoped_id);
    assert_eq!(unscoped_hist["goals"].as_array().unwrap().len(), 0);

    // 6. project.bot.search (message + delegated task + effective memory; excludes forgotten memory)
    let search_oauth = client
        .call("project.bot.search", json!({ "query": "OAuth" }))
        .await["result"]
        .clone();
    assert_eq!(search_oauth["ok"], true);
    let hits = search_oauth["hits"].as_array().unwrap();
    assert!(
        hits.iter()
            .any(|h| h["kind"] == "task" && h["sessionId"] == "sess-del-1")
    );
    assert!(
        hits.iter()
            .any(|h| h["kind"] == "memory" && h["text"].as_str().unwrap().contains("PKCE"))
    );
    assert!(
        !hits
            .iter()
            .any(|h| h["text"].as_str().unwrap().contains("Forgotten OAuth"))
    );

    let search_bot = client
        .call("project.bot.search", json!({ "query": "Security Bot" }))
        .await["result"]
        .clone();
    assert_eq!(search_bot["ok"], true);
    assert!(
        search_bot["hits"]
            .as_array()
            .unwrap()
            .iter()
            .any(|h| h["kind"] == "bot" && h["workspaceId"] == ws_id)
    );

    let _ = client.call("core.shutdown", json!({})).await;
    drop(client);
    server_handle.await.unwrap().unwrap();
}

#[tokio::test]
async fn project_bot_diagnostics_history_drafts_and_evidence_roundtrip() {
    let temp = TempDir::new().unwrap();
    let home = temp.path().join("home");
    let repo_dir = temp.path().join("repo-ops");
    fs::create_dir_all(&home).unwrap();
    fs::create_dir_all(&repo_dir).unwrap();

    let registry = ProjectRegistry::new(&home);
    let reg = registry
        .register(&repo_dir.to_string_lossy(), None)
        .unwrap();
    let ws_id = reg.workspace_id;

    let conv_store = ConversationStore::new(&home);
    let created_at = "2026-11-21T03:00:00.000Z";
    let bot_conv = conv_store
        .create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: "Ops Bot",
                workspace_id: &ws_id,
                workspace_path: Some(&reg.path),
                role: "project_agent",
                parent_conversation_id: None,
                mode: "project_agent",
                created_at,
            },
            None,
            None,
        )
        .unwrap();
    let bot_conv_id = bot_conv["id"].as_str().unwrap().to_owned();

    conv_store
        .append_classic_message(
            &bot_conv_id,
            &json!({
                "id": "turn-ops-1",
                "role": "assistant",
                "kind": "agent_turn",
                "content": "checked",
                "createdAt": created_at,
                "meta": {
                    "diagnosticTiming": {
                        "startedAt": "2026-11-21T03:00:00.000Z",
                        "finishedAt": "2026-11-21T03:00:01.250Z",
                        "durationMs": 1250,
                        "outcome": "done"
                    }
                },
                "rounds": [{
                    "toolCalls": [{
                        "name": "get_session",
                        "result": {
                            "ok": true,
                            "title": "Audit Bearer secret-token-999",
                            "statusLabel": "Completed",
                            "evidenceRefs": ["tool-result://query-ops"]
                        }
                    }]
                }]
            }),
        )
        .unwrap();

    let child_conv = conv_store
        .create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: "Worker Task",
                workspace_id: &ws_id,
                workspace_path: Some(&reg.path),
                role: "work_session",
                parent_conversation_id: Some(&bot_conv_id),
                mode: "goal",
                created_at,
            },
            None,
            None,
        )
        .unwrap();
    let child_conv_id = child_conv["id"].as_str().unwrap().to_owned();

    let hist_conv = conv_store
        .create_classic_conversation(&json!({
            "title": "Legacy Auth Migration",
            "workspacePath": &reg.path,
            "mode": "chat",
        }))
        .unwrap();
    let hist_conv_id = hist_conv["id"].as_str().unwrap().to_owned();
    conv_store
        .append_classic_message(
            &hist_conv_id,
            &json!({ "id": "hm-1", "role": "user", "content": "Review OAuth" }),
        )
        .unwrap();
    conv_store
        .append_classic_message(
            &hist_conv_id,
            &json!({ "id": "hm-2", "role": "assistant", "content": "Checked endpoints" }),
        )
        .unwrap();

    let partial_hist = conv_store
        .create_classic_conversation(&json!({
            "title": "Partial Tool Chat",
            "workspacePath": &reg.path,
            "mode": "chat",
        }))
        .unwrap();
    let partial_hist_id = partial_hist["id"].as_str().unwrap().to_owned();
    conv_store
        .append_classic_message(
            &partial_hist_id,
            &json!({
                "id": "ph-1",
                "role": "assistant",
                "content": "Ran tool",
                "tool_calls": [{ "id": "tc-1" }]
            }),
        )
        .unwrap();

    let archived_hist = conv_store
        .create_classic_conversation(&json!({
            "title": "Archived Thread",
            "workspacePath": &reg.path,
            "mode": "chat",
        }))
        .unwrap();
    let archived_hist_id = archived_hist["id"].as_str().unwrap().to_owned();
    conv_store
        .set_archive_status(&archived_hist_id, true)
        .unwrap();

    BotProfileStore::new(&home)
        .create(&CreateBotProfile {
            workspace_id: &ws_id,
            display_name: "Ops Bot",
            managed: false,
            agent_conversation_id: &bot_conv_id,
            avatar_salt: "",
        })
        .unwrap();

    // Seed Lease, InputQueue, Inbox, Approval, Objective + WatchState
    let lease_store = HostLeaseStore::new(&home);
    let host_ident = HostIdentity::new("host-ops-1", HostSurface::Desktop, 4242, "0.1.0").unwrap();
    let _lease = lease_store
        .acquire(&ws_id, &host_ident, 1_700_000_000_000)
        .unwrap();

    let queue = InputQueue::new(&home);
    queue
        .submit_input(&SubmitInputRequest {
            workspace_id: &ws_id,
            input_id: "in-diag-1",
            surface: "desktop",
            text: "hello",
            anchor_refs: vec![],
            quote_refs: vec![],
            attachment_refs: vec![],
            attachments: vec![],
            answer_to: None,
            history_ref: None,
            history_snapshot_id: None,
            history_confirmed: None,
        })
        .unwrap();

    ProjectInbox::new(&home)
        .append(
            &ws_id,
            &[json!({
                "eventId": "ev-diag-1",
                "kind": "needs_user",
                "at": "2026-11-21T03:01:00.000Z"
            })],
        )
        .unwrap();

    ApprovalStore::new(&home)
        .open(
            &HostApproval {
                approval_id: "appr-open-diag",
                workspace_id: Some(&ws_id),
                conversation_id: &child_conv_id,
                stream_id: "s-1",
                plan_id: Some("plan-ops-1"),
                session_id: Some("sess-ops-1"),
                capability_id: "local.file.write",
                args_digest: &"a".repeat(64),
                policy_revision: "rev-1",
                created_at: "2026-11-21T03:00:00.000Z",
                deadline_at: None,
            },
            None,
        )
        .unwrap();

    let obj_store = ObjectiveStore::new(&home);
    let (obj, _) = obj_store
        .create(&CreateObjectiveRequest {
            workspace_id: &ws_id,
            project_agent_conversation_id: &bot_conv_id,
            origin_message_id: "m-obj",
            title: "Watch API",
            outcome: "Healthy",
            autonomy: "propose",
            created_by: "user_request",
            watches: vec![json!({
                "watchId": "w-1",
                "kind": "event",
                "source": {
                    "type": "files",
                    "paths": ["src/main.rs", "token=abcd", "sk-secretkeyvalue123"]
                }
            })],
            milestones: vec![ObjectiveMilestone {
                id: "ms-1".into(),
                title: "Check".into(),
                status: "pending".into(),
                session_ids: vec![],
            }],
            success_signals: vec![],
            budget: Some(ObjectiveBudget::default()),
            deadline: None,
            request_id: None,
        })
        .unwrap();

    let watch_key = sha256_hex(format!("{}:w-1", obj.objective_id).as_bytes());
    let obj_rt_dir = home.join("project-runtime").join(&ws_id).join("objectives");
    fs::create_dir_all(obj_rt_dir.join("probe-evidence")).unwrap();
    fs::write(
        obj_rt_dir.join("watch-state.json"),
        serde_json::to_string(&json!({
            "schemaVersion": 1,
            "watches": {
                watch_key: {
                    "lastObservationAt": "2026-11-21T03:02:00.000Z",
                    "nextRunAt": "2026-11-21T04:02:00.000Z",
                    "pendingExecutionKey": "exec-1"
                }
            },
            "reservations": {}
        }))
        .unwrap(),
    )
    .unwrap();

    let exec_key = "probe-exec-ops-1";
    let exec_hash = sha256_hex(exec_key.as_bytes());
    let watch_ev_ref = format!("objective-probe:{ws_id}:{exec_hash}");
    fs::write(
        obj_rt_dir
            .join("probe-evidence")
            .join(format!("{exec_hash}.json")),
        serde_json::to_string(&json!({
            "workspaceId": ws_id,
            "executionKey": exec_key,
            "evidenceRef": watch_ev_ref,
            "observation": { "summary": "drift detected", "severity": "info", "observedAt": "2026-11-21T03:02:00.000Z" },
            "execution": { "call": { "toolName": "git_status" }, "grant": { "granted": true }, "result": { "status": "success" } }
        }))
        .unwrap(),
    )
    .unwrap();

    // Seed delegated goal plan + shell artifact + evidence-index.jsonl
    let gp_dir = home.join("goal-plans");
    fs::create_dir_all(&gp_dir).unwrap();
    let plan_obj = json!({
        "planId": "plan-ops-1",
        "conversationId": child_conv_id,
        "title": "Audit task",
        "status": "executing",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-ops-1",
            "parentConversationId": bot_conv_id
        }
    });
    fs::write(
        gp_dir.join("plan-ops-1.json"),
        serde_json::to_string(&plan_obj).unwrap(),
    )
    .unwrap();
    fs::write(
        gp_dir.join("index.jsonl"),
        format!("{}\n", serde_json::to_string(&plan_obj).unwrap()),
    )
    .unwrap();

    let shell_art_dir = home.join("shell-artifacts/2026-11-21/art-1");
    fs::create_dir_all(&shell_art_dir).unwrap();
    fs::write(shell_art_dir.join("stdout.txt"), "all checks green\n").unwrap();

    let changed_target = repo_dir.join("src/auth.rs");
    let ev_records = [
        json!({
            "evidenceRef": "tool-result://query-ops",
            "conversationId": bot_conv_id,
            "streamId": "turn-ops-1",
            "toolName": "get_session",
            "capabilityId": "local.delegation.get_session",
            "createdAt": "2026-11-21T03:00:00.000Z"
        }),
        json!({
            "evidenceRef": "local-shell-artifact://art-1/stdout",
            "conversationId": child_conv_id,
            "planId": "plan-ops-1",
            "toolName": "shell_exec",
            "createdAt": "2026-11-21T03:01:00.000Z",
            "artifactRefs": ["local-shell-artifact://art-1/stdout"],
            "userArtifacts": [{
                "kind": "code-change",
                "ref": format!("file://{}", changed_target.to_string_lossy()),
                "label": "auth.rs",
                "preview": { "kind": "code", "diffLines": ["-old", "+new"] }
            }]
        }),
    ];
    fs::write(
        gp_dir.join("evidence-index.jsonl"),
        format!(
            "{}\n{}\n",
            serde_json::to_string(&ev_records[0]).unwrap(),
            serde_json::to_string(&ev_records[1]).unwrap()
        ),
    )
    .unwrap();

    let (mut client, server_handle) = spawn_server(&home).await;

    // 1. project.bot.diagnostics
    let diag_res = client
        .call(
            "project.bot.diagnostics",
            json!({
                "scheduler": {
                    "stats": { "active": 1, "waiting": 0, "limit": 4 },
                    "queue": [],
                    "projects": [{
                        "workspaceId": ws_id,
                        "slots": { "read": 1, "write": 0, "isolated": 0 },
                        "queue": [{ "sessionId": "sess-ops-1", "priority": "high", "enqueuedAt": "2026-11-21T03:00:00.000Z", "reason": null }]
                    }]
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(diag_res["ok"], true);
    let report = &diag_res["report"];
    assert_eq!(report["schemaVersion"], 1);
    assert_eq!(report["errors"], json!([]));
    assert_eq!(report["scheduler"]["stats"]["limit"], 4);
    assert_eq!(report["bots"].as_array().unwrap().len(), 1);
    let bot_diag = &report["bots"][0];
    assert_eq!(bot_diag["lease"]["surface"], "desktop");
    assert_eq!(bot_diag["lease"]["pid"], 4242);
    assert_eq!(bot_diag["input"]["depth"], 1);
    assert_eq!(bot_diag["inbox"]["events"].as_array().unwrap().len(), 1);
    assert_eq!(bot_diag["approvals"].as_array().unwrap().len(), 1);
    assert_eq!(
        bot_diag["objectives"][0]["watches"][0]["paths"],
        json!(["src/main.rs"])
    );
    assert_eq!(bot_diag["objectives"][0]["watches"][0]["pending"], true);
    assert_eq!(bot_diag["turns"].as_array().unwrap().len(), 1);
    assert_eq!(bot_diag["turns"][0]["outcome"], "done");
    assert_eq!(bot_diag["errors"], json!([]));

    // 2. project.bot.continueHistory
    assert_eq!(
        client
            .call(
                "project.bot.continueHistory",
                json!({ "conversationId": bot_conv_id, "workspaceId": ws_id })
            )
            .await["result"]["code"],
        "NOT_HISTORY"
    );
    assert_eq!(
        client
            .call(
                "project.bot.continueHistory",
                json!({ "conversationId": archived_hist_id, "workspaceId": ws_id })
            )
            .await["result"]["code"],
        "ARCHIVED"
    );
    let cont_full = client
        .call(
            "project.bot.continueHistory",
            json!({ "conversationId": hist_conv_id, "workspaceId": ws_id }),
        )
        .await["result"]
        .clone();
    assert_eq!(cont_full["ok"], true);
    assert_eq!(cont_full["input"]["historyRef"], hist_conv_id);
    assert_eq!(
        cont_full["input"]["historySnapshotId"],
        cont_full["snapshot"]["snapshotId"]
    );
    assert_eq!(cont_full["input"]["text"], "继续：Legacy Auth Migration");

    let cont_need_confirm = client
        .call(
            "project.bot.continueHistory",
            json!({ "conversationId": partial_hist_id, "workspaceId": ws_id }),
        )
        .await["result"]
        .clone();
    assert_eq!(cont_need_confirm["ok"], false);
    assert_eq!(
        cont_need_confirm["code"],
        "BACKGROUND_CONFIRMATION_REQUIRED"
    );

    let cont_confirmed = client
        .call(
            "project.bot.continueHistory",
            json!({
                "conversationId": partial_hist_id,
                "workspaceId": ws_id,
                "confirmMissing": true,
                "text": "Continue from tool run",
                "inputId": "hist-in-confirmed"
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(cont_confirmed["ok"], true);
    assert_eq!(cont_confirmed["input"]["historyConfirmed"], true);
    assert_eq!(cont_confirmed["input"]["inputId"], "hist-in-confirmed");

    // 3. project.bot.readInputDraft / writeInputDraft
    assert_eq!(
        client
            .call(
                "project.bot.readInputDraft",
                json!({ "workspaceId": ws_id, "surface": "remote" })
            )
            .await["result"]["code"],
        "NOT_FOUND"
    );
    let draft0 = client
        .call(
            "project.bot.readInputDraft",
            json!({ "workspaceId": ws_id, "surface": "desktop" }),
        )
        .await["result"]
        .clone();
    assert_eq!(draft0["ok"], true);
    assert_eq!(draft0["snapshot"]["revision"], 0);

    let write_ok = client
        .call(
            "project.bot.writeInputDraft",
            json!({
                "workspaceId": ws_id,
                "surface": "desktop",
                "revision": 0,
                "uploads": [{
                    "id": "up-1",
                    "name": "diff.txt",
                    "mimeType": "text/plain",
                    "size": 4,
                    "kind": "text",
                    "text": "diff"
                }],
                "draft": {
                    "text": "Draft follow-up",
                    "quote": null,
                    "attachmentIds": ["up-1"]
                },
                "pending": []
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(write_ok, json!({ "ok": true, "revision": 1 }));

    let draft1 = client
        .call(
            "project.bot.readInputDraft",
            json!({ "workspaceId": ws_id, "surface": "desktop" }),
        )
        .await["result"]
        .clone();
    assert_eq!(draft1["ok"], true);
    assert_eq!(draft1["snapshot"]["revision"], 1);
    assert_eq!(
        draft1["snapshot"]["draft"]["attachments"][0]["text"],
        "diff"
    );

    let conflict = client
        .call(
            "project.bot.writeInputDraft",
            json!({
                "workspaceId": ws_id,
                "surface": "desktop",
                "revision": 0,
                "uploads": [],
                "draft": { "text": "stale", "quote": null, "attachmentIds": [] },
                "pending": []
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(conflict, json!({ "ok": false, "code": "DRAFT_CONFLICT" }));

    // 4. project.bot.readEvidence
    assert_eq!(
        client
            .call(
                "project.bot.readEvidence",
                json!({ "evidenceRef": "../secret" })
            )
            .await["result"]["code"],
        "INVALID_REF"
    );
    assert_eq!(
        client
            .call(
                "project.bot.readEvidence",
                json!({ "evidenceRef": "tool-result://missing" })
            )
            .await["result"]["code"],
        "NOT_FOUND"
    );

    let batch_ev = client
        .call(
            "project.bot.readEvidence",
            json!({
                "evidenceRefs": [
                    "tool-result://query-ops",
                    "tool-result://query-ops",
                    "tool-result://missing"
                ]
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(batch_ev["ok"], true);
    assert_eq!(batch_ev["items"].as_array().unwrap().len(), 2);
    assert_eq!(batch_ev["items"][0]["toolName"], "get_session");

    let query_ev = client
        .call(
            "project.bot.readEvidence",
            json!({ "evidenceRef": "tool-result://query-ops" }),
        )
        .await["result"]
        .clone();
    assert_eq!(query_ev["ok"], true);
    assert_eq!(query_ev["kind"], "observation");
    assert_eq!(
        query_ev["summary"],
        "Audit Bearer [REDACTED_TOKEN]\nCompleted"
    );

    let shell_scoped = client
        .call(
            "project.bot.readEvidence",
            json!({
                "evidenceRef": "local-shell-artifact://art-1/stdout",
                "context": {
                    "workspaceId": ws_id,
                    "task": { "sessionId": "sess-ops-1", "planId": "plan-ops-1" }
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(shell_scoped["ok"], true);
    assert_eq!(shell_scoped["kind"], "diff");
    assert_eq!(shell_scoped["deliveryStatus"], "available");
    assert_eq!(
        shell_scoped["deliveries"][0]["reference"]["task"]["sessionId"],
        "sess-ops-1"
    );
    assert!(
        shell_scoped["summary"]
            .as_str()
            .unwrap()
            .contains("all checks green")
    );

    let shell_denied = client
        .call(
            "project.bot.readEvidence",
            json!({
                "evidenceRef": "local-shell-artifact://art-1/stdout",
                "context": { "workspaceId": "other-ws" }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(shell_denied["ok"], false);
    assert_eq!(shell_denied["deliveryStatus"], "scope_denied");
    assert_eq!(shell_denied["code"], "SCOPE_DENIED");

    let watch_ok = client
        .call(
            "project.bot.readEvidence",
            json!({
                "evidenceRef": watch_ev_ref,
                "context": { "workspaceId": ws_id }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(watch_ok["ok"], true);
    assert_eq!(watch_ok["deliveryStatus"], "available");
    assert!(
        watch_ok["summary"]
            .as_str()
            .unwrap()
            .contains("drift detected")
    );

    let watch_denied = client
        .call(
            "project.bot.readEvidence",
            json!({
                "evidenceRef": watch_ev_ref,
                "context": {
                    "workspaceId": ws_id,
                    "task": { "sessionId": "sess-ops-1", "planId": "plan-ops-1" }
                }
            }),
        )
        .await["result"]
        .clone();
    assert_eq!(watch_denied["code"], "SCOPE_DENIED");

    let _ = client.call("core.shutdown", json!({})).await;
    drop(client);
    server_handle.await.unwrap().unwrap();
}
