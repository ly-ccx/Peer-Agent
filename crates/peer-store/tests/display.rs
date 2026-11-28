use peer_store::{ConversationStore, DisplayEvent, DisplayReadError, StoreError};
use serde_json::{Value, json};
use std::{
    fs,
    io::Write,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
fn setup(root: &Path, body: &str, patch: Option<Value>) {
    fs::create_dir_all(root.join("conversations")).unwrap();
    fs::write(
        root.join("conversations/index.jsonl"),
        "{\"id\":\"a\",\"title\":\"first\",\"contentRevision\":1}\n",
    )
    .unwrap();
    fs::write(root.join("conversations/a.jsonl"), body).unwrap();
    if let Some(patch) = patch {
        fs::write(root.join("conversations/a.stream.json"), patch.to_string()).unwrap();
    }
}
fn marker(patch: Value) -> Value {
    json!({"version":1,"conversationId":"a","messageId":"m","patch":patch})
}
#[test]
fn display_patch_is_separate_from_canonical_history_and_does_not_clone_unknown_fields() {
    for patch in [
        json!({"content":"stream text"}),
        json!({"role":"user"}),
        json!({"content":null}),
        json!({"role":"tool"}),
    ] {
        let root = tempfile::tempdir().unwrap();
        let body = "{\"id\":\"m\",\"role\":\"assistant\",\"content\":\"old text\",\"secretUnknown\":\"not selected\"}\n";
        setup(root.path(), body, Some(marker(patch.clone())));
        let store = ConversationStore::new(root.path());
        let mut rows = vec![];
        let snapshot = store
            .visit_display("a", None, |row| {
                if let DisplayEvent::Message(v) = row {
                    rows.push(v.clone());
                }
                Ok(())
            })
            .unwrap();
        assert!(snapshot.has_provisional);
        snapshot.validate().unwrap();
        if patch["role"] == "tool" {
            assert!(rows.is_empty());
        } else {
            assert_eq!(
                rows,
                vec![
                    json!({"role":patch.get("role").unwrap_or(&json!("assistant")),"content":patch.get("content").unwrap_or(&json!("old text"))})
                ]
            );
        }
        assert!(
            store
                .read_committed("a", None, 8192)
                .unwrap()
                .history
                .messages
                .is_empty()
        );
        assert_eq!(
            fs::read_to_string(root.path().join("conversations/a.jsonl")).unwrap(),
            body
        );
    }
}
#[test]
fn source_changes_cancellation_corruption_and_orphan_streams_never_return_a_snapshot() {
    for change in ["index", "history", "stream", "cancel"] {
        let root = tempfile::tempdir().unwrap();
        setup(
            root.path(),
            "{\"id\":\"m\",\"role\":\"assistant\",\"content\":\"old text\"}\n",
            Some(marker(json!({"content":"stream text"}))),
        );
        let cancel = AtomicBool::new(false);
        let store = ConversationStore::new(root.path());
        let result = store.visit_display("a", Some(&cancel), |event| {
            if matches!(event, DisplayEvent::Metadata(_)) {
                match change {
                    "index" => {
                        let p = root.path().join("conversations/index.jsonl");
                        let text = fs::read_to_string(&p).unwrap().replace("first", "other");
                        fs::write(p, text).unwrap();
                    }
                    "history" => {
                        let p = root.path().join("conversations/a.jsonl");
                        let text = fs::read_to_string(&p)
                            .unwrap()
                            .replace("old text", "new text");
                        fs::write(p, text).unwrap();
                    }
                    "stream" => {
                        fs::write(
                            root.path().join("conversations/a.stream.json"),
                            marker(json!({"content":"changed txt"})).to_string(),
                        )
                        .unwrap();
                    }
                    _ => cancel.store(true, Ordering::Release),
                }
            }
            Ok(())
        });
        assert!(
            matches!(
                result,
                Err(DisplayReadError::Source(
                    StoreError::VersionChanged | StoreError::Cancelled
                ))
            ),
            "{change}"
        );
    }
    let root = tempfile::tempdir().unwrap();
    let store = ConversationStore::new(root.path());
    for body in [
        b"{\"role\":\"assistant\"}".as_slice(),
        b"{broken}\n",
        b"{\"role\":\"tool\",\"content\":\"\xff\"}\n",
    ] {
        setup(root.path(), "", None);
        fs::write(root.path().join("conversations/a.jsonl"), body).unwrap();
        assert!(matches!(
            store.visit_display("a", None, |_| Ok(())),
            Err(DisplayReadError::Source(StoreError::HistoryCorrupt))
        ));
    }
    for patch in [
        json!({"version":99}),
        marker(json!({"content":"late"})),
        json!({"version":1,"conversationId":"foreign","messageId":"m","patch":{}}),
    ] {
        setup(
            root.path(),
            "{\"id\":\"another\",\"role\":\"assistant\",\"content\":\"text\"}\n",
            Some(patch),
        );
        assert!(matches!(
            store.visit_display("a", None, |_| Ok(())),
            Err(DisplayReadError::Source(
                StoreError::StreamStateInvalid | StoreError::StreamTargetMissing
            ))
        ));
    }
}
fn repeat_record(path: &Path, role: &str, count: usize) {
    let mut f = fs::File::create(path).unwrap();
    write!(f, "{{\"id\":\"m\",\"role\":\"{role}\",\"content\":\"").unwrap();
    let chunk = vec![b'x'; 65536];
    let mut left = count;
    while left > 0 {
        let n = left.min(chunk.len());
        f.write_all(&chunk[..n]).unwrap();
        left -= n;
    }
    f.write_all(b"\"}\n").unwrap();
}
#[test]
fn appended_history_is_not_visited_beyond_the_captured_snapshot() {
    let root = tempfile::tempdir().unwrap();
    setup(
        root.path(),
        "{\"id\":\"m\",\"role\":\"assistant\",\"content\":\"original\"}\n",
        None,
    );
    let path = root.path().join("conversations/a.jsonl");
    let mut seen = 0;
    let result = ConversationStore::new(root.path()).visit_display("a", None, |event| {
        if matches!(event, DisplayEvent::Message(_)) {
            seen += 1;
            let mut writer = fs::OpenOptions::new().append(true).open(&path)?;
            writer.write_all(b"{\"role\":\"assistant\",\"content\":\"appended\"}\n")?;
        }
        Ok(())
    });
    assert_eq!(seen, 1, "a growing source must not extend the read horizon");
    assert!(matches!(
        result,
        Err(DisplayReadError::Source(StoreError::VersionChanged))
    ));
    assert!(fs::read_to_string(path).unwrap().contains("appended"));
}
#[test]
fn large_tool_fields_are_skipped_ten_mib_visible_text_fits_and_selected_overflow_is_explicit() {
    let root = tempfile::tempdir().unwrap();
    setup(root.path(), "", None);
    let path = root.path().join("conversations/a.jsonl");
    let store = ConversationStore::new(root.path());
    repeat_record(&path, "tool", 16 * 1024 * 1024);
    let mut rows = 0;
    store
        .visit_display("a", None, |v| {
            if matches!(v, DisplayEvent::Message(_)) {
                rows += 1;
            }
            Ok(())
        })
        .unwrap();
    assert_eq!(rows, 0);
    repeat_record(&path, "assistant", 10 * 1024 * 1024);
    store
        .visit_display("a", None, |v| {
            if let DisplayEvent::Message(v) = v {
                assert_eq!(v["content"].as_str().unwrap().len(), 10 * 1024 * 1024);
            }
            Ok(())
        })
        .unwrap();
    repeat_record(&path, "assistant", 13 * 1024 * 1024);
    let before = fs::metadata(&path).unwrap().len();
    assert!(matches!(
        store.visit_display("a", None, |_| Ok(())),
        Err(DisplayReadError::Source(StoreError::HistoryLimit))
    ));
    assert_eq!(fs::metadata(path).unwrap().len(), before);
}
