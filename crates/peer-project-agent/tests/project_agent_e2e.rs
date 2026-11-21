use peer_project_agent::{
    CircuitBreakerStore, CreateObjectiveRequest, LeaseStatus, MemoryEpisode, MemoryFilter,
    NativeProjectHost, ObjectiveBudget, ProjectCapabilityProvider, PublishInteractiveRequest,
    QuestionState, RECOVERY_PHASES, STALL_WINDOW_MS, SessionSupervisor, SpawnCriterion,
    SpawnSessionRequest, TurnEndKind, TurnExecutionState, WriteCuratedMemoryRequest,
    WriteMemoryRequest, assess_same_cause, assess_stall, bot_list_json,
    build_cleanup_expected_digest, host_resource_plan_from_plan, input_message_id,
    load_local_image_attachment, normalize_user_upload, objective_action_card_id,
    project_reply_questions, read_retry_continuity, reconcile_unknown_outcome,
    task_result_references,
};
use peer_protocol::interactive_result::{
    InteractiveAvailability, InteractiveOwner, InteractiveResultReference, InteractiveResultSource,
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
use peer_store::{ApprovalState, EvidenceIndexStore, ExecutionResourceStore, ResourceReservation};
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

#[tokio::test]
async fn working_context_notes_handoff_and_work_history_redaction_via_coordination_v2() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host
        .bind_workspace(ws.path(), Some("ContinuityBot"))
        .unwrap();

    host.submit_user_input(
        &entry.workspace_id,
        "in-wc-1",
        "Check release checklist and deploy token sk-secret9876543210abcdef",
        None,
    )
    .unwrap();

    let server = start_mock_server(vec![
        // 1. Verify Phase-3 tools projected & write initial note (rev 0 -> 1)
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            for required in [
                "read_work_notes",
                "write_work_note",
                "search_work_history",
                "prepare_context_handoff",
                "send_agent_message",
                "coordinate_work",
                "memory_remember",
            ] {
                assert!(
                    tools.iter().any(|t| t == required),
                    "expected projected tool {required}"
                );
            }
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "project_agent must never project {forbidden}"
                );
            }
            sse_tool_call(
                "wc-1",
                "write_work_note",
                &json!({
                    "name": "release-checklist",
                    "text": "Step 1 verified",
                    "expectedRevision": 0,
                    "sourceRefs": ["input-in-wc-1"]
                }),
            )
        }),
        // 2. Verify rev 1 & test stale expectedRevision conflict (rev 0)
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("write_work_note output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["note"]["revision"], 1);
            sse_tool_call(
                "wc-2",
                "write_work_note",
                &json!({
                    "name": "release-checklist",
                    "text": "Stale conflict attempt",
                    "expectedRevision": 0
                }),
            )
        }),
        // 3. Verify conflict rejected, update cleanly with expectedRevision: 1 -> rev 2
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("stale write_work_note error");
            assert_eq!(out["ok"], false);
            sse_tool_call(
                "wc-3",
                "write_work_note",
                &json!({
                    "name": "release-checklist",
                    "text": "Step 1 & 2 verified",
                    "expectedRevision": 1
                }),
            )
        }),
        // 4. Verify rev 2, then read_work_notes
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("write_work_note rev 2 output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["note"]["revision"], 2);
            sse_tool_call("wc-4", "read_work_notes", &json!({ "limit": 10 }))
        }),
        // 5. Verify read_work_notes returns rev 2 note, then prepare_context_handoff
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("read_work_notes output");
            assert_eq!(out["ok"], true);
            let notes = out["notes"].as_array().expect("notes array");
            assert!(
                notes
                    .iter()
                    .any(|n| n["name"] == "release-checklist" && n["revision"] == 2),
                "expected release-checklist rev 2 in {notes:?}"
            );
            sse_tool_call(
                "wc-5",
                "prepare_context_handoff",
                &json!({ "hint": "Continue release checklist after compaction" }),
            )
        }),
        // 6. Verify handoff window persisted, then search_work_history with secret redaction
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("prepare_context_handoff output");
            assert_eq!(out["ok"], true);
            assert!(
                out["window"]["windowId"]
                    .as_str()
                    .is_some_and(|s| !s.is_empty()),
                "expected non-empty windowId in {out}"
            );
            sse_tool_call(
                "wc-6",
                "search_work_history",
                &json!({ "query": "deploy token" }),
            )
        }),
        // 7. Verify secret is redacted, then attempt memory_remember with forbidden runtime field
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("search_work_history output");
            assert_eq!(out["ok"], true);
            let matches = out["matches"].as_array().expect("matches array");
            assert!(!matches.is_empty());
            assert_eq!(matches[0]["redacted"], true);
            assert_eq!(matches[0]["text"], "[sensitive history content omitted]");
            sse_tool_call(
                "wc-7",
                "memory_remember",
                &json!({
                    "kind": "fact",
                    "text": "Should reject caller trust override",
                    "trust": "verified"
                }),
            )
        }),
        // 8. Verify runtime field injection rejected, then valid memory_remember preference
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("rejected memory_remember output");
            assert_eq!(out["ok"], false);
            sse_tool_call(
                "wc-8",
                "memory_remember",
                &json!({
                    "kind": "preference",
                    "text": "Always keep checklists concise"
                }),
            )
        }),
        // 9. Verify preference saved with scope=user, trust=stated, then reply
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("valid memory_remember output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["item"]["scope"], "user");
            assert_eq!(out["item"]["trust"], "stated");
            sse_tool_call(
                "wc-9",
                "post_reply",
                &json!({
                    "replyTo": ["in-wc-1"],
                    "text": "Checklist note, handoff window, and preference stored."
                }),
            )
        }),
        // 10. Turn 2: assert L7_CONTINUITY project-agent.working-context carries note & handoff hint
        Box::new(|req| {
            let sys_text: String = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "system")
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                sys_text.contains("release-checklist")
                    && sys_text.contains("Step 1 & 2 verified")
                    && sys_text.contains("Continue release checklist after compaction"),
                "expected L7 working-context section in system prompt:\n{sys_text}"
            );
            sse_tool_call(
                "wc-10",
                "post_reply",
                &json!({
                    "replyTo": ["in-wc-2"],
                    "text": "Resumed with working context intact."
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick1 = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick1.bot_turns_run, 1);

    let coord_state = host.coordination().read_state(&entry.workspace_id).unwrap();
    assert!(!coord_state["works"].as_object().unwrap().is_empty());
    assert!(!coord_state["workNotes"].as_object().unwrap().is_empty());
    assert!(
        !coord_state["contextWindows"]
            .as_object()
            .unwrap()
            .is_empty()
    );

    host.submit_user_input(&entry.workspace_id, "in-wc-2", "Continue next steps", None)
        .unwrap();
    let tick2 = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick2.bot_turns_run, 1);
    host.close();
}

