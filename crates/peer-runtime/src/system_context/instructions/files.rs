//! Stable regular-file observation shared by instructions and prompt settings.
use crate::CancellationToken;
use std::{fs::Metadata, io::Read, path::Path};
const MAX_FILE_BYTES: usize = 1024 * 1024;
fn same(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev()
            && a.ino() == b.ino()
            && a.len() == b.len()
            && a.mtime() == b.mtime()
            && a.mtime_nsec() == b.mtime_nsec()
            && a.ctime() == b.ctime()
            && a.ctime_nsec() == b.ctime_nsec()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}
pub(super) fn read(
    path: &Path,
    total: &mut usize,
    cancel: &CancellationToken,
    after_read: &mut impl FnMut(&Path),
) -> Result<Option<String>, &'static str> {
    if cancel.is_cancelled() {
        return Err("cancelled");
    }
    let mut options = std::fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(
            (rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOCTTY).bits() as i32,
        );
    }
    let mut file = match options.open(path) {
        Ok(file) => file,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("context_instruction_unavailable"),
    };
    let before = file
        .metadata()
        .map_err(|_| "context_instruction_unavailable")?;
    if !before.is_file() {
        return Ok(None);
    }
    if before.len() > MAX_FILE_BYTES as u64 {
        return Err("context_instruction_limit");
    }
    let mut bytes = Vec::new();
    loop {
        if cancel.is_cancelled() {
            return Err("cancelled");
        }
        let mut block = [0; 16384];
        let n = file
            .read(&mut block)
            .map_err(|_| "context_instruction_unavailable")?;
        if n == 0 {
            break;
        }
        *total = total.checked_add(n).ok_or("context_instruction_limit")?;
        if bytes.len() + n > MAX_FILE_BYTES || *total > super::MAX_TOTAL_BYTES {
            return Err("context_instruction_limit");
        }
        bytes.extend_from_slice(&block[..n]);
    }
    after_read(path);
    let after = file.metadata().map_err(|_| "context_instruction_changed")?;
    let at_path = std::fs::metadata(path).map_err(|_| "context_instruction_changed")?;
    if !same(&before, &after) || !same(&before, &at_path) {
        return Err("context_instruction_changed");
    }
    String::from_utf8(bytes)
        .map(Some)
        .map_err(|_| "context_instruction_invalid_utf8")
}
