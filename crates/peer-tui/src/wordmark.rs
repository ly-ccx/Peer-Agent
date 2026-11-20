//! Exact B3 `peer agent` terminal wordmark (`apps/tui/src/b3-wordmark.ts` & `b3-wordmark-view.tsx`).
//!
//! Renders the 7x23 pixel matrix in Full (width >= 76), Half-block (width >= 42),
//! or Narrow fallback, mapping roles onto the active Frost `TuiPalette`.

use crate::theme::TuiPalette;
use ratatui::{
    style::{Color, Style},
    text::{Line, Span},
};

const P_GLYPH: [&str; 7] = [
    "00000", "11110", "10001", "10001", "11110", "10000", "10000",
];
const E_GLYPH: [&str; 7] = [
    "00000", "01110", "10001", "11111", "10000", "01110", "00000",
];
const R_GLYPH: [&str; 7] = [
    "00000", "10110", "11001", "10000", "10000", "10000", "00000",
];

const B3_SIGNAL_ROW: usize = 3;
const B3_SIGNAL_COLS: (usize, usize) = (6, 16);
const B3_AGENT_ROW: usize = 5;
const MATRIX_WIDTH: usize = 23;

/// Milliseconds per matrix row during the startup top-to-bottom wordmark reveal.
pub const WORDMARK_REVEAL_STEP_MS: u64 = 100;
/// Period (ms) of the glacial-azure breathing shimmer after reveal completes.
pub const WORDMARK_BREATHE_PERIOD_MS: u64 = 2_000;
/// Animation tick interval (ms) while an empty hero wordmark is on screen.
pub const WORDMARK_ANIMATION_TICK_MS: u64 = 125;
const WORDMARK_BREATHE_AMPLITUDE: f64 = 0.35;
const MATRIX_HEIGHT: usize = 7;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Role {
    Primary,
    Signal,
    Muted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum B3Variant {
    Full,
    Half,
    Narrow,
}

impl B3Variant {
    pub const fn for_width(width: u16) -> Self {
        if width >= 76 {
            Self::Full
        } else if width >= 42 {
            Self::Half
        } else {
            Self::Narrow
        }
    }
}

fn compose_matrix() -> [[u8; MATRIX_WIDTH]; MATRIX_HEIGHT] {
    let glyphs = [&P_GLYPH, &E_GLYPH, &E_GLYPH, &R_GLYPH];
    let mut matrix = [[0u8; MATRIX_WIDTH]; MATRIX_HEIGHT];
    for (row_idx, row) in matrix.iter_mut().enumerate() {
        let mut col = 0usize;
        for (gi, glyph) in glyphs.iter().enumerate() {
            for b in glyph[row_idx].as_bytes() {
                row[col] = u8::from(*b == b'1');
                col += 1;
            }
            if gi < glyphs.len() - 1 {
                row[col] = 0;
                col += 1;
            }
        }
    }
    matrix[B3_SIGNAL_ROW][B3_SIGNAL_COLS.0..=B3_SIGNAL_COLS.1].fill(2);
    matrix
}

const fn cell_role(cell: u8) -> Option<Role> {
    match cell {
        1 => Some(Role::Primary),
        2 => Some(Role::Signal),
        _ => None,
    }
}

fn resolve_color(role: Role, palette: &TuiPalette, signal_override: Option<Color>) -> Color {
    match role {
        Role::Primary => palette.text,
        Role::Signal => signal_override.unwrap_or(palette.info),
        Role::Muted => palette.muted,
    }
}

fn lerp_rgb(from: Color, to: Color, t: f64) -> Color {
    let t = t.clamp(0.0, 1.0);
    match (from, to) {
        (Color::Rgb(r1, g1, b1), Color::Rgb(r2, g2, b2)) => {
            let mix = |a: u8, b: u8| -> u8 {
                (f64::from(a) + (f64::from(b) - f64::from(a)) * t)
                    .round()
                    .clamp(0.0, 255.0) as u8
            };
            Color::Rgb(mix(r1, r2), mix(g1, g2), mix(b1, b2))
        }
        _ => from,
    }
}

/// Computes the breathing highlight color for the signal bar at `phase` in `[0.0, 1.0)`.
pub fn breathe_signal_color(palette: &TuiPalette, phase: f64) -> Color {
    let normalized = phase.rem_euclid(1.0);
    let wave = 0.5 - 0.5 * (normalized * std::f64::consts::TAU).cos();
    lerp_rgb(
        palette.info,
        palette.brand_highlight,
        wave * WORDMARK_BREATHE_AMPLITUDE,
    )
}

fn push_seg(
    segs: &mut Vec<(String, Option<Role>, Option<Role>)>,
    text: &str,
    fg: Option<Role>,
    bg: Option<Role>,
) {
    if text.is_empty() {
        return;
    }
    if let Some(last) = segs.last_mut()
        && last.1 == fg
        && last.2 == bg
    {
        last.0.push_str(text);
        return;
    }
    segs.push((text.to_owned(), fg, bg));
}

fn to_ratatui_line(
    segs: Vec<(String, Option<Role>, Option<Role>)>,
    palette: &TuiPalette,
    signal_override: Option<Color>,
) -> Line<'static> {
    let spans: Vec<Span<'static>> = segs
        .into_iter()
        .map(|(text, fg, bg)| {
            let mut style = Style::new().bg(palette.background);
            if let Some(r) = fg {
                style = style.fg(resolve_color(r, palette, signal_override));
            }
            if let Some(r) = bg {
                style = style.bg(resolve_color(r, palette, signal_override));
            }
            Span::styled(text, style)
        })
        .collect();
    Line::from(spans)
}

