use crate::{
    protocol::{
        CapabilitiesListResult, CoreCapabilitiesSummary, DEFAULT_REVERSE_TIMEOUT,
        ExternalCapabilityManifest, InitializeParams, InitializeResult, MAX_FRAME_BYTES,
        MAX_PENDING_HOST_CALLS, PROTOCOL_VERSION, PingParams, PingResult, RpcError, ServerInfo,
        ShutdownResult,
    },
    transport::{BoundedLineReader, FrameWriter, FrameWriterHandle},
};
use peer_protocol::{JsonDecodeError, JsonLimits, decode_json_bounded};
use peer_runtime::CancellationToken;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::oneshot,
    task::JoinSet,
};

const MAX_INBOUND_STRING_BYTES: usize = 1024 * 1024;
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone)]
pub struct CoreServerConfig {
    pub version: String,
    pub data_home: PathBuf,
    pub reverse_request_timeout: Duration,
}

impl CoreServerConfig {
    pub fn new(version: impl Into<String>, data_home: PathBuf) -> Self {
        Self {
            version: version.into(),
            data_home,
            reverse_request_timeout: DEFAULT_REVERSE_TIMEOUT,
        }
    }
}

#[derive(Default)]
struct CoreState {
    initialized: bool,
    draining: bool,
    client: Option<crate::protocol::ClientInfo>,
    external_capabilities: Vec<ExternalCapabilityManifest>,
}

type PendingMap = HashMap<String, oneshot::Sender<Result<Value, RpcError>>>;

#[derive(Clone)]
pub struct RpcPeer {
    writer: FrameWriter,
    next_id: Arc<AtomicU64>,
    pending: Arc<Mutex<PendingMap>>,
    shutdown: CancellationToken,
    reverse_timeout: Duration,
}

impl RpcPeer {
    fn new(writer: FrameWriter, shutdown: CancellationToken, reverse_timeout: Duration) -> Self {
        Self {
            writer,
            next_id: Arc::new(AtomicU64::new(1)),
            pending: Arc::new(Mutex::new(HashMap::new())),
            shutdown,
            reverse_timeout,
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> io::Result<()> {
        self.writer
            .send_value(&json!({
                "jsonrpc": "2.0",
                "method": method,
                "params": params,
            }))
            .await
    }

    pub async fn call_host(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if self.shutdown.is_cancelled() || cancel.is_cancelled() {
            return Err(RpcError::shutting_down());
        }
        let id = format!("core-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = self
                .pending
                .lock()
                .map_err(|_| RpcError::internal_error("pending host call lock poisoned"))?;
            if guard.len() >= MAX_PENDING_HOST_CALLS {
                return Err(RpcError::host_call_failed(
                    "Too many concurrent host requests",
                    None,
                ));
            }
            guard.insert(id.clone(), tx);
        }

        let payload = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        if let Err(err) = self.writer.send_value(&payload).await {
            self.remove_pending(&id);
            return Err(RpcError::host_call_failed(
                format!("Failed to write host request: {err}"),
                None,
            ));
        }

        let timeout = tokio::time::sleep(self.reverse_timeout);
        tokio::pin!(timeout);

        let response = tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => {
                self.remove_pending(&id);
                Err(RpcError::shutting_down())
            }
            _ = cancel.cancelled() => {
                self.remove_pending(&id);
                Err(RpcError::host_call_failed("Host request cancelled", None))
            }
            _ = &mut timeout => {
                self.remove_pending(&id);
                Err(RpcError::host_call_failed(
                    format!("Host request '{method}' timed out"),
                    None,
                ))
            }
            res = rx => match res {
                Ok(inner) => inner,
                Err(_) => Err(RpcError::host_call_failed(
                    format!("Host request '{method}' closed before reply"),
                    None,
                )),
            }
        };
        response
    }

    fn resolve_pending(&self, id: &str, message: &Value) {
        let sender = self.pending.lock().ok().and_then(|mut map| map.remove(id));
        let Some(tx) = sender else {
            return;
        };
        let outcome = if let Some(error_obj) = message.get("error") {
            let code = error_obj["code"].as_i64().unwrap_or(-32004) as i32;
            let msg = error_obj["message"]
                .as_str()
                .unwrap_or("Host request failed")
                .to_owned();
            let data = error_obj.get("data").cloned();
            Err(RpcError {
                code,
                message: msg,
                data,
            })
        } else {
            Ok(message.get("result").cloned().unwrap_or(Value::Null))
        };
        let _ = tx.send(outcome);
    }

    fn remove_pending(&self, id: &str) {
        if let Ok(mut map) = self.pending.lock() {
            map.remove(id);
        }
    }

    fn fail_all_pending(&self, reason: &str) {
        if let Ok(mut map) = self.pending.lock() {
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::host_call_failed(reason, None)));
            }
        }
    }
}

