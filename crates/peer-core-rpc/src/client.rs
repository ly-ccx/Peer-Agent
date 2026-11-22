//! Cross-platform async JSON-RPC client for connecting to a running `peer core --daemon`.

use crate::{
    daemon::{DaemonDescriptor, read_daemon_descriptor},
    protocol::{
        ExternalCapabilityManifest, InitializeParams, InitializeResult, MAX_FRAME_BYTES,
        PROTOCOL_VERSION, RpcError,
    },
    transport::{BoundedLineReader, FrameWriter, FrameWriterHandle},
};
use peer_runtime::CancellationToken;
use serde_json::{Value, json};
use std::{collections::VecDeque, io, path::Path, pin::Pin, sync::Arc, time::Duration};
use tokio::io::AsyncRead;

pub type HostRequestHandler =
    Arc<dyn Fn(&str, &Value) -> Result<Value, RpcError> + Send + Sync + 'static>;

const DEFAULT_RPC_TIMEOUT: Duration = Duration::from_secs(30);
const PROBE_TIMEOUT: Duration = Duration::from_millis(600);

type BoxedReadHalf = Pin<Box<dyn AsyncRead + Send + Unpin>>;

pub struct RawDaemonConnection {
    reader: BoundedLineReader<BoxedReadHalf>,
    writer_handle: Option<FrameWriterHandle>,
    writer: FrameWriter,
    next_id: u64,
    shutdown: CancellationToken,
    notifications: VecDeque<(String, Value)>,
    host_handler: Option<HostRequestHandler>,
}

impl RawDaemonConnection {
    pub async fn connect(endpoint: &str, transport: &str) -> io::Result<Self> {
        #[cfg(unix)]
        let (read_half, writer_handle): (BoxedReadHalf, FrameWriterHandle) = {
            if transport != "unix" {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported unix daemon transport: {transport}"),
                ));
            }
            let stream = tokio::net::UnixStream::connect(endpoint).await?;
            let (r, w) = tokio::io::split(stream);
            (Box::pin(r), FrameWriterHandle::spawn(w))
        };

        #[cfg(windows)]
        let (read_half, writer_handle): (BoxedReadHalf, FrameWriterHandle) = {
            if transport != "named_pipe" {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidInput,
                    format!("unsupported windows daemon transport: {transport}"),
                ));
            }
            let client = tokio::net::windows::named_pipe::ClientOptions::new().open(endpoint)?;
            let (r, w) = tokio::io::split(client);
            (Box::pin(r), FrameWriterHandle::spawn(w))
        };

        let writer = writer_handle.writer();
        Ok(Self {
            reader: BoundedLineReader::new(read_half),
            writer_handle: Some(writer_handle),
            writer,
            next_id: 1,
            shutdown: CancellationToken::new(),
            notifications: VecDeque::new(),
            host_handler: None,
        })
    }

    pub fn set_host_handler(&mut self, handler: HostRequestHandler) {
        self.host_handler = Some(handler);
    }

    pub async fn send_raw_request(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> io::Result<Result<Value, RpcError>> {
        let id = self.next_id;
        self.next_id += 1;
        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        self.writer.send_value(&payload).await?;

        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    format!("daemon RPC '{method}' timed out"),
                ));
            }
            let next = tokio::time::timeout(remaining, self.reader.next_line(&self.shutdown))
                .await
                .map_err(|_| {
                    io::Error::new(
                        io::ErrorKind::TimedOut,
                        format!("daemon RPC '{method}' timed out"),
                    )
                })??;
            let Some(frame) = next else {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "daemon closed connection before response",
                ));
            };
            if frame.len() > MAX_FRAME_BYTES || frame.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let msg: Value = serde_json::from_slice(&frame)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;

            if let Some(resp_method) = msg.get("method").and_then(Value::as_str) {
                if let Some(req_id) = msg.get("id").cloned() {
                    let req_params = msg.get("params").cloned().unwrap_or(Value::Null);
                    let reply = self.handle_reverse_call(req_id, resp_method, &req_params);
                    let _ = self.writer.send_value(&reply).await;
                } else {
                    self.notifications.push_back((
                        resp_method.to_owned(),
                        msg.get("params").cloned().unwrap_or(Value::Null),
                    ));
                }
                continue;
            }

            if msg.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(err_obj) = msg.get("error") {
                    return Ok(Err(RpcError {
                        code: err_obj["code"].as_i64().unwrap_or(-32603) as i32,
                        message: err_obj["message"]
                            .as_str()
                            .unwrap_or("Daemon RPC error")
                            .to_owned(),
                        data: err_obj.get("data").cloned(),
                    }));
                }
                return Ok(Ok(msg.get("result").cloned().unwrap_or(Value::Null)));
            }
        }
    }

    fn handle_reverse_call(&self, id: Value, method: &str, params: &Value) -> Value {
        if let Some(handler) = &self.host_handler {
            match handler(method, params) {
                Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
                Err(err) => err.to_response(id),
            }
        } else if method == "host.ping" {
            json!({ "jsonrpc": "2.0", "id": id, "result": { "ok": true, "surface": "cli" } })
        } else {
            RpcError::method_not_found(method).to_response(id)
        }
    }

    pub async fn next_notification(
        &mut self,
        timeout: Duration,
    ) -> io::Result<Option<(String, Value)>> {
        if let Some(queued) = self.notifications.pop_front() {
            return Ok(Some(queued));
        }
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
            if remaining.is_zero() {
                return Ok(None);
            }
            let next = match tokio::time::timeout(remaining, self.reader.next_line(&self.shutdown))
                .await
            {
                Ok(res) => res?,
                Err(_) => return Ok(None),
            };
            let Some(frame) = next else {
                return Ok(None);
            };
            if frame.iter().all(u8::is_ascii_whitespace) {
                continue;
            }
            let msg: Value = serde_json::from_slice(&frame)
                .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
            if let Some(method) = msg.get("method").and_then(Value::as_str) {
                if let Some(req_id) = msg.get("id").cloned() {
                    let req_params = msg.get("params").cloned().unwrap_or(Value::Null);
                    let reply = self.handle_reverse_call(req_id, method, &req_params);
                    let _ = self.writer.send_value(&reply).await;
                    continue;
                }
                return Ok(Some((
                    method.to_owned(),
                    msg.get("params").cloned().unwrap_or(Value::Null),
                )));
            }
        }
    }

    pub async fn finish(mut self) {
        self.shutdown.cancel();
        if let Some(handle) = self.writer_handle.take() {
            let _ = handle.finish().await;
        }
    }
}

