//! ADR 56 RuntimeUsageAccounting: one request observation, two distinct scopes.
//! The caller supplies disjoint provider-normalized safe integer quantities.
use peer_protocol::{ProviderRequestUsage, RuntimeTurnUsage, UsageAmounts, UsagePurpose};
use serde::Serialize;
const MAX: u64 = 9_007_199_254_740_991;
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub provider_request_count: u64,
    pub last_request: Option<ProviderRequestUsage>,
    pub turn_total: RuntimeTurnUsage,
}
#[derive(Default)]
pub struct RuntimeUsageAccounting {
    count: u64,
    last: Option<ProviderRequestUsage>,
    total: UsageAmounts,
}
pub struct RequestMetadata<'a> {
    pub fingerprint: Option<&'a str>,
    pub purpose: UsagePurpose,
    pub capacity_bearing: bool,
}
impl Default for RequestMetadata<'_> {
    fn default() -> Self {
        Self {
            fingerprint: None,
            purpose: UsagePurpose::Agent,
            capacity_bearing: true,
        }
    }
}
fn sum(a: u64, b: u64) -> Result<u64, &'static str> {
    a.checked_add(b)
        .filter(|n| *n <= MAX)
        .ok_or("native_usage_limit")
}
fn normalized(mut usage: UsageAmounts) -> Result<UsageAmounts, &'static str> {
    usage.total_tokens = [
        usage.input_tokens,
        usage.output_tokens,
        usage.cache_read_tokens,
        usage.cache_write_tokens,
    ]
    .into_iter()
    .try_fold(0, sum)?;
    Ok(usage)
}
impl RuntimeUsageAccounting {
    /// Null/zero observations count as real provider rounds without erasing the
    /// last capacity-bearing observation. Invalid input leaves state unchanged.
    pub fn observe(
        &mut self,
        usage: Option<UsageAmounts>,
        metadata: RequestMetadata<'_>,
    ) -> Result<UsageSnapshot, &'static str> {
        if metadata.fingerprint.is_some_and(|s| s.len() > 1024) {
            return Err("native_usage_limit");
        }
        let count = sum(self.count, 1)?;
        let mut total = self.total.clone();
        let request = if let Some(usage) = usage {
            let usage = normalized(usage)?;
            if usage.total_tokens > 0 {
                total = normalized(UsageAmounts {
                    input_tokens: sum(total.input_tokens, usage.input_tokens)?,
                    output_tokens: sum(total.output_tokens, usage.output_tokens)?,
                    cache_read_tokens: sum(total.cache_read_tokens, usage.cache_read_tokens)?,
                    cache_write_tokens: sum(total.cache_write_tokens, usage.cache_write_tokens)?,
                    total_tokens: 0,
                })?;
                Some(ProviderRequestUsage {
                    request_index: count,
                    request_purpose: metadata.purpose,
                    request_fingerprint: metadata
                        .fingerprint
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned),
                    amounts: usage,
                })
            } else {
                None
            }
        } else {
            None
        };
        self.count = count;
        self.total = total;
        if metadata.capacity_bearing && request.is_some() {
            self.last = request;
        }
        Ok(self.snapshot())
    }
    pub fn snapshot(&self) -> UsageSnapshot {
        UsageSnapshot {
            provider_request_count: self.count,
            last_request: self.last.clone(),
            turn_total: RuntimeTurnUsage {
                provider_request_count: self.count,
                amounts: self.total.clone(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};
    #[test]
    fn real_ts_usage_scope_sequences_match_at_every_request_boundary() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/usage-accounting.json"
        ))
        .unwrap();
        for c in data["cases"].as_array().unwrap() {
            let mut usage = RuntimeUsageAccounting::default();
            assert_eq!(
                serde_json::to_value(usage.snapshot()).unwrap(),
                c["initial"]
            );
            for (step, expected) in c["steps"]
                .as_array()
                .unwrap()
                .iter()
                .zip(c["expected"].as_array().unwrap())
            {
                let value = step
                    .get("usage")
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()).unwrap());
                let m = &step["metadata"];
                let snapshot = usage
                    .observe(
                        value,
                        RequestMetadata {
                            fingerprint: m["requestFingerprint"].as_str(),
                            purpose: serde_json::from_value(
                                m.get("requestPurpose").cloned().unwrap_or(json!("agent")),
                            )
                            .unwrap(),
                            capacity_bearing: m["capacityBearing"] != false,
                        },
                    )
                    .unwrap();
                assert_eq!(
                    serde_json::to_value(snapshot).unwrap(),
                    *expected,
                    "{}",
                    c["name"]
                );
            }
        }
    }
    #[test]
    fn count_and_sum_overflow_do_not_partially_mutate_prior_facts() {
        let mut usage = RuntimeUsageAccounting::default();
        usage
            .observe(
                Some(UsageAmounts {
                    input_tokens: MAX,
                    ..UsageAmounts::default()
                }),
                RequestMetadata::default(),
            )
            .unwrap();
        let before = usage.snapshot();
        for extra in [1, MAX + 1] {
            assert!(
                usage
                    .observe(
                        Some(UsageAmounts {
                            input_tokens: extra,
                            ..UsageAmounts::default()
                        }),
                        RequestMetadata::default()
                    )
                    .is_err()
            );
            assert_eq!(usage.snapshot(), before);
        }
        usage.count = MAX;
        assert!(usage.observe(None, RequestMetadata::default()).is_err());
        assert_eq!(usage.count, MAX);
    }
}
