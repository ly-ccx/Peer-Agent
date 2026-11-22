#![forbid(unsafe_code)]

//! Cross-platform bidirectional NDJSON JSON-RPC 2.0 host bridge for Peer Core.
//!
//! Exposes the local Rust runtime to thin UI shells (`peer core --stdio`) while
//! keeping capability projection, permission gates, storage and Evidence local.

pub mod classic;
mod classic_conversations;
mod classic_goal;
mod classic_llm;
mod classic_mcp;
mod classic_skills;
mod classic_streams;
mod classic_usage;
mod external_provider;
mod project;
mod project_bot;
mod project_bot_ops;
mod project_bot_read;
pub mod protocol;
pub mod server;
mod transport;

pub use classic::{ModelLoader, ResolvedTurnModel};
pub use protocol::{
    ClientInfo, CoreCapabilitiesSummary, DEFAULT_REVERSE_TIMEOUT, ExternalCapabilityManifest,
    InitializeParams, InitializeResult, MAX_EXTERNAL_CAPABILITIES, MAX_FRAME_BYTES,
    PROTOCOL_VERSION, PingParams, PingResult, RpcError, ServerInfo, ShutdownResult,
};
pub use server::{CoreServerConfig, RpcPeer, serve_io, serve_stdio};

#[cfg(test)]
mod tests {
    use super::*;
    use peer_runtime::CancellationToken;
    use serde_json::{Value, json};
    use std::time::Duration;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, DuplexStream};

    struct TestClient {
        reader: BufReader<tokio::io::ReadHalf<DuplexStream>>,
        writer: tokio::io::WriteHalf<DuplexStream>,
    }

    impl TestClient {
        async fn send(&mut self, value: &Value) {
            let mut line = serde_json::to_vec(value).expect("serialize request");
            line.push(b'\n');
            self.writer.write_all(&line).await.expect("write line");
            self.writer.flush().await.expect("flush line");
        }

        async fn send_raw(&mut self, bytes: &[u8]) {
            self.writer.write_all(bytes).await.expect("write raw");
            self.writer.flush().await.expect("flush raw");
        }

        async fn recv(&mut self) -> Option<Value> {
            let mut line = String::new();
            let n = self.reader.read_line(&mut line).await.expect("read line");
            if n == 0 {
                return None;
            }
            Some(serde_json::from_str(&line).expect("parse response"))
        }
    }

    fn spawn_server(
        timeout: Duration,
    ) -> (
        TestClient,
        CancellationToken,
        tokio::task::JoinHandle<std::io::Result<()>>,
    ) {
        let (client_stream, server_stream) = tokio::io::duplex(256 * 1024);
        let (server_read, server_write) = tokio::io::split(server_stream);
        let (client_read, client_write) = tokio::io::split(client_stream);
        let shutdown = CancellationToken::new();
        let config = CoreServerConfig {
            reverse_request_timeout: timeout,
            ..CoreServerConfig::new("0.1.0-test", tempfile::tempdir().expect("tempdir").keep())
        };
        let handle = tokio::spawn(serve_io(
            server_read,
            server_write,
            config,
            shutdown.clone(),
        ));
        (
            TestClient {
                reader: BufReader::new(client_read),
                writer: client_write,
            },
            shutdown,
            handle,
        )
    }

    #[tokio::test]
    async fn initialize_ping_capabilities_and_graceful_shutdown() {
        let (mut client, _shutdown, server_handle) = spawn_server(Duration::from_secs(5));

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "core.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "client": { "name": "peer-desktop", "version": "0.1.0-test" },
                    "externalCapabilities": [
                        {
                            "alias": "browser_open",
                            "capabilityId": "local.web.control.open",
                            "manifest": {
                                "capabilityId": "local.web.control.open",
                                "description": "Open webview"
                            }
                        }
                    ]
                }
            }))
            .await;

        let init = client.recv().await.expect("init reply");
        assert_eq!(init["id"], 1);
        assert_eq!(init["result"]["protocolVersion"], PROTOCOL_VERSION);
        assert_eq!(init["result"]["server"]["name"], "peer-core");
        assert_eq!(init["result"]["server"]["version"], "0.1.0-test");
        assert_eq!(
            init["result"]["capabilities"]["registeredExternalCapabilities"],
            json!(["browser_open"])
        );

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "core.ping",
                "params": { "probeHost": false }
            }))
            .await;
        let ping = client.recv().await.expect("ping reply");
        assert_eq!(ping["id"], 2);
        assert_eq!(ping["result"]["ok"], true);
        assert!(ping["result"]["hostProbe"].is_null());

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "core.capabilities.list",
                "params": {}
            }))
            .await;
        let caps = client.recv().await.expect("caps reply");
        assert_eq!(caps["id"], 3);
        assert_eq!(
            caps["result"]["domains"],
            json!([
                "core",
                "classic.chat",
                "classic.goal",
                "classic.conversations",
                "classic.usage",
                "classic.skills",
                "classic.mcp",
                "classic.llm",
                "project.memory",
                "project.objectives",
                "project.profile",
                "project.access",
                "project.bot"
            ])
        );
        assert_eq!(
            caps["result"]["externalCapabilities"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            caps["result"]["externalCapabilities"][0]["alias"],
            "browser_open"
        );

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "core.shutdown",
                "params": {}
            }))
            .await;
        let shutdown_reply = client.recv().await.expect("shutdown reply");
        assert_eq!(shutdown_reply["id"], 4);
        assert_eq!(shutdown_reply["result"]["ok"], true);
        assert_eq!(shutdown_reply["result"]["draining"], true);
        assert!(client.recv().await.is_none());

        server_handle
            .await
            .expect("join")
            .expect("clean server exit");
    }

    #[tokio::test]
    async fn uninitialized_requests_rejected_and_double_init_rejected() {
        let (mut client, _shutdown, server_handle) = spawn_server(Duration::from_secs(5));

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "core.ping",
                "params": {}
            }))
            .await;
        let uninit = client.recv().await.expect("uninitialized error");
        assert_eq!(uninit["id"], 1);
        assert_eq!(uninit["error"]["code"], protocol::CODE_NOT_INITIALIZED);

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "core.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "client": { "name": "test", "version": "1.0.0" }
                }
            }))
            .await;
        let ok_init = client.recv().await.expect("first init ok");
        assert!(ok_init["result"]["protocolVersion"].is_u64());

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "core.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "client": { "name": "test", "version": "1.0.0" }
                }
            }))
            .await;
        let double_init = client.recv().await.expect("second init rejected");
        assert_eq!(double_init["id"], 3);
        assert_eq!(
            double_init["error"]["code"],
            protocol::CODE_ALREADY_INITIALIZED
        );

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 4,
                "method": "core.unknown",
                "params": {}
            }))
            .await;
        let unknown = client.recv().await.expect("unknown method");
        assert_eq!(unknown["error"]["code"], protocol::CODE_METHOD_NOT_FOUND);

        drop(client);
        server_handle.await.expect("join").expect("clean eof exit");
    }

    #[tokio::test]
    async fn bidirectional_host_probe_roundtrip_and_host_error_propagation() {
        let (mut client, _shutdown, server_handle) = spawn_server(Duration::from_secs(5));

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "core.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "client": { "name": "peer-desktop", "version": "0.1.0" }
                }
            }))
            .await;
        assert!(client.recv().await.is_some());

        // Trigger bidirectional ping -> server calls host.ping -> client replies -> server returns ping result.
        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 2,
                "method": "core.ping",
                "params": { "probeHost": true }
            }))
            .await;

        let reverse_req = client.recv().await.expect("host.ping request from core");
        assert_eq!(reverse_req["method"], "host.ping");
        let rev_id = reverse_req["id"].clone();
        assert!(rev_id.as_str().unwrap().starts_with("core-"));

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": rev_id,
                "result": { "ok": true, "surface": "desktop-test" }
            }))
            .await;

        let ping_ok = client.recv().await.expect("ping response with hostProbe");
        assert_eq!(ping_ok["id"], 2);
        assert_eq!(
            ping_ok["result"]["hostProbe"],
            json!({ "ok": true, "surface": "desktop-test" })
        );

        // Now verify host error propagation.
        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 3,
                "method": "core.ping",
                "params": { "probeHost": true }
            }))
            .await;
        let reverse_req_2 = client.recv().await.expect("second host.ping");
        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": reverse_req_2["id"],
                "error": { "code": -32099, "message": "host simulated failure" }
            }))
            .await;

        let ping_err = client.recv().await.expect("ping error response");
        assert_eq!(ping_err["id"], 3);
        assert_eq!(ping_err["error"]["code"], protocol::CODE_HOST_CALL_FAILED);
        assert!(
            ping_err["error"]["message"]
                .as_str()
                .unwrap()
                .contains("host simulated failure")
        );

        drop(client);
        server_handle.await.expect("join").expect("clean exit");
    }

    #[tokio::test]
    async fn oversized_frame_and_invalid_json_handled_safely() {
        let (mut client, _shutdown, server_handle) = spawn_server(Duration::from_secs(5));

        client.send_raw(b"{not-valid-json}\n").await;
        let parse_err = client.recv().await.expect("parse error");
        assert_eq!(parse_err["error"]["code"], protocol::CODE_PARSE_ERROR);

        let mut huge = vec![b'a'; MAX_FRAME_BYTES + 16];
        huge.push(b'\n');
        let _ = client.writer.write_all(&huge).await;
        let _ = client.writer.flush().await;

        let frame_err = client.recv().await.expect("oversized frame error");
        assert_eq!(frame_err["error"]["code"], protocol::CODE_INVALID_REQUEST);

        let result = server_handle.await.expect("join");
        assert!(result.is_err());
    }

    #[tokio::test]
    async fn duplicate_external_capability_alias_rejected() {
        let (mut client, _shutdown, server_handle) = spawn_server(Duration::from_secs(5));

        client
            .send(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": "core.initialize",
                "params": {
                    "protocolVersion": PROTOCOL_VERSION,
                    "client": { "name": "peer-desktop", "version": "0.1.0" },
                    "externalCapabilities": [
                        { "alias": "dup", "capabilityId": "a", "manifest": {} },
                        { "alias": "dup", "capabilityId": "b", "manifest": {} }
                    ]
                }
            }))
            .await;

        let reply = client.recv().await.expect("duplicate alias error");
        assert_eq!(reply["id"], 1);
        assert_eq!(reply["error"]["code"], protocol::CODE_INVALID_PARAMS);

        drop(client);
        server_handle.await.expect("join").expect("clean exit");
    }
}
