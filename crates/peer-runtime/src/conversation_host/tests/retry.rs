//! Drive the production Conversation Host and its real provider/tool/store seams.
use super::*;
use crate::model::{ModelFailurePhase, ModelRetryNotice};

pub(super) fn sse_response(body: &str, declared_length: usize) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {declared_length}\r\nConnection: close\r\n\r\n{body}"
    )
}
fn sse(values: &[Value]) -> String {
    values
        .iter()
        .map(|value| format!("data: {value}\n\n"))
        .collect()
}
fn partial() -> String {
    sse(&[
        json!({"type":"response.output_text.delta","delta":"discarded preview"}),
        json!({"type":"response.reasoning_text.delta","delta":"discarded thinking"}),
        json!({"type":"response.output_item.added","output_index":0,"item":{"id":"discarded","call_id":"discarded","name":"write_file","type":"function_call","arguments":""}}),
        json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"discarded","delta":"{\"path\":\"wrong.txt"}),
    ])
}
fn completed_text() -> String {
    let text = "Clean terminal reply.";
    let body = sse(&[
        json!({"type":"response.output_text.delta","delta":text}),
        json!({"type":"response.completed","response":{"status":"completed",
            "output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":text}]}],
            "usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}
        }}),
    ]);
    sse_response(&body, body.len())
}
fn completed_tool() -> String {
    let args = json!({"path":"proof.txt","content":"owned effect"}).to_string();
    let mut item = json!({"id":"complete","call_id":"valid","name":"write_file","type":"function_call","arguments":""});
    let start = json!({"type":"response.output_item.added","output_index":0,"item":item});
    item["arguments"] = json!(args);
    let body = sse(&[
        start,
        json!({"type":"response.output_text.delta","delta":"Accepted tool step."}),
        json!({"type":"response.function_call_arguments.delta","output_index":0,"item_id":"complete","delta":args}),
        json!({"type":"response.output_item.done","output_index":0,"item":item}),
        json!({"type":"response.completed","response":{"status":"completed","output":[
            item, {"type":"message","role":"assistant","content":[{"type":"output_text","text":"Accepted tool step."}]}
        ],"usage":{"input_tokens":10,"output_tokens":2,"total_tokens":12}}}),
    ]);
    sse_response(&body, body.len())
}
fn failed_event(kind: &str, provider_code: &str) -> String {
    let body = sse(&[json!({"type":kind,"response":{
        "error":{"code":provider_code,"message":"private prompt echo and arbitrary OAuth token"},
        "incomplete_details":{"reason":provider_code},
    }})]);
    sse_response(&body, body.len())
}
fn http(status: u16, retry_after: Option<&str>, body: &str) -> String {
    let retry_after = retry_after
        .map(|raw| format!("Retry-After: {raw}\r\n"))
        .unwrap_or_default();
    format!(
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\n{retry_after}Connection: close\r\n\r\n{body}",
        body.len()
    )
}
fn server(responses: Vec<String>) -> (NativeModel, std::thread::JoinHandle<Vec<Value>>) {
    let (endpoint, served) = raw_server_with_reply_gate(responses, |_| {});
    (responses_model(endpoint), served)
}
fn responses_model(endpoint: String) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint,
            model: "fixture-responses".into(),
            provider: "fixture".into(),
            wire: Wire::Responses,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(5),
    )
    .unwrap()
}
struct RuntimeFixture {
    root: tempfile::TempDir,
    workspace: tempfile::TempDir,
    runtime: NativeConversationRuntime,
}
impl RuntimeFixture {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let workspace = tempfile::tempdir().unwrap();
        let runtime = NativeConversationRuntime::new(
            root.path(),
            ConversationAccess::new(LocalAccessLevel::FullLocal),
        );
        Self {
            root,
            workspace,
            runtime,
        }
    }
    fn options(&self, max_turns: usize) -> ConversationOptions<'_> {
        ConversationOptions {
            workspace: self.workspace.path(),
            conversation_id: None,
            resume_from: None,
            prompt: "Synthetic retry fixture",
            image_paths: &[],
            provider_id: "fixture",
            mode: RuntimeMode::Chat,
            effort: "default",
            persist_model_selection: false,
            allowlist: None,
            max_turns: Some(max_turns),
        }
    }
    async fn execute(
        &self,
        model: &NativeModel,
        mut output: Option<&mut dyn ConversationOutput>,
    ) -> ConversationOutcome {
        let output = output
            .as_mut()
            .map(|output| &mut **output as &mut dyn ConversationOutput);
        self.runtime
            .execute_interactive(
                &self.options(1),
                model,
                &mut NoInput,
                output,
                &CancellationToken::new(),
            )
            .await
            .unwrap()
    }
    fn verify_one_write(&self, outcome: &ConversationOutcome) {
        let messages = ConversationStore::new(self.root.path())
            .read_committed(&outcome.session_id, None, 8 * 1024 * 1024)
            .unwrap()
            .history
            .messages;
        let calls = messages
            .iter()
            .flat_map(|message| message["segments"].as_array().into_iter().flatten())
            .filter(|segment| segment["type"] == "tool-call")
            .collect::<Vec<_>>();
        assert_eq!(calls.len(), 1);
        assert_eq!(calls[0]["result"]["status"], "success");
        assert!(!json!(messages).to_string().contains("discarded"));
        let call = calls[0]["toolCallId"].as_str().unwrap();
        let evidence = peer_store::EvidenceIndexStore::new(self.root.path())
            .list_for_conversation(&outcome.session_id, None)
            .unwrap();
        assert_eq!(evidence.len(), 1);
        assert_eq!(
            peer_store::EvidenceIndexStore::new(self.root.path())
                .find(&[format!("tool-result://{call}")], None)
                .unwrap()
                .len(),
            1,
        );
        assert_eq!(
            std::fs::read_to_string(self.workspace.path().join("proof.txt")).unwrap(),
            "owned effect"
        );
        assert!(!self.workspace.path().join("wrong.txt").exists());
    }
}

