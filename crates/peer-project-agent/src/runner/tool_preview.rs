//! Display projection of tool arguments and outcomes, not model/tool input.
//! Match the limits and wire shape of packages/protocol/src/tool-activity-preview.ts
//! and runtime-node's turn-activity projection. Redact before clipping visible text.

use regex::Regex;
use serde_json::{Value, json};
use std::sync::OnceLock;

pub(super) const INPUT_LIMIT: usize = 2_000;
pub(super) const RESULT_LIMIT: usize = 4_000;
const TURN_LIMIT: usize = 32_000;
const STRING_LIMIT: usize = 6_000;
const SCAN_LIMIT: usize = 64_000;
const REDACTED: &str = "[redacted]";

fn regex(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("valid tool preview redaction pattern"))
}

fn private_field(key: &str) -> bool {
    static FIELD: OnceLock<Regex> = OnceLock::new();
    regex(
        &FIELD,
        r"(?i)api.?key|token|secret|password|credential|authorization|cookie|private.?key|reasoning|thinking|private_",
    )
    .is_match(key)
}

// Inspect more than the visible prefix so a credential crossing the preview
// boundary is removed, not shortened into a still-sensitive prefix.
pub(super) fn reply_draft(text: &str) -> String {
    // The last token may be an unfinished key; do not wait for the usual
    // minimum length before hiding its payload in an uncommitted snapshot.
    static PARTIAL_KEY: OnceLock<Regex> = OnceLock::new();
    let text = redact_text(text);
    let text = regex(
        &PARTIAL_KEY,
        r"(?i)\b(?:(?:sk|pk|rk)-[A-Za-z0-9_-]*|(?:AKIA|ASIA)[0-9A-Z]*)$",
    )
    .replace(&text, REDACTED);
    utf16_prefix(&text, INPUT_LIMIT).0.to_owned()
}

fn redact_text(text: &str) -> String {
    static PEM: OnceLock<Regex> = OnceLock::new();
    static CREDENTIAL: OnceLock<Regex> = OnceLock::new();
    static BEARER: OnceLock<Regex> = OnceLock::new();
    static SECRET: OnceLock<Regex> = OnceLock::new();
    let pem = regex(&PEM, r"(?is)-----BEGIN [^-\r\n]*PRIVATE KEY-----.*");
    let bearer = regex(&BEARER, r"(?i)\bBearer[ \t]+[A-Za-z0-9._~+/=-]+");
    let credential = regex(
        &CREDENTIAL,
        r#"(?i)(\b[A-Za-z0-9_.-]*(?:api[_-]?key|token|secret|password|credential|authorization|cookie|private[_-]?key)[ \t]*["']?[ \t]*[:=][ \t]*)(?:"(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s,"';}]+)"#,
    );
    let secret = regex(
        &SECRET,
        r"(?i)private_[A-Za-z0-9_-]*|\b(?:sk|pk|rk)-[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b",
    );
    let text = pem.replace(text, REDACTED);
    let text = bearer.replace_all(&text, "Bearer [redacted]");
    let text = credential.replace_all(&text, "${1}[redacted]");
    secret.replace_all(&text, REDACTED).into_owned()
}

fn utf16_prefix(text: &str, limit: usize) -> (&str, usize) {
    let mut units = 0;
    for (offset, ch) in text.char_indices() {
        let next = units + ch.len_utf16();
        if next > limit {
            return (&text[..offset], units);
        }
        units = next;
    }
    (text, units)
}

pub(super) fn summary(text: &str) -> String {
    let redacted = redact_text(utf16_prefix(text, SCAN_LIMIT).0);
    utf16_prefix(&redacted, 160).0.to_owned()
}

/// A single sanitized value feeds live previews and persisted round objects.
/// Keep the latter structured for legacy status/count/resource consumers.
#[derive(Default)]
pub(super) struct ToolPreview {
    pub(super) value: Value,
    truncated: bool,
    redacted: bool,
    nodes: usize,
}

impl ToolPreview {
    pub(super) fn new(value: &Value) -> Self {
        let mut preview = Self::default();
        let parsed;
        let value = if let Some(s) = value.as_str() {
            if utf16_prefix(s, SCAN_LIMIT).0.len() < s.len() {
                return Self {
                    value: json!(""),
                    truncated: true,
                    redacted: true,
                    ..Self::default()
                };
            }
            parsed = serde_json::from_str::<Value>(s).ok();
            parsed.as_ref().unwrap_or(value)
        } else {
            value
        };
        preview.value = preview.visit(value, 0);
        preview
    }

    fn clean_text(&mut self, text: &str) -> String {
        let (scanned, _) = utf16_prefix(text, SCAN_LIMIT);
        self.truncated |= scanned.len() < text.len();
        let clean = redact_text(scanned);
        self.redacted |= clean != scanned;
        let (bounded, _) = utf16_prefix(&clean, STRING_LIMIT);
        self.truncated |= bounded.len() < clean.len();
        bounded.to_owned()
    }

    fn visit(&mut self, value: &Value, depth: usize) -> Value {
        self.nodes += 1;
        if self.nodes > 160 || depth > 6 {
            self.truncated = true;
            return json!("[truncated]");
        }
        match value {
            Value::String(s) => Value::String(self.clean_text(s)),
            Value::Array(items) => {
                self.truncated |= items.len() > 40;
                Value::Array(
                    items
                        .iter()
                        .take(40)
                        .map(|v| self.visit(v, depth + 1))
                        .collect(),
                )
            }
            Value::Object(fields) => {
                self.truncated |= fields.len() > 40;
                Value::Object(
                    fields
                        .iter()
                        .take(40)
                        .map(|(key, item)| {
                            let clean_key = self.clean_text(key);
                            let item = if private_field(key) {
                                self.redacted = true;
                                json!(REDACTED)
                            } else {
                                self.visit(item, depth + 1)
                            };
                            (clean_key, item)
                        })
                        .collect(),
                )
            }
            _ => value.clone(),
        }
    }
}

