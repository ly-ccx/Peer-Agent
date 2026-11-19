//! Native `peer bots --json` machine-readable Bot roster listing (ADR 80, ADR 122, ADR 129).

use peer_project_agent::{NativeProjectHost, bot_list_json};
use peer_protocol::{CliExit, data_home};
use std::io::{self, Write};

pub fn list_json() -> io::Result<CliExit> {
    let Some(home) = data_home() else {
        writeln!(io::stderr(), "peer bots: data home unavailable")?;
        return Ok(CliExit::Runtime);
    };
    let host = match NativeProjectHost::new(&home, crate::VERSION.trim(), None) {
        Ok(h) => h,
        Err(err) => {
            writeln!(io::stderr(), "peer bots: {}", err.code)?;
            return Ok(CliExit::Runtime);
        }
    };
    let payload = bot_list_json(&host);
    host.close();
    let encoded = serde_json::to_string(&payload).map_err(io::Error::other)?;
    crate::finish_stdout(writeln!(
        io::stdout(),
        "{}",
        crate::text::escape_json_controls(&encoded)
    ))?;
    Ok(CliExit::Ok)
}
