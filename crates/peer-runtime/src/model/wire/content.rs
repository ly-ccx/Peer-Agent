use super::*;
use base64::{Engine as _, engine::general_purpose::STANDARD};
pub(super) fn stringified(v: &Value) -> Result<String, ModelError> {
    peer_protocol::javascript_json_string(v).map_err(|_| ModelError("model_request_invalid"))
}
pub(super) fn openai_content(v: &Value) -> Result<Value, ModelError> {
    let Some(parts) = v.as_array() else {
        return Ok(v.clone());
    };
    let mut out = vec![];
    for p in parts {
        if !p.is_object() {
            continue;
        }
        if p["type"] == "text" && p["text"].as_str().is_some_and(|s| !s.trim().is_empty()) {
            out.push(json!({"type":"text","text":p["text"]}));
        } else if p["type"] == "image_url"
            && p["image_url"]["url"]
                .as_str()
                .is_some_and(|s| !s.is_empty())
        {
            out.push(json!({"type":"image_url","image_url":{"url":p["image_url"]["url"]}}));
        } else {
            out.push(p.clone());
        }
    }
    Ok(if out.is_empty() {
        json!("")
    } else {
        json!(out)
    })
}
pub(super) fn anthropic_content(v: &Value) -> Result<Value, ModelError> {
    let Some(parts) = v.as_array() else {
        return Ok(v.clone());
    };
    let mut out = vec![];
    for p in parts {
        if p["type"] == "text" && p["text"].as_str().is_some_and(|s| !s.trim().is_empty()) {
            out.push(json!({"type":"text","text":p["text"]}));
        } else if p["type"] == "image_url" {
            if let Some(url) = p["image_url"]["url"]
                .as_str()
                .and_then(|s| s.strip_prefix("data:"))
                && let Some((header, payload)) = url.split_once(',')
            {
                let (mime, encoded) = header
                    .strip_suffix(";base64")
                    .map_or((header, false), |h| (h, true));
                if mime.starts_with("image/") {
                    let data = if encoded {
                        payload.to_owned()
                    } else {
                        let bytes = percent_encoding::percent_decode_str(payload)
                            .decode_utf8()
                            .map_err(|_| ModelError("model_image_invalid"))?;
                        STANDARD.encode(bytes.as_bytes())
                    };
                    out.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":data}}));
                }
            }
        } else if matches!(
            p["type"].as_str(),
            Some("image" | "tool_use" | "tool_result" | "thinking" | "redacted_thinking")
        ) {
            out.push(p.clone());
        }
    }
    Ok(if out.is_empty() {
        json!("")
    } else {
        json!(out)
    })
}
pub(super) fn blocks(v: &Value) -> Result<Vec<Value>, ModelError> {
    let v = anthropic_content(v)?;
    Ok(match v {
        Value::Array(a) => a,
        Value::String(s) if !s.trim().is_empty() => vec![json!({"type":"text","text":s})],
        _ => vec![],
    })
}
pub(super) fn arguments(v: &Value) -> Value {
    if v.is_object() || v.is_array() {
        return v.clone();
    }
    v.as_str()
        .and_then(|s| serde_json::from_str::<Value>(s).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}))
}
pub(super) fn result_text(v: &Value) -> Result<String, ModelError> {
    if v.is_null() {
        return Ok(String::new());
    }
    if let Some(s) = v.as_str() {
        Ok(s.into())
    } else {
        stringified(v)
    }
}