struct ServerContext {
    config: CoreServerConfig,
    started_at: Instant,
    state: Mutex<CoreState>,
    peer: RpcPeer,
}

impl ServerContext {
    fn snapshot_capabilities(
        &self,
    ) -> Result<(bool, bool, Vec<ExternalCapabilityManifest>), RpcError> {
        let guard = self
            .state
            .lock()
            .map_err(|_| RpcError::internal_error("server state poisoned"))?;
        Ok((
            guard.initialized,
            guard.draining,
            guard.external_capabilities.clone(),
        ))
    }

    fn initialize(&self, params_value: Value) -> Result<Value, RpcError> {
        let params: InitializeParams = serde_json::from_value(params_value)
            .map_err(|err| RpcError::invalid_params(format!("Invalid initialize params: {err}")))?;
        params.validate()?;

        let mut guard = self
            .state
            .lock()
            .map_err(|_| RpcError::internal_error("server state poisoned"))?;
        if guard.draining {
            return Err(RpcError::shutting_down());
        }
        if guard.initialized {
            return Err(RpcError::already_initialized());
        }
        let aliases = params
            .external_capabilities
            .iter()
            .map(|c| c.alias.clone())
            .collect();
        guard.initialized = true;
        guard.client = Some(params.client);
        guard.external_capabilities = params.external_capabilities;

        let result = InitializeResult {
            protocol_version: PROTOCOL_VERSION,
            server: ServerInfo {
                name: "peer-core".into(),
                version: self.config.version.clone(),
            },
            pid: std::process::id(),
            capabilities: CoreCapabilitiesSummary {
                domains: vec!["core".into()],
                planned_domains: vec!["classic.chat".into(), "classic.goal".into(), "bot".into()],
                bidirectional_host_calls: true,
                registered_external_capabilities: aliases,
            },
        };
        serde_json::to_value(result).map_err(|err| RpcError::internal_error(err.to_string()))
    }

    fn begin_shutdown(&self) -> Result<Value, RpcError> {
        let mut guard = self
            .state
            .lock()
            .map_err(|_| RpcError::internal_error("server state poisoned"))?;
        guard.draining = true;
        serde_json::to_value(ShutdownResult {
            ok: true,
            draining: true,
        })
        .map_err(|err| RpcError::internal_error(err.to_string()))
    }

