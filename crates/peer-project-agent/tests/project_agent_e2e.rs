use peer_project_agent::{
    CircuitBreakerStore, CreateObjectiveRequest, LeaseStatus, MemoryEpisode, MemoryFilter,
    NativeProjectHost, ObjectiveBudget, ProjectCapabilityProvider, PublishInteractiveRequest,
    QuestionState, RECOVERY_PHASES, ReadConversationOptions, STALL_WINDOW_MS, SessionSupervisor,
    SpawnCriterion, SpawnSessionRequest, ToolProjectionMode, TurnEndKind, TurnExecutionState,
    WriteCuratedMemoryRequest, WriteMemoryRequest, assess_same_cause, assess_stall, bot_list_json,
    build_cleanup_expected_digest, host_resource_plan_from_plan, hydrate_agent_turn_record,
    input_message_id, load_local_image_attachment, normalize_user_upload, objective_action_card_id,
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

    // Reproduce the desktop-wide startup sweep writing a stale row without a
    // decider before the next project host acquires the workspace.
    let mut stale = before;
    stale["state"] = json!("stale");
    stale["decidedAt"] = json!(peer_project_agent::now_iso());
    let mut approval_log = fs::OpenOptions::new()
        .append(true)
        .open(
            home.path()
                .join("project-runtime")
                .join(&entry.workspace_id)
                .join("approvals.jsonl"),
        )
        .unwrap();
    writeln!(approval_log, "{stale}").unwrap();
    drop(approval_log);

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

    // The stale audit row stays intact. Recovery binds a fresh open approval
    // to the same pending plan without starting its worker.
    let rows = host_b
        .approvals()
        .list(Some(&entry.workspace_id), None)
        .unwrap();
    let stale = rows
        .iter()
        .find(|a| a["approvalId"] == approval_id)
        .unwrap();
    assert_eq!(stale["state"], ApprovalState::Stale.as_str());
    let repaired = host_b.supervisor().read_plan(&spawned.plan_id).unwrap();
    let fresh_id = repaired["delegationOrigin"]["planApprovalId"]
        .as_str()
        .unwrap();
    assert_ne!(fresh_id, approval_id);
    assert_eq!(
        rows.iter().find(|a| a["approvalId"] == fresh_id).unwrap()["state"],
        ApprovalState::Open.as_str()
    );
    assert_eq!(repaired["status"], "awaiting_approval");
    let reply = host_b
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .unwrap();
    assert_eq!(reply["content"], "Recovered cleanly and ready.");
    host_b.close();
    let host_c = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    host_c.ensure_lease(&entry.workspace_id).unwrap();
    host_c
        .recover_workspace_barrier(&entry.workspace_id, &cancel)
        .await
        .unwrap();
    let retained = host_c.supervisor().read_plan(&spawned.plan_id).unwrap();
    assert_eq!(retained["delegationOrigin"]["planApprovalId"], fresh_id);
    assert_eq!(
        host_c
            .approvals()
            .list(Some(&entry.workspace_id), None)
            .unwrap()
            .len(),
        2
    );
    let denied = host_c
        .supervisor()
        .decide_plan_approval(&entry.workspace_id, fresh_id, false, true)
        .unwrap();
    assert_eq!(denied.status, "cancelled");
    let denied = host_c.supervisor().read_plan(&spawned.plan_id).unwrap();
    assert_eq!(denied["approval"]["decision"], "denied");
    assert_eq!(
        denied["delegationOrigin"]["cancellation"]["phase"],
        "completed"
    );
    host_c.close();
}

#[tokio::test]
async fn memory_and_objective_tools_through_governed_provider_with_chinese_fts_and_evidence() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    // Explicitly test Full projection mode compatibility (including legacy memory_write).
    host.set_tool_projection_mode(ToolProjectionMode::Full);
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
    assert_eq!(turn_rec["traceRef"].as_str(), Some(turn_id.as_str()));
    assert!(
        turn_rec.get("rounds").is_none(),
        "compact agent_turn stub in JSONL must offload rounds to sidecar file"
    );
    assert!(
        turn_rec.get("publicUpdates").is_none(),
        "compact agent_turn stub in JSONL must offload publicUpdates to sidecar file"
    );
    assert!(turn_rec["meta"]["diagnosticTiming"]["startedAt"].is_string());
    assert!(turn_rec["meta"]["diagnosticTiming"]["finishedAt"].is_string());

    let trace_file = home
        .path()
        .join("project-runtime")
        .join(&entry.workspace_id)
        .join("turns")
        .join(format!("{turn_id}.json"));
    assert!(
        trace_file.is_file(),
        "offloaded agent_turn trace file must exist at {}",
        trace_file.display()
    );

    let dir_read = host.directory().read_conversation(
        &entry.workspace_id,
        &ReadConversationOptions {
            kinds: Some(vec!["agent_turn".into()]),
            ..Default::default()
        },
    );
    let hydrated = dir_read["messages"]
        .as_array()
        .and_then(|arr| arr.iter().find(|m| m["id"] == turn_id))
        .expect("hydrated agent_turn from directory");
    assert!(hydrated["rounds"].as_array().is_some_and(|r| {
        r.iter().any(|round| {
            round["text"]
                .as_str()
                .unwrap_or("")
                .contains("Preparing reply")
        })
    }));
    // Dual-channel isolation: companion scratchpad emitted alongside a tool call stays in
    // diagnostic `rounds` and must not leak into user-facing `publicUpdates`.
    assert!(
        hydrated["publicUpdates"]
            .as_array()
            .is_some_and(|u| u.is_empty()),
        "tool-round scratchpad text must stay out of publicUpdates; got {:?}",
        hydrated["publicUpdates"]
    );

    let mut manual_hydrated = turn_rec.clone();
    hydrate_agent_turn_record(home.path(), &entry.workspace_id, &mut manual_hydrated);
    assert!(
        manual_hydrated["rounds"]
            .as_array()
            .is_some_and(|r| !r.is_empty())
    );
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
        // 0. Activate objectives skill pack on demand (blank workspace starts in Progressive mode)
        Box::new(|_| {
            sse_tool_call(
                "obj-0",
                "activate_skill_pack",
                &json!({ "packs": ["objectives"] }),
            )
        }),
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
        // 0. Activate continuity, coordination, and memory skill packs on demand
        Box::new(|req| {
            let initial_tools = tool_names_from_request(req);
            assert!(initial_tools.iter().any(|t| t == "activate_skill_pack"));
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !initial_tools.iter().any(|t| t == forbidden),
                    "project_agent must never project {forbidden}"
                );
            }
            sse_tool_call(
                "wc-0",
                "activate_skill_pack",
                &json!({ "packs": ["continuity", "coordination", "memory"] }),
            )
        }),
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
        // 1.5. Activate coordination skill pack before send_agent_message / coordinate_work
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req).expect("spawned sessionId");
            *sid_writer.lock().unwrap() = Some(sid);
            sse_tool_call(
                "coord-1b",
                "activate_skill_pack",
                &json!({ "packs": ["coordination"] }),
            )
        }),
        // 2. send_agent_message (mailbox_only)
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req).expect("spawned sessionId");
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
                "ra-0",
                "activate_skill_pack",
                &json!({ "packs": ["continuity"] }),
            )
        }),
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

#[tokio::test]
async fn fallback_reply_store_failure_reports_failed_and_preserves_pending_input_cursor() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("FailSafeBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let cancel = CancellationToken::new();
    let input_id = "in-persist-fail";
    host.submit_user_input(&ws_id, input_id, "Reply cleanly", None)
        .unwrap();

    let index_path = home.path().join("conversations/index.jsonl");
    let conv_id_clone = conv_id.clone();
    let server = start_mock_server(vec![Box::new(move |_req| {
        // Sabotage index.jsonl messageCount after consume() wrote the user input so
        // persist_fallback_reply fails with StoreError::CommitUncertain on commit.
        let mut rows: Vec<Value> = fs::read_to_string(&index_path)
            .unwrap()
            .lines()
            .filter(|l| !l.trim().is_empty())
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let row = rows.iter_mut().find(|r| r["id"] == conv_id_clone).unwrap();
        row["messageCount"] = json!(999);
        let edited: String = rows.iter().map(|r| format!("{r}\n")).collect();
        fs::write(&index_path, edited).unwrap();
        sse_text("Fallback reply that cannot be persisted")
    })]);

    let model = mock_model(&server.endpoint);
    let report = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(report.inputs_consumed, 1);
    assert_eq!(report.bot_turns_run, 1);
    assert!(
        matches!(
            report.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::Failed { code }) if code == "STORE_COMMIT_UNCERTAIN"
        ),
        "expected Failed(STORE_COMMIT_UNCERTAIN), got {:?}",
        report.last_turn
    );

    let cursor_path = home
        .path()
        .join(format!("project-runtime/{ws_id}/input-cursor.json"));
    let cursor: Value = serde_json::from_slice(&fs::read(&cursor_path).unwrap()).unwrap();
    assert_eq!(cursor["inputId"], input_id);
    assert!(cursor.get("executedInputId").is_none_or(Value::is_null));
    assert!(
        !cursor["completedInputIds"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|v| v == input_id)
    );

    host.close();
}

#[tokio::test]
async fn synthesis_after_max_rounds_instructs_no_tools_and_recovers_from_dsml_leak() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Test repo\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("SynthBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let cancel = CancellationToken::new();
    let input_id = "in-synth-dsml-1";
    host.submit_user_input(&ws_id, input_id, "Inspect repository", None)
        .unwrap();

    let mut handlers: Vec<ScriptHandler> = (0..14)
        .map(|idx| {
            Box::new(move |req: &Value| {
                if idx == 13 {
                    let sys_text = req["messages"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|m| m["role"] == "system")
                        .filter_map(|m| m["content"].as_str())
                        .collect::<Vec<_>>()
                        .join("\n");
                    assert!(
                        sys_text.contains("FINAL TOOL ROUND NOTICE"),
                        "final tool round must receive FINAL TOOL ROUND NOTICE: {sys_text}"
                    );
                }
                sse_tool_call(
                    &format!("tc-synth-{idx}"),
                    "list_files",
                    &json!({"path": "."}),
                )
            }) as ScriptHandler
        })
        .collect();
    // Request 15: Synthesis attempt 1 sees disabled tools + explicit synthesis prompt, simulates DeepSeek DSML leak.
    handlers.push(Box::new(|req| {
        assert!(
            req.get("tools")
                .and_then(Value::as_array)
                .is_none_or(Vec::is_empty),
            "synthesis request must not advertise tools: {:?}",
            req.get("tools")
        );
        let msgs = req["messages"].as_array().expect("messages array");
        let sys_text = msgs
            .iter()
            .filter(|m| m["role"] == "system")
            .filter_map(|m| m["content"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            sys_text.contains("FINAL SYNTHESIS OVERRIDE"),
            "synthesis system prompt override missing: {sys_text}"
        );
        assert!(
            sys_text.contains("Do NOT mention internal tool names"),
            "synthesis system prompt must prohibit leaking internal tool names: {sys_text}"
        );
        let last_user = msgs
            .iter()
            .rev()
            .find(|m| m["role"] == "user")
            .and_then(|m| m["content"].as_str())
            .unwrap_or("");
        assert!(
            last_user.contains("tools are disabled"),
            "synthesis prompt must tell model tools are disabled: {last_user}"
        );
        sse_text(
            "\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"read_file\">\n<｜DSML｜ parameter name=\"path\" string=\"true\">README.md</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>",
        )
    }));
    // Request 16: Synthesis attempt 2 must use flattened plain-text history (zero tool/tool_calls entries).
    handlers.push(Box::new(|req| {
        let msgs = req["messages"].as_array().expect("messages array");
        assert!(
            !msgs.iter().any(|m| m["role"] == "tool"),
            "flattened synthesis retry must strip role=tool messages"
        );
        assert!(
            !msgs.iter().any(|m| m
                .get("tool_calls")
                .and_then(Value::as_array)
                .is_some_and(|a| !a.is_empty())),
            "flattened synthesis retry must strip assistant tool_calls"
        );
        let flattened_obs = msgs
            .iter()
            .filter(|m| m["role"] == "user")
            .filter_map(|m| m["content"].as_str())
            .any(|c| c.contains("[Tool execution observations") && c.contains("list_files"));
        assert!(
            flattened_obs,
            "flattened synthesis retry must preserve compact tool observations"
        );
        sse_text("已查看工作区根目录（README.md），已达到单轮工具上限。")
    }));

    let server = start_mock_server(handlers);
    let model = mock_model(&server.endpoint);
    let report = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(report.bot_turns_run, 1);
    assert_eq!(server.requests.lock().unwrap().len(), 16);
    assert!(matches!(
        report.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    let reply = host
        .find_reply_for_input(&ws_id, input_id)
        .unwrap()
        .expect("clean reply persisted");
    assert_eq!(
        reply["content"],
        "已查看工作区根目录（README.md），已达到单轮工具上限。"
    );

    let store = peer_store::ConversationStore::new(home.path());
    let snap = store.read_committed(&conv_id, None, 1024 * 1024).unwrap();
    assert!(
        snap.history
            .messages
            .iter()
            .filter(|m| m["kind"] == "agent_reply")
            .all(|m| !m["content"].as_str().unwrap_or("").contains("<｜DSML｜")),
        "no persisted agent_reply may contain raw DSML markup"
    );

    host.close();
}

#[tokio::test]
async fn main_loop_retries_and_rejects_persistent_dsml_protocol_leak() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _) = host
        .bind_workspace(ws.path(), Some("LeakGuardBot"))
        .unwrap();
    let ws_id = entry.workspace_id.clone();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let cancel = CancellationToken::new();
    let input_id = "in-dsml-reject-1";
    host.submit_user_input(&ws_id, input_id, "Check files", None)
        .unwrap();

    let leak_payload = "<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"list_files\">\n<｜DSML｜ parameter name=\"path\" string=\"true\">.</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";
    let p1 = leak_payload.to_owned();
    let p2 = leak_payload.to_owned();
    let p3 = leak_payload.to_owned();
    let server = start_mock_server(vec![
        Box::new(move |_| sse_text(&p1)),
        Box::new(move |req| {
            let msgs = req["messages"].as_array().unwrap();
            assert!(
                !msgs.iter().any(|m| m["content"]
                    .as_str()
                    .unwrap_or("")
                    .contains("<｜DSML｜ calls>")),
                "leaked DSML output must not be echoed into repair history"
            );
            sse_text(&p2)
        }),
        Box::new(move |_| sse_text(&p3)),
    ]);

    let model = mock_model(&server.endpoint);
    let report = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(server.requests.lock().unwrap().len(), 3);
    assert!(
        matches!(
            report.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::Failed { code }) if code == "unsupported_tool_response"
        ),
        "expected Failed(unsupported_tool_response), got {:?}",
        report.last_turn
    );
    assert!(
        host.find_reply_for_input(&ws_id, input_id)
            .unwrap()
            .is_none(),
        "pure DSML response must never be persisted as agent_reply"
    );

    host.close();
}

