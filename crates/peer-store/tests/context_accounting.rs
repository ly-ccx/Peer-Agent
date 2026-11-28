use peer_store::{ConversationStore, NewConversation, StoreError};
use serde_json::{Value, json};
use std::fs;
const AT: &str = "2026-11-14T04:00:00.000Z";
fn snapshot(id: &str, revision: u64, epoch: u64) -> Value {
    json!({"version":1,"conversationId":id,"contentRevision":revision,"modelKey":"provider::model","revision":2,"phase":"turn_complete","compactionEpoch":epoch,"contextWindow":1000,"inputBudget":1000,"compactionThresholdTokens":800,"authoritativeInputTokens":20,"percent":2,"pressureSource":"provider_usage","pendingUncountedChanges":false,"pendingContentChars":0,"countCapability":{"kind":"observed_usage_only"},"counterStatus":"active","updatedAt":1,"lastObserved":{"inputTokens":20,"requestFingerprint":"actual-request","compactionEpoch":epoch,"source":"provider_usage","observedAt":1}})
}
#[test]
fn durable_capacity_cas_boundary_unknown_fields_and_corrupt_sidecar_preservation() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let meta = store
        .create(
            &NewConversation {
                title: "owned fixture",
                workspace_path: None,
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap();
    let id = meta["id"].as_str().unwrap();
    store.bind_context_model(id, "provider", "model").unwrap();
    assert_eq!(
        store.bind_context_model(id, "other", "model").unwrap_err(),
        StoreError::ContextConflict
    );
    let history = store.read_committed(id, None, 1024 * 1024).unwrap();
    let committed = store
        .commit_message(
            &history,
            &json!({"id":"u","role":"user","content":"goal"}),
            AT,
            None,
        )
        .unwrap()
        .snapshot;
    let saved = store
        .write_context_snapshot(&committed, &snapshot(id, 1, 0))
        .unwrap();
    assert_eq!(
        store
            .read_context_snapshot(&saved, "provider::model")
            .unwrap()
            .unwrap()["authoritativeInputTokens"],
        20
    );
    assert_eq!(
        store
            .write_context_snapshot(&committed, &snapshot(id, 1, 0))
            .unwrap_err(),
        StoreError::ContextConflict
    );
    let file = root
        .path()
        .join(format!("conversations/.context-snapshots/{id}.json"));
    let mut raw: Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    raw["futureOpaque"] = json!({"keep":true});
    fs::write(&file, raw.to_string()).unwrap();
    let current = store.read_committed(id, None, 1024 * 1024).unwrap();
    store
        .write_context_snapshot(&current, &snapshot(id, 1, 0))
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&file).unwrap()).unwrap()["futureOpaque"],
        json!({"keep":true})
    );
    let history = store.read_committed(id, None, 1024 * 1024).unwrap();
    let marker = json!({"id":"compact","role":"user","content":"handoff","_compaction":{"method":"llm","summary":"handoff","historySelection":{"version":1,"compactionEpoch":1,"retainedMessageIds":["u"]}}});
    let compacted = store
        .commit_message(&history, &marker, AT, None)
        .unwrap()
        .snapshot;
    assert!(
        store
            .read_context_snapshot(&compacted, "provider::model")
            .unwrap()
            .is_none()
    );
    assert_eq!(
        store
            .write_context_snapshot(&compacted, &snapshot(id, 2, 0))
            .unwrap_err(),
        StoreError::ContextConflict
    );
    let new = store
        .write_context_snapshot(&compacted, &snapshot(id, 2, 1))
        .unwrap();
    let raw = store
        .read_context_snapshot(&new, "provider::model")
        .unwrap()
        .unwrap();
    assert_eq!(raw["compactionBoundaryId"], "compact");
    let original = fs::read(&file).unwrap();
    for corrupt in [
        b"{broken".to_vec(),
        b"{\"version\":99,\"opaque\":true}".to_vec(),
    ] {
        fs::write(&file, &corrupt).unwrap();
        let history = store.read_committed(id, None, 1024 * 1024).unwrap();
        assert!(
            store
                .read_context_snapshot(&history, "provider::model")
                .unwrap()
                .is_none()
        );
        assert_eq!(
            store
                .write_context_snapshot(&history, &snapshot(id, 2, 1))
                .unwrap_err(),
            StoreError::ContextInvalid
        );
        assert_eq!(fs::read(&file).unwrap(), corrupt);
    }
    fs::write(&file, original).unwrap();
    let current = store.read_committed(id, None, 1024 * 1024).unwrap();
    let later = store
        .commit_message(
            &current,
            &json!({"id":"next","role":"user","content":"next task"}),
            AT,
            None,
        )
        .unwrap();
    assert_eq!(
        store
            .read_context_snapshot(&later.snapshot, "provider::model")
            .unwrap()
            .unwrap()["lastObserved"]["inputTokens"],
        20
    );
}

