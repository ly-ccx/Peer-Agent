//! Read-only Host projection of the prompt settings already used by TUI.
//! Other settings remain explicit admission blockers until their adapters exist.
use super::{ConfigInstruction, files};
use crate::CancellationToken;
use peer_protocol::{JsonLimits, decode_json_bounded, javascript_trim};
use serde_json::{Value, json};
use std::path::Path;

pub(super) fn read_host_prompt_settings(
    home: &Path,
    cancel: &CancellationToken,
) -> Result<Vec<ConfigInstruction>, &'static str> {
    project(&read_host_settings(home, cancel)?)
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
pub(super) fn project(settings: &Value) -> Result<Vec<ConfigInstruction>, &'static str> {
    let object = settings.as_object().ok_or("context_settings_invalid")?;
    if object.keys().any(|k| {
        !matches!(
            k.as_str(),
            "schemaVersion" | "locale" | "replyLanguage" | "systemInstructions" | "gitBranchPrefix"
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
    Ok(config)
}