pub(super) struct PreviewBudget(usize);

impl Default for PreviewBudget {
    fn default() -> Self {
        Self(TURN_LIMIT)
    }
}

impl PreviewBudget {
    pub(super) fn project(&mut self, preview: &ToolPreview, limit: usize) -> Value {
        let text = match &preview.value {
            Value::Null => String::new(),
            Value::String(s) => s.clone(),
            value => serde_json::to_string_pretty(value).expect("JSON tool preview"),
        };
        let (bounded, used) = utf16_prefix(&text, limit.min(self.0));
        self.0 -= used;
        json!({
            "text": bounded,
            "redacted": preview.redacted,
            "truncated": preview.truncated || bounded.len() < text.len(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_draft_redacts_before_utf16_clipping_and_hides_partial_keys() {
        for suffix in [
            "SK-",
            "pk-a",
            "rk-ab",
            "AKIA",
            "asia01",
            "AKIA0123456789ABCDEF",
        ] {
            assert_eq!(
                reply_draft(&format!("进度 {suffix}")),
                "进度 [redacted]",
                "{suffix}"
            );
        }
        let prefix = "界".repeat(INPUT_LIMIT - 12);
        let text = format!("{prefix} api_key=\"synthetic value spanning the clip\".");
        assert_eq!(reply_draft(&text), format!("{prefix} api_key=[re"));
        // Redaction can move safe text from beyond the original limit into view.
        let padded_secret = format!("{} sk-{} 😀!", "a".repeat(INPUT_LIMIT - 14), "x".repeat(50));
        assert_eq!(
            reply_draft(&padded_secret),
            format!("{} [redacted] 😀", "a".repeat(INPUT_LIMIT - 14))
        );
        assert_eq!(
            reply_draft(&format!("{}😀", "a".repeat(INPUT_LIMIT - 1))),
            "a".repeat(INPUT_LIMIT - 1)
        );
    }

    #[test]
    fn tool_preview_redacts_nested_keys_plaintext_and_private_markers() {
        let raw = json!({
            "path": "README.md",
            "nested": [{"privateKey": "do not print", "reasoning": "hidden trace", "PRIVATE_FIELD": true}],
            "content": "README fixture content\nPRIVATE_MARKER\napi_key=sk-example123456\nAuthorization: Bearer test-bearer-value\npassword=\"quoted value\"\nAKIA0123456789ABCDEF\n-----BEGIN OPENSSH PRIVATE KEY-----\nkey material",
        });
        let safe = ToolPreview::new(&raw);
        for text in [
            safe.value.to_string(),
            PreviewBudget::default().project(&safe, RESULT_LIMIT)["text"]
                .as_str()
                .unwrap()
                .to_owned(),
        ] {
            assert!(text.contains("README fixture content"));
            for secret in [
                "PRIVATE_",
                "do not print",
                "hidden trace",
                "sk-example",
                "test-bearer-value",
                "quoted value",
                "AKIA",
                "key material",
            ] {
                assert!(!text.contains(secret), "leaked {secret}");
            }
        }
        assert!(safe.redacted);
        assert!(!safe.truncated);
        let encoded = ToolPreview::new(&json!(
            r#"{"credentials":{"field":"never publish"},"ok":true}"#
        ));
        assert_eq!(encoded.value, json!({"credentials": REDACTED, "ok": true}));
    }

    #[test]
    fn tool_preview_limits_exact_utf16_edges_and_turn_budget() {
        let mut budget = PreviewBudget::default();
        let exact = ToolPreview::new(&json!("界".repeat(INPUT_LIMIT)));
        assert_eq!(budget.project(&exact, INPUT_LIMIT)["truncated"], false);
        let emoji = ToolPreview::new(&json!(format!("{}😀!", "a".repeat(RESULT_LIMIT - 1))));
        let clipped = budget.project(&emoji, RESULT_LIMIT);
        assert_eq!(clipped["text"].as_str().unwrap().len(), RESULT_LIMIT - 1);
        assert_eq!(clipped["truncated"], true);

        let crossed = ToolPreview::new(
            &json!({"stdout": format!("{}PRIVATE_{}", "x".repeat(RESULT_LIMIT - 40), "s".repeat(STRING_LIMIT))}),
        );
        let clipped = budget.project(&crossed, RESULT_LIMIT);
        assert_eq!(clipped["redacted"], true);
        assert!(clipped["text"].as_str().unwrap().contains(REDACTED));
        assert!(!crossed.value.to_string().contains("PRIVATE_"));

        let long = ToolPreview::new(&json!("x".repeat(STRING_LIMIT + 1)));
        assert_eq!(long.value.as_str().unwrap().len(), STRING_LIMIT);
        assert!(long.truncated);
        let mut budget = PreviewBudget::default();
        for _ in 0..TURN_LIMIT / RESULT_LIMIT {
            assert_eq!(
                budget.project(&long, RESULT_LIMIT)["text"]
                    .as_str()
                    .unwrap()
                    .len(),
                RESULT_LIMIT
            );
        }
        assert_eq!(
            budget.project(&long, RESULT_LIMIT),
            json!({"text": "", "truncated": true, "redacted": false})
        );
        assert_eq!(
            budget.project(&ToolPreview::new(&Value::Null), RESULT_LIMIT),
            json!({"text": "", "truncated": false, "redacted": false})
        );
    }
}
