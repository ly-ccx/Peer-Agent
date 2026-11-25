//! Wire owns request formatting and streaming. It cannot execute tools.
use crate::{CancellationToken, credentials::Secret};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{sync::Arc, time::Duration};
mod authentication;
mod observation;
pub(crate) use observation::ModelObservation;
mod continuation;
pub(crate) use continuation::Continuation as ModelContinuation;
mod media;
mod tool_results;
pub(crate) use tool_results::ToolResultEncoding;
mod count;
mod grok;
pub(crate) mod qoder_retry;
mod retry_seed;
pub use count::ProviderTokenCount;
const TOOL_ARGUMENT_BYTES: usize = 1024 * 1024;
mod sse;
pub use continuation::LiveHistory;
mod error;
mod sse_frame;
mod stream;
mod usage;
pub use error::{ModelError, ModelRequestObservation};
pub mod wire;
pub(crate) use wire::REQUEST_BYTES;
#[derive(Clone)]
pub struct NativeModel {
    network: Arc<crate::network::Network>,
    endpoint: reqwest::Url,
    model: String,
    provider: String,
    authentication: Arc<authentication::Access>,
    deadline: Duration,
    wire: wire::Wire,
    generation: wire::GenerationOptions,
    binding: String,
    context_window: Option<u64>,
    headers: reqwest::header::HeaderMap,
    compatibility: Option<Arc<grok::Compatibility>>,
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
    pub thinking: String,
    pub calls: Vec<ModelToolCall>,
    pub usage: Option<Value>,
    pub request_fingerprint: String,
    pub(crate) continuation: Option<continuation::Continuation>,
}

impl ModelTurn {
    /// Parse normalized provider usage quantities into canonical `UsageAmounts`.
    pub fn usage_amounts(&self) -> Option<peer_protocol::UsageAmounts> {
        self.usage
            .as_ref()
            .filter(|v| !v.is_null())
            .and_then(|v| serde_json::from_value(v.clone()).ok())
    }
}

