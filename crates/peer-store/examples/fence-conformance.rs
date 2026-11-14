//! Development-only crash fixture, excluded unless test-fixtures is enabled.
use peer_store::{
    AcquireLease, HostIdentity, HostLeaseStore, HostSurface, protect_coordination_writer_fixture,
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::{
    env,
    io::{self, Read, Write},
    path::PathBuf,
};
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    workspace: String,
    now: i64,
    stop_after: Option<String>,
}
fn run() -> Result<Value, Box<dyn std::error::Error>> {
    let root = PathBuf::from(env::var("PEER_NATIVE_CONFORMANCE_ROOT")?);
    if !root.join(".native-cli-fixture").is_file() {
        return Err("synthetic marker required".into());
    }
    let mut input = String::new();
    io::stdin().take(65537).read_to_string(&mut input)?;
    if input.len() > 65536 {
        return Err("request limit".into());
    }
    let request: Request = serde_json::from_str(&input)?;
    let owner = HostIdentity::new(
        "native-fence",
        HostSurface::Tui,
        std::process::id(),
        "fixture",
    )?;
    let token = match HostLeaseStore::new(root).acquire(&request.workspace, &owner, request.now)? {
        AcquireLease::Acquired { token, .. } => token,
        AcquireLease::Held(_) => return Ok(json!({"ok":false,"code":"fixture_lease_held"})),
    };
    let outcome = protect_coordination_writer_fixture(&token, None, |step| {
        if request.stop_after.as_deref() == Some(step.as_str()) {
            println!("{}", json!({"stoppedAfter":step.as_str()}));
            io::stdout().flush().expect("fixture stdout");
            std::process::exit(77);
        }
        Ok(())
    });
    let result = match outcome {
        Ok(outcome) => json!({"ok":true,"outcome":format!("{outcome:?}")}),
        Err(error) => json!({"ok":false,"code":error.code()}),
    };
    token.release()?;
    Ok(result)
}
fn main() {
    match run() {
        Ok(value) => println!("{value}"),
        Err(_) => {
            eprintln!("fence fixture rejected");
            std::process::exit(1);
        }
    }
}
