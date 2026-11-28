//! Desktop-compatible local skill listing, enablement, symlinking, and uninstall.
//! Reads/writes `<data_home>/skills/settings.json` under `DirectoryLock` + `durable_jsonl::replace`
//! and parses SKILL.md frontmatter via `SkillManifest::from_header`.

use crate::{DirectoryLock, SkillManifest, StoreError, durable_jsonl as log, files};
use serde_json::{Map, Value, json};
use std::{
    collections::{BTreeSet, HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    time::Duration,
};

const SKILL_FILENAME: &str = "SKILL.md";
const MAX_SKILL_BYTES: usize = 512 * 1024;
const MAX_SETTINGS_BYTES: usize = 256 * 1024;
const MAX_META_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone)]
struct LoadedSkill {
    manifest: SkillManifest,
    instructions: String,
    scope: &'static str,
    workspace_path: Option<String>,
    workspace_aliases: Vec<String>,
    skill_dir: PathBuf,
    source: Option<String>,
    managed_source: String,
    icon_url: Option<String>,
}

#[derive(Default)]
struct SkillSettings {
    disabled: BTreeSet<String>,
    workspace_disabled: HashMap<String, BTreeSet<String>>,
    workspace_enabled: HashMap<String, BTreeSet<String>>,
    raw: Value,
}

fn clean_lexical_path(input: &Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for comp in input.components() {
        match comp {
            Component::Prefix(p) => out.push(p.as_os_str()),
            Component::RootDir => out.push(comp.as_os_str()),
            Component::CurDir => {}
            Component::ParentDir => {
                if !out.pop() {
                    out.push(comp.as_os_str());
                }
            }
            Component::Normal(part) => out.push(part),
        }
    }
    out
}

fn workspace_key_candidates(ws: &Path) -> (Option<String>, Vec<String>) {
    let raw_str = ws.to_string_lossy();
    let trimmed = peer_protocol::javascript_trim(&raw_str);
    if trimmed.is_empty() {
        return (None, Vec::new());
    }
    let lexical = clean_lexical_path(Path::new(trimmed));
    let lexical_str = lexical.to_string_lossy().into_owned();
    let canonical = fs::canonicalize(&lexical)
        .ok()
        .map(|p| p.to_string_lossy().into_owned());
    let mut aliases = vec![lexical_str.clone()];
    if let Some(ref c) = canonical
        && !aliases.contains(c)
    {
        aliases.push(c.clone());
    }
    let primary = canonical.unwrap_or(lexical_str);
    (Some(primary), aliases)
}

pub fn safe_skill_dir_name(skill_id: &str) -> Option<&str> {
    let trimmed = peer_protocol::javascript_trim(skill_id);
    if trimmed.is_empty()
        || trimmed.contains('/')
        || trimmed.contains('\\')
        || trimmed.contains('\0')
        || trimmed == "."
        || trimmed == ".."
    {
        return None;
    }
    let single = Path::new(trimmed).file_name()?.to_str()?;
    (single == trimmed).then_some(trimmed)
}

fn read_settings(settings_file: &Path) -> SkillSettings {
    let Ok(Some(bytes)) = files::read(settings_file, MAX_SETTINGS_BYTES) else {
        return SkillSettings {
            raw: json!({
                "disabled": [],
                "workspaceDisabled": {},
                "workspaceEnabled": {},
            }),
            ..Default::default()
        };
    };
    let Ok(raw) = serde_json::from_slice::<Value>(&bytes) else {
        return SkillSettings {
            raw: json!({
                "disabled": [],
                "workspaceDisabled": {},
                "workspaceEnabled": {},
            }),
            ..Default::default()
        };
    };
    let mut settings = SkillSettings {
        raw: raw.clone(),
        ..Default::default()
    };
    if let Some(arr) = raw["disabled"].as_array() {
        for v in arr {
            if let Some(s) = v.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                settings.disabled.insert(s.to_owned());
            }
        }
    }
    for (field, target) in [
        ("workspaceDisabled", &mut settings.workspace_disabled),
        ("workspaceEnabled", &mut settings.workspace_enabled),
    ] {
        if let Some(obj) = raw[field].as_object() {
            for (k, v) in obj {
                let (primary, _) = workspace_key_candidates(Path::new(k));
                let Some(norm_key) = primary else {
                    continue;
                };
                let entry = target.entry(norm_key).or_default();
                if let Some(arr) = v.as_array() {
                    for id in arr {
                        if let Some(s) = id.as_str().map(str::trim).filter(|s| !s.is_empty()) {
                            entry.insert(s.to_owned());
                        }
                    }
                }
            }
        }
    }
    settings
}

