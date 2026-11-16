//! Exact production result envelope; server content never becomes permission.
use super::*;
fn pretty(value: &Value) -> String {
    let compact =
        peer_protocol::javascript_json_string(value).unwrap_or_else(|_| value.to_string());
    let mut out = String::new();
    let mut depth = 0;
    let mut string = false;
    let mut escaped = false;
    let chars: Vec<_> = compact.chars().collect();
    for (i, c) in chars.iter().copied().enumerate() {
        if string {
            out.push(c);
            if escaped {
                escaped = false
            } else if c == '\\' {
                escaped = true
            } else if c == '"' {
                string = false
            }
            continue;
        }
        match c {
            '"' => {
                string = true;
                out.push(c)
            }
            '{' | '[' => {
                out.push(c);
                depth += 1;
                if !matches!(chars.get(i + 1), Some('}' | ']')) {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
            }
            '}' | ']' => {
                depth -= 1;
                if !matches!(i.checked_sub(1).and_then(|i| chars.get(i)), Some('{' | '[')) {
                    out.push('\n');
                    out.push_str(&"  ".repeat(depth));
                }
                out.push(c)
            }
            ',' => {
                out.push_str(",\n");
                out.push_str(&"  ".repeat(depth));
            }
            ':' => out.push_str(": "),
            _ => out.push(c),
        }
    }
    out
}
pub(crate) fn normalize_result(raw: Value) -> Value {
    let content = raw["content"].as_array().cloned().unwrap_or_default();
    let text = content
        .iter()
        .filter_map(|i| i["text"].as_str().or_else(|| i["data"].as_str()))
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    let text = if text.is_empty() {
        if raw.is_null() {
            pretty(&json!({}))
        } else {
            pretty(&raw)
        }
    } else {
        text
    };
    let is_error = match &raw["isError"] {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::String(s) => !s.is_empty(),
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        _ => true,
    };
    json!({"raw":raw,"content":content,"text":text,"isError":is_error,"structuredContent":raw.get("structuredContent").unwrap_or(&Value::Null)})
}
/// Redaction can change arbitrary server keys, including a key named isError.
/// Preserve the SDK-validated protocol outcome separately from that data.
pub(crate) fn prepare_result(
    raw: Value,
    config: &Value,
    extra: &[String],
) -> Result<Value, &'static str> {
    let is_error = raw["isError"] == true;
    let mut output = normalize_result(redact_with(raw, config, extra));
    output["isError"] = json!(is_error);
    if serde_json::to_vec(&output).map_or(true, |v| {
        v.len() > LIMITS["maxResultBytes"].as_u64().unwrap() as usize
    }) {
        return Err("mcp_result_limit");
    }
    Ok(output)
}
/// Configured header/environment values may be echoed by an untrusted server.
/// Sanitize before any Tool Result, model context or Evidence persistence.
#[cfg(test)]
fn redact(value: Value, config: &Value) -> Value {
    redact_with(value, config, &[])
}
fn redact_with(mut value: Value, config: &Value, extra: &[String]) -> Value {
    let mut secrets = zeroize::Zeroizing::new(extra.to_vec());
    if let Some(values) = config["_credentialRedaction"].as_array() {
        secrets.extend(
            values
                .iter()
                .filter_map(|v| v.as_str())
                .filter(|v| !v.is_empty())
                .map(str::to_owned),
        );
    }
    for key in ["headers", "env"] {
        if let Some(map) = config[key].as_object() {
            for v in map.values() {
                if let Some(s) = v.as_str().filter(|s| !s.is_empty()) {
                    secrets.push(s.to_owned());
                }
            }
        }
    }
    secrets.sort_by_key(|s| std::cmp::Reverse(s.len()));
    secrets.dedup();
    if secrets.is_empty() {
        return value;
    }
    let matcher = aho_corasick::AhoCorasick::builder()
        .kind(Some(aho_corasick::AhoCorasickKind::ContiguousNFA))
        .match_kind(aho_corasick::MatchKind::LeftmostLongest)
        .build(secrets.iter());
    let Ok(matcher) = matcher else {
        return json!({"redacted":true});
    };
    let replacements = vec!["[REDACTED]"; secrets.len()];
    fn visit(v: &mut Value, matcher: &aho_corasick::AhoCorasick, replacements: &[&str]) {
        match v {
            Value::String(s) => *s = matcher.replace_all(s, replacements),
            Value::Array(a) => {
                for v in a {
                    visit(v, matcher, replacements)
                }
            }
            Value::Object(m) => {
                let old = std::mem::take(m);
                for (k, mut v) in old {
                    let k = matcher.replace_all(&k, replacements);
                    visit(&mut v, matcher, replacements);
                    m.insert(k, v);
                }
            }
            _ => {}
        }
    }
    visit(&mut value, &matcher, &replacements);
    value
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redaction_never_recursively_rewrites_replacement_text() {
        let config = json!({"env":{"A":"a","B":"RED","C":"[REDACTED]","D":"alphabet"}});
        assert_eq!(
            redact(json!({"v":"alphabet a RED [REDACTED]"}), &config),
            json!({"v":"[REDACTED] [REDACTED] [REDACTED] [REDACTED]"})
        );
    }
    #[test]
    fn redacted_data_cannot_change_a_protocol_failure_to_success() {
        let output = prepare_result(
            json!({"content":[],"isError":true}),
            &json!({"env":{"TOKEN":"Error"}}),
            &[],
        )
        .unwrap();
        assert_eq!(output["isError"], true);
        assert!(!output["raw"].to_string().contains("isError"));
        let output = prepare_result(
            json!({"content":[{"type":"text","text":"Error secret"}],"isError":true}),
            &json!({}),
            &["Error".into(), "secret".into()],
        )
        .unwrap();
        assert_eq!(output["isError"], true);
        assert_eq!(output["text"], "[REDACTED] [REDACTED]");
        assert!(!output["raw"].to_string().contains("isError"));
    }
    #[test]
    fn production_ts_normalizer_matches() {
        let contract: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/mcp-runtime-results.json"
        ))
        .unwrap();
        for c in contract["cases"].as_array().unwrap() {
            assert_eq!(normalize_result(c["input"].clone()), c["expected"]);
        }
    }
}
