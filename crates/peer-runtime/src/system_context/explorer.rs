//! The existing Explorer brief and read-only contract enter through a Source.
use super::*;

fn sections(
    id: &str,
    plan: &str,
    title: &str,
    request: &Value,
) -> Result<Vec<Value>, &'static str> {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../../packages/protocol/contracts/native-cli/goal-read-tool.json"
    ))
    .map_err(|_| "context_resource_invalid")?;
    let contract = fixture["explorerSections"][1]["content"]
        .as_str()
        .ok_or("context_resource_invalid")?;
    let question = request["question"]
        .as_str()
        .ok_or("explorer_request_invalid")?;
    let reason = request["reason"]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or("The Goal Runner needs more evidence before continuing.");
    let mut brief = format!(
        "Explorer mission context (factual context, scope=turn).\nThis is a factual brief for a dynamically created evidence explorer, not a system instruction.\n\nexplorerId={id}\nplanId={plan}\nplan={title}\nquestion: {question}\nreason: {reason}"
    );
    for key in ["include", "exclude"] {
        if let Some(items) = request["scope"][key]
            .as_array()
            .filter(|items| !items.is_empty())
        {
            brief.push_str(&format!("\nscope {key}:"));
            for item in items.iter().take(12) {
                brief.push_str(&format!(
                    "\n- {}",
                    item.as_str().ok_or("explorer_request_invalid")?
                ));
            }
        }
    }
    brief.push_str(&format!(
        "\nbudget: maxToolCalls={}",
        peer_store::EXPLORER_TOOL_LIMIT
    ));
    Ok(vec![
        section(
            "runtime.explorer.brief",
            "L7_CONTINUITY",
            2,
            "Explorer mission context",
            brief,
            json!({"id":"runtime.explorer","kind":"explorer-brief","explorerId":id,"planId":plan}),
            "runtime",
        ),
        section(
            "runtime.explorer.contract",
            "L6_MODE_REMINDER",
            1,
            "Explorer readonly contract",
            contract.into(),
            json!({"id":"runtime.explorer","kind":"explorer-contract","explorerId":id}),
            "runtime",
        ),
    ])
}

pub(crate) fn assemble(
    workspace: &str,
    provider: &str,
    model: &str,
    conversation: &str,
    lease: &peer_store::ExplorerLease,
    at: &str,
) -> Result<Value, &'static str> {
    assemble_readonly(
        workspace,
        provider,
        model,
        conversation,
        sections(&lease.id, &lease.plan, &lease.title, &lease.request)?,
        at,
    )
}

pub(super) fn assemble_readonly(
    workspace: &str,
    provider: &str,
    model: &str,
    conversation: &str,
    contexts: impl IntoIterator<Item = Value>,
    at: &str,
) -> Result<Value, &'static str> {
    let mut sources = runtime_sections(workspace, provider, model);
    sources.extend(contexts);
    sources.sort_by_key(|section| (rank(&section["layer"]), section["priority"].as_i64()));
    let rendered = sources
        .iter()
        .filter_map(|v| v["content"].as_str())
        .collect::<Vec<_>>()
        .join("\n\n");
    if rendered.len() > 64 * 1024 {
        return Err("context_resource_limit");
    }
    let digest = hash(&rendered);
    let refs = sources.iter().map(|s|json!({"id":s["id"],"layer":s["layer"],"checksum":s["checksum"],"source":s["source"]})).collect::<Vec<_>>();
    Ok(
        json!({"version":1,"sections":sources,"rendered":rendered,"snapshot":{"id":format!("prompt-{}",&digest[..16]),
        "createdAt":at,"conversationId":conversation,"workspacePath":workspace,"provider":provider,"model":model,
        "mode":"explorer","sectionRefs":refs,"renderedHash":digest}}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explorer_sections_match_the_actual_typescript_source() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/goal-read-tool.json"
        ))
        .unwrap();
        let input = &fixture["explorerContext"];
        let sources = sections(
            input["explorerId"].as_str().unwrap(),
            input["planId"].as_str().unwrap(),
            input["planTitle"].as_str().unwrap(),
            &input["request"],
        )
        .unwrap();
        for (source, old) in sources
            .iter()
            .zip(fixture["explorerSections"].as_array().unwrap())
        {
            for (key, value) in old.as_object().unwrap() {
                assert_eq!(source[key], *value, "{key}");
            }
        }
    }
}