#[tokio::test]
async fn user_turn_succeeds_and_spawns_session_when_history_exceeds_four_megabytes() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Large history test\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("HistoryBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let cancel = CancellationToken::new();
    // Seed initial turn so the conversation exists cleanly in index.jsonl.
    let seed_input = "in-seed-4mb";
    let seed_anchor = input_message_id(seed_input).unwrap();
    host.submit_user_input(&ws_id, seed_input, "Initial task context", None)
        .unwrap();
    let seed_server = start_mock_server(vec![Box::new(move |_| {
        sse_tool_call(
            "tc-seed",
            "post_reply",
            &json!({ "replyTo": [seed_anchor.clone()], "text": "Initial ready." }),
        )
    })]);
    let seed_model = mock_model(&seed_server.endpoint);
    let _ = host
        .tick_foreground(&ws_id, &seed_model, json!({}), &cancel)
        .await
        .unwrap();

    // Push conversation JSONL cleanly past the 4 MiB boundary using large agent_turn rows.
    let conv_store = peer_store::ConversationStore::new(home.path());
    let big_payload = "X".repeat(190_000);
    for idx in 0..24 {
        let turn_id = format!("turn-bloat-{idx}");
        conv_store
            .append_message_idempotent(
                &conv_id,
                &json!({
                    "id": turn_id,
                    "role": "assistant",
                    "kind": "agent_turn",
                    "turnId": turn_id,
                    "content": "",
                    "rounds": [{
                        "text": "",
                        "toolCalls": [{
                            "name": "read_file",
                            "input": { "path": "README.md" },
                            "result": { "ok": true, "blob": big_payload }
                        }]
                    }],
                    "createdAt": "2026-11-22T12:00:00.000Z"
                }),
                "2026-11-22T12:00:00.000Z",
                None,
            )
            .unwrap();
    }
    let jsonl_bytes = fs::metadata(home.path().join(format!("conversations/{conv_id}.jsonl")))
        .unwrap()
        .len();
    assert!(
        jsonl_bytes > 4 * 1024 * 1024,
        "expected conversation JSONL > 4 MiB, got {jsonl_bytes} bytes"
    );

    let rerun_id = "in-rerun-4mb";
    let rerun_anchor = input_message_id(rerun_id).unwrap();
    let rerun_anchor_spawn = rerun_anchor.clone();
    let rerun_anchor_reply = rerun_anchor.clone();
    host.submit_user_input(&ws_id, rerun_id, "重跑", None)
        .unwrap();

    let server = start_mock_server(vec![
        Box::new(move |req| {
            let msgs = req["messages"].as_array().expect("messages array");
            let user_contents: Vec<&str> = msgs
                .iter()
                .filter(|m| m["role"] == "user")
                .filter_map(|m| m["content"].as_str())
                .collect();
            assert!(
                user_contents.contains(&"重跑"),
                "4+ MiB history must preserve user input '重跑', saw {user_contents:?}"
            );
            assert!(
                !user_contents
                    .iter()
                    .any(|c| c.contains("Review current project status")),
                "must NOT inject empty-history wake prompt when user history exists: {user_contents:?}"
            );
            sse_tool_call(
                "tc-spawn-4mb",
                "spawn_session",
                &json!({
                    "anchorMessageIds": [rerun_anchor_spawn.clone()],
                    "title": "验证超过4MB对话仍可派发任务",
                    "brief": "Read README.md and confirm.",
                    "kind": "research",
                    "readOnly": true,
                    "requiredCapabilities": ["local.file.read"],
                    "successCriteria": [{
                        "id": "c1",
                        "kind": "file-exists",
                        "path": "README.md",
                        "description": "README exists"
                    }]
                }),
            )
        }),
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req).expect("spawned sessionId in tool output");
            sse_tool_call(
                "tc-reply-4mb",
                "post_reply",
                &json!({
                    "replyTo": [rerun_anchor_reply.clone()],
                    "sources": [sid.clone()],
                    "statusClaims": [{ "sessionId": sid, "status": "queued" }],
                    "text": "已重新派发任务。"
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let report = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(report.bot_turns_run, 1);
    let turn = report.last_turn.as_ref().expect("last_turn present");
    assert_eq!(
        turn.spawned_session_ids.len(),
        1,
        "expected spawn_session to succeed even when conversation JSONL exceeds 4 MiB"
    );
    assert!(matches!(turn.end, TurnEndKind::ReplyCommitted { .. }));
    let reply = host
        .find_reply_for_input(&ws_id, rerun_id)
        .unwrap()
        .expect("reply persisted for >4MiB turn");
    assert_eq!(reply["content"], "已重新派发任务。");

    host.close();
}

#[tokio::test]
async fn project_agent_runner_executes_git_query_without_native_process_owner_unknown() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Git Query Repo\n").unwrap();
    for args in [
        &["init"][..],
        &["config", "user.email", "test@example.com"][..],
        &["config", "user.name", "Test User"][..],
        &["add", "README.md"][..],
        &["commit", "-m", "initial commit"][..],
    ] {
        let status = std::process::Command::new("git")
            .args(args)
            .current_dir(ws.path())
            .status()
            .expect("run git setup");
        assert!(status.success(), "git setup {:?} failed", args);
    }

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("GitBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let cancel = CancellationToken::new();
    let input_id = "in-git-query-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&ws_id, input_id, "Check git repository status", None)
        .unwrap();

    let server = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "tc-git-1",
                "git_query",
                &json!({ "operation": "snapshot", "path": "." }),
            )
        }),
        Box::new(move |req| {
            let tool_msg = req["messages"]
                .as_array()
                .and_then(|arr| arr.iter().rfind(|m| m["role"] == "tool"))
                .expect("tool response for git_query");
            let parsed: Value = serde_json::from_str(tool_msg["content"].as_str().unwrap_or("{}"))
                .unwrap_or_default();
            assert_ne!(
                parsed.get("reason").and_then(Value::as_str),
                Some("native_process_owner_unknown"),
                "git_query must not fail with native_process_owner_unknown: {parsed}"
            );
            assert_eq!(
                parsed.get("kind").and_then(Value::as_str),
                Some("local_git_observation"),
                "expected local_git_observation from git_query, got: {parsed}"
            );
            sse_tool_call(
                "tc-post-git",
                "post_reply",
                &json!({ "replyTo": [anchor.clone()], "text": "Git 状态已读取。" }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let report = host
        .tick_foreground(&ws_id, &model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(report.bot_turns_run, 1);
    assert!(matches!(
        report.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    host.close();
}

#[tokio::test]
async fn progressive_skill_pack_projection_preserves_prefix_and_enforces_security_ceiling() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("ProgBot")).unwrap();
    let ws_id = entry.workspace_id.clone();

    let input_id = "in-prog-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(
        &ws_id,
        input_id,
        "Remember our preferred release cadence",
        None,
    )
    .unwrap();

    let initial_tools_slot: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let initial_tools_writer = Arc::clone(&initial_tools_slot);
    let initial_tools_reader = Arc::clone(&initial_tools_slot);
    let anchor_clone = anchor.clone();

    let server = start_mock_server(vec![
        // Round 1: blank workspace starts with 14 Tier-1 core tools + skill pack catalog.
        Box::new(move |req| {
            let sys = req["messages"]
                .as_array()
                .and_then(|arr| arr.iter().find(|m| m["role"] == "system"))
                .and_then(|m| m["content"].as_str())
                .unwrap_or("");
            assert!(
                sys.contains("On-Demand Capability Packs"),
                "Progressive mode must inject compact skill-pack catalog"
            );
            assert!(sys.contains("- memory:"));
            assert!(sys.contains("- objectives:"));

            let tools = tool_names_from_request(req);
            assert_eq!(
                tools.len(),
                14,
                "blank workspace in Progressive mode must project exactly 14 core tools, got {:?}",
                tools
            );
            assert!(tools.iter().any(|t| t == "activate_skill_pack"));
            assert!(!tools.iter().any(|t| t == "memory_remember"));
            assert!(!tools.iter().any(|t| t == "memory_write"));
            assert!(!tools.iter().any(|t| t == "create_objective"));
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "project_agent must never project {forbidden}"
                );
            }
            *initial_tools_writer.lock().unwrap() = tools;

            sse_tool_call(
                "prog-1",
                "activate_skill_pack",
                &json!({ "packs": ["memory", "objectives"] }),
            )
        }),
        // Round 2: prefix stays byte-identical, unlocked tools append strictly at the tail.
        Box::new(move |req| {
            let activate_out = last_tool_result_json(req).expect("activate_skill_pack output");
            assert_eq!(activate_out["ok"], true);
            assert_eq!(activate_out["activated"], json!(["memory", "objectives"]));
            assert!(activate_out["guides"]["memory"].as_str().is_some());
            assert!(activate_out["guides"]["objectives"].as_str().is_some());

            let tools = tool_names_from_request(req);
            let initial = initial_tools_reader.lock().unwrap().clone();
            assert_eq!(
                &tools[..initial.len()],
                &initial[..],
                "KV-cache stability: prefix tool order must remain identical after activation"
            );
            let tail = &tools[initial.len()..];
            assert!(tail.iter().any(|t| t == "memory_remember"));
            assert!(tail.iter().any(|t| t == "memory_list"));
            assert!(tail.iter().any(|t| t == "memory_forget"));
            assert!(tail.iter().any(|t| t == "create_objective"));
            assert!(
                !tools.iter().any(|t| t == "memory_write"),
                "duplicate legacy memory_write stays hidden in Progressive mode"
            );
            for forbidden in ["write_file", "edit_file", "bash", "web_fetch"] {
                assert!(
                    !tools.iter().any(|t| t == forbidden),
                    "project_agent must never project {forbidden}"
                );
            }

            sse_tool_call(
                "prog-2",
                "memory_remember",
                &json!({
                    "kind": "preference",
                    "text": "Prefer weekly Friday releases"
                }),
            )
        }),
        // Round 3: commit reply
        Box::new(move |req| {
            let mem_out = last_tool_result_json(req).expect("memory_remember output");
            assert_eq!(mem_out["ok"], true);
            sse_tool_call(
                "prog-3",
                "post_reply",
                &json!({
                    "replyTo": [anchor_clone],
                    "text": "已记住每周五发布的偏好。"
                }),
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick = host
        .tick(&ws_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert_eq!(tick.bot_turns_run, 1);
    assert!(matches!(
        tick.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    let memories = host.memory().list(&MemoryFilter {
        workspace_id: Some(&ws_id),
        ..Default::default()
    });
    assert_eq!(memories.len(), 1);
    assert!(memories[0].text.contains("Friday"));
}

#[tokio::test]
async fn phase1_ergonomics_auto_anchor_spawn_preset_and_post_reply_session_prefix_and_long_text() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Ergonomics\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("ErgoBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();

    // Turn 1: omit anchorMessageIds & requiredCapabilities in spawn_session (use capabilityPreset),
    // then cite "session:<sid>" without statusClaims and >2000-char text in post_reply.
    let input_id = "in-ergo-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&ws_id, input_id, "Inspect repo layout", None)
        .unwrap();

    let sid_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sid_writer = Arc::clone(&sid_slot);
    let long_body = format!("任务已派发。{}", "详细说明内容。".repeat(350));
    assert!(
        long_body.chars().count() > 2100 && long_body.chars().count() < 8000,
        "test body must exercise >2000 relaxed TEXT_MAX"
    );
    let long_body_clone = long_body.clone();

    let server_1 = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "ergo-spawn",
                "spawn_session",
                &json!({
                    "title": "Read README",
                    "brief": "Inspect README.md",
                    "kind": "research",
                    "readOnly": true,
                    "capabilityPreset": "read_only",
                    "successCriteria": [{
                        "kind": "file-exists",
                        "path": "README.md",
                        "description": "README exists"
                    }]
                }),
            )
        }),
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req).expect("spawn_session succeeded");
            *sid_writer.lock().unwrap() = Some(sid.clone());
            sse_tool_call(
                "ergo-reply",
                "post_reply",
                &json!({
                    "text": long_body_clone,
                    "sources": [format!("session:{sid}")]
                }),
            )
        }),
    ]);

    let model_1 = mock_model(&server_1.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let tick_1 = host
        .tick_foreground(&ws_id, &model_1, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick_1.bot_turns_run, 1);
    assert!(matches!(
        tick_1.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    let spawned_sid = sid_slot.lock().unwrap().clone().expect("captured sid");
    let sessions = host.supervisor().list_sessions(&ws_id);
    let sess = sessions
        .iter()
        .find(|s| s.session_id == spawned_sid)
        .expect("spawned session exists");
    assert_eq!(
        sess.anchor_message_ids,
        vec![anchor.clone()],
        "spawn_session must auto-anchor to current user input when omitted"
    );

    let reply = host
        .find_reply_for_input(&ws_id, input_id)
        .unwrap()
        .expect("long post_reply committed");
    assert_eq!(reply["content"], long_body);
    assert_eq!(reply["meta"]["sources"], json!([spawned_sid.clone()]));
    assert_eq!(
        reply["meta"]["sessionStates"][0]["sessionId"],
        json!(spawned_sid.clone())
    );
    assert_eq!(
        reply["meta"]["sessionStates"][0]["status"],
        json!("queued"),
        "post_reply must auto-fill the actual session status at reply commit time"
    );
    assert!(
        matches!(sess.status.as_str(), "queued" | "running"),
        "spawned session should be queued or running, got {}",
        sess.status
    );

    // Turn 2: explicit wrong statusClaims and forged sources must STILL be rejected strictly.
    let input_2 = "in-ergo-2";
    host.submit_user_input(&ws_id, input_2, "Check truthfulness guards", None)
        .unwrap();
    let sid_for_mismatch = spawned_sid.clone();
    let server_2 = start_mock_server(vec![
        // Attempt 1: explicit status_claim_mismatch ("accepted" when actual status is "queued")
        Box::new(move |_| {
            sse_tool_call(
                "ergo-bad-claim",
                "post_reply",
                &json!({
                    "text": "任务已完成。",
                    "sources": [sid_for_mismatch],
                    "statusClaims": [{ "sessionId": sid_for_mismatch, "status": "accepted" }]
                }),
            )
        }),
        // Attempt 2: forged source path
        Box::new(|req| {
            let err_out = last_tool_result_json(req).expect("mismatch error");
            assert_eq!(err_out["ok"], false);
            assert_eq!(err_out["error"], "status_claim_mismatch");
            sse_tool_call(
                "ergo-forged",
                "post_reply",
                &json!({
                    "text": "引用假路径。",
                    "sources": ["src/does-not-exist.rs"]
                }),
            )
        }),
        // Attempt 3: honest reply succeeds
        Box::new(|req| {
            let err_out = last_tool_result_json(req).expect("forged_sources error");
            assert_eq!(err_out["ok"], false);
            assert_eq!(err_out["error"], "forged_sources");
            sse_tool_call(
                "ergo-ok",
                "post_reply",
                &json!({
                    "text": "已如实确认状态。"
                }),
            )
        }),
    ]);

    let model_2 = mock_model(&server_2.endpoint);
    let tick_2 = host
        .tick_foreground(&ws_id, &model_2, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick_2.bot_turns_run, 1);
    assert!(matches!(
        tick_2.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::ReplyCommitted { .. })
    ));

    let _ = (&conv_id, &mut perm);
}

#[tokio::test]
async fn wake_turn_host_fallback_reports_failed_session_when_model_yields_without_post_reply() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("WakeFailBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let input_id = "in-wake-fail-1";
    let anchor = input_message_id(input_id).unwrap();
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": anchor.clone(),
                "role": "user",
                "kind": "user_input",
                "inputId": input_id,
                "content": "Run UI patch",
                "createdAt": "2026-11-22T00:00:00.000Z"
            }),
            "2026-11-22T00:00:00.000Z",
            None,
        )
        .unwrap();
    // Mark user input handled by spawning directly and failing it so the wake turn runs alone.
    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![anchor.clone()],
                input_id: input_id.into(),
                surface: "tui".into(),
                title: "降级摘要条样式".into(),
                brief: "Update provider-settings.css".into(),
                kind: "ui".into(),
                read_only: false,
                required_capabilities: vec!["local.file.edit".into()],
                success_criteria: vec![SpawnCriterion {
                    id: None,
                    kind: "manual".into(),
                    description: "Check spacing".into(),
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
    // Drain the initial user input by posting a quick ack, then fail the session to enqueue wake event.
    host.conversations()
        .append_message_idempotent(
            &conv_id,
            &json!({
                "id": "reply-ack-1",
                "role": "assistant",
                "kind": "agent_reply",
                "content": "已派发任务。",
                "replyTo": [anchor.clone()],
                "createdAt": "2026-11-22T00:00:01.000Z"
            }),
            "2026-11-22T00:00:01.000Z",
            None,
        )
        .unwrap();
    // Drain user_inputs via inbox consume or simply fail session and run runner directly for wake turn.
    assert!(
        host.supervisor()
            .fail_session(
                &ws_id,
                &spawned.session_id,
                "provider_502",
                "Upstream gateway 502 while applying CSS patch",
                true,
            )
            .unwrap()
    );

    // Mock model returns plain text without calling post_reply on both initial wake round and delivery repair round.
    let server = start_mock_server(vec![
        Box::new(|_| sse_text("I see the task failed.")),
        Box::new(|_| sse_text("Still not calling post_reply.")),
    ]);
    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();

    let wake_events = vec![json!({
        "eventId": "ev-fail-1",
        "kind": "session_ended",
        "payload": {
            "sessionId": spawned.session_id,
            "status": "failed",
            "error": "provider_502"
        }
    })];
    let outcome = host
        .runner()
        .run_turn(
            &peer_project_agent::RunTurnOptions {
                workspace_id: &ws_id,
                workspace_path: ws.path(),
                conversation_id: &conv_id,
                kind: "wake",
                user_inputs: &[],
                wake_events: &wake_events,
                worker_model_selection: json!({}),
                holds_lease: true,
                manual_trial: false,
            },
            &model,
            &cancel,
        )
        .await
        .unwrap();

    assert!(
        matches!(outcome.end, TurnEndKind::ReplyCommitted { .. }),
        "host-side wake fallback must commit visible failure notification, got {:?}",
        outcome.end
    );

    let msgs = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let fallback = msgs
        .iter()
        .find(|m| m["kind"] == "agent_reply" && m["meta"]["fallback"].as_bool() == Some(true))
        .expect("host fallback failure reply persisted");
    let content = fallback["content"].as_str().unwrap_or("");
    assert!(content.contains("降级摘要条样式"));
    assert!(content.contains("Upstream gateway 502"));
    assert_eq!(fallback["meta"]["sources"], json!([spawned.session_id]));
    assert_eq!(fallback["meta"]["sessionStates"][0]["status"], "failed");
    assert_eq!(fallback["replyTo"], json!([anchor]));
}

#[tokio::test]
async fn worker_exhausting_turn_budget_synthesizes_final_report_and_resolves_multi_repo_criteria() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    // Simulate a multi-repo parent workspace (`peer-dev` containing `RepoA/` and `RepoB/`).
    let css_dir = ws.path().join("RepoA/src");
    fs::create_dir_all(&css_dir).unwrap();
    fs::create_dir_all(ws.path().join("RepoB")).unwrap();
    fs::write(
        css_dir.join("panel.css"),
        ".strip { padding: 12px; background: none; }\n",
    )
    .unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("WrapBot")).unwrap();
    let ws_id = entry.workspace_id.clone();
    let conv_id = profile.agent_conversation_id.unwrap();
    assert!(matches!(
        host.ensure_lease(&ws_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: ws_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec!["input-wrap-1".into()],
                input_id: "wrap-1".into(),
                surface: "tui".into(),
                title: "Verify panel CSS".into(),
                brief: "Check RepoA/src/panel.css".into(),
                kind: "ui".into(),
                read_only: true,
                required_capabilities: vec!["local.file.read".into(), "local.file.list".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c1".into()),
                    kind: "file-contains".into(),
                    description: "panel.css removes background".into(),
                    command: None,
                    // Intentionally relative to RepoA/ rather than ws root:
                    path: Some("src/panel.css".into()),
                    expect: Some("background: none;".into()),
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

    let promoted = host.supervisor().promote_queued(&ws_id, true).unwrap();
    assert_eq!(promoted.start, vec![spawned.session_id.clone()]);

    // max_turns = 2:
    // Turn 1: list_files -> consumes turn 1
    // Turn 2: read_file  -> consumes turn 2 -> hits agent_loop_exhausted!
    // Turn 3 (host graceful wrap-up): tools must be empty ([]), model returns final summary.
    let server = start_mock_server(vec![
        Box::new(|req| {
            let user_prompt = req["messages"]
                .as_array()
                .and_then(|arr| arr.iter().find(|m| m["role"] == "user"))
                .and_then(|m| m["content"].as_str())
                .unwrap_or("");
            assert!(
                user_prompt.contains("Turn budget: 2 turns"),
                "worker prompt must advertise turn budget"
            );
            sse_tool_call("w-1", "list_files", &json!({ "path": "RepoA/src" }))
        }),
        Box::new(|_| {
            sse_tool_call(
                "w-2",
                "read_file",
                &json!({ "path": "RepoA/src/panel.css" }),
            )
        }),
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            assert!(
                tools.is_empty(),
                "graceful wrap-up turn must disable tools, got {:?}",
                tools
            );
            sse_text(
                "Verified RepoA/src/panel.css contains `background: none;` and `padding: 12px;`.",
            )
        }),
    ]);

    let model = mock_model(&server.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    let outcome = host
        .run_promoted_session(
            &ws_id,
            &spawned.session_id,
            &model,
            None,
            &mut perm,
            2,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(outcome.status, "completed");
    assert!(outcome.content.contains("RepoA/src/panel.css"));

    let plan = host
        .supervisor()
        .find_plan_by_session(&ws_id, &spawned.session_id)
        .expect("plan persisted");
    assert_eq!(plan["status"], "completed");
    assert_eq!(plan["criterionResults"][0]["passed"], true);
    assert_eq!(plan["delegationOrigin"]["independentVerifier"], "passed");
}

#[tokio::test]
async fn spawn_omitting_criterion_description_wait_keeps_live_activity_and_wake_shows_visible_activity()
 {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("README.md"), "# Check\n").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("WaitVisBot")).unwrap();
    let ws_id = entry.workspace_id.clone();

    let input_id = "in-wait-vis-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&ws_id, input_id, "跑检查", None)
        .unwrap();

    let sid_slot: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sid_writer = Arc::clone(&sid_slot);

    // Turn 1: spawn_session with a command criterion omitting `description`, then wait_for_sessions.
    let server_1 = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "wv-spawn",
                "spawn_session",
                &json!({
                    "title": "只跑类型检查",
                    "brief": "Run check",
                    "kind": "ops",
                    "readOnly": true,
                    "successCriteria": [{
                        "id": "c1",
                        "kind": "command",
                        "command": "echo ok",
                        "expect": "ok"
                    }]
                }),
            )
        }),
        Box::new(move |req| {
            let sid = extract_spawned_session_id(req)
                .expect("spawn_session succeeds without criterion description");
            *sid_writer.lock().unwrap() = Some(sid.clone());
            sse_tool_call(
                "wv-wait",
                "wait_for_sessions",
                &json!({ "sessionIds": [sid] }),
            )
        }),
    ]);

    let model_1 = mock_model(&server_1.endpoint);
    let cancel = CancellationToken::new();
    let fg = host
        .tick_foreground(&ws_id, &model_1, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(fg.bot_turns_run, 1);
    assert!(matches!(
        fg.last_turn.as_ref().map(|t| &t.end),
        Some(TurnEndKind::AwaitingChildren { .. })
    ));

    // Activity must remain live (not disposed to a blank orphan row) while awaiting child session.
    let waiting_act = host
        .runner()
        .activity_for(&ws_id)
        .expect("activity stays live during wait_for_sessions");
    assert_eq!(waiting_act.phase, "tool");
    assert!(waiting_act.finished_at.is_none());
    assert_eq!(waiting_act.segments[0]["name"], "wait_for_sessions");
    assert_eq!(waiting_act.segments[0]["status"], "running");

    // Capture activity updates during the subsequent wake turn answering the unanswered input.
    type WakeActivityLog = Arc<Mutex<Vec<(String, Vec<String>)>>>;
    let wake_activities: WakeActivityLog = Arc::new(Mutex::new(Vec::new()));
    let wake_cb = Arc::clone(&wake_activities);
    host.runner()
        .set_activity_listener(Some(Arc::new(move |act, _status| {
            wake_cb
                .lock()
                .unwrap()
                .push((act.phase.clone(), act.reply_to.clone()));
        })));

    let sid = sid_slot.lock().unwrap().clone().expect("spawned sid");
    let sid_for_get = sid.clone();
    let sid_for_reply = sid.clone();
    // Run worker + wake turn: worker replies, then wake turn runs with visible activity
    // and posts a proactive wake reply citing `sources: [sid]` WITHOUT explicit `replyTo`
    // (proving automatic unanswered-anchor inheritance).
    let server_2 = start_mock_server(vec![
        // Worker reply (completes immediately)
        Box::new(|_| sse_text("Checks passed clean.")),
        // Wake turn round 1: get_session(detail="report")
        Box::new(move |_| {
            sse_tool_call(
                "wv-get",
                "get_session",
                &json!({ "sessionId": sid_for_get, "detail": "report" }),
            )
        }),
        // Wake turn round 2: proactive wake reply omitting replyTo -> auto-anchors to unanswered user input
        Box::new(move |req| {
            let out = last_tool_result_json(req).expect("get_session report output");
            assert_eq!(out["ok"], true);
            assert!(
                out["report"]["workerOutput"]
                    .as_str()
                    .unwrap_or("")
                    .contains("Checks passed")
            );
            assert!(
                out["report"].get("summary").is_none(),
                "summary must not be duplicated inside report"
            );
            sse_tool_call(
                "wv-reply",
                "post_reply",
                &json!({
                    "proactive": true,
                    "sources": [sid_for_reply],
                    "text": "检查全部通过。"
                }),
            )
        }),
    ]);

    let model_2 = mock_model(&server_2.endpoint);
    let mut perm = AutoAllowPermission;
    let worker_out = host
        .run_promoted_session(&ws_id, &sid, &model_2, None, &mut perm, 8, &cancel)
        .await
        .unwrap();
    assert_eq!(worker_out.status, "completed");
    let plan = host
        .supervisor()
        .find_plan_by_session(&ws_id, &sid)
        .expect("completed plan");
    assert_eq!(plan["progress"]["completed"], 1);
    assert_eq!(plan["progress"]["percent"], 100);

    let tick2 = host
        .tick_foreground(&ws_id, &model_2, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick2.wake_turns_run, 1);

    let reply = host
        .find_reply_for_input(&ws_id, input_id)
        .unwrap()
        .expect("proactive wake reply must auto-anchor to unanswered user input");
    assert_eq!(reply["replyTo"], json!([anchor]));

    // Verify failed-verification result_ready projects `verification_failed` (never stuck "正在核对结果").
    let failed_ver_plan = json!({
        "planId": "plan-vf",
        "status": "completed",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-vf",
            "phase": "completed",
            "independentVerifier": "failed"
        },
        "verificationReport": {
            "passed": false,
            "error": "git_read_permission_denied"
        }
    });
    let lc = peer_project_agent::decide_lifecycle(&failed_ver_plan, false, false, None, None);
    assert_eq!(lc.status, "result_ready");
    assert_eq!(lc.follow_up.owner, "bot");
    assert_eq!(lc.follow_up.reason, "verification_failed");

    let captured = wake_activities.lock().unwrap().clone();
    assert!(
        captured.iter().any(|(phase, reply_to)| phase == "thinking"
            && reply_to.contains(&input_message_id(input_id).unwrap())),
        "wake turn answering an unanswered user input must emit visible live activity anchored to that input, got {:?}",
        captured
    );
    assert!(
        captured.iter().any(|(phase, _)| phase == "done"),
        "wake turn must finish cleanly in done phase, got {:?}",
        captured
    );
}

