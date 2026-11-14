//! Registered project.instructions Source. Discovery inputs belong to the Host;
//! ordinary files and model arguments cannot register or select a Source.
mod files;
mod settings;
use super::section;
use crate::CancellationToken;
use peer_protocol::javascript_trim;
use serde_json::{Value, json};
use std::path::{Component, Path, PathBuf};

const MAX_UNITS: usize = 24_000;
const MAX_CANDIDATES: usize = 64;
const MAX_TOTAL_BYTES: usize = 4 * 1024 * 1024;

pub struct ConfigInstruction {
    pub id: String,
    pub title: String,
    pub content: String,
    pub source: Option<String>,
    pub priority: i64,
}
/// The existing Source input seam, not a model-visible execution interface.
pub struct InstructionInput<'a> {
    pub workspace: &'a Path,
    pub data_home: &'a Path,
    pub include_global: bool,
    pub config: &'a [ConfigInstruction],
    pub target_paths: &'a [PathBuf],
}
#[derive(Default)]
pub struct ProjectInstructions {
    sections: Vec<Value>,
}
fn normalized(path: &Path) -> Result<PathBuf, &'static str> {
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map_err(|_| "context_instruction_path_invalid")?
            .join(path)
    };
    let mut result = PathBuf::new();
    for part in absolute.components() {
        match part {
            Component::ParentDir => {
                result.pop();
            }
            Component::CurDir => {}
            _ => result.push(part.as_os_str()),
        }
    }
    Ok(result)
}
fn inside(parent: &Path, child: &Path) -> bool {
    child.strip_prefix(parent).is_ok_and(|relative| {
        // Preserve the existing Source's path.relative(...).startsWith('..').
        !relative.to_string_lossy().starts_with("..")
    })
}
fn identifier(raw: &str) -> String {
    raw.to_lowercase()
        .encode_utf16()
        .map(|unit| {
            if unit <= 127
                && ((unit as u8).is_ascii_alphanumeric() || b"._-".contains(&(unit as u8)))
            {
                char::from(unit as u8)
            } else {
                '-'
            }
        })
        .collect()
}
fn trim(raw: &str) -> (String, usize, usize, bool) {
    let original = raw.encode_utf16().count();
    if original <= MAX_UNITS {
        return (javascript_trim(raw).into(), original, original, false);
    }
    let mut included = 0;
    let mut end = 0;
    for c in raw.chars() {
        if included + c.len_utf16() > MAX_UNITS {
            break;
        }
        included += c.len_utf16();
        end += c.len_utf8();
    }
    let content = raw[..end]
        .trim_end_matches(|c: char| {
            let mut buffer = [0; 4];
            javascript_trim(c.encode_utf8(&mut buffer)).is_empty()
        })
        .into();
    (content, original, included, true)
}
impl ProjectInstructions {
    pub fn observe(workspace: &Path) -> Result<Self, &'static str> {
        Self::observe_input(
            &InstructionInput {
                workspace,
                data_home: workspace,
                include_global: false,
                config: &[],
                target_paths: &[],
            },
            &CancellationToken::new(),
        )
    }
    /// Current TUI Host defaults: prompt settings participate even when the
    /// settings file is absent. Global instructions remain opt-in at the Source.
    pub fn observe_host(
        workspace: &Path,
        data_home: &Path,
        cancel: &CancellationToken,
    ) -> Result<Self, &'static str> {
        let config = settings::read_host_prompt_settings(data_home, cancel)?;
        Self::observe_input(
            &InstructionInput {
                workspace,
                data_home,
                include_global: false,
                config: &config,
                target_paths: &[],
            },
            cancel,
        )
    }
    pub fn observe_input(
        input: &InstructionInput<'_>,
        cancel: &CancellationToken,
    ) -> Result<Self, &'static str> {
        Self::observe_inner(input, cancel, |_| {})
    }
    fn observe_inner(
        input: &InstructionInput<'_>,
        cancel: &CancellationToken,
        mut after_read: impl FnMut(&Path),
    ) -> Result<Self, &'static str> {
        let check = || {
            if cancel.is_cancelled() {
                Err("cancelled")
            } else {
                Ok(())
            }
        };
        check()?;
        if input.config.len() > MAX_CANDIDATES || input.target_paths.len() > MAX_CANDIDATES {
            return Err("context_instruction_limit");
        }
        let mut total = input
            .workspace
            .as_os_str()
            .len()
            .checked_add(input.data_home.as_os_str().len())
            .ok_or("context_instruction_limit")?;
        for target in input.target_paths {
            total = total
                .checked_add(target.as_os_str().len())
                .ok_or("context_instruction_limit")?;
        }
        if total > MAX_TOTAL_BYTES {
            return Err("context_instruction_limit");
        }
        let workspace = normalized(input.workspace)?;
        let mut sections = Vec::new();
        let mut config_count = 0;
        for (index, item) in input.config.iter().enumerate() {
            check()?;
            for length in [
                item.id.len(),
                item.title.len(),
                item.content.len(),
                item.source.as_deref().map_or(0, str::len),
            ] {
                total = total
                    .checked_add(length)
                    .ok_or("context_instruction_limit")?;
            }
            if total > MAX_TOTAL_BYTES {
                return Err("context_instruction_limit");
            }
            if item.content.is_empty() {
                continue;
            }
            config_count += 1;
            let id = if item.id.is_empty() {
                format!("instruction-{}", index + 1)
            } else {
                item.id.clone()
            };
            let title = if !item.title.is_empty() {
                item.title.clone()
            } else if !item.id.is_empty() {
                item.id.clone()
            } else {
                format!("Instruction {}", index + 1)
            };
            let source = item.source.as_deref().filter(|s| !s.is_empty());
            let (content, original, included, truncated) = trim(&item.content);
            if content.is_empty() {
                continue;
            }
            let notice = if truncated {
                format!(
                    "\n\n\n[Config instruction truncated: included {included} of {original} chars.]"
                )
            } else {
                String::new()
            };
            let from = match source {
                Some(source) => format!(": {source}"),
                None => ".".into(),
            };
            sections.push(section(&format!("project.instructions.config.{}",identifier(&id)),"L3_INSTRUCTIONS",item.priority,
                &format!("Project instructions: {title}"),
                format!("Project instructions from configured Peer Agent settings{from}\nThese instructions are configured guidance. Follow them unless they conflict with higher-priority core system rules, tool contracts, permission requirements, evidence discipline, or workspace-scoped instructions.\n{content}{notice}"),
                json!({"id":"project.instructions","kind":"config","path":source,"scope":"config","filename":null,"title":title,"truncated":truncated,"originalChars":original,"includedChars":included}),"user"));
        }
        let mut candidates = Vec::new();
        let mut priority = config_count;
        if input.include_global {
            candidates.push((
                normalized(input.data_home)?.join("AGENTS.md"),
                "global",
                priority,
            ));
            priority += 1;
        }
        let mut dirs = vec![workspace.clone()];
        for target in input.target_paths {
            check()?;
            let target = normalized(&workspace.join(target))?;
            if !inside(&workspace, &target) {
                continue;
            }
            let target_dir = if target.is_dir() {
                target
            } else {
                target.parent().unwrap().to_owned()
            };
            if !inside(&workspace, &target_dir) {
                continue;
            }
            let mut current = workspace.clone();
            for part in target_dir.strip_prefix(&workspace).unwrap().components() {
                current.push(part.as_os_str());
                if !dirs.contains(&current) {
                    if dirs.len() >= MAX_CANDIDATES / 2 {
                        return Err("context_instruction_limit");
                    }
                    dirs.push(current.clone());
                }
            }
        }
        for dir in dirs {
            let scope = if dir == workspace {
                "workspace"
            } else {
                "scoped"
            };
            for filename in ["AGENTS.md", "CLAUDE.md"] {
                candidates.push((dir.join(filename), scope, priority));
                priority += 1;
            }
        }
        if candidates.len() + input.config.len() > MAX_CANDIDATES {
            return Err("context_instruction_limit");
        }
        let mut seen = Vec::new();
        for (path, scope, priority) in candidates {
            check()?;
            if seen.contains(&path) {
                continue;
            }
            seen.push(path.clone());
            let Some(raw) = files::read(&path, &mut total, cancel, &mut after_read)? else {
                continue;
            };
            let (content, original, included, truncated) = trim(&raw);
            if content.is_empty() {
                continue;
            }
            let filename = path
                .file_name()
                .and_then(|s| s.to_str())
                .ok_or("context_instruction_path_invalid")?;
            let relative = if scope == "global" {
                path.to_str()
            } else {
                path.strip_prefix(&workspace).unwrap().to_str()
            }
            .ok_or("context_instruction_path_invalid")?;
            let id = if scope == "global" {
                format!("project.instructions.global.{}", filename.to_lowercase())
            } else {
                format!(
                    "project.instructions.{}",
                    identifier(&relative.replace(std::path::MAIN_SEPARATOR, "."))
                )
            };
            let notice = if truncated {
                format!(
                    "\n\n\n[Instruction file truncated: included {included} of {original} chars.]"
                )
            } else {
                String::new()
            };
            sections.push(section(&id,"L3_INSTRUCTIONS",priority,&format!("Project instructions: {filename}"),
                format!("Project instructions from {relative}.\nThese instructions are workspace guidance. Follow them unless they conflict with higher-priority core system rules, tool contracts, permission requirements, or evidence discipline.\n{content}{notice}"),
                json!({"id":"project.instructions","kind":if scope=="global"{"global-file"}else{"workspace-file"},"path":path,"scope":scope,"filename":filename,"title":null,"truncated":truncated,"originalChars":original,"includedChars":included}),"workspace"));
        }
        check()?;
        Ok(Self { sections })
    }
    pub fn sections(&self) -> Vec<Value> {
        self.sections.clone()
    }
}

#[cfg(test)]
mod tests;
