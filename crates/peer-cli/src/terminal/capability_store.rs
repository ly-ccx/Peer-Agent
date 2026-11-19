//! Read-first & write-on-action Skill / MCP configuration helpers for CLI TUI pickers.
//!
//! Strictly read-only when opening pickers; only explicit Space toggle writes
//! `<home>/skills/settings.json` or `<home>/mcp-registry.json` atomically while
//! preserving all unrelated keys and refusing corrupt JSON.

use peer_store::SkillCatalog;
use peer_tui::{McpPickerRow, SkillPickerRow};
use serde_json::{Map, Value, json};
use std::{
    fs, io,
    path::{Path, PathBuf},
};

const MAX_CONFIG_BYTES: u64 = 1024 * 1024;

fn read_json_bounded(path: &Path) -> io::Result<Option<Value>> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(err) if err.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(err) => return Err(err),
    };
    if meta.len() > MAX_CONFIG_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "config exceeds 1 MiB budget",
        ));
    }
    let raw = fs::read_to_string(path)?;
    serde_json::from_str::<Value>(&raw)
        .map(Some)
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidData, "corrupt JSON"))
}

fn write_json_atomic(dir: &Path, path: &Path, prefix: &str, value: &Value) -> io::Result<()> {
    fs::create_dir_all(dir)?;
    let encoded = serde_json::to_string_pretty(value).map_err(io::Error::other)?;
    let tmp = tempfile::Builder::new()
        .prefix(prefix)
        .suffix(".tmp")
        .tempfile_in(dir)?;
    fs::write(tmp.path(), format!("{encoded}\n"))?;
    tmp.persist(path).map_err(|e| e.error)?;
    Ok(())
}

pub(super) fn load_skills(home: &Path, workspace: &Path) -> Vec<SkillPickerRow> {
    let Ok(entries) = SkillCatalog::list_all(home, workspace) else {
        return Vec::new();
    };
    entries
        .into_iter()
        .map(|entry| SkillPickerRow {
            name: if entry.manifest.name.is_empty() {
                entry.manifest.id.clone()
            } else {
                entry.manifest.name
            },
            description: entry.manifest.description,
            skill_id: entry.manifest.id,
            enabled: entry.enabled,
        })
        .collect()
}

fn remove_string_from_array_map(map: &mut Map<String, Value>, ws_key: &str, id: &str) {
    if let Some(Value::Array(arr)) = map.get_mut(ws_key) {
        arr.retain(|v| v.as_str() != Some(id));
    }
}

fn add_string_to_array_map(map: &mut Map<String, Value>, ws_key: &str, id: &str) {
    let entry = map
        .entry(ws_key.to_owned())
        .or_insert_with(|| Value::Array(Vec::new()));
    if let Value::Array(arr) = entry
        && !arr.iter().any(|v| v.as_str() == Some(id))
    {
        arr.push(Value::String(id.to_owned()));
    }
}

pub(super) fn set_skill_enabled(
    home: &Path,
    workspace: &Path,
    skill_id: &str,
    enabled: bool,
) -> io::Result<Vec<SkillPickerRow>> {
    let ws = fs::canonicalize(workspace)?;
    let ws_key = ws
        .to_str()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "invalid workspace path"))?;
    let skills_dir = home.join("skills");
    let path = skills_dir.join("settings.json");

    let mut root = match read_json_bounded(&path)? {
        None => Map::new(),
        Some(Value::Object(obj)) => obj,
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "skills settings.json is corrupt; refusing to overwrite",
            ));
        }
    };

    let mut ws_enabled = match root.remove("workspaceEnabled") {
        Some(Value::Object(obj)) => obj,
        None | Some(Value::Null) => Map::new(),
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspaceEnabled invalid; refusing to overwrite",
            ));
        }
    };
    let mut ws_disabled = match root.remove("workspaceDisabled") {
        Some(Value::Object(obj)) => obj,
        None | Some(Value::Null) => Map::new(),
        Some(_) => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "workspaceDisabled invalid; refusing to overwrite",
            ));
        }
    };

    if enabled {
        remove_string_from_array_map(&mut ws_disabled, ws_key, skill_id);
        add_string_to_array_map(&mut ws_enabled, ws_key, skill_id);
    } else {
        remove_string_from_array_map(&mut ws_enabled, ws_key, skill_id);
        add_string_to_array_map(&mut ws_disabled, ws_key, skill_id);
    }
    root.insert("workspaceEnabled".to_owned(), Value::Object(ws_enabled));
    root.insert("workspaceDisabled".to_owned(), Value::Object(ws_disabled));
    write_json_atomic(
        &skills_dir,
        &path,
        ".skills-settings-",
        &Value::Object(root),
    )?;
    Ok(load_skills(home, workspace))
}

fn registry_path(home: &Path) -> PathBuf {
    home.join("mcp-registry.json")
}

