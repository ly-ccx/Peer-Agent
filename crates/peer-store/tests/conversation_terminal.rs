use peer_store::{ConversationStore, DirectoryLock, NewConversation, StoreError};
use serde_json::{Value, json};
use std::{fs, path::Path, sync::atomic::AtomicBool, time::Duration};
const AT: &str = "2026-11-18T00:00:00.000Z";

#[cfg(feature = "test-fixtures")]
#[test]
fn cancellation_after_publication_finishes_known_storage_without_discarding_facts() {
    for phase in ["marker", "body", "index"] {
        let (root, store, id) = seed();
        let files = paths(root.path(), &id);
        let initial = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        let cancel = AtomicBool::new(false);
        let done = store
            .commit_terminal_fixture(
                &initial,
                "answer",
                &json!({"content":"already observed"}),
                AT,
                Some(&cancel),
                &format!("cancel:{phase}"),
            )
            .unwrap();
        assert!(cancel.load(std::sync::atomic::Ordering::Acquire));
        assert_eq!(
            done.snapshot.history.messages[1]["content"],
            "already observed"
        );
        assert!(!files[2].exists());
        store
            .commit_message(
                &done.snapshot,
                &json!({"id":"later","role":"user","content":"new task"}),
                AT,
                None,
            )
            .unwrap();
    }
}
fn get(path: impl AsRef<Path>) -> Value {
    serde_json::from_slice(&fs::read(path).unwrap()).unwrap()
}
fn seed() -> (tempfile::TempDir, ConversationStore, String) {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let meta = store
        .create(
            &NewConversation {
                title: "Terminal fixture",
                workspace_path: None,
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap();
    let id = meta["id"].as_str().unwrap().to_owned();
    for message in [
        json!({"id":"user","role":"user","content":"question"}),
        json!({"id":"answer","role":"assistant","content":"","future":{"opaque":true}}),
    ] {
        let snapshot = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        store.commit_message(&snapshot, &message, AT, None).unwrap();
    }
    (root, store, id)
}
fn paths(root: &Path, id: &str) -> [std::path::PathBuf; 3] {
    [
        root.join("conversations/index.jsonl"),
        root.join(format!("conversations/{id}.jsonl")),
        root.join(format!("conversations/{id}.stream.json")),
    ]
}
fn bytes(paths: &[std::path::PathBuf; 3]) -> Vec<Option<Vec<u8>>> {
    paths.iter().map(|p| fs::read(p).ok()).collect()
}

#[test]
fn numeric_v1_sidecar_uses_the_existing_reader_normalization() {
    let (root, store, id) = seed();
    let initial = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store
        .patch_stream_message(&initial, "answer", &json!({"content":"preview"}), AT, None)
        .unwrap();
    let marker = paths(root.path(), &id)[2].clone();
    let value = fs::read_to_string(&marker)
        .unwrap()
        .replace("\"version\":1", "\"version\":1.0");
    assert!(value.contains("\"version\":1.0"));
    fs::write(&marker, value).unwrap();
    let fresh = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store
        .commit_terminal_message(&fresh, "answer", &json!({"content":"final"}), AT, None)
        .unwrap();
}
#[test]
fn stream_is_provisional_terminal_merges_original_facts_and_stale_patch_cannot_return() {
    let (root, store, id) = seed();
    let files = paths(root.path(), &id);
    let initial = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let before = bytes(&files);
    let streamed = store
        .patch_stream_message(&initial, "answer", &json!({"content":"partial"}), AT, None)
        .unwrap();
    assert_eq!(streamed.history.content_revision, 2);
    assert_eq!(streamed.history.messages.len(), 1);
    assert_eq!(bytes(&files)[..2], before[..2]);
    let mut marker = get(&files[2]);
    marker["futureMarker"] = json!({"opaque":true});
    fs::write(&files[2], serde_json::to_vec(&marker).unwrap()).unwrap();
    let observed = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let current = store
        .patch_stream_message(
            &observed,
            "answer",
            &json!({"content":"partial two"}),
            AT,
            None,
        )
        .unwrap();
    assert_eq!(get(&files[2])["futureMarker"], json!({"opaque":true}));
    let patch = json!({"content":"final","interrupted":false,"segments":[{"type":"tool-call","toolCallId":"actual-call","tool":"read_file","result":{"status":"success","evidence":{"ref":"retained"}}}],"permissionGrants":[{"grantId":"actual-grant","granted":true}]});
    let done = store
        .commit_terminal_message(&current, "answer", &patch, AT, None)
        .unwrap();
    assert_eq!(done.snapshot.history.content_revision, 3);
    assert!(!files[2].exists());
    let row = &done.snapshot.history.messages[1];
    assert_eq!(row["future"], json!({"opaque":true}));
    for (key, value) in patch.as_object().unwrap() {
        assert_eq!(&row[key], value);
    }
    let saved = bytes(&files);
    assert_eq!(
        store
            .patch_stream_message(&current, "answer", &json!({"content":"late"}), AT, None)
            .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(
        store
            .commit_terminal_message(&initial, "answer", &patch, AT, None)
            .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(bytes(&files), saved);
    assert!(
        store
            .commit_terminal_message(&done.snapshot, "answer", &patch, AT, None)
            .unwrap()
            .already_committed
    );
    assert_eq!(bytes(&files), saved);
    let fresh = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store
        .commit_message(
            &fresh,
            &json!({"id":"later","role":"user","content":"new task"}),
            AT,
            None,
        )
        .unwrap();
}
#[test]
fn invalid_foreign_cancelled_and_busy_updates_preserve_sources_then_admit_valid_work() {
    let (root, store, id) = seed();
    let files = paths(root.path(), &id);
    let initial = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let before = bytes(&files);
    for patch in [
        json!({"id":"replacement"}),
        json!({"role":"user"}),
        json!([]),
    ] {
        assert_eq!(
            store
                .commit_terminal_message(&initial, "answer", &patch, AT, None)
                .unwrap_err(),
            StoreError::InvalidInput
        );
    }
    assert_eq!(
        store
            .patch_stream_message(&initial, "missing", &json!({}), AT, None)
            .unwrap_err(),
        StoreError::StreamTargetMissing
    );
    assert_eq!(
        store
            .commit_terminal_message(
                &initial,
                "answer",
                &json!({"content":"cancelled"}),
                AT,
                Some(&AtomicBool::new(true))
            )
            .unwrap_err(),
        StoreError::Cancelled
    );
    let held = DirectoryLock::acquire(&files[0], Duration::from_millis(100), None).unwrap();
    assert_eq!(
        store
            .patch_stream_message(&initial, "answer", &json!({}), AT, None)
            .unwrap_err(),
        StoreError::LockBusy
    );
    drop(held);
    assert_eq!(bytes(&files), before);
    store
        .patch_stream_message(
            &initial,
            "user",
            &json!({"content":"owned user preview"}),
            AT,
            None,
        )
        .unwrap();
    let foreign = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    let saved = bytes(&files);
    assert_eq!(
        store
            .commit_terminal_message(&foreign, "answer", &json!({"content":"never"}), AT, None)
            .unwrap_err(),
        StoreError::StreamStateInvalid
    );
    assert_eq!(bytes(&files), saved);
    store
        .commit_terminal_message(&foreign, "user", &json!({"content":"question"}), AT, None)
        .unwrap();
    let fresh = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
    store
        .commit_terminal_message(&fresh, "answer", &json!({"content":"complete"}), AT, None)
        .unwrap();
}
#[cfg(feature = "test-fixtures")]
#[test]
fn every_interrupted_commit_preserves_actual_body_and_can_finish_without_replay_or_duplicate() {
    for phase in ["marker", "body", "index", "sidecar"] {
        let (root, store, id) = seed();
        let files = paths(root.path(), &id);
        let initial = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        let patch = json!({"content":"observed final","permissionGrants":[{"grantId":"retained","granted":true}],"segments":[{"type":"tool-call","toolCallId":"same-call","result":{"status":"failed","error":{"code":"known"}}}]});
        assert_eq!(
            store
                .commit_terminal_fixture(&initial, "answer", &patch, AT, None, phase)
                .unwrap_err(),
            StoreError::CommitUncertain
        );
        let raw: Vec<Value> = fs::read_to_string(&files[1])
            .unwrap()
            .lines()
            .map(|s| serde_json::from_str(s).unwrap())
            .collect();
        assert_eq!(
            raw[1]["content"],
            if phase == "marker" {
                ""
            } else {
                "observed final"
            }
        );
        assert_eq!(files[2].exists(), phase != "sidecar");
        let fresh = store.read_committed(&id, None, 8 * 1024 * 1024).unwrap();
        assert_eq!(
            fresh.history.excluded_from_message_id.is_some(),
            phase != "sidecar"
        );
        let done = store
            .commit_terminal_message(&fresh, "answer", &patch, AT, None)
            .unwrap();
        assert_eq!(done.snapshot.history.messages.len(), 2);
        assert_eq!(
            done.snapshot.history.messages[1]["permissionGrants"],
            patch["permissionGrants"]
        );
        assert!(!files[2].exists());
        assert!(
            store
                .commit_terminal_message(&done.snapshot, "answer", &patch, AT, None)
                .unwrap()
                .already_committed
        );
        store
            .commit_message(
                &done.snapshot,
                &json!({"id":"later","role":"user","content":"new task"}),
                AT,
                None,
            )
            .unwrap();
    }
}
