//! Billing-only canonical facts, never a checkpoint or capacity/permission truth.
use crate::{
    RuntimeTurnUsage, SessionExecutionIdentity, UsageAmounts, javascript_json_string,
    normalize_session_execution_identity,
};
use serde_json::Value;
use std::sync::LazyLock;
const SAFE: f64 = 9_007_199_254_740_991.0;
pub const NATIVE_USAGE_CONTRACT: &str =
    include_str!("../../../packages/protocol/contracts/native-cli/native-runtime-usage-v1.json");
static CONTRACT: LazyLock<Value> =
    LazyLock::new(|| serde_json::from_str(NATIVE_USAGE_CONTRACT).expect("embedded usage contract"));
pub fn native_usage_recovery_batch_limit() -> usize {
    CONTRACT["recoveryBatch"].as_u64().expect("contract batch") as usize
}
pub struct NativeUsageSnapshot {
    pub execution: SessionExecutionIdentity,
    pub conversation_id: String,
    pub attribution: Value,
    pub usage: RuntimeTurnUsage,
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeUsageRecoveryProgress {
    pub schema_version: u32,
    pub settled: usize,
    pub remaining: usize,
}
fn integer(v: &Value) -> Option<u64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && n.fract() == 0.0 && *n <= SAFE)
        .map(|n| n as u64)
}
fn text(v: &Value, max: usize) -> bool {
    v.as_str().is_some_and(|s| !s.is_empty() && s.len() <= max)
}
fn fields(v: &Value, list: &Value) -> bool {
    v.as_object().is_some_and(|object| {
        object.keys().all(|key| {
            list.as_array()
                .expect("contract fields")
                .iter()
                .any(|v| v == key)
        })
    })
}
pub fn normalize_native_usage_snapshot(
    v: &Value,
    work: &str,
    workspace: &str,
) -> Option<NativeUsageSnapshot> {
    if javascript_json_string(v).ok()?.len() > CONTRACT["snapshotBytes"].as_u64()? as usize
        || !fields(v, &CONTRACT["snapshotFields"])
        || integer(&v["schemaVersion"]) != Some(CONTRACT["schemaVersion"].as_u64()?)
        || v["knownAmountsOnly"] != true
        || v["workId"] != work
    {
        return None;
    }
    let execution = normalize_session_execution_identity(&v["execution"])?;
    let conversation = v["conversationId"].as_str()?;
    if conversation.is_empty()
        || conversation.len() > 128
        || !conversation.as_bytes()[0].is_ascii_alphanumeric()
        || !conversation
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
    {
        return None;
    }
    let a = &v["attribution"];
    if !fields(a, &CONTRACT["attributionFields"])
        || a["role"] != CONTRACT["role"]
        || a["workspaceId"] != workspace
        || !text(&a["id"], 200)
        || a["streamId"] != a["id"]
        || !text(&a["at"], 64)
        || !text(&a["modelProviderId"], 512)
        || !text(&a["model"], 512)
    {
        return None;
    }
    for key in ["groupId", "providerName", "pricingSource"] {
        if !a[key].is_null() && !text(&a[key], 1024) {
            return None;
        }
    }
    if !a["estimatedCostUsd"].is_null()
        && a["estimatedCostUsd"]
            .as_f64()
            .is_none_or(|n| !n.is_finite() || n < 0.0 || n > SAFE)
    {
        return None;
    }
    let u = &v["usage"];
    if u["usageScope"] != CONTRACT["usageScope"] || !fields(u, &CONTRACT["usageFields"]) {
        return None;
    }
    let amounts = UsageAmounts {
        input_tokens: integer(&u["inputTokens"])?,
        output_tokens: integer(&u["outputTokens"])?,
        cache_read_tokens: integer(&u["cacheReadTokens"])?,
        cache_write_tokens: integer(&u["cacheWriteTokens"])?,
        total_tokens: integer(&u["totalTokens"])?,
    };
    let total = [
        amounts.input_tokens,
        amounts.output_tokens,
        amounts.cache_read_tokens,
        amounts.cache_write_tokens,
    ]
    .into_iter()
    .try_fold(0u64, u64::checked_add)?;
    let count = integer(&u["providerRequestCount"])?;
    if total != amounts.total_tokens || total > SAFE as u64 || count == 0 {
        return None;
    }
    Some(NativeUsageSnapshot {
        execution,
        conversation_id: conversation.into(),
        attribution: a.clone(),
        usage: RuntimeTurnUsage {
            provider_request_count: count,
            amounts,
        },
    })
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn scoped_billing_facts_bind_work_workspace_execution_and_safe_normalized_amounts() {
        let good = &CONTRACT["valid"];
        let parsed = normalize_native_usage_snapshot(good, "work", "workspace").unwrap();
        assert_eq!(parsed.usage.amounts.total_tokens, 16);
        assert_eq!(parsed.execution.plan_id, "plan");
        assert!(normalize_native_usage_snapshot(good, "foreign-work", "workspace").is_none());
        assert!(normalize_native_usage_snapshot(good, "work", "foreign-workspace").is_none());
        for (key, value) in [
            ("schemaVersion", json!(2)),
            ("knownAmountsOnly", json!(false)),
            ("execution", json!({})),
            ("conversationId", json!("../foreign")),
            ("futureAccounting", json!(true)),
        ] {
            let mut bad = good.clone();
            bad[key] = value;
            assert!(
                normalize_native_usage_snapshot(&bad, "work", "workspace").is_none(),
                "{key}"
            );
        }
        for (key, value) in [
            ("usageScope", json!("provider_request")),
            ("providerRequestCount", json!(0)),
            ("inputTokens", json!(-1)),
            ("outputTokens", json!(9007199254740992u64)),
            ("totalTokens", json!(999)),
        ] {
            let mut bad = good.clone();
            bad["usage"][key] = value;
            assert!(
                normalize_native_usage_snapshot(&bad, "work", "workspace").is_none(),
                "{key}"
            );
        }
        let mut bad = good.clone();
        bad["attribution"]["role"] = json!("project_agent");
        assert!(normalize_native_usage_snapshot(&bad, "work", "workspace").is_none());
        let mut bad = good.clone();
        bad["attribution"]["providerName"] = json!("x".repeat(20000));
        assert!(normalize_native_usage_snapshot(&bad, "work", "workspace").is_none());
    }
}
