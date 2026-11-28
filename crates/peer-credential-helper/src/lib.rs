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
            "features": ["model-oauth-cas-v1"],
        })),
        Request::Get { key, .. } => vault.get(key).and_then(|secret| {
            if key.starts_with("model/")&&key.ends_with("/oauth-tokens")&&secret.as_ref().is_some_and(|s|serde_json::from_str::<serde_json::Value>(s).is_ok_and(|v|v.get("peerModelRefresh").is_some())) {return Err(HelperError::OAuthRefreshPending);}
            let value = secret.as_ref().map(|secret| secret.as_str());
            Ok(json!({ "secret": value }))
        }),
        Request::Set { key, secret, .. } => {
            let result = vault.set(key, secret);
            secret.zeroize();
            result.map(|_| json!({ "stored": true }))
        }
        Request::Delete { key, .. } => vault
            .delete(key)
            .map(|deleted| json!({ "deleted": deleted })),
        Request::GetSnapshot { key, .. } => vault.get_snapshot(key).map(|snapshot| {
            json!({"secret":snapshot.as_ref().map(|s|s.secret.as_str()),"revision":snapshot.as_ref().map(|s|s.revision.as_str())})
        }),
        Request::CompareSet { key, expected_revision, secret, .. } => {
            let result = vault.compare_set(key, expected_revision.as_deref(), secret.as_deref());
            secret.zeroize();
            result.map(|commit| json!({"applied":commit.applied,"revision":commit.revision}))
        }
    };

    match result {
        Ok(data) => Response::ok(data),
        Err(error) => Response::error(error.code(), error.public_message()),
    }
}

/// Isolated encrypted-Vault fixture; absent from featureless product builds.
#[cfg(feature = "test-fixtures")]
pub fn handle_fixture_request(request: Request, home: &Path, key: &[u8]) -> Response {
    struct FixedKey(Vec<u8>);
    impl KeyStore for FixedKey {
        fn load(&self) -> Result<Option<zeroize::Zeroizing<Vec<u8>>>> {
            Ok(Some(zeroize::Zeroizing::new(self.0.clone())))
        }
        fn save(&self, key: &[u8]) -> Result<()> {
            if key == self.0 {
                Ok(())
            } else {
                Err(HelperError::MasterKeyInvalid)
            }
        }
    }
    if key.len() != 32 || !home.join(".native-cli-fixture").is_file() {
        return Response::error("fixture_denied", "Isolated fixture required.");
    }
    handle_request_with_store(request, home, &FixedKey(key.to_vec()))
}

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;
    use crate::key_store::test_support::MemoryKeyStore;

    #[test]
    fn conditional_oauth_commits_cannot_overwrite_rotations_or_resurrect_logout() {
        let directory = tempdir().unwrap();
        let store = MemoryKeyStore::default();
        let call = |value: serde_json::Value| {
            handle_request_with_store(
                serde_json::from_value(value).unwrap(),
                directory.path(),
                &store,
            )
        };
        let key = "model/channel/oauth-tokens";
        assert_eq!(
            call(json!({"version":1,"action":"get-snapshot","key":key}))
                .data
                .unwrap(),
            json!({"secret":null,"revision":null})
        );
        let created = call(json!({"version":1,"action":"compare-set","key":key,"expectedRevision":null,"secret":"first"})).data.unwrap();
        assert_eq!(created["applied"], true);
        let first = call(json!({"version":1,"action":"get-snapshot","key":key}))
            .data
            .unwrap();
        assert_eq!(first["secret"], "first");
        assert_eq!(first["revision"], created["revision"]);
        assert!(call(json!({"version":1,"action":"set","key":key,"secret":"new-login"})).ok);
        let before = std::fs::read(directory.path().join("credentials.vault.json")).unwrap();
        let stale = call(json!({"version":1,"action":"compare-set","key":key,"expectedRevision":first["revision"],"secret":"late-refresh"})).data.unwrap();
        assert_eq!(stale, json!({"applied":false,"revision":null}));
        assert_eq!(
            std::fs::read(directory.path().join("credentials.vault.json")).unwrap(),
            before
        );
        let next = call(json!({"version":1,"action":"get-snapshot","key":key}))
            .data
            .unwrap();
        assert_ne!(next["revision"], first["revision"]);
        assert_eq!(next["secret"], "new-login");
        assert!(call(json!({"version":1,"action":"delete","key":key})).ok);
        assert_eq!(call(json!({"version":1,"action":"compare-set","key":key,"expectedRevision":next["revision"],"secret":"resurrection"})).data.unwrap()["applied"], false);
        assert!(
            call(json!({"version":1,"action":"get","key":key}))
                .data
                .unwrap()["secret"]
                .is_null()
        );
        assert_eq!(call(json!({"version":1,"action":"compare-set","key":"model/channel/api-key","expectedRevision":null,"secret":"denied"})).error.unwrap().code, "credential_key_namespace_denied");
        let request: Request = serde_json::from_value(json!({"version":1,"action":"compare-set","key":key,"expectedRevision":null,"secret":"never-debug-this"})).unwrap();
        assert!(!format!("{request:?}").contains("never-debug-this"));
    }

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
