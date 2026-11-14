#![forbid(unsafe_code)]

pub mod terminal;

pub const VERSION: &str = include_str!("../../../VERSION");

#[derive(Debug, PartialEq, Eq)]
pub enum Command {
    Version,
    Help,
    Doctor,
    Interactive,
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
        return Command::Help;
    }
    match argv.first().map(String::as_str) {
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
