//! Bounded block-level Markdown, code-fence syntax highlighting, and diff formatter for Ratatui (ADR 130).
//!
//! Processes sanitized text in bounded byte/line slices so even a 10 MiB single
//! message never constructs a million-line Paragraph or stalls the draw loop.

use crate::{
    bounded_cache::ByteSized,
    table::{TableAlignment, TableBorders, TableSpec, render_table_lines},
    terminal_text,
    theme::{
        DARK_PALETTE, HEADING_H1, HEADING_H2, HEADING_H3, LIST_BULLET, QUOTE_PREFIX, TuiPalette,
    },
};
use ratatui::{
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Hard per-message rendering cap to prevent unbounded Paragraph allocations (ADR 130).
pub const MAX_MARKDOWN_INPUT_BYTES: usize = 32 * 1024;
pub const MAX_WRAPPED_LINES_PER_ITEM: usize = 256;

#[derive(Debug, Clone)]
pub struct StyledLine {
    pub spans: Vec<(String, Style)>,
    pub bytes: usize,
}

impl StyledLine {
    pub fn plain(text: String, style: Style) -> Self {
        let bytes = text.len() + 32;
        Self {
            spans: vec![(text, style)],
            bytes,
        }
    }

    pub(crate) fn from_spans(spans: Vec<(String, Style)>) -> Self {
        let bytes = spans
            .iter()
            .map(|(text, _)| text.len() + 32)
            .sum::<usize>()
            .max(32);
        Self { spans, bytes }
    }

    pub fn to_ratatui_line(&self) -> Line<'static> {
        Line::from(
            self.spans
                .iter()
                .map(|(text, style)| Span::styled(text.clone(), *style))
                .collect::<Vec<_>>(),
        )
    }
}

impl ByteSized for StyledLine {
    fn approx_bytes(&self) -> usize {
        self.bytes
    }
}

#[derive(Debug, Clone)]
pub struct RenderedBlock {
    pub lines: Vec<StyledLine>,
    pub truncated: bool,
    pub total_bytes: usize,
}

