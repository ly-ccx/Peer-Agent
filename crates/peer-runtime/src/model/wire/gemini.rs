use super::*;
fn parts(v: &Value) -> Result<Vec<Value>, ModelError> {
    let v = openai_content(v)?;
    if let Some(s) = v.as_str() {
        return Ok(if s.is_empty() {
            vec![]
        } else {
            vec![json!({"text":s})]
        });
    }
    let mut out = vec![];
    for p in v.as_array().into_iter().flatten() {
        if p["type"] == "text" && p["text"].as_str().is_some_and(|s| !s.is_empty()) {
            out.push(json!({"text":p["text"]}));
        } else if p["type"] == "image_url"
            && let Some(url) = p["image_url"]["url"]
                .as_str()
                .and_then(|s| s.strip_prefix("data:"))
            && let Some((mime, data)) = url.split_once(";base64,")
            && !mime.is_empty()
            && !mime.contains([',', ';'])
            && !data.is_empty()
        {
            out.push(json!({"inlineData":{"mimeType":mime,"data":data}}));
        }
    }
    Ok(out)
}
pub(super) fn encode(i: &WireInput<'_>) -> Result<Value, ModelError> {
    let mut system = vec![];
    let mut contents = vec![];
    for m in messages_with_system(i)? {
        if m["role"] == "system" {
            if let Some(s) = m["content"].as_str().filter(|s| !s.is_empty()) {
                system.push(s.to_owned());
            }
            continue;
        }
        if let Some(v) = m
            .get("geminiContent")
            .filter(|v| !v.is_null() && **v != false)
        {
            contents.push(v.clone());
            continue;
        }
        if m["role"] == "assistant" && m["tool_calls"].as_array().is_some_and(|a| !a.is_empty()) {
            let mut p = parts(&m["content"])?;
            for c in m["tool_calls"].as_array().unwrap() {
                if let Some(name) = c["function"]["name"].as_str().filter(|s| !s.is_empty()) {
                    p.push(json!({"functionCall":{"name":name,"args":arguments(&c["function"]["arguments"])}}));
                }
            }
            if !p.is_empty() {
                contents.push(json!({"role":"model","parts":p}));
            }
            continue;
        }
        if m["role"] == "tool" && m["name"].as_str().is_some_and(|s| !s.is_empty()) {
            contents.push(json!({"role":"user","parts":[{"functionResponse":{"name":m["name"],"response":{"result":m.get("content").filter(|v|!v.is_null()).cloned().unwrap_or(json!(""))}}}]}));
            continue;
        }
        let p = parts(&m["content"])?;
        if !p.is_empty() {
            contents.push(json!({"role":if m["role"]=="assistant"{"model"}else{"user"},"parts":p}));
        }
    }
    let mut body = json!({"contents":contents});
    if let Some(tools) = i.tools {
        let declarations=tools.iter().filter_map(|t|{let f=t.get("function").unwrap_or(t);f["name"].as_str().filter(|s|!s.is_empty())?;Some(json!({"name":f["name"],"description":f.get("description").filter(|v|!v.is_null() && **v!=false && **v!="").cloned().unwrap_or(json!("")),"parameters":f.get("parameters").filter(|v|!v.is_null() && **v!=false).cloned().unwrap_or(json!({"type":"object","properties":{}}))}))}).collect::<Vec<_>>();
        if !declarations.is_empty() {
            body["tools"] = json!([{"functionDeclarations":declarations}]);
        }
    }
    if let Some(n) = token_limit(i.options.max_output_tokens) {
        body["generationConfig"] = json!({"maxOutputTokens":token_json(n)});
    }
    if !system.is_empty() {
        body["systemInstruction"] = json!({"parts":[{"text":system.join("\n\n")}]});
    }
    if i.options.auth_method.as_deref() == Some("oauth_google") {
        if let Some(s) = i.options.session_id.as_ref().filter(|s| !s.is_empty()) {
            body["session_id"] = s.clone().into();
        }
        let mut wrapped =
            json!({"model":i.model.strip_prefix("models/").unwrap_or(i.model),"request":body});
        if let Some(s) = i.options.project_id.as_ref().filter(|s| !s.is_empty()) {
            wrapped["project"] = s.clone().into();
        }
        if let Some(s) = i.options.user_prompt_id.as_ref().filter(|s| !s.is_empty()) {
            wrapped["user_prompt_id"] = s.clone().into();
        }
        return Ok(wrapped);
    }
    Ok(body)
}
