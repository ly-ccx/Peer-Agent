use crate::{
    classic::{self, ModelLoader},
    classic_conversations,
    classic_goal::{self, ClassicGoalRegistry},
    classic_llm, classic_mcp, classic_skills,
    classic_streams::ClassicStreamRegistry,
    classic_usage, project, project_bot, project_bot_live, project_bot_ops, project_bot_read,
    project_host::ProjectHostRuntime,
    protocol::{
        CapabilitiesListResult, CoreCapabilitiesSummary, DEFAULT_REVERSE_TIMEOUT,
        DaemonStatusResult, ExternalCapabilityManifest, InitializeParams, InitializeResult,
        MAX_FRAME_BYTES, MAX_PENDING_HOST_CALLS, PROTOCOL_VERSION, PingParams, PingResult,
        RpcError, ServerInfo, ShutdownResult,
    },
    transport::{BoundedLineReader, FrameWriter, FrameWriterHandle, encode_frame},
};
use peer_protocol::{JsonDecodeError, JsonLimits, LocalAccessLevel, decode_json_bounded};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, NativeConversationRuntime},
};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fmt, io,
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{Notify, mpsc, oneshot},
    task::JoinSet,
};

const MAX_INBOUND_STRING_BYTES: usize = 1024 * 1024;
const SHUTDOWN_DRAIN_TIMEOUT: Duration = Duration::from_secs(2);
const MULTI_CLIENT_NOTIFY_TIMEOUT: Duration = Duration::from_millis(250);

fn classic_domains() -> Vec<String> {
    vec![
        "core".into(),
        "classic.chat".into(),
        "classic.goal".into(),
        "classic.conversations".into(),
        "classic.usage".into(),
        "classic.skills".into(),
        "classic.mcp".into(),
        "classic.llm".into(),
        "project.memory".into(),
        "project.objectives".into(),
        "project.profile".into(),
        "project.access".into(),
        "project.bot".into(),
    ]
}

#[derive(Clone)]
pub struct CoreServerConfig {
    pub version: String,
    pub data_home: PathBuf,
    pub reverse_request_timeout: Duration,
    pub model_loader: Option<ModelLoader>,
}

impl fmt::Debug for CoreServerConfig {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("CoreServerConfig")
            .field("version", &self.version)
            .field("data_home", &self.data_home)
            .field("reverse_request_timeout", &self.reverse_request_timeout)
            .field("has_model_loader", &self.model_loader.is_some())
            .finish()
    }
}

