#![forbid(unsafe_code)]

mod cancellation;
pub mod mcp;
pub mod model_auth;
pub mod models;
pub mod native_exec;
pub mod terminal;

pub const VERSION: &str = include_str!("../../../VERSION");

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Help,
    Doctor,
    Interactive,
    Models,
    Completions(String),
    CompletionsHelp,
    Usage(&'static str),
    Exec { plan: String, max_turns: usize },
    Recover(String),
    McpAuth { server: String, refresh: bool },
    ModelAuth { action: String, channel: String },
    Unavailable(String),
}

/// Preserve legacy version fast-path precedence before terminal initialization.
pub fn command(argv: &[String]) -> Command {
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--version" | "-v"))
    {
        return Command::Version;
    }
    if argv
        .iter()
        .any(|arg| matches!(arg.as_str(), "--help" | "-h"))
    {
        if argv.first().is_some_and(|s| s == "completions") {
            return Command::CompletionsHelp;
        }
        return Command::Help;
    }
    match argv.first().map(String::as_str) {
        Some("completions") => {
            if argv.len() == 2 && matches!(argv[1].as_str(), "bash" | "zsh" | "fish") {
                Command::Completions(argv[1].clone())
            } else {
                Command::Usage("Usage: peer completions <bash|zsh|fish>")
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
        Some("doctor") if argv.len() == 1 => Command::Doctor,
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
        assert_eq!(command(&["acp".into(), "--help".into()]), Command::Help);
        assert_eq!(command(&[]), Command::Interactive);
        assert_eq!(
            command(&["exec".into()]),
            Command::Unavailable("exec".into())
        );
    }
}
