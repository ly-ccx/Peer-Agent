//! Model OAuth stays in the native host. A successful refresh is committed
//! conditionally in Helper before the token can enter a model request.
use crate::{
    CancellationToken,
    credentials::{HelperClient, Secret},
    model::ModelError,
    model_config::ModelBinding,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{path::Path, sync::OnceLock, time::Duration};
pub(crate) mod projection;
#[cfg(test)]
mod tests;
pub(crate) mod token;
pub(crate) mod token_http;
use token::Token;
fn registry() -> &'static Value {
    static DATA: OnceLock<Value> = OnceLock::new();
    DATA.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/model-oauth-registry.json"
        ))
        .expect("verified model OAuth contract")
    })
}
pub(crate) fn provider(auth: &str) -> Option<&'static Value> {
    registry()["providers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["authMethod"] == auth)
}
pub(crate) fn context_window(
    auth: &str,
    model: &str,
    values: &Value,
) -> Result<Option<u64>, ModelError> {
    if auth != "oauth_chatgpt" {
        return Ok(None);
    }
    let metadata = registry()["subscriptionCatalog"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["id"] == model)
        .ok_or(ModelError::new("model_subscription_unavailable"))?;
    let definition = metadata["modelOptions"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|v| v["id"] == "contextTier" && v["kind"] == "select");
    let Some(definition) = definition else {
        return Ok(metadata["contextWindow"].as_u64());
    };
    let selected = values
        .get("contextTier")
        .filter(|v| !v.is_null())
        .unwrap_or(&definition["defaultValue"]);
    let choices = definition["choices"]
        .as_array()
        .ok_or(ModelError::new("model_subscription_unavailable"))?;
    let equals = |left: &Value, right: &Value| {
        if left.is_number() && right.is_number() {
            left.as_f64() == right.as_f64()
        } else {
            left == right
        }
    };
    let choice = choices
        .iter()
        .find(|v| equals(&v["value"], selected))
        .or_else(|| {
            choices
                .iter()
                .find(|v| v["value"] == definition["defaultValue"])
        })
        .or_else(|| choices.first());
    Ok(choice
        .and_then(|v| v["contextWindow"].as_u64())
        .or_else(|| metadata["contextWindow"].as_u64()))
}
pub(crate) fn now_ms() -> Result<u64, ModelError> {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .map_err(|_| ModelError::new("model_oauth_clock_invalid"))
}
fn stamp(secret: &Secret, revision: Option<&str>) -> String {
    format!(
        "{:x}:{}",
        Sha256::digest(secret.expose().as_bytes()),
        revision.unwrap_or("legacy")
    )
}
pub(crate) struct Access {
    pub secret: Secret,
    pub account: Option<String>,
}
pub(crate) struct ModelOAuth {
    helper: HelperClient,
    key: String,
    auth: String,
    binding: ModelBinding,
    network: crate::network::Network,
    token_url: reqwest::Url,
    state: tokio::sync::Mutex<String>,
    cas: bool,
    account: Option<String>,
    pub project: Option<String>,
}
impl ModelOAuth {
    pub(crate) async fn load(
        home: &Path,
        key: &str,
        auth: &str,
        binding: ModelBinding,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        let helper = HelperClient::for_home(home)
            .map_err(|_| ModelError::new("credential_helper_unavailable"))?;
        Self::load_with_helper(home, key, auth, binding, helper, cancel).await
    }
    async fn load_with_helper(
        home: &Path,
        key: &str,
        auth: &str,
        binding: ModelBinding,
        helper: HelperClient,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        let provider = provider(auth).ok_or(ModelError::new("native_model_auth_unsupported"))?;
        let guard = binding.transaction(cancel).await?;
        let cas = helper
            .supports_model_oauth_cas(cancel)
            .await
            .map_err(|_| ModelError::new("model_credential_unavailable"))?;
        let (secret, revision) = if cas {
            let snapshot = helper
                .get_snapshot(key, cancel)
                .await
                .map_err(|_| ModelError::new("model_credential_unavailable"))?;
            (snapshot.secret, snapshot.revision)
        } else {
            (
                helper
                    .get(key, cancel)
                    .await
                    .map_err(|_| ModelError::new("model_credential_unavailable"))?,
                None,
            )
        };
        let secret = secret.ok_or(ModelError::new("model_credential_missing"))?;
        let token = Token::parse(secret.expose())?;
        token.validate_provider(auth)?;
        token.ensure_ready()?;
        let network = crate::network::Network::new().map_err(|e| ModelError::new(e.0))?;
        let (_, token_url) = endpoints(home, auth, provider["baseUrl"].as_str().unwrap())?;
        guard
            .finish()
            .map_err(|_| ModelError::new("model_configuration_changed"))?;
        Ok(Self {
            helper,
            key: key.into(),
            auth: auth.into(),
            binding,
            network,
            token_url,
            state: tokio::sync::Mutex::new(stamp(&secret, revision.as_deref())),
            cas,
            account: token.account(),
            project: token.project(),
        })
    }
    pub(crate) async fn access(&self, cancel: &CancellationToken) -> Result<Access, ModelError> {
        let mut expected = tokio::select! { biased; _=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")), state=self.state.lock()=>state };
        let guard = self.binding.transaction(cancel).await?;
        let (secret, revision) = if self.cas {
            let snapshot = self
                .helper
                .get_snapshot(&self.key, cancel)
                .await
                .map_err(|_| ModelError::new("model_credential_unavailable"))?;
            (snapshot.secret, snapshot.revision)
        } else {
            (
                self.helper
                    .get(&self.key, cancel)
                    .await
                    .map_err(|_| ModelError::new("model_credential_unavailable"))?,
                None,
            )
        };
        let secret = secret.ok_or(ModelError::new("model_credential_changed"))?;
        if stamp(&secret, revision.as_deref()) != *expected {
            return Err(ModelError::new("model_credential_changed"));
        }
        let mut token = Token::parse(secret.expose())?;
        token.validate_provider(&self.auth)?;
        token.ensure_ready()?;
        if !token.current(now_ms()?) {
            if !self.cas
                || !self
                    .helper
                    .supports_model_oauth_cas(cancel)
                    .await
                    .map_err(|_| ModelError::new("model_credential_unavailable"))?
            {
                return Err(ModelError::new("model_oauth_helper_upgrade_required"));
            }
            let form = token.refresh_form(provider(&self.auth).unwrap())?;
            self.binding.validate()?;
            let pending = token.reservation(&self.auth, now_ms()?)?;
            if !self
                .helper
                .compare_set(&self.key, revision.as_deref(), Some(&pending), cancel)
                .await
                .map_err(|_| ModelError::new("model_oauth_reservation_unknown"))?
            {
                return Err(ModelError::new("model_credential_changed"));
            }
            let claim = self
                .helper
                .get_snapshot(&self.key, cancel)
                .await
                .map_err(|_| ModelError::new("model_oauth_reservation_unknown"))?;
            if claim.secret.as_ref().is_none_or(|value| {
                Sha256::digest(value.expose().as_bytes()) != Sha256::digest(pending.as_bytes())
            }) {
                return Err(ModelError::new("model_credential_changed"));
            }
            let claim_revision = claim.revision;
            self.binding.validate()?;
            guard
                .finish()
                .map_err(|_| ModelError::new("model_oauth_reservation_unknown"))?;
            let started = std::sync::atomic::AtomicBool::new(false);
            let refresh = async {
                token_http::request(
                    &self.network,
                    cancel,
                    &self.token_url,
                    &form,
                    Some(&started),
                )
                .await
            };
            let response = tokio::select! { biased; _=cancel.cancelled()=>Err(ModelError::new("CANCELLED")), result=tokio::time::timeout(Duration::from_secs(15),refresh)=>result.unwrap_or_else(|_|Err(ModelError::new("model_oauth_refresh_timeout"))) };
            if response.is_err() && !started.load(std::sync::atomic::Ordering::Acquire) {
                let cleanup = CancellationToken::new();
                if let Ok(cleanup_guard) = self.binding.transaction(&cleanup).await {
                    let _ = self
                        .helper
                        .compare_set(
                            &self.key,
                            claim_revision.as_deref(),
                            Some(secret.expose()),
                            &cleanup,
                        )
                        .await;
                    let _ = cleanup_guard.finish();
                }
            }
            let response = response?;
            token.updated(&response, &self.auth, now_ms()?)?;
            let updated = token.serialize()?;
            let write_guard = self.binding.transaction(cancel).await?;
            let applied = self
                .helper
                .compare_set(&self.key, claim_revision.as_deref(), Some(&updated), cancel)
                .await
                .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?;
            if !applied {
                return Err(ModelError::new("model_credential_changed"));
            }
            let current = self
                .helper
                .get_snapshot(&self.key, cancel)
                .await
                .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?;
            let current_secret = current
                .secret
                .ok_or(ModelError::new("model_credential_changed"))?;
            if Sha256::digest(current_secret.expose().as_bytes())
                != Sha256::digest(updated.as_bytes())
            {
                return Err(ModelError::new("model_credential_changed"));
            }
            *expected = stamp(&current_secret, current.revision.as_deref());
            let _metadata = projection::persist(
                write_guard,
                self.binding.channel_id(),
                &self.auth,
                Some(&token),
                cancel,
            );
            // A failed hint cannot invalidate a proven credential. Re-admit
            // only against the actual operational config and Vault generation.
            let verify_guard = self.binding.transaction(cancel).await?;
            let actual = self
                .helper
                .get_snapshot(&self.key, cancel)
                .await
                .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?;
            if actual
                .secret
                .as_ref()
                .is_none_or(|s| stamp(s, actual.revision.as_deref()) != *expected)
            {
                return Err(ModelError::new("model_credential_changed"));
            }
            verify_guard
                .finish()
                .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?;
        } else {
            guard
                .finish()
                .map_err(|_| ModelError::new("model_configuration_changed"))?;
        }
        self.binding.validate()?;
        if token.account() != self.account || token.project() != self.project {
            return Err(ModelError::new("model_oauth_binding_changed"));
        }
        let account = token.account();
        if self.auth == "oauth_chatgpt" && account.is_none() {
            return Err(ModelError::new("model_oauth_account_required"));
        }
        Ok(Access {
            secret: token.access()?,
            account,
        })
    }
}

pub(crate) fn endpoints(
    home: &Path,
    auth: &str,
    base: &str,
) -> Result<(String, reqwest::Url), ModelError> {
    let provider = provider(auth).ok_or(ModelError::new("native_model_auth_unsupported"))?;
    #[cfg(any(test, feature = "test-fixtures"))]
    {
        let file = home.join(".native-model-oauth-fixture.json");
        if file.is_file() {
            if !home.join(".native-cli-fixture").is_file() {
                return Err(ModelError::new("model_oauth_fixture_denied"));
            }
            let bytes =
                std::fs::read(file).map_err(|_| ModelError::new("model_oauth_fixture_denied"))?;
            let value = peer_protocol::decode_json_bounded(
                &bytes,
                peer_protocol::JsonLimits {
                    bytes: 4096,
                    nodes: 32,
                    depth: 4,
                    string_bytes: 4096,
                },
            )
            .map_err(|_| ModelError::new("model_oauth_fixture_denied"))?
            .value;
            let parse = |key: &str| -> Result<reqwest::Url, ModelError> {
                let url = reqwest::Url::parse(value[key].as_str().unwrap_or(""))
                    .map_err(|_| ModelError::new("model_oauth_fixture_denied"))?;
                if url.scheme() != "http"
                    || !url
                        .host_str()
                        .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                        .is_some_and(|ip| ip.is_loopback())
                    || !url.username().is_empty()
                    || url.password().is_some()
                    || url.query().is_some()
                    || url.fragment().is_some()
                {
                    return Err(ModelError::new("model_oauth_fixture_denied"));
                }
                Ok(url)
            };
            return Ok((
                parse("modelBaseUrl")?
                    .to_string()
                    .trim_end_matches('/')
                    .into(),
                parse("tokenUrl")?,
            ));
        }
    }
    let _ = home;
    Ok((
        base.into(),
        reqwest::Url::parse(provider["tokenUrl"].as_str().unwrap())
            .map_err(|_| ModelError::new("model_oauth_endpoint_invalid"))?,
    ))
}
