use peer_protocol::CliExit;
use std::io::{self, Write};
fn field(value: &str, label: bool) -> io::Result<String> {
    let mut output = String::new();
    let mut whitespace = false;
    for c in value.chars() {
        if label && matches!(c, '\t' | '\r' | '\n') {
            if !whitespace {
                output.push(' ');
            }
            whitespace = true;
            continue;
        }
        whitespace = false;
        if c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {
            return Err(io::Error::other("model_catalog_terminal_text_invalid"));
        }
        output.push(c);
    }
    Ok(output)
}
pub fn run() -> io::Result<CliExit> {
    let home = peer_protocol::data_home();
    let rows = match peer_runtime::model_catalog::load(home.as_deref()) {
        Ok(rows) => rows,
        Err(error) => {
            writeln!(io::stderr(), "peer models: {}", error.code)?;
            return Ok(CliExit::Runtime);
        }
    };
    if rows.is_empty() {
        writeln!(io::stderr(), "No model configured.")?;
        return Ok(CliExit::Ok);
    }
    let lines = rows
        .iter()
        .map(|row| {
            Ok(format!(
                "{}\t{}\t{}",
                field(&row.provider_id, false)?,
                field(&row.model_id, false)?,
                field(&row.display_name, true)?
            ))
        })
        .collect::<io::Result<Vec<_>>>()?;
    writeln!(io::stdout(), "{}", lines.join("\n"))?;
    Ok(CliExit::Ok)
}
