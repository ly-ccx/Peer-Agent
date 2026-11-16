//! Read-only account ownership. Every send fences the actual source and model.
use super::{
    CACHE_LIMIT, CREDENTIAL_LIMIT,
    account_files::{self, Observation},
    authentication::{self, Fields, Runtime},
    sensitive_json::SensitiveJson,
};
use crate::{CancellationToken, model::ModelError, model_config::ModelBinding};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zeroize::Zeroizing;
const ENV_NAMES: &[&str] = &[
    "HOME",
    "QODER_CONFIG_DIR",
    "QODER_CLI_HOME",
    "QODER_ACCESS_TOKEN",
    "QODER_PERSONAL_ACCESS_TOKEN",
    "QODER_PAT",
    "QODER_INFERENCE_ENDPOINT",
    "QODER_INFER_ENDPOINT",
    "QODER_ENV",
    "QODER_ENVIRONMENT",
    "QODER_CLIENT_TYPE",
    "QODER_BUSINESS_PRODUCT",
    "QODER_BUSINESS_TYPE",
    "QODER_SCENE",
    "QODER_SESSION_TYPE",
];
struct Environment(Vec<Option<Zeroizing<String>>>);
impl Environment {
    fn capture() -> Result<Self, ModelError> {
        ENV_NAMES
            .iter()
            .map(|name| match std::env::var(name) {
                Ok(value) if value.len() <= 8192 => Ok(Some(Zeroizing::new(value))),
                Err(std::env::VarError::NotPresent) => Ok(None),
                _ => Err(invalid()),
            })
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }
    fn get(&self, name: &str) -> Option<&str> {
        self.0[ENV_NAMES
            .iter()
            .position(|n| *n == name)
            .expect("registered Qoder environment")]
        .as_deref()
        .map(String::as_str)
    }
    fn text(&self, name: &str) -> Option<&str> {
        self.get(name)
            .map(peer_protocol::javascript_trim)
            .filter(|v| !v.is_empty())
    }
    fn fingerprint(&self) -> [u8; 32] {
        let mut hash = Sha256::new();
        for value in &self.0 {
            match value {
                Some(v) => {
                    hash.update([1]);
                    hash.update((v.len() as u64).to_be_bytes());
                    hash.update(v.as_bytes());
                }
                None => hash.update([0]),
            }
        }
        hash.finalize().into()
    }
    fn root(&self) -> Result<PathBuf, ModelError> {
        let root = if let Some(path) = self.text("QODER_CONFIG_DIR") {
            PathBuf::from(path)
        } else {
            Path::new(
                self.text("QODER_CLI_HOME")
                    .or_else(|| self.text("HOME"))
                    .ok_or_else(invalid)?,
            )
            .join(".qoder")
        };
        if root.is_absolute() {
            Ok(root)
        } else {
            std::env::current_dir()
                .map(|cwd| cwd.join(root))
                .map_err(|_| invalid())
        }
    }
    fn runtime(&self) -> Runtime {
        let value = |name, default: &str| {
            self.get(name)
                .filter(|s| !s.is_empty())
                .unwrap_or(default)
                .to_owned()
        };
        Runtime {
            client: value("QODER_CLIENT_TYPE", "5"),
            product: value("QODER_BUSINESS_PRODUCT", "cli"),
            business: value("QODER_BUSINESS_TYPE", "agent"),
            scene: value("QODER_SCENE", "assistant"),
        }
    }
}
fn invalid() -> ModelError {
    ModelError::new("qoder_auth_invalid")
}
fn now() -> Result<u64, ModelError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| ModelError::new("qoder_auth_clock_invalid"))
}
fn expiry(profile: &Value, now: u64) -> Result<(), ModelError> {
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
    bounded_text("uid", 512)?
        .filter(|s| !s.is_empty())
        .ok_or_else(invalid)?;
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
enum EndpointObservation {
    File(Observation),
    Absent(PathBuf),
    Explicit,
}
impl EndpointObservation {
    fn validate(&self) -> Result<(), ModelError> {
        match self {
            Self::File(file) => file.validate(),
            Self::Explicit => Ok(()),
            Self::Absent(path) => match std::fs::symlink_metadata(path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
                _ => Err(ModelError::new("qoder_auth_changed")),
            },
        }
    }
}
fn endpoint(
    env: &Environment,
    root: &Path,
    cancel: &CancellationToken,
) -> Result<(reqwest::Url, EndpointObservation), ModelError> {
    let explicit = env
        .get("QODER_INFERENCE_ENDPOINT")
        .filter(|s| !s.is_empty())
        .or_else(|| env.get("QODER_INFER_ENDPOINT"))
        .map(peer_protocol::javascript_trim)
        .filter(|v| !v.is_empty());
    let mut observed = EndpointObservation::Explicit;
    let mut cache = None;
    if explicit.is_none() {
        let path = root.join(".cache/endpoint-cache.json");
        match std::fs::symlink_metadata(&path) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                observed = EndpointObservation::Absent(path)
            }
            Err(_) => return Err(ModelError::new("qoder_auth_unavailable")),
            Ok(_) => {
                let (bytes, observation) = account_files::read(&path, CACHE_LIMIT, cancel)?;
                cache = Some(SensitiveJson::parse(&bytes, CACHE_LIMIT)?);
                observed = EndpointObservation::File(observation);
            }
        }
    }
    if cache.as_ref().is_some_and(|c| !c.0["entries"].is_object()) {
        return Err(invalid());
    }
    let env_name = env
        .text("QODER_ENV")
        .or_else(|| env.text("QODER_ENVIRONMENT"))
        .unwrap_or("prod");
    let entries = cache.as_ref().map(|c| &c.0["entries"]);
    let cached = entries.and_then(|e| {
        [
            &e[env_name]["endpoint"],
            &e["prod"]["endpoint"],
            &e[env_name]["inferEndpoints"][0],
            &e["prod"]["inferEndpoints"][0],
        ]
        .into_iter()
        .filter_map(Value::as_str)
        .map(peer_protocol::javascript_trim)
        .find(|v| !v.is_empty())
    });
    let fallback = match env_name.to_lowercase().as_str() {
        "daily" => "https://daily-api3.qoder.sh",
        "test" => "https://test-api3.qoder.sh",
        _ => "https://api3.qoder.sh",
    };
    let base = explicit
        .or(cached)
        .unwrap_or(fallback)
        .trim_end_matches('/');
    let base_url =
        reqwest::Url::parse(base).map_err(|_| ModelError::new("model_endpoint_invalid"))?;
    if !matches!(base_url.scheme(), "http" | "https")
        || base_url.host_str().is_none()
        || !base_url.username().is_empty()
        || base_url.password().is_some()
        || base_url.query().is_some()
        || base_url.fragment().is_some()
    {
        return Err(ModelError::new("model_endpoint_invalid"));
    }
    let url = reqwest::Url::parse(&format!("{base}{}", authentication::INFER_PATH))
        .map_err(|_| ModelError::new("model_endpoint_invalid"))?;
    Ok((url, observed))
}
pub(crate) struct Account {
    profile: SensitiveJson,
    machine: Zeroizing<String>,
    fields: Fields,
    observations: Vec<Observation>,
    endpoint_observation: EndpointObservation,
    environment: [u8; 32],
    runtime: Runtime,
    binding: ModelBinding,
    endpoint: reqwest::Url,
    catalog: super::catalog::Catalog,
    session_type: String,
}
impl Account {
    pub(crate) fn load(
        binding: ModelBinding,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        Self::load_from(binding, Environment::capture()?, cancel)
    }
    fn load_from(
        binding: ModelBinding,
        env: Environment,
        cancel: &CancellationToken,
    ) -> Result<Self, ModelError> {
        if cancel.is_cancelled() {
            return Err(ModelError::new("CANCELLED"));
        }
        if [
            "QODER_ACCESS_TOKEN",
            "QODER_PERSONAL_ACCESS_TOKEN",
            "QODER_PAT",
        ]
        .iter()
        .any(|name| env.text(name).is_some())
        {
            // The current prepared-infer dialect requires profile fields. Never
            // fall back to a different on-disk account when an env token wins.
            return Err(ModelError::new("qoder_local_user_info_required"));
        }
        let root = env.root()?;
        let (machine, first) = account_files::read(&root.join(".auth/machine_id"), 4096, cancel)?;
        let machine = std::str::from_utf8(&machine).map_err(|_| invalid())?;
        let machine = Zeroizing::new(peer_protocol::javascript_trim(machine).to_owned());
        let key = Zeroizing::new(machine.encode_utf16().take(16).collect::<Vec<_>>());
        let key = Zeroizing::new(String::from_utf16(&key).map_err(|_| invalid())?);
        let (cipher, second) =
            account_files::read(&root.join(".auth/user"), CREDENTIAL_LIMIT, cancel)?;
        let cipher = std::str::from_utf8(&cipher).map_err(|_| invalid())?;
        let plain =
            super::decrypt_credential(peer_protocol::javascript_trim(cipher), key.as_bytes())
                .map_err(|_| invalid())?;
        let profile = SensitiveJson::parse(plain.expose().as_bytes(), CREDENTIAL_LIMIT)?;
        validate_profile(&profile.0)?;
        expiry(&profile.0, now()?)?;
        let fields = Fields::from_profile(&profile.0)?;
        let catalog = super::catalog::Catalog::load(
            &root,
            profile.0["uid"].as_str().ok_or_else(invalid)?,
            cancel,
        )?;
        let (endpoint, endpoint_observation) = endpoint(&env, &root, cancel)?;
        let account = Self {
            profile,
            machine,
            fields,
            observations: vec![first, second],
            endpoint_observation,
            environment: env.fingerprint(),
            runtime: env.runtime(),
            binding,
            endpoint,
            catalog,
            session_type: env
                .get("QODER_SESSION_TYPE")
                .filter(|s| !s.is_empty())
                .unwrap_or("qodercli")
                .to_owned(),
        };
        account.validate_source(cancel, now()?)?;
        Ok(account)
    }
    fn validate_source(&self, cancel: &CancellationToken, now: u64) -> Result<(), ModelError> {
        if cancel.is_cancelled() {
            return Err(ModelError::new("CANCELLED"));
        }
        self.binding.validate()?;
        for observation in &self.observations {
            observation.validate()?;
        }
        self.endpoint_observation.validate()?;
        self.catalog.validate()?;
        expiry(&self.profile.0, now)?;
        Ok(())
    }
    pub(crate) fn session_type(&self) -> &str {
        &self.session_type
    }
    pub(crate) fn metadata(
        &self,
        model: &str,
        config: &Value,
        selected: &Value,
    ) -> Result<Value, ModelError> {
        let m = config["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == selected["modelProviderId"])
            .ok_or_else(invalid)?;
        let c = config["channels"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|v| v["id"] == m["groupId"])
            .ok_or_else(invalid)?;
        self.catalog.metadata(
            model,
            m.get("modelOptions").or_else(|| c.get("modelOptions")),
        )
    }
    pub(crate) fn endpoint(&self) -> &reqwest::Url {
        &self.endpoint
    }
    pub(crate) fn headers(
        &self,
        body: &Value,
        encoded: &[u8],
        cancel: &CancellationToken,
    ) -> Result<reqwest::header::HeaderMap, ModelError> {
        self.validate_source(cancel, now()?)?;
        if Environment::capture()?.fingerprint() != self.environment {
            return Err(ModelError::new("qoder_auth_changed"));
        }
        let model = body["model_config"]["key"].as_str().ok_or_else(invalid)?;
        let source = body["model_config"]["source"]
            .as_str()
            .ok_or_else(invalid)?;
        authentication::Request {
            profile: &self.profile.0,
            machine: &self.machine,
            fields: &self.fields,
            runtime: &self.runtime,
            model,
            source,
            encoded,
        }
        .headers(now()?)
    }
}

#[cfg(test)]
mod tests;
