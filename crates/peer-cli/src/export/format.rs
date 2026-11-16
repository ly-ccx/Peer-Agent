use peer_store::SessionMetadata;
use serde_json::Value;
use std::{
    borrow::Cow,
    io::{self, Write},
};
fn word(c: u8) -> bool {
    c.is_ascii_alphanumeric() || c == b'_'
}
fn whitespace(c: char) -> bool {
    let mut bytes = [0; 4];
    peer_protocol::javascript_trim(c.encode_utf8(&mut bytes)).is_empty()
}
pub(super) struct Tracked<W> {
    out: W,
    position: u64,
    last: u64,
}
impl<W: Write> Tracked<W> {
    pub fn new(out: W) -> Self {
        Self {
            out,
            position: 0,
            last: 0,
        }
    }
    pub fn finish(mut self) -> io::Result<u64> {
        self.flush()?;
        Ok(self.last)
    }
}
impl<W: Write> Write for Tracked<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let text =
            std::str::from_utf8(bytes).map_err(|_| io::Error::other("export_text_invalid"))?;
        self.out.write_all(bytes)?;
        if let Some((i, c)) = text.char_indices().rfind(|(_, c)| !whitespace(*c)) {
            self.last = self.position + i as u64 + c.len_utf8() as u64;
        }
        self.position += bytes.len() as u64;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.out.flush()
    }
}
fn prefix(bytes: &[u8], at: usize, value: &[u8]) -> bool {
    bytes
        .get(at..at + value.len())
        .is_some_and(|s| s.eq_ignore_ascii_case(value))
}
fn token_end(bytes: &[u8], start: usize, kind: u8) -> Option<usize> {
    let mut end = start;
    while end < bytes.len()
        && (bytes[end].is_ascii_alphanumeric()
            || if kind == 0 {
                matches!(bytes[end], b'_' | b'-')
            } else {
                matches!(bytes[end], b'.' | b'_' | b'-')
            })
    {
        end += 1;
    }
    while kind == 0 && end > start && !word(bytes[end - 1]) {
        end -= 1;
    }
    (end >= start + if kind == 0 { 8 } else { 1 }).then_some(end)
}
fn secret_end(text: &str, at: usize) -> Option<usize> {
    let bytes = text.as_bytes();
    if at > 0 && word(bytes[at - 1]) {
        return None;
    }
    if prefix(bytes, at, b"sk-") {
        return token_end(bytes, at + 3, 0);
    }
    if prefix(bytes, at, b"ya29.") {
        return token_end(bytes, at + 5, 1);
    }
    if prefix(bytes, at, b"Bearer") {
        let mut start = at + 6;
        let before = start;
        for c in text[start..].chars() {
            if !whitespace(c) {
                break;
            }
            start += c.len_utf8();
        }
        if start == before {
            return None;
        }
        let mut end = start;
        while end < bytes.len()
            && (bytes[end].is_ascii_alphanumeric()
                || matches!(bytes[end], b'.' | b'_' | b'~' | b'+' | b'/' | b'-'))
        {
            end += 1;
        }
        if end == start {
            return None;
        }
        while bytes.get(end) == Some(&b'=') {
            end += 1;
        }
        return Some(end);
    }
    None
}
pub(super) fn redacted(out: &mut impl Write, text: &str) -> io::Result<()> {
    let mut start = 0;
    let mut at = 0;
    let bytes = text.as_bytes();
    while at < bytes.len() {
        if matches!(bytes[at], b's' | b'S' | b'b' | b'B' | b'y' | b'Y')
            && let Some(end) = secret_end(text, at)
        {
            out.write_all(&bytes[start..at])?;
            out.write_all(b"[redacted]")?;
            start = end;
            at = end;
        } else {
            at += 1;
        }
    }
    out.write_all(&bytes[start..])
}
fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(v) => *v,
        Value::Number(v) => v.as_f64() != Some(0.),
        Value::String(v) => !v.is_empty(),
        _ => true,
    }
}
fn content(value: &Value) -> Cow<'_, str> {
    match value {
        Value::String(s) => Cow::Borrowed(s),
        Value::Object(v) => Cow::Borrowed(v.get("text").and_then(Value::as_str).unwrap_or("")),
        Value::Array(parts) => Cow::Owned(
            parts
                .iter()
                .filter_map(|v| {
                    if let Some(s) = v.as_str() {
                        return (!s.is_empty()).then_some(s);
                    }
                    let v = v.as_object()?;
                    if v.get("type").is_some_and(|t| truthy(t) && t != "text") {
                        return None;
                    }
                    v.get("text")
                        .and_then(Value::as_str)
                        .or_else(|| v.get("content").and_then(Value::as_str))
                        .filter(|s| !s.is_empty())
                })
                .collect::<Vec<_>>()
                .join("\n"),
        ),
        _ => Cow::Borrowed(""),
    }
}
fn check_terminal(text: &str, terminal: bool) -> io::Result<()> {
    if terminal
        && text.chars().any(|c| {
            (c.is_control() && !matches!(c, '\n' | '\t'))
                || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
        })
    {
        return Err(io::Error::other("export_terminal_text_invalid"));
    }
    Ok(())
}
pub(super) fn header(
    out: &mut impl Write,
    meta: &SessionMetadata,
    terminal: bool,
) -> io::Result<()> {
    let title = meta
        .title
        .as_deref()
        .map(peer_protocol::javascript_trim)
        .filter(|s| !s.is_empty())
        .unwrap_or("Untitled session")
        .replace("\r\n", " ")
        .replace('\n', " ");
    check_terminal(&title, terminal)?;
    check_terminal(&meta.id, terminal)?;
    out.write_all(b"# ")?;
    redacted(out, &title)?;
    out.write_all(b"\n\nsession: ")?;
    redacted(out, &meta.id)?;
    if let Some(updated) = meta.updated_at.as_deref().filter(|s| !s.is_empty()) {
        check_terminal(updated, terminal)?;
        out.write_all(b"\nupdated: ")?;
        redacted(out, updated)?;
    }
    Ok(())
}
pub(super) fn message(out: &mut impl Write, row: &Value, terminal: bool) -> io::Result<()> {
    let role = row["role"].as_str().unwrap_or("");
    if !matches!(role, "user" | "assistant") {
        return Ok(());
    }
    let raw = content(&row["content"]);
    let text = peer_protocol::javascript_trim(&raw);
    if text.is_empty() {
        return Ok(());
    }
    check_terminal(text, terminal)?;
    write!(out, "\n\n## {role}\n\n")?;
    redacted(out, text)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_typescript_redaction_vectors_match_without_full_text_replacement() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/session-shell.json"
        ))
        .unwrap();
        for case in data["redaction"].as_array().unwrap() {
            let mut bytes = vec![];
            redacted(&mut bytes, case["text"].as_str().unwrap()).unwrap();
            assert_eq!(
                String::from_utf8(bytes).unwrap(),
                case["expected"].as_str().unwrap()
            );
        }
    }
}
