//! ADR 121 materialized preview, derived presentation only.
use serde_json::{Value, json};
fn whitespace(c: char) -> bool {
    matches!(c,'\u{9}'..='\u{d}'|'\u{20}'|'\u{a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}')
}
fn compact(s: &str, limit: usize) -> String {
    let mut out = String::new();
    let mut space = false;
    let mut count = 0;
    for c in s.chars() {
        if whitespace(c) {
            space = !out.is_empty();
            continue;
        }
        if space {
            if count >= limit {
                break;
            }
            out.push(' ');
            count += 1;
            space = false
        }
        if count >= limit {
            break;
        }
        out.push(c);
        count += 1
    }
    out
}
fn utf16_prefix(s: &str, limit: usize) -> String {
    let mut n = 0;
    s.chars()
        .take_while(|c| {
            n += c.len_utf16();
            n <= limit
        })
        .collect()
}
fn question(row: &Value) -> Option<Value> {
    let q = row.get("question").filter(|v| v.is_object())?;
    let mut out = json!({});
    if let Some(prompt) = q["prompt"].as_str() {
        out["prompt"] = json!(utf16_prefix(prompt, 2000))
    }
    if let Some(options) = q["options"].as_array() {
        let values: Vec<_> = options
            .iter()
            .take(12)
            .filter_map(Value::as_str)
            .map(|s| compact(s, 200))
            .filter(|s| !s.is_empty())
            .collect();
        if !values.is_empty() {
            out["options"] = json!(values)
        }
    }
    if q["answered"].is_boolean() {
        out["answered"] = q["answered"].clone()
    }
    if q["expiresAt"].is_string() {
        out["expiresAt"] = q["expiresAt"].clone()
    }
    (!out.as_object().unwrap().is_empty()).then_some(out)
}
fn facts(row: &Value) -> Option<Value> {
    let kind = row["kind"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(row["type"].as_str())
        .or(row["messageKind"].as_str())
        .unwrap_or("");
    if kind == "agent_activity"
        && ["verifying", "verified"].contains(&row["agentActivity"]["state"].as_str().unwrap_or(""))
    {
        return None;
    }
    if kind == "system_card"
        && row["cards"]
            .as_array()
            .is_some_and(|v| !v.is_empty() && v.iter().all(|c| c["kind"] == "verdict"))
    {
        return None;
    }
    if !["user_input", "agent_reply", "system_card", "agent_activity"].contains(&kind)
        && !(kind.is_empty() && ["user", "assistant"].contains(&row["role"].as_str().unwrap_or("")))
    {
        return None;
    }
    let names: Vec<_> = row["attachments"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v["name"].as_str())
        .filter(|s| !s.is_empty())
        .take(8)
        .collect();
    let text = row["content"]
        .as_str()
        .or(row["text"].as_str())
        .unwrap_or("");
    let text = if peer_protocol::javascript_trim(text).is_empty() {
        row["attachments"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|v| v["name"].as_str())
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join(", ")
    } else {
        text.to_owned()
    };
    let excerpt = compact(&text, 80);
    if excerpt.is_empty() && names.is_empty() {
        return None;
    }
    let role = if kind == "user_input" || row["role"] == "user" {
        "user"
    } else {
        "assistant"
    };
    let mut out = json!({"excerpt":if excerpt.is_empty(){compact(&names.join(", "),80)}else{excerpt},"role":role,"kind":if kind.is_empty(){if role=="user"{"user_input"}else{"agent_reply"}}else{kind}});
    if let Some(id) = row["id"].as_str().filter(|s| !s.is_empty()) {
        out["messageId"] = json!(id)
    }
    if let Some(at) = row["createdAt"]
        .as_str()
        .filter(|s| !s.is_empty())
        .or(row["at"].as_str())
        && !at.is_empty()
    {
        out["at"] = json!(at)
    }
    if let Some(q) = question(row) {
        out["question"] = q
    }
    if !names.is_empty() {
        out["attachmentNames"] = json!(names)
    }
    let surfacing = if row["kind"] == "agent_activity" {
        Some("silent")
    } else {
        row["meta"]["surfacing"]
            .as_str()
            .or(row["surfacing"].as_str())
    };
    if let Some(s) = surfacing.filter(|s| !s.is_empty()) {
        out["surfacing"] = json!(s)
    }
    if surfacing == Some("silent") || row["meta"]["unread"] == false {
        out["countUnread"] = json!(false)
    }
    Some(out)
}
pub(crate) fn preview(meta: &mut Value, messages: &[Value]) {
    let facts = messages
        .iter()
        .rev()
        .find_map(facts)
        .or_else(|| meta.get("preview").filter(|v| v.is_object()).cloned())
        .unwrap_or(Value::Null);
    let mut record = json!({"conversationId":meta["id"],"title":compact(meta["title"].as_str().unwrap_or(""),80),"excerpt":facts["excerpt"].as_str().unwrap_or(""),"updatedAt":meta["updatedAt"],"contentRevision":meta["contentRevision"],"availability":"ready"});
    for key in [
        "messageId",
        "role",
        "kind",
        "at",
        "question",
        "attachmentNames",
        "countUnread",
        "surfacing",
    ] {
        if let Some(v) = facts.get(key) {
            record[key] = v.clone()
        }
    }
    meta["preview"] = record;
}
