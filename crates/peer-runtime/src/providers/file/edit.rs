//! Exact string replacement follows the existing TS Provider, including the
//! non-regexp String.replace substitution tokens for a single replacement.
use super::*;
pub(super) fn replace(content: &str, args: &Value) -> Result<String, HostError> {
    let old = string(args, "old_string")?;
    if peer_protocol::javascript_trim(old).is_empty() {
        return Err(HostError("invalid_old_string"));
    }
    let new = string(args, "new_string")?;
    let count = content.matches(old).count();
    if count == 0 {
        return Err(HostError("old_string_not_found"));
    }
    if count > 1 && args["replace_all"] != true {
        return Err(HostError("old_string_not_unique"));
    }
    // A capped writer also handles substitution tokens without pessimistically
    // rejecting a small result merely because the input has many matches.
    let mut out = String::with_capacity(content.len().min(WRITE_BYTES));
    let mut append = |s: &str| -> Result<(), HostError> {
        if out.len().saturating_add(s.len()) > WRITE_BYTES {
            return Err(HostError("file_write_too_large"));
        }
        out.push_str(s);
        Ok(())
    };
    if args["replace_all"] == true {
        let mut rest = content;
        while let Some(i) = rest.find(old) {
            append(&rest[..i])?;
            append(new)?;
            rest = &rest[i + old.len()..];
        }
        append(rest)?;
    } else {
        let i = content.find(old).unwrap();
        let before = &content[..i];
        let after = &content[i + old.len()..];
        append(before)?;
        let mut rest = new;
        while let Some(i) = rest.find('$') {
            append(&rest[..i])?;
            rest = &rest[i + 1..];
            let value = match rest.as_bytes().first() {
                Some(b'$') => "$",
                Some(b'&') => old,
                Some(b'`') => before,
                Some(b'\'') => after,
                _ => {
                    append("$")?;
                    continue;
                }
            };
            append(value)?;
            rest = &rest[1..];
        }
        append(rest)?;
        append(after)?;
    }
    Ok(out)
}