fn read_skill_meta(skill_dir: &Path) -> Option<Value> {
    let meta_path = skill_dir.join("_meta.json");
    let bytes = files::read(&meta_path, MAX_META_BYTES).ok()??;
    let val: Value = serde_json::from_slice(&bytes).ok()?;
    val.is_object().then_some(val)
}

fn extract_frontmatter_header_and_body(content: &str) -> (Option<&str>, String) {
    let normalized_start = if content.starts_with("---\r\n") {
        5
    } else if content.starts_with("---\n") {
        4
    } else {
        return (None, content.to_owned());
    };
    let rest = &content[normalized_start..];
    let mut offset = 0usize;
    for line in rest.split_inclusive('\n') {
        if matches!(line, "---\n" | "---\r\n" | "---") {
            let header = rest[..offset].trim_end_matches(['\r', '\n']);
            let body = rest[offset + line.len()..].trim_start_matches(['\r', '\n']);
            return (Some(header), body.to_owned());
        }
        offset += line.len();
    }
    (None, content.to_owned())
}

fn header_scalar(header: &str, keys: &[&str]) -> Option<String> {
    if let Ok(docs) = yaml_rust2::YamlLoader::load_from_str(header)
        && let Some(first) = docs.first()
    {
        for key in keys {
            if let Some(s) = first[*key]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                return Some(s.to_owned());
            }
        }
    }
    for line in header.lines().map(str::trim) {
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let k = k.trim();
        if keys.contains(&k) {
            let v = v
                .trim()
                .strip_prefix('"')
                .and_then(|s| s.strip_suffix('"'))
                .or_else(|| {
                    v.trim()
                        .strip_prefix('\'')
                        .and_then(|s| s.strip_suffix('\''))
                })
                .unwrap_or(v.trim())
                .trim();
            if !v.is_empty() {
                return Some(v.to_owned());
            }
        }
    }
    None
}

fn load_single_skill(skill_dir: &Path, dir_name: &str) -> Option<LoadedSkill> {
    let skill_file = skill_dir.join(SKILL_FILENAME);
    let raw_bytes = fs::read(&skill_file).ok()?;
    if raw_bytes.len() > MAX_SKILL_BYTES {
        return None;
    }
    let content = std::str::from_utf8(&raw_bytes).ok()?;
    let (header_opt, instructions) = extract_frontmatter_header_and_body(content);
    let header = header_opt?;
    let manifest = SkillManifest::from_header(header, dir_name).ok()??;

    let meta = read_skill_meta(skill_dir);
    let source_fm = header_scalar(header, &["x-source", "source"]);
    let source_meta = meta
        .as_ref()
        .and_then(|m| m["source"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let managed_source = source_meta.as_deref().unwrap_or("").to_lowercase();
    let source = source_fm.or(source_meta);

    let icon_fm = header_scalar(header, &["x-icon-url", "iconUrl"]);
    let icon_meta = meta
        .as_ref()
        .and_then(|m| m["iconUrl"].as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let icon_url = icon_fm.or(icon_meta);

    Some(LoadedSkill {
        manifest,
        instructions,
        scope: "global",
        workspace_path: None,
        workspace_aliases: Vec::new(),
        skill_dir: skill_dir.to_path_buf(),
        source,
        managed_source,
        icon_url,
    })
}

fn load_skills_from_root(
    root: &Path,
    scope: &'static str,
    workspace_path: Option<String>,
    workspace_aliases: Vec<String>,
) -> Vec<LoadedSkill> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let dir_path = entry.path();
        if !fs::metadata(&dir_path).is_ok_and(|m| m.is_dir()) {
            continue;
        }
        let dir_name = entry.file_name().to_string_lossy().into_owned();
        if let Some(mut skill) = load_single_skill(&dir_path, &dir_name) {
            skill.scope = scope;
            skill.workspace_path = workspace_path.clone();
            skill.workspace_aliases = workspace_aliases.clone();
            out.push(skill);
        }
    }
    out
}

fn is_skill_mounted(settings: &SkillSettings, skill_id: &str, aliases: &[String]) -> bool {
    if aliases.is_empty() {
        return !settings.disabled.contains(skill_id);
    }
    for alias in aliases {
        if settings
            .workspace_enabled
            .get(alias)
            .is_some_and(|set| set.contains(skill_id))
        {
            return true;
        }
    }
    if settings.disabled.contains(skill_id) {
        return false;
    }
    for alias in aliases {
        if settings
            .workspace_disabled
            .get(alias)
            .is_some_and(|set| set.contains(skill_id))
        {
            return false;
        }
    }
    true
}

fn is_managed_workspace_skill(skill: &LoadedSkill) -> bool {
    if skill.scope != "workspace"
        || !matches!(
            skill.managed_source.as_str(),
            "skillhub" | "qoder-marketplace"
        )
    {
        return false;
    }
    let Some(ref ws_path) = skill.workspace_path else {
        return false;
    };
    let Some(safe_id) = safe_skill_dir_name(&skill.manifest.id) else {
        return false;
    };
    let workspace_root = Path::new(ws_path).join("skills");
    let expected_target = workspace_root.join(safe_id);
    if clean_lexical_path(&skill.skill_dir) != clean_lexical_path(&expected_target) {
        return false;
    }
    let Ok(meta) = fs::symlink_metadata(&expected_target) else {
        return false;
    };
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return false;
    }
    let Ok(root_real) = fs::canonicalize(&workspace_root) else {
        return false;
    };
    let Ok(target_real) = fs::canonicalize(&expected_target) else {
        return false;
    };
    target_real.starts_with(&root_real) && target_real != root_real
}

