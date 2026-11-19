use peer_project_agent::{
    LeaseStatus, MemoryFilter, NativeProjectHost, ProjectCapabilityProvider, SessionSupervisor,
    SpawnCriterion, SpawnSessionRequest, TurnExecutionState, input_message_id,
};
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
    providers::{EffectAdmission, ProviderCall, ProviderRegistry, RuntimeMode},
    session_host::{LocalPermissionDecision, PermissionInput},
};
use peer_store::{ApprovalState, EvidenceIndexStore};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};
use tempfile::tempdir;

struct AutoAllowPermission;

impl PermissionInput for AutoAllowPermission {
    fn decide<'a>(
        &'a mut self,
        _prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async { LocalPermissionDecision::Approve })
    }
}

type ScriptHandler = Box<dyn Fn(&Value) -> String + Send>;

struct MockModelServer {
    endpoint: String,
    requests: Arc<Mutex<Vec<Value>>>,
    _thread: std::thread::JoinHandle<()>,
}

fn sse_tool_call(id: &str, name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    let chunk = json!({
        "choices": [{
            "index": 0,
            "delta": {
                "tool_calls": [{
                    "index": 0,
                    "id": id,
                    "type": "function",
                    "function": {
                        "name": name,
                        "arguments": args_str
                    }
                }]
            },
            "finish_reason": "tool_calls"
        }]
    });
    let usage = json!({
        "choices": [],
        "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}
    });
    format!("data: {chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n")
}

fn sse_text(text: &str) -> String {
    let chunk = json!({
        "choices": [{
            "index": 0,
            "delta": {"content": text},
            "finish_reason": "stop"
        }]
    });
    let usage = json!({
        "choices": [],
        "usage": {"prompt_tokens": 15, "completion_tokens": 4, "total_tokens": 19}
    });
    format!("data: {chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n")
}

fn start_mock_server(handlers: Vec<ScriptHandler>) -> MockModelServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let mut queue: VecDeque<ScriptHandler> = handlers.into();
    let thread = std::thread::spawn(move || {
        while let Some(handler) = queue.pop_front() {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut header = Vec::new();
            let mut b = [0u8; 1];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut b).unwrap();
                header.push(b[0]);
                assert!(header.len() < 65536);
            }
            let header_str = String::from_utf8(header).unwrap();
            let len: usize = header_str
                .lines()
                .find_map(|l| {
                    let lower = l.to_ascii_lowercase();
                    lower
                        .strip_prefix("content-length:")
                        .and_then(|v| v.trim().parse().ok())
                })
                .unwrap_or(0);
            let mut body = vec![0u8; len];
            if len > 0 {
                socket.read_exact(&mut body).unwrap();
            }
            let req_json: Value = serde_json::from_slice(&body).unwrap_or_else(|_| json!({}));
            captured.lock().unwrap().push(req_json.clone());
            let sse = handler(&req_json);
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                sse.len(),
                sse
            );
            socket.write_all(resp.as_bytes()).unwrap();
            let _ = socket.flush();
        }
    });
    MockModelServer {
        endpoint,
        requests,
        _thread: thread,
    }
}

fn mock_model(endpoint: &str) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint: endpoint.to_owned(),
            model: "mock-e2e-model".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(10),
    )
    .unwrap()
}

