use super::*;
use std::collections::HashSet;
fn history(messages: &[Value]) -> Result<Vec<Value>, ModelError> {
    let mut out = vec![];
    let mut pending = HashSet::new();
    let mut cursor = 0;
    while cursor < messages.len() {
        let m = &messages[cursor];
        cursor += 1;
        if m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|c| !c.is_empty()) {
            let mut content = blocks(&m["content"])?;
            pending.clear();
            for c in m["tool_calls"].as_array().unwrap() {
                let (Some(name), Some(id)) = (
                    c["function"]["name"].as_str().filter(|s| !s.is_empty()),
                    c["id"].as_str().filter(|s| !s.is_empty()),
                ) else {
                    continue;
                };
                pending.insert(id.to_owned());
                content.push(json!({"type":"tool_use","id":id,"name":name,"input":arguments(&c["function"]["arguments"])}));
            }
            let mut next = m.clone();
            next.as_object_mut().unwrap().remove("tool_calls");
            next["content"] = json!(content);
            out.push(next);
            continue;
        }
        if m["role"] == "tool" {
            let mut results = vec![];
            let mut unmatched = vec![];
            let start = cursor - 1;
            cursor = start;
            while cursor < messages.len() && messages[cursor]["role"] == "tool" {
                let m = &messages[cursor];
                cursor += 1;
                let id = m["tool_call_id"].as_str().unwrap_or("");
                let text = result_text(&m["content"])?;
                if !id.is_empty() && pending.remove(id) {
                    results.push(json!({"type":"tool_result","tool_use_id":id,"content":text}));
                } else {
                    unmatched.push(
                        [
                            "[Historical local tool result - unmatched; read-only context]".into(),
                            if id.is_empty() {
                                String::new()
                            } else {
                                format!("tool_call_id: {id}")
                            },
                            text,
                        ]
                        .into_iter()
                        .filter(|s| !s.is_empty())
                        .collect::<Vec<_>>()
                        .join("\n"),
                    );
                }
            }
            if !results.is_empty() {
                out.push(json!({"role":"user","content":results}));
            }
            for text in unmatched {
                out.push(json!({"role":"user","content":[{"type":"text","text":text}]}));
            }
            continue;
        }
        pending.clear();
        out.push(m.clone());
    }
    Ok(out)
}
fn mark_message(m: &mut Value) -> bool {
    if let Some(text) = m["content"].as_str().filter(|s| !s.trim().is_empty()) {
        m["content"] = json!([{"type":"text","text":text,"cache_control":{"type":"ephemeral"}}]);
        return true;
    }
    if let Some(a) = m["content"].as_array_mut() {
        for p in a.iter_mut().rev() {
            if p["type"] == "text" && p["text"].as_str().is_some_and(|s| !s.trim().is_empty()) {
                p["cache_control"] = json!({"type":"ephemeral"});
                return true;
            }
        }
    }
    false
}
pub(super) fn encode(i: &WireInput<'_>) -> Result<Value, ModelError> {
    let o = i.options;
    let mut messages = history(i.messages)?;
    if o.supports_reasoning
        && o.effort != "off"
        && i.tools.is_some_and(|t| !t.is_empty())
        && o.reasoning_param_style.as_deref() == Some("anthropic-enabled-output-effort")
    {
        for m in &mut messages {
            if m["role"] != "assistant" {
                continue;
            }
            let content = blocks(&m["content"])?;
            if !content.is_empty() && content.iter().all(|b| b["type"] == "text") {
                *m = json!({"role":"user","content":format!("[Historical assistant reply — conversation context, not a new user request]\n{}",content.iter().filter_map(|b|b["text"].as_str()).collect::<Vec<_>>().join("\n"))});
            }
        }
    }
    for m in &mut messages {
        m["content"] = anthropic_content(&m["content"])?;
    }
    let mut system = if let Some(stable) = i.stable_system.filter(|s| !s.is_empty())
        && !i.system.trim().is_empty()
    {
        json!([{"type":"text","text":stable},{"type":"text","text":i.system}])
    } else {
        json!(i.system)
    };
    let reply = token_limit(o.max_output_tokens).unwrap_or(16384.);
    let mut body = json!({"model":i.model,"system":system,"messages":messages,"max_tokens":token_json(reply),"stream":true});
    if let Some(tools) = i.tools {
        body["tools"] = json!(
            tools
                .iter()
                .map(|t| {
                    let f = t.get("function").unwrap_or(t);
                    let mut t = json!({"name":f["name"]});
                    for (key, target) in [
                        ("description", "description"),
                        ("parameters", "input_schema"),
                    ] {
                        if let Some(v) = f.get(key) {
                            t[target] = v.clone();
                        }
                    }
                    t
                })
                .collect::<Vec<_>>()
        );
    }
    let model = i.model.to_lowercase();
    let style = o.reasoning_param_style.as_deref().unwrap_or_else(|| {
        if o.reasoning_format.as_deref() == Some("adaptive") {
            "anthropic-adaptive-effort"
        } else if ["opus-4-8", "opus-4.8", "fable", "mythos"]
            .iter()
            .any(|s| model.contains(s))
        {
            "anthropic-output-effort"
        } else {
            "anthropic-enabled-budget"
        }
    });
    if o.supports_reasoning && !o.effort.is_empty() {
        if style == "anthropic-enabled-output-effort" {
            if o.effort == "off" {
                body["thinking"] = json!({"type":"disabled"});
            } else {
                body["thinking"] = json!({"type":"enabled"});
                body["output_config"] = json!({"effort":effort(o,true)});
            }
        } else if o.effort != "off" {
            match style {
                "anthropic-adaptive-effort" | "anthropic-output-effort" => {
                    body["thinking"] = json!({"type":"adaptive","display":"summarized"});
                    body["output_config"] = json!({"effort":effort(o,false)});
                }
                "anthropic-enabled-budget" => {
                    let budget = numeric_effort(
                        o,
                        match o.effort.as_str() {
                            "low" => 4096.,
                            "high" | "xhigh" => 32768.,
                            _ => 10240.,
                        },
                        10240.,
                    );
                    let (budget, max) = if let Some(limit) = token_limit(o.max_output_tokens) {
                        if limit < 2. {
                            (1., limit)
                        } else {
                            let reserve = reply.min((limit / 2.).floor()).max(1.);
                            let budget = budget.min(limit - reserve).max(1.);
                            (budget, (budget + reply).min(limit).max(budget + 1.))
                        }
                    } else {
                        (budget, budget + reply)
                    };
                    body["thinking"] = json!({"type":"enabled","budget_tokens":token_json(budget)});
                    body["max_tokens"] = token_json(max);
                }
                _ => {}
            }
        }
    }
    if o.prompt_caching.unwrap_or(true) {
        if !i.system.trim().is_empty() && system.is_string() {
            system = json!([{"type":"text","text":i.system,"cache_control":{"type":"ephemeral"}}]);
        } else if let Some(a) = system.as_array_mut()
            && let Some(last) = a.last_mut()
        {
            last["cache_control"] = json!({"type":"ephemeral"});
        }
        body["system"] = system;
        let messages = body["messages"].as_array_mut().unwrap();
        for idx in (0..messages.len().saturating_sub(1)).rev() {
            if mark_message(&mut messages[idx]) {
                break;
            }
        }
    }
    Ok(body)
}
