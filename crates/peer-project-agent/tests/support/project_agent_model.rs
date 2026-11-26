//! Local SSE and project fixtures shared by Rust unit and integration tests.

use peer_project_agent::{
    NativeProjectHost, SpawnCriterion, SpawnSessionRequest, input_message_id,
};
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
    session_host::{LocalPermissionDecision, PermissionInput},
};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    io::{Read, Write},
    net::TcpListener,
    sync::{Arc, Mutex},
    time::Duration,
};

pub(crate) struct AutoAllowPermission;

impl PermissionInput for AutoAllowPermission {
    fn decide<'a>(
        &'a mut self,
        _prompt: Value,
        _cancel: &'a CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async { LocalPermissionDecision::Approve })
    }
}

pub(crate) type ScriptHandler = Box<dyn Fn(&Value) -> String + Send>;
pub(crate) type HttpScriptHandler = Box<dyn Fn(&Value) -> (u16, &'static str, String) + Send>;

pub(crate) struct MockModelServer {
    pub(crate) endpoint: String,
    pub(crate) requests: Arc<Mutex<Vec<Value>>>,
    _thread: std::thread::JoinHandle<()>,
}

pub(crate) fn sse_tool_call(id: &str, name: &str, args: &Value) -> String {
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

pub(crate) fn sse_text(text: &str) -> String {
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

pub(crate) fn start_http_mock_server(handlers: Vec<HttpScriptHandler>) -> MockModelServer {
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

pub(crate) fn start_mock_server(handlers: Vec<ScriptHandler>) -> MockModelServer {
    let wrapped = handlers
        .into_iter()
        .map(|h| {
            Box::new(move |req: &Value| (200u16, "text/event-stream", h(req))) as HttpScriptHandler
        })
        .collect();
    start_http_mock_server(wrapped)
}

pub(crate) fn mock_model_with_wire(endpoint: &str, wire: Wire) -> NativeModel {
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

pub(crate) fn mock_model(endpoint: &str) -> NativeModel {
    mock_model_with_wire(endpoint, Wire::Chat)
}

pub(crate) fn extract_spawned_session_id(req: &Value) -> Option<String> {
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

pub(crate) fn last_tool_result_json(req: &Value) -> Option<Value> {
    let raw = req["messages"]
        .as_array()?
        .iter()
        .rev()
        .find(|m| m["role"] == "tool")?["content"]
        .as_str()?;
    serde_json::from_str(raw).ok()
}

pub(crate) struct StubBridge;
impl peer_project_agent::InteractiveContentBridge for StubBridge {
    fn validate_draft(
        &self,
        draft: Value,
        bindings: Value,
        _cancel: CancellationToken,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Value, peer_project_agent::InteractiveValidationError>,
                > + Send,
        >,
    > {
        Box::pin(async move {
            Ok(json!({
                "schemaVersion": 1,
                "libraryVersion": "peer-basic-1",
                "title": draft["title"],
                "textFallback": draft["textFallback"],
                "program": draft["program"],
                "specHash": "sha256:37505cc28779ca4e18facf09edb86db7a01a64d58b0acc22841b168707dc3d24",
                "stateSchemaHash": "sha256:44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a",
                "stateSchema": {},
                "initialValues": {},
                "bindings": bindings,
            }))
        })
    }

    fn evaluate_content(
        &self,
        _content: Value,
        _values: Value,
        _cancel: CancellationToken,
    ) -> std::pin::Pin<
        Box<
            dyn std::future::Future<
                    Output = Result<Value, peer_project_agent::InteractiveValidationError>,
                > + Send,
        >,
    > {
        Box::pin(
            async move { Ok(json!({ "projection": { "text": "metric=99", "truncated": false } })) },
        )
    }

    fn catalog_prompt(&self) -> Option<String> {
        Some("Peer interactive catalog stub".to_owned())
    }
}

pub(crate) fn spawn_autonomy_fixture(
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

pub(crate) fn spawn_readme_for_natural_reply() -> String {
    sse_tool_call(
        "spawn-readme",
        "spawn_session",
        &json!({
            "title": "Inspect README",
            "brief": "Read README.md",
            "kind": "research",
            "readOnly": true,
            "capabilityPreset": "read_only",
            "successCriteria": [{"kind": "file-exists", "path": "README.md", "description": "README exists"}]
        }),
    )
}