#[tokio::test]
async fn independent_verifier_handles_missing_parent_read_and_repairs_unindexed_ref_without_tools()
{
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "peer verifier repair\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("RepairBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let conv_id = profile.agent_conversation_id.unwrap();
    host.submit_user_input(&entry.workspace_id, "in-rep-1", "Check readme", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    let anchor = input_message_id("in-rep-1").unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor],
                input_id: "in-rep-1".into(),
                surface: "desktop".into(),
                title: "Verify readme with repair".into(),
                brief: "Read readme.md and confirm contents.".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec!["local.file.read".into(), "local.file.list".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c-review".into()),
                    kind: "model_review".into(),
                    command: None,
                    path: None,
                    expect: None,
                    description: "Verify readme mentions verifier repair".into(),
                }],
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
    let promoted = host
        .supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();
    assert_eq!(promoted.start, vec![spawned.session_id.clone()]);

    let worker_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))),
        Box::new(|_| sse_text("Read readme.md and verified contents.")),
    ]);

    let verifier_server = start_mock_server(vec![
        // Attempt 0 Turn 1: probe a multi-level nonexistent path (previously crashed with file_parent_unavailable!)
        Box::new(|_| {
            sse_tool_call(
                "v-missing-parent",
                "list_files",
                &json!({ "path": "nonexistent_parent/shell-artifacts" }),
            )
        }),
        // Attempt 0 Turn 2: confirm prior tool failed recoverably, then read readme.md
        Box::new(|req| {
            let msgs_str = serde_json::to_string(&req["messages"]).unwrap();
            assert!(
                msgs_str.contains("file_unavailable"),
                "expected recoverable file_unavailable tool result, got {msgs_str}"
            );
            sse_tool_call("v-read", "read_file", &json!({ "path": "readme.md" }))
        }),
        // Attempt 0 Turn 3: emit passed: true with string missingEvidence + 1 valid worker ref + 1 raw file path
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
                .expect("Known Worker Evidence Refs line");
            let known: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            let report = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": ["minor caveat emitted as string"],
                "risks": [],
                "evidenceRefs": [known[0], "/raw/workspace/readme.md"],
                "summary": "Verified readme.md cleanly."
            });
            sse_text(&serde_json::to_string(&report).unwrap())
        }),
        // Attempt 1 (tool-less format repair on SAME conversation): verify tools disabled and exact bad ref named
        Box::new(|req| {
            let tools = tool_names_from_request(req);
            assert!(
                tools.is_empty(),
                "Attempt 1 format repair must be strictly tool-less, got {:?}",
                tools
            );
            let last_user = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "user")
                .and_then(|m| m["content"].as_str())
                .unwrap_or("");
            assert!(
                last_user.contains("/raw/workspace/readme.md"),
                "repair prompt must name the exact unindexed ref, got {last_user}"
            );
            let marker = "Valid indexed evidenceRefs (cite ONLY exact strings from this list): ";
            let line = last_user
                .lines()
                .find(|l| l.starts_with(marker))
                .expect("valid indexed refs line in repair prompt");
            let valid: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            assert!(!valid.is_empty(), "expected non-empty valid refs list");
            let repaired = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": ["minor caveat emitted as string"],
                "risks": [],
                "evidenceRefs": [valid[0]],
                "summary": "Verified readme.md cleanly after removing raw path ref."
            });
            sse_text(&serde_json::to_string(&repaired).unwrap())
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

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .expect("plan");
    assert_eq!(plan["delegationOrigin"]["independentVerifier"], "passed");
    assert_eq!(plan["verificationReport"]["passed"], true);
    assert_eq!(
        plan["verificationReport"]["missingEvidence"][0]["reason"],
        "minor caveat emitted as string"
    );
    assert!(
        plan["delegationOrigin"]["verifierConversationId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "verifierConversationId must be persisted"
    );
    host.close();
}

