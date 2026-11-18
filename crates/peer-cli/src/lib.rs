#![forbid(unsafe_code)]

pub mod acp;
mod cancellation;
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

pub const VERSION: &str = include_str!("../../../VERSION");

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Acp,
    Help,
    Doctor,
    Interactive,
    Models,
    SessionsList,
    SessionsDelete { id: String, yes: bool },
    Completions(String),
    CompletionsHelp,
    Usage(String),
    ShellHelp(&'static str),
    Export(export::Options),
    Result { reference: String, json: bool },
    ResultHelp,
    Exec { plan: String, max_turns: usize },
    OrdinaryExec(Box<ordinary_exec::Options>),
    ExecHelp,
    Recover(String),
    RecoverSession(String),
    McpAuth { server: String, refresh: bool },
    ModelAuth { action: String, channel: String },
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
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--version" | "-v"))
    {
        return Command::Version;
    }
    if argv.first().is_some_and(|s| s == "exec") && argv.get(1).is_none_or(|s| s != "--plan") {
        return ordinary_exec::parse(&argv[1..]);
    }
    if argv.first().is_some_and(|s| s == "result") {
        return interactive_result::parse(&argv[1..]);
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
        None | Some("bots" | "--classic") if argv.len() <= 1 => Command::Interactive,
        Some(name) => Command::Unavailable(name.to_owned()),
        _ => Command::Interactive,
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
        assert_eq!(command(&[]), Command::Interactive);
        assert_eq!(
            command(&["exec".into()]),
            Command::OrdinaryExec(Box::default())
        );
    }
}
