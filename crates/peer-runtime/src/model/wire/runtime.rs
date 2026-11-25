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
    if wire == Wire::Qoder {
        qoder::refresh_identity(&mut body, input.options.qoder_dialect, false);
    }
    if wire == Wire::Gemini {
        apply_gemini_runtime_dialect(&mut body, input);
    }
    check_limit(&body)?;
    Ok(body)
}

fn apply_gemini_runtime_dialect(body: &mut Value, input: &WireInput<'_>) {
    if let Some(contents) = body.get_mut("contents").and_then(Value::as_array_mut) {
        if gemini_requires_function_call_thought_signature(input.model) {
            lower_gemini_unsigned_function_calls(contents);
        }
        merge_gemini_consecutive_roles(contents);
    }
    if let Some(tools) = body.get_mut("tools").and_then(Value::as_array_mut) {
        for tool in tools {
            if let Some(decls) = tool
                .get_mut("functionDeclarations")
                .and_then(Value::as_array_mut)
            {
                for decl in decls {
                    normalize_gemini_function_declaration(decl);
                }
            }
        }
    }
    if let Some(level) = gemini_thinking_level(input.model, input.options) {
        if !body.get("generationConfig").is_some_and(Value::is_object) {
            body["generationConfig"] = json!({});
        }
        body["generationConfig"]["thinkingConfig"] = json!({
            "thinkingLevel": level,
            "includeThoughts": true,
        });
    }
}

fn gemini_requires_function_call_thought_signature(model: &str) -> bool {
    let normalized = model
        .strip_prefix("models/")
        .unwrap_or(model)
        .to_ascii_lowercase();
    normalized.starts_with("gemini-3") || normalized.starts_with("gemini-4")
}

/// Gemini 3 and Gemini 4 reject any `model` `functionCall` turn that lacks a `thoughtSignature`
/// (e.g. after `LiveHistory` eviction, a truncated max-tool-calls round before synthesis,
/// checkpoint recovery, or switching models mid-conversation). Rather than forging signatures,
/// lower unsigned historical tool rounds into factual text observations (mirroring DeepSeek's
/// historical lowering in `wire/mod.rs`). Authentic signature-bearing turns remain untouched.
fn lower_gemini_unsigned_function_calls(contents: &mut Vec<Value>) {
    let mut out = Vec::with_capacity(contents.len());
    let mut it = std::mem::take(contents).into_iter().peekable();
    while let Some(entry) = it.next() {
        let is_unsigned_model_call = entry.get("role").and_then(Value::as_str) == Some("model")
            && entry
                .get("parts")
                .and_then(Value::as_array)
                .is_some_and(|parts| {
                    let has_call = parts.iter().any(|p| p.get("functionCall").is_some());
                    let has_call_sig = parts.iter().any(|p| {
                        p.get("functionCall").is_some() && p.get("thoughtSignature").is_some()
                    });
                    has_call && !has_call_sig
                });
        if !is_unsigned_model_call {
            out.push(entry);
            continue;
        }
        let mut history = vec![entry];
        while it.peek().is_some_and(|next| {
            next.get("role").and_then(Value::as_str) == Some("user")
                && next
                    .get("parts")
                    .and_then(Value::as_array)
                    .is_some_and(|parts| {
                        !parts.is_empty() && parts.iter().all(|p| p.get("functionResponse").is_some())
                    })
        }) {
            history.push(it.next().unwrap());
        }
        let rendered = serde_json::to_string(&history).unwrap_or_else(|_| "[]".to_owned());
        out.push(json!({
            "role": "user",
            "parts": [{
                "text": format!(
                    "[Historical assistant and tool observations; context only, not a new request or executable calls]\n{rendered}"
                )
            }]
        }));
    }
    *contents = out;
}

