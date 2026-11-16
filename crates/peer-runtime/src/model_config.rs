//! Read-only adapter for existing v2 channel/model configuration and Helper v1.
//! Unsupported dialect/auth/legacy secrets fail before any model dispatch.
use crate::{
    CancellationToken,
    credentials::HelperClient,
    model::{
        ModelConfig, ModelError, NativeModel,
        wire::{GenerationOptions, Wire},
    },
};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use std::{io::Read, path::Path, time::Duration};
mod channel;
fn read(path: &Path) -> Result<Value, ModelError> {
    let mut f =
        std::fs::File::open(path).map_err(|_| ModelError::new("model_config_unavailable"))?;
    let before = f
        .metadata()
        .map_err(|_| ModelError::new("model_config_unavailable"))?;
    let mut bytes = Vec::new();
    f.by_ref()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ModelError::new("model_config_unavailable"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(ModelError::new("model_config_limit"));
    }
    let after = std::fs::metadata(path).map_err(|_| ModelError::new("model_config_changed"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.len() != after.len()
        {
            return Err(ModelError::new("model_config_changed"));
        }
    }
    decode_json_bounded(
        &bytes,
        JsonLimits {
            bytes: 1024 * 1024,
            nodes: 16384,
            depth: 32,
            string_bytes: 1024 * 1024,
        },
    )
    .map(|v| v.value)
    .map_err(|_| ModelError::new("model_config_invalid"))
}
pub struct ResolvedNativeModel {
    pub context_window: Option<u64>,
    pub endpoint: String,
    pub model: String,
    pub credential_key: String,
    pub key_configured: bool,
    pub wire: Wire,
    pub provider: String,
    pub generation: GenerationOptions,
    pub headers: reqwest::header::HeaderMap,
}
pub fn resolve_model(config: &Value, selected: &Value) -> Result<ResolvedNativeModel, ModelError> {
    if config["version"] != 2 {
        return Err(ModelError::new("native_legacy_model_config_unsupported"));
    }
    let id = selected["modelProviderId"]
        .as_str()
        .ok_or(ModelError::new("model_selection_invalid"))?;
    let models = config["models"]
        .as_array()
        .ok_or(ModelError::new("model_config_invalid"))?;
    let matches: Vec<_> = models.iter().filter(|m| m["id"] == id).collect();
    if matches.len() != 1 {
        return Err(ModelError::new("model_selection_unavailable"));
    }
    let m = matches[0];
    let group = m["groupId"]
        .as_str()
        .ok_or(ModelError::new("model_config_invalid"))?;
    let channels = config["channels"]
        .as_array()
        .ok_or(ModelError::new("model_config_invalid"))?;
    let matches: Vec<_> = channels.iter().filter(|c| c["id"] == group).collect();
    if matches.len() != 1 {
        return Err(ModelError::new("model_config_invalid"));
    }
    let c = matches[0];
    // Same flattened channel -> model precedence as the existing catalog.
    let field = |key| {
        m.get(key)
            .or_else(|| c.get(key))
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|s| !s.is_empty())
    };
    let family = field("providerType")
        .or_else(|| field("provider"))
        .map(str::to_lowercase)
        .unwrap_or_else(|| group.to_owned());
    if m["enabled"] == false
        || c["enabled"] == false
        || selected["modelId"] != m["model"]
        || selected["providerId"] != group
        || selected["family"] != family
    {
        return Err(ModelError::new("model_selection_unavailable"));
    }
    if [m, c].iter().any(|v| {
        v.get("apiKey").is_some()
            || v.get("oauthTokens").is_some()
            || v.get("oauthClientSecret").is_some()
            || !v["proxy"].is_null()
    }) {
        return Err(ModelError::new("native_model_channel_unsupported"));
    }
    let mut flat = c
        .as_object()
        .ok_or(ModelError::new("model_config_invalid"))?
        .clone();
    flat.extend(
        m.as_object()
            .ok_or(ModelError::new("model_config_invalid"))?
            .clone(),
    );
    let resolved = channel::resolve(&Value::Object(flat), selected)?;
    let model = m["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(ModelError::new("model_selection_invalid"))?;
    if group.is_empty()
        || group.len() > 200
        || !group
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(ModelError::new("model_credential_key_invalid"));
    }
    Ok(ResolvedNativeModel {
        context_window: m
            .get("contextWindow")
            .or_else(|| c.get("contextWindow"))
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
            .map(|n| n.floor() as u64)
            .filter(|n| *n > 0),
        endpoint: resolved.endpoint,
        model: model.into(),
        credential_key: format!("model/{group}/api-key"),
        key_configured: c["apiKeyConfigured"] == true || m["apiKeyConfigured"] == true,
        wire: resolved.wire,
        provider: resolved.provider,
        generation: resolved.generation,
        headers: resolved.headers,
    })
}

