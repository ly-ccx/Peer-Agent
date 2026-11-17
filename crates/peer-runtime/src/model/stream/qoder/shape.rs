//! Qoder's payload variants normalize into the same bounded Chat decoder.
//! A shape change cannot escape validation or create an implicit terminal.
use super::*;
mod blocks;
#[derive(Default)]
pub(super) struct Shape {
    mode: Option<Mode>,
    blocks: blocks::Blocks,
    identities: std::collections::BTreeMap<usize, Identity>,
}
#[derive(PartialEq, Clone, Copy)]
enum Mode {
    Chat,
    Blocks,
}
#[derive(Default)]
struct Identity {
    id: String,
    name: String,
}
impl Shape {
    fn select(&mut self, mode: Mode) -> Result<(), ModelError> {
        if self.mode.is_some_and(|old| old != mode) {
            return Err(ModelError::new("model_stream_invalid"));
        }
        self.mode = Some(mode);
        Ok(())
    }
    pub(super) fn terminal(&mut self, chat: &mut ChatStream) -> Result<bool, ModelError> {
        if self.mode == Some(Mode::Blocks) {
            self.blocks.settled()?;
        }
        if self.mode == Some(Mode::Chat) {
            // Names are provisional model intent until the physical terminal.
            // The existing TS adapter uses the last nonempty complete name.
            for (index, identity) in &self.identities {
                if !identity.name.is_empty() {
                    emit(
                        chat,
                        &serde_json::json!({"choices":[{"index":0,"delta":{"tool_calls":[{"index":index,"function":{"name":identity.name}}]}}]}),
                    )?;
                }
            }
        }
        chat.qoder_terminal()?;
        Ok(true)
    }
    pub(super) fn event(
        &mut self,
        chat: &mut ChatStream,
        event: &Value,
    ) -> Result<bool, ModelError> {
        if event["type"] == "ping" {
            return Ok(false);
        }
        if let Some(kind) = event["type"].as_str() {
            if matches!(
                kind,
                "message_start"
                    | "message_delta"
                    | "content_block_start"
                    | "content_block_delta"
                    | "content_block_stop"
                    | "message_stop"
            ) {
                if kind == "message_stop" {
                    return self.terminal(chat);
                }
                self.select(Mode::Blocks)?;
                self.blocks.event(chat, event)?;
                return Ok(false);
            }
            // Optional labels do not replace a recognized Chat payload. A
            // future control event without choices/usage remains unsupported.
            if !event["choices"].is_array() && !event["usage"].is_object() {
                return Err(ModelError::new("model_event_unsupported"));
            }
        }
        let mut v = event.clone();
        if v.get("choices").is_none() && v["usage"].is_object() {
            v["choices"] = serde_json::json!([]);
        }
        if let Some(raw) = v
            .as_object_mut()
            .and_then(|v| v.shift_remove("usage"))
            .filter(|v| !v.is_null())
        {
            chat.qoder_usage(&raw)?;
        }
        let choices = v["choices"]
            .as_array_mut()
            .ok_or(ModelError::new("model_stream_invalid"))?;
        if !choices.is_empty() {
            self.select(Mode::Chat)?;
        }
        if choices.len() == 1 {
            let c = &mut choices[0];
            if !c.is_object() {
                return Err(ModelError::new("model_stream_invalid"));
            }
            if c.get("index").is_none() {
                c["index"] = 0.into();
            }
            if let Some(d) = c.get_mut("delta").filter(|x| x.is_object()) {
                if let Some(content) = d.get("content") {
                    let text = text(content)?;
                    d["content"] = text.into();
                }
                for alias in [
                    "reasoning_content",
                    "reasoning",
                    "reasoning_text",
                    "thinking",
                    "thinking_content",
                    "reasoning_summary",
                ] {
                    if let Some(value) = d.get(alias) {
                        let thought = text(value)?;
                        if !thought.is_empty() {
                            d["reasoning_content"] = thought.into();
                            break;
                        }
                    }
                }
                if !d["error"].is_null() {
                    return Err(ModelError::new("qoder_stream_rejected"));
                }
                if let Some(calls) = d["tool_calls"].as_array_mut() {
                    let single = calls.len() == 1;
                    for call in calls {
                        if !call.is_object() {
                            return Err(ModelError::new("model_stream_invalid"));
                        }
                        if single && call.get("index").is_none() {
                            call["index"] = 0.into();
                        }
                        let i = call["index"]
                            .as_u64()
                            .filter(|n| *n < 32)
                            .ok_or(ModelError::new("model_tool_limit"))?
                            as usize;
                        let identity = self.identities.entry(i).or_default();
                        stable_field(call, "id", &mut identity.id, 512)?;
                        if let Some(function) = call.get_mut("function").filter(|v| !v.is_null()) {
                            if !function.is_object() {
                                return Err(ModelError::new("model_stream_invalid"));
                            }
                            if let Some(name) = function.get("name").filter(|v| !v.is_null()) {
                                let name = name
                                    .as_str()
                                    .filter(|s| s.len() <= 200)
                                    .ok_or(ModelError::new("model_call_id_invalid"))?;
                                if !name.is_empty() {
                                    identity.name = name.into();
                                }
                            }
                            if let Some(object) = function.as_object_mut() {
                                object.shift_remove("name");
                            }
                        }
                        if call["type"].is_null() {
                            call.as_object_mut().unwrap().shift_remove("type");
                        }
                    }
                }
            }
        }
        emit(chat, &v)?;
        Ok(false)
    }
}
fn stable_field(
    v: &mut Value,
    key: &str,
    previous: &mut String,
    limit: usize,
) -> Result<(), ModelError> {
    if let Some(value) = v.get(key).filter(|v| !v.is_null()) {
        let value = value
            .as_str()
            .filter(|s| s.len() <= limit)
            .ok_or(ModelError::new("model_call_id_invalid"))?;
        if value.is_empty() {
            v.as_object_mut().unwrap().shift_remove(key);
            return Ok(());
        }
        if previous.is_empty() {
            *previous = value.into();
        } else if previous != value {
            return Err(ModelError::new("model_call_id_invalid"));
        } else {
            v.as_object_mut().unwrap().shift_remove(key);
        }
    }
    Ok(())
}
fn text(value: &Value) -> Result<String, ModelError> {
    fn append(value: &Value, out: &mut String) -> Result<(), ModelError> {
        match value {
            Value::String(s) => {
                if out.len() + s.len() > 512 * 1024 {
                    return Err(ModelError::new("model_text_limit"));
                }
                out.push_str(s);
            }
            Value::Array(items) => {
                for item in items {
                    append(item, out)?;
                }
            }
            Value::Object(_) => {
                if let Some(v) = ["text", "content", "delta", "summary", "output_text"]
                    .iter()
                    .find_map(|k| value.get(*k).filter(|v| !v.is_null()))
                {
                    append(v, out)?;
                }
            }
            _ => {}
        }
        Ok(())
    }
    let mut out = String::new();
    append(value, &mut out)?;
    Ok(out)
}
fn emit(chat: &mut ChatStream, event: &Value) -> Result<(), ModelError> {
    chat.event(&serde_json::to_vec(event).map_err(|_| ModelError::new("model_stream_invalid"))?)
}
