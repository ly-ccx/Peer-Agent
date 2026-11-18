use crate::Command;
use peer_protocol::{
    CliExit, data_home,
    interactive_result::{
        INTERACTIVE_RESULT_PREFIX, InteractiveAvailability, InteractiveResultReference,
    },
};
use std::io::{self, Write};

const USAGE: &str = "Usage: peer result <interactive-result://…> [--json]";

pub(crate) fn parse(arguments: &[String]) -> Command {
    if matches!(arguments, [help] if matches!(help.as_str(), "-h" | "--help")) {
        return Command::ResultHelp;
    }
    match arguments {
        [reference] if reference.starts_with(INTERACTIVE_RESULT_PREFIX) => Command::Result {
            reference: reference.clone(),
            json: false,
        },
        [reference, flag]
            if reference.starts_with(INTERACTIVE_RESULT_PREFIX) && flag == "--json" =>
        {
            Command::Result {
                reference: reference.clone(),
                json: true,
            }
        }
        _ => Command::Usage(USAGE.into()),
    }
}

pub fn help(out: &mut impl Write) -> io::Result<()> {
    writeln!(
        out,
        "peer {}\n\n{USAGE}\nRead a fixed result summary from the local Bot.",
        crate::VERSION.trim()
    )
}

pub fn run(out: &mut impl Write, locator: &str, json: bool) -> io::Result<CliExit> {
    let Some(reference) = InteractiveResultReference::parse(locator) else {
        writeln!(io::stderr(), "peer result: invalid fixed result reference")?;
        return Ok(CliExit::Usage);
    };
    let Some(home) = data_home() else {
        writeln!(io::stderr(), "peer result: interactive_result_unavailable")?;
        return Ok(CliExit::Runtime);
    };
    let mut result = match peer_store::read_interactive_result(&home, &reference) {
        Ok(result) => result,
        Err(error) => {
            writeln!(io::stderr(), "peer result: {}", error.code())?;
            return Ok(if error.scope_denied() {
                CliExit::Auth
            } else {
                CliExit::Runtime
            });
        }
    };
    super::text::strip_terminal_controls(&mut result.title);
    super::text::strip_terminal_controls(&mut result.text_fallback.text);
    if json {
        serde_json::to_writer(&mut *out, &result)?;
        writeln!(out)?;
    } else {
        writeln!(
            out,
            "{}\n{}\nAvailability: {}",
            result.title,
            result.locator,
            result.availability.as_str()
        )?;
        if result.availability == InteractiveAvailability::OriginOnly {
            writeln!(out, "The result is stored on the original device.")?;
        }
        writeln!(
            out,
            "Source: {} / {}",
            result.source.conversation_id, result.source.tool_call_id
        )?;
        let truncated = if result.truncated { " (truncated)" } else { "" };
        writeln!(
            out,
            "Saved model summary, unverified{truncated}\n{}{}",
            result.text_fallback.text,
            result.text_fallback.suffix()
        )?;
    }
    Ok(CliExit::Ok)
}
