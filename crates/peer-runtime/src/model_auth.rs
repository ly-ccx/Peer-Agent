//! Explicit account management. It cannot execute a tool or admit a task.
use crate::{
    CancellationToken,
    credentials::{CredentialError, CredentialSnapshot, HelperClient},
    model::ModelError,
    model_oauth::{now_ms, provider, token::Token, token_http},
    oauth_callback,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use peer_protocol::{ModelAccountState, ModelAccountStatus};
use reqwest::Url;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn credential_error(error: CredentialError) -> ModelError {
    ModelError::new(if error == CredentialError::Cancelled {
        "CANCELLED"
    } else {
        "model_credential_unavailable"
    })
}
mod config;
use config::LoginConfig;
struct Account {
    home: PathBuf,
    channel: Value,
    id: String,
    auth: String,
    key: String,
    helper: HelperClient,
}
impl Account {
    fn load(home: &Path, id: &str) -> Result<Self, ModelError> {
        if id.is_empty()
            || id.contains("..")
            || id.len() > 200
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b))
        {
            return Err(ModelError::new("model_account_id_invalid"));
        }
        let config = crate::model_config::read(&home.join("llm-providers.json"))?;
        let channel = Self::channel(&config, id)?;
        if ["apiKey", "oauthTokens", "oauthClientSecret"]
            .iter()
            .any(|key| channel.get(key).is_some())
            || !channel["proxy"].is_null()
        {
            return Err(ModelError::new("native_model_channel_unsupported"));
        }
        let auth = crate::model_config::account_auth(&channel)?;
        let helper = HelperClient::for_home(home)
            .map_err(|_| ModelError::new("credential_helper_unavailable"))?;
        Ok(Self {
            home: home.into(),
            channel,
            id: id.into(),
            auth,
            key: format!("model/{id}/oauth-tokens"),
            helper,
        })
    }
    fn channel(config: &Value, id: &str) -> Result<Value, ModelError> {
        if config["version"] != 2 {
            return Err(ModelError::new("native_legacy_model_config_unsupported"));
        }
        if !config["models"].is_array() {
            return Err(ModelError::new("model_config_invalid"));
        }
        let channels = config["channels"]
            .as_array()
            .ok_or(ModelError::new("model_config_invalid"))?;
        let mut matches = channels.iter().filter(|v| v["id"] == id);
        let channel = matches
            .next()
            .ok_or(ModelError::new("model_account_unavailable"))?;
        if matches.next().is_some() {
            return Err(ModelError::new("model_config_invalid"));
        }
        Ok(channel.clone())
    }
    fn validate(&self) -> Result<(), ModelError> {
        let config = crate::model_config::read(&self.home.join("llm-providers.json"))?;
        if Self::channel(&config, &self.id)? != self.channel {
            return Err(ModelError::new("model_configuration_changed"));
        }
        Ok(())
    }
    async fn snapshot(&self, cancel: &CancellationToken) -> Result<CredentialSnapshot, ModelError> {
        if !self
            .helper
            .supports_model_oauth_cas(cancel)
            .await
            .map_err(credential_error)?
        {
            return Err(ModelError::new("model_oauth_helper_upgrade_required"));
        }
        self.helper
            .get_snapshot(&self.key, cancel)
            .await
            .map_err(credential_error)
    }
}
pub async fn status(
    home: &Path,
    id: &str,
    cancel: &CancellationToken,
) -> Result<ModelAccountStatus, ModelError> {
    let account = Account::load(home, id)?;
    let conditional = account
        .helper
        .supports_model_oauth_cas(cancel)
        .await
        .map_err(credential_error)?;
    let secret = if conditional {
        account
            .helper
            .get_snapshot(&account.key, cancel)
            .await
            .map_err(credential_error)?
            .secret
    } else {
        account
            .helper
            .get(&account.key, cancel)
            .await
            .map_err(credential_error)?
    };
    account.validate()?;
    let mut expires = None;
    let state = match secret {
        None => ModelAccountState::NotLoggedIn,
        Some(secret) => match Token::parse(secret.expose()) {
            Ok(token)
                if token.validate_provider(&account.auth).is_ok()
                    && token.ensure_ready().is_ok() =>
            {
                expires = token.expires();
                if account.auth == "oauth_chatgpt" && token.text("accountId").is_none() {
                    ModelAccountState::RecoveryRequired
                } else if token.current(now_ms()?) {
                    ModelAccountState::Authenticated
                } else if token.text("refresh").is_none() {
                    ModelAccountState::RecoveryRequired
                } else {
                    ModelAccountState::RefreshRequired
                }
            }
            _ => ModelAccountState::RecoveryRequired,
        },
    };
    Ok(ModelAccountStatus {
        channel_id: account.id,
        auth_method: account.auth,
        status: state,
        expires,
    })
}
pub async fn logout(home: &Path, id: &str, cancel: &CancellationToken) -> Result<(), ModelError> {
    let account = Account::load(home, id)?;
    let snapshot = account.snapshot(cancel).await?;
    account.validate()?;
    if !account
        .helper
        .compare_set(&account.key, snapshot.revision.as_deref(), None, cancel)
        .await
        .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?
    {
        return Err(ModelError::new("model_credential_changed"));
    }
    let after = account
        .snapshot(cancel)
        .await
        .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?;
    if after.secret.is_some() {
        return Err(ModelError::new("model_credential_changed"));
    }
    Ok(())
}
fn callback_error(error: oauth_callback::Error) -> ModelError {
    use oauth_callback::Error;
    ModelError::new(match error {
        Error::Redirect => "model_oauth_redirect_invalid",
        Error::Unavailable => "model_oauth_callback_unavailable",
        Error::State => "model_oauth_state_missing",
        Error::Url => "model_oauth_url_invalid",
        Error::Failed => "model_oauth_callback_failed",
        Error::Timeout => "model_oauth_timeout",
        Error::Limit => "model_oauth_callback_limit",
        Error::Cancelled => "CANCELLED",
        Error::Denied => "model_oauth_denied",
    })
}
fn random() -> Result<zeroize::Zeroizing<String>, ModelError> {
    let mut bytes = zeroize::Zeroizing::new([0u8; 32]);
    getrandom::fill(bytes.as_mut())
        .map_err(|_| ModelError::new("model_oauth_random_unavailable"))?;
    Ok(zeroize::Zeroizing::new(
        URL_SAFE_NO_PAD.encode(bytes.as_ref()),
    ))
}
pub async fn authorize(
    home: &Path,
    id: &str,
    cancel: &CancellationToken,
    present: impl FnOnce(&str) -> Result<(), ModelError>,
) -> Result<(), ModelError> {
    let account = Account::load(home, id)?;
    let before = account.snapshot(cancel).await?;
    let descriptor = provider(&account.auth).unwrap();
    let config = LoginConfig::load(home, descriptor)?;
    let verifier = random()?;
    let state = random()?;
    let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
    let (listener, redirect) = oauth_callback::listen(&config.redirect)
        .await
        .map_err(callback_error)?;
    let mut authorization = config.authorization;
    {
        let mut query = authorization.query_pairs_mut();
        for (key, value) in descriptor["login"]["parameters"]
            .as_object()
            .into_iter()
            .flatten()
        {
            query.append_pair(
                key,
                value
                    .as_str()
                    .ok_or(ModelError::new("model_oauth_config_invalid"))?,
            );
        }
        query
            .append_pair("client_id", descriptor["clientId"].as_str().unwrap())
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &redirect)
            .append_pair(
                "scope",
                descriptor["login"]["scope"]
                    .as_str()
                    .ok_or(ModelError::new("model_oauth_config_invalid"))?,
            )
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256")
            .append_pair("state", &state);
    }
    account.validate()?;
    if cancel.is_cancelled() {
        return Err(ModelError::new("CANCELLED"));
    }
    present(authorization.as_str())?;
    let callback = oauth_callback::wait(
        listener,
        &redirect,
        authorization.as_str(),
        cancel,
        config.wait,
        true,
    )
    .await
    .map_err(callback_error)?;
    let callback =
        Url::parse(&callback).map_err(|_| ModelError::new("model_oauth_callback_failed"))?;
    let code = zeroize::Zeroizing::new(
        callback
            .query_pairs()
            .find(|(k, _)| k == "code")
            .unwrap()
            .1
            .into_owned(),
    );
    let mut form = Url::parse("https://unused.invalid").unwrap();
    {
        let mut query = form.query_pairs_mut();
        query
            .append_pair("grant_type", "authorization_code")
            .append_pair("client_id", descriptor["clientId"].as_str().unwrap())
            .append_pair("code", &code)
            .append_pair("redirect_uri", &redirect)
            .append_pair("code_verifier", &verifier);
        if let Some(secret) = descriptor["clientSecret"].as_str() {
            query.append_pair("client_secret", secret);
        }
    }
    let form = zeroize::Zeroizing::new(form.query().unwrap().to_owned());
    account.validate()?;
    let current = account.snapshot(cancel).await?;
    if current.revision != before.revision {
        return Err(ModelError::new("model_credential_changed"));
    }
    let client = token_http::client()?;
    let response = tokio::select! {biased;_=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")), result=token_http::request(&client,&config.token,&form)=>result.map_err(|_|ModelError::new("model_oauth_exchange_failed"))?};
    let tokens = Token::login(&response, &account.auth, now_ms()?)?.serialize()?;
    account.validate()?;
    if !account
        .helper
        .compare_set(
            &account.key,
            before.revision.as_deref(),
            Some(&tokens),
            cancel,
        )
        .await
        .map_err(|_| ModelError::new("model_oauth_commit_unknown"))?
    {
        return Err(ModelError::new("model_credential_changed"));
    }
    let current = account.snapshot(cancel).await?;
    if current
        .secret
        .as_ref()
        .is_none_or(|s| Sha256::digest(s.expose().as_bytes()) != Sha256::digest(tokens.as_bytes()))
    {
        return Err(ModelError::new("model_oauth_commit_unknown"));
    }
    account
        .validate()
        .map_err(|_| ModelError::new("model_oauth_configuration_changed_after_commit"))?;
    Ok(())
}