#[tokio::test]
async fn work_session_profile_enforces_read_only_ceiling_and_independent_verifier_evaluates_model_review()
 {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "peer phase 3\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("VerifierBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let conv_id = profile.agent_conversation_id.unwrap();
    host.submit_user_input(&entry.workspace_id, "in-ver-1", "Review readme.md", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    let anchor = input_message_id("in-ver-1").unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor],
                input_id: "in-ver-1".into(),
                surface: "tui".into(),
                title: "Read readme cleanly".into(),
                brief: "Read readme.md and confirm contents without mutating files.".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec![
                    "local.file.read".into(),
                    "local.file.write".into(),
                    "local.shell.exec".into(),
                ],
                success_criteria: vec![
                    SpawnCriterion {
                        id: Some("c-file".into()),
                        kind: "file-exists".into(),
                        command: None,
                        path: Some("readme.md".into()),
                        expect: None,
                        description: "readme.md exists".into(),
                    },
                    SpawnCriterion {
                        id: Some("c-review".into()),
                        kind: "model_review".into(),
                        command: None,
                        path: None,
                        expect: None,
                        description: "Verify readme mentions phase 3".into(),
                    },
                ],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".into(),
                worker_model_selection: json!({
                    "providerId": "openai",
                    "modelId": "gpt-5.2"
                }),
            },
            true,
        )
        .unwrap();

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .unwrap();
    let worker_prof = peer_project_agent::resolve_work_session_profile(
        &plan,
        "worker",
        peer_protocol::LocalAccessLevel::SessionLocal,
    )
    .expect("work session profile");
    assert!(worker_prof.allowlist.iter().any(|c| c == "local.file.read"));
    assert!(
        !worker_prof
            .allowlist
            .iter()
            .any(|c| c == "local.file.write")
    );
    assert!(
        !worker_prof
            .allowlist
            .iter()
            .any(|c| c == "local.shell.exec")
    );

    let promoted = host
        .supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();
    assert_eq!(promoted.start, vec![spawned.session_id.clone()]);

    let worker_server = start_mock_server(vec![
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            assert!(tools.iter().any(|t| t == "read_file"));
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "read-only worker must not project {forbidden}"
                );
            }
            sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))
        }),
        Box::new(|_| sse_text("Read readme.md and confirmed phase 3.")),
    ]);

    let verifier_server = start_mock_server(vec![
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            assert!(tools.iter().any(|t| t == "read_file"));
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "independent verifier must never project {forbidden}"
                );
            }
            sse_tool_call("v-read", "read_file", &json!({ "path": "readme.md" }))
        }),
        Box::new(|req| {
            let user_text: String = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "user")
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            let marker = "Known Worker Evidence Refs: ";
            let line = user_text
                .lines()
                .find(|l| l.starts_with(marker))
                .expect("Known Worker Evidence Refs line in verifier prompt");
            let known: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            assert!(!known.is_empty(), "expected worker evidence refs");
            let report = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": [],
                "risks": [],
                "evidenceRefs": [known[0]],
                "summary": "Independent review passed.",
            });
            sse_text(&serde_json::to_string(&report).unwrap())
        }),
    ]);

    let worker_model = NativeModel::new(
        ModelConfig {
            endpoint: worker_server.endpoint.clone(),
            model: "gpt-5.2".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(10),
    )
    .unwrap();
    let verifier_model = NativeModel::new(
        ModelConfig {
            endpoint: verifier_server.endpoint.clone(),
            model: "claude-sonnet-4-6".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(10),
    )
    .unwrap();

    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let ep = host
        .run_promoted_session(
            &entry.workspace_id,
            &spawned.session_id,
            &worker_model,
            Some(&verifier_model),
            &mut perm,
            8,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(ep.status, "completed");

    let detail = host
        .supervisor()
        .read_verification_detail(&entry.workspace_id, &spawned.session_id)
        .unwrap();
    assert_eq!(detail["verifierModel"], "claude-sonnet-4-6");
    assert_eq!(detail["sameFamilyAsWorker"], false);
    assert_eq!(detail["verificationReport"]["passed"], true);
    assert_eq!(detail["verdict"]["independentVerifier"], "passed");
    let reviews = detail["modelReviews"]
        .as_array()
        .expect("modelReviews array");
    assert_eq!(reviews.len(), 1);
    assert_eq!(reviews[0]["criterionId"], "c-review");
    assert_eq!(reviews[0]["passed"], true);
    assert_eq!(reviews[0]["sameFamilyAsWorker"], false);
    assert_eq!(detail["verdict"]["outcome"], "passed");
    host.close();
}

#[tokio::test]
async fn send_agent_message_and_coordinate_work_query_and_control_through_coordination_v2() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("Cargo.toml"), "[package]\nname = \"demo\"\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host.bind_workspace(ws.path(), Some("CoordBot")).unwrap();

    host.submit_user_input(
        &entry.workspace_id,
        "in-coord-1",
        "Inspect workspace and adjust child task scope",
        None,
    )
    .unwrap();
    let anchor = input_message_id("in-coord-1").unwrap();

    let captured_sid: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sid_writer = Arc::clone(&captured_sid);

    let server = start_mock_server(vec![
        // 1. spawn_session
        Box::new(move |_| {
            sse_tool_call(
                "coord-1",
                "spawn_session",
                &json!({
                    "anchorMessageIds": [anchor],
                    "title": "Inspect Cargo files",
                    "brief": "Read project manifests",
                    "kind": "research",
                    "readOnly": true,
                    "requiredCapabilities": ["local.file.list", "local.file.read"],
                    "isolation": "none",
                    "successCriteria": [{
                        "id": "c-cargo",
                        "kind": "file-exists",
                        "path": "Cargo.toml",
                        "description": "Cargo.toml exists"
                    }]
                }),
            )
        }),
        // 2. send_agent_message (mailbox_only)
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req).expect("spawned sessionId");
            *sid_writer.lock().unwrap() = Some(sid.clone());
            sse_tool_call(
                "coord-2",
                "send_agent_message",
                &json!({
                    "sessionId": sid,
                    "purpose": "update",
                    "text": "Focus on Cargo.toml only",
                    "delivery": "mailbox_only"
                }),
            )
        }),
        // 3. coordinate_work query
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("send_agent_message output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["delivery"], "mailbox_only");
            let sid = out["sessionId"].as_str().unwrap().to_owned();
            sse_tool_call(
                "coord-3",
                "coordinate_work",
                &json!({
                    "action": "query",
                    "sessionId": sid,
                    "reason": "check mandate"
                }),
            )
        }),
        // 4. coordinate_work augment (rev 0 -> 1)
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("coordinate_work query output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["goalRevision"], 0);
            let sid = out["session"]["sessionId"].as_str().unwrap().to_owned();
            sse_tool_call(
                "coord-4",
                "coordinate_work",
                &json!({
                    "action": "augment",
                    "sessionId": sid,
                    "reason": "add scope",
                    "expectedRevision": 0,
                    "text": "Also check lib.rs"
                }),
            )
        }),
        // 5. coordinate_work cancel (rev 1 -> 2)
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("coordinate_work augment output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["goalRevision"], 1);
            let sid = out["session"]["sessionId"].as_str().unwrap().to_owned();
            sse_tool_call(
                "coord-5",
                "coordinate_work",
                &json!({
                    "action": "cancel",
                    "sessionId": sid,
                    "reason": "stop now",
                    "expectedRevision": 1
                }),
            )
        }),
        // 6. post_reply
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("coordinate_work cancel output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["goalRevision"], 2);
            assert_eq!(out["session"]["status"], "cancelled");
            sse_tool_call(
                "coord-6",
                "post_reply",
                &json!({
                    "replyTo": ["in-coord-1"],
                    "text": "Sent update and closed coordinated work."
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let fg = host
        .tick_foreground(&entry.workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg.bot_turns_run, 1);

    let sid = captured_sid.lock().unwrap().clone().expect("captured sid");
    let coord_state = host.coordination().read_state(&entry.workspace_id).unwrap();
    assert!(
        coord_state["agentMessages"]
            .as_object()
            .unwrap()
            .values()
            .any(|m| m["text"] == "Focus on Cargo.toml only"),
        "expected durable agentMessage in coordination state: {coord_state}"
    );
    assert!(
        coord_state["mandates"]
            .as_object()
            .unwrap()
            .values()
            .any(|m| m["goalRevision"] == 2),
        "expected goalRevision=2 mandate in coordination state: {coord_state}"
    );

    let child_conv = host
        .conversations()
        .read_committed(&sid, None, 1024 * 1024)
        .unwrap();
    assert!(
        child_conv
            .history
            .messages
            .iter()
            .any(|m| m["kind"] == "agent_message" && m["content"] == "Focus on Cargo.toml only"),
        "expected agent_message record appended into child conversation"
    );
    host.close();
}

#[tokio::test]
async fn user_input_preempts_pending_wake_events_and_foreground_tick_never_blocks_on_workers() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("hello.txt"), "hello\n").unwrap();
    let host = Arc::new(NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap());
    let (entry, _) = host.bind_workspace(ws.path(), Some("PreemptBot")).unwrap();

    // Part A: tick_foreground promotes queued session without running/blocking on worker model calls.
    host.submit_user_input(&entry.workspace_id, "in-fg-1", "Check hello.txt", None)
        .unwrap();
    let anchor1 = input_message_id("in-fg-1").unwrap();
    let server1 = start_mock_server(vec![
        Box::new(move |_| {
            sse_tool_call(
                "fg-spawn",
                "spawn_session",
                &json!({
                    "anchorMessageIds": [anchor1],
                    "title": "Read hello",
                    "brief": "Read hello.txt",
                    "kind": "research",
                    "readOnly": true,
                    "requiredCapabilities": ["local.file.list"],
                    "isolation": "none",
                    "successCriteria": [{
                        "id": "c-hello",
                        "kind": "file-exists",
                        "path": "hello.txt",
                        "description": "hello.txt exists"
                    }]
                }),
            )
        }),
        Box::new(|req| {
            let sid = extract_spawned_session_id(req).unwrap();
            sse_tool_call(
                "fg-wait",
                "wait_for_sessions",
                &json!({ "sessionIds": [sid] }),
            )
        }),
    ]);

    let model1 = mock_model(&server1.endpoint);
    let cancel = CancellationToken::new();
    let fg1 = host
        .tick_foreground(&entry.workspace_id, &model1, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg1.bot_turns_run, 1);
    assert_eq!(fg1.promoted_session_ids.len(), 1);
    assert_eq!(fg1.wake_turns_run, 0);

    let promoted_sid = fg1.promoted_session_ids[0].clone();
    let sessions = host.supervisor().list_sessions(&entry.workspace_id);
    assert_eq!(
        sessions
            .iter()
            .find(|s| s.session_id == promoted_sid)
            .unwrap()
            .status,
        "running"
    );

    // Part B: fresh user input submitted mid-turn preempts pending wake events until queue drains.
    host.inbox()
        .append(
            &entry.workspace_id,
            &[json!({
                "eventId": "ev-preempt-1",
                "kind": "session_completed",
                "workspaceId": entry.workspace_id,
                "sessionId": promoted_sid,
                "at": "2026-11-20T12:00:00Z",
                "payload": { "summary": "background session update" }
            })],
        )
        .unwrap();
    assert!(host.inbox().has_pending(&entry.workspace_id));

    host.submit_user_input(&entry.workspace_id, "in-fg-2", "First user turn", None)
        .unwrap();
    let host_cb = Arc::clone(&host);
    let ws_id_cb = entry.workspace_id.clone();

    let server2 = start_mock_server(vec![
        // 1. Turn for in-fg-2 submits in-fg-3 mid-flight so wake must wait
        Box::new(move |_| {
            host_cb
                .submit_user_input(&ws_id_cb, "in-fg-3", "Follow-up mid-turn", None)
                .unwrap();
            sse_tool_call(
                "fg-r2",
                "post_reply",
                &json!({
                    "replyTo": ["in-fg-2"],
                    "text": "Answered first input while in-fg-3 waits."
                }),
            )
        }),
        // 2. Turn for in-fg-3 runs before pending wake
        Box::new(|req| {
            let sys_or_user: String = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                sys_or_user.contains("Follow-up mid-turn"),
                "expected in-fg-3 user turn before wake turn"
            );
            sse_tool_call(
                "fg-r3",
                "post_reply",
                &json!({
                    "replyTo": ["in-fg-3"],
                    "text": "Answered follow-up before wake."
                }),
            )
        }),
        // 3. Deferred wake turn drains only once user input queue is empty
        Box::new(|_| {
            sse_tool_call(
                "fg-wake",
                "post_reply",
                &json!({
                    "replyTo": ["in-fg-3"],
                    "surfacing": "silent",
                    "text": "Wake processed after user queue cleared."
                }),
            )
        }),
    ]);

    let model2 = mock_model(&server2.endpoint);
    let fg2 = host
        .tick_foreground(&entry.workspace_id, &model2, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg2.bot_turns_run, 1);
    assert_eq!(fg2.wake_turns_run, 0);
    assert!(host.inbox().has_pending(&entry.workspace_id));
    assert!(host.inputs().has_pending(&entry.workspace_id));

    let fg3 = host
        .tick_foreground(&entry.workspace_id, &model2, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg3.bot_turns_run, 1);
    assert_eq!(fg3.wake_turns_run, 1);
    assert!(!host.inbox().has_pending(&entry.workspace_id));
    host.close();
}

