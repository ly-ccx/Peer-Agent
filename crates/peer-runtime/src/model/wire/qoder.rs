//! FREE_INPUT encoder; canonical history and capability projection stay owned
//! by their existing modules. This adapter only builds provider wire data.
use super::*;
mod messages;
mod schema;

fn fallback<'a>(value: &'a Value, key: &str, default: &'a str) -> &'a str {
    value[key]
        .as_str()
        .filter(|s| !s.is_empty())
        .unwrap_or(default)
}
pub(super) fn context(metadata: &Value, values: &Value) -> (Value, Option<Value>) {
    let window = metadata
        .get("contextWindow")
        .cloned()
        .unwrap_or(Value::Null);
    let definition = metadata["modelOptions"].as_array().and_then(|a| {
        a.iter()
            .find(|v| v["id"] == "contextTier" && v["kind"] == "select")
    });
    let Some(choices) = definition.and_then(|d| d["choices"].as_array()) else {
        return (window, None);
    };
    let requested = values["contextTier"].as_str();
    let choice = requested
        .and_then(|r| choices.iter().find(|v| v["value"] == r))
        .or_else(|| {
            choices
                .iter()
                .find(|v| v["value"] == definition.unwrap()["defaultValue"])
        })
        .or_else(|| choices.first());
    let Some(choice) = choice else {
        return (window, None);
    };
    let context = choice
        .get("contextWindow")
        .filter(|v| !v.is_null())
        .cloned()
        .unwrap_or(window);
    let tier = choice
        .get("requestValue")
        .filter(|v| !v.is_null())
        .or_else(|| choice.get("value"))
        .cloned();
    (context, tier)
}
pub(super) fn encode(input: &WireInput<'_>) -> Result<Value, ModelError> {
    if input.options.qoder_dialect == QoderDialect::Legacy {
        return legacy(input);
    }
    let empty = json!({});
    let metadata = input.options.qoder_metadata.as_ref().unwrap_or(&empty);
    let values = input.options.model_option_values.as_ref().unwrap_or(&empty);
    let (window, tier) = context(metadata, values);
    let raw = input.options.effort.trim().to_lowercase();
    let effort = if raw.is_empty() || raw == "default" {
        metadata["reasoningDefaultEffort"]
            .as_str()
            .unwrap_or("")
            .trim()
            .to_lowercase()
    } else {
        raw
    };
    let effort = if matches!(effort.as_str(), "off" | "none") {
        "none"
    } else {
        &effort
    };
    let reasoning =
        metadata["supportsReasoning"] == true || (!effort.is_empty() && effort != "none");
    let normalized = messages::normalize(input.messages)?;
    let text = normalized
        .iter()
        .rev()
        .find(|m| m["role"] == "user")
        .map(|m| messages::text(&m["content"]))
        .unwrap_or_default();
    let mut messages = normalized
        .into_iter()
        .filter(|v| v["role"] != "system")
        .collect::<Vec<_>>();
    // The existing assembler supplies the single admitted System Context.
    if !input.system.is_empty() {
        messages.insert(0, json!({"role":"system","content":input.system}));
    }
    let model = if input.model.trim().is_empty() || input.model.trim().eq_ignore_ascii_case("auto")
    {
        "auto"
    } else {
        input.model.trim()
    };
    let key = fallback(metadata, "id", model);
    let mut parameters = json!({});
    if let Some(n) = token_limit(input.options.max_output_tokens) {
        parameters["max_tokens"] = token_json(n);
    }
    if !effort.is_empty() {
        parameters["reasoning_effort"] = json!(effort);
    }
    let mut model_config = json!({"key":key,"display_name":fallback(metadata,"label",key),"model":"","format":fallback(metadata,"format","openai"),"is_vl":metadata["supportsVision"]==true,"is_reasoning":reasoning,"api_key":"","url":"","source":fallback(metadata,"source","system"),"max_input_tokens":if numeric(&window).is_some_and(|n|n!=0.0){window}else{json!(200000)}});
    if let Some(tier) = tier {
        model_config["contextTier"] = tier;
    }
    let id = uuid::Uuid::new_v4().to_string();
    Ok(json!({
        "request_id":id,"request_set_id":id,"chat_record_id":id,"session_id":uuid::Uuid::new_v4().to_string(),"stream":true,"chat_task":"FREE_INPUT",
        "chat_context":{"text":text,"features":[],"extra":{"context":[],"modelConfig":{"key":key,"is_reasoning":reasoning},"originalContent":text},"chatPrompt":"","imageUrls":null},
        "is_reply":true,"is_retry":false,"source":1,"version":"3","agent_id":"agent_common","task_id":"peer-agent",
        "session_type":input.options.qoder_session_type.as_deref().filter(|v|!v.is_empty()).unwrap_or("qodercli"),"aliyun_user_type":"",
        "model_config":model_config,"custom_model":null,"system":input.system,"messages":messages,"tools":schema::tools(input.tools),"parameters":parameters,"business":{}
    }))
}

