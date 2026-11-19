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

pub const TOOL_GLYPH_COMPLETED: &str = "✓";
pub const TOOL_GLYPH_FAILED: &str = "✗";
pub const TOOL_GLYPH_CANCELLED: &str = "○";
pub const TOOL_GLYPH_RUNNING: &str = "◇";
pub const TOOL_GLYPH_RUNNING_PULSE: &str = "◆";
pub const TOOL_GLYPH_UNKNOWN: &str = "·";
pub const TOOL_DETAIL_PIPE: &str = "┆";

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

/// Topbar subscription quota color (`apps/tui/src/tui-subscription-quota.ts`).
pub fn subscription_quota_color(remaining: Option<u8>, palette: &TuiPalette) -> Color {
    match remaining {
        Some(r) if r <= 10 => palette.danger,
        Some(r) if r <= 30 => palette.warning,
        Some(_) => palette.success,
        None => palette.muted,
    }
}

/// Compact topbar subscription quota text (`剩余72% · plus` / `72% · plus`).
pub fn format_topbar_quota(remaining: u8, plan_label: Option<&str>, locale: TuiLocale) -> String {
    let plan = plan_label.map(str::trim).filter(|s| !s.is_empty());
    if locale.is_zh() {
        match plan {
            Some(p) => format!("剩余{remaining}% · {p}"),
            None => format!("剩余{remaining}%"),
        }
    } else {
        match plan {
            Some(p) => format!("{remaining}% · {p}"),
            None => format!("{remaining}%"),
        }
    }
}

/// Visual block meter (`███░░░`) matching `apps/tui/src/composer-status-view.tsx`.
pub fn context_meter_parts(percent: Option<u8>, width: usize) -> (String, String) {
    if width == 0 {
        return (String::new(), String::new());
    }
    let bounded = usize::from(percent.unwrap_or(0).min(100));
    let filled = (((bounded as f64 / 100.0) * width as f64).round() as usize).min(width);
    ("█".repeat(filled), "░".repeat(width.saturating_sub(filled)))
}

pub const RUNNING_ACTIVITY_LABEL: &str = "working...";
pub const WORKING_ANIMATION_INTERVAL_MS: u64 = 80;
const SWEEP_FALLOFF: f64 = 2.0;
const SWEEP_LEAD: usize = 6;

fn rgb_to_hsl(r: u8, g: u8, b: u8) -> (f64, f64, f64) {
    let rn = f64::from(r) / 255.0;
    let gn = f64::from(g) / 255.0;
    let bn = f64::from(b) / 255.0;
    let max = rn.max(gn).max(bn);
    let min = rn.min(gn).min(bn);
    let l = (max + min) / 2.0;
    if (max - min).abs() < f64::EPSILON {
        return (0.0, 0.0, l);
    }
    let d = max - min;
    let s = if l > 0.5 {
        d / (2.0 - max - min)
    } else {
        d / (max + min)
    };
    let h = if (max - rn).abs() < f64::EPSILON {
        (gn - bn) / d + if gn < bn { 6.0 } else { 0.0 }
    } else if (max - gn).abs() < f64::EPSILON {
        (bn - rn) / d + 2.0
    } else {
        (rn - gn) / d + 4.0
    };
    (h / 6.0, s, l)
}

fn hue_to_rgb(p: f64, q: f64, mut t: f64) -> f64 {
    if t < 0.0 {
        t += 1.0;
    }
    if t > 1.0 {
        t -= 1.0;
    }
    if t < 1.0 / 6.0 {
        return p + (q - p) * 6.0 * t;
    }
    if t < 0.5 {
        return q;
    }
    if t < 2.0 / 3.0 {
        return p + (q - p) * (2.0 / 3.0 - t) * 6.0;
    }
    p
}

