//! Real HTTP/1.1 chunk framing, including a server that never closes its stream.
use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};
fn fixtures() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap()
}
fn socket_closed(observed: &std::io::Result<usize>) -> bool {
    // A peer reset is a closed connection too. Timeouts, live bytes and other
    // I/O failures remain false; never infer closure from a generic error.
    matches!(observed, Ok(0))
        || matches!(observed, Err(e) if e.kind()==std::io::ErrorKind::ConnectionReset)
}
#[tokio::test]
async fn socket_observation_distinguishes_eof_reset_live_and_data() {
    use std::net::TcpStream;
    for mode in ["eof", "data", "live", "reset"] {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let raw = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        raw.set_nonblocking(true).unwrap();
        let (mut server, _) = listener.accept().unwrap();
        server
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let client = tokio::net::TcpStream::from_std(raw).unwrap();
        let mut client = Some(client);
        if mode == "data" {
            let socket = client.as_ref().unwrap();
            socket.writable().await.unwrap();
            assert_eq!(socket.try_write(b"x").unwrap(), 1);
        } else if mode == "reset" {
            client
                .as_ref()
                .unwrap()
                .set_linger(Some(Duration::ZERO))
                .unwrap();
            drop(client.take());
        } else if mode == "eof" {
            drop(client.take());
        }
        let observed = server.read(&mut [0]);
        if mode == "reset" {
            assert_eq!(
                observed.as_ref().unwrap_err().kind(),
                std::io::ErrorKind::ConnectionReset
            );
        }
        if mode == "live" {
            assert!(matches!(
                observed.as_ref().unwrap_err().kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ));
        }
        assert_eq!(
            socket_closed(&observed),
            matches!(mode, "eof" | "reset"),
            "{mode}: {observed:?}"
        );
        drop(client);
    }
}
#[tokio::test]
async fn all_wires_match_actual_ts_requests_results_and_close_on_terminal_without_eof() {
    for c in fixtures()["cases"].as_array().unwrap() {
        for size in [1, 17, 4096] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let stream = c["stream"].as_str().unwrap().to_owned();
            let (send, recv) = tokio::sync::oneshot::channel();
            let thread = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut header = Vec::new();
                let mut b = [0];
                while !header.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut b).unwrap();
                    header.push(b[0]);
                    assert!(header.len() < 16384);
                }
                let header = String::from_utf8(header).unwrap();
                let n = header
                    .lines()
                    .find_map(|l| {
                        l.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(n < 65536);
                let mut body = vec![0; n];
                socket.read_exact(&mut body).unwrap();
                socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n").unwrap();
                for chunk in stream.as_bytes().chunks(size) {
                    write!(socket, "{:x}\r\n", chunk.len()).unwrap();
                    socket.write_all(chunk).unwrap();
                    socket.write_all(b"\r\n").unwrap();
                }
                // No terminating HTTP chunk and no server EOF. Client must own cleanup.
                let observed = socket.read(&mut b);
                send.send((body, observed)).unwrap();
            });
            let wire: Wire = serde_json::from_value(c["wire"].clone()).unwrap();
            let model = NativeModel::new(
                ModelConfig {
                    endpoint: url,
                    model: "model".into(),
                    provider: "fixture".into(),
                    wire,
                    generation: GenerationOptions::default(),
                },
                None,
                Duration::from_secs(2),
            )
            .unwrap();
            let result=tokio::time::timeout(Duration::from_secs(1),model.turn("shared system",&json!({"messages":[{"role":"user","content":"inspect"}]}),&json!([{"type":"function","function":{"name":"read_file","description":"Read a file","parameters":{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}}}]),&CancellationToken::new())).await.expect("authoritative terminal must finish without transport EOF").unwrap();
            assert_eq!(
                result.content, c["expected"]["content"],
                "{} {}",
                c["wire"], c["kind"]
            );
            let calls: Vec<_> = result
                .calls
                .iter()
                .map(|v| json!({"name":v.name,"arguments":v.arguments}))
                .collect();
            assert_eq!(json!(calls), c["expected"]["calls"]);
            let usage = result.usage.unwrap();
            for key in [
                "inputTokens",
                "outputTokens",
                "cacheReadTokens",
                "totalTokens",
            ] {
                assert_eq!(
                    usage[key], c["expected"]["usage"][key],
                    "{} {key}",
                    c["wire"]
                );
            }
            let (body, observed) = tokio::time::timeout(Duration::from_secs(3), recv)
                .await
                .unwrap()
                .unwrap();
            assert!(
                socket_closed(&observed),
                "{} {} size={size} must close the owned streaming socket: {observed:?}",
                c["wire"],
                c["kind"]
            );
            assert_eq!(
                result.request_fingerprint,
                format!("{:x}", Sha256::digest(&body))
            );
            assert_eq!(
                serde_json::from_slice::<Value>(&body).unwrap(),
                c["requestBody"],
                "{} request",
                c["wire"]
            );
            thread.join().unwrap();
        }
    }
}