fn summarize_skill(skill: &LoadedSkill, settings: &SkillSettings, aliases: &[String]) -> Value {
    json!({
        "skillId": skill.manifest.id,
        "name": skill.manifest.name,
        "description": skill.manifest.description,
        "whenToUse": skill.manifest.when_to_use,
        "version": skill.manifest.version,
        "dataLevel": skill.manifest.data_level,
        "enabled": is_skill_mounted(settings, &skill.manifest.id, aliases),
        "scope": skill.scope,
        "workspacePath": skill.workspace_path,
        "iconUrl": skill.icon_url,
        "source": skill.source,
        "canUninstall": skill.scope == "global" || is_managed_workspace_skill(skill),
    })
}

pub fn list_skills(
    data_home: &Path,
    active_workspace: Option<&Path>,
    workspace_paths: Option<&[PathBuf]>,
) -> Result<Value, StoreError> {
    let skills_root = data_home.join("skills");
    let settings = read_settings(&skills_root.join("settings.json"));

    if let Some(ws_list) = workspace_paths {
        let mut seen = BTreeSet::new();
        let mut items = Vec::new();
        for ws in ws_list {
            let (Some(primary), aliases) = workspace_key_candidates(ws) else {
                continue;
            };
            if !seen.insert(primary.clone()) {
                continue;
            }
            let ws_root = Path::new(&primary).join("skills");
            for skill in load_skills_from_root(
                &ws_root,
                "workspace",
                Some(primary.clone()),
                aliases.clone(),
            ) {
                items.push(summarize_skill(&skill, &settings, &skill.workspace_aliases));
            }
        }
        for skill in load_skills_from_root(&skills_root, "global", None, Vec::new()) {
            items.push(summarize_skill(&skill, &settings, &[]));
        }
        return Ok(Value::Array(items));
    }

    let (active_primary, active_aliases) = active_workspace
        .map(workspace_key_candidates)
        .unwrap_or((None, Vec::new()));
    let global_skills = load_skills_from_root(&skills_root, "global", None, Vec::new());
    let workspace_skills = if let Some(ref primary) = active_primary {
        let ws_root = Path::new(primary).join("skills");
        load_skills_from_root(
            &ws_root,
            "workspace",
            Some(primary.clone()),
            active_aliases.clone(),
        )
    } else {
        Vec::new()
    };

    let ws_ids: HashSet<String> = workspace_skills
        .iter()
        .map(|s| s.manifest.id.clone())
        .collect();
    let mut merged: Vec<LoadedSkill> = workspace_skills;
    merged.extend(
        global_skills
            .into_iter()
            .filter(|s| !ws_ids.contains(&s.manifest.id)),
    );
    merged.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));

    let items: Vec<Value> = merged
        .iter()
        .map(|s| summarize_skill(s, &settings, &active_aliases))
        .collect();
    Ok(Value::Array(items))
}

