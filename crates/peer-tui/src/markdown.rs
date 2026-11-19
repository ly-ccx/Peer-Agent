//! Bounded block-level Markdown, code-fence syntax highlighting, and diff formatter for Ratatui (ADR 130).
//!
//! Processes sanitized text in bounded byte/line slices so even a 10 MiB single
//! message never constructs a million-line Paragraph or stalls the draw loop.

use crate::{
    bounded_cache::ByteSized,
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

fn wrap_plain_into(
    text: &str,
    width: usize,
    style: Style,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    push_wrapped_segments(vec![(text.to_owned(), style)], width, None, out, max_lines);
}

/// Format inline `**bold**` and `` `code` `` spans within one unwrapped text line, then wrap to `width`.
fn tokenize_inline_markdown(
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
        let ch_len = text[i..].chars().next().map_or(1, char::len_utf8);
        i += ch_len;
    }
    if plain_start < bytes.len() {
        segments.push((text[plain_start..].to_owned(), base_style));
    }
}

fn wrap_inline_markdown(
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

    for raw_line in slice.split('\n') {
        if lines.len() >= effective_max {
            truncated = true;
            break;
        }
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
}
