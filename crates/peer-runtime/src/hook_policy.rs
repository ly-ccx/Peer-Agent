//! Hook selectors and decision reduction. Configuration only supplies a
//! constraint to the Host. A returned decision never creates a Grant.
use peer_store::{HookDefinition, HookPhase};
use regex::Regex;
use serde_json::Value;

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum HookDecision {
    Allow,
    Ask,
    Deny,
}

pub struct HookVerdict {
    pub decision: HookDecision,
    pub reason: Option<String>,
    pub outcome: &'static str,
}

pub struct HookSelector {
    capability: Option<Regex>,
    arguments: Option<Regex>,
}

impl HookSelector {
    pub fn compile(definition: &HookDefinition) -> Result<Self, &'static str> {
        Ok(Self {
            capability: glob(&definition.capability_pattern)?,
            arguments: glob(definition.argument_pattern.as_deref().unwrap_or_default())?,
        })
    }
    pub fn matches(&self, capability: &str, arguments: &Value) -> Result<bool, &'static str> {
        if self
            .capability
            .as_ref()
            .is_some_and(|pattern| !pattern.is_match(&utf16_text(capability)))
        {
            return Ok(false);
        }
        let Some(pattern) = &self.arguments else {
            return Ok(true);
        };
        let value = ["command", "query", "path"]
            .into_iter()
            .find_map(|name| arguments[name].as_str());
        let owned;
        let args = if let Some(value) = value {
            value
        } else if arguments.is_null() {
            "{}"
        } else {
            owned = peer_protocol::javascript_json_string(arguments)
                .map_err(|_| "hook_arguments_invalid")?;
            &owned
        };
        if args.len() > 1024 * 1024 {
            return Err("hook_arguments_limit");
        }
        Ok(pattern.is_match(&utf16_text(args)))
    }
}

// JS RegExp's original "*" and "?" are based on UTF-16 code units. A
// reversible mapping to valid Rust scalar values leaves delimiters literal
// and avoids changing the number of wildcard positions for non-BMP text.
fn scalar(unit: u16) -> char {
    char::from_u32(0x10000 + u32::from(unit)).expect("UTF-16 unit maps to one scalar")
}
fn utf16_text(input: &str) -> String {
    input.encode_utf16().map(scalar).collect()
}
fn glob(pattern: &str) -> Result<Option<Regex>, &'static str> {
    if matches!(pattern, "" | "*") {
        return Ok(None);
    }
    let non_line = r"[^\x{1000a}\x{1000d}\x{12028}\x{12029}]";
    let mut regex = String::from(r"\A");
    for unit in pattern.encode_utf16() {
        if unit == u16::from(b'*') {
            regex.push_str(non_line);
            regex.push('*');
        } else if unit == u16::from(b'?') {
            regex.push_str(non_line);
        } else {
            regex.push(scalar(unit));
        }
    }
    regex.push_str(r"\z");
    Regex::new(&regex)
        .map(Some)
        .map_err(|_| "hook_selector_invalid")
}

pub fn hook_verdict(
    phase: HookPhase,
    exit_code: Option<i32>,
    stdout: &[u8],
    failure: Option<&'static str>,
    fail_open: bool,
) -> HookVerdict {
    if let Some(failure) = failure {
        return failure_verdict(phase, failure, fail_open);
    }
    if let Some(verdict) = parse(stdout) {
        return verdict;
    }
    if exit_code != Some(0) {
        return failure_verdict(phase, "non_zero_exit", fail_open);
    }
    HookVerdict {
        decision: HookDecision::Allow,
        reason: None,
        outcome: "ok",
    }
}

fn failure_verdict(phase: HookPhase, failure: &'static str, fail_open: bool) -> HookVerdict {
    HookVerdict {
        decision: if fail_open || phase == HookPhase::PostToolUse {
            HookDecision::Allow
        } else {
            HookDecision::Deny
        },
        reason: Some(failure.into()),
        outcome: failure,
    }
}
fn parse(stdout: &[u8]) -> Option<HookVerdict> {
    let raw = peer_protocol::decode_json_bounded(
        stdout,
        peer_protocol::JsonLimits {
            bytes: 64 * 1024,
            nodes: 4096,
            depth: 16,
            string_bytes: 64 * 1024,
        },
    )
    .ok()?
    .value;
    let decision = match raw["decision"].as_str()? {
        "allow" => HookDecision::Allow,
        "ask" => HookDecision::Ask,
        "deny" => HookDecision::Deny,
        _ => return None,
    };
    Some(HookVerdict {
        decision,
        reason: raw["reason"].as_str().map(str::to_owned),
        outcome: "ok",
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn glob_preserves_the_existing_selector_fields_and_utf16_wildcards() {
        let def = HookDefinition {
            id: "fixture".into(),
            command: "fixture".into(),
            capability_pattern: "local.*".into(),
            argument_pattern: Some("take??".into()),
            timeout_ms: 3000,
            fail_open: false,
        };
        let selector = HookSelector::compile(&def).unwrap();
        assert!(
            selector
                .matches(
                    "local.file.read",
                    &json!({"query":"take🦀","path":"excluded"})
                )
                .unwrap()
        );
        assert!(
            !selector
                .matches(
                    "local.file.read",
                    &json!({"command":"excluded","query":"take🦀"})
                )
                .unwrap()
        );
        assert!(
            !selector
                .matches("local.file.read", &json!({"path":"take\n!"}))
                .unwrap()
        );
        assert!(
            !selector
                .matches("other.file.read", &json!({"path":"take🦀"}))
                .unwrap()
        );
    }
    #[test]
    fn absent_arguments_use_the_same_empty_object_as_the_legacy_runner() {
        let definition = HookDefinition {
            id: "empty".into(),
            command: "test fixture".into(),
            capability_pattern: "*".into(),
            argument_pattern: Some("{}".into()),
            timeout_ms: 3000,
            fail_open: false,
        };
        let selected = HookSelector::compile(&definition).unwrap();
        assert!(selected.matches("local.fixture", &Value::Null).unwrap());
        assert!(selected.matches("local.fixture", &json!({})).unwrap());
        assert!(
            !selected
                .matches("local.fixture", &json!({"path":""}))
                .unwrap()
        );
    }
    #[test]
    fn explicit_hook_outcomes_and_failure_defaults_follow_the_legacy_contract() {
        let ask = hook_verdict(
            HookPhase::PreToolUse,
            Some(3),
            br#"{"decision":"ask","reason":"confirm"}"#,
            None,
            false,
        );
        assert_eq!(ask.decision, HookDecision::Ask);
        assert_eq!(ask.reason.as_deref(), Some("confirm"));
        let denied = hook_verdict(HookPhase::PreToolUse, None, b"", Some("timeout"), false);
        assert_eq!(denied.decision, HookDecision::Deny);
        assert_eq!(denied.outcome, "timeout");
        assert_eq!(
            hook_verdict(HookPhase::PreToolUse, None, b"", Some("timeout"), true).decision,
            HookDecision::Allow
        );
        assert_eq!(
            hook_verdict(HookPhase::PostToolUse, Some(1), b"", None, false).decision,
            HookDecision::Allow
        );
        assert_eq!(
            HookDecision::Deny.max(HookDecision::Ask),
            HookDecision::Deny
        );
    }
}
