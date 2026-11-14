use peer_protocol::{JsonLimits, ProjectionError, ProjectionLimits, project_json_reader};
use serde_json::json;
use std::{
    io::{self, Read},
    sync::atomic::AtomicBool,
};

fn limits() -> ProjectionLimits {
    ProjectionLimits {
        source_bytes: 128 * 1024 * 1024,
        selected: JsonLimits {
            bytes: 8192,
            nodes: 64,
            depth: 8,
            string_bytes: 8192,
        },
        key_bytes: 256,
    }
}
#[test]
fn huge_skipped_string_and_large_skipped_array_do_not_become_values() {
    let prefix = io::Cursor::new(br#"{"id":"first","trace":""#);
    let source = prefix
        .chain(io::repeat(b'x').take(16 * 1024 * 1024))
        .chain(io::Cursor::new(br#"","id":"last","status":"paused"}"#));
    let result = project_json_reader(source, &["id", "status"], limits(), None).unwrap();
    assert_eq!(result.value, json!({"id":"last","status":"paused"}));
    assert_eq!(result.nodes, 4);
    assert!(result.string_bytes < 100);
    assert!(result.source_bytes > 16 * 1024 * 1024);
    let items = io::repeat(b'0').take(1); // Build many values without an equivalent in-memory Vec.
    let source = io::Cursor::new(br#"{"ignored":["#)
        .chain(items)
        .chain(io::Cursor::new(",0".repeat(65_536)))
        .chain(io::Cursor::new(br#"],"id":"kept"}"#));
    assert_eq!(
        project_json_reader(source, &["id"], limits(), None)
            .unwrap()
            .value,
        json!({"id":"kept"})
    );
}
#[test]
fn root_key_selected_wire_nodes_strings_and_ignored_depth_are_bounded() {
    let cases = [
        format!("{{\"{}\":0}}", "x".repeat(4096)),
        format!("{{\"id\":\"{}\"}}", "x".repeat(8193)),
        format!("{{\"ignored\":{}0{}}}", "[".repeat(1000), "]".repeat(1000)),
    ];
    for body in cases {
        assert!(matches!(
            project_json_reader(body.as_bytes(), &["id"], limits(), None),
            Err(ProjectionError::LimitExceeded)
        ));
    }
    let body = format!("{{\"id\":[{}0]}}", "0,".repeat(64));
    assert!(matches!(
        project_json_reader(body.as_bytes(), &["id"], limits(), None),
        Err(ProjectionError::LimitExceeded)
    ));
    let mut small = limits();
    small.selected.string_bytes = 1;
    assert!(matches!(
        project_json_reader(br#"{"id":"abc"}"#.as_slice(), &["id"], small, None),
        Err(ProjectionError::LimitExceeded)
    ));
    let mut small = limits();
    small.source_bytes = 8;
    assert!(matches!(
        project_json_reader(br#"{"ignored":"long"}"#.as_slice(), &[], small, None),
        Err(ProjectionError::LimitExceeded)
    ));
}
#[test]
fn skipped_syntax_utf8_and_io_errors_never_produce_partial_facts() {
    for body in [
        br#"{"id":"visible","ignored":"\q"}"#.as_slice(),
        b"{\"id\":\"visible\",\"ignored\":\"\xff\"}".as_slice(),
        b"{\"ignored\":\"\xed\xa0\x80\"}".as_slice(),
        br#"{"ignored":[1,]}"#.as_slice(),
        br#"{"id":"visible"} trailing"#.as_slice(),
    ] {
        assert!(
            matches!(
                project_json_reader(body, &["id"], limits(), None),
                Err(ProjectionError::InvalidJson)
            ),
            "{body:?}"
        );
    }
    struct Failed;
    impl Read for Failed {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::other("fixture failure"))
        }
    }
    assert!(matches!(
        project_json_reader(Failed, &["id"], limits(), None),
        Err(ProjectionError::ReadFailed)
    ));
    assert!(matches!(
        project_json_reader(
            br#"{}"#.as_slice(),
            &[],
            limits(),
            Some(&AtomicBool::new(true))
        ),
        Err(ProjectionError::Cancelled)
    ));
}
#[test]
fn valid_utf8_escapes_and_string_delimiters_do_not_confuse_the_reader_gate() {
    let body = br#"{"ignored":"{[\"\\]}","id":"\u4e2d\u6587\ud83d\ude00","future":{"x":true}}"#;
    let mut exact = limits();
    exact.source_bytes = body.len() as u64;
    assert_eq!(
        project_json_reader(body.as_slice(), &["id"], exact, None)
            .unwrap()
            .value,
        json!({"id":"中文😀"})
    );
    let body = "{\"ignored\":\"中文😀\",\"id\":\"已读\"}";
    assert_eq!(
        project_json_reader(body.as_bytes(), &["id"], limits(), None)
            .unwrap()
            .value,
        json!({"id":"已读"})
    );
}

#[test]
fn cancellation_during_a_skipped_value_returns_no_partial_projection() {
    use std::sync::atomic::Ordering;
    struct Cancellable<'a> {
        bytes: u64,
        cancel: &'a AtomicBool,
    }
    impl Read for Cancellable<'_> {
        fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
            out.fill(b'x');
            self.bytes += out.len() as u64;
            if self.bytes > 65_536 {
                self.cancel.store(true, Ordering::Release);
            }
            Ok(out.len())
        }
    }
    let cancel = AtomicBool::new(false);
    let source = io::Cursor::new(br#"{"id":"visible","ignored":""#).chain(Cancellable {
        bytes: 0,
        cancel: &cancel,
    });
    assert!(matches!(
        project_json_reader(source, &["id"], limits(), Some(&cancel)),
        Err(ProjectionError::Cancelled)
    ));
}
