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
    /// Bind authentic provider continuation captured from a live `ModelTurn`
    /// to the exact canonical messages built for its tool calls and results.
    pub fn remember_turn(
        &mut self,
        history: &Value,
        ids: &[String],
        turn: &mut super::ModelTurn,
    ) -> Result<(), ModelError> {
        self.remember(history, ids, turn.continuation.take())
    }

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
        let expected_sanitized = crate::canonical_history::sanitize_assistant(&continuation.text);
        let expected = peer_protocol::javascript_trim(&expected_sanitized);
        if !expected.is_empty() {
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

    #[test]
    fn live_replay_matches_canonical_history_trimmed_assistant_text_with_parallel_tools() {
        let raw_text = "  刚才那条命令被拒绝了，我换一种方式重新核对。\n\n";
        let transcript = vec![
            json!({
                "id": "m-user",
                "role": "user",
                "content": "继续",
            }),
            json!({
                "id": "m-asst",
                "role": "assistant",
                "content": raw_text,
                "thinkingContent": "thought",
                "segments": [
                    {"type": "thinking", "content": "thought"},
                    {"type": "text", "content": raw_text},
                ],
            }),
            json!({
                "id": "m-call-1",
                "role": "assistant",
                "content": "",
                "segments": [
                    {"type": "tool-call", "tool": "bash", "toolCallId": "call-1", "args": {"cmd": "echo 1"}},
                ],
            }),
            json!({
                "id": "m-res-1",
                "role": "tool",
                "toolCallId": "call-1",
                "name": "bash",
                "content": "ok-1",
            }),
            json!({
                "id": "m-call-2",
                "role": "assistant",
                "content": "",
                "segments": [
                    {"type": "tool-call", "tool": "bash", "toolCallId": "call-2", "args": {"cmd": "echo 2"}},
                ],
            }),
            json!({
                "id": "m-res-2",
                "role": "tool",
                "toolCallId": "call-2",
                "name": "bash",
                "content": "ok-2",
            }),
        ];
        let projected = crate::canonical_history::project_history(&transcript).unwrap();
        let mut live = LiveHistory::default();
        live.remember(
            &projected,
            &["call-1".into(), "call-2".into()],
            Some(Continuation {
                binding: "opencode-go".into(),
                text: raw_text.to_owned(),
                wire: Wire::Chat,
                blocks: vec![json!({"reasoning_content": "thought"})],
            }),
        )
        .unwrap();

        let mut lowered = lower(&projected).unwrap();
        live.apply("opencode-go", &mut lowered);
        assert_eq!(lowered.len(), 4);
        assert_eq!(lowered[0]["role"], "user");
        assert_eq!(
            lowered[1]["content"],
            "刚才那条命令被拒绝了，我换一种方式重新核对。"
        );
        assert_eq!(lowered[1]["reasoning_content"], "thought");
        assert_eq!(lowered[1]["tool_calls"][0]["id"], "call-1");
        assert_eq!(lowered[1]["tool_calls"][1]["id"], "call-2");
        assert_eq!(lowered[2]["tool_call_id"], "call-1");
        assert_eq!(lowered[3]["tool_call_id"], "call-2");

        let mut tampered_live = LiveHistory::default();
        let err = tampered_live
            .remember(
                &projected,
                &["call-1".into(), "call-2".into()],
                Some(Continuation {
                    binding: "opencode-go".into(),
                    text: "篡改后的正文\n\n".into(),
                    wire: Wire::Chat,
                    blocks: vec![json!({"reasoning_content": "thought"})],
                }),
            )
            .unwrap_err();
        assert_eq!(err.code, "model_continuation_identity_changed");
    }
}
