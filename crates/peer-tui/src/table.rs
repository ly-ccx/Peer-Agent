//! Rounded Unicode box-drawing Markdown table renderer for virtualized Ratatui scrollback.
//!
//! Layout follows a two-tier proportional column budget inspired by xAI Grok Build
//! (`xai-grok-markdown`): natural column widths when the table fits, proportional
//! shrinking down to unbreakable-word or grapheme floors with multi-line per-cell
//! wrapping and inline Markdown span projection when constrained, and `[1]` stacked-card
//! fallback only when even single-grapheme column floors exceed the viewport.

use crate::{
    markdown::{
        LineLink, StyledLine, push_or_merge_link, tokenize_inline_markdown,
        wrap_inline_markdown_with_ids, wrap_plain_into,
    },
    theme::TuiPalette,
};
use ratatui::style::{Modifier, Style};
use std::ops::Range;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const CELL_PADDING: usize = 1;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TableAlignment {
    Left,
    Center,
    Right,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TableBorders {
    chars: [char; 11],
}

impl TableBorders {
    const H: usize = 0;
    const V: usize = 1;
    const TL: usize = 2;
    const TR: usize = 3;
    const BL: usize = 4;
    const BR: usize = 5;
    const T_T: usize = 6;
    const T_B: usize = 7;
    const T_L: usize = 8;
    const T_R: usize = 9;
    const X: usize = 10;

    pub const ROUNDED: Self = Self {
        chars: ['─', '│', '╭', '╮', '╰', '╯', '┬', '┴', '├', '┤', '┼'],
    };

    pub const BOX: Self = Self {
        chars: ['─', '│', '┌', '┐', '└', '┘', '┬', '┴', '├', '┤', '┼'],
    };

    pub const fn new(chars: [char; 11]) -> Self {
        Self { chars }
    }

    pub const fn h(&self) -> char {
        self.chars[Self::H]
    }
    pub const fn v(&self) -> char {
        self.chars[Self::V]
    }
    pub const fn c_tl(&self) -> char {
        self.chars[Self::TL]
    }
    pub const fn c_tr(&self) -> char {
        self.chars[Self::TR]
    }
    pub const fn c_bl(&self) -> char {
        self.chars[Self::BL]
    }
    pub const fn c_br(&self) -> char {
        self.chars[Self::BR]
    }
    pub const fn t_t(&self) -> char {
        self.chars[Self::T_T]
    }
    pub const fn t_b(&self) -> char {
        self.chars[Self::T_B]
    }
    pub const fn t_l(&self) -> char {
        self.chars[Self::T_L]
    }
    pub const fn t_r(&self) -> char {
        self.chars[Self::T_R]
    }
    pub const fn x(&self) -> char {
        self.chars[Self::X]
    }
}

impl Default for TableBorders {
    fn default() -> Self {
        Self::ROUNDED
    }
}

pub struct TableSpec<'a> {
    pub headers: &'a [String],
    pub rows: &'a [Vec<String>],
    pub alignments: &'a [TableAlignment],
    pub borders: TableBorders,
}

#[derive(Debug, Clone)]
struct PreparedSpan {
    range: Range<usize>,
    style: Style,
    link: Option<(String, u32)>,
}

#[derive(Debug, Clone, Default)]
struct PreparedCell {
    plain: String,
    spans: Vec<PreparedSpan>,
}

#[derive(Debug, Clone)]
struct WrapToken {
    range: Range<usize>,
    is_space: bool,
}

struct RowEmitContext<'a> {
    col_widths: &'a [usize],
    alignments: &'a [TableAlignment],
    borders: TableBorders,
    border_style: Style,
    pad_style: Style,
}

/// Split raw cell text on HTML `<br>`, `<br/>`, or `<br />` tags (case-insensitive).
fn split_cell_br_lines(raw: &str) -> Vec<&str> {
    let bytes = raw.as_bytes();
    let mut parts = Vec::new();
    let mut part_start = 0usize;
    let mut i = 0usize;
    while i + 3 < bytes.len() {
        if bytes[i] == b'<'
            && matches!(bytes[i + 1], b'b' | b'B')
            && matches!(bytes[i + 2], b'r' | b'R')
        {
            let mut j = i + 3;
            while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                j += 1;
            }
            if j < bytes.len() && bytes[j] == b'/' {
                j += 1;
                while j < bytes.len() && bytes[j].is_ascii_whitespace() {
                    j += 1;
                }
            }
            if j < bytes.len() && bytes[j] == b'>' {
                parts.push(raw[part_start..i].trim());
                i = j + 1;
                part_start = i;
                continue;
            }
        }
        i += 1;
    }
    parts.push(raw[part_start..].trim());
    parts
}

