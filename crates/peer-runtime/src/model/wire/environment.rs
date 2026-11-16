//! Adapter for the original standalone createOpenAICompatibleProvider wire.
//! Its off/default and history behavior differs from branded runtime channels.
use super::*;
pub(super) fn encode(input: &WireInput<'_>) -> Result<Value, ModelError> {
    let mut messages = messages_with_system(input)?;
    if input.system.is_empty() {
        messages.remove(0);
    }
    for message in &mut messages {
        if let Some(object) = message.as_object_mut() {
            object.remove("name");
        }
    }
    let mut body = json!({"model":input.model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    if let Some(tools) = input.tools.filter(|v| !v.is_empty()) {
        body["tools"] = json!(tools);
    }
    if !input.options.effort.is_empty() && input.options.effort != "default" {
        body["reasoning_effort"] = json!(input.options.effort);
    }
    if let Some(limit) = token_limit(input.options.max_output_tokens) {
        body["max_tokens"] = token_json(limit);
    }
    check_limit(&body)?;
    Ok(body)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_matches_actual_ts_environment_provider_including_off_and_default() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/model-catalog.json"
        ))
        .unwrap();
        for case in data["environmentRequests"].as_array().unwrap() {
            let options = GenerationOptions {
                effort: case["reasoningEffort"].as_str().unwrap().into(),
                chat_dialect: ChatDialect::Environment,
                ..Default::default()
            };
            let messages = vec![json!({"role":"user","content":"hello"})];
            let input = WireInput {
                model: "fixture-env",
                system: "",
                stable_system: None,
                messages: &messages,
                tools: None,
                options: &options,
            };
            assert_eq!(
                super::super::runtime::encode(Wire::Chat, &input).unwrap(),
                case["expected"]
            );
        }
    }
}