fn find_skill(
    data_home: &Path,
    skill_id: &str,
    active_workspace: Option<&Path>,
    workspace_path: Option<Option<&Path>>,
) -> Option<(LoadedSkill, Vec<String>)> {
    let skills_root = data_home.join("skills");
    match workspace_path {
        None => {
            let (active_primary, active_aliases) = active_workspace
                .map(workspace_key_candidates)
                .unwrap_or((None, Vec::new()));
            if let Some(ref primary) = active_primary {
                let ws_root = Path::new(primary).join("skills");
                if let Some(found) = load_skills_from_root(
                    &ws_root,
                    "workspace",
                    Some(primary.clone()),
                    active_aliases.clone(),
                )
                .into_iter()
                .find(|s| s.manifest.id == skill_id)
                {
                    return Some((found, active_aliases));
                }
            }
            let found = load_skills_from_root(&skills_root, "global", None, Vec::new())
                .into_iter()
                .find(|s| s.manifest.id == skill_id)?;
            Some((found, active_aliases))
        }
        Some(None) => {
            let found = load_skills_from_root(&skills_root, "global", None, Vec::new())
                .into_iter()
                .find(|s| s.manifest.id == skill_id)?;
            Some((found, Vec::new()))
        }
        Some(Some(ws)) => {
            let (primary_opt, aliases) = workspace_key_candidates(ws);
            let root = primary_opt
                .as_deref()
                .map(|p| Path::new(p).join("skills"))
                .unwrap_or_else(|| skills_root.clone());
            let scope = if primary_opt.is_some() {
                "workspace"
            } else {
                "global"
            };
            let found = load_skills_from_root(&root, scope, primary_opt, aliases.clone())
                .into_iter()
                .find(|s| s.manifest.id == skill_id)?;
            Some((found, aliases))
        }
    }
}

pub fn get_skill_detail(
    data_home: &Path,
    skill_id: &str,
    active_workspace: Option<&Path>,
    workspace_path: Option<Option<&Path>>,
) -> Result<Option<Value>, StoreError> {
    let skills_root = data_home.join("skills");
    let settings = read_settings(&skills_root.join("settings.json"));
    let Some((skill, aliases)) = find_skill(data_home, skill_id, active_workspace, workspace_path)
    else {
        return Ok(None);
    };
    let mut summary = summarize_skill(&skill, &settings, &aliases);
    if let Some(obj) = summary.as_object_mut() {
        obj.insert("instructions".into(), json!(skill.instructions));
        obj.insert(
            "sourcePath".into(),
            json!(skill.skill_dir.join(SKILL_FILENAME).to_string_lossy()),
        );
    }
    Ok(Some(summary))
}

fn mutate_settings_file<F>(data_home: &Path, mutate: F) -> Result<(), StoreError>
where
    F: FnOnce(&mut SkillSettings),
{
    let skills_root = log::directory(&data_home.join("skills"))?;
    let settings_file = skills_root.join("settings.json");
    let _lock = DirectoryLock::acquire(&settings_file, Duration::from_millis(200), None)?;
    let mut settings = read_settings(&settings_file);
    mutate(&mut settings);

    let mut root_obj = settings.raw.as_object().cloned().unwrap_or_default();
    root_obj.insert(
        "disabled".into(),
        Value::Array(settings.disabled.into_iter().map(Value::String).collect()),
    );
    let mut wd_obj = Map::new();
    for (k, set) in settings.workspace_disabled {
        wd_obj.insert(
            k,
            Value::Array(set.into_iter().map(Value::String).collect()),
        );
    }
    let mut we_obj = Map::new();
    for (k, set) in settings.workspace_enabled {
        we_obj.insert(
            k,
            Value::Array(set.into_iter().map(Value::String).collect()),
        );
    }
    root_obj.insert("workspaceDisabled".into(), Value::Object(wd_obj));
    root_obj.insert("workspaceEnabled".into(), Value::Object(we_obj));

    let bytes = serde_json::to_vec_pretty(&Value::Object(root_obj))
        .map_err(|_| StoreError::InvalidInput)?;
    log::replace(&settings_file, &bytes, None)
}

