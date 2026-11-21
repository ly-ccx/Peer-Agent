use peer_store::{McpRegistryStore, StoreError};
use serde_json::json;
use std::fs;
#[test]
fn missing_empty_legacy_and_cached_manifests_are_read_only_and_source_bound() {
    let root = tempfile::tempdir().unwrap();
    let store = McpRegistryStore::new(root.path());
    let initial = store.read().unwrap();
    assert_eq!(initial.inventory.server_count, 0);
    assert!(!root.path().join("mcp-registry.json").exists());
    let file = root.path().join("mcp-registry.json");
    for input in [
        json!({"version":1,"servers":[]}),
        json!([]),
        json!({"version":1,"servers":[{"id":"s","transport":"sse","tools":[{"name":"read","inputSchema":{}}],"futureOpaque":{"keep":true}}]}),
    ] {
        fs::write(&file, input.to_string()).unwrap();
        let bytes = fs::read(&file).unwrap();
        let snapshot = store.read().unwrap();
        assert_ne!(snapshot.source_revision, initial.source_revision);
        assert_eq!(fs::read(&file).unwrap(), bytes);
        if snapshot.inventory.server_count > 0 {
            assert_eq!(
                snapshot.inventory.manifests[0]["origin"]["transport"],
                "sse"
            );
            assert_eq!(
                snapshot.inventory.manifests[0]["permissionPolicy"]["required"],
                true
            );
        }
    }
}
#[test]
fn future_corrupt_oversized_and_foreign_sources_never_become_empty_inventory() {
    let root = tempfile::tempdir().unwrap();
    let store = McpRegistryStore::new(root.path());
    let file = root.path().join("mcp-registry.json");
    for bytes in [
        b"{broken".to_vec(),
        b"{\"version\":99,\"servers\":[]}".to_vec(),
        vec![b' '; 1024 * 1024 + 1],
    ] {
        fs::write(&file, &bytes).unwrap();
        assert!(store.read().is_err());
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
    fs::remove_file(&file).unwrap();
    let other = root.path().join("foreign");
    fs::write(&other, b"{\"version\":1,\"servers\":[]}").unwrap();
    std::os::unix::fs::symlink(&other, &file).unwrap();
    assert_eq!(store.read().err(), Some(StoreError::ReadFailed));
}