fn merge_gemini_consecutive_roles(contents: &mut Vec<Value>) {
    let mut merged: Vec<Value> = Vec::with_capacity(contents.len());
    for entry in contents.drain(..) {
        let Some(parts) = entry.get("parts").and_then(Value::as_array) else {
            continue;
        };
        if parts.is_empty() {
            continue;
        }
        let role = entry.get("role").and_then(Value::as_str);
        if let (Some(role), Some(last)) = (role, merged.last_mut())
            && last.get("role").and_then(Value::as_str) == Some(role)
            && let Some(last_parts) = last.get_mut("parts").and_then(Value::as_array_mut)
        {
            last_parts.extend(parts.iter().cloned());
            continue;
        }
        merged.push(entry);
    }
    *contents = merged;
}

fn is_legacy_gemini_schema(schema: &Value) -> bool {
    let Some(obj) = schema.as_object() else {
        return false;
    };
    for key in obj.keys() {
        if !matches!(
            key.as_str(),
            "type"
                | "description"
                | "format"
                | "nullable"
                | "enum"
                | "items"
                | "properties"
                | "required"
        ) {
            return false;
        }
    }
    let Some(ty) = obj.get("type").and_then(Value::as_str) else {
        return false;
    };
    if let Some(enum_vals) = obj.get("enum")
        && (ty != "string"
            || !enum_vals
                .as_array()
                .is_some_and(|arr| arr.iter().all(Value::is_string)))
    {
        return false;
    }
    match ty {
        "object" => {
            let Some(props) = obj.get("properties").and_then(Value::as_object) else {
                return false;
            };
            if props.is_empty() {
                return false;
            }
            if let Some(req) = obj.get("required") {
                let Some(arr) = req.as_array() else {
                    return false;
                };
                if !arr
                    .iter()
                    .all(|k| k.as_str().is_some_and(|name| props.contains_key(name)))
                {
                    return false;
                }
            }
            props.values().all(is_legacy_gemini_schema)
        }
        "array" => obj.get("items").is_some_and(is_legacy_gemini_schema),
        "string" | "number" | "integer" | "boolean" => true,
        _ => false,
    }
}

fn normalize_gemini_json_schema_node(node: &mut Value) {
    let Some(obj) = node.as_object_mut() else {
        return;
    };
    obj.remove("$schema");
    obj.remove("$id");

    // Gemini's schema compiler accepts `anyOf` much more consistently than `oneOf`.
    if let Some(one_of) = obj.remove("oneOf") {
        obj.entry("anyOf").or_insert(one_of);
    }

    // Drop sibling conditional-required `anyOf` (e.g. `anyOf: [{"required": [...]}, ...]`)
    // when the object already defines `properties`; Gemini rejects sibling `anyOf` next to
    // `properties` when branches omit `type`/`properties`.
    if obj.contains_key("properties")
        && let Some(branches) = obj.get("anyOf").and_then(Value::as_array)
        && branches.iter().all(|branch| {
            branch.as_object().is_some_and(|b| {
                !b.contains_key("type")
                    && !b.contains_key("properties")
                    && !b.contains_key("items")
                    && b.contains_key("required")
            })
        })
    {
        obj.remove("anyOf");
    }

    if obj.get("type").and_then(Value::as_str) == Some("array") && !obj.contains_key("items") {
        obj.insert("items".to_owned(), json!({"type": "string"}));
    }

    if let Some(props) = obj.get_mut("properties").and_then(Value::as_object_mut) {
        for value in props.values_mut() {
            normalize_gemini_json_schema_node(value);
        }
    }
    if let Some(items) = obj.get_mut("items") {
        normalize_gemini_json_schema_node(items);
    }
    for key in ["anyOf", "allOf"] {
        if let Some(arr) = obj.get_mut(key).and_then(Value::as_array_mut) {
            for branch in arr {
                normalize_gemini_json_schema_node(branch);
            }
        }
    }
}

