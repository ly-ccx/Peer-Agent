//! Shared model configuration facts. Callers own schema-specific mutations and
//! credential transactions; the Store owns bounded snapshots, fencing and CAS.
use crate::{DirectoryLock, StoreError, durable_jsonl, files};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};
const MAX_BYTES: usize = 1024 * 1024;
pub struct ModelConfigStore {
    file: PathBuf,
}
pub struct ModelConfigSnapshot {
    pub value: Value,
    pub source_revision: String,
}
pub struct ModelConfigTransaction {
    store: ModelConfigStore,
    lock: DirectoryLock,
    snapshot: ModelConfigSnapshot,
}
fn decode(bytes: &[u8]) -> Result<Value, StoreError> {
    let value = peer_protocol::decode_json_bounded(
        bytes,
        peer_protocol::JsonLimits {
            bytes: MAX_BYTES,
            nodes: 16384,
            depth: 32,
            string_bytes: MAX_BYTES,
        },
    )
    .map_err(|_| StoreError::InvalidInput)?
    .value;
    if value["version"] != 2
        || !["channels", "models"].iter().all(|key| {
            value[*key]
                .as_array()
                .is_some_and(|rows| rows.iter().all(Value::is_object))
        })
    {
        return Err(StoreError::InvalidInput);
    }
    Ok(value)
}
impl ModelConfigStore {
    pub fn new(home: impl AsRef<Path>) -> Self {
        Self {
            file: home.as_ref().join("llm-providers.json"),
        }
    }
    pub fn read(&self) -> Result<ModelConfigSnapshot, StoreError> {
        let before = files::identity(&self.file)?;
        let raw = files::read(&self.file, MAX_BYTES)?;
        if files::identity(&self.file)? != before {
            return Err(StoreError::VersionChanged);
        }
        let value = match &raw {
            None => json!({"version":2,"channels":[],"models":[]}),
            Some(bytes) => decode(bytes)?,
        };
        let revision = format!(
            "{}:{:x}",
            files::fingerprint(&[before]),
            Sha256::digest(raw.as_deref().unwrap_or_default())
        );
        Ok(ModelConfigSnapshot {
            value,
            source_revision: revision,
        })
    }
    pub fn begin(
        &self,
        timeout: Duration,
        cancel: Option<&AtomicBool>,
    ) -> Result<ModelConfigTransaction, StoreError> {
        let home = durable_jsonl::directory(self.file.parent().ok_or(StoreError::InvalidInput)?)?;
        let store = Self::new(home);
        let lock = DirectoryLock::acquire(&store.file, timeout, cancel)?;
        let snapshot = store.read()?;
        Ok(ModelConfigTransaction {
            store,
            lock,
            snapshot,
        })
    }
}
impl ModelConfigTransaction {
    pub fn snapshot(&self) -> &ModelConfigSnapshot {
        &self.snapshot
    }
    /// Consume the transaction so an uncertain commit can never be replayed by
    /// this handle. Re-read the actual file to reconcile any unknown outcome.
    pub fn commit(
        self,
        expected: &str,
        value: &Value,
        cancel: Option<&AtomicBool>,
    ) -> Result<ModelConfigSnapshot, StoreError> {
        self.lock.check_owned()?;
        if self.snapshot.source_revision != expected
            || self.store.read()?.source_revision != expected
        {
            return Err(StoreError::VersionChanged);
        }
        let bytes = serde_json::to_vec_pretty(value).map_err(|_| StoreError::InvalidInput)?;
        decode(&bytes)?;
        durable_jsonl::check_cancel(cancel)?;
        self.lock.check_owned()?;
        durable_jsonl::replace(&self.store.file, &bytes, cancel)?;
        let next = self.store.read().map_err(|_| StoreError::CommitUncertain)?;
        self.lock
            .release()
            .map_err(|_| StoreError::CommitUncertain)?;
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stale_snapshot_cancellation_and_corrupt_state_preserve_existing_configuration() {
        let root = tempfile::tempdir().unwrap();
        let store = ModelConfigStore::new(root.path());
        let first = store.read().unwrap();
        let tx = store.begin(Duration::ZERO, None).unwrap();
        let next = json!({"version":2,"channels":[],"models":[],"future":{"keep":[1,2]}});
        tx.commit(&first.source_revision, &next, None).unwrap();
        assert!(matches!(
            store
                .begin(Duration::ZERO, None)
                .unwrap()
                .commit(&first.source_revision, &next, None),
            Err(StoreError::VersionChanged)
        ));
        let tx = store.begin(Duration::ZERO, None).unwrap();
        let rev = tx.snapshot().source_revision.clone();
        let cancel = AtomicBool::new(true);
        assert!(matches!(
            tx.commit(
                &rev,
                &json!({"version":2,"channels":[],"models":[]}),
                Some(&cancel)
            ),
            Err(StoreError::Cancelled)
        ));
        assert_eq!(store.read().unwrap().value, next);
        for raw in ["{broken", "{\"version\":99,\"channels\":[],\"models\":[]}"] {
            std::fs::write(root.path().join("llm-providers.json"), raw).unwrap();
            assert!(store.begin(Duration::ZERO, None).is_err());
            assert_eq!(
                std::fs::read_to_string(root.path().join("llm-providers.json")).unwrap(),
                raw
            );
            assert!(!root.path().join("llm-providers.json.lock").exists());
        }
    }
}
