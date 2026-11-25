//! Live CLI dialects, retaining canonical/history lowering from the shared wire.
use super::*;
/// CLI defaults live at the wire seam rather than in the HTTP transport.
pub(crate) fn encode(wire: Wire, input: &WireInput<'_>) -> Result<Value, ModelError> {
    if input.options.chat_dialect == ChatDialect::Environment {
        if wire != Wire::Chat {
            return Err(ModelError::new("model_environment_wire_invalid"));
        }
        return super::environment::encode(input);
    }
    let mut body = super::encode(wire, input)?;
    if wire == Wire::Chat
        && input
            .options
            .reasoning_param_style
            .as_deref()
            .unwrap_or("openai-effort")
            == "openai-effort"
    {
        body.as_object_mut().unwrap().remove("reasoning_effort");
        let o = input.options;
        if o.supports_reasoning && !o.effort.is_empty() {
            let mapped = if let Some(map) = &o.reasoning_effort_map {
                map.get(&o.effort)
                    .or_else(|| {
                        if o.effort == "default" {
                            map.get("medium")
                        } else {
                            None
                        }
                    })
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(|s| json!(s))
            } else if o.effort != "off" {
                Some(effort(o, false))
            } else {
                None
            };
            if let Some(value) = mapped {
                body["reasoning_effort"] = value;
            }
        }
    }
    if wire == Wire::Responses {
        body["tool_choice"] = json!("auto");
        body["parallel_tool_calls"] = json!(true);
        // The live CLI uses the Desktop Responses encoder's newer effort
        // semantics: declared maps are authoritative, including mapped off.
        body.as_object_mut().unwrap().remove("reasoning");
        let o = input.options;
        if o.supports_reasoning
            && o.reasoning_param_style
                .as_deref()
                .unwrap_or("openai-effort")
                == "openai-effort"
            && !o.effort.is_empty()
        {
            let mapped = if let Some(map) = &o.reasoning_effort_map {
                if o.effort == "default" {
                    map.get("default")
                        .filter(|v| !v.is_null())
                        .or_else(|| map.get("medium"))
                } else {
                    map.get(&o.effort)
                }
                .cloned()
            } else if o.effort != "off" {
                Some(effort(o, false))
            } else {
                None
            };
            if let Some(value) =
                mapped.filter(|v| !v.is_null() && v != "" && v != &json!(false) && v != &json!(0))
            {
                body["reasoning"] = json!({"effort":value});
            }
        }
        if o.fast_mode {
            body["service_tier"] = json!("priority");
        }
        if o.auth_method.as_deref() == Some("oauth_grok") {
            body.as_object_mut().unwrap().remove("reasoning");
            if !o.effort.is_empty() && !matches!(o.effort.as_str(), "off" | "default") {
                body["reasoning"] = json!({"effort":o.effort});
            }
        }
        if matches!(
            o.auth_method.as_deref(),
            Some("oauth_chatgpt" | "oauth_grok")
        ) && o.effort == "default"
        {
            body.as_object_mut().unwrap().remove("reasoning");
        }
    }
    check_limit(&body)?;
    Ok(body)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_fields_cannot_expand_a_valid_shared_request_past_the_wire_limit() {
        let options = GenerationOptions::default();
        let mut input = WireInput {
            model: "model",
            system: "x",
            stable_system: None,
            messages: &[],
            tools: None,
            options: &options,
        };
        let overhead = serde_json::to_vec(&super::super::encode(Wire::Responses, &input).unwrap())
            .unwrap()
            .len();
        let system = "x".repeat(2 * 1024 * 1024 - overhead + 1);
        input.system = &system;
        assert_eq!(
            serde_json::to_vec(&super::super::encode(Wire::Responses, &input).unwrap())
                .unwrap()
                .len(),
            2 * 1024 * 1024
        );
        assert_eq!(
            encode(Wire::Responses, &input).err().unwrap().code,
            "model_request_limit"
        );
    }
}