fn blank_wordmark_line(width: usize, palette: &TuiPalette) -> Line<'static> {
    Line::from(Span::styled(
        " ".repeat(width),
        Style::new().bg(palette.background),
    ))
}

fn animation_state(
    total_rows: usize,
    elapsed_ms: Option<u64>,
    palette: &TuiPalette,
) -> (usize, Option<Color>) {
    let Some(ms) = elapsed_ms else {
        return (total_rows, None);
    };
    let reveal_total_ms = (total_rows as u64) * WORDMARK_REVEAL_STEP_MS;
    if ms < reveal_total_ms {
        let revealed = ((ms / WORDMARK_REVEAL_STEP_MS) as usize + 1).min(total_rows);
        return (revealed, None);
    }
    let phase_ms = (ms - reveal_total_ms) % WORDMARK_BREATHE_PERIOD_MS;
    let phase = (phase_ms as f64) / (WORDMARK_BREATHE_PERIOD_MS as f64);
    (total_rows, Some(breathe_signal_color(palette, phase)))
}

/// Returns `(lines, pixel_width)` for the responsive B3 `peer agent` wordmark.
pub fn b3_wordmark_lines(width: u16, palette: &TuiPalette) -> (Vec<Line<'static>>, u16) {
    b3_wordmark_lines_animated(width, palette, None)
}

