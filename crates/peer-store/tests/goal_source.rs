use peer_store::{GoalSourceStore, StoreError};
use std::{fs, io::Write, sync::atomic::AtomicBool};
#[test]
fn large_goal_and_progress_are_raw_identity_bound_snapshots_without_source_mutation() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("goal-plans");
    fs::create_dir_all(directory.join("runner-progress")).unwrap();
    let path = directory.join("p.json");
    let mut file = fs::File::create(&path).unwrap();
    file.write_all(br#"{"planId":"p","conversationId":"c","status":"executing","trace":""#)
        .unwrap();
    for _ in 0..1024 {
        file.write_all(&[b'x'; 16 * 1024]).unwrap();
    }
    file.write_all(br#"","delegationOrigin":{"workspaceId":"w","sessionId":"s"}}"#)
        .unwrap();
    drop(file);
    let progress = directory.join("runner-progress/p.json");
    fs::write(
        &progress,
        r#"{"planId":"p","status":"paused","runner":{"updatedAt":"2026-11-14T00:00:00Z"}}"#,
    )
    .unwrap();
    let before = fs::metadata(&path).unwrap();
    let snapshot = GoalSourceStore::new(root.path())
        .read_raw_fields("p", 32 * 1024 * 1024, None)
        .unwrap();
    assert_eq!(snapshot.raw_plan["status"], "executing");
    assert_eq!(
        snapshot.raw_runner_progress.as_ref().unwrap()["status"],
        "paused"
    );
    assert!(snapshot.raw_plan.get("trace").is_none());
    assert!(snapshot.requires_runtime_check);
    assert!(snapshot.source_bytes > 16 * 1024 * 1024);
    assert_eq!(
        fs::metadata(&path).unwrap().modified().unwrap(),
        before.modified().unwrap()
    );
    fs::write(&progress, r#"{"planId":"p","status":"cancelled"}"#).unwrap();
    let next = GoalSourceStore::new(root.path())
        .read_raw_fields("p", 32 * 1024 * 1024, None)
        .unwrap();
    assert_ne!(snapshot.source_revision, next.source_revision);
}
#[test]
fn invalid_identity_corrupt_progress_limits_and_cancellation_block_raw_projection() {
    let root = tempfile::tempdir().unwrap();
    let directory = root.path().join("goal-plans");
    fs::create_dir_all(directory.join("runner-progress")).unwrap();
    let store = GoalSourceStore::new(root.path());
    assert!(matches!(
        store.read_raw_fields("../p", 1024, None),
        Err(StoreError::InvalidInput)
    ));
    fs::write(directory.join("p.json"), r#"{"planId":"other"}"#).unwrap();
    assert!(matches!(
        store.read_raw_fields("p", 1024, None),
        Err(StoreError::GoalCorrupt)
    ));
    fs::write(directory.join("p.json"), r#"{"planId":"p"}"#).unwrap();
    assert!(matches!(
        store.read_raw_fields("p", 2, None),
        Err(StoreError::GoalLimit)
    ));
    assert!(matches!(
        store.read_raw_fields("p", 1024, Some(&AtomicBool::new(true))),
        Err(StoreError::Cancelled)
    ));
    fs::write(directory.join("runner-progress/p.json"), "corrupt").unwrap();
    assert!(matches!(
        store.read_raw_fields("p", 1024, None),
        Err(StoreError::GoalCorrupt)
    ));
}
