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
    let wire = match (
        c["channelId"].as_str().unwrap_or("openai-compatible"),
        c["wireOverride"].as_str(),
    ) {
        ("openai" | "openai-compatible", None | Some("openai-chat")) => Wire::Chat,
        ("openai" | "openai-compatible" | "grok", Some("openai-responses")) | ("grok", None) => {
            Wire::Responses
        }
        ("anthropic" | "anthropic-compatible", None | Some("anthropic-messages")) => {
            Wire::Anthropic
        }
        ("google-ai", None) => Wire::Gemini,
        _ => return Err(ModelError::new("native_model_channel_unsupported")),
    };
    if c["authMethod"] != "api_key"
        || m["supportsReasoning"] == true
        || c["supportsReasoning"] == true
        || selected["reasoningEffort"]
            .as_str()
            .is_some_and(|e| !matches!(e, "off" | "default"))
        || !m["maxOutputTokens"].is_null()
        || selected["fastMode"] == true
        || m["modelOptionValues"]
            .as_object()
            .is_some_and(|v| !v.is_empty())
        || [m, c].iter().any(|v| {
            v.get("apiKey").is_some()
                || v.get("oauthTokens").is_some()
                || v["customHeaders"]
                    .as_object()
                    .is_some_and(|h| !h.is_empty())
                || !v["proxy"].is_null()
        })
    {
        return Err(ModelError::new("native_model_channel_unsupported"));
    }
    let base = c["baseUrl"]
        .as_str()
        .ok_or(ModelError::new("model_endpoint_invalid"))?
        .trim_end_matches('/');
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
        endpoint: match wire {
            Wire::Chat => format!("{base}/chat/completions"),
            Wire::Responses => format!("{base}/responses"),
            Wire::Anthropic => format!("{base}/v1/messages"),
            Wire::Gemini => {
                if model.contains(['?', '#', '\\', '/', '%'])
                    && !model
                        .strip_prefix("models/")
                        .is_some_and(|s| !s.is_empty() && !s.contains(['?', '#', '\\', '/', '%']))
                {
                    return Err(ModelError::new("model_selection_invalid"));
                }
                format!(
                    "{base}/models/{}:streamGenerateContent?alt=sse",
                    model.strip_prefix("models/").unwrap_or(model)
                )
            }
        },
        model: model.into(),
        credential_key: format!("model/{group}/api-key"),
        key_configured: c["apiKeyConfigured"] == true || m["apiKeyConfigured"] == true,
        wire,
        provider: c["channelId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .unwrap_or(group)
            .trim()
            .into(),
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
            generation: GenerationOptions::default(),
        },
        secret,
        Duration::from_secs(120),
    )
    .map(|model| model.with_context_window(resolved.context_window))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
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
