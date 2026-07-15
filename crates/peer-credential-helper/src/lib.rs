mod error;
mod key_store;
mod protocol;
mod vault;

use std::path::{Path, PathBuf};

use serde_json::json;
use zeroize::Zeroize;

pub use error::{HelperError, Result};
use key_store::{KeyStore, PlatformKeyStore};
pub use protocol::{PROTOCOL_VERSION, Request, Response};
use vault::CredentialVault;

pub fn resolve_data_home() -> Result<PathBuf> {
    if let Some(value) = std::env::var_os("PEER_AGENT_HOME") {
        let path = PathBuf::from(value);
        if !path.as_os_str().is_empty() {
            return Ok(path);
        }
    }

    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .ok_or(HelperError::VaultInvalid)?;
    Ok(PathBuf::from(home).join(".peer-agent"))
}

pub fn handle_request(request: Request, data_home: &Path) -> Response {
    let key_store = PlatformKeyStore;
    handle_request_with_store(request, data_home, &key_store)
}

fn handle_request_with_store(
    mut request: Request,
    data_home: &Path,
    key_store: &dyn KeyStore,
) -> Response {
    if let Err(code) = request.validate() {
        return Response::error(code, "The credential helper request was rejected.");
    }

    let vault = CredentialVault::new(data_home, key_store);
    let result = match &mut request {
        Request::Ping { .. } => Ok(json!({
            "status": "ready",
            "platform": std::env::consts::OS,
        })),
        Request::Get { key, .. } => vault.get(key).map(|secret| {
            let value = secret.as_ref().map(|secret| secret.as_str());
            json!({ "secret": value })
        }),
        Request::Set { key, secret, .. } => {
            let result = vault.set(key, secret);
            secret.zeroize();
            result.map(|_| json!({ "stored": true }))
        }
        Request::Delete { key, .. } => vault
            .delete(key)
            .map(|deleted| json!({ "deleted": deleted })),
    };

    match result {
        Ok(data) => Response::ok(data),
        Err(error) => Response::error(error.code(), error.public_message()),
    }
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::key_store::test_support::MemoryKeyStore;

    #[test]
    fn handles_set_get_delete_without_platform_storage() {
        let directory = tempdir().expect("tempdir");
        let store = MemoryKeyStore::default();

        let set = handle_request_with_store(
            Request::Set {
                version: 1,
                key: "model/openai/api-key".into(),
                secret: "secret-value".into(),
            },
            directory.path(),
            &store,
        );
        assert!(set.ok);

        let get = handle_request_with_store(
            Request::Get {
                version: 1,
                key: "model/openai/api-key".into(),
            },
            directory.path(),
            &store,
        );
        assert_eq!(get.data.expect("get data")["secret"], "secret-value");

        let delete = handle_request_with_store(
            Request::Delete {
                version: 1,
                key: "model/openai/api-key".into(),
            },
            directory.path(),
            &store,
        );
        assert_eq!(delete.data.expect("delete data")["deleted"], true);

        let missing = handle_request_with_store(
            Request::Get {
                version: 1,
                key: "model/openai/api-key".into(),
            },
            directory.path(),
            &store,
        );
        assert!(missing.data.expect("missing data")["secret"].is_null());
    }

    #[test]
    fn rejects_invalid_requests_before_touching_storage() {
        let directory = tempdir().expect("tempdir");
        let store = MemoryKeyStore::default();
        let response = handle_request_with_store(
            Request::Get {
                version: 1,
                key: "../../etc/passwd".into(),
            },
            directory.path(),
            &store,
        );
        assert!(!response.ok);
        assert_eq!(
            response.error.expect("error").code,
            "credential_key_namespace_denied"
        );
        assert!(!directory.path().join("credentials.vault.json").exists());
    }
}
