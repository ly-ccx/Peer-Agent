//! Classic Chat + Plan RPC handlers (`classic.*`) delegating execution,
//! tool projection, permission gates, compaction and usage accounting to
//! `peer_runtime::conversation_host::NativeConversationRuntime`.

use crate::{
    RpcPeer,
    classic_streams::{ClassicStreamRegistry, now_epoch_ms},
    external_provider::ExternalRpcProvider,
    protocol::{ExternalCapabilityManifest, RpcError},
    server::ServerContext,
};
use peer_protocol::{LocalAccessLevel, UsageAmounts};
use peer_runtime::{
    CancellationToken,
    conversation_host::{
        CompactOptions, ConversationEvent, ConversationOutcome, ConversationOutput,
        PreparedConversationOptions,
    },
    model::NativeModel,
    model_catalog::resolve_desktop_model,
    model_config::load_model,
    providers::{CapabilityProvider, RuntimeMode},
    session_host::{LocalPermissionDecision, PermissionInput},
    usage_accounting::UsageSnapshot,
};
use peer_store::ConversationStore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    future::Future,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::sync::oneshot;

const MAX_STREAM_TOOL_RESULT_CHARS: usize = 32_768;

#[derive(Clone)]
pub(crate) enum StreamIdRef {
    Fixed(String),
    Shared(Arc<Mutex<String>>),
}

impl StreamIdRef {
    pub(crate) fn current(&self) -> String {
        match self {
            Self::Fixed(id) => id.clone(),
            Self::Shared(cell) => cell.lock().map(|guard| guard.clone()).unwrap_or_default(),
        }
    }
}

pub struct ResolvedTurnModel {
    pub provider_id: String,
    pub effort: String,
    pub model: NativeModel,
}

pub type ModelLoader = Arc<
    dyn Fn(
            PathBuf,
            Option<String>,
            Option<String>,
            bool,
            CancellationToken,
        ) -> Pin<Box<dyn Future<Output = Result<ResolvedTurnModel, RpcError>> + Send>>
        + Send
        + Sync,
