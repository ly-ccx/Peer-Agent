use peer_runtime::{CancellationToken, model::OpenAiChatModel};
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
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/chat/completions", listener.local_addr().unwrap());
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
        if let Some(response) = response {
            socket.write_all(response.as_bytes()).unwrap();
            let _ = send.send(true);
        } else {
            let closed = socket.read(&mut b).is_ok_and(|n| n == 0);
            let _ = send.send(closed);
        }
    });
    (endpoint, recv, thread)
}
#[tokio::test]
async fn native_http_timeout_and_cancellation_close_the_actual_connection() {
    for cancel_request in [false, true] {
        let (url, closed, thread) = server(None);
        let cancel = CancellationToken::new();
        let model = OpenAiChatModel::new(
            &url,
            "model",
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
            error.0,
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
            "model_http_rejected",
        ),
        (
            format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nConnection: close\r\n\r\ndata: {}\n\n",
                json!({"choices":[{"index":0,"delta":{"content":"partial"},"finish_reason":null}]})
            ),
            "model_stream_incomplete",
        ),
    ] {
        let (url, _, thread) = server(Some(response));
        let model = OpenAiChatModel::new(&url, "model", None, Duration::from_secs(2)).unwrap();
        let r = model
            .turn(
                "context",
                &json!({"messages":[]}),
                &json!([]),
                &CancellationToken::new(),
            )
            .await;
        assert!(r.is_err_and(|e| e.0 == code));
        thread.join().unwrap();
    }
}