#[tokio::test]
async fn coordination_v2_state_survives_host_restart_and_lease_handoff() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host_a = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host_a
        .bind_workspace(ws.path(), Some("RestartBot"))
        .unwrap();

    host_a
        .submit_user_input(
            &entry.workspace_id,
            "in-restart-1",
            "Write durable architecture note before restart",
            None,
        )
        .unwrap();

    let server_a = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "ra-1",
                "write_work_note",
                &json!({
                    "name": "arch-note",
                    "text": "Initial design note",
                    "expectedRevision": 0
                }),
            )
        }),
        Box::new(|_| {
            sse_tool_call(
                "ra-2",
                "prepare_context_handoff",
                &json!({ "hint": "Persist across host restart" }),
            )
        }),
        Box::new(|_| {
            sse_tool_call(
                "ra-3",
                "post_reply",
                &json!({
                    "replyTo": ["in-restart-1"],
                    "text": "Persisted note and handoff window before restart."
                }),
            )
        }),
    ]);

    let model_a = mock_model(&server_a.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    host_a
        .tick(&entry.workspace_id, &model_a, json!({}), &mut perm, &cancel)
        .await
        .unwrap();

    let state_a = host_a
        .coordination()
        .read_state(&entry.workspace_id)
        .unwrap();
    assert!(!state_a["workNotes"].as_object().unwrap().is_empty());
    assert!(!state_a["contextWindows"].as_object().unwrap().is_empty());

    host_a.release_lease(&entry.workspace_id).unwrap();
    host_a.close();

    // Cold-start brand-new host_b against same home directory
    let host_b = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    assert!(matches!(
        host_b.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let state_b = host_b
        .coordination()
        .read_state(&entry.workspace_id)
        .unwrap();
    assert_eq!(state_b["workNotes"], state_a["workNotes"]);
    assert_eq!(state_b["contextWindows"], state_a["contextWindows"]);

    host_b
        .submit_user_input(
            &entry.workspace_id,
            "in-restart-2",
            "Read and advance note after restart",
            None,
        )
        .unwrap();

    let server_b = start_mock_server(vec![
        Box::new(|req| {
            let sys_text: String = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "system")
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                sys_text.contains("arch-note") && sys_text.contains("Persist across host restart"),
                "expected pre-restart note and handoff in host_b system prompt:\n{sys_text}"
            );
            sse_tool_call("rb-1", "read_work_notes", &json!({}))
        }),
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("read_work_notes output");
            assert_eq!(out["ok"], true);
            let notes = out["notes"].as_array().unwrap();
            assert!(
                notes
                    .iter()
                    .any(|n| n["name"] == "arch-note" && n["revision"] == 1)
            );
            sse_tool_call(
                "rb-2",
                "write_work_note",
                &json!({
                    "name": "arch-note",
                    "text": "Updated after restart",
                    "expectedRevision": 1
                }),
            )
        }),
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("updated write_work_note output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["note"]["revision"], 2);
            sse_tool_call(
                "rb-3",
                "post_reply",
                &json!({
                    "replyTo": ["in-restart-2"],
                    "text": "Updated arch-note to rev 2 after host restart."
                }),
            )
        }),
    ]);

    let model_b = mock_model(&server_b.endpoint);
    host_b
        .tick(&entry.workspace_id, &model_b, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    host_b.close();
}

#[tokio::test]
async fn watchdog_detects_running_and_result_ready_stalls_and_stops_auto_retry_on_same_cause_limit()
{
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, _profile) = host
        .bind_workspace(ws.path(), Some("Watchdog Bot"))
        .unwrap();
    let publisher = host.watch_publisher();

    // 1. Running session past STALL_WINDOW_MS emits stall:run:... once and deduplicates repeat calls.
    let plan_running = json!({
        "planId": "plan-wd-1",
        "status": "executing",
        "createdAt": "2026-11-20T10:00:00.000Z",
        "updatedAt": "2026-11-20T10:00:00.000Z",
        "tasks": [{"taskId": "task-wd-1", "status": "pending"}],
        "delegationOrigin": {
            "workspaceId": entry.workspace_id,
            "sessionId": "sess-wd-1",
            "phase": "running"
        }
    });
    let ev1 = publisher.publish(
        &entry.workspace_id,
        std::slice::from_ref(&plan_running),
        "2026-11-20T10:12:00.000Z",
        None,
    );
    assert_eq!(ev1.len(), 1);
    assert_eq!(ev1[0]["kind"], "stalled");
    assert_eq!(ev1[0]["payload"]["anchor"], "2026-11-20T10:00:00.000Z");
    assert_eq!(
        ev1[0]["payload"]["stallId"].as_str(),
        Some("stall:sess-wd-1:2026-11-20T10:00:00.000Z")
    );
    let ev1_dup = publisher.publish(
        &entry.workspace_id,
        &[plan_running],
        "2026-11-20T10:14:00.000Z",
        None,
    );
    assert!(ev1_dup.is_empty(), "same stall anchor must deduplicate");

    // 2. Waiting on user approval suppresses stall detection.
    let plan_waiting = json!({
        "planId": "plan-wd-2",
        "status": "paused",
        "createdAt": "2026-11-20T10:00:00.000Z",
        "updatedAt": "2026-11-20T10:00:00.000Z",
        "tasks": [{"taskId": "task-wd-2", "status": "pending"}],
        "delegationOrigin": {
            "workspaceId": entry.workspace_id,
            "sessionId": "sess-wd-2",
            "phase": "awaiting_approval",
            "planApprovalId": "appr-1"
        }
    });
    let mut waiting_facts = peer_project_agent::watch_facts_from_plan(&plan_waiting).unwrap();
    assert_eq!(waiting_facts.status, "waiting_user");
    let waiting_assess = assess_stall(&waiting_facts, i64::MAX / 2, STALL_WINDOW_MS);
    assert!(!waiting_assess.stalled);
    waiting_facts.status = "running".into();
    let running_wait_assess = assess_stall(&waiting_facts, i64::MAX / 2, STALL_WINDOW_MS);
    assert!(!running_wait_assess.stalled);
    assert!(running_wait_assess.waiting);

    // 3. result_ready past STALL_WINDOW_MS emits both result_ready and verification_pending stall.
    let plan_verify = json!({
        "planId": "plan-wd-1",
        "status": "completed",
        "createdAt": "2026-11-20T10:00:00.000Z",
        "updatedAt": "2026-11-20T10:00:00.000Z",
        "completedAt": "2026-11-20T10:00:00.000Z",
        "tasks": [{"taskId": "task-wd-1", "status": "completed"}],
        "delegationOrigin": {
            "workspaceId": entry.workspace_id,
            "sessionId": "sess-wd-1",
            "phase": "result_ready",
            "resultRevision": "rev-1",
            "verdict": { "outcome": "pass", "evidenceRefs": ["ev-1"] }
        }
    });
    let ev_verify = publisher.publish(
        &entry.workspace_id,
        &[plan_verify],
        "2026-11-20T10:16:00.000Z",
        None,
    );
    assert!(ev_verify.iter().any(|e| e["kind"] == "result_ready"));
    assert!(ev_verify.iter().any(|e| {
        e["kind"] == "stalled"
            && e["payload"]["stallId"] == "stall:verify:sess-wd-1:2026-11-20T10:00:00.000Z"
            && e["payload"]["anchor"] == "verification_pending"
    }));

    // 4. Three matching same-cause failures stop auto-retry and ask the user.
    let plan_failed = json!({
        "planId": "plan-wd-1",
        "status": "failed",
        "createdAt": "2026-11-20T10:00:00.000Z",
        "updatedAt": "2026-11-20T10:18:00.000Z",
        "tasks": [{"taskId": "task-wd-1", "status": "failed"}],
        "failureLog": [
            {"taskId": "task-wd-1", "cause": "ECONNRESET: read error"},
            {"taskId": "task-wd-1", "cause": "econnreset during stream"}
        ],
        "runner": {
            "currentTaskId": "task-wd-1",
            "lastError": "ECONNRESET: socket hang up"
        },
        "delegationOrigin": {
            "workspaceId": entry.workspace_id,
            "sessionId": "sess-wd-1",
            "phase": "failed"
        }
    });
    let fail_facts = peer_project_agent::watch_facts_from_plan(&plan_failed).unwrap();
    let same_assess = assess_same_cause(&fail_facts, None);
    assert_eq!(same_assess.count, 3);
    assert!(same_assess.ask_user);
    assert!(same_assess.stop_auto_retry);

    let ev_fail = publisher.publish(
        &entry.workspace_id,
        &[plan_failed],
        "2026-11-20T10:18:00.000Z",
        None,
    );
    assert!(ev_fail.iter().any(|e| {
        e["kind"] == "failed"
            && e["payload"]["sameCauseCount"] == 3
            && e["payload"]["stopAutoRetry"] == true
            && e["payload"]["askUser"] == true
    }));
    host.close();
}

