//! Synthetic resource probe only; not a production CLI entry.
use peer_store::{TranscriptLimits, TranscriptReader};
use serde_json::json;
use std::{
    env,
    path::PathBuf,
    time::{Duration, Instant},
};
fn main() {
    let root = PathBuf::from(env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file(), "fixture marker");
    let started = Instant::now();
    let page = TranscriptReader::new(&root)
        .read_page("p", None, TranscriptLimits::default(), None)
        .expect("bounded raw page");
    println!(
        "{}",
        json!({
            "ok":true,
            "sourceBytes":std::fs::metadata(root.join("conversations/p.jsonl")).expect("source identity").len(),
            "rows":page.rows.len(),"scannedBytes":page.scanned_bytes,
            "hasOlder":page.older.is_some(),"requiresRuntimeCheck":page.requires_runtime_check,
            "elapsedMs":started.elapsed().as_millis()
        })
    );
    // Keep the actual decoded page resident long enough for the external sampler.
    std::thread::sleep(Duration::from_millis(300));
    std::hint::black_box(page);
}
