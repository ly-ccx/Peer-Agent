#![forbid(unsafe_code)]

pub mod acp;
pub mod bot_exec;
pub mod bots;
mod cancellation;
pub mod core_rpc;
pub mod doctor;
pub mod export;
pub mod interactive_result;
pub mod mcp;
pub mod model_auth;
pub mod models;
pub mod native_exec;
pub mod ordinary_exec;
pub mod ordinary_recovery;
pub mod sessions;
mod shell_args;
pub mod terminal;
mod text;
pub mod update;
pub use text::finish_stdout;

use std::path::PathBuf;

pub const VERSION: &str = include_str!("../../../VERSION");

const CORE_USAGE: &str =
    "Usage: peer core --stdio | --daemon [--socket <path>] [--quiet] | status [--json] | stop";

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Acp,
    CoreStdio,
    CoreDaemon {
        socket: Option<PathBuf>,
        quiet: bool,
    },
    CoreStatus {
        json: bool,
    },
    CoreStop,
    Help,
    Doctor,
    BotsJson {
        standalone: bool,
    },
    Interactive(terminal::InteractiveMode),
    Models,
    SessionsList,
    SessionsResume(String),
    SessionsDelete {
        id: String,
        yes: bool,
    },
    Completions(String),
    CompletionsHelp,
    Update {
        check_only: bool,
    },
    UpdateHelp,
    Usage(String),
    ShellHelp(&'static str),
    Export(export::Options),
    Result {
        reference: String,
        json: bool,
    },
    ResultHelp,
    ResultCleanupReceipt,
    Exec {
        plan: String,
        max_turns: usize,
    },
    OrdinaryExec(Box<ordinary_exec::Options>),
    ExecHelp,
    Recover(String),
    RecoverSession(String),
    McpAuth {
        server: String,
        refresh: bool,
    },
    ModelAuth {
        action: String,
        channel: String,
    },
    Unavailable(String),
}

/// Preserve legacy version fast-path precedence before terminal initialization.
pub fn command(argv: &[String]) -> Command {
    if argv.first().is_some_and(|arg| arg == "acp") {
        return if argv.len() == 1 {
            Command::Acp
        } else {
            Command::Usage("Usage: peer acp (stdio; no options)".into())
        };
    }
    if argv.first().is_some_and(|arg| arg == "core") {
        return parse_core_command(&argv[1..]);
    }
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--version" | "-v"))
    {
        return Command::Version;
    }
    if argv.first().is_some_and(|s| s == "exec") && argv.get(1).is_none_or(|s| s != "--plan") {
        return ordinary_exec::parse(&argv[1..]);
    }
    if argv.first().is_some_and(|s| s == "update") {
        return update::parse(&argv[1..]);
    }
    if argv.first().is_some_and(|s| s == "result") {
        return interactive_result::parse(&argv[1..]);
    }
    if argv
        .first()
        .is_some_and(|s| s == "__interactive-maintenance")
    {
        return Command::ResultCleanupReceipt;
    }
    if argv.first().is_some_and(|s| s == "result-cleanup-receipt") {
        return if argv.len() == 1 {
            Command::ResultCleanupReceipt
        } else {
            Command::Usage("Usage: peer result-cleanup-receipt < request.json".into())
        };
    }
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        if argv.first().is_some_and(|s| s == "completions") {
            return Command::CompletionsHelp;
        }
        match argv.first().map(String::as_str) {
            Some("doctor") => return Command::ShellHelp("doctor"),
            Some("sessions") => return Command::ShellHelp("sessions"),
            Some("export") => return Command::ShellHelp("export"),
            _ => {}
        }
        return Command::Help;
    }
    if let Some(command) = shell_args::parse(argv) {
        return command;
    }
    match argv.first().map(String::as_str) {
        Some("completions") => {
            if argv.len() == 2 && matches!(argv[1].as_str(), "bash" | "zsh" | "fish") {
                Command::Completions(argv[1].clone())
            } else {
                Command::Usage("Usage: peer completions <bash|zsh|fish>".into())
            }
        }
        Some("models") if argv.len() == 1 => Command::Models,
        Some("models")
            if argv.len() == 3
                && matches!(argv[1].as_str(), "auth" | "logout" | "status" | "reconcile") =>
        {
            Command::ModelAuth {
                action: argv[1].clone(),
                channel: argv[2].clone(),
            }
        }
        Some("mcp") if argv.len() == 3 && matches!(argv[1].as_str(), "auth" | "refresh") => {
            Command::McpAuth {
                server: argv[2].clone(),
                refresh: argv[1] == "refresh",
            }
        }
        Some("recover") if argv.len() == 3 && argv[1] == "--plan" => {
            Command::Recover(argv[2].clone())
        }
        Some("recover") if argv.len() == 3 && argv[1] == "--session" => {
            Command::RecoverSession(argv[2].clone())
        }
        Some("recover") => Command::Usage(
            "Usage: peer recover --session <conversation-id> | --plan <goal-id>".into(),
        ),
        Some("exec") if argv.len() == 3 && argv[1] == "--plan" => Command::Exec {
            plan: argv[2].clone(),
            max_turns: 16,
        },
        Some("exec") if argv.len() == 5 && argv[1] == "--plan" && argv[3] == "--max-turns" => {
            match argv[4].parse::<usize>() {
                Ok(n) if (1..=1000).contains(&n) => Command::Exec {
                    plan: argv[2].clone(),
                    max_turns: n,
                },
                _ => Command::Unavailable("exec: invalid max turns".into()),
            }
        }
        Some("bots") if argv.len() == 2 && argv[1] == "--json" => {
            Command::BotsJson { standalone: false }
        }
        Some("bots")
            if argv.len() == 3
                && ((argv[1] == "--json" && argv[2] == "--standalone")
                    || (argv[1] == "--standalone" && argv[2] == "--json")) =>
        {
            Command::BotsJson { standalone: true }
        }
        Some("bots") if argv.len() == 1 => Command::Interactive(terminal::InteractiveMode::Bots),
        Some("version") if argv.len() == 1 => Command::Version,
        Some("help") if argv.len() == 1 => Command::Help,
        Some("--classic") if argv.len() == 1 => {
            Command::Interactive(terminal::InteractiveMode::Classic)
        }
        None => Command::Interactive(terminal::InteractiveMode::Auto),
        Some(name) => Command::Unavailable(name.to_owned()),
    }
}

