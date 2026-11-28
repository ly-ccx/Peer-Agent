use super::*;
use std::collections::{BTreeMap, HashSet};
enum Block {
    Text,
    Thinking {
        text: String,
        signature: String,
    },
    Tool {
        id: String,
        name: String,
        args: String,
        initial: Option<serde_json::Map<String, Value>>,
    },
    Redacted {
        data: String,
    },
}
#[derive(Default)]
pub(super) struct Anthropic {
    blocks: BTreeMap<usize, Block>,
    closed: HashSet<usize>,
    pub(super) text: String,
    pub(super) thought: String,
    pub(super) usage: Option<Value>,
    reason: Option<String>,
    started: bool,
    pub done: bool,
}
impl Anthropic {
    pub(super) fn has_tool_intent(&self) -> bool {
        self.blocks
            .values()
            .any(|block| matches!(block, Block::Tool { .. }))
    }

    pub(super) fn reply_draft(&self) -> Option<String> {
        let (args, initial) = self.blocks.values().find_map(|block| match block {
            Block::Tool {
                name,
                args,
                initial,
                ..
            } if name == reply_draft::REPLY_TOOL => Some((args, initial)),
            _ => None,
        })?;
        if args.is_empty() {
            initial
                .as_ref()?
                .get("text")?
                .as_str()
                .and_then(reply_draft::from_text)
        } else {
            reply_draft::from_json(args)
        }
    }

