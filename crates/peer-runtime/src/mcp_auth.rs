//! Host-only Vault resolution. No authorization, migration or secret persistence.
use crate::{
    CancellationToken,
    credentials::{CredentialError, HelperClient},
};
use peer_store::{McpCredentialBinding, McpCredentialStore};
use serde_json::{Value, json};
use std::path::Path;

pub(crate) struct SensitiveConfig(pub Value);
impl Drop for SensitiveConfig {
    fn drop(&mut self) {
        crate::credentials::scrub(&mut self.0);
    }
}
pub(crate) fn binding(
    home: &Path,
    config: &Value,
) -> Result<Option<McpCredentialBinding>, &'static str> {
    let mode = config["auth"]["mode"].as_str().unwrap_or("none");
    if mode == "none" {
        return Ok(None);
    }
    if !matches!(mode, "http_bearer" | "http_header" | "stdio_env" | "oauth2") {
        return Err("mcp_auth_mode_invalid");
    }
    if (mode == "stdio_env") != (config["transport"] == "stdio") {
        return Err("mcp_auth_transport_invalid");
    }
    let reference = config["auth"]["credentialRef"]
        .as_str()
        .filter(|v| v.starts_with("mcp-cred:"))
        .ok_or("mcp_credential_ref_invalid")?;
    let binding = McpCredentialStore::new(home)
        .binding(reference, mode)
        .map_err(|e| e.code())?;
    Ok(Some(binding))
}
pub(crate) fn check(
    home: &Path,
    binding: Option<&McpCredentialBinding>,
) -> Result<(), &'static str> {
    if let Some(binding) = binding {
        McpCredentialStore::new(home)
            .check(binding)
            .map_err(|_| "mcp_credential_changed")?;
    }
    Ok(())
}
pub(crate) fn check_access(
    home: &Path,
    binding: Option<&McpCredentialBinding>,
) -> Result<(), &'static str> {
    check(home, binding)?;
    if let Some(binding) = binding
        && binding.metadata["kind"] == "oauth2"
    {
        if binding.metadata["oauth"]["tokenStatus"] == "recovery_required" {
            return Err("mcp_oauth_recovery_required");
        }
        if !binding.metadata["oauth"]["expiresAt"].is_null()
            && !binding.metadata["oauth"]["expiresAt"].is_string()
        {
            return Err("mcp_oauth_token_invalid");
        }
        if let Some(expiry) = binding.metadata["oauth"]["expiresAt"].as_str() {
            let expiry =
                time::OffsetDateTime::parse(expiry, &time::format_description::well_known::Rfc3339)
                    .map_err(|_| "mcp_oauth_token_invalid")?;
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "mcp_oauth_clock_invalid")?
                .as_secs() as i64;
            if expiry.unix_timestamp() <= now + 30 {
                return Err("mcp_oauth_refresh_required");
            }
        }
    }
    Ok(())
}
pub(crate) async fn resolve(
    home: &Path,
    config: Value,
    binding: Option<&McpCredentialBinding>,
    cancel: &CancellationToken,
) -> Result<SensitiveConfig, &'static str> {
    let mut config = SensitiveConfig(config);
    let Some(binding) = binding else {
        return Ok(config);
    };
    check_access(home, Some(binding))?;
    let mut payload = load_payload(home, binding, cancel).await?;
    if payload.0.get("refreshState").is_some() {
        return Err("mcp_oauth_recovery_required");
    }
    let mode = binding.metadata["kind"]
        .as_str()
        .ok_or("mcp_credential_invalid")?;
    let secret = if mode == "oauth2" {
        let oauth = &mut payload.0["oauth"];
        let tokens = &oauth["tokens"];
        let expires = tokens["expires_at"]
            .as_f64()
            .or_else(|| tokens["expiresAt"].as_f64());
        if expires.is_none() && (!tokens["expires_at"].is_null() || !tokens["expiresAt"].is_null())
        {
            return Err("mcp_oauth_token_invalid");
        }
        if expires.is_none() && !tokens["expires_in"].is_null() {
            return Err("mcp_oauth_refresh_required");
        }
        if let Some(expires) = expires {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|_| "mcp_oauth_clock_invalid")?
                .as_millis() as f64;
            if expires <= now + 30000.0 {
                return Err("mcp_oauth_refresh_required");
            }
        }
        tokens["access_token"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("mcp_oauth_authorization_required")?
    } else {
        payload.0["secret"]
            .as_str()
            .filter(|v| !v.is_empty())
            .ok_or("mcp_credential_invalid")?
    };
    // Both the raw token and its wire encoding can be echoed by a server.
    config.0["_credentialRedaction"] = json!([secret]);
    let target = if mode == "stdio_env" {
        "env"
    } else {
        "headers"
    };
    if config.0.get(target).is_none() || config.0[target].is_null() {
        config.0[target] = json!({});
    }
    let fields = config.0[target]
        .as_object_mut()
        .ok_or("mcp_config_invalid")?;
    match mode {
        "http_bearer" | "oauth2" => {
            fields.retain(|name, _| !name.eq_ignore_ascii_case("authorization"));
            fields.insert("Authorization".into(), json!(format!("Bearer {secret}")));
        }
        "http_header" => {
            let name = config.0["auth"]["headerName"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| binding.metadata["headerName"].as_str())
                .ok_or("mcp_header_invalid")?
                .to_owned();
            reqwest::header::HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| "mcp_header_invalid")?;
            let fields = config.0["headers"]
                .as_object_mut()
                .ok_or("mcp_config_invalid")?;
            fields.retain(|key, _| !key.eq_ignore_ascii_case(&name));
            fields.insert(name, json!(secret));
        }
        "stdio_env" => {
            let name = config.0["auth"]["envName"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| binding.metadata["envName"].as_str())
                .ok_or("mcp_env_invalid")?;
            if !name
                .bytes()
                .enumerate()
                .all(|(i, b)| b.is_ascii_alphabetic() || b == b'_' || (i > 0 && b.is_ascii_digit()))
                || name.is_empty()
            {
                return Err("mcp_env_invalid");
            }
            let name = name.to_owned();
            config.0["env"]
                .as_object_mut()
                .ok_or("mcp_config_invalid")?
                .insert(name, json!(secret));
        }
        _ => return Err("mcp_auth_mode_invalid"),
    }
    check_access(home, Some(binding))?;
    Ok(config)
}

pub(crate) async fn load_payload(
    home: &Path,
    binding: &McpCredentialBinding,
    cancel: &CancellationToken,
) -> Result<SensitiveConfig, &'static str> {
    let client = HelperClient::for_home(home).map_err(|_| "credential_helper_unavailable")?;
    let raw = client
        .get(
            binding.metadata["vaultKey"]
                .as_str()
                .ok_or("mcp_credential_invalid")?,
            cancel,
        )
        .await
        .map_err(|e| {
            if e == CredentialError::Cancelled {
                "CANCELLED"
            } else {
                "mcp_credential_unavailable"
            }
        })?
        .ok_or("mcp_credential_missing")?;
    let payload = SensitiveConfig(
        peer_protocol::decode_json_bounded(
            raw.expose().as_bytes(),
            peer_protocol::JsonLimits {
                bytes: 262144,
                nodes: 8192,
                depth: 32,
                string_bytes: 262144,
            },
        )
        .map_err(|_| "mcp_credential_invalid")?
        .value,
    );
    if payload.0["version"] != 1
        || payload.0["credentialRef"] != binding.metadata["credentialRef"]
        || payload.0["kind"] != binding.metadata["kind"]
    {
        return Err("mcp_credential_invalid");
    }
    Ok(payload)
}
