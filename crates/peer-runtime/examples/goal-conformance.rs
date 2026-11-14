//! Explicit synthetic fixture only; no default data root, execution or secrets.
use peer_runtime::goal_facts::TuiGoalProjector;
use peer_store::GoalStore;
use serde_json::json;
use std::{
    io::{self, Read},
    path::PathBuf,
};
fn main() {
    let root =
        PathBuf::from(std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    let mut input = Vec::new();
    io::stdin().take(65537).read_to_end(&mut input).unwrap();
    assert!(input.len() <= 65536);
    let v = peer_protocol::decode_json_bounded(
        &input,
        peer_protocol::JsonLimits {
            bytes: 65536,
            nodes: 8192,
            depth: 32,
            string_bytes: 65536,
        },
    )
    .unwrap()
    .value;
    let p = TuiGoalProjector::new(v["now"].as_str().unwrap_or("2026-11-14T04:00:00.000Z")).unwrap();
    let store = GoalStore::new(&root);
    if let Some(conversation) = v["conversation"].as_str() {
        let result = store.active_by_conversation(conversation, &p, None);
        println!(
            "{}",
            match result {
                Ok(s) =>
                    json!({"ok":true,"facts":s.snapshot.map(|s|s.facts),"sourceRevision":s.source_revision}),
                Err(e) => json!({"ok":false,"code":e.code()}),
            }
        );
        return;
    }
    let result = store.read(v["id"].as_str().unwrap_or("p"), &p, None);
    println!(
        "{}",
        match result {
            Ok(s) =>
                json!({"ok":true,"facts":s.facts,"sourceRevision":s.source_revision,"sourceBytes":s.source_bytes}),
            Err(e) => json!({"ok":false,"code":e.code()}),
        }
    );
}
