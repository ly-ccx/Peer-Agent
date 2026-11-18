//! A reading copy has no authority to resume, authorize or settle a task.
mod destination;
mod format;
mod stdout;
use peer_protocol::CliExit;
use peer_store::{ConversationStore, DisplayEvent, DisplayReadError};
use std::io::{self, BufWriter, Seek, SeekFrom, Write};
#[derive(Debug, PartialEq, Eq)]
pub struct Options {
    pub session_id: String,
    pub output_path: Option<String>,
    pub force: bool,
}
fn operation(
    home: &std::path::Path,
    options: &Options,
    cancel: &std::sync::atomic::AtomicBool,
) -> io::Result<()> {
    let target = options
        .output_path
        .as_deref()
        .map(|p| destination::Destination::inspect(home, p, options.force))
        .transpose()?;
    let mut spool = tempfile::tempfile()?;
    let (source, last) = {
        let buffered = BufWriter::with_capacity(65536, &mut spool);
        let mut out = format::Tracked::new(buffered);
        let source = ConversationStore::new(home)
            .visit_display(&options.session_id, Some(cancel), |event| match event {
                DisplayEvent::Metadata(meta) => format::header(&mut out, meta, target.is_none()),
                DisplayEvent::Message(row) => format::message(&mut out, row, target.is_none()),
            })
            .map_err(|e| match e {
                DisplayReadError::Source(e) => io::Error::other(e.code()),
                DisplayReadError::Sink(e) => e,
            })?;
        (source, out.finish()?)
    };
    spool.set_len(last)?;
    spool.seek(SeekFrom::End(0))?;
    spool.write_all(b"\n")?;
    destination::check_cancel(cancel)?;
    source
        .validate()
        .map_err(|_| io::Error::other("export_source_changed"))?;
    if let Some(target) = target {
        target.publish(&source, &mut spool, cancel)?;
    } else {
        crate::finish_stdout(stdout::copy(&mut spool, cancel))?;
    }
    Ok(())
}
pub fn run(options: &Options) -> io::Result<CliExit> {
    let Some(home) = peer_protocol::data_home() else {
        writeln!(io::stderr(), "peer export: data home unavailable")?;
        return Ok(CliExit::Runtime);
    };
    crate::cancellation::run_blocking(|cancel| {
        match operation(&home, options, &cancel).and_then(|()| {
            if let Some(path) = &options.output_path {
                crate::finish_stdout(stdout::text(
                    &format!(
                        "Exported {} to {}\n",
                        options.session_id,
                        crate::text::diagnostic(path)
                    ),
                    &cancel,
                ))
                .map_err(|e| {
                    io::Error::new(e.kind(), format!("export_publication_unknown: {e}"))
                })?;
            }
            Ok(())
        }) {
            Ok(()) => Ok(CliExit::Ok),
            Err(e) => {
                writeln!(io::stderr(), "peer export: {e}")?;
                Ok(if cancel.load(std::sync::atomic::Ordering::Acquire) {
                    CliExit::Cancelled
                } else if e.kind() == io::ErrorKind::AlreadyExists {
                    CliExit::Usage
                } else {
                    CliExit::Runtime
                })
            }
        }
    })?
}
