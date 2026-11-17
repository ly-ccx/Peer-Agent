//! Existing ordinary default Sources, with real Host observations. No worker
//! rules, fake Goal, capability execution or ad hoc instruction injection.
use super::*;
use crate::providers::RuntimeMode;
pub struct ConversationContext<'a> {
    pub conversation: &'a str,
    pub workspace: &'a str,
    pub provider: &'a str,
    pub model: &'a str,
    pub mode: RuntimeMode,
    pub effort: &'a str,
    pub registry_path: &'a str,
    pub servers: &'a [Value],
    pub instructions: &'a instructions::ProjectInstructions,
}
pub fn assemble_conversation_context(
    input: &ConversationContext<'_>,
    continuity: &[Value],
    at: &str,
) -> Result<Value, &'static str> {
    if !matches!(
        input.mode,
        RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
    ) {
        return Err("native_context_mode_unsupported");
    }
    let resource: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/ordinary-context-static.json"
    ))
    .map_err(|_| "context_resource_invalid")?;
    let mode = input.mode.as_str();
    let effort = if ["low", "default", "high", "xhigh", "max"].contains(&input.effort) {
        input.effort
    } else {
        "default"
    };
    let catalog = &resource["modes"][mode];
    let mut sections = catalog["sections"]
        .as_array()
        .ok_or("context_resource_invalid")?
        .clone();
    sections.extend(runtime_sections(
        input.workspace,
        input.provider,
        input.model,
    ));
    sections.extend(input.instructions.sections());
    if let Some(section) = continuity::render(continuity) {
        sections.push(section);
    }
    let mut reminder = catalog["reminder"]["content"]
        .as_str()
        .ok_or("context_resource_invalid")?
        .to_owned();
    if effort != "default" {
        reminder.push_str(&format!("\nReasoning effort: {}.", effort));
    }
    reminder.push_str(&format!(
        "\nProvider target: {} / {}.",
        input.provider, input.model
    ));
    let mut source = catalog["reminder"]["source"].clone();
    source["effort"] = json!(effort);
    source["provider"] = json!(input.provider);
    source["model"] = json!(input.model);
    sections.push(section(
        "runtime.mode",
        "L6_MODE_REMINDER",
        0,
        "Mode reminder",
        reminder,
        source,
        "runtime",
    ));
    let mcp = &resource["mcp"];
    let servers = input.servers.iter().take(40).collect::<Vec<_>>();
    let mut content = format!(
        "{}Your MCP registry lives at: {}{}",
        mcp["prefix"].as_str().ok_or("context_resource_invalid")?,
        input.registry_path,
        mcp["middle"].as_str().ok_or("context_resource_invalid")?
    );
    if servers.is_empty() {
        content.push_str("Installed MCP servers in your own registry: none yet.");
    } else {
        content.push_str(&format!(
            "Installed MCP servers in your own registry ({}):",
            servers.len()
        ));
        for server in &servers {
            let id = server["id"].as_str().unwrap_or("");
            let name = server["displayName"]
                .as_str()
                .filter(|s| !s.is_empty())
                .or_else(|| server["name"].as_str())
                .filter(|s| !s.is_empty())
                .unwrap_or(if id.is_empty() { "(unnamed)" } else { id });
            let transport = server["transport"].as_str().unwrap_or("unknown");
            let count = server["toolsCount"]
                .as_f64()
                .filter(|n| n.is_finite())
                .unwrap_or(0.0);
            let count = peer_protocol::javascript_json_string(&json!(count))
                .map_err(|_| "context_resource_invalid")?;
            content.push_str(&format!(
                "\n- {name} (id={}; {}; transport={transport}; tools={count})",
                if id.is_empty() { "unknown" } else { id },
                if server["enabled"] == false {
                    "disabled"
                } else {
                    "enabled"
                }
            ));
        }
    }
    content.push_str(mcp["suffix"].as_str().ok_or("context_resource_invalid")?);
    let base = &mcp["section"];
    let mut source = base["source"].clone();
    source["serverCount"] = json!(servers.len());
    sections.push(section(
        "agent.mcp-host",
        "L1_AGENT",
        1,
        "MCP host self-awareness",
        content,
        source,
        "builtin",
    ));
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
        json!({"version":1,"sections":sections,"rendered":rendered,"snapshot":{"id":format!("prompt-{}",&digest[..16]),"createdAt":at,"conversationId":input.conversation,"workspacePath":input.workspace,"provider":input.provider,"model":input.model,"mode":mode,"sectionRefs":sections.iter().map(|s|json!({"id":s["id"],"layer":s["layer"],"checksum":s["checksum"],"source":s["source"]})).collect::<Vec<_>>(),"renderedHash":digest}}),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn ordinary_source_sections_hashes_and_snapshots_match_actual_ts_default_registry() {
        let resource: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/ordinary-context.json"
        ))
        .unwrap();
        for c in resource["cases"].as_array().unwrap() {
            let input = ConversationContext {
                conversation: c["conversation"].as_str().unwrap(),
                workspace: c["workspace"].as_str().unwrap(),
                provider: c["provider"].as_str().unwrap(),
                model: c["model"].as_str().unwrap(),
                mode: c["mode"].as_str().unwrap().parse().unwrap(),
                effort: c["effort"].as_str().unwrap(),
                registry_path: c["registryPath"].as_str().unwrap(),
                servers: c["servers"].as_array().unwrap(),
                instructions: &instructions::ProjectInstructions::default(),
            };
            assert_eq!(
                assemble_conversation_context(&input, &[], c["now"].as_str().unwrap()).unwrap(),
                c["expected"],
                "{} {} {}",
                c["mode"],
                c["provider"],
                c["effort"]
            );
        }
    }
}
