//! Read-only OAuth subscription quota monitor (ChatGPT / Grok).
//!
//! Shares the native `ModelOAuth` credential store and pinned `Network` transport
//! (system proxy + trusted roots) without spawning any Node/Bun process.

use crate::{CancellationToken, model_config, model_oauth::ModelOAuth, network::Network};
use peer_protocol::{JsonLimits, decode_json_bounded};
use reqwest::{Method, Url};
use serde_json::{Value, json};
use std::{path::Path, time::Duration};

const MAX_QUOTA_BODY_BYTES: usize = 512 * 1024;
const QUOTA_REQUEST_TIMEOUT: Duration = Duration::from_secs(15);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubscriptionQuotaSnapshot {
    pub provider_id: String,
    pub auth_method: String,
    pub remaining_percent: u8,
    pub used_percent: u8,
    pub plan_label: Option<String>,
    pub resets_at: Option<String>,
}

fn clamp_percent(value: f64) -> Option<u8> {
    if !value.is_finite() {
        return None;
    }
    Some(value.round().clamp(0.0, 100.0) as u8)
}

fn env_override_active() -> bool {
    std::env::var_os("PEER_MODEL_API_KEY").is_some_and(|v| !v.is_empty())
}

fn text<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v[key].as_str().map(str::trim).filter(|s| !s.is_empty())
}

struct QuotaTarget {
    auth_method: String,
    group_id: String,
    model_entry_id: String,
}

fn find_quota_target(home: &Path, provider_id: &str) -> Option<QuotaTarget> {
    if env_override_active() || provider_id.trim().is_empty() {
        return None;
    }
    let file = home.join("llm-providers.json");
    if file.try_exists().ok() != Some(true) {
        return None;
    }
    let doc = model_config::read(&file).ok()?;
    let channel = doc["channels"].as_array()?.iter().find(|c| {
        c["id"].as_str() == Some(provider_id) || c["groupId"].as_str() == Some(provider_id)
    })?;
    let auth_method = text(channel, "authMethod")?;
    if !matches!(auth_method, "oauth_chatgpt" | "oauth_grok") || channel["oauthConfigured"] != true
    {
        return None;
    }
    let group_id = text(channel, "groupId")
        .or_else(|| text(channel, "id"))?
        .to_owned();
    let models = doc["models"].as_array()?;
    let matched_model = models
        .iter()
        .find(|m| {
            m["enabled"] != false
                && (m["groupId"].as_str() == Some(group_id.as_str())
                    || m["id"].as_str() == Some(provider_id))
        })
        .or_else(|| {
            models.iter().find(|m| {
                m["groupId"].as_str() == Some(group_id.as_str())
                    || m["id"].as_str() == Some(provider_id)
            })
        })?;
    let model_entry_id = text(matched_model, "id")?.to_owned();
    Some(QuotaTarget {
        auth_method: auth_method.to_owned(),
        group_id,
        model_entry_id,
    })
}

/// Returns `true` when `provider_id` resolves to a configured OAuth subscription channel.
pub fn supports_subscription_quota(home: &Path, provider_id: &str) -> bool {
    find_quota_target(home, provider_id).is_some()
}

