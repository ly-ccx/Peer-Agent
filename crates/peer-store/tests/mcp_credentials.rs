use peer_store::{McpCredentialStore, StoreError};
use serde_json::json;
use sha2::{Digest, Sha256};

fn row() -> serde_json::Value {
    json!({"id":"a","credentialRef":"mcp-cred:a","kind":"oauth2", "oauth":{"tokenStatus":"available"},
        "vaultKey":format!("mcp/{:x}/{}",Sha256::digest(b"mcp-cred:a"),uuid::Uuid::new_v4()),"future":{"kept":true}})
}

#[test]
fn intermediate_publication_retains_lock_and_advances_only_the_owner() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("mcp-credentials.json");
    std::fs::write(
        &file,
        json!({"version":2,"credentials":[row()],"futureRoot":42}).to_string(),
    )
    .unwrap();
    let store = McpCredentialStore::new(root.path());
    let original = store.binding("mcp-cred:a", "oauth2").unwrap();
    let mut owner = store.transaction(&original).unwrap();
    let mut pending = original.metadata.clone();
    pending["vaultKey"] = row()["vaultKey"].clone();
    pending["oauth"]["tokenStatus"] = json!("recovery_required");
    let pending = owner.publish(pending).unwrap();
    assert_ne!(pending.revision, original.revision);
    assert!(matches!(
        store.check(&original),
        Err(StoreError::VersionChanged)
    ));
    assert!(matches!(
        store.transaction(&pending),
        Err(StoreError::LockBusy)
    ));
    let mut final_row = pending.metadata.clone();
    final_row["vaultKey"] = row()["vaultKey"].clone();
    final_row["oauth"]["tokenStatus"] = json!("available");
    let final_binding = owner.commit(final_row).unwrap();
    store.check(&final_binding).unwrap();
    assert!(!root.path().join("mcp-credentials.json.lock").exists());
    let data: serde_json::Value = serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
    assert_eq!(data["futureRoot"], 42);
    assert_eq!(data["credentials"][0]["future"]["kept"], true);
}

#[test]
fn cancellation_and_replaced_owner_cannot_erase_the_published_intent() {
    for replaced in [false, true] {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("mcp-credentials.json");
        std::fs::write(
            &file,
            json!({"version":2,"credentials":[row()]}).to_string(),
        )
        .unwrap();
        let store = McpCredentialStore::new(root.path());
        let original = store.binding("mcp-cred:a", "oauth2").unwrap();
        let mut owner = store.transaction(&original).unwrap();
        let mut pending = original.metadata.clone();
        pending["vaultKey"] = row()["vaultKey"].clone();
        pending["oauth"]["tokenStatus"] = json!("recovery_required");
        let pending = owner.publish(pending).unwrap();
        let bytes = std::fs::read(&file).unwrap();
        let lock = root.path().join("mcp-credentials.json.lock");
        if replaced {
            std::fs::rename(&lock, root.path().join("retired-lock")).unwrap();
            std::fs::create_dir(&lock).unwrap();
            assert!(matches!(
                owner.commit(original.metadata),
                Err(StoreError::LockOwnershipChanged)
            ));
            assert!(lock.is_dir(), "foreign lock must remain");
        } else {
            drop(owner);
            assert!(!lock.exists());
        }
        assert_eq!(std::fs::read(&file).unwrap(), bytes);
        store.check(&pending).unwrap();
    }
}
