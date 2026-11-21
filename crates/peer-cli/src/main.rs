#![forbid(unsafe_code)]

use peer_cli::{Command, VERSION, command, finish_stdout};
use peer_protocol::CliExit;
use std::{
    io::{self, IsTerminal, Write},
    process::ExitCode,
};
const SHELL_CONTRACT: &str =
    include_str!("../../../packages/protocol/contracts/native-cli/shell-completions.json");

fn stamp_help_version(template: &str) -> String {
    if let Some((first, rest)) = template.split_once('\n')
        && first.starts_with("peer ")
    {
        return format!("peer {}\n{rest}", VERSION.trim());
    }
    template.to_owned()
}

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
        Command::CoreStdio => {
            drop(out);
            return peer_cli::core_rpc::run();
        }
        Command::Version => finish_stdout(writeln!(out, "peer {}", VERSION.trim()))?,
        Command::Help => finish_stdout(writeln!(
            out,
            "peer {}\n\nUsage:\n  peer                      Open this project bot (or ask to bind it)\n  peer bots [--json]        Browse your bots (or list as JSON)\n  peer --classic            Open ordinary task mode, even when a bot is bound\n  peer --version            Print version\n  peer --help               Show this help\n  peer update [--check]     Install or check the newest release on this channel\n  peer sessions             List, resume, or delete stored sessions\n  peer models               List configured models (or auth|logout|status|reconcile <channel>)\n  peer doctor               Check the local install\n  peer completions          Print a shell completion script (<bash|zsh|fish>)\n  peer export <id>          Export a stored session as Markdown\n  peer exec [options] [prompt]\n  peer acp                  Run the ACP agent on stdio\n  peer core --stdio         Run the local Rust core RPC engine on stdio\n  peer result <interactive-result://…> [--json]\n  peer result-cleanup-receipt < request.json\n  peer recover --session <conversation-id> | --plan <goal-id>\n  peer mcp <auth|refresh> <server-id>\n\nUse `peer exec --help`, `peer update --help`, `peer sessions --help`, `peer doctor --help`,\n`peer completions --help`, or `peer export --help` for subcommand details.\nInside bot mode, press F2 or type /classic to switch to task mode.\nNo Bun/Node sidecar is started.",
            VERSION.trim()
        ))?,
        Command::Update { check_only } => {
            drop(out);
            return peer_cli::update::run(check_only);
        }
        Command::UpdateHelp => {
            finish_stdout(writeln!(out, "{}", peer_cli::update::help_text()))?;
        }
        Command::Completions(shell) => {
            let data: serde_json::Value =
                serde_json::from_str(SHELL_CONTRACT).expect("verified shell contract");
            finish_stdout(write!(out, "{}", data["scripts"][&shell].as_str().unwrap()))?;
        }
        Command::CompletionsHelp => {
            let data: serde_json::Value =
                serde_json::from_str(SHELL_CONTRACT).expect("verified shell contract");
            let help = stamp_help_version(data["help"].as_str().unwrap());
            finish_stdout(writeln!(out, "{help}"))?;
        }
        Command::ShellHelp(topic) => {
            let data: serde_json::Value = serde_json::from_str(include_str!(
                "../../../packages/protocol/contracts/native-cli/session-shell.json"
            ))
            .expect("verified shell contract");
            let help = stamp_help_version(data["help"][topic].as_str().unwrap());
            finish_stdout(writeln!(out, "{help}"))?;
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
        Command::BotsJson => {
            drop(out);
            return peer_cli::bots::list_json();
        }
        Command::SessionsResume(id) => {
            drop(out);
            return peer_cli::sessions::resume(&id);
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
        Command::Interactive(mode) => {
            drop(out);
            if !io::stdin().is_terminal() || !io::stdout().is_terminal() {
                writeln!(
                    io::stderr(),
                    "peer: refusing to start the interactive TUI without a TTY. Use `peer exec`."
                )?;
                return Ok(CliExit::Usage);
            }
            return peer_cli::terminal::run_mode(mode);
        }
    }
    Ok(CliExit::Ok)
}
