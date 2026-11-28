//! Channel data selects a wire; wire implementations own request dialects.
//! This module never loads credentials, dispatches a request, or grants tools.
use crate::model::{
    ModelError,
    wire::{GenerationOptions, Wire},
};
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::{Value, json};
use std::sync::OnceLock;
mod go;

pub(super) struct Channel {
    pub wire: Wire,
    pub endpoint: String,
    pub provider: String,
    pub generation: GenerationOptions,
    pub headers: HeaderMap,
    pub context_window_override: Option<u64>,
}
fn registry() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-channel-registry.json"
        ))
        .expect("verified channel contract")
    })
}
fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().filter(|s| !s.is_empty())
}
fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
fn normalized_map(v: &Value) -> Option<Value> {
    let mut map = serde_json::Map::new();
    for (name, value) in v.as_object()? {
        let name = name.trim();
        if name.is_empty() {
            continue;
        }
        let value = match value {
            Value::String(s) if !s.trim().is_empty() => json!(s.trim()),
            Value::Number(_) => value.clone(),
            _ => continue,
        };
        map.insert(name.into(), value);
    }
    (!map.is_empty()).then_some(Value::Object(map))
}
fn insert_header(headers: &mut HeaderMap, name: &str, value: &str) -> Result<(), ModelError> {
    let name = HeaderName::from_bytes(name.as_bytes())
        .map_err(|_| ModelError::new("model_header_invalid"))?;
    let value = if let Some(existing) = headers.get(&name) {
        format!(
            "{}, {value}",
            existing
                .to_str()
                .map_err(|_| ModelError::new("model_header_invalid"))?
        )
    } else {
        value.into()
    };
    let mut value =
        HeaderValue::from_str(&value).map_err(|_| ModelError::new("model_header_invalid"))?;
    // Custom headers can themselves contain credentials. Debug formatting must
    // never reveal them, including headers not named Authorization.
    value.set_sensitive(true);
    headers.insert(name, value);
    Ok(())
}
fn headers(
    descriptor: &Value,
    flat: &Value,
    wire: Wire,
    is_go: bool,
    auth: &str,
) -> Result<HeaderMap, ModelError> {
    // JS object merging replaces exact spelling first; the HTTP Headers seam
    // then combines distinct spellings of one case-insensitive name.
    let mut raw = serde_json::Map::new();
    if wire == Wire::Responses {
        raw.insert("OpenAI-Beta".into(), json!("responses=experimental"));
    }
    if wire == Wire::Anthropic {
        raw.insert("anthropic-version".into(), json!("2023-06-01"));
    }
    for (name, value) in descriptor["headers"].as_object().into_iter().flatten() {
        raw.insert(name.clone(), value.clone());
    }
    if let Some(provider) = crate::model_oauth::provider(auth) {
        for (name, value) in provider["headers"].as_object().into_iter().flatten() {
            raw.insert(name.clone(), value.clone());
        }
    }
    if is_go {
        raw.extend(go::headers(wire, flat)?);
    }
    let empty = json!({});
    let custom = flat
        .get("customHeaders")
        .filter(|v| !v.is_null())
        .unwrap_or(&empty)
        .as_object()
        .ok_or(ModelError::new("model_header_invalid"))?;
    let mut bytes = 0usize;
    if custom.len() > 32 {
        return Err(ModelError::new("model_header_limit"));
    }
    for (name, value) in custom {
        let normalized = name.trim().to_ascii_lowercase();
        if registry()["protectedHeaders"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v == &normalized)
            || matches!(
                normalized.as_str(),
                "host"
                    | "content-length"
                    | "transfer-encoding"
                    | "connection"
                    | "te"
                    | "trailer"
                    | "upgrade"
                    | "proxy-authorization"
                    | "proxy-connection"
            )
        {
            return Err(ModelError::new("model_header_protected"));
        }
        // Validate names even for empty/null values, as the existing registry does.
        HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| ModelError::new("model_header_invalid"))?;
        if value.is_null() || value == "" {
            continue;
        }
        let value = match value {
            Value::String(s) => s.clone(),
            Value::Number(_) | Value::Bool(_) => value.to_string(),
            _ => return Err(ModelError::new("model_header_invalid")),
        };
        bytes += name.len() + value.len();
        if value.len() > 8192 || bytes > 32768 {
            return Err(ModelError::new("model_header_limit"));
        }
        raw.insert(name.clone(), json!(value));
    }
    let mut headers = HeaderMap::new();
    for (name, value) in raw {
        insert_header(
            &mut headers,
            &name,
            value
                .as_str()
                .ok_or(ModelError::new("model_header_invalid"))?,
        )?;
    }
    Ok(headers)
}
fn descriptor(flat: &Value) -> Result<(&str, &'static Value), ModelError> {
    let provider = text(flat, "channelId")
        .unwrap_or_else(|| {
            if flat["provider"] == "anthropic" {
                "anthropic"
            } else {
                "openai-compatible"
            }
        })
        .trim();
    let provider = go::normalize(provider);
    let d = registry()["descriptors"]
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == provider)
        .ok_or(ModelError::new("native_model_channel_unsupported"))?;
    Ok((provider, d))
}
fn auth_method<'a>(flat: &'a Value, d: &Value) -> Result<&'a str, ModelError> {
    let auth = text(flat, "authMethod").unwrap_or("api_key");
    if (auth != "api_key" && crate::model_oauth::provider(auth).is_none())
        || d["authMethods"][auth].is_null()
    {
        return Err(ModelError::new("native_model_auth_unsupported"));
    }
    Ok(auth)
}
pub(super) fn account_auth(flat: &Value) -> Result<String, ModelError> {
    let (_, d) = descriptor(flat)?;
    let auth = auth_method(flat, d)?;
    if crate::model_oauth::provider(auth).is_none() {
        return Err(ModelError::new("native_model_auth_unsupported"));
    }
    Ok(auth.into())
}
pub(super) fn resolve(flat: &Value, selected: &Value) -> Result<Channel, ModelError> {
    let (provider, d) = descriptor(flat)?;
    let is_go = provider == "opencode-go";
    let auth = auth_method(flat, d)?;
    let oauth = crate::model_oauth::provider(auth);
    let model = text(flat, "model").ok_or(ModelError::new("model_selection_invalid"))?;
    let wire_name = text(flat, "wireOverride")
        .or_else(|| text(flat, "wire"))
        .or_else(|| is_go.then(|| go::wire(model)))
        .or_else(|| text(&d["authMethods"][auth], "wire"))
        .or_else(|| text(d, "defaultWire"))
        .ok_or(ModelError::new("native_model_channel_unsupported"))?;
    if oauth.is_some() && wire_name != d["authMethods"][auth]["wire"].as_str().unwrap() {
        return Err(ModelError::new("native_model_channel_unsupported"));
    }
    if !d["allowedWires"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v == wire_name)
    {
        return Err(ModelError::new("native_model_channel_unsupported"));
    }
    let wire: Wire = serde_json::from_value(json!(wire_name))
        .map_err(|_| ModelError::new("native_model_channel_unsupported"))?;
    let base = oauth
        .and_then(|v| v["baseUrl"].as_str())
        .or_else(|| text(flat, "baseUrl"))
        .or_else(|| text(&d["defaults"], "baseUrl"))
        .ok_or(ModelError::new("model_endpoint_invalid"))?
        .trim_end_matches('/');
    let base = if is_go {
        go::base_url(wire, base, d["defaults"]["baseUrl"].as_str().unwrap())
    } else {
        base.into()
    };
    let endpoint = match wire {
        Wire::Chat => format!("{base}/chat/completions"),
        Wire::Responses => format!("{base}/responses"),
        Wire::Anthropic => format!("{base}/v1/messages"),
        Wire::Gemini => {
            let model = model.strip_prefix("models/").unwrap_or(model);
            if model.is_empty() || model.contains(['?', '#', '\\', '/', '%']) {
                return Err(ModelError::new("model_selection_invalid"));
            }
            format!("{base}/models/{model}:streamGenerateContent?alt=sse")
        }
    };
    let mut reasoning = if is_go {
        go::reasoning(wire_name, model, flat)?
    } else {
        d["capabilities"]["reasoning"].clone()
    };
    if !is_go && let Some(value) = flat.get("supportsReasoning") {
        reasoning["supported"] = json!(truthy(value));
        if !truthy(value) {
            reasoning["paramStyle"] = json!("none");
        }
    }
    if !is_go && let Some(style) = text(flat, "reasoningParamStyle") {
        reasoning["paramStyle"] = json!(style);
        reasoning["supported"] = json!(style != "none");
    }
    let effort = selected["reasoningEffort"].as_str().unwrap_or("default");
    if effort.len() > 64 {
        return Err(ModelError::new("model_generation_invalid"));
    }
    let generation = GenerationOptions {
        effort: effort.into(),
        supports_reasoning: reasoning["supported"] == true,
        reasoning_param_style: text(&reasoning, "paramStyle").map(str::to_owned),
        reasoning_effort_map: if is_go {
            reasoning.get("effortMap").cloned()
        } else {
            normalized_map(&flat["reasoningEffortMap"])
                .or_else(|| reasoning.get("effortMap").cloned())
        },
        // null is undeclared metadata, not a user request to disable caching.
        prompt_caching: Some(
            flat.get("supportsPromptCaching")
                .filter(|v| !v.is_null())
                .map(truthy)
                .unwrap_or(d["capabilities"]["promptCache"] != false),
        ),
        max_output_tokens: flat["maxOutputTokens"].as_f64(),
        fast_mode: selected["fastMode"] == true,
        auth_method: oauth.is_some().then(|| auth.to_owned()),
        omit_max_output_tokens: matches!(auth, "oauth_chatgpt" | "oauth_grok"),
        ..GenerationOptions::default()
    };
    Ok(Channel {
        wire,
        endpoint,
        provider: provider.into(),
        generation,
        headers: headers(d, flat, wire, is_go, auth)?,
        context_window_override: crate::model_oauth::context_window(
            auth,
            model,
            &flat["modelOptionValues"],
        )?,
    })
}