#[tokio::test]
async fn independent_verifier_rejects_fabricated_refs_after_repair_and_records_conversation_id() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "peer strict refs\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("StrictBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let conv_id = profile.agent_conversation_id.unwrap();
    host.submit_user_input(&entry.workspace_id, "in-str-1", "Check readme", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    let anchor = input_message_id("in-str-1").unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor],
                input_id: "in-str-1".into(),
                surface: "desktop".into(),
                title: "Reject fabricated refs".into(),
                brief: "Read readme.md.".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec!["local.file.read".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c-review".into()),
                    kind: "model_review".into(),
                    command: None,
                    path: None,
                    expect: None,
                    description: "Verify readme".into(),
                }],
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
    host.supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();

    let worker_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))),
        Box::new(|_| sse_text("Done.")),
    ]);
    let fake_report = json!({
        "passed": true,
        "failedCriteria": [],
        "missingEvidence": [],
        "risks": [],
        "evidenceRefs": ["tool-result://call-fabricated-999"],
        "summary": "Claimed pass with fabricated ref."
    });
    let fake_json = serde_json::to_string(&fake_report).unwrap();
    let fake_json_2 = fake_json.clone();
    let verifier_server = start_mock_server(vec![
        Box::new(move |_| sse_text(&fake_json)),
        Box::new(move |req| {
            assert!(tool_names_from_request(req).is_empty());
            sse_text(&fake_json_2)
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

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .expect("plan");
    assert_eq!(plan["delegationOrigin"]["independentVerifier"], "failed");
    assert_eq!(
        plan["verificationReport"]["error"],
        "verifier_report_invalid"
    );
    assert!(
        plan["delegationOrigin"]["verifierConversationId"]
            .as_str()
            .is_some_and(|s| !s.is_empty()),
        "verifierConversationId must still be recorded on invalid report"
    );
    host.close();
}

#[tokio::test]
async fn command_and_manual_criteria_reach_human_gate_and_confirm_cleanly() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "pr 334 verified\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("GateBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let conv_id = profile.agent_conversation_id.unwrap();
    host.submit_user_input(&entry.workspace_id, "in-gate-1", "Reopen clean PR", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    let anchor = input_message_id("in-gate-1").unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id.clone(),
                anchor_message_ids: vec![anchor],
                input_id: "in-gate-1".into(),
                surface: "desktop".into(),
                title: "Reopen clean PR".into(),
                brief: "Verify PR diff and report.".into(),
                kind: "code".into(),
                read_only: false,
                required_capabilities: vec!["local.file.read".into(), "local.shell.exec".into()],
                success_criteria: vec![
                    SpawnCriterion {
                        id: Some("c1".into()),
                        kind: "command".into(),
                        command: Some("git diff --name-only".into()),
                        path: None,
                        expect: None,
                        description: "Diff only touches 2 files".into(),
                    },
                    SpawnCriterion {
                        id: Some("c2".into()),
                        kind: "manual".into(),
                        command: None,
                        path: None,
                        expect: None,
                        description: "User confirms PR link and summary".into(),
                    },
                ],
                priority: "high".into(),
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
    host.supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();

    let worker_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))),
        Box::new(|_| sse_text("PR #334 created cleanly.")),
    ]);
    let verifier_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("v-read", "read_file", &json!({ "path": "readme.md" }))),
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
                .expect("Known Worker Evidence Refs");
            let known: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            let report = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": [],
                "risks": [],
                "evidenceRefs": [known[0]],
                "summary": "All command criteria verified."
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

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .expect("plan");
    assert_eq!(plan["delegationOrigin"]["independentVerifier"], "passed");
    assert_eq!(plan["criterionResults"][0]["criterionId"], "c1");
    assert_eq!(plan["criterionResults"][0]["passed"], true);
    assert!(plan["criterionResults"][0]["evidenceRef"].is_string());
    assert!(
        plan["runner"]["verifierRuns"]
            .as_array()
            .is_some_and(|runs| runs.iter().any(|r| r["status"] == "passed"))
    );

    // Watchdog & lifecycle must treat `phase == verifying` as `verifying` (never premature `result_ready`).
    let mut verifying_plan = plan.clone();
    verifying_plan["delegationOrigin"]["phase"] = json!("verifying");
    let wf = peer_project_agent::watch_facts_from_plan(&verifying_plan).expect("watch facts");
    assert_eq!(wf.status, "verifying");

    // Projected session must surface human gate (`awaiting_human_gate`), NOT stuck `正在核对结果`.
    let projected = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&entry.workspace_id),
        None,
        None,
        None,
        None,
    );
    let sess = projected
        .iter()
        .find(|s| s["sessionId"] == spawned.session_id)
        .expect("projected session");
    assert_eq!(sess["status"], "result_ready");
    assert_eq!(sess["resultConfirmationRequired"], true);
    assert_eq!(sess["followUp"]["owner"], "user");
    assert_eq!(sess["followUp"]["reason"], "awaiting_human_gate");

    // Explicit user confirmation settles manual criterion + accepts the session.
    let accepted = host
        .confirm_session_result(&entry.workspace_id, &spawned.session_id, None)
        .unwrap();
    assert!(accepted.close_gate_passed);
    assert_eq!(accepted.accepted_by.as_deref(), Some("user"));

    let projected_after = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&entry.workspace_id),
        None,
        None,
        None,
        None,
    );
    let sess_after = projected_after
        .iter()
        .find(|s| s["sessionId"] == spawned.session_id)
        .expect("projected session after confirm");
    assert_eq!(sess_after["status"], "accepted");
    assert_eq!(sess_after["followUp"]["owner"], "none");
    assert_eq!(sess_after["followUp"]["reason"], "settled");

    // Legacy verified plan compatibility: empty `criterionResults` + passing `verificationReport`
    // still unlocks `awaiting_human_gate` and settles cleanly on user confirm.
    let mut legacy_plan = plan;
    legacy_plan["planId"] = json!("plan-legacy-verified");
    legacy_plan["delegationOrigin"]["sessionId"] = json!("sess-legacy-verified");
    legacy_plan["criterionResults"] = json!([]);
    legacy_plan["resultAcceptance"] = Value::Null;
    legacy_plan["manualConfirmations"] = json!([]);
    let plans_dir = home.path().join("goal-plans");
    fs::write(
        plans_dir.join("plan-legacy-verified.json"),
        serde_json::to_string(&legacy_plan).unwrap(),
    )
    .unwrap();
    let idx_path = plans_dir.join("index.jsonl");
    let mut idx_content = fs::read_to_string(&idx_path).unwrap_or_default();
    idx_content.push_str("{\"planId\":\"plan-legacy-verified\"}\n");
    fs::write(&idx_path, idx_content).unwrap();

    let legacy_proj = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&entry.workspace_id),
        None,
        None,
        None,
        None,
    );
    let legacy_sess = legacy_proj
        .iter()
        .find(|s| s["sessionId"] == "sess-legacy-verified")
        .expect("legacy projected session");
    assert_eq!(legacy_sess["resultConfirmationRequired"], true);
    assert_eq!(legacy_sess["followUp"]["owner"], "user");
    assert_eq!(legacy_sess["followUp"]["reason"], "awaiting_human_gate");
    let legacy_confirmed = host
        .confirm_session_result(&entry.workspace_id, "sess-legacy-verified", None)
        .unwrap();
    assert_eq!(legacy_confirmed.accepted_by.as_deref(), Some("user"));

    host.close();
}