fn hsl_to_rgb(h: f64, s: f64, l: f64) -> (u8, u8, u8) {
    if s.abs() < 1e-12 {
        let v = (l * 255.0).round().clamp(0.0, 255.0) as u8;
        return (v, v, v);
    }
    let q = if l < 0.5 {
        l * (1.0 + s)
    } else {
        l + s - l * s
    };
    let p = 2.0 * l - q;
    let r = (hue_to_rgb(p, q, h + 1.0 / 3.0) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8;
    let g = (hue_to_rgb(p, q, h) * 255.0).round().clamp(0.0, 255.0) as u8;
    let b = (hue_to_rgb(p, q, h - 1.0 / 3.0) * 255.0)
        .round()
        .clamp(0.0, 255.0) as u8;
    (r, g, b)
}

fn lerp_hue(a: f64, b: f64, t: f64) -> f64 {
    let mut delta = b - a;
    if delta > 0.5 {
        delta -= 1.0;
    }
    if delta < -0.5 {
        delta += 1.0;
    }
    (a + delta * t + 1.0) % 1.0
}

pub fn blend_hsl_colors(from: Color, to: Color, t: f64) -> Color {
    let (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) = (from, to) else {
        return from;
    };
    let (h1, s1, l1) = rgb_to_hsl(r1, g1, b1);
    let (h2, s2, l2) = rgb_to_hsl(r2, g2, b2);
    let tt = t.clamp(0.0, 1.0);
    let (r, g, b) = hsl_to_rgb(
        lerp_hue(h1, h2, tt),
        s1 + (s2 - s1) * tt,
        l1 + (l2 - l1) * tt,
    );
    Color::Rgb(r, g, b)
}

/// Specular highlight intensity sweeping across `working...` (`composer-status-view.tsx`).
pub fn activity_sweep_intensity(index: usize, frame: usize, length: usize) -> f64 {
    if length == 0 {
        return 0.0;
    }
    let period = length + SWEEP_LEAD * 2;
    let pos = (frame % period) as f64 - SWEEP_LEAD as f64;
    let dist = (index as f64 - pos).abs();
    let t = (1.0 - dist / SWEEP_FALLOFF).clamp(0.0, 1.0);
    t * t
}

/// Resting lime with a white highlight band that sweeps left to right (`composer-status-view.tsx`).
pub fn activity_sweep_color(
    index: usize,
    frame: usize,
    length: usize,
    palette: &TuiPalette,
) -> Color {
    let rest = blend_hsl_colors(palette.accent, palette.muted, 0.35);
    blend_hsl_colors(
        rest,
        palette.brand_highlight,
        activity_sweep_intensity(index, frame, length),
    )
}

/// Compact day/hour/minute/second elapsed time (`tool-result-summary.ts`).
pub fn format_running_elapsed(elapsed_ms: u64) -> String {
    let mut remaining = elapsed_ms / 1_000;
    let days = remaining / 86_400;
    remaining %= 86_400;
    let hours = remaining / 3_600;
    remaining %= 3_600;
    let minutes = remaining / 60;
    let seconds = remaining % 60;
    let mut out = String::new();
    if days > 0 {
        out.push_str(&format!("{days}d"));
    }
    if hours > 0 {
        out.push_str(&format!("{hours}h"));
    }
    if minutes > 0 {
        out.push_str(&format!("{minutes}m"));
    }
    if seconds > 0 || out.is_empty() {
        out.push_str(&format!("{seconds}s"));
    }
    out
}

/// Trailing three-dot animation for pending `PEER` placeholders (`tool-result-summary.ts`).
pub fn thinking_status_label(frame: usize) -> &'static str {
    match frame % 3 {
        0 => "Thinking.",
        1 => "Thinking..",
        _ => "Thinking...",
    }
}

/// Elapsed duration label for tool timeline rows (`tool-result-summary.ts`).
pub fn format_tool_duration(is_running: bool, duration_ms: Option<u64>) -> String {
    if is_running {
        return "now".to_owned();
    }
    let Some(ms) = duration_ms else {
        return "—".to_owned();
    };
    if ms < 1_000 {
        format!("{:.1}s", (ms as f64 / 1000.0).max(0.1))
    } else if ms < 10_000 {
        format!("{:.1}s", ms as f64 / 1000.0)
    } else {
        format!("{}s", (ms as f64 / 1000.0).round() as u64)
    }
}

