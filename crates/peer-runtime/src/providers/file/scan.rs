//! Bounded filesystem observations. Search has the original full-path UTF-16
//! ordering; directory presentation uses the process locale.
use super::*;
use locale::FileLocale;
pub(super) const ITEMS: usize = 16384;
pub(super) const PATH_BYTES: usize = 4 * 1024 * 1024;
pub(super) const RESULT_BYTES: usize = 256 * 1024;
pub(super) const SEARCH_BYTES: usize = 1_000_000;
#[derive(Default)]
struct Budget {
    items: usize,
    bytes: usize,
}
impl Budget {
    fn path(&mut self, path: &Path) -> Result<(), HostError> {
        self.items += 1;
        self.bytes = self.bytes.saturating_add(path.as_os_str().len());
        if self.items > ITEMS || self.bytes > PATH_BYTES {
            return Err(HostError("file_collection_limit"));
        }
        Ok(())
    }
}
pub(super) fn display(workspace: &Path, path: &Path) -> String {
    let a: Vec<_> = workspace.components().collect();
    let b: Vec<_> = path.components().collect();
    let common = a.iter().zip(&b).take_while(|(a, b)| a == b).count();
    let mut relative = PathBuf::new();
    for _ in common..a.len() {
        relative.push("..");
    }
    for part in &b[common..] {
        relative.push(part.as_os_str());
    }
    if relative.as_os_str().is_empty() {
        ".".into()
    } else {
        relative.to_string_lossy().into()
    }
}
pub(super) fn bounded(result: &Value) -> Result<(), HostError> {
    bounded_to(result, RESULT_BYTES)
}
pub(super) fn bounded_to(result: &Value, limit: usize) -> Result<(), HostError> {
    struct Counter(usize, usize);
    impl std::io::Write for Counter {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0 = self.0.saturating_add(b.len());
            if self.0 > self.1 {
                return Err(std::io::Error::other("file_result_limit"));
            }
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }
    serde_json::to_writer(Counter(0, limit), result).map_err(|_| HostError("file_result_limit"))
}
enum EntryType {
    Dir,
    File,
    Other,
}

fn visit_entries(
    path: &Path,
    run: &RunGuard,
    mut visit: impl FnMut(std::ffi::OsString, EntryType) -> Result<(), HostError>,
) -> Result<(), HostError> {
    let unavailable = |_| HostError("file_unavailable");
    if run.port.confined_reads {
        use rustix::fs::{AtFlags, Dir, FileType, statat};
        use std::os::unix::ffi::OsStrExt;
        let directory = target::directory(path)?;
        let entries = Dir::read_from(&directory).map_err(unavailable)?;
        for entry in entries {
            run.cancel()?;
            let entry = entry.map_err(unavailable)?;
            let name = entry.file_name();
            if matches!(name.to_bytes(), b"." | b"..") {
                continue;
            }
            let kind = match entry.file_type() {
                FileType::Unknown => FileType::from_raw_mode(
                    statat(&directory, name, AtFlags::SYMLINK_NOFOLLOW)
                        .map_err(unavailable)?
                        .st_mode,
                ),
                kind => kind,
            };
            visit(
                std::ffi::OsStr::from_bytes(name.to_bytes()).into(),
                match kind {
                    FileType::Directory => EntryType::Dir,
                    FileType::RegularFile => EntryType::File,
                    _ => EntryType::Other,
                },
            )?;
        }
    } else {
        for entry in std::fs::read_dir(path).map_err(|_| HostError("file_unavailable"))? {
            run.cancel()?;
            let entry = entry.map_err(|_| HostError("file_unavailable"))?;
            let kind = entry
                .file_type()
                .map_err(|_| HostError("file_unavailable"))?;
            visit(
                entry.file_name(),
                if kind.is_dir() {
                    EntryType::Dir
                } else if kind.is_file() {
                    EntryType::File
                } else {
                    EntryType::Other
                },
            )?;
        }
    }
    Ok(())
}