pub(super) fn load_mcp_servers(home: &Path) -> Vec<McpPickerRow> {
    let Ok(Some(value)) = read_json_bounded(&registry_path(home)) else {
        return Vec::new();
    };
    let servers = value
        .as_array()
        .or_else(|| value.get("servers").and_then(Value::as_array));
    let Some(servers) = servers else {
        return Vec::new();
    };
    servers
        .iter()
        .filter_map(|s| {
            let id = s["id"]
                .as_str()
                .or_else(|| s["mcpId"].as_str())
                .filter(|v| !v.is_empty())?
                .to_owned();
            let display_name = s["displayName"]
                .as_str()
                .filter(|v| !v.is_empty())
                .or_else(|| s["name"].as_str().filter(|v| !v.is_empty()))
                .unwrap_or(&id)
                .to_owned();
            let enabled = s["enabled"] != false;
            let health_status = s["health"]["status"]
                .as_str()
                .unwrap_or("unknown")
                .to_owned();
            let visibility = s.get("toolVisibility").and_then(Value::as_object);
            let tools = s["tools"].as_array().map(Vec::as_slice).unwrap_or(&[]);
            let mut visible_tools = 0usize;
            let mut tool_names = Vec::new();
            for tool in tools {
                let name = tool["name"]
                    .as_str()
                    .or_else(|| tool["toolName"].as_str())
                    .unwrap_or("");
                if name.is_empty() {
                    continue;
                }
                let vis = visibility
                    .and_then(|m| m.get(name))
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| tool["visible"].as_bool().unwrap_or(true));
                if vis {
                    visible_tools += 1;
                }
                if tool_names.len() < 8 {
                    tool_names.push(name.to_owned());
                }
            }
            Some(McpPickerRow {
                id,
                display_name,
                enabled,
                health_status,
                visible_tools,
                total_tools: tools.len(),
                tool_names,
            })
        })
        .collect()
}

pub(super) fn set_mcp_server_enabled(
    home: &Path,
    server_id: &str,
    enabled: bool,
) -> io::Result<Vec<McpPickerRow>> {
    let path = registry_path(home);
    let mut doc = match read_json_bounded(&path)? {
        Some(v) => v,
        None => {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "mcp-registry.json not found",
            ));
        }
    };
    let servers = if let Some(arr) = doc.as_array_mut() {
        arr
    } else if let Some(arr) = doc.get_mut("servers").and_then(Value::as_array_mut) {
        arr
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "mcp-registry.json is corrupt; refusing to overwrite",
        ));
    };
    let mut matched = false;
    for srv in servers.iter_mut() {
        let id_match =
            srv["id"].as_str() == Some(server_id) || srv["mcpId"].as_str() == Some(server_id);
        if id_match && let Some(obj) = srv.as_object_mut() {
            obj.insert("enabled".to_owned(), json!(enabled));
            matched = true;
            break;
        }
    }
    if !matched {
        return Err(io::Error::new(
            io::ErrorKind::NotFound,
            "MCP server not found",
        ));
    }
    write_json_atomic(home, &path, ".mcp-registry-", &doc)?;
    Ok(load_mcp_servers(home))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skills_and_mcp_toggles_preserve_unrelated_keys_and_refuse_corrupt_files() {
        let tmp = tempfile::tempdir().unwrap();
        let home = tmp.path().join("home");
        let ws = tmp.path().join("ws");
        fs::create_dir_all(home.join("skills/rust-check")).unwrap();
        fs::create_dir_all(&ws).unwrap();
        fs::write(
            home.join("skills/rust-check/SKILL.md"),
            "---\nname: Rust Check\ndescription: Run cargo checks\n---\nbody\n",
        )
        .unwrap();

        // Missing settings.json -> read-only, creates nothing
        let rows = load_skills(&home, &ws);
        assert_eq!(rows.len(), 1);
        assert!(rows[0].enabled);
        assert!(!home.join("skills/settings.json").exists());

        // Seed unrelated key, toggle off then on
        fs::write(
            home.join("skills/settings.json"),
            r#"{"disabled":["other-global"],"workspaceDisabled":{"/other":["x"]}}"#,
        )
        .unwrap();
        let updated = set_skill_enabled(&home, &ws, "rust-check", false).unwrap();
        assert!(!updated[0].enabled);
        let raw: Value =
            serde_json::from_str(&fs::read_to_string(home.join("skills/settings.json")).unwrap())
                .unwrap();
        assert_eq!(raw["disabled"], json!(["other-global"]));
        assert_eq!(raw["workspaceDisabled"]["/other"], json!(["x"]));
        let updated = set_skill_enabled(&home, &ws, "rust-check", true).unwrap();
        assert!(updated[0].enabled);

        // Corrupt skills settings refuses overwrite
        fs::write(home.join("skills/settings.json"), "{corrupt").unwrap();
        assert!(set_skill_enabled(&home, &ws, "rust-check", false).is_err());

        // MCP registry roundtrip preserves extra headers/auth fields
        fs::write(
            home.join("mcp-registry.json"),
            serde_json::to_string_pretty(&json!({
                "version": 1,
                "servers": [{
                    "id": "srv-1",
                    "displayName": "Browser",
                    "enabled": true,
                    "transport": "stdio",
                    "command": "/bin/mcp",
                    "health": {"status": "ok"},
                    "tools": [{"name": "open"}]
                }]
            }))
            .unwrap(),
        )
        .unwrap();
        let srvs = load_mcp_servers(&home);
        assert_eq!(srvs.len(), 1);
        assert!(srvs[0].enabled);
        let toggled = set_mcp_server_enabled(&home, "srv-1", false).unwrap();
        assert!(!toggled[0].enabled);
        let saved: Value =
            serde_json::from_str(&fs::read_to_string(home.join("mcp-registry.json")).unwrap())
                .unwrap();
        assert_eq!(saved["servers"][0]["command"], "/bin/mcp");
    }
}