pub fn set_skill_enabled(
    data_home: &Path,
    skill_id: &str,
    enabled: bool,
    active_workspace: Option<&Path>,
    workspace_path: Option<Option<&Path>>,
) -> Result<Value, StoreError> {
    let trimmed = peer_protocol::javascript_trim(skill_id);
    if trimmed.is_empty() {
        return list_skills(data_home, active_workspace, None);
    }
    let effective_ws: Option<PathBuf> = match workspace_path {
        None => active_workspace.map(Path::to_path_buf),
        Some(None) => None,
        Some(Some(ws)) => Some(ws.to_path_buf()),
    };
    let (primary_key, aliases) = effective_ws
        .as_deref()
        .map(workspace_key_candidates)
        .unwrap_or((None, Vec::new()));

    mutate_settings_file(data_home, |settings| {
        if let Some(ref key) = primary_key {
            for alias in &aliases {
                if alias != key {
                    if let Some(extra) = settings.workspace_disabled.remove(alias) {
                        settings
                            .workspace_disabled
                            .entry(key.clone())
                            .or_default()
                            .extend(extra);
                    }
                    if let Some(extra) = settings.workspace_enabled.remove(alias) {
                        settings
                            .workspace_enabled
                            .entry(key.clone())
                            .or_default()
                            .extend(extra);
                    }
                }
            }
            let disabled_set = settings.workspace_disabled.entry(key.clone()).or_default();
            if enabled {
                disabled_set.remove(trimmed);
                settings
                    .workspace_enabled
                    .entry(key.clone())
                    .or_default()
                    .insert(trimmed.to_owned());
            } else {
                disabled_set.insert(trimmed.to_owned());
                if let Some(enabled_set) = settings.workspace_enabled.get_mut(key) {
                    enabled_set.remove(trimmed);
                }
            }
        } else if enabled {
            settings.disabled.remove(trimmed);
        } else {
            settings.disabled.insert(trimmed.to_owned());
        }
    })?;

    match workspace_path {
        None => list_skills(data_home, active_workspace, None),
        Some(_) => {
            if let Some(key) = primary_key {
                let single = [PathBuf::from(key)];
                list_skills(data_home, active_workspace, Some(&single))
            } else {
                list_skills(data_home, active_workspace, Some(&[]))
            }
        }
    }
}

fn is_linked_entry(skills_root: &Path, dir_name: &str) -> bool {
    fs::symlink_metadata(skills_root.join(dir_name)).is_ok_and(|m| m.file_type().is_symlink())
}

#[derive(Clone)]
struct AvailableSkill {
    manifest: SkillManifest,
    source_root: PathBuf,
    source_dir: PathBuf,
    linked: bool,
}

fn scan_available_skills(data_home: &Path, source_roots: &[PathBuf]) -> Vec<AvailableSkill> {
    let skills_root = data_home.join("skills");
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for root in source_roots {
        let Ok(entries) = fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let source_dir = entry.path();
            if !fs::metadata(&source_dir).is_ok_and(|m| m.is_dir()) {
                continue;
            }
            let dir_name = entry.file_name().to_string_lossy().into_owned();
            let Some(loaded) = load_single_skill(&source_dir, &dir_name) else {
                continue;
            };
            if !seen.insert(loaded.manifest.id.clone()) {
                continue;
            }
            let linked = is_linked_entry(&skills_root, &loaded.manifest.id);
            out.push(AvailableSkill {
                manifest: loaded.manifest,
                source_root: root.clone(),
                source_dir,
                linked,
            });
        }
    }
    out.sort_by(|a, b| a.manifest.id.cmp(&b.manifest.id));
    out
}

pub fn list_available_skills(
    data_home: &Path,
    source_roots: &[PathBuf],
) -> Result<Value, StoreError> {
    let items: Vec<Value> = scan_available_skills(data_home, source_roots)
        .into_iter()
        .map(|s| {
            json!({
                "skillId": s.manifest.id,
                "name": s.manifest.name,
                "description": s.manifest.description,
                "whenToUse": s.manifest.when_to_use,
                "version": s.manifest.version,
                "dataLevel": s.manifest.data_level,
                "sourceRoot": s.source_root.to_string_lossy(),
                "sourceDir": s.source_dir.to_string_lossy(),
                "linked": s.linked,
            })
        })
        .collect();
    Ok(Value::Array(items))
}

#[cfg(unix)]
fn symlink_directory(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::unix::fs::symlink(src, dst)
}

#[cfg(windows)]
fn symlink_directory(src: &Path, dst: &Path) -> std::io::Result<()> {
    std::os::windows::fs::symlink_dir(src, dst)
}

