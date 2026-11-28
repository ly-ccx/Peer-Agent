use super::*;
use std::collections::{BTreeMap, HashSet};
struct Item {
    id: String,
    call_id: String,
    name: String,
    args: String,
    closed: bool,
}
#[derive(Default)]
pub(super) struct Responses {
    pub(super) text: String,
    pub(super) thought: String,
    items: BTreeMap<usize, Item>,
    pub(super) usage: Option<Value>,
    pub done: bool,
}
impl Responses {
    pub(super) fn has_tool_intent(&self) -> bool {
        !self.items.is_empty()
    }

    pub(super) fn reply_draft(&self) -> Option<String> {
        self.items
            .values()
            .find(|item| item.name == reply_draft::REPLY_TOOL)
            .and_then(|item| reply_draft::from_json(&item.args))
    }

    pub fn event(&mut self, v: &Value) -> Result<bool, ModelError> {
        match v["type"].as_str() {
            Some(kind @ ("response.failed" | "response.incomplete" | "error")) => {
                self.usage = v
                    .pointer("/response/usage")
                    .filter(|u| !u.is_null())
                    .cloned();
                return Err(ModelError::provider_event(
                    match kind {
                        "response.failed" => "response.failed",
                        "response.incomplete" => "response.incomplete",
                        _ => "error",
                    },
                    v,
                ));
            }
            Some("response.output_text.delta") => append(&mut self.text, &v["delta"], 512 * 1024)?,
            Some("response.reasoning_summary_text.delta" | "response.reasoning_text.delta") => {
                append(&mut self.thought, &v["delta"], 512 * 1024)?
            }
            Some("response.refusal.delta" | "response.refusal.done") => {
                return Err(ModelError::new("model_provider_refused"));
            }
            Some("response.output_item.added") if v["item"]["type"] == "function_call" => {
                let i = index(v)?;
                if self.items.len() >= 32 || self.items.contains_key(&i) {
                    return Err(ModelError::new("model_tool_limit"));
                }
                let item = &v["item"];
                let args = item["arguments"].as_str().unwrap_or("").to_owned();
                if args.len() > super::super::TOOL_ARGUMENT_BYTES {
                    return Err(ModelError::new("model_tool_limit"));
                }
                self.items.insert(
                    i,
                    Item {
                        id: name(&item["id"], 512)?,
                        call_id: name(&item["call_id"], 512)?,
                        name: name(&item["name"], 200)?,
                        args,
                        closed: false,
                    },
                );
            }
            Some("response.function_call_arguments.delta") => {
                let item = self.item(v)?;
                append(
                    &mut item.args,
                    &v["delta"],
                    super::super::TOOL_ARGUMENT_BYTES,
                )?;
            }
            Some("response.function_call_arguments.done") => {
                let item = self.item(v)?;
                if item.args
                    != v["arguments"]
                        .as_str()
                        .ok_or(ModelError::new("model_arguments_invalid"))?
                {
                    return Err(ModelError::new("model_arguments_invalid"));
                }
            }
            Some("response.output_item.done") if v["item"]["type"] == "function_call" => {
                let item = self.item_by_index(index(v)?)?;
                let final_item = &v["item"];
                if final_item["id"] != item.id
                    || final_item["call_id"] != item.call_id
                    || final_item["name"] != item.name
                    || final_item["arguments"] != item.args
                {
                    return Err(ModelError::new("model_arguments_invalid"));
                }
                item.closed = true;
            }
            Some("response.completed") => {
                let response = &v["response"];
                if response["status"] != "completed" {
                    return Err(ModelError::terminal_stop(
                        "response.completed",
                        response
                            .pointer("/incomplete_details/reason")
                            .and_then(Value::as_str),
                    ));
                }
                let output = response["output"]
                    .as_array()
                    .ok_or(ModelError::new("model_stream_invalid"))?;
                let mut seen = HashSet::new();
                let mut text = String::new();
                for (i, final_item) in output.iter().enumerate() {
                    match final_item["type"].as_str() {
                        Some("function_call") => {
                            let item = self
                                .items
                                .get(&i)
                                .ok_or(ModelError::new("model_call_id_invalid"))?;
                            if !item.closed
                                || final_item["id"] != item.id
                                || final_item["call_id"] != item.call_id
                                || final_item["name"] != item.name
                                || final_item["arguments"] != item.args
                            {
                                return Err(ModelError::new("model_arguments_invalid"));
                            }
                            seen.insert(i);
                        }
                        Some("message") => {
                            if final_item["role"] != "assistant" {
                                return Err(ModelError::new("model_stream_invalid"));
                            }
                            for part in final_item["content"]
                                .as_array()
                                .ok_or(ModelError::new("model_stream_invalid"))?
                            {
                                if part["type"] != "output_text" {
                                    return Err(ModelError::new("model_block_unsupported"));
                                }
                                append(&mut text, &part["text"], 512 * 1024)?;
                            }
                        }
                        Some("reasoning") => {}
                        _ => return Err(ModelError::new("model_tool_type_unsupported")),
                    }
                }
                if seen.len() != self.items.len() || text != self.text {
                    return Err(ModelError::terminal_stop("response.completed", None));
                }
                self.usage = response.get("usage").filter(|u| !u.is_null()).cloned();
                self.done = true;
            }
            // These typed envelope boundaries carry no executable intent.
            Some(
                "response.created"
                | "response.in_progress"
                | "response.queued"
                | "response.metadata"
                | "response.output_item.added"
                | "response.output_item.done"
                | "response.content_part.added"
                | "response.content_part.done"
                | "response.output_text.done"
                | "response.output_text.annotation.added"
                | "response.reasoning_summary_part.added"
                | "response.reasoning_summary_part.done"
                | "response.reasoning_summary_text.done"
                | "response.reasoning_text.done"
                | "keepalive",
            ) => {}
            _ => return Err(ModelError::new("model_event_unsupported")),
        }
        Ok(self.done)
    }
    fn item_by_index(&mut self, i: usize) -> Result<&mut Item, ModelError> {
        self.items
            .get_mut(&i)
            .filter(|i| !i.closed)
            .ok_or(ModelError::new("model_call_id_invalid"))
    }
    fn item(&mut self, v: &Value) -> Result<&mut Item, ModelError> {
        let item = self.item_by_index(index(v)?)?;
        if v["item_id"] != item.id {
            return Err(ModelError::new("model_call_id_invalid"));
        }
        Ok(item)
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if !self.done {
            return Err(ModelError::new("model_stream_incomplete"));
        }
        let mut calls = Vec::new();
        let mut ids = HashSet::new();
        for item in self.items.into_values() {
            if !ids.insert(item.call_id) {
                return Err(ModelError::new("model_call_id_invalid"));
            }
            calls.push(call(item.name, &item.args)?);
        }
        finish(
            self.text,
            self.thought,
            calls,
            self.usage,
            Wire::Responses,
            fingerprint,
        )
    }
}
fn index(v: &Value) -> Result<usize, ModelError> {
    v["output_index"]
        .as_u64()
        .filter(|i| *i < 128)
        .map(|i| i as usize)
        .ok_or(ModelError::new("model_block_limit"))
}
