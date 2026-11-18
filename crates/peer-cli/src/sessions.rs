use peer_protocol::CliExit;
use std::io::{self, IsTerminal, Write};
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

pub fn delete(id: &str, yes: bool) -> io::Result<CliExit> {
    let Some(home) = peer_protocol::data_home() else {
        writeln!(io::stderr(), "peer sessions: data home unavailable")?;
        return Ok(CliExit::Runtime);
    };
    match peer_store::session_delete_exists(&home, id) {
        Ok(true) => (),
        Ok(false) => {
            writeln!(io::stderr(), "peer sessions: session not found: {id}")?;
            return Ok(CliExit::Runtime);
        }
        Err(error) => return delete_error(error, id),
    }
    if !yes {
        if !io::stdin().is_terminal() {
            writeln!(io::stderr(), "peer sessions delete needs a TTY or --yes.")?;
            return Ok(CliExit::Usage);
        }
        write!(io::stderr(), "Delete session {id}? [y/N] ")?;
        io::stderr().flush()?;
        let mut answer = String::new();
        io::stdin().read_line(&mut answer)?;
        if !matches!(answer.trim().to_ascii_lowercase().as_str(), "y" | "yes") {
            writeln!(io::stderr(), "Delete cancelled.")?;
            return Ok(CliExit::Ok);
        }
    }
    match peer_store::delete_session(&home, id) {
        Ok(()) => {
            writeln!(io::stdout(), "Deleted session {id}.")?;
            Ok(CliExit::Ok)
        }
        Err(error) => delete_error(error, id),
    }
}

fn delete_error(error: peer_store::StoreError, id: &str) -> io::Result<CliExit> {
    if error == peer_store::StoreError::NotFound {
        writeln!(io::stderr(), "peer sessions: session not found: {id}")?;
    } else {
        writeln!(io::stderr(), "peer sessions: {}", error.code())?;
    }
    Ok(CliExit::Runtime)
}
