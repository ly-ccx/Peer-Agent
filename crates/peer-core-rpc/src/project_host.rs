//! Live `NativeProjectHost` actor runtime for `peer-core-rpc`.
//!
//! Manages dormant-by-default desktop host lifecycle (`project.bot.hostConfigure`),
//! per-workspace lease heartbeats and yield handoffs, 7-phase startup recovery barriers,
//! live Bot cognition turns with real-time `project.bot.activity` streaming, asynchronous
//! delegated worker episodes with live `PermissionInput` gating (`BotApprovalPermissionInput`),
//! periodic maintenance, and graceful shutdown draining.

use crate::{
    RpcPeer,
    classic::{self, ModelLoader},
    server::LocalBackgroundSpawner,
};
use peer_project_agent::{
    BotProfile, InteractiveContentBridge, InteractiveValidationError, LeaseStatus,
    NativeProjectHost, ProjectAgentActivity, ProjectError, is_valid_workspace_id,
    needs_recovery_attention, now_iso, now_iso_offset_ms, sha256_json,
};
use peer_protocol::{HostSurface, approval_args_digest};
use peer_runtime::{
    CancellationToken,
    model::NativeModel,
    model_catalog::{has_role_model_config, resolve_role_model},
    model_config::load_model,
    session_host::{LocalPermissionDecision, PermissionInput},
};
use peer_store::{ApprovalDecision, ApprovalState, ApprovalStore, HostApproval, PolicyStore};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex, RwLock,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{Mutex as AsyncMutex, mpsc, oneshot};

const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const MAINTENANCE_TICKS: u64 = 12; // 12 * 5s = 60s
const DEFAULT_PERMISSION_WAIT: Duration = Duration::from_secs(300);
const HOST_LEASE_YIELD_COOLDOWN: Duration = Duration::from_secs(20);
const INTERACTIVE_VALIDATION_RPC_TIMEOUT: Duration = Duration::from_secs(30);

struct RpcInteractiveContentBridge {
    peer: RpcPeer,
    catalog_prompt: Arc<RwLock<Option<String>>>,
}

impl RpcInteractiveContentBridge {
    async fn call_validate(
        peer: RpcPeer,
        params: Value,
        cancel: CancellationToken,
    ) -> Result<Value, InteractiveValidationError> {
        match peer
            .call_host_with_timeout(
                "host.interactive.validate",
                params,
                INTERACTIVE_VALIDATION_RPC_TIMEOUT,
                &cancel,
            )
            .await
        {
            Ok(val) => {
                if val.get("ok").and_then(Value::as_bool) == Some(true) {
                    Ok(val["result"].clone())
                } else {
                    Err(InteractiveValidationError::new(
                        val.get("code")
                            .and_then(Value::as_str)
                            .unwrap_or("interactive_validation_failed"),
                        val.get("path").and_then(Value::as_str).unwrap_or(""),
                        val.get("details").and_then(Value::as_str).unwrap_or(""),
                    ))
                }
            }
            Err(rpc_err) => Err(InteractiveValidationError::new(
                if cancel.is_cancelled() {
                    "interactive_cancelled"
                } else {
                    "interactive_worker_failed"
                },
                "",
                rpc_err.message,
            )),
        }
    }
}

impl InteractiveContentBridge for RpcInteractiveContentBridge {
    fn validate_draft(
        &self,
        draft: Value,
        bindings: Value,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Value, InteractiveValidationError>> + Send>> {
        let peer = self.peer.clone();
        Box::pin(Self::call_validate(
            peer,
            json!({
                "operation": "validate",
                "draft": draft,
                "bindings": bindings,
            }),
            cancel,
        ))
    }

    fn evaluate_content(
        &self,
        content: Value,
        values: Value,
        cancel: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<Value, InteractiveValidationError>> + Send>> {
        let peer = self.peer.clone();
        Box::pin(Self::call_validate(
            peer,
            json!({
                "operation": "evaluate",
                "content": content,
                "values": values,
            }),
            cancel,
        ))
    }

    fn catalog_prompt(&self) -> Option<String> {
        self.catalog_prompt.read().ok().and_then(|g| g.clone())
    }
}

#[derive(Debug, Clone)]
pub(crate) struct HostRuntimeSettings {
    pub proactivity: String,
    pub learn_preferences: bool,
    pub concurrency: Option<usize>,
    pub heartbeat_interval_ms: u64,
}

impl Default for HostRuntimeSettings {
    fn default() -> Self {
        Self {
            proactivity: "standard".to_owned(),
            learn_preferences: true,
            concurrency: None,
            heartbeat_interval_ms: HEARTBEAT_INTERVAL.as_millis() as u64,
        }
    }
}

struct ActiveTurnEntry {
    cancel: CancellationToken,
}

struct ActiveWorkerEntry {
    workspace_id: String,
    cancel: CancellationToken,
}

pub(crate) struct LiveApprovalWaiter {
    pub workspace_id: String,
    pub mirrored_in_workspace: bool,
    tx: oneshot::Sender<LocalPermissionDecision>,
}

struct VerificationNotification {
    runtime: Arc<ProjectHostRuntime>,
    workspace_id: String,
}

impl Drop for VerificationNotification {
    fn drop(&mut self) {
        self.runtime
            .emit_conversation_changed(&self.workspace_id, None);
        self.runtime.emit_changed(vec![self.workspace_id.clone()]);
    }
}

pub struct ProjectHostRuntime {
    data_home: PathBuf,
    host: Arc<NativeProjectHost>,
    peer: RpcPeer,
    spawner: LocalBackgroundSpawner,
    model_loader: Option<ModelLoader>,
    enabled: AtomicBool,
    settings: Mutex<HostRuntimeSettings>,
    active_turns: Mutex<HashMap<String, ActiveTurnEntry>>,
    active_workers: Mutex<HashMap<String, ActiveWorkerEntry>>,
    live_approvals: Arc<Mutex<HashMap<String, LiveApprovalWaiter>>>,
    recovery_status: Mutex<HashMap<String, Value>>,
    in_flight_retries: Mutex<HashSet<String>>,
    workspace_locks: Mutex<HashMap<String, Arc<AsyncMutex<()>>>>,
    pending_wakes: Mutex<HashSet<String>>,
    active_wakes: Mutex<HashSet<String>>,
    heartbeat_paused_inputs: Mutex<HashMap<String, Option<String>>>,
    yielded_until: Mutex<HashMap<String, tokio::time::Instant>>,
    loop_cancel: Mutex<Option<CancellationToken>>,
    interactive_catalog: Arc<RwLock<Option<String>>>,
}

impl ProjectHostRuntime {
    pub(crate) fn new(
        data_home: PathBuf,
        app_version: &str,
        peer: RpcPeer,
        spawner: LocalBackgroundSpawner,
        model_loader: Option<ModelLoader>,
    ) -> Result<Self, ProjectError> {
        let host = Arc::new(NativeProjectHost::new_for_surface(
            &data_home,
            HostSurface::Desktop,
            app_version,
            None,
        )?);
        let interactive_catalog = Arc::new(RwLock::new(None));
        host.set_interactive_bridge(Some(Arc::new(RpcInteractiveContentBridge {
            peer: peer.clone(),
            catalog_prompt: Arc::clone(&interactive_catalog),
        })));
        Ok(Self {
            data_home,
            host,
            peer,
            spawner,
            model_loader,
            enabled: AtomicBool::new(false),
            settings: Mutex::new(HostRuntimeSettings::default()),
            active_turns: Mutex::new(HashMap::new()),
            active_workers: Mutex::new(HashMap::new()),
            live_approvals: Arc::new(Mutex::new(HashMap::new())),
            recovery_status: Mutex::new(HashMap::new()),
            in_flight_retries: Mutex::new(HashSet::new()),
            workspace_locks: Mutex::new(HashMap::new()),
            pending_wakes: Mutex::new(HashSet::new()),
            active_wakes: Mutex::new(HashSet::new()),
            heartbeat_paused_inputs: Mutex::new(HashMap::new()),
            yielded_until: Mutex::new(HashMap::new()),
            loop_cancel: Mutex::new(None),
            interactive_catalog,
        })
    }

    fn is_yield_cooled_down(&self, workspace_id: &str) -> bool {
        let now = tokio::time::Instant::now();
        let Ok(mut guard) = self.yielded_until.lock() else {
            return false;
        };
        guard.retain(|_, until| *until > now);
        guard.get(workspace_id).is_some_and(|until| *until > now)
    }

    fn mark_yielded(&self, workspace_id: &str) {
        if let Ok(mut guard) = self.yielded_until.lock() {
            guard.insert(
                workspace_id.to_owned(),
                tokio::time::Instant::now() + HOST_LEASE_YIELD_COOLDOWN,
            );
        }
    }

    pub fn clear_yield_cooldown(&self, workspace_id: &str) {
        if let Ok(mut guard) = self.yielded_until.lock() {
            guard.remove(workspace_id);
        }
    }

    pub fn host(&self) -> &Arc<NativeProjectHost> {
        &self.host
    }

    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::SeqCst)
    }