#[tokio::test]
async fn execution_obligation_inspect_authorize_confirm_resolve_and_unknown_outcome_reconciliation()
{
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let git_init = std::process::Command::new("git")
        .args(["init"])
        .current_dir(ws.path())
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .unwrap();
    assert!(git_init.status.success());
    let cancel = CancellationToken::new();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, profile) = host
        .bind_workspace(ws.path(), Some("Obligation Bot"))
        .unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    // Run 7-phase barrier before creating the synthetic protected claim so subsequent turns
    // do not re-run suspend_live on this claim.
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    host.recover_workspace_barrier(&entry.workspace_id, &cancel)
        .await
        .unwrap();

    let anchor_setup = input_message_id("in-obl-setup").unwrap();
    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor_setup],
                input_id: "in-obl-setup".into(),
                surface: "tui".into(),
                title: "Uncertain external write".into(),
                brief: "Write artifact with unknown dispatch".into(),
                kind: "other".into(),
                read_only: false,
                required_capabilities: vec!["local.file.write".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c-obl-1".into()),
                    kind: "file-exists".into(),
                    description: "Verify artifact exists".into(),
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
        .control_session(
            &entry.workspace_id,
            &spawned.session_id,
            "cancel",
            "stop",
            true,
        )
        .unwrap();
    let setup_batch = host
        .inbox()
        .take_batch(&entry.workspace_id, i64::MAX / 2, true);
    host.inbox()
        .commit_batch(&entry.workspace_id, setup_batch.through_seq, true)
        .unwrap();

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .unwrap();
    let host_plan = host_resource_plan_from_plan(&plan).unwrap();
    let mut rstore = ExecutionResourceStore::initialize(home.path(), None).unwrap();
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
    let recon = reconcile_unknown_outcome(home.path(), &plan, &claim_id, Some(&work))
        .await
        .unwrap();
    assert_eq!(recon["ok"], true);
    assert_eq!(recon["evidence"]["verdict"], "no_effect_observed");

    host.submit_user_input(
        &entry.workspace_id,
        "in-obl-1",
        "Inspect unsettled obligation and request authorization",
        None,
    )
    .unwrap();

    let sid_turn1 = spawned.session_id.clone();
    let sid_auth = spawned.session_id.clone();
    let sid_res = spawned.session_id.clone();
    let observed_grant: Arc<Mutex<Option<(String, String, String)>>> = Arc::new(Mutex::new(None));
    let observed_grant_capture = Arc::clone(&observed_grant);
    let observed_grant_use = Arc::clone(&observed_grant);

    let server = start_mock_server(vec![
        // Turn 1, round 1: inspect_execution_obligation
        Box::new(move |req| {
            let tools = tool_names_from_request(req);
            assert!(tools.iter().any(|t| t == "inspect_execution_obligation"));
            assert!(
                tools
                    .iter()
                    .any(|t| t == "request_obligation_authorization")
            );
            assert!(tools.iter().any(|t| t == "resolve_execution_obligation"));
            sse_tool_call(
                "obl-1",
                "inspect_execution_obligation",
                &json!({ "sessionIds": [sid_turn1] }),
            )
        }),
        // Turn 1, round 2: request_obligation_authorization
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("inspect output");
            assert_eq!(out["ok"], true);
            let row = &out["items"][0];
            let obl_id = row["obligationId"].as_str().unwrap().to_owned();
            let op_id = row["operationId"].as_str().unwrap().to_owned();
            let ev_rev = row["evidenceRevision"].as_str().unwrap().to_owned();
            sse_tool_call(
                "obl-2",
                "request_obligation_authorization",
                &json!({
                    "items": [{
                        "obligationId": obl_id,
                        "sessionId": sid_auth,
                        "operationId": op_id,
                        "evidenceRevision": ev_rev,
                        "actions": ["retire_follow_up", "acknowledge_unknown"]
                    }]
                }),
            )
        }),
        // Turn 1, round 3: capture grantId & opId and post reply
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("authorize output");
            assert_eq!(out["ok"], true);
            let grant_id = out["grantId"].as_str().unwrap().to_owned();
            let op_id = out["items"][0]["operationId"]
                .as_str()
                .unwrap_or("op-1")
                .to_owned();
            *observed_grant_capture.lock().unwrap() = Some((
                grant_id.clone(),
                op_id,
                "idem-e2e-resolve-key-123456".to_owned(),
            ));
            sse_tool_call(
                "obl-3",
                "post_reply",
                &json!({
                    "replyTo": ["in-obl-1"],
                    "text": format!("Authorization requested ({grant_id}). Confirm to settle.")
                }),
            )
        }),
        // Turn 2 (wake from obligation_grant_confirmed), round 1: resolve_execution_obligation
        Box::new(move |_req| {
            let (grant_id, op_id, idem_key) = observed_grant_use.lock().unwrap().clone().unwrap();
            sse_tool_call(
                "obl-4",
                "resolve_execution_obligation",
                &json!({
                    "grantId": grant_id,
                    "idempotencyKey": idem_key,
                    "items": [{
                        "sessionId": sid_res,
                        "operationId": op_id,
                        "actions": ["retire_follow_up", "acknowledge_unknown"]
                    }]
                }),
            )
        }),
        // Turn 2, round 2: assert applied & complete wake turn
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("resolve output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["items"][0]["result"], "applied");
            assert_eq!(out["items"][0]["disposition"], "indexed");
            sse_text("Execution obligation settled.")
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let fg1 = host
        .tick_foreground(&entry.workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg1.inputs_consumed, 1);
    assert_eq!(fg1.wake_turns_run, 0);

    let (grant_id, op_id, idem_key) = observed_grant.lock().unwrap().clone().unwrap();
    let pending = host.pending_obligation_grants(&entry.workspace_id);
    assert!(pending.iter().any(|g| g["grantId"] == grant_id));

    let confirmed = host
        .confirm_obligation_grant(&entry.workspace_id, &grant_id, true)
        .unwrap();
    assert_eq!(confirmed["ok"], true);
    let recent_inbox = host.inbox().list_recent(&entry.workspace_id, 20);
    assert!(
        recent_inbox
            .iter()
            .any(|e| { e["kind"] == "obligation_grant_confirmed" && e["grantId"] == grant_id })
    );

    // Wake turn resolves the confirmed grant via resolve_execution_obligation tool.
    let fg2 = host
        .tick_foreground(&entry.workspace_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg2.wake_turns_run, 1);

    // Direct idempotent replay with the same key & items returns replayed == true.
    let conv = host
        .profiles()
        .read(&entry.workspace_id)
        .unwrap()
        .agent_conversation_id
        .unwrap();
    let replay = host
        .obligation_service()
        .resolve(
            &entry.workspace_id,
            &conv,
            &grant_id,
            &idem_key,
            &[json!({
                "sessionId": spawned.session_id,
                "operationId": op_id,
                "actions": ["retire_follow_up", "acknowledge_unknown"]
            })],
            "call-obl-replay",
        )
        .await
        .unwrap();
    assert_eq!(replay["replayed"], true);
    host.close();
}