pub enum ModelDelta<'a> {
    Text(&'a str),
    Thinking(&'a str),
}

pub const SAME_PROVIDER_RETRY_DELAYS_MS: [u64; 3] = [500, 1_500, 3_000];

/// Bounded same-provider transient backoff policy (ADR 30) unifying generic HTTP/transport
/// retries (`[500, 1500, 3000]ms`) and Qoder-specific retry hints.
pub struct SameProviderRetryPolicy {
    qoder: qoder_retry::Policy,
    delays_ms: Vec<u64>,
    generic_attempts: usize,
}

impl Default for SameProviderRetryPolicy {
    fn default() -> Self {
        Self::with_delays_ms(SAME_PROVIDER_RETRY_DELAYS_MS.to_vec())
    }
}

impl SameProviderRetryPolicy {
    pub fn with_delays_ms(delays_ms: Vec<u64>) -> Self {
        Self {
            qoder: qoder_retry::Policy::default(),
            delays_ms,
            generic_attempts: 0,
        }
    }

    pub fn next_delay(&mut self, error: &ModelError) -> Result<Option<Duration>, &'static str> {
        if error.retry.is_some() {
            return self.qoder.next(error).map_err(|e| e.code);
        }
        if error.is_transient_retryable()
            && let Some(&ms) = self.delays_ms.get(self.generic_attempts)
        {
            self.generic_attempts += 1;
            return Ok(Some(Duration::from_millis(ms)));
        }
        Ok(None)
    }
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
        if let Some(oauth) = oauth {
            self.authentication = Arc::new(authentication::Access::OAuth(Box::new(oauth)));
        }
        self
    }
    pub(crate) fn with_qoder(mut self, account: Option<crate::qoder::account::Account>) -> Self {
        if let Some(account) = account {
            self.authentication = Arc::new(authentication::Access::Qoder(Box::new(account)));
        }
        self
    }
    pub(crate) fn with_compatibility(
        mut self,
        home: &std::path::Path,
        auth: &str,
    ) -> Result<Self, ModelError> {
        if auth == "oauth_grok" {
            self.compatibility = Some(Arc::new(grok::Compatibility::new(home)?));
        }
        Ok(self)
    }
    pub(crate) fn validate_saved_media(&self, history: &Value) -> Result<(), ModelError> {
        media::admit(history, self.wire)
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
                && !(config.wire == wire::Wire::Gemini && endpoint.query() == Some("alt=sse"))
                && !(config.wire == wire::Wire::Qoder
                    && endpoint.query()
                        == Some("FetchKeys=llm_model_result&AgentId=agent_common&Encode=1")))
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
            network: Arc::new(network),
            endpoint,
            model: config.model,
            provider: config.provider,
            authentication: Arc::new(authentication::Access::from_key(secret)),
            deadline,
            wire: config.wire,
            generation: config.generation,
            binding,
            context_window: None,
            headers: reqwest::header::HeaderMap::new(),
            compatibility: None,
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
    /// Run a model turn that materializes oversized tool results (> 6000 UTF-16 chars)
    /// into `<home>/conversations/<conversation_id>.tool-results/` before wire encoding,
    /// matching `ContextPipeline::result_views`, while forwarding streaming text/thinking deltas.
    #[allow(clippy::too_many_arguments)]
    pub async fn turn_with_materialized_history_and_deltas(
        &self,
        home: &std::path::Path,
        conversation_id: &str,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
        cancel: &CancellationToken,
        publish: impl std::ops::AsyncFnMut(ModelDelta<'_>) -> Result<(), ModelError>,
    ) -> Result<ModelTurn, ModelError> {
        let sources = ToolResultEncoding::collect(history)?;
        let home_buf = home.to_path_buf();
        let conv = conversation_id.to_owned();
        let mat_cancel = cancel.clone();
        let encoding =
            tokio::task::spawn_blocking(move || sources.materialize(&home_buf, &conv, &mat_cancel))
                .await
                .map_err(|_| ModelError::new("model_tool_result_encoding_unavailable"))??;
        self.prepare_request_with_tool_results(context, history, tools, live, &encoding)?
            .send_with_deltas(cancel, publish)
            .await
    }
    /// Run a model turn that materializes oversized tool results (> 6000 UTF-16 chars)
    /// into `<home>/conversations/<conversation_id>.tool-results/` before wire encoding,
    /// matching `ContextPipeline::result_views`.
    #[allow(clippy::too_many_arguments)]
    pub async fn turn_with_materialized_history(
        &self,
        home: &std::path::Path,
        conversation_id: &str,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
        cancel: &CancellationToken,
    ) -> Result<ModelTurn, ModelError> {
        self.turn_with_materialized_history_and_deltas(
            home,
            conversation_id,
            context,
            history,
            tools,
            live,
            cancel,
            async |_: ModelDelta<'_>| Ok(()),
        )
        .await
    }
    pub fn prepare_request<'a>(
        &'a self,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
    ) -> Result<PreparedRequest<'a>, ModelError> {
        let encoding = ToolResultEncoding::collect(history)?.inline()?;
        self.prepare_request_with_tool_results(context, history, tools, live, &encoding)
    }
    pub(crate) fn prepare_request_with_tool_results<'a>(
        &'a self,
        context: &str,
        history: &Value,
        tools: &Value,
        live: &LiveHistory,
        encoding: &ToolResultEncoding,
    ) -> Result<PreparedRequest<'a>, ModelError> {
        media::admit(history, self.wire)?;
        let mut messages = continuation::lower(history)?;
        live.apply(&self.binding, &mut messages);
        encoding.apply_lowered(&mut messages)?;
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
        self.freeze(body)
    }
    async fn request_builder(
        &self,
        endpoint: reqwest::Url,
        accept: &str,
        cancel: &CancellationToken,
        prepared: Option<(&Value, &[u8])>,
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
        let client = self
            .network
            .prepare(&endpoint, cancel)
            .await
            .map_err(|e| ModelError::new(e.0))?
            .builder
            .connect_timeout(Duration::from_secs(15).min(self.deadline))
            .read_timeout(self.deadline)
            .build()
            .map_err(|_| ModelError::new("model_transport_unavailable"))?;
        headers.insert(
            "connection",
            reqwest::header::HeaderValue::from_static("close"),
        );
        self.authentication
            .apply(&mut headers, self.wire, prepared, cancel)
            .await?;
        Ok(client.post(endpoint).headers(headers))
    }
}
impl PreparedRequest<'_> {
    pub async fn send(self, cancel: &CancellationToken) -> Result<ModelTurn, ModelError> {
        self.send_with_deltas(cancel, async |_: ModelDelta<'_>| Ok(()))
            .await
    }

    /// Observe only newly decoded assistant text and reasoning deltas.
    /// The terminal validation below still controls the returned turn and all tool intent.
    pub(crate) async fn send_with_deltas(
        self,
        cancel: &CancellationToken,
        mut publish: impl std::ops::AsyncFnMut(ModelDelta<'_>) -> Result<(), ModelError>,
    ) -> Result<ModelTurn, ModelError> {
        let model = self.owner;
        let request_fingerprint = self.fingerprint;
        let mut stream = Some(stream::Stream::new(model.wire));
        let mut final_observation = None;
        let read = async {
            let send_request = async {
                match &model.compatibility {
                    Some(adapter) => adapter.send(model, &self.bytes, cancel).await,
                    None => model
                        .request_builder(
                            model.endpoint.clone(),
                            "text/event-stream",
                            cancel,
                            Some((&self.body, &self.bytes)),
                        )
                        .await?
                        .body(self.bytes)
                        .send()
                        .await
                        .map_err(|e| {
                            let mut error = ModelError::new(if e.is_timeout() {
                                "model_timeout"
                            } else {
                                "model_transport_failed"
                            });
                            if model.wire == wire::Wire::Qoder
                                && (e.is_connect() || e.is_request() || e.is_timeout())
                            {
                                error.retry = Some(qoder_retry::Hint::Connection);
                            }
                            error
                        }),
                }
            };
            let mut response = tokio::time::timeout(model.deadline, send_request)
                .await
                .map_err(|_| {
                    let mut error = ModelError::new("model_timeout");
                    if model.wire == wire::Wire::Qoder {
                        error.retry = Some(qoder_retry::Hint::Connection);
                    }
                    error
                })??;
            if !response.status().is_success() {
                let status = response.status().as_u16();
                // The status is sufficient for access rejection. An error body
                // cannot turn it into context pressure or a retry.
                if let Some(error) = ModelError::http_access_rejection(status) {
                    return Err(error);
                }
                let mut body = Vec::new();
                while let Some(chunk) = tokio::time::timeout(model.deadline, response.chunk())
                    .await
                    .map_err(|_| ModelError::new("model_timeout"))?
                    .map_err(|e| {
                        ModelError::new(if e.is_timeout() {
                            "model_timeout"
                        } else {
                            "model_transport_failed"
                        })
                    })?
                {
                    if body.len() + chunk.len() > 65536 {
                        return Err(ModelError::new("model_error_body_limit"));
                    }
                    body.extend_from_slice(&chunk);
                }
                return Err(if model.wire == wire::Wire::Qoder {
                    qoder_retry::http(status, &body)
                } else {
                    ModelError::http(status, &body)
                });
            }
            if !sse_content_type_allowed(response.headers()) {
                return Err(ModelError::new("model_content_type_invalid"));
            }
            let decoder = stream.as_mut().expect("one request decoder");
            let mut shown = 0;
            let mut shown_thinking = 0;
            while let Some(chunk) = tokio::time::timeout(model.deadline, response.chunk())
                .await
                .map_err(|_| ModelError::new("model_timeout"))?
                .map_err(|e| {
                    let mut error = ModelError::new(if e.is_timeout() {
                        "model_timeout"
                    } else {
                        "model_stream_interrupted"
                    });
                    if model.wire == wire::Wire::Qoder && !e.is_timeout() {
                        error.retry = Some(qoder_retry::Hint::Transient);
                    }
                    error
                })?
            {
                decoder.push(&chunk)?;
                let thinking = decoder.preview_thinking();
                if thinking.len() > shown_thinking {
                    publish(ModelDelta::Thinking(&thinking[shown_thinking..])).await?;
                    shown_thinking = thinking.len();
                }
                let text = decoder.preview_text();
                if text.len() > shown {
                    publish(ModelDelta::Text(&text[shown..])).await?;
                    shown = text.len();
                }
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
        let result = tokio::select! {biased;_=cancel.cancelled()=>Err(ModelError::new("CANCELLED")),r=read=>r};
        let observation =
            final_observation.or_else(|| stream.as_ref().and_then(stream::Stream::observed_usage));
        result.map_err(|error| error.observed(request_fingerprint, observation))
    }
}
fn sse_content_type_allowed(headers: &reqwest::header::HeaderMap) -> bool {
    let Some(raw) = headers.get(reqwest::header::CONTENT_TYPE) else {
        return true;
    };
    let Ok(value) = raw.to_str() else {
        return false;
    };
    matches!(
        value
            .split(';')
            .next()
            .map(|s| s.trim().to_ascii_lowercase())
            .as_deref(),
        Some("text/event-stream" | "text/plain" | "application/octet-stream" | "")
    )
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
    fn sse_content_type_check_allows_missing_and_sse_proxies_only() {
        let empty = reqwest::header::HeaderMap::new();
        assert!(sse_content_type_allowed(&empty));

        for ok in [
            "text/event-stream",
            "text/event-stream; charset=utf-8",
            "TEXT/EVENT-STREAM",
            "text/plain;charset=UTF-8",
            "application/octet-stream",
        ] {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(reqwest::header::CONTENT_TYPE, ok.parse().unwrap());
            assert!(sse_content_type_allowed(&h), "expected allowed: {ok}");
        }

        for bad in ["text/html", "application/json", "application/xml"] {
            let mut h = reqwest::header::HeaderMap::new();
            h.insert(reqwest::header::CONTENT_TYPE, bad.parse().unwrap());
            assert!(!sse_content_type_allowed(&h), "expected rejected: {bad}");
        }
    }

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

    #[test]
    fn same_provider_retry_policy_retries_transient_only_and_bounds_attempts() {
        let mut policy = SameProviderRetryPolicy::default();
        assert_eq!(
            policy
                .next_delay(&ModelError::http(503, b"service unavailable"))
                .unwrap(),
            Some(Duration::from_millis(500))
        );
        assert_eq!(
            policy
                .next_delay(&ModelError::http(429, b"rate limit"))
                .unwrap(),
            Some(Duration::from_millis(1500))
        );
        assert_eq!(
            policy
                .next_delay(&ModelError::new("model_timeout"))
                .unwrap(),
            Some(Duration::from_millis(3000))
        );
        assert_eq!(
            policy
                .next_delay(&ModelError::http(500, b"internal error"))
                .unwrap(),
            None
        );

        let mut non_retry = SameProviderRetryPolicy::default();
        assert_eq!(
            non_retry
                .next_delay(&ModelError::http_access_rejection(401).unwrap())
                .unwrap(),
            None
        );
        assert_eq!(
            non_retry
                .next_delay(&ModelError::http(400, b"bad request"))
                .unwrap(),
            None
        );
        assert_eq!(
            non_retry
                .next_delay(&ModelError::http(413, b"context_length_exceeded"))
                .unwrap(),
            None
        );
        assert_eq!(
            non_retry.next_delay(&ModelError::new("CANCELLED")).unwrap(),
            None
        );
    }
}
