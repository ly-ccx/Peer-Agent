//! Provider quantities become disjoint dimensions before accounting.
use super::{ModelError, wire::Wire};
use serde_json::{Value, json};
fn count(v: Option<&Value>) -> Result<u64, ModelError> {
    match v.filter(|v| !v.is_null()) {
        None => Ok(0),
        Some(v) => v
            .as_u64()
            .filter(|n| *n <= 9_007_199_254_740_991)
            .ok_or(ModelError::new("model_usage_invalid")),
    }
}
fn first_count(v: &Value, keys: &[&str]) -> Result<u64, ModelError> {
    for key in keys {
        if let Some(n) = v.get(*key).filter(|v| !v.is_null()) {
            return count(Some(n));
        }
    }
    Ok(0)
}
pub(super) fn normalize(wire: Wire, v: &Value) -> Result<Value, ModelError> {
    if !v.is_object() {
        return Err(ModelError::new("model_usage_invalid"));
    }
    let present = |keys: &[&str]| keys.iter().any(|k| v.get(*k).is_some_and(|n| !n.is_null()));
    let complete = match wire {
        Wire::Chat | Wire::Qoder | Wire::Responses => {
            present(&["input_tokens", "prompt_tokens"])
                && present(&["output_tokens", "completion_tokens"])
        }
        Wire::Anthropic => present(&["input_tokens"]) && present(&["output_tokens"]),
        Wire::Gemini => present(&["promptTokenCount"]) && present(&["candidatesTokenCount"]),
    };
    let (input, output, cache, write) = match wire {
        Wire::Chat | Wire::Qoder | Wire::Responses => {
            let cache = if let Some(c) = v["input_tokens_details"]
                .get("cached_tokens")
                .filter(|v| !v.is_null())
                .or_else(|| {
                    v["prompt_tokens_details"]
                        .get("cached_tokens")
                        .filter(|v| !v.is_null())
                }) {
                count(Some(c))?
            } else {
                first_count(v, &["prompt_cache_hit_tokens", "prompt_cache_hit"])?
            };
            let input = first_count(v, &["input_tokens", "prompt_tokens"])?;
            let output = first_count(v, &["output_tokens", "completion_tokens"])?;
            let write = v
                .get("cache_creation_input_tokens")
                .filter(|v| !v.is_null())
                .or_else(|| v.get("cache_write_input_tokens").filter(|v| !v.is_null()))
                .or_else(|| {
                    v["prompt_tokens_details"]
                        .get("cache_write_tokens")
                        .filter(|v| !v.is_null())
                });
            (
                input.saturating_sub(cache),
                output,
                cache,
                write.map(|w| count(Some(w))).transpose()?,
            )
        }
        Wire::Anthropic => (
            count(v.get("input_tokens"))?,
            count(v.get("output_tokens"))?,
            count(v.get("cache_read_input_tokens"))?,
            Some(count(v.get("cache_creation_input_tokens"))?),
        ),
        Wire::Gemini => {
            let cache = count(v.get("cachedContentTokenCount"))?;
            (
                count(v.get("promptTokenCount"))?
                    .saturating_sub(cache)
                    .checked_add(count(v.get("toolUsePromptTokenCount"))?)
                    .ok_or(ModelError::new("model_usage_invalid"))?,
                count(v.get("candidatesTokenCount"))?
                    .checked_add(count(v.get("thoughtsTokenCount"))?)
                    .ok_or(ModelError::new("model_usage_invalid"))?,
                cache,
                None,
            )
        }
    };
    // Optional observations are distinct from a provider-reported zero. Still
    // validate any present dimensions above; unknown is not malformed data.
    if !complete {
        return Ok(Value::Null);
    }
    let total = [input, output, cache, write.unwrap_or(0)]
        .into_iter()
        .try_fold(0u64, |a, b| {
            a.checked_add(b).filter(|n| *n <= 9_007_199_254_740_991)
        })
        .ok_or(ModelError::new("model_usage_invalid"))?;
    let mut out = json!({"inputTokens":input,"outputTokens":output,"cacheReadTokens":cache,"totalTokens":total});
    if let Some(w) = write {
        out["cacheWriteTokens"] = w.into();
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn provider_cache_counts_are_disjoint_and_unknown_write_is_absent() {
        for (wire, raw, expected) in [
            (
                Wire::Chat,
                json!({"prompt_tokens":20,"completion_tokens":3,"prompt_tokens_details":{"cached_tokens":5}}),
                json!({"inputTokens":15,"outputTokens":3,"cacheReadTokens":5,"totalTokens":23}),
            ),
            (
                Wire::Responses,
                json!({"input_tokens":20,"output_tokens":3,"input_tokens_details":{"cached_tokens":5}}),
                json!({"inputTokens":15,"outputTokens":3,"cacheReadTokens":5,"totalTokens":23}),
            ),
            (
                Wire::Anthropic,
                json!({"input_tokens":15,"output_tokens":3,"cache_read_input_tokens":5,"cache_creation_input_tokens":2}),
                json!({"inputTokens":15,"outputTokens":3,"cacheReadTokens":5,"cacheWriteTokens":2,"totalTokens":25}),
            ),
            (
                Wire::Gemini,
                json!({"promptTokenCount":20,"cachedContentTokenCount":5,"candidatesTokenCount":3,"thoughtsTokenCount":7,"toolUsePromptTokenCount":2}),
                json!({"inputTokens":17,"outputTokens":10,"cacheReadTokens":5,"totalTokens":32}),
            ),
        ] {
            assert_eq!(normalize(wire, &raw).unwrap(), expected);
        }
        assert!(normalize(Wire::Chat, &json!({"prompt_tokens":-1})).is_err());
        assert!(
            normalize(
                Wire::Responses,
                &json!({"input_tokens":9_007_199_254_740_991u64,"output_tokens":1})
            )
            .is_err()
        );
    }
    #[test]
    fn incomplete_observations_cannot_become_known_zero_usage() {
        for (wire, raw) in [
            (Wire::Chat, json!({"total_tokens":16})),
            (Wire::Responses, json!({"input_tokens":20})),
            (Wire::Anthropic, json!({"output_tokens":3})),
            (
                Wire::Gemini,
                json!({"promptTokenCount":20,"cachedContentTokenCount":5}),
            ),
        ] {
            assert_eq!(normalize(wire, &raw).unwrap(), Value::Null);
        }
        assert!(normalize(Wire::Chat,&json!({"prompt_tokens":20,"completion_tokens":3,"cache_creation_input_tokens":null})).unwrap().get("cacheWriteTokens").is_none());
    }
}
