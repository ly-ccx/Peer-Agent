//! Read-only view of the shared Skill installation and workspace mount settings.
use crate::{SkillManifest, StoreError, files};
use serde_json::Value;
use std::{
    collections::BTreeMap,
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
};

const MAX_ENTRIES: usize = 512;
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
const MAX_PACKAGE_BYTES: u64 = 256 * 1024;
const MAX_FRONTMATTER_BYTES: u64 = 16 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SkillScope {
    Installed,
    Workspace,
}

#[derive(Clone)]
pub struct MountedSkill {
    pub manifest: SkillManifest,
    pub scope: SkillScope,
    pub directory: PathBuf,
    install_path: PathBuf,
    source: files::FileIdentity,
}

impl MountedSkill {
    /// Read the selected package body. The runtime must admit the capability
    /// before calling this Store seam, then publish its actual observation.
    pub fn instructions(&self) -> Result<String, StoreError> {
        let file = self.directory.join("SKILL.md");
        self.check_current()?;
        let bytes =
            files::read(&file, MAX_PACKAGE_BYTES as usize)?.ok_or(StoreError::VersionChanged)?;
        self.check_current()?;
        let text = std::str::from_utf8(&bytes).map_err(|_| StoreError::HistoryCorrupt)?;
        let mut offset = 0;
        for (i, line) in text.split_inclusive('\n').enumerate() {
            offset += line.len();
            if i != 0 && matches!(line, "---\n" | "---\r\n" | "---") {
                return Ok(text[offset..].trim_start_matches(['\r', '\n']).to_string());
            }
        }
        Err(StoreError::HistoryCorrupt)
    }