#[tokio::test]
async fn command_and_model_review_session_auto_accepts_under_auto_policy() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "auto accept check\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("AutoBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let conv_id = profile.agent_conversation_id.unwrap();
    host.submit_user_input(&entry.workspace_id, "in-auto-1", "Run check", None)
        .unwrap();
    host.inputs()
        .consume(&entry.workspace_id, &conv_id, host.conversations(), true)
        .unwrap();
    let anchor = input_message_id("in-auto-1").unwrap();

    let spawned = host
        .supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: entry.workspace_id.clone(),
                workspace_path: ws.path().to_path_buf(),
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor],
                input_id: "in-auto-1".into(),
                surface: "desktop".into(),
                title: "Command and review".into(),
                brief: "Read readme and verify.".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec!["local.file.read".into()],
                success_criteria: vec![
                    SpawnCriterion {
                        id: Some("c-cmd".into()),
                        kind: "command".into(),
                        command: Some("echo ok".into()),
                        path: None,
                        expect: None,
                        description: "Command passes".into(),
                    },
                    SpawnCriterion {
                        id: Some("c-rev".into()),
                        kind: "model_review".into(),
                        command: None,
                        path: None,
                        expect: None,
                        description: "Review passes".into(),
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
    host.supervisor()
        .promote_queued(&entry.workspace_id, true)
        .unwrap();

    let worker_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))),
        Box::new(|_| sse_text("Checked readme.")),
    ]);
    let verifier_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("v-read", "read_file", &json!({ "path": "readme.md" }))),
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
                .expect("Known Worker Evidence Refs");
            let known: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            let report = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": [],
                "risks": [],
                "evidenceRefs": [known[0]],
                "summary": "Verified."
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
    host.run_promoted_session(
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

    let plan = host
        .supervisor()
        .find_plan_by_session(&entry.workspace_id, &spawned.session_id)
        .expect("plan");
    assert!(plan["modelReviewSourceRevision"].is_string());
    assert_eq!(
        plan["modelReviews"][0]["sourceRevision"],
        plan["modelReviewSourceRevision"]
    );
    assert!(plan["modelReviews"][0]["verifierRunId"].is_string());

    // Reporting the session settles it automatically under `auto` policy.
    let decision = host
        .supervisor()
        .settle_session(
            &entry.workspace_id,
            &spawned.session_id,
            true,
            false,
            None,
            true,
        )
        .unwrap();
    assert!(decision.close_gate_passed);
    assert_eq!(decision.accepted_by.as_deref(), Some("policy"));
    host.close();
}

#[tokio::test]
async fn model_invented_manual_criterion_promotes_to_model_review_and_auto_accepts_on_post_reply() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "clean pr 334\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("AutoBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let ws_id = entry.workspace_id.clone();

    // Ordinary user input ("2") — user did NOT ask to review or manually confirm.
    host.submit_user_input(&ws_id, "in-auto-manual-1", "2", None)
        .unwrap();

    let spawned_sid: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
    let sid_capture = Arc::clone(&spawned_sid);

    let bot_server = start_mock_server(vec![
        // Main bot calls spawn_session with model-invented `kind: "manual"` and a brief containing "确认一下"
        Box::new(|_| {
            sse_tool_call(
                "sp-1",
                "spawn_session",
                &json!({
                    "title": "Reopen clean PR",
                    "brief": "先用 gh auth status 确认一下可用，然后创建新 PR。",
                    "kind": "code",
                    "readOnly": false,
                    "capabilityPreset": "code_edit_and_shell",
                    "successCriteria": [
                        { "id": "c1", "kind": "command", "command": "echo ok", "description": "Command ok" },
                        { "id": "c2", "kind": "manual", "description": "Report includes PR URL and exit codes" }
                    ]
                }),
            )
        }),
        Box::new(move |req| {
            let tool_msg = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .and_then(|m| m["content"].as_str())
                .unwrap();
            let parsed: Value = serde_json::from_str(tool_msg).unwrap();
            let sid = parsed["sessionId"].as_str().unwrap().to_owned();
            *sid_capture.lock().unwrap() = Some(sid.clone());
            sse_tool_call(
                "ack-1",
                "post_reply",
                &json!({ "text": format!("已派发任务 {sid}。") }),
            )
        }),
    ]);

    let bot_model = mock_model(&bot_server.endpoint);
    let cancel = CancellationToken::new();
    let tick1 = host
        .tick_foreground(&ws_id, &bot_model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick1.bot_turns_run, 1);

    let sid = spawned_sid.lock().unwrap().clone().expect("spawned sid");
    let plan_before = host
        .supervisor()
        .find_plan_by_session(&ws_id, &sid)
        .expect("plan");
    // Unauthorized model-invented `manual` must have been normalized to `model_review`!
    assert_eq!(plan_before["successCriteria"][1]["kind"], "model_review");

    host.supervisor().promote_queued(&ws_id, true).unwrap();

    let worker_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("w-read", "read_file", &json!({ "path": "readme.md" }))),
        Box::new(|_| sse_text("Opened PR #334 cleanly.")),
    ]);
    let verifier_server = start_mock_server(vec![
        Box::new(|_| sse_tool_call("v-read", "read_file", &json!({ "path": "readme.md" }))),
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
                .expect("Known Worker Evidence Refs");
            let known: Vec<String> =
                serde_json::from_str(line.trim_start_matches(marker).trim()).unwrap();
            let report = json!({
                "passed": true,
                "failedCriteria": [],
                "missingEvidence": [],
                "risks": [],
                "evidenceRefs": [known[0]],
                "summary": "Verified c1 and c2."
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

    let mut perm = AutoAllowPermission;
    host.run_promoted_session(
        &ws_id,
        &sid,
        &worker_model,
        Some(&verifier_model),
        &mut perm,
        8,
        &cancel,
    )
    .await
    .unwrap();

    // Wake turn delivers report via post_reply -> MUST auto-accept without asking user to confirm!
    let sid_for_reply = sid.clone();
    let wake_server = start_mock_server(vec![Box::new(move |_| {
        sse_tool_call(
            "wake-reply",
            "post_reply",
            &json!({
                "proactive": true,
                "sources": [sid_for_reply],
                "text": "PR #334 已创建并通过独立核验。"
            }),
        )
    })]);
    let wake_model = mock_model(&wake_server.endpoint);
    let tick2 = host
        .tick_foreground(&ws_id, &wake_model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick2.wake_turns_run, 1);

    let projected = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&ws_id),
        None,
        None,
        None,
        None,
    );
    let sess = projected
        .iter()
        .find(|s| s["sessionId"] == sid)
        .expect("projected session");
    assert_eq!(
        sess["status"], "accepted",
        "ordinary task under auto policy must auto-accept on post_reply, not wait for user confirmation"
    );
    assert_eq!(sess["followUp"]["owner"], "none");
    assert_eq!(sess["followUp"]["reason"], "settled");
    host.close();
}

#[tokio::test]
async fn cancel_session_retires_verification_failed_and_stale_cancelled_autonomously_on_wake() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "cancel test\n").unwrap();

    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, _profile) = host.bind_workspace(ws.path(), Some("CleanupBot")).unwrap();
    assert!(matches!(
        host.ensure_lease(&entry.workspace_id).unwrap(),
        LeaseStatus::Acquired { .. }
    ));
    let ws_id = entry.workspace_id.clone();

    let plans_dir = home.path().join("goal-plans");
    fs::create_dir_all(&plans_dir).unwrap();

    let vf_plan = json!({
        "planId": "plan-vf-cancel",
        "conversationId": "conv-vf-cancel",
        "title": "核验未通过待清理",
        "goal": "Test cancel",
        "status": "completed",
        "updatedAt": "2026-11-23T02:00:00.000Z",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-vf-cancel",
            "phase": "completed",
            "independentVerifier": "failed"
        },
        "verificationReport": {
            "passed": false,
            "error": "file_parent_unavailable"
        },
        "tasks": [{ "taskId": "t1", "status": "completed" }]
    });
    let stale_cancel_plan = json!({
        "planId": "plan-stale-cancel",
        "conversationId": "conv-stale-cancel",
        "title": "只读熟悉旧取消",
        "goal": "Legacy cancel without receipt",
        "status": "cancelled",
        "updatedAt": "2026-10-07T03:00:00.000Z",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-stale-cancel",
            "phase": "paused"
        },
        "runner": { "enabled": true, "status": "paused" },
        "tasks": []
    });
    let active_plan = json!({
        "planId": "plan-active-keep",
        "conversationId": "conv-active-keep",
        "title": "正在排队中的任务",
        "goal": "Active queued",
        "status": "accepted",
        "updatedAt": "2026-11-23T02:01:00.000Z",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-active-keep",
            "phase": "queued"
        },
        "tasks": [{ "taskId": "t1", "status": "pending" }]
    });
    let accepted_plan = json!({
        "planId": "plan-accepted-keep",
        "conversationId": "conv-accepted-keep",
        "title": "已签收任务",
        "goal": "Already accepted",
        "status": "completed",
        "updatedAt": "2026-11-23T02:02:00.000Z",
        "delegationOrigin": {
            "workspaceId": ws_id,
            "sessionId": "sess-accepted-keep",
            "phase": "accepted"
        },
        "resultAcceptance": {
            "acceptedAt": "2026-11-23T02:02:00.000Z",
            "acceptedBy": "policy"
        },
        "tasks": [{ "taskId": "t1", "status": "completed" }]
    });

    for p in [&vf_plan, &stale_cancel_plan, &active_plan, &accepted_plan] {
        let pid = p["planId"].as_str().unwrap();
        fs::write(
            plans_dir.join(format!("{pid}.json")),
            serde_json::to_string(p).unwrap(),
        )
        .unwrap();
    }
    fs::write(
        plans_dir.join("index.jsonl"),
        "{\"planId\":\"plan-vf-cancel\"}\n{\"planId\":\"plan-stale-cancel\"}\n{\"planId\":\"plan-active-keep\"}\n{\"planId\":\"plan-accepted-keep\"}\n",
    )
    .unwrap();

    // Before cancellation: both `vf` and `stale_cancel` are in current list and marked `cancelable: true`.
    let before = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&ws_id),
        None,
        None,
        None,
        None,
    );
    let vf_before = before
        .iter()
        .find(|s| s["sessionId"] == "sess-vf-cancel")
        .unwrap();
    assert_eq!(vf_before["followUp"]["inCurrentList"], true);
    assert_eq!(vf_before["followUp"]["reason"], "verification_failed");
    assert_eq!(vf_before["cancelable"], true);
    let stale_before = before
        .iter()
        .find(|s| s["sessionId"] == "sess-stale-cancel")
        .unwrap();
    assert_eq!(stale_before["followUp"]["inCurrentList"], true);
    assert_eq!(stale_before["followUp"]["reason"], "stop_unconfirmed");
    assert_eq!(stale_before["cancelable"], true);

    // Enqueue a wake event (NO user turn!) so the bot runs autonomously on a wake turn.
    host.inbox()
        .append(
            &ws_id,
            &[json!({
                "eventId": "ev-vf-wake-1",
                "kind": "report_available",
                "workspaceId": ws_id,
                "sessionId": "sess-vf-cancel",
                "at": "2026-11-23T02:05:00.000Z",
                "payload": { "planId": "plan-vf-cancel", "status": "completed" }
            })],
        )
        .unwrap();

    let wake_server = start_mock_server(vec![
        // Activate `session_ops` skill pack
        Box::new(|_| {
            sse_tool_call(
                "act-1",
                "activate_skill_pack",
                &json!({ "pack": "session_ops" }),
            )
        }),
        // Autonomously cancel `sess-vf-cancel` (verification_failed) on wake turn
        Box::new(|_| {
            sse_tool_call(
                "c-vf",
                "cancel_session",
                &json!({ "sessionId": "sess-vf-cancel", "reason": "核验未通过，清理无效任务" }),
            )
        }),
        // Autonomously settle `sess-stale-cancel` (stale stop_unconfirmed) on wake turn
        Box::new(|req| {
            let last_tool = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .and_then(|m| m["content"].as_str())
                .unwrap();
            assert!(
                last_tool.contains(r#""ok":true"#),
                "expected autonomous cancel of verification_failed session to succeed, got {last_tool}"
            );
            sse_tool_call(
                "c-stale",
                "cancel_session",
                &json!({ "sessionId": "sess-stale-cancel", "reason": "确认清理旧取消任务" }),
            )
        }),
        // Safety check: attempting to autonomously cancel an active queued task on a wake turn MUST still be denied!
        Box::new(|req| {
            let last_tool = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .and_then(|m| m["content"].as_str())
                .unwrap();
            assert!(
                last_tool.contains(r#""ok":true"#),
                "expected autonomous settle of stale cancelled session to succeed, got {last_tool}"
            );
            sse_tool_call(
                "c-active",
                "cancel_session",
                &json!({ "sessionId": "sess-active-keep", "reason": "should be blocked on wake" }),
            )
        }),
        // Confirm active queued cancel returned current_user_required, then post reply
        Box::new(|req| {
            let last_tool = req["messages"]
                .as_array()
                .unwrap()
                .iter()
                .rev()
                .find(|m| m["role"] == "tool")
                .and_then(|m| m["content"].as_str())
                .unwrap();
            assert!(
                last_tool.contains("current_user_required"),
                "active queued session must still require a user turn to cancel, got {last_tool}"
            );
            sse_tool_call(
                "wake-done",
                "post_reply",
                &json!({ "proactive": true, "text": "已清理 2 条无效任务。" }),
            )
        }),
    ]);

    let wake_model = mock_model(&wake_server.endpoint);
    let cancel = CancellationToken::new();
    let tick = host
        .tick_foreground(&ws_id, &wake_model, json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick.wake_turns_run, 1);

    // Already-accepted session must still refuse cancel with `session_already_completed`.
    let acc_err = host
        .supervisor()
        .control_session(&ws_id, "sess-accepted-keep", "cancel", "nope", true)
        .unwrap_err();
    assert_eq!(acc_err.code, "session_already_completed");

    // Verify both cleaned sessions left the current follow-up list cleanly.
    let after = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&ws_id),
        None,
        None,
        None,
        None,
    );
    for sid in ["sess-vf-cancel", "sess-stale-cancel"] {
        let s = after.iter().find(|r| r["sessionId"] == sid).unwrap();
        assert_eq!(s["status"], "cancelled");
        assert_eq!(s["followUp"]["inCurrentList"], false);
        assert_eq!(s["followUp"]["reason"], "stop_confirmed");
        let plan = host.supervisor().find_plan_by_session(&ws_id, sid).unwrap();
        assert_eq!(
            plan["delegationOrigin"]["cancellation"]["initiator"],
            "project_agent"
        );
        assert!(plan["delegationOrigin"]["cancellation"]["disposition"].is_null());
        assert_eq!(s["cancelable"], false);
    }
    host.close();
}

