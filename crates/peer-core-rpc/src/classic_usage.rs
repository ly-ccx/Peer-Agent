//! Classic Usage statistics & cache hit rate RPC handlers (`classic.usage.*`).

use crate::{protocol::RpcError, server::ServerContext};
use peer_store::usage_queries::{
    collect_cache_hit_rate, collect_usage_daily, collect_usage_day, collect_usage_stats,
};
use serde::Deserialize;
use serde_json::Value;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StatsParams {
    #[serde(default)]
    generated_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DailyParams {
    #[serde(default)]
    range: Option<String>,
    #[serde(default)]
    now: Option<String>,
    #[serde(default)]
    local_offset_minutes: i32,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DayParams {
    #[serde(default)]
    date: Option<String>,
    #[serde(default)]
    now: Option<String>,
    #[serde(default)]
    local_offset_minutes: i32,
}

pub fn handle_stats(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: StatsParams = if params_val.is_null() {
        StatsParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid usage.stats params: {err}")))?
    };
    Ok(collect_usage_stats(
        &ctx.config.data_home,
        params.generated_at.as_deref(),
    ))
}

pub fn handle_daily(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: DailyParams = if params_val.is_null() {
        DailyParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid usage.daily params: {err}")))?
    };
    Ok(collect_usage_daily(
        &ctx.config.data_home,
        params.range.as_deref(),
        params.now.as_deref(),
        params.local_offset_minutes,
    ))
}

pub fn handle_day(ctx: &ServerContext, params_val: Value) -> Result<Value, RpcError> {
    let params: DayParams = if params_val.is_null() {
        DayParams::default()
    } else {
        serde_json::from_value(params_val)
            .map_err(|err| RpcError::invalid_params(format!("Invalid usage.day params: {err}")))?
    };
    Ok(collect_usage_day(
        &ctx.config.data_home,
        params.date.as_deref(),
        params.now.as_deref(),
        params.local_offset_minutes,
    ))
}

pub fn handle_cache_hit_rate(ctx: &ServerContext) -> Result<Value, RpcError> {
    Ok(collect_cache_hit_rate(&ctx.config.data_home))
}
