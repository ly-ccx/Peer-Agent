//! Read-only Host projection of the prompt settings already used by TUI.
//! Other settings remain explicit admission blockers until their adapters exist.
use super::{ConfigInstruction, files};
use crate::CancellationToken;
use peer_protocol::{JsonLimits, LocalAccessLevel, decode_json_bounded, javascript_trim};
use serde::Deserialize;
use serde_json::{Value, json};
use std::path::Path;

pub(super) fn read_host_prompt_settings(
    home: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<ConfigInstruction>, &'static str> {
    project(&read_host_settings(home, cancel)?)
}

pub(super) fn read_desktop_prompt_settings(
    home: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<ConfigInstruction>, &'static str> {
    project_desktop(&read_host_settings(home, cancel)?)
}

pub(super) fn presentation_locale(
    home: &Path,
    cancel: &CancellationToken,
) -> Result<&'static str, &'static str> {
    Ok(normalized_locale(&read_host_settings(home, cancel)?))
}

fn normalized_locale(settings: &Value) -> &'static str {
    let locale = settings["locale"].as_str().unwrap_or("zh-CN");
    if javascript_trim(locale).to_lowercase().starts_with("en") {
        "en-US"
    } else {
        "zh-CN"
    }
}

fn read_host_settings(home: &Path, cancel: &CancellationToken) -> Result<Value, &'static str> {
    let path = home.join("settings.json");
    let raw = files::read(&path, &mut 0, cancel, &mut |_| {}).map_err(|code| match code {
        "cancelled" => "cancelled",
        "context_instruction_changed" => "context_settings_changed",
        "context_instruction_limit" => "context_settings_limit",
        "context_instruction_invalid_utf8" => "context_settings_invalid",
        _ => "context_settings_unavailable",
    })?;
    let settings = match raw {
        Some(raw) => {
            decode_json_bounded(
                raw.as_bytes(),
                JsonLimits {
                    bytes: 1024 * 1024,
                    nodes: 4096,
                    depth: 16,
                    string_bytes: 1024 * 1024,
                },
            )
            .map_err(|_| "context_settings_invalid")?
            .value
        }
        None => {
            // A FIFO/directory is not an absent settings file. Never discard
            // an existing configuration and manufacture default admission.
            match std::fs::symlink_metadata(&path) {
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
                _ => return Err("context_settings_unavailable"),
            }
        }
    };
    Ok(settings)
}
fn item(id: &str, title: &str, content: String) -> ConfigInstruction {
    ConfigInstruction {
        id: id.into(),
        title: title.into(),
        content,
        source: Some(id.into()),
        priority: 0,
    }
}
fn validate_legacy_metadata(settings: &Value) -> Result<(), &'static str> {
    if settings
        .get("themeMode")
        .is_some_and(|value| !matches!(value.as_str(), Some("light" | "dark" | "system")))
        || settings.get("localAccessLevel").is_some_and(|value| {
            !value.is_string() || LocalAccessLevel::deserialize(value).is_err()
        })
    {
        return Err("context_settings_invalid");
    }

    for key in ["activeWorkspace", "appMode", "effort", "updateChannel"] {
        if settings
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err("context_settings_invalid");
        }
    }
    if settings
        .get("workspaces")
        .is_some_and(|v| !v.is_null() && !v.is_array())
    {
        return Err("context_settings_invalid");
    }
    for key in [
        "appearance",
        "appshots",
        "composerDrafts",
        "developer",
        "fallbackVision",
        "inputPrediction",
        "memory",
        "modelRouting",
        "remoteAccess",
        "workbench",
    ] {
        if settings
            .get(key)
            .is_some_and(|v| !v.is_null() && !v.is_object())
        {
            return Err("context_settings_invalid");
        }
    }

    if let Some(project) = settings.get("projectAgent") {
        let project = project.as_object().ok_or("context_settings_invalid")?;
        for (key, value) in project {
            match key.as_str() {
                "shell" if value == "bots" => {}
                "shell" if !value.is_string() => return Err("context_settings_invalid"),
                "shellIntroPending" | "shellIntroDismissed" | "interactiveResults"
                    if value.is_boolean() => {}
                "shellIntroPending" | "shellIntroDismissed" | "interactiveResults" => {
                    return Err("context_settings_invalid");
                }
                "proactivity" | "digestTime" | "communicationStyle"
                    if value.is_null() || value.is_string() => {}
                "proactivity" | "digestTime" | "communicationStyle" => {
                    return Err("context_settings_invalid");
                }
                "quietHours" if value.is_null() || value.is_object() => {}
                "quietHours" => return Err("context_settings_invalid"),
                "concurrency" if value.is_null() || value.is_number() => {}
                "concurrency" => return Err("context_settings_invalid"),
                _ => return Err("native_capability_inventory_unsupported"),
            }
        }
    }
    Ok(())
}