#[cfg(windows)]
fn remove_symlink(dst: &Path) -> std::io::Result<()> {
    match fs::remove_dir(dst) {
        Ok(()) => Ok(()),
        Err(_) => fs::remove_file(dst),
    }
}

#[cfg(unix)]
fn remove_symlink(dst: &Path) -> std::io::Result<()> {
    fs::remove_file(dst)
}

pub fn link_skill(
    data_home: &Path,
    skill_id: &str,
    source_roots: &[PathBuf],
) -> Result<Value, StoreError> {
    let Some(dir_name) = safe_skill_dir_name(skill_id) else {
        return Ok(json!({ "ok": false, "error": "invalid-skill-id" }));
    };
    let Some(available) = scan_available_skills(data_home, source_roots)
        .into_iter()
        .find(|s| s.manifest.id == dir_name)
    else {
        return Ok(json!({ "ok": false, "error": "source-not-found" }));
    };
    let skills_root = data_home.join("skills");
    let target = skills_root.join(dir_name);
    if target.exists() || is_linked_entry(&skills_root, dir_name) {
        if is_linked_entry(&skills_root, dir_name) {
            return Ok(json!({ "ok": true, "alreadyLinked": true }));
        }
        return Ok(json!({ "ok": false, "error": "target-exists" }));
    }
    let _ = log::directory(&skills_root)?;
    match symlink_directory(&available.source_dir, &target) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(err) => Ok(json!({
            "ok": false,
            "error": "symlink-failed",
            "detail": err.to_string(),
        })),
    }
}

pub fn unlink_skill(data_home: &Path, skill_id: &str) -> Result<Value, StoreError> {
    let Some(dir_name) = safe_skill_dir_name(skill_id) else {
        return Ok(json!({ "ok": false, "error": "invalid-skill-id" }));
    };
    let target = data_home.join("skills").join(dir_name);
    let Ok(meta) = fs::symlink_metadata(&target) else {
        return Ok(json!({ "ok": false, "error": "not-linked" }));
    };
    if !meta.file_type().is_symlink() {
        return Ok(json!({ "ok": false, "error": "not-a-link" }));
    }
    match remove_symlink(&target) {
        Ok(()) => Ok(json!({ "ok": true })),
        Err(err) => Ok(json!({
            "ok": false,
            "error": "unlink-failed",
            "detail": err.to_string(),
        })),
    }
}

