//! Transient, bounded projection of the root `post_reply.text`, not tool admission.
use serde::Deserialize;
use serde::de::IgnoredAny;

pub(super) const REPLY_TOOL: &str = "post_reply";
const MAX_ARGUMENT_BYTES: usize = 128_000;

// Return bounded raw text, not a display prefix. The activity projector must
// redact the entire draft before applying its UTF-16 display limit.

pub(super) fn from_json(mut json: &str) -> Option<String> {
    if json.len() > MAX_ARGUMENT_BYTES {
        return None;
    }
    json = whitespace(json).strip_prefix('{')?;
    loop {
        json = whitespace(json);
        let key_end = string_end(json)?;
        let key: String = serde_json::from_str(&json[..key_end]).ok()?;
        json = whitespace(whitespace(&json[key_end..]).strip_prefix(':')?);
        if key == "text" {
            return string_prefix(json);
        }
        // Consume an entire non-text value (including nested keys/strings) before
        // looking for another root member. A partial value isn't a reply.
        let mut value = serde_json::Deserializer::from_str(json).into_iter::<IgnoredAny>();
        value.next()?.ok()?;
        json = whitespace(&json[value.byte_offset()..]).strip_prefix(',')?;
    }
}

pub(super) fn from_text(text: &str) -> Option<String> {
    (text.len() <= MAX_ARGUMENT_BYTES).then(|| text.to_owned())
}

fn whitespace(s: &str) -> &str {
    s.trim_start_matches([' ', '\t', '\r', '\n'])
}

fn string_end(s: &str) -> Option<usize> {
    let mut escaped = false;
    for (i, b) in s.strip_prefix('"')?.bytes().enumerate() {
        if b == b'"' && !escaped {
            return Some(i + 2);
        }
        escaped = !escaped && b == b'\\';
    }
    None
}

fn string_prefix(json: &str) -> Option<String> {
    let body = json.strip_prefix('"')?;
    let mut chars = body.char_indices();
    let mut text = String::new();
    while let Some((start, c)) = chars.next() {
        let c = match c {
            '"' => break,
            '\\' => {
                let Some((_, escape)) = chars.next() else {
                    break;
                };
                if escape == 'u' {
                    let mut code = 0;
                    for _ in 0..4 {
                        let Some((_, digit)) = chars.next() else {
                            return Some(text);
                        };
                        code = code * 16 + digit.to_digit(16)?;
                    }
                    if (0xd800..=0xdbff).contains(&code) {
                        for expected in ['\\', 'u'] {
                            let Some((_, c)) = chars.next() else {
                                return Some(text);
                            };
                            if c != expected {
                                return None;
                            }
                        }
                        for _ in 0..4 {
                            let Some((_, digit)) = chars.next() else {
                                return Some(text);
                            };
                            digit.to_digit(16)?;
                        }
                    }
                }
                let end = chars.clone().next().map_or(body.len(), |(i, _)| i);
                // Delegate decoding and surrogate-pair validation to the JSON parser.
                let quoted = format!("\"{}\"", &body[start..end]);
                let mut decoder = serde_json::Deserializer::from_str(&quoted);
                String::deserialize(&mut decoder).ok()?.chars().next()?
            }
            '\u{0}'..='\u{1f}' => return None,
            c => c,
        };
        text.push(c);
    }
    Some(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_root_string_is_projected_and_partial_escapes_stay_hidden() {
        let json = r#"{"nested":{"text":"private"},"token":"credential","text":"开\n\"\uD83D\uDE80😀 fin","tail":"private"}"#;
        let expected = "开\n\"🚀😀 fin";
        for (end, _) in json.char_indices() {
            if let Some(prefix) = from_json(&json[..end]) {
                assert!(expected.starts_with(&prefix), "{prefix:?}");
            }
        }
        assert_eq!(from_json(json).as_deref(), Some(expected));
        assert_eq!(from_json(r#"{"text":"开\uD83D\uDE"#).as_deref(), Some("开"));
        for json in [
            r#"[{"text":"secret"}]"#,
            r#"{"text":{"text":"secret"}}"#,
            r#"{"content":"text", "token":"secret"}"#,
            r#"{"text":"bad\q"#,
        ] {
            assert_eq!(from_json(json), None);
        }
    }

    #[test]
    fn raw_draft_is_bounded_but_not_clipped_at_the_display_limit() {
        let text = format!("{}😀 AKIA0123456789ABCDEF", "a".repeat(1999));
        assert_eq!(from_text(&text).as_deref(), Some(text.as_str()));
        assert_eq!(
            from_json(&serde_json::json!({"text":text}).to_string()).as_deref(),
            Some(text.as_str())
        );
        let oversized = "中".repeat(MAX_ARGUMENT_BYTES / 3 + 1);
        assert!(from_text(&oversized).is_none());
        assert!(from_json(&serde_json::json!({"text":oversized}).to_string()).is_none());
    }
}
