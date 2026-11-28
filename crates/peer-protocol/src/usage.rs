//! ADR 56 amounts and explicit scopes. Billing totals are never context capacity.
use serde::{Deserialize, Serialize};

#[derive(Debug, Default, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct UsageAmounts {
    pub input_tokens: u64,
    pub output_tokens: u64,
    pub cache_read_tokens: u64,
    pub cache_write_tokens: u64,
    pub total_tokens: u64,
}
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum UsagePurpose {
    #[default]
    Agent,
    CompactionSummary,
    InputPrediction,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "usageScope",
    rename = "provider_request",
    rename_all = "camelCase"
)]
pub struct ProviderRequestUsage {
    pub request_index: u64,
    pub request_purpose: UsagePurpose,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_fingerprint: Option<String>,
    #[serde(flatten)]
    pub amounts: UsageAmounts,
}
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "usageScope", rename = "runtime_turn", rename_all = "camelCase")]
pub struct RuntimeTurnUsage {
    pub provider_request_count: u64,
    #[serde(flatten)]
    pub amounts: UsageAmounts,
}
