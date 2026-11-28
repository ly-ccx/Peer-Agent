//! Isolated development bridge only; never an installed execution command.
use peer_protocol::NativeProcessRecorder;
use peer_store::{ConversationStore, NewConversationExecution};
use serde_json::{Value, json};
use std::{
    io::{self, Read},
    path::PathBuf,
};
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let root = PathBuf::from(
        std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").ok_or("fixture root required")?,
    );
    if !root.join(".native-cli-fixture").is_file() {
        return Err("isolated fixture marker required".into());
    }
    let mut bytes = Vec::new();
    io::stdin().take(1_048_577).read_to_end(&mut bytes)?;
    if bytes.len() > 1_048_576 {
        return Err("request limit".into());
    }
    let v: Value = serde_json::from_slice(&bytes)?;
    let id = v["id"].as_str().ok_or("id")?;
    let store = ConversationStore::new(&root);
    if v["op"] == "read" {
        return Ok(match store.read_conversation_execution(id) {
            Ok(run) => json!({"ok":true,"run":run}),
            Err(e) => json!({"ok":false,"code":e.code()}),
        });
    }
    if v["op"] == "read-evidence" {
        let call_id = v["call"].as_str().ok_or("tool call id")?;
        let rows = peer_store::EvidenceIndexStore::new(&root)
            .find(&[format!("tool-result://{call_id}")], None)?;
        return Ok(json!({ "records": rows }));
    }
    if v["op"] == "verify-usage" {
        let run = store
            .read_conversation_execution(id)?
            .ok_or("execution required")?;
        if !run.usage_committed {
            return Err("usage acknowledgement required".into());
        }
        let usage = run.usage.ok_or("observed usage required")?;
        let receipt = store.record_runtime_turn_usage(id, &usage, &run.attribution, None)?;
        return Ok(json!({ "receipt": receipt }));
    }
    if v["op"] == "read-tool" {
        let snapshot = store.read_committed(id, None, 8 * 1024 * 1024)?;
        let call_id = v["call"].as_str().ok_or("tool call id")?;
        for message in snapshot.history.messages {
            let Some(segment) = message["segments"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|segment| segment["type"] == "tool-call" && segment["toolCallId"] == call_id)
            else {
                continue;
            };
            let args_digest = peer_protocol::approval_args_digest(&segment["args"])
                .map_err(|_| "tool args digest")?;
            return Ok(json!({
                "message": message,
                "argsDigest": args_digest,
                "revision": snapshot.history.content_revision,
            }));
        }
        return Err("tool message not found".into());
    }
    if v["op"] != "claim" {
        return Err("operation".into());
    }
    let h = match store.read_committed(id, None, 8 * 1024 * 1024) {
        Ok(history) => history,
        Err(error) => return Ok(json!({"ok":false, "code":error.code()})),
    };
    let owner = NativeProcessRecorder {
        boot_id: "fixture-boot".into(),
        pid: std::process::id(),
        pid_start: "fixture-start".into(),
        host_id: "fixture-host".into(),
        acquired_at: "2026-11-18T00:00:00.000Z".into(),
    };
    let stream = v["stream"].as_str().ok_or("stream")?;
    Ok(
        match store.claim_conversation_execution(
            &h,
            &NewConversationExecution {
                stream_id: stream,
                engine: "peer-native",
                owner: &owner,
                attribution: &json!({"id":stream,"streamId":stream}),
                selected_model: None,
                at: &owner.acquired_at,
            },
            None,
        ) {
            Ok(_) => json!({"ok":true,"run":store.read_conversation_execution(id)?}),
            Err(e) => json!({"ok":false,"code":e.code()}),
        },
    )
}
fn main() {
    match run() {
        Ok(v) => println!("{v}"),
        Err(_) => {
            eprintln!("conversation execution fixture rejected");
            std::process::exit(2)
        }
    }
}