pub fn uninstall_skill(
    data_home: &Path,
    skill_id: &str,
    active_workspace: Option<&Path>,
    workspace_path: Option<Option<&Path>>,
) -> Result<Value, StoreError> {
    let Some(dir_name) = safe_skill_dir_name(skill_id) else {
        return Ok(json!({ "ok": false, "error": "invalid-skill-id" }));
    };
    let Some((skill, _)) = find_skill(data_home, skill_id, active_workspace, workspace_path) else {
        return Ok(json!({ "ok": false, "error": "not-found" }));
    };

    let skills_root = data_home.join("skills");
    let root = if skill.scope == "workspace" {
        match skill.workspace_path.as_deref() {
            Some(ws) => Path::new(ws).join("skills"),
            None => {
                return Ok(json!({ "ok": false, "error": "workspace-skill-not-uninstallable" }));
            }
        }
    } else {
        skills_root.clone()
    };

    if skill.scope == "workspace" && !is_managed_workspace_skill(&skill) {
        return Ok(json!({ "ok": false, "error": "workspace-skill-not-uninstallable" }));
    }

    let target = root.join(dir_name);
    if clean_lexical_path(&skill.skill_dir) != clean_lexical_path(&target) {
        return Ok(json!({ "ok": false, "error": "path-mismatch" }));
    }
    let Ok(meta) = fs::symlink_metadata(&target) else {
        return Ok(json!({ "ok": false, "error": "not-found" }));
    };

    let mode = if meta.file_type().is_symlink() {
        if skill.scope == "workspace" {
            return Ok(json!({ "ok": false, "error": "workspace-skill-not-uninstallable" }));
        }
        if let Err(err) = remove_symlink(&target) {
            return Ok(json!({
                "ok": false,
                "error": "unlink-failed",
                "detail": err.to_string(),
            }));
        }
        "unlinked"
    } else {
        let Ok(root_real) = fs::canonicalize(&root) else {
            return Ok(json!({ "ok": false, "error": "path-escape" }));
        };
        let Ok(target_real) = fs::canonicalize(&target) else {
            return Ok(json!({ "ok": false, "error": "path-escape" }));
        };
        if target_real.parent() != Some(root_real.as_path()) {
            return Ok(json!({ "ok": false, "error": "path-escape" }));
        }
        if let Err(err) = fs::remove_dir_all(&target) {
            return Ok(json!({
                "ok": false,
                "error": "delete-failed",
                "detail": err.to_string(),
            }));
        }
        "deleted"
    };

    if skills_root.join("settings.json").exists() {
        mutate_settings_file(data_home, |settings| {
            settings.disabled.remove(skill_id);
            for set in settings.workspace_disabled.values_mut() {
                set.remove(skill_id);
            }
            for set in settings.workspace_enabled.values_mut() {
                set.remove(skill_id);
            }
        })?;
    }

    Ok(json!({ "ok": true, "mode": mode }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_skill(root: &Path, id: &str, desc: &str, managed_source: Option<&str>) {
        let dir = root.join("skills").join(id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("SKILL.md"),
            format!("---\ndescription: {desc}\n---\nBody for {id}\n"),
        )
        .unwrap();
        if let Some(src) = managed_source {
            fs::write(
                dir.join("_meta.json"),
                serde_json::to_vec(&json!({ "source": src })).unwrap(),
            )
            .unwrap();
        }
    }

    #[test]
    fn list_enable_disable_link_unlink_and_uninstall_roundtrip() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("workspace");
        let borrow = tmp.path().join("borrow");
        fs::create_dir_all(&ws).unwrap();

        write_skill(&home, "alpha", "Global alpha", None);
        write_skill(&ws, "alpha", "Workspace alpha", None);
        write_skill(&ws, "hub-skill", "Managed hub skill", Some("skillhub"));
        write_skill(&borrow, "shared-borrow", "Borrowed skill", None);

        let listed = list_skills(&home, Some(&ws), None).unwrap();
        let items = listed.as_array().unwrap();
        assert_eq!(items.len(), 2);
        let alpha = items.iter().find(|s| s["skillId"] == "alpha").unwrap();
        assert_eq!(alpha["description"], "Workspace alpha");
        assert_eq!(alpha["canUninstall"], false);

        let hub = items.iter().find(|s| s["skillId"] == "hub-skill").unwrap();
        assert_eq!(hub["canUninstall"], true);

        let after_disable = set_skill_enabled(&home, "alpha", false, Some(&ws), None).unwrap();
        let alpha_disabled = after_disable
            .as_array()
            .unwrap()
            .iter()
            .find(|s| s["skillId"] == "alpha")
            .unwrap();
        assert_eq!(alpha_disabled["enabled"], false);

        // Toggling a second skill in the same workspace must preserve the first toggle.
        let after_disable_second =
            set_skill_enabled(&home, "hub-skill", false, Some(&ws), None).unwrap();
        let arr2 = after_disable_second.as_array().unwrap();
        assert_eq!(
            arr2.iter().find(|s| s["skillId"] == "alpha").unwrap()["enabled"],
            false
        );
        assert_eq!(
            arr2.iter().find(|s| s["skillId"] == "hub-skill").unwrap()["enabled"],
            false
        );

        let avail = list_available_skills(&home, &[borrow.join("skills")]).unwrap();
        assert_eq!(avail.as_array().unwrap().len(), 1);
        assert_eq!(avail[0]["linked"], false);

        let linked = link_skill(&home, "shared-borrow", &[borrow.join("skills")]).unwrap();
        assert_eq!(linked["ok"], true);
        let detail = get_skill_detail(&home, "shared-borrow", Some(&ws), None)
            .unwrap()
            .unwrap();
        assert_eq!(detail["instructions"], "Body for shared-borrow\n");

        let unlinked = unlink_skill(&home, "shared-borrow").unwrap();
        assert_eq!(unlinked["ok"], true);

        let ws_reject = uninstall_skill(&home, "alpha", Some(&ws), Some(Some(&ws))).unwrap();
        assert_eq!(ws_reject["ok"], false);
        assert_eq!(ws_reject["error"], "workspace-skill-not-uninstallable");

        let hub_removed = uninstall_skill(&home, "hub-skill", Some(&ws), Some(Some(&ws))).unwrap();
        assert_eq!(hub_removed["ok"], true);
        assert_eq!(hub_removed["mode"], "deleted");
    }
}