    async fn handle_request(&self, method: &str, params: Value) -> Result<Value, RpcError> {
        let (initialized, draining, external_capabilities) = self.snapshot_capabilities()?;
        if draining {
            return Err(RpcError::shutting_down());
        }
        if !initialized {
            return Err(RpcError::not_initialized());
        }
        match method {
            "core.ping" => {
                let parsed: PingParams = if params.is_null() {
                    PingParams::default()
                } else {
                    serde_json::from_value(params).map_err(|err| {
                        RpcError::invalid_params(format!("Invalid ping params: {err}"))
                    })?
                };
                let host_probe = if parsed.probe_host {
                    Some(
                        self.peer
                            .call_host("host.ping", json!({}), &self.peer.shutdown)
                            .await
                            .map_err(|err| {
                                RpcError::host_call_failed(
                                    format!("host.ping failed: {}", err.message),
                                    Some(err.to_error_object()),
                                )
                            })?,
                    )
                } else {
                    None
                };
                let uptime_ms =
                    u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
                serde_json::to_value(PingResult {
                    ok: true,
                    server_version: self.config.version.clone(),
                    uptime_ms,
                    pid: std::process::id(),
                    host_probe,
                })
                .map_err(|err| RpcError::internal_error(err.to_string()))
            }
            "core.capabilities.list" => serde_json::to_value(CapabilitiesListResult {
                domains: vec!["core".into()],
                external_capabilities,
            })
            .map_err(|err| RpcError::internal_error(err.to_string())),
            _ => Err(RpcError::method_not_found(method)),
        }
    }
}

pub async fn serve_stdio(config: CoreServerConfig, shutdown: CancellationToken) -> io::Result<()> {
    serve_io(tokio::io::stdin(), tokio::io::stdout(), config, shutdown).await
}

