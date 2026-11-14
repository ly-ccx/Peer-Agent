use peer_protocol::{
    JsonLimits, JsonSelection as S, ProjectionError, ProjectionLimits, project_json_selected_reader,
};
use serde_json::json;
use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};
static TASK: S<'static> = S::Object(&[("status", S::Full), ("subtasks", S::Each(&TASK))]);
static TASKS: S<'static> = S::Each(&TASK);
static ROOT: S<'static> = S::Object(&[
    ("planId", S::Full),
    ("tasks", S::Each(&TASK)),
    (
        "runner",
        S::Object(&[("status", S::Full), ("interruption", S::Full)]),
    ),
]);
fn limits() -> ProjectionLimits {
    ProjectionLimits {
        source_bytes: 32 * 1024 * 1024,
        selected: JsonLimits {
            bytes: 8192,
            nodes: 256,
            depth: 64,
            string_bytes: 8192,
        },
        key_bytes: 512,
    }
}
#[test]
fn recursive_task_projection_skips_body_and_checkpoint_in_one_pass() {
    let raw = json!({"planId":"p","tasks":[{"status":"running","description":"x".repeat(4*1024*1024),"subtasks":[{"status":"completed","result":"y".repeat(4*1024*1024)}]}],"runner":{"status":"paused","contextCheckpoint":{"payload":"z".repeat(4*1024*1024)}}});
    let bytes = serde_json::to_vec(&raw).unwrap();
    let p = project_json_selected_reader(bytes.as_slice(), &ROOT, limits(), None).unwrap();
    assert_eq!(
        p.value,
        json!({"planId":"p","tasks":[{"status":"running","subtasks":[{"status":"completed"}]}],"runner":{"status":"paused"}})
    );
    assert_eq!(p.source_bytes, bytes.len() as u64);
    assert!(p.string_bytes < 256);
}
#[test]
fn null_duplicate_and_byte_node_key_limits_are_explicit() {
    let p = project_json_selected_reader(
        br#"{"tasks":null,"runner":null,"planId":"old","planId":"p"}"#.as_slice(),
        &ROOT,
        limits(),
        None,
    )
    .unwrap();
    assert_eq!(p.value, json!({"tasks":null,"runner":null,"planId":"p"}));
    let body = json!({"tasks":[{"status":"x".repeat(20000)}]});
    assert!(matches!(
        project_json_selected_reader(
            serde_json::to_vec(&body).unwrap().as_slice(),
            &ROOT,
            limits(),
            None
        ),
        Err(ProjectionError::LimitExceeded)
    ));
    let raw = json!({"tasks":(0..300).map(|_|json!({"status":"running"})).collect::<Vec<_>>()});
    assert!(matches!(
        project_json_selected_reader(
            serde_json::to_vec(&raw).unwrap().as_slice(),
            &ROOT,
            limits(),
            None
        ),
        Err(ProjectionError::LimitExceeded)
    ));
    let raw = format!("{{\"tasks\":[{{\"{}\":0}}]}}", "k".repeat(1000));
    assert!(matches!(
        project_json_selected_reader(raw.as_bytes(), &ROOT, limits(), None),
        Err(ProjectionError::LimitExceeded)
    ));
    assert!(matches!(
        project_json_selected_reader(b"null".as_slice(), &ROOT, limits(), None),
        Err(ProjectionError::InvalidJson)
    ));
    let root = S::Object(&[("tasks", S::Each(&TASKS))]);
    assert!(
        project_json_selected_reader(
            br#"{"tasks":[[{"status":"running"}]]}"#.as_slice(),
            &root,
            limits(),
            None
        )
        .is_ok()
    );
}
#[test]
fn ignored_syntax_and_wrong_container_type_never_return_partial_facts() {
    for bytes in [
        b"{\"planId\":\"p\",\"ignored\": [1,]}".as_slice(),
        b"{\"planId\":\"p\",\"ignored\":\"\xff\"}",
        b"{\"tasks\":true}",
    ] {
        assert!(matches!(
            project_json_selected_reader(bytes, &ROOT, limits(), None),
            Err(ProjectionError::InvalidJson)
        ));
    }
    let malformed = json!({"tasks":"x".repeat(40000)});
    assert!(
        project_json_selected_reader(
            serde_json::to_vec(&malformed).unwrap().as_slice(),
            &ROOT,
            limits(),
            None
        )
        .is_err()
    );
}
struct Cancel<'a> {
    data: &'a [u8],
    flag: &'a AtomicBool,
    read: usize,
}
impl Read for Cancel<'_> {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        let n = self.data.read(out)?;
        self.read += n;
        if self.read > 100000 {
            self.flag.store(true, Ordering::Release)
        }
        Ok(n)
    }
}
#[test]
fn cancellation_during_nested_skipped_content_returns_no_view() {
    let raw = json!({"tasks":[{"status":"running","body":"x".repeat(2*1024*1024)}]});
    let bytes = serde_json::to_vec(&raw).unwrap();
    let flag = AtomicBool::new(false);
    let reader = Cancel {
        data: &bytes,
        flag: &flag,
        read: 0,
    };
    assert!(matches!(
        project_json_selected_reader(reader, &ROOT, limits(), Some(&flag)),
        Err(ProjectionError::Cancelled)
    ));
}