pub async fn load_model(
    home: &Path,
    selected: &Value,
    cancel: &CancellationToken,
) -> Result<NativeModel, ModelError> {
    let config = read(&home.join("llm-providers.json"))?;
    let resolved = resolve_model(&config, selected)?;
    let secret = if resolved.key_configured {
        let helper = if let Some(path) = std::env::var_os("PEER_CREDENTIAL_HELPER_PATH") {
            std::path::PathBuf::from(path)
        } else {
            std::env::current_exe()
                .map_err(|_| ModelError::new("credential_helper_unavailable"))?
                .parent()
                .ok_or(ModelError::new("credential_helper_unavailable"))?
                .join("peer-credential-helper")
        };
        let client = HelperClient::new(&helper, home, Duration::from_secs(10))
            .map_err(|_| ModelError::new("credential_helper_unavailable"))?;
        Some(
            client
                .get(&resolved.credential_key, cancel)
                .await
                .map_err(|_| ModelError::new("model_credential_unavailable"))?
                .ok_or(ModelError::new("model_credential_missing"))?,
        )
    } else {
        None
    };
    NativeModel::new(
        ModelConfig {
            endpoint: resolved.endpoint,
            model: resolved.model,
            provider: resolved.provider,
            wire: resolved.wire,
            generation: resolved.generation,
        },
        secret,
        Duration::from_secs(120),
    )
    .map(|model| {
        model
            .with_context_window(resolved.context_window)
            .with_headers(resolved.headers)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn actual_ts_channel_configuration_and_runtime_requests_match() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-channels.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            let model = resolve_model(&case["config"], &case["selected"]).unwrap();
            let expected = &case["expected"];
            assert_eq!(
                model.wire,
                serde_json::from_value(expected["wire"].clone()).unwrap(),
                "{}",
                case["name"]
            );
            assert_eq!(model.endpoint, expected["endpoint"], "{}", case["name"]);
            assert_eq!(
                model.generation,
                serde_json::from_value(expected["options"].clone()).unwrap(),
                "{}",
                case["name"]
            );
            let headers: serde_json::Map<String, Value> = model
                .headers
                .iter()
                .map(|(k, v)| (k.to_string(), json!(v.to_str().unwrap())))
                .collect();
            assert_eq!(
                Value::Object(headers),
                expected["headers"],
                "{}",
                case["name"]
            );
            let request = crate::model::wire::encode_runtime(
                model.wire,
                &crate::model::wire::WireInput {
                    model: &model.model,
                    system: data["system"].as_str().unwrap(),
                    stable_system: None,
                    messages: data["messages"].as_array().unwrap(),
                    tools: data["tools"].as_array().map(Vec::as_slice),
                    options: &model.generation,
                },
            )
            .unwrap();
            assert_eq!(request, expected["request"], "{}", case["name"]);
            // No API-key adapter here declares private model options. Unknown
            // values follow ADR48: no projection, never raw request injection.
            let mut unknown = case["config"].clone();
            unknown["models"][0]["modelOptionValues"] =
                json!({"system":"injected", "Authorization":"injected", "temperature":"1"});
            let unknown = resolve_model(&unknown, &case["selected"]).unwrap();
            assert_eq!(unknown.generation, model.generation);
            assert_eq!(unknown.headers, model.headers);
        }
    }

    #[test]
    fn model_header_protection_limits_and_metadata_precedence_are_enforced() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-channels.json"
        ))
        .unwrap();
        let mut config = data["cases"][0]["config"].clone();
        let selected = &data["cases"][0]["selected"];
        config["channels"][0]["customHeaders"] = json!({"X-Channel":"shadowed"});
        config["models"][0]["customHeaders"] = json!({"X-Model":"private-synthetic-header"});
        config["channels"][0]["supportsReasoning"] = json!(true);
        config["models"][0]["supportsReasoning"] = json!(false);
        let resolved = resolve_model(&config, selected).unwrap();
        assert!(!resolved.generation.supports_reasoning);
        assert!(!resolved.headers.contains_key("x-channel"));
        assert_eq!(resolved.headers["x-model"], "private-synthetic-header");
        assert!(!format!("{:?}", resolved.headers).contains("private-synthetic-header"));
        let registry: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-channel-registry.json"
        ))
        .unwrap();
        for header in registry["protectedHeaders"].as_array().unwrap() {
            let mut changed = config.clone();
            changed["models"][0]["customHeaders"] =
                json!({header.as_str().unwrap().to_uppercase():""});
            assert!(resolve_model(&changed, selected).is_err(), "{header}");
        }
        for headers in [
            json!({"host":"foreign.invalid"}),
            json!({"content-length":0}),
            json!({"X-Foo":"line\r\nbreak"}),
            json!({"X Bad":"value"}),
            json!({"":"value"}),
            json!({"X-Too-Large":"x".repeat(8193)}),
            json!(
                (0..33)
                    .map(|i| (format!("x-{i}"), json!("v")))
                    .collect::<serde_json::Map<_, _>>()
            ),
            json!("not an object"),
        ] {
            config["models"][0]["customHeaders"] = headers;
            assert!(resolve_model(&config, selected).is_err());
        }
        for channel in ["unknown", "grok", "qoder"] {
            config["models"][0]["customHeaders"] = json!({});
            config["channels"][0]["channelId"] = json!(channel);
            assert!(resolve_model(&config, selected).is_err());
        }
        config["channels"][0]["channelId"] = json!("opencode-go");
        config["channels"][0]["wireOverride"] = json!("gemini");
        assert!(resolve_model(&config, selected).is_err());
    }
    #[test]
    fn go_session_identity_is_owned_bounded_and_does_not_mutate_configuration() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-channels.json"
        ))
        .unwrap();
        let case = data["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|c| c["config"]["channels"][0]["channelId"] == "opencode-go")
            .unwrap();
        let mut config = case["config"].clone();
        config["channels"][0]
            .as_object_mut()
            .unwrap()
            .remove("sessionId");
        let bytes = serde_json::to_vec(&config).unwrap();
        let first = resolve_model(&config, &case["selected"]).unwrap();
        let second = resolve_model(&config, &case["selected"]).unwrap();
        assert!(
            first.headers["x-opencode-session"]
                .to_str()
                .unwrap()
                .starts_with("peer-")
        );
        assert_ne!(
            first.headers["x-opencode-session"],
            second.headers["x-opencode-session"]
        );
        assert_eq!(serde_json::to_vec(&config).unwrap(), bytes);
        config["channels"][0]["conversationId"] = json!("canonical-conversation");
        assert_eq!(
            resolve_model(&config, &case["selected"]).unwrap().headers["x-opencode-session"],
            "canonical-conversation"
        );
        for value in [json!("injected\r\nheader: bad"), json!("x".repeat(1025))] {
            config["channels"][0]["sessionId"] = value;
            assert!(resolve_model(&config, &case["selected"]).is_err());
        }
        config["channels"][0]["sessionId"] = json!("fixed");
        config["models"][0]["reasoningEffortValues"] = json!(["low", null]);
        assert!(resolve_model(&config, &case["selected"]).is_err());
    }
    #[test]
    fn channel_model_selection_and_credential_identity_cannot_be_substituted() {
        let base = json!({"version":2,"channels":[{"id":"channel","provider":"openai","channelId":"openai-compatible","authMethod":"api_key","baseUrl":"https://fixture.invalid/v1"}],"models":[{"id":"channel::model","groupId":"channel","model":"model"}]});
        let selection = json!({"providerId":"channel","modelProviderId":"channel::model","modelId":"model","family":"openai","reasoningEffort":"off"});
        let good = resolve_model(&base, &selection).unwrap();
        assert_eq!(good.credential_key, "model/channel/api-key");
        assert_eq!(good.wire, Wire::Chat);
        let mut capacity = base.clone();
        capacity["channels"][0]["contextWindow"] = json!(2000);
        assert_eq!(
            resolve_model(&capacity, &selection).unwrap().context_window,
            Some(2000)
        );
        capacity["models"][0]["contextWindow"] = json!(1000);
        assert_eq!(
            resolve_model(&capacity, &selection).unwrap().context_window,
            Some(1000)
        );
        capacity["models"][0]["contextWindow"] = json!("unknown");
        assert_eq!(
            resolve_model(&capacity, &selection).unwrap().context_window,
            None
        );
        for (key, value) in [
            ("providerId", json!("foreign")),
            ("modelId", json!("other-model")),
            ("family", json!("other-family")),
        ] {
            let mut changed = selection.clone();
            changed[key] = value;
            assert!(resolve_model(&base, &changed).is_err());
        }
        for patch in [
            json!({"wireOverride":"gemini"}),
            json!({"authMethod":"oauth_chatgpt"}),
            json!({"apiKey":"legacy inline secret"}),
            json!({"customHeaders":{"Authorization":"override"}}),
        ] {
            let mut changed = base.clone();
            changed["channels"][0]
                .as_object_mut()
                .unwrap()
                .extend(patch.as_object().unwrap().clone());
            assert!(resolve_model(&changed, &selection).is_err());
        }
        let mut changed = base.clone();
        changed["models"]
            .as_array_mut()
            .unwrap()
            .push(base["models"][0].clone());
        assert!(resolve_model(&changed, &selection).is_err());
        let mut changed = base;
        changed["channels"][0]["providerType"] = json!(" ");
        changed["models"][0]["provider"] = json!("");
        let mut selected = selection;
        selected["family"] = json!("channel");
        assert!(resolve_model(&changed, &selected).is_ok());
    }
}