fn spawn_autonomy_fixture(
    host: &NativeProjectHost,
    workspace_id: &str,
    parent_id: &str,
    workspace_path: &std::path::Path,
) -> peer_project_agent::WorkSessionSummary {
    host.submit_user_input(
        workspace_id,
        "auto-input",
        "Check the project readme.",
        None,
    )
    .unwrap();
    host.inputs()
        .consume(workspace_id, parent_id, host.conversations(), true)
        .unwrap();
    host.inputs()
        .mark_executed(workspace_id, &["auto-input".to_owned()], &[], true)
        .unwrap();
    host.supervisor()
        .spawn_session(
            SpawnSessionRequest {
                workspace_id: workspace_id.into(),
                workspace_path: workspace_path.into(),
                parent_conversation_id: parent_id.into(),
                anchor_message_ids: vec![input_message_id("auto-input").unwrap()],
                input_id: "auto-input".into(),
                surface: "desktop".into(),
                title: "Check the readme".into(),
                brief: "Check whether readme.md exists.".into(),
                kind: "research".into(),
                read_only: true,
                required_capabilities: vec!["local.file.read".into()],
                success_criteria: vec![SpawnCriterion {
                    id: Some("readme".into()),
                    kind: "file-exists".into(),
                    description: "readme.md exists".into(),
                    path: Some("readme.md".into()),
                    expect: None,
                    command: None,
                }],
                priority: "normal".into(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "auto".into(),
                worker_model_selection: json!({}),
            },
            true,
        )
        .unwrap()
}

fn latest_autonomy_tool_result(req: &Value) -> &str {
    req["messages"]
        .as_array()
        .unwrap()
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")
        .and_then(|m| m["content"].as_str())
        .unwrap()
}

#[tokio::test]
async fn autonomy_wake_retry_inherits_scope_retires_predecessor_and_promotes_immediately() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("RetryBot")).unwrap();
    let ws_id = entry.workspace_id;
    host.ensure_lease(&ws_id).unwrap();
    let old = spawn_autonomy_fixture(
        &host,
        &ws_id,
        &profile.agent_conversation_id.unwrap(),
        ws.path(),
    );
    host.supervisor()
        .fail_session(&ws_id, &old.session_id, "model_timeout", "fixture", true)
        .unwrap();
    let sid = old.session_id.clone();
    let same_sid = sid.clone();
    let repeated_sid = sid.clone();
    let retired_sid = sid.clone();
    let replacement = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let observed = replacement.clone();

    let wake = start_mock_server(vec![
        Box::new(move |_| {
            sse_tool_call(
                "escalate",
                "spawn_session",
                &json!({
                    "supersedes": sid, "readOnly": false
                }),
            )
        }),
        Box::new(move |req| {
            assert!(latest_autonomy_tool_result(req).contains("retry_capability_escalation"));
            sse_tool_call("retry", "spawn_session", &json!({"supersedes": same_sid}))
        }),
        Box::new(move |req| {
            let result: Value = serde_json::from_str(latest_autonomy_tool_result(req)).unwrap();
            assert_eq!(result["autoRetryCount"], 1, "{result}");
            *observed.lock().unwrap() = result["sessionId"].as_str().unwrap().to_owned();
            sse_tool_call(
                "duplicate-retry",
                "spawn_session",
                &json!({"supersedes": repeated_sid}),
            )
        }),
        Box::new(move |req| {
            assert!(latest_autonomy_tool_result(req).contains("session_already_superseded"));
            sse_tool_call(
                "ops-pack",
                "activate_skill_pack",
                &json!({"pack":"session_ops"}),
            )
        }),
        Box::new(move |_| {
            sse_tool_call(
                "retired-cleanup",
                "cancel_session",
                &json!({"sessionId":retired_sid,"reason":"Already replaced by the host"}),
            )
        }),
        Box::new(move |req| {
            assert!(latest_autonomy_tool_result(req).contains(r#""ok":true"#));
            sse_tool_call(
                "wait-retry",
                "wait_for_sessions",
                &json!({"sessionIds": [replacement.lock().unwrap().as_str()]}),
            )
        }),
    ]);
    let cancel = CancellationToken::new();
    let tick = host
        .tick_foreground(&ws_id, &mock_model(&wake.endpoint), json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick.promoted_session_ids.len(), 1);
    let new_sid = &tick.promoted_session_ids[0];
    let new = host
        .supervisor()
        .find_plan_by_session(&ws_id, new_sid)
        .unwrap();
    let previous = host.supervisor().read_plan(&old.plan_id).unwrap();
    assert_eq!(previous["delegationOrigin"]["supersededBy"], *new_sid);
    assert_eq!(previous["status"], "failed");
    assert!(previous["delegationOrigin"]["cancellation"].is_null());
    for key in [
        "readOnly",
        "requiredCapabilities",
        "inputId",
        "anchorMessageIds",
        "parentConversationId",
        "isolation",
        "dependsOn",
    ] {
        assert_eq!(
            new["delegationOrigin"][key],
            previous["delegationOrigin"][key]
        );
    }
    assert_eq!(new["successCriteria"], previous["successCriteria"]);
    assert_eq!(new["deliveryBinding"], previous["deliveryBinding"]);
    let projected = peer_project_agent::list_sessions_projected(
        home.path(),
        Some(&ws_id),
        None,
        None,
        None,
        None,
    );
    let old_row = projected
        .iter()
        .find(|s| s["sessionId"] == old.session_id)
        .unwrap();
    assert_eq!(old_row["followUp"]["reason"], "superseded");
    assert_eq!(old_row["followUp"]["inCurrentList"], false);
    host.supervisor()
        .fail_session(
            &ws_id,
            new_sid,
            "model_timeout",
            "second fixture failure",
            true,
        )
        .unwrap();
    let second_sid = new_sid.clone();
    let wake_twice = start_mock_server(vec![
        Box::new(move |_| {
            sse_tool_call(
                "retry-twice",
                "spawn_session",
                &json!({"supersedes": second_sid}),
            )
        }),
        Box::new(|req| {
            let result: Value = serde_json::from_str(latest_autonomy_tool_result(req)).unwrap();
            assert_eq!(result["autoRetryCount"], 2, "{result}");
            sse_tool_call(
                "wait-retry-twice",
                "wait_for_sessions",
                &json!({"sessionIds": [result["sessionId"]]}),
            )
        }),
    ]);
    let tick = host
        .tick_foreground(
            &ws_id,
            &mock_model(&wake_twice.endpoint),
            json!({}),
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(tick.promoted_session_ids.len(), 1);
    let third_sid = tick.promoted_session_ids[0].clone();
    host.supervisor()
        .fail_session(
            &ws_id,
            &third_sid,
            "model_timeout",
            "third fixture failure",
            true,
        )
        .unwrap();
    let capped = start_mock_server(vec![
        Box::new(move |_| {
            sse_tool_call("limit", "spawn_session", &json!({"supersedes": third_sid}))
        }),
        Box::new(|req| {
            assert!(latest_autonomy_tool_result(req).contains("auto_retry_limit_exceeded"));
            sse_tool_call(
                "limit-reply",
                "post_reply",
                &json!({"proactive": true, "text": "The automatic retry limit was reached."}),
            )
        }),
    ]);
    let tick = host
        .tick_foreground(&ws_id, &mock_model(&capped.endpoint), json!({}), &cancel)
        .await
        .unwrap();
    assert!(tick.promoted_session_ids.is_empty());
    assert_eq!(host.supervisor().list_sessions(&ws_id).len(), 3);
    host.close();
}

#[tokio::test]
async fn autonomy_worker_technical_question_wakes_parent_and_continues_same_conversation() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "readme").unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("AnswerBot")).unwrap();
    let ws_id = entry.workspace_id;
    let parent_id = profile.agent_conversation_id.unwrap();
    host.ensure_lease(&ws_id).unwrap();
    let child = spawn_autonomy_fixture(&host, &ws_id, &parent_id, ws.path());
    let sid = &child.session_id;
    host.supervisor().promote_queued(&ws_id, true).unwrap();
    let worker = start_mock_server(vec![
        Box::new(|req| {
            assert!(tool_names_from_request(req).contains(&"request_parent_input".to_string()));
            sse_tool_call(
                "ask-parent",
                "request_parent_input",
                &json!({
                    "question": "Which readme should I inspect?"
                }),
            )
        }),
        Box::new(|req| {
            assert!(req["messages"].to_string().contains("Use root readme.md"));
            sse_text("Root readme.md exists.")
        }),
    ]);
    let worker_model = mock_model(&worker.endpoint);
    let cancel = CancellationToken::new();
    let mut permission = AutoAllowPermission;
    let episode = host
        .run_promoted_session(
            &ws_id,
            sid,
            &worker_model,
            None,
            &mut permission,
            8,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(episode.status, "waiting_agent");
    let waiting = host.supervisor().read_plan(&child.plan_id).unwrap();
    let worker_conv = waiting["delegationOrigin"]["workerConversationId"].clone();
    let sid_to_answer = sid.clone();
    let sid_to_wait = sid.clone();
    let wake = start_mock_server(vec![
        Box::new(|req| {
            assert!(
                req["messages"]
                    .to_string()
                    .contains("Which readme should I inspect?")
            );
            sse_tool_call(
                "ops-pack",
                "activate_skill_pack",
                &json!({"pack": "session_ops"}),
            )
        }),
        Box::new(move |_| {
            sse_tool_call(
                "answer-worker",
                "message_session",
                &json!({
                    "sessionId": sid_to_answer, "intent": "answer", "text": "Use root readme.md"
                }),
            )
        }),
        Box::new(move |req| {
            let result = latest_autonomy_tool_result(req);
            assert!(result.contains(r#""ok":true"#), "{result}");
            sse_tool_call(
                "wait-answer",
                "wait_for_sessions",
                &json!({"sessionIds": [sid_to_wait]}),
            )
        }),
    ]);
    let tick = host
        .tick_foreground(&ws_id, &mock_model(&wake.endpoint), json!({}), &cancel)
        .await
        .unwrap();
    assert_eq!(tick.promoted_session_ids, vec![sid.clone()]);
    let episode = host
        .run_promoted_session(
            &ws_id,
            sid,
            &worker_model,
            None,
            &mut permission,
            8,
            &cancel,
        )
        .await
        .unwrap();
    assert_eq!(episode.status, "completed");
    let completed = host.supervisor().read_plan(&child.plan_id).unwrap();
    assert_eq!(
        completed["delegationOrigin"]["workerConversationId"],
        worker_conv
    );
    assert_eq!(
        completed["delegationOrigin"]["lastAnsweredAgentWaitMessageId"],
        waiting["delegationOrigin"]["agentWaitMessageId"]
    );
    assert!(completed["delegationOrigin"]["agentWaitMessageId"].is_null());
    assert_eq!(completed["delegationOrigin"]["workerTurnsUsed"], 2);
    host.close();
}

#[tokio::test]
async fn autonomy_wake_reverification_runs_readonly_role_and_auto_accepts_after_reporting() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    fs::write(ws.path().join("readme.md"), "readme").unwrap();
    fs::write(
        home.path().join("settings.json"),
        json!({
            "schemaVersion": 3,
            "projectAgent": { "shell": "bots", "managedRoot": ws.path().join("managed") }
        })
        .to_string(),
    )
    .unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("ReverifyBot")).unwrap();
    let ws_id = entry.workspace_id;
    host.ensure_lease(&ws_id).unwrap();
    let child = spawn_autonomy_fixture(
        &host,
        &ws_id,
        &profile.agent_conversation_id.unwrap(),
        ws.path(),
    );
    let sid = &child.session_id;
    host.supervisor().promote_queued(&ws_id, true).unwrap();
    let worker = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "bad-args",
                "read_file",
                &json!({"path":"readme.md","invalid_option":true}),
            )
        }),
        Box::new(|req| {
            assert!(latest_autonomy_tool_result(req).contains("tool_arguments_invalid"));
            sse_tool_call("corrected-args", "read_file", &json!({"path":"readme.md"}))
        }),
        Box::new(|req| {
            assert!(latest_autonomy_tool_result(req).contains("readme"));
            sse_text("Root readme exists.")
        }),
    ]);
    let failed = start_mock_server(vec![Box::new(|_| {
        sse_text(
            r#"{"passed":false,"failedCriteria":[],"missingEvidence":[],"risks":[],"evidenceRefs":[],"summary":"Temporary verifier failure"}"#,
        )
    })]);
    let cancel = CancellationToken::new();
    host.run_promoted_session(
        &ws_id,
        sid,
        &mock_model(&worker.endpoint),
        Some(&mock_model(&failed.endpoint)),
        &mut AutoAllowPermission,
        8,
        &cancel,
    )
    .await
    .unwrap();
    let initial = host.supervisor().read_plan(&child.plan_id).unwrap();
    assert_eq!(initial["delegationOrigin"]["independentVerifier"], "failed");
    let verified_response = |req: &Value| {
        let tools = tool_names_from_request(req);
        assert!(tools.contains(&"read_file".to_string()));
        assert!(!tools.iter().any(|tool| matches!(
            tool.as_str(),
            "run_command" | "write_file" | "request_parent_input"
        )));
        let prompt = req["messages"]
            .as_array()
            .unwrap()
            .iter()
            .find(|msg| {
                msg["role"] == "user"
                    && msg["content"]
                        .as_str()
                        .is_some_and(|s| s.contains("Check the root"))
            })
            .unwrap()["content"]
            .as_str()
            .unwrap();
        let known: Vec<String> = serde_json::from_str(
            prompt
                .lines()
                .find_map(|l| l.strip_prefix("Known Worker Evidence Refs: "))
                .unwrap(),
        )
        .unwrap();
        sse_text(&json!({"passed": true, "failedCriteria": [], "missingEvidence": [], "risks": [], "evidenceRefs": [known[0]], "summary": "Readme verified"}).to_string())
    };
    let verifier = start_mock_server(vec![
        Box::new(verified_response),
        Box::new(verified_response),
    ]);
    let sid_to_verify = sid.clone();
    let sid_to_verify_again = sid.clone();
    let sid_to_test_limit = sid.clone();
    let sid_to_report = sid.clone();
    let wake = start_mock_server(vec![
        Box::new(|_| {
            sse_tool_call(
                "ops-pack",
                "activate_skill_pack",
                &json!({"pack": "session_ops"}),
            )
        }),
        Box::new(move |_| {
            sse_tool_call(
                "reverify",
                "verify_session",
                &json!({
                    "sessionId": sid_to_verify, "focus": "Check the root"
                }),
            )
        }),
        Box::new(move |req| {
            let result: Value = serde_json::from_str(latest_autonomy_tool_result(req)).unwrap();
            assert_eq!(result["reverified"], true, "{result}");
            assert_eq!(result["verifierRunCount"], 2);
            assert_eq!(result["verificationReport"]["passed"], true);
            sse_tool_call(
                "reverify-again",
                "verify_session",
                &json!({
                    "sessionId":sid_to_verify_again, "focus":"Check the root again"
                }),
            )
        }),
        Box::new(move |req| {
            let result: Value = serde_json::from_str(latest_autonomy_tool_result(req)).unwrap();
            assert_eq!(result["verifierRunCount"], 3, "{result}");
            sse_tool_call(
                "reverify-over-limit",
                "verify_session",
                &json!({
                    "sessionId":sid_to_test_limit, "force":true
                }),
            )
        }),
        Box::new(move |req| {
            assert!(latest_autonomy_tool_result(req).contains("reverify_limit_exceeded"));
            sse_tool_call(
                "verified-reply",
                "post_reply",
                &json!({
                    "proactive": true, "sources": [sid_to_report], "text": "The readme was verified."
                }),
            )
        }),
    ]);
    host.tick_foreground_with_verifier(
        &ws_id,
        &mock_model(&wake.endpoint),
        Some(&mock_model(&verifier.endpoint)),
        json!({}),
        &cancel,
    )
    .await
    .unwrap();
    let completed = host.supervisor().read_plan(&child.plan_id).unwrap();
    assert_eq!(completed["runner"]["verifierRuns"][0]["status"], "failed");
    assert_eq!(completed["runner"]["verifierRuns"][1]["status"], "passed");
    assert_eq!(completed["runner"]["verifierRuns"][2]["status"], "passed");
    assert_eq!(
        completed["runner"]["verifierRuns"]
            .as_array()
            .unwrap()
            .len(),
        3
    );
    assert!(
        completed["resultAcceptance"]["acceptedAt"].is_string(),
        "{completed}"
    );
    host.close();
}