>;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeReminderParam {
    pub id: String,
    pub content: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicChatSendParams {
    pub conversation_id: String,
    pub stream_id: String,
    pub assistant_message_id: String,
    pub workspace_path: String,
    #[serde(default = "default_mode")]
    pub mode: String,
    #[serde(default)]
    pub model_provider_id: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
    #[serde(default)]
    pub fast_mode: bool,
    #[serde(default)]
    pub persist_model_selection: bool,
    #[serde(default)]
    pub resume_interrupted_reply: bool,
    #[serde(default)]
    pub runtime_reminders: Vec<RuntimeReminderParam>,
    #[serde(default)]
    pub allowlist: Option<Vec<String>>,
    #[serde(default)]
    pub max_turns: Option<usize>,
}

fn default_mode() -> String {
    "chat".to_owned()
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicChatSendResult {
    pub accepted: bool,
    pub stream_id: String,
    pub conversation_id: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicChatAbortParams {
    pub stream_id: String,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ClassicChatReattachParams {
    #[serde(default)]
    pub stream_id: Option<String>,
    #[serde(default)]
    pub conversation_id: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicChatCompactParams {
    pub conversation_id: String,
    #[serde(default)]
    pub stream_id: Option<String>,
    #[serde(default)]
    pub workspace_path: Option<String>,
    #[serde(default)]
    pub model_provider_id: Option<String>,
    #[serde(default)]
    pub effort: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicPermissionDecideParams {
    pub tool_call_id: String,
    pub decision: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClassicAccessSetParams {
    pub access_level: String,
}

pub async fn resolve_default_model(
    data_home: PathBuf,
    model_provider_id: Option<String>,
    effort: Option<String>,
    fast_mode: bool,
    cancel: CancellationToken,
) -> Result<ResolvedTurnModel, RpcError> {
    let resolved = resolve_desktop_model(
        &data_home,
        model_provider_id.as_deref(),
        effort.as_deref(),
        fast_mode,
    )
    .map_err(|err| RpcError::invalid_params(format!("{}: {}", err.code, err.detail)))?;

    let provider_id = resolved.entry.provider_id.clone();
    let resolved_effort = resolved.selection["reasoningEffort"]
        .as_str()
        .unwrap_or("default")
        .to_owned();
    let model = load_model(&data_home, &resolved.selection, &cancel)
        .await
        .map_err(|err| RpcError::internal_error(format!("model_load_failed: {}", err.code)))?;
    Ok(ResolvedTurnModel {
        provider_id,
        effort: resolved_effort,
        model,
    })
}

fn validate_non_empty(value: &str, label: &str) -> Result<(), RpcError> {
    if value.trim().is_empty() || value.len() > 256 {
        return Err(RpcError::invalid_params(format!(
            "{label} must be 1..=256 characters"
        )));
    }
    Ok(())
}

pub async fn handle_send(ctx: &Arc<ServerContext>, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicChatSendParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.chat.send params: {err}"))
    })?;
    validate_non_empty(&params.conversation_id, "conversationId")?;
    validate_non_empty(&params.stream_id, "streamId")?;
    validate_non_empty(&params.assistant_message_id, "assistantMessageId")?;
    if params.workspace_path.trim().is_empty() {
        return Err(RpcError::invalid_params("workspacePath must not be empty"));
    }

    let mode: RuntimeMode = params
        .mode
        .parse()
        .map_err(|_| RpcError::invalid_params(format!("Unsupported mode: {}", params.mode)))?;
    if !matches!(
        mode,
        RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
    ) {
        return Err(RpcError::invalid_params(format!(
            "classic.chat.send only supports 'chat', 'plan', or 'goal' mode (got {})",
            params.mode
        )));
    }

    let external_capabilities = ctx.snapshot_external_capabilities()?;
    let stream_cancel = ctx.peer.shutdown_child_token();
    ctx.streams
        .register_stream(
            &params.stream_id,
            &params.conversation_id,
            &params.assistant_message_id,
            stream_cancel.clone(),
        )
        .map_err(|code| RpcError::invalid_params(format!("Cannot start stream: {code}")))?;

    let _ = ctx
        .peer
        .notify("chat:stream:active-changed", ctx.streams.list_active())
        .await;

    let ctx_bg = Arc::clone(ctx);
    let stream_id = params.stream_id.clone();
    let conversation_id = params.conversation_id.clone();
    ctx.spawn_local_background(move |guard| {
        tokio::task::spawn_local(async move {
            let _guard = guard;
            run_classic_turn(ctx_bg, params, mode, external_capabilities, stream_cancel).await;
        });
    })
    .inspect_err(|_| {
        ctx.streams
            .finish_stream(&stream_id, "error", true, None, None);
    })?;

    serde_json::to_value(ClassicChatSendResult {
        accepted: true,
        stream_id,
        conversation_id,
    })
    .map_err(|err| RpcError::internal_error(err.to_string()))
}

async fn run_classic_turn(
    ctx: Arc<ServerContext>,
    params: ClassicChatSendParams,
    mode: RuntimeMode,
    external_capabilities: Vec<ExternalCapabilityManifest>,
    cancel: CancellationToken,
) {
    let stream_id = params.stream_id.clone();
    let conversation_id = params.conversation_id.clone();
    let workspace = PathBuf::from(&params.workspace_path);

    let model_result = match &ctx.config.model_loader {
        Some(loader) => {
            loader(
                ctx.config.data_home.clone(),
                params.model_provider_id.clone(),
                params.effort.clone(),
                params.fast_mode,
                cancel.clone(),
            )
            .await
        }
        None => {
            resolve_default_model(
                ctx.config.data_home.clone(),
                params.model_provider_id.clone(),
                params.effort.clone(),
                params.fast_mode,
                cancel.clone(),
            )
            .await
        }
    };

    let resolved_model = match model_result {
        Ok(m) => m,
        Err(err) => {
            let cancelled = cancel.is_cancelled();
            if cancelled {
                ctx.streams
                    .finish_stream(&stream_id, "aborted", true, None, None);
                let _ = ctx
                    .peer
                    .notify(
                        "chat:stream:aborted",
                        json!({ "streamId": stream_id, "conversationId": conversation_id }),
                    )
                    .await;
            } else {
                ctx.streams
                    .finish_stream(&stream_id, "error", true, None, None);
                let _ = ctx
                    .peer
                    .notify(
                        "chat:stream:error",
                        json!({
                            "streamId": stream_id,
                            "conversationId": conversation_id,
                            "error": err.message,
                            "streamFailure": { "code": err.message },
                        }),
                    )
                    .await;
            }
            let _ = ctx
                .peer
                .notify("chat:stream:active-changed", ctx.streams.list_active())
                .await;
            return;
        }
    };

    let mut extra_providers: Vec<Box<dyn CapabilityProvider>> = Vec::new();
    if !external_capabilities.is_empty() {
        extra_providers.push(Box::new(ExternalRpcProvider::new(
            external_capabilities,
            ctx.peer.clone(),
            workspace.clone(),
        )));
    }

    let reminders: Vec<(String, String)> = params
        .runtime_reminders
        .iter()
        .map(|r| (r.id.clone(), r.content.clone()))
        .collect();

    let mut permission = RpcPermissionInput {
        stream_id: StreamIdRef::Fixed(stream_id.clone()),
        peer: ctx.peer.clone(),
        streams: ctx.streams.clone(),
    };
    let mut output = RpcConversationOutput {
        stream_id: StreamIdRef::Fixed(stream_id.clone()),
        conversation_id: conversation_id.clone(),
        peer: ctx.peer.clone(),
        streams: ctx.streams.clone(),
    };

    let exec_result = ctx
        .runtime
        .execute_prepared_interactive(
            PreparedConversationOptions {
                workspace: &workspace,
                conversation_id: &conversation_id,
                stream_id: &stream_id,
                assistant_message_id: &params.assistant_message_id,
                provider_id: &resolved_model.provider_id,
                mode,
                effort: &resolved_model.effort,
                persist_model_selection: params.persist_model_selection,
                resume_interrupted_reply: params.resume_interrupted_reply,
                runtime_reminders: &reminders,
                allowlist: params.allowlist.as_deref(),
                max_turns: params.max_turns,
                extra_providers,
            },
            &resolved_model.model,
            &mut permission,
            Some(&mut output),
            &cancel,
        )
        .await;

    match exec_result {
        Ok(outcome) => {
            deliver_terminal_outcome(&ctx, &stream_id, &conversation_id, &cancel, outcome).await
        }
        Err(host_err) => {
            let cancelled = cancel.is_cancelled() || host_err.0 == "CANCELLED";
            if cancelled {
                ctx.streams
                    .finish_stream(&stream_id, "aborted", true, None, None);
                let _ = ctx
                    .peer
                    .notify(
                        "chat:stream:aborted",
                        json!({ "streamId": stream_id, "conversationId": conversation_id }),
                    )
                    .await;
            } else {
                ctx.streams
                    .finish_stream(&stream_id, "error", true, None, None);
                let _ = ctx
                    .peer
                    .notify(
                        "chat:stream:error",
                        json!({
                            "streamId": stream_id,
                            "conversationId": conversation_id,
                            "error": host_err.0,
                            "streamFailure": { "code": host_err.0 },
                        }),
                    )
                    .await;
            }
        }
    }

    let _ = ctx
        .peer
        .notify("chat:stream:active-changed", ctx.streams.list_active())
        .await;
}

async fn deliver_terminal_outcome(
    ctx: &ServerContext,
    stream_id: &str,
    conversation_id: &str,
    cancel: &CancellationToken,
    outcome: ConversationOutcome,
) {
    let usage_json = format_usage_amounts(&outcome.usage.turn_total.amounts);
    let lifetime_usage = outcome.lifetime_usage.clone();

    if let Some(err_code) = outcome.error {
        let cancelled = cancel.is_cancelled() || err_code == "CANCELLED";
        if cancelled {
            ctx.streams
                .finish_stream(stream_id, "aborted", true, Some(usage_json), lifetime_usage);
            let _ = ctx
                .peer
                .notify(
                    "chat:stream:aborted",
                    json!({ "streamId": stream_id, "conversationId": conversation_id }),
                )
                .await;
        } else {
            ctx.streams.finish_stream(
                stream_id,
                "error",
                true,
                Some(usage_json.clone()),
                lifetime_usage.clone(),
            );
            let mut payload = json!({
                "streamId": stream_id,
                "conversationId": conversation_id,
                "error": err_code,
                "streamFailure": { "code": err_code },
                "usage": usage_json,
            });
            if let Some(lu) = lifetime_usage {
                payload["lifetimeUsage"] = lu;
            }
            let _ = ctx.peer.notify("chat:stream:error", payload).await;
        }
        return;
    }

    ctx.streams.finish_stream(
        stream_id,
        "done",
        false,
        Some(usage_json.clone()),
        lifetime_usage.clone(),
    );
    let mut payload = json!({
        "streamId": stream_id,
        "conversationId": conversation_id,
        "usage": usage_json,
    });
    if let Some(reason) = outcome.stop_reason {
        payload["reason"] = json!(reason);
    }
    if let Some(lu) = lifetime_usage {
        payload["lifetimeUsage"] = lu;
    }
    if let Some(acct) = outcome.context_accounting {
        payload["contextAccounting"] = acct;
    }
    let _ = ctx.peer.notify("chat:stream:done", payload).await;
}

pub fn handle_abort(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicChatAbortParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.chat.abort params: {err}"))
    })?;
    ctx.goals.mark_pause_for_tick_stream(&params.stream_id);
    let aborted = ctx.streams.abort_stream(&params.stream_id).is_some();
    Ok(json!({ "aborted": aborted }))
}

pub fn handle_reattach(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicChatReattachParams = if params_val.is_null() {
        ClassicChatReattachParams::default()
    } else {
        serde_json::from_value(params_val).map_err(|err| {
            RpcError::invalid_params(format!("Invalid classic.chat.reattach params: {err}"))
        })?
    };
    Ok(ctx.streams.reattach(
        params.stream_id.as_deref(),
        params.conversation_id.as_deref(),
    ))
}

pub fn handle_list_active(ctx: &ServerContext) -> Result<Value, RpcError> {
    Ok(ctx.streams.list_active())
}

pub fn handle_permission_decide(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicPermissionDecideParams =
        serde_json::from_value(params_val).map_err(|err| {
            RpcError::invalid_params(format!("Invalid classic.permission.decide params: {err}"))
        })?;
    let decision = match params.decision.as_str() {
        "approve" | "approve_once" => LocalPermissionDecision::Approve,
        "approve_session" | "session" => LocalPermissionDecision::ApproveSession,
        "deny" | "denied" => LocalPermissionDecision::Deny,
        "cancel" => LocalPermissionDecision::Cancel,
        other => {
            return Err(RpcError::invalid_params(format!(
                "Invalid permission decision: {other}"
            )));
        }
    };
    let resolved = ctx
        .streams
        .decide_permission(&params.tool_call_id, decision)
        .map_err(RpcError::internal_error)?;
    Ok(json!({ "resolved": resolved }))
}

pub fn handle_access_set(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: ClassicAccessSetParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.access.set params: {err}"))
    })?;
    let level = match params.access_level.as_str() {
        "ask_before_local" | "manual" => LocalAccessLevel::AskBeforeLocal,
        "session_local" => LocalAccessLevel::SessionLocal,
        "restricted_local" => LocalAccessLevel::RestrictedLocal,
        "full_local" | "full" => LocalAccessLevel::FullLocal,
        other => {
            return Err(RpcError::invalid_params(format!(
                "Invalid localAccessLevel: {other}"
            )));
        }
    };
    ctx.access
        .set(level)
        .map_err(|err| RpcError::internal_error(err.0))?;
    Ok(json!({
        "ok": true,
        "accessLevel": level.as_str(),
    }))
}

pub async fn handle_compact(
    ctx: &Arc<ServerContext>,
    params_val: Value,
) -> Result<Value, RpcError> {
    let params: ClassicChatCompactParams = serde_json::from_value(params_val).map_err(|err| {
        RpcError::invalid_params(format!("Invalid classic.chat.compact params: {err}"))
    })?;
    validate_non_empty(&params.conversation_id, "conversationId")?;

    let stream_id = params
        .stream_id
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| format!("compact-{}", uuid::Uuid::new_v4()));

    let store = ConversationStore::new(&ctx.config.data_home);
    let meta = store
        .read_metadata(&params.conversation_id)
        .map_err(|err| {
            RpcError::invalid_params(format!("conversation_unavailable: {}", err.code()))
        })?
        .metadata
        .ok_or_else(|| RpcError::invalid_params("conversation_unavailable"))?;

    let mode_str = meta["mode"].as_str().unwrap_or("chat");
    let mode: RuntimeMode = mode_str
        .parse()
        .map_err(|_| RpcError::invalid_params(format!("Unsupported mode: {mode_str}")))?;

    let workspace = params
        .workspace_path
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .or_else(|| meta["workspacePath"].as_str())
        .ok_or_else(|| RpcError::invalid_params("workspacePath unavailable for compaction"))?;

    let model_provider_id = params
        .model_provider_id
        .or_else(|| meta["modelProviderId"].as_str().map(str::to_owned));
    let effort = params
        .effort
        .or_else(|| meta["effort"].as_str().map(str::to_owned));

    let cancel = ctx.peer.shutdown_child_token();
    let resolved = match &ctx.config.model_loader {
        Some(loader) => {
            loader(
                ctx.config.data_home.clone(),
                model_provider_id,
                effort,
                false,
                cancel.clone(),
            )
            .await?
        }
        None => {
            resolve_default_model(
                ctx.config.data_home.clone(),
                model_provider_id,
                effort,
                false,
                cancel.clone(),
            )
            .await?
        }
    };

    let _ = ctx
        .peer
        .notify(
            "chat:stream:compaction",
            json!({
                "conversationId": params.conversation_id,
                "streamId": stream_id,
                "stage": "start",
            }),
        )
        .await;

    let (reply_tx, reply_rx) = oneshot::channel();
    let ctx_local = Arc::clone(ctx);
    let conv_id = params.conversation_id.clone();
    let workspace_owned = workspace.to_owned();
    let provider_id_owned = resolved.provider_id.clone();
    let effort_owned = resolved.effort.clone();
    let model_owned = resolved.model;
    let cancel_owned = cancel.clone();

    ctx.dispatch_local(move || {
        tokio::task::spawn_local(async move {
            let outcome = ctx_local
                .runtime
                .compact_conversation(
                    &CompactOptions {
                        workspace: &PathBuf::from(&workspace_owned),
                        conversation_id: &conv_id,
                        resume_from: None,
                        provider_id: &provider_id_owned,
                        mode,
                        effort: &effort_owned,
                    },
                    &model_owned,
                    &cancel_owned,
                )
                .await;
            let _ = reply_tx.send(outcome);
        });
    })?;

    let outcome = reply_rx
        .await
        .map_err(|_| RpcError::internal_error("compaction task aborted"))?;

    match outcome {
        Ok(compact) => {
            let (before_tokens, after_tokens) =
                read_compaction_token_counts(&store, &params.conversation_id);
            let _ = ctx
                .peer
                .notify(
                    "chat:stream:compaction",
                    json!({
                        "conversationId": params.conversation_id,
                        "streamId": stream_id,
                        "stage": "done",
                        "method": compact.method,
                        "beforeTokens": before_tokens,
                        "afterTokens": after_tokens,
                        "oldMessageCount": compact.original_message_count,
                        "keptMessageCount": 1,
                    }),
                )
                .await;
            Ok(json!({
                "compacted": true,
                "method": compact.method,
                "originalMessageCount": compact.original_message_count,
            }))
        }
        Err(err) if err.0 == "native_compaction_no_user" => {
            let _ = ctx
                .peer
                .notify(
                    "chat:stream:compaction",
                    json!({
                        "conversationId": params.conversation_id,
                        "streamId": stream_id,
                        "stage": "idle",
                    }),
                )
                .await;
            Ok(json!({ "compacted": false }))
        }
        Err(err) => {
            let _ = ctx
                .peer
                .notify(
                    "chat:stream:compaction",
                    json!({
                        "conversationId": params.conversation_id,
                        "streamId": stream_id,
                        "stage": "failed",
                        "errorCode": err.0,
                        "message": err.0,
                    }),
                )
                .await;
            Err(RpcError::internal_error(err.0))
        }
    }
}

