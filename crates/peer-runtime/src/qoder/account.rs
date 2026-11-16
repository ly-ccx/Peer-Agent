//! Selected account owns source identity and one immutable request dialect.
#[cfg(test)]
use super::CREDENTIAL_LIMIT;
#[cfg(test)]
use super::environment::ENV_NAMES;
use super::{
    account_files::ReadSet,
    authentication::{self, Fields, Runtime},
    environment::Environment,
    local_auth::Login,
};
use crate::{
    CancellationToken,
    model::{ModelError, wire::QoderDialect},
    model_config::ModelBinding,
};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};
#[cfg(test)]
use zeroize::Zeroizing;
fn now() -> Result<u64, ModelError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|v| v.as_secs())
        .map_err(|_| ModelError::new("qoder_auth_clock_invalid"))
}
struct Prepared {
    fields: Fields,
    metadata: Value,
    runtime: Runtime,
}
enum Mode {
    Prepared(Box<Prepared>),
    Legacy,
}
pub(crate) struct Account {
    login: Login,
    reads: ReadSet,
    mode: Mode,
    environment: [u8; 32],
    binding: ModelBinding,
    endpoint: reqwest::Url,
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
        let root = env.root()?;
        let mut reads = ReadSet::default();
        let login = Login::load(&env, &root, &mut reads, cancel)?;
        login.validate(now()?)?;
        let catalog = super::catalog::Catalog::load(&root, login.uid(), &mut reads, cancel)?;
        let metadata = catalog.metadata(binding.model_id(), binding.model_options())?;
        let (mode, endpoint) = if let Some(metadata) = metadata {
            let (profile, _) = login.prepared()?;
            let fields = Fields::from_profile(profile)?;
            let endpoint = super::endpoint::prepared(&env, &root, &mut reads, cancel)?;
            (
                Mode::Prepared(Box::new(Prepared {
                    fields,
                    metadata,
                    runtime: env.runtime(),
                })),
                endpoint,
            )
        } else {
            (
                Mode::Legacy,
                super::endpoint::legacy(&env, binding.base_url())?,
            )
        };
        let account = Self {
            login,
            reads,
            mode,
            environment: env.fingerprint(),
            binding,
            endpoint,
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
        self.reads.validate()?;
        self.login.validate(now)
    }
    pub(crate) fn session_type(&self) -> &str {
        &self.session_type
    }
    pub(crate) fn metadata(&self) -> Option<&Value> {
        match &self.mode {
            Mode::Prepared(prepared) => Some(&prepared.metadata),
            Mode::Legacy => None,
        }
    }
    pub(crate) fn dialect(&self) -> QoderDialect {
        match self.mode {
            Mode::Prepared(_) => QoderDialect::Prepared,
            Mode::Legacy => QoderDialect::Legacy,
        }
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
        match &self.mode {
            Mode::Prepared(prepared) => {
                let (profile, machine) = self.login.prepared()?;
                let invalid = || ModelError::new("qoder_auth_invalid");
                authentication::Request {
                    profile,
                    machine,
                    fields: &prepared.fields,
                    runtime: &prepared.runtime,
                    model: body["model_config"]["key"].as_str().ok_or_else(invalid)?,
                    source: body["model_config"]["source"]
                        .as_str()
                        .ok_or_else(invalid)?,
                    encoded,
                }
                .headers(now()?)
            }
            Mode::Legacy => authentication::legacy_headers(self.login.token(), body),
        }
    }
}
#[cfg(test)]
mod tests;