    pub fn check_current(&self) -> Result<(), StoreError> {
        if fs::canonicalize(&self.install_path).ok().as_ref() != Some(&self.directory)
            || files::identity(&self.directory.join("SKILL.md"))?.as_ref() != Some(&self.source)
        {
            return Err(StoreError::VersionChanged);
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillCatalogEntry {
    pub manifest: SkillManifest,
    pub scope: SkillScope,
    pub enabled: bool,
}

pub struct SkillCatalog {
    pub mounted: Vec<MountedSkill>,
    inventories: [(PathBuf, Option<files::FileIdentity>); 3],
}

struct DiscoveredCatalog {
    entries: Vec<(MountedSkill, bool)>,
    inventories: [(PathBuf, Option<files::FileIdentity>); 3],
}

impl SkillCatalog {
    fn discover(data_home: &Path, workspace: &Path) -> Result<DiscoveredCatalog, StoreError> {
        let workspace = fs::canonicalize(workspace).map_err(|_| StoreError::InvalidInput)?;
        let workspace_key = workspace.to_str().ok_or(StoreError::InvalidInput)?;
        let global = data_home.join("skills");
        let local = workspace.join("skills");
        let settings_file = global.join("settings.json");
        let inventories = [
            (global.clone(), files::identity(&global)?),
            (local.clone(), files::identity(&local)?),
            (settings_file.clone(), files::identity(&settings_file)?),
        ];
        let settings = settings(&settings_file)?;
        let workspace_skills = observe_root(&local, SkillScope::Workspace, &workspace)?;
        let installed_skills = observe_root(&global, SkillScope::Installed, &workspace)?;
        let mut available = BTreeMap::new();
        // A workspace declaration shadows the same installed id regardless of
        // whether the user's workspace settings currently mount it.
        for skill in workspace_skills.into_iter().chain(installed_skills) {
            available.entry(skill.manifest.id.clone()).or_insert(skill);
        }
        let entries = available
            .into_iter()
            .map(|(id, skill)| {
                let is_enabled = enabled(&settings, workspace_key, &id);
                (skill, is_enabled)
            })
            .collect();
        Ok(DiscoveredCatalog {
            entries,
            inventories,
        })
    }

    pub fn list_all(
        data_home: &Path,
        workspace: &Path,
    ) -> Result<Vec<SkillCatalogEntry>, StoreError> {
        let discovered = Self::discover(data_home, workspace)?;
        Ok(discovered
            .entries
            .into_iter()
            .map(|(skill, is_enabled)| SkillCatalogEntry {
                enabled: is_enabled,
                manifest: skill.manifest,
                scope: skill.scope,
            })
            .collect())
    }

    pub fn observe(data_home: &Path, workspace: &Path) -> Result<Self, StoreError> {
        Self::observe_with_overrides(data_home, workspace, &[], &[])
    }

    pub fn observe_with_overrides(
        data_home: &Path,
        workspace: &Path,
        enabled_ids: &[String],
        disabled_ids: &[String],
    ) -> Result<Self, StoreError> {
        let discovered = Self::discover(data_home, workspace)?;
        let result = Self {
            mounted: discovered
                .entries
                .into_iter()
                .filter_map(|(skill, default_enabled)| {
                    let id = skill.manifest.id.as_str();
                    let effective = if disabled_ids.iter().any(|x| x == id) {
                        false
                    } else if enabled_ids.iter().any(|x| x == id) {
                        true
                    } else {
                        default_enabled
                    };
                    effective.then_some(skill)
                })
                .collect(),
            inventories: discovered.inventories,
        };
        result.check_current()?;
        Ok(result)
    }

    pub fn check_current(&self) -> Result<(), StoreError> {
        for (path, version) in &self.inventories {
            if files::identity(path)? != *version {
                return Err(StoreError::VersionChanged);
            }
        }
        for entry in &self.mounted {
            entry.check_current()?;
        }
        Ok(())
    }
}

fn settings(path: &Path) -> Result<Value, StoreError> {
    let Some(bytes) = files::read(path, MAX_SETTINGS_BYTES)? else {
        return Ok(Value::Null);
    };
    peer_protocol::decode_json_bounded(
        &bytes,
        peer_protocol::JsonLimits {
            bytes: MAX_SETTINGS_BYTES,
            nodes: 16_384,
            depth: 16,
            string_bytes: MAX_SETTINGS_BYTES,
        },
    )
    .map(|result| result.value)
    .map_err(|_| StoreError::HistoryCorrupt)
}

fn listed(value: &Value, id: &str) -> bool {
    value
        .as_array()
        .is_some_and(|entries| entries.iter().any(|item| item == id))
}

fn enabled(settings: &Value, workspace: &str, id: &str) -> bool {
    listed(&settings["workspaceEnabled"][workspace], id)
        || !listed(&settings["disabled"], id)
            && !listed(&settings["workspaceDisabled"][workspace], id)
}

fn observe_root(
    root: &Path,
    scope: SkillScope,
    workspace: &Path,
) -> Result<Vec<MountedSkill>, StoreError> {
    let Some(initial) = files::identity(root)? else {
        return Ok(Vec::new());
    };
    let entries = fs::read_dir(root).map_err(|_| StoreError::ReadFailed)?;
    let mut skills = Vec::new();
    for (i, entry) in entries.enumerate() {
        if i >= MAX_ENTRIES {
            return Err(StoreError::HistoryLimit);
        }
        let entry = entry.map_err(|_| StoreError::ReadFailed)?;
        let ty = entry.file_type().map_err(|_| StoreError::ReadFailed)?;
        if !ty.is_dir() && !ty.is_symlink() {
            continue;
        }
        let name = entry.file_name();
        let name = name.to_str().ok_or(StoreError::InvalidInput)?;
        let directory = match fs::canonicalize(entry.path()) {
            Ok(path) if path.is_dir() => path,
            Ok(_) => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => return Err(StoreError::ReadFailed),
        };
        if scope == SkillScope::Workspace && !directory.starts_with(workspace) {
            return Err(StoreError::OutOfScope);
        }
        let Some((manifest, source)) = observe_header(&directory.join("SKILL.md"), name)? else {
            continue;
        };
        if fs::canonicalize(entry.path()).ok().as_ref() != Some(&directory) {
            return Err(StoreError::VersionChanged);
        }
        skills.push(MountedSkill {
            manifest,
            scope,
            directory,
            install_path: entry.path(),
            source,
        });
    }
    if files::identity(root)?.as_ref() != Some(&initial) {
        return Err(StoreError::VersionChanged);
    }
    skills.sort_by(|a, b| a.directory.cmp(&b.directory));
    Ok(skills)
}

fn observe_header(
    path: &Path,
    name: &str,
) -> Result<Option<(SkillManifest, files::FileIdentity)>, StoreError> {
    let Some((file, identity)) = files::open(path, MAX_PACKAGE_BYTES)? else {
        return Ok(None);
    };
    let mut reader = BufReader::with_capacity(1024, file).take(MAX_FRONTMATTER_BYTES);
    let mut line = String::new();
    reader
        .read_line(&mut line)
        .map_err(|_| StoreError::ReadFailed)?;
    if !matches!(line.as_str(), "---\n" | "---\r\n") {
        return Ok(None);
    }
    let mut header = String::new();
    loop {
        line.clear();
        let len = reader
            .read_line(&mut line)
            .map_err(|_| StoreError::ReadFailed)?;
        if len == 0 {
            return if reader.limit() == 0 {
                Err(StoreError::HistoryLimit)
            } else {
                Ok(None)
            };
        }
        if matches!(line.as_str(), "---\n" | "---\r\n" | "---") {
            break;
        }
        header.push_str(&line);
    }
    if files::identity(path)?.as_ref() != Some(&identity) {
        return Err(StoreError::VersionChanged);
    }
    Ok(SkillManifest::from_header(&header, name)
        .map_err(|_| StoreError::HistoryLimit)?
        .map(|manifest| (manifest, identity)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn install(root: &Path, id: &str, description: &str) {
        let directory = root.join("skills").join(id);
        fs::create_dir_all(&directory).unwrap();
        fs::write(
            directory.join("SKILL.md"),
            format!("---\ndescription: {description}\n---\nfixtures only\n"),
        )
        .unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn explicit_borrowed_mount_workspace_shadow_and_settings_are_read_together() {
        let parent = tempfile::tempdir().unwrap();
        let home = parent.path().join("data");
        let workspace = parent.path().join("workspace");
        let external = parent.path().join("borrowable");
        install(&home, "shared", "global summary");
        install(&workspace, "shared", "workspace summary");
        install(&external, "linked", "borrowed summary");
        install(&home, "disabled", "globally disabled summary");
        std::os::unix::fs::symlink(external.join("skills/linked"), home.join("skills/linked"))
            .unwrap();
        let path = fs::canonicalize(&workspace).unwrap();
        let config = home.join("skills/settings.json");
        let write = |value| fs::write(&config, serde_json::to_vec(&value).unwrap()).unwrap();
        write(
            json!({"disabled":["disabled"],"workspaceDisabled":{path.to_str().unwrap():["linked"]}}),
        );
        let entries = SkillCatalog::observe(&home, &workspace).unwrap().mounted;
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].manifest.description, "workspace summary");
        assert_eq!(entries[0].scope, SkillScope::Workspace);
        write(
            json!({"disabled":["disabled"],"workspaceEnabled":{path.to_str().unwrap():["disabled"]}}),
        );
        let entries = SkillCatalog::observe(&home, &workspace).unwrap().mounted;
        assert_eq!(
            entries
                .iter()
                .map(|entry| entry.manifest.id.as_str())
                .collect::<Vec<_>>(),
            ["disabled", "linked", "shared"]
        );
        assert_eq!(entries[1].scope, SkillScope::Installed);
        assert_eq!(entries[1].manifest.description, "borrowed summary");

        write(json!({"disabled":["disabled"]}));
        let all = SkillCatalog::list_all(&home, &workspace).unwrap();
        assert_eq!(
            all.iter()
                .map(|e| (e.manifest.id.as_str(), e.enabled))
                .collect::<Vec<_>>(),
            [("disabled", false), ("linked", true), ("shared", true)]
        );
    }
    #[cfg(unix)]
    #[test]
    fn load_binds_the_selected_package_to_its_observed_file_and_installation() {
        let root = tempfile::tempdir().unwrap();
        let home = root.path().join("data");
        let workspace = root.path().join("workspace");
        let primary = root.path().join("original");
        let replacement = root.path().join("different");
        fs::create_dir(&workspace).unwrap();
        fs::create_dir_all(home.join("skills")).unwrap();
        install(&primary, "linked", "original summary");
        install(&replacement, "linked", "replacement summary");
        let installed = home.join("skills/linked");
        std::os::unix::fs::symlink(primary.join("skills/linked"), &installed).unwrap();
        let entries = SkillCatalog::observe(&home, &workspace).unwrap().mounted;
        assert_eq!(entries[0].instructions().unwrap(), "fixtures only\n");
        fs::write(
            primary.join("skills/linked/SKILL.md"),
            "---\ndescription: edited\n---\nupdated body\n",
        )
        .unwrap();
        assert_eq!(entries[0].instructions(), Err(StoreError::VersionChanged));
        let entries = SkillCatalog::observe(&home, &workspace).unwrap().mounted;
        assert_eq!(entries[0].instructions().unwrap(), "updated body\n");
        fs::remove_file(&installed).unwrap();
        std::os::unix::fs::symlink(replacement.join("skills/linked"), &installed).unwrap();
        assert_eq!(entries[0].instructions(), Err(StoreError::VersionChanged));
    }
}
