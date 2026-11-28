use super::*;
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::{TcpListener, TcpStream},
};
fn isolated(proxy: Option<String>) -> Network {
    let mut values = BTreeMap::new();
    values.insert(
        "NO_PROXY".into(),
        Zeroizing::new(if proxy.is_some() { "" } else { "*" }.into()),
    );
    if let Some(proxy) = proxy {
        values.insert("ALL_PROXY".into(), Zeroizing::new(proxy));
    }
    Network {
        environment: Environment::from_values(values),
        extra: vec![],
    }
}
async fn head(socket: &mut TcpStream) -> String {
    let mut bytes = Vec::new();
    while !bytes.ends_with(b"\r\n\r\n") {
        assert!(bytes.len() < 32768);
        bytes.push(socket.read_u8().await.unwrap());
    }
    String::from_utf8(bytes).unwrap()
}
fn request(address: SocketAddr) -> http::Request<Vec<u8>> {
    http::Request::builder()
        .uri(format!(
            "http://localhost:{}/oauth?retained=1",
            address.port()
        ))
        .header(http::header::PROXY_AUTHORIZATION, "must-not-reach-origin")
        .body(vec![])
        .unwrap()
}
async fn eof(socket: &mut TcpStream) {
    let mut byte = [0];
    let result = tokio::time::timeout(Duration::from_secs(1), socket.read(&mut byte))
        .await
        .expect("owned socket must close");
    assert!(
        matches!(result, Ok(0))
            || result.is_err_and(|e| e.kind() == std::io::ErrorKind::ConnectionReset)
    );
}
#[tokio::test]
async fn headers_only_finishes_an_infinite_sse_and_closes_without_waiting_for_body() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let network = isolated(None);
    let server = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let h = head(&mut socket).await;
        assert!(h.starts_with("GET /oauth?retained=1 HTTP/1.1"));
        assert!(
            h.to_lowercase()
                .contains(&format!("host: localhost:{}", address.port()))
        );
        assert!(!h.to_lowercase().contains("proxy-authorization"));
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\n\r\n")
            .await
            .unwrap();
        eof(&mut socket).await;
    };
    let client = async {
        let response = network
            .pinned_http(
                request(address),
                &[address],
                ResponseBody::HeadersOnly,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.body().is_empty());
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(server, client);
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn response_header_body_and_request_limits_do_not_return_partial_success() {
    for mode in ["exact-body", "body", "header", "fields", "informational"] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let network = isolated(None);
        let server = async {
            let (mut socket, _) = listener.accept().await.unwrap();
            head(&mut socket).await;
            let response = match mode {
                "exact-body" => format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    1024 * 1024,
                    "x".repeat(1024 * 1024)
                ),
                "body" => format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\n\r\n{}",
                    1024 * 1024 + 1,
                    "x".repeat(1024 * 1024 + 1)
                ),
                "informational" => format!(
                    "HTTP/1.1 100 Continue\r\n\r\nHTTP/1.1 200 OK\r\nX-Large: {}\r\nContent-Length: 0\r\n\r\n",
                    "x".repeat(32769)
                ),
                "header" => format!(
                    "HTTP/1.1 200 OK\r\nX-Large: {}\r\nContent-Length: 0\r\n\r\n",
                    "x".repeat(32769)
                ),
                _ => format!(
                    "HTTP/1.1 200 OK\r\n{}Content-Length: 0\r\n\r\n",
                    (0..101)
                        .map(|i| format!("X-{i}: value\r\n"))
                        .collect::<String>()
                ),
            };
            let _ = socket.write_all(response.as_bytes()).await;
            let _ = socket.shutdown().await;
        };
        let client = async {
            let response = network
                .pinned_http(
                    request(address),
                    &[address],
                    ResponseBody::Bounded,
                    &CancellationToken::new(),
                )
                .await;
            if mode == "exact-body" {
                assert_eq!(response.unwrap().body().len(), 1024 * 1024);
            } else if mode == "body" {
                assert!(matches!(response, Err(Error("mcp_oauth_response_limit"))));
            } else {
                assert!(response.is_err(), "{mode}");
            }
        };
        tokio::time::timeout(Duration::from_secs(3), async {
            tokio::join!(server, client);
        })
        .await
        .unwrap();
    }
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let network = isolated(None);
    let mut oversized = request(address);
    *oversized.body_mut() = vec![0; 262145];
    assert!(matches!(
        network
            .pinned_http(
                oversized,
                &[address],
                ResponseBody::Bounded,
                &CancellationToken::new()
            )
            .await,
        Err(Error("mcp_oauth_request_limit"))
    ));
    assert!(
        tokio::time::timeout(Duration::from_millis(50), listener.accept())
            .await
            .is_err()
    );
}
#[tokio::test]
async fn cancellation_drops_sent_http_without_replay_and_next_connection_succeeds() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let network = isolated(None);
    let cancel = CancellationToken::new();
    let (sent, received) = tokio::sync::oneshot::channel();
    let server = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        head(&mut socket).await;
        sent.send(()).unwrap();
        eof(&mut socket).await;
        let (mut socket, _) = listener.accept().await.unwrap();
        head(&mut socket).await;
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .await
            .unwrap();
    };
    let client = async {
        let action = async {
            received.await.unwrap();
            cancel.cancel();
        };
        let approved = [address];
        let (result, _) = tokio::join!(
            network.pinned_http(request(address), &approved, ResponseBody::Bounded, &cancel),
            action
        );
        assert!(matches!(result, Err(Error("CANCELLED"))));
        let response = network
            .pinned_http(
                request(address),
                &[address],
                ResponseBody::Bounded,
                &CancellationToken::new(),
            )
            .await
            .unwrap();
        assert_eq!(response.body(), b"{}");
    };
    tokio::time::timeout(Duration::from_secs(3), async {
        tokio::join!(server, client);
    })
    .await
    .unwrap();
}
#[tokio::test]
async fn proxy_rejection_header_limit_timeout_and_cancel_never_connect_to_origin_or_fall_back() {
    for mode in ["reject", "header", "timeout", "cancel"] {
        let origin = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = origin.local_addr().unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy_address = proxy.local_addr().unwrap();
        let network = isolated(Some(format!(
            "http://proxy-user:proxy-secret@{proxy_address}"
        )));
        let cancel = CancellationToken::new();
        let server = async {
            let (mut socket, _) = proxy.accept().await.unwrap();
            let h = head(&mut socket).await;
            assert!(h.starts_with(&format!("CONNECT {address} HTTP/1.1")));
            assert!(h.to_lowercase().contains("proxy-authorization: basic"));
            assert!(!h.contains("retained=1"));
            assert!(!h.to_lowercase().contains("\r\nauthorization:"));
            match mode {
                "reject" => socket
                    .write_all(
                        b"HTTP/1.1 407 Proxy Authentication Required\r\nContent-Length: 0\r\n\r\n",
                    )
                    .await
                    .unwrap(),
                "header" => {
                    let _ = socket
                        .write_all(
                            format!("HTTP/1.1 200 OK\r\nX-Large: {}\r\n\r\n", "x".repeat(32769))
                                .as_bytes(),
                        )
                        .await;
                }
                "cancel" => {
                    cancel.cancel();
                    eof(&mut socket).await;
                }
                _ => {
                    let mut byte = [0];
                    assert!(matches!(
                        tokio::time::timeout(Duration::from_secs(7), socket.read(&mut byte)).await,
                        Ok(Ok(0))
                    ));
                }
            }
        };
        let client = async {
            let result = network
                .pinned_http(request(address), &[address], ResponseBody::Bounded, &cancel)
                .await;
            assert!(result.is_err(), "{mode}");
            if mode == "timeout" {
                assert!(matches!(result, Err(Error("mcp_oauth_proxy_timeout"))));
            }
        };
        tokio::time::timeout(Duration::from_secs(9), async {
            tokio::join!(server, client);
        })
        .await
        .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_millis(50), origin.accept())
                .await
                .is_err(),
            "proxy failure cannot cause direct fallback"
        );
    }
}
