//! Exact existing TUI automatic approval and project-agent mode policy. These
//! pure decisions never bypass live Host admission or Provider hard denials.
use serde_json::{Value, json};
use std::sync::OnceLock;
fn capabilities() -> &'static Value {
    static CAPS: OnceLock<Value> = OnceLock::new();
    CAPS.get_or_init(|| {
        serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/project-agent-capabilities.json"
        ))
        .expect("compiled capability policy")
    })
}
pub fn automatic_access_decision(level: &str, prompt: &Value, bot: bool) -> Option<Value> {
    if level == "full_local" {
        return Some(json!({"granted":true,"reason":"local_access_level_full"}));
    }
    if level != "session_local" || prompt["confirmation"]["kind"] != "capability-approval" {
        return None;
    }
    let kind = &prompt["confirmation"]["approvalKind"];
    if kind == "file-write" && !bot {
        return Some(json!({"granted":true,"reason":"local_access_level_session"}));
    }
    if kind == "shell-exec"
        && matches!(
            prompt["riskLevel"].as_str(),
            Some("L0_inert" | "L1_local_read" | "L2_local_write" | "L3_external_write")
        )
    {
        return Some(json!({"granted":true,"reason":"local_access_level_session"}));
    }
    None
}
pub fn evaluate_project_agent_turn(input: &Value) -> Value {
    if input["mode"] != "project_agent" && input["role"] != "project_agent" {
        return json!({"applies":false,"allowed":true});
    }
    let capability = input["capabilityId"].as_str();
    if capability.is_none()
        || !capabilities()["capabilities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|c| c.as_str() == capability)
    {
        return json!({"applies":true,"allowed":false,"reason":"project_agent_capability_denied","detail":"capability","accessLevel":"restricted_local"});
    }
    if input["permissionKind"].as_str().is_some_and(|s| {
        s == "file-write"
            || s == "shell"
            || s == "browser"
            || s.starts_with("browser-")
            || s.starts_with("browser_")
    }) {
        return json!({"applies":true,"allowed":false,"reason":"project_agent_capability_denied","detail":"permission_kind","accessLevel":"restricted_local"});
    }
    json!({"applies":true,"allowed":true,"accessLevel":"restricted_local"})
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn current_tui_automatic_and_role_mode_contracts_match() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/access-policy.json"
        ))
        .unwrap();
        for c in fixture["automatic"].as_array().unwrap() {
            assert_eq!(
                automatic_access_decision(
                    c["level"].as_str().unwrap(),
                    &c["prompt"],
                    c["bot"].as_bool().unwrap()
                )
                .unwrap_or(Value::Null),
                c["expected"],
                "{c}"
            );
        }
        for c in fixture["modes"].as_array().unwrap() {
            assert_eq!(
                evaluate_project_agent_turn(&c["input"]),
                c["expected"],
                "{c}"
            );
        }
    }
}