impl CoreServerConfig {
    pub fn new(version: impl Into<String>, data_home: PathBuf) -> Self {
        Self {
            version: version.into(),
            data_home,
            reverse_request_timeout: DEFAULT_REVERSE_TIMEOUT,
            model_loader: None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct DaemonRuntimeMeta {
    pub transport: String,
    pub endpoint: String,
    pub auth_token: String,
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

type PendingMap = HashMap<String, oneshot::Sender<Result<Value, RpcError>>>;

struct ClientSlot {
    writer: FrameWriter,
    initialized: bool,
    client_info: Option<crate::protocol::ClientInfo>,
    external_capabilities: Vec<ExternalCapabilityManifest>,
    pending: Arc<Mutex<PendingMap>>,
}

pub struct PeerHub {
    next_client_id: AtomicU64,
    next_host_call_id: AtomicU64,
    clients: Mutex<HashMap<u64, ClientSlot>>,
}

impl PeerHub {
    fn new() -> Self {
        Self {
            next_client_id: AtomicU64::new(1),
            next_host_call_id: AtomicU64::new(1),
            clients: Mutex::new(HashMap::new()),
        }
    }

    fn register_client(&self, writer: FrameWriter) -> u64 {
        let client_id = self.next_client_id.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut guard) = self.clients.lock() {
            guard.insert(
                client_id,
                ClientSlot {
                    writer,
                    initialized: false,
                    client_info: None,
                    external_capabilities: Vec::new(),
                    pending: Arc::new(Mutex::new(HashMap::new())),
                },
            );
        }
        client_id
    }

    fn unregister_client(&self, client_id: u64) -> usize {
        let (removed, remaining) = match self.clients.lock() {
            Ok(mut guard) => {
                let slot = guard.remove(&client_id);
                (slot, guard.len())
            }
            Err(_) => (None, 0),
        };
        if let Some(slot) = removed {
            Self::fail_pending_map(&slot.pending, "Host client disconnected");
        }
        remaining
    }

    fn mark_initialized(
        &self,
        client_id: u64,
        client_info: crate::protocol::ClientInfo,
        external_capabilities: Vec<ExternalCapabilityManifest>,
    ) -> Result<(), RpcError> {
        let mut guard = self
            .clients
            .lock()
            .map_err(|_| RpcError::internal_error("peer hub lock poisoned"))?;
        let Some(slot) = guard.get_mut(&client_id) else {
            return Err(RpcError::shutting_down());
        };
        if slot.initialized {
            return Err(RpcError::already_initialized());
        }
        slot.initialized = true;
        slot.client_info = Some(client_info);
        slot.external_capabilities = external_capabilities;
        Ok(())
    }

    fn is_client_initialized(&self, client_id: u64) -> bool {
        self.clients
            .lock()
            .ok()
            .and_then(|guard| guard.get(&client_id).map(|slot| slot.initialized))
            .unwrap_or(false)
    }

    fn connected_counts(&self) -> (usize, usize) {
        let Ok(guard) = self.clients.lock() else {
            return (0, 0);
        };
        let total = guard.len();
        let initialized = guard.values().filter(|slot| slot.initialized).count();
        (total, initialized)
    }

    fn snapshot_external_capabilities(&self) -> Result<Vec<ExternalCapabilityManifest>, RpcError> {
        let guard = self
            .clients
            .lock()
            .map_err(|_| RpcError::internal_error("peer hub lock poisoned"))?;
        let mut ordered_ids: Vec<u64> = guard
            .iter()
            .filter_map(|(id, slot)| if slot.initialized { Some(*id) } else { None })
            .collect();
        ordered_ids.sort_unstable();

        let mut seen_aliases = HashSet::new();
        let mut merged = Vec::new();
        for id in ordered_ids {
            if let Some(slot) = guard.get(&id) {
                for cap in &slot.external_capabilities {
                    if seen_aliases.insert(cap.alias.clone()) {
                        merged.push(cap.clone());
                    }
                }
            }
        }
        Ok(merged)
    }

    async fn broadcast_notification(&self, method: &str, params: Value) -> io::Result<()> {
        let writers: Vec<FrameWriter> = {
            let Ok(guard) = self.clients.lock() else {
                return Ok(());
            };
            let mut entries: Vec<(u64, FrameWriter)> = guard
                .iter()
                .filter_map(|(id, slot)| {
                    if slot.initialized {
                        Some((*id, slot.writer.clone()))
                    } else {
                        None
                    }
                })
                .collect();
            entries.sort_by_key(|(id, _)| *id);
            entries.into_iter().map(|(_, writer)| writer).collect()
        };
        if writers.is_empty() {
            return Ok(());
        }
        let payload = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
        });
        if writers.len() == 1 {
            return writers[0].send_value(&payload).await;
        }
        let encoded = encode_frame(&payload)?;
        for writer in writers {
            let _ = tokio::time::timeout(
                MULTI_CLIENT_NOTIFY_TIMEOUT,
                writer.send_preencoded(encoded.clone()),
            )
            .await;
        }
        Ok(())
    }

    fn select_host_target(
        &self,
        preferred_client_id: Option<u64>,
        method: &str,
        params: &Value,
    ) -> Option<(FrameWriter, Arc<Mutex<PendingMap>>)> {
        let guard = self.clients.lock().ok()?;
        let pick_slot = |id: u64| -> Option<(FrameWriter, Arc<Mutex<PendingMap>>)> {
            guard
                .get(&id)
                .filter(|slot| slot.initialized)
                .map(|slot| (slot.writer.clone(), Arc::clone(&slot.pending)))
        };

        if method == "host.ping" {
            if let Some(id) = preferred_client_id
                && let Some(target) = pick_slot(id)
            {
                return Some(target);
            }
            let mut ids: Vec<u64> = guard
                .iter()
                .filter_map(|(id, slot)| if slot.initialized { Some(*id) } else { None })
                .collect();
            ids.sort_unstable();
            return ids.first().and_then(|id| pick_slot(*id));
        }

        if method == "host.capability.execute" {
            let alias = params.get("alias").and_then(Value::as_str);
            let capability_id = params.get("capabilityId").and_then(Value::as_str);
            let matches_slot = |slot: &ClientSlot| {
                slot.initialized
                    && slot.external_capabilities.iter().any(|cap| {
                        alias.is_some_and(|a| cap.alias == a)
                            || capability_id.is_some_and(|cid| cap.capability_id == cid)
                    })
            };
            if let Some(id) = preferred_client_id
                && guard.get(&id).is_some_and(matches_slot)
            {
                return pick_slot(id);
            }
            let mut matching_ids: Vec<u64> = guard
                .iter()
                .filter_map(|(id, slot)| if matches_slot(slot) { Some(*id) } else { None })
                .collect();
            matching_ids.sort_unstable();
            return matching_ids.first().and_then(|id| pick_slot(*id));
        }

        // `host.goal.*` or other reverse host RPCs: prefer caller if initialized
        // and registered external capabilities (Desktop), else any client with
        // external capabilities, else preferred client or lowest initialized client.
        if let Some(id) = preferred_client_id
            && guard
                .get(&id)
                .is_some_and(|s| s.initialized && !s.external_capabilities.is_empty())
        {
            return pick_slot(id);
        }
        let mut ext_ids: Vec<u64> = guard
            .iter()
            .filter_map(|(id, slot)| {
                if slot.initialized && !slot.external_capabilities.is_empty() {
                    Some(*id)
                } else {
                    None
                }
            })
            .collect();
        ext_ids.sort_unstable();
        if let Some(id) = ext_ids.first() {
            return pick_slot(*id);
        }
        if let Some(id) = preferred_client_id
            && let Some(target) = pick_slot(id)
        {
            return Some(target);
        }
        let mut any_ids: Vec<u64> = guard
            .iter()
            .filter_map(|(id, slot)| if slot.initialized { Some(*id) } else { None })
            .collect();
        any_ids.sort_unstable();
        any_ids.first().and_then(|id| pick_slot(*id))
    }

    fn resolve_pending(&self, client_id: u64, id: &str, message: &Value) {
        let pending_arc = self
            .clients
            .lock()
            .ok()
            .and_then(|guard| guard.get(&client_id).map(|slot| Arc::clone(&slot.pending)));
        let Some(pending_arc) = pending_arc else {
            return;
        };
        let sender = pending_arc.lock().ok().and_then(|mut map| map.remove(id));
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

    fn fail_pending_map(pending: &Arc<Mutex<PendingMap>>, reason: &str) {
        if let Ok(mut map) = pending.lock() {
            for (_, tx) in map.drain() {
                let _ = tx.send(Err(RpcError::host_call_failed(reason, None)));
            }
        }
    }

    fn fail_all_pending(&self, reason: &str) {
        let pending_maps: Vec<Arc<Mutex<PendingMap>>> = self
            .clients
            .lock()
            .ok()
            .map(|guard| {
                guard
                    .values()
                    .map(|slot| Arc::clone(&slot.pending))
                    .collect()
            })
            .unwrap_or_default();
        for pending in pending_maps {
            Self::fail_pending_map(&pending, reason);
        }
    }
}

#[derive(Clone)]
pub struct RpcPeer {
    hub: Arc<PeerHub>,
    client_id: Option<u64>,
    shutdown: CancellationToken,
    reverse_timeout: Duration,
}

impl RpcPeer {
    fn new(
        hub: Arc<PeerHub>,
        client_id: Option<u64>,
        shutdown: CancellationToken,
        reverse_timeout: Duration,
    ) -> Self {
        Self {
            hub,
            client_id,
            shutdown,
            reverse_timeout,
        }
    }

    pub async fn notify(&self, method: &str, params: Value) -> io::Result<()> {
        self.hub.broadcast_notification(method, params).await
    }

    pub fn shutdown_child_token(&self) -> CancellationToken {
        self.shutdown.child_token()
    }

    pub async fn call_host(
        &self,
        method: &str,
        params: Value,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        self.call_host_with_timeout(method, params, self.reverse_timeout, cancel)
            .await
    }

    pub async fn call_host_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        cancel: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if self.shutdown.is_cancelled() || cancel.is_cancelled() {
            return Err(RpcError::shutting_down());
        }
        let Some((writer, pending)) = self.hub.select_host_target(self.client_id, method, &params)
        else {
            return Err(RpcError::host_call_failed(
                format!("No connected host client handles '{method}'"),
                None,
            ));
        };

        let id = format!(
            "core-{}",
            self.hub.next_host_call_id.fetch_add(1, Ordering::Relaxed)
        );
        let (tx, rx) = oneshot::channel();
        {
            let mut guard = pending
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
        if let Err(err) = writer.send_value(&payload).await {
            if let Ok(mut map) = pending.lock() {
                map.remove(&id);
            }
            return Err(RpcError::host_call_failed(
                format!("Failed to write host request: {err}"),
                None,
            ));
        }

        let sleep_timer = tokio::time::sleep(timeout);
        tokio::pin!(sleep_timer);

        let remove_pending = || {
            if let Ok(mut map) = pending.lock() {
                map.remove(&id);
            }
        };

        tokio::select! {
            biased;
            _ = self.shutdown.cancelled() => {
                remove_pending();
                Err(RpcError::shutting_down())
            }
            _ = cancel.cancelled() => {
                remove_pending();
                Err(RpcError::host_call_failed("Host request cancelled", None))
            }
            _ = &mut sleep_timer => {
                remove_pending();
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
        }
    }
}

type LocalJob = Box<dyn FnOnce() + Send + 'static>;

pub struct BackgroundCounterGuard {
    counter: Arc<AtomicUsize>,
    notify: Arc<Notify>,
}

impl Drop for BackgroundCounterGuard {
    fn drop(&mut self) {
        if self.counter.fetch_sub(1, Ordering::SeqCst) == 1 {
            self.notify.notify_waiters();
        }
    }
}

#[derive(Clone)]
pub(crate) struct LocalBackgroundSpawner {
    local_tx: mpsc::UnboundedSender<LocalJob>,
    active_background: Arc<AtomicUsize>,
    background_done: Arc<Notify>,
}

impl LocalBackgroundSpawner {
    pub(crate) fn spawn<F>(&self, spawn_fn: F) -> Result<(), RpcError>
    where
        F: FnOnce(BackgroundCounterGuard) + Send + 'static,
    {
        let guard = BackgroundCounterGuard {
            counter: Arc::clone(&self.active_background),
            notify: Arc::clone(&self.background_done),
        };
        self.active_background.fetch_add(1, Ordering::SeqCst);
        let res = self.local_tx.send(Box::new(move || {
            let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(move || spawn_fn(guard)));
        }));
        if res.is_err() {
            return Err(RpcError::shutting_down());
        }
        Ok(())
    }
}

pub struct CoreEngine {
    pub config: CoreServerConfig,
    pub started_at: Instant,
    pub hub: Arc<PeerHub>,
    pub shutdown: CancellationToken,
    pub daemon_meta: Option<DaemonRuntimeMeta>,
    draining: AtomicBool,
    pub access: ConversationAccess,
    pub runtime: Arc<NativeConversationRuntime>,
    pub streams: ClassicStreamRegistry,
    pub goals: ClassicGoalRegistry,
    pub project_host: Arc<ProjectHostRuntime>,
    local_tx: mpsc::UnboundedSender<LocalJob>,
    local_stop: CancellationToken,
    active_background: Arc<AtomicUsize>,
    background_done: Arc<Notify>,
    local_thread: Mutex<Option<std::thread::JoinHandle<()>>>,
}

impl CoreEngine {
    pub fn new(
        config: CoreServerConfig,
        shutdown: CancellationToken,
        daemon_meta: Option<DaemonRuntimeMeta>,
    ) -> io::Result<Arc<Self>> {
        let (local_tx, mut local_rx) = mpsc::unbounded_channel::<LocalJob>();
        let local_stop = CancellationToken::new();
        let thread_stop = local_stop.clone();
        let local_thread = std::thread::Builder::new()
            .name("peer-core-local-rt".into())
            .spawn(move || {
                if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build()
                {
                    let local = tokio::task::LocalSet::new();
                    rt.block_on(local.run_until(async move {
                        loop {
                            tokio::select! {
                                biased;
                                _ = thread_stop.cancelled() => break,
                                maybe_job = local_rx.recv() => match maybe_job {
                                    Some(job) => job(),
                                    None => break,
                                }
                            }
                        }
                    }));
                }
            })?;

        let hub = Arc::new(PeerHub::new());
        let shared_peer = RpcPeer::new(
            Arc::clone(&hub),
            None,
            shutdown.clone(),
            config.reverse_request_timeout,
        );
        let access = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
        let runtime = Arc::new(NativeConversationRuntime::new(
            &config.data_home,
            access.clone(),
        ));
        let active_background = Arc::new(AtomicUsize::new(0));
        let background_done = Arc::new(Notify::new());
        let spawner = LocalBackgroundSpawner {
            local_tx: local_tx.clone(),
            active_background: Arc::clone(&active_background),
            background_done: Arc::clone(&background_done),
        };
        let project_host = Arc::new(
            ProjectHostRuntime::new(
                config.data_home.clone(),
                &config.version,
                shared_peer,
                spawner,
                config.model_loader.clone(),
            )
            .map_err(|err| io::Error::other(err.detail))?,
        );

        Ok(Arc::new(Self {
            config,
            started_at: Instant::now(),
            hub,
            shutdown,
            daemon_meta,
            draining: AtomicBool::new(false),
            access,
            runtime,
            streams: ClassicStreamRegistry::new(),
            goals: ClassicGoalRegistry::new(),
            project_host,
            local_tx,
            local_stop,
            active_background,
            background_done,
            local_thread: Mutex::new(Some(local_thread)),
        }))
    }

    pub fn is_draining(&self) -> bool {
        self.draining.load(Ordering::SeqCst)
    }

    pub fn context_for_client(self: &Arc<Self>, client_id: u64) -> Arc<ServerContext> {
        Arc::new(ServerContext {
            config: self.config.clone(),
            started_at: self.started_at,
            engine: Arc::clone(self),
            client_id,
            peer: RpcPeer::new(
                Arc::clone(&self.hub),
                Some(client_id),
                self.shutdown.clone(),
                self.config.reverse_request_timeout,
            ),
            access: self.access.clone(),
            runtime: Arc::clone(&self.runtime),
            streams: self.streams.clone(),
            goals: self.goals.clone(),
            project_host: Arc::clone(&self.project_host),
            local_tx: self.local_tx.clone(),
            active_background: Arc::clone(&self.active_background),
            background_done: Arc::clone(&self.background_done),
        })
    }

    async fn drain_background(&self) {
        while self.active_background.load(Ordering::SeqCst) > 0 {
            self.background_done.notified().await;
        }
    }

    pub async fn shutdown_and_drain(&self) {
        self.draining.store(true, Ordering::SeqCst);
        self.shutdown.cancel();
        self.project_host.begin_shutdown();
        self.goals.cancel_all();
        self.streams.cancel_all();
        self.hub.fail_all_pending("Core server shutting down");
        let _ = tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, self.drain_background()).await;
        self.local_stop.cancel();
        self.project_host.release_all_leases();
        let handle = self
            .local_thread
            .lock()
            .ok()
            .and_then(|mut guard| guard.take());
        if let Some(handle) = handle {
            let _ = tokio::task::spawn_blocking(move || {
                let _ = handle.join();
            })
            .await;
        }
    }
}

pub struct ServerContext {
    pub config: CoreServerConfig,
    pub started_at: Instant,
    engine: Arc<CoreEngine>,
    client_id: u64,
    pub peer: RpcPeer,
    pub access: ConversationAccess,
    pub runtime: Arc<NativeConversationRuntime>,
    pub streams: ClassicStreamRegistry,
    pub goals: ClassicGoalRegistry,
    pub project_host: Arc<ProjectHostRuntime>,
    local_tx: mpsc::UnboundedSender<LocalJob>,
    active_background: Arc<AtomicUsize>,
    background_done: Arc<Notify>,
}

impl ServerContext {
    pub fn snapshot_external_capabilities(
        &self,
    ) -> Result<Vec<ExternalCapabilityManifest>, RpcError> {
        self.engine.hub.snapshot_external_capabilities()
    }