fn prepare_cell(
    raw: &str,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
) -> PreparedCell {
    let logical_lines = split_cell_br_lines(raw);
    let mut plain = String::new();
    let mut spans = Vec::new();
    let mut segs = Vec::new();

    for (line_idx, logical) in logical_lines.iter().enumerate() {
        if line_idx > 0 {
            plain.push('\n');
        }
        segs.clear();
        if logical.contains('\t') {
            let normalized = logical.replace('\t', " ");
            tokenize_inline_markdown(&normalized, base_style, palette, next_link_id, &mut segs);
        } else {
            tokenize_inline_markdown(logical, base_style, palette, next_link_id, &mut segs);
        }
        for seg in segs.drain(..) {
            if seg.text.is_empty() {
                continue;
            }
            let start = plain.len();
            plain.push_str(&seg.text);
            let end = plain.len();
            spans.push(PreparedSpan {
                range: start..end,
                style: seg.style,
                link: seg.link,
            });
        }
    }

    PreparedCell { plain, spans }
}

fn alignment_padding(vis_width: usize, col_width: usize, align: TableAlignment) -> (usize, usize) {
    let gap = col_width.saturating_sub(vis_width);
    match align {
        TableAlignment::Right => (gap, 0),
        TableAlignment::Center => {
            let left = gap / 2;
            (left, gap - left)
        }
        TableAlignment::Left => (0, gap),
    }
}

fn is_space_grapheme(g: &str) -> bool {
    g == " " || g == "\t"
}

fn is_open_delim_grapheme(g: &str) -> bool {
    matches!(g, "(" | "[" | "{")
}

fn is_break_punct_grapheme(g: &str) -> bool {
    let mut chars = g.chars();
    let Some(ch) = chars.next() else {
        return false;
    };
    chars.next().is_none() && g.width() <= 1 && !ch.is_alphanumeric() && !ch.is_whitespace()
}

fn grapheme_starts_alphabetic(g: &str) -> bool {
    g.chars().next().is_some_and(char::is_alphabetic)
}

fn grapheme_is_ascii_digit(g: &str) -> bool {
    let mut chars = g.chars();
    matches!((chars.next(), chars.next()), (Some(c), None) if c.is_ascii_digit())
}

fn grapheme_is_alnum(g: &str) -> bool {
    g.chars().next().is_some_and(char::is_alphanumeric)
}

/// Tokenize a single unwrapped logical line (no `\n`) into CJK-aware and URL/semver-safe units.
fn cell_wrap_tokens(line: &str) -> Vec<WrapToken> {
    let gs: Vec<(usize, &str)> = line.grapheme_indices(true).collect();
    let mut tokens = Vec::new();
    let mut narrow_start: Option<usize> = None;
    let mut narrow_has_alnum = false;
    let mut i = 0usize;

    while i < gs.len() {
        let (start, g) = gs[i];
        let end = gs.get(i + 1).map_or(line.len(), |&(next, _)| next);

        if is_space_grapheme(g) {
            if let Some(tok_start) = narrow_start.take() {
                tokens.push(WrapToken {
                    range: tok_start..start,
                    is_space: false,
                });
                narrow_has_alnum = false;
            }
            let space_start = start;
            let mut space_end = end;
            while i + 1 < gs.len() && is_space_grapheme(gs[i + 1].1) {
                i += 1;
                space_end = gs.get(i + 1).map_or(line.len(), |&(next, _)| next);
            }
            tokens.push(WrapToken {
                range: space_start..space_end,
                is_space: true,
            });
            i += 1;
            continue;
        }

        // Split wide graphemes (CJK / fullwidth / wide emoji) individually so Chinese prose wraps naturally.
        if g.width() >= 2 {
            if let Some(tok_start) = narrow_start.take() {
                tokens.push(WrapToken {
                    range: tok_start..start,
                    is_space: false,
                });
                narrow_has_alnum = false;
            }
            tokens.push(WrapToken {
                range: start..end,
                is_space: false,
            });
            i += 1;
            continue;
        }

        if is_open_delim_grapheme(g)
            && let Some(tok_start) = narrow_start.take()
        {
            tokens.push(WrapToken {
                range: tok_start..start,
                is_space: false,
            });
            narrow_has_alnum = false;
        }

        let tok_start = *narrow_start.get_or_insert(start);
        if grapheme_is_alnum(g) {
            narrow_has_alnum = true;
        }

        if narrow_has_alnum
            && start > tok_start
            && is_break_punct_grapheme(g)
            && let Some(&(_, next_g)) = gs.get(i + 1)
        {
            let prev_is_digit = i > 0 && grapheme_is_ascii_digit(gs[i - 1].1);
            let next_is_digit = grapheme_is_ascii_digit(next_g);
            let allow_break = grapheme_starts_alphabetic(next_g)
                || (prev_is_digit && next_is_digit && g != "," && g != ".");
            if allow_break {
                tokens.push(WrapToken {
                    range: tok_start..end,
                    is_space: false,
                });
                narrow_start = None;
                narrow_has_alnum = false;
            }
        }

        i += 1;
    }

    if let Some(tok_start) = narrow_start {
        tokens.push(WrapToken {
            range: tok_start..line.len(),
            is_space: false,
        });
    }

    tokens
}

