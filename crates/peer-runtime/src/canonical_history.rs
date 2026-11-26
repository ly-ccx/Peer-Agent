//! ADR 57 projector v3. Persisted tool records are history, never new calls.
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
fn selected_history(values: &[Value], boundary: Option<usize>) -> Result<Vec<Value>, &'static str> {
    let Some(index) = boundary else {
        return Ok(values.to_vec());
    };
    let Some(raw) = marker(&values[index]).and_then(|m| m.get("historySelection")) else {
        return Ok(values[index + 1..].to_vec());
    };
    let selection = peer_protocol::normalize_compaction_history_selection(raw)
        .ok_or("compaction_history_selection_invalid")?;
    if text(&values[index]["id"]).is_empty()
        || [
            &marker(&values[index]).unwrap()["summary"],
            &marker(&values[index]).unwrap()["handoffContent"],
            &values[index]["content"],
        ]
        .into_iter()
        .all(|v| text(v).is_empty())
    {
        return Err("compaction_history_selection_invalid");
    }
    let wanted: std::collections::HashSet<_> = selection
        .retained_message_ids
        .iter()
        .map(String::as_str)
        .collect();
    let mut ids = Vec::new();
    let mut selected = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for (i, row) in values.iter().enumerate() {
        let id = row["id"].as_str().unwrap_or("");
        if !wanted.contains(id) {
            continue;
        }
        if i >= index
            || !seen.insert(id)
            || marker(row).is_some()
            || !matches!(row["role"].as_str(), Some("user" | "assistant" | "tool"))
            || matches!(
                row["kind"].as_str(),
                Some("agent_message" | "agent_activity")
            )
        {
            return Err("compaction_history_selection_invalid");
        }
        ids.push(id.to_owned());
        selected.push(row.clone());
    }
    if ids != selection.retained_message_ids {
        return Err("compaction_history_selection_invalid");
    }
    selected.extend_from_slice(&values[index + 1..]);
    Ok(selected)
}
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
fn user(m: &Value, workspace_images: bool) -> Result<Option<Value>, &'static str> {
    // Interactive material requires its governed transport adapter, never silent
    // omission or reinterpretation as project/system instructions.
    if !m["resourceFeedback"].is_null() && m["resourceFeedback"] != json!([]) {
        return Err("history_resource_feedback_unsupported");
    }
    let mut blocks = Vec::<String>::new();
    let mut images = Vec::<Value>::new();
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
                images.push(json!({"type":"image_url","image_url":{"url":u}}));
            } else if workspace_images && a["blobDigest"].is_string() {
                images.push(json!({"type":"workspace_image","attachment":a}));
            }
        }
    }
    for a in list(&m["images"]) {
        let u = if text(&a["url"]).is_empty() {
            text(&a["dataUrl"])
        } else {
            text(&a["url"])
        };
        if !u.is_empty() && !images.iter().any(|part| part["image_url"]["url"] == u) {
            images.push(json!({"type":"image_url","image_url":{"url":u}}));
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
    parts.extend(images);
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
    project_history_with_workspace_images(values, None)
}

pub(crate) type WorkspaceImageResolver =
    std::sync::Arc<dyn Fn(&Value) -> Option<String> + Send + Sync>;

pub(crate) fn project_history_with_workspace_images(
    values: &[Value],
    resolve_image: Option<&WorkspaceImageResolver>,
) -> Result<Value, &'static str> {
    // Bound before cloning/expanding; Runtime never holds the entire transcript.
    peer_protocol::javascript_json_array_string_with_limit(values, 8 * 1024 * 1024)
        .map_err(|_| "history_projection_limit")?;
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
    if let Some(c) = &mut continuity
        && let Some(i) = boundary
        && let Some(raw) = marker(&values[i]).and_then(|m| m.get("historySelection"))
    {
        c["compactionEpoch"] = json!(
            peer_protocol::normalize_compaction_history_selection(raw)
                .ok_or("compaction_history_selection_invalid")?
                .compaction_epoch
        );
    }
    let mut messages = Vec::new();
    for m in folded(&selected_history(values, boundary)?) {
        if matches!(m["kind"].as_str(), Some("agent_message" | "agent_activity"))
            || marker(&m).is_some()
        {
            continue;
        }
        match m["role"].as_str() {
            Some("user") => {
                if let Some(v) = user(&m, resolve_image.is_some())? {
                    messages.push(v)
                }
            }
            Some("assistant") => assistant(&m, &mut messages)?,
            _ => {}
        }
    }
    let index = boundary.map_or(-1, |i| i as i64);
    let input = json!({"projectorVersion":peer_protocol::CANONICAL_HISTORY_PROJECTOR_VERSION,"compactionBoundaryIndex":index,"continuity":continuity,"messages":messages});
    let bytes = peer_protocol::javascript_json_string_with_limit(&input, 8 * 1024 * 1024)
        .map_err(|_| "history_projection_limit")?;
    let hash = bytes.encode_utf16().fold(0x811c9dc5u32, |h, c| {
        (h ^ u32::from(c)).wrapping_mul(0x01000193)
    });
    // Fingerprint the verified blob identity without expanding the stored
    // transcript. Hydrate only projected image parts for the bounded wire request.
    if let Some(resolve) = resolve_image {
        let mut bytes = bytes.len();
        for message in &mut messages {
            if message["role"] != "user" {
                continue;
            }
            for part in message["content"].as_array_mut().into_iter().flatten() {
                if part["type"] != "workspace_image" {
                    continue;
                }
                let url =
                    resolve(&part["attachment"]).ok_or("history_workspace_image_unavailable")?;
                bytes = bytes.saturating_add(url.len());
                if bytes > crate::model::REQUEST_BYTES {
                    return Err("model_request_size_limit");
                }
                *part = json!({"type":"image_url","image_url":{"url":url}});
            }
        }
    }
    let mut out = json!({"messages":messages,"compactionBoundaryIndex":index,"projectorVersion":peer_protocol::CANONICAL_HISTORY_PROJECTOR_VERSION,"historyFingerprint":format!("history-v3-{hash:08x}")});
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
    fn delegated_workspace_images_are_resolved_only_at_canonical_projection() {
        let rows = [json!({
            "id": "followup", "role": "user", "kind": "user_followup", "content": "Look at this",
            "attachments": [{"kind": "image", "blobDigest": "known", "mimeType": "image/png"}],
        })];
        assert_eq!(
            project_history(&rows).unwrap()["messages"][0]["content"],
            "Look at this"
        );
        let resolve: WorkspaceImageResolver = std::sync::Arc::new(|attachment| {
            (attachment["blobDigest"] == "known").then(|| "data:image/png;base64,AA==".into())
        });
        let projected = project_history_with_workspace_images(&rows, Some(&resolve)).unwrap();
        assert_eq!(
            projected["messages"][0]["content"][1],
            json!({
                "type": "image_url", "image_url": {"url": "data:image/png;base64,AA=="}
            })
        );
        assert!(rows[0]["attachments"][0]["dataUrl"].is_null());
        let missing: WorkspaceImageResolver = std::sync::Arc::new(|_| None);
        assert_eq!(
            project_history_with_workspace_images(&rows, Some(&missing)).unwrap_err(),
            "history_workspace_image_unavailable"
        );
    }

    #[test]
    fn durable_selection_matches_actual_ts_sync_and_yielding_projectors() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../packages/protocol/contracts/native-cli/compaction-v1.json"
        ))
        .unwrap();
        for case in f["projections"].as_array().unwrap() {
            let result = project_history(case["messages"].as_array().unwrap());
            if let Some(code) = case["error"].as_str() {
                assert_eq!(result.unwrap_err(), code, "{}", case["name"]);
            } else {
                assert_eq!(result.unwrap(), case["expected"], "{}", case["name"]);
            }
        }
    }
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
