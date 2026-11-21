//! Isolated development Store bridge. Not a product command or execution port.
use peer_store::{ConversationStore, DirectoryLock};
use serde_json::{Value, json};
use std::{
    io::{self, Read, Write},
    path::PathBuf,
    sync::atomic::AtomicBool,
    time::Duration,
};
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").ok_or("fixture root required")?,
    );
    if !root.join(".native-cli-fixture").is_file() {
        return Err("fixture marker required".into());
    }
    let mut bytes = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return Err("request limit".into());
    }
    let request: Value = serde_json::from_slice(&bytes)?;
    let id = request["id"].as_str().ok_or("id required")?;
    if request["op"] == "hold" {
        // One fixed Store lock; no arbitrary path or execution supplied by input.
        let file = root.join("conversations/index.jsonl");
        let held = DirectoryLock::acquire(&file, Duration::from_millis(100), None)?;
        writeln!(io::stdout(), "{}", json!({"ready":true}))?;
        io::stdout().flush()?;
        std::thread::sleep(Duration::from_millis(
            request["holdMs"]
                .as_u64()
                .filter(|v| *v <= 8000)
                .ok_or("hold limit")?,
        ));
        held.release()?;
        return Ok(json!({"ok":true}));
    }
    let store = ConversationStore::new(&root);
    let mut snapshot = match store.read_committed(id, None, 8 * 1024 * 1024) {
        Ok(s) => s,
        Err(e) => return Ok(json!({"ok":false,"code":e.code()})),
    };
    if request["op"] == "snapshot" {
        return Ok(
            json!({"ok":true,"history":snapshot.history,"sourceRevision":snapshot.source_revision}),
        );
    }
    let expected = &request["expected"];
    snapshot.source_revision = expected["sourceRevision"]
        .as_str()
        .ok_or("source required")?
        .into();
    snapshot.history.content_revision = expected["contentRevision"]
        .as_u64()
        .ok_or("revision required")?;
    let message = request["messageId"].as_str().ok_or("message required")?;
    let at = "2026-11-18T00:00:00.000Z";
    let cancel = AtomicBool::new(request["cancelled"] == true);
    let result=match request["op"].as_str() {
        Some("stream")=>store.patch_stream_message(&snapshot,message,&request["patch"],at,Some(&cancel)).map(|s|json!({"ok":true,"history":s.history,"sourceRevision":s.source_revision})),
        Some("terminal")=>store.commit_terminal_message(&snapshot,message,&request["patch"],at,Some(&cancel)).map(|r|json!({"ok":true,"history":r.snapshot.history,"sourceRevision":r.snapshot.source_revision,"alreadyCommitted":r.already_committed})),
        #[cfg(feature="test-fixtures")]
        Some("fault")=>store.commit_terminal_fixture(&snapshot,message,&request["patch"],at,Some(&cancel),request["after"].as_str().ok_or("stage required")?).map(|r|json!({"ok":true,"history":r.snapshot.history})),
        _=>return Err("unknown operation".into()),
    };
    Ok(result.unwrap_or_else(|e| json!({"ok":false,"code":e.code()})))
}
fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(_) => {
            eprintln!("terminal fixture rejected");
            std::process::exit(2)
        }
    }
}
