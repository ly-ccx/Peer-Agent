use peer_protocol::LocalAccessLevel;
use peer_store::{ConversationStore, DirectoryLock, PolicyStore, PolicyUpdateError, StoreError};
use serde_json::json;
use std::{fs, sync::atomic::AtomicBool, time::Duration};

fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("conversations")).unwrap();
    fs::write(
        root.path().join("conversations/index.jsonl"),
        "{\"id\":\"c\",\"contentRevision\":3,\"unknownField\":true}\n",
    )
    .unwrap();
    fs::write(root.path().join("conversations/c.jsonl"), "{\"id\":\"u\",\"role\":\"user\",\"content\":\"你好\",\"future\":{\"value\":1}}\n{\"id\":\"a\",\"role\":\"assistant\",\"content\":\"draft\"}\n").unwrap();
    root
}

#[test]
fn strict_history_excludes_active_tail_and_preserves_unknown_fields() {
    let root = fixture();
    let store = ConversationStore::new(root.path());
    let first = store.read_committed("c", Some(3), 8192).unwrap();
    assert_eq!(first.history.messages.len(), 2);
    assert_eq!(first.history.messages[0]["future"], json!({"value":1}));
    fs::write(
        root.path().join("conversations/c.stream.json"),
        r#"{"version":1,"conversationId":"c","messageId":"a","patch":{}}"#,
    )
    .unwrap();
    let second = store.read_committed("c", Some(3), 8192).unwrap();
    assert_eq!(second.history.messages.len(), 1);
    assert_eq!(
        second.history.excluded_from_message_id.as_deref(),
        Some("a")
    );
    assert!(second.history.requires_runtime_check);
    assert_ne!(first.source_revision, second.source_revision);
}

#[test]
fn corrupt_sidecar_revision_budget_and_identifier_fail_closed() {
    let root = fixture();
    let store = ConversationStore::new(root.path());
    assert_eq!(
        store.read_committed("../c", None, 8192).unwrap_err(),
        StoreError::InvalidInput
    );
    assert_eq!(
        store.read_committed("c", Some(2), 8192).unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(
        store.read_committed("c", None, 2).unwrap_err(),
        StoreError::HistoryLimit
    );
    fs::write(
        root.path().join("conversations/c.stream.json"),
        r#"{"version":1,"conversationId":"c","messageId":"missing","patch":{}}"#,
    )
    .unwrap();
    assert_eq!(
        store.read_committed("c", None, 8192).unwrap_err(),
        StoreError::StreamTargetMissing
    );
    fs::write(root.path().join("conversations/c.stream.json"), "not json").unwrap();
    assert_eq!(
        store.read_committed("c", None, 8192).unwrap_err(),
        StoreError::StreamStateInvalid
    );
    fs::remove_file(root.path().join("conversations/c.stream.json")).unwrap();
    fs::write(root.path().join("conversations/c.jsonl"), "{}\nnot json\n").unwrap();
    assert_eq!(
        store.read_committed("c", None, 8192).unwrap_err(),
        StoreError::HistoryCorrupt
    );
}

#[cfg(unix)]
#[test]
fn internal_history_symlinks_are_not_followed() {
    let root = fixture();
    fs::remove_file(root.path().join("conversations/c.jsonl")).unwrap();
    fs::write(root.path().join("other"), "{}\n").unwrap();
    std::os::unix::fs::symlink(
        root.path().join("other"),
        root.path().join("conversations/c.jsonl"),
    )
    .unwrap();
    assert_eq!(
        ConversationStore::new(root.path())
            .read_committed("c", None, 8192)
            .unwrap_err(),
        StoreError::ReadFailed
    );
}

#[test]
fn history_bounds_allocations_across_rows_before_building_large_trees() {
    let root = fixture();
    let path = root.path().join("conversations/c.jsonl");
    // Under the byte limit, but 65,536 tiny values exceed the shared node budget.
    let body = format!("{{\"items\":[{}0]}}\n", "0,".repeat(65_535));
    fs::write(&path, &body).unwrap();
    let store = ConversationStore::new(root.path());
    assert_eq!(
        store.read_committed("c", None, 1_048_576).unwrap_err(),
        StoreError::HistoryLimit
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), body);
    let body = format!("{{\"deep\":{}0{}}}\n", "[".repeat(65), "]".repeat(65));
    fs::write(&path, &body).unwrap();
    assert_eq!(
        store.read_committed("c", None, 8192).unwrap_err(),
        StoreError::HistoryLimit
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), body);
}

