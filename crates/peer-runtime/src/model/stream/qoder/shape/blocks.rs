//! Sparse content-block events are a Qoder shape, not an Anthropic wire switch.
//! Usage in Anthropic-only fields stays unknown; it is not Chat billing zero.
use super::*;
#[derive(Default)]
pub(super) struct Blocks {
    entries: std::collections::BTreeMap<usize, Entry>,
    tools: usize,
    started: bool,
    reason: bool,
}
struct Entry {
    kind: Kind,
    closed: bool,
}
enum Kind {
    Text,
    Thinking,
    Tool {
        index: usize,
        args: bool,
        initial: bool,
    },
}
impl Blocks {
    pub(super) fn settled(&self) -> Result<(), ModelError> {
        if self.entries.values().any(|e| !e.closed) {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        Ok(())
    }
    pub(super) fn event(&mut self, chat: &mut ChatStream, v: &Value) -> Result<(), ModelError> {
        match v["type"].as_str() {
            Some("message_start") => {
                if self.started
                    || !self.entries.is_empty()
                    || v["message"].get("role").is_some_and(|r| r != "assistant")
                {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                self.started = true;
            }
            Some("content_block_start") => {
                let index = index(v)?;
                if self.reason || index != self.entries.len() {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                let b = &v["content_block"];
                let kind = match b["type"].as_str() {
                    Some("text") => {
                        if let Some(value) = b.get("text").filter(|v| !v.is_null()) {
                            let part = value
                                .as_str()
                                .ok_or(ModelError::new("model_stream_invalid"))?;
                            delta(chat, serde_json::json!({"content":part}))?;
                        }
                        Kind::Text
                    }
                    Some("thinking") => {
                        if let Some(value) = b.get("thinking").filter(|v| !v.is_null()) {
                            let part = value
                                .as_str()
                                .ok_or(ModelError::new("model_stream_invalid"))?;
                            delta(chat, serde_json::json!({"reasoning_content":part}))?;
                        }
                        Kind::Thinking
                    }
                    Some("tool_use") => {
                        if self.tools >= 32 {
                            return Err(ModelError::new("model_tool_limit"));
                        }
                        let initial = match b.get("input").filter(|v| !v.is_null()) {
                            None => false,
                            Some(value) => !value
                                .as_object()
                                .ok_or(ModelError::new("model_arguments_invalid"))?
                                .is_empty(),
                        };
                        let args = if initial {
                            b["input"].to_string()
                        } else {
                            String::new()
                        };
                        let tool = self.tools;
                        self.tools += 1;
                        tool_delta(
                            chat,
                            tool,
                            serde_json::json!({"id":b["id"],"type":"function","function":{"name":b["name"],"arguments":args}}),
                        )?;
                        Kind::Tool {
                            index: tool,
                            args: initial,
                            initial,
                        }
                    }
                    _ => return Err(ModelError::new("model_block_unsupported")),
                };
                self.entries.insert(
                    index,
                    Entry {
                        kind,
                        closed: false,
                    },
                );
            }
            Some("content_block_delta") => {
                let entry = self
                    .entries
                    .get_mut(&index(v)?)
                    .filter(|e| !e.closed)
                    .ok_or(ModelError::new("model_stream_invalid"))?;
                let d = &v["delta"];
                match (&mut entry.kind, d["type"].as_str()) {
                    (Kind::Text, Some("text_delta")) => delta(
                        chat,
                        serde_json::json!({"content":d["text"].as_str().ok_or(ModelError::new("model_stream_invalid"))?}),
                    )?,
                    (Kind::Thinking, Some("thinking_delta")) => delta(
                        chat,
                        serde_json::json!({"reasoning_content":d["thinking"].as_str().ok_or(ModelError::new("model_stream_invalid"))?}),
                    )?,
                    (Kind::Thinking, Some("signature_delta")) => {
                        if !d["signature"].is_string() {
                            return Err(ModelError::new("model_stream_invalid"));
                        }
                    }
                    (
                        Kind::Tool {
                            index,
                            args,
                            initial: false,
                        },
                        Some("input_json_delta"),
                    ) => {
                        let part = d["partial_json"]
                            .as_str()
                            .ok_or(ModelError::new("model_arguments_invalid"))?;
                        if !part.is_empty() {
                            *args = true;
                        }
                        tool_delta(
                            chat,
                            *index,
                            serde_json::json!({"function":{"arguments":part}}),
                        )?;
                    }
                    _ => return Err(ModelError::new("model_stream_invalid")),
                }
            }
            Some("content_block_stop") => {
                let entry = self
                    .entries
                    .get_mut(&index(v)?)
                    .filter(|e| !e.closed)
                    .ok_or(ModelError::new("model_stream_invalid"))?;
                if let Kind::Tool {
                    index, args: false, ..
                } = &entry.kind
                {
                    tool_delta(
                        chat,
                        *index,
                        serde_json::json!({"function":{"arguments":"{}"}}),
                    )?;
                }
                entry.closed = true;
            }
            Some("message_delta") => {
                self.settled()?;
                if let Some(reason) = v["delta"]["stop_reason"].as_str() {
                    if self.reason {
                        return Err(ModelError::new("model_stream_invalid"));
                    }
                    self.reason = true;
                    let reason = match reason {
                        "end_turn" | "stop_sequence" => "stop",
                        "tool_use" => "tool_calls",
                        _ => return Err(ModelError::new("model_stream_incomplete")),
                    };
                    emit(
                        chat,
                        &serde_json::json!({"choices":[{"index":0,"delta":{},"finish_reason":reason}]}),
                    )?;
                }
            }
            _ => return Err(ModelError::new("model_event_unsupported")),
        }
        Ok(())
    }
}
fn index(v: &Value) -> Result<usize, ModelError> {
    v["index"]
        .as_u64()
        .filter(|n| *n < 128)
        .map(|n| n as usize)
        .ok_or(ModelError::new("model_block_limit"))
}
fn delta(chat: &mut ChatStream, d: Value) -> Result<(), ModelError> {
    emit(
        chat,
        &serde_json::json!({"choices":[{"index":0,"delta":d}]}),
    )
}
fn tool_delta(chat: &mut ChatStream, index: usize, mut call: Value) -> Result<(), ModelError> {
    call["index"] = index.into();
    delta(chat, serde_json::json!({"tool_calls":[call]}))
}
