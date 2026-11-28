use std::io;
pub(crate) fn strip_terminal_controls(value: &mut String) {
    value.retain(|c| {
        matches!(c, '\t' | '\n')
            || !(c.is_control() || matches!(c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    });
}
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

/// JSON must retain field meaning without emitting terminal controls.
pub(crate) fn escape_json_controls(encoded: &str) -> String {
    encoded
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}') {
                format!("\\u{:04x}", c as u32)
            } else {
                c.to_string()
            }
        })
        .collect()
}

/// Preserve a settled command's exit status when its final display is dropped.
/// Commands that require successful delivery on stdout must propagate write errors.
pub fn finish_stdout(write: io::Result<()>) -> io::Result<()> {
    match write {
        Err(error) if error.kind() == io::ErrorKind::BrokenPipe => Ok(()),
        other => other,
    }
}
