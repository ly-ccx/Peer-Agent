//! Request-local facts for summary cognition. Canonical history and the
//! provider's governed Tool Result views remain the original sources.
use crate::capability::CapabilityError as HostError;
use peer_protocol::javascript_json_string;
use serde_json::{Value, json};

pub(super) const WORKING_PLAN_HEADING: &str = "\n\nActive working plan (authoritative session state — preserve open steps, checks, and invariants in the summary):\n";

const INPUT_BYTES: usize = 256 * 1024;
const TEXT_UNITS: usize = 12_000;
const TOOL_INPUT_UNITS: usize = 2_000;
const LIMIT: HostError = HostError("context_summary_limit");
const PAIR: HostError = HostError("history_projection_invalid");

struct Budget {
    bytes: usize,
    continuity: usize,
    user_text: usize,
    assistant_text: usize,
    tool_input: usize,
    tool_result: Option<usize>,
}

const MODEL: Budget = Budget {
    bytes: INPUT_BYTES,
    continuity: TEXT_UNITS,
    user_text: TEXT_UNITS,
    assistant_text: TEXT_UNITS,
    tool_input: TOOL_INPUT_UNITS,
    tool_result: None,
};

const STRUCTURAL: Budget = Budget {
    bytes: 12 * 1024,
    continuity: 800,
    user_text: 800,
    assistant_text: 500,
    tool_input: 300,
    tool_result: Some(300),
};

pub(super) fn build(continuity: Option<&Value>, messages: Vec<Value>) -> Result<String, HostError> {
    fit(
        continuity.cloned().unwrap_or(Value::Null),
        messages,
        0,
        &MODEL,
    )
}

pub(super) fn structural_fallback(input: &str) -> Result<String, HostError> {
    let (history, protected_plan) = input
        .split_once(WORKING_PLAN_HEADING)
        .map_or((input, None), |(history, plan)| (history, Some(plan)));
    let mut facts: Value = serde_json::from_str(history).map_err(|_| PAIR)?;
    let messages = facts["messages"]
        .as_array_mut()
        .map(std::mem::take)
        .ok_or(PAIR)?;
    let earlier = facts["omittedEarlierMessages"]["count"]
        .as_u64()
        .unwrap_or(0) as usize;
    let short = fit(facts["continuity"].take(), messages, earlier, &STRUCTURAL)?;
    let mut handoff = format!(
        "Structural handoff. Original conversation history and its saved Tool Result / Evidence remain available. Re-read them for omitted details.\n{short}"
    );
    if let Some(plan) = protected_plan {
        handoff.push_str(WORKING_PLAN_HEADING);
        handoff.push_str(plan);
    }
    Ok(handoff)
}

fn fit(
    mut continuity: Value,
    mut messages: Vec<Value>,
    earlier_omitted: usize,
    limits: &Budget,
) -> Result<String, HostError> {
    if let Some(summary) = continuity.get_mut("summary") {
        preview_text(summary, limits.continuity, "previous summary");
    }

    let has_continuity = continuity["summary"]
        .as_str()
        .is_some_and(|s| !s.is_empty());
    let continuity = javascript_json_string(&continuity).map_err(|_| LIMIT)?;
    let mut input = format!("{{\"continuity\":{continuity},\"messages\":[");
    let budget = limits.bytes.checked_sub(input.len() + 2).ok_or(LIMIT)?;
    let mut omitted = earlier_omitted.checked_add(messages.len()).ok_or(LIMIT)?;
    let mut used = 0;
    let mut kept = Vec::new();
    while let Some(message) = messages.pop() {
        let group = Group::project(message, &mut messages, limits)?;
        let bytes = group.encoded.len() + usize::from(!kept.is_empty());
        if used + bytes > budget {
            break;
        }
        used += bytes;
        omitted -= group.rows;
        kept.push(group);
    }

    let omission = loop {
        if omitted == 0 {
            break String::new();
        }
        let omission = format!(
            ",\"omittedEarlierMessages\":{{\"count\":{omitted},\"source\":\"Original conversation history and its saved Tool Result / Evidence\"}}"
        );
        if used + omission.len() <= budget {
            break omission;
        }
        let oldest = kept.pop().ok_or(LIMIT)?;
        used -= oldest.encoded.len() + usize::from(!kept.is_empty());
        omitted += oldest.rows;
    };

    if kept.is_empty() && omitted > 0 && !has_continuity {
        return Err(LIMIT);
    }

    for (index, group) in kept.into_iter().rev().enumerate() {
        if index != 0 {
            input.push(',');
        }
        input.push_str(&group.encoded);
    }
    input.push(']');
    input.push_str(&omission);
    input.push('}');
    Ok(input)
}

