//! Classic Goal Runner RPC handlers (`classic.goal.*`) and reverse host
//! adapters (`host.goal.prepareWorkspace`, `host.goal.runVisualVerification`).

use crate::{
    classic::{
        self, ResolvedTurnModel, RpcConversationOutput, RpcPermissionInput, StreamIdRef,
        format_usage_amounts,
    },
    external_provider::ExternalRpcProvider,
    protocol::{CODE_METHOD_NOT_FOUND, ExternalCapabilityManifest, RpcError},
    server::ServerContext,
};
use peer_runtime::{
    CancellationToken,
    capability::{CapabilityError, now},
    conversation_host::{
        GoalHostHooks, GoalPlanRunOptions, GoalRunnerEvent, VisualVerificationOutcome,
    },
    providers::CapabilityProvider,
};
use peer_store::{ConversationStore, GoalError, GoalStore};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tokio::sync::{oneshot, watch};

const PREPARE_WORKSPACE_TIMEOUT: Duration = Duration::from_secs(30);
const VISUAL_VERIFY_TIMEOUT: Duration = Duration::from_secs(180);
const STOP_WAIT_TIMEOUT: Duration = Duration::from_secs(3);

#[derive(Clone)]
struct ActiveGoalRun {
    cancel: CancellationToken,
    pause_requested: Arc<AtomicBool>,
    finished_rx: watch::Receiver<bool>,
    active_tick_stream: Arc<Mutex<String>>,
}

#[derive(Clone, Default)]
pub struct ClassicGoalRegistry {
    inner: Arc<Mutex<GoalRegistryInner>>,
}

#[derive(Default)]
struct GoalRegistryInner {
    active: HashMap<String, ActiveGoalRun>,
    tick_streams: HashMap<String, String>,
}