    pub fn dispatch_local<F>(&self, job: F) -> Result<(), RpcError>
    where
        F: FnOnce() + Send + 'static,
    {
        self.local_tx
            .send(Box::new(job))
            .map_err(|_| RpcError::shutting_down())
    }

    pub fn spawn_local_background<F>(&self, spawn_fn: F) -> Result<(), RpcError>
    where
        F: FnOnce(BackgroundCounterGuard) + Send + 'static,
    {
        LocalBackgroundSpawner {
            local_tx: self.local_tx.clone(),
            active_background: Arc::clone(&self.active_background),
            background_done: Arc::clone(&self.background_done),
        }
        .spawn(spawn_fn)
    }

    fn initialize(&self, params_value: Value) -> Result<Value, RpcError> {
        let params: InitializeParams = serde_json::from_value(params_value)
            .map_err(|err| RpcError::invalid_params(format!("Invalid initialize params: {err}")))?;
        params.validate()?;

        if self.engine.is_draining() {
            return Err(RpcError::shutting_down());
        }
        if let Some(meta) = &self.engine.daemon_meta {
            let provided = params.auth_token.as_deref().unwrap_or("");
            if !constant_time_eq(provided.as_bytes(), meta.auth_token.as_bytes()) {
                return Err(RpcError::unauthorized(
                    "Invalid or missing daemon authToken",
                ));
            }
        }
        let aliases: Vec<String> = params
            .external_capabilities
            .iter()
            .map(|c| c.alias.clone())
            .collect();
        self.engine.hub.mark_initialized(
            self.client_id,
            params.client,
            params.external_capabilities,
        )?;

        let result = InitializeResult {
            protocol_version: PROTOCOL_VERSION,
            server: ServerInfo {
                name: "peer-core".into(),
                version: self.config.version.clone(),
            },
            pid: std::process::id(),
            capabilities: CoreCapabilitiesSummary {
                domains: classic_domains(),
                planned_domains: vec!["bot".into()],
                bidirectional_host_calls: true,
                registered_external_capabilities: aliases,
            },
        };
        serde_json::to_value(result).map_err(|err| RpcError::internal_error(err.to_string()))
    }

