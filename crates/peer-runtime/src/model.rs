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
    network: crate::network::Network,
    endpoint: reqwest::Url,
    model: String,
    provider: String,
    secret: Option<Secret>,
    deadline: Duration,
    wire: wire::Wire,
    generation: wire::GenerationOptions,
    binding: String,
    context_window: Option<u64>,
    headers: reqwest::header::HeaderMap,
    oauth: Option<crate::model_oauth::ModelOAuth>,
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
    pub(crate) fn with_headers(mut self, headers: reqwest::header::HeaderMap) -> Self {
        self.headers = headers;
        self
    }
    pub(crate) fn with_oauth(mut self, oauth: Option<crate::model_oauth::ModelOAuth>) -> Self {
        self.oauth = oauth;
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
        let network = crate::network::Network::new().map_err(|e| ModelError::new(e.0))?;
        // A live cache cannot cross provider instances, even when two channels
        // share the same endpoint and model name with different credentials.
        let binding = uuid::Uuid::new_v4().to_string();
        Ok(Self {
            network,
            endpoint,
            model: config.model,
            provider: config.provider,
            secret,
            deadline,
            wire: config.wire,
            generation: config.generation,
            binding,
            context_window: None,
            headers: reqwest::header::HeaderMap::new(),
            oauth: None,
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
    async fn request_builder(
        &self,
        endpoint: reqwest::Url,
        accept: &str,
        cancel: &CancellationToken,
    ) -> Result<reqwest::RequestBuilder, ModelError> {
        let mut headers = self.headers.clone();
        headers.insert(
            "content-type",
            reqwest::header::HeaderValue::from_static("application/json"),
        );
        if !headers.contains_key("accept") {
            headers.insert(
                "accept",
                reqwest::header::HeaderValue::from_str(accept)
                    .map_err(|_| ModelError::new("model_header_invalid"))?,
            );
        }
        if self.wire == wire::Wire::Anthropic {
            headers.insert(
                "anthropic-version",
                reqwest::header::HeaderValue::from_static("2023-06-01"),
            );
        }
        let oauth = match &self.oauth {
            Some(oauth) => Some(oauth.access(cancel).await?),
            None => None,
        };
        if let Some(account) = oauth.as_ref().and_then(|v| v.account.as_ref()) {
            if account.len() > 512 {
                return Err(ModelError::new("model_oauth_account_invalid"));
            }
            let mut value = reqwest::header::HeaderValue::from_str(account)
                .map_err(|_| ModelError::new("model_oauth_account_invalid"))?;
            value.set_sensitive(true);
            if self.wire == wire::Wire::Responses {
                headers.insert("chatgpt-account-id", value);
            }
        }
        if let Some(s) = oauth.as_ref().map(|v| &v.secret).or(self.secret.as_ref()) {
            let bearer = zeroize::Zeroizing::new(
                if oauth.is_some() || matches!(self.wire, wire::Wire::Chat | wire::Wire::Responses)
                {
                    format!("Bearer {}", s.expose())
                } else {
                    s.expose().to_owned()
                },
            );
            let mut value = reqwest::header::HeaderValue::from_str(&bearer)
                .map_err(|_| ModelError::new("model_credential_invalid"))?;
            value.set_sensitive(true);
            headers.insert(
                if oauth.is_some() {
                    "authorization"
                } else {
                    match self.wire {
                        wire::Wire::Anthropic => "x-api-key",
                        wire::Wire::Gemini => "x-goog-api-key",
                        _ => "authorization",
                    }
                },
                value,
            );
        }
        let client = self
            .network
            .builder(&endpoint, cancel)
            .await
            .map_err(|e| ModelError::new(e.0))?
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(self.deadline)
            .build()
            .map_err(|_| ModelError::new("model_transport_unavailable"))?;
        headers.insert(
            "connection",
            reqwest::header::HeaderValue::from_static("close"),
        );
        Ok(client.post(endpoint).headers(headers))
    }
}
impl PreparedRequest<'_> {
    pub async fn send(self, cancel: &CancellationToken) -> Result<ModelTurn, ModelError> {
        let model = self.owner;
        let request_fingerprint = self.fingerprint;
        let request = model
            .request_builder(model.endpoint.clone(), "text/event-stream", cancel)
            .await?
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
                let status = response.status().as_u16();
                let mut body = Vec::new();
                while let Some(chunk) = response
                    .chunk()
                    .await
                    .map_err(|_| ModelError::new("model_transport_failed"))?
                {
                    if body.len() + chunk.len() > 65536 {
                        return Err(ModelError::new("model_error_body_limit"));
                    }
                    body.extend_from_slice(&chunk);
                }
                return Err(ModelError::http(status, &body));
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
