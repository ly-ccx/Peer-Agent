use regex::Regex;
use std::{io::Write, sync::OnceLock};
const WS: &str =
    r"\t\n\v\f\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}";
fn regex(s: &str) -> Regex {
    regex::RegexBuilder::new(s)
        .size_limit(128 * 1024)
        .dfa_size_limit(256 * 1024)
        .build()
        .expect("fixed redaction pattern")
}
pub(super) fn redact(raw: &str) -> String {
    let mut units = 0;
    let mut end = 0;
    for (pos, c) in raw.char_indices() {
        if units + c.len_utf16() > super::limits().preview_units {
            break;
        }
        units += c.len_utf16();
        end = pos + c.len_utf8();
    }
    let mut text = raw[..end].to_owned();
    if end < raw.len() {
        text.push_str("\n...[preview truncated]");
    }
    static RE: OnceLock<Vec<(Regex, &'static str)>> = OnceLock::new();
    for (re, to) in RE.get_or_init(|| {
        vec![
            (regex("AKIA[0-9A-Z]{16}"), "[REDACTED_AWS_KEY]"),
            (regex("sk-[A-Za-z0-9_-]{20,}"), "[REDACTED_API_KEY]"),
            (
                regex(&format!(r"((?i-u:Bearer)[{WS}]+)[A-Za-z0-9._-]+")),
                "${1}[REDACTED_TOKEN]",
            ),
            (
                regex(&format!(
                    r"((?i-u:[A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY))=)[^{WS}]+"
                )),
                "${1}[REDACTED]",
            ),
        ]
    }) {
        text = re.replace_all(&text, *to).into_owned();
    }
    text
}
pub(super) fn origin(raw: &str) -> String {
    static URL: OnceLock<Regex> = OnceLock::new();
    static QUERY: OnceLock<Regex> = OnceLock::new();
    let text = redact(raw);
    let text = URL
        .get_or_init(|| regex(&format!(r"((?i-u:[a-z][a-z0-9+.-]*)://)[^/{WS}]*@")))
        .replace_all(&text, "${1}[redacted]@");
    QUERY
        .get_or_init(|| {
            regex(&format!(
                r"([?&](?i-u:token|key|password|secret|access_token)=)[^&{WS}]*"
            ))
        })
        .replace_all(&text, "${1}[redacted]")
        .into_owned()
}
pub(super) struct JsonLimit(pub usize);
impl Write for JsonLimit {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0 = self.0.saturating_add(bytes.len());
        if self.0 > super::limits().observation_json_bytes {
            return Err(std::io::Error::other("git_query_output_limit"));
        }
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}
