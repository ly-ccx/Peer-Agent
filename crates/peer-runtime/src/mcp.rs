//! Native MCP owns bounded protocol sessions, never authorization or Evidence.
use crate::{CancellationToken, recorder};
use rmcp::{
    RoleClient, ServiceExt,
    model::ClientConfig,
    service::{Peer, RunningService},
};
use serde_json::{Value, json};
use std::{
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::{
    process::Child,
    sync::{Notify, mpsc},
};
mod transport;
pub(crate) static LIMITS: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/mcp-runtime-v1.json"
    ))
    .unwrap()
});
pub(crate) struct McpState {
    pub closed: AtomicBool,
    pub sent: AtomicBool,
    pub notify: Notify,
    inner: Mutex<WireState>,
    transport_secrets: Mutex<zeroize::Zeroizing<Vec<String>>>,
}
struct WireState {
    bytes: usize,
    frames: usize,
    id: Value,
    initialize_id: Value,
    result: Option<Value>,
    error: Option<&'static str>,
    protocol: Option<String>,
}
#[derive(Default)]
pub(crate) struct Protection(zeroize::Zeroizing<Vec<String>>);
impl Protection {
    pub(crate) fn extend(&mut self, selected: &[String]) -> Result<(), &'static str> {
        bounded_protection(&mut self.0, selected)
    }
    pub(crate) fn values(&self) -> &[String] {
        &self.0
    }
}
fn bounded_protection(values: &mut Vec<String>, selected: &[String]) -> Result<(), &'static str> {
    let mut added = Vec::new();
    for value in selected {
        if !value.is_empty() && !values.contains(value) && !added.contains(&value) {
            added.push(value);
        }
    }
    if values.len() + added.len() > 64
        || values.iter().map(String::len).sum::<usize>()
            + added.iter().map(|v| v.len()).sum::<usize>()
            > 262144
    {
        return Err("mcp_network_protection_limit");
    }
    values.extend(added.into_iter().cloned());
    Ok(())
}
impl McpState {
    fn new() -> Arc<Self> {
        Arc::new(Self {
            closed: AtomicBool::new(false),
            sent: AtomicBool::new(false),
            notify: Notify::new(),
            transport_secrets: Mutex::new(zeroize::Zeroizing::new(Vec::new())),
            inner: Mutex::new(WireState {
                bytes: 0,
                frames: 0,
                id: Value::Null,
                initialize_id: Value::Null,
                result: None,
                error: None,
                protocol: None,
            }),
        })
    }
    pub(crate) fn protect(&self, selected: &[String]) -> Result<(), &'static str> {
        let mut values = self.transport_secrets.lock().unwrap();
        bounded_protection(&mut values, selected)
    }
    pub(crate) fn retain_protection(&self, config: &Value) -> Result<Protection, &'static str> {
        let mut protection = Protection::default();
        protection.extend(&self.transport_secrets.lock().unwrap())?;
        let mut dynamic = zeroize::Zeroizing::new(Vec::new());
        if let Some(values) = config["_credentialRedaction"].as_array() {
            dynamic.extend(values.iter().filter_map(Value::as_str).map(str::to_owned));
        }
        if let Some(headers) = config["headers"].as_object() {
            dynamic.extend(
                headers
                    .iter()
                    .filter(|(k, _)| k.eq_ignore_ascii_case("authorization"))
                    .filter_map(|(_, v)| v.as_str())
                    .map(str::to_owned),
            );
        }
        protection.extend(&dynamic)?;
        Ok(protection)
    }
    pub(crate) fn prepare_result(&self, raw: Value, config: &Value) -> Result<Value, &'static str> {
        result::prepare_result(raw, config, &self.transport_secrets.lock().unwrap())
    }
    fn begin(&self, v: &Value) {
        if v["method"] == "initialize" {
            self.inner.lock().unwrap().initialize_id = v["id"].clone();
        }
        if v["method"] == "tools/call" {
            let mut s = self.inner.lock().unwrap();
            s.bytes = 0;
            s.frames = 0;
            s.id = v["id"].clone();
            s.result = None;
            self.sent.store(false, Ordering::Release);
        }
    }
    fn incoming(
        &self,
        bytes: &[u8],
    ) -> Result<rmcp::service::RxJsonRpcMessage<RoleClient>, &'static str> {
        let v = peer_protocol::decode_json_bounded(
            bytes,
            peer_protocol::JsonLimits {
                bytes: LIMITS["maxFrameBytes"].as_u64().unwrap() as usize,
                nodes: 32768,
                depth: 32,
                string_bytes: LIMITS["maxFrameBytes"].as_u64().unwrap() as usize,
            },
        )
        .map_err(|_| "mcp_message_invalid")?
        .value;
        let mut s = self.inner.lock().unwrap();
        s.bytes = s
            .bytes
            .checked_add(bytes.len())
            .ok_or("mcp_message_limit")?;
        s.frames += 1;
        if s.bytes > LIMITS["maxRpcBytes"].as_u64().unwrap() as usize
            || s.frames > LIMITS["maxRpcFrames"].as_u64().unwrap() as usize
        {
            return Err("mcp_message_limit");
        }
        if !s.id.is_null() && v["id"] == s.id && v.get("result").is_some() {
            s.result = Some(v["result"].clone());
        }
        let message = serde_json::from_value(v.clone()).map_err(|_| "mcp_message_invalid")?;
        if !s.initialize_id.is_null()
            && v["id"] == s.initialize_id
            && v.get("method").is_none()
            && (v.get("result").is_some() || v.get("error").is_some())
        {
            if let Some(version) = v["result"]["protocolVersion"].as_str() {
                s.protocol = Some(version.into());
            }
            s.initialize_id = Value::Null;
        }
        Ok(message)
    }
    fn fail(&self, code: &'static str) {
        self.inner.lock().unwrap().error = Some(code);
        self.closed.store(true, Ordering::Release);
        self.notify.notify_one();
    }
    pub fn error(&self) -> Option<&'static str> {
        self.inner.lock().unwrap().error
    }
    pub(crate) async fn stopped(&self) {
        while !self.closed.load(Ordering::Acquire) {
            self.notify.notified().await;
        }
    }
}
#[derive(Clone)]
pub(crate) struct McpPeer {
    peer: Peer<RoleClient>,
    pub state: Arc<McpState>,
}
impl McpPeer {
    pub async fn call(
        &self,
        name: String,
        args: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, &'static str> {
        if self.state.closed.load(Ordering::Acquire) {
            return Err(self.state.error().unwrap_or("mcp_connection_closed"));
        }
        let params = rmcp::model::CallToolRequestParams::new(name)
            .with_arguments(args.as_object().ok_or("tool_arguments_invalid")?.clone());
        let result = tokio::select! {biased;_=cancel.cancelled()=>return Err("CANCELLED"),result=tokio::time::timeout(Duration::from_millis(LIMITS["timeoutMs"].as_u64().unwrap()),self.peer.call_tool_once(params))=>result.map_err(|_|"mcp_timeout")?};
        result.map_err(|e| {
            if matches!(e, rmcp::service::ServiceError::McpError(_)) {
                "mcp_tool_error"
            } else {
                self.state.error().unwrap_or("mcp_rpc_failed")
            }
        })?;
        self.state
            .inner
            .lock()
            .unwrap()
            .result
            .take()
            .ok_or("mcp_result_missing")
    }
}
pub(crate) struct Connection {
    service: RunningService<RoleClient, ClientConfig>,
    worker: tokio::task::JoinHandle<()>,
    child: Option<Child>,
    stderr: Option<tokio::task::JoinHandle<()>>,
    cancel: CancellationToken,
}
impl Connection {
    pub async fn open(
        config: &Value,
        owned: &CancellationToken,
        admission: &crate::effect_admission::EffectAdmission,
        handle: &str,
        owner: &recorder::Recorder,
    ) -> Result<(McpPeer, Self), &'static str> {
        let stop = owned.child_token();
        let state = McpState::new();
        let (transport, worker, child, stderr) =
            transport::open(config, stop.clone(), state.clone()).await?;
        let registration = if let Some(pid) = child.as_ref().and_then(Child::id) {
            match recorder::process_recorder(pid, &owner.host_id, &owner.acquired_at).await {
                Some(record) => admission
                    .child(handle.into(), record)
                    .await
                    .map_err(|_| "mcp_authority_changed"),
                None => Err("mcp_process_unavailable"),
            }
        } else {
            Ok(())
        };
        if let Err(error) = registration {
            transport.close_now();
            let ended = FailedConnection {
                worker,
                child,
                stderr,
                cancel: stop,
            }
            .cleanup()
            .await;
            return Err(if ended { error } else { "mcp_stop_unproven" });
        }
        let info:ClientConfig=serde_json::from_value(json!({"protocolVersion":LIMITS["protocolVersion"],"capabilities":{},"clientInfo":LIMITS["clientInfo"]})).map_err(|_|"mcp_config_invalid")?;
        let connected = tokio::select! {biased;_=owned.cancelled()=>Err("CANCELLED"),result=tokio::time::timeout(Duration::from_millis(LIMITS["timeoutMs"].as_u64().unwrap()),info.serve(transport))=>result.map_err(|_|"mcp_initialize_timeout").and_then(|v|v.map_err(|_|"mcp_initialize_failed"))};
        match connected {
            Ok(service) => {
                let peer = McpPeer {
                    peer: service.peer().clone(),
                    state: state.clone(),
                };
                Ok((
                    peer,
                    Self {
                        service,
                        worker,
                        child,
                        stderr,
                        cancel: stop,
                    },
                ))
            }
            Err(error) => {
                stop.cancel();
                let parts = FailedConnection {
                    worker,
                    child,
                    stderr,
                    cancel: stop,
                };
                let ended = parts.cleanup().await;
                Err(if ended { error } else { "mcp_stop_unproven" })
            }
        }
    }
    pub async fn close(mut self) -> Result<(), ()> {
        self.cancel.cancel();
        let service = self
            .service
            .close_with_timeout(Duration::from_secs(1))
            .await;
        let parts = FailedConnection {
            worker: self.worker,
            child: self.child,
            stderr: self.stderr,
            cancel: self.cancel,
        };
        let ended = parts.cleanup().await;
        if matches!(service, Ok(Some(_))) && ended {
            Ok(())
        } else {
            Err(())
        }
    }
}
struct FailedConnection {
    worker: tokio::task::JoinHandle<()>,
    child: Option<Child>,
    stderr: Option<tokio::task::JoinHandle<()>>,
    cancel: CancellationToken,
}
impl FailedConnection {
    async fn cleanup(mut self) -> bool {
        self.cancel.cancel();
        let mut ended = true;
        if let Some(child) = &mut self.child {
            let pid = child.id();
            if let Some(pid) = pid {
                crate::recorder::kill_process_tree(pid);
            }
            let _ = child.start_kill();
            ended = matches!(
                tokio::time::timeout(Duration::from_secs(2), child.wait()).await,
                Ok(Ok(_))
            );
            if let Some(pid) = pid {
                ended &= crate::providers::group_absent(pid);
            }
        }
        let mut worker = self.worker;
        if tokio::time::timeout(Duration::from_secs(1), &mut worker)
            .await
            .is_err()
        {
            worker.abort();
            ended &= worker.await.is_err();
        }
        if let Some(mut stderr) = self.stderr
            && tokio::time::timeout(Duration::from_secs(1), &mut stderr)
                .await
                .is_err()
        {
            stderr.abort();
            let _ = stderr.await;
        }
        ended
    }
}
mod result;

#[cfg(test)]
mod protection_tests {
    use super::*;
    #[test]
    fn selected_route_protection_is_bounded_deduplicated_and_never_marks_dispatch() {
        let state = McpState::new();
        let initial = vec!["first-secret".to_owned()];
        state.protect(&initial).unwrap();
        state.protect(&initial).unwrap();
        assert_eq!(state.transport_secrets.lock().unwrap().len(), 1);
        assert_eq!(
            state.protect(&["x".repeat(262144)]),
            Err("mcp_network_protection_limit")
        );
        assert_eq!(
            state.transport_secrets.lock().unwrap().as_slice(),
            initial.as_slice()
        );
        assert_eq!(
            state.protect(&(0..64).map(|i| format!("secret-{i}")).collect::<Vec<_>>()),
            Err("mcp_network_protection_limit")
        );
        assert!(!state.sent.load(Ordering::Acquire));
        assert_eq!(
            state
                .prepare_result(
                    json!({"content":[{"type":"text","text":"first-secret retained"}]}),
                    &json!({})
                )
                .unwrap()["text"],
            "[REDACTED] retained"
        );
    }
}
