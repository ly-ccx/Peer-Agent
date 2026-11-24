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
#[test]
fn unrelated_index_publication_preserves_source_but_target_metadata_edit_invalidates_it() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let first = create(&store);
    let before = snapshot(&store, &first);
    let second = create(&store);
    let other_message = json!({"id":"b","role":"user","content":"independent"});
    let other = store
        .commit_message(&snapshot(&store, &second), &other_message, AT, None)
        .unwrap()
        .snapshot;
    assert_eq!(
        snapshot(&store, &first).source_revision,
        before.source_revision
    );
    let first_message = json!({"id":"a","role":"user","content":"original"});
    let committed = store
        .commit_message(&before, &first_message, AT, None)
        .unwrap()
        .snapshot;
    assert_eq!(
        snapshot(&store, &second).source_revision,
        other.source_revision
    );
    assert_eq!(
        snapshot(&store, &second).history.messages,
        vec![other_message]
    );
    assert_eq!(committed.history.messages, vec![first_message]);

    let index = root.path().join("conversations/index.jsonl");
    let mut rows: Vec<serde_json::Value> = fs::read_to_string(&index)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    let target = rows.iter_mut().find(|row| row["id"] == first).unwrap();
    target["future"] = json!({"opaque":true});
    let edited = rows
        .iter()
        .map(|row| format!("{row}\n"))
        .collect::<String>();
    fs::write(&index, &edited).unwrap();
    assert_eq!(
        snapshot(&store, &first).history.content_revision,
        committed.history.content_revision
    );
    assert_eq!(
        store
            .commit_message(
                &committed,
                &json!({"id":"stale","role":"user","content":"stale"}),
                AT,
                None
            )
            .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(fs::read_to_string(index).unwrap(), edited);
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

#[test]
fn legacy_duplicate_historical_ids_allow_new_appends_reconcile_and_terminal_updates_while_blocking_new_duplicates()
 {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let id = create(&store);
    let dir = root.path().join("conversations");
    let body_path = dir.join(format!("{id}.jsonl"));
    let index_path = dir.join("index.jsonl");

    let dup_failed = json!({
        "id": "card:verdict:s-1",
        "role": "assistant",
        "kind": "system_card",
        "content": "failed",
    });
    let dup_passed = json!({
        "id": "card:verdict:s-1",
        "role": "assistant",
        "kind": "system_card",
        "content": "passed",
    });
    let unique_answer = json!({
        "id": "answer",
        "role": "assistant",
        "content": "draft",
    });
    fs::write(
        &body_path,
        format!("{dup_failed}\n{dup_passed}\n{unique_answer}\n"),
    )
    .unwrap();

    let mut index_row: serde_json::Value =
        serde_json::from_slice(&fs::read(&index_path).unwrap()).unwrap();
    index_row["messageCount"] = json!(3);
    index_row["contentRevision"] = json!(3);
    fs::write(&index_path, format!("{index_row}\n")).unwrap();

    let reply = json!({"id": "reply-1", "role": "assistant", "content": "new reply"});
    let first = store
        .append_message_idempotent(&id, &reply, AT, None)
        .unwrap();
    assert!(!first.already_committed);
    assert_eq!(first.snapshot.history.messages.len(), 4);
    assert_eq!(first.snapshot.history.content_revision, 4);

    let repeated = store
        .append_message_idempotent(&id, &reply, AT, None)
        .unwrap();
    assert!(repeated.already_committed);
    assert_eq!(repeated.snapshot.history.messages.len(), 4);

    assert_eq!(
        store
            .append_message_idempotent(&id, &dup_failed, AT, None)
            .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(
        store
            .commit_message(&first.snapshot, &dup_failed, AT, None)
            .unwrap_err(),
        StoreError::VersionChanged
    );
    assert_eq!(snapshot(&store, &id).history.messages.len(), 4);

    let extra = json!({"id": "extra-1", "role": "user", "content": "lagging index row"});
    let mut existing_body = fs::read_to_string(&body_path).unwrap();
    existing_body.push_str(&format!("{extra}\n"));
    fs::write(&body_path, existing_body).unwrap();

    let reconciled = store.reconcile_index(&id, AT, None).unwrap();
    assert_eq!(reconciled.history.messages.len(), 5);

    let streamed = store
        .patch_stream_message(
            &reconciled,
            "answer",
            &json!({"content": "partial"}),
            AT,
            None,
        )
        .unwrap();
    let done = store
        .commit_terminal_message(&streamed, "answer", &json!({"content": "final"}), AT, None)
        .unwrap();
    assert_eq!(done.snapshot.history.messages[2]["content"], "final");

    assert_eq!(
        store
            .patch_stream_message(
                &done.snapshot,
                "card:verdict:s-1",
                &json!({"content": "ambiguous"}),
                AT,
                None,
            )
            .unwrap_err(),
        StoreError::HistoryCorrupt
    );
    assert_eq!(
        store
            .commit_terminal_message(
                &done.snapshot,
                "card:verdict:s-1",
                &json!({"content": "ambiguous"}),
                AT,
                None,
            )
            .unwrap_err(),
        StoreError::HistoryCorrupt
    );
}

#[test]
fn update_workspace_path_updates_index_without_bumping_updated_at_or_losing_history() {
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    let created = store
        .create_classic_conversation(&json!({
            "title": "Bot Conv",
            "workspacePath": "/tmp/old-folder",
            "role": "project_agent",
            "workspaceId": "ws-rebind-1",
        }))
        .unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    let original_updated_at = created["updatedAt"].as_str().unwrap().to_owned();
    let reply = json!({ "id": "msg-1", "role": "user", "content": "hello" });
    store
        .append_message_idempotent(&id, &reply, AT, None)
        .unwrap();
    let before = store.read_metadata(&id).unwrap().metadata.unwrap();
    let before_updated_at = before["updatedAt"].as_str().unwrap().to_owned();
    assert!(!original_updated_at.is_empty());

    let updated = store
        .update_workspace_path(&id, "  /tmp/new-folder/ ")
        .unwrap()
        .unwrap();
    assert_eq!(updated["workspacePath"], "/tmp/new-folder/");
    assert_eq!(updated["updatedAt"], before_updated_at);

    let after_meta = store.read_metadata(&id).unwrap().metadata.unwrap();
    assert_eq!(after_meta["workspacePath"], "/tmp/new-folder/");
    assert_eq!(after_meta["updatedAt"], before_updated_at);
    let after = store.read_committed(&id, None, 1024 * 1024).unwrap();
    assert_eq!(after.history.messages.len(), 1);
    assert_eq!(after.history.messages[0]["id"], "msg-1");

    assert_eq!(
        store
            .update_workspace_path("missing-id", "/tmp/new-folder")
            .unwrap(),
        None
    );
    assert_eq!(
        store.update_workspace_path(&id, "   ").unwrap_err(),
        StoreError::InvalidInput
    );
}
