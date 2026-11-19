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

fn resolve_color(role: Role, palette: &TuiPalette) -> Color {
    match role {
        Role::Primary => palette.text,
        Role::Signal => palette.info,
        Role::Muted => palette.muted,
    }
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
) -> Line<'static> {
    let spans: Vec<Span<'static>> = segs
        .into_iter()
        .map(|(text, fg, bg)| {
            let mut style = Style::new().bg(palette.background);
            if let Some(r) = fg {
                style = style.fg(resolve_color(r, palette));
            }
            if let Some(r) = bg {
                style = style.bg(resolve_color(r, palette));
            }
            Span::styled(text, style)
        })
        .collect();
    Line::from(spans)
}

/// Returns `(lines, pixel_width)` for the responsive B3 `peer agent` wordmark.
pub fn b3_wordmark_lines(width: u16, palette: &TuiPalette) -> (Vec<Line<'static>>, u16) {
    let variant = B3Variant::for_width(width);
    let matrix = compose_matrix();
    match variant {
        B3Variant::Full => {
            let mut lines = Vec::with_capacity(MATRIX_HEIGHT);
            for (row_idx, row) in matrix.iter().enumerate() {
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
                lines.push(to_ratatui_line(segs, palette));
            }
            // 23 * 2 + 2 + 5 = 53 columns
            (lines, 53)
        }
        B3Variant::Half => {
            let half_rows = MATRIX_HEIGHT.div_ceil(2);
            let mut lines = Vec::with_capacity(half_rows);
            for half_row in 0..half_rows {
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
                lines.push(to_ratatui_line(segs, palette));
            }
            // 23 + 2 + 5 = 30 columns
            (lines, 30)
        }
        B3Variant::Narrow => {
            let segs = vec![
                ("peer".to_owned(), Some(Role::Primary), None),
                ("━".to_owned(), Some(Role::Signal), None),
                ("agent".to_owned(), Some(Role::Muted), None),
            ];
            (vec![to_ratatui_line(segs, palette)], 10)
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
}
