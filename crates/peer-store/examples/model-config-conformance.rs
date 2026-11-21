use peer_store::ModelConfigStore;
use serde_json::json;
use std::{path::PathBuf, time::Duration};
fn main() {
    let mut args = std::env::args().skip(1);
    let home = PathBuf::from(args.next().expect("isolated home"));
    let store = ModelConfigStore::new(home);
    match args.next().as_deref() {
        Some("increment") => {
            let count: usize = args.next().unwrap().parse().unwrap();
            for _ in 0..count {
                let tx = store.begin(Duration::from_secs(5), None).unwrap();
                let revision = tx.snapshot().source_revision.clone();
                let mut value = tx.snapshot().value.clone();
                value["nativeCounter"] = json!(value["nativeCounter"].as_u64().unwrap_or(0) + 1);
                std::thread::sleep(Duration::from_millis(2));
                tx.commit(&revision, &value, None).unwrap();
            }
        }
        Some("read") => (),
        _ => panic!("unknown conformance operation"),
    }
    let result = store.read().unwrap();
    println!(
        "{}",
        json!({"revision":result.source_revision,"value":result.value})
    );
}
