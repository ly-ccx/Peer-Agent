//! OpenCode Go's model routing and declared reasoning profile adapter.
//! Only the declaration outputs are embedded; no JS code runs in this module.
use crate::model::{ModelError, wire::Wire};
use serde_json::{Value, json};
use std::sync::OnceLock;

fn data() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/model-go-registry.json"
        ))
        .expect("verified Go channel contract")
    })
}
pub(super) fn normalize(id: &str) -> &str {
    match id {
        "opencode-go-openai" | "opencode-go-anthropic" => "opencode-go",
        _ => id,
    }
}
pub(super) fn wire(model: &str) -> &'static str {
    let id = model.trim().to_lowercase();
    if id.contains("luna") {
        "openai-responses"
    } else if id.contains("claude")
        || id.contains("anthropic")
        || id.contains("minimax")
        || id.starts_with("qwen")
        || id.contains("qwen3")
    {
        "anthropic-messages"
    } else {
        "openai-chat"
    }
}
pub(super) fn base_url(wire: Wire, configured: &str, default: &str) -> String {
    let configured = configured.trim().trim_end_matches('/');
    let raw = if configured.is_empty() {
        default
    } else {
        configured
    };
    let lower = raw.to_ascii_lowercase();
    if wire == Wire::Anthropic && lower.ends_with("/zen/go/v1") {
        raw[..raw.len() - 3].into()
    } else if wire != Wire::Anthropic && lower.ends_with("/zen/go") {
        format!("{raw}/v1")
    } else {
        raw.into()
    }
}
pub(super) fn reasoning(wire: &str, model: &str, flat: &Value) -> Result<Value, ModelError> {
    let mut map = serde_json::Map::new();
    let mut levels = vec![];
    if let Some(values) = flat["reasoningEffortValues"].as_array() {
        for value in values {
            let value = value
                .as_str()
                .ok_or(ModelError::new("model_generation_invalid"))?
                .trim()
                .to_lowercase();
            if value.is_empty() {
                continue;
            }
            let level = if matches!(value.as_str(), "none" | "minimal") {
                "off"
            } else {
                &value
            };
            if !map.contains_key(level) {
                levels.push(level.to_owned());
                map.insert(level.into(), json!(value));
            }
        }
    }
    if !levels.is_empty() {
        return Ok(
            json!({"supported":true,"paramStyle":"openai-effort","defaultEffort":if levels.iter().any(|v|v=="default"){"default"}else{&levels[0]},"effortLevels":levels,"effortMap":map}),
        );
    }
    Ok(data()["profiles"]
        .get(model.trim().to_lowercase())
        .unwrap_or(&data()["defaults"][wire])
        .clone())
}
pub(super) fn headers(
    wire: Wire,
    flat: &Value,
) -> Result<serde_json::Map<String, Value>, ModelError> {
    let mut headers = if wire == Wire::Anthropic {
        data()["anthropicHeaders"].as_object().unwrap().clone()
    } else {
        serde_json::Map::new()
    };
    let explicit = flat["sessionId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or_else(|| flat["conversationId"].as_str())
        .unwrap_or("")
        .trim();
    if explicit.len() > 1024 {
        return Err(ModelError::new("model_header_limit"));
    }
    let session = if explicit.is_empty() {
        format!("peer-{}", uuid::Uuid::new_v4())
    } else {
        explicit.to_owned()
    };
    headers.insert(
        data()["sessionHeader"].as_str().unwrap().into(),
        json!(session),
    );
    Ok(headers)
}
