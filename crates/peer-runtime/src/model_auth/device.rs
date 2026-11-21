//! A device grant belongs to one explicit account-management operation.
//! Codes never enter persistent state, tool projection, or a model request.
use super::*;
use peer_protocol::ModelAuthorizationPrompt;
use tokio::time::Instant;
struct Config {
    device: Url,
    token: Url,
    userinfo: Url,
    wait: Duration,
    fixture: bool,
}
impl Config {
    fn load(home: &Path, descriptor: &Value) -> Result<Self, ModelError> {
        let parse = |v: &Value| {
            Url::parse(v.as_str().unwrap_or(""))
                .map_err(|_| ModelError::new("model_oauth_config_invalid"))
        };
        let result = Self {
            device: parse(&descriptor["login"]["deviceUrl"])?,
            token: parse(&descriptor["tokenUrl"])?,
            userinfo: parse(&descriptor["login"]["userinfoUrl"])?,
            wait: Duration::from_secs(900),
            fixture: false,
        };
        #[cfg(any(test, feature = "test-fixtures"))]
        let mut result = result;
        #[cfg(any(test, feature = "test-fixtures"))]
        if home.join(".native-model-login-fixture.json").exists() {
            if !home.join(".native-cli-fixture").is_file() {
                return Err(ModelError::new("model_oauth_fixture_denied"));
            }
            let data = crate::model_config::read(&home.join(".native-model-login-fixture.json"))?;
            if data.to_string().len() > 4096 {
                return Err(ModelError::new("model_oauth_fixture_denied"));
            }
            let local = |field: &str| -> Result<Url, ModelError> {
                let url = parse(&data[field])?;
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
            result.device = local("deviceUrl")?;
            result.token = local("tokenUrl")?;
            result.userinfo = local("userinfoUrl")?;
            result.fixture = true;
            if let Some(ms) = data["waitMs"].as_u64() {
                if !(100..=900000).contains(&ms) {
                    return Err(ModelError::new("model_oauth_fixture_denied"));
                }
                result.wait = Duration::from_millis(ms);
            }
        }
        let _ = home;
        Ok(result)
    }
}
fn form(pairs: &[(&str, &str)]) -> zeroize::Zeroizing<String> {
    zeroize::Zeroizing::new(url_form(pairs))
}
fn url_form(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("https://unused.invalid").unwrap();
    {
        let mut query = url.query_pairs_mut();
        for (key, value) in pairs {
            query.append_pair(key, value);
        }
    }
    url.query().unwrap().into()
}
fn seconds(token: &Token, field: &str, default: u64) -> Result<u64, ModelError> {
    if !token.has(field) {
        return Ok(default);
    }
    token
        .number(field)
        .or_else(|| token.text(field).and_then(|v| v.parse().ok()))
        .filter(|v| *v > 0 && *v <= 86400)
        .ok_or(ModelError::new("grok_device_response_invalid"))
}

async fn current(
    account: &Account,
    before: &CredentialSnapshot,
    cancel: &CancellationToken,
) -> Result<(), ModelError> {
    let guard = account.transaction(cancel).await?;
    let actual = account.snapshot(cancel).await?;
    if actual.revision != before.revision {
        return Err(ModelError::new("model_credential_changed"));
    }
    guard
        .finish()
        .map_err(|_| ModelError::new("model_configuration_changed"))
}
async fn exchange(
    account: &Account,
    before: &CredentialSnapshot,
    network: &crate::network::Network,
    url: &Url,
    form: &str,
    cancel: &CancellationToken,
    deadline: Instant,
) -> Result<(reqwest::StatusCode, Token), ModelError> {
    current(account, before, cancel).await?;
    tokio::select! {biased;_=cancel.cancelled()=>Err(ModelError::new("CANCELLED")),response=tokio::time::timeout_at(deadline,token_http::exchange(network,cancel,url,form,None,true))=>response.unwrap_or_else(|_|Err(ModelError::new("grok_device_code_expired")))}
}
fn verification(
    raw: &str,
    device: &str,
    config: &Config,
    descriptor: &Value,
) -> Result<String, ModelError> {
    if raw.len() > 4096
        || raw.chars().any(char::is_control)
        || raw.trim() != raw
        || raw.contains(device)
    {
        return Err(ModelError::new("grok_device_response_invalid"));
    }
    let url = Url::parse(raw).map_err(|_| ModelError::new("grok_device_response_invalid"))?;
    let allowed = descriptor["login"]["verificationOrigins"]
        .as_array()
        .unwrap()
        .iter()
        .any(|v| v.as_str() == Some(&url.origin().ascii_serialization()));
    let local = config.fixture
        && url.scheme() == "http"
        && url
            .host_str()
            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
            .is_some_and(|ip| ip.is_loopback());
    if !(url.scheme() == "https" && allowed || local)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || url
            .query_pairs()
            .any(|(k, v)| k == "device_code" || v.contains(device))
        || percent_encoding::percent_decode_str(url.path())
            .decode_utf8()
            .is_ok_and(|v| v.contains(device))
    {
        return Err(ModelError::new("grok_device_response_invalid"));
    }
    Ok(url.into())
}
pub(super) async fn authorize(
    account: &Account,
    before: &CredentialSnapshot,
    cancel: &CancellationToken,
    present: impl FnOnce(&ModelAuthorizationPrompt) -> Result<(), ModelError>,
) -> Result<ModelMetadataState, ModelError> {
    let descriptor = provider(&account.auth).unwrap();
    let config = Config::load(&account.home, descriptor)?;
    let network = crate::network::Network::new().map_err(|e| ModelError::new(e.0))?;
    let started = Instant::now();
    let attempt = started + config.wait;
    let request = form(&[
        ("client_id", descriptor["clientId"].as_str().unwrap()),
        ("scope", descriptor["login"]["scope"].as_str().unwrap()),
    ]);
    let (status, device) = exchange(
        account,
        before,
        &network,
        &config.device,
        &request,
        cancel,
        attempt,
    )
    .await?;
    if !status.is_success() {
        return Err(ModelError::new("grok_oauth_device_rejected"));
    }
    let secret = device
        .text("device_code")
        .filter(|v| v.len() <= 4096)
        .ok_or(ModelError::new("grok_device_response_invalid"))?;
    let code = device
        .text("user_code")
        .filter(|v| v.len() <= 128 && !v.chars().any(char::is_control) && !v.contains(secret))
        .ok_or(ModelError::new("grok_device_response_invalid"))?;
    let raw = device
        .text("verification_uri_complete")
        .or_else(|| device.text("verification_uri"))
        .ok_or(ModelError::new("grok_device_response_invalid"))?;
    let authorization_url = verification(raw, secret, &config, descriptor)?;
    let lifetime = seconds(&device, "expires_in", 900)?;
    let mut interval = Duration::from_secs(seconds(&device, "interval", 5)?);
    let deadline = (Instant::now() + Duration::from_secs(lifetime)).min(attempt);
    let expires = now_ms()?
        .checked_add(
            deadline
                .saturating_duration_since(Instant::now())
                .as_millis() as u64,
        )
        .ok_or(ModelError::new("grok_device_response_invalid"))?;
    let expires_at = time::OffsetDateTime::from_unix_timestamp_nanos(expires as i128 * 1000000)
        .map_err(|_| ModelError::new("grok_device_response_invalid"))?
        .format(&time::format_description::well_known::Rfc3339)
        .map_err(|_| ModelError::new("grok_device_response_invalid"))?;
    current(account, before, cancel).await?;
    present(&ModelAuthorizationPrompt {
        authorization_url,
        user_code: Some(code.into()),
        expires_at: Some(expires_at),
    })?;
    let request = form(&[
        ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ("device_code", secret),
        ("client_id", descriptor["clientId"].as_str().unwrap()),
    ]);
    loop {
        let next = Instant::now() + interval;
        tokio::select! {biased;_=cancel.cancelled()=>return Err(ModelError::new("CANCELLED")),_=tokio::time::sleep_until(next.min(deadline))=>{}}
        if Instant::now() >= deadline {
            return Err(ModelError::new("grok_device_code_expired"));
        }
        let (status, response) = exchange(
            account,
            before,
            &network,
            &config.token,
            &request,
            cancel,
            deadline,
        )
        .await?;
        if status.is_success() {
            let mut token = Token::login(&response, &account.auth, now_ms()?)?;
            current(account, before, cancel).await?;
            if let Some(profile) = userinfo(&network, &config.userinfo, &token, cancel).await {
                token.with_profile(&profile);
            }
            if cancel.is_cancelled() {
                return Err(ModelError::new("CANCELLED"));
            }
            return account.commit(before, token, cancel).await;
        }
        match response.text("error") {
            Some("authorization_pending") => {}
            Some("slow_down") => {
                interval = interval
                    .checked_add(Duration::from_secs(5))
                    .ok_or(ModelError::new("grok_device_code_expired"))?
            }
            Some("access_denied") => return Err(ModelError::new("grok_oauth_access_denied")),
            Some("expired_token") => return Err(ModelError::new("grok_device_code_expired")),
            _ => return Err(ModelError::new("grok_oauth_login_rejected")),
        }
    }
}
async fn userinfo(
    network: &crate::network::Network,
    url: &Url,
    token: &Token,
    cancel: &CancellationToken,
) -> Option<Token> {
    let read = async {
        let client = network
            .prepare(url, cancel)
            .await
            .ok()?
            .builder
            .timeout(Duration::from_secs(15))
            .build()
            .ok()?;
        let bearer = zeroize::Zeroizing::new(format!("Bearer {}", token.text("access")?));
        let mut value = reqwest::header::HeaderValue::from_str(&bearer).ok()?;
        value.set_sensitive(true);
        let mut response = client
            .get(url.clone())
            .header("authorization", value)
            .send()
            .await
            .ok()?;
        if !response.status().is_success() {
            return None;
        }
        let mut bytes = zeroize::Zeroizing::new(Vec::new());
        while let Some(chunk) = response.chunk().await.ok()? {
            if bytes.len() + chunk.len() > 65536 {
                return None;
            }
            bytes.extend_from_slice(&chunk);
        }
        Token::parse(std::str::from_utf8(&bytes).ok()?).ok()
    };
    tokio::select! {biased;_=cancel.cancelled()=>None,result=tokio::time::timeout(Duration::from_secs(15),read)=>result.ok().flatten()}
}
