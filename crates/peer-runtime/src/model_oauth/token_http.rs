//! Shared pinned OAuth token exchange: one request, bounded body, no redirects/replay.
use super::{ModelError, Token};
use std::time::Duration;
pub(crate) async fn request(
    network: &crate::network::Network,
    cancel: &crate::CancellationToken,
    url: &reqwest::Url,
    form: &str,
    started: Option<&std::sync::atomic::AtomicBool>,
) -> Result<Token, ModelError> {
    let client = network
        .builder(url, cancel)
        .await
        .map_err(|e| ModelError::new(e.0))?
        .connect_timeout(Duration::from_secs(5))
        .read_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(15))
        .build()
        .map_err(|_| ModelError::new("model_oauth_transport_unavailable"))?;
    if let Some(started) = started {
        started.store(true, std::sync::atomic::Ordering::Release);
    }
    let mut response = client
        .post(url.clone())
        .header("content-type", "application/x-www-form-urlencoded")
        .header("connection", "close")
        .body(form.to_string())
        .send()
        .await
        .map_err(|_| ModelError::new("model_oauth_refresh_transport_failed"))?;
    if !response.status().is_success() {
        return Err(ModelError::new("model_oauth_refresh_rejected"));
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| {
            v.split(';')
                .next()
                .is_some_and(|v| v.trim().eq_ignore_ascii_case("application/json"))
        })
    {
        return Err(ModelError::new("model_oauth_refresh_content_type"));
    }
    let mut body = zeroize::Zeroizing::new(Vec::new());
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| ModelError::new("model_oauth_refresh_interrupted"))?
    {
        if body.len() + chunk.len() > 65536 {
            return Err(ModelError::new("model_oauth_refresh_limit"));
        }
        body.extend_from_slice(&chunk);
    }
    Token::parse(
        std::str::from_utf8(&body).map_err(|_| ModelError::new("model_oauth_refresh_invalid"))?,
    )
}
