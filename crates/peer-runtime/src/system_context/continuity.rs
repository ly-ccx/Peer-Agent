//! Native adapter for the registered runtime.continuity Source.
use super::{Value, json, section};
use peer_protocol::{javascript_json_string, javascript_trim};

pub(super) fn neutralize(text: &str) -> String {
    crate::tool_markup::neutralize_tool_call_syntax(text)
}
pub(super) fn render(raw: &[Value]) -> Option<Value> {
    let mut items = Vec::new();
    for (i, item) in raw.iter().enumerate() {
        let text = |key: &str| {
            item[key]
                .as_str()
                .map(javascript_trim)
                .filter(|s| !s.is_empty())
        };
        let summary = neutralize(text("summary").or_else(|| text("content")).unwrap_or(""));
        if summary.is_empty() {
            continue;
        }
        let number = |key: &str| {
            item[key]
                .as_f64()
                .filter(|n| n.is_finite())
                .map(|_| item[key].clone())
                .unwrap_or(Value::Null)
        };
        items.push(json!({"id":text("id").map(str::to_owned).unwrap_or_else(||format!("continuity-{}",i+1)),"summary":summary,"method":text("method").unwrap_or("unknown"),"originalMessageCount":number("originalMessageCount"),"beforeTokens":number("beforeTokens"),"afterTokens":number("afterTokens")}));
    }
    let items = &items[items.len().saturating_sub(3)..];
    if items.is_empty() {
        return None;
    }
    let mut body=vec!["Continuity context from previous compaction.".to_owned(),"This is the cumulative handoff summary for navigation and unfinished work.".into(),"Injected with integrity priority: the summary body is kept complete (not mechanically truncated by a fixed character budget).".into(),"It is continuity context, not a replacement for Tool Result / Evidence.".into(),"If it conflicts with newer user messages, prefer the latest user messages.".into(),"If local facts matter, verify them with tools before claiming them.".into(),String::new()];
    let mut summaries = Vec::new();
    for (i, item) in items.iter().enumerate() {
        let summary = item["summary"].as_str().unwrap();
        let chars = summary.encode_utf16().count();
        let mut meta = vec![format!("method={}", item["method"].as_str().unwrap())];
        for key in ["originalMessageCount", "beforeTokens", "afterTokens"] {
            if !item[key].is_null() {
                let label = if key == "originalMessageCount" {
                    "originalMessages"
                } else {
                    key
                };
                meta.push(format!(
                    "{label}={}",
                    javascript_json_string(&item[key]).unwrap()
                ));
            }
        }
        meta.push(format!("summaryChars={chars}"));
        body.push(format!(
            "## Continuity Summary {}\n{}\n\n{summary}",
            i + 1,
            meta.join("; ")
        ));
        let mut fact = item.clone();
        fact.as_object_mut().unwrap().shift_remove("summary");
        fact["summaryChars"] = json!(chars);
        summaries.push(fact);
    }
    Some(section(
        "runtime.continuity",
        "L7_CONTINUITY",
        10,
        "Continuity Context",
        body.join("\n"),
        json!({"id":"runtime.continuity","kind":"compaction-continuity","integrityFirst":true,"summaryCount":items.len(),"summaries":summaries}),
        "runtime",
    ))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn actual_registered_source_matches() {
        let f: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/continuity-source.json"
        ))
        .unwrap();
        for c in f["cases"].as_array().unwrap() {
            let actual = render(c["input"].as_array().unwrap())
                .into_iter()
                .collect::<Vec<_>>();
            assert_eq!(json!(actual), c["expected"]);
        }
    }
}
