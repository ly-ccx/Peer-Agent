use peer_project_agent::NativeProjectHost;
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    net::TcpListener,
    process::Command,
    time::Duration,
};
use tempfile::tempdir;

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
        "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}
    });
    format!("data: {chunk}\n\ndata: {usage}\n\ndata: [DONE]\n\n")
}

fn spawn_single_reply_server(
    anchor_msg_id: String,
    reply_text: String,
) -> (String, std::thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base_url = format!("http://{}", listener.local_addr().unwrap());
    let thread = std::thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut header = Vec::new();
        let mut b = [0u8; 1];
        while !header.ends_with(b"\r\n\r\n") {
            socket.read_exact(&mut b).unwrap();
            header.push(b[0]);
        }
        let header_str = String::from_utf8(header).unwrap();
        let len: usize = header_str
            .lines()
            .find_map(|l| {
                l.to_ascii_lowercase()
                    .strip_prefix("content-length:")
                    .and_then(|v| v.trim().parse().ok())
            })
            .unwrap_or(0);
        let mut body = vec![0u8; len];
        if len > 0 {
            socket.read_exact(&mut body).unwrap();
        }
        let sse = sse_tool_call(
            "cli-bot-1",
            "post_reply",
            &json!({
                "replyTo": [anchor_msg_id],
                "text": reply_text
            }),
        );
        let resp = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            sse.len(),
            sse
        );
        socket.write_all(resp.as_bytes()).unwrap();
        let _ = socket.flush();
    });
    (base_url, thread)
}

#[test]
fn peer_exec_bot_and_bots_json_work_natively_without_bun_or_node() {
    let home = tempdir().unwrap();
    let ws = tempdir().unwrap();
    let bin = env!("CARGO_BIN_EXE_peer-native");

    // 1. Unbound workspace -> exit code 2 (Usage) and error = bot_not_bound
    let unbound = Command::new(bin)
        .env("PEER_AGENT_HOME", home.path())
        .args([
            "exec",
            "--bot",
            "--output-format",
            "json",
            "--workspace",
            ws.path().to_str().unwrap(),
            "hello",
        ])
        .output()
        .unwrap();
    assert_eq!(unbound.status.code(), Some(2));
    let unbound_json: Value = serde_json::from_slice(&unbound.stdout).unwrap();
    assert_eq!(unbound_json["ok"], false);
    assert_eq!(unbound_json["error"], "bot_not_bound");

    // 2. Bind workspace and list via `peer bots --json`
    let host = NativeProjectHost::new(home.path(), "0.1.0-test", Some(1)).unwrap();
    let (entry, profile) = host.bind_workspace(ws.path(), Some("CLI Bot")).unwrap();
    host.close();

    let bots_out = Command::new(bin)
        .env("PEER_AGENT_HOME", home.path())
        .args(["bots", "--json"])
        .output()
        .unwrap();
    assert_eq!(bots_out.status.code(), Some(0));
    let bots_json: Value = serde_json::from_slice(&bots_out.stdout).unwrap();
    assert_eq!(bots_json.as_array().unwrap().len(), 1);
    assert_eq!(bots_json[0]["workspaceId"], entry.workspace_id);
    assert_eq!(bots_json[0]["profile"]["displayName"], "CLI Bot");

    // 3. Run `peer exec --bot` against mock env model server -> exit 0 + canonical JSON receipt
    let input_id = "cli-req-1";
    let anchor = peer_project_agent::input_message_id(input_id).unwrap();
    let (base_url, server_thread) =
        spawn_single_reply_server(anchor, "Native Rust Bot answered cleanly.".into());

    let exec_out = Command::new(bin)
        .env("PEER_AGENT_HOME", home.path())
        .env("PEER_MODEL_API_KEY", "test-key")
        .env("PEER_MODEL_BASE_URL", &base_url)
        .env("PEER_MODEL_ID", "mock-cli-bot")
        .args([
            "exec",
            "--bot",
            "--input-id",
            input_id,
            "--wait-ms",
            "5000",
            "--output-format",
            "json",
            "--workspace",
            ws.path().to_str().unwrap(),
            "Ping bot",
        ])
        .output()
        .unwrap();
    server_thread.join().unwrap();
    assert_eq!(
        exec_out.status.code(),
        Some(0),
        "stderr: {}",
        String::from_utf8_lossy(&exec_out.stderr)
    );
    let exec_json: Value = serde_json::from_slice(&exec_out.stdout).unwrap();
    assert_eq!(exec_json["ok"], true);
    assert_eq!(
        exec_json["sessionId"],
        profile.agent_conversation_id.as_deref().unwrap()
    );
    assert_eq!(exec_json["result"], "Native Rust Bot answered cleanly.");
    assert_eq!(exec_json["botInput"]["inputId"], input_id);
    assert_eq!(exec_json["botInput"]["status"], "replied");
    assert!(exec_json["botInput"]["replyId"].as_str().is_some());

    // 4. Re-running same input_id with conflicting prompt fails with bot_input_conflict
    let conflict = Command::new(bin)
        .env("PEER_AGENT_HOME", home.path())
        .args([
            "exec",
            "--bot",
            "--input-id",
            input_id,
            "--wait-ms",
            "500",
            "--output-format",
            "json",
            "--workspace",
            ws.path().to_str().unwrap(),
            "Different prompt",
        ])
        .output()
        .unwrap();
    assert_eq!(conflict.status.code(), Some(1));
    let conflict_json: Value = serde_json::from_slice(&conflict.stdout).unwrap();
    assert_eq!(conflict_json["error"], "bot_input_conflict");
}