#[tokio::test]
async fn seven_phase_project_recovery_barrier_persists_recovery_json_and_re_runs_after_lease_drop()
{
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;

    let host_a = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, _profile) = host_a
        .bind_workspace(ws.path(), Some("Recovery Bot"))
        .unwrap();
    assert!(
        !host_a
            .recovery()
            .is_ready(&entry.workspace_id, host_a.holds_lease(&entry.workspace_id))
    );

    host_a
        .submit_user_input(&entry.workspace_id, "in-rec-1", "Check readiness", None)
        .unwrap();
    let server = start_mock_server(vec![Box::new(|_req| {
        sse_tool_call(
            "rec-1",
            "post_reply",
            &json!({ "replyTo": ["in-rec-1"], "text": "Recovery complete and ready." }),
        )
    })]);
    let model = mock_model(&server.endpoint);
    host_a
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();

    assert!(
        host_a
            .recovery()
            .is_ready(&entry.workspace_id, host_a.holds_lease(&entry.workspace_id))
    );
    let rec_file = host_a
        .recovery()
        .diagnostic_file(&entry.workspace_id)
        .unwrap();
    assert!(rec_file.is_file(), "recovery.json must be persisted");
    let rec_json: Value = serde_json::from_str(&fs::read_to_string(&rec_file).unwrap()).unwrap();
    assert_eq!(rec_json["status"], "ready");
    assert_eq!(rec_json["phase"], *RECOVERY_PHASES.last().unwrap());

    // Dropping the workspace lease clears in-memory readiness so a subsequent host must re-run
    // while retaining the last recovery diagnostic artifact.
    host_a.release_lease(&entry.workspace_id).unwrap();
    assert!(
        !host_a
            .recovery()
            .is_ready(&entry.workspace_id, host_a.holds_lease(&entry.workspace_id))
    );
    assert!(host_a.recovery().status(&entry.workspace_id).is_some());

    let host_b = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    assert!(matches!(
        host_b.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    assert!(
        !host_b
            .recovery()
            .is_ready(&entry.workspace_id, host_b.holds_lease(&entry.workspace_id))
    );
    let diag = host_b
        .recover_workspace_barrier(&entry.workspace_id, &cancel)
        .await
        .unwrap();
    assert_eq!(diag.status, "ready");
    assert_eq!(diag.phase, "digest");
    assert!(
        host_b
            .recovery()
            .is_ready(&entry.workspace_id, host_b.holds_lease(&entry.workspace_id))
    );
    host_b.close();
}

#[tokio::test]
async fn memory_curator_episode_admission_three_episode_preference_and_file_anchor_maintenance() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::create_dir_all(ws.path().join("src")).unwrap();
    fs::write(ws.path().join("src/db.rs"), b"pub const POOL: u32 = 16;\n").unwrap();

    let cancel = CancellationToken::new();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("Memory Bot")).unwrap();
    let ws_id = entry.workspace_id.clone();

    let timestamps = [
        "2026-11-20T09:10:00.000Z",
        "2026-11-20T09:30:00.000Z",
        "2026-11-20T09:50:00.000Z",
    ];
    for (idx, ts) in timestamps.iter().enumerate() {
        let ep = MemoryEpisode {
            id: format!("ep-mem-{}", idx + 1),
            workspace_id: ws_id.clone(),
            anchor_message_id: format!("msg-mem-{}", idx + 1),
            dispositions: vec![],
            summary: format!("Database pool review #{}", idx + 1),
            opened_at: (*ts).to_owned(),
            closed_at: (*ts).to_owned(),
            trigger: "task_events".into(),
            session_ids: vec![],
            evidence_refs: vec![format!("ev-ep-{}", idx + 1)],
            evidence_texts: std::collections::BTreeMap::from([(
                format!("ev-ep-{}", idx + 1),
                "Connection pool defaults to 16 in src/db.rs".to_owned(),
            )]),
            texts: vec![format!("Checked src/db.rs POOL=16 round {}", idx + 1)],
            untrusted: false,
            fingerprint: format!("fp-mem-{}", idx + 1),
            extracted: false,
        };
        host.memory_curator()
            .episodes()
            .append_episode(&ep)
            .unwrap();
    }

    let ep1_body = json!({
        "candidates": [
            {
                "kind": "preference",
                "trust": "inferred",
                "text": "Always summarize failing assertions first"
            },
            {
                "kind": "fact",
                "trust": "verified",
                "text": "Connection pool defaults to 16 in src/db.rs",
                "evidenceRefs": ["ev-ep-1"],
                "filePaths": ["src/db.rs"]
            },
            {
                "kind": "fact",
                "trust": "verified",
                "text": "Use token sk-live-secret1234567890abcdef in src/db.rs",
                "evidenceRefs": ["ev-ep-1"],
                "filePaths": ["src/db.rs"]
            }
        ]
    })
    .to_string();
    let ep2_body = json!({
        "candidates": [{
            "kind": "preference",
            "trust": "inferred",
            "text": "Always summarize failing assertions first"
        }]
    })
    .to_string();
    let ep3_body = ep2_body.clone();

    let server = start_mock_server(vec![
        Box::new(move |_req| sse_text(&ep1_body)),
        Box::new(move |_req| sse_text(&ep2_body)),
        Box::new(move |_req| sse_text(&ep3_body)),
    ]);
    let model = mock_model(&server.endpoint);

    // Episode 1: inferred preference is not active yet; secret candidate is rejected;
    // verified fact with file anchor is stored.
    let out1 = host
        .memory_curator()
        .extract_due_with_model(&ws_id, ws.path(), timestamps[0], true, &model, &cancel)
        .await
        .unwrap();
    assert!(!out1.learned_ids.is_empty());
    let active_prefs_after_1 = host.memory().list(&MemoryFilter {
        scope: Some("user"),
        workspace_id: None,
        kind: Some("preference"),
        status: Some("active"),
    });
    assert!(active_prefs_after_1.is_empty());
    assert!(
        host.memory()
            .search(Some(&ws_id), "sk-live", 10)
            .unwrap()
            .is_empty()
    );
    let anchored_fact = host
        .memory()
        .search(Some(&ws_id), "Connection pool defaults", 10)
        .unwrap();
    assert_eq!(anchored_fact.len(), 1);
    assert!(
        anchored_fact[0]
            .file_anchors
            .as_ref()
            .is_some_and(|a| !a.is_empty())
    );
    let fact_id = anchored_fact[0].id.clone();

    // Episode 2: still below 3-episode threshold.
    let _out2 = host
        .memory_curator()
        .extract_due_with_model(&ws_id, ws.path(), timestamps[1], true, &model, &cancel)
        .await
        .unwrap();
    assert!(
        host.memory()
            .list(&MemoryFilter {
                scope: Some("user"),
                workspace_id: None,
                kind: Some("preference"),
                status: Some("active"),
            })
            .is_empty()
    );

    // Episode 3 via host.run_background_maintenance: activates user preference at count 3.
    let maint_rep = host
        .run_background_maintenance(&ws_id, timestamps[2], Some(&model), &cancel)
        .await
        .unwrap();
    assert!(!maint_rep.curator_learned_ids.is_empty());
    let active_prefs_after_3 = host.memory().list(&MemoryFilter {
        scope: Some("user"),
        workspace_id: None,
        kind: Some("preference"),
        status: Some("active"),
    });
    assert_eq!(active_prefs_after_3.len(), 1);
    assert_eq!(active_prefs_after_3[0].confirmed_count, 3);

    // Write an expired memory and mutate src/db.rs, then run next-day daily maintenance.
    let exp_item = host
        .memory()
        .write_curated(&WriteCuratedMemoryRequest {
            scope: "project",
            workspace_id: Some(&ws_id),
            kind: "fact",
            text: "Temporary migration flag active",
            trust: "verified",
            source_refs: vec!["ev-exp".into()],
            confirmed_count: 1,
            pinned: false,
            anchor_message_id: None,
            expires_at: Some("2026-11-20T08:00:00.000Z"),
            topic_key: None,
            topic_value: None,
            file_anchors: None,
        })
        .unwrap();
    fs::write(ws.path().join("src/db.rs"), b"pub const POOL: u32 = 32;\n").unwrap();

    let day2_maint = host
        .memory_maintenance()
        .run_due(&ws_id, ws.path(), "2026-11-21T09:05:00.000Z", "09:00")
        .unwrap();
    assert!(day2_maint.skipped.is_none());
    assert!(day2_maint.changed_ids.contains(&fact_id));
    assert!(day2_maint.changed_ids.contains(&exp_item.id));

    let refreshed_fact = host.memory().get(Some(&ws_id), &fact_id).unwrap();
    assert_eq!(refreshed_fact.needs_reverify, Some(true));
    assert_eq!(
        refreshed_fact.maintenance_reason.as_deref(),
        Some("file_changed")
    );
    let expired = host.memory().get(Some(&ws_id), &exp_item.id).unwrap();
    assert_eq!(expired.status, "expired");
    host.close();
}

