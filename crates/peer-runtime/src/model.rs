//! Wire owns request formatting and streaming. It cannot execute tools.
use crate::{CancellationToken, credentials::Secret};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::Duration;
mod sse;
pub struct OpenAiChatModel {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    model: String,
    secret: Option<Secret>,
    deadline: Duration,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelError(pub &'static str);
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for ModelError {}
pub struct ModelToolCall {
    pub name: String,
    pub arguments: Value,
}
pub struct ModelTurn {
    pub content: String,
    pub calls: Vec<ModelToolCall>,
    pub usage: Option<Value>,
    pub request_fingerprint: String,
}
/// Current P3 encoder subset: tools + canonical history, no reasoning dialect.
/// Unsupported provider/model metadata is rejected by the config adapter.
pub fn encode_chat_request(
    model: &str,
    context: &str,
    history: &Value,
    tools: &Value,
) -> Result<Value, ModelError> {
    let mut messages = vec![json!({"role":"system","content":context})];
    for message in history["messages"]
        .as_array()
        .ok_or(ModelError("history_projection_invalid"))?
    {
        let mut m = json!({"role":message["role"],"content":message["content"]});
        if let Some(id) = message.get("toolCallId") {
            m["tool_call_id"] = id.clone()
        }
        if let Some(calls) = message["toolCalls"].as_array() {
            m["tool_calls"]=json!(calls.iter().map(|c|json!({"id":c["id"],"type":"function","function":{"name":c["name"],"arguments":c["arguments"]}})).collect::<Vec<_>>())
        }
        messages.push(m);
    }
    let mut body = json!({"model":model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    if tools.as_array().is_some_and(|a| !a.is_empty()) {
        body["tools"] = tools.clone()
    }
    if serde_json::to_vec(&body)
        .map_err(|_| ModelError("model_request_invalid"))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(ModelError("model_request_limit"));
    }
    Ok(body)
}
impl OpenAiChatModel {
    pub fn model_id(&self) -> &str {
        &self.model
    }
    pub fn new(
        endpoint: &str,
        model: &str,
        secret: Option<Secret>,
        deadline: Duration,
    ) -> Result<Self, ModelError> {
        let endpoint =
            reqwest::Url::parse(endpoint).map_err(|_| ModelError("model_endpoint_invalid"))?;
        if !matches!(endpoint.scheme(), "https" | "http")
            || endpoint.host_str().is_none()
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
            || endpoint.query().is_some()
            || model.is_empty()
            || model.len() > 512
            || deadline.is_zero()
            || deadline > Duration::from_secs(600)
        {
            return Err(ModelError("model_config_invalid"));
        }
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .retry(reqwest::retry::never())
            .connect_timeout(Duration::from_secs(10))
            .read_timeout(Duration::from_secs(30))
            .timeout(deadline)
            .pool_max_idle_per_host(1)
            .build()
            .map_err(|_| ModelError("model_transport_unavailable"))?;
        Ok(Self {
            client,
            endpoint,
            model: model.into(),
            secret,
            deadline,
        })
    }
    pub async fn turn(
        &self,
        context: &str,
        history: &Value,
        tools: &Value,
        cancel: &CancellationToken,
    ) -> Result<ModelTurn, ModelError> {
        if history["messages"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|m| m["content"].is_array())
        {
            return Err(ModelError("native_model_images_unsupported"));
        }
        let body = encode_chat_request(&self.model, context, history, tools)?;
        let bytes = serde_json::to_vec(&body).map_err(|_| ModelError("model_request_invalid"))?;
        let request_fingerprint = format!("{:x}", Sha256::digest(&bytes));
        let mut request = self
            .client
            .post(self.endpoint.clone())
            .header("content-type", "application/json")
            .header("accept", "text/event-stream")
            .body(bytes);
        if let Some(s) = &self.secret {
            let bearer = zeroize::Zeroizing::new(format!("Bearer {}", s.expose()));
            let mut value = reqwest::header::HeaderValue::from_str(&bearer)
                .map_err(|_| ModelError("model_credential_invalid"))?;
            value.set_sensitive(true);
            request = request.header(reqwest::header::AUTHORIZATION, value)
        }
        let read = async {
            let mut response = request.send().await.map_err(|e| {
                if e.is_timeout() {
                    ModelError("model_timeout")
                } else {
                    ModelError("model_transport_failed")
                }
            })?;
            if !response.status().is_success() {
                return Err(ModelError("model_http_rejected"));
            }
            if !response
                .headers()
                .get(reqwest::header::CONTENT_TYPE)
                .and_then(|v| v.to_str().ok())
                .is_some_and(|v| v.split(';').next() == Some("text/event-stream"))
            {
                return Err(ModelError("model_content_type_invalid"));
            }
            let mut stream = sse::ChatStream::default();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ModelError("model_stream_interrupted"))?
            {
                stream.push(&chunk)?;
            }
            stream.finish(request_fingerprint)
        };
        tokio::select! {biased;_=cancel.cancelled()=>Err(ModelError("CANCELLED")),r=tokio::time::timeout(self.deadline,read)=>r.map_err(|_|ModelError("model_timeout"))?}
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
    .map_err(|_| ModelError("model_payload_invalid"))
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
                encode_chat_request(
                    "model",
                    c["context"].as_str().unwrap(),
                    &c["history"],
                    &c["tools"]
                )
                .unwrap(),
                c["expected"],
                "{}",
                c["name"]
            );
        }
    }
}
