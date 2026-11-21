//! URL selection is bound to captured settings/config and the same read set.
use super::{
    CACHE_LIMIT, account_files::ReadSet, authentication, environment::Environment,
    sensitive_json::SensitiveJson,
};
use crate::{CancellationToken, model::ModelError};
use serde_json::Value;
use std::path::Path;
fn invalid() -> ModelError {
    ModelError::new("qoder_auth_invalid")
}
pub(super) fn prepared(
    env: &Environment,
    root: &Path,
    reads: &mut ReadSet,
    cancel: &CancellationToken,
) -> Result<reqwest::Url, ModelError> {
    let explicit = env
        .get("QODER_INFERENCE_ENDPOINT")
        .filter(|s| !s.is_empty())
        .or_else(|| env.get("QODER_INFER_ENDPOINT"))
        .map(peer_protocol::javascript_trim)
        .filter(|v| !v.is_empty());
    let cache = if explicit.is_none() {
        reads
            .optional(
                &root.join(".cache/endpoint-cache.json"),
                CACHE_LIMIT,
                cancel,
            )?
            .map(|bytes| SensitiveJson::parse(&bytes, CACHE_LIMIT))
            .transpose()?
    } else {
        None
    };
    if cache.as_ref().is_some_and(|c| !c.0["entries"].is_object()) {
        return Err(invalid());
    }
    let env_name = env
        .text("QODER_ENV")
        .or_else(|| env.text("QODER_ENVIRONMENT"))
        .unwrap_or("prod");
    let entries = cache.as_ref().map(|c| &c.0["entries"]);
    let cached = entries.and_then(|e| {
        [
            &e[env_name]["endpoint"],
            &e["prod"]["endpoint"],
            &e[env_name]["inferEndpoints"][0],
            &e["prod"]["inferEndpoints"][0],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .map(peer_protocol::javascript_trim)
        .find(|v| !v.is_empty())
    });
    let fallback = match env_name.to_lowercase().as_str() {
        "daily" => "https://daily-api3.qoder.sh",
        "test" => "https://test-api3.qoder.sh",
        _ => "https://api3.qoder.sh",
    };
    let base = explicit
        .or(cached)
        .unwrap_or(fallback)
        .trim_end_matches('/');
    let base_url =
        reqwest::Url::parse(base).map_err(|_| ModelError::new("model_endpoint_invalid"))?;
    if !matches!(base_url.scheme(), "http" | "https")
        || base_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || base_url.query().is_some()
        || base_url.fragment().is_some()
    {
        return Err(ModelError::new("model_endpoint_invalid"));
    }
    let url = reqwest::Url::parse(&format!("{base}{}", authentication::INFER_PATH))
        .map_err(|_| ModelError::new("model_endpoint_invalid"))?;
    Ok(url)
}

pub(super) fn legacy(
    env: &Environment,
    explicit: Option<&str>,
) -> Result<reqwest::Url, ModelError> {
    let base = if let Some(base) = explicit {
        base.to_owned()
    } else {
        let host = env
            .text("QODER_MODEL_SERVER_HOST")
            .map(|s| {
                s.strip_prefix("https://")
                    .or_else(|| s.strip_prefix("http://"))
                    .unwrap_or(s)
                    .trim_end_matches('/')
                    .to_owned()
            })
            .unwrap_or_else(|| {
                match env
                    .text("QODER_ENV")
                    .or_else(|| env.text("QODER_ENVIRONMENT"))
                    .unwrap_or("")
                    .to_lowercase()
                    .as_str()
                {
                    "daily" => "daily-api2-v2.qoder.sh",
                    "test" => "test-api2-v2.qoder.sh",
                    _ => "api2-v2.qoder.sh",
                }
                .to_owned()
            });
        format!("https://{host}/model/v1")
    };
    let url = reqwest::Url::parse(&format!("{}/chat/completions", base.trim_end_matches('/')))
        .map_err(|_| ModelError::new("model_endpoint_invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ModelError::new("model_endpoint_invalid"));
    }
    Ok(url)
}
