use super::*;
use std::collections::BTreeMap;
#[derive(Default)]
struct Call {
    id: String,
    name: String,
    args: String,
}
#[derive(Default)]
pub(super) struct ChatStream {
    line: Vec<u8>,
    event: Vec<u8>,
    bytes: usize,
    text: String,
    calls: BTreeMap<usize, Call>,
    usage: Option<Value>,
    reason: Option<String>,
    done: bool,
}
impl ChatStream {
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        self.bytes = self
            .bytes
            .checked_add(chunk.len())
            .ok_or(ModelError("model_response_limit"))?;
        if self.bytes > 8 * 1024 * 1024 {
            return Err(ModelError("model_response_limit"));
        }
        for b in chunk {
            if *b == b'\n' {
                self.line()?;
            } else {
                if self.line.len() >= 1024 * 1024 {
                    return Err(ModelError("model_event_limit"));
                }
                self.line.push(*b)
            }
        }
        Ok(())
    }
    fn line(&mut self) -> Result<(), ModelError> {
        if self.line.last() == Some(&b'\r') {
            self.line.pop();
        }
        if self.line.is_empty() {
            if !self.event.is_empty() {
                self.event()?;
            }
            return Ok(());
        }
        if let Some(data) = self.line.strip_prefix(b"data:") {
            let data = data.strip_prefix(b" ").unwrap_or(data);
            if self.event.len() + data.len() + 1 > 1024 * 1024 {
                return Err(ModelError("model_event_limit"));
            }
            if !self.event.is_empty() {
                self.event.push(b'\n')
            }
            self.event.extend_from_slice(data);
        }
        self.line.clear();
        Ok(())
    }
    fn event(&mut self) -> Result<(), ModelError> {
        let bytes = std::mem::take(&mut self.event);
        if bytes == b"[DONE]" {
            if self.done {
                return Err(ModelError("model_stream_invalid"));
            }
            self.done = true;
            return Ok(());
        }
        if self.done {
            return Err(ModelError("model_stream_invalid"));
        }
        let v = decode(&bytes, 1024 * 1024)?;
        if v.get("error").is_some() {
            return Err(ModelError("model_provider_error"));
        }
        if let Some(u) = v.get("usage").filter(|v| !v.is_null()) {
            if self.usage.is_some() {
                return Err(ModelError("model_usage_invalid"));
            }
            self.usage = Some(u.clone())
        }
        let choices = v["choices"]
            .as_array()
            .ok_or(ModelError("model_stream_invalid"))?;
        if choices.len() > 1 {
            return Err(ModelError("model_choices_unsupported"));
        }
        let Some(c) = choices.first() else {
            return Ok(());
        };
        if c["index"] != 0 {
            return Err(ModelError("model_choices_unsupported"));
        }
        if let Some(r) = c["finish_reason"].as_str() {
            if self.reason.is_some() {
                return Err(ModelError("model_stream_invalid"));
            }
            self.reason = Some(r.into())
        }
        let d = &c["delta"];
        if let Some(t) = d["content"].as_str() {
            if self.text.len() + t.len() > 512 * 1024 {
                return Err(ModelError("model_text_limit"));
            }
            self.text.push_str(t)
        }
        if let Some(calls) = d["tool_calls"].as_array() {
            for t in calls {
                let i = t["index"]
                    .as_u64()
                    .filter(|i| *i < 32)
                    .ok_or(ModelError("model_tool_limit"))? as usize;
                let call = self.calls.entry(i).or_default();
                if let Some(id) = t["id"].as_str() {
                    if !call.id.is_empty() || id.is_empty() || id.len() > 512 {
                        return Err(ModelError("model_call_id_invalid"));
                    }
                    call.id = id.into()
                }
                if t.get("type").is_some_and(|v| v != "function") {
                    return Err(ModelError("model_tool_type_unsupported"));
                }
                if let Some(n) = t["function"]["name"].as_str() {
                    if call.name.len() + n.len() > 200 {
                        return Err(ModelError("model_tool_limit"));
                    }
                    call.name.push_str(n)
                }
                if let Some(a) = t["function"]["arguments"].as_str() {
                    if call.args.len() + a.len() > 65536 {
                        return Err(ModelError("model_tool_limit"));
                    }
                    call.args.push_str(a)
                }
            }
        }
        Ok(())
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if self.calls.is_empty() && self.text.trim().is_empty() {
            return Err(ModelError("model_empty_response"));
        }
        if !self.done
            || !self.line.is_empty()
            || !self.event.is_empty()
            || !matches!(self.reason.as_deref(), Some("stop" | "tool_calls"))
        {
            return Err(ModelError("model_stream_incomplete"));
        }
        if (self.reason.as_deref() == Some("tool_calls")) == self.calls.is_empty() {
            return Err(ModelError("model_stream_invalid"));
        }
        let mut calls = Vec::new();
        let mut ids = std::collections::HashSet::new();
        for (index, c) in self.calls {
            if index != calls.len() || c.id.is_empty() || !ids.insert(c.id) || c.name.is_empty() {
                return Err(ModelError("model_call_id_invalid"));
            }
            let arguments = decode(c.args.as_bytes(), 65536)?;
            if !arguments.is_object() {
                return Err(ModelError("model_arguments_invalid"));
            }
            calls.push(ModelToolCall {
                name: c.name,
                arguments,
            })
        }
        Ok(ModelTurn {
            content: self.text,
            calls,
            usage: self.usage,
            request_fingerprint: fingerprint,
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
            Err(ModelError("model_stream_incomplete"))
        ));
    }
}
