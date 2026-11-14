use peer_store::{ConversationStore, NewConversation, StoreError};
use serde_json::json;
use std::{fs, sync::atomic::AtomicBool};
const AT: &str = "2026-11-14T04:00:00.000Z";
fn create(s: &ConversationStore) -> String {
    s.create(
        &NewConversation {
            title: "Fixture",
            workspace_path: None,
            mode: "chat",
            created_at: AT,
        },
        None,
    )
    .unwrap()["id"]
        .as_str()
        .unwrap()
        .to_owned()
}
fn snapshot(s: &ConversationStore, id: &str) -> peer_store::HistorySnapshot {
    s.read_committed(id, None, 8 * 1024 * 1024).unwrap()
}
#[test]
fn source_bound_cas_idempotent_and_later_admission() {
    let r = tempfile::tempdir().unwrap();
    let s = ConversationStore::new(r.path());
    let id = create(&s);
    let old = snapshot(&s, &id);
    let row = json!({"id":"a","role":"user","content":"原生输入","future":{"opaque":true}});
    let committed = s.commit_message(&old, &row, AT, None).unwrap();
    assert!(!committed.already_committed);
    assert_eq!(committed.snapshot.history.content_revision, 1);
    assert!(
        s.commit_message(&old, &row, AT, None)
            .unwrap()
            .already_committed
    );
    assert_eq!(snapshot(&s, &id).history.messages, vec![row.clone()]);
    assert_eq!(
        s.commit_message(
            &old,
            &json!({"id":"b","role":"user","content":"stale"}),
            AT,
            None
        )
        .unwrap_err(),
        StoreError::VersionChanged
    );
    let next = s
        .commit_message(
            &committed.snapshot,
            &json!({"id":"b","role":"assistant","content":"回复"}),
            AT,
            None,
        )
        .unwrap();
    assert_eq!(next.snapshot.history.content_revision, 2);
    let mut changed = row;
    changed["content"] = json!("mutated");
    assert_eq!(
        s.commit_message(&next.snapshot, &changed, AT, None)
            .unwrap_err(),
        StoreError::VersionChanged
    );
}
#[cfg(feature = "test-fixtures")]
#[test]
fn body_before_index_failure_preserves_and_reconciles_without_duplicate() {
    let r = tempfile::tempdir().unwrap();
    let s = ConversationStore::new(r.path());
    let id = create(&s);
    let old = snapshot(&s, &id);
    let row = json!({"id":"call","role":"assistant","content":"","segments":[{"type":"tool-call","toolCallId":"call","tool":"local.shell.exec","args":{"command":"printf effect"}}]});
    assert_eq!(
        s.commit_message_fixture(&old, &row, AT, false).unwrap_err(),
        StoreError::CommitUncertain
    );
    let body = r.path().join(format!("conversations/{id}.jsonl"));
    let preserved = fs::read(&body).unwrap();
    assert_eq!(snapshot(&s, &id).history.messages.len(), 1);
    assert_eq!(
        s.commit_message(&old, &row, AT, None).unwrap_err(),
        StoreError::CommitUncertain
    );
    let fixed = s.reconcile_index(&id, AT, None).unwrap();
    assert_eq!(fixed.history.content_revision, 1);
    assert!(
        s.commit_message(&fixed, &row, AT, None)
            .unwrap()
            .already_committed
    );
    assert_eq!(fs::read(&body).unwrap(), preserved);
    assert_eq!(
        s.reconcile_index(&id, AT, None)
            .unwrap()
            .history
            .content_revision,
        1
    );
    let later = s
        .commit_message(
            &fixed,
            &json!({"id":"later","role":"user","content":"subsequent input"}),
            AT,
            None,
        )
        .unwrap();
    assert_eq!(later.snapshot.history.messages.len(), 2);
    // The incomplete tool remains an incomplete tool; index repair manufactures no result.
    assert!(
        later.snapshot.history.messages[0]["segments"][0]
            .get("result")
            .is_none()
    );
}
#[test]
fn corruption_sidecar_orphan_and_cancel_do_not_write() {
    let r = tempfile::tempdir().unwrap();
    let s = ConversationStore::new(r.path());
    let flag = AtomicBool::new(true);
    assert_eq!(
        s.create(
            &NewConversation {
                title: "Fixture",
                workspace_path: None,
                mode: "chat",
                created_at: AT
            },
            Some(&flag)
        )
        .unwrap_err(),
        StoreError::Cancelled
    );
    assert!(!r.path().join("conversations").exists());
    let id = create(&s);
    let old = snapshot(&s, &id);
    let dir = r.path().join("conversations");
    let index = fs::read(dir.join("index.jsonl")).unwrap();
    fs::create_dir(dir.join("index.jsonl.lock")).unwrap();
    assert_eq!(
        s.commit_message(
            &old,
            &json!({"id":"a","role":"user","content":"x"}),
            AT,
            None
        )
        .unwrap_err(),
        StoreError::LockBusy
    );
    assert_eq!(fs::read(dir.join("index.jsonl")).unwrap(), index);
    fs::remove_dir(dir.join("index.jsonl.lock")).unwrap();
    let body = dir.join(format!("{id}.jsonl"));
    fs::write(&body, b"{partial").unwrap();
    assert!(s.reconcile_index(&id, AT, None).is_err());
    assert_eq!(fs::read(&body).unwrap(), b"{partial");
    fs::write(&body, b"").unwrap();
    let side = dir.join(format!("{id}.stream.json"));
    fs::write(&side, b"{}").unwrap();
    assert_eq!(
        s.reconcile_index(&id, AT, None).unwrap_err(),
        StoreError::StreamStateInvalid
    );
}
#[test]
fn same_revision_replaced_source_cannot_be_overwritten() {
    let r = tempfile::tempdir().unwrap();
    let s = ConversationStore::new(r.path());
    let id = create(&s);
    let old = snapshot(&s, &id);
    let file = r.path().join("conversations/index.jsonl");
    let mut meta: serde_json::Value = serde_json::from_slice(&fs::read(&file).unwrap()).unwrap();
    meta["opaque"] = json!("another writer");
    fs::write(&file, format!("{meta}\n")).unwrap();
    assert_eq!(
        s.commit_message(
            &old,
            &json!({"id":"new","role":"user","content":"x"}),
            AT,
            None
        )
        .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(snapshot(&s, &id).history.messages.len(), 0);
}

#[test]
fn missing_previously_counted_rows_cannot_be_reconciled_as_empty_success() {
    let r = tempfile::tempdir().unwrap();
    let s = ConversationStore::new(r.path());
    let id = create(&s);
    let old = snapshot(&s, &id);
    s.commit_message(
        &old,
        &json!({"id":"saved","role":"user","content":"confirmed"}),
        AT,
        None,
    )
    .unwrap();
    let body = r.path().join(format!("conversations/{id}.jsonl"));
    let index = r.path().join("conversations/index.jsonl");
    let before = fs::read(&index).unwrap();
    fs::write(&body, b"").unwrap();
    assert_eq!(
        s.reconcile_index(&id, AT, None).unwrap_err(),
        StoreError::HistoryMissing
    );
    assert_eq!(fs::read(index).unwrap(), before);
    assert!(fs::read(body).unwrap().is_empty());
}
