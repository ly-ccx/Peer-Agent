//! Detection, stripping, and neutralization of literal / leaked model tool-call markup
//! (DeepSeek DSML `<｜DSML｜ calls>`, `<|DSML|...>`, XML `<tool_call>`, `<function_calls>`,
//! `<antml:...>`, `<invoke>`, `<parameter>`, `<functions.xxx>`).

use regex::Regex;
use std::sync::LazyLock;

static DSML_CALLS_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:<|&lt;)\s*[｜|]\s*DSML\s*[｜|]\s*(?:function_)?calls(?:[^a-zA-Z0-9_]|$)[\s\S]*?(?:(?:<|&lt;)\s*/\s*[｜|]\s*DSML\s*[｜|]\s*(?:function_)?calls\s*(?:>|&gt;)|$)",
    )
    .expect("dsml calls block regex")
});

static DSML_INVOKE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:<|&lt;)\s*[｜|]\s*DSML\s*[｜|]\s*invoke(?:[^a-zA-Z0-9_]|$)[\s\S]*?(?:(?:<|&lt;)\s*/\s*[｜|]\s*DSML\s*[｜|]\s*invoke\s*(?:>|&gt;)|$)",
    )
    .expect("dsml invoke block regex")
});

static DSML_STRAY_TAG_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?is)(?:<|&lt;)\s*/?\s*[｜|]\s*DSML\s*[｜|][^>\n]*(?:>|&gt;|$)")
        .expect("dsml stray tag regex")
});

static XML_TOOL_CALL_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:<|&lt;)\s*(?:antml:)?tool_call(?:[^a-zA-Z0-9_>][^>\n]*)?(?:>|&gt;)[\s\S]*?(?:(?:<|&lt;)\s*/\s*(?:antml:)?tool_call\s*(?:>|&gt;)|$)",
    )
    .expect("xml tool_call block regex")
});

static XML_FUNCTION_CALLS_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:<|&lt;)\s*(?:antml:)?function_calls\s*(?:>|&gt;)[\s\S]*?(?:(?:<|&lt;)\s*/\s*(?:antml:)?function_calls\s*(?:>|&gt;)|$)",
    )
    .expect("xml function_calls block regex")
});

static XML_INVOKE_BLOCK_RE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?is)(?:<|&lt;)\s*(?:antml:)?invoke(?:[^a-zA-Z0-9_]|$)[\s\S]*?(?:(?:<|&lt;)\s*/\s*(?:antml:)?invoke\s*(?:>|&gt;)|$)",
    )
    .expect("xml invoke block regex")
});

static MULTI_NEWLINE_RE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"\n{3,}").expect("multi newline regex"));

fn contains_angle_or_escaped_lt(text: &str) -> bool {
    text.contains('<')
        || text
            .as_bytes()
            .windows(4)
            .any(|w| w.eq_ignore_ascii_case(b"&lt;"))
}

fn is_dsml_tag_body(after_open: &str) -> bool {
    let trimmed = after_open.trim_start();
    let after_slash = trimmed
        .strip_prefix('/')
        .map(str::trim_start)
        .unwrap_or(trimmed);
    let rest = if let Some(r) = after_slash.strip_prefix('｜') {
        r
    } else if let Some(r) = after_slash.strip_prefix('|') {
        r
    } else {
        return false;
    };
    let rest = rest.trim_start();
    let Some(dsml) = rest.as_bytes().get(..4) else {
        return false;
    };
    if !dsml.eq_ignore_ascii_case(b"dsml") {
        return false;
    }
    let after_dsml = rest[4..].trim_start();
    after_dsml.starts_with('｜') || after_dsml.starts_with('|')
}

fn is_xml_or_function_tag_body(after_open: &str) -> bool {
    let tag = after_open.strip_prefix('/').unwrap_or(after_open);
    let namespaced = tag
        .as_bytes()
        .get(..6)
        .is_some_and(|p| p.eq_ignore_ascii_case(b"antml:"));
    let tag = if namespaced { &tag[6..] } else { tag };
    let bytes = tag.as_bytes();
    let named = ["tool_call", "function_calls", "invoke", "parameter"]
        .iter()
        .any(|name| {
            bytes
                .get(..name.len())
                .is_some_and(|p| p.eq_ignore_ascii_case(name.as_bytes()))
                && bytes
                    .get(name.len())
                    .is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'_')
        });
    if named {
        return true;
    }
    !namespaced
        && bytes
            .get(..10)
            .is_some_and(|p| p.eq_ignore_ascii_case(b"functions."))
        && bytes[10..]
            .iter()
            .copied()
            .take_while(|b| b.is_ascii_alphanumeric() || *b == b'_' || *b == b'.' || *b == b'-')
            .any(|b| b.is_ascii_alphanumeric() || b == b'_')
}

