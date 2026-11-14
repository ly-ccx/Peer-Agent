//! Synthetic v1 transport fixture. Not built by the product release command.
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    path::PathBuf,
    time::Duration,
};

fn main() {
    let root = PathBuf::from(std::env::var_os("PEER_AGENT_HOME").expect("fixture root"));
    assert!(root.join(".native-cli-fixture").is_file());
    fs::write(root.join(format!("pid-{}", std::process::id())), "started").unwrap();
    let mode = fs::read_to_string(root.join("mode")).unwrap_or_default();
    let mut bytes = Vec::new();
    std::io::stdin()
        .take(524_289)
        .read_to_end(&mut bytes)
        .unwrap();
    assert!(bytes.len() <= 524_288);
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    fs::write(root.join("last-request.json"), &bytes).unwrap();
    match mode.as_str() {
        "sleep" => std::thread::sleep(Duration::from_secs(20)),
        "stdout-flood" => {
            let _ = std::io::stdout().write_all(&vec![b'x'; 2 * 1024 * 1024]);
            return;
        }
        "stderr-flood" => {
            let _ = std::io::stderr().write_all(&vec![b'x'; 128 * 1024]);
            return;
        }
        "invalid" => {
            println!("{{broken synthetic-secret");
            return;
        }
        "version" => {
            println!(
                "{}",
                json!({"version":2,"ok":true,"data":{"secret":"synthetic-secret"}})
            );
            return;
        }
        "error" => {
            eprintln!("synthetic-secret");
            println!(
                "{}",
                json!({"version":1,"ok":false,"error":{"code":"secure_storage_unavailable","message":"synthetic-secret"}})
            );
            std::process::exit(1);
        }
        "status" => {
            println!(
                "{}",
                json!({"version":1,"ok":true,"data":{"secret":"synthetic-secret"}})
            );
            std::process::exit(1);
        }
        "nodes" => {
            println!(
                "{{\"version\":1,\"ok\":true,\"data\":{{\"extra\":[{}0]}}}}",
                "0,".repeat(1024)
            );
            return;
        }
        _ => {}
    }
    let saved = root.join("synthetic-secret.txt");
    let data = match request["action"].as_str().unwrap() {
        "ping" => json!({"status":"ready","platform":"fixture"}),
        "get" => json!({"secret":fs::read_to_string(saved).ok()}),
        "set" => {
            fs::write(saved, request["secret"].as_str().unwrap()).unwrap();
            json!({"stored":true})
        }
        "delete" => json!({"deleted": fs::remove_file(saved).is_ok()}),
        _ => panic!("unknown request"),
    };
    println!("{}", json!({"version":1,"ok":true,"data":data}));
}
