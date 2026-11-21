//! Read configured Hook policy from the legacy global and workspace sources.
use crate::{StoreError, files};
use peer_protocol::{JsonLimits, decode_json_bounded};
use serde_json::Value;
use std::path::{Path, PathBuf};

const MAX_CONFIG: usize = 256 * 1024;
const MAX_HOOKS: usize = 128;
const MAX_COMMAND: usize = 16 * 1024;
const MAX_PATTERN: usize = 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum HookPhase {
    PreToolUse,
    PostToolUse,
}

impl HookPhase {
    pub fn name(self) -> &'static str {
        match self {
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
        }
    }
}

pub struct HookDefinition {
    pub id: String,
    pub command: String,
    pub capability_pattern: String,
    pub argument_pattern: Option<String>,
    pub timeout_ms: u64,
    pub fail_open: bool,
}

pub struct HookConfig {
    sources: [HookConfigSource; 2],
    pre: Vec<HookDefinition>,
    post: Vec<HookDefinition>,
}

struct HookConfigSource {
    path: PathBuf,
    file: Option<files::FileIdentity>,
    directory: Option<(u64, u64)>,
}

impl HookConfigSource {
    fn observe(path: PathBuf) -> Result<Self, StoreError> {
        let file = files::identity(&path)?;
        let directory = if file.is_some() {
            Some(Self::parent_identity(&path)?)
        } else {
            None
        };
        Ok(Self {
            path,
            file,
            directory,
        })
    }

    fn parent_identity(path: &Path) -> Result<(u64, u64), StoreError> {
        let parent = path.parent().ok_or(StoreError::InvalidInput)?;
        let identified = files::identity(parent)?.ok_or(StoreError::VersionChanged)?;
        Ok((identified.dev, identified.ino))
    }

    fn check_current(&self) -> Result<(), StoreError> {
        if files::identity(&self.path)? != self.file
            || self
                .directory
                .is_some_and(|expected| Self::parent_identity(&self.path).ok() != Some(expected))
        {
            return Err(StoreError::VersionChanged);
        }
        Ok(())
    }
}

impl HookConfig {
    pub fn observe(data_home: &Path, workspace: &Path) -> Result<Self, StoreError> {
        let sources = [
            HookConfigSource::observe(data_home.join("hooks/hooks.json"))?,
            HookConfigSource::observe(workspace.join(".peer/hooks.json"))?,
        ];
        let mut pre = Vec::new();
        let mut post = Vec::new();
        for source in &sources {
            let Some(bytes) = files::read(&source.path, MAX_CONFIG)? else {
                continue;
            };
            let config = decode_json_bounded(
                &bytes,
                JsonLimits {
                    bytes: MAX_CONFIG,
                    nodes: 16_384,
                    depth: 16,
                    string_bytes: MAX_CONFIG,
                },
            )
            .map_err(|_| StoreError::HistoryCorrupt)?;
            let hooks = &config.value["hooks"];
            if !config.value.is_object() || !(hooks.is_null() || hooks.is_object()) {
                return Err(StoreError::HistoryCorrupt);
            }
            rules(hooks, HookPhase::PreToolUse, &mut pre)?;
            rules(hooks, HookPhase::PostToolUse, &mut post)?;
        }
        let result = Self { sources, pre, post };
        result.check_current()?;
        Ok(result)
    }

    pub fn check_current(&self) -> Result<(), StoreError> {
        for source in &self.sources {
            source.check_current()?;
        }
        Ok(())
    }

    pub fn rules(&self, phase: HookPhase) -> &[HookDefinition] {
        match phase {
            HookPhase::PreToolUse => &self.pre,
            HookPhase::PostToolUse => &self.post,
        }
    }
}

fn rules(
    hooks: &Value,
    phase: HookPhase,
    selected: &mut Vec<HookDefinition>,
) -> Result<(), StoreError> {
    let Some(definitions) = hooks[phase.name()].as_array() else {
        return Ok(());
    };
    if selected.len() + definitions.len() > MAX_HOOKS {
        return Err(StoreError::HistoryLimit);
    }
    for item in definitions {
        let Some(command) = item["command"].as_str().filter(|s| !s.is_empty()) else {
            continue;
        };
        if command.len() > MAX_COMMAND || command.contains('\0') {
            return Err(StoreError::InvalidInput);
        }
        let pattern = &item["match"];
        let capability_pattern = pattern["capabilityId"].as_str().unwrap_or("*");
        let argument_pattern = pattern["argumentsPattern"].as_str();
        if capability_pattern.len() > MAX_PATTERN
            || argument_pattern.is_some_and(|p| p.len() > MAX_PATTERN)
        {
            return Err(StoreError::HistoryLimit);
        }
        let timeout_ms = match item["timeoutMs"].as_f64() {
            None => 3000,
            Some(ms) if (1.0..=60_000.0).contains(&ms) => ms as u64,
            Some(_) => return Err(StoreError::InvalidInput),
        };
        selected.push(HookDefinition {
            id: item["id"].as_str().unwrap_or(command).into(),
            command: command.into(),
            capability_pattern: capability_pattern.into(),
            argument_pattern: argument_pattern.map(str::to_owned),
            timeout_ms,
            fail_open: item["onError"] == "fail-open" || item["onFailure"] == "open",
        });
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn configured_hooks_observe_legacy_order_defaults_and_the_original_files() {
        let root = tempfile::tempdir().unwrap();
        let workspace = root.path().join("workspace");
        let home = root.path().join("home");
        let global = home.join("hooks/hooks.json");
        let local = workspace.join(".peer/hooks.json");
        for (path, value) in [
            (
                &global,
                json!({"hooks":{"PreToolUse":[{"command":"check global","onFailure":"open"}]}}),
            ),
            (
                &local,
                json!({"hooks":{"PreToolUse":[{"id":"local","command":"check local","match":{"capabilityId":"local.*","argumentsPattern":"sample?"},"timeoutMs":500}],"PostToolUse":[{"command":"observe result"}]}}),
            ),
        ] {
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, value.to_string()).unwrap();
        }
        let catalog = HookConfig::observe(&home, &workspace).unwrap();
        let rules = catalog.rules(HookPhase::PreToolUse);
        assert_eq!(
            rules
                .iter()
                .map(|rule| rule.id.as_str())
                .collect::<Vec<_>>(),
            ["check global", "local"]
        );
        assert!(rules[0].fail_open);
        assert_eq!(rules[0].timeout_ms, 3000);
        assert_eq!(rules[1].argument_pattern.as_deref(), Some("sample?"));
        assert_eq!(
            catalog.rules(HookPhase::PostToolUse)[0].command,
            "observe result"
        );
        catalog.check_current().unwrap();
        std::fs::write(&global, b"{}").unwrap();
        assert_eq!(catalog.check_current(), Err(StoreError::VersionChanged));
    }
}