    fn begin_shutdown(&self, params: &Value) -> Result<(Value, bool), RpcError> {
        if self.engine.daemon_meta.is_none() {
            self.engine.draining.store(true, Ordering::SeqCst);
            let value = serde_json::to_value(ShutdownResult {
                ok: true,
                draining: true,
                disconnected: None,
                daemon_shutdown: None,
                remaining_clients: None,
            })
            .map_err(|err| RpcError::internal_error(err.to_string()))?;
            return Ok((value, true));
        }

        if !self.engine.hub.is_client_initialized(self.client_id) {
            return Err(RpcError::not_initialized());
        }
        let shutdown_daemon = params.get("shutdownDaemon").and_then(Value::as_bool) == Some(true)
            || params.get("scope").and_then(Value::as_str) == Some("daemon");
        let shutdown_if_last = params.get("shutdownIfLast").and_then(Value::as_bool) == Some(true);
        let (total, _) = self.engine.hub.connected_counts();
        let remaining = total.saturating_sub(1);
        let will_stop = shutdown_daemon || (shutdown_if_last && remaining == 0);
        if will_stop {
            self.engine.draining.store(true, Ordering::SeqCst);
        }
        let value = serde_json::to_value(ShutdownResult {
            ok: true,
            draining: will_stop,
            disconnected: Some(true),
            daemon_shutdown: Some(will_stop),
            remaining_clients: Some(remaining),
        })
        .map_err(|err| RpcError::internal_error(err.to_string()))?;
        Ok((value, will_stop))
    }