#[derive(Default)]
struct Preview {
    text: String,
    thinking: String,
    reset: Vec<(ModelRetryNotice, String, String)>,
    on_retry: Option<Box<dyn FnMut()>>,
    supports_reset: bool,
}
impl ConversationOutput for Preview {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), HostError>> + 'a>> {
        if let ConversationEvent::AssistantDelta(text) = event {
            self.text.push_str(text);
        }
        if let ConversationEvent::ThinkingDelta(thinking) = event {
            self.thinking.push_str(thinking);
        }
        Box::pin(async { Ok(()) })
    }
    fn model_retry(
        &mut self,
        notice: ModelRetryNotice,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<bool, HostError>> + '_>> {
        if let Some(callback) = self.on_retry.as_mut() {
            callback();
        }
        if self.supports_reset {
            self.reset.push((
                notice,
                std::mem::take(&mut self.text),
                std::mem::take(&mut self.thinking),
            ));
        } else {
            self.reset
                .push((notice, self.text.clone(), self.thinking.clone()));
        }
        Box::pin(async { Ok(self.supports_reset) })
    }
}

#[tokio::test]
async fn midstream_replay_discards_partial_text_thinking_and_arguments_and_resets_preview() {
    let partial = partial();
    let (model, served) = server(vec![
        sse_response(&partial, partial.len() + 100),
        completed_tool(),
    ]);
    let fixture = RuntimeFixture::new();
    let mut output = Preview {
        supports_reset: true,
        ..Default::default()
    };
    let outcome = fixture.execute(&model, Some(&mut output)).await;
    assert_eq!(outcome.error, Some("agent_loop_exhausted")); // One-step limit after the settled tool.
    assert_eq!(outcome.turns, 1);
    assert_eq!(outcome.usage.provider_request_count, 2);
    assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 12);
    fixture.verify_one_write(&outcome);
    let requests = served.join().unwrap();
    assert_eq!(requests[0], requests[1]);
    let [(notice, text, thinking)] = output.reset.as_slice() else {
        panic!("expected one retry")
    };
    assert_eq!((notice.attempt, notice.max_attempts), (2, 4));
    assert!((425..=575).contains(&notice.delay_ms));
    assert_eq!(notice.error_category, "model_stream_interrupted");
    assert_eq!(text, "discarded preview");
    assert_eq!(thinking, "discarded thinking");
    assert_eq!(output.text, "Accepted tool step.");
    assert!(output.thinking.is_empty());
}