#[cfg(feature = "test-fixtures")]
#[test]
fn marker_body_before_index_invalidates_old_capacity_and_reconciles_without_rewrite() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let meta = store
        .create(
            &NewConversation {
                title: "owned",
                workspace_path: None,
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap();
    let id = meta["id"].as_str().unwrap();
    store.bind_context_model(id, "provider", "model").unwrap();
    let history = store.read_committed(id, None, 1024 * 1024).unwrap();
    let history = store
        .write_context_snapshot(&history, &snapshot(id, 0, 0))
        .unwrap();
    let marker = json!({"id":"compact","role":"user","content":"handoff","_compaction":{"summary":"handoff","historySelection":{"version":1,"compactionEpoch":1,"retainedMessageIds":[]}}});
    assert_eq!(
        store
            .commit_message_fixture(&history, &marker, AT, false)
            .unwrap_err(),
        StoreError::CommitUncertain
    );
    let partial = store.read_committed(id, None, 1024 * 1024).unwrap();
    assert!(
        store
            .read_context_snapshot(&partial, "provider::model")
            .unwrap()
            .is_none()
    );
    let body = root.path().join(format!("conversations/{id}.jsonl"));
    let original = fs::read(&body).unwrap();
    let fixed = store.reconcile_index(id, AT, None).unwrap();
    assert_eq!(fixed.history.content_revision, 1);
    assert_eq!(fs::read(body).unwrap(), original);
    store
        .write_context_snapshot(&fixed, &snapshot(id, 1, 1))
        .unwrap();
}

#[cfg(feature = "test-fixtures")]
#[test]
fn sidecar_before_mirror_failure_and_old_metadata_fields_are_recoverable() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let meta = store
        .create(
            &NewConversation {
                title: "owned",
                workspace_path: None,
                mode: "chat",
                created_at: AT,
            },
            None,
        )
        .unwrap();
    let id = meta["id"].as_str().unwrap();
    store.bind_context_model(id, "provider", "model").unwrap();
    let index = root.path().join("conversations/index.jsonl");
    let mut row: Value = serde_json::from_slice(&fs::read(&index).unwrap()).unwrap();
    row["contextSnapshot"] = snapshot(id, 0, 0);
    row["contextSnapshot"]["modelKey"] = json!("provider");
    row["contextSnapshot"]["futureOpaque"] = json!({"keep":true});
    fs::write(&index, format!("{row}\n")).unwrap();
    let history = store.read_committed(id, None, 1024 * 1024).unwrap();
    assert_eq!(
        store
            .read_context_snapshot(&history, "provider::model")
            .unwrap()
            .unwrap()["modelKey"],
        "provider::model"
    );
    assert_eq!(
        store
            .write_context_snapshot_fixture(&history, &snapshot(id, 0, 0))
            .unwrap_err(),
        StoreError::ContextCommitUncertain
    );
    let saved = store
        .read_context_snapshot(&history, "provider::model")
        .unwrap()
        .unwrap();
    assert_eq!(saved["futureOpaque"], json!({"keep":true}));
    assert_eq!(saved["projectorVersion"], 3);
    let current = store.read_committed(id, None, 1024 * 1024).unwrap();
    store
        .write_context_snapshot(&current, &snapshot(id, 0, 0))
        .unwrap();
    let row: Value = serde_json::from_slice(&fs::read(index).unwrap()).unwrap();
    assert_eq!(row["contextSnapshot"]["futureOpaque"], json!({"keep":true}));
    assert_eq!(row["contextSnapshot"]["projectorVersion"], 3);
}