fn matches_literal_tool_call_tag(after_open: &str) -> bool {
    is_dsml_tag_body(after_open) || is_xml_or_function_tag_body(after_open)
}

/// Returns true if `text` contains literal model tool-call protocol markup
/// (DSML, `<tool_call>`, `<function_calls>`, `<antml:...>`, `<invoke>`, `<parameter>`, `<functions.xxx>`).
pub fn has_literal_tool_call_syntax(text: &str) -> bool {
    if !contains_angle_or_escaped_lt(text) {
        return false;
    }
    let bytes = text.as_bytes();
    for (idx, b) in bytes.iter().enumerate() {
        if *b == b'<' && matches_literal_tool_call_tag(&text[idx + 1..]) {
            return true;
        }
        if *b == b'&'
            && bytes
                .get(idx..idx + 4)
                .is_some_and(|w| w.eq_ignore_ascii_case(b"&lt;"))
            && matches_literal_tool_call_tag(&text[idx + 4..])
        {
            return true;
        }
    }
    false
}

/// Returns true if `text` already contains literal tool-call syntax or ends with
/// an unclosed `<...` prefix that could grow into a tool-call tag during streaming.
pub fn has_partial_tool_call_prefix(text: &str) -> bool {
    if has_literal_tool_call_syntax(text) {
        return true;
    }
    let Some(idx) = text.rfind('<') else {
        return false;
    };
    let tail = &text[idx..];
    if tail.contains('>') || tail.len() > 32 {
        return false;
    }
    let trimmed = tail[1..].trim_start();
    let after_slash = trimmed
        .strip_prefix('/')
        .map(str::trim_start)
        .unwrap_or(trimmed);
    let inner = after_slash.to_ascii_lowercase();
    if inner.is_empty() {
        return true;
    }
    if [
        "tool_call",
        "function_calls",
        "antml:tool_call",
        "antml:function_calls",
        "antml:invoke",
        "antml:parameter",
        "invoke",
        "parameter",
        "functions.",
    ]
    .iter()
    .any(|prefix| prefix.starts_with(&inner))
    {
        return true;
    }
    if inner.starts_with('｜') || inner.starts_with('|') {
        let compact: String = inner
            .chars()
            .skip(1)
            .filter(|c| !c.is_whitespace())
            .collect();
        return "dsml｜".starts_with(&compact) || "dsml|".starts_with(&compact);
    }
    false
}

/// Strips complete and dangling literal tool-call protocol blocks (DSML / XML),
/// collapsing excess blank lines and trimming surrounding whitespace while keeping genuine prose.
pub fn strip_literal_tool_call_blocks(text: &str) -> String {
    if !has_literal_tool_call_syntax(text) {
        return text.to_owned();
    }
    let s = DSML_CALLS_BLOCK_RE.replace_all(text, "");
    let s = DSML_INVOKE_BLOCK_RE.replace_all(&s, "");
    let s = DSML_STRAY_TAG_RE.replace_all(&s, "");
    let s = XML_TOOL_CALL_BLOCK_RE.replace_all(&s, "");
    let s = XML_FUNCTION_CALLS_BLOCK_RE.replace_all(&s, "");
    let s = XML_INVOKE_BLOCK_RE.replace_all(&s, "");
    MULTI_NEWLINE_RE.replace_all(&s, "\n\n").trim().to_owned()
}

