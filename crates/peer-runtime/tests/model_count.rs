//! Real count/generation sockets over one frozen native encoder request.
use peer_runtime::{
    CancellationToken,
    model::{
        LiveHistory, ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

fn response(content_type: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}
type CapturedRequests = Vec<(String, Vec<u8>)>;
fn exchanges(
    responses: Vec<Option<String>>,
) -> (String, std::thread::JoinHandle<CapturedRequests>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    listener.set_nonblocking(true).unwrap();
    let thread = std::thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        let mut out = vec![];
        for response in responses {
            let mut socket = loop {
                match listener.accept() {
                    Ok((s, _)) => break s,
                    Err(e)
                        if e.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(2))
                    }
                    other => panic!("controlled accept: {other:?}"),
                }
            };
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            socket
                .set_write_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut header = vec![];
            let mut byte = [0];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut byte).unwrap();
                header.push(byte[0]);
                assert!(header.len() < 16_384);
            }
            let header = String::from_utf8(header).unwrap();
            let size = header
                .lines()
                .find_map(|l| {
                    l.to_lowercase()
                        .strip_prefix("content-length:")
                        .map(|v| v.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(size < 65_536);
            let mut body = vec![0; size];
            socket.read_exact(&mut body).unwrap();
            out.push((header, body));
            if let Some(response) = response {
                socket.write_all(response.as_bytes()).unwrap();
            } else {
                assert_eq!(
                    socket.read(&mut byte).unwrap(),
                    0,
                    "cancelled count must close its actual socket"
                );
            }
        }
        out
    });
    (base, thread)
}
fn model(base: &str, wire: Wire, deadline: Duration) -> NativeModel {
    NativeModel::new(
        ModelConfig {
            endpoint: format!(
                "{base}{}",
                match wire {
                    Wire::Anthropic => "/v1/messages",
                    Wire::Gemini => "/v1beta/models/model:streamGenerateContent?alt=sse",
                    _ => "/chat/completions",
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
        deadline,
    )
    .unwrap()
}
fn text_stream(wire: Wire) -> String {
    let f: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    let name = if wire == Wire::Anthropic {
        "anthropic-messages"
    } else {
        "gemini"
    };
    f["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["wire"] == name && c["kind"] == "text")
        .unwrap()["stream"]
        .as_str()
        .unwrap()
        .into()
}

#[tokio::test]
async fn native_count_and_send_share_original_messages_tools_and_fingerprint() {
    for wire in [Wire::Anthropic, Wire::Gemini] {
        let count = if wire == Wire::Anthropic {
            "{\"input_tokens\":123}"
        } else {
            "{\"totalTokens\":123}"
        };
        let (base, thread) = exchanges(vec![
            Some(response("application/json", count)),
            Some(response("text/event-stream", &text_stream(wire))),
        ]);
        let model = model(&base, wire, Duration::from_secs(2));
        let mut history = json!({"messages":[{"role":"user","content":"original input"}]});
        let mut tools = json!([{"type":"function","function":{"name":"read_file","description":"fixture","parameters":{"type":"object","properties":{"path":{"type":"string"}}}}}]);
        let mut context = "Original Context Source".to_owned();
        let prepared = model
            .prepare_request(&context, &history, &tools, &LiveHistory::default())
            .unwrap();
        let fingerprint = prepared.fingerprint().to_owned();
        history["messages"][0]["content"] = json!("caller changed after preparation");
        tools = json!([]);
        context.clear();
        assert!(tools.as_array().unwrap().is_empty());
        let count = prepared
            .count_input_tokens(&CancellationToken::new())
            .await
            .unwrap()
            .unwrap();
        assert_eq!(count.input_tokens, 123);
        assert_eq!(count.request_fingerprint, fingerprint);
        let turn = prepared.send(&CancellationToken::new()).await.unwrap();
        assert_eq!(turn.request_fingerprint, fingerprint);
        let captures = thread.join().unwrap();
        assert_eq!(captures.len(), 2);
        assert_eq!(format!("{:x}", Sha256::digest(&captures[1].1)), fingerprint);
        let counted: Value = serde_json::from_slice(&captures[0].1).unwrap();
        let mut sent: Value = serde_json::from_slice(&captures[1].1).unwrap();
        if wire == Wire::Anthropic {
            assert!(captures[0].0.starts_with("POST /v1/messages/count_tokens "));
            assert!(
                captures
                    .iter()
                    .all(|(headers, _)| headers.lines().any(|line| {
                        line.split_once(':').is_some_and(|(name, value)| {
                            name.eq_ignore_ascii_case("anthropic-version")
                                && value.trim() == "2023-06-01"
                        })
                    })),
                "count and generation must send the Anthropic version header: {captures:?}"
            );
            sent.as_object_mut().unwrap().shift_remove("stream");
            sent.as_object_mut().unwrap().shift_remove("max_tokens");
            assert_eq!(counted, sent);
        } else {
            assert!(
                captures[0]
                    .0
                    .starts_with("POST /v1beta/models/model:countTokens ")
            );
            assert!(!captures[0].0.contains("alt=sse"));
            sent["model"] = json!("models/model");
            assert_eq!(counted, json!({"generateContentRequest":sent}));
        }
        assert!(!String::from_utf8_lossy(&captures[1].1).contains("caller changed"));
    }
}

#[tokio::test]
async fn bad_or_unavailable_counter_does_not_mutate_or_consume_the_send_request() {
    for (reply, code) in [
        (
            "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".into(),
            "context_count_rejected",
        ),
        (
            response("application/json", "{\"input_tokens\":-1}"),
            "context_count_response_invalid",
        ),
        (
            response("application/json", "{\"input_tokens\":1.5}"),
            "context_count_response_invalid",
        ),
        (
            response("application/json", "{\"input_tokens\":9007199254740992}"),
            "context_count_response_invalid",
        ),
        (
            response("application/json", "{\"unexpected\":123}"),
            "context_count_response_invalid",
        ),
        (
            response("text/html", "<html>secret diagnostic</html>"),
            "context_count_content_type_invalid",
        ),
        (
            response("application/json", &" ".repeat(16_385)),
            "context_count_limit",
        ),
    ] {
        let (base, thread) = exchanges(vec![
            Some(reply),
            Some(response("text/event-stream", &text_stream(Wire::Anthropic))),
        ]);
        let model = model(&base, Wire::Anthropic, Duration::from_secs(2));
        let prepared = model
            .prepare_request(
                "context",
                &json!({"messages":[{"role":"user","content":"same request"}]}),
                &json!([]),
                &LiveHistory::default(),
            )
            .unwrap();
        let fp = prepared.fingerprint().to_owned();
        let error = match prepared.count_input_tokens(&CancellationToken::new()).await {
            Err(e) => e,
            _ => panic!("bad counter must fail"),
        };
        assert_eq!(error.code, code);
        assert!(error.observation.is_none());
        assert_eq!(
            prepared
                .send(&CancellationToken::new())
                .await
                .unwrap()
                .request_fingerprint,
            fp
        );
        assert_eq!(thread.join().unwrap().len(), 2);
    }
}

#[tokio::test]
async fn count_timeout_and_cancellation_close_socket_without_creating_usage() {
    for cancelled in [false, true] {
        let (base, thread) = exchanges(vec![None]);
        let model = model(
            &base,
            Wire::Anthropic,
            if cancelled {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(50)
            },
        );
        let prepared = model
            .prepare_request(
                "context",
                &json!({"messages":[]}),
                &json!([]),
                &LiveHistory::default(),
            )
            .unwrap();
        let cancel = CancellationToken::new();
        if cancelled {
            let c = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(50)).await;
                c.cancel();
            });
        }
        let error = match prepared.count_input_tokens(&cancel).await {
            Err(e) => e,
            _ => panic!("stalled counter cannot succeed"),
        };
        assert_eq!(
            error.code,
            if cancelled {
                "CANCELLED"
            } else {
                "context_count_timeout"
            }
        );
        assert!(error.observation.is_none());
        // Keep Tokio's reactor running while the owned HTTP cancellation
        // closes the socket; blocking join here prevents that cleanup itself.
        tokio::time::timeout(
            Duration::from_secs(3),
            tokio::task::spawn_blocking(move || thread.join().unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
    }
}

#[tokio::test]
async fn observed_only_channels_never_probe_an_inapplicable_counter() {
    for wire in [Wire::Chat, Wire::Responses] {
        let config = ModelConfig {
            endpoint: "http://127.0.0.1:9/v1/messages".into(),
            model: "model".into(),
            provider: "fixture".into(),
            wire,
            generation: GenerationOptions::default(),
        };
        let model = NativeModel::new(config, None, Duration::from_secs(2)).unwrap();
        let prepared = model
            .prepare_request(
                "context",
                &json!({"messages":[]}),
                &json!([]),
                &LiveHistory::default(),
            )
            .unwrap();
        assert!(
            prepared
                .count_input_tokens(&CancellationToken::new())
                .await
                .unwrap()
                .is_none()
        );
    }
}
