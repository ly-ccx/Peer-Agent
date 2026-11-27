use peer_runtime::{
    CancellationToken,
    model::{
        ModelConfig, NativeModel,
        wire::{GenerationOptions, Wire},
    },
};
use serde_json::json;
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::Duration,
};
fn server(
    response: Option<String>,
) -> (
    String,
    tokio::sync::oneshot::Receiver<bool>,
    std::thread::JoinHandle<()>,
    tokio::sync::oneshot::Receiver<Vec<u8>>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let (send, recv) = tokio::sync::oneshot::channel();
    let (capture, captured) = tokio::sync::oneshot::channel();
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
            assert!(header.len() < 16384)
        }
        let header = String::from_utf8(header).unwrap();
        let n = header
            .lines()
            .find_map(|l| {
                l.to_lowercase()
                    .strip_prefix("content-length:")
                    .map(|s| s.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        assert!(n < 32768);
        let mut body = vec![0; n];
        socket.read_exact(&mut body).unwrap();
        let _ = capture.send(body);
        if let Some(response) = response {
            socket.write_all(response.as_bytes()).unwrap();
            let _ = send.send(true);
        } else {
            let closed = socket.read(&mut b).is_ok_and(|n| n == 0);
            let _ = send.send(closed);
        }
    });
    (endpoint, recv, thread, captured)
}
#[tokio::test]
async fn native_http_timeout_and_cancellation_close_the_actual_connection() {
    for cancel_request in [false, true] {
        let (url, closed, thread, _) = server(None);
        let cancel = CancellationToken::new();
        let model = NativeModel::new(
            ModelConfig {
                endpoint: url,
                model: "model".into(),
                provider: "openai".into(),
                wire: Wire::Chat,
                generation: GenerationOptions::default(),
            },
            None,
            if cancel_request {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(40)
            },
        )
        .unwrap();
        if cancel_request {
            let signal = cancel.clone();
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_millis(40)).await;
                signal.cancel();
            });
        }
        let error = match model
            .turn(
                "context",
                &json!({"messages":[{"role":"user","content":"test"}]}),
                &json!([]),
                &cancel,
            )
            .await
        {
            Err(error) => error,
            Ok(_) => panic!("stalled HTTP must not succeed"),
        };
        assert_eq!(
            error.code,
            if cancel_request {
                "CANCELLED"
            } else {
                "model_timeout"
            }
        );
        assert!(
            tokio::time::timeout(Duration::from_secs(3), closed)
                .await
                .unwrap()
                .unwrap(),
            "cancelled transport must release its socket"
        );
        thread.join().unwrap();
    }
}
#[tokio::test]
async fn provider_rejections_and_truncated_tool_streams_remain_errors() {
    for (response, code) in [
        (
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                .to_owned(),
            "model_auth_rejected",
        ),
        (
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})
            ),
            "model_stream_incomplete",
        ),
    ] {
        let (url, _, thread, _) = server(Some(response));
        let model = NativeModel::new(
            ModelConfig {
                endpoint: url,
                model: "model".into(),
                provider: "openai".into(),
                wire: Wire::Chat,
                generation: GenerationOptions::default(),
            },
            None,
            Duration::from_secs(2),
        )
        .unwrap();
        let r = model
            .turn(
                "context",
                &json!({"messages":[]}),
                &json!([]),
                &CancellationToken::new(),
            )
            .await;
        assert!(r.is_err_and(|e| e.code == code));
        thread.join().unwrap();
    }
}
#[tokio::test]
async fn terminal_error_observation_binds_usage_to_the_actual_sent_bytes() {
    use sha2::{Digest, Sha256};
    let body = "data: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":4}}\n\ndata: [DONE]\n\n";
    let response = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    );
    let (url, _, thread, captured) = server(Some(response));
    let model = NativeModel::new(
        ModelConfig {
            endpoint: url,
            model: "model".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_secs(2),
    )
    .unwrap();
    let error = match model
        .turn(
            "context",
            &json!({"messages":[{"role":"user","content":"same immutable request"}]}),
            &json!([]),
            &CancellationToken::new(),
        )
        .await
    {
        Err(e) => e,
        Ok(_) => panic!("empty response cannot succeed"),
    };
    assert_eq!(error.code, "model_empty_response");
    let observation = error.observation.unwrap();
    assert_eq!(observation.usage.unwrap().total_tokens, 16);
    assert_eq!(
        observation.request_fingerprint,
        format!("{:x}", Sha256::digest(captured.await.unwrap()))
    );
    thread.join().unwrap();
}