fn compute_column_widths(
    num_cols: usize,
    header_cells: &[PreparedCell],
    body_rows: &[Vec<PreparedCell>],
    max_width: usize,
) -> Option<Vec<usize>> {
    let overhead = num_cols * (2 * CELL_PADDING + 1) + 1;
    if max_width <= overhead {
        return None;
    }
    let content_budget = max_width - overhead;

    let mut natural_widths = vec![1usize; num_cols];
    let mut hard_floors = vec![1usize; num_cols];
    let mut min_col_widths = vec![1usize; num_cols];

    let all_rows = std::iter::once(header_cells).chain(body_rows.iter().map(Vec::as_slice));
    for row in all_rows {
        for col in 0..num_cols {
            let Some(cell) = row.get(col) else {
                continue;
            };
            let cell_natural = cell
                .plain
                .split('\n')
                .map(UnicodeWidthStr::width)
                .max()
                .unwrap_or(0);
            natural_widths[col] = natural_widths[col].max(cell_natural);

            let widest_grapheme = cell
                .plain
                .graphemes(true)
                .filter(|g| *g != "\n")
                .map(UnicodeWidthStr::width)
                .max()
                .unwrap_or(0);
            hard_floors[col] = hard_floors[col].max(widest_grapheme);

            for logical in cell.plain.split('\n') {
                for tok in cell_wrap_tokens(logical) {
                    if !tok.is_space {
                        let tok_w = logical[tok.range].width();
                        min_col_widths[col] = min_col_widths[col].max(tok_w);
                    }
                }
            }
        }
    }

    for col in 0..num_cols {
        min_col_widths[col] = min_col_widths[col]
            .max(hard_floors[col])
            .min(natural_widths[col]);
    }

    let hard_total: usize = hard_floors.iter().sum();
    if hard_total > content_budget {
        return None;
    }

    let natural_total: usize = natural_widths.iter().sum();
    if natural_total <= content_budget {
        return Some(natural_widths);
    }

    let min_total: usize = min_col_widths.iter().sum();
    let (base_widths, target_widths) = if min_total <= content_budget {
        (min_col_widths, natural_widths)
    } else {
        (hard_floors, min_col_widths)
    };

    let mut new_widths = base_widths;
    let mut locked: Vec<bool> = (0..num_cols)
        .map(|i| new_widths[i] >= target_widths[i])
        .collect();
    let mut extra_budget = content_budget.saturating_sub(new_widths.iter().sum::<usize>());

    // Phase 1: Iteratively lock in narrow columns whose natural/target width fits
    // within fair share of the budget so short label/ID columns do not wrap awkwardly.
    loop {
        let active_count = locked.iter().filter(|&&is_locked| !is_locked).count();
        if active_count == 0 || extra_budget == 0 {
            break;
        }
        let locked_total: usize = new_widths
            .iter()
            .enumerate()
            .filter(|&(i, _)| locked[i])
            .map(|(_, &w)| w)
            .sum();
        let fair_share = content_budget.saturating_sub(locked_total) / active_count;
        let mut progressed = false;
        for i in 0..num_cols {
            if locked[i] {
                continue;
            }
            let need = target_widths[i].saturating_sub(new_widths[i]);
            if target_widths[i] <= fair_share && need <= extra_budget {
                new_widths[i] = target_widths[i];
                extra_budget -= need;
                locked[i] = true;
                progressed = true;
            }
        }
        if !progressed {
            break;
        }
    }

    // Phase 2: Grok proportional distribution for remaining wide columns.
    let extra_wants: Vec<usize> = (0..num_cols)
        .map(|i| {
            if locked[i] {
                0
            } else {
                target_widths[i].saturating_sub(new_widths[i])
            }
        })
        .collect();
    let total_extra_want: usize = extra_wants.iter().sum();

    if total_extra_want > 0 && extra_budget > 0 {
        for (idx, (&want, &target)) in extra_wants.iter().zip(&target_widths).enumerate() {
            if locked[idx] || want == 0 {
                continue;
            }
            let share = ((want as u128 * extra_budget as u128) / total_extra_want as u128) as usize;
            let cap = target.saturating_sub(new_widths[idx]);
            new_widths[idx] += share.min(cap);
        }

        let used: usize = new_widths.iter().sum();
        let mut remaining = content_budget.saturating_sub(used);
        if remaining > 0 {
            let mut indices: Vec<usize> = (0..num_cols)
                .filter(|&i| !locked[i] && new_widths[i] < target_widths[i])
                .collect();
            indices.sort_by(|&a, &b| {
                let unmet_a = target_widths[a].saturating_sub(new_widths[a]);
                let unmet_b = target_widths[b].saturating_sub(new_widths[b]);
                unmet_b.cmp(&unmet_a).then_with(|| a.cmp(&b))
            });
            for idx in indices {
                if remaining == 0 {
                    break;
                }
                if new_widths[idx] < target_widths[idx] {
                    new_widths[idx] += 1;
                    remaining -= 1;
                }
            }
        }
    }

    Some(new_widths)
}