#[tokio::test]
async fn delegated_worker_retry_after_a_settled_tool_keeps_exactly_one_evidence() {
    let partial = partial();
    let (model, served) = server(vec![
        completed_tool(),
        sse_response(&partial, partial.len() + 100),
        completed_text(),
    ]);
    let fixture = RuntimeFixture::new();
    let allowlist = ["local.file.write".to_owned()];
    let options = ConversationOptions {
        allowlist: Some(&allowlist),
        ..fixture.options(2)
    };
    let outcome = fixture
        .runtime
        .execute_delegated(&options, &model, &mut NoInput, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(outcome.error, None);
    assert_eq!(outcome.content, "Clean terminal reply.");
    assert_eq!(outcome.turns, 2);
    assert_eq!(outcome.usage.provider_request_count, 3);
    assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 24);
    fixture.verify_one_write(&outcome);
    let requests = served.join().unwrap();
    assert_eq!(requests[1], requests[2]);
    assert_eq!(requests.len(), 3);
    assert_ne!(requests[0], requests[1]);
}

#[tokio::test]
async fn transient_sse_failed_event_and_clean_eof_recover_in_the_same_logical_turn() {
    let partial = partial();
    for (response, category, provider_code) in [
        (
            failed_event("response.failed", "server_error"),
            "model_provider_error",
            Some("server_error"),
        ),
        (
            failed_event("response.incomplete", "stream_interrupted"),
            "model_provider_error",
            Some("stream_interrupted"),
        ),
        (
            sse_response(&partial, partial.len()),
            "model_stream_incomplete",
            None,
        ),
    ] {
        let (model, served) = server(vec![response, completed_text()]);
        let fixture = RuntimeFixture::new();
        let mut output = Preview::default();
        let outcome = fixture.execute(&model, Some(&mut output)).await;
        assert_eq!(outcome.error, None);
        assert_eq!(outcome.content, "Clean terminal reply.");
        assert_eq!(outcome.turns, 1);
        assert_eq!(outcome.usage.provider_request_count, 2);
        assert_eq!(output.reset.len(), 1);
        assert_eq!(output.reset[0].0.error_category, category);
        assert_eq!(output.reset[0].0.provider_code, provider_code);
        if category == "model_stream_incomplete" {
            // A legacy output cannot reset its preview and receives no appended replacement deltas.
            assert_eq!(output.text, "discarded preview");
        } else {
            assert_eq!(output.text, "Clean terminal reply.");
        }
        assert_eq!(served.join().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn terminal_provider_events_keep_only_allowlisted_fields_and_never_retry() {
    for (kind, code) in [
        ("response.failed", "insufficient_quota"),
        ("response.failed", "invalid_api_key"),
        ("response.failed", "policy_violation"),
        ("response.incomplete", "max_output_tokens"),
        ("response.incomplete", "content_filter"),
        ("response.incomplete", "rate_limit"),
    ] {
        let (model, served) = server(vec![failed_event(kind, code)]);
        let outcome = RuntimeFixture::new().execute(&model, None).await;
        assert_eq!(outcome.error, Some("model_provider_error"));
        assert_eq!(outcome.usage.provider_request_count, 1);
        let error = outcome.model_error.unwrap();
        assert_eq!(error.sse_event_kind, Some(kind));
        assert_eq!(error.provider_code, Some(code));
        assert_eq!(error.failure_phase, Some(ModelFailurePhase::Terminal));
        assert_eq!(error.attempts_used, 1);
        let detail = error.format_diagnostic().unwrap();
        assert!(detail.contains(kind) && detail.contains(code));
        assert!(!detail.contains("private prompt") && !detail.contains("OAuth token"));
        assert_eq!(served.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn transient_http_statuses_and_oversized_error_body_retry() {
    for status in [408, 500, 502, 503, 504, 520, 521, 522, 523, 524, 429] {
        let (model, served) = server(vec![http(status, Some("0"), ""), completed_text()]);
        let outcome = RuntimeFixture::new().execute(&model, None).await;
        assert_eq!(outcome.error, None, "status {status}");
        assert_eq!(outcome.usage.provider_request_count, 2);
        assert_eq!(served.join().unwrap().len(), 2);
    }
    let oversized = "x".repeat(64 * 1024 + 1);
    let (model, served) = server(vec![http(502, Some("0"), &oversized), completed_text()]);
    let mut output = Preview::default();
    let outcome = RuntimeFixture::new()
        .execute(&model, Some(&mut output))
        .await;
    assert_eq!(outcome.error, None);
    assert_eq!(output.reset[0].0.error_category, "model_error_body_limit");
    assert_eq!(served.join().unwrap().len(), 2);

    for (response, code, retry_after) in [
        (http(502, Some("600"), &oversized), "model_error_body_limit", 600_000),
        ("HTTP/1.1 502 Fixture\r\nContent-Length: 100\r\nRetry-After: 601\r\nConnection: close\r\n\r\nabc".into(),
            "model_stream_interrupted", 600_000),
    ] {
        let (model, served) = server(vec![response]);
        let outcome = RuntimeFixture::new().execute(&model, None).await;
        assert_eq!(outcome.error, Some(code));
        let error = outcome.model_error.unwrap();
        assert_eq!(error.http_status, Some(502));
        assert_eq!(error.retry_after_ms, Some(retry_after));
        assert_eq!(error.attempts_used, 1);
        assert!(error.is_transient_retryable());
        assert_eq!(served.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn bounded_retry_after_and_known_quota_auth_and_bad_request_are_terminal() {
    for (status, delay, body) in [
        (400, None, ""),
        (401, None, ""),
        (403, None, ""),
        (404, None, ""),
        (407, None, ""),
        (422, None, ""),
        (429, Some("0"), r#"{"error":{"code":"insufficient_quota"}}"#),
        (503, Some("600"), ""),
    ] {
        let (model, served) = server(vec![http(status, delay, body)]);
        let outcome = RuntimeFixture::new().execute(&model, None).await;
        let error = outcome.model_error.unwrap();
        assert_eq!(error.http_status, Some(status));
        assert_eq!(error.attempts_used, 1);
        assert_eq!(outcome.usage.provider_request_count, 1);
        assert_eq!(served.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn cancelled_backoff_admits_no_additional_physical_request() {
    let (model, served) = server(vec![http(503, Some("3"), "")]);
    let cancel = CancellationToken::new();
    let cancel_after_notice = cancel.clone();
    let mut output = Preview {
        on_retry: Some(Box::new(move || {
            let cancel = cancel_after_notice.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(20)).await;
                cancel.cancel();
            });
        })),
        ..Default::default()
    };
    let fixture = RuntimeFixture::new();
    let outcome = tokio::time::timeout(
        Duration::from_secs(2),
        fixture.runtime.execute_interactive(
            &fixture.options(1),
            &model,
            &mut NoInput,
            Some(&mut output),
            &cancel,
        ),
    )
    .await
    .expect("cancel must interrupt 3s backoff")
    .unwrap();
    assert_eq!(outcome.error, Some("CANCELLED"));
    assert_eq!(outcome.usage.provider_request_count, 1);
    assert_eq!(output.reset[0].0.delay_ms, 3000);
    assert_eq!(served.join().unwrap().len(), 1);
}

#[tokio::test]
async fn exhausted_replay_reports_four_actual_attempts_without_provider_payload() {
    let response = failed_event("response.failed", "server_error");
    let response = response.replace("Connection: close", "Retry-After: 0\r\nConnection: close");
    let (model, served) = server(vec![response; 4]);
    let fixture = RuntimeFixture::new();
    let mut output = Preview::default();
    let outcome = fixture.execute(&model, Some(&mut output)).await;
    assert_eq!(outcome.turns, 1);
    assert_eq!(outcome.usage.provider_request_count, 4);
    assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 0);
    let error = outcome.model_error.unwrap();
    let detail = error.format_diagnostic().unwrap();
    for field in [
        "attempts_used=4",
        "failure_phase=Terminal",
        "http_status=200",
        "provider_code=server_error",
    ] {
        assert!(detail.contains(field), "{detail}");
    }
    assert!(!detail.contains("private") && !detail.contains("OAuth"));
    assert_eq!(
        output.reset.iter().map(|r| r.0.attempt).collect::<Vec<_>>(),
        [2, 3, 4]
    );
    assert_eq!(served.join().unwrap().len(), 4);
}

#[tokio::test]
async fn revised_source_or_revoked_owner_during_backoff_prevents_replay() {
    for revoke_owner in [false, true] {
        let (model, served) = server(vec![http(503, Some("1"), "")]);
        let fixture = RuntimeFixture::new();
        let conversation = create_conversation(fixture.root.path(), fixture.workspace.path());
        let store = ConversationStore::new(fixture.root.path());
        let cid = conversation.clone();
        let live = fixture.runtime.live.clone();
        let mut output = Preview {
            on_retry: Some(Box::new(move || {
                if revoke_owner {
                    let identity = store
                        .read_conversation_execution(&cid)
                        .unwrap()
                        .unwrap()
                        .identity;
                    live.close_admission(&identity).unwrap();
                } else {
                    let snapshot = store.read_committed(&cid, None, 8 * 1024 * 1024).unwrap();
                    store
                        .commit_message(
                            &snapshot,
                            &json!({
                                "id":"external-revision", "role":"user", "content":"new source"
                            }),
                            &now(),
                            None,
                        )
                        .unwrap();
                }
            })),
            ..Default::default()
        };
        let options = ConversationOptions {
            conversation_id: Some(&conversation),
            ..fixture.options(1)
        };
        let outcome = fixture
            .runtime
            .execute_interactive(
                &options,
                &model,
                &mut NoInput,
                Some(&mut output),
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert!(
            matches!(
                outcome.error,
                Some("CANCELLED" | "CONTEXT_SNAPSHOT_CHANGED" | "native_execution_owner_unknown")
            ),
            "{:?}",
            outcome.error
        );
        assert_eq!(outcome.usage.provider_request_count, 1);
        assert_eq!(served.join().unwrap().len(), 1);
    }
}

#[tokio::test]
async fn self_signed_tls_certificate_is_terminal_after_one_handshake() {
    use base64::{Engine, engine::general_purpose::STANDARD};
    use rustls::pki_types::{CertificateDer, PrivatePkcs8KeyDer};

    // OpenSSL-generated test-only P-256 certificate for loopback. It is
    // deliberately absent from every trust store and holds no real secret.
    let cert = STANDARD
        .decode(concat!(
            "MIIBmDCCAT+gAwIBAgIUW4H6jp/CLx9rTIL1DSQu7qh6kTUwCgYIKoZIzj0EAwIwFDES",
            "MBAGA1UEAwwJbG9jYWxob3N0MB4XDTI2MTEyNjE0NDUxNVoXDTM2MTEyMzE0NDUxNVow",
            "FDESMBAGA1UEAwwJbG9jYWxob3N0MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEejCR",
            "LHjCnRg6rYZIgKzniLBLP5grgN5LAc6G7Gfd0JMpZ6cWkHBoK3uxLSgpzVzV86eOWrPX",
            "KYlztskeFiX8CaNvMG0wHQYDVR0OBBYEFLxZySrOVrk63sdIh1kQ3+AY6ogqMB8GA1Ud",
            "IwQYMBaAFLxZySrOVrk63sdIh1kQ3+AY6ogqMA8GA1UdEwEB/wQFMAMBAf8wGgYDVR0R",
            "BBMwEYIJbG9jYWxob3N0hwR/AAABMAoGCCqGSM49BAMCA0cAMEQCICtkod9satVmUkFk",
            "898dG+fXdnnFjiQwLoBYCPoNtFBvAiA9X3qFfaazlg6F0dpflJxcTQWKIndw/w4FJC6tZKdT9A=="
        ))
        .unwrap();
    let key = STANDARD
        .decode(concat!(
            "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgK7ZTCDhlMFfZHAq774FP",
            "iDGDzwKEvPtR2QQSPnNgJOmhRANCAAR6MJEseMKdGDqthkiArOeIsEs/mCuA3ksBzob",
            "sZ93QkylnpxaQcGgre7EtKCnNXNXzp45as9cpiXO2yR4WJfwJ"
        ))
        .unwrap();
    let config = rustls::ServerConfig::builder_with_provider(Arc::new(
        rustls::crypto::ring::default_provider(),
    ))
    .with_safe_default_protocol_versions()
    .unwrap()
    .with_no_client_auth()
    .with_single_cert(
        vec![CertificateDer::from(cert)],
        PrivatePkcs8KeyDer::from(key).into(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let model = responses_model(format!(
        "https://{}/v1/responses",
        listener.local_addr().unwrap()
    ));
    let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
    let served = tokio::spawn(async move {
        let (socket, _) = listener.accept().await.unwrap();
        assert!(acceptor.accept(socket).await.is_err());
        assert!(
            tokio::time::timeout(Duration::from_millis(750), listener.accept())
                .await
                .is_err()
        );
    });

    let outcome = RuntimeFixture::new().execute(&model, None).await;
    assert_eq!(outcome.error, Some("model_tls_certificate_invalid"));
    let error = outcome.model_error.unwrap();
    assert_eq!(error.failure_phase, Some(ModelFailurePhase::Connect));
    assert_eq!(error.attempts_used, 1);
    assert_eq!(outcome.usage.provider_request_count, 1);
    served.await.unwrap();
}

#[tokio::test]
async fn failed_sse_usage_is_accounted_as_a_separate_observed_attempt() {
    let body = sse(&[json!({"type":"response.failed","response":{
        "error":{"code":"server_error"}, "usage":{"input_tokens":4,"output_tokens":1,"total_tokens":5}
    }})]);
    let failed = sse_response(&body, body.len())
        .replace("Connection: close", "Retry-After: 0\r\nConnection: close");
    let (model, served) = server(vec![failed, completed_text()]);
    let outcome = RuntimeFixture::new().execute(&model, None).await;
    assert_eq!(outcome.error, None);
    assert_eq!(outcome.usage.provider_request_count, 2);
    assert_eq!(outcome.usage.turn_total.amounts.total_tokens, 17);
    assert_eq!(outcome.usage.last_request.unwrap().amounts.total_tokens, 12);
    assert_eq!(served.join().unwrap().len(), 2);
}

#[tokio::test]
async fn corrupt_sse_json_is_terminal_without_replay_or_preview_reset() {
    let invalid = "event: response.failed\ndata: not-valid-json\n\n";
    let (model, served) = server(vec![sse_response(invalid, invalid.len())]);
    let mut output = Preview::default();
    let outcome = RuntimeFixture::new()
        .execute(&model, Some(&mut output))
        .await;
    assert_eq!(outcome.error, Some("model_payload_invalid"));
    assert_eq!(outcome.model_error.unwrap().attempts_used, 1);
    assert_eq!(outcome.usage.provider_request_count, 1);
    assert!(output.reset.is_empty());
    assert_eq!(served.join().unwrap().len(), 1);
}

#[tokio::test]
async fn explicit_token_cap_stays_terminal_even_if_transport_then_breaks() {
    let body = sse(&[
        json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":"length"}]}),
    ]);
    let (endpoint, served) =
        raw_server_with_reply_gate(vec![sse_response(&body, body.len() + 100)], |_| {});
    let outcome = RuntimeFixture::new().execute(&model(endpoint), None).await;
    let error = outcome.model_error.unwrap();
    assert_eq!(error.provider_code, Some("length"));
    assert_eq!(error.sse_event_kind, Some("finish_reason"));
    assert_eq!(error.attempts_used, 1);
    assert_eq!(outcome.usage.provider_request_count, 1);
    assert_eq!(served.join().unwrap().len(), 1);
}
