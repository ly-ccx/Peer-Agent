use peer_project_agent::{
    CircuitBreakerStore, LeaseStatus, MemoryFilter, NativeProjectHost, ProjectCapabilityProvider,
    QuestionState, SessionSupervisor, SpawnCriterion, SpawnSessionRequest, TurnEndKind,
    TurnExecutionState, bot_list_json, input_message_id, project_reply_questions,
    read_retry_continuity,
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
type HttpScriptHandler = Box<dyn Fn(&Value) -> (u16, &'static str, String) + Send>;

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

fn responses_sse_tool_call(call_id: &str, name: &str, args: &Value) -> String {
    let args_str = serde_json::to_string(args).unwrap();
    let item_id = format!("fc-{call_id}");
    let item_added = json!({
        "type": "response.output_item.added",
        "output_index": 0,
        "item": {
            "id": item_id,
            "type": "function_call",
            "call_id": call_id,
            "name": name,
            "arguments": ""
        }
    });
    let delta = json!({
        "type": "response.function_call_arguments.delta",
        "output_index": 0,
        "item_id": item_id,
        "delta": args_str
    });
    let args_done = json!({
        "type": "response.function_call_arguments.done",
        "output_index": 0,
        "item_id": item_id,
        "arguments": args_str
    });
    let final_item = json!({
        "id": item_id,
        "type": "function_call",
        "call_id": call_id,
        "name": name,
        "arguments": args_str
    });
    let item_done = json!({
        "type": "response.output_item.done",
        "output_index": 0,
        "item": final_item
    });
    let completed = json!({
        "type": "response.completed",
        "response": {
            "status": "completed",
            "output": [final_item],
            "usage": {"input_tokens": 20, "output_tokens": 5, "total_tokens": 25}
        }
    });
    format!(
        "data: {item_added}\n\ndata: {delta}\n\ndata: {args_done}\n\ndata: {item_done}\n\ndata: {completed}\n\n"
    )
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

fn start_http_mock_server(handlers: Vec<HttpScriptHandler>) -> MockModelServer {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let captured = Arc::clone(&requests);
    let mut queue: VecDeque<HttpScriptHandler> = handlers.into();
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
            let (status, content_type, resp_body) = handler(&req_json);
            let reason = if status == 200 { "OK" } else { "Error" };
            let resp = format!(
                "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                resp_body.len(),
                resp_body
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

fn start_mock_server(handlers: Vec<ScriptHandler>) -> MockModelServer {
    let wrapped = handlers
        .into_iter()
        .map(|h| {
            Box::new(move |req: &Value| (200u16, "text/event-stream", h(req))) as HttpScriptHandler
        })
        .collect();
    start_http_mock_server(wrapped)
}

fn mock_model_with_wire(endpoint: &str, wire: Wire) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint: endpoint.to_owned(),
            model: "mock-e2e-model".into(),
            provider: "openai".into(),
            wire,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(10),
    )
    .unwrap()
}

fn mock_model(endpoint: &str) -> NativeModel {
    mock_model_with_wire(endpoint, Wire::Chat)
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

#[tokio::test]
async fn multi_round_bot_tool_loop_encodes_valid_wire_tool_calls_for_chat_and_responses() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Test repo\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("WireBot")).unwrap();

    // 1. Wire::Chat multi-round: list_files -> post_reply
    let chat_input_id = "in-wire-chat-1";
    let chat_anchor = input_message_id(chat_input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, chat_input_id, "List repo files", None)
        .unwrap();

    let chat_anchor_clone = chat_anchor.clone();
    let chat_server = start_mock_server(vec![
        Box::new(|_req| sse_tool_call("c-list-1", "list_files", &json!({"path": "."}))),
        Box::new(move |req| {
            let msgs = req["messages"].as_array().expect("messages array");
            let asst_idx = msgs
                .iter()
                .position(|m| {
                    m["role"] == "assistant"
                        && m["tool_calls"][0]["function"]["name"] == "list_files"
                        && m["tool_calls"][0]["id"]
                            .as_str()
                            .is_some_and(|s| !s.is_empty())
                })
                .expect("round 1 request must include assistant tool_calls");
            let call_id = msgs[asst_idx]["tool_calls"][0]["id"].as_str().unwrap();
            let tool_msg = &msgs[asst_idx + 1];
            assert_eq!(tool_msg["role"], "tool");
            assert_eq!(tool_msg["tool_call_id"], call_id);
            sse_tool_call(
                "c-reply-1",
                "post_reply",
                &json!({
                    "replyTo": [chat_anchor_clone],
                    "text": "Found README.md over Chat wire."
                }),
            )
        }),
    ]);

    let chat_model = mock_model(&chat_server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick1 = host
        .tick(
            &entry.workspace_id,
            &chat_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick1.bot_turns_run, 1);
    let chat_reply = host
        .find_reply_for_input(&entry.workspace_id, chat_input_id)
        .unwrap()
        .expect("chat reply persisted");
    assert_eq!(chat_reply["content"], "Found README.md over Chat wire.");

    // 2. Wire::Responses multi-round: list_files -> post_reply
    let resp_input_id = "in-wire-resp-1";
    let resp_anchor = input_message_id(resp_input_id).unwrap();
    host.submit_user_input(
        &entry.workspace_id,
        resp_input_id,
        "Inspect workspace via Responses wire",
        None,
    )
    .unwrap();

    let resp_anchor_clone = resp_anchor.clone();
    let resp_server = start_mock_server(vec![
        Box::new(|_req| responses_sse_tool_call("r-list-1", "list_files", &json!({"path": "."}))),
        Box::new(move |req| {
            let input = req["input"].as_array().expect("responses input array");
            let fc = input
                .iter()
                .find(|item| item["type"] == "function_call" && item["name"] == "list_files")
                .expect("round 1 Responses input must contain function_call");
            let call_id = fc["call_id"]
                .as_str()
                .filter(|s| !s.is_empty())
                .expect("function_call call_id");
            let output = input
                .iter()
                .find(|item| item["type"] == "function_call_output" && item["call_id"] == call_id)
                .expect("round 1 Responses input must contain matching function_call_output");
            assert!(
                output["output"]
                    .as_str()
                    .is_some_and(|s| s.contains("README.md")),
                "tool output should include list_files result: {output}"
            );
            responses_sse_tool_call(
                "r-reply-1",
                "post_reply",
                &json!({
                    "replyTo": [resp_anchor_clone],
                    "text": "Found README.md over Responses wire."
                }),
            )
        }),
    ]);

    let resp_model = mock_model_with_wire(&resp_server.endpoint, Wire::Responses);
    let tick2 = host
        .tick(
            &entry.workspace_id,
            &resp_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick2.bot_turns_run, 1);
    let resp_reply = host
        .find_reply_for_input(&entry.workspace_id, resp_input_id)
        .unwrap()
        .expect("responses reply persisted");
    assert_eq!(
        resp_reply["content"],
        "Found README.md over Responses wire."
    );
}

#[tokio::test]
async fn failed_bot_user_turn_preserves_unexecuted_input_and_recovers_on_retry() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Retry repo\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("RetryBot")).unwrap();

    let input_id = "in-retry-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, input_id, "Check project", None)
        .unwrap();
    assert!(host.has_pending_work(&entry.workspace_id));

    let server_fail = start_http_mock_server(vec![
        Box::new(|_req| {
            (
                200,
                "text/event-stream",
                sse_tool_call("f-list-1", "list_files", &json!({"path": "."})),
            )
        }),
        Box::new(|_req| {
            (
                500,
                "application/json",
                json!({"error": {"message": "upstream failure"}}).to_string(),
            )
        }),
    ]);
    let fail_model = mock_model(&server_fail.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick1 = host
        .tick(
            &entry.workspace_id,
            &fail_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick1.bot_turns_run, 1);
    assert!(
        matches!(
            tick1.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::Failed { .. })
        ),
        "expected TurnEndKind::Failed, got {:?}",
        tick1.last_turn.as_ref().map(|t| &t.end)
    );
    assert!(
        host.has_pending_work(&entry.workspace_id),
        "failed user input must remain pending in InputQueue for retry"
    );

    let anchor_clone = anchor.clone();
    let server_ok = start_mock_server(vec![Box::new(move |_req| {
        sse_tool_call(
            "ok-reply-1",
            "post_reply",
            &json!({
                "replyTo": [anchor_clone],
                "text": "Recovered on retry."
            }),
        )
    })]);
    let ok_model = mock_model(&server_ok.endpoint);
    let tick2 = host
        .tick(
            &entry.workspace_id,
            &ok_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick2.bot_turns_run, 1);
    assert!(
        !host.has_pending_work(&entry.workspace_id),
        "pending work must clear once reply commits"
    );
    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("canonical reply persisted after retry");
    assert_eq!(reply["content"], "Recovered on retry.");
}

#[tokio::test]
async fn bot_materializes_oversized_tool_results_and_can_read_tool_result() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let mut big = "line-content-0123456789\n".repeat(500);
    big.push_str("\nUNIQUE_TAIL_MARKER\n");
    fs::write(ws.path().join("BIG.md"), &big).unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host
        .bind_workspace(ws.path(), Some("MaterializeBot"))
        .unwrap();

    let input_id = "in-mat-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(
        &entry.workspace_id,
        input_id,
        "Read BIG.md and summarize",
        None,
    )
    .unwrap();

    let anchor_clone = anchor.clone();
    let server = start_mock_server(vec![
        // Round 0: call read_file on BIG.md (> 6000 UTF-16 chars)
        Box::new(|_req| responses_sse_tool_call("big-1", "read_file", &json!({"path": "BIG.md"}))),
        // Round 1: verify read_tool_result is projected and BIG.md was materialized as local_file_ref
        Box::new(|req| {
            let has_reader = req["tools"]
                .as_array()
                .expect("responses tools array")
                .iter()
                .any(|t| t["name"].as_str() == Some("read_tool_result"));
            assert!(has_reader, "project_agent must project read_tool_result");

            let input = req["input"].as_array().expect("responses input array");
            let fc_out = input
                .iter()
                .find(|item| item["type"] == "function_call_output")
                .expect("round 1 function_call_output");
            let out_str = fc_out["output"].as_str().expect("output string");
            let parsed: Value = serde_json::from_str(out_str).expect("materialized json");
            assert_eq!(
                parsed["kind"], "local_file_ref",
                "oversized read_file must materialize as local_file_ref: {parsed}"
            );
            let native_ref = parsed["nativeContentRef"].clone();
            assert!(native_ref.is_object(), "expected nativeContentRef object");
            let tail_offset = native_ref["bytes"]
                .as_u64()
                .unwrap_or(0)
                .saturating_sub(2048);
            responses_sse_tool_call(
                "big-2",
                "read_tool_result",
                &json!({"reference": native_ref, "offset": tail_offset, "length": 2048}),
            )
        }),
        // Round 2: verify read_tool_result returned the full content including UNIQUE_TAIL_MARKER
        Box::new(move |req| {
            let input = req["input"].as_array().expect("responses input array");
            let outputs: Vec<_> = input
                .iter()
                .filter(|item| item["type"] == "function_call_output")
                .collect();
            assert_eq!(outputs.len(), 2, "expected 2 tool outputs in round 2");
            let second_out = outputs[1]["output"].as_str().unwrap_or("");
            assert!(
                second_out.contains("UNIQUE_TAIL_MARKER"),
                "read_tool_result must return full file tail: {second_out}"
            );
            responses_sse_tool_call(
                "big-3",
                "post_reply",
                &json!({
                    "replyTo": [anchor_clone],
                    "text": "Read full BIG.md with tail marker."
                }),
            )
        }),
    ]);

    let model = mock_model_with_wire(&server.endpoint, Wire::Responses);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick.bot_turns_run, 1);
    assert!(
        matches!(
            tick.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::ReplyCommitted { .. })
        ),
        "expected ReplyCommitted, got {:?}",
        tick.last_turn.as_ref().map(|t| &t.end)
    );
    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("canonical reply persisted");
    assert_eq!(reply["content"], "Read full BIG.md with tail marker.");
}

