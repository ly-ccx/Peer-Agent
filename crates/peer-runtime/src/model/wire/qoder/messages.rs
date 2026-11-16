use super::*;
use std::collections::HashSet;
pub(super) fn text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|p| {
                p.as_str()
                    .or_else(|| p["text"].as_str())
                    .or_else(|| p["content"].as_str())
            })
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(_) => v.to_string(),
        _ => String::new(),
    }
}
fn has_content(v: &Value) -> bool {
    match v {
        Value::String(s) => !s.trim().is_empty(),
        Value::Array(a) => a.iter().any(|p| {
            p.is_object()
                && (p["type"] != "text" || p["text"].as_str().is_some_and(|s| !s.trim().is_empty()))
        }),
        _ => false,
    }
}
fn part(v: &Value) -> Option<Value> {
    if let Some(s) = v.as_str() {
        return Some(json!({"type":"text","text":s}));
    }
    match v["type"].as_str() {
        Some("text") if v["text"].is_string() => Some(json!({"type":"text","text":v["text"]})),
        Some("image_url")
            if v["image_url"]["url"]
                .as_str()
                .is_some_and(|s| !s.is_empty()) =>
        {
            let mut url = json!({"url":v["image_url"]["url"]});
            if let Some(detail) = v["image_url"].get("detail").filter(|v| !v.is_null()) {
                url["detail"] = detail.clone();
            }
            Some(json!({"type":"image_url","image_url":url}))
        }
        Some("tool_use") => Some(
            json!({"type":"text","text":format!("[tool_use {}{}] {}",v["name"].as_str().unwrap_or("tool"),v["id"].as_str().filter(|s|!s.is_empty()).map(|s|format!(" {s}")).unwrap_or_default(),v.get("input").filter(|v|v.is_object()||v.is_array()).unwrap_or(&json!({})))}),
        ),
        Some("tool_result") => Some(
            json!({"type":"text","text":format!("[tool_result{}] {}",v["tool_use_id"].as_str().filter(|s|!s.is_empty()).map(|s|format!(" {s}")).unwrap_or_default(),text(&v["content"]))}),
        ),
        _ => v["content"]
            .as_str()
            .map(|s| json!({"type":"text","text":s})),
    }
}
fn message(v: Value) -> Value {
    let mut out = json!({"role":v["role"],"content":match &v["content"] {
        Value::String(s)=>json!(s),Value::Array(a)=>{let parts:Vec<_>=a.iter().filter_map(part).collect();if parts.is_empty(){json!("")}else{json!(parts)}},Value::Object(_)=>part(&v["content"]).map(|p|json!([p])).unwrap_or(json!("")),_=>json!("")
    }});
    if out["role"] == "user" || out["role"] == "assistant" {
        out["contents"] = match &out["content"] {
            Value::String(s) if !s.trim().is_empty() => json!([{"type":"text","text":s}]),
            Value::Array(a) => json!(
                a.iter()
                    .filter_map(|p| match p["type"].as_str() {
                        Some("text")
                            if p["text"].as_str().is_some_and(|s| !s.trim().is_empty()) =>
                            Some(p.clone()),
                        Some("image_url") => Some(
                            json!({"type":"image_url","image_url":{"url":p["image_url"]["url"]}})
                        ),
                        _ => None,
                    })
                    .collect::<Vec<_>>()
            ),
            _ => json!([]),
        };
    }
    for key in ["name", "tool_call_id", "tool_calls"] {
        if let Some(value) = v.get(key) {
            out[key] = value.clone();
        }
    }
    out
}
pub(super) fn normalize(messages: &[Value]) -> Result<Vec<Value>, ModelError> {
    let result_ids: HashSet<_> = messages
        .iter()
        .filter(|m| m["role"] == "tool")
        .filter_map(|m| m["tool_call_id"].as_str())
        .collect();
    let mut declared = HashSet::new();
    let mut paired = Vec::new();
    for (index, m) in messages.iter().enumerate() {
        if m["role"] == "tool" {
            if m["tool_call_id"]
                .as_str()
                .is_some_and(|id| declared.contains(id))
            {
                paired.push(m.clone());
            }
            continue;
        }
        if m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|a| !a.is_empty()) {
            let mut m = m.clone();
            let calls: Vec<_> = m["tool_calls"]
                .as_array()
                .unwrap()
                .iter()
                .filter(|c| {
                    c["id"].as_str().is_some_and(|id| {
                        !id.is_empty() && (result_ids.contains(id) || index + 1 == messages.len())
                    })
                })
                .cloned()
                .collect();
            for call in &calls {
                declared.insert(call["id"].as_str().unwrap().to_owned());
            }
            if calls.is_empty() {
                m.as_object_mut().unwrap().remove("tool_calls");
                if !has_content(&m["content"]) {
                    continue;
                }
            } else {
                m["tool_calls"] = json!(calls);
            }
            paired.push(m);
            continue;
        }
        paired.push(m.clone());
    }
    let mut merged: Vec<Value> = Vec::new();
    for mut m in paired {
        if m["role"] == "assistant" && merged.last().is_some_and(|p| p["role"] == "assistant") {
            let previous = merged.pop().unwrap();
            let joined = [text(&previous["content"]), text(&m["content"])]
                .into_iter()
                .filter(|s| !s.trim().is_empty())
                .collect::<Vec<_>>()
                .join("\n\n");
            let calls: Vec<_> = [&previous, &m]
                .iter()
                .flat_map(|v| v["tool_calls"].as_array().into_iter().flatten())
                .cloned()
                .collect();
            let mut value = previous.clone();
            value
                .as_object_mut()
                .unwrap()
                .extend(m.as_object().unwrap().clone());
            if !calls.is_empty() {
                value["tool_calls"] = json!(calls);
                value["content"] = json!(joined);
            } else if !joined.is_empty() {
                value["content"] = json!(joined);
            }
            m = value;
        }
        if let Some(calls) = m["tool_calls"].as_array() {
            let calls:Vec<_>=calls.iter().enumerate().filter_map(|(i,c)| {
                let name=c["function"]["name"].as_str().or_else(||c["name"].as_str())?.trim();if name.is_empty(){return None;}
                let args=c["function"].get("arguments").or_else(||c.get("arguments")).or_else(||c.get("input")).unwrap_or(&Value::Null);
                let args=match args {Value::String(s) if s.trim().is_empty()=>json!({}),Value::String(s)=>serde_json::from_str(s.trim()).unwrap_or_else(|_|json!({"raw_arguments":s})),Value::Object(_)|Value::Array(_)=>args.clone(),_=>json!({})};
                Some(json!({"id":c["id"].as_str().filter(|s|!s.is_empty()).map(str::to_owned).unwrap_or_else(||format!("qoder_history_tool_{}",i+1)),"type":"function","function":{"name":name,"arguments":args.to_string()}}))
            }).collect();
            m.as_object_mut().unwrap().remove("tool_calls");
            if !calls.is_empty() {
                m["tool_calls"] = json!(calls);
            }
        }
        let out = message(m);
        if out["role"] == "user" && !has_content(&out["content"]) && out["tool_calls"].is_null() {
            continue;
        }
        if ["system", "user", "assistant", "tool"]
            .iter()
            .any(|r| out["role"] == *r)
        {
            merged.push(out);
        }
    }
    // Regenerate contents after merging the raw assistant text/call objects.
    Ok(merged.into_iter().map(message).collect())
}