fn tool_names_from_request(req: &Value) -> Vec<String> {
    req["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
        .collect()
}

fn extract_spawned_session_id(req: &Value) -> Option<String> {
    req["messages"]
        .as_array()?
        .iter()
        .rev()
        .filter(|m| m["role"] == "tool")
        .find_map(|m| {
            let content = m["content"].as_str()?;
            let parsed: Value = serde_json::from_str(content).ok()?;
            parsed["sessionId"].as_str().map(str::to_owned)
        })
}

fn extract_session_id_from_wake(req: &Value) -> Option<String> {
    let sys = req["messages"]
        .as_array()?
        .iter()
        .find(|m| m["role"] == "system")?["content"]
        .as_str()?;
    let marker = "\"sessionId\":\"";
    let start = sys.find(marker)? + marker.len();
    let rest = &sys[start..];
    let end = rest.find('"')?;
    Some(rest[..end].to_owned())
}

#[tokio::test]
async fn full_bot_delegate_worker_evidence_verify_reply_and_policy_acceptance_loop() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("E2E Bot")).unwrap();

    let input_id = "in-e2e-1";
    let anchor_msg_id = input_message_id(input_id).unwrap();
    host.submit_user_input(
        &entry.workspace_id,
        input_id,
        "Create greeting.txt containing hello peer",
        None,
    )
    .unwrap();

    let anchor_for_spawn = anchor_msg_id.clone();
    let anchor_for_reply = anchor_msg_id.clone();
    let server = start_mock_server(vec![
        // 1. Main Bot user turn round 1: verify read-only projection & delegate via spawn_session
        Box::new(move |req| {
            let tools = tool_names_from_request(req);
            assert!(tools.iter().any(|t| t == "spawn_session"));
            assert!(tools.iter().any(|t| t == "post_reply"));
            assert!(tools.iter().any(|t| t == "read_file"));
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "project_agent must never project {forbidden}"
                );
            }
            sse_tool_call(
                "bot-call-1",
                "spawn_session",
                &json!({
                    "anchorMessageIds": [anchor_for_spawn],
                    "title": "Write greeting file",
                    "brief": "Create greeting.txt with content hello peer",
                    "kind": "code",
                    "readOnly": false,
                    "requiredCapabilities": ["local.file.write"],
                    "isolation": "none",
                    "successCriteria": [{
                        "id": "c-file",
                        "kind": "file-contains",
                        "path": "greeting.txt",
                        "expect": "hello peer",
                        "description": "greeting.txt contains hello peer"
                    }]
                }),
            )
        }),
        // 2. Main Bot user turn round 2: wait_for_sessions on spawned worker
        Box::new(|req| {
            let sid =
                extract_spawned_session_id(req).expect("spawn_session tool output has sessionId");
            sse_tool_call(
                "bot-call-2",
                "wait_for_sessions",
                &json!({"sessionIds": [sid]}),
            )
        }),
        // 3. Worker turn round 1: write greeting.txt via real write_file capability
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            assert!(
                tools.iter().any(|t| t == "write_file"),
                "worker should have write_file projected"
            );
            sse_tool_call(
                "worker-call-1",
                "write_file",
                &json!({
                    "path": "greeting.txt",
                    "content": "hello peer\n"
                }),
            )
        }),
        // 4. Worker turn round 2: finish episode
        Box::new(|_req| sse_text("Created greeting.txt with hello peer.")),
        // 5. Main Bot wake turn: post_reply citing verified session -> triggers policy acceptance
        Box::new(move |req| {
            let sid = extract_session_id_from_wake(req).expect("wake context includes sessionId");
            sse_tool_call(
                "bot-wake-1",
                "post_reply",
                &json!({
                    "replyTo": [anchor_for_reply],
                    "text": "Done: created greeting.txt with `hello peer`, verified on disk.",
                    "sources": [sid.clone()],
                    "statusClaims": [{
                        "sessionId": sid,
                        "status": "result_ready"
                    }]
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();

    assert!(tick.held_lease);
    assert_eq!(tick.inputs_consumed, 1);
    assert_eq!(tick.bot_turns_run, 1);
    assert_eq!(tick.sessions_promoted, 1);
    assert_eq!(tick.sessions_executed, 1);
    assert_eq!(tick.wake_turns_run, 1);

    // 1. Real filesystem artifact written by worker
    let written = fs::read_to_string(ws.path().join("greeting.txt")).unwrap();
    assert_eq!(written, "hello peer\n");

    // 2. Canonical agent_reply persisted and discoverable by input_id
    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("canonical agent_reply persisted");
    assert!(reply["content"].as_str().unwrap().contains("greeting.txt"));

    // 3. Delegated plan settled with policy auto-acceptance backed by indexed Host Evidence
    let sessions = host.supervisor().list_sessions(&entry.workspace_id);
    assert_eq!(sessions.len(), 1);
    assert!(sessions[0].accepted, "expected policy auto-acceptance");
    assert_eq!(sessions[0].accepted_by.as_deref(), Some("policy"));
    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &sessions[0].session_id)
        .unwrap();
    assert_eq!(plan["resultAcceptance"]["acceptedBy"], "policy");
    assert!(plan["resultAcceptance"]["verdictRef"].as_str().is_some());
    assert_eq!(plan["criterionResults"][0]["status"], "passed");

    // 4. EvidenceIndexStore contains both worker write_file and host_verify_criterion records
    let ev_refs = host.supervisor().indexed_evidence_refs_for_plan(&plan);
    assert!(
        ev_refs.len() >= 2,
        "expected worker + verifier evidence, got {ev_refs:?}"
    );
    let plan_ev = EvidenceIndexStore::new(home.path())
        .list_for_plan(plan["planId"].as_str().unwrap(), None)
        .unwrap();
    assert!(
        plan_ev
            .iter()
            .any(|row| row["toolName"] == "host_verify_criterion")
    );
    assert_eq!(server.requests.lock().unwrap().len(), 5);
}

#[tokio::test]
async fn read_only_host_admission_rejects_write_shell_and_connections() {
    let home = tempdir().unwrap();
    let supervisor = Arc::new(SessionSupervisor::new(home.path(), Some(1)));
    let state = Arc::new(Mutex::new(TurnExecutionState::default()));
    let mut registry = ProviderRegistry::default();
    registry.register(Box::new(ProjectCapabilityProvider::new(
        home.path(),
        supervisor,
        state,
    )));
    let projection = registry
        .project_for_mode(RuntimeMode::ProjectAgent, None)
        .unwrap();
    let names: Vec<String> = projection
        .definitions()
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|t| t["function"]["name"].as_str().map(str::to_owned))
        .collect();
    for required in ["read_file", "spawn_session", "post_reply", "memory_search"] {
        assert!(names.iter().any(|n| n == required), "missing {required}");
    }
    for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
        assert!(
            !names.iter().any(|n| n == forbidden),
            "forbidden tool {forbidden} must not be projected in ProjectAgent mode"
        );
        assert!(projection.capability(forbidden).is_none());
    }

    // Even if a caller prepares a shell effect in Chat mode, attaching read-only host admission denies it.
    let ws = tempdir().unwrap();
    let cancel = CancellationToken::new();
    let (admission, _adm_handle) = EffectAdmission::spawn_read_only_host(cancel.clone(), || true);
    let chat_proj = registry.project_for_mode(RuntimeMode::Chat, None).unwrap();
    let mut prepared_bash = registry
        .prepare(
            &chat_proj,
            "bash",
            json!({"command": "echo should-not-run"}),
            ws.path(),
            home.path(),
        )
        .unwrap();
    prepared_bash.admission(admission);
    let outcome = prepared_bash
        .start(
            ProviderCall::for_host("conv-1", "call-ro-1", "2026-01-01T00:00:00.000Z"),
            cancel,
        )
        .unwrap()
        .await;
    assert_ne!(
        outcome.status, "success",
        "read-only host admission must reject bash execution"
    );
}

#[tokio::test]
async fn dual_host_lease_contention_allows_client_submit_and_reply_observation() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host_a = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let host_b = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host_a.bind_workspace(ws.path(), Some("Alpha")).unwrap();

    // Host A holds the workspace lease
    assert!(matches!(
        host_a.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    // Host B observes lease held by Host A
    assert!(matches!(
        host_b.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::HeldByOther(_)
    ));

    // Host B acts as client: submits input durably, ticks (must NOT execute turns)
    let input_id = "in-dual-1";
    let anchor = input_message_id(input_id).unwrap();
    host_b
        .submit_user_input(&entry.workspace_id, input_id, "Hello from client", None)
        .unwrap();

    let anchor_clone = anchor.clone();
    let server = start_mock_server(vec![Box::new(move |_req| {
        sse_tool_call(
            "bot-a-1",
            "post_reply",
            &json!({
                "replyTo": [anchor_clone],
                "text": "Handled by Lease Owner A."
            }),
        )
    })]);
    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;

    let report_b = host_b
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert!(!report_b.held_lease);
    assert_eq!(report_b.bot_turns_run, 0);
    assert_eq!(server.requests.lock().unwrap().len(), 0);

    // Host A ticks, consumes Host B's input, and commits reply
    let report_a = host_a
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert!(report_a.held_lease);
    assert_eq!(report_a.inputs_consumed, 1);
    assert_eq!(report_a.bot_turns_run, 1);
    assert!(
        matches!(
            report_a.last_turn.as_ref().map(|t| &t.end),
            Some(peer_project_agent::TurnEndKind::ReplyCommitted { .. })
        ),
        "unexpected turn end: {:?}",
        report_a.last_turn
    );

    // Host B observes Host A's canonical reply
    let observed = host_b
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("client observes host reply");
    assert_eq!(observed["content"], "Handled by Lease Owner A.");
    host_a.close();
}

#[tokio::test]
async fn stale_approval_recovery_and_lease_handoff() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host_a = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host_a
        .bind_workspace(ws.path(), Some("RecoverBot"))
        .unwrap();

    // Host A spawns a plan-approval-gated session (leaves open approval on disk)
    assert!(matches!(
        host_a.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    // Configure plan_approval = "always" on this bot profile so spawning opens a durable approval
    let mut updated_profile = profile.clone();
    updated_profile.plan_approval = Some("always".into());
    host_a.profiles().save(updated_profile).unwrap();
    let spawned = host_a
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: profile.agent_conversation_id.clone().unwrap(),
                anchor_message_ids: vec!["in:a1".into()],
                input_id: "a1".into(),
                surface: "tui".into(),
                title: "Risky migration".into(),
                brief: "Migrate schema".into(),
                kind: "code".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                success_criteria: vec![SpawnCriterion {
                    id: None,
                    kind: "manual".into(),
                    description: "Manual review".into(),
                    command: None,
                    path: None,
                    expect: None,
                }],
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap();
    let approval_id = spawned.approval_id.clone().expect("open approval created");
    let before = host_a
        .approvals()
        .list(Some(&entry.workspace_id), None)
        .unwrap()
        .into_iter()
        .find(|a| a["approvalId"].as_str() == Some(approval_id.as_str()))
        .expect("approval exists");
    assert_eq!(before["state"], ApprovalState::Open.as_str());

    // Host A releases lease (clean exit / crash handoff)
    host_a.close();

    // Host B takes over, runs startup recovery on first tick, and answers a fresh user input
    let host_b = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let input_id = "in-after-recover";
    let anchor = input_message_id(input_id).unwrap();
    host_b
        .submit_user_input(&entry.workspace_id, input_id, "Status check", None)
        .unwrap();
    let anchor_clone = anchor.clone();
    let server = start_mock_server(vec![Box::new(move |_req| {
        sse_tool_call(
            "bot-b-1",
            "post_reply",
            &json!({
                "replyTo": [anchor_clone],
                "text": "Recovered cleanly and ready."
            }),
        )
    })]);
    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let report = host_b
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert!(report.held_lease);
    assert_eq!(report.bot_turns_run, 1);

    // Open approval was marked stale during recovery
    let after = host_b
        .approvals()
        .list(Some(&entry.workspace_id), None)
        .unwrap()
        .into_iter()
        .find(|a| a["approvalId"].as_str() == Some(approval_id.as_str()))
        .expect("approval exists after recovery");
    assert_eq!(after["state"], ApprovalState::Stale.as_str());
    let reply = host_b
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .unwrap();
    assert_eq!(reply["content"], "Recovered cleanly and ready.");
}

#[tokio::test]
async fn memory_and_objective_tools_through_governed_provider_with_chinese_fts_and_evidence() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("MemoryBot")).unwrap();
    let input_id = "in-mem-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(
        &entry.workspace_id,
        input_id,
        "Remember our architecture and create a migration objective",
        None,
    )
    .unwrap();

    let anchor_for_mem = anchor.clone();
    let anchor_clone = anchor.clone();
    let server = start_mock_server(vec![
        // 1. memory_write with Chinese text
        Box::new(move |_req| {
            sse_tool_call(
                "m1",
                "memory_write",
                &json!({
                    "scope": "project",
                    "kind": "decision",
                    "text": "仓库采用 Rust 原生 Ratatui 架构",
                    "sourceRefs": [anchor_for_mem],
                    "anchorMessageId": anchor_for_mem
                }),
            )
        }),
        // 2. memory_search with 2-char Chinese substring ("原生")
        Box::new(|_req| {
            sse_tool_call("m2", "memory_search", &json!({"query": "原生", "limit": 5}))
        }),
        // 3. objective_create after confirming memory hit came back
        Box::new(|req| {
            let last_tool = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .unwrap()["content"]
                .as_str()
                .unwrap();
            assert!(
                last_tool.contains("Ratatui"),
                "Chinese <3-char FTS fallback must find stored memory: {last_tool}"
            );
            sse_tool_call(
                "m3",
                "create_objective",
                &json!({
                    "title": "Finish native CLI",
                    "outcome": "Zero Bun/Node runtime dependencies"
                }),
            )
        }),
        // 4. post_reply
        Box::new(move |_req| {
            sse_tool_call(
                "m4",
                "post_reply",
                &json!({
                    "replyTo": [anchor_clone],
                    "text": "Recorded memory and created objective."
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick.bot_turns_run, 1);

    let memories = host.memory().list(&MemoryFilter {
        workspace_id: Some(&entry.workspace_id),
        ..Default::default()
    });
    assert_eq!(memories.len(), 1);
    assert!(memories[0].text.contains("Ratatui"));

    let objectives = host.objectives().list(&entry.workspace_id).unwrap();
    assert_eq!(objectives.len(), 1);
    assert_eq!(objectives[0].title, "Finish native CLI");

    let conv_id = profile.agent_conversation_id.as_deref().unwrap();
    let ev = EvidenceIndexStore::new(home.path())
        .list_for_conversation(conv_id, None)
        .unwrap();
    assert!(
        ev.len() >= 4,
        "all 4 governed bot tools must register Evidence, got {}",
        ev.len()
    );
}