pub(super) fn project(settings: &Value) -> Result<Vec<ConfigInstruction>, &'static str> {
    let object = settings.as_object().ok_or("context_settings_invalid")?;
    if object.keys().any(|k| {
        !matches!(
            k.as_str(),
            "schemaVersion"
                | "locale"
                | "replyLanguage"
                | "systemInstructions"
                | "gitBranchPrefix"
                | "themeMode"
                | "localAccessLevel"
                | "projectAgent"
                | "activeWorkspace"
                | "workspaces"
                | "appearance"
                | "appMode"
                | "appshots"
                | "composerDrafts"
                | "developer"
                | "effort"
                | "fallbackVision"
                | "inputPrediction"
                | "memory"
                | "modelRouting"
                | "remoteAccess"
                | "updateChannel"
                | "workbench"
        )
    }) {
        return Err("native_capability_inventory_unsupported");
    }
    if settings.get("schemaVersion").is_some_and(|v| {
        !v.as_f64()
            .is_some_and(|n| (0.0..=3.0).contains(&n) && n.fract() == 0.0)
    }) {
        return Err("context_settings_schema_unsupported");
    }
    // Both execution hosts already receive their effective permission policy
    // from the active authority. These settings remain read-only metadata.
    validate_legacy_metadata(settings)?;
    validate_prompt_fields(settings)?;
    Ok(build_prompt_instructions(settings))
}

pub(super) fn project_desktop(settings: &Value) -> Result<Vec<ConfigInstruction>, &'static str> {
    if !settings.is_object() {
        return Err("context_settings_invalid");
    }
    validate_prompt_fields(settings)?;
    Ok(build_prompt_instructions(settings))
}

fn validate_prompt_fields(settings: &Value) -> Result<(), &'static str> {
    for field in [
        "locale",
        "replyLanguage",
        "systemInstructions",
        "gitBranchPrefix",
    ] {
        if settings
            .get(field)
            .is_some_and(|v| !v.is_null() && !v.is_string())
        {
            return Err("context_settings_invalid");
        }
    }
    Ok(())
}

fn build_prompt_instructions(settings: &Value) -> Vec<ConfigInstruction> {
    let mut config = Vec::new();
    if let Some(content) = settings["systemInstructions"]
        .as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty())
    {
        config.push(item(
            "settings.systemInstructions",
            "System Instructions",
            content.into(),
        ));
    }
    // createTuiLanguageStore.getPromptSettings uses a literal configured string;
    // otherwise its normalized locale (default zh-CN) supplies the reply language.
    let language = javascript_trim(
        settings["replyLanguage"]
            .as_str()
            .unwrap_or_else(|| normalized_locale(settings)),
    );
    let name = match language {
        "zh-CN" => Some("Simplified Chinese (简体中文)"),
        "zh-TW" => Some("Traditional Chinese (繁體中文)"),
        "en-US" => Some("English"),
        "ja-JP" => Some("Japanese (日本語)"),
        "ko-KR" => Some("Korean (한국어)"),
        "fr-FR" => Some("French (Français)"),
        "de-DE" => Some("German (Deutsch)"),
        "es-ES" => Some("Spanish (Español)"),
        "ru-RU" => Some("Russian (Русский)"),
        _ => None,
    };
    if let Some(name) = name {
        config.push(item("settings.replyLanguage","Reply Language",format!("Always write your replies to the user in {name}, regardless of the language the user writes in. Keep code, file paths, identifiers, and quoted content unchanged.")));
    }
    let prefix = settings["gitBranchPrefix"]
        .as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("PeerAgent/");
    config.push(item("settings.gitBranchPrefix","Git Branch Prefix",format!("When you create a new git branch (e.g. via `git checkout -b` or `git switch -c`), always name it with the prefix \"{prefix}\". For example, a feature branch should be named like \"{prefix}my-feature\". Do not apply this prefix to existing branches you only check out.")));
    config
}
