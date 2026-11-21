use peer_protocol::{JsonLimits, TranscriptCursor, TranscriptRow};
use peer_store::{
    StoreError, TranscriptError, TranscriptLimit, TranscriptLimits, TranscriptReader,
};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    sync::atomic::AtomicBool,
};
use tempfile::TempDir;

fn fixture(bytes: &[u8]) -> (TempDir, TranscriptReader) {
    let root = TempDir::new().unwrap();
    fs::create_dir(root.path().join("conversations")).unwrap();
    fs::write(root.path().join("conversations/c.jsonl"), bytes).unwrap();
    let reader = TranscriptReader::new(root.path());
    (root, reader)
}
fn values(rows: &[TranscriptRow]) -> Vec<Value> {
    rows.iter()
        .filter_map(|row| match row {
            TranscriptRow::Message { raw, .. } => Some(raw.clone()),
            TranscriptRow::InvalidJson { .. } => None,
        })
        .collect()
}

#[test]
fn unicode_cross_chunk_pages_keep_unknown_fields_and_stable_byte_anchors() {
    let large = json!({"id":"large","content":"测👩‍💻".repeat(8000),"future":{"a":[1,2]}});
    let source = format!(
        "{}\n{large}\n{}\n",
        json!({"id":"old"}),
        json!({"id":"new"})
    );
    let (root, reader) = fixture(source.as_bytes());
    // A display page does not merge or vouch for an unrelated stream patch.
    fs::write(
        root.path().join("conversations/c.stream.json"),
        b"untrusted malformed sidecar",
    )
    .unwrap();
    let limits = TranscriptLimits {
        records: 2,
        ..Default::default()
    };
    let page = reader.read_page("c", None, limits, None).unwrap();
    assert_eq!(values(&page.rows), vec![large, json!({"id":"new"})]);
    assert!(page.requires_runtime_check);
    assert_eq!(page.older.as_ref().unwrap().before_byte, 13);
    let older = reader
        .read_page("c", page.older.as_ref(), limits, None)
        .unwrap();
    assert_eq!(values(&older.rows), vec![json!({"id":"old"})]);
    assert!(older.older.is_none());
    assert_eq!(older.source_revision, page.source_revision);
    assert_eq!(
        fs::read(root.path().join("conversations/c.jsonl")).unwrap(),
        source.as_bytes()
    );
}

#[test]
fn corrupt_and_invalid_utf8_rows_remain_explicit_and_blank_prefix_terminates() {
    let source = b"\n{\"id\":\"a\"}\n{bad}\n{\"id\":\"\xff\"}\n\n";
    let (_root, reader) = fixture(source);
    let page = reader
        .read_page("c", None, TranscriptLimits::default(), None)
        .unwrap();
    assert_eq!(page.rows.len(), 3);
    for row in &page.rows[1..] {
        let TranscriptRow::InvalidJson { range } = row else {
            panic!("corruption was hidden")
        };
        assert!(!source[range.start as usize..range.end as usize].is_empty());
    }
    let older = reader
        .read_page("c", page.older.as_ref(), TranscriptLimits::default(), None)
        .unwrap();
    assert!(older.rows.is_empty());
    assert!(older.older.is_none());
}

#[test]
fn tail_cost_is_independent_of_large_prefix_and_no_writes_occur() {
    let (root, reader) = fixture(b"");
    let path = root.path().join("conversations/c.jsonl");
    let mut file = File::create(&path).unwrap();
    for _ in 0..100_000 {
        file.write_all(b"{\"content\":\"an older row retained on disk\"}\n")
            .unwrap();
    }
    file.write_all(b"{\"id\":\"tail\"}").unwrap();
    drop(file);
    let before = fs::metadata(&path).unwrap();
    let page = reader
        .read_page(
            "c",
            None,
            TranscriptLimits {
                records: 1,
                ..Default::default()
            },
            None,
        )
        .unwrap();
    assert_eq!(values(&page.rows), vec![json!({"id":"tail"})]);
    assert!(page.scanned_bytes <= 16 * 1024);
    assert_eq!(page.older.unwrap().before_byte, before.len() - 13);
    let after = fs::metadata(path).unwrap();
    assert_eq!(after.len(), before.len());
    assert_eq!(after.modified().unwrap(), before.modified().unwrap());
}

