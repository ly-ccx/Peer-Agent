use super::*;
#[derive(Default)]
pub(super) struct Gemini {
    pub(super) text: String,
    pub(super) thought: String,
    calls: Vec<ModelToolCall>,
    pub(super) usage: Option<Value>,
    native: Vec<Value>,
    native_bytes: usize,
    pub done: bool,
}
impl Gemini {
    pub fn event(&mut self, event: &Value) -> Result<bool, ModelError> {
        let v = event.get("response").unwrap_or(event);
        if event.get("error").is_some()
            || v.get("error").is_some()
            || v["promptFeedback"].get("blockReason").is_some()
        {
            return Err(ModelError::new("model_provider_error"));
        }
        if let Some(usage) = v.get("usageMetadata") {
            self.usage = Some(usage.clone());
        }
        let candidates = match v.get("candidates").and_then(Value::as_array) {
            Some(c) => c.as_slice(),
            None if v.get("usageMetadata").is_some() => &[],
            None => return Err(ModelError::new("model_stream_invalid")),
        };
        if candidates.len() > 1 {
            return Err(ModelError::new("model_choices_unsupported"));
        }
        if let Some(c) = candidates.first() {
            if c.get("index").is_some_and(|i| i != 0) {
                return Err(ModelError::new("model_choices_unsupported"));
            }
            if let Some(parts) = c["content"]["parts"].as_array() {
                for part in parts {
                    if let Some(t) = part.get("text") {
                        append(
                            if part["thought"] == true {
                                &mut self.thought
                            } else {
                                &mut self.text
                            },
                            t,
                            512 * 1024,
                        )?;
                        self.remember(part)?;
                    } else if let Some(f) = part.get("functionCall") {
                        if self.calls.len() >= 32 {
                            return Err(ModelError::new("model_tool_limit"));
                        }
                        self.calls.push(call(
                            name(&f["name"], 200)?,
                            &f.get("args")
                                .cloned()
                                .unwrap_or_else(|| serde_json::json!({}))
                                .to_string(),
                        )?);
                        self.remember(part)?;
                    } else if part.get("thoughtSignature").is_some()
                        && part.as_object().is_some_and(|o| {
                            o.keys()
                                .all(|k| matches!(k.as_str(), "thoughtSignature" | "thought"))
                        })
                    {
                        self.remember(part)?;
                    } else {
                        return Err(ModelError::new("model_block_unsupported"));
                    }
                }
            }
            if let Some(reason) = c["finishReason"]
                .as_str()
                .filter(|r| *r != "FINISH_REASON_UNSPECIFIED")
            {
                if reason != "STOP" {
                    return Err(ModelError::new("model_stream_incomplete")
                        .with_detail(format!("finishReason={reason}")));
                }
                self.done = true;
            }
        }
        Ok(self.done)
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if !self.done {
            return Err(
                ModelError::new("model_stream_incomplete").with_detail("eof_before_finish_reason")
            );
        }
        let mut turn = finish(
            self.text,
            self.thought,
            self.calls,
            self.usage,
            Wire::Gemini,
            fingerprint,
        )?;
        turn.continuation =
            (!self.native.is_empty()).then_some(super::super::continuation::Continuation {
                binding: String::new(),
                text: String::new(),
                wire: Wire::Gemini,
                blocks: self.native,
            });
        Ok(turn)
    }
    fn remember(&mut self, part: &Value) -> Result<(), ModelError> {
        if let Some((thought, text)) = plain_text_part(part)
            && let Some(last) = self.native.last_mut()
            && plain_text_part(last).is_some_and(|(last_thought, _)| last_thought == thought)
        {
            if self.native_bytes.saturating_add(text.len()) > 512 * 1024 {
                return Err(ModelError::new("model_continuation_limit"));
            }
            if let Some(Value::String(existing)) =
                last.as_object_mut().and_then(|o| o.get_mut("text"))
            {
                existing.push_str(text);
                self.native_bytes += text.len();
                return Ok(());
            }
        }
        let encoded_len = serde_json::to_vec(part)
            .map_err(|_| ModelError::new("model_payload_invalid"))?
            .len();
        if self.native.len() >= 128 || self.native_bytes.saturating_add(encoded_len) > 512 * 1024 {
            return Err(ModelError::new("model_continuation_limit"));
        }
        self.native_bytes += encoded_len;
        self.native.push(part.clone());
        Ok(())
    }
}

fn plain_text_part(part: &Value) -> Option<(bool, &str)> {
    let obj = part.as_object()?;
    let text = obj.get("text")?.as_str()?;
    let thought = match obj.get("thought") {
        None => false,
        Some(Value::Bool(b)) => *b,
        Some(_) => return None,
    };
    obj.keys()
        .all(|k| matches!(k.as_str(), "text" | "thought"))
        .then_some((thought, text))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn coalesces_long_thought_and_text_streams_and_accepts_signature_only_parts() {
        let mut decoder = Gemini::default();
        for _ in 0..160 {
            assert!(
                !decoder
                    .event(&json!({
                        "candidates": [{"index": 0, "content": {"parts": [{"text": "t", "thought": true}]}}]
                    }))
                    .unwrap()
            );
        }
        assert!(
            !decoder
                .event(&json!({
                    "candidates": [{"index": 0, "content": {"parts": [{"thoughtSignature": "sig-thought", "thought": true}]}}]
                }))
                .unwrap()
        );
        for _ in 0..160 {
            assert!(
                !decoder
                    .event(&json!({
                        "candidates": [{"index": 0, "content": {"parts": [{"text": "a"}]}}]
                    }))
                    .unwrap()
            );
        }
        assert!(
            decoder
                .event(&json!({
                    "candidates": [{
                        "index": 0,
                        "content": {"parts": [{"functionCall": {"name": "read_file", "args": {"path": "x"}}, "thoughtSignature": "sig-call"}]},
                        "finishReason": "STOP"
                    }],
                    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 5, "totalTokenCount": 15}
                }))
                .unwrap()
        );
        assert!(
            decoder
                .event(&json!({
                    "usageMetadata": {"promptTokenCount": 10, "candidatesTokenCount": 6, "totalTokenCount": 16}
                }))
                .unwrap()
        );
        let turn = decoder.finish("fp".into()).unwrap();
        assert_eq!(turn.thinking.len(), 160);
        assert_eq!(turn.content.len(), 160);
        assert_eq!(turn.calls.len(), 1);
        let blocks = turn.continuation.unwrap().blocks;
        assert_eq!(blocks.len(), 4);
        assert_eq!(blocks[1]["thoughtSignature"], "sig-thought");
        assert_eq!(blocks[3]["thoughtSignature"], "sig-call");
    }
}