struct Group {
    encoded: String,
    rows: usize,
}

impl Group {
    fn project(
        mut last: Value,
        earlier: &mut Vec<Value>,
        limits: &Budget,
    ) -> Result<Self, HostError> {
        if last["role"] == "tool" {
            let mut call = earlier.pop().ok_or(PAIR)?;
            // The canonical projector emits one assistant call immediately
            // before each saved observation. Keep both at the same boundary.
            if call["role"] != "assistant"
                || call["toolCalls"]
                    .as_array()
                    .is_none_or(|calls| calls.len() != 1)
                || call["toolCalls"][0]["id"].as_str().is_none()
                || call["toolCalls"][0]["id"] != last["toolCallId"]
                || call["toolCalls"][0]["name"] != last["name"]
            {
                return Err(PAIR);
            }
            if let Some(args) = call["toolCalls"][0].get_mut("arguments") {
                preview_text(args, limits.tool_input, "tool input");
            }
            if let Some(limit) = limits.tool_result {
                structural_result(&mut last["content"], limit)?;
            }
            let call = javascript_json_string(&call).map_err(|_| LIMIT)?;
            let result = javascript_json_string(&last).map_err(|_| LIMIT)?;
            return Ok(Self {
                encoded: format!("{call},{result}"),
                rows: 2,
            });
        }
        if last.get("toolCalls").is_some() {
            return Err(PAIR);
        }
        let text_limit = if last["role"] == "user" {
            limits.user_text
        } else {
            limits.assistant_text
        };
        if let Some(content) = last.get_mut("content") {
            if let Some(parts) = content.as_array_mut() {
                for part in parts {
                    match part["type"].as_str() {
                        Some("text") => preview_text(&mut part["text"], text_limit, "text block"),
                        Some("image_url") => {
                            *part = json!({"type":"image_url","omittedFromSummary":true});
                        }
                        _ => return Err(PAIR),
                    }
                }
            } else {
                preview_text(content, text_limit, "message text");
            }
        }
        let encoded = javascript_json_string(&last).map_err(|_| LIMIT)?;
        Ok(Self { encoded, rows: 1 })
    }
}

fn structural_result(content: &mut Value, limit: usize) -> Result<(), HostError> {
    let Some(encoded) = content.as_str() else {
        return Err(PAIR);
    };
    if encoded.encode_utf16().count() <= limit {
        return Ok(());
    }
    let Some(mut result) = serde_json::from_str::<Value>(encoded)
        .ok()
        .filter(Value::is_object)
    else {
        preview_text(content, limit, "tool result");
        return Ok(());
    };
    let mut view = json!({"contentOmitted":true});
    for key in [
        "kind",
        "status",
        "resultStatus",
        "artifactRef",
        "artifactRefs",
        "evidenceRefs",
        "nativeContentRef",
    ] {
        if let Some(value) = result.get_mut(key) {
            view[key] = value.take();
        }
    }
    if let Some(code) = result["resultError"]["code"]
        .as_str()
        .or(result["error"]["code"].as_str())
    {
        view["errorCode"] = json!(code);
    }
    let mut preview = ["preview", "stdoutPreview", "output"]
        .into_iter()
        .filter_map(|key| result[key].as_str())
        .next()
        .map(|value| json!(value))
        .unwrap_or(Value::Null);
    if !preview.is_null() {
        preview_text(&mut preview, limit, "tool result");
        view["preview"] = preview;
    }
    *content = json!(javascript_json_string(&view).map_err(|_| LIMIT)?);
    Ok(())
}