impl ByteSized for RenderedBlock {
    fn approx_bytes(&self) -> usize {
        self.total_bytes
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct WrapCacheKey {
    pub item_hash: u64,
    pub revision: u64,
    pub width: u16,
    pub scheme: u8,
}

pub fn stable_hash(text: &str) -> u64 {
    // 64-bit FNV-1a over UTF-8 bytes for compact cache keys (never stores full body in key).
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in text.as_bytes() {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

fn push_wrapped_segments(
    segments: Vec<(String, Style)>,
    width: usize,
    fill_style: Option<Style>,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let w = width.max(1);
    let pad_target = w.min(240);
    let emit_line = |spans: &mut Vec<(String, Style)>,
                     bytes: &mut usize,
                     col: usize,
                     out: &mut Vec<StyledLine>| {
        if out.len() >= max_lines {
            spans.clear();
            *bytes = 0;
            return;
        }
        if let Some(bg_style) = fill_style
            && col < pad_target
        {
            let pad = " ".repeat(pad_target - col);
            *bytes += pad.len() + 32;
            spans.push((pad, bg_style));
        }
        out.push(StyledLine {
            spans: std::mem::take(spans),
            bytes: (*bytes).max(32),
        });
        *bytes = 0;
    };

    if segments.is_empty() {
        let mut spans = Vec::new();
        let mut bytes = 0usize;
        emit_line(&mut spans, &mut bytes, 0, out);
        return;
    }

    let mut cur_spans: Vec<(String, Style)> = Vec::new();
    let mut cur_bytes = 0usize;
    let mut col = 0usize;

    for (seg_text, seg_style) in segments {
        let mut buf = String::new();
        for grapheme in seg_text.graphemes(true) {
            let glyph = if grapheme == "\t" { "    " } else { grapheme };
            let gw = glyph.width().min(w);
            if col + gw > w && col > 0 {
                if !buf.is_empty() {
                    cur_bytes += buf.len() + 32;
                    cur_spans.push((std::mem::take(&mut buf), seg_style));
                }
                emit_line(&mut cur_spans, &mut cur_bytes, col, out);
                col = 0;
                if out.len() >= max_lines {
                    return;
                }
            }
            buf.push_str(glyph);
            col += gw;
        }
        if !buf.is_empty() {
            cur_bytes += buf.len() + 32;
            cur_spans.push((buf, seg_style));
        }
    }
    emit_line(&mut cur_spans, &mut cur_bytes, col, out);
}

pub(crate) fn wrap_plain_into(
    text: &str,
    width: usize,
    style: Style,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    push_wrapped_segments(vec![(text.to_owned(), style)], width, None, out, max_lines);
}

/// Format inline `**bold**`, `~~strike~~`, and `` `code` `` spans within one unwrapped text line.
pub(crate) fn tokenize_inline_markdown(
    text: &str,
    base_style: Style,
    palette: &TuiPalette,
    segments: &mut Vec<(String, Style)>,
) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut plain_start = 0usize;
    let code_style = base_style.fg(palette.code).bg(palette.code_bg);
    while i < bytes.len() {
        if bytes[i] == b'`'
            && let Some(end_rel) = text[i + 1..].find('`')
            && end_rel > 0
        {
            if i > plain_start {
                segments.push((text[plain_start..i].to_owned(), base_style));
            }
            let code_end = i + 1 + end_rel;
            segments.push((text[i + 1..code_end].to_owned(), code_style));
            i = code_end + 1;
            plain_start = i;
            continue;
        }
        if bytes[i..].starts_with(b"**")
            && let Some(end_rel) = text[i + 2..].find("**")
            && end_rel > 0
        {
            if i > plain_start {
                segments.push((text[plain_start..i].to_owned(), base_style));
            }
            let bold_end = i + 2 + end_rel;
            segments.push((
                text[i + 2..bold_end].to_owned(),
                base_style.add_modifier(Modifier::BOLD),
            ));
            i = bold_end + 2;
            plain_start = i;
            continue;
        }
        if bytes[i..].starts_with(b"~~")
            && let Some(end_rel) = text[i + 2..].find("~~")
            && end_rel > 0
        {
            if i > plain_start {
                segments.push((text[plain_start..i].to_owned(), base_style));
            }
            let strike_end = i + 2 + end_rel;
            segments.push((
                text[i + 2..strike_end].to_owned(),
                base_style.add_modifier(Modifier::CROSSED_OUT),
            ));
            i = strike_end + 2;
            plain_start = i;
            continue;
        }
        let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
        i += ch_len;
    }
    if plain_start < bytes.len() {
        segments.push((text[plain_start..].to_owned(), base_style));
    }
}

pub(crate) fn wrap_inline_markdown(
    text: &str,
    width: usize,
    base_style: Style,
    palette: &TuiPalette,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let mut segments = Vec::new();
    tokenize_inline_markdown(text, base_style, palette, &mut segments);
    push_wrapped_segments(segments, width, None, out, max_lines);
}

const MAX_TABLE_COLUMNS: usize = 32;

fn is_heading_line(trimmed: &str) -> bool {
    ["# ", "## ", "### ", "#### ", "##### ", "###### "]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix))
}

fn is_horizontal_rule(line: &str) -> bool {
    let trimmed = line.trim();
    let Some(marker) = trimmed.chars().next() else {
        return false;
    };
    if !matches!(marker, '-' | '*' | '_') {
        return false;
    }
    let mut count = 0usize;
    for ch in trimmed.chars() {
        if ch == marker {
            count += 1;
        } else if !ch.is_whitespace() {
            return false;
        }
    }
    count >= 3
}

fn is_table_row(line: &str) -> bool {
    !line.trim().is_empty() && line.contains('|')
}

fn has_unescaped_backtick(s: &str) -> bool {
    let mut escaped = false;
    for ch in s.chars() {
        if escaped {
            escaped = false;
            continue;
        }
        if ch == '\\' {
            escaped = true;
            continue;
        }
        if ch == '`' {
            return true;
        }
    }
    false
}

fn split_table_row(line: &str) -> Vec<String> {
    let mut s = line.trim();
    if let Some(rest) = s.strip_prefix('|') {
        s = rest;
    }
    if let Some(rest) = s.strip_suffix('|')
        && !rest.ends_with('\\')
    {
        s = rest;
    }
    let mut cells = Vec::new();
    let mut cur = String::new();
    let mut escaped = false;
    let mut in_code = false;
    for (idx, ch) in s.char_indices() {
        if escaped {
            cur.push(ch);
            escaped = false;
            continue;
        }
        if ch == '\\' && (!in_code || s[idx + 1..].starts_with('|')) {
            escaped = true;
            continue;
        }
        if ch == '`' {
            if in_code {
                in_code = false;
            } else if has_unescaped_backtick(&s[idx + 1..]) {
                in_code = true;
            }
            cur.push(ch);
            continue;
        }
        if ch == '|' && !in_code {
            cells.push(cur.trim().to_owned());
            cur.clear();
            if cells.len() >= MAX_TABLE_COLUMNS {
                return cells;
            }
            continue;
        }
        cur.push(ch);
    }
    if escaped {
        cur.push('\\');
    }
    if cells.len() < MAX_TABLE_COLUMNS {
        cells.push(cur.trim().to_owned());
    }
    cells
}

fn is_table_separator(line: &str) -> bool {
    if !line.contains('|') {
        return false;
    }
    let cells = split_table_row(line);
    !cells.is_empty()
        && cells.iter().all(|cell| {
            let trimmed = cell.trim();
            let inner = trimmed
                .strip_prefix(':')
                .unwrap_or(trimmed)
                .strip_suffix(':')
                .unwrap_or_else(|| trimmed.strip_prefix(':').unwrap_or(trimmed));
            !inner.is_empty() && inner.bytes().all(|b| b == b'-')
        })
}

fn parse_table_alignments(sep: &str) -> Vec<TableAlignment> {
    split_table_row(sep)
        .into_iter()
        .map(|cell| {
            let left = cell.starts_with(':');
            let right = cell.ends_with(':');
            match (left, right) {
                (true, true) => TableAlignment::Center,
                (false, true) => TableAlignment::Right,
                _ => TableAlignment::Left,
            }
        })
        .collect()
}

fn is_keyword(word: &str) -> bool {
    matches!(
        word,
        "fn" | "let"
            | "mut"
            | "const"
            | "pub"
            | "struct"
            | "enum"
            | "impl"
            | "trait"
            | "for"
            | "while"
            | "loop"
            | "if"
            | "else"
            | "match"
            | "return"
            | "async"
            | "await"
            | "use"
            | "mod"
            | "type"
            | "where"
            | "function"
            | "var"
            | "class"
            | "import"
            | "export"
            | "from"
            | "as"
            | "def"
            | "try"
            | "catch"
            | "except"
            | "finally"
            | "raise"
            | "throw"
            | "new"
            | "in"
            | "of"
            | "func"
            | "go"
            | "defer"
            | "select"
            | "switch"
            | "case"
            | "default"
            | "break"
            | "continue"
            | "readonly"
            | "interface"
            | "extends"
    )
}

fn is_literal(word: &str) -> bool {
    matches!(
        word,
        "true"
            | "false"
            | "null"
            | "nil"
            | "None"
            | "Some"
            | "Ok"
            | "Err"
            | "True"
            | "False"
            | "undefined"
            | "self"
            | "Self"
            | "this"
            | "super"
    )
}

fn highlight_code_line(line: &str, lang: &str, palette: &TuiPalette) -> Vec<(String, Style)> {
    let bg = palette.code_bg;
    let base = Style::new().fg(palette.text).bg(bg);
    if line.is_empty() {
        return vec![("  ".to_owned(), base)];
    }
    let mut segs: Vec<(String, Style)> = vec![("  ".to_owned(), base)];
    let trimmed = line.trim_start();
    let hash_comment_lang = matches!(
        lang,
        "py" | "python" | "sh" | "bash" | "zsh" | "yaml" | "yml" | "toml" | "rb" | "ruby"
    );

    let bytes = line.as_bytes();
    let mut i = 0usize;
    while i < bytes.len() {
        let rest = &line[i..];
        if rest.starts_with("//")
            || (hash_comment_lang && trimmed.starts_with('#') && bytes[i] == b'#')
        {
            segs.push((rest.to_owned(), Style::new().fg(palette.muted).bg(bg)));
            break;
        }
        let b = bytes[i];
        if b == b'"' || b == b'\'' || b == b'`' {
            let quote = b;
            let mut j = i + 1;
            while j < bytes.len() {
                if bytes[j] == b'\\' {
                    j = (j + 2).min(bytes.len());
                    continue;
                }
                if bytes[j] == quote {
                    j += 1;
                    break;
                }
                j += 1;
            }
            while j < bytes.len() && !line.is_char_boundary(j) {
                j += 1;
            }
            segs.push((
                line[i..j].to_owned(),
                Style::new().fg(palette.success).bg(bg),
            ));
            i = j;
            continue;
        }
        if b.is_ascii_digit() {
            let mut j = i + 1;
            while j < bytes.len()
                && (bytes[j].is_ascii_alphanumeric()
                    || matches!(bytes[j], b'.' | b'_' | b'x' | b'X'))
            {
                j += 1;
            }
            segs.push((
                line[i..j].to_owned(),
                Style::new().fg(palette.warning).bg(bg),
            ));
            i = j;
            continue;
        }
        if b.is_ascii_alphabetic() || b == b'_' {
            let mut j = i + 1;
            while j < bytes.len() && (bytes[j].is_ascii_alphanumeric() || bytes[j] == b'_') {
                j += 1;
            }
            let word = &line[i..j];
            let style = if is_keyword(word) {
                Style::new().fg(palette.accent).bg(bg)
            } else if is_literal(word) {
                Style::new().fg(palette.warning).bg(bg)
            } else if word.chars().next().is_some_and(|c| c.is_ascii_uppercase()) {
                Style::new().fg(palette.info).bg(bg)
            } else if line[j..].trim_start().starts_with('(') {
                Style::new().fg(palette.accent_soft).bg(bg)
            } else {
                base
            };
            segs.push((word.to_owned(), style));
            i = j;
            continue;
        }
        let ch_len = line[i..].chars().next().map_or(1, char::len_utf8);
        let style = if matches!(
            b,
            b'+' | b'-' | b'*' | b'/' | b'=' | b'<' | b'>' | b'!' | b'&' | b'|'
        ) {
            Style::new().fg(palette.text_soft).bg(bg)
        } else {
            base
        };
        let chunk = &line[i..i + ch_len];
        if let Some((prev, prev_style)) = segs.last_mut()
            && *prev_style == style
        {
            prev.push_str(chunk);
        } else {
            segs.push((chunk.to_owned(), style));
        }
        i += ch_len;
    }
    segs
}

/// Render a bounded Markdown / code / diff slice using the default dark Frost palette.
pub fn render_markdown_bounded(
    raw: &str,
    width: usize,
    base_style: Style,
    max_lines: usize,
) -> RenderedBlock {
    render_markdown_themed(raw, width, base_style, max_lines, &DARK_PALETTE)
}

/// Render a bounded Markdown / code / diff slice into wrapped Ratatui lines using `palette`.
pub fn render_markdown_themed(
    raw: &str,
    width: usize,
    base_style: Style,
    max_lines: usize,
    palette: &TuiPalette,
) -> RenderedBlock {
    let sanitized = terminal_text(raw);
    let mut truncated = false;
    let slice = if sanitized.len() > MAX_MARKDOWN_INPUT_BYTES {
        truncated = true;
        let mut cut = MAX_MARKDOWN_INPUT_BYTES;
        while cut > 0 && !sanitized.is_char_boundary(cut) {
            cut -= 1;
        }
        &sanitized[..cut]
    } else {
        sanitized.as_str()
    };

    let effective_max = max_lines.clamp(1, MAX_WRAPPED_LINES_PER_ITEM);
    let mut lines: Vec<StyledLine> = Vec::new();
    let mut in_code_fence = false;
    let mut fence_lang = String::new();
    let raw_lines: Vec<&str> = slice.split('\n').collect();
    let mut line_idx = 0usize;

    while line_idx < raw_lines.len() {
        if lines.len() >= effective_max {
            truncated = true;
            break;
        }
        let raw_line = raw_lines[line_idx];
        let trimmed = raw_line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            if !in_code_fence {
                in_code_fence = true;
                fence_lang = rest.trim().to_ascii_lowercase();
                let badge = if fence_lang.is_empty() {
                    "── code ──".to_owned()
                } else {
                    format!("── {fence_lang} ──")
                };
                wrap_plain_into(
                    &badge,
                    width,
                    Style::new().fg(palette.muted).bg(palette.background),
                    &mut lines,
                    effective_max,
                );
            } else {
                in_code_fence = false;
                fence_lang.clear();
                wrap_plain_into(
                    "──────────",
                    width,
                    Style::new().fg(palette.muted).bg(palette.background),
                    &mut lines,
                    effective_max,
                );
            }
            line_idx += 1;
            continue;
        }

        if in_code_fence {
            let code_bg_style = Style::new().bg(palette.code_bg);
            if fence_lang == "diff" {
                let diff_fg = if raw_line.starts_with("@@") {
                    palette.diff_hunk
                } else if raw_line.starts_with("+++")
                    || raw_line.starts_with("---")
                    || raw_line.starts_with("diff --git ")
                    || raw_line.starts_with("index ")
                {
                    palette.diff_meta
                } else if raw_line.starts_with('+') {
                    palette.diff_add
                } else if raw_line.starts_with('-') {
                    palette.diff_delete
                } else {
                    palette.text
                };
                push_wrapped_segments(
                    vec![(
                        format!("  {raw_line}"),
                        Style::new().fg(diff_fg).bg(palette.code_bg),
                    )],
                    width,
                    Some(code_bg_style),
                    &mut lines,
                    effective_max,
                );
            } else {
                let segs = highlight_code_line(raw_line, &fence_lang, palette);
                push_wrapped_segments(segs, width, Some(code_bg_style), &mut lines, effective_max);
            }
            line_idx += 1;
            continue;
        }

        // GFM table: header row | delimiter row | data rows
        if is_table_row(raw_line)
            && line_idx + 1 < raw_lines.len()
            && is_table_separator(raw_lines[line_idx + 1])
        {
            let headers = split_table_row(raw_line);
            let alignments = parse_table_alignments(raw_lines[line_idx + 1]);
            if !headers.is_empty() && headers.len() == alignments.len() {
                let mut row_idx = line_idx + 2;
                let mut rows = Vec::new();
                while row_idx < raw_lines.len() {
                    let candidate = raw_lines[row_idx];
                    let c_trim = candidate.trim_start();
                    if !is_table_row(candidate)
                        || c_trim.starts_with("```")
                        || c_trim.starts_with("> ")
                        || is_heading_line(c_trim)
                    {
                        break;
                    }
                    if rows.len() >= effective_max {
                        truncated = true;
                        row_idx += 1;
                        while row_idx < raw_lines.len()
                            && is_table_row(raw_lines[row_idx])
                            && !raw_lines[row_idx].trim_start().starts_with("```")
                            && !raw_lines[row_idx].trim_start().starts_with("> ")
                            && !is_heading_line(raw_lines[row_idx].trim_start())
                        {
                            row_idx += 1;
                        }
                        break;
                    }
                    rows.push(split_table_row(candidate));
                    row_idx += 1;
                }
                let spec = TableSpec {
                    headers: &headers,
                    rows: &rows,
                    alignments: &alignments,
                    borders: TableBorders::ROUNDED,
                };
                if render_table_lines(
                    &spec,
                    width.max(1),
                    base_style,
                    palette,
                    &mut lines,
                    effective_max,
                ) {
                    truncated = true;
                }
                line_idx = row_idx;
                continue;
            }
        }

        if is_horizontal_rule(raw_line) {
            wrap_plain_into(
                &"─".repeat(width.clamp(3, 40)),
                width,
                Style::new().fg(palette.muted).bg(palette.background),
                &mut lines,
                effective_max,
            );
            line_idx += 1;
            continue;
        }

        // Headings (`apps/tui/src/tui-theme.ts` MARKDOWN_CHROME)
        if let Some(h3) = trimmed.strip_prefix("### ") {
            let segs = vec![
                (
                    HEADING_H3.to_owned(),
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                ),
                (
                    h3.trim_start().to_owned(),
                    base_style.fg(palette.text).add_modifier(Modifier::BOLD),
                ),
            ];
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }
        if let Some(h2) = trimmed.strip_prefix("## ") {
            let segs = vec![
                (
                    HEADING_H2.to_owned(),
                    Style::new()
                        .fg(palette.info)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                ),
                (
                    h2.trim_start().to_owned(),
                    base_style.fg(palette.info).add_modifier(Modifier::BOLD),
                ),
            ];
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }
        if let Some(h1) = trimmed.strip_prefix("# ") {
            let segs = vec![
                (
                    HEADING_H1.to_owned(),
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                ),
                (
                    h1.trim_start().to_owned(),
                    base_style.fg(palette.accent).add_modifier(Modifier::BOLD),
                ),
            ];
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }

        // Blockquote
        if let Some(quoted) = trimmed.strip_prefix("> ") {
            let mut segs = vec![(
                QUOTE_PREFIX.to_owned(),
                Style::new().fg(palette.border_focus).bg(palette.background),
            )];
            tokenize_inline_markdown(quoted, base_style.fg(palette.text_soft), palette, &mut segs);
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }

        // Unordered list bullets (`- ` or `* `)
        if let Some(bullet_body) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
        {
            let indent_len = raw_line.len().saturating_sub(trimmed.len());
            let indent = " ".repeat(indent_len.min(16));
            let mut segs = vec![
                (indent, base_style),
                (
                    LIST_BULLET.to_owned(),
                    Style::new().fg(palette.accent).bg(palette.background),
                ),
            ];
            tokenize_inline_markdown(bullet_body, base_style, palette, &mut segs);
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }

        wrap_inline_markdown(
            raw_line,
            width,
            base_style,
            palette,
            &mut lines,
            effective_max,
        );
        line_idx += 1;
    }