pub(super) fn list(path: &Path, workspace: &Path, run: &RunGuard) -> Result<Value, HostError> {
    run.check()?;
    if !std::fs::metadata(path)
        .map_err(|_| HostError("file_unavailable"))?
        .is_dir()
    {
        return Err(HostError("not_a_directory"));
    }
    let mut budget = Budget::default();
    let mut entries = Vec::new();
    visit_entries(path, run, |name, kind| {
        let target = path.join(&name);
        budget.path(&target)?;
        let name = name
            .into_string()
            .map_err(|_| HostError("file_path_encoding"))?;
        entries.push(json!({"name":name,"path":display(workspace,&target),"type":match kind { EntryType::Dir=>"directory",EntryType::File=>"file",EntryType::Other=>"other"}}));
        Ok(())
    })?;
    let locale = FileLocale::current()?;
    entries
        .sort_by(|a, b| locale.compare(a["name"].as_str().unwrap(), b["name"].as_str().unwrap()));
    run.check()?;
    let result = json!({"path":display(workspace,path),"entries":entries});
    bounded(&result)?;
    Ok(result)
}
fn files(path: &Path, run: &RunGuard) -> Result<Vec<PathBuf>, HostError> {
    run.check()?;
    let meta = std::fs::metadata(path).map_err(|_| HostError("file_unavailable"))?;
    if meta.is_file() {
        return Ok(vec![path.into()]);
    }
    if !meta.is_dir() {
        return Err(HostError("not_a_file_or_directory"));
    }
    let mut budget = Budget::default();
    let mut pending = vec![path.to_owned()];
    let mut files = Vec::new();
    while let Some(dir) = pending.pop() {
        run.check()?;
        visit_entries(&dir, run, |name, kind| {
            if name == ".git" || name == "node_modules" {
                return Ok(());
            }
            let path = dir.join(&name);
            budget.path(&path)?;
            if path.to_str().is_none() {
                return Err(HostError("file_path_encoding"));
            }
            if matches!(kind, EntryType::Dir) {
                pending.push(path);
            } else if matches!(kind, EntryType::File) {
                files.push(path);
            }
            Ok(())
        })?;
    }
    files.sort_by(|a, b| {
        a.to_str()
            .unwrap()
            .encode_utf16()
            .cmp(b.to_str().unwrap().encode_utf16())
    });
    Ok(files)
}
pub(super) fn search(
    path: &Path,
    workspace: &Path,
    args: &Value,
    run: &RunGuard,
) -> Result<Value, HostError> {
    let query = string(args, "query")?;
    if peer_protocol::javascript_trim(query).is_empty() {
        return Err(HostError("invalid_query"));
    }
    let maximum = args["max_results"]
        .as_f64()
        .unwrap_or(50.0)
        .floor()
        .clamp(1.0, 200.0) as usize;
    let sensitive = args["case_sensitive"] == true;
    let locale = FileLocale::current()?;
    let needle = if sensitive {
        query.to_owned()
    } else {
        locale.lower(query)
    };
    let mut matches = Vec::new();
    let mut bytes = 0usize;
    for file in files(path, run)? {
        run.check()?;
        if matches.len() >= maximum {
            break;
        }
        // Per-file read errors are skipped by the original search algorithm.
        // Cancellation and the overall result budget stay outside this branch.
        let Ok(raw) = run
            .open_read(&file)
            .and_then(|mut file| read_handle_bytes(&mut file, SEARCH_BYTES))
        else {
            continue;
        };
        let content = String::from_utf8_lossy(&raw);
        if content.contains('\0') {
            continue;
        }
        let mut lines = content.split('\n').enumerate().peekable();
        while let Some((index, line)) = lines.next() {
            run.cancel()?;
            let line = if lines.peek().is_some() {
                line.strip_suffix('\r').unwrap_or(line)
            } else {
                line
            };
            let haystack = if sensitive {
                std::borrow::Cow::Borrowed(line)
            } else {
                std::borrow::Cow::Owned(locale.lower(line))
            };
            if haystack.contains(&needle) {
                bytes = bytes
                    .saturating_add(line.len())
                    .saturating_add(file.as_os_str().len());
                if bytes > RESULT_BYTES {
                    return Err(HostError("file_result_limit"));
                }
                matches.push(json!({"path":display(workspace,&file),"line":index+1,"text":line}));
            }
            if matches.len() >= maximum {
                break;
            }
        }
    }
    run.check()?;
    let result = json!({"query":query,"path":display(workspace,path),"matchCount":matches.len(),"truncated":matches.len()>=maximum,"matches":matches});
    bounded(&result)?;
    Ok(result)
}
