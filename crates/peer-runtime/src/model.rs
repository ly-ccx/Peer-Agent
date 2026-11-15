//! Wire owns request formatting and streaming. It cannot execute tools.
use crate::{CancellationToken, credentials::Secret};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::time::Duration;
mod continuation;
mod count;
pub use count::ProviderTokenCount;
mod sse;
pub use continuation::LiveHistory;
mod error;
mod sse_frame;
mod stream;
mod usage;
pub use error::{ModelError, ModelRequestObservation};
pub mod wire;
pub struct NativeModel {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    provider: String,
    secret: Option<Secret>,
    deadline: Duration,
    wire: wire::Wire,
    generation: wire::GenerationOptions,
    binding: String,
    context_window: Option<u64>,
}
/// An encoded request bound to the exact provider instance that built it.
/// Counting can borrow it; sending consumes its original immutable wire bytes.
pub struct PreparedRequest<'a> {
    owner: &'a NativeModel,
    body: Value,
    bytes: Vec<u8>,
    fingerprint: String,
}
impl PreparedRequest<'_> {
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}
pub struct ModelConfig {
    pub endpoint: String,
    pub model: String,
    pub provider: String,
    pub wire: wire::Wire,
    pub generation: wire::GenerationOptions,
}
pub struct ModelToolCall {
    pub name: String,
    pub arguments: Value,
}
pub struct ModelTurn {
    pub content: String,
    pub calls: Vec<ModelToolCall>,
    pub usage: Option<Value>,
    pub request_fingerprint: String,
    pub(crate) continuation: Option<continuation::Continuation>,
}
impl NativeModel {
    pub fn context_window(&self) -> Option<u64> {
        self.context_window
    }
    pub(crate) fn with_context_window(mut self, window: Option<u64>) -> Self {
        self.context_window = window;
        self
    }
    pub fn model_id(&self) -> &str {
        &self.model
    }
    pub fn provider(&self) -> &str {
        &self.provider
    }
    pub fn new(
        config: ModelConfig,
        secret: Option<Secret>,
        deadline: Duration,
    ) -> Result<Self, ModelError> {
        let endpoint = reqwest::Url::parse(&config.endpoint)
            .map_err(|_| ModelError::new("model_endpoint_invalid"))?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
            || (endpoint.query().is_some()
                && !(config.wire == wire::Wire::Gemini && endpoint.query() == Some("alt=sse")))
            || config.model.is_empty()
            || config.model.len() > 512
            || config.provider.is_empty()
            || config.provider.len() > 200
            || deadline.is_zero()
            || deadline > Duration::from_secs(600)
        {
            return Err(ModelError::new("model_config_invalid"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(deadline)
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|_| ModelError::new("model_transport_unavailable"))?;
        // A live cache cannot cross provider instances, even when two channels
        // share the same endpoint and model name with different credentials.
        let binding = uuid::Uuid::new_v4().to_string();
        Ok(Self {
            client,
            endpoint,
            model: config.model,
            provider: config.provider,
            secret,
            deadline,
            wire: config.wire,
            generation: config.generation,
            binding,
            context_window: None,
        })
    }
    pub async fn turn(
        &self,
        context: &str,
        history: &Value,
        tools: &Value,
        cancel: &CancellationToken,
    ) -> Result<ModelTurn, ModelError> {
        self.turn_with_history(context, history, tools, &LiveHistory::default(), cancel)
            .await
    }
    pub async fn turn_with_history(
        &self,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
        cancel: &CancellationToken,
    ) -> Result<ModelTurn, ModelError> {
        self.prepare_request(context, history, tools, live)?
            .send(cancel)
            .await
    }
    pub fn prepare_request<'a>(
        &'a self,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
    ) -> Result<PreparedRequest<'a>, ModelError> {
        if history["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["content"].is_array())
        {
            return Err(ModelError::new("native_model_images_unsupported"));
        }
        let mut messages = continuation::lower(history)?;
        live.apply(&self.binding, &mut messages);
        let body = wire::encode_runtime(
            self.wire,
            &wire::WireInput {
                model: &self.model,
                system: context,
                stable_system: None,
                messages: &messages,
                tools: tools
                    .as_array()
                    .filter(|t| self.wire != wire::Wire::Chat || !t.is_empty())
                    .map(Vec::as_slice),
                options: &self.generation,
            },
        )?;
        let bytes =
            serde_json::to_vec(&body).map_err(|_| ModelError::new("model_request_invalid"))?;
        let fingerprint = format!("{:x}", Sha256::digest(&bytes));
        Ok(PreparedRequest {
            owner: self,
            body,
            bytes,
            fingerprint,
        })
    }
    fn request_builder(
        &self,
        endpoint: reqwest::Url,
        accept: &str,
    ) -> Result<reqwest::RequestBuilder, ModelError> {
        let mut request = self
            .client
            .post(endpoint)
            .header("content-type", "application/json")
            .header("accept", accept);

        if self.wire == wire::Wire::Anthropic {
            request = request.header("anthropic-version", "2023-06-01");
        }
        if let Some(s) = &self.secret {
            let bearer = zeroize::Zeroizing::new(
                if matches!(self.wire, wire::Wire::Chat | wire::Wire::Responses) {
                    format!("Bearer {}", s.expose())
                } else {
                    s.expose().to_owned()
                },
            );
            let mut value = reqwest::header::HeaderValue::from_str(&bearer)
                .map_err(|_| ModelError::new("model_credential_invalid"))?;
            value.set_sensitive(true);
            request = request.header(
                match self.wire {
                    wire::Wire::Anthropic => "x-api-key",
                    wire::Wire::Gemini => "x-goog-api-key",
                    _ => "authorization",
                },
                value,
            )
        }
        Ok(request)
    }
}
impl PreparedRequest<'_> {
    pub async fn send(self, cancel: &CancellationToken) -> Result<ModelTurn, ModelError> {
        let model = self.owner;
        let request_fingerprint = self.fingerprint;
        let request = model
            .request_builder(model.endpoint.clone(), "text/event-stream")?
            .body(self.bytes);
        let mut stream = Some(stream::Stream::new(model.wire));
        let mut final_observation = None;
        let read = async {
            let mut response = request.send().await.map_err(|e| {
                if e.is_timeout() {
                    ModelError::new("model_timeout")
                } else {
                    ModelError::new("model_transport_failed")
                }
            })?;
            if !response.status().is_success() {
                return Err(ModelError::new("model_http_rejected"));
            }
            if !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
            {
                return Err(ModelError::new("model_content_type_invalid"));
            }
            let decoder = stream.as_mut().expect("one request decoder");
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ModelError::new("model_stream_interrupted"))?
            {
                decoder.push(&chunk)?;
                if decoder.terminal() {
                    break;
                }
            }
            final_observation = decoder.observed_usage();
            let mut turn = stream
                .take()
                .expect("one request decoder")
                .finish(request_fingerprint.clone())?;
            if let Some(c) = &mut turn.continuation {
                c.binding = model.binding.clone();
                c.text = turn.content.clone();
            }
            Ok(turn)
        };
        let result = tokio::select! {biased;_=cancel.cancelled()=>Err(ModelError::new("CANCELLED")),r=tokio::time::timeout(model.deadline,read)=>r.unwrap_or_else(|_|Err(ModelError::new("model_timeout")))};
        let observation =
            final_observation.or_else(|| stream.as_ref().and_then(stream::Stream::observed_usage));
        result.map_err(|error| error.observed(request_fingerprint, observation))
    }
}
fn decode(bytes: &[u8], max: usize) -> Result<Value, ModelError> {
    decode_json_bounded(
        bytes,
        JsonLimits {
            bytes: max,
            nodes: 16384,
            depth: 32,
            string_bytes: max,
        },
    )
    .map(|v| v.value)
    .map_err(|_| ModelError::new("model_payload_invalid"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn canonical_lowering_matches_actual_openai_compatible_encoder() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/native-context-wire.json"
        ))
        .unwrap();
        for c in f["wireCases"].as_array().unwrap() {
            assert_eq!(
                wire::encode_runtime(
                    wire::Wire::Chat,
                    &wire::WireInput {
                        model: "model",
                        system: c["context"].as_str().unwrap(),
                        stable_system: None,
                        messages: &continuation::lower(&c["history"]).unwrap(),
                        tools: c["tools"]
                            .as_array()
                            .filter(|t| !t.is_empty())
                            .map(Vec::as_slice),
                        options: &wire::GenerationOptions::default(),
                    }
                )
                .unwrap(),
                c["expected"],
                "{}",
                c["name"]
            );
        }
    }
}