fn read_compaction_token_counts(store: &ConversationStore, conversation_id: &str) -> (u64, u64) {
    let Ok(snapshot) = store.read_committed(conversation_id, None, 8 * 1024 * 1024) else {
        return (0, 0);
    };
    let before = snapshot
        .history
        .messages
        .iter()
        .rev()
        .find_map(|msg| {
            msg.get("_compaction")
                .or_else(|| msg.get("compaction"))
                .and_then(|c| c.get("beforeTokens"))
                .and_then(Value::as_u64)
        })
        .unwrap_or(0);
    let summary_len = snapshot
        .history
        .messages
        .iter()
        .rev()
        .find(|msg| msg.get("_compaction").is_some() || msg.get("compaction").is_some())
        .and_then(|msg| msg["content"].as_str())
        .map_or(0, str::len);
    let after = store
        .read_metadata(conversation_id)
        .ok()
        .and_then(|m| m.metadata)
        .and_then(|v| {
            v["contextSnapshot"]["authoritativeInputTokens"]
                .as_u64()
                .or_else(|| v["contextSnapshot"]["estimatedInputTokens"].as_u64())
        })
        .unwrap_or((summary_len / 4) as u64);
    (before, after)
}

pub(crate) struct RpcPermissionInput {
    pub(crate) stream_id: StreamIdRef,
    pub(crate) peer: RpcPeer,
    pub(crate) streams: ClassicStreamRegistry,
}

