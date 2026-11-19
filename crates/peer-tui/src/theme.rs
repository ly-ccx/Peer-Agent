//! Pure Peer Frost visual system and semantic chrome tokens (mirrors `apps/tui/src/tui-theme.ts`).
//!
//! Strictly pure display constants and helpers with zero filesystem or process I/O.

use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Style},
    widgets::Block,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeMode {
    #[default]
    Dark,
    Light,
    System,
}

impl ThemeMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
            Self::System => "system",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "dark" | "深色" => Some(Self::Dark),
            "light" | "浅色" => Some(Self::Light),
            "system" | "auto" | "跟随系统" => Some(Self::System),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ThemeScheme {
    #[default]
    Dark,
    Light,
}

impl ThemeScheme {
    pub const fn cache_id(self) -> u8 {
        match self {
            Self::Dark => 0,
            Self::Light => 1,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Dark => "dark",
            Self::Light => "light",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum TuiLocale {
    #[default]
    ZhCn,
    EnUs,
}

impl TuiLocale {
    pub const fn is_zh(self) -> bool {
        matches!(self, Self::ZhCn)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::ZhCn => "zh-CN",
            Self::EnUs => "en-US",
        }
    }

    pub fn parse(raw: &str) -> Option<Self> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "zh" | "zh-cn" | "zh_cn" | "cn" | "中文" => Some(Self::ZhCn),
            "en" | "en-us" | "en_us" | "english" | "英文" => Some(Self::EnUs),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TuiPalette {
    pub background: Color,
    pub panel: Color,
    pub panel_raised: Color,
    pub user_panel: Color,
    pub selection: Color,
    pub text_selection_bg: Color,
    pub text_selection_fg: Color,
    pub input_bg: Color,
    pub input_fg: Color,
    pub input_placeholder: Color,
    pub border: Color,
    pub border_focus: Color,
    pub text: Color,
    pub text_soft: Color,
    pub muted: Color,
    pub subtle: Color,
    pub dim: Color,
    pub accent: Color,
    pub accent_soft: Color,
    pub link: Color,
    pub brand_highlight: Color,
    pub user: Color,
    pub info: Color,
    pub success: Color,
    pub warning: Color,
    pub danger: Color,
    pub danger_soft: Color,
    pub tool: Color,
    pub tool_failed: Color,
    pub tool_running: Color,
    pub tool_cancelled: Color,
    pub tool_detail: Color,
    pub code: Color,
    pub code_bg: Color,
    pub diff_add: Color,
    pub diff_delete: Color,
    pub diff_hunk: Color,
    pub diff_meta: Color,
}

pub static DARK_PALETTE: TuiPalette = TuiPalette {
    background: Color::Rgb(0x08, 0x0a, 0x0c),
    panel: Color::Rgb(0x0d, 0x10, 0x13),
    panel_raised: Color::Rgb(0x12, 0x16, 0x1a),
    user_panel: Color::Rgb(0x0d, 0x10, 0x13),
    selection: Color::Rgb(0x17, 0x1c, 0x21),
    text_selection_bg: Color::Rgb(0xb8, 0xf3, 0x5b),
    text_selection_fg: Color::Rgb(0x08, 0x0a, 0x0c),
    input_bg: Color::Rgb(0x08, 0x0a, 0x0c),
    input_fg: Color::Rgb(0xe7, 0xeb, 0xee),
    input_placeholder: Color::Rgb(0x69, 0x73, 0x7d),
    border: Color::Rgb(0x20, 0x26, 0x2c),
    border_focus: Color::Rgb(0x3e, 0x48, 0x51),
    text: Color::Rgb(0xe7, 0xeb, 0xee),
    text_soft: Color::Rgb(0xb8, 0xc0, 0xc7),
    muted: Color::Rgb(0x69, 0x73, 0x7d),
    subtle: Color::Rgb(0x56, 0x61, 0x6b),
    dim: Color::Rgb(0x3e, 0x48, 0x51),
    accent: Color::Rgb(0xb8, 0xf3, 0x5b),
    accent_soft: Color::Rgb(0xd0, 0xfa, 0x8e),
    link: Color::Rgb(0xa9, 0xd9, 0xe8),
    brand_highlight: Color::Rgb(0xff, 0xff, 0xff),
    user: Color::Rgb(0xa9, 0xd9, 0xe8),
    info: Color::Rgb(0xa9, 0xd9, 0xe8),
    success: Color::Rgb(0x68, 0xd3, 0x91),
    warning: Color::Rgb(0xe6, 0xb8, 0x6a),
    danger: Color::Rgb(0xef, 0x73, 0x73),
    danger_soft: Color::Rgb(0xf5, 0x9a, 0x9a),
    tool: Color::Rgb(0x68, 0xd3, 0x91),
    tool_failed: Color::Rgb(0xef, 0x73, 0x73),
    tool_running: Color::Rgb(0xe6, 0xb8, 0x6a),
    tool_cancelled: Color::Rgb(0x69, 0x73, 0x7d),
    tool_detail: Color::Rgb(0x69, 0x73, 0x7d),
    code: Color::Rgb(0xb8, 0xf3, 0x5b),
    code_bg: Color::Rgb(0x12, 0x16, 0x1a),
    diff_add: Color::Rgb(0x68, 0xd3, 0x91),
    diff_delete: Color::Rgb(0xef, 0x73, 0x73),
    diff_hunk: Color::Rgb(0xa9, 0xd9, 0xe8),
    diff_meta: Color::Rgb(0x69, 0x73, 0x7d),
};

pub static LIGHT_PALETTE: TuiPalette = TuiPalette {
    background: Color::Rgb(0xF3, 0xF5, 0xF8),
    panel: Color::Rgb(0xFF, 0xFF, 0xFF),
    panel_raised: Color::Rgb(0xF7, 0xF9, 0xFC),
    user_panel: Color::Rgb(0xE8, 0xF1, 0xFF),
    selection: Color::Rgb(0xE8, 0xEE, 0xF7),
    text_selection_bg: Color::Rgb(0x1E, 0x3A, 0x5F),
    text_selection_fg: Color::Rgb(0xFF, 0xFF, 0xFF),
    input_bg: Color::Rgb(0xF3, 0xF5, 0xF8),
    input_fg: Color::Rgb(0x1A, 0x23, 0x32),
    input_placeholder: Color::Rgb(0x6B, 0x75, 0x85),
    border: Color::Rgb(0xDC, 0xE0, 0xE8),
    border_focus: Color::Rgb(0xC8, 0xCE, 0xDA),
    text: Color::Rgb(0x1A, 0x23, 0x32),
    text_soft: Color::Rgb(0x2A, 0x35, 0x48),
    muted: Color::Rgb(0x6B, 0x75, 0x85),
    subtle: Color::Rgb(0x8B, 0x93, 0xA1),
    dim: Color::Rgb(0xA8, 0xB0, 0xBC),
    accent: Color::Rgb(0x4D, 0x7C, 0x0F),
    accent_soft: Color::Rgb(0x65, 0xA3, 0x0D),
    link: Color::Rgb(0x25, 0x63, 0xEB),
    brand_highlight: Color::Rgb(0xFF, 0xFF, 0xFF),
    user: Color::Rgb(0x25, 0x63, 0xEB),
    info: Color::Rgb(0x4F, 0x7C, 0xFF),
    success: Color::Rgb(0x1A, 0x8F, 0x4A),
    warning: Color::Rgb(0xB4, 0x53, 0x09),
    danger: Color::Rgb(0xC2, 0x3B, 0x3B),
    danger_soft: Color::Rgb(0xDC, 0x6B, 0x6B),
    tool: Color::Rgb(0x1A, 0x8F, 0x4A),
    tool_failed: Color::Rgb(0xC2, 0x3B, 0x3B),
    tool_running: Color::Rgb(0xB4, 0x53, 0x09),
    tool_cancelled: Color::Rgb(0x8B, 0x93, 0xA1),
    tool_detail: Color::Rgb(0x6B, 0x75, 0x85),
    code: Color::Rgb(0x3F, 0x62, 0x12),
    code_bg: Color::Rgb(0xEB, 0xEE, 0xF3),
    diff_add: Color::Rgb(0x1A, 0x8F, 0x4A),
    diff_delete: Color::Rgb(0xC2, 0x3B, 0x3B),
    diff_hunk: Color::Rgb(0x25, 0x63, 0xEB),
    diff_meta: Color::Rgb(0x6B, 0x75, 0x85),
};

// Shared picker & chrome glyphs (`apps/tui/src/tui-theme.ts`)
pub const CARET_SELECTED: &str = "› ";
pub const CARET_IDLE: &str = "  ";
pub const CHECK_CURRENT: &str = " ✓";
pub const SEPARATOR: &str = "─";
pub const HINT_SEPARATOR: &str = " · ";

pub const BRAND_MARK: &str = "◆";
pub const ONLINE_DOT: &str = "●";
pub const OFFLINE_DOT: &str = "○";
pub const USER_RAIL_BAR: &str = "▌ ";

pub const HEADING_H1: &str = "▌ ";
pub const HEADING_H2: &str = "› ";
pub const HEADING_H3: &str = "• ";
pub const LIST_BULLET: &str = "• ";
pub const QUOTE_PREFIX: &str = "│ ";

pub fn palette_for(scheme: ThemeScheme) -> &'static TuiPalette {
    match scheme {
        ThemeScheme::Dark => &DARK_PALETTE,
        ThemeScheme::Light => &LIGHT_PALETTE,
    }
}

/// Context usage accent for the status-bar meter (`apps/tui/src/tui-theme.ts`).
pub fn context_usage_color(percent: Option<u8>, palette: &TuiPalette) -> Color {
    match percent {
        Some(p) if p >= 90 => palette.danger,
        Some(p) if p >= 80 => palette.warning,
        _ => palette.user,
    }
}

/// Fill an entire frame/area with the Frost canvas background.
pub fn fill_canvas(frame: &mut Frame<'_>, area: Rect, bg: Color) {
    frame.render_widget(Block::default().style(Style::new().bg(bg)), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn palettes_match_frost_dark_and_light_tokens() {
        assert_eq!(DARK_PALETTE.background, Color::Rgb(8, 10, 12));
        assert_eq!(DARK_PALETTE.accent, Color::Rgb(184, 243, 91));
        assert_eq!(LIGHT_PALETTE.background, Color::Rgb(243, 245, 248));
        assert_eq!(LIGHT_PALETTE.accent, Color::Rgb(77, 124, 15));
        assert_eq!(
            context_usage_color(Some(95), &DARK_PALETTE),
            DARK_PALETTE.danger
        );
        assert_eq!(
            context_usage_color(Some(85), &DARK_PALETTE),
            DARK_PALETTE.warning
        );
        assert_eq!(
            context_usage_color(Some(40), &DARK_PALETTE),
            DARK_PALETTE.user
        );
    }
}
