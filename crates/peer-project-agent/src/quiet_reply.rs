//! The Project Agent's terminal quiet marker and its streaming projection.

pub const QUIET_REPLY_MARKER: &str = "NO_REPLY";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QuietReplyParse {
    pub is_quiet: bool,
    pub leading_text: String,
    pub is_pure_quiet: bool,
}

const MARKUP: [char; 3] = ['`', '*', '_'];
const SUFFIX: [char; 5] = ['`', '*', '_', '.', '!'];

fn terminal_word(text: &str, separator: impl Fn(char) -> bool) -> (&str, &str) {
    let start = text.rfind(separator).map_or(0, |index| {
        index + text[index..].chars().next().map_or(0, char::len_utf8)
    });
    text.split_at(start)
}

fn is_inline_reference(before: &str, markup: &str) -> bool {
    markup.contains('`')
        && before
            .rsplit_once('\n')
            .map_or(before, |(_, line)| line)
            .chars()
            .any(char::is_alphanumeric)
}

pub fn parse_quiet_reply(raw: &str) -> QuietReplyParse {
    let mut remaining = raw.trim_end();
    let mut is_quiet = false;
    loop {
        let (before, word) = terminal_word(remaining, char::is_whitespace);
        let bare = word.trim_start_matches(MARKUP);
        if !bare
            .strip_prefix(QUIET_REPLY_MARKER)
            .is_some_and(|suffix| suffix.trim_matches(SUFFIX).is_empty())
            || is_inline_reference(before, &word[..word.len() - bare.len()])
        {
            break;
        }
        is_quiet = true;
        remaining = before.trim_end();
    }
    let is_pure_quiet = is_quiet && !remaining.chars().any(char::is_alphanumeric);
    QuietReplyParse {
        is_quiet,
        is_pure_quiet,
        leading_text: if is_pure_quiet {
            String::new()
        } else if is_quiet {
            remaining.to_owned()
        } else {
            raw.to_owned()
        },
    }
}

pub fn is_quiet_reply(raw: &str) -> bool {
    parse_quiet_reply(raw).is_quiet
}

pub fn without_growing_quiet_marker(raw: &str) -> &str {
    let (before, word) = terminal_word(raw.trim_end(), |ch| matches!(ch, ' ' | '\n' | '\t'));
    let bare = word.trim_start_matches(MARKUP);
    if !bare.is_empty()
        && (QUIET_REPLY_MARKER.starts_with(bare)
            || bare
                .strip_prefix(QUIET_REPLY_MARKER)
                .is_some_and(|suffix| suffix.trim_matches(SUFFIX).is_empty()))
        && !is_inline_reference(before, &word[..word.len() - bare.len()])
    {
        before.trim_end()
    } else {
        raw
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quiet_reply_truth_table_all_12_cases() {
        let cases: Vec<(String, bool, bool, String, String)> = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/quiet-reply.json"
        ))
        .unwrap();
        assert_eq!(cases.len(), 12);
        for (raw, is_quiet, is_pure_quiet, leading_text, streaming) in cases {
            assert_eq!(
                parse_quiet_reply(&raw),
                QuietReplyParse {
                    is_quiet,
                    is_pure_quiet,
                    leading_text
                },
                "{raw:?}"
            );
            assert_eq!(without_growing_quiet_marker(&raw), streaming, "{raw:?}");
        }
    }

    #[test]
    fn streaming_without_growing_marker_never_flashes_partial_sentinel() {
        for raw in ["NO_REPLY", "已记下\n**NO_REPLY**", "请输出 `NO_REPLY`"] {
            for (offset, ch) in raw.char_indices() {
                let prefix = &raw[..offset + ch.len_utf8()];
                let visible = without_growing_quiet_marker(prefix);
                if raw.starts_with("请输出") {
                    assert_eq!(visible, prefix);
                } else {
                    assert!(!visible.contains('N'), "{prefix:?} -> {visible:?}");
                }
            }
        }
    }
}
