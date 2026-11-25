//! Grok subscription compatibility is a bounded transport adapter, not an agent loop.
use super::{ModelError, NativeModel};
use crate::{CancellationToken, model_oauth::provider};
use reqwest::{Response, Url};
use std::{
    path::Path,
    time::{Duration, Instant},
};
#[derive(Clone)]
struct Cached {
    version: String,
    at: Instant,
}
pub(super) struct Compatibility {
    release: Url,
    cache: tokio::sync::Mutex<Option<Cached>>,
}
impl Compatibility {
    pub(crate) fn new(home: &Path) -> Result<Self, ModelError> {
        let policy = &provider("oauth_grok").unwrap()["compatibility"];
        let release = Url::parse(policy["releaseUrl"].as_str().unwrap())
            .map_err(|_| ModelError::new("grok_compatibility_unavailable"))?;
        #[cfg(any(test, feature = "test-fixtures"))]
        let mut release = release;
        #[cfg(any(test, feature = "test-fixtures"))]
        if home.join(".native-model-oauth-fixture.json").exists() {
            if !home.join(".native-cli-fixture").is_file() {
                return Err(ModelError::new("model_oauth_fixture_denied"));
            }
            let data = crate::model_config::read(&home.join(".native-model-oauth-fixture.json"))?;
            let url = Url::parse(data["versionUrl"].as_str().unwrap_or(""))
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
            release = url;
        }
        let _ = home;
        Ok(Self {
            release,
            cache: tokio::sync::Mutex::new(None),
        })
    }
    async fn version(
        &self,
        model: &NativeModel,
        cancel: &CancellationToken,
        force: bool,
    ) -> Result<String, ModelError> {
        let policy = &provider("oauth_grok").unwrap()["compatibility"];
        let ttl = Duration::from_millis(policy["cacheTtlMs"].as_u64().unwrap());
        let stale = Duration::from_millis(policy["maxStaleMs"].as_u64().unwrap());
        let timeout = Duration::from_millis(policy["timeoutMs"].as_u64().unwrap());
        let mut cache = tokio::select! {biased;_=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")),c=self.cache.lock()=>c};
        if !force && let Some(value) = cache.as_ref().filter(|v| v.at.elapsed() < ttl) {
            return Ok(value.version.clone());
        }
        let previous = cache.clone();
        if force {
            *cache = None;
        }
        let discover = async {
            let client = model
                .network
                .prepare(&self.release, cancel)
                .await
                .map_err(|e| ModelError::new(e.0))?
                .builder
                .timeout(timeout)
                .build()
                .map_err(|_| ModelError::new("grok_compatibility_unavailable"))?;
            // No origin credentials or custom provider headers may enter this request.
            let mut response = client
                .get(self.release.clone())
                .header("accept", "text/plain")
                .send()
                .await
                .map_err(|_| ModelError::new("grok_compatibility_unavailable"))?;
            if !response.status().is_success() {
                return Err(ModelError::new("grok_compatibility_unavailable"));
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = response
                .chunk()
                .await
                .map_err(|_| ModelError::new("grok_compatibility_unavailable"))?
            {
                if bytes.len() + chunk.len() > policy["bodyBytes"].as_u64().unwrap() as usize {
                    return Err(ModelError::new("grok_compatibility_unavailable"));
                }
                bytes.extend_from_slice(&chunk);
            }
            let version = std::str::from_utf8(&bytes)
                .map_err(|_| ModelError::new("grok_compatibility_unavailable"))?
                .trim();
            validate(version)?;
            Ok(version.to_owned())
        };
        let result = tokio::select! {biased;_=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")),r=tokio::time::timeout(timeout,discover)=>r.unwrap_or_else(|_|Err(ModelError::new("grok_compatibility_unavailable")))};
        match result {
            Ok(version) => {
                *cache = Some(Cached {
                    version: version.clone(),
                    at: Instant::now(),
                });
                Ok(version)
            }
            Err(error) if !force && error.code != "grok_subscription_upgrade_required" => {
                if let Some(value) = previous.filter(|v| v.at.elapsed() < stale) {
                    Ok(value.version)
                } else {
                    Err(error)
                }
            }
            Err(error) => Err(error),
        }
    }
    pub(super) async fn send(
        &self,
        model: &NativeModel,
        body: &[u8],
        cancel: &CancellationToken,
    ) -> Result<Response, ModelError> {
        let version = self.version(model, cancel, false).await?;
        let send = async |version: &str| {
            // In particular this rechecks actual credentials/config after metadata wait,
            // and again before the one permitted pre-inference compatibility resend.
            model
                .request_builder(model.endpoint.clone(), "text/event-stream", cancel)
                .await?
                .header("x-grok-client-version", version)
                .body(body.to_vec())
                .send()
                .await
                .map_err(|_| ModelError::new("model_transport_failed"))
        };
        let response = send(&version).await?;
        if response.status() != reqwest::StatusCode::UPGRADE_REQUIRED {
            return Ok(response);
        }
        let refreshed = self.version(model, cancel, true).await;
        if cancel.is_cancelled() {
            return Err(ModelError::new("CANCELLED"));
        }
        let Ok(refreshed) = refreshed else {
            return Ok(response);
        };
        if refreshed == version {
            return Ok(response);
        }
        drop(response);
        send(&refreshed).await
    }
}
fn validate(version: &str) -> Result<(), ModelError> {
    let parts = version.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || !p.bytes().all(|c| c.is_ascii_digit()))
    {
        return Err(ModelError::new("grok_compatibility_unavailable"));
    }
    if parts[0] != "1" {
        return Err(ModelError::new("grok_subscription_upgrade_required"));
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_verified_major_and_exact_release_syntax_are_accepted() {
        for version in ["1.0.77", "1.100.0"] {
            assert!(validate(version).is_ok());
        }
        for version in ["1.0.77-beta", "1.2.3.4", "1.0. 1", "1.0", "x.1.0"] {
            assert!(validate(version).is_err());
        }
        assert_eq!(
            validate("2.0.0").unwrap_err().code,
            "grok_subscription_upgrade_required"
        );
    }
}