fn wrap_cell_ranges(plain: &str, col_width: usize) -> Vec<Range<usize>> {
    let w = col_width.max(1);
    let mut out = Vec::new();
    let mut line_base = 0usize;

    for logical in plain.split('\n') {
        if logical.is_empty() {
            out.push(line_base..line_base);
            line_base += 1;
            continue;
        }

        let tokens = cell_wrap_tokens(logical);
        let mut cur_range: Option<Range<usize>> = None;
        let mut cur_w = 0usize;
        let mut pending_space: Option<(Range<usize>, usize)> = None;

        for tok in tokens {
            let tok_text = &logical[tok.range.clone()];
            let tok_w = tok_text.width();
            let abs_range = (line_base + tok.range.start)..(line_base + tok.range.end);

            if tok.is_space {
                if cur_range.is_some() {
                    pending_space = Some((abs_range, tok_w));
                }
                continue;
            }

            let pending_w = pending_space.as_ref().map_or(0, |&(_, pw)| pw);
            if let Some(ref mut cur) = cur_range
                && cur_w + pending_w + tok_w <= w
            {
                cur.end = abs_range.end;
                cur_w += pending_w + tok_w;
                pending_space = None;
                continue;
            }

            if let Some(finished) = cur_range.take() {
                out.push(finished);
            }
            cur_w = 0;
            pending_space = None;

            if tok_w <= w {
                cur_range = Some(abs_range);
                cur_w = tok_w;
            } else {
                // Token still wider than column width (e.g. long URL / SHA): hard-split on grapheme boundaries.
                let mut g_start = line_base + tok.range.start;
                let mut g_end = g_start;
                let mut g_w = 0usize;
                let gs: Vec<(usize, &str)> = tok_text.grapheme_indices(true).collect();
                for (gi, &(rel_idx, g)) in gs.iter().enumerate() {
                    let next_rel = gs.get(gi + 1).map_or(tok_text.len(), |&(nr, _)| nr);
                    let gw = g.width();
                    if g_w > 0 && g_w + gw > w {
                        out.push(g_start..g_end);
                        g_start = line_base + tok.range.start + rel_idx;
                        g_w = 0;
                    }
                    g_end = line_base + tok.range.start + next_rel;
                    g_w += gw;
                }
                if g_end > g_start {
                    cur_range = Some(g_start..g_end);
                    cur_w = g_w;
                }
            }
        }

        if let Some(finished) = cur_range {
            out.push(finished);
        } else if out.last().is_none_or(|r| r.end < line_base) {
            out.push(line_base..line_base);
        }

        line_base += logical.len() + 1;
    }

    if out.is_empty() {
        out.push(0..0);
    }
    out
}

fn format_border_line(col_widths: &[usize], left: char, mid: char, right: char, h: char) -> String {
    let mut line = String::new();
    line.push(left);
    for (idx, &width) in col_widths.iter().enumerate() {
        let total = width + CELL_PADDING * 2;
        for _ in 0..total {
            line.push(h);
        }
        if idx + 1 < col_widths.len() {
            line.push(mid);
        }
    }
    line.push(right);
    line
}

fn push_border_line(
    out: &mut Vec<StyledLine>,
    max_lines: usize,
    text: String,
    border_style: Style,
) -> bool {
    if out.len() >= max_lines {
        return true;
    }
    out.push(StyledLine::plain(text, border_style));
    false
}

fn emit_table_row(
    ctx: &RowEmitContext<'_>,
    cells: &[PreparedCell],
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) -> bool {
    let empty_cell = PreparedCell::default();
    let wrapped: Vec<Vec<Range<usize>>> = (0..ctx.col_widths.len())
        .map(|col| {
            let cell = cells.get(col).unwrap_or(&empty_cell);
            wrap_cell_ranges(&cell.plain, ctx.col_widths[col])
        })
        .collect();
    let num_visual_lines = wrapped.iter().map(Vec::len).max().unwrap_or(1);
    let v_str = ctx.borders.v().to_string();
    let v_w = v_str.width();

    for vis_line in 0..num_visual_lines {
        if out.len() >= max_lines {
            return true;
        }
        let mut spans: Vec<(String, Style)> = Vec::new();
        let mut links: Vec<LineLink> = Vec::new();
        let mut col_cursor = 0usize;
        spans.push((v_str.clone(), ctx.border_style));
        col_cursor += v_w;

        for (col, &col_w) in ctx.col_widths.iter().enumerate() {
            let cell = cells.get(col).unwrap_or(&empty_cell);
            let range = wrapped[col].get(vis_line).cloned().unwrap_or(0..0);
            let vis_w = cell.plain[range.clone()].width();
            let align = ctx
                .alignments
                .get(col)
                .copied()
                .unwrap_or(TableAlignment::Left);
            let (left_pad, right_pad) = alignment_padding(vis_w, col_w, align);

            let left_w = CELL_PADDING + left_pad;
            spans.push((" ".repeat(left_w), ctx.pad_style));
            col_cursor += left_w;
            for prepared in &cell.spans {
                let s = prepared.range.start.max(range.start);
                let e = prepared.range.end.min(range.end);
                if s < e {
                    let chunk = &cell.plain[s..e];
                    let chunk_w = chunk.width();
                    spans.push((chunk.to_owned(), prepared.style));
                    if let Some((target, id)) = &prepared.link {
                        push_or_merge_link(
                            &mut links,
                            col_cursor,
                            col_cursor + chunk_w,
                            target,
                            *id,
                        );
                    }
                    col_cursor += chunk_w;
                }
            }
            let right_w = right_pad + CELL_PADDING;
            spans.push((" ".repeat(right_w), ctx.pad_style));
            col_cursor += right_w;
            spans.push((v_str.clone(), ctx.border_style));
            col_cursor += v_w;
        }

        out.push(StyledLine::from_spans_with_links(spans, links));
    }

    false
}