fn legacy(input: &WireInput<'_>) -> Result<Value, ModelError> {
    let mut messages = vec![json!({"role":"system","content":input.system})];
    messages.extend_from_slice(input.messages);
    let id = uuid::Uuid::new_v4().to_string();
    let model = if input.model.trim().is_empty() || input.model.trim().eq_ignore_ascii_case("auto")
    {
        "auto"
    } else {
        input.model.trim()
    };
    let mut body = json!({
        "model":model,"messages":messages::normalize(&messages)?,"stream":true,"stream_options":{"include_usage":true},"tools":schema::tools(input.tools),
        "metadata":{"context":{"request_id":id,"request_set_id":id,"session_id":uuid::Uuid::new_v4().to_string(),"task_id":"peer-agent","client_type":"5"}}
    });
    if let Some(n) = token_limit(input.options.max_output_tokens) {
        body["max_tokens"] = token_json(n);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn legacy_requests_match_actual_ts_without_encoding_or_prepared_only_fields() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/qoder-legacy.json"
        ))
        .unwrap();
        for case in data["cases"].as_array().unwrap() {
            let i = &case["input"];
            let mut options: GenerationOptions = serde_json::from_value(i.clone()).unwrap();
            options.qoder_dialect = QoderDialect::Legacy;
            let mut body = encode(&WireInput {
                model: i["model"].as_str().unwrap(),
                system: i["system"].as_str().unwrap(),
                stable_system: None,
                messages: i["messages"].as_array().unwrap(),
                tools: i["tools"].as_array().map(Vec::as_slice),
                options: &options,
            })
            .unwrap();
            assert_eq!(
                body["metadata"]["context"]["request_id"],
                body["metadata"]["context"]["request_set_id"]
            );
            for key in ["request_id", "request_set_id", "session_id"] {
                assert!(
                    uuid::Uuid::parse_str(body["metadata"]["context"][key].as_str().unwrap())
                        .is_ok()
                );
                body["metadata"]["context"][key] =
                    case["expected"]["metadata"]["context"][key].clone();
            }
            assert_eq!(body, case["expected"]);
        }
    }
    #[test]
    fn qoder_builder_matches_actual_ts_history_schema_effort_and_context_vectors() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/qoder-requests.json"
        ))
        .unwrap();
        for (index, case) in data["requests"].as_array().unwrap().iter().enumerate() {
            let i = &case["input"];
            let mut options: GenerationOptions = serde_json::from_value(i.clone()).unwrap();
            options.qoder_metadata = (!i["metadata"].is_null()).then(|| i["metadata"].clone());
            let mut body = encode(&WireInput {
                model: i["model"].as_str().unwrap(),
                system: i["system"].as_str().unwrap(),
                stable_system: None,
                messages: i["messages"].as_array().unwrap(),
                tools: i["tools"].as_array().map(Vec::as_slice),
                options: &options,
            })
            .unwrap();
            assert!(uuid::Uuid::parse_str(body["request_id"].as_str().unwrap()).is_ok());
            assert_eq!(body["request_id"], body["request_set_id"]);
            assert_eq!(body["request_id"], body["chat_record_id"]);
            assert_ne!(body["session_id"], body["request_id"]);
            for key in [
                "request_id",
                "request_set_id",
                "chat_record_id",
                "session_id",
            ] {
                body[key] = case["expected"][key].clone();
            }
            assert_eq!(body, case["expected"], "actual TS case {index}");
        }
    }
}