impl ClassicGoalRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    #[allow(clippy::type_complexity)]
    fn try_register(
        &self,
        plan_id: &str,
        cancel: CancellationToken,
    ) -> Result<
        (
            Arc<AtomicBool>,
            Arc<Mutex<String>>,
            watch::Sender<bool>,
            watch::Receiver<bool>,
        ),
        watch::Receiver<bool>,
    > {
        let mut inner = self.inner.lock().expect("goal registry poisoned");
        if let Some(existing) = inner.active.get(plan_id) {
            return Err(existing.finished_rx.clone());
        }
        let pause_requested = Arc::new(AtomicBool::new(false));
        let active_tick_stream = Arc::new(Mutex::new(String::new()));
        let (finished_tx, finished_rx) = watch::channel(false);
        inner.active.insert(
            plan_id.to_owned(),
            ActiveGoalRun {
                cancel,
                pause_requested: Arc::clone(&pause_requested),
                finished_rx: finished_rx.clone(),
                active_tick_stream: Arc::clone(&active_tick_stream),
            },
        );
        Ok((
            pause_requested,
            active_tick_stream,
            finished_tx,
            finished_rx,
        ))
    }

    pub fn get_finished_receiver(&self, plan_id: &str) -> Option<watch::Receiver<bool>> {
        self.inner
            .lock()
            .ok()
            .and_then(|inner| inner.active.get(plan_id).map(|g| g.finished_rx.clone()))
    }

    fn bind_tick_stream(&self, plan_id: &str, tick_stream_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner
                .tick_streams
                .insert(tick_stream_id.to_owned(), plan_id.to_owned());
            if let Some(entry) = inner.active.get(plan_id)
                && let Ok(mut current) = entry.active_tick_stream.lock()
            {
                *current = tick_stream_id.to_owned();
            }
        }
    }

    fn unbind_tick_stream(&self, plan_id: &str, tick_stream_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.tick_streams.remove(tick_stream_id);
            if let Some(entry) = inner.active.get(plan_id)
                && let Ok(mut current) = entry.active_tick_stream.lock()
                && *current == tick_stream_id
            {
                current.clear();
            }
        }
    }

    pub fn mark_pause_for_tick_stream(&self, stream_id: &str) -> bool {
        let Ok(inner) = self.inner.lock() else {
            return false;
        };
        let Some(plan_id) = inner.tick_streams.get(stream_id) else {
            return false;
        };
        let Some(entry) = inner.active.get(plan_id) else {
            return false;
        };
        entry.pause_requested.store(true, Ordering::SeqCst);
        true
    }

    pub fn request_pause(&self, plan_id: &str) -> Option<watch::Receiver<bool>> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.active.get(plan_id)?;
        entry.pause_requested.store(true, Ordering::SeqCst);
        entry.cancel.cancel();
        Some(entry.finished_rx.clone())
    }

    pub fn request_clear(&self, plan_id: &str) -> Option<watch::Receiver<bool>> {
        let inner = self.inner.lock().ok()?;
        let entry = inner.active.get(plan_id)?;
        entry.pause_requested.store(false, Ordering::SeqCst);
        entry.cancel.cancel();
        Some(entry.finished_rx.clone())
    }

    fn remove(&self, plan_id: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.active.remove(plan_id);
            inner.tick_streams.retain(|_, owner| owner != plan_id);
        }
    }

    pub fn cancel_all(&self) {
        if let Ok(inner) = self.inner.lock() {
            for entry in inner.active.values() {
                entry.cancel.cancel();
            }
        }
    }
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClassicGoalRunOptionsParam {
    #[serde(default)]
    pub max_turns: Option<usize>,
    #[serde(default)]
    pub await_idle: bool,
    #[serde(default)]
    pub allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub model_provider_id: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub fast_mode: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicGoalPlanActionParams {
    pub plan_id: String,
    #[serde(default)]
    pub options: ClassicGoalRunOptionsParam,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicGoalStopParams {
    pub plan_id: String,
    #[serde(default)]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicGoalGetStateParams {
    pub plan_id: String,
}

pub fn format_goal_runner_state(plan: &Value) -> Value {
    json!({
        "planId": plan["planId"],
        "planStatus": plan["status"],
        "runner": plan.get("runner").cloned().unwrap_or(Value::Null),
        "progress": plan.get("progress").cloned().unwrap_or(Value::Null),
    })
}

fn map_goal_error(err: GoalError) -> RpcError {
    RpcError::invalid_params(format!("Goal operation failed: {}", err.code()))
}

fn resolve_plan_workspace(plan: &Value, store: &ConversationStore) -> Option<PathBuf> {
    if plan["deliveryBinding"]["executionIsolation"] == "worktree"
        && let Some(wt) = plan["deliveryBinding"]["worktreePath"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
    {
        return Some(PathBuf::from(wt));
    }
    for candidate in [
        plan["targetWorkspacePath"].as_str(),
        plan["deliveryBinding"]["targetWorkspacePath"].as_str(),
        plan["originWorkspacePath"].as_str(),
    ] {
        if let Some(ws) = candidate.map(str::trim).filter(|s| !s.is_empty()) {
            return Some(PathBuf::from(ws));
        }
    }
    let conversation_id = plan["conversationId"].as_str().filter(|s| !s.is_empty())?;
    store
        .read_metadata(conversation_id)
        .ok()
        .and_then(|m| m.metadata)
        .and_then(|meta| {
            meta["workspacePath"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(PathBuf::from)
        })
}

fn has_waiting_user_leaf(plan: &Value) -> bool {
    let mut stack: Vec<&Value> = plan["tasks"].as_array().into_iter().flatten().collect();
    while let Some(task) = stack.pop() {
        if let Some(children) = task["subtasks"].as_array().filter(|rows| !rows.is_empty()) {
            stack.extend(children);
        } else if task["status"] == "waiting_user" {
            return true;
        }
    }
    false
}

struct SignalOnce(Option<oneshot::Sender<()>>);

impl SignalOnce {
    fn fire(&mut self) {
        if let Some(tx) = self.0.take() {
            let _ = tx.send(());
        }
    }
}

impl Drop for SignalOnce {
    fn drop(&mut self) {
        self.fire();
    }
}

struct ActiveGoalGuard {
    goals: ClassicGoalRegistry,
    plan_id: String,
    finished_tx: watch::Sender<bool>,
}

impl Drop for ActiveGoalGuard {
    fn drop(&mut self) {
        self.goals.remove(&self.plan_id);
        let _ = self.finished_tx.send(true);
    }
}

struct RpcGoalHostHooks {
    ctx: Arc<ServerContext>,
    goal_cancel: CancellationToken,
    is_resume: bool,
    started_signal: SignalOnce,
}

impl GoalHostHooks for RpcGoalHostHooks {
    fn on_goal_event<'a>(
        &'a mut self,
        event: GoalRunnerEvent<'a>,
    ) -> Pin<Box<dyn Future<Output = ()> + 'a>> {
        Box::pin(async move {
            match event {
                GoalRunnerEvent::Started {
                    plan_id,
                    conversation_id,
                } => {
                    self.started_signal.fire();
                    let event_type = if self.is_resume {
                        "goalRunner:resumed"
                    } else {
                        "goalRunner:started"
                    };
                    let _ = self
                        .ctx
                        .peer
                        .notify(
                            "goalRunner:changed",
                            json!({
                                "type": event_type,
                                "planId": plan_id,
                                "conversationId": conversation_id,
                                "changeKind": "runner-state",
                            }),
                        )
                        .await;
                }
                GoalRunnerEvent::TickStarted {
                    plan_id,
                    conversation_id,
                    stream_id,
                    turn_number,
                    assistant_message_id,
                    started_at_ms,
                } => {
                    let _ = self.ctx.streams.register_stream(
                        stream_id,
                        conversation_id,
                        assistant_message_id,
                        self.goal_cancel.clone(),
                    );
                    self.ctx.goals.bind_tick_stream(plan_id, stream_id);
                    let _ = self
                        .ctx
                        .peer
                        .notify(
                            "goalRunner:changed",
                            json!({
                                "type": "goalRunner:streamStarted",
                                "planId": plan_id,
                                "conversationId": conversation_id,
                                "changeKind": "runner-state",
                                "streamId": stream_id,
                                "turnNumber": turn_number,
                                "assistantMessageId": assistant_message_id,
                                "startedAt": started_at_ms,
                            }),
                        )
                        .await;
                    let _ = self
                        .ctx
                        .peer
                        .notify("chat:stream:active-changed", self.ctx.streams.list_active())
                        .await;
                }
                GoalRunnerEvent::TickFinished {
                    plan_id,
                    conversation_id,
                    stream_id,
                    error,
                    cancelled,
                    usage,
                } => {
                    let usage_json = format_usage_amounts(&usage.turn_total.amounts);
                    let terminal_status = if cancelled {
                        "aborted"
                    } else if error.is_some() {
                        "error"
                    } else {
                        "done"
                    };
                    self.ctx.streams.finish_stream(
                        stream_id,
                        terminal_status,
                        cancelled || error.is_some(),
                        Some(usage_json.clone()),
                        None,
                    );
                    self.ctx.goals.unbind_tick_stream(plan_id, stream_id);
                    if cancelled {
                        let _ = self
                            .ctx
                            .peer
                            .notify(
                                "chat:stream:aborted",
                                json!({
                                    "streamId": stream_id,
                                    "conversationId": conversation_id,
                                }),
                            )
                            .await;
                    } else if let Some(err_code) = error {
                        let _ = self
                            .ctx
                            .peer
                            .notify(
                                "chat:stream:error",
                                json!({
                                    "streamId": stream_id,
                                    "conversationId": conversation_id,
                                    "error": err_code,
                                    "streamFailure": { "code": err_code },
                                    "usage": usage_json,
                                }),
                            )
                            .await;
                    } else {
                        let _ = self
                            .ctx
                            .peer
                            .notify(
                                "chat:stream:done",
                                json!({
                                    "streamId": stream_id,
                                    "conversationId": conversation_id,
                                    "usage": usage_json,
                                }),
                            )
                            .await;
                    }
                    let _ = self
                        .ctx
                        .peer
                        .notify("chat:stream:active-changed", self.ctx.streams.list_active())
                        .await;
                }
                GoalRunnerEvent::PlanChanged {
                    plan_id,
                    conversation_id,
                    change_kind,
                } => {
                    let _ = self
                        .ctx
                        .peer
                        .notify(
                            "goalPlans:changed",
                            json!({
                                "reason": "persist",
                                "planId": plan_id,
                                "conversationId": conversation_id,
                                "changeKind": change_kind,
                            }),
                        )
                        .await;
                }
                GoalRunnerEvent::StateChanged {
                    plan_id,
                    conversation_id,
                    event_type,
                    detail,
                } => {
                    let mut payload = match detail {
                        Value::Object(map) => map,
                        other => {
                            let mut map = serde_json::Map::new();
                            if !other.is_null() {
                                map.insert("detail".into(), other);
                            }
                            map
                        }
                    };
                    payload.insert("type".into(), json!(event_type));
                    payload.insert("planId".into(), json!(plan_id));
                    payload.insert("conversationId".into(), json!(conversation_id));
                    payload.insert("changeKind".into(), json!("runner-state"));
                    let _ = self
                        .ctx
                        .peer
                        .notify("goalRunner:changed", Value::Object(payload))
                        .await;
                }
            }
        })
    }

    fn run_visual_verification<'a>(
        &'a mut self,
        plan_id: &'a str,
        conversation_id: &'a str,
        verifier_run_id: &'a str,
        workspace: &'a Path,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = Result<VisualVerificationOutcome, CapabilityError>> + 'a>>
    {
        Box::pin(async move {
            let workspace_str = workspace
                .to_str()
                .ok_or(CapabilityError("invalid_workspace"))?;
            let response = self
                .ctx
                .peer
                .call_host_with_timeout(
                    "host.goal.runVisualVerification",
                    json!({
                        "planId": plan_id,
                        "conversationId": conversation_id,
                        "verifierRunId": verifier_run_id,
                        "workspacePath": workspace_str,
                    }),
                    VISUAL_VERIFY_TIMEOUT,
                    cancel,
                )
                .await;

            match response {
                Ok(val) => {
                    let required = val["required"].as_bool().unwrap_or(false);
                    let passed = if !required {
                        true
                    } else {
                        val["passed"] == true || val["report"]["passed"] == true
                    };
                    let report = val.get("report").cloned().unwrap_or(Value::Null);
                    Ok(VisualVerificationOutcome {
                        required,
                        passed,
                        report,
                    })
                }
                Err(err) if err.code == CODE_METHOD_NOT_FOUND => Ok(VisualVerificationOutcome {
                    required: false,
                    passed: true,
                    report: Value::Null,
                }),
                Err(_) if cancel.is_cancelled() || self.goal_cancel.is_cancelled() => {
                    Err(CapabilityError("CANCELLED"))
                }
                Err(err) => Ok(VisualVerificationOutcome {
                    required: true,
                    passed: false,
                    report: json!({
                        "passed": false,
                        "summary": err.message,
                        "evidenceRefs": [],
                    }),
                }),
            }
        })
    }
}

pub async fn handle_start(ctx: &Arc<ServerContext>, params_val: Value) -> Result<Value, RpcError> {
    start_or_resume(ctx, params_val, false).await
}

pub async fn handle_resume(ctx: &Arc<ServerContext>, params_val: Value) -> Result<Value, RpcError> {
    start_or_resume(ctx, params_val, true).await
}

async fn start_or_resume(
    ctx: &Arc<ServerContext>,
    params_val: Value,
    is_resume: bool,
) -> Result<Value, RpcError> {
    let params: ClassicGoalPlanActionParams =
        serde_json::from_value(params_val).map_err(|err| {
            RpcError::invalid_params(format!("Invalid classic.goal action params: {err}"))
        })?;
    let plan_id = params.plan_id.trim().to_owned();
    if plan_id.is_empty() || plan_id.len() > 256 {
        return Err(RpcError::invalid_params(
            "planId must be 1..=256 characters",
        ));
    }

    let goal_store = GoalStore::new(&ctx.config.data_home);
    let Some(initial_plan) = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?
    else {
        return Ok(Value::Null);
    };

    if !initial_plan["delegationOrigin"].is_null() || !initial_plan["parentPlanId"].is_null() {
        return Err(RpcError::invalid_params("delegated_goal_out_of_scope"));
    }

    if let Some(mut finished_rx) = ctx.goals.get_finished_receiver(&plan_id) {
        if params.options.await_idle {
            let _ = finished_rx.wait_for(|done| *done).await;
        }
        let fresh = goal_store
            .read_plan_snapshot(&plan_id)
            .map_err(map_goal_error)?;
        return Ok(fresh
            .map(|p| format_goal_runner_state(&p))
            .unwrap_or(Value::Null));
    }

    if !is_resume
        && (matches!(
            initial_plan["status"].as_str(),
            Some("paused" | "cancelled")
        ) || initial_plan["runner"]["status"] == "waiting_user"
            || has_waiting_user_leaf(&initial_plan))
    {
        return Ok(format_goal_runner_state(&initial_plan));
    }

    let conversation_id = initial_plan["conversationId"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .ok_or_else(|| RpcError::invalid_params("plan conversationId is missing"))?
        .to_owned();

    let prep_cancel = ctx.peer.shutdown_child_token();
    let prep_result = match ctx
        .peer
        .call_host_with_timeout(
            "host.goal.prepareWorkspace",
            json!({
                "planId": plan_id,
                "conversationId": conversation_id,
            }),
            PREPARE_WORKSPACE_TIMEOUT,
            &prep_cancel,
        )
        .await
    {
        Ok(val) => Some(val),
        Err(err) if err.code == CODE_METHOD_NOT_FOUND => None,
        Err(err) => {
            return Err(RpcError::host_call_failed(
                format!("host.goal.prepareWorkspace failed: {}", err.message),
                Some(err.to_error_object()),
            ));
        }
    };

    let Some(plan) = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?
    else {
        return Ok(Value::Null);
    };
    if !plan["delegationOrigin"].is_null() || !plan["parentPlanId"].is_null() {
        return Err(RpcError::invalid_params("delegated_goal_out_of_scope"));
    }

    let conv_store = ConversationStore::new(&ctx.config.data_home);
    let workspace = prep_result
        .as_ref()
        .and_then(|v| v["workspacePath"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .or_else(|| resolve_plan_workspace(&plan, &conv_store))
        .ok_or_else(|| RpcError::invalid_params("workspacePath unavailable for goal runner"))?;

    let meta = conv_store
        .read_metadata(&conversation_id)
        .ok()
        .and_then(|m| m.metadata);
    let model_provider_id = params.options.model_provider_id.clone().or_else(|| {
        meta.as_ref()
            .and_then(|m| m["modelProviderId"].as_str().map(str::to_owned))
    });
    let effort = params.options.effort.clone().or_else(|| {
        meta.as_ref()
            .and_then(|m| m["effort"].as_str().map(str::to_owned))
    });
    let fast_mode = params.options.fast_mode
        || meta
            .as_ref()
            .is_some_and(|m| m.get("fastMode") == Some(&Value::Bool(true)));

    let goal_cancel = ctx.peer.shutdown_child_token();
    let resolved_model = match &ctx.config.model_loader {
        Some(loader) => {
            loader(
                ctx.config.data_home.clone(),
                model_provider_id,
                effort,
                fast_mode,
                goal_cancel.clone(),
            )
            .await?
        }
        None => {
            classic::resolve_default_model(
                ctx.config.data_home.clone(),
                model_provider_id,
                effort,
                fast_mode,
                goal_cancel.clone(),
            )
            .await?
        }
    };

    let external_capabilities = ctx.snapshot_external_capabilities()?;
    let (pause_requested, active_tick_stream, finished_tx, mut finished_rx) =
        match ctx.goals.try_register(&plan_id, goal_cancel.clone()) {
            Ok(tuple) => tuple,
            Err(mut existing_rx) => {
                if params.options.await_idle {
                    let _ = existing_rx.wait_for(|done| *done).await;
                }
                let fresh = goal_store
                    .read_plan_snapshot(&plan_id)
                    .map_err(map_goal_error)?;
                return Ok(fresh
                    .map(|p| format_goal_runner_state(&p))
                    .unwrap_or(Value::Null));
            }
        };

    let (started_tx, started_rx) = oneshot::channel();
    let ctx_bg = Arc::clone(ctx);
    let plan_id_bg = plan_id.clone();
    let conversation_id_bg = conversation_id.clone();
    let allowlist_bg = params.options.allowlist.clone();
    let max_turns_bg = params.options.max_turns;
    let await_idle = params.options.await_idle;

    ctx.spawn_local_background(move |guard| {
        tokio::task::spawn_local(async move {
            let _bg_guard = guard;
            let _goal_guard = ActiveGoalGuard {
                goals: ctx_bg.goals.clone(),
                plan_id: plan_id_bg.clone(),
                finished_tx,
            };
            run_goal_driver(
                ctx_bg,
                GoalDriverInput {
                    plan_id: plan_id_bg,
                    conversation_id: conversation_id_bg,
                    workspace,
                    resolved_model,
                    external_capabilities,
                    goal_cancel,
                    pause_requested,
                    active_tick_stream,
                    started_tx,
                    allow_resume: true,
                    is_resume,
                    allowlist: allowlist_bg,
                    max_turns: max_turns_bg,
                },
            )
            .await;
        });
    })?;

    if await_idle {
        let _ = finished_rx.wait_for(|done| *done).await;
    } else {
        let _ = started_rx.await;
    }

    let fresh = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?;
    Ok(fresh
        .map(|p| format_goal_runner_state(&p))
        .unwrap_or(Value::Null))
}

struct GoalDriverInput {
    plan_id: String,
    conversation_id: String,
    workspace: PathBuf,
    resolved_model: ResolvedTurnModel,
    external_capabilities: Vec<ExternalCapabilityManifest>,
    goal_cancel: CancellationToken,
    pause_requested: Arc<AtomicBool>,
    active_tick_stream: Arc<Mutex<String>>,
    started_tx: oneshot::Sender<()>,
    allow_resume: bool,
    is_resume: bool,
    allowlist: Option<Vec<String>>,
    max_turns: Option<usize>,
}

async fn run_goal_driver(ctx: Arc<ServerContext>, input: GoalDriverInput) {
    let GoalDriverInput {
        plan_id,
        conversation_id,
        workspace,
        resolved_model,
        external_capabilities,
        goal_cancel,
        pause_requested,
        active_tick_stream,
        started_tx,
        allow_resume,
        is_resume,
        allowlist,
        max_turns,
    } = input;

    let stream_id = format!("goal-runner-{}", uuid::Uuid::new_v4());
    let mut extra_providers: Vec<Box<dyn CapabilityProvider>> = Vec::new();
    if !external_capabilities.is_empty() {
        extra_providers.push(Box::new(ExternalRpcProvider::new(
            external_capabilities,
            ctx.peer.clone(),
            workspace.clone(),
        )));
    }

    let tick_ref = StreamIdRef::Shared(active_tick_stream);
    let mut permission = RpcPermissionInput {
        stream_id: tick_ref.clone(),
        peer: ctx.peer.clone(),
        streams: ctx.streams.clone(),
    };
    let mut output = RpcConversationOutput {
        stream_id: tick_ref,
        conversation_id: conversation_id.clone(),
        peer: ctx.peer.clone(),
        streams: ctx.streams.clone(),
    };
    let mut hooks = RpcGoalHostHooks {
        ctx: Arc::clone(&ctx),
        goal_cancel: goal_cancel.clone(),
        is_resume,
        started_signal: SignalOnce(Some(started_tx)),
    };

    let outcome = ctx
        .runtime
        .drive_goal_plan(
            GoalPlanRunOptions {
                plan_id: &plan_id,
                workspace: &workspace,
                stream_id: &stream_id,
                provider_id: &resolved_model.provider_id,
                effort: &resolved_model.effort,
                allow_resume,
                pause_requested: Some(pause_requested),
                allowlist: allowlist.as_deref(),
                max_turns,
                extra_providers,
            },
            &resolved_model.model,
            &mut permission,
            Some(&mut output),
            Some(&mut hooks),
            &goal_cancel,
        )
        .await;

    hooks.started_signal.fire();

    if let Err(err) = outcome {
        let _ = ctx
            .peer
            .notify(
                "goalRunner:changed",
                json!({
                    "type": "goalRunner:failed",
                    "planId": plan_id,
                    "conversationId": conversation_id,
                    "changeKind": "runner-state",
                    "error": err.0,
                }),
            )
            .await;
    }
}

pub async fn handle_pause(ctx: &Arc<ServerContext>, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicGoalStopParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.goal.pause params: {err}"))
    })?;
    let plan_id = params.plan_id.trim().to_owned();
    let reason = params
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("paused");

    let goal_store = GoalStore::new(&ctx.config.data_home);
    let Some(existing) = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?
    else {
        return Ok(Value::Null);
    };
    if !existing["delegationOrigin"].is_null() || !existing["parentPlanId"].is_null() {
        return Err(RpcError::invalid_params("delegated_goal_out_of_scope"));
    }

    if let Some(mut finished_rx) = ctx.goals.request_pause(&plan_id) {
        let _ = tokio::time::timeout(STOP_WAIT_TIMEOUT, finished_rx.wait_for(|done| *done)).await;
    }

    let current = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?;
    let already_paused = current
        .as_ref()
        .is_some_and(|p| p["status"] == "paused" && p["runner"]["status"] == "paused");
    if !already_paused
        && let Some(updated) = goal_store
            .pause_ordinary_runner(&plan_id, reason, &now())
            .map_err(map_goal_error)?
    {
        let conv_id = updated["conversationId"].as_str().unwrap_or("");
        let _ = ctx
            .peer
            .notify(
                "goalPlans:changed",
                json!({
                    "reason": "persist",
                    "planId": plan_id,
                    "conversationId": conv_id,
                    "changeKind": "runner-state",
                }),
            )
            .await;
        let _ = ctx
            .peer
            .notify(
                "goalRunner:changed",
                json!({
                    "type": "goalRunner:paused",
                    "planId": plan_id,
                    "conversationId": conv_id,
                    "changeKind": "runner-state",
                    "reason": reason,
                }),
            )
            .await;
    }

    let fresh = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?;
    Ok(fresh
        .map(|p| format_goal_runner_state(&p))
        .unwrap_or(Value::Null))
}

pub async fn handle_clear(ctx: &Arc<ServerContext>, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicGoalStopParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.goal.clear params: {err}"))
    })?;
    let plan_id = params.plan_id.trim().to_owned();
    let reason = params
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("cleared");

    let goal_store = GoalStore::new(&ctx.config.data_home);
    let Some(existing) = goal_store
        .read_plan_snapshot(&plan_id)
        .map_err(map_goal_error)?
    else {
        return Ok(Value::Null);
    };
    if !existing["delegationOrigin"].is_null() || !existing["parentPlanId"].is_null() {
        return Err(RpcError::invalid_params("delegated_goal_out_of_scope"));
    }

    if let Some(mut finished_rx) = ctx.goals.request_clear(&plan_id) {
        let _ = tokio::time::timeout(STOP_WAIT_TIMEOUT, finished_rx.wait_for(|done| *done)).await;
    }

    let Some(updated) = goal_store
        .clear_ordinary_runner(&plan_id, reason, &now())
        .map_err(map_goal_error)?
    else {
        return Ok(Value::Null);
    };
    let conv_id = updated["conversationId"].as_str().unwrap_or("");
    let _ = ctx
        .peer
        .notify(
            "goalPlans:changed",
            json!({
                "reason": "persist",
                "planId": plan_id,
                "conversationId": conv_id,
                "changeKind": "runner-state",
            }),
        )
        .await;
    let _ = ctx
        .peer
        .notify(
            "goalRunner:changed",
            json!({
                "type": "goalRunner:cleared",
                "planId": plan_id,
                "conversationId": conv_id,
                "changeKind": "runner-state",
                "reason": reason,
            }),
        )
        .await;
    Ok(format_goal_runner_state(&updated))
}

pub fn handle_get_state(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicGoalGetStateParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.goal.getState params: {err}"))
    })?;
    let goal_store = GoalStore::new(&ctx.config.data_home);
    let plan = goal_store
        .read_plan_snapshot(params.plan_id.trim())
        .map_err(map_goal_error)?;
    Ok(plan
        .map(|p| format_goal_runner_state(&p))
        .unwrap_or(Value::Null))
}
