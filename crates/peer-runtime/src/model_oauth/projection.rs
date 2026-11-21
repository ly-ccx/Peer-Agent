//! Rebuildable non-secret hints, conditional on the already-owned config Store.
//! Vault outcomes never roll back because this optional projection failed.
use super::{ModelError, Token};
use crate::CancellationToken;
use peer_protocol::{ModelMetadataState, model_oauth_hint_fields};
use peer_store::{ModelConfigTransaction, StoreError};
use serde_json::{Value, json};
fn hints(token: Option<&Token>, auth: &str) -> Result<Value, ModelError> {
    let Some(token) = token else {
        return Ok(json!({"oauthConfigured":false}));
    };
    token.validate_provider(auth)?;
    token.ensure_ready()?;
    let access = token
        .text("access")
        .ok_or(ModelError::new("model_oauth_metadata_token_invalid"))?;
    let expiry = token
        .expires()
        .filter(|v| *v > 0 && *v <= 9_007_199_254_740_991)
        .ok_or(ModelError::new("model_oauth_metadata_token_invalid"))?;
    if access.trim().is_empty()
        || reqwest::header::HeaderValue::from_str(&format!("Bearer {access}")).is_err()
    {
        return Err(ModelError::new("model_oauth_metadata_token_invalid"));
    }
    let mut value = json!({"oauthConfigured":true,"oauthExpires":expiry});
    if let Some(account) = token.text("accountId") {
        if account.len() > 512 || reqwest::header::HeaderValue::from_str(account).is_err() {
            return Err(ModelError::new("model_oauth_metadata_token_invalid"));
        }
        value["oauthAccountId"] = json!(account);
    } else if auth == "oauth_chatgpt" {
        return Err(ModelError::new("model_oauth_account_required"));
    }
    Ok(value)
}
fn apply(config: &mut Value, id: &str, hints: &Value) -> Result<bool, ModelError> {
    let channels = config["channels"]
        .as_array_mut()
        .ok_or(ModelError::new("model_config_invalid"))?;
    if channels.iter().filter(|v| v["id"] == id).count() != 1 {
        return Err(ModelError::new("model_configuration_changed"));
    }
    let channel = channels
        .iter_mut()
        .find(|v| v["id"] == id)
        .unwrap()
        .as_object_mut()
        .ok_or(ModelError::new("model_config_invalid"))?;
    let mut changed = false;
    for field in model_oauth_hint_fields() {
        if let Some(value) = hints.get(field) {
            if channel.get(field) != Some(value) {
                channel.insert(field.clone(), value.clone());
                changed = true;
            }
        } else if channel.remove(field).is_some() {
            changed = true;
        }
    }
    for model in config["models"]
        .as_array_mut()
        .ok_or(ModelError::new("model_config_invalid"))?
        .iter_mut()
        .filter(|v| v["groupId"] == id)
    {
        let model = model
            .as_object_mut()
            .ok_or(ModelError::new("model_config_invalid"))?;
        for field in model_oauth_hint_fields() {
            if model.remove(field).is_some() {
                changed = true;
            }
        }
    }
    Ok(changed)
}
pub(crate) fn persist(
    guard: ModelConfigTransaction,
    id: &str,
    auth: &str,
    token: Option<&Token>,
    cancel: &CancellationToken,
) -> Result<ModelMetadataState, ModelError> {
    let hints = hints(token, auth)?;
    let mut config = guard.snapshot().value.clone();
    if !apply(&mut config, id, &hints)? {
        return Ok(if guard.finish().is_ok() {
            ModelMetadataState::Synced
        } else {
            ModelMetadataState::CommitUnknown
        });
    }
    if cancel.is_cancelled() {
        return Ok(ModelMetadataState::RebuildRequired);
    }
    let revision = guard.snapshot().source_revision.clone();
    Ok(match guard.commit(&revision, &config, None) {
        Ok(_) => ModelMetadataState::Synced,
        Err(
            StoreError::CommitUncertain
            | StoreError::LockOwnershipChanged
            | StoreError::VersionChanged,
        ) => ModelMetadataState::CommitUnknown,
        Err(_) => ModelMetadataState::RebuildRequired,
    })
}
