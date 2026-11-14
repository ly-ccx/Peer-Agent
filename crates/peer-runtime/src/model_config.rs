//! Read-only adapter for existing v2 channel/model configuration and Helper v1.
//! Unsupported dialect/auth/legacy secrets fail before any model dispatch.
use crate::{
    CancellationToken,
    credentials::HelperClient,
    model::{ModelError, OpenAiChatModel},
};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use std::{io::Read, path::Path, time::Duration};
fn read(path: &Path) -> Result<Value, ModelError> {
    let mut f = std::fs::File::open(path).map_err(|_| ModelError("model_config_unavailable"))?;
    let before = f
        .metadata()
        .map_err(|_| ModelError("model_config_unavailable"))?;
    let mut bytes = Vec::new();
    f.by_ref()
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| ModelError("model_config_unavailable"))?;
    if bytes.len() > 1024 * 1024 {
        return Err(ModelError("model_config_limit"));
    }
    let after = std::fs::metadata(path).map_err(|_| ModelError("model_config_changed"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if before.ino() != after.ino()
            || before.dev() != after.dev()
            || before.mtime() != after.mtime()
            || before.mtime_nsec() != after.mtime_nsec()
            || before.len() != after.len()
        {
            return Err(ModelError("model_config_changed"));
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
    .map_err(|_| ModelError("model_config_invalid"))
}
pub struct ResolvedNativeModel {
    pub endpoint: String,
    pub model: String,
    pub credential_key: String,
    pub key_configured: bool,
}
pub fn resolve_model(config: &Value, selected: &Value) -> Result<ResolvedNativeModel, ModelError> {
    if config["version"] != 2 {
        return Err(ModelError("native_legacy_model_config_unsupported"));
    }
    let id = selected["modelProviderId"]
        .as_str()
        .ok_or(ModelError("model_selection_invalid"))?;
    let models = config["models"]
        .as_array()
        .ok_or(ModelError("model_config_invalid"))?;
    let matches: Vec<_> = models.iter().filter(|m| m["id"] == id).collect();
    if matches.len() != 1 {
        return Err(ModelError("model_selection_unavailable"));
    }
    let m = matches[0];
    let group = m["groupId"]
        .as_str()
        .ok_or(ModelError("model_config_invalid"))?;
    let channels = config["channels"]
        .as_array()
        .ok_or(ModelError("model_config_invalid"))?;
    let matches: Vec<_> = channels.iter().filter(|c| c["id"] == group).collect();
    if matches.len() != 1 {
        return Err(ModelError("model_config_invalid"));
    }
    let c = matches[0];
    if m["enabled"] == false
        || c["enabled"] == false
        || selected["modelId"] != m["model"]
        || selected["family"] != "openai"
    {
        return Err(ModelError("model_selection_unavailable"));
    }
    if c["channelId"] != "openai-compatible"
        || c["authMethod"] != "api_key"
        || c.get("wireOverride")
            .is_some_and(|v| !v.is_null() && v != "openai-chat")
        || m["supportsReasoning"] == true
        || c["supportsReasoning"] == true
        || selected["reasoningEffort"]
            .as_str()
            .is_some_and(|e| !matches!(e, "off" | "default"))
        || !m["maxOutputTokens"].is_null()
        || [m, c].iter().any(|v| {
            v.get("apiKey").is_some()
                || v.get("oauthTokens").is_some()
                || v["customHeaders"]
                    .as_object()
                    .is_some_and(|h| !h.is_empty())
                || !v["proxy"].is_null()
        })
    {
        return Err(ModelError("native_model_channel_unsupported"));
    }
    let base = c["baseUrl"]
        .as_str()
        .ok_or(ModelError("model_endpoint_invalid"))?
        .trim_end_matches('/');
    let model = m["model"]
        .as_str()
        .filter(|s| !s.is_empty())
        .ok_or(ModelError("model_selection_invalid"))?;
    if group.is_empty()
        || group.len() > 200
        || !group
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
    {
        return Err(ModelError("model_credential_key_invalid"));
    }
    Ok(ResolvedNativeModel {
        endpoint: format!("{base}/chat/completions"),
        model: model.into(),
        credential_key: format!("model/{group}/api-key"),
        key_configured: c["apiKeyConfigured"] == true || m["apiKeyConfigured"] == true,
    })
}
pub async fn load_model(
    home: &Path,
    selected: &Value,
    cancel: &CancellationToken,
) -> Result<OpenAiChatModel, ModelError> {
    let config = read(&home.join("llm-providers.json"))?;
    let resolved = resolve_model(&config, selected)?;
    let secret = if resolved.key_configured {
        let helper = if let Some(path) = std::env::var_os("PEER_CREDENTIAL_HELPER_PATH") {
            std::path::PathBuf::from(path)
        } else {
            std::env::current_exe()
                .map_err(|_| ModelError("credential_helper_unavailable"))?
                .parent()
                .ok_or(ModelError("credential_helper_unavailable"))?
                .join("peer-credential-helper")
        };
        let client = HelperClient::new(&helper, home, Duration::from_secs(10))
            .map_err(|_| ModelError("credential_helper_unavailable"))?;
        Some(
            client
                .get(&resolved.credential_key, cancel)
                .await
                .map_err(|_| ModelError("model_credential_unavailable"))?
                .ok_or(ModelError("model_credential_missing"))?,
        )
    } else {
        None
    };
    OpenAiChatModel::new(
        &resolved.endpoint,
        &resolved.model,
        secret,
        Duration::from_secs(120),
    )
}
