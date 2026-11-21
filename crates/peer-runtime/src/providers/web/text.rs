//! Literal legacy extraction semantics; web content never becomes instructions.
use regex::Regex;
use std::{borrow::Cow, sync::OnceLock};
const WS: &str = r"[\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
fn regex(pattern: &str) -> Regex {
    regex::RegexBuilder::new(pattern)
        .size_limit(128 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .expect("fixed web pattern")
}
fn apply(text: &mut String, re: &Regex, to: &str) {
    if let Cow::Owned(next) = re.replace_all(text, to) {
        *text = next;
    }
}
fn entities(mut text: String, cancel: &impl Fn() -> bool) -> Result<String, &'static str> {
    static FIXED: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    for (re, to) in FIXED.get_or_init(|| {
        [
            ("(?i-u:&nbsp;)", " "),
            ("(?i-u:&amp;)", "&"),
            ("(?i-u:&lt;)", "<"),
            ("(?i-u:&gt;)", ">"),
            ("(?i-u:&quot;)", "\""),
            ("(?i-u:&#39;|&apos;)", "'"),
        ]
        .into_iter()
        .map(|(p, r)| (regex(p), r))
        .collect()
    }) {
        if cancel() {
            return Err("CANCELLED");
        }
        apply(&mut text, re, to);
    }
    static NUMERIC: OnceLock<Regex> = OnceLock::new();
    let mut invalid = false;
    if let Cow::Owned(next) = NUMERIC.get_or_init(|| regex(r"&#([0-9]+);")).replace_all(
        &text,
        |caps: &regex::Captures<'_>| {
            if cancel() {
                invalid = true;
                return String::new();
            }
            match caps[1].parse::<u32>().ok().and_then(char::from_u32) {
                Some(c) => c.to_string(),
                None => {
                    invalid = true;
                    String::new()
                }
            }
        },
    ) {
        text = next;
    }
    if cancel() {
        return Err("CANCELLED");
    }
    if invalid {
        return Err("web_content_invalid");
    }
    Ok(text)
}
pub(super) struct Text {
    pub title: String,
    pub content: String,
    pub source_units: usize,
    pub truncated: bool,
}
pub(super) fn prefix(text: &str, limit: usize) -> (&str, bool) {
    let mut units = 0;
    let mut end = 0;
    for (cpos, c) in text.char_indices() {
        if units + c.len_utf16() > limit {
            break;
        }
        units += c.len_utf16();
        end = cpos + c.len_utf8();
    }
    (&text[..end], end < text.len())
}
pub(super) fn normalize(
    raw: String,
    mime: &str,
    cancel: &impl Fn() -> bool,
) -> Result<Text, &'static str> {
    if cancel() {
        return Err("CANCELLED");
    }
    static DETECT: OnceLock<Regex> = OnceLock::new();
    let html = mime.to_ascii_lowercase().contains("text/html")
        || DETECT
            .get_or_init(|| regex(r"(?i-u:<html|<body|<title)"))
            .is_match(&raw);
    let mut title = String::new();
    if html {
        static TITLE: OnceLock<Regex> = OnceLock::new();
        if let Some(c) = TITLE
            .get_or_init(|| regex(r"(?i-u:<title\b)[^>]*>(?s:(.*?))(?i-u:</title>)"))
            .captures(&raw)
        {
            if c[1].len() > 65536 {
                return Err("web_content_limit");
            }
            title = c[1].to_owned();
            static SPACE: OnceLock<Regex> = OnceLock::new();
            apply(
                &mut title,
                SPACE.get_or_init(|| regex(&format!("{WS}+"))),
                " ",
            );
            title = entities(peer_protocol::javascript_trim(&title).into(), cancel)?;
        }
    }
    let mut content = raw;
    if html {
        static STRIP: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
        for (re, to) in STRIP.get_or_init(|| {
            let mut v: Vec<_> = ["script", "style", "noscript"]
                .into_iter()
                .map(|tag| {
                    (
                        regex(&format!(r"(?i-u:<{tag}\b)[^>]*>(?s:.*?)(?i-u:</{tag}>)")),
                        " ",
                    )
                })
                .collect();
            v.push((regex(&format!(r"(?i-u:<br){WS}*/?{WS}*>")), "\n"));
            for tag in ["p", "div", "li"] {
                v.push((regex(&format!(r"(?i-u:</{tag}){WS}*>")), "\n"));
            }
            v.push((regex(r"<[^>]+>"), " "));
            v
        }) {
            if cancel() {
                return Err("CANCELLED");
            }
            apply(&mut content, re, to);
        }
        content = entities(content, cancel)?;
        static CLEAN: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
        for (re, to) in CLEAN.get_or_init(|| {
            vec![
                (regex(r"[ \t]+"), " "),
                (regex(&format!(r"{WS}*\n{WS}*")), "\n"),
                (regex(r"\n{3,}"), "\n\n"),
            ]
        }) {
            if cancel() {
                return Err("CANCELLED");
            }
            apply(&mut content, re, to);
        }
        content = peer_protocol::javascript_trim(&content).to_owned();
    }
    let source_units = content.encode_utf16().count();
    let (selected, truncated) = prefix(&content, 2_000_000);
    let end = selected.len();
    content.truncate(end);
    content.shrink_to_fit();
    if title.len() > 65536 {
        return Err("web_content_limit");
    }
    Ok(Text {
        title,
        content,
        source_units,
        truncated,
    })
}
pub(super) fn protect(
    text: &str,
    patterns: &[String],
    limit: usize,
) -> Result<(String, bool), &'static str> {
    if patterns.is_empty() {
        if text.len() > limit {
            return Err("web_redaction_limit");
        }
        return Ok((text.into(), false));
    }
    let matcher = aho_corasick::AhoCorasick::builder()
        .kind(Some(aho_corasick::AhoCorasickKind::ContiguousNFA))
        .match_kind(aho_corasick::MatchKind::LeftmostLongest)
        .build(patterns.iter().filter(|s| !s.is_empty()))
        .map_err(|_| "web_redaction_limit")?;
    let mut result = String::new();
    let mut cursor = 0;
    let mut changed = false;
    let mut append = |part: &str| {
        if result.len().saturating_add(part.len()) > limit {
            Err("web_redaction_limit")
        } else {
            result.push_str(part);
            Ok(())
        }
    };
    for hit in matcher.find_iter(text) {
        append(&text[cursor..hit.start()])?;
        append("[REDACTED]")?;
        cursor = hit.end();
        changed = true;
    }
    append(&text[cursor..])?;
    Ok((result, changed))
}
