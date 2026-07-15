use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use fs2::FileExt;
use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use zeroize::{Zeroize, Zeroizing};

use crate::error::{HelperError, Result};
use crate::key_store::{KeyStore, load_or_create_master_key};

const VAULT_VERSION: u8 = 1;
const VAULT_FILENAME: &str = "credentials.vault.json";
const LOCK_FILENAME: &str = "credentials.vault.lock";
const NONCE_LEN: usize = 12;
const MAX_VAULT_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultFile {
    version: u8,
    records: BTreeMap<String, EncryptedRecord>,
}

impl Default for VaultFile {
    fn default() -> Self {
        Self {
            version: VAULT_VERSION,
            records: BTreeMap::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct EncryptedRecord {
    nonce: String,
    ciphertext: String,
}

pub struct CredentialVault<'a> {
    data_home: PathBuf,
    key_store: &'a dyn KeyStore,
}

impl<'a> CredentialVault<'a> {
    pub fn new(data_home: impl Into<PathBuf>, key_store: &'a dyn KeyStore) -> Self {
        Self {
            data_home: data_home.into(),
            key_store,
        }
    }

    pub fn path(&self) -> PathBuf {
        self.data_home.join(VAULT_FILENAME)
    }

    pub fn get(&self, key: &str) -> Result<Option<Zeroizing<String>>> {
        self.with_lock(false, || {
            let vault_path = self.path();
            if !vault_path.exists() {
                return Ok(None);
            }
            let master_key = load_or_create_master_key(self.key_store, true)?;
            let vault = read_vault(&vault_path)?;
            let Some(record) = vault.records.get(key) else {
                return Ok(None);
            };
            decrypt_record(&master_key, key, record).map(Some)
        })
    }

    pub fn set(&self, key: &str, secret: &str) -> Result<()> {
        self.with_lock(true, || {
            let vault_path = self.path();
            let master_key = load_or_create_master_key(self.key_store, vault_path.exists())?;
            let mut vault = if vault_path.exists() {
                read_vault(&vault_path)?
            } else {
                VaultFile::default()
            };
            vault
                .records
                .insert(key.to_owned(), encrypt_record(&master_key, key, secret)?);
            write_vault_atomic(&self.data_home, &vault_path, &vault)
        })
    }

    pub fn delete(&self, key: &str) -> Result<bool> {
        self.with_lock(true, || {
            let vault_path = self.path();
            if !vault_path.exists() {
                return Ok(false);
            }
            let _master_key = load_or_create_master_key(self.key_store, true)?;
            let mut vault = read_vault(&vault_path)?;
            let removed = vault.records.remove(key).is_some();
            if removed {
                write_vault_atomic(&self.data_home, &vault_path, &vault)?;
            }
            Ok(removed)
        })
    }

    fn with_lock<T>(&self, exclusive: bool, operation: impl FnOnce() -> Result<T>) -> Result<T> {
        ensure_private_directory(&self.data_home)?;
        let lock_path = self.data_home.join(LOCK_FILENAME);
        let lock = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(&lock_path)?;
        set_private_file_permissions(&lock_path)?;
        if exclusive {
            lock.lock_exclusive()?;
        } else {
            FileExt::lock_shared(&lock)?;
        }
        let result = operation();
        let unlock_result = FileExt::unlock(&lock);
        match (result, unlock_result) {
            (Ok(value), Ok(())) => Ok(value),
            (Err(error), _) => Err(error),
            (Ok(_), Err(error)) => Err(error.into()),
        }
    }
}

fn encrypt_record(master_key: &[u8], key: &str, secret: &str) -> Result<EncryptedRecord> {
    let cipher =
        Aes256Gcm::new_from_slice(master_key).map_err(|_| HelperError::MasterKeyInvalid)?;
    let mut nonce_bytes = [0_u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce_bytes);
    let aad = aad_for(key);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce_bytes),
            Payload {
                msg: secret.as_bytes(),
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| HelperError::VaultAuthenticationFailed)?;
    Ok(EncryptedRecord {
        nonce: BASE64.encode(nonce_bytes),
        ciphertext: BASE64.encode(ciphertext),
    })
}

fn decrypt_record(
    master_key: &[u8],
    key: &str,
    record: &EncryptedRecord,
) -> Result<Zeroizing<String>> {
    let cipher =
        Aes256Gcm::new_from_slice(master_key).map_err(|_| HelperError::MasterKeyInvalid)?;
    let nonce = BASE64
        .decode(record.nonce.as_bytes())
        .map_err(|_| HelperError::VaultInvalid)?;
    if nonce.len() != NONCE_LEN {
        return Err(HelperError::VaultInvalid);
    }
    let mut ciphertext = BASE64
        .decode(record.ciphertext.as_bytes())
        .map_err(|_| HelperError::VaultInvalid)?;
    let aad = aad_for(key);
    let plaintext = cipher
        .decrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: &ciphertext,
                aad: aad.as_bytes(),
            },
        )
        .map_err(|_| HelperError::VaultAuthenticationFailed);
    ciphertext.zeroize();
    let bytes = plaintext?;
    let value = String::from_utf8(bytes).map_err(|_| HelperError::VaultInvalid)?;
    Ok(Zeroizing::new(value))
}

