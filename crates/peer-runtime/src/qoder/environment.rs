//! Captured Qoder settings and credential-source priority. Never logged.
use super::authentication::Runtime;
use crate::model::ModelError;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use zeroize::Zeroizing;
fn invalid() -> ModelError {
    ModelError::new("qoder_auth_invalid")
}
pub(super) const ENV_NAMES: &[&str] = &[
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
    "QODER_MODEL_SERVER_HOST",
];
pub(super) struct Environment(pub(super) Vec<Option<Zeroizing<String>>>);
impl Environment {
    pub(super) fn capture() -> Result<Self, ModelError> {
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
    pub(super) fn get(&self, name: &str) -> Option<&str> {
        self.0[ENV_NAMES
            .iter()
            .position(|n| *n == name)
            .expect("registered Qoder environment")]
        .as_deref()
        .map(String::as_str)
    }
    pub(super) fn text(&self, name: &str) -> Option<&str> {
        self.get(name)
            .map(peer_protocol::javascript_trim)
            .filter(|v| !v.is_empty())
    }
    pub(super) fn fingerprint(&self) -> [u8; 32] {
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
    pub(super) fn root(&self) -> Result<PathBuf, ModelError> {
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
    pub(super) fn runtime(&self) -> Runtime {
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
