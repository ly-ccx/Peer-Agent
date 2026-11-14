//! Isolated memory probe; raw source projection only, not a Goal executor.
use peer_store::GoalSourceStore;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").ok_or("fixture root required")?,
    );
    if !root.join(".native-cli-fixture").is_file() {
        return Err("fixture marker required".into());
    }
    let began = Instant::now();
    let source = GoalSourceStore::new(root).read_raw_fields("p", 256 * 1024 * 1024, None)?;
    println!(
        "{}",
        serde_json::json!({"ok":true,"sourceBytes":source.source_bytes,"selectedBytes":serde_json::to_vec(&source.raw_plan)?.len(),"requiresRuntimeCheck":source.requires_runtime_check,"elapsedMs":began.elapsed().as_millis()})
    );
    std::thread::sleep(Duration::from_millis(300));
    Ok(())
}
