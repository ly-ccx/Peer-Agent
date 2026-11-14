#![forbid(unsafe_code)]

use peer_cli::{Command, VERSION, command};
use peer_protocol::CliExit;
use std::{
    io::{self, IsTerminal, Write},
    process::ExitCode,
};

fn main() -> ExitCode {
    let result = run();
    match result {
        Ok(code) => ExitCode::from(code as u8),
        Err(error) => {
            let _ = writeln!(io::stderr(), "peer: {error}");
            ExitCode::from(CliExit::Runtime as u8)
        }
    }
}

fn run() -> io::Result<CliExit> {
    let argv: Vec<_> = std::env::args().skip(1).collect();
    let mut out = io::stdout().lock();
    match command(&argv) {
        Command::Version => writeln!(out, "peer {}", VERSION.trim())?,
        Command::Help => writeln!(
            out,
            "Peer native CLI migration candidate\n\nUsage: peer-native [--help|--version|doctor|--classic|bots]\n\nThis candidate supports terminal draft editing only. Sending, execution, ACP,\nand persistent session recovery are not yet connected. Use the existing peer\nfor normal work. No Bun/Node sidecar is started."
        )?,
        Command::Doctor => writeln!(
            out,
            "{}",
            serde_json::json!({
                "version": VERSION.trim(), "native": true, "candidate": true,
                "contractVersion": 1, "contractHash": peer_protocol::contract_hash(),
                "runtimeConnected": false, "sidecar": false,
                "dataHomeConfigured": peer_protocol::data_home().is_some(),
            })
        )?,
        Command::Unavailable(name) => {
            writeln!(
                io::stderr(),
                "peer-native: command {name:?} is not available in this migration candidate; use the existing peer"
            )?;
            return Ok(CliExit::Runtime);
        }
        Command::Interactive => {
            drop(out);
            if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                writeln!(
                    io::stderr(),
                    "peer: refusing to start the interactive TUI without a TTY. Use `peer exec`."
                )?;
                return Ok(CliExit::Usage);
            }
            peer_cli::terminal::run()?;
        }
    }
    Ok(CliExit::Ok)
}
