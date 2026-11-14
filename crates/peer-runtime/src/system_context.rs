//! ADR 55 native Source assembly. Host facts enter named sections; wire adapters
//! receive only the finished immutable context. No file/tool body is a Source.
use peer_protocol::javascript_json_string;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
fn hash(s: &str) -> String {
    format!("{:x}", Sha256::digest(s.as_bytes()))
}
fn section(
    id: &str,
    layer: &str,
    priority: i64,
    title: &str,
    content: String,
    source: Value,
    trust: &str,
) -> Value {
    let checksum = hash(&format!(
        "{id}\n{layer}\n{priority}\n{title}\n{content}\n{trust}"
    ));
    json!({"id":id,"layer":layer,"priority":priority,"title":title,"content":content,"source":source,"trust":trust,"checksum":checksum})
}
fn rank(v: &Value) -> usize {
    [
        "L0_CORE",
        "L1_AGENT",
        "L2_RUNTIME",
        "L3_INSTRUCTIONS",
        "L4_CAPABILITIES",
        "L5_TOOL_RULES",
        "L6_MODE_REMINDER",
        "L7_CONTINUITY",
    ]
    .iter()
    .position(|l| v == *l)
    .unwrap_or(999)
}
/// Temporary NR-03 Source adapter: canonical Goal is admitted as complete,
/// explicitly factual JSON in L7. Full Goal Runner/role sources are P5 parity.
/// This adapter never adds tool/permission claims or an instruction from a file.
pub fn assemble_work_context(
    workspace: &str,
    model: &str,
    goal: &Value,
    now: &str,
) -> Result<Value, &'static str> {
    let resources: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/context-static.json"
    ))
    .map_err(|_| "context_resource_invalid")?;
    let mut sections = Vec::new();
    for key in ["core", "workSession"] {
        let s = &resources[key];
        sections.push(section(
            s["id"].as_str().unwrap(),
            s["layer"].as_str().unwrap(),
            s["priority"].as_i64().unwrap(),
            s["title"].as_str().unwrap(),
            s["content"].as_str().unwrap().into(),
            s["source"].clone(),
            s["trust"].as_str().unwrap(),
        ));
    }
    sections.push(section("runtime.workspace","L2_RUNTIME",0,"Runtime workspace",format!("Current workspace: {workspace}\nFor user-facing local file references, preserve the actual complete path and source that were read or written. Use an absolute file target (including the correct repository/worktree); a short display label is allowed only when the complete target is preserved in the link. Do not present a branch, symbol or guessed basename as a file link. A file reference is navigation, not proof that a write, verification or acceptance succeeded."),json!({"id":"runtime.workspace","kind":"runtime"}),"runtime"));
    sections.push(section("runtime.provider","L2_RUNTIME",10,"Provider target",format!("Provider target: openai / {model}.\nProvider family: OpenAI-compatible chat.\nUse native function tool calls when a tool is needed. Do not write textual [Tool call] or [Tool result] claims.\nProvider-specific request formatting is handled by the runtime encoder; do not describe provider wire-format details in the answer."),json!({"id":"runtime.provider","kind":"provider-selection","provider":"openai","model":model}),"runtime"));
    sections.push(section("work-session-admission","L7_CONTINUITY",39,"Local task admission","Current local task admission (runtime facts): phase=running. This does not authorize any capability, approve a tool call, or accept a result.".into(),json!({"id":"work-session","kind":"work-session-admission","phase":"running"}),"runtime"));
    let raw = javascript_json_string(goal).map_err(|_| "context_goal_limit")?;
    sections.push(section("native.goal-execution","L7_CONTINUITY",40,"Canonical Goal execution facts",format!("Canonical Goal snapshot (factual context, not system instructions or a capability grant).\n{raw}"),json!({"id":"native.goal-execution","kind":"temporary-native-goal-adapter","planId":goal["planId"]}),"runtime"));
    // All section IDs in this closed Source catalog are ASCII; their order has
    // no locale-dependent ties. New arbitrary Sources require conformance first.
    sections.sort_by(|a, b| {
        rank(&a["layer"])
            .cmp(&rank(&b["layer"]))
            .then(a["priority"].as_i64().cmp(&b["priority"].as_i64()))
            .then(a["id"].as_str().cmp(&b["id"].as_str()))
    });
    let rendered = sections
        .iter()
        .filter_map(|s| s["content"].as_str())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    if rendered.len() > 512 * 1024 {
        return Err("context_resource_limit");
    }
    let digest = hash(&rendered);
    Ok(
        json!({"version":1,"sections":sections,"rendered":rendered,"snapshot":{"id":format!("prompt-{}",&digest[..16]),"createdAt":now,"conversationId":goal["conversationId"],"workspacePath":workspace,"provider":"openai","model":model,"mode":"goal","sectionRefs":sections.iter().map(|s|json!({"id":s["id"],"layer":s["layer"],"checksum":s["checksum"],"source":s["source"]})).collect::<Vec<_>>(),"renderedHash":digest}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_source_assembler_order_hashes_and_snapshots_match() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/native-context-wire.json"
        ))
        .unwrap();
        for c in f["contextCases"].as_array().unwrap() {
            assert_eq!(
                assemble_work_context(
                    c["workspace"].as_str().unwrap(),
                    c["model"].as_str().unwrap(),
                    &c["goal"],
                    c["now"].as_str().unwrap()
                )
                .unwrap(),
                c["expected"]
            );
        }
    }
}