#[cfg(feature = "test-fixtures")]
#[tokio::test]
async fn native_helper_credentials_use_each_wire_auth_header_without_exposing_the_secret() {
    use peer_runtime::credentials::HelperClient;
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(".native-cli-fixture"), "synthetic").unwrap();
    std::fs::write(
        root.path().join("synthetic-secret.txt"),
        "synthetic-native-key",
    )
    .unwrap();
    let helper = HelperClient::new(
        std::path::Path::new(env!("CARGO_BIN_EXE_helper-test-fixture")),
        root.path(),
        Duration::from_secs(2),
    )
    .unwrap();
    for c in fixtures()["cases"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|c| c["kind"] == "text")
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let stream = c["stream"].as_str().unwrap().to_owned();
        let (send, recv) = tokio::sync::oneshot::channel();
        let thread = std::thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut header = Vec::new();
            let mut b = [0];
            while !header.ends_with(b"\r\n\r\n") {
                socket.read_exact(&mut b).unwrap();
                header.push(b[0]);
                assert!(header.len() < 16384);
            }
            let header = String::from_utf8(header).unwrap().to_ascii_lowercase();
            let n = header
                .lines()
                .find_map(|l| {
                    l.strip_prefix("content-length:")
                        .map(|s| s.trim().parse::<usize>().unwrap())
                })
                .unwrap();
            assert!(n < 65536);
            let mut body = vec![0; n];
            socket.read_exact(&mut body).unwrap();
            write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",stream.len(),stream).unwrap();
            send.send((header, body)).unwrap();
        });
        let cancel = CancellationToken::new();
        let secret = helper
            .get("model/channel/api-key", &cancel)
            .await
            .unwrap()
            .unwrap();
        let wire: Wire = serde_json::from_value(c["wire"].clone()).unwrap();
        let model = NativeModel::new(
            ModelConfig {
                endpoint,
                model: "model".into(),
                provider: "fixture".into(),
                wire,
                generation: GenerationOptions::default(),
            },
            Some(secret),
            Duration::from_secs(2),
        )
        .unwrap();
        let turn = model
            .turn("context", &json!({"messages":[]}), &json!([]), &cancel)
            .await
            .unwrap();
        assert_eq!(turn.content, "Native complete.");
        let (header, body) = recv.await.unwrap();
        let expected = match wire {
            Wire::Anthropic => "x-api-key: synthetic-native-key",
            Wire::Gemini => "x-goog-api-key: synthetic-native-key",
            _ => "authorization: bearer synthetic-native-key",
        };
        assert!(header.lines().any(|l| l == expected));
        assert_eq!(header.matches("synthetic-native-key").count(), 1);
        assert!(
            !String::from_utf8(body)
                .unwrap()
                .contains("synthetic-native-key")
        );
        if wire == Wire::Anthropic {
            assert!(header.contains("anthropic-version: 2023-06-01"));
        }
        thread.join().unwrap();
    }
    // Header injection fails before dispatch, with a static non-secret error.
    std::fs::write(
        root.path().join("synthetic-secret.txt"),
        "synthetic-key\r\ninjected: value",
    )
    .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let cancel = CancellationToken::new();
    let secret = helper
        .get("model/channel/api-key", &cancel)
        .await
        .unwrap()
        .unwrap();
    let model = NativeModel::new(
        ModelConfig {
            endpoint: format!("http://{}", listener.local_addr().unwrap()),
            model: "model".into(),
            provider: "fixture".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        Some(secret),
        Duration::from_secs(2),
    )
    .unwrap();
    assert!(
        model
            .turn("context", &json!({"messages":[]}), &json!([]), &cancel)
            .await
            .is_err_and(|e| e.code == "model_credential_invalid")
    );
    assert!(
        listener
            .accept()
            .is_err_and(|e| e.kind() == std::io::ErrorKind::WouldBlock)
    );
}
