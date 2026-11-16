//! Explicit development-only process using the real encrypted Vault/lock code.
use std::{
    io::{Read, Write},
    path::PathBuf,
};
fn main() {
    let home = PathBuf::from(std::env::var_os("PEER_AGENT_HOME").expect("isolated home"));
    assert!(home.is_absolute() && home.join(".native-cli-fixture").is_file());
    let key = std::fs::read(home.join(".synthetic-vault-key")).expect("synthetic key");
    let mut bytes = vec![];
    std::io::stdin()
        .take(524_289)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 524_288);
    let request = serde_json::from_slice(&bytes).expect("fixture protocol");
    let compare = matches!(&request,peer_credential_helper::Request::CompareSet {secret:Some(secret),..} if serde_json::from_str::<serde_json::Value>(secret).is_ok_and(|v|v.get("peerModelRefresh").is_none()));
    let response = peer_credential_helper::handle_fixture_request(request, &home, &key);
    // Commit the actual encrypted transaction, then lose only its receipt.
    // This executable is never part of the product's featureless build.
    if compare && response.ok && home.join(".lose-compare-receipt").is_file() {
        std::fs::remove_file(home.join(".lose-compare-receipt")).unwrap();
        std::process::exit(23);
    }
    serde_json::to_writer(std::io::stdout(), &response).unwrap();
    std::io::stdout().write_all(b"\n").unwrap();
}
