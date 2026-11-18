use super::*;
#[derive(Default)]
pub(super) struct Gemini {
    pub(super) text: String,
    thought: String,
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
        let candidates = v["candidates"]
            .as_array()
            .ok_or(ModelError::new("model_stream_invalid"))?;
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
                    return Err(ModelError::new("model_stream_incomplete"));
                }
                self.done = true;
            }
        }
        Ok(self.done)
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if !self.done {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        let mut turn = finish(self.text, self.calls, self.usage, Wire::Gemini, fingerprint)?;
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
        self.native_bytes += serde_json::to_vec(part)
            .map_err(|_| ModelError::new("model_payload_invalid"))?
            .len();
        if self.native.len() >= 128 || self.native_bytes > 512 * 1024 {
            return Err(ModelError::new("model_continuation_limit"));
        }
        self.native.push(part.clone());
        Ok(())
    }
}