    if truncated {
        let notice = StyledLine::plain(
            "… ［单条内容超过单页渲染预算，已按块折叠］".to_owned(),
            Style::new().fg(palette.warning).bg(palette.background),
        );
        if lines.len() >= effective_max && !lines.is_empty() {
            *lines.last_mut().unwrap() = notice;
        } else {
            lines.push(notice);
        }
    }

    let total_bytes = lines.iter().map(|l| l.bytes).sum::<usize>() + 64;
    RenderedBlock {
        lines,
        truncated,
        total_bytes,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::LIGHT_PALETTE;

    #[test]
    fn markdown_handles_code_diff_bold_and_caps_10mb_single_message() {
        let md = "# 标题\n- 项目条目\n这是 **加粗** 和 `code`。\n```rust\nfn demo() -> usize { 42 }\n```\n```diff\n+added\n-removed\n@@ -1 +1 @@\n```";
        let rendered = render_markdown_themed(
            md,
            40,
            Style::new().fg(DARK_PALETTE.text),
            64,
            &DARK_PALETTE,
        );
        assert!(!rendered.truncated);
        assert!(rendered.lines.len() >= 8);
        assert!(rendered.lines.iter().any(|l| {
            l.spans.iter().any(|(t, s)| {
                t.contains("+added")
                    && s.fg == Some(DARK_PALETTE.diff_add)
                    && s.bg == Some(DARK_PALETTE.code_bg)
            })
        }));
        assert!(rendered.lines.iter().any(|l| {
            l.spans.iter().any(|(t, s)| {
                t.contains("-removed")
                    && s.fg == Some(DARK_PALETTE.diff_delete)
                    && s.bg == Some(DARK_PALETTE.code_bg)
            })
        }));
        assert!(rendered.lines.iter().any(|l| {
            l.spans
                .iter()
                .any(|(t, s)| t == "fn" && s.fg == Some(DARK_PALETTE.accent))
        }));

        // Light palette uses light code surface
        let light = render_markdown_themed(
            "`x`",
            40,
            Style::new().fg(LIGHT_PALETTE.text),
            16,
            &LIGHT_PALETTE,
        );
        assert!(light.lines.iter().any(|l| {
            l.spans.iter().any(|(t, s)| {
                t == "x" && s.fg == Some(LIGHT_PALETTE.code) && s.bg == Some(LIGHT_PALETTE.code_bg)
            })
        }));

        // 10 MiB single message must finish fast and cap output cleanly.
        let giant = "a".repeat(10 * 1024 * 1024);
        let bounded = render_markdown_bounded(&giant, 80, Style::default(), 120);
        assert!(bounded.truncated);
        assert!(bounded.lines.len() <= 120);
    }

    fn plain_lines(block: &RenderedBlock) -> Vec<String> {
        block
            .lines
            .iter()
            .map(|l| l.spans.iter().map(|(t, _)| t.as_str()).collect::<String>())
            .collect()
    }

    #[test]
    fn markdown_renders_gfm_rounded_tables_and_narrow_fallback() {
        // 1. Wide 3-column table renders with rounded borders, uniform width, and inline styles
        let data_md = "| 仓库 | 分支 | 数量 |\n|:---|---:|---:|\n| **peer** | `main` | 12 |\n| ~~old~~ | `next` | 3 |";
        let data_block = render_markdown_themed(
            data_md,
            80,
            Style::new().fg(DARK_PALETTE.text),
            64,
            &DARK_PALETTE,
        );
        let data_text = plain_lines(&data_block);
        assert_eq!(data_text.len(), 7);
        assert!(data_text[0].starts_with('╭') && data_text[0].ends_with('╮'));
        assert!(data_text[2].starts_with('├') && data_text[2].contains('┼'));
        assert!(data_text[6].starts_with('╰') && data_text[6].ends_with('╯'));
        let grid_w = data_text[0].width();
        for line in &data_text {
            assert_eq!(line.width(), grid_w);
        }
        assert!(data_block.lines[3].spans.iter().any(|(t, s)| {
            t == "main" && s.fg == Some(DARK_PALETTE.code) && s.bg == Some(DARK_PALETTE.code_bg)
        }));
        assert!(
            data_block.lines[3]
                .spans
                .iter()
                .any(|(t, s)| { t == "peer" && s.add_modifier.contains(Modifier::BOLD) })
        );
        assert!(
            data_block.lines[5]
                .spans
                .iter()
                .any(|(t, s)| { t == "old" && s.add_modifier.contains(Modifier::CROSSED_OUT) })
        );

        // 2. Wide 4-column screenshot-style table at width=72 wraps inside rounded grid (not stacked!)
        let wide_md = "| 仓库 | 当前分支 | 主线位置 | 说明 |\n|---|---|---|---|\n| Peer-Knowledge | `codex/coding-agent-engineering-charter` | `origin/main` 停在 `7600b00` (11-10, ADR 127) | ADR 133 只在分支上，未合入 main |\n| Peer-Agent | `fix/bot-thread-latest-floating` | `origin/main` 为 `48e88a25` (RC29 相关) | 最近提交为桌面体验修复；Rust CLI 线在 `codex/native-rust-cli` |";
        let wrapped_block = render_markdown_themed(
            wide_md,
            72,
            Style::new().fg(DARK_PALETTE.text),
            128,
            &DARK_PALETTE,
        );
        let wrapped_lines = plain_lines(&wrapped_block);
        let wrapped_text = wrapped_lines.join("\n");
        assert!(wrapped_text.contains('╭'));
        assert!(wrapped_text.contains('╰'));
        assert!(wrapped_text.contains("Peer-Knowledge"));
        assert!(wrapped_text.contains("Peer-Agent"));
        assert!(!wrapped_text.contains("[1]"));
        assert!(!wrapped_text.contains("|---|"));
        let wide_grid_w = wrapped_lines[0].width();
        assert!(wide_grid_w <= 72);
        for line in &wrapped_lines {
            assert_eq!(line.width(), wide_grid_w);
        }

        // 3. 2-column summary table renders with consistent rounded grid borders too
        let summary_md = "| 项 | 结果 |\n|---|---|\n| 状态 | `ok` |\n| 数量 | 42 |";
        let summary_block = render_markdown_themed(
            summary_md,
            80,
            Style::new().fg(DARK_PALETTE.text),
            64,
            &DARK_PALETTE,
        );
        let summary_text = plain_lines(&summary_block).join("\n");
        assert!(summary_text.contains('╭'));
        assert!(summary_text.contains('╰'));
        assert!(summary_text.contains("状态"));
        assert!(summary_text.contains("ok"));

        // 4. Backtick-escaped pipe stays inside cell 0
        let pipe_md = "| 命令 | 说明 |\n|---|---|\n| `a | b` | 管道示例 |";
        let pipe_block = render_markdown_themed(
            pipe_md,
            80,
            Style::new().fg(DARK_PALETTE.text),
            64,
            &DARK_PALETTE,
        );
        let pipe_lines = plain_lines(&pipe_block);
        assert!(pipe_lines[3].contains("a | b"));
        assert_eq!(pipe_lines[0].matches('┬').count(), 1);

        // 5. Extreme narrow width=14 falls back to stacked cards
        let narrow_block = render_markdown_themed(
            wide_md,
            14,
            Style::new().fg(DARK_PALETTE.text),
            64,
            &DARK_PALETTE,
        );
        let narrow_text = plain_lines(&narrow_block).join("\n");
        assert!(narrow_text.contains("[1]"));
        assert!(narrow_text.contains("[2]"));

        // 6. Non-table prose containing `|` followed by regular text renders as prose
        let prose_md = "使用 | 作为分隔符\n这行是普通文本";
        let prose_block = render_markdown_themed(
            prose_md,
            80,
            Style::new().fg(DARK_PALETTE.text),
            32,
            &DARK_PALETTE,
        );
        let prose_text = plain_lines(&prose_block).join("\n");
        assert!(!prose_text.contains('╭'));
        assert!(prose_text.contains("使用 | 作为分隔符"));
    }
}