/// Fetches the current subscription quota snapshot for `provider_id`, returning `None` on
/// unsupported channels, missing credentials, network errors, or parse errors.
pub async fn fetch_subscription_quota(
    home: &Path,
    provider_id: &str,
    cancel: &CancellationToken,
) -> Option<SubscriptionQuotaSnapshot> {
    let target = find_quota_target(home, provider_id)?;
    let config = model_config::read(&home.join("llm-providers.json")).ok()?;
    let binding = model_config::ModelBinding::new(
        home,
        &config,
        &json!({ "modelProviderId": target.model_entry_id }),
    )
    .ok()?;
    let cred_key = format!("model/{}/oauth-tokens", target.group_id);
    let oauth = ModelOAuth::load(home, &cred_key, &target.auth_method, binding, cancel)
        .await
        .ok()?;
    let access = oauth.access(cancel).await.ok()?;
    let network = Network::new().ok()?;

    match target.auth_method.as_str() {
        "oauth_chatgpt" => {
            let mut headers = vec![
                ("Accept".to_owned(), "application/json".to_owned()),
                ("User-Agent".to_owned(), "PeerAgent/1.0".to_owned()),
                (
                    "Authorization".to_owned(),
                    format!("Bearer {}", access.secret.expose()),
                ),
            ];
            if let Some(account_id) = access.account.as_deref() {
                headers.push(("ChatGPT-Account-ID".to_owned(), account_id.to_owned()));
                headers.push(("chatgpt-account-id".to_owned(), account_id.to_owned()));
            }
            let bytes = request_bytes(
                &network,
                Method::GET,
                "https://chatgpt.com/backend-api/wham/usage",
                &headers,
                None,
                cancel,
            )
            .await?;
            let val = decode_bounded_json(&bytes)?;
            parse_chatgpt_usage(provider_id, &val)
        }
        "oauth_grok" => {
            let headers = vec![
                (
                    "Authorization".to_owned(),
                    format!("Bearer {}", access.secret.expose()),
                ),
                (
                    "Content-Type".to_owned(),
                    "application/grpc-web+proto".to_owned(),
                ),
                ("Accept".to_owned(), "application/grpc-web+proto".to_owned()),
                ("X-Grpc-Web".to_owned(), "1".to_owned()),
                ("X-User-Agent".to_owned(), "PeerAgent/1.0".to_owned()),
                ("Origin".to_owned(), "https://grok.com".to_owned()),
                (
                    "Referer".to_owned(),
                    "https://grok.com/?_s=usage".to_owned(),
                ),
                ("User-Agent".to_owned(), "PeerAgent/1.0".to_owned()),
            ];
            let bytes = request_bytes(
                &network,
                Method::POST,
                "https://grok.com/grok_api_v2.GrokBuildBilling/GetGrokCreditsConfig",
                &headers,
                Some(vec![0x00, 0x00, 0x00, 0x00, 0x00]),
                cancel,
            )
            .await?;
            parse_grok_grpc_web(provider_id, &bytes)
        }
        _ => None,
    }
}

async fn request_bytes(
    network: &Network,
    method: Method,
    raw_url: &str,
    headers: &[(String, String)],
    body: Option<Vec<u8>>,
    cancel: &CancellationToken,
) -> Option<Vec<u8>> {
    let url = Url::parse(raw_url).ok()?;
    let client = network
        .prepare(&url, cancel)
        .await
        .ok()?
        .builder
        .connect_timeout(Duration::from_secs(8))
        .timeout(QUOTA_REQUEST_TIMEOUT)
        .build()
        .ok()?;
    let mut req = client.request(method, url).header("connection", "close");
    for (k, v) in headers {
        req = req.header(k.as_str(), v.as_str());
    }
    if let Some(payload) = body {
        req = req.body(payload);
    }
    let mut resp = tokio::select! {
        biased;
        _ = cancel.cancelled() => return None,
        res = tokio::time::timeout(QUOTA_REQUEST_TIMEOUT, req.send()) => res.ok()?.ok()?,
    };
    if !resp.status().is_success() {
        return None;
    }
    let mut out = Vec::new();
    while let Some(chunk) = tokio::select! {
        biased;
        _ = cancel.cancelled() => return None,
        res = resp.chunk() => res.ok()?,
    } {
        if out.len().saturating_add(chunk.len()) > MAX_QUOTA_BODY_BYTES {
            return None;
        }
        out.extend_from_slice(&chunk);
    }
    Some(out)
}

