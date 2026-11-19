//! Bounded block-level Markdown, code-fence, and diff formatter for Ratatui (ADR 130).
//!
//! Processes sanitized text in bounded byte/line slices so even a 10 MiB single
//! message never constructs a million-line Paragraph or stalls the draw loop.

use crate::{bounded_cache::ByteSized, terminal_text};
use ratatui::{
    style::{Color, Modifier, Style},
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

fn wrap_plain_into(
    text: &str,
    width: usize,
    style: Style,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let w = width.max(1);
    let mut line = String::new();
    let mut col = 0usize;
    for grapheme in text.graphemes(true) {
        let glyph = if grapheme == "\t" { "    " } else { grapheme };
        let gw = glyph.width().min(w);
        if col + gw > w && !line.is_empty() {
            if out.len() >= max_lines {
                return;
            }
            out.push(StyledLine::plain(std::mem::take(&mut line), style));
            col = 0;
        }
        line.push_str(glyph);
        col += gw;
    }
    if out.len() < max_lines {
        out.push(StyledLine::plain(line, style));
    }
}

/// Format inline `**bold**` and `` `code` `` spans within one unwrapped text line, then wrap to `width`.
fn wrap_inline_markdown(
    text: &str,
    width: usize,
    base_style: Style,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let w = width.max(1);
    // Tokenize into styled segments (code backticks and **bold**).
    let mut segments: Vec<(String, Style)> = Vec::new();
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut plain_start = 0usize;
    while i < bytes.len() {
        if bytes[i] == b'`'
            && let Some(end_rel) = text[i + 1..].find('`')
            && end_rel > 0
        {
            if i > plain_start {
                segments.push((text[plain_start..i].to_owned(), base_style));
            }
            let code_end = i + 1 + end_rel;
            segments.push((text[i + 1..code_end].to_owned(), base_style.fg(Color::Cyan)));
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
    if segments.is_empty() {
        if out.len() < max_lines {
            out.push(StyledLine::plain(String::new(), base_style));
        }
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
            if col + gw > w && (col > 0) {
                if !buf.is_empty() {
                    cur_bytes += buf.len() + 32;
                    cur_spans.push((std::mem::take(&mut buf), seg_style));
                }
                if out.len() >= max_lines {
                    return;
                }
                out.push(StyledLine {
                    spans: std::mem::take(&mut cur_spans),
                    bytes: cur_bytes,
                });
                cur_bytes = 0;
                col = 0;
            }
            buf.push_str(glyph);
            col += gw;
        }
        if !buf.is_empty() {
            cur_bytes += buf.len() + 32;
            cur_spans.push((buf, seg_style));
        }
    }
    if out.len() < max_lines {
        out.push(StyledLine {
            spans: cur_spans,
            bytes: cur_bytes.max(32),
        });
    }
}

/// Render a bounded Markdown / code / diff slice into wrapped Ratatui lines.
pub fn render_markdown_bounded(
    raw: &str,
    width: usize,
    base_style: Style,
    max_lines: usize,
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
    let mut fence_is_diff = false;

    for raw_line in slice.split('\n') {
        if lines.len() >= effective_max {
            truncated = true;
            break;
        }
        let trimmed = raw_line.trim_start();
        if let Some(rest) = trimmed.strip_prefix("```") {
            if !in_code_fence {
                in_code_fence = true;
                let lang = rest.trim();
                fence_is_diff = lang.eq_ignore_ascii_case("diff");
                let badge = if lang.is_empty() {
                    "── code ──".to_owned()
                } else {
                    format!("── {lang} ──")
                };
                wrap_plain_into(
                    &badge,
                    width,
                    Style::new().fg(Color::DarkGray),
                    &mut lines,
                    effective_max,
                );
            } else {
                in_code_fence = false;
                fence_is_diff = false;
                wrap_plain_into(
                    "──────────",
                    width,
                    Style::new().fg(Color::DarkGray),
                    &mut lines,
                    effective_max,
                );
            }
            continue;
        }

        if in_code_fence {
            let code_style = if fence_is_diff {
                if raw_line.starts_with('+') && !raw_line.starts_with("+++") {
                    Style::new().fg(Color::Green)
                } else if raw_line.starts_with('-') && !raw_line.starts_with("---") {
                    Style::new().fg(Color::Red)
                } else if raw_line.starts_with("@@") {
                    Style::new().fg(Color::Cyan)
                } else {
                    Style::new().fg(Color::Gray)
                }
            } else {
                Style::new().fg(Color::Gray)
            };
            let indented = format!("  {raw_line}");
            wrap_plain_into(&indented, width, code_style, &mut lines, effective_max);
            continue;
        }

        // Heading
        if trimmed.starts_with("### ") || trimmed.starts_with("## ") || trimmed.starts_with("# ") {
            let heading = trimmed.trim_start_matches('#').trim_start();
            wrap_plain_into(
                heading,
                width,
                base_style.add_modifier(Modifier::BOLD),
                &mut lines,
                effective_max,
            );
            continue;
        }

        // Blockquote
        if let Some(quoted) = trimmed.strip_prefix("> ") {
            let line_text = format!("│ {quoted}");
            wrap_inline_markdown(
                &line_text,
                width,
                Style::new().fg(Color::DarkGray),
                &mut lines,
                effective_max,
            );
            continue;
        }

        wrap_inline_markdown(raw_line, width, base_style, &mut lines, effective_max);
    }

    if truncated {
        let notice = StyledLine::plain(
            "… ［单条内容超过单页渲染预算，已按块折叠］".to_owned(),
            Style::new().fg(Color::Yellow),
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

    #[test]
    fn markdown_handles_code_diff_bold_and_caps_10mb_single_message() {
        let md = "# 标题\n这是 **加粗** 和 `code`。\n```diff\n+added\n-removed\n@@ -1 +1 @@\n```";
        let rendered = render_markdown_bounded(md, 40, Style::default(), 64);
        assert!(!rendered.truncated);
        assert!(rendered.lines.len() >= 6);
        assert!(rendered.lines.iter().any(|l| {
            l.spans
                .iter()
                .any(|(t, s)| t.contains("+added") && s.fg == Some(Color::Green))
        }));
        assert!(rendered.lines.iter().any(|l| {
            l.spans
                .iter()
                .any(|(t, s)| t.contains("-removed") && s.fg == Some(Color::Red))
        }));

        // 10 MiB single message must finish fast and cap output cleanly.
        let giant = "a".repeat(10 * 1024 * 1024);
        let bounded = render_markdown_bounded(&giant, 80, Style::default(), 120);
        assert!(bounded.truncated);
        assert!(bounded.lines.len() <= 120);
    }
}
