use super::*;
pub(super) fn encode(i: &WireInput<'_>) -> Result<Value, ModelError> {
    let messages = messages_with_system(i)?;
    let mut instructions = vec![];
    let mut input = vec![];
    for m in messages {
        if m["role"] == "system" {
            if let Some(s) = m["content"].as_str().filter(|s| !s.is_empty()) {
                instructions.push(s.to_owned());
            }
            continue;
        }
        if m["role"] == "tool" {
            input.push(json!({"type":"function_call_output","call_id":m["tool_call_id"],"output":result_text(&m["content"])?}));
            continue;
        }
        if m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|a| !a.is_empty()) {
            if let Some(text) = m["content"].as_str().filter(|s| !s.is_empty()) {
                input.push(
                    json!({"role":"assistant","content":[{"type":"output_text","text":text}]}),
                );
            }
            for c in m["tool_calls"].as_array().unwrap() {
                let name = c["function"]["name"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .map(|c| {
                        if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                            c
                        } else {
                            '_'
                        }
                    })
                    .collect::<String>();
                let mut item = json!({"type":"function_call","call_id":c["id"],"name":if name.is_empty(){"tool"}else{&name},"arguments":c["function"].get("arguments").filter(|v|!v.is_null()).cloned().unwrap_or(json!(""))});
                if c.get("id").is_none() {
                    item.as_object_mut().unwrap().remove("call_id");
                }
                input.push(item);
            }
            continue;
        }
        let role = if m["role"] == "assistant" {
            "assistant"
        } else {
            "user"
        };
        let kind = if role == "assistant" {
            "output_text"
        } else {
            "input_text"
        };
        let mut parts = vec![];
        if let Some(text) = m["content"].as_str() {
            parts.push(json!({"type":kind,"text":text}));
        } else if let Some(a) = m["content"].as_array() {
            for p in a {
                if p["type"] == "text" && p["text"].is_string() {
                    parts.push(json!({"type":kind,"text":p["text"]}));
                } else if p["type"] == "image_url"
                    && p["image_url"]["url"]
                        .as_str()
                        .is_some_and(|s| !s.is_empty())
                {
                    parts.push(json!({"type":"input_image","image_url":p["image_url"]["url"]}));
                } else if p["type"] == "input_image"
                    && p["image_url"].as_str().is_some_and(|s| !s.is_empty())
                {
                    parts.push(json!({"type":"input_image","image_url":p["image_url"]}));
                }
            }
        }
        if !parts.is_empty() {
            input.push(json!({"role":role,"content":parts}));
        }
    }
    let mut body = json!({"model":i.model,"input":input,"stream":true,"store":false});
    if !instructions.is_empty() {
        body["instructions"] = instructions.join("\n\n").into();
    }
    if let Some(tools) = i.tools {
        body["tools"]=json!(tools.iter().filter_map(|t|{
        let f=t.get("function").unwrap_or(t);if f["name"].as_str().is_none_or(str::is_empty){return None;}
        let mut t=json!({"type":"function","name":f["name"],"strict":f["strict"].as_bool().unwrap_or(false)});
        for k in ["description","parameters"] {if let Some(v)=f.get(k){t[k]=v.clone();}}Some(t)
    }).collect::<Vec<_>>());
    }
    let o = i.options;
    if !o.omit_max_output_tokens
        && let Some(n) = token_limit(o.max_output_tokens)
    {
        body["max_output_tokens"] = token_json(n);
    }
    if o.supports_reasoning
        && o.reasoning_param_style
            .as_deref()
            .unwrap_or("openai-effort")
            == "openai-effort"
        && !o.effort.is_empty()
        && o.effort != "off"
    {
        let mapped = o
            .reasoning_effort_map
            .as_ref()
            .and_then(|m| {
                if o.effort == "default" {
                    m.get("default")
                        .filter(|v| !v.is_null())
                        .or_else(|| m.get("medium"))
                } else {
                    m.get(&o.effort)
                }
            })
            .filter(|v| !v.is_null());
        body["reasoning"] = json!({"effort":mapped.cloned().unwrap_or_else(||effort(o,false))});
    }
    Ok(body)
}