fn sse_streamed_text_then_tool_call(chunks: &[&str], id: &str, name: &str, args: &Value) -> String {
    let mut out = String::new();
    for part in chunks {
        let delta = json!({
            "choices": [{
                "index": 0,
                "delta": {"content": part},
                "finish_reason": Value::Null
            }]
        });
        out.push_str(&format!("data: {delta}\n\n"));
    }
    out.push_str(&sse_tool_call(id, name, args));
    out
}

#[tokio::test]
async fn transient_retry_recovers_without_tripping_breaker_and_auth_error_never_retries() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    host.runner().set_retry_delays_ms(vec![5, 10, 20]);
    let (entry, profile) = host
        .bind_workspace(ws.path(), Some("RetryBreaker"))
        .unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    // 1. Transient HTTP 503 -> retry -> 200 post_reply succeeds cleanly without tripping circuit.
    let input_ok = "in-transient-1";
    let anchor_ok = input_message_id(input_ok).unwrap();
    host.submit_user_input(&entry.workspace_id, input_ok, "Ping server", None)
        .unwrap();
    let server_transient = start_http_mock_server(vec![
        Box::new(|_req| {
            (
                503,
                "application/json",
                json!({"error":{"message":"temporarily unavailable"}}).to_string(),
            )
        }),
        Box::new(move |_req| {
            (
                200,
                "text/event-stream",
                sse_tool_call(
                    "tr-1",
                    "post_reply",
                    &json!({
                        "replyTo": [anchor_ok],
                        "text": "Recovered after 503."
                    }),
                ),
            )
        }),
    ]);
    let transient_model = mock_model(&server_transient.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick_transient = host
        .tick(
            &entry.workspace_id,
            &transient_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(server_transient.requests.lock().unwrap().len(), 2);
    assert!(matches!(
        tick_transient.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));
    let cb = CircuitBreakerStore::new(home.path()).read(&entry.workspace_id);
    assert_eq!(cb.status, "closed");
    assert_eq!(cb.failures, 0);

    // 2. Auth error HTTP 401 never retries (exactly 1 HTTP request) and writes unavailableCard + hidden agent_turn.
    let server_auth = start_http_mock_server(vec![Box::new(|_req| {
        (
            401,
            "application/json",
            json!({"error":{"message":"invalid api key"}}).to_string(),
        )
    })]);
    let auth_model = mock_model(&server_auth.endpoint);
    let input_auth = "in-auth-1";
    host.submit_user_input(&entry.workspace_id, input_auth, "Try with bad auth", None)
        .unwrap();
    let tick_auth = host
        .tick(
            &entry.workspace_id,
            &auth_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(server_auth.requests.lock().unwrap().len(), 1);
    assert!(matches!(
        tick_auth.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::Failed { code }) if code == "model_auth_rejected"
    ));
    let auth_turn_id = tick_auth.last_turn.as_ref().unwrap().turn_id.clone();

    let visible = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap()
        .messages;
    assert!(
        visible.iter().any(|m| {
            m["id"] == format!("{auth_turn_id}-card")
                && m["kind"] == "system_card"
                && m["card"] == "agent_unavailable"
        }),
        "expected unavailableCard in visible interactions"
    );
    assert!(
        !visible.iter().any(|m| m["kind"] == "agent_turn"),
        "agent_turn must remain hidden from visible interactions"
    );
    let raw = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    assert!(
        raw.iter()
            .any(|m| m["id"] == auth_turn_id && m["kind"] == "agent_turn"),
        "expected durable agent_turn in committed store"
    );

    // 3. 4 more consecutive non-retryable 401 failures (total 5) trip persistent circuit-breaker.json;
    // a fresh NativeProjectHost reading the same data_home sees CircuitOpen on subsequent wake turn.
    let mut extra_handlers = Vec::new();
    for _ in 0..4 {
        extra_handlers.push(Box::new(|_req: &Value| {
            (
                401u16,
                "application/json",
                json!({"error":{"message":"invalid api key"}}).to_string(),
            )
        }) as HttpScriptHandler);
    }
    let server_trip = start_http_mock_server(extra_handlers);
    let trip_model = mock_model(&server_trip.endpoint);
    for _ in 0..4 {
        let _ = host
            .tick(
                &entry.workspace_id,
                &trip_model,
                json!({}),
                &mut perm,
                &cancel,
            )
            .await
            .unwrap();
    }
    host.close();

    let persisted_cb = CircuitBreakerStore::new(home.path()).read(&entry.workspace_id);
    assert_eq!(persisted_cb.status, "open");
    assert_eq!(persisted_cb.failures, 5);

    let fresh_host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    fresh_host
        .inbox()
        .append(
            &entry.workspace_id,
            &[json!({
                "eventId": "ev-wake-cb-1",
                "kind": "report_available",
                "sessionId": "sess-1"
            })],
        )
        .unwrap();
    // Clear pending user inputs to isolate wake-turn circuit block on fresh_host
    fresh_host
        .inputs()
        .mark_executed(&entry.workspace_id, &[input_auth.to_owned()], &[], true)
        .unwrap();
    let tick_blocked = fresh_host
        .tick(
            &entry.workspace_id,
            &trip_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick_blocked.wake_turns_run, 1);
    assert!(matches!(
        tick_blocked.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::CircuitOpen)
    ));
}

