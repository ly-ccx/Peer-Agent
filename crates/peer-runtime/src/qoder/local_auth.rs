//! The chosen third-party credential source owns its plaintext and expiry.
use super::{
    CREDENTIAL_LIMIT, account_files::ReadSet, environment::Environment,
    sensitive_json::SensitiveJson,
};
use crate::{CancellationToken, credentials::Secret, model::ModelError};
use serde_json::Value;
use std::path::Path;
use zeroize::Zeroizing;
fn invalid() -> ModelError {
    ModelError::new("qoder_auth_invalid")
}
pub(super) enum Login {
    Environment(Secret),
    Local(Box<Local>),
}
pub(super) struct Local {
    profile: SensitiveJson,
    machine: Zeroizing<String>,
}
impl Login {
    pub fn load(
        env: &Environment,
        root: &Path,
        reads: &mut ReadSet,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        for name in [
            "QODER_ACCESS_TOKEN",
            "QODER_PERSONAL_ACCESS_TOKEN",
            "QODER_PAT",
        ] {
            if let Some(token) = env.text(name) {
                return Secret::from_string(token.to_owned())
                    .map(Self::Environment)
                    .map_err(|_| invalid());
            }
        }
        let bytes = reads.required(&root.join(".auth/machine_id"), 4096, cancel)?;
        let machine = Zeroizing::new(
            peer_protocol::javascript_trim(std::str::from_utf8(&bytes).map_err(|_| invalid())?)
                .to_owned(),
        );
        let key = Zeroizing::new(machine.encode_utf16().take(16).collect::<Vec<_>>());
        let key = Zeroizing::new(String::from_utf16(&key).map_err(|_| invalid())?);
        let cipher = reads.required(&root.join(".auth/user"), CREDENTIAL_LIMIT, cancel)?;
        let plain = super::decrypt_credential(
            peer_protocol::javascript_trim(std::str::from_utf8(&cipher).map_err(|_| invalid())?),
            key.as_bytes(),
        )
        .map_err(|_| invalid())?;
        let profile = SensitiveJson::parse(plain.expose().as_bytes(), CREDENTIAL_LIMIT)?;
        validate_profile(&profile.0)?;
        Ok(Self::Local(Box::new(Local { profile, machine })))
    }
    pub fn uid(&self) -> Option<&str> {
        match self {
            Self::Environment(_) => None,
            Self::Local(local) => local.profile.0["uid"].as_str().filter(|s| !s.is_empty()),
        }
    }
    pub fn prepared(&self) -> Result<(&Value, &str), ModelError> {
        let Self::Local(local) = self else {
            return Err(ModelError::new("qoder_local_user_info_required"));
        };
        local.profile.0["uid"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or_else(invalid)?;
        Ok((&local.profile.0, &local.machine))
    }
    pub fn token(&self) -> &str {
        match self {
            Self::Environment(secret) => secret.expose(),
            Self::Local(local) => ["security_oauth_token", "access_token"]
                .iter()
                .filter_map(|key| local.profile.0[*key].as_str())
                .map(peer_protocol::javascript_trim)
                .find(|s| !s.is_empty())
                .expect("validated token"),
        }
    }
    pub fn validate(&self, now: u64) -> Result<(), ModelError> {
        match self {
            Self::Environment(_) => Ok(()),
            Self::Local(local) => expiry(&local.profile.0, now),
        }
    }
}
pub(super) fn expiry(profile: &Value, now: u64) -> Result<(), ModelError> {
    let Some(value) = profile.get("expire_time").filter(|v| !v.is_null()) else {
        return Ok(());
    };
    let value = match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|n: &f64| n.is_finite() && *n >= 0.0)
    .ok_or_else(invalid)?;
    if value > 0.0 && value <= now.saturating_add(60) as f64 {
        return Err(ModelError::new("qoder_auth_expired"));
    }
    Ok(())
}
fn validate_profile(profile: &Value) -> Result<(), ModelError> {
    if !profile.is_object() {
        return Err(invalid());
    }
    let bounded_text = |key, limit| -> Result<Option<&str>, ModelError> {
        match profile.get(key) {
            None => Ok(None),
            Some(Value::String(s)) if s.len() <= limit => Ok(Some(s)),
            _ => Err(invalid()),
        }
    };
    bounded_text("uid", 512)?;
    let primary = bounded_text("security_oauth_token", 8192)?
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty());
    let secondary = bounded_text("access_token", 8192)?
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty());
    primary
        .or(secondary)
        .ok_or(ModelError::new("qoder_auth_token_missing"))?;
    for name in ["encrypt_user_info", "key", "organization_id"] {
        bounded_text(name, 8192)?;
    }
    if let Some(tags) = profile.get("organization_tags") {
        let tags = tags
            .as_array()
            .filter(|a| a.len() <= 128)
            .ok_or_else(invalid)?;
        if tags
            .iter()
            .any(|v| !v.as_str().is_some_and(|s| s.len() <= 512))
        {
            return Err(invalid());
        }
    }
    if profile
        .get("data_policy_agreed")
        .is_some_and(|v| !v.is_boolean())
    {
        return Err(invalid());
    }
    Ok(())
}
