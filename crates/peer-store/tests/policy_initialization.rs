use peer_protocol::LocalAccessLevel;
use peer_store::{PolicyStore, StoreError};
use std::{
    fs,
    path::Path,
    sync::{Arc, Barrier, atomic::AtomicBool},
};
const AT: &str = "2026-11-14T00:00:00.000Z";
fn profile(root: &Path, id: &str, conversation: &str) {
    fs::create_dir_all(root.join("projects").join(id)).unwrap();
    fs::write(
        root.join("projects").join(id).join("profile.json"),
        serde_json::json!({"workspaceId":id,"agentConversationId":conversation,"status":"active","displayName":"Fixture Bot","avatar":{"kind":"generated"}})
            .to_string(),
    )
    .unwrap();
}
#[test]
fn explicit_first_migration_preserves_existing_policy_and_new_bots_start_ask() {
    let root = tempfile::tempdir().unwrap();
    profile(root.path(), "w", "bot");
    let store = PolicyStore::new(root.path());
    let initialized = store
        .initialize(LocalAccessLevel::FullLocal, AT, None)
        .unwrap();
    assert!(initialized.created_authority);
    assert_eq!(initialized.migrated_profiles, 1);
    let original = store.read_existing("w").unwrap();
    assert_eq!(original.access_level, LocalAccessLevel::FullLocal);
    assert_eq!(original.source, "legacy_migration");
    let again = store
        .initialize(LocalAccessLevel::AskBeforeLocal, AT, None)
        .unwrap();
    assert_eq!(again.migrated_profiles, 0);
    assert!(!again.created_authority);
    assert_eq!(store.read_existing("w").unwrap(), original);
    profile(root.path(), "new", "new-bot");
    assert_eq!(
        store.read_existing("new"),
        Err(StoreError::PolicyUnavailable)
    );
    let new = store.read_or_register("new", AT).unwrap();
    assert_eq!(new.access_level, LocalAccessLevel::AskBeforeLocal);
    assert_eq!(new.source, "new_bot");
    assert_eq!(new.revision, 1);
    profile(root.path(), "new", "replaced");
    assert_eq!(
        store.read_or_register("new", AT),
        Err(StoreError::OutOfScope)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(root.path().join("project-runtime/bot-access.sqlite"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
#[test]
fn imported_data_does_not_inherit_another_device_full_setting() {
    let root = tempfile::tempdir().unwrap();
    profile(root.path(), "w", "bot");
    fs::create_dir(root.path().join("project-runtime")).unwrap();
    fs::write(
        root.path().join("project-runtime/bot-access-imported.json"),
        "{}",
    )
    .unwrap();
    let store = PolicyStore::new(root.path());
    store
        .initialize(LocalAccessLevel::FullLocal, AT, None)
        .unwrap();
    assert_eq!(
        store.read_existing("w").unwrap().access_level,
        LocalAccessLevel::AskBeforeLocal
    );
}
#[test]
fn unknown_schema_corrupt_db_and_unknown_marker_are_preserved_during_initialization() {
    let root = tempfile::tempdir().unwrap();
    let store = PolicyStore::new(root.path());
    store
        .initialize(LocalAccessLevel::AskBeforeLocal, AT, None)
        .unwrap();
    let path = root.path().join("project-runtime/bot-access.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("PRAGMA user_version=2").unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert!(matches!(
        store.initialize(LocalAccessLevel::FullLocal, AT, None),
        Err(StoreError::PolicyUnavailable)
    ));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    fs::write(&path, "corrupt authority").unwrap();
    assert!(matches!(
        store.initialize(LocalAccessLevel::FullLocal, AT, None),
        Err(StoreError::PolicyUnavailable)
    ));
    assert_eq!(fs::read(&path).unwrap(), b"corrupt authority");
    let root = tempfile::tempdir().unwrap();
    let store = PolicyStore::new(root.path());
    store
        .initialize(LocalAccessLevel::AskBeforeLocal, AT, None)
        .unwrap();
    let path = root.path().join("project-runtime/bot-access.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("UPDATE access_meta SET value='future' WHERE key='migrated'")
        .unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert!(matches!(
        store.initialize(LocalAccessLevel::FullLocal, AT, None),
        Err(StoreError::PolicyUnavailable)
    ));
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
#[test]
fn skipped_bad_profiles_are_reported_and_later_registration_stays_ask() {
    let root = tempfile::tempdir().unwrap();
    profile(root.path(), "good", "bot");
    profile(root.path(), "bad", "invalid");
    fs::write(root.path().join("projects/bad/profile.json"), "corrupt").unwrap();
    let store = PolicyStore::new(root.path());
    let report = store
        .initialize(LocalAccessLevel::FullLocal, AT, None)
        .unwrap();
    assert_eq!(report.skipped_profiles, vec!["bad"]);
    assert_eq!(report.migrated_profiles, 1);
    profile(root.path(), "bad", "fixed");
    assert_eq!(
        store.read_or_register("bad", AT).unwrap().access_level,
        LocalAccessLevel::AskBeforeLocal
    );
}
#[test]
fn cancellation_before_initialization_creates_no_authority() {
    let root = tempfile::tempdir().unwrap();
    let store = PolicyStore::new(root.path());
    assert!(matches!(
        store.initialize(
            LocalAccessLevel::FullLocal,
            AT,
            Some(&AtomicBool::new(true))
        ),
        Err(StoreError::Cancelled)
    ));
    assert!(fs::read_dir(root.path()).unwrap().next().is_none());
}
#[test]
fn concurrent_new_bot_registration_creates_one_revision() {
    let root = tempfile::tempdir().unwrap();
    PolicyStore::new(root.path())
        .initialize(LocalAccessLevel::FullLocal, AT, None)
        .unwrap();
    profile(root.path(), "w", "bot");
    let barrier = Arc::new(Barrier::new(2));
    let tasks: Vec<_> = (0..2)
        .map(|_| {
            let root = root.path().to_owned();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                PolicyStore::new(root).read_or_register("w", AT)
            })
        })
        .collect();
    for task in tasks {
        let policy = task.join().unwrap().unwrap();
        assert_eq!(policy.revision, 1);
        assert_eq!(policy.access_level, LocalAccessLevel::AskBeforeLocal);
    }
    let db =
        rusqlite::Connection::open(root.path().join("project-runtime/bot-access.sqlite")).unwrap();
    let count: i64 = db
        .query_row("SELECT count(*) FROM access_policy", [], |r| r.get(0))
        .unwrap();
    assert_eq!(count, 1);
}

#[test]
fn oversized_sqlite_values_and_malformed_known_tables_fail_without_rebuild() {
    let root = tempfile::tempdir().unwrap();
    profile(root.path(), "w", "bot");
    let store = PolicyStore::new(root.path());
    store
        .initialize(LocalAccessLevel::AskBeforeLocal, AT, None)
        .unwrap();
    let path = root.path().join("project-runtime/bot-access.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute(
        "UPDATE access_policy SET updatedAt=?1",
        ["x".repeat(1_048_577)],
    )
    .unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert_eq!(store.read_existing("w"), Err(StoreError::PolicyUnavailable));
    assert_eq!(fs::read(&path).unwrap(), bytes);
    let root = tempfile::tempdir().unwrap();
    fs::create_dir(root.path().join("project-runtime")).unwrap();
    let path = root.path().join("project-runtime/bot-access.sqlite");
    let db = rusqlite::Connection::open(&path).unwrap();
    db.execute_batch("CREATE TABLE access_policy(unknown TEXT)")
        .unwrap();
    drop(db);
    let bytes = fs::read(&path).unwrap();
    assert!(matches!(
        PolicyStore::new(root.path()).initialize(LocalAccessLevel::FullLocal, AT, None),
        Err(StoreError::PolicyUnavailable)
    ));
    assert_eq!(fs::read(&path).unwrap(), bytes);
}