#[test]
fn budgets_fail_with_source_range_instead_of_a_partial_success() {
    let source = format!("{}\n", json!({"content":"x".repeat(100_000)}));
    let (_root, reader) = fixture(source.as_bytes());
    assert!(
        matches!(reader.read_page("c",None,TranscriptLimits{record_bytes:1024,..Default::default()},None),
        Err(TranscriptError::LimitExceeded{kind:TranscriptLimit::RecordBytes,line_end,scanned_from}) if line_end==source.len() as u64-1 && scanned_from<line_end)
    );
    let (_root, reader) = fixture(b"\n\n\n\n\n\n");
    let limits = TranscriptLimits {
        scan_bytes: 4,
        record_bytes: 4,
        ..Default::default()
    };
    assert!(matches!(
        reader.read_page("c", None, limits, None),
        Err(TranscriptError::LimitExceeded {
            kind: TranscriptLimit::ScanBytes,
            ..
        })
    ));
    let (_root, reader) = fixture(b"{\"a\":\"one\"}\n{\"a\":\"two\"}\n");
    for json in [
        JsonLimits {
            bytes: 20,
            nodes: 100,
            depth: 64,
            string_bytes: 100,
        },
        JsonLimits {
            bytes: 100,
            nodes: 3,
            depth: 64,
            string_bytes: 100,
        },
        JsonLimits {
            bytes: 100,
            nodes: 100,
            depth: 64,
            string_bytes: 6,
        },
    ] {
        assert!(matches!(
            reader.read_page(
                "c",
                None,
                TranscriptLimits {
                    json,
                    ..Default::default()
                },
                None
            ),
            Err(TranscriptError::LimitExceeded {
                kind: TranscriptLimit::DecodedPage,
                ..
            })
        ));
    }
}

#[test]
fn changed_source_cross_conversation_and_mid_record_cursors_are_rejected() {
    let (root, reader) = fixture(b"{\"id\":\"a\"}\n{\"id\":\"b\"}\n");
    let limits = TranscriptLimits {
        records: 1,
        ..Default::default()
    };
    let page = reader.read_page("c", None, limits, None).unwrap();
    let cursor = page.older.unwrap();
    for bad in [
        TranscriptCursor {
            conversation_id: "other".into(),
            ..cursor.clone()
        },
        TranscriptCursor {
            before_byte: 1,
            ..cursor.clone()
        },
        TranscriptCursor {
            before_byte: 0,
            ..cursor.clone()
        },
    ] {
        assert_eq!(
            reader.read_page("c", Some(&bad), limits, None).unwrap_err(),
            TranscriptError::InvalidCursor
        );
    }
    let path = root.path().join("conversations/c.jsonl");
    let mut file = OpenOptions::new().append(true).open(&path).unwrap();
    file.write_all(b"{}\n").unwrap();
    drop(file);
    assert_eq!(
        reader
            .read_page("c", Some(&cursor), limits, None)
            .unwrap_err(),
        TranscriptError::Store(StoreError::VersionChanged)
    );
    // A truncation must be reported stale even if the old offset is now beyond EOF.
    fs::write(path, b"{}").unwrap();
    assert_eq!(
        reader
            .read_page("c", Some(&cursor), limits, None)
            .unwrap_err(),
        TranscriptError::Store(StoreError::VersionChanged)
    );
}

#[test]
fn cancellation_invalid_limits_paths_and_symlinks_do_not_change_source() {
    let (root, reader) = fixture(b"{\"id\":\"a\"}\n");
    assert_eq!(
        reader
            .read_page(
                "c",
                None,
                TranscriptLimits::default(),
                Some(&AtomicBool::new(true))
            )
            .unwrap_err(),
        TranscriptError::Store(StoreError::Cancelled)
    );
    for limits in [
        TranscriptLimits {
            records: 0,
            ..Default::default()
        },
        TranscriptLimits {
            records: 257,
            ..Default::default()
        },
        TranscriptLimits {
            scan_bytes: 1,
            record_bytes: 2,
            ..Default::default()
        },
    ] {
        assert_eq!(
            reader.read_page("c", None, limits, None).unwrap_err(),
            TranscriptError::Store(StoreError::InvalidInput)
        );
    }
    assert_eq!(
        reader
            .read_page("../escape", None, TranscriptLimits::default(), None)
            .unwrap_err(),
        TranscriptError::Store(StoreError::InvalidInput)
    );
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            root.path().join("conversations/c.jsonl"),
            root.path().join("conversations/link.jsonl"),
        )
        .unwrap();
        assert_eq!(
            reader
                .read_page("link", None, TranscriptLimits::default(), None)
                .unwrap_err(),
            TranscriptError::Store(StoreError::ReadFailed)
        );
    }
    assert_eq!(
        fs::read(root.path().join("conversations/c.jsonl")).unwrap(),
        b"{\"id\":\"a\"}\n"
    );
}
