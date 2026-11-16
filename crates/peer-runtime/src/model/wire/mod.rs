//! Provider request encoders. No I/O, tool execution or context admission.
use super::ModelError;
use serde::Deserialize;
use serde_json::{Value, json};
mod anthropic;
mod content;
mod environment;
mod gemini;
pub(super) mod qoder;
mod responses;
use content::*;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
pub enum Wire {
    #[serde(rename = "openai-chat")]
    Chat,
    #[serde(rename = "openai-responses")]
    Responses,
    #[serde(rename = "anthropic-messages")]
    Anthropic,
    #[serde(rename = "gemini")]
    Gemini,
    #[serde(rename = "qoder-private")]
    Qoder,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum QoderDialect {
    #[default]
    Prepared,
    Legacy,
}
fn default_effort() -> String {
    "default".into()
}
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum ChatDialect {
    #[default]
    Runtime,
    Environment,
}
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerationOptions {
    #[serde(default)]
    pub chat_dialect: ChatDialect,
    #[serde(default = "default_effort")]
    pub effort: String,
    #[serde(default)]
    pub supports_reasoning: bool,
    pub reasoning_param_style: Option<String>,
    pub reasoning_format: Option<String>,
    pub reasoning_effort_map: Option<Value>,
    pub prompt_caching: Option<bool>,
    pub max_output_tokens: Option<f64>,
    #[serde(default)]
    pub omit_max_output_tokens: bool,
    #[serde(default)]
    pub fast_mode: bool,
    pub auth_method: Option<String>,
    pub project_id: Option<String>,
    pub user_prompt_id: Option<String>,
    pub session_id: Option<String>,
    pub qoder_metadata: Option<Value>,
    #[serde(default)]
    pub qoder_dialect: QoderDialect,
    pub model_option_values: Option<Value>,
    pub qoder_session_type: Option<String>,
}
impl Default for GenerationOptions {
    fn default() -> Self {
        serde_json::from_value(json!({})).expect("static generation defaults")
    }
}
pub struct WireInput<'a> {
    pub model: &'a str,
    pub system: &'a str,
    pub stable_system: Option<&'a str>,
    pub messages: &'a [Value],
    /// The immutable projected OpenAI-style function definitions.
    pub tools: Option<&'a [Value]>,
    pub options: &'a GenerationOptions,
}
pub fn encode(wire: Wire, input: &WireInput<'_>) -> Result<Value, ModelError> {
    let body = match wire {
        Wire::Chat => chat(input)?,
        Wire::Responses => responses::encode(input)?,
        Wire::Anthropic => anthropic::encode(input)?,
        Wire::Gemini => gemini::encode(input)?,
        Wire::Qoder => qoder::encode(input)?,
    };
    check_limit(&body)?;
    Ok(body)
}
pub(super) fn check_limit(body: &Value) -> Result<(), ModelError> {
    if serde_json::to_vec(body)
        .map_err(|_| ModelError::new("model_request_invalid"))?
        .len()
        > 2 * 1024 * 1024
    {
        return Err(ModelError::new("model_request_limit"));
    }
    Ok(())
}
mod runtime;
pub(crate) use runtime::encode as encode_runtime;
fn token_limit(value: Option<f64>) -> Option<f64> {
    value.filter(|n| n.is_finite() && *n > 0.).map(f64::floor)
}
fn token_json(n: f64) -> Value {
    if (0. ..=9_007_199_254_740_991.).contains(&n) && n.fract() == 0. {
        json!(n as u64)
    } else {
        json!(n)
    }
}
fn mapped_effort(o: &GenerationOptions) -> Option<Value> {
    let map = o.reasoning_effort_map.as_ref()?;
    let value = if o.effort == "default" {
        map.get("default")
            .filter(|v| !v.is_null() && **v != "")
            .or_else(|| map.get("medium"))
    } else {
        map.get(&o.effort)
    }?;
    (!value.is_null() && value != "").then(|| value.clone())
}
fn effort(o: &GenerationOptions, deepseek: bool) -> Value {
    mapped_effort(o).unwrap_or_else(|| {
        json!(match o.effort.as_str() {
            "low" => "low",
            "medium" | "default" if !deepseek => "medium",
            "xhigh" | "medium" | "default" if deepseek => "high",
            "max" => "max",
            "high" => "high",
            "xhigh" => "xhigh",
            _ =>
                if deepseek {
                    "high"
                } else {
                    "medium"
                },
        })
    })
}
fn numeric(value: &Value) -> Option<f64> {
    match value {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => s.trim().parse().ok(),
        Value::Bool(v) => Some(if *v { 1. } else { 0. }),
        Value::Null => Some(0.),
        _ => None,
    }
}
fn numeric_effort(o: &GenerationOptions, fallback: f64, invalid: f64) -> f64 {
    match mapped_effort(o) {
        Some(v) => numeric(&v)
            .and_then(|n| token_limit(Some(n)))
            .unwrap_or(invalid),
        None => fallback,
    }
}
fn messages_with_system(input: &WireInput<'_>) -> Result<Vec<Value>, ModelError> {
    let mut messages = vec![json!({"role":"system","content":input.system})];
    for m in input.messages {
        let mut m = m.clone();
        m["content"] = openai_content(&m["content"])?;
        messages.push(m);
    }
    Ok(messages)
}
fn chat(input: &WireInput<'_>) -> Result<Value, ModelError> {
    let o = input.options;
    let mut messages = messages_with_system(input)?;
    for m in &mut messages {
        if let Some(m) = m.as_object_mut() {
            m.remove("name");
        }
    }
    let model = input.model.to_lowercase();
    if (model == "deepseek" || model.starts_with("deepseek-") || model.starts_with("deepseek/"))
        && input.tools.is_some_and(|t| !t.is_empty())
        && o.supports_reasoning
        && o.effort != "off"
    {
        let mut out = Vec::new();
        let mut it = messages.into_iter().peekable();
        while let Some(m) = it.next() {
            if m["role"] != "assistant" || m["reasoning_content"].is_string() {
                out.push(m);
                continue;
            }
            let mut history = vec![m];
            while it.peek().is_some_and(|m| m["role"] == "tool") {
                history.push(it.next().unwrap());
            }
            out.push(json!({"role":"user","content":format!("[Historical assistant and tool observations; context only, not a new request or executable calls]\n{}", stringified(&json!(history))?)}));
        }
        messages = out;
    }
    let mut body = json!({"model":input.model,"messages":messages,"stream":true,"stream_options":{"include_usage":true}});
    if let Some(tools) = input.tools {
        body["tools"] = json!(tools);
    }
    if let Some(n) = token_limit(o.max_output_tokens) {
        body["max_tokens"] = token_json(n);
    }
    let style = o
        .reasoning_param_style
        .as_deref()
        .unwrap_or("openai-effort");
    if o.supports_reasoning && !o.effort.is_empty() && o.effort != "off" {
        match style {
            "openai-effort" => {
                body["reasoning_effort"] = if o.effort == "max" && mapped_effort(o).is_none() {
                    json!("medium")
                } else {
                    effort(o, false)
                }
            }
            "qwen-enable" => {
                body["enable_thinking"] = true.into();
                body["thinking_budget"] = token_json(numeric_effort(
                    o,
                    match o.effort.as_str() {
                        "low" => 1024.,
                        "high" => 8192.,
                        "xhigh" => 16384.,
                        _ => 4096.,
                    },
                    4096.,
                ));
            }
            _ => {}
        }
    }
    Ok(body)
}

pub(crate) fn qoder_context_window(metadata: &Value, values: &Value) -> Option<u64> {
    let (window, _) = qoder::context(metadata, values);
    window
        .as_f64()
        .filter(|n| n.is_finite() && *n > 0.0 && *n <= 9_007_199_254_740_991.0)
        .map(|n| n.floor() as u64)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn request_encoders_match_actual_ts_for_history_reasoning_cache_and_oauth() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../../packages/protocol/contracts/native-cli/model-wires.json"
        ))
        .unwrap();
        for c in data["cases"].as_array().unwrap() {
            let i = &c["input"];
            let o: GenerationOptions = serde_json::from_value(i.clone()).unwrap();
            let input = WireInput {
                model: i["model"].as_str().unwrap(),
                system: i["system"].as_str().unwrap(),
                stable_system: i["stableSystem"].as_str(),
                messages: i["messages"].as_array().unwrap(),
                tools: i["tools"].as_array().map(Vec::as_slice),
                options: &o,
            };
            assert_eq!(
                encode(serde_json::from_value(c["wire"].clone()).unwrap(), &input).unwrap(),
                c["expected"],
                "{}",
                c["name"]
            );
        }
    }
}