pub struct DaemonClient {
    conn: RawDaemonConnection,
    descriptor: DaemonDescriptor,
    init: InitializeResult,
}

impl DaemonClient {
    pub async fn connect_data_home(
        data_home: &Path,
        client_name: &str,
        client_version: &str,
        external_capabilities: Vec<ExternalCapabilityManifest>,
    ) -> io::Result<Self> {
        let Some(descriptor) = read_daemon_descriptor(data_home)? else {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "peer core daemon is not running",
            ));
        };
        Self::connect_descriptor(
            &descriptor,
            client_name,
            client_version,
            external_capabilities,
        )
        .await
    }

    pub async fn connect_descriptor(
        descriptor: &DaemonDescriptor,
        client_name: &str,
        client_version: &str,
        external_capabilities: Vec<ExternalCapabilityManifest>,
    ) -> io::Result<Self> {
        let mut conn =
            RawDaemonConnection::connect(&descriptor.endpoint, &descriptor.transport).await?;
        let init_params = InitializeParams {
            protocol_version: PROTOCOL_VERSION,
            client: crate::protocol::ClientInfo {
                name: client_name.to_owned(),
                version: client_version.to_owned(),
            },
            external_capabilities,
            auth_token: Some(descriptor.auth_token.clone()),
        };
        let params_val = serde_json::to_value(init_params)
            .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
        let reply = conn
            .send_raw_request("core.initialize", params_val, DEFAULT_RPC_TIMEOUT)
            .await?;
        match reply {
            Ok(val) => {
                let init: InitializeResult = serde_json::from_value(val)
                    .map_err(|err| io::Error::new(io::ErrorKind::InvalidData, err))?;
                Ok(Self {
                    conn,
                    descriptor: descriptor.clone(),
                    init,
                })
            }
            Err(rpc_err) => {
                conn.finish().await;
                Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    format!(
                        "core.initialize failed ({}): {}",
                        rpc_err.code, rpc_err.message
                    ),
                ))
            }
        }
    }

    pub async fn probe_descriptor(descriptor: &DaemonDescriptor) -> bool {
        let fut = async {
            let client = Self::connect_descriptor(
                descriptor,
                "peer-probe",
                &descriptor.server_version,
                vec![],
            )
            .await?;
            let _ = client.disconnect().await;
            Ok::<(), io::Error>(())
        };
        matches!(tokio::time::timeout(PROBE_TIMEOUT, fut).await, Ok(Ok(())))
    }

    pub fn set_host_handler(&mut self, handler: HostRequestHandler) {
        self.conn.set_host_handler(handler);
    }

    pub fn initialize_result(&self) -> &InitializeResult {
        &self.init
    }

    pub fn descriptor(&self) -> &DaemonDescriptor {
        &self.descriptor
    }

    pub async fn request(
        &mut self,
        method: &str,
        params: Value,
    ) -> io::Result<Result<Value, RpcError>> {
        self.conn
            .send_raw_request(method, params, DEFAULT_RPC_TIMEOUT)
            .await
    }

    pub async fn request_with_timeout(
        &mut self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> io::Result<Result<Value, RpcError>> {
        self.conn.send_raw_request(method, params, timeout).await
    }

    pub async fn next_notification(
        &mut self,
        timeout: Duration,
    ) -> io::Result<Option<(String, Value)>> {
        self.conn.next_notification(timeout).await
    }

    pub async fn disconnect(mut self) -> io::Result<Value> {
        let res = self
            .conn
            .send_raw_request("core.shutdown", json!({}), Duration::from_secs(2))
            .await;
        self.conn.finish().await;
        match res {
            Ok(Ok(val)) => Ok(val),
            Ok(Err(err)) => Err(io::Error::other(err.message)),
            Err(err) => Err(err),
        }
    }

    pub async fn shutdown_daemon(mut self) -> io::Result<Value> {
        let res = self
            .conn
            .send_raw_request(
                "core.shutdown",
                json!({ "shutdownDaemon": true }),
                Duration::from_secs(5),
            )
            .await;
        self.conn.finish().await;
        match res {
            Ok(Ok(val)) => Ok(val),
            Ok(Err(err)) => Err(io::Error::other(err.message)),
            Err(err) => Err(err),
        }
    }

    pub async fn shutdown_if_last(mut self) -> io::Result<Value> {
        let res = self
            .conn
            .send_raw_request(
                "core.shutdown",
                json!({ "shutdownIfLast": true }),
                Duration::from_secs(5),
            )
            .await;
        self.conn.finish().await;
        match res {
            Ok(Ok(val)) => Ok(val),
            Ok(Err(err)) => Err(io::Error::other(err.message)),
            Err(err) => Err(err),
        }
    }
}
