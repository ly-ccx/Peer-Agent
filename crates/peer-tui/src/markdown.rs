//! Bounded block-level Markdown, code-fence syntax highlighting, and diff formatter for Ratatui (ADR 130).
//!
//! Processes sanitized text in bounded byte/line slices so even a 10 MiB single
//! message never constructs a million-line Paragraph or stalls the draw loop.

use crate::{
    bounded_cache::ByteSized,
    table::{TableAlignment, TableBorders, TableSpec, render_table_lines_with_ids},
    terminal_text,
    theme::{
        DARK_PALETTE, HEADING_H1, HEADING_H2, HEADING_H3, LIST_BULLET, QUOTE_PREFIX, TuiPalette,
    },
};
use ratatui::{
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

/// Hard per-message rendering cap to prevent unbounded Paragraph allocations (ADR 130).
pub const MAX_MARKDOWN_INPUT_BYTES: usize = 32 * 1024;
pub const MAX_WRAPPED_LINES_PER_ITEM: usize = 256;
pub const MAX_SCREEN_HYPERLINKS_PER_FRAME: usize = 256;

/// Interactive hyperlink span within a single wrapped [`StyledLine`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LineLink {
    pub col_start: u16,
    pub col_end: u16,
    pub target: String,
    pub id: u32,
}

/// Interactive hyperlink projected into terminal screen coordinates for a single frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ScreenHyperlink {
    pub row: u16,
    pub col_start: u16,
    pub col_end: u16,
    pub target: String,
    pub id: u32,
}

#[derive(Debug, Clone)]
pub(crate) struct InlineSegment {
    pub(crate) text: String,
    pub(crate) style: Style,
    pub(crate) link: Option<(String, u32)>,
}

impl InlineSegment {
    pub(crate) fn plain(text: String, style: Style) -> Self {
        Self {
            text,
            style,
            link: None,
        }
    }

    pub(crate) fn linked(text: String, style: Style, target: String, id: u32) -> Self {
        Self {
            text,
            style,
            link: Some((target, id)),
        }
    }
}

pub(crate) fn alloc_link_id(next_id: &mut u32) -> u32 {
    let id = (*next_id).max(1);
    *next_id = id.wrapping_add(1).max(1);
    id
}

#[derive(Debug, Clone)]
pub struct StyledLine {
    pub spans: Vec<(String, Style)>,
    pub links: Vec<LineLink>,
    pub bytes: usize,
}

impl StyledLine {
    pub fn plain(text: String, style: Style) -> Self {
        let bytes = text.len() + 32;
        Self {
            spans: vec![(text, style)],
            links: Vec::new(),
            bytes,
        }
    }

