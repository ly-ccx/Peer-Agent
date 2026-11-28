//! Development conformance entry; never shipped or called by peer-native.
use peer_protocol::TranscriptCursor;
use peer_store::{TranscriptError, TranscriptLimits, TranscriptReader};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    conversation_id: String,
    cursor: Option<TranscriptCursor>,
    records: usize,
}
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let root = PathBuf::from(env::var("PEER_NATIVE_CONFORMANCE_ROOT")?);
    if !root.join(".native-cli-fixture").is_file() {
        return Err("synthetic fixture marker required".into());
    }
    let mut input = String::new();
    io::stdin().take(1_048_577).read_to_string(&mut input)?;
    if input.len() > 1_048_576 {
        return Err("request limit".into());
    }
    let request: Request = serde_json::from_str(&input)?;
    Ok(
        match TranscriptReader::new(root).read_page(
            &request.conversation_id,
            request.cursor.as_ref(),
            TranscriptLimits {
                records: request.records,
                ..Default::default()
            },
            None,
        ) {
            Ok(page) => json!({"ok":true,"page":page}),
            Err(TranscriptError::Store(error)) => json!({"ok":false,"code":error.code()}),
            Err(TranscriptError::InvalidCursor) => {
                json!({"ok":false,"code":"TRANSCRIPT_INVALID_CURSOR"})
            }
            Err(TranscriptError::LimitExceeded {
                kind,
                line_end,
                scanned_from,
            }) => {
                json!({"ok":false,"code":"TRANSCRIPT_RESOURCE_LIMIT","kind":format!("{kind:?}"),"lineEnd":line_end,"scannedFrom":scanned_from})
            }
        },
    )
}
fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(_) => {
            eprintln!("conformance input rejected");
            std::process::exit(1);
        }
    }
}