#[tokio::test]
async fn objective_watch_runner_reconciles_deterministic_and_agent_probes_and_proposal_card_spawns_session()
 {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("config.toml"), b"port = 8080\n").unwrap();

    let cancel = CancellationToken::new();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(2)).unwrap();
    let (entry, profile) = host
        .bind_workspace(ws.path(), Some("Objective Bot"))
        .unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();

    // Run initial barrier cleanly before setting up watches.
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    host.recover_workspace_barrier(&ws_id, &cancel)
        .await
        .unwrap();

    let origin_msg_id = input_message_id("in-obj-origin").unwrap();
    let (obj, _) = host
        .objectives()
        .create(&CreateObjectiveRequest {
            workspace_id: &ws_id,
            project_agent_conversation_id: &conv_id,
            origin_message_id: &origin_msg_id,
            title: "Monitor config.toml",
            outcome: "Keep runtime config healthy",
            autonomy: "propose",
            created_by: "user_request",
            watches: vec![
                json!({
                    "watchId": "watch-file",
                    "kind": "schedule",
                    "schedule": { "everySeconds": 60 },
                    "probe": {
                        "type": "deterministic",
                        "check": "file_hash",
                        "spec": { "path": "config.toml" }
                    }
                }),
                json!({
                    "watchId": "watch-agent",
                    "kind": "schedule",
                    "schedule": { "everySeconds": 60 },
                    "probe": {
                        "type": "agent",
                        "question": "Summarize health of config.toml"
                    }
                }),
            ],
            milestones: vec![],
            success_signals: vec![],
            budget: Some(ObjectiveBudget::default()),
            deadline: None,
            request_id: Some("req-obj-e2e-1"),
        })
        .unwrap();

    let probe_reply = json!({
        "digest": "cfg-healthy-v1",
        "summary": "config.toml healthy",
        "severity": "notable",
        "succeeded": true,
        "value": "healthy"
    })
    .to_string();

    let captured_action: Arc<Mutex<Option<(String, String)>>> = Arc::new(Mutex::new(None));
    let captured_action_write = Arc::clone(&captured_action);
    let obj_id_for_tool = obj.objective_id.clone();

    let server = start_mock_server(vec![
        // 1. Agent probe turn inside run_background_maintenance
        Box::new(move |_req| sse_text(&probe_reply)),
        // 2. Wake turn reacting to objective_signal inbox event -> propose_objective_action
        Box::new(move |req| {
            let sys_text: String = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|m| m["role"] == "system")
                .filter_map(|m| m["content"].as_str())
                .collect::<Vec<_>>()
                .join("\n");
            assert!(
                sys_text.contains("objective_signal"),
                "expected objective_signal in wake context:\n{sys_text}"
            );
            let event_id = "obj-sig-e2e-1";
            sse_tool_call(
                "obj-prop-1",
                "propose_objective_action",
                &json!({
                    "objectiveId": obj_id_for_tool,
                    "eventIds": [event_id],
                    "task": {
                        "title": "Inspect config drift",
                        "brief": "Read config.toml details",
                        "kind": "research",
                        "readOnly": true,
                        "requiredCapabilities": ["local.file.read"],
                        "successCriteria": [{
                            "id": "c-obj-1",
                            "kind": "file-exists",
                            "description": "Confirm config.toml exists",
                            "path": "config.toml"
                        }]
                    }
                }),
            )
        }),
        // 3. Verify proposal mode + cardId and finish wake turn
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("propose_objective_action output");
            assert_eq!(out["ok"], true);
            assert_eq!(out["mode"], "proposal");
            let action_id = out["actionId"].as_str().unwrap().to_owned();
            let card_id = out["cardId"].as_str().unwrap().to_owned();
            assert_eq!(card_id, objective_action_card_id(&action_id));
            *captured_action_write.lock().unwrap() = Some((action_id, card_id));
            sse_text("Created objective action proposal card.")
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let rep = host
        .run_background_maintenance(&ws_id, "2026-11-20T10:00:00.000Z", Some(&model), &cancel)
        .await
        .unwrap();
    assert_eq!(rep.watch_observations, 2);
    assert!(rep.watch_signals >= 1);

    // Watch cursor persisted & interval gating skips probes 20s later (< 60s).
    let file_cursor = host
        .watches()
        .read_cursor(&ws_id, &obj.objective_id, "watch-file");
    assert_eq!(
        file_cursor.last_scheduled_at.as_deref(),
        Some("2026-11-20T10:00:00.000Z")
    );
    let gated = host
        .watches()
        .reconcile_workspace(
            &ws_id,
            ws.path(),
            "2026-11-20T10:00:20.000Z",
            60_000,
            Some(&model),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(gated.observations_recorded, 0);

    // Confirm inbox recorded objective_signal events and run wake turn to propose an action card.
    let signals: Vec<Value> = host
        .inbox()
        .list_recent(&ws_id, 20)
        .into_iter()
        .filter(|e| e["kind"] == "objective_signal")
        .collect();
    assert!(!signals.is_empty());

    let fg = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg.wake_turns_run, 1);

    let (action_id, _card_id) = captured_action.lock().unwrap().clone().unwrap();
    let pending = host.objective_actions().pending(&ws_id);
    assert!(pending.iter().any(|a| a.action_id == action_id));

    let decided = host
        .decide_objective_proposal(&ws_id, &action_id, true)
        .unwrap();
    let sid = decided
        .session_id
        .expect("approving proposal must spawn delegated session");
    let spawned_plan = host
        .supervisor()
        .find_plan_by_session(&ws_id, &sid)
        .unwrap();
    assert_eq!(
        spawned_plan["delegationOrigin"]["objectiveId"].as_str(),
        Some(obj.objective_id.as_str())
    );
    host.close();
}

