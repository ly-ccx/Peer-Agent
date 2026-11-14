//! The registered project.instructions Source, observed by the Host once per
//! episode. Ordinary files/attachments cannot register themselves as Sources.
use super::section;
use peer_protocol::javascript_trim;
use serde_json::{Value, json};
use std::{
    fs::Metadata,
    io::Read,
    path::{Path, PathBuf},
};
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_UNITS: usize = 24_000;
#[derive(Default)]
pub struct ProjectInstructions {
    files: Vec<Instruction>,
}
struct Instruction {
    path: PathBuf,
    filename: &'static str,
    priority: i64,
    content: String,
    original: usize,
    included: usize,
    truncated: bool,
}
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
impl ProjectInstructions {
    pub fn observe(workspace: &Path) -> Result<Self, &'static str> {
        Self::observe_inner(workspace, |_| {})
    }
    fn observe_inner(
        workspace: &Path,
        mut after_read: impl FnMut(&Path),
    ) -> Result<Self, &'static str> {
        let mut files = Vec::new();
        for (priority, filename) in ["AGENTS.md", "CLAUDE.md"].into_iter().enumerate() {
            let path = workspace.join(filename);
            let mut options = std::fs::OpenOptions::new();
            options.read(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                // A path swap to a FIFO must not hang Context assembly.
                options.custom_flags(
                    (rustix::fs::OFlags::NONBLOCK | rustix::fs::OFlags::NOCTTY).bits() as i32,
                );
            }
            let mut file = match options.open(&path) {
                Ok(file) => file,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(_) => return Err("context_instruction_unavailable"),
            };
            let before = file
                .metadata()
                .map_err(|_| "context_instruction_unavailable")?;
            if !before.is_file() {
                continue;
            }
            if before.len() > MAX_FILE_BYTES as u64 {
                return Err("context_instruction_limit");
            }
            let mut bytes = Vec::new();
            file.by_ref()
                .take(MAX_FILE_BYTES as u64 + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| "context_instruction_unavailable")?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err("context_instruction_limit");
            }
            after_read(&path);
            let after = file.metadata().map_err(|_| "context_instruction_changed")?;
            let at_path = std::fs::metadata(&path).map_err(|_| "context_instruction_changed")?;
            if !same(&before, &after) || !same(&before, &at_path) {
                return Err("context_instruction_changed");
            }
            let raw = String::from_utf8(bytes).map_err(|_| "context_instruction_invalid_utf8")?;
            let original = raw.encode_utf16().count();
            let (content, included, truncated) = if original <= MAX_UNITS {
                (javascript_trim(&raw).into(), original, false)
            } else {
                let mut included = 0;
                let mut end = 0;
                for c in raw.chars() {
                    if included + c.len_utf16() > MAX_UNITS {
                        break;
                    }
                    included += c.len_utf16();
                    end += c.len_utf8();
                }
                // trimEnd uses the same ECMAScript whitespace set as the shared projector.
                let prefix = &raw[..end];
                let trimmed = prefix.trim_end_matches(|c: char| {
                    let mut buffer = [0; 4];
                    javascript_trim(c.encode_utf8(&mut buffer)).is_empty()
                });
                (trimmed.into(), included, true)
            };
            files.push(Instruction {
                path,
                filename,
                priority: priority as i64,
                content,
                original,
                included,
                truncated,
            });
        }
        Ok(Self { files })
    }
    pub(super) fn sections(&self) -> Vec<Value> {
        self.files.iter().filter(|f|!f.content.is_empty()).map(|f|{
            let notice=if f.truncated {format!("\n\n[Instruction file truncated: included {} of {} chars.]",f.included,f.original)}else{String::new()};
            let content=format!("Project instructions from {}.\nThese instructions are workspace guidance. Follow them unless they conflict with higher-priority core system rules, tool contracts, permission requirements, or evidence discipline.\n{}{}",f.filename,f.content,if notice.is_empty(){String::new()}else{format!("\n{notice}")});
            section(&format!("project.instructions.{}",f.filename.to_lowercase()),"L3_INSTRUCTIONS",f.priority,&format!("Project instructions: {}",f.filename),content,json!({"id":"project.instructions","kind":"workspace-file","path":f.path,"scope":"workspace","filename":f.filename,"title":null,"truncated":f.truncated,"originalChars":f.original,"includedChars":f.included}),"workspace")
        }).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use sha2::{Digest, Sha256};
    #[test]
    fn actual_ts_source_rendering_metadata_and_checksums_match_native_files() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/project-instructions.json"
        ))
        .unwrap();
        for c in data["cases"].as_array().unwrap() {
            let root = tempfile::tempdir().unwrap();
            for (file, content) in c["files"].as_object().unwrap() {
                std::fs::write(root.path().join(file), content.as_str().unwrap()).unwrap();
            }
            let instructions = ProjectInstructions::observe(root.path()).unwrap();
            let sections = instructions.sections();
            let normalized: Value = serde_json::from_str(
                &serde_json::to_string(&sections)
                    .unwrap()
                    .replace(root.path().to_str().unwrap(), "/synthetic/workspace"),
            )
            .unwrap();
            assert_eq!(normalized, c["expected"]["sections"]);
            let rendered = sections
                .iter()
                .map(|s| s["content"].as_str().unwrap())
                .collect::<Vec<_>>()
                .join("\n\n");
            assert_eq!(
                format!("{:x}", Sha256::digest(rendered.as_bytes())),
                c["expected"]["snapshot"]["renderedHash"]
            );
        }
    }
    #[test]
    fn changed_invalid_and_oversized_sources_fail_without_rewriting_the_file() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("AGENTS.md");
        std::fs::write(&file, "original").unwrap();
        assert!(matches!(
            ProjectInstructions::observe_inner(root.path(), |p| std::fs::write(
                p,
                "changed longer guidance"
            )
            .unwrap()),
            Err("context_instruction_changed")
        ));
        assert_eq!(
            std::fs::read_to_string(&file).unwrap(),
            "changed longer guidance"
        );
        for (bytes, error) in [
            (vec![0xff], "context_instruction_invalid_utf8"),
            (vec![b'x'; MAX_FILE_BYTES + 1], "context_instruction_limit"),
        ] {
            std::fs::write(&file, &bytes).unwrap();
            assert!(matches!(ProjectInstructions::observe(root.path()),Err(e) if e==error));
            assert_eq!(std::fs::read(&file).unwrap(), bytes);
        }
    }
}
