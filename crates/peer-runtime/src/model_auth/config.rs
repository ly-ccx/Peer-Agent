use super::*;
pub(super) struct LoginConfig {
    pub authorization: Url,
    pub token: Url,
    pub redirect: String,
    pub wait: Duration,
}
impl LoginConfig {
    pub fn load(home: &Path, provider: &Value) -> Result<Self, ModelError> {
        let parse = |value: &Value| {
            Url::parse(value.as_str().unwrap_or(""))
                .map_err(|_| ModelError::new("model_oauth_config_invalid"))
        };
        let result = Self {
            authorization: parse(&provider["login"]["authorizationUrl"])?,
            token: parse(&provider["tokenUrl"])?,
            redirect: provider["login"]["redirectUri"]
                .as_str()
                .ok_or(ModelError::new("model_oauth_config_invalid"))?
                .into(),
            wait: Duration::from_secs(300),
        };
        #[cfg(any(test, feature = "test-fixtures"))]
        let mut result = result;
        #[cfg(any(test, feature = "test-fixtures"))]
        {
            let file = home.join(".native-model-login-fixture.json");
            if file.exists() {
                if !home.join(".native-cli-fixture").is_file() {
                    return Err(ModelError::new("model_oauth_fixture_denied"));
                }
                let value = crate::model_config::read(&file)?;
                if value.to_string().len() > 4096 {
                    return Err(ModelError::new("model_oauth_fixture_denied"));
                }
                let loopback = |field: &str| -> Result<Url, ModelError> {
                    let url = parse(&value[field])?;
                    if url.scheme() != "http"
                        || !url
                            .host_str()
                            .and_then(|s| s.parse::<std::net::IpAddr>().ok())
                            .is_some_and(|ip| ip.is_loopback())
                        || !url.username().is_empty()
                        || url.password().is_some()
                        || url.fragment().is_some()
                        || url.query().is_some()
                    {
                        return Err(ModelError::new("model_oauth_fixture_denied"));
                    }
                    Ok(url)
                };
                result.authorization = loopback("authorizationUrl")?;
                result.token = loopback("tokenUrl")?;
                let port = value["callbackPort"]
                    .as_u64()
                    .filter(|p| *p <= 65535)
                    .ok_or(ModelError::new("model_oauth_fixture_denied"))?
                    as u16;
                let mut redirect = Url::parse(&result.redirect).unwrap();
                redirect.set_port(Some(port)).unwrap();
                result.redirect = redirect.into();
                if let Some(ms) = value["waitMs"].as_u64() {
                    if !(100..=300000).contains(&ms) {
                        return Err(ModelError::new("model_oauth_fixture_denied"));
                    }
                    result.wait = Duration::from_millis(ms);
                }
            }
        }
        let _ = home;
        Ok(result)
    }
}