/// Neutralizes unescaped `<` prefixes on literal tool-call tags (`<tag` -> `&lt;tag`)
/// so history / continuity context cannot act as few-shot tool-call examples.
pub fn neutralize_tool_call_syntax(text: &str) -> String {
    if !text.contains('<') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(i) = rest.find('<') {
        out.push_str(&rest[..i]);
        rest = &rest[i + 1..];
        out.push_str(if matches_literal_tool_call_tag(rest) {
            "&lt;"
        } else {
            "<"
        });
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCREENSHOT_DSML: &str = "\n\n<｜DSML｜ calls>\n<｜DSML｜ invoke name=\"read_file\">\n<｜DSML｜ parameter name=\"end_line\" string=\"false\">161</｜DSML｜ parameter>\n<｜DSML｜ parameter name=\"path\" string=\"true\">Peer-Agent/apps/desktop/renderer/src/app/components/provider-settings.css</｜DSML｜ parameter>\n<｜DSML｜ parameter name=\"start_line\" string=\"false\">111</｜DSML｜ parameter>\n</｜DSML｜ invoke>\n</｜DSML｜ calls>";

    #[test]
    fn detects_dsml_and_xml_tool_call_variants() {
        assert!(has_literal_tool_call_syntax(SCREENSHOT_DSML));
        assert!(has_literal_tool_call_syntax("<|DSML|function_calls>"));
        assert!(has_literal_tool_call_syntax(
            "<｜DSML｜ parameter name=\"q\" string=\"true\">x</｜DSML｜ parameter>"
        ));
        assert!(has_literal_tool_call_syntax("&lt;｜DSML｜ calls&gt;"));
        assert!(has_literal_tool_call_syntax(
            "<tool_call>{\"name\":\"ls\"}</tool_call>"
        ));
        assert!(has_literal_tool_call_syntax(
            "<antml:invoke name=\"read_file\">"
        ));
        assert!(has_literal_tool_call_syntax("<function_calls><invoke>"));
        assert!(has_literal_tool_call_syntax("<functions.bash />"));
    }

    #[test]
    fn leaves_normal_prose_html_and_math_untouched() {
        let prose = "Compare a < b and render <div class=\"box\">ok</div> with `<span>x</span>`.";
        assert!(!has_literal_tool_call_syntax(prose));
        assert_eq!(strip_literal_tool_call_blocks(prose), prose);
        assert_eq!(neutralize_tool_call_syntax(prose), prose);
    }

    #[test]
    fn detects_partial_streaming_prefixes_without_false_positives() {
        assert!(has_partial_tool_call_prefix("Hello <"));
        assert!(has_partial_tool_call_prefix("Hello <｜DS"));
        assert!(has_partial_tool_call_prefix("Hello <|DSML"));
        assert!(has_partial_tool_call_prefix("<antml:invo"));
        assert!(has_partial_tool_call_prefix("<tool_cal"));
        assert!(has_partial_tool_call_prefix("Done\n<｜DSML｜ calls>"));
        assert!(!has_partial_tool_call_prefix("a < b"));
        assert!(!has_partial_tool_call_prefix("<div class=\"x\">"));
        assert!(!has_partial_tool_call_prefix(
            "normal text without brackets"
        ));
    }

    #[test]
    fn strips_dsml_and_preserves_mixed_prose() {
        assert_eq!(strip_literal_tool_call_blocks(SCREENSHOT_DSML), "");

        let mixed = format!("已检查完前半部分，接下来继续看样式文件。{SCREENSHOT_DSML}");
        assert_eq!(
            strip_literal_tool_call_blocks(&mixed),
            "已检查完前半部分，接下来继续看样式文件。"
        );

        let dangling = "Summary text.\n\n<|DSML|function_calls>\n<|DSML|invoke name=\"bash\">";
        assert_eq!(strip_literal_tool_call_blocks(dangling), "Summary text.");

        let xml_mixed = "Before\n<tool_call>{\"name\":\"bash\"}</tool_call>\n\n\nAfter";
        assert_eq!(strip_literal_tool_call_blocks(xml_mixed), "Before\n\nAfter");
    }

    #[test]
    fn neutralizes_dsml_and_xml_tags_idempotently() {
        let mixed = format!("Note:\n{SCREENSHOT_DSML}\nAnd <invoke name=\"x\"> and <div/>");
        let once = neutralize_tool_call_syntax(&mixed);
        assert!(!once.contains("<｜DSML｜"));
        assert!(once.contains("&lt;｜DSML｜ calls>"));
        assert!(once.contains("&lt;invoke name=\"x\">"));
        assert!(once.contains("<div/>"));
        assert_eq!(neutralize_tool_call_syntax(&once), once);
    }
}
