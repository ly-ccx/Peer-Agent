//! Classic LLM catalog, one-shot completion, and subscription quota RPC handlers (`classic.llm.*`).

use crate::{classic, protocol::RpcError, server::ServerContext};
use peer_runtime::{
    model_catalog::load as load_model_catalog,
    subscription_quota::{fetch_subscription_quota, supports_subscription_quota},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Instant;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CompleteParams {
    #[serde(default)]
    id: Option<String>,
    #[serde(default)]
    prompt: String,
    #[serde(default)]
    max_tokens: Option<u64>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct QuotaParams {
    id: String,
}

pub fn handle_catalog(ctx: &ServerContext) -> Result<Value, RpcError> {
    let entries = load_model_catalog(Some(&ctx.config.data_home))
        .map_err(|err| RpcError::internal_error(err.code))?;
    serde_json::to_value(entries).map_err(|err| RpcError::internal_error(err.to_string()))
}

pub async fn handle_complete(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: CompleteParams = if params_val.is_null() {
        CompleteParams::default()
    } else {
        serde_json::from_value(params_val).map_err(|err| {
            RpcError::invalid_params(format!("Invalid llm.complete params: {err}"))
        })?
    };
    let prompt = params.prompt.trim();
    if prompt.is_empty() {
        return Ok(json!({
            "success": false,
            "error": "Prompt required",
            "text": "",
        }));
    }
    let _ = params.max_tokens;

    let cancel = ctx.peer.shutdown_child_token();
    let started = Instant::now();
    let loader = ctx.config.model_loader.clone();
    let data_home = ctx.config.data_home.clone();
    let provider_id = params.id.filter(|s| !s.trim().is_empty());

    let resolved = match loader {
        Some(custom) => custom(data_home, provider_id, None, false, cancel.clone()).await,
        None => {
            classic::resolve_default_model(data_home, provider_id, None, false, cancel.clone())
                .await
        }
    };
    let resolved = match resolved {
        Ok(model) => model,
        Err(err) => {
            return Ok(json!({
                "success": false,
                "error": err.message,
                "text": "",
                "latencyMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
            }));
        }
    };

    let history = json!({
        "messages": [
            { "role": "user", "content": prompt }
        ]
    });
    let tools = json!([]);
    match resolved.model.turn("", &history, &tools, &cancel).await {
        Ok(turn) => Ok(json!({
            "success": true,
            "text": turn.content.trim(),
            "latencyMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })),
        Err(err) => Ok(json!({
            "success": false,
            "error": err.code,
            "text": "",
            "latencyMs": u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        })),
    }
}

pub async fn handle_quota(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: QuotaParams = serde_json::from_value(params_val)
        .map_err(|err| RpcError::invalid_params(format!("Invalid llm.quota params: {err}")))?;
    let provider_id = params.id.trim();
    if provider_id.is_empty() {
        return Err(RpcError::invalid_params("id must not be empty"));
    }
    let supported = supports_subscription_quota(&ctx.config.data_home, provider_id);
    if !supported {
        return Ok(json!({
            "supported": false,
            "snapshot": Value::Null,
        }));
    }
    let cancel = ctx.peer.shutdown_child_token();
    let snapshot = fetch_subscription_quota(&ctx.config.data_home, provider_id, &cancel).await;
    Ok(json!({
        "supported": true,
        "snapshot": snapshot.map(|s| json!({
            "providerId": s.provider_id,
            "authMethod": s.auth_method,
            "remainingPercent": s.remaining_percent,
            "usedPercent": s.used_percent,
            "planLabel": s.plan_label,
            "resetsAt": s.resets_at,
        })).unwrap_or(Value::Null),
    }))
}
