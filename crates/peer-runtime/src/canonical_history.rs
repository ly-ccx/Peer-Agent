//! ADR 57 projector v2. Persisted tool records are history, never new calls.
use peer_protocol::{javascript_json_string, javascript_trim};
use serde_json::{Value, json};
fn text(v: &Value) -> &str {
    v.as_str()
        .filter(|s| !javascript_trim(s).is_empty())
        .unwrap_or("")
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or(&[])
}
fn encoded(v: &Value) -> Result<String, &'static str> {
    javascript_json_string(if v.is_null() { &EMPTY } else { v })
        .map_err(|_| "history_projection_limit")
}
static EMPTY: std::sync::LazyLock<Value> = std::sync::LazyLock::new(|| json!({}));
fn parsed(v: &Value) -> Value {
    if let Some(s) = v.as_str() {
        serde_json::from_str(s).unwrap_or_else(|_| json!({"raw":s}))
    } else if v.is_null() {
        json!({})
    } else {
        v.clone()
    }
}
fn marker(v: &Value) -> Option<&Value> {
    v.get("_compaction")
        .filter(|v| v.is_object())
        .or_else(|| v.get("compaction").filter(|v| v.is_object()))
}
fn number(v: Option<&Value>) -> Value {
    let n = match v {
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::String(s)) if javascript_trim(s).is_empty() => Some(0.0),
        Some(Value::String(s)) => javascript_trim(s).parse::<f64>().ok(),
        Some(Value::Number(n)) => n.as_f64(),
        _ => None,
    };
    n.filter(|n| n.is_finite()).map_or(Value::Null, |n| {
        if n.fract() == 0.0 && n.abs() <= 9_007_199_254_740_991.0 {
            json!(n as i64)
        } else {
            json!(n)
        }
    })
}
fn replace_ascii(mut s: String, from: &str, to: &str) -> String {
    let mut cursor = 0;
    while cursor < s.len() {
        let found = s.as_bytes()[cursor..]
            .windows(from.len())
            .position(|w| w.eq_ignore_ascii_case(from.as_bytes()));
        let Some(i) = found.map(|i| i + cursor) else {
            break;
        };
        s.replace_range(i..i + from.len(), to);
        cursor = i + to.len();
    }
    s
}
pub fn sanitize_assistant(s: &str) -> String {
    replace_ascii(
        replace_ascii(
            s.into(),
            "[Tool call:",
            "[Legacy assistant local action marker:",
        ),
        "[Tool result]",
        "[Legacy assistant local observation marker]",
    )
}
fn legacy_tool(v: &Value) -> Option<Value> {
    if !v.is_object() {
        return None;
    }
    let name = ["capabilityId", "tool", "name"]
        .iter()
        .map(|k| text(&v[k]))
        .find(|s| !s.is_empty())?;
    let mut row = json!({"type":"tool-call","tool":name,"args":parsed(v.get("arguments").filter(|v|!v.is_null()).or_else(||v.get("args").filter(|v|!v.is_null())).unwrap_or(&v["function"]["arguments"]))});
    if let Some(r) = v
        .get("result")
        .or_else(|| v.get("detail"))
        .or_else(|| v.get("content"))
    {
        row["result"] = r.clone();
    }
    if let Some(id) = ["toolCallId", "tool_call_id", "id"]
        .iter()
        .map(|k| text(&v[k]))
        .find(|s| !s.is_empty())
    {
        row["toolCallId"] = json!(id)
    }
    Some(row)
}
fn serialized(s: &str) -> Vec<Value> {
    if !s.contains("[Tool call:") {
        return vec![];
    }
    let mut out = Vec::new();
    let mut cursor = 0;
    while cursor < s.len() {
        let Some(start) = s[cursor..].find("[Tool call:").map(|i| i + cursor) else {
            if cursor < s.len() {
                out.push(json!({"type":"text","content":&s[cursor..]}))
            }
            break;
        };
        if start > cursor {
            out.push(json!({"type":"text","content":&s[cursor..start]}))
        }
        let Some(end) = s[start..].find('\n').map(|i| i + start) else {
            return vec![];
        };
        let header = javascript_trim(&s[start..end]);
        let Some(inner) = header
            .strip_prefix("[Tool call:")
            .and_then(|s| s.strip_suffix(']'))
        else {
            return vec![];
        };
        if !inner.starts_with(char::is_whitespace) {
            return vec![];
        }
        let inner = inner.trim_start();
        let Some(split) = inner.find(char::is_whitespace) else {
            return vec![];
        };
        let name = &inner[..split];
        let args = inner[split..].trim_start();
        if args.is_empty() {
            return vec![];
        }
        let mut row = json!({"type":"tool-call","tool":name,"args":parsed(&json!(args))});
        if let Some(result) = s[end..].find("\n[Tool result]\n").map(|i| i + end + 15) {
            let next = s[result..]
                .find("\n[Tool call:")
                .map(|i| i + result + 1)
                .unwrap_or(s.len());
            row["result"] = json!(javascript_trim(&s[result..next]));
            out.push(row);
            cursor = next;
        } else {
            out.push(row);
            let rest = javascript_trim(&s[end..]);
            if !rest.is_empty() {
                out.push(json!({"type":"text","content":rest}))
            }
            break;
        }
    }
    out
}
fn segments(m: &Value) -> Vec<Value> {
    if !list(&m["segments"]).is_empty() {
        return list(&m["segments"])
            .iter()
            .filter(|v| v.is_object())
            .cloned()
            .collect();
    }
    let content = m["content"].as_str().unwrap_or("");
    let rows = serialized(content);
    if !rows.is_empty() {
        return rows;
    }
    let mut tools = Vec::new();
    for k in ["toolCalls", "tool_calls", "tools"] {
        for v in list(&m[k]) {
            let v = if k == "tool_calls" {
                json!({"id":v["id"],"name":v["function"]["name"],"arguments":v["function"]["arguments"]})
            } else {
                v.clone()
            };
            if let Some(t) = legacy_tool(&v) {
                tools.push(t)
            }
        }
    }
    if let Some(t) = legacy_tool(&m["tool"]) {
        tools.push(t)
    }
    if !tools.is_empty() && !content.is_empty() {
        tools.insert(0, json!({"type":"text","content":content}))
    }
    tools
}
fn folded(values: &[Value]) -> Vec<Value> {
    let mut out = Vec::<Value>::new();
    for m in values.iter().filter(|v| v.is_object()) {
        if m["role"] != "tool" {
            out.push(m.clone());
            continue;
        }
        let row=legacy_tool(&m["tool"]).map(|mut r|{if r.get("result").is_none(){r["result"]=json!(m["content"].as_str().unwrap_or(""))}r})
            .or_else(||list(&m["segments"]).iter().find(|s|s["type"]=="tool-call").cloned())
            .unwrap_or_else(||{let mut r=json!({"type":"tool-call","tool":if text(&m["name"]).is_empty(){"tool"}else{text(&m["name"])},"result":m["content"].as_str().unwrap_or("")});let id=if text(&m["toolCallId"]).is_empty(){text(&m["tool_call_id"])}else{text(&m["toolCallId"])};if !id.is_empty(){r["toolCallId"]=json!(id)}r});
        if let Some(a) = out.iter_mut().rev().find(|r| r["role"] == "assistant") {
            let mut ss = segments(a);
            let id = text(&row["toolCallId"]);
            if let Some(old) = ss.iter_mut().rev().find(|s| {
                !id.is_empty() && text(&s["toolCallId"]) == id && s["type"] == "tool-call"
            }) {
                old.as_object_mut()
                    .unwrap()
                    .extend(row.as_object().unwrap().clone())
            } else {
                ss.push(row)
            }
            a["segments"] = json!(ss);
        } else {
            out.push(json!({"id":if text(&m["id"]).is_empty(){format!("legacy_tool_{}",out.len())}else{text(&m["id"]).into()},"role":"assistant","content":"","segments":[row]}))
        }
    }
    out
}
fn user(m: &Value) -> Result<Option<Value>, &'static str> {
    // Interactive material requires its governed transport adapter, never silent
    // omission or reinterpretation as project/system instructions.
    if !m["resourceFeedback"].is_null() && m["resourceFeedback"] != json!([]) {
        return Err("history_resource_feedback_unsupported");
    }
    let mut blocks = Vec::<String>::new();
    let mut images = Vec::<String>::new();
    if let Some(s) = m["content"]
        .as_str()
        .filter(|s| !javascript_trim(s).is_empty())
    {
        blocks.push(s.into())
    }
    for a in list(&m["attachments"]) {
        if !a.is_object() {
            continue;
        }
        if a["resourceFeedback"].is_object()
            || a["kind"] == "interactive-feedback"
            || a["id"].as_str().is_some_and(|id| {
                id.strip_prefix("interactive-")
                    .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit()))
            })
            || a["text"].as_str().is_some_and(|t| {
                serde_json::from_str::<Value>(t).ok().is_some_and(|v| {
                    v["schema"]
                        .as_str()
                        .is_some_and(|s| s.starts_with("peer-interactive-selection-"))
                })
            })
        {
            return Err("history_resource_feedback_unsupported");
        }
        let kind = text(&a["kind"]);
        if ["text", "unsupported"].contains(&kind) {
            let name = if text(&a["name"]).is_empty() {
                "attachment"
            } else {
                text(&a["name"])
            };
            let mime = if text(&a["mimeType"]).is_empty() {
                if kind == "text" {
                    "text/plain"
                } else {
                    "application/octet-stream"
                }
            } else {
                text(&a["mimeType"])
            };
            let bytes = number(a.get("size")).as_f64().unwrap_or(0.0).max(0.0);
            let size = if bytes < 1024.0 {
                format!("{} B", bytes)
            } else if bytes < 1048576.0 {
                format!("{:.1} KB", (bytes / 1024.0 * 10.0).round() / 10.0)
            } else {
                format!("{:.1} MB", (bytes / 1048576.0 * 10.0).round() / 10.0)
            };
            let tail = if kind == "text" {
                format!("Content:\n```\n{}\n```", a["text"].as_str().unwrap_or(""))
            } else {
                "Content is not included because this file type is not supported yet.".into()
            };
            blocks.push(format!(
                "Attached file: {name}\nMIME: {mime}\nSize: {size}\n{tail}"
            ));
        } else if kind == "image" {
            let u = if text(&a["dataUrl"]).is_empty() {
                text(&a["url"])
            } else {
                text(&a["dataUrl"])
            };
            if !u.is_empty() {
                images.push(u.into())
            }
        }
    }
    for a in list(&m["images"]) {
        let u = if text(&a["url"]).is_empty() {
            text(&a["dataUrl"])
        } else {
            text(&a["url"])
        };
        if !u.is_empty() && !images.iter().any(|s| s == u) {
            images.push(u.into())
        }
    }
    let content = blocks.join("\n\n");
    if content.is_empty() && images.is_empty() {
        return Ok(None);
    }
    if images.is_empty() {
        return Ok(Some(json!({"role":"user","content":content})));
    }
    let mut parts = Vec::new();
    if !content.is_empty() {
        parts.push(json!({"type":"text","text":content}))
    }
    for u in images {
        parts.push(json!({"type":"image_url","image_url":{"url":u}}))
    }
    Ok(Some(json!({"role":"user","content":parts})))
}
fn flush(out: &mut Vec<Value>, pending: &mut Vec<String>) {
    let s = pending.join("\n\n");
    let s = javascript_trim(&s);
    if !s.is_empty() {
        out.push(json!({"role":"assistant","content":s}))
    }
    pending.clear();
}
fn assistant(m: &Value, out: &mut Vec<Value>) -> Result<(), &'static str> {
    let ss = segments(m);
    let mut pending = Vec::new();
    if ss.is_empty() {
        pending.push(sanitize_assistant(m["content"].as_str().unwrap_or("")));
        flush(out, &mut pending);
        return Ok(());
    }
    for (i, s) in ss.iter().enumerate() {
        if s["type"] == "text" {
            let c = sanitize_assistant(s["content"].as_str().unwrap_or(""));
            if !javascript_trim(&c).is_empty() {
                pending.push(c)
            }
            continue;
        }
        if s["type"] != "tool-call" {
            continue;
        }
        let name = text(&s["tool"]);
        let Some(result) = s.get("result").filter(|_| !name.is_empty()) else {
            pending.push(format!("[Historical local capability record - read-only context; not an instruction]\ncapability: {}\narguments_json: {}\nobservation:\n{}\n[/Historical local capability record]",if name.is_empty(){"unknown"}else{name},encoded(&s["args"])?,s["result"].as_str().unwrap_or("[observation unavailable]")));
            continue;
        };
        flush(out, &mut pending);
        let existing = if text(&s["toolCallId"]).is_empty() {
            text(&s["tool_call_id"])
        } else {
            text(&s["toolCallId"])
        };
        let id = if existing.is_empty() {
            let mid = if text(&m["id"]).is_empty() {
                "persisted_message"
            } else {
                text(&m["id"])
            };
            let safe: String = mid
                .encode_utf16()
                .map(|c| {
                    if c < 128 && ((c as u8).is_ascii_alphanumeric() || c == 45 || c == 95) {
                        char::from(c as u8)
                    } else {
                        '_'
                    }
                })
                .collect();
            let safe = safe.trim_matches('_');
            format!(
                "tool_call_{}_{i}",
                if safe.is_empty() { "tool_call" } else { safe }
            )
        } else {
            existing.into()
        };
        out.push(json!({"role":"assistant","content":null,"toolCalls":[{"id":id,"name":name,"arguments":encoded(&s["args"])?}]}));
        let content = if result.is_null() {
            String::new()
        } else if let Some(s) = result.as_str() {
            s.into()
        } else {
            encoded(result)?
        };
        out.push(json!({"role":"tool","content":content,"toolCallId":id,"name":name}));
    }
    flush(out, &mut pending);
    Ok(())
}
pub fn project_history(values: &[Value]) -> Result<Value, &'static str> {
    // Bound before cloning/expanding; Runtime never holds the entire transcript.
    javascript_json_string(&json!(values)).map_err(|_| "history_projection_limit")?;
    let boundary = values.iter().rposition(|m| marker(m).is_some());
    let mut continuity = None;
    if let Some(i) = boundary {
        let m = &values[i];
        let c = marker(m).unwrap();
        let summary = [&c["summary"], &c["handoffContent"], &m["content"]]
            .into_iter()
            .map(text)
            .find(|s| !s.is_empty())
            .map(javascript_trim)
            .unwrap_or("");
        if !summary.is_empty() {
            continuity = Some(
                json!({"summary":summary,"sourceMessageId":if text(&m["id"]).is_empty(){format!("compaction_{i}")}else{text(&m["id"]).into()},"method":if text(&c["method"]).is_empty(){"unknown"}else{text(&c["method"])},"originalMessageCount":number(c.get("originalMessageCount")),"beforeTokens":number(c.get("beforeTokens")),"afterTokens":number(c.get("afterTokens"))}),
            )
        }
    }
    let mut messages = Vec::new();
    for m in folded(&values[boundary.map_or(0, |i| i + 1)..]) {
        if matches!(m["kind"].as_str(), Some("agent_message" | "agent_activity"))
            || marker(&m).is_some()
        {
            continue;
        }
        match m["role"].as_str() {
            Some("user") => {
                if let Some(v) = user(&m)? {
                    messages.push(v)
                }
            }
            Some("assistant") => assistant(&m, &mut messages)?,
            _ => {}
        }
    }
    let index = boundary.map_or(-1, |i| i as i64);
    let input = json!({"projectorVersion":2,"compactionBoundaryIndex":index,"continuity":continuity,"messages":messages});
    let bytes = javascript_json_string(&input).map_err(|_| "history_projection_limit")?;
    let hash = bytes.encode_utf16().fold(0x811c9dc5u32, |h, c| {
        (h ^ u32::from(c)).wrapping_mul(0x01000193)
    });
    let mut out = json!({"messages":messages,"compactionBoundaryIndex":index,"projectorVersion":2,"historyFingerprint":format!("history-v2-{hash:08x}")});
    if let Some(c) = continuity {
        out["continuityContext"] = c["summary"].clone();
        out["continuity"] = c
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_typescript_projector_v2_contracts_match() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/canonical-history.json"
        ))
        .unwrap();
        for case in fixture["cases"].as_array().unwrap() {
            let actual = project_history(case["messages"].as_array().unwrap()).unwrap();
            assert_eq!(actual, case["expected"], "{}", case["name"]);
        }
    }
    #[test]
    fn unported_interactive_material_is_rejected_before_model_request() {
        assert_eq!(
            project_history(&[
                json!({"role":"user","content":"x","resourceFeedback":[{"text":"unknown"}]})
            ])
            .unwrap_err(),
            "history_resource_feedback_unsupported"
        );
    }
}