fn aad_for(key: &str) -> String {
    format!("peer-agent-credential-v{VAULT_VERSION}:{key}")
}

fn read_vault(path: &Path) -> Result<VaultFile> {
    let mut file = File::open(path)?;
    let metadata = file.metadata()?;
    if metadata.len() > MAX_VAULT_BYTES {
        return Err(HelperError::VaultInvalid);
    }
    let mut content = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut content)?;
    let vault: VaultFile =
        serde_json::from_slice(&content).map_err(|_| HelperError::VaultInvalid)?;
    content.zeroize();
    if vault.version != VAULT_VERSION {
        return Err(HelperError::VaultInvalid);
    }
    Ok(vault)
}

fn write_vault_atomic(data_home: &Path, path: &Path, vault: &VaultFile) -> Result<()> {
    ensure_private_directory(data_home)?;
    let encoded = serde_json::to_vec(vault).map_err(|_| HelperError::VaultInvalid)?;
    let temp_path = data_home.join(format!(".{VAULT_FILENAME}.{}.tmp", std::process::id()));
    let write_result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp_path)?;
        set_private_file_permissions(&temp_path)?;
        file.write_all(&encoded)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp_path, path)?;
        set_private_file_permissions(path)?;
        sync_directory(data_home)?;
        Ok(())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    write_result
}

fn ensure_private_directory(path: &Path) -> Result<()> {
    fs::create_dir_all(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

fn set_private_file_permissions(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))?;
    }
    let _ = path;
    Ok(())
}

fn sync_directory(path: &Path) -> Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()?;
    }
    let _ = path;
    Ok(())
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::key_store::test_support::MemoryKeyStore;

    #[test]
    fn encrypts_round_trips_and_deletes_credentials() {
        let directory = tempdir().expect("tempdir");
        let key_store = MemoryKeyStore::default();
        let vault = CredentialVault::new(directory.path(), &key_store);

        vault
            .set("model/openai/api-key", "sk-secret-value")
            .expect("set");
        let raw = fs::read_to_string(vault.path()).expect("vault file");
        assert!(!raw.contains("sk-secret-value"));
        assert_eq!(
            vault
                .get("model/openai/api-key")
                .expect("get")
                .expect("value")
                .as_str(),
            "sk-secret-value"
        );
        assert!(vault.delete("model/openai/api-key").expect("delete"));
        assert!(
            vault
                .get("model/openai/api-key")
                .expect("missing")
                .is_none()
        );
    }

    #[test]
    fn uses_a_fresh_nonce_for_every_write() {
        let directory = tempdir().expect("tempdir");
        let key_store = MemoryKeyStore::default();
        let vault = CredentialVault::new(directory.path(), &key_store);

        vault.set("model/openai/api-key", "same").expect("first");
        let first = fs::read_to_string(vault.path()).expect("first raw");
        vault.set("model/openai/api-key", "same").expect("second");
        let second = fs::read_to_string(vault.path()).expect("second raw");
        assert_ne!(first, second);
    }

    #[test]
    fn detects_ciphertext_tampering() {
        let directory = tempdir().expect("tempdir");
        let key_store = MemoryKeyStore::default();
        let vault = CredentialVault::new(directory.path(), &key_store);
        vault.set("model/openai/api-key", "secret").expect("set");

        let raw = fs::read_to_string(vault.path()).expect("raw");
        let mut json: serde_json::Value = serde_json::from_str(&raw).expect("json");
        let ciphertext = json["records"]["model/openai/api-key"]["ciphertext"]
            .as_str()
            .expect("ciphertext");
        let replacement = format!("A{}", &ciphertext[1..]);
        json["records"]["model/openai/api-key"]["ciphertext"] = replacement.into();
        fs::write(vault.path(), serde_json::to_vec(&json).expect("encode")).expect("tamper");

        assert!(matches!(
            vault.get("model/openai/api-key"),
            Err(HelperError::VaultAuthenticationFailed)
        ));
    }

    #[test]
    fn refuses_existing_vault_when_protected_key_is_missing() {
        let directory = tempdir().expect("tempdir");
        let key_store = MemoryKeyStore::default();
        let vault = CredentialVault::new(directory.path(), &key_store);
        vault.set("model/openai/api-key", "secret").expect("set");
        key_store.clear();

        assert!(matches!(
            vault.get("model/openai/api-key"),
            Err(HelperError::MasterKeyMissing)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn applies_private_unix_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let directory = tempdir().expect("tempdir");
        let data_home = directory.path().join("peer-home");
        let key_store = MemoryKeyStore::default();
        let vault = CredentialVault::new(&data_home, &key_store);
        vault.set("model/openai/api-key", "secret").expect("set");

        assert_eq!(
            fs::metadata(&data_home)
                .expect("dir metadata")
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        assert_eq!(
            fs::metadata(vault.path())
                .expect("file metadata")
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
