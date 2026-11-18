#![forbid(unsafe_code)]

use peer_cli::{Command, VERSION, command, finish_stdout};
use peer_protocol::CliExit;
use std::{
    io::{self, IsTerminal, Write},
    process::ExitCode,
};
const SHELL_CONTRACT: &str =
    include_str!("../../../packages/protocol/contracts/native-cli/shell-completions.json");

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
        Command::Acp => {
            drop(out);
            return peer_cli::acp::run();
        }
        Command::Version => finish_stdout(writeln!(out, "peer {}", VERSION.trim()))?,
        Command::Help => finish_stdout(writeln!(
            out,
            "Peer native CLI migration candidate\n\nUsage: peer-native [--help|--version|doctor|--classic|bots]\n       peer-native exec [options] [prompt]\n       peer-native acp\n       peer-native exec --plan <canonical-goal-id> [--max-turns N]\n       peer-native recover --plan <canonical-goal-id>\n       peer-native recover --session <conversation-id>\n       peer-native sessions [list | delete <id> [--yes]]\n       peer-native export <session-id> [--output <path>] [--force]\n       peer result <interactive-result://…> [--json]\n       peer result-cleanup-receipt < request.json\n       peer-native mcp auth <server-id>\n       peer-native mcp refresh <server-id>\n       peer-native completions <bash|zsh|fish>\n       peer-native models\n       peer-native models <auth|logout|status|reconcile> <configured-channel-id>\n\nNative exec supports ordinary conversations and delegated worker admissions\nwith native model and MCP transports. Unsupported configuration is rejected. OAuth commands update configured\nVault credentials; they do not grant tools. The interactive TUI edits drafts.\nPEER_MODEL_API_KEY, PEER_MODEL_BASE_URL and PEER_MODEL_ID configure the independent\nenvironment model source. No Bun/Node sidecar is started."
        ))?,
        Command::Completions(shell) => {
            let data: serde_json::Value =
                serde_json::from_str(SHELL_CONTRACT).expect("verified shell contract");
            finish_stdout(write!(out, "{}", data["scripts"][&shell].as_str().unwrap()))?;
        }
        Command::CompletionsHelp => {
            let data: serde_json::Value =
                serde_json::from_str(SHELL_CONTRACT).expect("verified shell contract");
            finish_stdout(writeln!(out, "{}", data["help"].as_str().unwrap()))?;
        }
        Command::ShellHelp(topic) => {
            let data: serde_json::Value = serde_json::from_str(include_str!(
                "../../../packages/protocol/contracts/native-cli/session-shell.json"
            ))
            .expect("verified shell contract");
            finish_stdout(writeln!(out, "{}", data["help"][topic].as_str().unwrap()))?;
        }
        Command::Export(options) => {
            drop(out);
            return peer_cli::export::run(&options);
        }
        Command::Result { reference, json } => {
            return peer_cli::interactive_result::run(&mut out, &reference, json);
        }
        Command::ResultCleanupReceipt => {
            return peer_cli::interactive_result::cleanup_receipt(&mut out, io::stdin().lock());
        }
        Command::ResultHelp => finish_stdout(peer_cli::interactive_result::help(&mut out))?,
        Command::Usage(message) => {
            writeln!(io::stderr(), "{message}")?;
            return Ok(CliExit::Usage);
        }
        Command::Doctor => {
            drop(out);
            return peer_cli::doctor::run();
        }
        Command::SessionsDelete { id, yes } => {
            drop(out);
            return peer_cli::sessions::delete(&id, yes);
        }
        Command::SessionsList => {
            drop(out);
            return peer_cli::sessions::list();
        }
        Command::Unavailable(name) => {
            writeln!(
                io::stderr(),
                "peer-native: command {name:?} is not available in this migration candidate; use the existing peer"
            )?;
            return Ok(CliExit::Runtime);
        }
        Command::Exec { plan, max_turns } => {
            drop(out);
            return peer_cli::native_exec::run(&plan, max_turns, false);
        }
        Command::OrdinaryExec(options) => {
            drop(out);
            return peer_cli::ordinary_exec::run(&options);
        }
        Command::ExecHelp => {
            finish_stdout(writeln!(out, "{}", peer_cli::ordinary_exec::HELP))?;
        }
        Command::Recover(plan) => {
            drop(out);
            return peer_cli::native_exec::run(&plan, 0, true);
        }
        Command::RecoverSession(session) => {
            drop(out);
            return peer_cli::ordinary_recovery::run(&session);
        }
        Command::McpAuth { server, refresh } => {
            drop(out);
            return peer_cli::mcp::run(&server, refresh);
        }
        Command::ModelAuth { action, channel } => {
            drop(out);
            return peer_cli::model_auth::run(&action, &channel);
        }
        Command::Models => {
            drop(out);
            return peer_cli::models::run();
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
