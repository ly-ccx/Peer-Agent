//! Non-Goal Host seam over actual ConversationStore and model HTTP sockets.
//! This Host is a test adapter, not the product ordinary-session executor.
use super::*;
use crate::model::{
    ModelConfig,
    wire::{GenerationOptions, Wire},
};
use crate::usage_accounting::RequestMetadata;
use peer_protocol::UsagePurpose;
use peer_store::NewConversation;
use sha2::{Digest, Sha256};
use std::{
    cell::Cell,
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

struct Host {
    home: std::path::PathBuf,
    conversation: String,
    valid: Cell<bool>,
    admitted: usize,
    waits: usize,
    revoke_after_wait: bool,
    cancel_after_wait: bool,
    mutate_after_wait: bool,
}
impl CognitionHost for Host {
    fn authority(&self) -> Result<(), HostError> {
        if self.valid.get() {
            Ok(())
        } else {
            Err(HostError("test_authority_changed"))
        }
    }
    fn check_request(&self) -> Result<(), HostError> {
        Ok(())
    }
    fn admit_request(&mut self) -> Result<(), HostError> {
        self.admitted += 1;
        Ok(())
    }
    fn assemble(&self, continuity: &[Value]) -> Result<Value, HostError> {
        // An explicitly synthetic registered-Source result. The common pipeline
        // has no Goal source to fall back to and cannot invent one for this Host.
        Ok(
            json!({"rendered":"Synthetic Context Source: no Goal or capability grant.",
            "snapshot":{"conversationId":self.conversation},"continuity":continuity}),
        )
    }
    fn observe(
        &mut self,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
        capacity_bearing: bool,
    ) -> Result<(), HostError> {
        let invalid = observed.invalid;
        accounting
            .observe(
                observed.usage,
                RequestMetadata {
                    fingerprint: observed.fingerprint.as_deref(),
                    purpose: if capacity_bearing {
                        UsagePurpose::Agent
                    } else {
                        UsagePurpose::CompactionSummary
                    },
                    capacity_bearing,
                },
            )
            .map_err(HostError)?;
        if invalid {
            return Err(HostError("native_usage_invalid"));
        }
        Ok(())
    }
    async fn wait<F: std::future::Future>(
        &mut self,
        future: F,
        owned: &CancellationToken,
        _external: &CancellationToken,
    ) -> Result<F::Output, HostError> {
        let value = future.await;
        self.waits += 1;
        if self.revoke_after_wait {
            self.valid.set(false);
        }
        if self.mutate_after_wait {
            self.mutate_after_wait = false;
            let store = ConversationStore::new(&self.home);
            let fresh = store.read_committed(&self.conversation, None, 8 * 1024 * 1024)?;
            store.commit_message(
                &fresh,
                &json!({"id":"external-user","role":"user","content":"Externally committed input"}),
                &now(),
                None,
            )?;
        }
        if self.cancel_after_wait {
            owned.cancel();
            return Err(HostError("CANCELLED"));
        }
        Ok(value)
    }
}
fn host() -> (tempfile::TempDir, Host) {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let meta = store
        .create(
            &NewConversation {
                title: "Cognition seam",
                workspace_path: None,
                mode: "chat",
                created_at: &now(),
            },
            None,
        )
        .unwrap();
    let conversation = meta["id"].as_str().unwrap().to_owned();
    let fresh = store
        .read_committed(&conversation, None, 8 * 1024 * 1024)
        .unwrap();
    store
        .commit_message(
            &fresh,
            &json!({"id":"original-user","role":"user","content":"Original saved input"}),
            &now(),
            None,
        )
        .unwrap();
    let host = Host {
        home: root.path().into(),
        conversation,
        valid: Cell::new(true),
        admitted: 0,
        waits: 0,
        revoke_after_wait: false,
        cancel_after_wait: false,
        mutate_after_wait: false,
    };
    (root, host)
}
fn response(content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
fn text_stream(wire: Wire) -> String {
    let fixtures: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let name = if wire == Wire::Anthropic {
        "anthropic-messages"
    } else {
        "openai-chat"
    };
    fixtures["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["wire"] == name && c["kind"] == "text")
        .unwrap()["stream"]
        .as_str()
        .unwrap()
        .into()
}
type Captured = Vec<(String, Vec<u8>)>;
fn exchanges(responses: Vec<String>) -> (String, std::thread::JoinHandle<Captured>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let thread = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = vec![];
        for response in responses {
            let mut socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    other => panic!("controlled cognition socket: {other:?}"),
                }
            };
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut headers = vec![];
            while !headers.ends_with(b"\r\n\r\n") {
                let mut b = [0];
                socket.read_exact(&mut b).unwrap();
                headers.push(b[0]);
                assert!(headers.len() < 16384);
            }
            let headers = String::from_utf8(headers).unwrap();
            let size = headers
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(size < 65536);
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            out.push((headers, body));
            socket.write_all(response.as_bytes()).unwrap();
        }
        out
    });
    (address, thread)
}
fn native_model(base: &str, wire: Wire) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint: format!(
                "{base}{}",
                if wire == Wire::Anthropic {
                    "/v1/messages"
                } else {
                    "/v1/chat/completions"
                }
            ),
            model: "model".into(),
            provider: "fixture".into(),
            wire,
            generation: GenerationOptions {
                max_output_tokens: Some(1024.0),
                ..GenerationOptions::default()
            },
        },
        None,
        Duration::from_secs(2),
    )
    .unwrap()
}
fn request<'a>(
    home: &'a Path,
    model: &'a NativeModel,
    tools: &'a Value,
    owned: &'a CancellationToken,
    external: &'a CancellationToken,
) -> CognitionRequest<'a> {
    CognitionRequest {
        home,
        model,
        tools,
        owned,
        external,
    }
}