#[tokio::test]
async fn bot_turn_records_canonical_usage_ledger_and_durable_agent_turn_with_streaming_activity() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("UsageBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    let input_id = "in-usage-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, input_id, "Check usage logging", None)
        .unwrap();

    let server = start_mock_server(vec![Box::new(move |_req| {
        sse_streamed_text_then_tool_call(
            &["Preparing reply... ", "almost done."],
            "u-call-1",
            "post_reply",
            &json!({
                "replyTo": [anchor],
                "text": "Usage recorded and answer posted."
            }),
        )
    })]);
    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick.bot_turns_run, 1);
    let turn_id = tick.last_turn.unwrap().turn_id;

    let ledger_path = home.path().join("usage/requests.jsonl");
    assert!(ledger_path.is_file(), "usage/requests.jsonl must exist");
    let ledger_raw = fs::read_to_string(&ledger_path).unwrap();
    let rows: Vec<Value> = ledger_raw
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let bot_row = rows
        .iter()
        .find(|r| r["streamId"] == turn_id)
        .expect("bot turn usage ledger row");
    assert_eq!(bot_row["role"], "project_agent");
    assert_eq!(bot_row["workspaceId"], entry.workspace_id);
    assert_eq!(bot_row["providerRequestCount"], 1);
    assert_eq!(bot_row["inputTokens"], 20);
    assert_eq!(bot_row["outputTokens"], 5);
    assert_eq!(bot_row["totalTokens"], 25);

    let raw = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let turn_rec = raw
        .iter()
        .find(|m| m["id"] == turn_id && m["kind"] == "agent_turn")
        .expect("durable agent_turn message persisted");
    assert!(turn_rec["rounds"].as_array().is_some_and(|r| !r.is_empty()));
    assert!(turn_rec["meta"]["diagnosticTiming"]["startedAt"].is_string());
    assert!(turn_rec["meta"]["diagnosticTiming"]["finishedAt"].is_string());
    assert!(turn_rec["publicUpdates"].as_array().is_some_and(|u| {
        u.iter()
            .any(|p| p["text"].as_str().unwrap_or("").contains("Preparing reply"))
    }));
}

