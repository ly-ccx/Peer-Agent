use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestError {
    UnsafeInteger,
    TooDeep,
    TooLarge,
}

const MAX_BYTES: usize = 1_048_576;
const MAX_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Exact existing JS digest for admitted JSON; never issues authority by itself.
pub fn approval_args_digest(value: &Value) -> Result<String, DigestError> {
    let mut encoded = String::new();
    encode(value, &mut encoded, 0)?;
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}

pub struct PermissionOperation<'a> {
    pub capability_id: &'a str,
    pub args: &'a Value,
    pub conversation_id: Option<&'a str>,
    pub workspace_path: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub plan_id: Option<&'a str>,
}

/// Same fixed operation object as permission-inheritance.mjs, without cloning args.
pub fn permission_operation_key(input: PermissionOperation<'_>) -> Result<String, DigestError> {
    let mut output = String::new();
    append(&mut output, "{\"args\":")?;
    encode(input.args, &mut output, 1)?;
    append(&mut output, ",\"capabilityId\":")?;
    encode_string(input.capability_id, &mut output)?;
    for (key, value) in [
        ("conversationId", input.conversation_id),
        ("planId", input.plan_id),
        ("sessionId", input.session_id),
        ("workspacePath", input.workspace_path),
    ] {
        append(&mut output, ",")?;
        encode_string(key, &mut output)?;
        append(&mut output, ":")?;
        if let Some(text) = value {
            encode_string(text, &mut output)?;
        } else {
            append(&mut output, "null")?;
        }
    }
    append(&mut output, "}")?;
    Ok(format!("{:x}", Sha256::digest(output.as_bytes())))
}

fn encode_string(value: &str, output: &mut String) -> Result<(), DigestError> {
    if value.len() > MAX_BYTES {
        return Err(DigestError::TooLarge);
    }
    append(output, "\"")?;
    for character in value.chars() {
        let mut buffer = [0u8; 4];
        match character {
            '"' => append(output, "\\\"")?,
            '\\' => append(output, "\\\\")?,
            '\u{8}' => append(output, "\\b")?,
            '\u{c}' => append(output, "\\f")?,
            '\n' => append(output, "\\n")?,
            '\r' => append(output, "\\r")?,
            '\t' => append(output, "\\t")?,
            control if (control as u32) < 32 => {
                const HEX: &[u8; 16] = b"0123456789abcdef";
                let encoded = [
                    b'\\',
                    b'u',
                    b'0',
                    b'0',
                    HEX[(control as usize) >> 4],
                    HEX[(control as usize) & 15],
                ];
                append(output, std::str::from_utf8(&encoded).expect("ASCII escape"))?;
            }
            other => append(output, other.encode_utf8(&mut buffer))?,
        }
    }
    append(output, "\"")
}

fn append(output: &mut String, text: &str) -> Result<(), DigestError> {
    if output.len().saturating_add(text.len()) > MAX_BYTES {
        return Err(DigestError::TooLarge);
    }
    output.push_str(text);
    Ok(())
}

fn encode(value: &Value, output: &mut String, depth: usize) -> Result<(), DigestError> {
    if depth > MAX_DEPTH {
        return Err(DigestError::TooDeep);
    }
    match value {
        Value::Null => append(output, "null"),
        Value::Bool(value) => append(output, if *value { "true" } else { "false" }),
        Value::String(value) => encode_string(value, output),
        Value::Number(number) => {
            if number.as_u64().is_some_and(|n| n > MAX_SAFE_INTEGER)
                || number
                    .as_i64()
                    .is_some_and(|n| n.unsigned_abs() > MAX_SAFE_INTEGER)
            {
                return Err(DigestError::UnsafeInteger);
            }
            let number = number.as_f64().ok_or(DigestError::UnsafeInteger)?;
            let mut buffer = ryu_js::Buffer::new();
            append(output, buffer.format(number))
        }
        Value::Array(values) => {
            append(output, "[")?;
            for (index, value) in values.iter().enumerate() {
                if index != 0 {
                    append(output, ",")?;
                }
                encode(value, output, depth + 1)?;
            }
            append(output, "]")
        }
        Value::Object(values) => {
            if values.len() > 65_536 {
                return Err(DigestError::TooLarge);
            }
            let mut keys: Vec<_> = values.keys().collect();
            // JavaScript Object.keys(...).sort() compares UTF-16 code units.
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            append(output, "{")?;
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    append(output, ",")?;
                }
                encode_string(key, output)?;
                append(output, ":")?;
                encode(&values[key], output, depth + 1)?;
            }
            append(output, "}")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_real_typescript_digest_vectors() {
        let contract: Value = serde_json::from_str(crate::CONTRACT_JSON).unwrap();
        for case in contract["approvalDigestCases"].as_array().unwrap() {
            assert_eq!(
                approval_args_digest(&case["input"]).unwrap(),
                case["expected"].as_str().unwrap(),
                "{}",
                case["name"]
            );
        }
    }

    #[test]
    fn rejects_unrepresentable_and_unbounded_inputs_without_partial_digest() {
        assert_eq!(
            approval_args_digest(&serde_json::json!(9_007_199_254_740_992_u64)),
            Err(DigestError::UnsafeInteger)
        );
        assert_eq!(
            approval_args_digest(&Value::String("x".repeat(MAX_BYTES + 1))),
            Err(DigestError::TooLarge)
        );
        // Raw input fits; escaped wire bytes do not. Never hash a prefix.
        assert_eq!(
            approval_args_digest(&Value::String("\0".repeat(MAX_BYTES / 5))),
            Err(DigestError::TooLarge)
        );
        let mut value = Value::Null;
        for _ in 0..66 {
            value = Value::Array(vec![value]);
        }
        assert_eq!(approval_args_digest(&value), Err(DigestError::TooDeep));
    }
}