#[tokio::test]
async fn interactive_result_capture_publish_reconcile_inspect_tool_and_cleanup_tombstone() {
    let data_dir = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host
        .bind_workspace(ws.path(), Some("InteractiveBot"))
        .unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.unwrap();
    let cancel = CancellationToken::new();

    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let owner = InteractiveOwner {
        workspace_id: ws_id.clone(),
        conversation_id: conv_id.clone(),
    };

    // 1. Capture tool observation with secret redaction
    let obs = host
        .interactive_results()
        .capture_tool_observation(
            &owner,
            &conv_id,
            "call-obs-1",
            &json!({"secret": "sk-live-secret1234567890abcdef", "safe": "ok"}),
            "D2_sensitive",
            "2026-11-20T10:00:00.000Z",
        )
        .unwrap();
    assert_eq!(obs["redacted"], true);
    let expected_ver = obs["source"]["expectedContentVersion"].as_str().unwrap();
    let mat = host
        .interactive_results()
        .read_material(&owner, &conv_id, "call-obs-1", expected_ver)
        .unwrap()
        .expect("captured material present");
    assert_eq!(mat["value"]["payload"]["secret"], "[REDACTED]");
    assert_eq!(mat["value"]["payload"]["safe"], "ok");

    // 2. Commit initial "create" publication -> starts as index_pending
    let pub1 = host
        .interactive_results()
        .commit_publication(
            &PublishInteractiveRequest {
                owner: owner.clone(),
                source: InteractiveResultSource {
                    conversation_id: conv_id.clone(),
                    plan_id: "plan-ir-e2e-1".into(),
                    session_id: conv_id.clone(),
                    tool_call_id: "call-pub-1".into(),
                    execution_epoch: Some("epoch-1".into()),
                },
                publication_kind: "create".into(),
                base: None,
                title: "Initial Interactive Chart".into(),
                text_fallback: "Row 1: metric = 10".into(),
                program: "root = Text(\"metric=10\")".into(),
                bindings: json!({"metric": 10}),
                provenance: vec![],
                data_level: "D2_sensitive".into(),
                grant_id: "grant-ir-1".into(),
                stream_id: None,
            },
            true,
        )
        .unwrap();
    assert_eq!(pub1["publicationStatus"], "index_pending");
    let ref1: InteractiveResultReference =
        serde_json::from_value(pub1["reference"].clone()).unwrap();
    let locator1 = ref1.locator();

    // Recovery barrier "tasks" phase reconciles pending publication into EvidenceIndexStore
    let diag = host
        .recover_workspace_barrier(&ws_id, &cancel)
        .await
        .unwrap();
    assert_eq!(diag.status, "ready");
    let op1 = host
        .interactive_results()
        .get_operation(&owner, &conv_id, "call-pub-1")
        .unwrap()
        .unwrap();
    assert_eq!(op1["publicationStatus"], "published");
    assert!(
        !EvidenceIndexStore::new(data_dir.path())
            .find(std::slice::from_ref(&locator1), None)
            .unwrap()
            .is_empty()
    );

    // 3. Commit "revise" publication and reconcile -> verify read_interactive_result_summary
    let pub2 = host
        .interactive_results()
        .commit_publication(
            &PublishInteractiveRequest {
                owner: owner.clone(),
                source: InteractiveResultSource {
                    conversation_id: conv_id.clone(),
                    plan_id: "plan-ir-e2e-1".into(),
                    session_id: conv_id.clone(),
                    tool_call_id: "call-pub-2".into(),
                    execution_epoch: Some("epoch-1".into()),
                },
                publication_kind: "revise".into(),
                base: Some(ref1.clone()),
                title: "Revised Interactive Chart".into(),
                text_fallback: "Row 1: metric = 42 (updated)".into(),
                program: "root = Text(\"metric=42\")".into(),
                bindings: json!({"metric": 42}),
                provenance: vec![],
                data_level: "D2_sensitive".into(),
                grant_id: "grant-ir-2".into(),
                stream_id: None,
            },
            true,
        )
        .unwrap();
    let ref2: InteractiveResultReference =
        serde_json::from_value(pub2["reference"].clone()).unwrap();
    let locator2 = ref2.locator();
    let reconciled2 = host
        .interactive_results()
        .reconcile_pending(&owner)
        .unwrap();
    assert_eq!(reconciled2.len(), 1);
    let summary = host
        .read_interactive_result_summary(&ws_id, &locator2)
        .unwrap();
    assert_eq!(summary.availability, InteractiveAvailability::Available);
    assert_eq!(summary.title, "Revised Interactive Chart");
    assert_eq!(summary.text_fallback.text, "Row 1: metric = 42 (updated)");

    // 4. Bot turn calling inspect_interactive_result (metadata -> text -> denied program -> post_reply)
    host.submit_user_input(
        &ws_id,
        "in-ir-1",
        "Inspect the revised interactive result",
        None,
    )
    .unwrap();
    let ref2_json = serde_json::to_value(&ref2).unwrap();
    let ref2_meta = ref2_json.clone();
    let ref2_text = ref2_json.clone();
    let ref2_prog = ref2_json.clone();
    let server = start_mock_server(vec![
        Box::new(move |_| {
            sse_tool_call(
                "ir-insp-1",
                "inspect_interactive_result",
                &json!({"target": {"kind": "result", "reference": ref2_meta}, "view": "metadata"}),
            )
        }),
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("metadata result");
            assert_eq!(out["kind"], "interactive_inspection");
            assert_eq!(out["title"], "Revised Interactive Chart");
            sse_tool_call(
                "ir-insp-2",
                "inspect_interactive_result",
                &json!({
                    "target": {"kind": "result", "reference": ref2_text},
                    "view": "text",
                    "offset": 0,
                    "limit": 200
                }),
            )
        }),
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("text result");
            assert!(
                out["text"]
                    .as_str()
                    .unwrap_or("")
                    .contains("metric = 42 (updated)")
            );
            sse_tool_call(
                "ir-insp-3",
                "inspect_interactive_result",
                &json!({"target": {"kind": "result", "reference": ref2_prog}, "view": "program"}),
            )
        }),
        Box::new(|req| {
            let err_out = last_tool_result_json(req).expect("program role denied output");
            assert_eq!(err_out["ok"], false);
            assert_eq!(err_out["error"], "interactive_role_denied");
            sse_tool_call(
                "ir-reply-1",
                "post_reply",
                &json!({
                    "replyTo": ["in-ir-1"],
                    "text": "Inspected metadata & fallback text; program view is blocked by role ceiling."
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let fg = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg.bot_turns_run, 1);
    assert!(
        host.find_reply_for_input(&ws_id, "in-ir-1")
            .unwrap()
            .is_some()
    );

    // 5. Cleanup commits tombstone -> availability flips to Cleaned
    let expected_digest = build_cleanup_expected_digest(&ref2, "cleanup-e2e").unwrap();
    let _receipt = host
        .interactive_results()
        .cleanup_result(
            &ref2,
            "req-clean-1",
            &expected_digest,
            "2026-11-20T10:05:00.000Z",
            true,
        )
        .unwrap();
    let cleaned = host
        .read_interactive_result_summary(&ws_id, &locator2)
        .unwrap();
    assert_eq!(cleaned.availability, InteractiveAvailability::Cleaned);
    host.close();
}

#[tokio::test]
async fn user_image_and_text_attachments_flow_through_input_queue_to_multimodal_model_request() {
    let data_dir = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("MediaBot")).unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.unwrap();
    let cancel = CancellationToken::new();

    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    // Write valid PNG signature + IHDR chunk (width=1, height=1, depth=8, color=2)
    let mut png_bytes = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    png_bytes.extend_from_slice(&13u32.to_be_bytes());
    png_bytes.extend_from_slice(b"IHDR");
    png_bytes.extend_from_slice(&1u32.to_be_bytes());
    png_bytes.extend_from_slice(&1u32.to_be_bytes());
    png_bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
    png_bytes.extend_from_slice(&[0u8; 4]);
    let png_path = ws.path().join("shot.png");
    fs::write(&png_path, &png_bytes).unwrap();

    let img_att = load_local_image_attachment(ws.path(), "shot.png", Some("att-img-1")).unwrap();
    let txt_att = normalize_user_upload(&json!({
        "id": "att-txt-1",
        "name": "notes.txt",
        "mimeType": "text/plain",
        "size": 19,
        "kind": "text",
        "text": "hello from txt file",
    }))
    .unwrap();

    let server = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "m-img-1",
                "post_reply",
                &json!({"replyTo": ["in-img-only"], "text": "Received PNG screenshot."}),
            )
        }),
        Box::new(|_| {
            sse_tool_call(
                "m-mix-1",
                "post_reply",
                &json!({"replyTo": ["in-mixed"], "text": "Analyzed text and PNG."}),
            )
        }),
    ]);
    let model = mock_model(&server.endpoint);

    // Input A: image-only with empty prompt ""
    host.submit_user_input_with_attachments(&ws_id, "in-img-only", "", None, vec![img_att.clone()])
        .unwrap();
    let fg1 = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg1.bot_turns_run, 1);

    // Input B: prompt + text attachment + PNG attachment
    host.submit_user_input_with_attachments(
        &ws_id,
        "in-mixed",
        "Analyze both",
        None,
        vec![txt_att, img_att],
    )
    .unwrap();
    let fg2 = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg2.bot_turns_run, 1);

    let reqs = server.requests.lock().unwrap();
    assert_eq!(reqs.len(), 2);

    // Verify request 0 carried multimodal image_url content part
    let user0 = reqs[0]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("user message in request 0");
    let parts0 = user0["content"]
        .as_array()
        .expect("image-only input must project content as array");
    assert!(parts0.iter().any(|p| {
        p["type"] == "image_url"
            && p["image_url"]["url"]
                .as_str()
                .is_some_and(|u| u.starts_with("data:image/png;base64,"))
    }));

    // Verify request 1 projected both formatted Attached file text block and image_url
    let user1 = reqs[1]["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .expect("latest user message in request 1");
    let parts1 = user1["content"]
        .as_array()
        .expect("mixed input must project multimodal content array");
    let has_text_block = parts1.iter().any(|p| {
        p["type"] == "text"
            && p["text"].as_str().is_some_and(|t| {
                t.contains("Analyze both")
                    && t.contains("Attached file: notes.txt")
                    && t.contains("hello from txt file")
            })
    });
    let has_img_block = parts1.iter().any(|p| {
        p["type"] == "image_url"
            && p["image_url"]["url"]
                .as_str()
                .is_some_and(|u| u.starts_with("data:image/png;base64,"))
    });
    assert!(has_text_block && has_img_block);

    // Verify ConversationStore persisted attachments on canonical user_input rows
    let committed = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let m_img = committed
        .iter()
        .find(|m| m["id"] == input_message_id("in-img-only").unwrap())
        .unwrap();
    assert_eq!(m_img["attachments"].as_array().map(Vec::len), Some(1));
    let m_mix = committed
        .iter()
        .find(|m| m["id"] == input_message_id("in-mixed").unwrap())
        .unwrap();
    assert_eq!(m_mix["attachments"].as_array().map(Vec::len), Some(2));

    drop(reqs);
    host.close();
}