    pub fn event(&mut self, v: &Value) -> Result<bool, ModelError> {
        if v["type"] == "error" || v.get("error").is_some() {
            return Err(ModelError::provider_event("error", v));
        }
        match v["type"].as_str() {
            Some("ping") => {}
            Some("message_start") => {
                if self.started || v["message"]["role"] != "assistant" {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                self.started = true;
                self.usage = v["message"].get("usage").filter(|u| !u.is_null()).cloned();
            }
            Some("content_block_start") => {
                if !self.started || self.reason.is_some() {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                let index = index(v)?;
                if self.blocks.contains_key(&index) || index != self.blocks.len() {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                let b = &v["content_block"];
                let block = match b["type"].as_str() {
                    Some("text") => {
                        append(&mut self.text, &b["text"], 512 * 1024)?;
                        Block::Text
                    }
                    Some("thinking") => {
                        let mut text = String::new();
                        append(&mut text, &b["thinking"], 512 * 1024)?;
                        if !text.is_empty() {
                            append(&mut self.thought, &b["thinking"], 512 * 1024)?;
                        }
                        Block::Thinking {
                            text,
                            signature: String::new(),
                        }
                    }
                    Some("redacted_thinking") => Block::Redacted {
                        data: name(&b["data"], 65536)?,
                    },
                    Some("tool_use") => {
                        if self
                            .blocks
                            .values()
                            .filter(|b| matches!(b, Block::Tool { .. }))
                            .count()
                            >= 32
                        {
                            return Err(ModelError::new("model_tool_limit"));
                        }
                        // Some compatible streams supply input only in JSON deltas.
                        let initial = match b.get("input") {
                            None => None,
                            Some(Value::Object(input)) => Some(input.clone()),
                            Some(_) => return Err(ModelError::new("model_arguments_invalid")),
                        };
                        Block::Tool {
                            id: name(&b["id"], 512)?,
                            name: name(&b["name"], 200)?,
                            args: String::new(),
                            initial,
                        }
                    }
                    _ => return Err(ModelError::new("model_block_unsupported")),
                };
                self.blocks.insert(index, block);
            }
            Some("content_block_delta") => {
                let index = index(v)?;
                if self.closed.contains(&index) {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                let block = self
                    .blocks
                    .get_mut(&index)
                    .ok_or(ModelError::new("model_stream_invalid"))?;
                let d = &v["delta"];
                match (block, d["type"].as_str()) {
                    (Block::Text, Some("text_delta")) => {
                        append(&mut self.text, &d["text"], 512 * 1024)?
                    }
                    (Block::Thinking { text, .. }, Some("thinking_delta")) => {
                        append(text, &d["thinking"], 512 * 1024)?;
                        append(&mut self.thought, &d["thinking"], 512 * 1024)?;
                    }
                    (Block::Thinking { signature, .. }, Some("signature_delta")) => {
                        append(signature, &d["signature"], 65536)?
                    }
                    (Block::Tool { args, initial, .. }, Some("input_json_delta"))
                        if initial.as_ref().is_none_or(serde_json::Map::is_empty) =>
                    {
                        append(args, &d["partial_json"], super::super::TOOL_ARGUMENT_BYTES)?
                    }
                    _ => return Err(ModelError::new("model_stream_invalid")),
                }
            }
            Some("content_block_stop") => {
                let index = index(v)?;
                if !self.blocks.contains_key(&index) || !self.closed.insert(index) {
                    return Err(ModelError::new("model_stream_invalid"));
                }
            }
            Some("message_delta") => {
                if !self.started || self.closed.len() != self.blocks.len() {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                if let Some(reason) = v["delta"]["stop_reason"].as_str()
                    && self.reason.replace(reason.into()).is_some()
                {
                    return Err(ModelError::new("model_stream_invalid"));
                }
                if let Some(usage) = v.get("usage").filter(|v| !v.is_null()) {
                    let object = usage
                        .as_object()
                        .ok_or(ModelError::new("model_usage_invalid"))?;
                    let accumulated = self
                        .usage
                        .get_or_insert_with(|| serde_json::json!({}))
                        .as_object_mut()
                        .ok_or(ModelError::new("model_usage_invalid"))?;
                    for (key, val) in object {
                        accumulated.insert(key.clone(), val.clone());
                    }
                }
            }
            Some("message_stop") => {
                if !self.started
                    || self.closed.len() != self.blocks.len()
                    || !matches!(
                        self.reason.as_deref(),
                        Some("end_turn" | "tool_use" | "stop_sequence")
                    )
                {
                    return Err(ModelError::terminal_stop(
                        "message_stop",
                        self.reason.as_deref(),
                    ));
                }
                self.done = true;
            }
            _ => return Err(ModelError::new("model_event_unsupported")),
        }
        Ok(self.done)
    }
    pub(super) fn terminal_stop_error(&self) -> Option<ModelError> {
        self.reason
            .as_deref()
            .filter(|reason| !matches!(*reason, "end_turn" | "tool_use" | "stop_sequence"))
            .map(|reason| ModelError::terminal_stop("message_delta", Some(reason)))
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if !self.done {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        let mut calls = Vec::new();
        let mut blocks = Vec::new();
        let mut ids = HashSet::new();
        for block in self.blocks.into_values() {
            if let Block::Thinking { text, signature } = block {
                let mut b = serde_json::json!({"type":"thinking","thinking":text});
                if !signature.is_empty() {
                    b["signature"] = signature.into();
                }
                blocks.push(b);
            } else if let Block::Redacted { data } = block {
                blocks.push(serde_json::json!({"type":"redacted_thinking","data":data}));
            } else if let Block::Tool {
                id,
                name,
                args,
                initial,
            } = block
            {
                if !ids.insert(id) {
                    return Err(ModelError::new("model_call_id_invalid"));
                }
                let args = if args.is_empty() {
                    // Omission is safe only when the provider supplies an entire input.
                    Value::Object(initial.ok_or(ModelError::new("model_arguments_invalid"))?)
                        .to_string()
                } else {
                    args
                };
                calls.push(call(name, &args)?);
            }
        }
        if (self.reason.as_deref() == Some("tool_use")) == calls.is_empty() {
            return Err(ModelError::new("model_stream_invalid"));
        }
        let mut turn = finish(
            self.text,
            self.thought,
            calls,
            self.usage,
            Wire::Anthropic,
            fingerprint,
        )?;
        turn.continuation =
            (!blocks.is_empty()).then_some(super::super::continuation::Continuation {
                binding: String::new(),
                text: String::new(),
                wire: Wire::Anthropic,
                blocks,
            });
        Ok(turn)
    }
}
fn index(v: &Value) -> Result<usize, ModelError> {
    v["index"]
        .as_u64()
        .filter(|i| *i < 128)
        .map(|i| i as usize)
        .ok_or(ModelError::new("model_block_limit"))
}
