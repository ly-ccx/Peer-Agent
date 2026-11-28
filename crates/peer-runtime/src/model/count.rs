//! Count the frozen encoder output, never rebuild a different canonical input.
use super::*;

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTokenCount {
    pub input_tokens: u64,
    pub source: &'static str,
    pub request_fingerprint: String,
}

fn count_endpoint(model: &NativeModel) -> Option<(reqwest::Url, &'static str)> {
    if model
        .generation
        .auth_method
        .as_deref()
        .is_some_and(|a| a != "api_key")
    {
        return None;
    }
    let mut endpoint = model.endpoint.clone();
    let (path, field) = match model.wire {
        wire::Wire::Anthropic => (
            format!(
                "{}/messages/count_tokens",
                endpoint.path().strip_suffix("/messages")?
            ),
            "input_tokens",
        ),
        wire::Wire::Gemini => {
            let prefix = endpoint.path().strip_suffix(":streamGenerateContent")?;
            if !prefix.ends_with(&format!(
                "/models/{}",
                model.model.strip_prefix("models/").unwrap_or(&model.model)
            )) {
                return None;
            }
            (format!("{prefix}:countTokens"), "totalTokens")
        }
        _ => return None,
    };
    endpoint.set_path(&path);
    endpoint.set_query(None);
    Some((endpoint, field))
}
impl NativeModel {
    pub fn supports_input_count(&self) -> bool {
        count_endpoint(self).is_some()
    }
}
impl PreparedRequest<'_> {
    fn count_request(&self) -> Option<(reqwest::Url, Value, &'static str)> {
        let (endpoint, field) = count_endpoint(self.owner)?;
        let mut body = self.body.clone();
        if self.owner.wire == wire::Wire::Anthropic {
            let fields = body.as_object_mut()?;
            fields.shift_remove("stream");
            fields.shift_remove("max_tokens");
        } else {
            body["model"] = Value::String(format!(
                "models/{}",
                self.owner
                    .model
                    .strip_prefix("models/")
                    .unwrap_or(&self.owner.model)
            ));
            body = serde_json::json!({"generateContentRequest":body});
        }
        Some((endpoint, body, field))
    }

    /// Unavailable counters remain observed-only. Count errors are advisory to
    /// generation; the accounting pipeline owns explicit degradation/recount.
    /// This request has no model-turn usage observation or execution authority.
    pub async fn count_input_tokens(
        &self,
        cancel: &CancellationToken,
    ) -> Result<Option<ProviderTokenCount>, ModelError> {
        let Some((endpoint, body, field)) = self.count_request() else {
            return Ok(None);
        };
        let bytes = serde_json::to_vec(&body)
            .map_err(|_| ModelError::new("context_count_request_invalid"))?;
        let request = self
            .owner
            .request_builder(endpoint, "application/json", cancel)
            .await?
            .body(bytes);
        let read = async {
            let mut response = request.send().await.map_err(|error| {
                ModelError::new(if error.is_timeout() {
                    "context_count_timeout"
                } else {
                    "context_count_transport_failed"
                })
            })?;
            if !response.status().is_success() {
                return Err(ModelError::new("context_count_rejected"));
            }
            if !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|h| h.to_str().ok())
                .is_some_and(|s| {
                    s.split(';')
                        .next()
                        .is_some_and(|t| t.trim().eq_ignore_ascii_case("application/json"))
                })
            {
                return Err(ModelError::new("context_count_content_type_invalid"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ModelError::new("context_count_interrupted"))?
            {
                if bytes.len().saturating_add(chunk.len()) > 16_384 {
                    return Err(ModelError::new("context_count_limit"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let payload = decode(&bytes, 16_384)
                .map_err(|_| ModelError::new("context_count_response_invalid"))?;
            let tokens = payload[field]
                .as_f64()
                .filter(|n| {
                    n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0 && n.fract() == 0.0
                })
                .ok_or(ModelError::new("context_count_response_invalid"))?
                as u64;
            Ok(Some(ProviderTokenCount {
                input_tokens: tokens,
                source: "provider_count_api",
                request_fingerprint: self.fingerprint.clone(),
            }))
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err(ModelError::new("CANCELLED")),result=tokio::time::timeout(self.owner.deadline.min(Duration::from_secs(10)),read)=>result.unwrap_or_else(|_|Err(ModelError::new("context_count_timeout")))}
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn count_payloads_match_the_actual_current_ts_adapters() {
        let fixtures: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-counts.json"
        ))
        .unwrap();
        for case in fixtures["cases"].as_array().unwrap() {
            let wire: wire::Wire = serde_json::from_value(case["wire"].clone()).unwrap();
            let input = &case["input"];
            let model = NativeModel::new(
                ModelConfig {
                    endpoint: if wire == wire::Wire::Anthropic {
                        "https://count.invalid/v1/messages".into()
                    } else {
                        format!(
                            "https://count.invalid/v1beta/models/{}:streamGenerateContent?alt=sse",
                            input["model"].as_str().unwrap()
                        )
                    },
                    model: input["model"].as_str().unwrap().into(),
                    provider: "fixture".into(),
                    wire,
                    generation: serde_json::from_value(input.clone()).unwrap(),
                },
                None,
                Duration::from_secs(2),
            )
            .unwrap();
            let body = wire::encode(
                wire,
                &wire::WireInput {
                    model: &model.model,
                    system: input["system"].as_str().unwrap(),
                    stable_system: input["stableSystem"].as_str(),
                    messages: input["messages"].as_array().unwrap(),
                    tools: input["tools"].as_array().map(Vec::as_slice),
                    options: &model.generation,
                },
            )
            .unwrap();
            let bytes = serde_json::to_vec(&body).unwrap();
            let fingerprint = format!("{:x}", Sha256::digest(&bytes));
            let request = PreparedRequest {
                owner: &model,
                body,
                bytes: bytes.into(),
                fingerprint,
            };
            assert_eq!(
                request.count_request().unwrap().1,
                case["expected"],
                "{}",
                case["name"]
            );
        }
    }
}