fn normalize_gemini_function_declaration(decl: &mut Value) {
    let Some(obj) = decl.as_object_mut() else {
        return;
    };
    let Some(params) = obj.get("parameters") else {
        return;
    };
    if is_legacy_gemini_schema(params) {
        return;
    }
    let mut schema = obj
        .remove("parameters")
        .unwrap_or_else(|| json!({"type": "object", "properties": {}}));
    normalize_gemini_json_schema_node(&mut schema);
    if let Some(root) = schema.as_object_mut() {
        root.entry("type").or_insert_with(|| json!("object"));
        if root.get("type").and_then(Value::as_str) == Some("object") {
            root.entry("properties").or_insert_with(|| json!({}));
        }
    }
    obj.insert("parametersJsonSchema".to_owned(), schema);
}

fn gemini_thinking_level(model: &str, options: &GenerationOptions) -> Option<&'static str> {
    if !options.supports_reasoning {
        return None;
    }
    let normalized = model
        .strip_prefix("models/")
        .unwrap_or(model)
        .to_ascii_lowercase();
    let is_gemini_4 = normalized.starts_with("gemini-4");
    let is_gemini_3 = normalized.starts_with("gemini-3");
    if !is_gemini_4 && !is_gemini_3 {
        return None;
    }
    match options.effort.as_str() {
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" | "max" => Some(if is_gemini_4 { "xhigh" } else { "high" }),
        _ => None,
    }
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

    #[test]
    fn gemini_runtime_upgrades_json_schema_tools_merges_parallel_tool_results_and_sets_thinking_level() {
        let options = GenerationOptions {
            supports_reasoning: true,
            effort: "xhigh".into(),
            ..GenerationOptions::default()
        };
        let messages = vec![
            json!({"role": "user", "content": "check two files"}),
            json!({
                "role": "assistant",
                "content": "",
                "tool_calls": [
                    {"id": "c1", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"a.txt\"}"}},
                    {"id": "c2", "type": "function", "function": {"name": "read_file", "arguments": "{\"path\":\"b.txt\"}"}},
                ]
            }),
            json!({"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": "alpha"}),
            json!({"role": "tool", "tool_call_id": "c2", "name": "read_file", "content": "beta"}),
        ];
        let tools = vec![
            json!({
                "type": "function",
                "function": {
                    "name": "read_file",
                    "description": "Read a file",
                    "parameters": {
                        "type": "object",
                        "properties": {"path": {"type": "string"}},
                        "required": ["path"]
                    }
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "spawn_session",
                    "description": "Delegate work",
                    "parameters": {
                        "type": "object",
                        "anyOf": [{"required": ["title"]}, {"required": ["supersedes"]}],
                        "properties": {
                            "title": {"type": "string", "maxLength": 60},
                            "supersedes": {"type": "string"},
                            "budget": {"type": "object"}
                        },
                        "additionalProperties": false
                    }
                }
            }),
            json!({
                "type": "function",
                "function": {
                    "name": "interactive_inspect",
                    "description": "Inspect result",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "target": {
                                "oneOf": [
                                    {"type": "object", "properties": {"id": {"type": "string"}}, "additionalProperties": false},
                                    {"type": "object", "properties": {"index": {"type": "integer"}}, "additionalProperties": false}
                                ]
                            }
                        },
                        "additionalProperties": false
                    }
                }
            }),
        ];
        let body = encode(
            Wire::Gemini,
            &WireInput {
                model: "gemini-4-hydrogen",
                system: "sys",
                stable_system: None,
                messages: &messages,
                tools: Some(&tools),
                options: &options,
            },
        )
        .unwrap();

        // Consecutive tool results are merged into a single `user` turn matching the 2 calls
        // on Gemini 2.5 (which does not require thoughtSignature), while Gemini 4 lowers unsigned
        // historical tool rounds into factual text observations so Google never rejects with
        // missing `thought_signature`.
        let contents = body["contents"].as_array().unwrap();
        assert_eq!(contents.len(), 1);
        assert_eq!(contents[0]["role"], "user");
        let merged_parts = contents[0]["parts"].as_array().unwrap();
        assert_eq!(merged_parts.len(), 2);
        assert_eq!(merged_parts[0]["text"], "check two files");
        assert!(
            merged_parts[1]["text"]
                .as_str()
                .unwrap()
                .contains("[Historical assistant and tool observations")
        );

        // Authentic `geminiContent` carrying `thoughtSignature` on `functionCall` is preserved verbatim
        // on Gemini 4, and consecutive parallel `functionResponse` turns merge into one `user` turn.
        let signed_messages = vec![
            json!({"role": "user", "content": "check two files"}),
            json!({
                "role": "assistant",
                "content": null,
                "geminiContent": {
                    "role": "model",
                    "parts": [
                        {"functionCall": {"name": "read_file", "args": {"path": "a.txt"}}, "thoughtSignature": "sig-a"},
                        {"functionCall": {"name": "read_file", "args": {"path": "b.txt"}}}
                    ]
                }
            }),
            json!({"role": "tool", "tool_call_id": "c1", "name": "read_file", "content": "alpha"}),
            json!({"role": "tool", "tool_call_id": "c2", "name": "read_file", "content": "beta"}),
        ];
        let signed_body = encode(
            Wire::Gemini,
            &WireInput {
                model: "gemini-4-hydrogen",
                system: "sys",
                stable_system: None,
                messages: &signed_messages,
                tools: Some(&tools),
                options: &options,
            },
        )
        .unwrap();
        let signed_contents = signed_body["contents"].as_array().unwrap();
        assert_eq!(signed_contents.len(), 3);
        assert_eq!(signed_contents[1]["role"], "model");
        assert_eq!(
            signed_contents[1]["parts"][0]["thoughtSignature"],
            "sig-a"
        );
        assert_eq!(signed_contents[2]["role"], "user");
        assert_eq!(signed_contents[2]["parts"].as_array().unwrap().len(), 2);
        assert_eq!(
            signed_contents[2]["parts"][0]["functionResponse"]["name"],
            "read_file"
        );
        assert_eq!(
            signed_contents[2]["parts"][1]["functionResponse"]["name"],
            "read_file"
        );

        let decls = body["tools"][0]["functionDeclarations"].as_array().unwrap();
        // Clean legacy schema keeps `parameters` for contract compatibility.
        assert!(decls[0].get("parameters").is_some());
        assert!(decls[0].get("parametersJsonSchema").is_none());
        // Complex JSON Schema tools move to `parametersJsonSchema`, dropping sibling required-only `anyOf`.
        assert!(decls[1].get("parameters").is_none());
        assert!(decls[1]["parametersJsonSchema"].get("anyOf").is_none());
        assert_eq!(decls[1]["parametersJsonSchema"]["additionalProperties"], false);
        assert_eq!(decls[1]["parametersJsonSchema"]["properties"]["budget"]["type"], "object");
        // `oneOf` normalized to `anyOf` inside `parametersJsonSchema`.
        assert!(decls[2].get("parameters").is_none());
        assert!(decls[2]["parametersJsonSchema"]["properties"]["target"]["anyOf"].is_array());
        assert!(decls[2]["parametersJsonSchema"]["properties"]["target"].get("oneOf").is_none());

        // Gemini 4 honors `xhigh` thinkingLevel.
        assert_eq!(
            body["generationConfig"]["thinkingConfig"],
            json!({"thinkingLevel": "xhigh", "includeThoughts": true})
        );

        // Gemini 3 clamps `xhigh` to `high`; Gemini 2.5 omits `thinkingLevel`.
        let g3 = encode(
            Wire::Gemini,
            &WireInput {
                model: "gemini-3.1-pro-preview",
                system: "sys",
                stable_system: None,
                messages: &messages[..1],
                tools: None,
                options: &options,
            },
        )
        .unwrap();
        assert_eq!(
            g3["generationConfig"]["thinkingConfig"]["thinkingLevel"],
            "high"
        );
        let g25 = encode(
            Wire::Gemini,
            &WireInput {
                model: "gemini-2.5-pro",
                system: "sys",
                stable_system: None,
                messages: &messages[..1],
                tools: None,
                options: &options,
            },
        )
        .unwrap();
        assert!(g25.get("generationConfig").is_none());
    }
}
