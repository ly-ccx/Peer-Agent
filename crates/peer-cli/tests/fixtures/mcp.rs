//! Native synthetic MCP server. Never included in the shipping CLI binary.
use serde_json::{Value, json};
use std::{
    io::{BufRead, Write},
    path::PathBuf,
};
fn main() {
    let root = PathBuf::from(std::env::var_os("MCP_FIXTURE_ROOT").unwrap());
    assert!(root.join(".native-cli-fixture").is_file());
    std::fs::write(root.join("mcp.pid"), std::process::id().to_string()).unwrap();
    let mode = std::env::args().nth(1).unwrap_or_default();
    let mut output = std::io::stdout().lock();
    for line in std::io::stdin().lock().lines() {
        let line = line.unwrap();
        assert!(line.len() <= 262144);
        let request: Value = serde_json::from_str(&line).unwrap();
        let mut log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(root.join("mcp.requests"))
            .unwrap();
        writeln!(log, "{request}").unwrap();
        let method = request["method"].as_str().unwrap_or("");
        if method == "initialize" && mode == "gate" {
            std::fs::write(root.join("mcp.ready"), "ready").unwrap();
            for _ in 0..1000 {
                if root.join("mcp.release").exists() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        }
        let result = match method {
            "initialize" if mode == "init_disconnect" => return,
            "initialize" => {
                json!({"protocolVersion":"2025-11-25","capabilities":{"tools":{}},"serverInfo":{"name":"native-fixture","version":"1"}})
            }
            "tools/list" => json!({"tools":[{"name":"read_fact","inputSchema":{"type":"object"}}]}),
            "tools/call" => {
                std::fs::write(root.join("mcp.effect"), "actual MCP effect").unwrap();
                if mode == "stall" {
                    loop {
                        std::thread::sleep(std::time::Duration::from_millis(100));
                    }
                }
                if mode == "large_valid" {
                    writeln!(output,"{}",json!({"jsonrpc":"2.0","id":request["id"],"result":{"content":[{"type":"text","text":"x".repeat(200000)}]}})).unwrap();
                    output.flush().unwrap();
                    continue;
                }
                if mode == "disconnect" {
                    return;
                }
                if mode == "oversize" {
                    writeln!(output, "{}", "x".repeat(1048578)).unwrap();
                    output.flush().unwrap();
                    continue;
                }
                if mode == "rpc_error" {
                    writeln!(output,"{}",json!({"jsonrpc":"2.0","id":request["id"],"error":{"code":-32602,"message":"synthetic RPC error"}})).unwrap();
                    output.flush().unwrap();
                    continue;
                }
                json!({"content":[{"type":"text","text":"native MCP fact"}],"isError":mode=="business_error","structuredContent":{"source":"native-fixture"},"extension":{"retained":true},"echo":std::env::var("MCP_SECRET").ok()})
            }
            _ => continue,
        };
        writeln!(
            output,
            "{}",
            json!({"jsonrpc":"2.0","id":request["id"],"result":result})
        )
        .unwrap();
        output.flush().unwrap();
    }
}
