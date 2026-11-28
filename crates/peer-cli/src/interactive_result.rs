use crate::Command;
use peer_protocol::{
    CliExit, data_home,
    interactive_result::{
        INTERACTIVE_RESULT_PREFIX, InteractiveAvailability, InteractiveResultReference,
    },
};
use peer_store::{InteractiveCleanupRequest, read_interactive_cleanup_receipt};
use std::io::{self, Read, Write};

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

pub fn cleanup_receipt(out: &mut impl Write, input: impl Read) -> io::Result<CliExit> {
    let mut bytes = Vec::new();
    input
        .take((InteractiveCleanupRequest::MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    let request = match InteractiveCleanupRequest::parse(&bytes) {
        Ok(request) => request,
        Err(error) => return cleanup_error(error.code()),
    };
    let Some(home) = data_home() else {
        return cleanup_error("interactive_retention_unavailable");
    };
    match read_interactive_cleanup_receipt(&home, &request) {
        Ok(Some(receipt)) => writeln!(out, "{}", crate::text::escape_json_controls(&receipt))?,
        Ok(None) => writeln!(out, "null")?,
        Err(error) => return cleanup_error(error.code()),
    }
    Ok(CliExit::Ok)
}

fn cleanup_error(code: &str) -> io::Result<CliExit> {
    // The legacy maintenance CLI exposes only interactive errors and the
    // existing material-unavailable code.
    let code = if code.starts_with("interactive_") || code == "material_snapshot_unavailable" {
        code
    } else {
        "interactive_retention_unavailable"
    };
    writeln!(io::stderr(), "peer interactive maintenance: {code}")?;
    Ok(match code {
        "interactive_cleanup_invalid" => CliExit::Usage,
        "interactive_scope_denied" | "interactive_retention_unavailable" => CliExit::Auth,
        _ => CliExit::Runtime,
    })
}