#[tokio::test]
async fn bot_context_overflow_commits_compaction_marker_and_retries_cleanly() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    host.runner().set_retry_delays_ms(vec![5, 10]);
    let (entry, profile) = host.bind_workspace(ws.path(), Some("CompactBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    // Seed prior conversation history
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "input-old-1",
                "role": "user",
                "kind": "user_input",
                "content": "Earlier topic",
                "createdAt": "2026-11-20T01:00:00.000Z"
            }),
            "2026-11-20T01:00:00.000Z",
            None,
        )
        .unwrap();
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "reply-old-1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "OLD_UNCOMPACTED_DETAIL_SHOULD_BE_SUMMARIZED",
                "createdAt": "2026-11-20T01:01:00.000Z"
            }),
            "2026-11-20T01:01:00.000Z",
            None,
        )
        .unwrap();

    let input_id = "in-compact-2";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, input_id, "Continue now", None)
        .unwrap();

    let anchor_clone = anchor.clone();
    let server = start_http_mock_server(vec![
        // 1. Primary call triggers 413 context overflow
        Box::new(|_req| {
            (
                413,
                "application/json",
                json!({"error":{"message":"context_length_exceeded"}}).to_string(),
            )
        }),
        // 2. Compaction LLM summarization call
        Box::new(|_req| {
            (
                200,
                "text/event-stream",
                sse_text("Compacted summary of earlier discussion."),
            )
        }),
        // 3. Retried primary call carries compaction continuity & succeeds with post_reply
        Box::new(move |req| {
            let sys = req["messages"]
                .as_array()
                .and_then(|arr| arr.iter().find(|m| m["role"] == "system"))
                .and_then(|m| m["content"].as_str())
                .unwrap_or("");
            assert!(
                sys.contains("Compacted summary of earlier discussion."),
                "system prompt must carry compaction continuity summary"
            );
            let serialized = req["messages"].to_string();
            assert!(
                !serialized.contains("OLD_UNCOMPACTED_DETAIL_SHOULD_BE_SUMMARIZED"),
                "compacted old assistant message must be omitted from wire history"
            );
            (
                200,
                "text/event-stream",
                sse_tool_call(
                    "cmp-reply",
                    "post_reply",
                    &json!({
                        "replyTo": [anchor_clone],
                        "text": "Proceeded cleanly after compaction."
                    }),
                ),
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
    assert!(matches!(
        tick.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    let raw = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    assert!(
        raw.iter()
            .any(|m| m.get("_compaction").is_some_and(Value::is_object)),
        "expected canonical _compaction marker message"
    );
    let visible = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap()
        .messages;
    assert!(
        visible
            .iter()
            .all(|m| !m.get("_compaction").is_some_and(Value::is_object)),
        "_compaction marker must remain hidden from visible interactions"
    );
    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("reply persisted after compaction");
    assert_eq!(reply["content"], "Proceeded cleanly after compaction.");
}

#[tokio::test]
async fn reply_question_card_lifecycle_and_canonical_card_id_answer() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("QuestionBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    let input_id = "in-q-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, input_id, "Deploy app", None)
        .unwrap();

    let server = start_mock_server(vec![Box::new(move |_req| {
        sse_tool_call(
            "q-reply-1",
            "post_reply",
            &json!({
                "replyTo": [anchor],
                "text": "Which environment should I target?",
                "question": {
                    "prompt": "Deploy target?",
                    "options": ["Staging", "Prod"]
                }
            }),
        )
    })]);
    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    host.tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();

    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("question reply posted");
    let reply_id = reply["id"].as_str().unwrap().to_owned();

    let page_open = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap();
    let states_open = project_reply_questions(&page_open.messages, i64::MAX / 4);
    // Use current time for expiry check when no expiresAt is set
    let states_now = project_reply_questions(&page_open.messages, 1_700_000_000_000);
    assert_eq!(states_open[&reply_id].state, QuestionState::Open);
    assert_eq!(states_now[&reply_id].state, QuestionState::Open);

    let canonical_card_id = format!("card:question:reply:{reply_id}");
    host.submit_user_input(
        &entry.workspace_id,
        "in-q-answer-1",
        "Staging",
        Some(canonical_card_id),
    )
    .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();

    let page_answered = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap();
    let states_answered = project_reply_questions(&page_answered.messages, 1_700_000_000_000);
    assert_eq!(states_answered[&reply_id].state, QuestionState::Answered);
}

#[tokio::test]
async fn dual_host_takeover_yield_handshake_transfers_lease_cleanly() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host_a = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let host_b = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host_a.bind_workspace(ws.path(), Some("LeaseBot")).unwrap();

    assert!(matches!(
        host_a.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    assert!(matches!(
        host_b.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::HeldByOther(_)
    ));

    // Host B requests takeover -> writes host.yield -> Host A observes takeover_requested()
    assert!(host_b.request_takeover(&entry.workspace_id).unwrap());
    assert!(host_a.takeover_requested(&entry.workspace_id));
    assert!(!host_b.takeover_requested(&entry.workspace_id));

    // Host A yields lease -> Host B acquires cleanly and does NOT see Host A's stale yield
    host_a.release_lease(&entry.workspace_id).unwrap();
    assert!(!host_a.holds_lease(&entry.workspace_id));
    assert!(matches!(
        host_b.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    assert!(!host_b.takeover_requested(&entry.workspace_id));
    host_b.close();
}

fn extract_objective_id_from_tools(req: &Value) -> Option<String> {
    req["messages"]
        .as_array()?
        .iter()
        .rev()
        .filter(|m| m["role"] == "tool")
        .find_map(|m| {
            let parsed: Value = serde_json::from_str(m["content"].as_str()?).ok()?;
            parsed["objective"]["objectiveId"]
                .as_str()
                .map(str::to_owned)
        })
}

fn last_tool_result_json(req: &Value) -> Option<Value> {
    let raw = req["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")?["content"]
        .as_str()?;
    serde_json::from_str(raw).ok()
}

fn git_cmd(cwd: &std::path::Path, args: &[&str]) {
    let out = std::process::Command::new("git")
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .expect("spawn git");
    assert!(
        out.status.success(),
        "git {:?} failed: {}",
        args,
        String::from_utf8_lossy(&out.stderr)
    );
}

#[tokio::test]
async fn objective_full_lifecycle_and_conversation_search_redacts_secrets() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("ObjBot")).unwrap();

    host.submit_user_input(
        &entry.workspace_id,
        "in-obj-1",
        "Track CI with deploy token sk-secret1234567890abcdef and close objective.",
        None,
    )
    .unwrap();

    let server = start_mock_server(vec![
        // 1. create_objective using raw inputId anchor
        Box::new(|_| {
            sse_tool_call(
                "obj-1",
                "create_objective",
                &json!({
                    "title": "Nightly Build",
                    "outcome": "Keep CI green",
                    "autonomy": "propose",
                    "anchorMessageId": "in-obj-1",
                    "milestones": [{"id": "m1", "title": "Green tests", "status": "open"}],
                    "budget": {"maxAutoSessionsPerDay": 2, "maxProbeRunsPerDay": 10}
                }),
            )
        }),
        // 2. get_objective
        Box::new(|req| {
            let oid = extract_objective_id_from_tools(req).unwrap();
            sse_tool_call("obj-2", "get_objective", &json!({"objectiveId": oid}))
        }),
        // 3. update_objective
        Box::new(|req| {
            let oid = extract_objective_id_from_tools(req).unwrap();
            sse_tool_call(
                "obj-3",
                "update_objective",
                &json!({
                    "objectiveId": oid,
                    "title": "Nightly Build v2",
                    "expectedVersion": 1
                }),
            )
        }),
        // 4. pause_objective
        Box::new(|req| {
            let oid = extract_objective_id_from_tools(req).unwrap();
            sse_tool_call(
                "obj-4",
                "pause_objective",
                &json!({"objectiveId": oid, "expectedVersion": 2}),
            )
        }),
        // 5. resume_objective
        Box::new(|req| {
            let oid = extract_objective_id_from_tools(req).unwrap();
            sse_tool_call(
                "obj-5",
                "resume_objective",
                &json!({"objectiveId": oid, "expectedVersion": 3}),
            )
        }),
        // 6. close_objective
        Box::new(|req| {
            let oid = extract_objective_id_from_tools(req).unwrap();
            sse_tool_call(
                "obj-6",
                "close_objective",
                &json!({
                    "objectiveId": oid,
                    "status": "achieved",
                    "evidenceRefs": ["ev-ci-1"]
                }),
            )
        }),
        // 7. search_conversation
        Box::new(|_| {
            sse_tool_call(
                "obj-7",
                "search_conversation",
                &json!({"query": "deploy token"}),
            )
        }),
        // 8. verify redacted search result and commit reply
        Box::new(|req| {
            let search_out = last_tool_result_json(req).expect("search_conversation output");
            assert_eq!(search_out["ok"], true);
            let matches = search_out["matches"].as_array().unwrap();
            assert!(!matches.is_empty());
            assert_eq!(matches[0]["redacted"], true);
            assert_eq!(matches[0]["snippet"], "[REDACTED]");
            sse_tool_call(
                "obj-8",
                "post_reply",
                &json!({
                    "replyTo": ["in-obj-1"],
                    "text": "Objective lifecycle and safe history search verified."
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

    let objs = host.objectives().list(&entry.workspace_id).unwrap();
    assert_eq!(objs.len(), 1);
    assert_eq!(objs[0].title, "Nightly Build v2");
    assert_eq!(objs[0].status, "achieved");
    assert_eq!(objs[0].version, 5);
    assert_eq!(objs[0].extra["closeEvidenceRefs"], json!(["ev-ci-1"]));
    assert!(
        host.find_reply_for_input(&entry.workspace_id, "in-obj-1")
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn post_reply_anchor_resolution_verdict_marks_and_delivery_repair_after_rejection() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("demo.txt"), "ok\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("RepairBot")).unwrap();

    host.submit_user_input(&entry.workspace_id, "in-repair-1", "Check demo.txt", None)
        .unwrap();
    let anchor = input_message_id("in-repair-1").unwrap();

    let server = start_mock_server(vec![
        // 1. User round 1: spawn read-only check session
        Box::new(move |_| {
            sse_tool_call(
                "rep-spawn",
                "spawn_session",
                &json!({
                    "anchorMessageIds": [anchor],
                    "title": "Check demo file",
                    "brief": "List workspace files cleanly",
                    "kind": "research",
                    "readOnly": true,
                    "requiredCapabilities": ["local.file.list"],
                    "isolation": "none",
                    "successCriteria": [{
                        "id": "c-demo",
                        "kind": "file-exists",
                        "path": "demo.txt",
                        "description": "demo.txt exists"
                    }]
                }),
            )
        }),
        // 2. User round 2: wait_for_sessions
        Box::new(|req| {
            let sid = extract_spawned_session_id(req).unwrap();
            sse_tool_call(
                "rep-wait",
                "wait_for_sessions",
                &json!({"sessionIds": [sid]}),
            )
        }),
        // 3. Worker round 1: list_files -> creates indexed Host Evidence
        Box::new(|_| sse_tool_call("w-list", "list_files", &json!({"path": "."}))),
        // 4. Worker round 2: finish episode
        Box::new(|_| sse_text("Confirmed demo.txt exists.")),
        // 5. Wake round 1: attempt post_reply with bad anchor -> rejected with diagnostics
        Box::new(|_| {
            sse_tool_call(
                "wake-bad-anchor",
                "post_reply",
                &json!({
                    "replyTo": ["input-missing"],
                    "text": "Should fail anchor resolution."
                }),
            )
        }),
        // 6. Wake round 2: inspect anchor_not_found diagnostic, emit plain text (no tool call) to trigger delivery_repair
        Box::new(|req| {
            let err_out = last_tool_result_json(req).expect("post_reply error output");
            assert_eq!(err_out["ok"], false);
            assert_eq!(err_out["error"], "anchor_not_found");
            let avail = err_out["availableReplyAnchors"]
                .as_array()
                .expect("availableReplyAnchors diagnostics");
            assert!(
                avail.iter().any(|a| a["messageId"] == "input-in-repair-1"),
                "expected availableReplyAnchors to include input-in-repair-1: {avail:?}"
            );
            sse_text("Plain prose without post_reply should trigger delivery_repair.")
        }),
        // 7. Wake repair round: resolve raw inputId `"in-repair-1"` -> `"input-in-repair-1"` + cite session verdict
        Box::new(|req| {
            let has_repair_nudge = req["messages"].as_array().unwrap().iter().any(|m| {
                m["role"] == "user"
                    && m["content"]
                        .as_str()
                        .is_some_and(|c| c.contains("post_reply"))
            });
            assert!(has_repair_nudge, "expected synthetic repair nudge");
            let sid = extract_session_id_from_wake(req).unwrap();
            sse_tool_call(
                "wake-repaired",
                "post_reply",
                &json!({
                    "replyTo": ["in-repair-1"],
                    "text": "Verified demo.txt exists on disk.",
                    "sources": [sid.clone()],
                    "statusClaims": [{"sessionId": sid, "status": "result_ready"}]
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
    assert_eq!(tick.wake_turns_run, 1);

    let reply = host
        .find_reply_for_input(&entry.workspace_id, "in-repair-1")
        .unwrap()
        .expect("committed reply after delivery repair");
    assert_eq!(reply["replyTo"], json!(["input-in-repair-1"]));
    let marks = reply["marks"].as_array().expect("verdict marks");
    assert!(!marks.is_empty());
    assert!(marks[0]["verdictRef"].as_str().is_some());
    assert!(reply["meta"]["verdictRef"].as_str().is_some());
}

#[tokio::test]
async fn stopped_turn_persists_agent_stopped_card_and_retry_carries_retry_continuity() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("StopBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    host.submit_user_input(&entry.workspace_id, "in-stop-1", "Run stoppable task", None)
        .unwrap();

    let cancel1 = CancellationToken::new();
    let cancel1_hook = cancel1.clone();
    let saw_retry_continuity = Arc::new(Mutex::new(false));
    let saw_retry_continuity_hook = Arc::clone(&saw_retry_continuity);

    let server = start_mock_server(vec![
        // 1. Turn 1 round 1: emit partial progress text alongside a read-only tool
        Box::new(|_| {
            let text_chunk = json!({
                "choices": [{
                    "index": 0,
                    "delta": { "content": "Partial work before stop" },
                    "finish_reason": null
                }]
            });
            let tool_chunk = json!({
                "choices": [{
                    "index": 0,
                    "delta": {
                        "tool_calls": [{
                            "index": 0,
                            "id": "stop-c1",
                            "type": "function",
                            "function": { "name": "list_objectives", "arguments": "{}" }
                        }]
                    },
                    "finish_reason": "tool_calls"
                }]
            });
            let usage = json!({
                "choices": [],
                "usage": {"prompt_tokens": 20, "completion_tokens": 5, "total_tokens": 25}
            });
            format!("data: {text_chunk}\n\ndata: {tool_chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n")
        }),
        // 2. Turn 1 round 2: user hits Ctrl-C before second round completes
        Box::new(move |_| {
            cancel1_hook.cancel();
            sse_text("Cancelled mid-turn")
        }),
        // 3. Turn 2 (retry): verify retry_continuity section in system prompt and complete reply
        Box::new(move |req| {
            let sys = req["messages"][0]["content"].as_str().unwrap_or("");
            if sys.contains("Prior stopped/failed attempt continuity")
                && sys.contains("list_objectives")
                && sys.contains("\"outcome\":\"stopped\"")
            {
                *saw_retry_continuity_hook.lock().unwrap() = true;
            }
            sse_tool_call(
                "retry-ok",
                "post_reply",
                &json!({
                    "replyTo": ["in-stop-1"],
                    "text": "Continued seamlessly from stopped attempt."
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let mut perm = AutoAllowPermission;
    let tick1 = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel1)
        .await
        .unwrap();
    assert_eq!(tick1.bot_turns_run, 1);
    assert_eq!(
        tick1.last_turn.as_ref().unwrap().end,
        TurnEndKind::UserStopped
    );

    let messages = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let stopped_card = messages
        .iter()
        .find(|m| m["kind"] == "system_card" && m["card"] == "agent_stopped")
        .expect("agent_stopped system_card persisted");
    assert_eq!(stopped_card["replyTo"], json!(["input-in-stop-1"]));
    assert_eq!(stopped_card["partialReply"], "Partial work before stop");

    let continuity = read_retry_continuity(&messages, &["input-in-stop-1".into()], None)
        .expect("read_retry_continuity reconstructs stopped turn");
    assert_eq!(continuity["outcome"], "stopped");
    assert_eq!(continuity["completedTools"][0]["name"], "list_objectives");
    assert!(
        host.find_reply_for_input(&entry.workspace_id, "in-stop-1")
            .unwrap()
            .is_none()
    );

    assert!(
        host.retry_stopped_input(&entry.workspace_id, "input-in-stop-1")
            .unwrap()
    );
    let cancel2 = CancellationToken::new();
    let tick2 = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel2)
        .await
        .unwrap();
    assert_eq!(tick2.bot_turns_run, 1);
    assert!(*saw_retry_continuity.lock().unwrap());
    assert!(
        host.find_reply_for_input(&entry.workspace_id, "in-stop-1")
            .unwrap()
            .is_some()
    );
}

#[tokio::test]
async fn digest_surfacing_defers_to_digest_queue_and_flushes_when_due() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("DigestBot")).unwrap();
    host.profiles()
        .set_proactivity(&entry.workspace_id, "low")
        .unwrap();

    host.inbox()
        .append(
            &entry.workspace_id,
            &[json!({
                "eventId": "ev-digest-wake-1",
                "kind": "objective_signal",
                "summary": "Nightly checks remained healthy"
            })],
        )
        .unwrap();

    let server = start_mock_server(vec![Box::new(|_| {
        sse_tool_call(
            "wake-digest-1",
            "post_reply",
            &json!({
                "text": "Overnight status: all checks stayed green.",
                "proactive": true
            }),
        )
    })]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick.wake_turns_run, 1);
    assert_eq!(host.digests().pending(&entry.workspace_id), 1);

    let before = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap();
    assert!(!before.messages.iter().any(|m| m["kind"] == "agent_reply"));

    assert!(
        host.flush_due_digest(&entry.workspace_id, "2026-11-20T08:30:00Z", "09:00")
            .unwrap()
            .is_none()
    );
    assert_eq!(host.digests().pending(&entry.workspace_id), 1);

    let flushed = host
        .flush_due_digest(&entry.workspace_id, "2026-11-20T09:05:00Z", "09:00")
        .unwrap()
        .expect("due digest flushes into conversation");
    assert_eq!(flushed["separatorLabel"], "今天 09:00 · 今日小结");
    assert_eq!(flushed["meta"]["surfacing"], "digest");
    assert_eq!(host.digests().pending(&entry.workspace_id), 0);

    let after = host
        .directory()
        .read_interactions(&entry.workspace_id, 50, None)
        .unwrap();
    assert!(
        after
            .messages
            .iter()
            .any(|m| m["id"] == flushed["id"] && m["kind"] == "agent_reply")
    );
}

#[tokio::test]
async fn confirm_session_result_and_worktree_handoff_merge_and_discard() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    git_cmd(ws.path(), &["init"]);
    git_cmd(ws.path(), &["config", "user.name", "Peer Test"]);
    git_cmd(ws.path(), &["config", "user.email", "peer@test.local"]);
    fs::write(ws.path().join("README.md"), "# Demo\n").unwrap();
    git_cmd(ws.path(), &["add", "README.md"]);
    git_cmd(ws.path(), &["commit", "-m", "initial commit"]);

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, mut profile) = host.bind_workspace(ws.path(), Some("GitBot")).unwrap();
    profile.acceptance_policy = Some("confirm".into());
    host.profiles().save(profile.clone()).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    host.submit_user_input(&entry.workspace_id, "in-wt-1", "Create feature A", None)
        .unwrap();
    host.submit_user_input(&entry.workspace_id, "in-wt-2", "Create feature B", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    host.inputs()
        .mark_executed(
            &entry.workspace_id,
            &["in-wt-1".into(), "in-wt-2".into()],
            &[],
            true,
        )
        .unwrap();

    let spawn_worktree_session = |input_id: &str, title: &str, file: &str, token: &str| {
        host.supervisor()
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: entry.workspace_id.clone(),
                    workspace_path: ws.path().to_path_buf(),
                    parent_conversation_id: conv_id.clone(),
                    anchor_message_ids: vec![input_message_id(input_id).unwrap()],
                    input_id: input_id.to_owned(),
                    surface: "tui".into(),
                    title: title.into(),
                    brief: format!("Write {file}"),
                    kind: "code".into(),
                    read_only: false,
                    required_capabilities: vec!["local.file.write".into()],
                    success_criteria: vec![SpawnCriterion {
                        id: Some(format!("c-{input_id}")),
                        kind: "file-contains".into(),
                        description: format!("{file} contains {token}"),
                        command: None,
                        path: Some(file.into()),
                        expect: Some(token.into()),
                    }],
                    priority: "normal".into(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "worktree".into(),
                    worker_model_selection: json!({}),
                },
                true,
            )
            .unwrap()
    };

    let s1 = spawn_worktree_session("in-wt-1", "Feature A", "feat_a.txt", "alpha");
    let s2 = spawn_worktree_session("in-wt-2", "Feature B", "feat_b.txt", "beta");

    let server = start_mock_server(vec![
        // Worker 1
        Box::new(|_| {
            sse_tool_call(
                "wt1-w",
                "write_file",
                &json!({"path": "feat_a.txt", "content": "alpha\n"}),
            )
        }),
        Box::new(|_| sse_text("Wrote feat_a.txt")),
        // Worker 2
        Box::new(|_| {
            sse_tool_call(
                "wt2-w",
                "write_file",
                &json!({"path": "feat_b.txt", "content": "beta\n"}),
            )
        }),
        Box::new(|_| sse_text("Wrote feat_b.txt")),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;

    // Both worktree-isolated sessions are promoted together by the scheduler.
    let p1 = host
        .supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();
    assert_eq!(p1.start, vec![s1.session_id.clone(), s2.session_id.clone()]);
    host.supervisor()
        .run_session_episode(
            &entry.workspace_id,
            &s1.session_id,
            &model,
            &mut perm,
            8,
            &cancel,
            true,
        )
        .await
        .unwrap();

    host.supervisor()
        .run_session_episode(
            &entry.workspace_id,
            &s2.session_id,
            &model,
            &mut perm,
            8,
            &cancel,
            true,
        )
        .await
        .unwrap();

    let sessions = host.supervisor().list_sessions(&entry.workspace_id);
    let sum1 = sessions
        .iter()
        .find(|s| s.session_id == s1.session_id)
        .unwrap();
    let sum2 = sessions
        .iter()
        .find(|s| s.session_id == s2.session_id)
        .unwrap();
    assert_eq!(sum1.status, "result_ready");
    assert!(!sum1.accepted);
    assert_eq!(sum2.status, "result_ready");
    assert!(!sum2.accepted);

    let bot_sessions = host.supervisor().list_bot_sessions(&entry.workspace_id);
    assert_eq!(
        bot_sessions
            .iter()
            .find(|s| s.session_id == s1.session_id)
            .unwrap()
            .result_confirmation_required,
        Some(true)
    );
    assert_eq!(
        bot_sessions
            .iter()
            .find(|s| s.session_id == s2.session_id)
            .unwrap()
            .result_confirmation_required,
        Some(true)
    );
    let bots_snap = bot_list_json(&host);
    assert!(bots_snap.as_array().is_some_and(|a| !a.is_empty()));

    let wt1 = sum1
        .worktree_path
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap();
    git_cmd(&wt1, &["add", "feat_a.txt"]);
    git_cmd(&wt1, &["commit", "-m", "feat a"]);

    let wt2 = sum2
        .worktree_path
        .as_deref()
        .map(std::path::PathBuf::from)
        .unwrap();
    git_cmd(&wt2, &["add", "feat_b.txt"]);
    git_cmd(&wt2, &["commit", "-m", "feat b"]);

    let d1 = host
        .confirm_session_result(&entry.workspace_id, &s1.session_id, Some("passed"))
        .unwrap();
    assert_eq!(d1.accepted_by.as_deref(), Some("user"));
    let h1 = host
        .handoff_session_worktree(&entry.workspace_id, &s1.session_id, true)
        .unwrap();
    assert_eq!(h1["status"], "delivered");
    assert_eq!(
        fs::read_to_string(ws.path().join("feat_a.txt")).unwrap(),
        "alpha\n"
    );

    let d2 = host
        .confirm_session_result(&entry.workspace_id, &s2.session_id, Some("passed"))
        .unwrap();
    assert_eq!(d2.accepted_by.as_deref(), Some("user"));
    let h2 = host
        .handoff_session_worktree(&entry.workspace_id, &s2.session_id, false)
        .unwrap();
    assert_eq!(h2["status"], "discarded");
    assert!(!ws.path().join("feat_b.txt").exists());

    let updated = host.supervisor().list_sessions(&entry.workspace_id);
    assert_eq!(
        updated
            .iter()
            .find(|s| s.session_id == s1.session_id)
            .unwrap()
            .handoff_status
            .as_deref(),
        Some("delivered")
    );
    assert_eq!(
        updated
            .iter()
            .find(|s| s.session_id == s2.session_id)
            .unwrap()
            .handoff_status
            .as_deref(),
        Some("discarded")
    );
    host.close();
}
