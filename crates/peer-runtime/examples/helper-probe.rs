//! Development probe: real native Helper ping only, isolated root, no OS secrets.
use peer_runtime::{CancellationToken, credentials::HelperClient};
use std::{fs, path::PathBuf, time::Duration};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let helper = PathBuf::from(
        std::env::args_os()
            .nth(1)
            .ok_or("absolute helper path required")?,
    );
    let root = tempfile::tempdir()?;
    let client = HelperClient::new(&helper, root.path(), Duration::from_secs(2))?;
    client.ping(&CancellationToken::new()).await?;
    if fs::read_dir(root.path())?.next().is_some() {
        return Err("ping mutated isolated data home".into());
    }
    println!(
        "{{\"ok\":true,\"protocol\":1,\"nativeHelper\":true,\"secretAccess\":false,\"dataHomeMutated\":false}}"
    );
    Ok(())
}