/// Returns `(lines, pixel_width)` for the B3 wordmark with optional reveal & breathing animation.
pub fn b3_wordmark_lines_animated(
    width: u16,
    palette: &TuiPalette,
    elapsed_ms: Option<u64>,
) -> (Vec<Line<'static>>, u16) {
    let variant = B3Variant::for_width(width);
    let matrix = compose_matrix();
    match variant {
        B3Variant::Full => {
            const FULL_WIDTH: usize = 53;
            let (revealed, signal_override) = animation_state(MATRIX_HEIGHT, elapsed_ms, palette);
            let mut lines = Vec::with_capacity(MATRIX_HEIGHT);
            for (row_idx, row) in matrix.iter().enumerate() {
                if row_idx >= revealed {
                    lines.push(blank_wordmark_line(FULL_WIDTH, palette));
                    continue;
                }
                let mut segs = Vec::new();
                for &cell in row {
                    push_seg(
                        &mut segs,
                        if cell == 0 { "  " } else { "██" },
                        cell_role(cell),
                        None,
                    );
                }
                push_seg(&mut segs, "  ", None, None);
                if row_idx == B3_AGENT_ROW {
                    push_seg(&mut segs, "agent", Some(Role::Muted), None);
                } else {
                    push_seg(&mut segs, "     ", None, None);
                }
                lines.push(to_ratatui_line(segs, palette, signal_override));
            }
            // 23 * 2 + 2 + 5 = 53 columns
            (lines, FULL_WIDTH as u16)
        }
        B3Variant::Half => {
            const HALF_WIDTH: usize = 30;
            let half_rows = MATRIX_HEIGHT.div_ceil(2);
            let (revealed, signal_override) = animation_state(half_rows, elapsed_ms, palette);
            let mut lines = Vec::with_capacity(half_rows);
            for half_row in 0..half_rows {
                if half_row >= revealed {
                    lines.push(blank_wordmark_line(HALF_WIDTH, palette));
                    continue;
                }
                let top = &matrix[half_row * 2];
                let bottom = matrix
                    .get(half_row * 2 + 1)
                    .copied()
                    .unwrap_or([0u8; MATRIX_WIDTH]);
                let mut segs = Vec::new();
                for col in 0..MATRIX_WIDTH {
                    let tr = cell_role(top[col]);
                    let br = cell_role(bottom[col]);
                    match (tr, br) {
                        (None, None) => push_seg(&mut segs, " ", None, None),
                        (Some(t), Some(b)) if t == b => push_seg(&mut segs, "█", Some(t), None),
                        (Some(t), Some(b)) => push_seg(&mut segs, "▀", Some(t), Some(b)),
                        (Some(t), None) => push_seg(&mut segs, "▀", Some(t), None),
                        (None, Some(b)) => push_seg(&mut segs, "▄", Some(b), None),
                    }
                }
                push_seg(&mut segs, "  ", None, None);
                if half_row == 2 {
                    push_seg(&mut segs, "agent", Some(Role::Muted), None);
                } else {
                    push_seg(&mut segs, "     ", None, None);
                }
                lines.push(to_ratatui_line(segs, palette, signal_override));
            }
            // 23 + 2 + 5 = 30 columns
            (lines, HALF_WIDTH as u16)
        }
        B3Variant::Narrow => {
            let (_revealed, signal_override) = animation_state(1, elapsed_ms, palette);
            let segs = vec![
                ("peer".to_owned(), Some(Role::Primary), None),
                ("━".to_owned(), Some(Role::Signal), None),
                ("agent".to_owned(), Some(Role::Muted), None),
            ];
            (vec![to_ratatui_line(segs, palette, signal_override)], 10)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{DARK_PALETTE, LIGHT_PALETTE};

    #[test]
    fn b3_wordmark_scales_by_width_and_uses_frost_roles() {
        let (full, fw) = b3_wordmark_lines(100, &DARK_PALETTE);
        assert_eq!(full.len(), 7);
        assert_eq!(fw, 53);

        let (half, hw) = b3_wordmark_lines(60, &LIGHT_PALETTE);
        assert_eq!(half.len(), 4);
        assert_eq!(hw, 30);

        let (narrow, nw) = b3_wordmark_lines(30, &DARK_PALETTE);
        assert_eq!(narrow.len(), 1);
        assert_eq!(nw, 10);
    }

    #[test]
    fn b3_wordmark_reveal_and_breathing_shimmer_preserve_geometry() {
        let (early, early_w) = b3_wordmark_lines_animated(100, &DARK_PALETTE, Some(0));
        assert_eq!(early.len(), 7);
        assert_eq!(early_w, 53);
        // Row 3 (signal bar) is not revealed at 0 ms yet.
        assert_eq!(early[B3_SIGNAL_ROW].spans.len(), 1);
        assert_eq!(early[B3_SIGNAL_ROW].width(), 53);

        let (mid_reveal, mid_w) = b3_wordmark_lines_animated(100, &DARK_PALETTE, Some(300));
        assert_eq!(mid_reveal.len(), 7);
        assert_eq!(mid_w, 53);
        assert!(
            mid_reveal[B3_SIGNAL_ROW]
                .spans
                .iter()
                .any(|s| s.style.fg == Some(DARK_PALETTE.info))
        );
        // Row 5 (agent label) stays blank until 500 ms.
        assert!(!mid_reveal[B3_AGENT_ROW].to_string().contains("agent"));

        // Breathing peak after reveal completes shifts the signal bar toward brand_highlight.
        let peak_ms =
            (MATRIX_HEIGHT as u64) * WORDMARK_REVEAL_STEP_MS + WORDMARK_BREATHE_PERIOD_MS / 2;
        let (breathe, bw) = b3_wordmark_lines_animated(100, &DARK_PALETTE, Some(peak_ms));
        assert_eq!(breathe.len(), 7);
        assert_eq!(bw, 53);
        assert!(breathe[B3_AGENT_ROW].to_string().contains("agent"));
        let expected = breathe_signal_color(&DARK_PALETTE, 0.5);
        assert_ne!(expected, DARK_PALETTE.info);
        assert!(
            breathe[B3_SIGNAL_ROW]
                .spans
                .iter()
                .any(|s| s.style.fg == Some(expected))
        );

        let (half_early, half_w) = b3_wordmark_lines_animated(60, &LIGHT_PALETTE, Some(0));
        assert_eq!(half_early.len(), 4);
        assert_eq!(half_w, 30);
        assert_eq!(half_early[3].width(), 30);
    }
}
