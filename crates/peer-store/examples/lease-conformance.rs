//! Bounded, synthetic-only JSONL fixture for cross-process lease conformance.
use peer_store::{
    AcquireLease, HOST_LEASE_HEARTBEAT_MS, HOST_LEASE_STALE_MS, HostIdentity, HostLeaseStore,
    HostSurface, LeaseToken,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, BufRead, Read, Write},
    path::PathBuf,
};

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    op: String,
    workspace: String,
    #[serde(default)]
    now: i64,
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let root =
        PathBuf::from(std::env::var_os("PEER_NATIVE_CONFORMANCE_ROOT").ok_or("fixture root")?);
    if !root.join(".native-cli-fixture").is_file() {
        return Err("fixture marker required".into());
    }
    let store = HostLeaseStore::new(root);
    let owner = HostIdentity::new("native", HostSurface::Tui, std::process::id(), "fixture")?;
    let mut held = BTreeMap::<String, LeaseToken>::new();
    let mut input = io::stdin().lock();
    println!(
        "{}",
        json!({"ready":true,"heartbeatMs":HOST_LEASE_HEARTBEAT_MS,"staleMs":HOST_LEASE_STALE_MS})
    );
    io::stdout().flush()?;
    loop {
        let mut line = Vec::new();
        if input.by_ref().take(16_385).read_until(b'\n', &mut line)? == 0 {
            break;
        }
        if line.len() > 16_384 {
            return Err("fixture request limit".into());
        }
        let request: Request = serde_json::from_slice(&line)?;
        let result = (|| -> Result<Value, peer_store::StoreError> {
            Ok(match request.op.as_str() {
                "inspect" => json!({"ok":true,"lease":store.inspect(&request.workspace)?}),
                "acquire" => {
                    if held.len() >= 4 && !held.contains_key(&request.workspace) { return Err(peer_store::StoreError::InvalidInput); }
                    match store.acquire(&request.workspace, &owner, request.now)? {
                        AcquireLease::Held(record) => json!({"ok":true,"acquired":false,"lease":record}),
                        AcquireLease::Acquired { token, took_over } => {
                            let output = json!({"ok":true,"acquired":true,"tookOver":took_over,"lease":token.record()});
                            held.insert(request.workspace.clone(), token); output
                        }
                    }
                }
                "takeover" => json!({"ok":true,"requested":store.request_takeover(&request.workspace,&owner,request.now)?}),
                "holds" => json!({"ok":true,"holds":held.get(&request.workspace).map(|t|t.holds()).transpose()?.unwrap_or(false)}),
                "pending" => json!({"ok":true,"pending":held.get(&request.workspace).ok_or(peer_store::StoreError::LeaseOwnershipLost)?.takeover_requested()?}),
                "heartbeat" => { held.get_mut(&request.workspace).ok_or(peer_store::StoreError::LeaseOwnershipLost)?.heartbeat(request.now)?; json!({"ok":true}) },
                "release" => { held.remove(&request.workspace).ok_or(peer_store::StoreError::LeaseOwnershipLost)?.release()?; json!({"ok":true}) },
                _ => return Err(peer_store::StoreError::InvalidInput),
            })
        })().unwrap_or_else(|error|json!({"ok":false,"code":error.code()}));
        println!("{result}");
        io::stdout().flush()?;
    }
    Ok(())
}
