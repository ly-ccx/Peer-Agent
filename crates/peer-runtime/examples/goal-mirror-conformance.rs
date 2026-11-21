//! Explicit synthetic storage/Host fixture, never a production capability.
use peer_runtime::goal_facts::TuiGoalProjector;
use peer_store::{
    AcquireLease, GoalExecutionFact, GoalStore, HostIdentity, HostLeaseStore, HostSurface,
};
use serde_json::json;
use std::{
    io::{self, Read, Write},
    path::PathBuf,
};
fn main() {
    let root =
        PathBuf::from(std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    let mut input = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut input).unwrap();
    assert!(input.len() <= 1_048_576);
    let v = peer_protocol::decode_json_bounded(
        &input,
        peer_protocol::JsonLimits {
            bytes: 1_048_576,
            nodes: 16384,
            depth: 64,
            string_bytes: 1_048_576,
        },
    )
    .unwrap()
    .value;
    let host = HostIdentity::new(
        "native-goal-mirror-fixture",
        HostSurface::Tui,
        std::process::id(),
        "fixture",
    )
    .unwrap();
    let AcquireLease::Acquired { token, .. } = HostLeaseStore::new(&root)
        .acquire("w", &host, 1_794_628_800_000)
        .unwrap()
    else {
        println!("{}", json!({"ok":false,"code":"fixture_lease_held"}));
        return;
    };
    let store = GoalStore::new(&root);
    let now = v["now"].as_str().unwrap_or("2026-11-14T04:00:00.000Z");
    let projector = TuiGoalProjector::new(now).unwrap();
    let result = (|| -> Result<serde_json::Value, peer_store::GoalError> {
        let before = store.read("p", &projector, None)?;
        let expected = v["expectedSourceRevision"]
            .as_str()
            .unwrap_or(&before.source_revision);
        let transaction =
            store.prepare_execution_mirror(&token, "p", expected, &projector, None)?;
        if let Some(ms) = v["holdMs"].as_u64() {
            assert!(ms <= 3000);
            println!("{}", json!({"phase":"locked"}));
            io::stdout().flush().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(ms));
            drop(transaction);
            return Ok(json!({"ok":true}));
        }
        let fact = if v["field"] == "closure" {
            GoalExecutionFact::ClaimClosure(&v["fact"])
        } else {
            GoalExecutionFact::SessionControl(&v["fact"])
        };
        let result = if v["interrupt"] == true {
            transaction.commit_before_index_fixture(fact, now)
        } else {
            transaction.commit(fact, now, None)
        }?;
        let snapshot = store.read("p", &projector, None)?;
        Ok(
            json!({"ok":true,"changed":result.changed,"sourceRevision":result.source_revision,"facts":snapshot.facts}),
        )
    })();
    token.release().unwrap();
    println!(
        "{}",
        result.unwrap_or_else(|e| json!({"ok":false,"code":e.code()}))
    );
}