    fn daemon_status(&self) -> Result<Value, RpcError> {
        let (connected_clients, initialized_clients) = self.engine.hub.connected_counts();
        let (transport, endpoint) = match &self.engine.daemon_meta {
            Some(meta) => (meta.transport.clone(), Some(meta.endpoint.clone())),
            None => ("stdio".to_owned(), None),
        };
        let host_status = self.project_host.status(None);
        let owned_workspaces: Vec<String> = host_status
            .get("ownedWorkspaces")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        let uptime_ms = u64::try_from(self.started_at.elapsed().as_millis()).unwrap_or(u64::MAX);
        serde_json::to_value(DaemonStatusResult {
            ok: true,
            daemon: self.engine.daemon_meta.is_some(),
            pid: std::process::id(),
            server_version: self.config.version.clone(),
            uptime_ms,
            connected_clients,
            initialized_clients,
            transport,
            endpoint,
            project_bot_host_enabled: self.project_host.is_enabled(),
            owned_workspaces,
        })
        .map_err(|err| RpcError::internal_error(err.to_string()))
    }

    async fn handle_request(
        self: &Arc<Self>,
        method: &str,
        params: Value,
    ) -> Result<Value, RpcError> {
        if self.engine.is_draining() {
            return Err(RpcError::shutting_down());
        }
        if !self.engine.hub.is_client_initialized(self.client_id) {
            return Err(RpcError::not_initialized());
        }
        let external_capabilities = self.snapshot_external_capabilities()?;
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
                domains: classic_domains(),
                external_capabilities,
            })
            .map_err(|err| RpcError::internal_error(err.to_string())),
            "core.daemon.status" => self.daemon_status(),
            "classic.chat.send" => classic::handle_send(self, params).await,
            "classic.chat.abort" => classic::handle_abort(self, params),
            "classic.chat.reattach" => classic::handle_reattach(self, params),
            "classic.chat.listActive" => classic::handle_list_active(self),
            "classic.chat.compact" => classic::handle_compact(self, params).await,
            "classic.permission.decide" => classic::handle_permission_decide(self, params),
            "classic.access.set" => classic::handle_access_set(self, params),
            "classic.goal.start" => classic_goal::handle_start(self, params).await,
            "classic.goal.resume" => classic_goal::handle_resume(self, params).await,
            "classic.goal.pause" => classic_goal::handle_pause(self, params).await,
            "classic.goal.clear" => classic_goal::handle_clear(self, params).await,
            "classic.goal.getState" => classic_goal::handle_get_state(self, params),
            "classic.conversations.list" => classic_conversations::handle_list(self, params),
            "classic.conversations.search" => classic_conversations::handle_search(self, params),
            "classic.conversations.create" => classic_conversations::handle_create(self, params),
            "classic.conversations.get" => classic_conversations::handle_get(self, params),
            "classic.conversations.updateTitle" => {
                classic_conversations::handle_update_title(self, params)
            }
            "classic.conversations.updateMode" => {
                classic_conversations::handle_update_mode(self, params)
            }
            "classic.conversations.updateFastMode" => {
                classic_conversations::handle_update_fast_mode(self, params)
            }
            "classic.conversations.updatePreferredExecutionIsolation" => {
                classic_conversations::handle_update_preferred_execution_isolation(self, params)
            }
            "classic.conversations.updateModelEffort" => {
                classic_conversations::handle_update_model_effort(self, params)
            }
            "classic.conversations.appendMessage" => {
                classic_conversations::handle_append_message(self, params)
            }
            "classic.conversations.updateLastMessage" => {
                classic_conversations::handle_update_last_message(self, params)
            }
            "classic.conversations.replaceMessages" => {
                classic_conversations::handle_replace_messages(self, params)
            }
            "classic.conversations.archive" => classic_conversations::handle_archive(self, params),
            "classic.conversations.restore" => classic_conversations::handle_restore(self, params),
            "classic.conversations.pin" => classic_conversations::handle_pin(self, params),
            "classic.conversations.unpin" => classic_conversations::handle_unpin(self, params),
            "classic.conversations.reorderPinned" => {
                classic_conversations::handle_reorder_pinned(self, params)
            }
            "classic.conversations.autoArchive" => {
                classic_conversations::handle_auto_archive(self, params)
            }
            "classic.conversations.delete" => classic_conversations::handle_delete(self, params),
            "classic.conversations.addUsage" => {
                classic_conversations::handle_add_usage(self, params)
            }
            "classic.usage.stats" => classic_usage::handle_stats(self, params),
            "classic.usage.daily" => classic_usage::handle_daily(self, params),
            "classic.usage.day" => classic_usage::handle_day(self, params),
            "classic.usage.cacheHitRate" => classic_usage::handle_cache_hit_rate(self),
            "classic.skills.list" => classic_skills::handle_list(self, params),
            "classic.skills.getDetail" => classic_skills::handle_get_detail(self, params),
            "classic.skills.enable" => classic_skills::handle_set_enabled(self, params, true),
            "classic.skills.disable" => classic_skills::handle_set_enabled(self, params, false),
            "classic.skills.listAvailable" => classic_skills::handle_list_available(self, params),
            "classic.skills.link" => classic_skills::handle_link(self, params),
            "classic.skills.unlink" => classic_skills::handle_unlink(self, params),
            "classic.skills.uninstall" => classic_skills::handle_uninstall(self, params),
            "classic.mcp.listInstalled" => classic_mcp::handle_list_installed(self),
            "classic.mcp.listCapabilities" => classic_mcp::handle_list_capabilities(self),
            "classic.mcp.listCredentials" => classic_mcp::handle_list_credentials(self),
            "classic.mcp.upsertServer" | "classic.mcp.install" => {
                classic_mcp::handle_upsert_server(self, params)
            }
            "classic.mcp.uninstall" => classic_mcp::handle_uninstall(self, params),
            "classic.mcp.setEnabled" => classic_mcp::handle_set_enabled(self, params),
            "classic.mcp.setToolVisibility" => {
                classic_mcp::handle_set_tool_visibility(self, params)
            }
            "classic.llm.catalog" => classic_llm::handle_catalog(self),
            "classic.llm.complete" => classic_llm::handle_complete(self, params).await,
            "classic.llm.quota" => classic_llm::handle_quota(self, params).await,
            "project.memory.list" => project::handle_memory_list(self, params),
            "project.memory.pin" => project::handle_memory_pin(self, params),
            "project.memory.forget" => project::handle_memory_forget(self, params),
            "project.memory.restore" => project::handle_memory_restore(self, params),
            "project.memory.edit" => project::handle_memory_edit(self, params),
            "project.memory.setSwitches" => project::handle_memory_set_switches(self, params),
            "project.objectives.list" => project::handle_objectives_list(self, params),
            "project.objectives.update" => {
                project::handle_objectives_command(self, params, "update")
            }
            "project.objectives.pause" => project::handle_objectives_command(self, params, "pause"),
            "project.objectives.resume" => {
                project::handle_objectives_command(self, params, "resume")
            }
            "project.objectives.delete" => {
                project::handle_objectives_command(self, params, "close")
            }
            "project.profile.readUnknownOutcomePolicy" => {
                project::handle_profile_read_unknown_outcome_policy(self, params)
            }
            "project.profile.setUnknownOutcomePolicy" => {
                project::handle_profile_set_unknown_outcome_policy(self, params)
            }
            "project.profile.readAvatar" => project_bot::handle_profile_read_avatar(self, params),
            "project.profile.update" => project_bot::handle_profile_update(self, params),
            "project.access.read" => project_bot::handle_access_read(self, params),
            "project.access.update" => project_bot::handle_access_update(self, params),
            "project.bot.list" => project_bot_read::handle_bot_list(self, params),
            "project.bot.listAttention" => {
                project_bot_read::handle_bot_list_attention(self, params)
            }
            "project.bot.get" => project_bot_read::handle_bot_get(self, params),
            "project.bot.listObligationGrants" => {
                project_bot_read::handle_bot_list_obligation_grants(self, params)
            }
            "project.bot.readConversation" => {
                project_bot_read::handle_bot_read_conversation(self, params)
            }
            "project.bot.listSessions" => project_bot_read::handle_bot_list_sessions(self, params),
            "project.bot.getSession" => project_bot_read::handle_bot_get_session(self, params),
            "project.bot.markRead" => project_bot::handle_bot_mark_read(self, params),
            "project.bot.listApprovals" => project_bot::handle_bot_list_approvals(self, params),
            "project.bot.listHistory" => project_bot::handle_bot_list_history(self, params),
            "project.bot.search" => project_bot::handle_bot_search(self, params),
            "project.bot.diagnostics" => project_bot_ops::handle_bot_diagnostics(self, params),
            "project.bot.continueHistory" => {
                project_bot_ops::handle_bot_continue_history(self, params)
            }
            "project.bot.readInputDraft" => {
                project_bot_ops::handle_bot_read_input_draft(self, params)
            }
            "project.bot.writeInputDraft" => {
                project_bot_ops::handle_bot_write_input_draft(self, params)
            }
            "project.bot.readEvidence" => project_bot_ops::handle_bot_read_evidence(self, params),
            "project.bot.hostConfigure" => {
                project_bot_live::handle_host_configure(self, params).await
            }
            "project.bot.hostStatus" => project_bot_live::handle_host_status(self, params),
            "project.bot.create" => project_bot_live::handle_create(self, params).await,
            "project.bot.delete" => project_bot_live::handle_delete(self, params).await,
            "project.bot.rebindFolder" => {
                project_bot_live::handle_rebind_folder(self, params).await
            }
            "project.bot.submitInput" => project_bot_live::handle_submit_input(self, params).await,
            "project.bot.stopResponse" => project_bot_live::handle_stop_response(self, params),
            "project.bot.cancelSession" => project_bot_live::handle_cancel_session(self, params),
            "project.bot.resumeSession" => {
                project_bot_live::handle_resume_session(self, params).await
            }
            "project.bot.verifySession" => {
                project_bot_live::handle_verify_session(self, params).await
            }
            "project.bot.decideObligation" => {
                project_bot_live::handle_decide_obligation(self, params).await
            }
            "project.bot.requestClaimClosure" => {
                project_bot_live::handle_request_claim_closure(self, params).await
            }
            "project.bot.decideApproval" => {
                project_bot_live::handle_decide_approval(self, params).await
            }
            "project.bot.startFamiliarize" => {
                project_bot_live::handle_start_familiarize(self, params)
            }
            "project.bot.confirmResult" => project_bot_live::handle_confirm_result(self, params),
            "project.bot.acceptReadme" => project_bot_live::handle_accept_readme(self, params),
            "project.bot.retry" => project_bot_live::handle_retry(self, params).await,
            "project.bot.takeoverHost" => project_bot_live::handle_takeover_host(self, params),
            "project.bot.recovery" => project_bot_live::handle_recovery(self, params).await,
            "project.bot.wake" => project_bot_live::handle_wake(self, params),
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
    let engine = CoreEngine::new(config, shutdown, None)?;
    let conn_result = serve_connection(Arc::clone(&engine), reader, writer).await;
    engine.shutdown_and_drain().await;
    conn_result
}