fn decode_bounded_json(bytes: &[u8]) -> Option<Value> {
    decode_json_bounded(
        bytes,
        JsonLimits {
            bytes: MAX_QUOTA_BODY_BYTES,
            nodes: 8192,
            depth: 24,
            string_bytes: MAX_QUOTA_BODY_BYTES,
        },
    )
    .ok()
    .map(|d| d.value)
}

fn extract_reset(v: &Value) -> Option<String> {
    if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
        return Some(s.to_owned());
    }
    v.as_f64()
        .filter(|n| n.is_finite() && *n > 0.0)
        .map(|n| n.floor().to_string())
}

pub(crate) fn parse_chatgpt_usage(
    provider_id: &str,
    payload: &Value,
) -> Option<SubscriptionQuotaSnapshot> {
    let rate_limit = payload
        .get("rate_limit")
        .or_else(|| payload.get("rateLimit"))?;
    let primary = rate_limit
        .get("primary_window")
        .or_else(|| rate_limit.get("primaryWindow"))
        .or_else(|| rate_limit.get("secondary_window"))
        .or_else(|| rate_limit.get("secondaryWindow"))?;
    let used = primary
        .get("used_percent")
        .or_else(|| primary.get("usedPercent"))
        .and_then(Value::as_f64)
        .and_then(clamp_percent)?;
    let remaining = 100u8.saturating_sub(used);
    let plan_label = payload
        .get("plan_type")
        .or_else(|| payload.get("planType"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let resets_at = primary
        .get("reset_at")
        .or_else(|| primary.get("resetAt"))
        .and_then(extract_reset);
    Some(SubscriptionQuotaSnapshot {
        provider_id: provider_id.to_owned(),
        auth_method: "oauth_chatgpt".to_owned(),
        remaining_percent: remaining,
        used_percent: used,
        plan_label,
        resets_at,
    })
}

fn read_varint(bytes: &[u8], idx: &mut usize) -> Option<u64> {
    let mut result = 0u64;
    let mut shift = 0u32;
    while *idx < bytes.len() {
        let byte = bytes[*idx];
        *idx += 1;
        result |= u64::from(byte & 0x7f).checked_shl(shift)?;
        if byte & 0x80 == 0 {
            return Some(result);
        }
        shift += 7;
        if shift > 63 {
            return None;
        }
    }
    None
}

fn collect_proto_numbers(
    bytes: &[u8],
    depth: usize,
    floats: &mut Vec<f64>,
    has_timestamp: &mut bool,
) {
    if depth > 6 {
        return;
    }
    let mut idx = 0usize;
    while idx < bytes.len() {
        let Some(key) = read_varint(bytes, &mut idx) else {
            break;
        };
        let wire_type = key & 0x07;
        match wire_type {
            0 => {
                let Some(val) = read_varint(bytes, &mut idx) else {
                    break;
                };
                if val > 1_700_000_000 && val < 2_200_000_000 {
                    *has_timestamp = true;
                }
            }
            1 => {
                if idx + 8 > bytes.len() {
                    break;
                }
                let val = f64::from_le_bytes(bytes[idx..idx + 8].try_into().unwrap());
                idx += 8;
                if val.is_finite() {
                    floats.push(val);
                    if val > 1_700_000_000.0 && val < 2_200_000_000.0 {
                        *has_timestamp = true;
                    }
                }
            }
            2 => {
                let Some(len) = read_varint(bytes, &mut idx).and_then(|l| usize::try_from(l).ok())
                else {
                    break;
                };
                if idx.checked_add(len).is_none_or(|end| end > bytes.len()) {
                    break;
                }
                collect_proto_numbers(&bytes[idx..idx + len], depth + 1, floats, has_timestamp);
                idx += len;
            }
            5 => {
                if idx + 4 > bytes.len() {
                    break;
                }
                let val = f64::from(f32::from_le_bytes(bytes[idx..idx + 4].try_into().unwrap()));
                idx += 4;
                if val.is_finite() {
                    floats.push(val);
                }
            }
            _ => break,
        }
    }
}

pub(crate) fn parse_grok_grpc_web(
    provider_id: &str,
    bytes: &[u8],
) -> Option<SubscriptionQuotaSnapshot> {
    let mut frames = Vec::new();
    let mut i = 0usize;
    while i + 5 <= bytes.len() {
        let flags = bytes[i];
        let len =
            u32::from_be_bytes([bytes[i + 1], bytes[i + 2], bytes[i + 3], bytes[i + 4]]) as usize;
        i += 5;
        if i.checked_add(len).is_none_or(|end| end > bytes.len()) {
            break;
        }
        if (flags & 0x80) == 0 {
            frames.push(&bytes[i..i + len]);
        }
        i += len;
    }
    let payloads: Vec<&[u8]> = if frames.is_empty() {
        vec![bytes]
    } else {
        frames
    };
    let mut floats = Vec::new();
    let mut has_timestamp = false;
    for payload in payloads {
        collect_proto_numbers(payload, 0, &mut floats, &mut has_timestamp);
    }
    let max_used = floats
        .into_iter()
        .filter(|v| v.is_finite() && (0.0..=100.0).contains(v))
        .fold(None::<f64>, |acc, v| Some(acc.map_or(v, |cur| cur.max(v))));
    let used = match (max_used.and_then(clamp_percent), has_timestamp) {
        (Some(u), _) => u,
        (None, true) => 0,
        (None, false) => return None,
    };
    Some(SubscriptionQuotaSnapshot {
        provider_id: provider_id.to_owned(),
        auth_method: "oauth_grok".to_owned(),
        remaining_percent: 100u8.saturating_sub(used),
        used_percent: used,
        plan_label: None,
        resets_at: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_chatgpt_and_grok_subscription_quotas() {
        let chatgpt = json!({
            "plan_type": "plus",
            "rate_limit": {
                "primary_window": { "used_percent": 28, "reset_at": "2026-11-20T00:00:00Z" }
            }
        });
        let snap = parse_chatgpt_usage("p-gpt", &chatgpt).unwrap();
        assert_eq!(snap.remaining_percent, 72);
        assert_eq!(snap.used_percent, 28);
        assert_eq!(snap.plan_label.as_deref(), Some("plus"));

        // gRPC-web frame carrying field #1 float 35.0
        let mut msg = vec![(1 << 3) | 5];
        msg.extend_from_slice(&35.0f32.to_le_bytes());
        let mut framed = vec![0u8];
        framed.extend_from_slice(&(msg.len() as u32).to_be_bytes());
        framed.extend_from_slice(&msg);
        let grok = parse_grok_grpc_web("p-grok", &framed).unwrap();
        assert_eq!(grok.remaining_percent, 65);
        assert_eq!(grok.used_percent, 35);
    }

    #[test]
    fn supports_subscription_quota_only_for_configured_oauth_channels() {
        let root = tempfile::tempdir().unwrap();
        let cfg = json!({
            "version": 2,
            "channels": [
                { "id": "c-gpt", "groupId": "c-gpt", "authMethod": "oauth_chatgpt", "oauthConfigured": true },
                { "id": "c-api", "groupId": "c-api", "authMethod": "api_key", "apiKeyConfigured": true }
            ],
            "models": [
                { "id": "m-gpt", "groupId": "c-gpt", "model": "gpt-6.1-sol", "enabled": true },
                { "id": "m-api", "groupId": "c-api", "model": "deepseek", "enabled": true }
            ]
        });
        std::fs::write(
            root.path().join("llm-providers.json"),
            serde_json::to_string(&cfg).unwrap(),
        )
        .unwrap();
        assert!(supports_subscription_quota(root.path(), "c-gpt"));
        assert!(!supports_subscription_quota(root.path(), "c-api"));
        assert!(!supports_subscription_quota(root.path(), "missing"));
    }
}