#[tokio::test]
async fn a_non_goal_host_counts_and_sends_the_same_real_request_and_restores_capacity() {
    let (root, mut host) = host();
    let (base, server) = exchanges(vec![
        response("application/json", "{\"input_tokens\":123}"),
        response("text/event-stream", &text_stream(Wire::Anthropic)),
    ]);
    let model = native_model(&base, Wire::Anthropic);
    let mut pipeline =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    let mut accounting = RuntimeUsageAccounting::default();
    let tools = json!([]);
    let cancel = CancellationToken::new();
    let result = pipeline
        .request(
            &mut host,
            &request(root.path(), &model, &tools, &cancel, &cancel),
            &mut accounting,
        )
        .await
        .unwrap();
    assert!(!result.turn.content.is_empty());
    assert_eq!(host.admitted, 1);
    assert_eq!(host.waits, 3); // saved result materialization, count, generation
    assert_eq!(accounting.snapshot().provider_request_count, 1);
    let captures = server.join().unwrap();
    assert_eq!(captures.len(), 2);
    let counted: Value = serde_json::from_slice(&captures[0].1).unwrap();
    let mut sent: Value = serde_json::from_slice(&captures[1].1).unwrap();
    sent.as_object_mut().unwrap().shift_remove("stream");
    sent.as_object_mut().unwrap().shift_remove("max_tokens");
    assert_eq!(counted, sent);
    assert_eq!(
        format!("{:x}", Sha256::digest(&captures[1].1)),
        result.turn.request_fingerprint
    );
    pipeline.finish(root.path()).unwrap();
    let restored =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    assert!(
        restored.capacity.snapshot(milliseconds(&now()).unwrap())["authoritativeInputTokens"]
            .is_number()
    );
    assert!(!root.path().join("project-runtime").exists());
    assert!(
        ConversationStore::new(root.path())
            .read_metadata(&host.conversation)
            .unwrap()
            .metadata
            .unwrap()["role"]
            .is_null()
    );
}