// Match the existing TUI's UTF-16 budgets and head/tail distribution,
// rounding down at scalar boundaries so the request is always valid UTF-8.
fn preview_text(value: &mut Value, limit: usize, label: &str) {
    let Some(text) = value.as_str() else {
        return;
    };
    let units = text.encode_utf16().count();
    if units <= limit {
        return;
    }
    let omitted = format!("\n…[{label} truncated: {units} chars total]…\n");
    let available = limit - omitted.encode_utf16().count();
    let head_budget = (available * 3).div_ceil(5);
    let tail_budget = available - head_budget;
    let mut head_units = 0;
    let head_end = text
        .char_indices()
        .find_map(|(offset, ch)| {
            head_units += ch.len_utf16();
            (head_units > head_budget).then_some(offset)
        })
        .expect("over-budget head");
    let mut tail_units = 0;
    let tail_start = text
        .char_indices()
        .rev()
        .find_map(|(offset, ch)| {
            tail_units += ch.len_utf16();
            (tail_units > tail_budget).then_some(offset + ch.len_utf8())
        })
        .expect("over-budget tail");
    *value = json!(format!(
        "{}{omitted}{}",
        &text[..head_end],
        &text[tail_start..]
    ));
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_preserves_both_ends_and_complete_unicode_scalars() {
        let mut short = json!("short observation");
        preview_text(&mut short, TEXT_UNITS, "message text");
        assert_eq!(short, "short observation");

        let mut long = json!(format!("first{}last", "🧪".repeat(10_000)));
        preview_text(&mut long, TEXT_UNITS, "message text");
        let text = long.as_str().unwrap();
        assert!(text.starts_with("first"));
        assert!(text.ends_with("last"));
        assert!(text.contains("20009 chars total"));
        assert!(text.encode_utf16().count() <= TEXT_UNITS);
        assert!(!text.contains(char::REPLACEMENT_CHARACTER));
    }

    #[test]
    fn previous_summary_remains_retrievable_after_summary_input_preview() {
        let text = format!("first{}last", "x".repeat(INPUT_BYTES));
        let continuity = json!({"summary":text,"sourceMessageId":"original-marker","method":"llm"});
        let input = build(
            Some(&continuity),
            vec![json!({"role":"assistant","content":"saved observation"})],
        )
        .unwrap();
        let facts: Value = serde_json::from_str(&input).unwrap();
        assert_eq!(continuity["summary"], text);
        assert_eq!(facts["continuity"]["sourceMessageId"], "original-marker");
        let preview = facts["continuity"]["summary"].as_str().unwrap();
        assert!(preview.contains("previous summary truncated"));
        assert!(preview.starts_with("first") && preview.ends_with("last"));
        assert!(preview.len() < INPUT_BYTES);
        assert!(facts.get("omittedEarlierMessages").is_none());
    }

    #[test]
    fn structural_handoff_keeps_original_argument_result_pair_and_reference() {
        let reference = json!({"sha256":"source-digest","bytes":15_000});
        let result = json!({"status":"failed","preview":"observed ".repeat(500),"nativeContentRef":reference,
            "evidenceRefs":["tool-result://saved-call"],"error":{"code":"observed_error"}});
        let initial = build(None, vec![
            json!({"role":"assistant","toolCalls":[{"id":"saved-call","name":"read_file","arguments":"{}"}]}),
            json!({"role":"tool","toolCallId":"saved-call","name":"read_file","content":result.to_string()})
        ]).unwrap();
        let short = structural_fallback(&initial).unwrap();
        let saved: Value = serde_json::from_str(short.lines().last().unwrap()).unwrap();
        let messages = &saved["messages"];
        assert_eq!(messages[0]["toolCalls"][0]["id"], messages[1]["toolCallId"]);
        let observed: Value =
            serde_json::from_str(messages[1]["content"].as_str().unwrap()).unwrap();
        assert_eq!(observed["nativeContentRef"], reference);
        assert_eq!(observed["errorCode"], "observed_error");
        assert_eq!(observed["status"], "failed");
        assert_eq!(observed["contentOmitted"], true);
        assert_eq!(observed["evidenceRefs"], result["evidenceRefs"]);
    }
}