#[tokio::test]
async fn autonomy_resume_only_continues_host_confirmed_technical_interruptions() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("ResumeBot")).unwrap();
    let ws_id = entry.workspace_id;
    host.ensure_lease(&ws_id).unwrap();
    let child = spawn_autonomy_fixture(
        &host,
        &ws_id,
        &profile.agent_conversation_id.unwrap(),
        ws.path(),
    );
    let sid = &child.session_id;
    let supervisor = host.supervisor();
    supervisor.promote_queued(&ws_id, true).unwrap();
    let worker = start_mock_server(vec![
        Box::new(|_| sse_text("First episode checkpoint.")),
        Box::new(|req| {
            assert!(
                req["messages"]
                    .to_string()
                    .contains("First episode checkpoint.")
            );
            sse_text("Continued the original work.")
        }),
    ]);
    let worker_model = mock_model(&worker.endpoint);
    let cancel = CancellationToken::new();
    let mut perm = AutoAllowPermission;
    host.run_promoted_session(&ws_id, sid, &worker_model, None, &mut perm, 8, &cancel)
        .await
        .unwrap();
    let checkpoint = supervisor.read_plan(&child.plan_id).unwrap();
    let worker_conv = checkpoint["delegationOrigin"]["workerConversationId"].clone();
    let set_interrupted = |origin: &str, count: u64, blocked_reason: Option<&str>| {
        let mut interrupted = checkpoint.clone();
        interrupted["status"] = json!("interrupted");
        interrupted["delegationOrigin"]["phase"] = json!("paused");
        interrupted["delegationOrigin"]["autoResumeCount"] = json!(count);
        interrupted["runner"] = json!({
            "status":"paused",
            "interruption":{"source":"stream_error","origin":origin,"reason":"model_timeout","recoverable":true,"interruptedAt":peer_project_agent::now_iso()}
        });
        if blocked_reason == Some("worker_budget_exhausted") {
            interrupted["delegationOrigin"]["workerTurnsUsed"] =
                interrupted["delegationOrigin"]["workerTurnLimit"].clone();
        } else if let Some(reason) = blocked_reason.filter(|reason| *reason != "open_approval") {
            interrupted["runner"]["blockedReason"] = json!(reason);
        }
        supervisor.save_plan_json(&interrupted).unwrap();
        host.inbox()
            .append(
                &ws_id,
                &[json!({
                    "eventId":format!("resume-{origin}-{count}-{blocked_reason:?}"),
                    "kind":"session_ended",
                    "sessionId":sid,
                    "at":peer_project_agent::now_iso(),
                    "payload":{"status":"interrupted"}
                })],
            )
            .unwrap();
    };

    for (origin, count, blocked_reason, expected_error) in [
        ("user", 0, None, Some("current_user_required")),
        (
            "provider",
            0,
            Some("open_approval"),
            Some("current_user_required"),
        ),
        (
            "provider",
            0,
            Some("execution_outcome_unknown"),
            Some("current_user_required"),
        ),
        (
            "provider",
            0,
            Some("manual_dod_confirmation_required"),
            Some("current_user_required"),
        ),
        (
            "provider",
            0,
            Some("worker_budget_exhausted"),
            Some("worker_budget_exhausted"),
        ),
        ("provider", 2, None, Some("auto_resume_limit_exceeded")),
        ("provider", 1, None, None),
    ] {
        set_interrupted(origin, count, blocked_reason);
        let approval = (blocked_reason == Some("open_approval")).then(|| {
            host.approvals()
                .open(
                    &peer_store::HostApproval {
                        approval_id: "blocked-resume-approval",
                        workspace_id: Some(&ws_id),
                        conversation_id: worker_conv.as_str().unwrap(),
                        stream_id: "blocked-resume-stream",
                        plan_id: Some(&child.plan_id),
                        session_id: Some(sid),
                        capability_id: "local.file.write",
                        args_digest: &"a".repeat(64),
                        policy_revision: "1",
                        created_at: &peer_project_agent::now_iso(),
                        deadline_at: None,
                    },
                    None,
                )
                .unwrap()
        });
        let resume_sid = sid.clone();
        let wait_sid = sid.clone();
        let wake = start_mock_server(vec![
            Box::new(|_| {
                sse_tool_call(
                    "ops-pack",
                    "activate_skill_pack",
                    &json!({"pack":"session_ops"}),
                )
            }),
            Box::new(move |_| {
                sse_tool_call(
                    "resume-tech",
                    "resume_session",
                    &json!({"sessionId":resume_sid}),
                )
            }),
            Box::new(move |req| {
                let result = latest_autonomy_tool_result(req);
                if let Some(error) = expected_error {
                    assert!(result.contains(error), "{result}");
                    sse_tool_call(
                        "explain-rejection",
                        "post_reply",
                        &json!({"proactive":true,"text":format!("Recovery stopped at {error}.")}),
                    )
                } else {
                    assert!(result.contains(r#""ok":true"#), "{result}");
                    sse_tool_call(
                        "wait-resume",
                        "wait_for_sessions",
                        &json!({"sessionIds":[wait_sid]}),
                    )
                }
            }),
        ]);
        let tick = host
            .tick_foreground(&ws_id, &mock_model(&wake.endpoint), json!({}), &cancel)
            .await
            .unwrap();
        if expected_error.is_some() {
            assert!(tick.promoted_session_ids.is_empty());
        } else {
            assert_eq!(tick.promoted_session_ids, vec![sid.clone()]);
        }
        if let Some(approval) = approval {
            host.approvals()
                .decide(
                    &approval,
                    ApprovalState::Denied,
                    peer_store::ApprovalDecision::LocalUser,
                    &peer_project_agent::now_iso(),
                    Some("local_user_denied"),
                    None,
                )
                .unwrap();
        }
    }
    let started = supervisor.read_plan(&child.plan_id).unwrap();
    assert_eq!(started["delegationOrigin"]["autoResumeCount"], 2);
    assert!(started["runner"]["interruption"].is_null());
    let episode = host
        .run_promoted_session(&ws_id, sid, &worker_model, None, &mut perm, 8, &cancel)
        .await
        .unwrap();
    assert_eq!(episode.status, "completed");
    assert_eq!(
        supervisor.read_plan(&child.plan_id).unwrap()["delegationOrigin"]["workerConversationId"],
        worker_conv
    );
    host.close();
}

#[tokio::test]
async fn gemini_main_bot_uses_parameters_json_schema_thinking_level_and_coalesces_long_thought_stream() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("GeminiBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    let input_id = "in-gemini-1";
    let anchor = input_message_id(input_id).unwrap();
    host.submit_user_input(&entry.workspace_id, input_id, "Write a Gemini plan", None)
        .unwrap();

    let captured = Arc::new(Mutex::new(Vec::<Value>::new()));
    let captured_ref = Arc::clone(&captured);
    let anchor_for_reply = anchor.clone();
    let server = start_mock_server(vec![Box::new(move |req: &Value| {
        captured_ref.lock().unwrap().push(req.clone());
        let mut sse = String::new();
        // >128 thought chunks plus signature-only part would previously hit model_continuation_limit / model_block_unsupported.
        for _ in 0..140 {
            sse.push_str(
                "data: {\"candidates\":[{\"index\":0,\"content\":{\"parts\":[{\"text\":\"step \",\"thought\":true}]}}]}\n\n",
            );
        }
        sse.push_str(
            "data: {\"candidates\":[{\"index\":0,\"content\":{\"parts\":[{\"thoughtSignature\":\"sig-thought\",\"thought\":true}]}}]}\n\n",
        );
        let call_chunk = json!({
            "candidates": [{
                "index": 0,
                "content": {
                    "parts": [{
                        "functionCall": {
                            "name": "post_reply",
                            "args": {
                                "replyTo": [anchor_for_reply],
                                "text": "Gemini reply committed cleanly."
                            }
                        },
                        "thoughtSignature": "sig-call"
                    }]
                },
                "finishReason": "STOP"
            }],
            "usageMetadata": {
                "promptTokenCount": 42,
                "candidatesTokenCount": 18,
                "thoughtsTokenCount": 30,
                "totalTokenCount": 90
            }
        });
        sse.push_str(&format!("data: {call_chunk}\n\n"));
        sse
    })]);

    let model = NativeModel::new(
        ModelConfig {
            endpoint: format!(
                "{}/v1beta/models/gemini-4-hydrogen:streamGenerateContent?alt=sse",
                server.endpoint.trim_end_matches("/chat/completions")
            ),
            model: "gemini-4-hydrogen".to_owned(),
            provider: "google-ai".to_owned(),
            wire: Wire::Gemini,
            generation: peer_runtime::model::wire::GenerationOptions {
                supports_reasoning: true,
                effort: "xhigh".to_owned(),
                ..peer_runtime::model::wire::GenerationOptions::default()
            },
        },
        None,
        Duration::from_secs(10),
    )
    .unwrap();

    let mut perm = AutoAllowPermission;
    let cancel = CancellationToken::new();
    let tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert!(
        matches!(
            tick.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::ReplyCommitted { .. })
        ),
        "expected Gemini ReplyCommitted, got {:?}",
        tick.last_turn.as_ref().map(|t| &t.end)
    );

    let reqs = captured.lock().unwrap();
    assert_eq!(reqs.len(), 1);
    let body = &reqs[0];
    assert_eq!(
        body["generationConfig"]["thinkingConfig"],
        json!({"thinkingLevel": "xhigh", "includeThoughts": true})
    );
    let decls = body["tools"][0]["functionDeclarations"]
        .as_array()
        .expect("Gemini functionDeclarations");
    assert!(!decls.is_empty());
    // No declaration may pass `additionalProperties` inside legacy `parameters`.
    for decl in decls {
        if let Some(legacy_params) = decl.get("parameters") {
            let serialized = legacy_params.to_string();
            assert!(
                !serialized.contains("\"additionalProperties\""),
                "legacy Gemini `parameters` must never contain additionalProperties: {decl}"
            );
        } else {
            assert!(
                decl["parametersJsonSchema"].is_object(),
                "expected parametersJsonSchema on declaration: {decl}"
            );
        }
    }
    let spawn_decl = decls
        .iter()
        .find(|d| d["name"] == "spawn_session")
        .expect("spawn_session declaration");
    assert!(spawn_decl.get("parameters").is_none());
    assert!(spawn_decl["parametersJsonSchema"].is_object());
    assert!(spawn_decl["parametersJsonSchema"].get("anyOf").is_none());

    let reply = host
        .find_reply_for_input(&entry.workspace_id, input_id)
        .unwrap()
        .expect("committed reply");
    assert_eq!(reply["content"], "Gemini reply committed cleanly.");
    assert!(!conv_id.is_empty());
}