#[tokio::test]
async fn conversation_search_index_fts5_trigram_chinese_and_redaction_with_memory_conflicts() {
    let data_dir = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("SearchBot")).unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.unwrap();
    let cancel = CancellationToken::new();

    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    // Seed visible messages: Chinese text + secret-bearing message
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "input-zh-1",
                "role": "user",
                "kind": "user_input",
                "content": "请检查支付网关的部署日志和超时配置",
                "createdAt": "2026-11-20T09:00:00.000Z"
            }),
            "2026-11-20T09:00:00.000Z",
            None,
        )
        .unwrap();
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "input-sec-1",
                "role": "user",
                "kind": "user_input",
                "content": "deploy token sk-live-secret1234567890abcdef for staging",
                "createdAt": "2026-11-20T09:01:00.000Z"
            }),
            "2026-11-20T09:01:00.000Z",
            None,
        )
        .unwrap();

    // Topic conflict & supersession resolution via MemoryStore
    let mem1 = host
        .memory()
        .write(&WriteMemoryRequest {
            scope: "project",
            workspace_id: Some(&ws_id),
            kind: "fact",
            text: "Repo uses npm",
            trust: "verified",
            source_refs: vec!["input-zh-1".into()],
            pinned: false,
            anchor_message_id: Some("input-zh-1"),
            expires_at: None,
            topic_key: Some("pkg_mgr"),
            topic_value: Some("npm"),
            file_anchors: None,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(10));
    let mem2 = host
        .memory()
        .write(&WriteMemoryRequest {
            scope: "project",
            workspace_id: Some(&ws_id),
            kind: "fact",
            text: "Switched repo to pnpm for 支付网关",
            trust: "stated",
            source_refs: vec!["input-zh-1".into()],
            pinned: false,
            anchor_message_id: Some("input-zh-1"),
            expires_at: None,
            topic_key: Some("pkg_mgr"),
            topic_value: Some("pnpm"),
            file_anchors: None,
        })
        .unwrap();
    let mem1_after = host.memory().get(Some(&ws_id), &mem1.id).unwrap();
    assert_eq!(mem1_after.status, "forgotten");
    assert_eq!(mem1_after.superseded_by.as_deref(), Some(mem2.id.as_str()));
    assert_eq!(mem2.status, "active");

    // Non-authoritative inferred user preference (confirmed_count >= 3) conflicts without superseding
    let upref1 = host
        .memory()
        .write(&WriteMemoryRequest {
            scope: "user",
            workspace_id: None,
            kind: "preference",
            text: "Prefer Neovim for editing",
            trust: "stated",
            source_refs: vec!["input-zh-1".into()],
            pinned: false,
            anchor_message_id: Some("input-zh-1"),
            expires_at: None,
            topic_key: Some("editor"),
            topic_value: Some("neovim"),
            file_anchors: None,
        })
        .unwrap();
    std::thread::sleep(Duration::from_millis(10));
    let upref2 = host
        .memory()
        .write_curated(&WriteCuratedMemoryRequest {
            scope: "user",
            workspace_id: None,
            kind: "preference",
            text: "Inferred preference for VS Code",
            trust: "inferred",
            source_refs: vec!["input-zh-1".into()],
            pinned: false,
            anchor_message_id: Some("input-zh-1"),
            expires_at: None,
            topic_key: Some("editor"),
            topic_value: Some("vscode"),
            file_anchors: None,
            confirmed_count: 3,
        })
        .unwrap();
    let upref1_conf = host.memory().get(None, &upref1.id).unwrap();
    assert_eq!(upref1_conf.status, "conflicted");
    assert_eq!(upref2.status, "conflicted");
    assert!(
        upref1_conf
            .conflicts_with
            .as_deref()
            .unwrap_or(&[])
            .contains(&upref2.id)
    );
    assert!(
        upref2
            .conflicts_with
            .as_deref()
            .unwrap_or(&[])
            .contains(&upref1.id)
    );

    // Host search_workspace (<3 CJK LIKE fallback + >=3 FTS5 trigram) & search_all
    let short_hits = host.search_workspace(&ws_id, "支付", 20).unwrap();
    assert!(
        short_hits
            .iter()
            .any(|h| h.kind == "message" && h.message_id.as_deref() == Some("input-zh-1"))
    );
    let fts_hits = host.search_workspace(&ws_id, "部署日志", 20).unwrap();
    assert!(
        fts_hits
            .iter()
            .any(|h| h.kind == "message" && h.message_id.as_deref() == Some("input-zh-1"))
    );
    assert!(
        data_dir
            .path()
            .join("project-runtime")
            .join(&ws_id)
            .join("search-index.sqlite")
            .exists()
    );
    let global_hits = host.search_all("支付", 20).unwrap();
    assert!(!global_hits.is_empty());

    // Bot turn calling search_conversation for Chinese query + secret query
    host.submit_user_input(
        &ws_id,
        "in-search-turn",
        "Search history for logs and token",
        None,
    )
    .unwrap();
    let server = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "srch-1",
                "search_conversation",
                &json!({"query": "部署日志"}),
            )
        }),
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("Chinese search output");
            assert_eq!(out["ok"], true);
            let matches = out["matches"].as_array().unwrap();
            assert!(matches.iter().any(|m| {
                m["redacted"] == false
                    && m["snippet"]
                        .as_str()
                        .is_some_and(|s| s.contains("部署日志"))
            }));
            sse_tool_call(
                "srch-2",
                "search_conversation",
                &json!({"query": "deploy token"}),
            )
        }),
        Box::new(|req| {
            let out = last_tool_result_json(req).expect("secret search output");
            assert_eq!(out["ok"], true);
            let matches = out["matches"].as_array().unwrap();
            let sec = matches
                .iter()
                .find(|m| m["id"] == "input-sec-1")
                .expect("secret match present");
            assert_eq!(sec["redacted"], true);
            assert_eq!(sec["snippet"], "[REDACTED]");
            sse_tool_call(
                "srch-reply",
                "post_reply",
                &json!({"replyTo": ["in-search-turn"], "text": "Verified FTS5 search and secret redaction."}),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let fg = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg.bot_turns_run, 1);
    host.close();
}

#[tokio::test]
async fn interactive_result_slash_result_lookup_from_task_evidence_refs() {
    let data_dir = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host
        .bind_workspace(ws.path(), Some("TaskResultBot"))
        .unwrap();
    let ws_id = entry.workspace_id;
    let conv_id = profile.agent_conversation_id.unwrap();
    let cancel = CancellationToken::new();

    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let diag = host
        .recover_workspace_barrier(&ws_id, &cancel)
        .await
        .unwrap();
    assert_eq!(diag.status, "ready");

    let summary = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![input_message_id("in-task-ir-1").unwrap()],
                input_id: "in-task-ir-1".into(),
                surface: "tui".into(),
                title: "Build Interactive Report".into(),
                brief: "Generate fixed interactive summary".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec!["local.interactive.publish".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c-ir-1".into()),
                    kind: "custom".into(),
                    description: "Publish fixed interactive result".into(),
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
    let sid = summary.session_id.clone();
    let mut plan = host
        .supervisor()
        .find_plan_by_session(&ws_id, &sid)
        .expect("spawned plan present");
    let plan_id = plan["planId"].as_str().unwrap().to_owned();

    let owner = InteractiveOwner {
        workspace_id: ws_id.clone(),
        conversation_id: conv_id.clone(),
    };
    let pub_res = host
        .interactive_results()
        .commit_publication(
            &PublishInteractiveRequest {
                owner: owner.clone(),
                source: InteractiveResultSource {
                    conversation_id: conv_id.clone(),
                    plan_id: plan_id.clone(),
                    session_id: sid.clone(),
                    tool_call_id: "call-task-pub-1".into(),
                    execution_epoch: Some("epoch-1".into()),
                },
                publication_kind: "create".into(),
                base: None,
                title: "Task Fixed View".into(),
                text_fallback: "Task output metric=99".into(),
                program: "root = Text(\"metric=99\")".into(),
                bindings: json!({"metric": 99}),
                provenance: vec![],
                data_level: "D1_internal".into(),
                grant_id: "grant-task-1".into(),
                stream_id: None,
            },
            true,
        )
        .unwrap();
    let ref_obj: InteractiveResultReference =
        serde_json::from_value(pub_res["reference"].clone()).unwrap();
    let locator = ref_obj.locator();
    host.interactive_results()
        .reconcile_pending(&owner)
        .unwrap();

    // Attach locator to the spawned plan's leaf task evidenceRefs so read_report indexes it
    let tasks = plan["tasks"].as_array_mut().expect("plan tasks array");
    assert!(!tasks.is_empty());
    tasks[0]["evidenceRefs"] = json!([locator]);
    let plan_path = data_dir
        .path()
        .join("goal-plans")
        .join(format!("{plan_id}.json"));
    fs::write(
        &plan_path,
        format!("{}\n", serde_json::to_string_pretty(&plan).unwrap()),
    )
    .unwrap();

    let report = host.supervisor().read_report(&ws_id, &sid).unwrap();
    let extracted = task_result_references(&report.evidence_refs);
    assert_eq!(extracted, vec![locator.clone()]);

    let task_ir = host.read_task_result(&ws_id, &sid, &locator).unwrap();
    assert_eq!(task_ir.availability, InteractiveAvailability::Available);
    assert_eq!(task_ir.title, "Task Fixed View");
    assert_eq!(task_ir.text_fallback.text, "Task output metric=99");

    // Scope isolation checks
    let wrong_session = host.read_task_result(&ws_id, "nonexistent-session", &locator);
    assert_eq!(wrong_session.unwrap_err().code, "interactive_scope_denied");
    let other_locator = format!(
        "interactive-result://{ws_id}/{conv_id}/other-id/{}",
        "0".repeat(64)
    );
    let wrong_locator = host.read_task_result(&ws_id, &sid, &other_locator);
    assert_eq!(wrong_locator.unwrap_err().code, "interactive_scope_denied");

    host.close();
}
