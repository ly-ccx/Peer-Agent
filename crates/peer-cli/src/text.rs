use std::io;
pub(crate) fn diagnostic(value: &str) -> String {
    if value
        .chars()
        .any(|c| c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}'))
    {
        value.chars().flat_map(char::escape_default).collect()
    } else {
        value.to_owned()
    }
}
/// Preserve field meaning while preventing terminal control injection.
pub(crate) fn field(value: &str, label: bool) -> io::Result<String> {
    let mut output = String::new();
    let mut whitespace = false;
    for c in value.chars() {
        if label && matches!(c, '\t' | '\r' | '\n') {
            if !whitespace {
                output.push(' ');
            }
            whitespace = true;
            continue;
        }
        whitespace = false;
        if c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {
            return Err(io::Error::other("terminal_text_invalid"));
        }
        output.push(c);
    }
    Ok(output)
}