fn parse_core_command(args: &[String]) -> Command {
    let usage = || Command::Usage(CORE_USAGE.into());
    let Some(first) = args.first().map(String::as_str) else {
        return usage();
    };
    match first {
        "--stdio" if args.len() == 1 => Command::CoreStdio,
        "--daemon" => {
            let mut socket = None;
            let mut quiet = false;
            let mut i = 1;
            while i < args.len() {
                let arg = args[i].as_str();
                if arg == "--quiet" {
                    quiet = true;
                    i += 1;
                } else if arg == "--socket" {
                    let Some(val) = args.get(i + 1).filter(|s| !s.is_empty()) else {
                        return usage();
                    };
                    socket = Some(PathBuf::from(val));
                    i += 2;
                } else if let Some(val) = arg.strip_prefix("--socket=") {
                    if val.is_empty() {
                        return usage();
                    }
                    socket = Some(PathBuf::from(val));
                    i += 1;
                } else {
                    return usage();
                }
            }
            Command::CoreDaemon { socket, quiet }
        }
        "status" => match args.len() {
            1 => Command::CoreStatus { json: false },
            2 if args[1] == "--json" => Command::CoreStatus { json: true },
            _ => usage(),
        },
        "stop" if args.len() == 1 => Command::CoreStop,
        _ => usage(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_and_help_never_need_terminal_runtime_or_credentials() {
        assert_eq!(
            command(&["exec".into(), "--version".into()]),
            Command::Version
        );
        assert!(matches!(
            command(&["acp".into(), "--help".into()]),
            Command::Usage(_)
        ));
        assert_eq!(
            command(&["core".into(), "--stdio".into()]),
            Command::CoreStdio
        );
        assert_eq!(
            command(&["core".into(), "--daemon".into()]),
            Command::CoreDaemon {
                socket: None,
                quiet: false,
            }
        );
        assert_eq!(
            command(&[
                "core".into(),
                "--daemon".into(),
                "--socket".into(),
                "/tmp/p.sock".into(),
                "--quiet".into(),
            ]),
            Command::CoreDaemon {
                socket: Some(PathBuf::from("/tmp/p.sock")),
                quiet: true,
            }
        );
        assert_eq!(
            command(&["core".into(), "status".into(), "--json".into()]),
            Command::CoreStatus { json: true }
        );
        assert_eq!(command(&["core".into(), "stop".into()]), Command::CoreStop);
        assert!(matches!(command(&["core".into()]), Command::Usage(_)));
        assert!(matches!(
            command(&["core".into(), "--help".into()]),
            Command::Usage(_)
        ));
        assert_eq!(
            command(&["bots".into(), "--json".into()]),
            Command::BotsJson { standalone: false }
        );
        assert_eq!(
            command(&["bots".into(), "--json".into(), "--standalone".into()]),
            Command::BotsJson { standalone: true }
        );
        assert_eq!(
            command(&[]),
            Command::Interactive(terminal::InteractiveMode::Auto)
        );
        assert_eq!(
            command(&["bots".into()]),
            Command::Interactive(terminal::InteractiveMode::Bots)
        );
        assert_eq!(
            command(&["--classic".into()]),
            Command::Interactive(terminal::InteractiveMode::Classic)
        );
        assert_eq!(
            command(&["exec".into()]),
            Command::OrdinaryExec(Box::default())
        );
    }
}