impl PermissionInput for RpcPermissionInput {
    fn decide<'a>(
        &'a mut self,
        prompt: Value,
        cancel: &'a CancellationToken,
    ) -> Pin<Box<dyn Future<Output = LocalPermissionDecision> + 'a>> {
        Box::pin(async move {
            let stream_id = self.stream_id.current();
            if stream_id.is_empty() {
                return LocalPermissionDecision::Unavailable;
            }
            let tool_call_id = prompt["toolCallId"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(|| format!("perm-{}", uuid::Uuid::new_v4()));
            let capability_id = prompt["capabilityId"]
                .as_str()
                .unwrap_or("local.capability");
            let display_name = prompt["tool"]
                .as_str()
                .filter(|s| !s.is_empty())
                .unwrap_or(capability_id);
            let reason = prompt["reason"]
                .as_str()
                .unwrap_or("This action needs your approval before local execution.");
            let risk_level = prompt["riskLevel"].as_str().unwrap_or("L3_external_write");
            let data_level = if risk_level == "L1_local_read" {
                "D1_internal"
            } else {
                "D2_sensitive"
            };
            let arguments = prompt["arguments"].clone();
            let arguments_preview = build_arguments_preview(&arguments, reason);
            let requested_at = prompt["approval"]["createdAt"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned)
                .unwrap_or_else(peer_runtime::capability::now);
            let deadline_at = prompt["approval"]["deadlineAt"]
                .as_str()
                .filter(|s| !s.is_empty())
                .map(str::to_owned);

            let call = json!({
                "toolCallId": tool_call_id,
                "capabilityId": capability_id,
                "displayName": display_name,
                "reason": reason,
                "arguments": arguments,
                "argumentsPreview": arguments_preview,
                "riskLevel": risk_level,
                "dataLevel": data_level,
                "requestedAt": requested_at,
            });

            let (tx, rx) = oneshot::channel();
            self.streams
                .register_permission_waiter(&stream_id, &tool_call_id, call.clone(), tx);

            let mut notif = json!({
                "streamId": stream_id,
                "call": call,
            });
            if let Some(deadline) = deadline_at {
                notif["deadlineAt"] = json!(deadline);
            }
            if self
                .peer
                .notify("chat:stream:permission-request", notif)
                .await
                .is_err()
            {
                self.streams
                    .clear_permission_waiter(&stream_id, &tool_call_id);
                return LocalPermissionDecision::Unavailable;
            }

            let decision = tokio::select! {
                biased;
                _ = cancel.cancelled() => LocalPermissionDecision::Cancel,
                _ = tokio::time::sleep(Duration::from_secs(300)) => LocalPermissionDecision::Timeout,
                res = rx => res.unwrap_or(LocalPermissionDecision::Cancel),
            };
            self.streams
                .clear_permission_waiter(&stream_id, &tool_call_id);
            decision
        })
    }
}

