//! Existing v2 files -> native loader -> count/send over actual bounded HTTP.
//! No Helper secret, external model, Node or Bun participates in these requests.
use peer_runtime::{
    CancellationToken,
    model::{LiveHistory, wire::Wire},
    model_config::load_model,
};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    time::{Duration, Instant},
};

#[tokio::test]
async fn stored_channel_options_headers_and_frozen_request_reach_count_and_send() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/model-channels.json"
    ))
    .unwrap();
    let streams: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/model-streams.json"
    ))
    .unwrap();
    for case in data["cases"].as_array().unwrap() {
        let wire: Wire = serde_json::from_value(case["expected"]["wire"].clone()).unwrap();
        let counted = matches!(wire, Wire::Anthropic | Wire::Gemini);
        let stream = streams["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["wire"] == case["expected"]["wire"] && c["kind"] == "text")
            .unwrap()["stream"]
            .as_str()
            .unwrap()
            .to_owned();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}/root/", listener.local_addr().unwrap());
        let (send, capture) = tokio::sync::oneshot::channel();
        let server = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(5);
            let mut requests = vec![];
            while requests.len() < if counted { 2 } else { 1 } {
                let (mut socket, _) = loop {
                    match listener.accept() {
                        Ok(pair) => break pair,
                        Err(e)
                            if e.kind() == std::io::ErrorKind::WouldBlock
                                && Instant::now() < deadline =>
                        {
                            std::thread::sleep(Duration::from_millis(2))
                        }
                        Err(e) => panic!("bounded fixture accept: {e}"),
                    }
                };
                socket.set_nonblocking(false).unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                socket
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut headers = vec![];
                let mut byte = [0];
                while !headers.ends_with(b"\r\n\r\n") {
                    socket.read_exact(&mut byte).unwrap();
                    headers.push(byte[0]);
                    assert!(headers.len() < 65536);
                }
                let headers = String::from_utf8(headers).unwrap();
                let size = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length:")
                            .map(|s| s.trim().parse::<usize>().unwrap())
                    })
                    .unwrap();
                assert!(size < 65536);
                let mut body = vec![0; size];
                socket.read_exact(&mut body).unwrap();
                requests.push((headers, serde_json::from_slice::<Value>(&body).unwrap()));
                let count = counted && requests.len() == 1;
                let (content_type, body) = if count {
                    (
                        "application/json",
                        "{\"input_tokens\":12,\"totalTokens\":12}",
                    )
                } else {
                    ("text/event-stream", stream.as_str())
                };
                write!(socket,"HTTP/1.1 200 OK\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",body.len()).unwrap();
            }
            send.send(requests).unwrap();
        });
        let root = tempfile::tempdir().unwrap();
        let mut config = case["config"].clone();
        config["channels"][0]["baseUrl"] = json!(base);
        std::fs::write(
            root.path().join("llm-providers.json"),
            serde_json::to_vec(&config).unwrap(),
        )
        .unwrap();
        let cancel = CancellationToken::new();
        let model = load_model(root.path(), &case["selected"], &cancel)
            .await
            .unwrap();
        let request = model
            .prepare_request(
                data["system"].as_str().unwrap(),
                &json!({"messages":data["messages"]}),
                &data["tools"],
                &LiveHistory::default(),
            )
            .unwrap();
        let fingerprint = request.fingerprint().to_owned();
        let count = request.count_input_tokens(&cancel).await.unwrap();
        assert_eq!(count.is_some(), counted, "{}", case["name"]);
        if let Some(count) = count {
            assert_eq!(count.input_tokens, 12);
            assert_eq!(count.request_fingerprint, fingerprint);
        }
        let turn = request.send(&cancel).await.unwrap();
        assert_eq!(turn.request_fingerprint, fingerprint);
        let requests = capture.await.unwrap();
        server.join().unwrap();
        assert_eq!(
            requests.last().unwrap().1,
            case["expected"]["request"],
            "{}",
            case["name"]
        );
        for (headers, _) in &requests {
            let headers = headers.to_ascii_lowercase();
            for (name, value) in case["expected"]["headers"].as_object().unwrap() {
                assert_eq!(
                    headers
                        .lines()
                        .filter(|line| line.starts_with(&format!("{name}:")))
                        .count(),
                    1,
                    "{} duplicate {name}",
                    case["name"]
                );
                assert!(
                    headers.contains(&format!(
                        "{name}: {}\r\n",
                        value.as_str().unwrap().to_ascii_lowercase()
                    )),
                    "{} missing {name}",
                    case["name"]
                );
            }
            assert!(!headers.contains("authorization:"));
            assert!(!headers.contains("x-api-key:"));
        }
        if counted {
            let (headers, body) = &requests[0];
            let mut expected = case["expected"]["request"].clone();
            if wire == Wire::Anthropic {
                assert!(headers.starts_with("POST /root/v1/messages/count_tokens HTTP/"));
                expected.as_object_mut().unwrap().remove("max_tokens");
                expected.as_object_mut().unwrap().remove("stream");
            } else {
                assert!(headers.contains(":countTokens HTTP/"));
                expected["model"] = json!(format!(
                    "models/{}",
                    case["selected"]["modelId"]
                        .as_str()
                        .unwrap()
                        .trim_start_matches("models/")
                ));
                expected = json!({"generateContentRequest":expected});
            }
            assert_eq!(body, &expected, "{}", case["name"]);
        }
    }
}