    pub(crate) fn from_spans_with_links(spans: Vec<(String, Style)>, links: Vec<LineLink>) -> Self {
        let span_bytes: usize = spans.iter().map(|(text, _)| text.len() + 32).sum();
        let link_bytes: usize = links.iter().map(|link| link.target.len() + 24).sum();
        let bytes = (span_bytes + link_bytes).max(32);
        Self {
            spans,
            links,
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

pub(crate) fn push_or_merge_link(
    links: &mut Vec<LineLink>,
    col_start: usize,
    col_end: usize,
    target: &str,
    id: u32,
) -> usize {
    if col_start >= col_end {
        return 0;
    }
    let cs = u16::try_from(col_start).unwrap_or(u16::MAX);
    let ce = u16::try_from(col_end).unwrap_or(u16::MAX);
    if cs >= ce {
        return 0;
    }
    if let Some(last) = links.last_mut()
        && last.id == id
        && last.col_end == cs
        && last.target == target
    {
        last.col_end = ce;
        return 0;
    }
    links.push(LineLink {
        col_start: cs,
        col_end: ce,
        target: target.to_owned(),
        id,
    });
    target.len() + 24
}

fn push_wrapped_segments(
    segments: Vec<InlineSegment>,
    width: usize,
    fill_style: Option<Style>,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let w = width.max(1);
    let pad_target = w.min(240);
    let emit_line = |spans: &mut Vec<(String, Style)>,
                     links: &mut Vec<LineLink>,
                     bytes: &mut usize,
                     col: usize,
                     out: &mut Vec<StyledLine>| {
        if out.len() >= max_lines {
            spans.clear();
            links.clear();
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
            links: std::mem::take(links),
            bytes: (*bytes).max(32),
        });
        *bytes = 0;
    };

    if segments.is_empty() {
        let mut spans = Vec::new();
        let mut links = Vec::new();
        let mut bytes = 0usize;
        emit_line(&mut spans, &mut links, &mut bytes, 0, out);
        return;
    }

    let mut cur_spans: Vec<(String, Style)> = Vec::new();
    let mut cur_links: Vec<LineLink> = Vec::new();
    let mut cur_bytes = 0usize;
    let mut col = 0usize;

    for seg in segments {
        let mut buf = String::new();
        let mut link_col_start = col;
        for grapheme in seg.text.graphemes(true) {
            let glyph = if grapheme == "\t" { "    " } else { grapheme };
            let gw = glyph.width().min(w);
            if col + gw > w && col > 0 {
                if !buf.is_empty() {
                    cur_bytes += buf.len() + 32;
                    cur_spans.push((std::mem::take(&mut buf), seg.style));
                }
                if let Some((ref target, id)) = seg.link {
                    cur_bytes +=
                        push_or_merge_link(&mut cur_links, link_col_start, col, target, id);
                }
                emit_line(&mut cur_spans, &mut cur_links, &mut cur_bytes, col, out);
                col = 0;
                link_col_start = 0;
                if out.len() >= max_lines {
                    return;
                }
            }
            buf.push_str(glyph);
            col += gw;
        }
        if !buf.is_empty() {
            cur_bytes += buf.len() + 32;
            cur_spans.push((buf, seg.style));
        }
        if let Some((ref target, id)) = seg.link {
            cur_bytes += push_or_merge_link(&mut cur_links, link_col_start, col, target, id);
        }
    }
    emit_line(&mut cur_spans, &mut cur_links, &mut cur_bytes, col, out);
}

pub(crate) fn wrap_plain_into(
    text: &str,
    width: usize,
    style: Style,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    push_wrapped_segments(
        vec![InlineSegment::plain(text.to_owned(), style)],
        width,
        None,
        out,
        max_lines,
    );
}

fn starts_with_url_scheme(s: &str) -> Option<usize> {
    let raw = s.as_bytes();
    for prefix in [b"https://".as_slice(), b"http://", b"file://"] {
        if raw.len() > prefix.len() && raw[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return Some(prefix.len());
        }
    }
    None
}

fn starts_with_markdown_scheme(s: &str) -> bool {
    let raw = s.as_bytes();
    for prefix in [b"https://".as_slice(), b"http://", b"file://", b"mailto:"] {
        if raw.len() > prefix.len() && raw[..prefix.len()].eq_ignore_ascii_case(prefix) {
            return true;
        }
    }
    false
}

pub(crate) fn strip_line_col_suffix(s: &str) -> &str {
    let Some((head, tail)) = s.rsplit_once(':') else {
        return s;
    };
    if tail.is_empty() || !tail.bytes().all(|b| b.is_ascii_digit()) {
        return s;
    }
    if let Some((head2, line_part)) = head.rsplit_once(':')
        && !line_part.is_empty()
        && line_part.bytes().all(|b| b.is_ascii_digit())
        && !head2.is_empty()
    {
        return head2;
    }
    if head.is_empty() { s } else { head }
}

fn has_file_extension(segment: &str) -> bool {
    let Some((stem, ext)) = segment.rsplit_once('.') else {
        return false;
    };
    !stem.is_empty()
        && stem != "."
        && !stem.ends_with('.')
        && stem.chars().any(|c| c.is_alphanumeric())
        && (1..=10).contains(&ext.len())
        && ext.bytes().all(|b| b.is_ascii_alphanumeric())
        && ext.bytes().any(|b| b.is_ascii_alphabetic())
}

fn is_known_abs_root(first_segment: &str) -> bool {
    matches!(
        first_segment,
        "Users"
            | "home"
            | "tmp"
            | "var"
            | "etc"
            | "opt"
            | "usr"
            | "Library"
            | "Applications"
            | "Volumes"
            | "System"
            | "bin"
            | "sbin"
            | "dev"
            | "workspace"
            | "workspaces"
            | "root"
            | "mnt"
            | "media"
            | "srv"
            | "private"
    )
}

fn has_disallowed_path_char(ch: char, allow_spaces: bool) -> bool {
    if ch.is_control() {
        return true;
    }
    if ch == ' ' {
        return !allow_spaces;
    }
    if ch.is_whitespace() {
        return true;
    }
    matches!(
        ch,
        '<' | '>'
            | '"'
            | '\''
            | '`'
            | '|'
            | '('
            | ')'
            | '['
            | ']'
            | '{'
            | '}'
            | ';'
            | '?'
            | '*'
            | '!'
            | '&'
            | '$'
            | '（'
            | '）'
            | '「'
            | '」'
            | '『'
            | '』'
            | '【'
            | '】'
            | '。'
            | '，'
            | '；'
            | '：'
            | '、'
            | '？'
            | '！'
    )
}

fn is_likely_file_path(raw: &str, allow_spaces_in_abs: bool) -> bool {
    if raw.is_empty() || raw.len() > 1024 {
        return false;
    }
    let has_spaces = raw.contains(' ');
    if raw
        .chars()
        .any(|c| has_disallowed_path_char(c, allow_spaces_in_abs))
    {
        return false;
    }
    let base = strip_line_col_suffix(raw);
    if base.is_empty() || base.contains("://") || base.starts_with("//") || base.contains("//") {
        return false;
    }

    if let Some(rest) = base.strip_prefix("~/") {
        if rest.is_empty()
            || !rest.chars().any(|c| c.is_alphanumeric())
            || (has_spaces && !rest.rsplit('/').next().is_some_and(has_file_extension))
        {
            return false;
        }
        return true;
    }

    if base.starts_with('/') {
        let segs: Vec<&str> = base.split('/').filter(|p| !p.is_empty()).collect();
        if segs.is_empty() || segs.iter().any(|p| *p == "." || *p == "..") {
            return false;
        }
        let last_is_file = segs.last().is_some_and(|last| has_file_extension(last));
        if has_spaces && !last_is_file {
            return false;
        }
        if segs.len() == 1 {
            return last_is_file;
        }
        return segs[0] == ".well-known"
            || last_is_file
            || (is_known_abs_root(segs[0])
                && segs
                    .iter()
                    .any(|p| p.bytes().any(|b| b.is_ascii_alphabetic())));
    }

    // Relative file path: must contain `/`, an ASCII letter, and a valid `.ext` on the leaf segment.
    if has_spaces || !base.contains('/') || !base.bytes().any(|b| b.is_ascii_alphabetic()) {
        return false;
    }
    let segs: Vec<&str> = base.split('/').collect();
    if segs.iter().any(|p| p.is_empty()) {
        return false;
    }
    segs.last()
        .is_some_and(|last| *last != "." && *last != ".." && has_file_extension(last))
}

fn extract_exact_link_target(candidate: &str) -> Option<String> {
    let trimmed = candidate.trim();
    if trimmed.is_empty() || trimmed.len() > 2048 || trimmed.chars().any(char::is_control) {
        return None;
    }
    if let Some(prefix_len) = starts_with_url_scheme(trimmed) {
        let rest = &trimmed[prefix_len..];
        if !rest.is_empty() && !trimmed.chars().any(char::is_whitespace) {
            return Some(trimmed.to_owned());
        }
        return None;
    }
    if is_likely_file_path(trimmed, true) {
        return Some(trimmed.to_owned());
    }
    None
}

fn is_valid_markdown_link_target(target: &str) -> bool {
    if target.is_empty() || target.len() > 2048 || target.chars().any(char::is_control) {
        return false;
    }
    if starts_with_markdown_scheme(target) {
        return !target.chars().any(char::is_whitespace);
    }
    if target.starts_with('/')
        || target.starts_with("~/")
        || target.starts_with("./")
        || target.starts_with("../")
    {
        return !target.starts_with("//")
            && target
                .trim_start_matches(['~', '.', '/'])
                .chars()
                .any(|c| c.is_alphanumeric());
    }
    !target.chars().any(char::is_whitespace)
        && target.bytes().any(|b| b.is_ascii_alphabetic())
        && (target.contains('/') || has_file_extension(strip_line_col_suffix(target)))
}

fn parse_markdown_link_at(text: &str, start: usize) -> Option<(&str, &str, usize)> {
    let bytes = text.as_bytes();
    if *bytes.get(start)? != b'[' {
        return None;
    }
    let mut j = start + 1;
    let mut in_code = false;
    let mut bracket_depth = 1usize;
    let mut label_end = None;
    while j < bytes.len() {
        match bytes[j] {
            b'\n' | b'\r' => return None,
            b'\\' if !in_code && j + 1 < bytes.len() => {
                let next_len = text[j + 1..].chars().next().map_or(1, char::len_utf8);
                j += 1 + next_len;
                continue;
            }
            b'`' => {
                in_code = !in_code;
                j += 1;
                continue;
            }
            b'[' if !in_code => bracket_depth += 1,
            b']' if !in_code => {
                bracket_depth -= 1;
                if bracket_depth == 0 {
                    label_end = Some(j);
                    break;
                }
            }
            _ => {}
        }
        j += text[j..].chars().next().map_or(1, char::len_utf8);
    }
    let label_end = label_end?;
    if bytes.get(label_end + 1) != Some(&b'(') {
        return None;
    }
    let label = text[start + 1..label_end].trim();
    if label.is_empty() {
        return None;
    }

    let url_start = label_end + 2;
    let mut k = url_start;
    let mut paren_depth = 1usize;
    let mut url_end = None;
    while k < bytes.len() {
        match bytes[k] {
            b'\n' | b'\r' => return None,
            b'\\' if k + 1 < bytes.len() => {
                let next_len = text[k + 1..].chars().next().map_or(1, char::len_utf8);
                k += 1 + next_len;
                continue;
            }
            b'(' => paren_depth += 1,
            b')' => {
                paren_depth -= 1;
                if paren_depth == 0 {
                    url_end = Some(k);
                    break;
                }
            }
            _ => {}
        }
        k += text[k..].chars().next().map_or(1, char::len_utf8);
    }
    let url_end = url_end?;
    let mut raw_target = text[url_start..url_end].trim();
    if raw_target.starts_with('<') && raw_target.ends_with('>') && raw_target.len() >= 2 {
        raw_target = &raw_target[1..raw_target.len() - 1];
    } else if let Some((head, rest)) = raw_target.split_once(char::is_whitespace) {
        let rest_trim = rest.trim_start();
        if rest_trim.starts_with('"') || rest_trim.starts_with('\'') {
            raw_target = head;
        }
    }
    if !is_valid_markdown_link_target(raw_target) {
        return None;
    }
    Some((label, raw_target, url_end + 1))
}

fn is_url_stop_char(ch: char) -> bool {
    ch.is_whitespace()
        || ch.is_control()
        || matches!(
            ch,
            '<' | '>'
                | '"'
                | '\''
                | '`'
                | '（'
                | '）'
                | '「'
                | '」'
                | '『'
                | '』'
                | '【'
                | '】'
                | '。'
                | '，'
                | '；'
                | '：'
                | '、'
        )
}

fn trim_matched_delimiters(mut s: &str) -> &str {
    loop {
        let trimmed = s.trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if trimmed.len() != s.len() {
            s = trimmed;
            continue;
        }
        if let Some(last) = s.chars().next_back()
            && let Some(open) = match last {
                ')' => Some('('),
                ']' => Some('['),
                '}' => Some('{'),
                _ => None,
            }
        {
            let opens = s.chars().filter(|&c| c == open).count();
            let closes = s.chars().filter(|&c| c == last).count();
            if closes > opens {
                s = &s[..s.len() - last.len_utf8()];
                continue;
            }
        }
        break;
    }
    s
}

fn match_autolink_url_at(text: &str, start: usize) -> Option<&str> {
    if start > 0
        && let Some(prev) = text[..start].chars().next_back()
        && (prev.is_ascii_alphanumeric() || matches!(prev, '_' | '/'))
    {
        return None;
    }
    let slice = &text[start..];
    let prefix_len = starts_with_url_scheme(slice)?;
    let mut end = prefix_len;
    for (rel, ch) in slice[prefix_len..].char_indices() {
        if is_url_stop_char(ch) {
            break;
        }
        end = prefix_len + rel + ch.len_utf8();
    }
    let matched = trim_matched_delimiters(&slice[..end]);
    let body = matched.get(prefix_len..)?;
    if body.is_empty() || body.chars().all(|c| c == '/') {
        return None;
    }
    Some(matched)
}

fn is_path_boundary_char(ch: char) -> bool {
    ch.is_whitespace()
        || matches!(
            ch,
            '(' | '['
                | '{'
                | '<'
                | '"'
                | '\''
                | '='
                | ':'
                | ','
                | ';'
                | '（'
                | '「'
                | '『'
                | '【'
                | '、'
                | '，'
                | '：'
                | '；'
                | '。'
        )
}

fn match_autolink_path_at(text: &str, start: usize) -> Option<&str> {
    if start > 0
        && let Some(prev) = text[..start].chars().next_back()
        && !is_path_boundary_char(prev)
    {
        return None;
    }
    let slice = &text[start..];
    let first = slice.chars().next()?;
    if first == '~' && !slice.starts_with("~/") {
        return None;
    }
    if !(first == '/'
        || first == '~'
        || first == '.'
        || first.is_ascii_alphanumeric()
        || first == '_')
    {
        return None;
    }
    let mut end = 0usize;
    for (rel, ch) in slice.char_indices() {
        if has_disallowed_path_char(ch, false) {
            break;
        }
        end = rel + ch.len_utf8();
    }
    if end == 0 {
        return None;
    }
    let mut candidate = slice[..end].trim_end_matches([',', '.', ';', '?', '!', ':']);
    while candidate.ends_with('/') && candidate.len() > 1 {
        candidate = &candidate[..candidate.len() - 1];
    }
    if !is_likely_file_path(candidate, false) {
        return None;
    }
    Some(candidate)
}

fn push_plain_with_autolinks(
    plain: &str,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
    segments: &mut Vec<InlineSegment>,
) {
    if plain.is_empty() {
        return;
    }
    let link_style = base_style
        .fg(palette.link)
        .add_modifier(Modifier::UNDERLINED);
    let mut i = 0usize;
    let mut raw_start = 0usize;
    let bytes = plain.as_bytes();
    while i < bytes.len() {
        if let Some(url) = match_autolink_url_at(plain, i) {
            if i > raw_start {
                segments.push(InlineSegment::plain(
                    plain[raw_start..i].to_owned(),
                    base_style,
                ));
            }
            let id = alloc_link_id(next_link_id);
            segments.push(InlineSegment::linked(
                url.to_owned(),
                link_style,
                url.to_owned(),
                id,
            ));
            i += url.len();
            raw_start = i;
            continue;
        }
        if let Some(path) = match_autolink_path_at(plain, i) {
            if i > raw_start {
                segments.push(InlineSegment::plain(
                    plain[raw_start..i].to_owned(),
                    base_style,
                ));
            }
            let id = alloc_link_id(next_link_id);
            segments.push(InlineSegment::linked(
                path.to_owned(),
                link_style,
                path.to_owned(),
                id,
            ));
            i += path.len();
            raw_start = i;
            continue;
        }
        let ch_len = plain[i..].chars().next().map_or(1, char::len_utf8);
        i += ch_len;
    }
    if raw_start < bytes.len() {
        segments.push(InlineSegment::plain(
            plain[raw_start..].to_owned(),
            base_style,
        ));
    }
}

/// Format inline `[label](url)`, URLs, paths, `**bold**`, `~~strike~~`, and `` `code` `` spans within one unwrapped text line.
pub(crate) fn tokenize_inline_markdown(
    text: &str,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
    segments: &mut Vec<InlineSegment>,
) {
    let bytes = text.as_bytes();
    let mut i = 0usize;
    let mut plain_start = 0usize;
    let code_style = base_style.fg(palette.code).bg(palette.code_bg);
    let link_style = base_style
        .fg(palette.link)
        .add_modifier(Modifier::UNDERLINED);
    while i < bytes.len() {
        if bytes[i] == b'`'
            && let Some(end_rel) = text[i + 1..].find('`')
            && end_rel > 0
        {
            if i > plain_start {
                push_plain_with_autolinks(
                    &text[plain_start..i],
                    base_style,
                    palette,
                    next_link_id,
                    segments,
                );
            }
            let code_end = i + 1 + end_rel;
            let inner = &text[i + 1..code_end];
            if let Some(target) = extract_exact_link_target(inner) {
                let id = alloc_link_id(next_link_id);
                segments.push(InlineSegment::linked(
                    inner.to_owned(),
                    code_style.add_modifier(Modifier::UNDERLINED),
                    target,
                    id,
                ));
            } else {
                segments.push(InlineSegment::plain(inner.to_owned(), code_style));
            }
            i = code_end + 1;
            plain_start = i;
            continue;
        }
        if bytes[i] == b'['
            && let Some((label, target, link_end)) = parse_markdown_link_at(text, i)
        {
            if i > plain_start {
                push_plain_with_autolinks(
                    &text[plain_start..i],
                    base_style,
                    palette,
                    next_link_id,
                    segments,
                );
            }
            let id = alloc_link_id(next_link_id);
            if label.starts_with('`')
                && label.ends_with('`')
                && label.len() >= 3
                && !label[1..label.len() - 1].contains('`')
            {
                let code_label = &label[1..label.len() - 1];
                segments.push(InlineSegment::linked(
                    code_label.to_owned(),
                    code_style.add_modifier(Modifier::UNDERLINED),
                    target.to_owned(),
                    id,
                ));
            } else {
                segments.push(InlineSegment::linked(
                    label.to_owned(),
                    link_style,
                    target.to_owned(),
                    id,
                ));
            }
            i = link_end;
            plain_start = i;
            continue;
        }
        if bytes[i..].starts_with(b"**")
            && let Some(end_rel) = text[i + 2..].find("**")
            && end_rel > 0
        {
            if i > plain_start {
                push_plain_with_autolinks(
                    &text[plain_start..i],
                    base_style,
                    palette,
                    next_link_id,
                    segments,
                );
            }
            let bold_end = i + 2 + end_rel;
            push_plain_with_autolinks(
                &text[i + 2..bold_end],
                base_style.add_modifier(Modifier::BOLD),
                palette,
                next_link_id,
                segments,
            );
            i = bold_end + 2;
            plain_start = i;
            continue;
        }
        if bytes[i..].starts_with(b"~~")
            && let Some(end_rel) = text[i + 2..].find("~~")
            && end_rel > 0
        {
            if i > plain_start {
                push_plain_with_autolinks(
                    &text[plain_start..i],
                    base_style,
                    palette,
                    next_link_id,
                    segments,
                );
            }
            let strike_end = i + 2 + end_rel;
            segments.push(InlineSegment::plain(
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
        push_plain_with_autolinks(
            &text[plain_start..],
            base_style,
            palette,
            next_link_id,
            segments,
        );
    }
}

pub(crate) fn wrap_inline_markdown_with_ids(
    text: &str,
    width: usize,
    base_style: Style,
    palette: &TuiPalette,
    next_link_id: &mut u32,
    out: &mut Vec<StyledLine>,
    max_lines: usize,
) {
    let mut segments = Vec::new();
    tokenize_inline_markdown(text, base_style, palette, next_link_id, &mut segments);
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
    let mut next_link_id: u32 = 1;
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
                    vec![InlineSegment::plain(
                        format!("  {raw_line}"),
                        Style::new().fg(diff_fg).bg(palette.code_bg),
                    )],
                    width,
                    Some(code_bg_style),
                    &mut lines,
                    effective_max,
                );
            } else {
                let segs = highlight_code_line(raw_line, &fence_lang, palette)
                    .into_iter()
                    .map(|(t, s)| InlineSegment::plain(t, s))
                    .collect();
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
                if render_table_lines_with_ids(
                    &spec,
                    width.max(1),
                    base_style,
                    palette,
                    &mut next_link_id,
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
            let mut segs = vec![InlineSegment::plain(
                HEADING_H3.to_owned(),
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            tokenize_inline_markdown(
                h3.trim_start(),
                base_style.fg(palette.text).add_modifier(Modifier::BOLD),
                palette,
                &mut next_link_id,
                &mut segs,
            );
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }
        if let Some(h2) = trimmed.strip_prefix("## ") {
            let mut segs = vec![InlineSegment::plain(
                HEADING_H2.to_owned(),
                Style::new()
                    .fg(palette.info)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            tokenize_inline_markdown(
                h2.trim_start(),
                base_style.fg(palette.info).add_modifier(Modifier::BOLD),
                palette,
                &mut next_link_id,
                &mut segs,
            );
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }
        if let Some(h1) = trimmed.strip_prefix("# ") {
            let mut segs = vec![InlineSegment::plain(
                HEADING_H1.to_owned(),
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            tokenize_inline_markdown(
                h1.trim_start(),
                base_style.fg(palette.accent).add_modifier(Modifier::BOLD),
                palette,
                &mut next_link_id,
                &mut segs,
            );
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }

        // Blockquote
        if let Some(quoted) = trimmed.strip_prefix("> ") {
            let mut segs = vec![InlineSegment::plain(
                QUOTE_PREFIX.to_owned(),
                Style::new().fg(palette.border_focus).bg(palette.background),
            )];
            tokenize_inline_markdown(
                quoted,
                base_style.fg(palette.text_soft),
                palette,
                &mut next_link_id,
                &mut segs,
            );
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
                InlineSegment::plain(indent, base_style),
                InlineSegment::plain(
                    LIST_BULLET.to_owned(),
                    Style::new().fg(palette.accent).bg(palette.background),
                ),
            ];
            tokenize_inline_markdown(
                bullet_body,
                base_style,
                palette,
                &mut next_link_id,
                &mut segs,
            );
            push_wrapped_segments(segs, width, None, &mut lines, effective_max);
            line_idx += 1;
            continue;
        }

        wrap_inline_markdown_with_ids(
            raw_line,
            width,
            base_style,
            palette,
            &mut next_link_id,
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

pub(crate) fn stamp_screen_link_id(block_prefix: u32, local_id: u32) -> u32 {
    let hi = (block_prefix & 0x000f_ffff).max(1);
    let lo = (local_id & 0x0fff).max(1);
    (hi << 12) | lo
}

pub(crate) fn project_line_links(
    links: &[LineLink],
    area: Rect,
    vis_row: usize,
    out_links: &mut Vec<ScreenHyperlink>,
) {
    if links.is_empty() || out_links.len() >= MAX_SCREEN_HYPERLINKS_PER_FRAME {
        return;
    }
    let Some(rel_y) = u16::try_from(vis_row).ok() else {
        return;
    };
    if rel_y >= area.height {
        return;
    }
    let row = area.y.saturating_add(rel_y);
    let max_x = area.x.saturating_add(area.width);
    for link in links {
        if out_links.len() >= MAX_SCREEN_HYPERLINKS_PER_FRAME {
            break;
        }
        if link.col_start >= area.width {
            continue;
        }
        let col_start = area.x.saturating_add(link.col_start);
        let col_end = area.x.saturating_add(link.col_end).min(max_x);
        if col_start < col_end {
            out_links.push(ScreenHyperlink {
                row,
                col_start,
                col_end,
                target: link.target.clone(),
                id: link.id,
            });
        }
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
    fn markdown_extracts_clickable_links_for_inline_paths_markdown_urls_and_skips_noise() {
        // 1. Long inline code file path wraps across lines while sharing a single link id
        let adr_path = "/Users/yinliang/Documents/Develop/peer-dev/Peer-Knowledge/knowledge/decisions/133-unified-rust-core-and-dual-host-architecture.md";
        let wrapped = render_markdown_themed(
            &format!("见 `{adr_path}` （状态 Accepted）"),
            40,
            Style::new().fg(DARK_PALETTE.text),
            16,
            &DARK_PALETTE,
        );
        let adr_links: Vec<&LineLink> = wrapped
            .lines
            .iter()
            .flat_map(|l| l.links.iter())
            .filter(|link| link.target == adr_path)
            .collect();
        assert!(
            adr_links.len() >= 2,
            "expected wrapped segments across >=2 lines"
        );
        let shared_id = adr_links[0].id;
        assert!(shared_id > 0);
        for link in &adr_links {
            assert_eq!(link.id, shared_id);
        }
        let rejoined: String = wrapped
            .lines
            .iter()
            .flat_map(|line| {
                line.links
                    .iter()
                    .filter(|l| l.target == adr_path)
                    .map(|l| slice_display_cols(line, l.col_start, l.col_end))
            })
            .collect();
        assert_eq!(rejoined, adr_path);
        // Inline code path keeps code foreground while adding UNDERLINED
        assert!(wrapped.lines.iter().any(|l| {
            l.spans.iter().any(|(t, s)| {
                t.contains("/Users/")
                    && s.fg == Some(DARK_PALETTE.code)
                    && s.bg == Some(DARK_PALETTE.code_bg)
                    && s.add_modifier.contains(Modifier::UNDERLINED)
            })
        }));

        // 2. Markdown links (including balanced parens & code labels) + bare URLs + relative `:line` paths
        let rich_md = "参考 [ADR 133](file:///Users/foo/133.md) · [Wiki](https://en.wikipedia.org/wiki/Rust_(programming_language)) · [`table.rs`](crates/peer-tui/src/table.rs:640) · 文档 (https://example.com/guide). 源码 crates/peer-tui/src/lib.rs:42";
        let rich = render_markdown_themed(
            rich_md,
            160,
            Style::new().fg(DARK_PALETTE.text),
            16,
            &DARK_PALETTE,
        );
        assert_eq!(rich.lines.len(), 1);
        let links = &rich.lines[0].links;
        assert_eq!(links.len(), 5);
        assert_eq!(links[0].target, "file:///Users/foo/133.md");
        assert_eq!(
            slice_display_cols(&rich.lines[0], links[0].col_start, links[0].col_end),
            "ADR 133"
        );
        assert_eq!(
            links[1].target,
            "https://en.wikipedia.org/wiki/Rust_(programming_language)"
        );
        assert_eq!(
            slice_display_cols(&rich.lines[0], links[1].col_start, links[1].col_end),
            "Wiki"
        );
        assert_eq!(links[2].target, "crates/peer-tui/src/table.rs:640");
        assert_eq!(
            slice_display_cols(&rich.lines[0], links[2].col_start, links[2].col_end),
            "table.rs"
        );
        assert_eq!(links[3].target, "https://example.com/guide");
        assert_eq!(
            slice_display_cols(&rich.lines[0], links[3].col_start, links[3].col_end),
            "https://example.com/guide"
        );
        assert_eq!(links[4].target, "crates/peer-tui/src/lib.rs:42");

        // 3. Slash commands, git branches, API paths, ratios, and CJK parenthetical prose never become links
        let noise_md = "运行 /help 或 /classic 查看 `codex/native-rust-cli` 与 `origin/main` 和 `/v1/chat/completions`，比例 2/3，[1](备注)";
        let noise = render_markdown_themed(
            noise_md,
            120,
            Style::new().fg(DARK_PALETTE.text),
            16,
            &DARK_PALETTE,
        );
        assert!(noise.lines.iter().all(|l| l.links.is_empty()));
    }
}