fn flatten_br_for_stacked(raw: &str) -> String {
    let parts = split_cell_br_lines(raw);
    if parts.len() <= 1 {
        raw.replace('\t', " ")
    } else {
        parts
            .into_iter()
            .filter(|p| !p.is_empty())
            .collect::<Vec<_>>()
            .join(" / ")
            .replace('\t', " ")
    }
}

struct StackedCtx<'a> {
    width: usize,
    base_style: Style,
    palette: &'a TuiPalette,
    next_link_id: &'a mut u32,
    out: &'a mut Vec<StyledLine>,
    max_lines: usize,
}

fn shift_line_links(mut links: Vec<LineLink>, delta: usize) -> Vec<LineLink> {
    let d = u16::try_from(delta).unwrap_or(u16::MAX);
    for link in &mut links {
        link.col_start = link.col_start.saturating_add(d);
        link.col_end = link.col_end.saturating_add(d);
    }
    links
}

fn push_labeled_inline(
    ctx: &mut StackedCtx<'_>,
    label_prefix: String,
    label_style: Style,
    value: &str,
) -> bool {
    if ctx.out.len() >= ctx.max_lines {
        return true;
    }
    let prefix_w = label_prefix.width();
    let remaining_budget = ctx.max_lines.saturating_sub(ctx.out.len());
    if prefix_w + 6 <= ctx.width {
        let body_w = ctx.width.saturating_sub(prefix_w).max(1);
        let mut wrapped = Vec::new();
        wrap_inline_markdown_with_ids(
            value,
            body_w,
            ctx.base_style,
            ctx.palette,
            ctx.next_link_id,
            &mut wrapped,
            remaining_budget,
        );
        let indent_style = Style::new().bg(ctx.palette.background);
        for (idx, line) in wrapped.into_iter().enumerate() {
            if ctx.out.len() >= ctx.max_lines {
                return true;
            }
            let prefix = if idx == 0 {
                (label_prefix.clone(), label_style)
            } else {
                (" ".repeat(prefix_w), indent_style)
            };
            let mut spans = Vec::with_capacity(line.spans.len() + 1);
            spans.push(prefix);
            spans.extend(line.spans);
            let links = shift_line_links(line.links, prefix_w);
            ctx.out
                .push(StyledLine::from_spans_with_links(spans, links));
        }
        return false;
    }

    let mut head = Vec::new();
    wrap_plain_into(
        label_prefix.trim_end(),
        ctx.width,
        label_style,
        &mut head,
        remaining_budget,
    );
    ctx.out.extend(head);
    if ctx.out.len() >= ctx.max_lines {
        return true;
    }
    let body_w = ctx.width.saturating_sub(2).max(1);
    let mut wrapped = Vec::new();
    wrap_inline_markdown_with_ids(
        value,
        body_w,
        ctx.base_style,
        ctx.palette,
        ctx.next_link_id,
        &mut wrapped,
        ctx.max_lines.saturating_sub(ctx.out.len()),
    );
    let indent_style = Style::new().bg(ctx.palette.background);
    for line in wrapped {
        if ctx.out.len() >= ctx.max_lines {
            return true;
        }
        let mut spans = Vec::with_capacity(line.spans.len() + 1);
        spans.push(("  ".to_owned(), indent_style));
        spans.extend(line.spans);
        let links = shift_line_links(line.links, 2);
        ctx.out
            .push(StyledLine::from_spans_with_links(spans, links));
    }
    false
}

fn render_stacked_fallback(
    spec: &TableSpec<'_>,
    width: usize,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) -> bool {
    let label_w = spec.headers.iter().map(|h| h.width()).max().unwrap_or(0);
    let idx_style = Style::new()
        .fg(palette.muted)
        .bg(palette.background)
        .add_modifier(Modifier::BOLD);
    let label_style = Style::new().fg(palette.muted).bg(palette.background);
    let blank_style = Style::new().bg(palette.background);

    if spec.rows.is_empty() {
        for (col_idx, header) in spec.headers.iter().enumerate() {
            if out.len() >= max_lines {
                return true;
            }
            wrap_plain_into(
                &format!("[{}] {}", col_idx + 1, header),
                width,
                idx_style,
                out,
                max_lines,
            );
        }
        return false;
    }

    let mut ctx = StackedCtx {
        width,
        base_style,
        palette,
        next_link_id,
        out,
        max_lines,
    };

    for (row_idx, row) in spec.rows.iter().enumerate() {
        if ctx.out.len() >= ctx.max_lines {
            return true;
        }
        ctx.out
            .push(StyledLine::plain(format!("[{}]", row_idx + 1), idx_style));
        for (col_idx, header) in spec.headers.iter().enumerate() {
            let val = flatten_br_for_stacked(row.get(col_idx).map(String::as_str).unwrap_or(""));
            let (_, right_pad) = alignment_padding(header.width(), label_w, TableAlignment::Left);
            let prefix = format!("  {}{}  ", header, " ".repeat(right_pad));
            if push_labeled_inline(&mut ctx, prefix, label_style, &val) {
                return true;
            }
        }
        if row_idx + 1 < spec.rows.len() {
            if ctx.out.len() >= ctx.max_lines {
                return true;
            }
            ctx.out.push(StyledLine::plain(String::new(), blank_style));
        }
    }
    false
}

