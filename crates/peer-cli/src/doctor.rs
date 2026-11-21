//! Read-only installation facts. No Helper execution, Vault or network access.
use peer_protocol::CliExit;
use std::{
    io::{self, IsTerminal, Write},
    path::{Path, PathBuf},
};
fn accessible(path: &Path, access: rustix::fs::Access) -> bool {
    rustix::fs::access(path, access).is_ok()
}
fn executable(path: &Path) -> bool {
    path.is_file() && accessible(path, rustix::fs::Access::EXEC_OK)
}
fn writable_directory(path: &Path) -> bool {
    let mut parent = path;
    loop {
        match std::fs::metadata(parent) {
            Ok(meta) => {
                return meta.is_dir()
                    && accessible(
                        parent,
                        rustix::fs::Access::WRITE_OK | rustix::fs::Access::EXEC_OK,
                    );
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {
                let Some(next) = parent.parent() else {
                    return false;
                };
                parent = next;
            }
            Err(_) => return false,
        }
    }
}
fn display(path: &Path) -> String {
    let text = path.to_string_lossy();
    if text
        .chars()
        .any(|c| c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
    {
        text.chars().flat_map(char::escape_default).collect()
    } else {
        text.into_owned()
    }
}
pub fn run() -> io::Result<CliExit> {
    let peer = std::env::current_exe()?;
    let helper = peer
        .parent()
        .unwrap_or(Path::new("."))
        .join("peer-credential-helper");
    let data = peer_protocol::data_home().map(|p| {
        if p.is_absolute() {
            p
        } else {
            std::env::current_dir()
                .unwrap_or(PathBuf::from("."))
                .join(p)
        }
    });
    let file_detail = |path: &Path| {
        if executable(path) {
            display(path)
        } else {
            format!("missing {}", display(path))
        }
    };
    let checks = [
        ("peer", executable(&peer), file_detail(&peer)),
        (
            "credential helper",
            executable(&helper),
            file_detail(&helper),
        ),
        (
            "data root",
            data.as_ref().is_some_and(|p| writable_directory(p)),
            data.as_ref()
                .map(|p| display(p))
                .unwrap_or_else(|| "not configured (HOME unavailable)".into()),
        ),
        (
            "version",
            !crate::VERSION.trim().is_empty(),
            crate::VERSION.trim().to_owned(),
        ),
    ];
    let mut out = io::stdout().lock();
    for (name, ok, detail) in &checks {
        writeln!(
            out,
            "{name}: {} {detail}",
            if *ok { "ok" } else { "failed" }
        )?;
    }
    writeln!(
        out,
        "terminal: {}",
        if io::stdin().is_terminal() {
            "tty"
        } else {
            "not a tty"
        }
    )?;
    writeln!(
        out,
        "color: {}",
        if std::env::var_os("NO_COLOR").is_none()
            && std::env::var("FORCE_COLOR").ok().as_deref() != Some("0")
        {
            "yes"
        } else {
            "no"
        }
    )?;
    let failed = checks
        .iter()
        .filter(|(_, ok, _)| !*ok)
        .map(|(name, _, _)| *name)
        .collect::<Vec<_>>();
    if !failed.is_empty() {
        writeln!(io::stderr(), "peer doctor: {} failed.", failed.join(", "))?;
        return Ok(CliExit::Runtime);
    }
    Ok(CliExit::Ok)
}