    pub(crate) fn workspace_lock(&self, workspace_id: &str) -> Arc<AsyncMutex<()>> {
        let mut guard = self
            .workspace_locks
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        Arc::clone(
            guard
                .entry(workspace_id.to_owned())
                .or_insert_with(|| Arc::new(AsyncMutex::new(()))),
        )
    }

    pub fn try_begin_retry(&self, workspace_id: &str, turn_id: &str) -> bool {
        let key = format!("{workspace_id}:{turn_id}");
        self.in_flight_retries
            .lock()
            .map(|mut g| g.insert(key))
            .unwrap_or(false)
    }

    pub fn finish_retry(&self, workspace_id: &str, turn_id: &str) {
        let key = format!("{workspace_id}:{turn_id}");
        if let Ok(mut g) = self.in_flight_retries.lock() {
            g.remove(&key);
        }
    }

    pub fn set_recovery_ready(&self, workspace_id: &str) {
        if let Ok(mut g) = self.recovery_status.lock() {
            g.insert(workspace_id.to_owned(), json!({ "status": "ready" }));
        }
    }

    fn set_recovery_failed(&self, workspace_id: &str, err: &ProjectError) {
        if let Ok(mut g) = self.recovery_status.lock() {
            g.insert(
                workspace_id.to_owned(),
                json!({
                    "status": "failed",
                    "error": err.code,
                }),
            );
        }
    }

    pub fn is_workspace_ready(&self, workspace_id: &str) -> bool {
        self.recovery_status
            .lock()
            .ok()
            .and_then(|g| g.get(workspace_id).map(|v| v["status"] == "ready"))
            .unwrap_or(false)
            || self
                .host
                .recovery()
                .is_ready(workspace_id, self.host.holds_lease(workspace_id))
    }

    pub fn emit_changed(&self, workspace_ids: Vec<String>) {
        if workspace_ids.is_empty() {
            return;
        }
        let peer = self.peer.clone();
        let _ = self.spawner.spawn(move |_guard| {
            tokio::task::spawn_local(async move {
                let _ = peer
                    .notify(
                        "project.bot.changed",
                        json!({ "workspaceIds": workspace_ids }),
                    )
                    .await;
            });
        });
    }

    pub fn emit_conversation_changed(&self, workspace_id: &str, conversation_id: Option<&str>) {
        let peer = self.peer.clone();
        let ws = workspace_id.to_owned();
        let cid = conversation_id.map(str::to_owned);
        let _ = self.spawner.spawn(move |_guard| {
            tokio::task::spawn_local(async move {
                let mut payload = json!({ "workspaceId": ws });
                if let Some(conv) = cid {
                    payload["conversationId"] = json!(conv);
                }
                let _ = peer
                    .notify("project.bot.conversationChanged", payload)
                    .await;
            });
        });
    }

    pub fn emit_obligation_grants(&self, payload: Value) {
        let peer = self.peer.clone();
        let _ = self.spawner.spawn(move |_guard| {
            tokio::task::spawn_local(async move {
                let _ = peer.notify("project.bot.obligationGrants", payload).await;
            });
        });
    }

    pub async fn configure(self: &Arc<Self>, params: Value) -> Result<Value, String> {
        let enabled = params
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| "enabled boolean required".to_owned())?;