/// Render a GFM Markdown table into bounded `StyledLine`s using `spec.borders`.
///
/// Returns `true` when output reached `max_lines` and was truncated.
pub fn render_table_lines(
    spec: &TableSpec<'_>,
    width: usize,
    base_style: Style,
    palette: &TuiPalette,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) -> bool {
    let mut next_link_id = 1u32;
    render_table_lines_with_ids(
        spec,
        width,
        base_style,
        palette,
        &mut next_link_id,
        out,
        max_lines,
    )
}

pub(crate) fn render_table_lines_with_ids(
    spec: &TableSpec<'_>,
    width: usize,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) -> bool {
    let num_cols = spec.headers.len();
    if num_cols == 0 {
        return false;
    }

    let header_style = Style::new()
        .fg(palette.text_soft)
        .bg(palette.background)
        .add_modifier(Modifier::BOLD);
    let body_style = base_style.bg(palette.background);
    let border_style = Style::new().fg(palette.subtle).bg(palette.background);
    let pad_style = Style::new().bg(palette.background);

    let header_cells: Vec<PreparedCell> = (0..num_cols)
        .map(|col| {
            let raw = spec.headers.get(col).map(String::as_str).unwrap_or("");
            prepare_cell(raw, header_style, palette, next_link_id)
        })
        .collect();

    let body_cells: Vec<Vec<PreparedCell>> = spec
        .rows
        .iter()
        .map(|row| {
            (0..num_cols)
                .map(|col| {
                    let raw = row.get(col).map(String::as_str).unwrap_or("");
                    prepare_cell(raw, body_style, palette, next_link_id)
                })
                .collect()
        })
        .collect();

    let Some(col_widths) = compute_column_widths(num_cols, &header_cells, &body_cells, width)
    else {
        return render_stacked_fallback(
            spec,
            width.max(1),
            body_style,
            palette,
            next_link_id,
            out,
            max_lines,
        );
    };

    let b = spec.borders;
    let top_border = format_border_line(&col_widths, b.c_tl(), b.t_t(), b.c_tr(), b.h());
    if push_border_line(out, max_lines, top_border, border_style) {
        return true;
    }

    let row_ctx = RowEmitContext {
        col_widths: &col_widths,
        alignments: spec.alignments,
        borders: b,
        border_style,
        pad_style,
    };

    if emit_table_row(&row_ctx, &header_cells, out, max_lines) {
        return true;
    }

    if !body_cells.is_empty() {
        let sep = format_border_line(&col_widths, b.t_l(), b.x(), b.t_r(), b.h());
        if push_border_line(out, max_lines, sep.clone(), border_style) {
            return true;
        }
        for (idx, row) in body_cells.iter().enumerate() {
            if emit_table_row(&row_ctx, row, out, max_lines) {
                return true;
            }
            if idx + 1 < body_cells.len()
                && push_border_line(out, max_lines, sep.clone(), border_style)
            {
                return true;
            }
        }
    }

    let bottom_border = format_border_line(&col_widths, b.c_bl(), b.t_b(), b.c_br(), b.h());
    push_border_line(out, max_lines, bottom_border, border_style)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::{DARK_PALETTE, LIGHT_PALETTE};

    fn plain_lines(lines: &[StyledLine]) -> Vec<String> {
        lines
            .iter()
            .map(|l| l.spans.iter().map(|(t, _)| t.as_str()).collect::<String>())
            .collect()
    }

    #[test]
    fn rounded_table_renders_aligned_cjk_and_inline_styles() {
        let headers = vec!["仓库".into(), "分支".into(), "数量".into()];
        let rows = vec![
            vec!["**peer**".into(), "`main`".into(), "12".into()],
            vec!["~~old~~".into(), "`next`".into(), "3".into()],
        ];
        let alignments = vec![
            TableAlignment::Left,
            TableAlignment::Center,
            TableAlignment::Right,
        ];
        let spec = TableSpec {
            headers: &headers,
            rows: &rows,
            alignments: &alignments,
            borders: TableBorders::ROUNDED,
        };

        let mut out = Vec::new();
        let truncated = render_table_lines(
            &spec,
            80,
            Style::new().fg(LIGHT_PALETTE.text),
            &LIGHT_PALETTE,
            &mut out,
            64,
        );
        assert!(!truncated);
        let text = plain_lines(&out);
        assert_eq!(text.len(), 7);
        assert!(text[0].starts_with('╭') && text[0].contains('┬') && text[0].ends_with('╮'));
        assert!(text[2].starts_with('├') && text[2].contains('┼') && text[2].ends_with('┤'));
        assert!(text[4].starts_with('├') && text[4].contains('┼') && text[4].ends_with('┤'));
        assert!(text[6].starts_with('╰') && text[6].contains('┴') && text[6].ends_with('╯'));

        let expected_w = text[0].width();
        assert!(expected_w <= 80);
        for line in &text {
            assert_eq!(line.width(), expected_w, "line width mismatch: {line}");
        }

        // Borders use palette.subtle
        assert_eq!(out[0].spans[0].1.fg, Some(LIGHT_PALETTE.subtle));
        // Header spans are bold
        assert!(out[1].spans.iter().any(|(t, s)| {
            t == "仓库"
                && s.add_modifier.contains(Modifier::BOLD)
                && s.fg == Some(LIGHT_PALETTE.text_soft)
        }));
        // Inline bold, code, strike
        assert!(
            out[3]
                .spans
                .iter()
                .any(|(t, s)| { t == "peer" && s.add_modifier.contains(Modifier::BOLD) })
        );
        assert!(out[3].spans.iter().any(|(t, s)| {
            t == "main" && s.fg == Some(LIGHT_PALETTE.code) && s.bg == Some(LIGHT_PALETTE.code_bg)
        }));
        assert!(
            out[5]
                .spans
                .iter()
                .any(|(t, s)| { t == "old" && s.add_modifier.contains(Modifier::CROSSED_OUT) })
        );
        // Right alignment on numeric column (" 12 " vs "  3 ")
        assert!(text[5].ends_with("  3 │"));
    }

    #[test]
    fn wide_four_column_cjk_table_wraps_inside_rounded_grid() {
        let headers = vec![
            "仓库".into(),
            "当前分支".into(),
            "主线位置".into(),
            "说明".into(),
        ];
        let rows = vec![
            vec![
                "Peer-Knowledge".into(),
                "`codex/coding-agent-engineering-charter`".into(),
                "`origin/main` 停在 `7600b00` (11-10, ADR 127)".into(),
                "ADR 133 及全部对齐改动只在分支上，未合入 main".into(),
            ],
            vec![
                "Peer-Agent".into(),
                "`fix/bot-thread-latest-floating`".into(),
                "`origin/main` 为 `48e88a25` (RC29 相关)".into(),
                "最近提交是桌面端「返回最新消息」浮动按钮等体验修复；Rust CLI 线在 `codex/native-rust-cli`".into(),
            ],
        ];
        let spec = TableSpec {
            headers: &headers,
            rows: &rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };

        for width in [110usize, 72] {
            let mut out = Vec::new();
            let truncated = render_table_lines(
                &spec,
                width,
                Style::new().fg(DARK_PALETTE.text),
                &DARK_PALETTE,
                &mut out,
                128,
            );
            assert!(!truncated);
            let lines = plain_lines(&out);
            let joined = lines.join("\n");
            assert!(joined.contains('╭'));
            assert!(joined.contains('╰'));
            assert!(joined.contains('├'));
            assert!(joined.contains('┼'));
            assert!(joined.contains('┤'));
            assert!(joined.contains('│'));
            assert!(
                !joined.contains("[1]"),
                "should wrap as grid at width {width}, not stack"
            );

            let grid_w = lines[0].width();
            assert!(
                grid_w <= width,
                "grid width {grid_w} exceeds viewport {width}"
            );
            for line in &lines {
                assert_eq!(line.width(), grid_w, "width mismatch at {width}: {line}");
            }

            assert!(joined.contains("Peer-Knowledge"));
            assert!(joined.contains("Peer-Agent"));

            // Rejoin column 1 and column 3 fragments across visual lines to ensure zero dropped text
            let col1_rejoined: String = lines
                .iter()
                .filter(|l| l.starts_with('│'))
                .filter_map(|l| l.split('│').nth(2))
                .map(str::trim)
                .collect();
            assert!(col1_rejoined.contains("codex/coding-agent-engineering-charter"));
            assert!(col1_rejoined.contains("fix/bot-thread-latest-floating"));

            let col3_rejoined: String = lines
                .iter()
                .filter(|l| l.starts_with('│'))
                .filter_map(|l| l.split('│').nth(4))
                .map(str::trim)
                .collect();
            let col3_compact: String = col3_rejoined
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            assert!(col3_compact.contains("ADR133及全部对齐改动只在分支上，未合入main"));
            assert!(
                col3_compact.contains(
                    "最近提交是桌面端「返回最新消息」浮动按钮等体验修复；RustCLI线在codex/native-rust-cli"
                )
            );

            // Wrapped segments of inline code keep code fg/bg style
            assert!(out.iter().any(|l| {
                l.spans.iter().any(|(t, s)| {
                    t.contains("codex/")
                        && s.fg == Some(DARK_PALETTE.code)
                        && s.bg == Some(DARK_PALETTE.code_bg)
                })
            }));
        }
    }

    #[test]
    fn unbreakable_long_token_hard_splits_on_grapheme_boundaries() {
        let headers = vec!["项".into(), "令牌".into()];
        let long_token = "a".repeat(40);
        let rows = vec![vec!["中文标识".into(), long_token]];
        let spec = TableSpec {
            headers: &headers,
            rows: &rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };

        let mut out = Vec::new();
        let truncated = render_table_lines(
            &spec,
            36,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut out,
            64,
        );
        assert!(!truncated);
        let lines = plain_lines(&out);
        let grid_w = lines[0].width();
        assert!(grid_w <= 36);
        for line in &lines {
            assert_eq!(line.width(), grid_w, "line width mismatch: {line}");
        }
        let col1_rejoined: String = lines
            .iter()
            .filter(|l| l.starts_with('│'))
            .filter_map(|l| l.split('│').nth(2))
            .map(str::trim)
            .collect();
        assert!(col1_rejoined.contains(&"a".repeat(40)));
    }

    #[test]
    fn extreme_narrow_viewport_falls_back_to_stacked_cards() {
        let headers = vec!["A".into(), "B".into(), "C".into(), "D".into()];
        let rows = vec![
            vec!["1".into(), "2".into(), "3".into(), "4".into()],
            vec!["x".into(), "y".into(), "z".into(), "w".into()],
        ];
        let spec = TableSpec {
            headers: &headers,
            rows: &rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };

        let mut out = Vec::new();
        let _ = render_table_lines(
            &spec,
            14,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut out,
            64,
        );
        let joined = plain_lines(&out).join("\n");
        assert!(joined.contains("[1]"));
        assert!(joined.contains("[2]"));
        for line in plain_lines(&out) {
            assert!(
                line.width() <= 14,
                "stacked line overflowed width 14: {line}"
            );
        }
    }

    #[test]
    fn table_handles_br_empty_body_and_line_budget() {
        // 1. Header-only table (no body rows, no dangling ├─┼─┤)
        let headers = vec!["Col A".into(), "Col B".into()];
        let empty_rows: Vec<Vec<String>> = Vec::new();
        let header_only = TableSpec {
            headers: &headers,
            rows: &empty_rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };
        let mut out = Vec::new();
        assert!(!render_table_lines(
            &header_only,
            60,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut out,
            32,
        ));
        let lines = plain_lines(&out);
        assert_eq!(lines.len(), 3);
        assert!(!lines.join("\n").contains('├'));

        // 2. `<br>` and `<br />` inside cells
        let br_rows = vec![vec!["第一行<br>第二行".into(), "a<br />`b`".into()]];
        let br_spec = TableSpec {
            headers: &headers,
            rows: &br_rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };
        let mut br_out = Vec::new();
        assert!(!render_table_lines(
            &br_spec,
            80,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut br_out,
            32,
        ));
        let br_text = plain_lines(&br_out).join("\n");
        assert!(br_text.contains("第一行"));
        assert!(br_text.contains("第二行"));
        assert!(!br_text.contains("<br"));

        // 3. Large 100-row table respects max_lines = 24
        let many_rows: Vec<Vec<String>> = (0..100)
            .map(|i| vec![format!("item-{i}"), format!("val-{i}")])
            .collect();
        let large_spec = TableSpec {
            headers: &headers,
            rows: &many_rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };
        let mut capped = Vec::new();
        assert!(render_table_lines(
            &large_spec,
            60,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut capped,
            24,
        ));
        assert_eq!(capped.len(), 24);
    }

    fn slice_display_cols(line: &StyledLine, col_start: u16, col_end: u16) -> String {
        let mut out = String::new();
        let mut col = 0u16;
        for (text, _) in &line.spans {
            for g in text.graphemes(true) {
                let gw = g.width() as u16;
                if col >= col_start && col < col_end {
                    out.push_str(g);
                }
                col = col.saturating_add(gw);
            }
        }
        out
    }

    #[test]
    fn table_cells_and_stacked_fallback_project_exact_hyperlink_columns() {
        let headers = vec!["文档".into(), "路径".into()];
        let rows = vec![vec![
            "[架构 133](file:///Users/foo/133.md)".into(),
            "`crates/peer-tui/src/table.rs`".into(),
        ]];
        let spec = TableSpec {
            headers: &headers,
            rows: &rows,
            alignments: &[],
            borders: TableBorders::ROUNDED,
        };

        let mut wide_out = Vec::new();
        assert!(!render_table_lines(
            &spec,
            80,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut wide_out,
            32,
        ));
        let wide_links: Vec<(&StyledLine, &LineLink)> = wide_out
            .iter()
            .flat_map(|line| line.links.iter().map(move |link| (line, link)))
            .collect();
        assert_eq!(wide_links.len(), 2);
        assert_eq!(wide_links[0].1.target, "file:///Users/foo/133.md");
        assert_eq!(
            slice_display_cols(
                wide_links[0].0,
                wide_links[0].1.col_start,
                wide_links[0].1.col_end
            ),
            "架构 133"
        );
        assert_eq!(wide_links[1].1.target, "crates/peer-tui/src/table.rs");
        assert_eq!(
            slice_display_cols(
                wide_links[1].0,
                wide_links[1].1.col_start,
                wide_links[1].1.col_end
            ),
            "crates/peer-tui/src/table.rs"
        );

        let mut stacked_out = Vec::new();
        render_table_lines(
            &spec,
            14,
            Style::new().fg(DARK_PALETTE.text),
            &DARK_PALETTE,
            &mut stacked_out,
            32,
        );
        let stacked_links: Vec<(&StyledLine, &LineLink)> = stacked_out
            .iter()
            .flat_map(|line| line.links.iter().map(move |link| (line, link)))
            .collect();
        assert!(!stacked_links.is_empty());
        for (line, link) in stacked_links {
            let sliced = slice_display_cols(line, link.col_start, link.col_end);
            assert!(!sliced.trim().is_empty());
        }
    }
}