/// Replace `/Users/<name>` or `/home/<name>` prefix with `~` (`composer-status.ts`).
pub fn compact_workspace_path(path: &str) -> String {
    let trimmed = path.trim().trim_end_matches(['/', '\\']);
    let clean = if trimmed.is_empty() {
        path.trim()
    } else {
        trimmed
    };
    let clean = if clean.is_empty() { "." } else { clean };
    for prefix in ["/Users/", "/home/"] {
        if let Some(rest) = clean.strip_prefix(prefix) {
            if let Some(idx) = rest.find('/') {
                return format!("~{}", &rest[idx..]);
            }
            return "~".to_owned();
        }
    }
    clean.to_owned()
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
        assert_eq!(
            subscription_quota_color(Some(8), &DARK_PALETTE),
            DARK_PALETTE.danger
        );
        assert_eq!(
            subscription_quota_color(Some(25), &DARK_PALETTE),
            DARK_PALETTE.warning
        );
        assert_eq!(
            subscription_quota_color(Some(72), &DARK_PALETTE),
            DARK_PALETTE.success
        );
        assert_eq!(
            format_topbar_quota(72, Some("plus"), TuiLocale::ZhCn),
            "剩余72% · plus"
        );
        assert_eq!(
            format_topbar_quota(72, Some("plus"), TuiLocale::EnUs),
            "72% · plus"
        );
        assert_eq!(
            context_meter_parts(Some(50), 12),
            ("██████".to_owned(), "░░░░░░".to_owned())
        );
        assert_eq!(
            compact_workspace_path("/Users/alice/Documents/peer-dev"),
            "~/Documents/peer-dev"
        );
    }

    #[test]
    fn working_animation_sweep_elapsed_and_thinking_match_opentui() {
        let len = RUNNING_ACTIVITY_LABEL.chars().count();
        assert_eq!(len, 10);
        let rest = activity_sweep_color(0, 0, len, &DARK_PALETTE);
        for idx in 0..len {
            assert_eq!(activity_sweep_intensity(idx, 0, len), 0.0);
            assert_eq!(activity_sweep_color(idx, 0, len, &DARK_PALETTE), rest);
        }
        assert_eq!(activity_sweep_intensity(0, 6, len), 1.0);
        assert_eq!(
            activity_sweep_color(0, 6, len, &DARK_PALETTE),
            DARK_PALETTE.brand_highlight
        );
        // Sweep moves left -> right across frames 6..15.
        for idx in 0..len {
            assert_eq!(activity_sweep_intensity(idx, 6 + idx, len), 1.0);
        }
        assert_eq!(format_running_elapsed(0), "0s");
        assert_eq!(format_running_elapsed(8_000), "8s");
        assert_eq!(format_running_elapsed(65_000), "1m5s");
        assert_eq!(format_running_elapsed(3_723_000), "1h2m3s");
        assert_eq!(format_running_elapsed(93_600_000), "1d2h");
        assert_eq!(thinking_status_label(0), "Thinking.");
        assert_eq!(thinking_status_label(1), "Thinking..");
        assert_eq!(thinking_status_label(2), "Thinking...");
        assert_eq!(thinking_status_label(3), "Thinking.");
        assert_eq!(format_tool_duration(true, Some(500)), "now");
        assert_eq!(format_tool_duration(false, None), "—");
        assert_eq!(format_tool_duration(false, Some(40)), "0.1s");
        assert_eq!(format_tool_duration(false, Some(200)), "0.2s");
        assert_eq!(format_tool_duration(false, Some(2_500)), "2.5s");
        assert_eq!(format_tool_duration(false, Some(12_400)), "12s");
    }
}
