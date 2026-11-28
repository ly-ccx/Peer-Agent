//! Owned cross-process fixture, never loaded by the production CLI.
use peer_protocol::RuntimeTurnUsage;
use peer_store::{ConversationStore, StoreError};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    time::Duration,
};
fn main() {
    let mut text = String::new();
    io::stdin()
        .take(1024 * 1024)
        .read_to_string(&mut text)
        .unwrap();
    let v: Value = serde_json::from_str(&text).unwrap();
    let root = PathBuf::from(v["root"].as_str().unwrap());
    let result = (|| -> Result<Value, StoreError> {
        if v["op"] == "hold" {
            let file = root.join("usage/requests.jsonl");
            let lock = peer_store::DirectoryLock::acquire(&file, Duration::from_millis(100), None)?;
            println!("{}", json!({"phase":"locked"}));
            io::stdout().flush().unwrap();
            std::thread::sleep(Duration::from_millis(500));
            lock.release()?;
            return Ok(Value::Null);
        }
        let usage: RuntimeTurnUsage = serde_json::from_value(v["input"]["usage"].clone())
            .map_err(|_| StoreError::UsageInvalid)?;
        Ok(ConversationStore::new(root)
            .record_runtime_turn_usage(
                v["id"].as_str().unwrap(),
                &usage,
                &v["input"]["attribution"],
                None,
            )?
            .unwrap_or(Value::Null))
    })();
    println!(
        "{}",
        match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(e) => json!({"ok":false,"code":e.code()}),
        }
    );
}