#[tokio::test]
async fn open_circuit_blocks_stale_user_input_repolls_and_surfaces_http_400_detail() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("BreakerBot")).unwrap();
    let conv_id = profile.agent_conversation_id.unwrap();

    host.submit_user_input(&entry.workspace_id, "in-400-1", "Trigger 400", None)
        .unwrap();

    let gemini_400_body = json!([{
        "error": {
            "code": 400,
            "message": "Invalid JSON payload received. Unknown name \"additionalProperties\".",
            "status": "INVALID_ARGUMENT"
        }
    }])
    .to_string();

    let mut handlers = Vec::new();
    for _ in 0..5 {
        let body = gemini_400_body.clone();
        handlers.push(Box::new(move |_req: &Value| {
            (400u16, "application/json", body.clone())
        }) as HttpScriptHandler);
    }
    let server = start_http_mock_server(handlers);
    let model = mock_model(&server.endpoint);
    let mut perm = AutoAllowPermission;
    let cancel = CancellationToken::new();

    // First 5 ticks trip the circuit breaker (failures 1..=5).
    for i in 1..=5 {
        let tick = host
            .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
            .await
            .unwrap();
        assert!(
            matches!(
                tick.last_turn.as_ref().map(|t| &t.end),
                Some(TurnEndKind::Failed { code }) if code == "model_http_rejected"
            ),
            "tick {i}: expected model_http_rejected, got {:?}",
            tick.last_turn.as_ref().map(|t| &t.end)
        );
    }

    let msgs_before = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let first_card = msgs_before
        .iter()
        .find(|m| m["card"] == "agent_unavailable")
        .expect("agent_unavailable card");
    let card_content = first_card["content"].as_str().unwrap_or("");
    assert!(
        card_content.contains("HTTP 400 (model_http_rejected): INVALID_ARGUMENT:"),
        "expected HTTP 400 diagnostic detail in card content, got: {card_content}"
    );
    assert_eq!(first_card["meta"]["httpStatus"], 400);

    let cards_before = msgs_before
        .iter()
        .filter(|m| m["card"] == "agent_unavailable")
        .count();
    assert_eq!(cards_before, 5);

    // 6th tick re-polling the SAME already-consumed failed input must be blocked by the open
    // circuit breaker (0 HTTP calls, 0 extra cards), NOT bypassed as a manual trial.
    let blocked_tick = host
        .tick(&entry.workspace_id, &model, json!({}), &mut perm, &cancel)
        .await
        .unwrap();
    assert!(
        matches!(
            blocked_tick.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::CircuitOpen)
        ),
        "expected open circuit to block stale user input repoll, got {:?}",
        blocked_tick.last_turn.as_ref().map(|t| &t.end)
    );
    let msgs_after = host
        .conversations()
        .read_committed(&conv_id, None, 4 * 1024 * 1024)
        .unwrap()
        .history
        .messages;
    let cards_after = msgs_after
        .iter()
        .filter(|m| m["card"] == "agent_unavailable")
        .count();
    assert_eq!(cards_after, 5, "blocked tick must not append duplicate error cards");

    // Submitting a brand-new user message while an older failed input is still pending must
    // admit a manual half-open trial instead of silently stopping on CircuitOpen.
    host.submit_user_input(&entry.workspace_id, "in-400-2", "?", None)
        .unwrap();
    let anchor_1 = input_message_id("in-400-1").unwrap();
    let anchor_2 = input_message_id("in-400-2").unwrap();
    let recovery_server = start_mock_server(vec![
        Box::new(move |_req| {
            sse_tool_call(
                "rec-call-1",
                "post_reply",
                &json!({"replyTo": [anchor_1], "text": "Recovered first pending input."}),
            )
        }),
        Box::new(move |_req| {
            sse_tool_call(
                "rec-call-2",
                "post_reply",
                &json!({"replyTo": [anchor_2], "text": "Answered follow-up question."}),
            )
        }),
    ]);
    let recovery_model = mock_model(&recovery_server.endpoint);
    let recovery_tick = host
        .tick(
            &entry.workspace_id,
            &recovery_model,
            json!({}),
            &mut perm,
            &cancel,
        )
        .await
        .unwrap();
    assert!(
        matches!(
            recovery_tick.last_turn.as_ref().map(|t| &t.end),
            Some(TurnEndKind::ReplyCommitted { .. })
        ),
        "fresh user input must trigger manual half-open trial and recover, got {:?}",
        recovery_tick.last_turn.as_ref().map(|t| &t.end)
    );
    assert_eq!(recovery_tick.bot_turns_run, 2);
}