#[tokio::test]
async fn real_late_usage_reaches_the_host_even_when_its_wait_rejects_the_response() {
    let (root, mut host) = host();
    host.cancel_after_wait = true;
    let (base, server) = exchanges(vec![response(
        "text/event-stream",
        &text_stream(Wire::Chat),
    )]);
    let model = native_model(&base, Wire::Chat);
    let mut pipeline =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    // Tool result materialization has a managed wait before the network. Keep
    // this admission successful, then reject the actual generation completion.
    let history = ConversationStore::new(root.path())
        .read_committed(&host.conversation, None, 8 * 1024 * 1024)
        .unwrap();
    let projected = project_history(&history.history.messages).unwrap();
    let system = host.assemble(&[]).unwrap();
    let prepared = model
        .prepare_request(
            system["rendered"].as_str().unwrap(),
            &projected,
            &json!([]),
            &LiveHistory::default(),
        )
        .unwrap();
    let cancel = CancellationToken::new();
    let tools = json!([]);
    let frame = request(root.path(), &model, &tools, &cancel, &cancel);
    let mut accounting = RuntimeUsageAccounting::default();
    let result = pipeline
        .send_attempts(&mut host, &frame, &mut accounting, prepared, &history, true)
        .await;
    assert!(matches!(result, Err(HostError("CANCELLED"))));
    assert_eq!(host.admitted, 1);
    assert_eq!(accounting.snapshot().provider_request_count, 1);
    assert!(accounting.snapshot().turn_total.amounts.total_tokens > 0);
    assert_eq!(server.join().unwrap().len(), 1);
    assert_eq!(
        ConversationStore::new(root.path())
            .read_committed(&host.conversation, None, 8 * 1024 * 1024)
            .unwrap()
            .history
            .messages
            .len(),
        1
    );
}

#[tokio::test]
async fn current_authority_is_rechecked_after_owned_materialization_before_any_network() {
    let (root, mut host) = host();
    host.revoke_after_wait = true;
    let model = native_model("http://127.0.0.1:1", Wire::Chat);
    let mut pipeline =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    let cancel = CancellationToken::new();
    let tools = json!([]);
    let mut accounting = RuntimeUsageAccounting::default();
    let result = pipeline
        .request(
            &mut host,
            &request(root.path(), &model, &tools, &cancel, &cancel),
            &mut accounting,
        )
        .await;
    assert!(matches!(result, Err(HostError("test_authority_changed"))));
    assert_eq!(host.admitted, 0);
    assert_eq!(accounting.snapshot().provider_request_count, 0);
}

#[tokio::test]
async fn concurrent_canonical_input_is_not_overwritten_and_a_fresh_host_request_can_continue() {
    let (root, mut host) = host();
    host.mutate_after_wait = true;
    let model = native_model("http://127.0.0.1:1", Wire::Chat);
    let mut pipeline =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    let cancel = CancellationToken::new();
    let tools = json!([]);
    let mut accounting = RuntimeUsageAccounting::default();
    let result = pipeline
        .request(
            &mut host,
            &request(root.path(), &model, &tools, &cancel, &cancel),
            &mut accounting,
        )
        .await;
    assert!(matches!(result, Err(HostError("CONTEXT_SNAPSHOT_CHANGED"))));
    assert_eq!(host.admitted, 0);
    let history = ConversationStore::new(root.path())
        .read_committed(&host.conversation, None, 8 * 1024 * 1024)
        .unwrap();
    assert_eq!(
        history.history.messages[1]["content"],
        "Externally committed input"
    );
    let (base, server) = exchanges(vec![response(
        "text/event-stream",
        &text_stream(Wire::Chat),
    )]);
    let model = native_model(&base, Wire::Chat);
    let mut fresh =
        ContextPipeline::open(root.path(), &host.conversation, "fixture", &model).unwrap();
    fresh
        .request(
            &mut host,
            &request(root.path(), &model, &tools, &cancel, &cancel),
            &mut accounting,
        )
        .await
        .unwrap();
    assert_eq!(server.join().unwrap().len(), 1);
    assert_eq!(host.admitted, 1);
    assert_eq!(
        ConversationStore::new(root.path())
            .read_committed(&host.conversation, None, 8 * 1024 * 1024)
            .unwrap()
            .history
            .messages,
        history.history.messages
    );
}
