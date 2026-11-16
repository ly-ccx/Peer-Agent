use peer_protocol::CliExit;
use std::io::{self, Write};
pub fn list() -> io::Result<CliExit> {
    let Some(home) = peer_protocol::data_home() else {
        writeln!(io::stderr(), "peer sessions: data home unavailable")?;
        return Ok(CliExit::Runtime);
    };
    let rows = match peer_store::ConversationStore::new(&home).list_sessions(None) {
        Ok(rows) => rows,
        Err(e) => {
            writeln!(io::stderr(), "peer sessions: {}", e.code())?;
            return Ok(CliExit::Runtime);
        }
    };
    if rows.is_empty() {
        writeln!(io::stderr(), "No sessions.")?;
        return Ok(CliExit::Ok);
    }
    let mut lines = Vec::new();
    for row in rows {
        let title = row
            .title
            .as_deref()
            .map(peer_protocol::javascript_trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("Untitled session");
        let title = crate::text::field(title, true)?;
        let updated = row
            .updated_at
            .as_deref()
            .map(peer_protocol::javascript_trim)
            .filter(|s| !s.is_empty())
            .unwrap_or("-");
        let updated = crate::text::field(updated, false)?;
        let role = if row.role == "default" {
            String::new()
        } else {
            format!("\t{}", row.role)
        };
        lines.push(format!("{updated}\t{}\t{title}{role}", row.id));
    }
    writeln!(io::stdout(), "{}", lines.join("\n"))?;
    Ok(CliExit::Ok)
}