pub async fn serve_connection<R, W>(engine: Arc<CoreEngine>, reader: R, writer: W) -> io::Result<()>
where
    R: AsyncRead + Unpin + Send + 'static,
    W: AsyncWrite + Unpin + Send + 'static,
{
    let mut line_reader = BoundedLineReader::new(reader);
    let writer_handle = FrameWriterHandle::spawn(writer);
    let client_writer = writer_handle.writer();
    let client_id = engine.hub.register_client(client_writer.clone());
    let context = engine.context_for_client(client_id);
    let shutdown = engine.shutdown.clone();
    let mut tasks = JoinSet::new();
    let mut stop_daemon_after_flush = false;
    let mut disconnecting = false;

    let loop_result: io::Result<()> = loop {
        while tasks.try_join_next().is_some() {}

        let next = tokio::select! {
            biased;
            _ = client_writer.closed() => {
                break Err(io::Error::new(
                    io::ErrorKind::BrokenPipe,
                    "JSON-RPC output writer closed",
                ));
            }
            line = line_reader.next_line(&shutdown) => line,
        };
        let frame = match next {
            Ok(Some(frame)) => frame,
            Ok(None) => break Ok(()),
            Err(err) => {
                // Report frame limit errors cleanly before closing if the pipe is still open.
                let _ = client_writer
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
                if let Err(write_err) = client_writer
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
                if let Err(write_err) = client_writer
                    .send_value(&RpcError::parse_error("Invalid JSON").to_response(Value::Null))
                    .await
                {
                    break Err(write_err);
                }
                continue;
            }
        };

        let Some(obj) = decoded.as_object() else {
            if let Err(write_err) = client_writer
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
            if let Err(write_err) = client_writer
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
                engine.hub.resolve_pending(client_id, id_str, &decoded);
                continue;
            }
            let err_id = reply_id.flatten().unwrap_or(Value::Null);
            if let Err(write_err) = client_writer
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
            if let Err(write_err) = client_writer
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
                if let Err(write_err) = client_writer
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
                if method == "core.shutdown"
                    && let Ok((_, will_stop)) = context.begin_shutdown(&params)
                {
                    disconnecting = true;
                    stop_daemon_after_flush = will_stop;
                    break Ok(());
                }
            }
            // Request with valid `"id"`.
            Some(Some(id)) => match method {
                "core.initialize" => {
                    let response = format_reply(id, context.initialize(params));
                    if let Err(write_err) = client_writer.send_value(&response).await {
                        break Err(write_err);
                    }
                }
                "core.shutdown" => match context.begin_shutdown(&params) {
                    Ok((val, will_stop)) => {
                        disconnecting = true;
                        stop_daemon_after_flush = will_stop;
                        let response = format_reply(id, Ok(val));
                        let send_res = client_writer.send_value(&response).await;
                        break send_res;
                    }
                    Err(err) => {
                        let response = format_reply(id, Err(err));
                        if let Err(write_err) = client_writer.send_value(&response).await {
                            break Err(write_err);
                        }
                    }
                },
                _ => {
                    let ctx = Arc::clone(&context);
                    let w = client_writer.clone();
                    let method_owned = method.to_owned();
                    tasks.spawn(async move {
                        let res = ctx.handle_request(&method_owned, params).await;
                        let response = format_reply(id.clone(), res);
                        if let Err(err) = w.send_value(&response).await
                            && err.kind() == io::ErrorKind::InvalidData
                        {
                            let fallback =
                                RpcError::internal_error(err.to_string()).to_response(id);
                            let _ = w.send_value(&fallback).await;
                        }
                    });
                }
            },
            // Unreachable because reply_id == Some(None) doesn't happen, satisfy exhaustiveness.
            Some(None) => unreachable!(),
        }
    };

    drop(line_reader);
    engine.hub.unregister_client(client_id);
    if tokio::time::timeout(SHUTDOWN_DRAIN_TIMEOUT, async {
        while tasks.join_next().await.is_some() {}
    })
    .await
    .is_err()
    {
        tasks.abort_all();
        while tasks.join_next().await.is_some() {}
    }
    let shutting_down = disconnecting || engine.is_draining();
    drop(context);
    drop(client_writer);
    let flush_result = writer_handle.finish().await;
    if stop_daemon_after_flush {
        engine.shutdown.cancel();
    }

    match (loop_result, flush_result) {
        (Err(err), _) => Err(err),
        (Ok(()), Err(flush_err))
            if shutting_down
                && matches!(
                    flush_err.kind(),
                    io::ErrorKind::BrokenPipe | io::ErrorKind::UnexpectedEof
                ) =>
        {
            Ok(())
        }
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
