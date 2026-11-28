use serde_json::Value;
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DigestError {
    UnsafeInteger,
    TooDeep,
    TooLarge,
    ReservedKey,
}

const MAX_BYTES: usize = 1_048_576;
const MAX_DEPTH: usize = 64;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

/// Exact existing JS digest for admitted JSON; never issues authority by itself.
pub fn approval_args_digest(value: &Value) -> Result<String, DigestError> {
    let mut encoded = String::new();
    encode(value, &mut encoded, 0, KeyOrder::Stable, MAX_BYTES)?;
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
    encode(input.args, &mut output, 1, KeyOrder::Stable, MAX_BYTES)?;
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
    encode_string_with_limit(value, output, MAX_BYTES)
}
fn append(output: &mut String, text: &str) -> Result<(), DigestError> {
    append_with_limit(output, text, MAX_BYTES)
}
fn encode_string_with_limit(
    value: &str,
    output: &mut String,
    limit: usize,
) -> Result<(), DigestError> {
    if value.len() > limit {
        return Err(DigestError::TooLarge);
    }
    append_with_limit(output, "\"", limit)?;
    for character in value.chars() {
        let mut buffer = [0u8; 4];
        match character {
            '"' => append_with_limit(output, "\\\"", limit)?,
            '\\' => append_with_limit(output, "\\\\", limit)?,
            '\u{8}' => append_with_limit(output, "\\b", limit)?,
            '\u{c}' => append_with_limit(output, "\\f", limit)?,
            '\n' => append_with_limit(output, "\\n", limit)?,
            '\r' => append_with_limit(output, "\\r", limit)?,
            '\t' => append_with_limit(output, "\\t", limit)?,
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
                append_with_limit(
                    output,
                    std::str::from_utf8(&encoded).expect("ASCII escape"),
                    limit,
                )?;
            }
            other => append_with_limit(output, other.encode_utf8(&mut buffer), limit)?,
        }
    }
    append_with_limit(output, "\"", limit)
}

fn append_with_limit(output: &mut String, text: &str, limit: usize) -> Result<(), DigestError> {
    if output.len().saturating_add(text.len()) > limit {
        return Err(DigestError::TooLarge);
    }
    output.push_str(text);
    Ok(())
}

#[derive(Clone, Copy)]
enum KeyOrder {
    Stable,
    JavaScript,
    Interactive,
}

/// Canonical bytes of an existing Interactive Result store record.
/// Unlike permission arguments, its source permits all finite JS numbers.
pub(crate) fn interactive_json(value: &Value) -> Result<String, DigestError> {
    let mut encoded = String::new();
    encode(value, &mut encoded, 0, KeyOrder::Interactive, 2 * MAX_BYTES)?;
    Ok(encoded)
}

/// Existing controlDigest uses JSON.stringify order, unlike approval's sorted keys.
/// serde_json preserve_order retains the source object's insertion order.
pub fn javascript_json_digest(value: &Value) -> Result<String, DigestError> {
    let encoded = javascript_json_string(value)?;
    Ok(format!("{:x}", Sha256::digest(encoded.as_bytes())))
}
pub fn javascript_json_string(value: &Value) -> Result<String, DigestError> {
    javascript_json_string_with_limit(value, MAX_BYTES)
}
/// Factual-context encoding only. Permission/control digests retain MAX_BYTES.
/// The caller owns its explicit budget; no caller may exceed the 8MiB ceiling.
pub fn javascript_json_string_with_limit(
    value: &Value,
    limit: usize,
) -> Result<String, DigestError> {
    if limit == 0 || limit > 8 * 1024 * 1024 {
        return Err(DigestError::TooLarge);
    }
    let mut encoded = String::new();
    encode(value, &mut encoded, 0, KeyOrder::JavaScript, limit)?;
    Ok(encoded)
}
/// Object.keys order used by existing JS reducers: integer indices, then insertion.
pub fn javascript_object_keys(value: &Value) -> Option<Vec<&str>> {
    let fields = value.as_object()?;
    let mut indexed = Vec::new();
    let mut ordinary = Vec::new();
    for key in fields.keys() {
        if let Some(index) = array_index(key) {
            indexed.push((index, key.as_str()))
        } else {
            ordinary.push(key.as_str())
        }
    }
    indexed.sort_by_key(|(index, _)| *index);
    Some(
        indexed
            .into_iter()
            .map(|(_, key)| key)
            .chain(ordinary)
            .collect(),
    )
}

fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || key.len() > 10 || key.len() > 1 && key.starts_with('0') {
        return None;
    }
    if !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|n| *n != u32::MAX)
}
fn encode(
    value: &Value,
    output: &mut String,
    depth: usize,
    order: KeyOrder,
    limit: usize,
) -> Result<(), DigestError> {
    if depth > MAX_DEPTH {
        return Err(DigestError::TooDeep);
    }
    match value {
        Value::Null => append_with_limit(output, "null", limit),
        Value::Bool(value) => {
            append_with_limit(output, if *value { "true" } else { "false" }, limit)
        }
        Value::String(value) => encode_string_with_limit(value, output, limit),
        Value::Number(number) => {
            if !matches!(order, KeyOrder::Interactive)
                && (number.as_u64().is_some_and(|n| n > MAX_SAFE_INTEGER)
                    || number
                        .as_i64()
                        .is_some_and(|n| n.unsigned_abs() > MAX_SAFE_INTEGER))
            {
                return Err(DigestError::UnsafeInteger);
            }
            let number = number.as_f64().ok_or(DigestError::UnsafeInteger)?;
            let mut buffer = ryu_js::Buffer::new();
            append_with_limit(output, buffer.format(number), limit)
        }
        Value::Array(values) => encode_array(values, output, depth, order, limit),
        Value::Object(values) => {
            if values.len() > 65_536 {
                return Err(DigestError::TooLarge);
            }
            let mut keys: Vec<_> = values.keys().collect();
            // JavaScript Object.keys(...).sort() compares UTF-16 code units.
            match order {
                KeyOrder::Stable | KeyOrder::Interactive => {
                    keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()))
                }
                KeyOrder::JavaScript => {
                    keys.sort_by(|a, b| match (array_index(a), array_index(b)) {
                        (Some(a), Some(b)) => a.cmp(&b),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => std::cmp::Ordering::Equal,
                    })
                }
            }
            append_with_limit(output, "{", limit)?;
            for (index, key) in keys.into_iter().enumerate() {
                if matches!(order, KeyOrder::Interactive)
                    && matches!(key.as_str(), "__proto__" | "prototype" | "constructor")
                {
                    return Err(DigestError::ReservedKey);
                }
                if index != 0 {
                    append_with_limit(output, ",", limit)?;
                }
                encode_string_with_limit(key, output, limit)?;
                append_with_limit(output, ":", limit)?;
                encode(&values[key], output, depth + 1, order, limit)?;
            }
            append_with_limit(output, "}", limit)
        }
    }
}

fn encode_array(
    values: &[Value],
    output: &mut String,
    depth: usize,
    order: KeyOrder,
    limit: usize,
) -> Result<(), DigestError> {
    append_with_limit(output, "[", limit)?;
    for (index, value) in values.iter().enumerate() {
        if index != 0 {
            append_with_limit(output, ",", limit)?;
        }
        encode(value, output, depth + 1, order, limit)?;
    }
    append_with_limit(output, "]", limit)
}
/// Borrow a factual history slice without copying it into a Value::Array first.
/// Default permission/control APIs do not use this context budget.
pub fn javascript_json_array_string_with_limit(
    values: &[Value],
    limit: usize,
) -> Result<String, DigestError> {
    if limit == 0 || limit > 8 * 1024 * 1024 {
        return Err(DigestError::TooLarge);
    }
    let mut output = String::new();
    encode_array(values, &mut output, 0, KeyOrder::JavaScript, limit)?;
    Ok(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn factual_context_budget_never_expands_permission_or_control_digest_budgets() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/attachment-images.json"
        ))
        .unwrap();
        let value = serde_json::json!({"body":"🦀".repeat(data["largeFact"]["scalars"].as_u64().unwrap() as usize),"escapes":"\n\"\0"});
        assert_eq!(data["permissionJsonBytes"], MAX_BYTES);
        let array =
            javascript_json_array_string_with_limit(std::slice::from_ref(&value), 2 * 1024 * 1024)
                .unwrap();
        assert_eq!(
            array.len(),
            data["largeFact"]["arrayBytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(array.as_bytes())),
            data["largeFact"]["arraySha256"]
        );
        let encoded = javascript_json_string_with_limit(&value, 2 * 1024 * 1024).unwrap();
        assert_eq!(
            encoded.len(),
            data["largeFact"]["bytes"].as_u64().unwrap() as usize
        );
        assert_eq!(
            format!("{:x}", Sha256::digest(encoded.as_bytes())),
            data["largeFact"]["sha256"]
        );
        assert_eq!(javascript_json_string(&value), Err(DigestError::TooLarge));
        assert_eq!(javascript_json_digest(&value), Err(DigestError::TooLarge));
        assert_eq!(approval_args_digest(&value), Err(DigestError::TooLarge));
        assert_eq!(
            permission_operation_key(PermissionOperation {
                capability_id: "local.file.write",
                args: &value,
                conversation_id: None,
                workspace_path: None,
                session_id: None,
                plan_id: None
            }),
            Err(DigestError::TooLarge)
        );
        assert_eq!(
            javascript_json_string_with_limit(&Value::Null, 0),
            Err(DigestError::TooLarge)
        );
        assert_eq!(
            javascript_json_string_with_limit(&Value::Null, 8 * 1024 * 1024 + 1),
            Err(DigestError::TooLarge)
        );
    }

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
