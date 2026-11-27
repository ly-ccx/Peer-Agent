use super::*;
use serde_json::json;
use std::collections::BTreeMap;
#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}
#[derive(Default)]
pub(super) struct ChatStream {
    frames: super::sse_frame::Frames,
    pub(super) text: String,
    calls: BTreeMap<usize, Call>,
    pub(super) usage: Option<Value>,
    reason: Option<String>,
    done: bool,
    pub(super) thought: String,
}
impl ChatStream {
    pub(super) fn has_tool_intent(&self) -> bool {
        !self.calls.is_empty()
    }

    pub(super) fn reply_draft(&self) -> Option<String> {
        self.calls
            .values()
            .find(|call| call.name == reply_draft::REPLY_TOOL)
            .and_then(|call| reply_draft::from_json(&call.args))
    }

    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        let mut frames = std::mem::take(&mut self.frames);
        let result = frames.push(chunk, |kind, bytes| {
            self.event(kind, bytes)?;
            Ok(self.done)
        });
        self.frames = frames;
        result.map(|_| ())
    }
    pub fn terminal(&self) -> bool {
        self.done
    }
    pub(super) fn event(
        &mut self,
        kind: Option<&'static str>,
        bytes: &[u8],
    ) -> Result<(), ModelError> {
        if bytes == b"[DONE]" {
            if self.done {
                return Err(ModelError::new("model_stream_invalid"));
            }
            self.done = true;
            return Ok(());
        }
        if self.done {
            return Err(ModelError::new("model_stream_invalid"));
        }
        let v = decode(bytes, 1024 * 1024)?;
        if let Some(u) = v.get("usage").filter(|v| !v.is_null()) {
            if self.usage.is_some() {
                return Err(ModelError::new("model_usage_invalid"));
            }
            self.usage = Some(u.clone())
        }
        if let Some(kind) = kind.or_else(|| v.get("error").is_some().then_some("error")) {
            return Err(ModelError::provider_event(kind, &v));
        }
        let choices = v["choices"]
            .as_array()
            .ok_or(ModelError::new("model_stream_invalid"))?;
        if choices.len() > 1 {
            return Err(ModelError::new("model_choices_unsupported"));
        }
        let Some(c) = choices.first() else {
            return Ok(());
        };
        if c["index"] != 0 {
            return Err(ModelError::new("model_choices_unsupported"));
        }
        if let Some(r) = c["finish_reason"].as_str() {
            if self.reason.is_some() {
                return Err(ModelError::new("model_stream_invalid"));
            }
            self.reason = Some(r.into())
        }
        let d = &c["delta"];
        if let Some(t) = d["reasoning_content"]
            .as_str()
            .or_else(|| d["reasoning"].as_str())
        {
            if self.thought.len() + t.len() > 512 * 1024 {
                return Err(ModelError::new("model_text_limit"));
            }
            self.thought.push_str(t);
        }
        if let Some(t) = d["content"].as_str() {
            if self.text.len() + t.len() > 512 * 1024 {
                return Err(ModelError::new("model_text_limit"));
            }
            self.text.push_str(t)
        }
        if let Some(calls) = d["tool_calls"].as_array() {
            for t in calls {
                let i = t["index"]
                    .as_u64()
                    .filter(|i| *i < 32)
                    .ok_or(ModelError::new("model_tool_limit"))? as usize;
                let call = self.calls.entry(i).or_default();
                if let Some(id) = t["id"].as_str() {
                    if !call.id.is_empty() || id.is_empty() || id.len() > 512 {
                        return Err(ModelError::new("model_call_id_invalid"));
                    }
                    call.id = id.into()
                }
                if t.get("type").is_some_and(|v| v != "function") {
                    return Err(ModelError::new("model_tool_type_unsupported"));
                }
                if let Some(n) = t["function"]["name"].as_str() {
                    if call.name.len() + n.len() > 200 {
                        return Err(ModelError::new("model_tool_limit"));
                    }
                    call.name.push_str(n)
                }
                if let Some(a) = t["function"]["arguments"].as_str() {
                    if call.args.len() + a.len() > TOOL_ARGUMENT_BYTES {
                        return Err(ModelError::new("model_tool_limit"));
                    }
                    call.args.push_str(a)
                }
            }
        }
        Ok(())
    }
    pub(super) fn terminal_stop_error(&self) -> Option<ModelError> {
        self.reason
            .as_deref()
            .filter(|reason| !matches!(*reason, "stop" | "tool_calls"))
            .map(|reason| ModelError::terminal_stop("finish_reason", Some(reason)))
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if let Some(error) = self.terminal_stop_error() {
            return Err(error);
        }
        if !self.done || !self.frames.complete() {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        if self.calls.is_empty() && self.text.trim().is_empty() {
            return Err(ModelError::new("model_empty_response"));
        }
        if self.reason.is_none() {
            return Err(ModelError::terminal_stop("done", None));
        }
        if (self.reason.as_deref() == Some("tool_calls")) == self.calls.is_empty() {
            return Err(ModelError::new("model_stream_invalid"));
        }
        let mut calls = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for (index, c) in self.calls {
            if index != calls.len()
                || c.id.is_empty()
                || !ids.insert(c.id.clone())
                || c.name.is_empty()
            {
                return Err(ModelError::new("model_call_id_invalid"));
            }
            let arguments = decode(c.args.as_bytes(), TOOL_ARGUMENT_BYTES)?;
            if !arguments.is_object() {
                return Err(ModelError::new("model_arguments_invalid"));
            }
            calls.push(ModelToolCall {
                name: c.name,
                arguments,
                native_chat: Some((c.id, c.args)),
            })
        }
        let continuation = (!self.thought.is_empty()).then(|| continuation::Continuation {
            binding: String::new(),
            text: String::new(),
            wire: wire::Wire::Chat,
            blocks: vec![json!({"reasoning_content":self.thought})],
        });
        Ok(ModelTurn {
            content: self.text,
            thinking: self.thought,
            calls,
            usage: self
                .usage
                .as_ref()
                .map(|u| super::usage::normalize(wire::Wire::Chat, u))
                .transpose()?,
            request_fingerprint: fingerprint,
            continuation,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn fragments_are_only_calls_after_complete_terminal_stream() {
        let bytes=b"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"upstream\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]},\"finish_reason\":null}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n";
        for size in [1, 2, 17, bytes.len()] {
            let mut s = ChatStream::default();
            for c in bytes.chunks(size) {
                s.push(c).unwrap()
            }
            assert_eq!(
                s.finish("fingerprint".into()).unwrap().calls[0].name,
                "read_file"
            )
        }
        let mut s = ChatStream::default();
        s.push(&bytes[..bytes.len() - 16]).unwrap();
        assert!(matches!(
            s.finish(String::new()),
            Err(ModelError {
                code: "model_stream_incomplete",
                ..
            })
        ));
    }
}
