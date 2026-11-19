//! Read/write TUI theme & locale preferences in `<PEER_AGENT_HOME>/settings.json`.
//!
//! Strictly read-only on open (never writes files when `settings.json` is absent)
//! and preserves all unrelated/Desktop keys during atomic updates.

use peer_tui::{DARK_PALETTE, LIGHT_PALETTE, ThemeMode, ThemeScheme, TuiLocale, TuiPalette};
use serde_json::{Map, Value};
use std::{
    fs, io,
    path::{Path, PathBuf},
    process::{Command, Stdio},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(in crate::terminal) struct TerminalPreferences {
    pub mode: ThemeMode,
    pub scheme: ThemeScheme,
    pub locale: TuiLocale,
}

impl TerminalPreferences {
    pub fn palette(&self) -> &'static TuiPalette {
        match self.scheme {
            ThemeScheme::Dark => &DARK_PALETTE,
            ThemeScheme::Light => &LIGHT_PALETTE,
        }
    }
}

fn settings_path(home: &Path) -> PathBuf {
    home.join("settings.json")
}

pub(in crate::terminal) fn detect_system_scheme() -> ThemeScheme {
    if cfg!(target_os = "macos")
        && let Ok(out) = Command::new("/usr/bin/defaults")
            .args(["read", "-g", "AppleInterfaceStyle"])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
    {
        return if out.status.success() && String::from_utf8_lossy(&out.stdout).trim() == "Dark" {
            ThemeScheme::Dark
        } else {
            ThemeScheme::Light
        };
    }

    if let Ok(cfg) = std::env::var("COLORFGBG")
        && let Some(bg_str) = cfg.rsplit(';').next()
        && let Ok(bg) = bg_str.trim().parse::<u8>()
    {
        return if bg < 8 {
            ThemeScheme::Dark
        } else {
            ThemeScheme::Light
        };
    }

    ThemeScheme::Dark
}

pub(in crate::terminal) fn resolve_scheme(mode: ThemeMode) -> ThemeScheme {
    match mode {
        ThemeMode::Dark => ThemeScheme::Dark,
        ThemeMode::Light => ThemeScheme::Light,
        ThemeMode::System => detect_system_scheme(),
    }
}

/// Strictly read-only preference load (defaults to `Dark` & `ZhCn` when absent).
pub(in crate::terminal) fn load_preferences(home: &Path) -> TerminalPreferences {
    let mut mode = ThemeMode::Dark;
    let mut locale = TuiLocale::ZhCn;

    if let Ok(raw) = fs::read_to_string(settings_path(home))
        && let Ok(Value::Object(map)) = serde_json::from_str::<Value>(&raw)
    {
        if let Some(m) = map
            .get("themeMode")
            .and_then(Value::as_str)
            .and_then(ThemeMode::parse)
        {
            mode = m;
        }
        if let Some(l) = map
            .get("language")
            .and_then(Value::as_str)
            .and_then(TuiLocale::parse)
        {
            locale = l;
        }
    }

    TerminalPreferences {
        mode,
        scheme: resolve_scheme(mode),
        locale,
    }
}

fn update_settings_key(home: &Path, key: &str, value: Value) -> io::Result<()> {
    let path = settings_path(home);
    let mut map = match fs::read_to_string(&path) {
        Ok(raw) => match serde_json::from_str::<Value>(&raw) {
            Ok(Value::Object(obj)) => obj,
            _ => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "settings.json is corrupt; refusing to overwrite",
                ));
            }
        },
        Err(err) if err.kind() == io::ErrorKind::NotFound => Map::new(),
        Err(err) => return Err(err),
    };

    map.insert(key.to_owned(), value);
    fs::create_dir_all(home)?;
    let encoded = serde_json::to_string_pretty(&Value::Object(map)).map_err(io::Error::other)?;
    let tmp = tempfile::Builder::new()
        .prefix(".settings-")
        .suffix(".tmp")
        .tempfile_in(home)?;
    fs::write(tmp.path(), format!("{encoded}\n"))?;
    tmp.persist(&path).map_err(|e| e.error)?;
    Ok(())
}

pub(in crate::terminal) fn save_theme_mode(
    home: &Path,
    mode: ThemeMode,
) -> io::Result<ThemeScheme> {
    update_settings_key(home, "themeMode", Value::String(mode.as_str().to_owned()))?;
    Ok(resolve_scheme(mode))
}

pub(in crate::terminal) fn save_locale(home: &Path, locale: TuiLocale) -> io::Result<()> {
    update_settings_key(home, "language", Value::String(locale.as_str().to_owned()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn settings_roundtrip_preserves_unrelated_keys_and_refuses_corrupt_file() {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path();

        // Missing file -> read-only defaults, creates nothing
        let prefs = load_preferences(home);
        assert_eq!(prefs.mode, ThemeMode::Dark);
        assert_eq!(prefs.locale, TuiLocale::ZhCn);
        assert!(!home.join("settings.json").exists());

        // Seed unrelated Desktop keys
        fs::write(
            home.join("settings.json"),
            serde_json::to_string_pretty(&json!({
                "desktopDensity": "compact",
                "themeMode": "dark"
            }))
            .unwrap(),
        )
        .unwrap();

        let scheme = save_theme_mode(home, ThemeMode::Light).unwrap();
        assert_eq!(scheme, ThemeScheme::Light);
        save_locale(home, TuiLocale::EnUs).unwrap();

        let updated: Value =
            serde_json::from_str(&fs::read_to_string(home.join("settings.json")).unwrap()).unwrap();
        assert_eq!(updated["desktopDensity"], "compact");
        assert_eq!(updated["themeMode"], "light");
        assert_eq!(updated["language"], "en-US");

        let reloaded = load_preferences(home);
        assert_eq!(reloaded.mode, ThemeMode::Light);
        assert_eq!(reloaded.scheme, ThemeScheme::Light);
        assert_eq!(reloaded.locale, TuiLocale::EnUs);

        // Corrupt JSON is never clobbered
        fs::write(home.join("settings.json"), b"{corrupt").unwrap();
        assert!(save_theme_mode(home, ThemeMode::Dark).is_err());
        assert_eq!(fs::read(home.join("settings.json")).unwrap(), b"{corrupt");
    }
}