        if let Ok(mut st) = self.settings.lock() {
            if let Some(p) = params.get("proactivity").and_then(Value::as_str) {
                st.proactivity = p.to_owned();
            }
            if let Some(lp) = params.get("learnPreferences").and_then(Value::as_bool) {
                st.learn_preferences = lp;
            }
            if let Some(c) = params.get("concurrency").and_then(Value::as_u64) {
                st.concurrency = usize::try_from(c).ok().filter(|n| *n > 0);
            }
            if let Some(hb) = params.get("heartbeatIntervalMs").and_then(Value::as_u64) {
                st.heartbeat_interval_ms = hb.clamp(50, 60_000);
            }
        }
        if let Some(ir_enabled) = params.get("interactiveResults").and_then(Value::as_bool) {
            self.host.set_interactive_enabled_override(Some(ir_enabled));
        }
        if let Some(ir_ctx) = params
            .get("interactiveContext")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty())
            && let Ok(mut guard) = self.interactive_catalog.write()
        {
            *guard = Some(ir_ctx.to_owned());
        }

        if let Some(workspaces) = params.get("workspaces").and_then(Value::as_array) {
            for item in workspaces {
                let managed = item.get("managed").and_then(Value::as_bool) == Some(true);
                let name = item
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty());
                if let Some(existing_id) = item
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    && let Ok(Some(existing)) = self.host.registry().get(existing_id)
                {
                    let _ = self.host.ensure_bot(&existing.workspace_id, managed, name);
                    continue;
                }
                let Some(path_str) = item
                    .as_str()
                    .or_else(|| item.get("path").and_then(Value::as_str))
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                else {
                    continue;
                };
                if let Ok(entry) = self.host.registry().register(path_str, None) {
                    let _ = self.host.ensure_bot(&entry.workspace_id, managed, name);
                }
            }
        }

        if !enabled {
            self.disable_and_drain().await;
            return Ok(self.status(None));
        }

        if !self.enabled.swap(true, Ordering::SeqCst) {
            self.start_loops();
        }
        let (tx, rx) = tokio::sync::oneshot::channel();
        let rt = Arc::clone(self);
        if self
            .spawner
            .spawn(move |_guard| {
                tokio::task::spawn_local(async move {
                    rt.reconcile_all_active_bots().await;
                    let _ = tx.send(());
                });
            })
            .is_ok()
        {
            let _ = rx.await;
        }
        Ok(self.status(None))
    }

    fn active_profiles(&self) -> Vec<peer_project_agent::BotProfile> {
        self.host
            .profiles()
            .list_workspace_ids()
            .into_iter()
            .filter_map(|id| {
                self.host
                    .profiles()
                    .read(&id)
                    .filter(peer_project_agent::BotProfile::is_active)
            })
            .collect()
    }

    pub fn status(&self, workspace_id: Option<&str>) -> Value {
        let profiles = self.active_profiles();
        let target_ids: Vec<String> = match workspace_id {
            Some(ws) if is_valid_workspace_id(ws) => vec![ws.to_owned()],
            _ => profiles.into_iter().map(|p| p.workspace_id).collect(),
        };
        let owned = self.host.owned_workspaces();
        let recovery_map = self
            .recovery_status
            .lock()
            .map(|g| g.clone())
            .unwrap_or_default();
        let mut activities = serde_json::Map::new();
        let mut agent_statuses = serde_json::Map::new();
        let mut recovery_attention = serde_json::Map::new();
        let mut rec_out = serde_json::Map::new();
        for ws in &target_ids {
            if let Some(act) = self.host.runner().activity_for(ws)
                && let Ok(v) = serde_json::to_value(act)
            {
                activities.insert(ws.clone(), v);
            }
            if let Some(st) = self.host.runner().status_for(ws) {
                agent_statuses.insert(ws.clone(), json!(st));
            }
            recovery_attention.insert(
                ws.clone(),
                json!(needs_recovery_attention(&self.data_home, ws)),
            );
            if let Some(rec) = recovery_map.get(ws) {
                rec_out.insert(ws.clone(), rec.clone());
            }
        }
        json!({
            "ok": true,
            "enabled": self.is_enabled(),
            "hostId": self.host.host_id(),
            "surface": match self.host.host_identity().surface() {
                HostSurface::Desktop => "desktop",
                HostSurface::Tui => "tui",
            },
            "interactiveResultsEnabled": self.host.is_interactive_publishing_available(),
            "ownedWorkspaces": owned,
            "recoveryStatus": rec_out,
            "activities": activities,
            "agentStatuses": agent_statuses,
            "recoveryAttention": recovery_attention,
        })
    }

    fn start_loops(self: &Arc<Self>) {
        let cancel = self.peer.shutdown_child_token();
        if let Ok(mut guard) = self.loop_cancel.lock() {
            if let Some(prev) = guard.take() {
                prev.cancel();
            }
            *guard = Some(cancel.clone());
        }

        // Activity forwarder channel -> `project.bot.activity`
        let (act_tx, mut act_rx) = mpsc::unbounded_channel::<(ProjectAgentActivity, String)>();
        self.host.runner().set_activity_listener(Some(Arc::new(
            move |activity: ProjectAgentActivity, status: String| {
                let _ = act_tx.send((activity, status));
            },
        )));
        let peer_act = self.peer.clone();
        let cancel_act = cancel.clone();
        let _ = self.spawner.spawn(move |_guard| {
            tokio::task::spawn_local(async move {
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel_act.cancelled() => break,
                        msg = act_rx.recv() => {
                            let Some((act, status)) = msg else { break; };
                            let _ = peer_act.notify("project.bot.activity", json!({
                                "workspaceId": act.workspace_id,
                                "activity": act,
                                "status": status,
                            })).await;
                        }
                    }
                }
            });
        });

        // Heartbeat / yield monitor + periodic maintenance loop
        let rt_hb = Arc::clone(self);
        let cancel_hb = cancel;
        let hb_ms = self
            .settings
            .lock()
            .map(|s| s.heartbeat_interval_ms)
            .unwrap_or(HEARTBEAT_INTERVAL.as_millis() as u64);
        let _ = self.spawner.spawn(move |_guard| {
            tokio::task::spawn_local(async move {
                let mut ticker = tokio::time::interval(Duration::from_millis(hb_ms));
                ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
                ticker.tick().await;
                let mut tick_count: u64 = 0;
                loop {
                    tokio::select! {
                        biased;
                        _ = cancel_hb.cancelled() => break,
                        _ = ticker.tick() => {
                            if !rt_hb.is_enabled() {
                                break;
                            }
                            tick_count += 1;
                            rt_hb.heartbeat_and_check_takeovers().await;
                            if tick_count.is_multiple_of(MAINTENANCE_TICKS) {
                                rt_hb.run_maintenance_pass(&cancel_hb).await;
                            }
                        }
                    }
                }
            });
        });
    }

    async fn reconcile_all_active_bots(self: &Arc<Self>) {
        let profiles = self.active_profiles();
        let mut changed_ws = Vec::new();
        for profile in profiles {
            if !self.is_enabled() {
                break;
            }
            let ws_id = profile.workspace_id;
            let cancel = self
                .loop_cancel
                .lock()
                .ok()
                .and_then(|g| g.clone())
                .unwrap_or_else(|| self.peer.shutdown_child_token());
            if self.ensure_workspace_ready(&ws_id, &cancel).await {
                changed_ws.push(ws_id.clone());
                if self.host.has_pending_work(&ws_id) {
                    self.wake_workspace(&ws_id);
                }
            }
        }
        if !changed_ws.is_empty() {
            self.emit_changed(changed_ws);
        }
    }

    async fn ensure_workspace_ready(&self, workspace_id: &str, cancel: &CancellationToken) -> bool {
        if self.is_yield_cooled_down(workspace_id) {
            return false;
        }
        let acquired = match self.host.ensure_lease(workspace_id) {
            Ok(LeaseStatus::Acquired { .. }) => true,
            Ok(LeaseStatus::HeldByOther(_)) => false,
            Err(err) => {
                self.set_recovery_failed(workspace_id, &err);
                return false;
            }
        };
        if !acquired {
            return false;
        }
        if !self
            .host
            .recovery()
            .is_ready(workspace_id, self.host.holds_lease(workspace_id))
        {
            match self
                .host
                .recover_workspace_barrier(workspace_id, cancel)
                .await
            {
                Ok(_) => self.set_recovery_ready(workspace_id),
                Err(err) => {
                    self.set_recovery_failed(workspace_id, &err);
                    return false;
                }
            }
        } else {
            self.set_recovery_ready(workspace_id);
        }
        true
    }

    async fn heartbeat_and_check_takeovers(self: &Arc<Self>) {
        let profiles = self.active_profiles();
        let cancel = self
            .loop_cancel
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| self.peer.shutdown_child_token());
        for profile in profiles {
            if !self.is_enabled() || cancel.is_cancelled() {
                break;
            }
            let ws_id = profile.workspace_id;
            if self.host.holds_lease(&ws_id) {
                if self.host.takeover_requested(&ws_id) {
                    self.quiesce_workspace(&ws_id).await;
                    let _ = self.host.release_lease(&ws_id);
                    let _ = std::fs::remove_file(
                        self.data_home
                            .join("project-runtime")
                            .join(&ws_id)
                            .join("host.yield"),
                    );
                    self.mark_yielded(&ws_id);
                    self.emit_changed(vec![ws_id]);
                    continue;
                }
                match self.host.ensure_lease(&ws_id) {
                    Ok(LeaseStatus::Acquired { .. }) => {
                        if self.host.has_pending_work(&ws_id) {
                            self.wake_workspace_from_heartbeat(&ws_id);
                        }
                    }
                    Ok(LeaseStatus::HeldByOther(_)) => {
                        self.quiesce_workspace(&ws_id).await;
                        self.emit_changed(vec![ws_id]);
                    }
                    Err(err) => {
                        self.set_recovery_failed(&ws_id, &err);
                    }
                }
            } else if self.ensure_workspace_ready(&ws_id, &cancel).await {
                self.emit_changed(vec![ws_id.clone()]);
                if self.host.has_pending_work(&ws_id) {
                    self.wake_workspace_from_heartbeat(&ws_id);
                }
            }
        }
    }

    async fn run_maintenance_pass(&self, cancel: &CancellationToken) {
        let owned = self.host.owned_workspaces();
        for ws_id in owned {
            if !self.is_enabled() || cancel.is_cancelled() {
                break;
            }
            if !self.is_workspace_ready(&ws_id) || self.host.takeover_requested(&ws_id) {
                continue;
            }
            let lock = self.workspace_lock(&ws_id);
            let Ok(_guard) = lock.try_lock() else {
                continue;
            };
            let model_opt = self
                .load_model_for_role(&ws_id, "memory_curator", cancel)
                .await
                .ok()
                .map(|(m, _)| m);
            let at = now_iso();
            if let Ok(report) = self
                .host
                .run_background_maintenance(&ws_id, &at, model_opt.as_ref(), cancel)
                .await
                && (report.flushed_digest || report.recovered_verifications > 0)
            {
                self.emit_conversation_changed(&ws_id, None);
                self.emit_changed(vec![ws_id]);
            }
        }
    }

    fn wake_workspace_from_heartbeat(self: &Arc<Self>, workspace_id: &str) {
        if self
            .active_wakes
            .lock()
            .is_ok_and(|active| active.contains(workspace_id))
        {
            return;
        }
        if let Ok(paused) = self.heartbeat_paused_inputs.lock()
            && let Some(paused_cursor) = paused.get(workspace_id)
        {
            let has_new_unread = self
                .host
                .inputs()
                .diagnostic_snapshot(workspace_id)
                .map(|snap| snap.depth > 0 || &snap.cursor != paused_cursor)
                .unwrap_or(false);
            let has_queued_sessions = self
                .host
                .supervisor()
                .list_sessions(workspace_id)
                .iter()
                .any(|s| s.status == "queued");
            let now_ms = peer_project_agent::parse_iso_ms(&now_iso()).unwrap_or(0);
            let wake_trial_due = self
                .host
                .failure_hold(workspace_id)
                .is_some_and(|hold| now_ms >= hold.hold_until_ms);
            if !has_new_unread && !has_queued_sessions && !wake_trial_due {
                return;
            }
        }
        self.wake_workspace(workspace_id);
    }

    pub fn wake_workspace(self: &Arc<Self>, workspace_id: &str) {
        if !self.is_enabled() || !is_valid_workspace_id(workspace_id) {
            return;
        }
        if let Ok(mut paused) = self.heartbeat_paused_inputs.lock() {
            paused.remove(workspace_id);
        }
        {
            let mut pending = self.pending_wakes.lock().unwrap_or_else(|e| e.into_inner());
            pending.insert(workspace_id.to_owned());
            let mut active = self.active_wakes.lock().unwrap_or_else(|e| e.into_inner());
            if !active.insert(workspace_id.to_owned()) {
                return;
            }
        }
        let rt = Arc::clone(self);
        let ws = workspace_id.to_owned();
        if self
            .spawner
            .spawn(move |_guard| {
                tokio::task::spawn_local(async move {
                    rt.pump_workspace(&ws).await;
                });
            })
            .is_err()
            && let Ok(mut active) = self.active_wakes.lock()
        {
            active.remove(workspace_id);
        }
    }

    async fn pump_workspace(self: &Arc<Self>, workspace_id: &str) {
        loop {
            let take_next = self
                .pending_wakes
                .lock()
                .map(|mut g| g.remove(workspace_id))
                .unwrap_or(false);
            if !take_next || !self.is_enabled() {
                break;
            }
            self.run_single_tick(workspace_id).await;
        }
        if let Ok(mut active) = self.active_wakes.lock() {
            active.remove(workspace_id);
        }
        // Check if another wake arrived right between loop exit and removal
        let missed = self
            .pending_wakes
            .lock()
            .map(|g| g.contains(workspace_id))
            .unwrap_or(false);
        if missed && self.is_enabled() {
            self.wake_workspace(workspace_id);
        }
    }

    async fn run_single_tick(self: &Arc<Self>, workspace_id: &str) {
        let Some(profile) = self
            .host
            .profiles()
            .read(workspace_id)
            .filter(BotProfile::is_active)
        else {
            return;
        };
        let conv_id = profile.agent_conversation_id;
        let loop_cancel = self
            .loop_cancel
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| self.peer.shutdown_child_token());
        if loop_cancel.is_cancelled() || !self.is_enabled() {
            return;
        }

        let lock = self.workspace_lock(workspace_id);
        let _ws_guard = lock.lock().await;

        if !self.is_enabled() || loop_cancel.is_cancelled() {
            return;
        }
        if !self
            .ensure_workspace_ready(workspace_id, &loop_cancel)
            .await
        {
            self.emit_changed(vec![workspace_id.to_owned()]);
            return;
        }
        if !self.host.has_pending_work(workspace_id)
            && !self
                .host
                .supervisor()
                .list_sessions(workspace_id)
                .iter()
                .any(|s| s.status == "queued")
        {
            return;
        }

        let Ok((bot_model, _)) = self
            .load_model_for_role(workspace_id, "project_agent", &loop_cancel)
            .await
        else {
            // Even without a configured model, still promote any queued sessions if possible
            if let Ok(promoted) = self.host.supervisor().promote_queued(workspace_id, true)
                && !promoted.start.is_empty()
            {
                for sid in promoted.start {
                    self.spawn_worker_session(workspace_id, &sid);
                }
                self.emit_changed(vec![workspace_id.to_owned()]);
            }
            return;
        };

        let worker_sel = self.worker_selection_json(workspace_id, &loop_cancel).await;
        let turn_cancel = loop_cancel.child_token();
        if let Ok(mut turns) = self.active_turns.lock() {
            turns.insert(
                workspace_id.to_owned(),
                ActiveTurnEntry {
                    cancel: turn_cancel.clone(),
                },
            );
        }

        let profile = self.host.profiles().read(workspace_id);
        let verifier_model = if has_role_model_config(
            &self.data_home,
            "verifier",
            profile.as_ref().and_then(|p| p.model_policy.as_ref()),
        ) {
            match self
                .load_model_for_role(workspace_id, "verifier", &turn_cancel)
                .await
            {
                Ok((model, _)) => Some(model),
                Err(_) => Some(bot_model.clone()),
            }
        } else {
            Some(bot_model.clone())
        };
        let had_failure_hold = self.host.failure_hold(workspace_id).is_some();
        let tick_res = Box::pin(self.host.tick_foreground_with_verifier(
            workspace_id,
            &bot_model,
            verifier_model.as_ref(),
            worker_sel,
            &turn_cancel,
        ))
        .await;

        if let Ok(mut turns) = self.active_turns.lock() {
            turns.remove(workspace_id);
        }

        match tick_res {
            Ok(report) => {
                let ended_in_failure = matches!(
                    report.last_turn.as_ref().map(|t| &t.end),
                    Some(
                        peer_project_agent::TurnEndKind::Failed { .. }
                            | peer_project_agent::TurnEndKind::CircuitOpen
                    )
                );
                if ended_in_failure {
                    let cursor = self.host.inputs().read_cursor(workspace_id).ok().flatten();
                    if let Ok(mut paused) = self.heartbeat_paused_inputs.lock() {
                        paused.insert(workspace_id.to_owned(), cursor);
                    }
                } else if let Ok(mut paused) = self.heartbeat_paused_inputs.lock() {
                    paused.remove(workspace_id);
                }
                if had_failure_hold
                    && !ended_in_failure
                    && report.last_turn.is_some()
                    && self.host.failure_hold(workspace_id).is_none()
                {
                    self.wake_workspace(workspace_id);
                }
                if !report.promoted_session_ids.is_empty() {
                    for sid in &report.promoted_session_ids {
                        self.spawn_worker_session(workspace_id, sid);
                    }
                }
                if report.inputs_consumed > 0
                    || report.bot_turns_run > 0
                    || report.wake_turns_run > 0
                    || !report.promoted_session_ids.is_empty()
                {
                    self.emit_conversation_changed(workspace_id, conv_id.as_deref());
                    self.emit_changed(vec![workspace_id.to_owned()]);
                }
            }
            Err(_) => {
                self.emit_changed(vec![workspace_id.to_owned()]);
            }
        }
    }

    pub fn spawn_worker_session(self: &Arc<Self>, workspace_id: &str, session_id: &str) {
        if !self.is_enabled() {
            return;
        }
        {
            let active = self
                .active_workers
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if active.contains_key(session_id) {
                return;
            }
        }
        let cancel = self
            .loop_cancel
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| self.peer.shutdown_child_token())
            .child_token();
        if let Ok(mut active) = self.active_workers.lock() {
            active.insert(
                session_id.to_owned(),
                ActiveWorkerEntry {
                    workspace_id: workspace_id.to_owned(),
                    cancel: cancel.clone(),
                },
            );
        }
        let rt = Arc::clone(self);
        let ws = workspace_id.to_owned();
        let sid = session_id.to_owned();
        if self
            .spawner
            .spawn(move |_guard| {
                tokio::task::spawn_local(async move {
                    let worker = Arc::clone(&rt);
                    let worker_ws = ws.clone();
                    let worker_sid = sid.clone();
                    let worker_cancel = cancel.clone();
                    let joined = tokio::task::spawn_local(async move {
                        worker
                            .run_worker_task(&worker_ws, &worker_sid, &worker_cancel)
                            .await;
                    })
                    .await;
                    if let Err(error) = joined {
                        eprintln!("project worker task {sid} exited: {error}");
                    }
                    if let Ok(mut active) = rt.active_workers.lock() {
                        active.remove(&sid);
                    }
                    rt.emit_changed(vec![ws.clone()]);
                    rt.emit_conversation_changed(&ws, None);
                    if rt.is_enabled() && !cancel.is_cancelled() {
                        rt.wake_workspace(&ws);
                    }
                });
            })
            .is_err()
            && let Ok(mut active) = self.active_workers.lock()
        {
            active.remove(session_id);
        }
    }

    pub async fn verify_session_now(
        self: &Arc<Self>,
        workspace_id: &str,
        session_id: &str,
        focus: Option<&str>,
    ) -> Result<Value, peer_project_agent::ProjectError> {
        let notify = VerificationNotification {
            runtime: Arc::clone(self),
            workspace_id: workspace_id.to_owned(),
        };
        let epoch = self
            .host
            .lease_epoch(workspace_id)
            .filter(|epoch| {
                self.is_enabled() && self.host.holds_lease_generation(workspace_id, epoch)
            })
            .ok_or_else(|| ProjectError::code("LEASE_REQUIRED"))?;
        let Some(plan) = self
            .host
            .supervisor()
            .find_plan_by_session(workspace_id, session_id)
        else {
            return Err(peer_project_agent::ProjectError::code("NOT_FOUND"));
        };
        let cancel = self
            .loop_cancel
            .lock()
            .ok()
            .and_then(|g| g.clone())
            .unwrap_or_else(|| self.peer.shutdown_child_token())
            .child_token();
        let _cancel_on_drop = cancel.clone().drop_guard();
        let profile = self.host.profiles().read(workspace_id);
        let model = if has_role_model_config(
            &self.data_home,
            "verifier",
            profile.as_ref().and_then(|p| p.model_policy.as_ref()),
        ) {
            match self
                .load_model_for_role(workspace_id, "verifier", &cancel)
                .await
            {
                Ok((m, _)) => m,
                Err(_) => self
                    .load_model_for_role(workspace_id, "project_agent", &cancel)
                    .await
                    .map(|(m, _)| m)
                    .map_err(|_| peer_project_agent::ProjectError::code("MODEL_UNAVAILABLE"))?,
            }
        } else {
            self.load_model_for_role(workspace_id, "project_agent", &cancel)
                .await
                .map(|(m, _)| m)
                .map_err(|_| peer_project_agent::ProjectError::code("MODEL_UNAVAILABLE"))?
        };
        let host = Arc::clone(&self.host);
        let ws = workspace_id.to_owned();
        let focus_owned = focus.map(str::to_owned);
        let runtime = tokio::runtime::Handle::current();
        self.emit_changed(vec![workspace_id.to_owned()]);
        let result = tokio::task::spawn_blocking(move || {
            let _notify = notify;
            runtime.block_on(host.supervisor().reverify_session(
                plan,
                focus_owned.as_deref(),
                &model,
                &cancel,
                || host.holds_lease_generation(&ws, &epoch),
            ))
        })
        .await
        .map_err(|_| peer_project_agent::ProjectError::code("verifier_task_failed"))??;
        let passed = result["verificationReport"]["passed"].as_bool() == Some(true);
        let accepted = result["decision"]["acceptedBy"].as_str().is_some();
        if passed && !accepted {
            let plan_id = result["planId"].as_str().unwrap_or("");
            self.host
                .supervisor()
                .notify_reverified_result(workspace_id, session_id, plan_id);
            if self.is_enabled() {
                self.wake_workspace(workspace_id);
            }
        }
        Ok(result)
    }

    async fn run_worker_task(
        self: &Arc<Self>,
        workspace_id: &str,
        session_id: &str,
        cancel: &CancellationToken,
    ) {
        match self
            .load_model_for_role(workspace_id, "session_worker", cancel)
            .await
        {
            Ok((worker_model, _)) => {
                let verifier_model = self
                    .load_model_for_role(workspace_id, "verifier", cancel)
                    .await
                    .ok()
                    .map(|(m, _)| m);
                let plan_id = self
                    .host
                    .supervisor()
                    .find_plan_by_session(workspace_id, session_id)
                    .and_then(|p| p["planId"].as_str().map(str::to_owned))
                    .unwrap_or_default();
                let mut permission = BotApprovalPermissionInput {
                    workspace_id: workspace_id.to_owned(),
                    session_id: session_id.to_owned(),
                    plan_id,
                    data_home: self.data_home.clone(),
                    peer: self.peer.clone(),
                    live_approvals: Arc::clone(&self.live_approvals),
                    shutdown: cancel.clone(),
                };
                if let Err(err) = Box::pin(self.host.run_promoted_session(
                    workspace_id,
                    session_id,
                    &worker_model,
                    verifier_model.as_ref(),
                    &mut permission,
                    peer_project_agent::DEFAULT_WORKER_MAX_TURNS,
                    cancel,
                ))
                .await
                    && !cancel.is_cancelled()
                    && !matches!(
                        err.code,
                        "LEASE_HELD_BY_OTHER" | "LEASE_REQUIRED" | "session_state_changed"
                    )
                {
                    let _ = self.host.supervisor().fail_session(
                        workspace_id,
                        session_id,
                        err.code,
                        &err.detail,
                        self.host.holds_lease(workspace_id),
                    );
                }
            }
            Err(err_msg) => {
                if !cancel.is_cancelled() {
                    let _ = self.host.supervisor().fail_session(
                        workspace_id,
                        session_id,
                        "WORKER_MODEL_UNAVAILABLE",
                        &err_msg,
                        self.host.holds_lease(workspace_id),
                    );
                }
            }
        }
    }

    async fn load_model_for_role(
        &self,
        workspace_id: &str,
        role: &str,
        cancel: &CancellationToken,
    ) -> Result<(NativeModel, Option<String>), String> {
        let profile = self.host.profiles().read(workspace_id);
        let policy = profile.as_ref().and_then(|p| p.model_policy.as_ref());
        let resolved_role =
            resolve_role_model(&self.data_home, role, policy, None, None, None, false);
        if let Some(loader) = &self.model_loader {
            let (provider_id, effort) = match resolved_role {
                Ok(sel) => (
                    Some(sel.entry.provider_id.clone()),
                    sel.selection["reasoningEffort"].as_str().map(str::to_owned),
                ),
                Err(_) => (None, None),
            };
            let loaded = loader(
                self.data_home.clone(),
                provider_id,
                effort,
                false,
                cancel.clone(),
            )
            .await
            .map_err(|e| e.message)?;
            return Ok((loaded.model, Some(loaded.provider_id)));
        }
        match resolved_role {
            Ok(sel) => {
                let model = load_model(&self.data_home, &sel.selection, cancel)
                    .await
                    .map_err(|e| e.code.to_owned())?;
                Ok((model, Some(sel.entry.provider_id)))
            }
            Err(_) => {
                let resolved = classic::resolve_default_model(
                    self.data_home.clone(),
                    None,
                    None,
                    false,
                    cancel.clone(),
                )
                .await
                .map_err(|e| e.message)?;
                Ok((resolved.model, Some(resolved.provider_id)))
            }
        }
    }

    async fn worker_selection_json(&self, workspace_id: &str, cancel: &CancellationToken) -> Value {
        let profile = self.host.profiles().read(workspace_id);
        let policy = profile.as_ref().and_then(|p| p.model_policy.as_ref());
        if let Ok(sel) = resolve_role_model(
            &self.data_home,
            "session_worker",
            policy,
            None,
            None,
            None,
            false,
        ) {
            return sel.selection;
        }
        if let Ok((m, pid)) = self
            .load_model_for_role(workspace_id, "session_worker", cancel)
            .await
        {
            let provider = pid.unwrap_or_else(|| m.provider().to_owned());
            return json!({
                "providerId": provider,
                "modelProviderId": provider,
                "modelId": m.model_id(),
                "family": m.provider(),
                "reasoningEffort": "default",
            });
        }
        json!({})
    }

    pub fn stop_turn(&self, workspace_id: &str, turn_id: &str) -> Value {
        if !self.host.holds_lease(workspace_id) {
            return json!({ "ok": false, "code": "HOST_OFFLINE" });
        }
        let active_tid = self
            .host
            .runner()
            .activity_for(workspace_id)
            .filter(|a| a.finished_at.is_none())
            .map(|a| a.turn_id);
        let has_turn = self
            .active_turns
            .lock()
            .ok()
            .is_some_and(|g| g.contains_key(workspace_id));
        if !has_turn {
            return json!({ "ok": false, "code": "STALE_TURN" });
        }
        if let Some(ref cur_tid) = active_tid
            && cur_tid != turn_id
        {
            return json!({ "ok": false, "code": "STALE_TURN" });
        }
        if let Ok(turns) = self.active_turns.lock()
            && let Some(entry) = turns.get(workspace_id)
        {
            entry.cancel.cancel();
            return json!({ "ok": true, "turnId": turn_id, "stopping": true });
        }
        json!({ "ok": false, "code": "STALE_TURN" })
    }

    pub fn cancel_live_worker(&self, session_id: &str) {
        self.host.supervisor().cancel_live_verification(session_id);
        if let Ok(workers) = self.active_workers.lock()
            && let Some(entry) = workers.get(session_id)
        {
            entry.cancel.cancel();
        }
    }

    pub fn is_live_approval_mirrored(&self, approval_id: &str) -> Option<bool> {
        self.live_approvals
            .lock()
            .ok()
            .and_then(|g| g.get(approval_id).map(|w| w.mirrored_in_workspace))
    }

    pub fn settle_live_approval(
        &self,
        approval_id: &str,
        decision: LocalPermissionDecision,
    ) -> Option<bool> {
        let waiter = self
            .live_approvals
            .lock()
            .ok()
            .and_then(|mut g| g.remove(approval_id))?;
        let mirrored = waiter.mirrored_in_workspace;
        let _ = waiter.tx.send(decision);
        Some(mirrored)
    }

    pub async fn quiesce_workspace(&self, workspace_id: &str) {
        if let Ok(turns) = self.active_turns.lock()
            && let Some(entry) = turns.get(workspace_id)
        {
            entry.cancel.cancel();
        }
        if let Ok(workers) = self.active_workers.lock() {
            for entry in workers.values() {
                if entry.workspace_id == workspace_id {
                    entry.cancel.cancel();
                }
            }
        }
        if let Ok(mut pending) = self.live_approvals.lock() {
            let keys: Vec<String> = pending
                .iter()
                .filter(|(_, w)| w.workspace_id == workspace_id)
                .map(|(k, _)| k.clone())
                .collect();
            for k in keys {
                if let Some(waiter) = pending.remove(&k) {
                    let _ = waiter.tx.send(LocalPermissionDecision::Cancel);
                }
            }
        }
        let lock = self.workspace_lock(workspace_id);
        let _guard = lock.lock().await;
    }

    pub async fn wait_workspace_idle(&self, workspace_id: &str) {
        let lock = self.workspace_lock(workspace_id);
        let _guard = lock.lock().await;
    }

    async fn disable_and_drain(&self) {
        self.begin_shutdown();
        let locks: Vec<Arc<AsyncMutex<()>>> = self
            .workspace_locks
            .lock()
            .map(|g| g.values().cloned().collect())
            .unwrap_or_default();
        for lock in locks {
            let _ = tokio::time::timeout(Duration::from_secs(2), lock.lock()).await;
        }
        self.release_all_leases();
    }

    pub fn begin_shutdown(&self) {
        self.enabled.store(false, Ordering::SeqCst);
        self.host.runner().set_activity_listener(None);
        if let Ok(mut guard) = self.loop_cancel.lock()
            && let Some(token) = guard.take()
        {
            token.cancel();
        }
        if let Ok(turns) = self.active_turns.lock() {
            for entry in turns.values() {
                entry.cancel.cancel();
            }
        }
        if let Ok(workers) = self.active_workers.lock() {
            for entry in workers.values() {
                entry.cancel.cancel();
            }
        }
        if let Ok(mut approvals) = self.live_approvals.lock() {
            for (_, waiter) in approvals.drain() {
                let _ = waiter.tx.send(LocalPermissionDecision::Cancel);
            }
        }
    }

    pub fn release_all_leases(&self) {
        self.host.release_all_leases();
    }
}

