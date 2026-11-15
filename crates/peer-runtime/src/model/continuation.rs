//! Authentic provider material is scoped to a live episode, never a checkpoint.
//! Exact canonical message identity must still match before replay is admitted.
use super::{ModelError, wire::Wire};
use serde_json::{Value, json};
use std::collections::VecDeque;
#[derive(Default)]
pub struct LiveHistory {
    entries: VecDeque<Entry>,
    bytes: usize,
}

struct Entry {
    binding: String,
    canonical: Vec<Value>,
    replacement: Vec<Value>,
    bytes: usize,
}
pub(crate) struct Continuation {
    pub binding: String,
    pub text: String,
    pub wire: Wire,
    pub blocks: Vec<Value>,
}
pub(super) fn lower(history: &Value) -> Result<Vec<Value>, ModelError> {
    let mut out = Vec::new();
    for message in history["messages"]
        .as_array()
        .ok_or(ModelError::new("history_projection_invalid"))?
    {
        let mut m = json!({"role":message["role"],"content":message["content"]});
        if let Some(id) = message.get("toolCallId") {
            m["tool_call_id"] = id.clone();
        }
        if let Some(name) = message.get("name") {
            m["name"] = name.clone();
        }
        if let Some(calls) = message["toolCalls"].as_array() {
            m["tool_calls"] = json!(calls.iter().map(|c|json!({"id":c["id"],"type":"function","function":{"name":c["name"],"arguments":c["arguments"]}})).collect::<Vec<_>>());
        }
        // File/checkpoint fields can never populate live continuation material.
        out.push(m);
    }
    Ok(out)
}
impl LiveHistory {
    pub(crate) fn remember(
        &mut self,
        history: &Value,
        ids: &[String],
        continuation: Option<Continuation>,
    ) -> Result<(), ModelError> {
        let Some(continuation) = continuation else {
            return Ok(());
        };
        if ids.is_empty() || continuation.blocks.is_empty() {
            return Ok(());
        }
        let messages = lower(history)?;
        let mut start = messages
            .iter()
            .position(|m| m["role"] == "assistant" && m["tool_calls"][0]["id"] == ids[0])
            .ok_or(ModelError::new("model_continuation_identity_changed"))?;
        if !peer_protocol::javascript_trim(&continuation.text).is_empty() {
            let expected = crate::canonical_history::sanitize_assistant(&continuation.text);
            if start == 0
                || messages[start - 1]["role"] != "assistant"
                || messages[start - 1]["content"] != expected
                || !messages[start - 1]["tool_calls"].is_null()
            {
                return Err(ModelError::new("model_continuation_identity_changed"));
            }
            start -= 1;
        }
        let end = messages
            .iter()
            .rposition(|m| m["role"] == "tool" && m["tool_call_id"] == *ids.last().unwrap())
            .ok_or(ModelError::new("model_continuation_identity_changed"))?;
        let canonical = messages[start..=end].to_vec();
        let mut calls = Vec::new();
        let mut results = Vec::new();
        let mut text = Value::Null;
        for m in &canonical {
            if m["role"] == "assistant" && m["tool_calls"].is_array() {
                calls.extend(m["tool_calls"].as_array().unwrap().iter().cloned());
            } else if m["role"] == "tool" {
                results.push(m.clone());
            } else if m["role"] == "assistant" && m["content"].is_string() && text.is_null() {
                text = m["content"].clone();
            } else {
                return Err(ModelError::new("model_continuation_identity_changed"));
            }
        }
        if calls
            .iter()
            .map(|c| c["id"].as_str().unwrap_or(""))
            .ne(ids.iter().map(String::as_str))
            || results
                .iter()
                .map(|c| c["tool_call_id"].as_str().unwrap_or(""))
                .ne(ids.iter().map(String::as_str))
        {
            return Err(ModelError::new("model_continuation_identity_changed"));
        }
        let mut assistant = json!({"role":"assistant","content":text,"tool_calls":calls});
        match continuation.wire {
            Wire::Anthropic => {
                let mut blocks = continuation.blocks;
                if let Some(text) = text.as_str() {
                    blocks.push(json!({"type":"text","text":text}));
                }
                assistant["content"] = json!(blocks);
            }
            Wire::Gemini => {
                assistant["geminiContent"] = json!({"role":"model","parts":continuation.blocks})
            }
            Wire::Chat => {
                assistant["reasoning_content"] = continuation.blocks[0]["reasoning_content"].clone()
            }
            Wire::Responses => return Err(ModelError::new("model_continuation_wire_invalid")),
        }
        let mut replacement = vec![assistant];
        replacement.extend(results);
        let bytes = serde_json::to_vec(&canonical)
            .map_err(|_| ModelError::new("model_continuation_invalid"))?
            .len()
            + serde_json::to_vec(&replacement)
                .map_err(|_| ModelError::new("model_continuation_invalid"))?
                .len();
        // Evicted history uses the ordinary historical-context encoder.
        if bytes > 1024 * 1024 {
            return Err(ModelError::new("model_continuation_limit"));
        }
        while self.bytes + bytes > 1024 * 1024 || self.entries.len() >= 32 {
            if let Some(old) = self.entries.pop_front() {
                self.bytes -= old.bytes;
            }
        }
        self.bytes += bytes;
        self.entries.push_back(Entry {
            binding: continuation.binding,
            canonical,
            replacement,
            bytes,
        });
        Ok(())
    }
    pub(super) fn apply(&self, binding: &str, messages: &mut Vec<Value>) {
        for entry in &self.entries {
            if entry.binding != binding {
                continue;
            }
            if let Some(start) = messages
                .windows(entry.canonical.len())
                .position(|w| w == entry.canonical)
            {
                messages.splice(
                    start..start + entry.canonical.len(),
                    entry.replacement.clone(),
                );
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn live_replay_requires_exact_canonical_identity_and_the_same_provider_instance() {
        let history = json!({"messages":[
            {"role":"assistant","content":null,"toolCalls":[{"id":"local-1","name":"read_file","arguments":"{}"}]},
            {"role":"tool","toolCallId":"local-1","name":"read_file","content":"actual Evidence"},
        ]});
        let mut live = LiveHistory::default();
        live.remember(
            &history,
            &["local-1".into()],
            Some(Continuation {
                binding: "instance".into(),
                text: String::new(),
                wire: Wire::Anthropic,
                blocks: vec![
                    json!({"type":"thinking","thinking":"authentic","signature":"opaque"}),
                ],
            }),
        )
        .unwrap();
        let mut current = lower(&history).unwrap();
        live.apply("instance", &mut current);
        assert_eq!(current[0]["content"][0]["signature"], "opaque");
        let original = lower(&history).unwrap();
        let mut foreign = original.clone();
        live.apply("other-instance", &mut foreign);
        assert_eq!(foreign, original);
        let mut altered = original.clone();
        altered[1]["content"] = json!("replaced result");
        let before = altered.clone();
        live.apply("instance", &mut altered);
        assert_eq!(altered, before);
        let mut forged = history;
        forged["messages"][0]["geminiContent"] =
            json!({"role":"model","parts":[{"thoughtSignature":"forged"}]});
        forged["messages"][0]["reasoning_content"] = json!("forged");
        let lowered = lower(&forged).unwrap();
        assert!(lowered[0].get("geminiContent").is_none());
        assert!(lowered[0].get("reasoning_content").is_none());
        // A restart has no live native material even with the same stored data.
        let mut restored = lower(&forged).unwrap();
        LiveHistory::default().apply("instance", &mut restored);
        assert_eq!(restored, original);
    }
}