fn streaming_server(
    chunks: Vec<(Duration, String)>,
    stall_after_chunks: bool,
) -> (
    String,
    tokio::sync::oneshot::Receiver<bool>,
    std::thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
    let (send, recv) = tokio::sync::oneshot::channel();
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        // Deliver small SSE frames independently of TCP delayed ACKs.
        socket.set_nodelay(true).unwrap();
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
        let header = String::from_utf8(header).unwrap();
        let n = header
            .lines()
            .find_map(|l| {
                l.to_lowercase()
                    .strip_prefix("content-length:")
                    .map(|s| s.trim().parse::<usize>().unwrap())
            })
            .unwrap();
        let mut body = vec![0; n];
        socket.read_exact(&mut body).unwrap();
        socket
            .write_all(
                b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        socket.flush().unwrap();
        for (delay, chunk) in chunks {
            if !delay.is_zero() {
                std::thread::sleep(delay);
            }
            if socket.write_all(chunk.as_bytes()).is_err() || socket.flush().is_err() {
                let _ = send.send(true);
                return;
            }
        }
        if stall_after_chunks {
            let closed = socket.read(&mut b).is_ok_and(|n| n == 0);
            let _ = send.send(closed);
        } else {
            let _ = send.send(true);
        }
    });
    (endpoint, recv, thread)
}

#[tokio::test]
async fn active_streaming_survives_past_single_wait_inactivity_deadline() {
    let frame_interval = Duration::from_millis(120);
    let inactivity = Duration::from_millis(270);
    let (url, done, thread) = streaming_server(
        vec![
            (
                frame_interval,
                format!(
                    "data: {}\n\n",
                    json!({"choices":[{"index":0,"delta":{"content":"hello "},"finish_reason":null}]})
                ),
            ),
            (
                frame_interval,
                format!(
                    "data: {}\n\n",
                    json!({"choices":[{"index":0,"delta":{"content":"long "},"finish_reason":null}]})
                ),
            ),
            (
                frame_interval,
                format!(
                    "data: {}\n\n",
                    json!({"choices":[{"index":0,"delta":{"content":"stream"},"finish_reason":"stop"}]})
                ),
            ),
            (frame_interval, "data: [DONE]\n\n".to_owned()),
        ],
        false,
    );
    // Three content frames already exceed one idle interval. Allow host
    // scheduling jitter between real socket writes while retaining that ratio.
    let model = NativeModel::new(
        ModelConfig {
            endpoint: url,
            model: "model".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        inactivity,
    )
    .unwrap();
    let started = std::time::Instant::now();
    let turn = model
        .turn(
            "context",
            &json!({"messages":[{"role":"user","content":"stream slowly"}]}),
            &json!([]),
            &CancellationToken::new(),
        )
        .await
        .expect("actively streaming response must not be killed by wall-clock cutoff");
    assert_eq!(turn.content, "hello long stream");
    assert!(started.elapsed() > inactivity);
    assert!(
        tokio::time::timeout(Duration::from_secs(3), done)
            .await
            .unwrap()
            .unwrap()
    );
    thread.join().unwrap();
}

#[tokio::test]
async fn mid_stream_stall_exceeding_inactivity_deadline_fails_with_model_timeout_and_closes_socket()
{
    let (url, closed, thread) = streaming_server(
        vec![(
            Duration::from_millis(10),
            format!(
                "data: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})
            ),
        )],
        true,
    );
    let model = NativeModel::new(
        ModelConfig {
            endpoint: url,
            model: "model".into(),
            provider: "openai".into(),
            wire: Wire::Chat,
            generation: GenerationOptions::default(),
        },
        None,
        Duration::from_millis(80),
    )
    .unwrap();
    let error = match model
        .turn(
            "context",
            &json!({"messages":[{"role":"user","content":"stall mid stream"}]}),
            &json!([]),
            &CancellationToken::new(),
        )
        .await
    {
        Err(error) => error,
        Ok(_) => panic!("mid-stream stalled HTTP must not succeed"),
    };
    assert_eq!(error.code, "model_timeout");
    assert!(
        tokio::time::timeout(Duration::from_secs(3), closed)
            .await
            .unwrap()
            .unwrap(),
        "stalled stream must release its socket on inactivity timeout"
    );
    thread.join().unwrap();
}
