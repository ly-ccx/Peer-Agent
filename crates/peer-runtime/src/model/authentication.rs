//! Credential lifetime belongs to the model's selected account adapter.
use super::*;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
pub(super) enum Access {
    Anonymous,
    Key(Secret),
    OAuth(Box<crate::model_oauth::ModelOAuth>),
}
impl Access {
    pub fn from_key(key: Option<Secret>) -> Self {
        key.map(Self::Key).unwrap_or(Self::Anonymous)
    }
    pub async fn apply(
        &self,
        headers: &mut HeaderMap,
        wire: wire::Wire,
        cancel: &CancellationToken,
    ) -> Result<(), ModelError> {
        let oauth = match self {
            Self::OAuth(oauth) => Some(oauth.access(cancel).await?),
            _ => None,
        };
        if let Some((account, name)) = oauth
            .as_ref()
            .and_then(|v| v.account.as_deref().zip(v.account_header.as_deref()))
        {
            if account.len() > 512 {
                return Err(ModelError::new("model_oauth_account_invalid"));
            }
            let mut value = HeaderValue::from_str(account)
                .map_err(|_| ModelError::new("model_oauth_account_invalid"))?;
            value.set_sensitive(true);
            headers.insert(
                HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| ModelError::new("model_header_invalid"))?,
                value,
            );
        }
        let key = match self {
            Self::Key(key) => Some(key),
            _ => None,
        };
        if let Some(secret) = oauth.as_ref().map(|v| &v.secret).or(key) {
            let bearer = zeroize::Zeroizing::new(
                if oauth.is_some() || matches!(wire, wire::Wire::Chat | wire::Wire::Responses) {
                    format!("Bearer {}", secret.expose())
                } else {
                    secret.expose().to_owned()
                },
            );
            let mut value = HeaderValue::from_str(&bearer)
                .map_err(|_| ModelError::new("model_credential_invalid"))?;
            value.set_sensitive(true);
            headers.insert(
                if oauth.is_some() {
                    "authorization"
                } else {
                    match wire {
                        wire::Wire::Anthropic => "x-api-key",
                        wire::Wire::Gemini => "x-goog-api-key",
                        _ => "authorization",
                    }
                },
                value,
            );
        }
        Ok(())
    }
}
