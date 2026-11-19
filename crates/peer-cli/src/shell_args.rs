//! Existing ADR108 grammar, kept separate from Runtime/ACP composition.
use crate::{Command, export::Options};
fn error(message: impl Into<String>) -> Command {
    Command::Usage(message.into())
}
pub(crate) fn parse(argv: &[String]) -> Option<Command> {
    match argv.first()?.as_str() {
        "doctor" => Some(if argv.len() == 1 {
            Command::Doctor
        } else {
            let arg = &argv[1];
            error(format!(
                "peer doctor: {} {}",
                if arg.starts_with('-') {
                    "unknown option"
                } else {
                    "unexpected argument"
                },
                crate::text::diagnostic(arg)
            ))
        }),
        "sessions" => Some(sessions(&argv[1..])),
        "export" => Some(export(&argv[1..])),
        _ => None,
    }
}
fn sessions(argv: &[String]) -> Command {
    let mut args = Vec::new();
    let mut yes = false;
    for arg in argv {
        if arg == "--yes" {
            yes = true;
        } else if arg.starts_with('-') {
            return error(format!(
                "peer sessions: unknown option {}",
                crate::text::diagnostic(arg)
            ));
        } else {
            args.push(arg);
        }
    }
    let Some(action) = args.first() else {
        return if yes {
            error("peer sessions: --yes is only valid with delete")
        } else {
            Command::SessionsList
        };
    };
    if action.as_str() == "list" {
        return if args.len() > 1 || yes {
            error("peer sessions list does not take arguments")
        } else {
            Command::SessionsList
        };
    }
    if !matches!(action.as_str(), "resume" | "delete") {
        return error(format!(
            "peer sessions: unexpected argument {}",
            crate::text::diagnostic(action)
        ));
    }
    if args.len() < 2 {
        return error(format!("peer sessions {action} requires a session id"));
    }
    if args.len() > 2 {
        return error(format!(
            "peer sessions: unexpected argument {}",
            crate::text::diagnostic(args[2])
        ));
    }
    if action.as_str() == "resume" && yes {
        return error("peer sessions: --yes is only valid with delete");
    }
    if action.as_str() == "delete" {
        return Command::SessionsDelete {
            id: args[1].clone(),
            yes,
        };
    }
    Command::SessionsResume(args[1].clone())
}
fn export(argv: &[String]) -> Command {
    let mut positional = Vec::new();
    let mut output_path = None;
    let mut force = false;
    let mut at = 0;
    while at < argv.len() {
        let arg = &argv[at];
        if arg == "--force" {
            force = true;
        } else if arg == "--output" {
            at += 1;
            let Some(value) = argv
                .get(at)
                .filter(|s| !s.is_empty() && !s.starts_with('-'))
            else {
                return error("peer export: --output requires a path");
            };
            output_path = Some(value.clone());
        } else if let Some(value) = arg.strip_prefix("--output=") {
            if value.is_empty() {
                return error("peer export: --output requires a path");
            }
            output_path = Some(value.to_owned());
        } else if arg.starts_with('-') {
            return error(format!(
                "peer export: unknown option {}",
                crate::text::diagnostic(arg)
            ));
        } else {
            positional.push(arg.clone());
        }
        at += 1;
    }
    let Some(session_id) = positional.first().filter(|s| !s.is_empty()) else {
        return error("peer export requires a session id");
    };
    if let Some(extra) = positional.get(1) {
        return error(format!(
            "peer export: unexpected argument {}",
            crate::text::diagnostic(extra)
        ));
    }
    Command::Export(Options {
        session_id: session_id.clone(),
        output_path,
        force,
    })
}
