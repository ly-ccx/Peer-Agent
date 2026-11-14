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
        Value::String(value) => {
            if value.len() > MAX_BYTES {
                return Err(DigestError::TooLarge);
            }
            append(
                output,
                &serde_json::to_string(value).expect("string serializes"),
            )
        }
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
            let mut keys: Vec<_> = values.keys().collect();
            // JavaScript Object.keys(...).sort() compares UTF-16 code units.
            keys.sort_by(|left, right| left.encode_utf16().cmp(right.encode_utf16()));
            append(output, "{")?;
            for (index, key) in keys.into_iter().enumerate() {
                if index != 0 {
                    append(output, ",")?;
                }
                encode(&Value::String(key.clone()), output, depth + 1)?;
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
        let mut value = Value::Null;
        for _ in 0..66 {
            value = Value::Array(vec![value]);
        }
        assert_eq!(approval_args_digest(&value), Err(DigestError::TooDeep));
    }
}