fn build_arguments_preview(arguments: &Value, reason: &str) -> Value {
    if let Some(cmd) = arguments.get("command").and_then(Value::as_str) {
        return json!({
            "command": cmd,
            "cwd": arguments.get("cwd").cloned().unwrap_or(Value::Null),
            "reason": reason,
        });
    }
    if let Some(path) = arguments.get("path").and_then(Value::as_str) {
        return json!({
            "path": path,
            "reason": reason,
        });
    }
    arguments.clone()
}

pub(crate) struct RpcConversationOutput {
    pub(crate) stream_id: StreamIdRef,
    pub(crate) conversation_id: String,
    pub(crate) peer: RpcPeer,
    pub(crate) streams: ClassicStreamRegistry,
}

impl ConversationOutput for RpcConversationOutput {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> Pin<Box<dyn Future<Output = Result<(), peer_runtime::capability::CapabilityError>> + 'a>>
    {
        Box::pin(async move {
            let stream_id = self.stream_id.current();
            if stream_id.is_empty() {
                return Ok(());
            }
            match event {
                ConversationEvent::Started { .. } | ConversationEvent::AssistantText(_) => {}
                ConversationEvent::ThinkingDelta(content) => {
                    self.streams
                        .append_thinking_delta(&stream_id, content, "reasoning");
                    let _ = self
                        .peer
                        .notify(
                            "chat:stream:thinking",
                            json!({
                                "streamId": stream_id,
                                "content": content,
                                "kind": "reasoning",
                            }),
                        )
                        .await;
                }
                ConversationEvent::AssistantDelta(content) => {
                    self.streams.append_text_delta(&stream_id, content);
                    let _ = self
                        .peer
                        .notify(
                            "chat:stream:delta",
                            json!({
                                "streamId": stream_id,
                                "content": content,
                            }),
                        )
                        .await;
                }
                ConversationEvent::ToolPrepared {
                    call_id,
                    tool,
                    arguments,
                } => {
                    let started_at_ms = self
                        .streams
                        .record_tool_prepared(&stream_id, call_id, tool, tool, arguments);
                    let _ = self
                        .peer
                        .notify(
                            "chat:stream:tool-call",
                            json!({
                                "streamId": stream_id,
                                "tool": tool,
                                "displayName": tool,
                                "args": arguments,
                                "toolCallId": call_id,
                                "startedAtMs": started_at_ms,
                            }),
                        )
                        .await;
                }
                ConversationEvent::PermissionSettled {
                    call_id,
                    granted,
                    reason,
                } => {
                    self.streams.clear_permission_waiter(&stream_id, call_id);
                    let _ = self
                        .peer
                        .notify(
                            "chat:stream:permission-settled",
                            json!({
                                "streamId": stream_id,
                                "toolCallIds": [call_id],
                                "granted": granted,
                                "reason": reason,
                            }),
                        )
                        .await;
                }
                ConversationEvent::ToolSettled {
                    call_id,
                    result,
                    evidence_ref,
                } => {
                    let stream_result = format_tool_result_for_stream(result);
                    let (started_at_ms, ended_at_ms, duration_ms) = self
                        .streams
                        .record_tool_settled(&stream_id, call_id, &stream_result);
                    let mut payload = json!({
                        "streamId": stream_id,
                        "toolCallId": call_id,
                        "result": stream_result,
                        "endedAtMs": ended_at_ms,
                    });
                    if let Some(start) = started_at_ms {
                        payload["startedAtMs"] = json!(start);
                    }
                    if let Some(dur) = duration_ms {
                        payload["durationMs"] = json!(dur);
                    }
                    if let Some(ev) = evidence_ref {
                        payload["evidenceRefs"] = json!([ev]);
                    }
                    let _ = self.peer.notify("chat:stream:tool-result", payload).await;

                    if let Some(capability_id) = result["capabilityId"].as_str()
                        && matches!(
                            capability_id,
                            "local.goal.create_plan" | "local.goal.update_task"
                        )
                        && result["status"] == "success"
                    {
                        let output = &result["output"];
                        let plan_id = output["planId"]
                            .as_str()
                            .or_else(|| output["plan"]["planId"].as_str())
                            .filter(|s| !s.is_empty());
                        if let Some(plan_id) = plan_id {
                            let workflow_kind = output["workflowKind"]
                                .as_str()
                                .or_else(|| output["plan"]["workflowKind"].as_str());
                            let change_kind = if capability_id == "local.goal.create_plan"
                                && workflow_kind == Some("goal_self_driven")
                            {
                                "goal-accepted"
                            } else {
                                "persist"
                            };
                            let _ = self
                                .peer
                                .notify(
                                    "goalPlans:changed",
                                    json!({
                                        "reason": "persist",
                                        "planId": plan_id,
                                        "conversationId": self.conversation_id,
                                        "changeKind": change_kind,
                                    }),
                                )
                                .await;
                        }
                    }
                }
                ConversationEvent::Usage(snapshot) => {
                    let usage_json = format_usage_snapshot(snapshot);
                    self.streams.record_usage(&stream_id, usage_json.clone());
                    let _ = self
                        .peer
                        .notify(
                            "chat:stream:usage",
                            json!({
                                "streamId": stream_id,
                                "usage": usage_json,
                            }),
                        )
                        .await;
                }
            }
            Ok(())
        })
    }
}

pub(crate) fn format_usage_amounts(amounts: &UsageAmounts) -> Value {
    json!({
        "inputTokens": amounts.input_tokens,
        "outputTokens": amounts.output_tokens,
        "cacheWriteTokens": amounts.cache_write_tokens,
        "cacheReadTokens": amounts.cache_read_tokens,
        "totalTokens": amounts.total_tokens,
    })
}

pub(crate) fn format_usage_snapshot(snapshot: &UsageSnapshot) -> Value {
    format_usage_amounts(&snapshot.turn_total.amounts)
}

fn format_tool_result_for_stream(result: &Value) -> String {
    let raw = match result {
        Value::String(s) => s.clone(),
        other => serde_json::to_string(other).unwrap_or_else(|_| "{}".to_owned()),
    };
    if raw.chars().count() <= MAX_STREAM_TOOL_RESULT_CHARS {
        return raw;
    }
    let truncated: String = raw.chars().take(MAX_STREAM_TOOL_RESULT_CHARS).collect();
    format!(
        "{truncated}… [truncated at {MAX_STREAM_TOOL_RESULT_CHARS} chars at {}ms]",
        now_epoch_ms()
    )
}
