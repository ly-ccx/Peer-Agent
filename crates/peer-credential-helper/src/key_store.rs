use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use rand::{RngCore, rngs::OsRng};
use zeroize::Zeroizing;

use crate::error::{HelperError, Result};

const SERVICE: &str = "com.peeragent.credentials";
const ACCOUNT: &str = "vault-master-key-v1";
const MASTER_KEY_LEN: usize = 32;

pub trait KeyStore: Send + Sync {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>>;
    fn save(&self, key: &[u8]) -> Result<()>;
}

#[derive(Debug, Default)]
pub struct PlatformKeyStore;

impl PlatformKeyStore {
    fn entry(&self) -> Result<keyring::Entry> {
        keyring::Entry::new(SERVICE, ACCOUNT).map_err(|_| HelperError::SecureStorageUnavailable)
    }
}

impl KeyStore for PlatformKeyStore {
    fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
        let entry = self.entry()?;
        let password = match entry.get_password() {
            Ok(value) => Zeroizing::new(value),
            Err(keyring::Error::NoEntry) => return Ok(None),
            Err(_) => return Err(HelperError::SecureStorageUnavailable),
        };
        let bytes = BASE64
            .decode(password.as_bytes())
            .map_err(|_| HelperError::MasterKeyInvalid)?;
        if bytes.len() != MASTER_KEY_LEN {
            return Err(HelperError::MasterKeyInvalid);
        }
        Ok(Some(Zeroizing::new(bytes)))
    }

    fn save(&self, key: &[u8]) -> Result<()> {
        if key.len() != MASTER_KEY_LEN {
            return Err(HelperError::MasterKeyInvalid);
        }
        let encoded = Zeroizing::new(BASE64.encode(key));
        self.entry()?
            .set_password(&encoded)
            .map_err(|_| HelperError::SecureStorageUnavailable)
    }
}

pub fn load_or_create_master_key(
    key_store: &dyn KeyStore,
    vault_exists: bool,
) -> Result<Zeroizing<Vec<u8>>> {
    if let Some(key) = key_store.load()? {
        return Ok(key);
    }
    if vault_exists {
        return Err(HelperError::MasterKeyMissing);
    }
    let mut key = Zeroizing::new(vec![0_u8; MASTER_KEY_LEN]);
    OsRng.fill_bytes(&mut key);
    key_store.save(&key)?;
    Ok(key)
}

#[cfg(test)]
pub mod test_support {
    use std::sync::Mutex;

    use super::*;

    #[derive(Default)]
    pub struct MemoryKeyStore {
        key: Mutex<Option<Vec<u8>>>,
    }

    impl MemoryKeyStore {
        pub fn clear(&self) {
            *self.key.lock().expect("key mutex") = None;
        }
    }

    impl KeyStore for MemoryKeyStore {
        fn load(&self) -> Result<Option<Zeroizing<Vec<u8>>>> {
            Ok(self
                .key
                .lock()
                .expect("key mutex")
                .clone()
                .map(Zeroizing::new))
        }

        fn save(&self, key: &[u8]) -> Result<()> {
            *self.key.lock().expect("key mutex") = Some(key.to_vec());
            Ok(())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{test_support::MemoryKeyStore, *};

    #[test]
    fn creates_and_reuses_one_master_key() {
        let store = MemoryKeyStore::default();
        let first = load_or_create_master_key(&store, false).expect("first key");
        let second = load_or_create_master_key(&store, true).expect("second key");
        assert_eq!(first.as_slice(), second.as_slice());
        assert_eq!(first.len(), MASTER_KEY_LEN);
    }

    #[test]
    fn refuses_to_replace_missing_key_for_existing_vault() {
        let store = MemoryKeyStore::default();
        assert!(matches!(
            load_or_create_master_key(&store, true),
            Err(HelperError::MasterKeyMissing)
        ));
    }
}