struct BotApprovalPermissionInput {
    workspace_id: String,
    session_id: String,
    plan_id: String,
    data_home: PathBuf,
    peer: RpcPeer,
    live_approvals: Arc<Mutex<HashMap<String, LiveApprovalWaiter>>>,
    shutdown: CancellationToken,
}

fn current_bot_policy_stamp(data_home: &Path, workspace_id: &str) -> String {
    PolicyStore::new(data_home)
        .read_existing(workspace_id)
        .map(|pol| {
            format!(
                "bot:{}:{}:{}",
                pol.workspace_id, pol.conversation_id, pol.revision
            )
        })
        .unwrap_or_else(|_| "1".to_owned())
}

impl PermissionInput for BotApprovalPermissionInput {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async move {
            let approval_obj = &prompt["approval"];
            let approval_id = approval_obj["approvalId"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| format!("approval-{}", uuid::Uuid::new_v4()));
            let store = ApprovalStore::new(&self.data_home);
            let mirrored = approval_obj["workspaceId"].is_null();
            let initial_policy_stamp =
                current_bot_policy_stamp(&self.data_home, &self.workspace_id);
            let (tx, rx) = oneshot::channel();
            if let Ok(mut guard) = self.live_approvals.lock() {
                guard.insert(
                    approval_id.clone(),
                    LiveApprovalWaiter {
                        workspace_id: self.workspace_id.clone(),
                        mirrored_in_workspace: mirrored,
                        tx,
                    },
                );
            }
            let mirrored_row = if mirrored {
                let cap_id = approval_obj["capabilityId"]
                    .as_str()
                    .or_else(|| prompt["capabilityId"].as_str())
                    .or_else(|| prompt["tool"].as_str())
                    .unwrap_or("tool");
                let conv_id = approval_obj["conversationId"]
                    .as_str()
                    .unwrap_or(&self.session_id);
                let stream_id = approval_obj["streamId"]
                    .as_str()
                    .unwrap_or(&self.session_id);
                let digest = approval_obj["argsDigest"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| {
                        approval_args_digest(&prompt["arguments"])
                            .unwrap_or_else(|_| sha256_json(&prompt["arguments"]))
                    });
                let created_at = approval_obj["createdAt"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(now_iso);
                let deadline_at = approval_obj["deadlineAt"]
                    .as_str()
                    .map(str::to_owned)
                    .unwrap_or_else(|| now_iso_offset_ms(300_000));
                store
                    .open(
                        &HostApproval {
                            approval_id: &approval_id,
                            workspace_id: Some(&self.workspace_id),
                            conversation_id: conv_id,
                            stream_id,
                            plan_id: (!self.plan_id.is_empty()).then_some(&self.plan_id),
                            session_id: Some(&self.session_id),
                            capability_id: cap_id,
                            args_digest: &digest,
                            policy_revision: &initial_policy_stamp,
                            created_at: &created_at,
                            deadline_at: Some(&deadline_at),
                        },
                        None,
                    )
                    .ok()
            } else {
                None
            };

            let _ = self
                .peer
                .notify(
                    "project.bot.changed",
                    json!({ "workspaceIds": [self.workspace_id] }),
                )
                .await;

            let sleep_timer = tokio::time::sleep(DEFAULT_PERMISSION_WAIT);
            tokio::pin!(sleep_timer);
            let mut decision = tokio::select! {
                biased;
                _ = cancel.cancelled() => LocalPermissionDecision::Cancel,
                _ = self.shutdown.cancelled() => LocalPermissionDecision::Cancel,
                _ = &mut sleep_timer => LocalPermissionDecision::Timeout,
                res = rx => res.unwrap_or(LocalPermissionDecision::Cancel),
            };

            if let Ok(mut guard) = self.live_approvals.lock() {
                guard.remove(&approval_id);
            }

            if let Some(ref row) = mirrored_row {
                let current_stamp = current_bot_policy_stamp(&self.data_home, &self.workspace_id);
                let drifted = matches!(
                    decision,
                    LocalPermissionDecision::Approve | LocalPermissionDecision::ApproveSession
                ) && current_stamp != initial_policy_stamp;
                if drifted {
                    decision = LocalPermissionDecision::Deny;
                }
                let already_decided = store
                    .list(Some(&self.workspace_id), None)
                    .ok()
                    .and_then(|rows| rows.into_iter().find(|r| r["approvalId"] == approval_id))
                    .is_some_and(|r| r["state"] != "open");
                if !already_decided {
                    let (state, decider, reason) = if drifted {
                        (
                            ApprovalState::Expired,
                            ApprovalDecision::Policy,
                            Some("permission_policy_changed"),
                        )
                    } else {
                        match decision {
                            LocalPermissionDecision::Approve
                            | LocalPermissionDecision::ApproveSession => {
                                (ApprovalState::Approved, ApprovalDecision::LocalUser, None)
                            }
                            LocalPermissionDecision::Deny => (
                                ApprovalState::Denied,
                                ApprovalDecision::LocalUser,
                                Some("local_user_denied"),
                            ),
                            LocalPermissionDecision::Timeout => (
                                ApprovalState::Expired,
                                ApprovalDecision::Policy,
                                Some("permission_timeout"),
                            ),
                            LocalPermissionDecision::Unavailable => (
                                ApprovalState::Expired,
                                ApprovalDecision::Policy,
                                Some("permission_unavailable"),
                            ),
                            LocalPermissionDecision::Cancel => (
                                ApprovalState::Cancelled,
                                ApprovalDecision::Policy,
                                Some("permission_cancelled"),
                            ),
                        }
                    };
                    let _ = store.decide(row, state, decider, &now_iso(), reason, None);
                }
            }
            decision
        })
    }
}