#[test]
fn directory_lock_contends_cancels_and_never_reclaims_unknown_owner() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("index.jsonl");
    let lock = DirectoryLock::acquire(&file, Duration::ZERO, None).unwrap();
    assert!(matches!(
        DirectoryLock::acquire(&file, Duration::from_millis(10), None),
        Err(StoreError::LockBusy)
    ));
    assert!(matches!(
        DirectoryLock::acquire(&file, Duration::from_secs(1), Some(&AtomicBool::new(true))),
        Err(StoreError::Cancelled)
    ));
    lock.release().unwrap();
    let lock = DirectoryLock::acquire(&file, Duration::ZERO, None).unwrap();
    fs::remove_dir(root.path().join("index.jsonl.lock")).unwrap();
    fs::create_dir(root.path().join("index.jsonl.lock")).unwrap();
    fs::write(
        root.path().join("index.jsonl.lock/unknown-owner"),
        "preserve",
    )
    .unwrap();
    assert_eq!(lock.release(), Err(StoreError::LockOwnershipChanged));
    assert!(root.path().join("index.jsonl.lock/unknown-owner").exists());
}

fn policy_fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    fs::create_dir_all(root.path().join("projects/w")).unwrap();
    fs::create_dir(root.path().join("project-runtime")).unwrap();
    fs::write(
        root.path().join("projects/w/profile.json"),
        r#"{"workspaceId":"w","agentConversationId":"bot","status":"active","displayName":"Fixture Bot","avatar":{"kind":"generated"}}"#,
    )
    .unwrap();
    let db =
        rusqlite::Connection::open(root.path().join("project-runtime/bot-access.sqlite")).unwrap();
    db.execute_batch("CREATE TABLE access_policy(workspaceId TEXT NOT NULL, conversationId TEXT NOT NULL, revision INTEGER NOT NULL, accessLevel TEXT NOT NULL, updatedAt TEXT NOT NULL, source TEXT NOT NULL, PRIMARY KEY(workspaceId, revision)); CREATE TABLE access_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO access_meta VALUES('migrated','1'); PRAGMA user_version=1; INSERT INTO access_policy VALUES('w','bot',1,'ask_before_local','fixture','new_bot');").unwrap();
    root
}

#[test]
fn existing_policy_cas_history_and_principal_changes_are_real_sqlite_facts() {
    let root = policy_fixture();
    let first = PolicyStore::new(root.path());
    let second = PolicyStore::new(root.path());
    let initial = first.read_existing("w").unwrap();
    assert_eq!(initial.revision, 1);
    let updated = second
        .update_existing("w", 1, LocalAccessLevel::FullLocal, "now")
        .unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(first.read_existing("w").unwrap(), updated);
    assert_eq!(
        first.update_existing("w", 1, LocalAccessLevel::SessionLocal, "late"),
        Err(PolicyUpdateError::Conflict(updated))
    );
    assert_eq!(
        second
            .update_existing("w", 2, LocalAccessLevel::FullLocal, "same")
            .unwrap()
            .revision,
        2
    );
    fs::write(
        root.path().join("projects/w/profile.json"),
        r#"{"workspaceId":"w","agentConversationId":"replacement","status":"active","displayName":"Fixture Bot","avatar":{"kind":"generated"}}"#,
    )
    .unwrap();
    assert_eq!(first.read_existing("w"), Err(StoreError::OutOfScope));
}

#[test]
fn damaged_and_unknown_schema_policies_are_never_rebuilt_or_widened() {
    let root = policy_fixture();
    let path = root.path().join("project-runtime/bot-access.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=2").unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(
        PolicyStore::new(root.path()).read_existing("w"),
        Err(StoreError::PolicyUnavailable)
    );
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::write(&path, b"corrupt policy").unwrap();
    assert_eq!(
        PolicyStore::new(root.path()).read_existing("w"),
        Err(StoreError::PolicyUnavailable)
    );
    assert_eq!(fs::read(&path).unwrap(), b"corrupt policy");
}

#[test]
fn bundled_sqlite_supports_existing_fts5_trigram_queries() {
    let db = rusqlite::Connection::open_in_memory().unwrap();
    db.execute_batch("CREATE VIRTUAL TABLE memory USING fts5(content,tokenize='trigram'); INSERT INTO memory VALUES('原生迁移方案');").unwrap();
    let count: i64 = db
        .query_row(
            "SELECT count(*) FROM memory WHERE memory MATCH '迁移方案'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(count, 1);
}