pub async fn serve_io<R, W>(
    reader: R,
    writer: W,
    config: CoreServerConfig,
    shutdown: CancellationToken,
) -> io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut line_reader = BoundedLineReader::new(reader);
    let writer_handle = FrameWriterHandle::spawn(writer);
    let peer = RpcPeer::new(
        writer_handle.writer(),
        shutdown.clone(),
        config.reverse_request_timeout,
    );
    let context = Arc::new(ServerContext {
        config,
        started_at: Instant::now(),
        state: Mutex::new(CoreState::default()),
        peer: peer.clone(),
    });
    let mut tasks = JoinSet::new();

    let loop_result: io::Result<()> = loop {
        while tasks.try_join_next().is_some() {}

        let next = line_reader.next_line(&shutdown).await;
        let frame = match next {
            Ok(Some(frame)) => frame,
            Ok(None) => break Ok(()),
            Err(err) => {
                // Report frame limit errors cleanly before closing if the pipe is still open.
                let _ = peer
                    .writer
                    .send_value(
                        &RpcError::invalid_request(err.to_string()).to_response(Value::Null),
                    )
                    .await;
                break Err(err);
            }
        };

        if frame.iter().all(u8::is_ascii_whitespace) {
            continue;
        }

        let decoded = match decode_json_bounded(
            &frame,
            JsonLimits {
                bytes: MAX_FRAME_BYTES,
                nodes: 32_768,
                depth: 64,
                string_bytes: MAX_INBOUND_STRING_BYTES,
            },
        ) {
            Ok(doc) => doc.value,
            Err(JsonDecodeError::LimitExceeded) => {
                if let Err(write_err) = peer
                    .writer
                    .send_value(
                        &RpcError::invalid_request("JSON frame limit exceeded")
                            .to_response(Value::Null),
                    )
                    .await
                {
                    break Err(write_err);
                }
                continue;
            }
            Err(JsonDecodeError::InvalidJson) => {
                if let Err(write_err) = peer
                    .writer
                    .send_value(&RpcError::parse_error("Invalid JSON").to_response(Value::Null))
                    .await
                {
                    break Err(write_err);
                }
                continue;
            }
        };

        let Some(obj) = decoded.as_object() else {
            if let Err(write_err) = peer
                .writer
                .send_value(
                    &RpcError::invalid_request("JSON-RPC payload must be an object")
                        .to_response(Value::Null),
                )
                .await
            {
                break Err(write_err);
            }
            continue;
        };

        let reply_id = extract_valid_id(obj.get("id"));
        if obj.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            let err_id = reply_id.flatten().unwrap_or(Value::Null);
            if let Err(write_err) = peer
                .writer
                .send_value(
                    &RpcError::invalid_request("jsonrpc version must be '2.0'").to_response(err_id),
                )
                .await
            {
                break Err(write_err);
            }
            continue;
        }

        // Handle responses to core -> host reverse requests directly on the read loop
        // so concurrent in-flight request tasks never deadlock awaiting host responses.
        if !obj.contains_key("method") {
            let has_result = obj.contains_key("result");
            let has_error = obj.contains_key("error");
            if (has_result ^ has_error)
                && let Some(id_str) = obj.get("id").and_then(Value::as_str)
            {
                peer.resolve_pending(id_str, &decoded);
                continue;
            }
            let err_id = reply_id.flatten().unwrap_or(Value::Null);
            if let Err(write_err) = peer
                .writer
                .send_value(
                    &RpcError::invalid_request("Malformed JSON-RPC message").to_response(err_id),
                )
                .await
            {
                break Err(write_err);
            }
            continue;
        }

        let Some(method) = obj.get("method").and_then(Value::as_str) else {
            let err_id = reply_id.flatten().unwrap_or(Value::Null);
            if let Err(write_err) = peer
                .writer
                .send_value(
                    &RpcError::invalid_request("JSON-RPC method must be a string")
                        .to_response(err_id),
                )
                .await
            {
                break Err(write_err);
            }
            continue;
        };

        let params = obj.get("params").cloned().unwrap_or(Value::Null);
        match reply_id {
            // Invalid `id` type present on a request.
            None if obj.contains_key("id") => {
                if let Err(write_err) = peer
                    .writer
                    .send_value(
                        &RpcError::invalid_request("Invalid JSON-RPC request id")
                            .to_response(Value::Null),
                    )
                    .await
                {
                    break Err(write_err);
                }
            }
            // Notification (no `"id"` field).
            None => {
                if method == "core.shutdown" {
                    let _ = context.begin_shutdown();
                    break Ok(());
                }
            }
            // Request with valid `"id"`.
            Some(Some(id)) => match method {
                "core.initialize" => {
                    let response = format_reply(id, context.initialize(params));
                    if let Err(write_err) = peer.writer.send_value(&response).await {
                        break Err(write_err);
                    }
                }
                "core.shutdown" => {
                    let response = format_reply(id, context.begin_shutdown());
                    let send_res = peer.writer.send_value(&response).await;
                    break send_res;
                }
                _ => {
                    let ctx = Arc::clone(&context);
                    let method_owned = method.to_owned();
                    tasks.spawn(async move {
                        let res = ctx.handle_request(&method_owned, params).await;
                        let response = format_reply(id, res);
                        let _ = ctx.peer.writer.send_value(&response).await;
                    });
                }
            },
            // Unreachable because reply_id == Some(None) doesn't happen, satisfy exhaustiveness.
            Some(None) => unreachable!(),
        }
    };

    drop(line_reader);
    shutdown.cancel();
    peer.fail_all_pending("Core server shutting down");
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    drop(context);
    drop(peer);
    let flush_result = writer_handle.finish().await;

    match (loop_result, flush_result) {
        (Err(err), _) => Err(err),
        (Ok(()), Err(flush_err)) => Err(flush_err),
        (Ok(()), Ok(())) => Ok(()),
    }
}

fn format_reply(id: Value, result: Result<Value, RpcError>) -> Value {
    match result {
        Ok(value) => json!({
            "jsonrpc": "2.0",
            "id": id,
            "result": value,
        }),
        Err(err) => err.to_response(id),
    }
}

/// Returns `Some(Some(id))` if `"id"` key is present and valid (`String | Number | Null`),
/// `None` if `"id"` is absent OR invalid (callers check `obj.contains_key("id")`).
fn extract_valid_id(id: Option<&Value>) -> Option<Option<Value>> {
    let val = id?;
    if val.is_string() || val.is_i64() || val.is_u64() || val.is_null() {
        Some(Some(val.clone()))
    } else {
        None
    }
}
