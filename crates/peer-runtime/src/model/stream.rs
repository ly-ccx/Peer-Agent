//! Bounded provider decoders. Only a valid terminal response exposes tool calls.
use super::{
    ModelError, ModelToolCall, ModelTurn, decode, sse::ChatStream, sse_frame::Frames, wire::Wire,
};
use serde_json::Value;
mod anthropic;
mod gemini;
mod responses;

pub(super) enum Stream {
    Chat(Box<ChatStream>),
    Other(Box<Framed>),
}
pub(super) struct Framed {
    frames: Frames,
    decoder: Decoder,
}
enum Decoder {
    Anthropic(anthropic::Anthropic),
    Responses(responses::Responses),
    Gemini(gemini::Gemini),
}
impl Stream {
    /// A complete normalized usage observation is useful even when response
    /// validation fails. This never exposes partially validated tool intent.
    pub fn observed_usage(&self) -> Option<peer_protocol::UsageAmounts> {
        let (wire, raw) = match self {
            Self::Chat(s) => (Wire::Chat, s.usage.as_ref()),
            Self::Other(s) => match &s.decoder {
                Decoder::Anthropic(d) => (Wire::Anthropic, d.usage.as_ref()),
                Decoder::Responses(d) => (Wire::Responses, d.usage.as_ref()),
                Decoder::Gemini(d) => (Wire::Gemini, d.usage.as_ref()),
            },
        };
        let normalized = super::usage::normalize(wire, raw?).ok()?;
        if normalized.is_null() {
            None
        } else {
            serde_json::from_value(normalized).ok()
        }
    }
    pub fn new(wire: Wire) -> Self {
        let decoder = match wire {
            Wire::Chat => return Self::Chat(Box::default()),
            Wire::Responses => Decoder::Responses(Default::default()),
            Wire::Anthropic => Decoder::Anthropic(Default::default()),
            Wire::Gemini => Decoder::Gemini(Default::default()),
        };
        Self::Other(Box::new(Framed {
            frames: Frames::default(),
            decoder,
        }))
    }
    pub fn push(&mut self, chunk: &[u8]) -> Result<(), ModelError> {
        match self {
            Self::Chat(stream) => stream.push(chunk),
            Self::Other(stream) => {
                stream.frames.push(chunk, |kind, bytes| {
                    let mut event = decode(bytes, 1024 * 1024)?;
                    if let (Some(kind), Some(fields)) = (kind, event.as_object_mut()) {
                        let event_type = fields.entry("type").or_insert_with(|| kind.into());
                        if event_type != kind {
                            return Err(ModelError::new("model_stream_invalid"));
                        }
                    }
                    match &mut stream.decoder {
                        Decoder::Anthropic(d) => d.event(&event),
                        Decoder::Responses(d) => d.event(&event),
                        Decoder::Gemini(d) => d.event(&event),
                    }
                })?;
                Ok(())
            }
        }
    }
    pub fn terminal(&self) -> bool {
        match self {
            Self::Chat(s) => s.terminal(),
            Self::Other(s) => match &s.decoder {
                Decoder::Anthropic(d) => d.done,
                Decoder::Responses(d) => d.done,
                Decoder::Gemini(d) => d.done,
            },
        }
    }
    pub fn has_tool_intent(&self) -> bool {
        match self {
            Self::Chat(stream) => stream.has_tool_intent(),
            Self::Other(stream) => match &stream.decoder {
                Decoder::Anthropic(decoder) => decoder.has_tool_intent(),
                Decoder::Responses(decoder) => decoder.has_tool_intent(),
                Decoder::Gemini(decoder) => decoder.has_tool_intent(),
            },
        }
    }

    pub fn preview_text(&self) -> &str {
        match self {
            Self::Chat(s) => &s.text,
            Self::Other(s) => match &s.decoder {
                Decoder::Anthropic(d) => &d.text,
                Decoder::Responses(d) => &d.text,
                Decoder::Gemini(d) => &d.text,
            },
        }
    }
    pub fn preview_thinking(&self) -> &str {
        match self {
            Self::Chat(s) => &s.thought,
            Self::Other(s) => match &s.decoder {
                Decoder::Anthropic(d) => &d.thought,
                Decoder::Responses(d) => &d.thought,
                Decoder::Gemini(d) => &d.thought,
            },
        }
    }
    pub fn terminal_stop_error(&self) -> Option<ModelError> {
        match self {
            Self::Chat(stream) => stream.terminal_stop_error(),
            Self::Other(stream) => match &stream.decoder {
                Decoder::Anthropic(decoder) => decoder.terminal_stop_error(),
                _ => None,
            },
        }
    }
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
        if let Some(error) = self.terminal_stop_error() {
            return Err(error);
        }
        match self {
            Self::Chat(s) => s.finish(fingerprint),
            Self::Other(s) => {
                if !s.frames.complete() {
                    return Err(ModelError::new("model_stream_incomplete"));
                }
                match s.decoder {
                    Decoder::Anthropic(d) => d.finish(fingerprint),
                    Decoder::Responses(d) => d.finish(fingerprint),
                    Decoder::Gemini(d) => d.finish(fingerprint),
                }
            }
        }
    }
}
fn append(target: &mut String, value: &Value, limit: usize) -> Result<(), ModelError> {
    let part = value
        .as_str()
        .ok_or(ModelError::new("model_stream_invalid"))?;
    if target.len() + part.len() > limit {
        return Err(ModelError::new("model_response_limit"));
    }
    target.push_str(part);
    Ok(())
}
fn name(value: &Value, limit: usize) -> Result<String, ModelError> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= limit)
        .map(str::to_owned)
        .ok_or(ModelError::new("model_call_id_invalid"))
}
fn call(name: String, args: &str) -> Result<ModelToolCall, ModelError> {
    let arguments = decode(args.as_bytes(), super::TOOL_ARGUMENT_BYTES)?;
    if !arguments.is_object() {
        return Err(ModelError::new("model_arguments_invalid"));
    }
    Ok(ModelToolCall { name, arguments })
}
fn finish(
    text: String,
    thinking: String,
    calls: Vec<ModelToolCall>,
    usage: Option<Value>,
    wire: Wire,
    fingerprint: String,
) -> Result<ModelTurn, ModelError> {
    if calls.is_empty() && text.trim().is_empty() {
        return Err(ModelError::new("model_empty_response"));
    }
    Ok(ModelTurn {
        content: text,
        thinking,
        calls,
        usage: usage
            .as_ref()
            .map(|u| super::usage::normalize(wire, u))
            .transpose()?,
        request_fingerprint: fingerprint,
        continuation: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixtures() -> Value {
        serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-streams.json"
        ))
        .unwrap()
    }
    #[test]
    fn provider_decoders_classify_known_errors_and_explicit_terminal_stops() {
        for (wire, body, kind, code, retry) in [
            (
                Wire::Responses,
                r#"{"response":{"error":{"code":"server_error"}}}"#,
                "response.failed",
                "server_error",
                true,
            ),
            (
                Wire::Anthropic,
                r#"{"error":{"type":"overloaded_error","message":"do not retain"}}"#,
                "error",
                "overloaded_error",
                true,
            ),
            (
                Wire::Anthropic,
                r#"{"error":{"type":"authentication_error"}}"#,
                "error",
                "authentication_error",
                false,
            ),
            (
                Wire::Chat,
                r#"{"code":"rate_limit_exceeded"}"#,
                "error",
                "rate_limit_exceeded",
                true,
            ),
            (
                Wire::Gemini,
                r#"{"error":{"code":503,"status":"UNAVAILABLE"}}"#,
                "error",
                "unavailable",
                true,
            ),
            (
                Wire::Gemini,
                r#"{"error":{"code":403,"status":"PERMISSION_DENIED"}}"#,
                "error",
                "permission_denied",
                false,
            ),
        ] {
            let error = Stream::new(wire)
                .push(format!("event: {kind}\ndata: {body}\n\n").as_bytes())
                .unwrap_err();
            assert_eq!(error.sse_event_kind, Some(kind));
            assert_eq!(error.provider_code, Some(code));
            assert_eq!(error.is_transient_retryable(), retry);
        }
        for reason in [
            "MAX_TOKENS",
            "SAFETY",
            "RECITATION",
            "PROHIBITED_CONTENT",
            "BLOCKLIST",
            "SPII",
            "MALFORMED_FUNCTION_CALL",
            "OTHER",
            "UNKNOWN_FUTURE_REASON",
        ] {
            let body = serde_json::json!({"candidates":[{"finishReason":reason}]});
            let error = Stream::new(Wire::Gemini)
                .push(format!("data: {body}\n\n").as_bytes())
                .unwrap_err();
            assert_eq!(error.sse_event_kind, Some("finishReason"));
            assert!(!error.is_transient_retryable(), "{reason}");
        }
        let mut chat = Stream::new(Wire::Chat);
        chat.push(
            b"data: {\"choices\":[{\"index\":0,\"finish_reason\":\"length\",\"delta\":{}}]}\n\n",
        )
        .unwrap();
        let Err(error) = chat.finish(String::new()) else {
            panic!("length stop must fail")
        };
        assert_eq!(error.provider_code, Some("length"));
        assert!(!error.is_transient_retryable());
    }
    #[test]
    fn fragments_crlf_and_truncation_preserve_terminal_authority() {
        for c in fixtures()["cases"].as_array().unwrap() {
            let wire: Wire = serde_json::from_value(c["wire"].clone()).unwrap();
            let bytes = c["stream"]
                .as_str()
                .unwrap()
                .replace('\n', "\r\n")
                .into_bytes();
            for size in [1, 2, 17, bytes.len()] {
                let mut stream = Stream::new(wire);
                let mut shown = String::new();
                for chunk in bytes.chunks(size) {
                    stream.push(chunk).unwrap();
                    let current = stream.preview_text();
                    assert!(current.starts_with(&shown));
                    shown.push_str(&current[shown.len()..]);
                }
                assert!(stream.terminal());
                let turn = stream.finish("fingerprint".into()).unwrap();
                assert_eq!(turn.content, c["expected"]["content"]);
                assert_eq!(shown, turn.content);
            }
            let raw = c["stream"].as_str().unwrap();
            let last = raw.rfind("data:").unwrap();
            let mut stream = Stream::new(wire);
            stream.push(&raw.as_bytes()[..last]).unwrap();
            assert!(!stream.terminal());
            assert!(matches!(
                stream.finish(String::new()),
                Err(ModelError {
                    code: "model_stream_incomplete",
                    ..
                }) | Err(ModelError {
                    code: "model_empty_response",
                    ..
                })
            ));
        }
    }
    #[test]
    fn anthropic_compatible_tool_blocks_without_an_initial_input_require_complete_deltas() {
        let fixtures = fixtures();
        let original = fixtures["cases"]
            .as_array()
            .unwrap()
            .iter()
            .find(|row| row["wire"] == "anthropic-messages" && row["kind"] == "tool")
            .unwrap()["stream"]
            .as_str()
            .unwrap();
        let omitted = original.replace(",\"input\":{}", "");
        assert_ne!(omitted, original);
        let parse = |input: &str| {
            let mut stream = Stream::new(Wire::Anthropic);
            for chunk in input.as_bytes().chunks(7) {
                stream.push(chunk)?;
            }
            stream.finish("fingerprint".into())
        };
        let expected = parse(original).unwrap();
        let accepted = parse(&omitted).unwrap();
        assert_eq!(accepted.calls.len(), 1);
        assert_eq!(accepted.calls[0].name, expected.calls[0].name);
        assert_eq!(accepted.calls[0].arguments, expected.calls[0].arguments);
        let no_delta = omitted
            .lines()
            .filter(|line| !line.contains("\"input_json_delta\""))
            .collect::<Vec<_>>()
            .join("\n")
            + "\n";
        assert!(parse(&no_delta).is_err());
        assert!(parse(&original.replace("\"input\":{}", "\"input\":null")).is_err());
        assert!(parse(&original.replace("\"input\":{}", "\"input\":{\"unexpected\":1}")).is_err());
    }
    #[test]
    fn malformed_or_failed_typed_streams_never_produce_executable_calls() {
        for c in fixtures()["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "tool")
        {
            let wire: Wire = serde_json::from_value(c["wire"].clone()).unwrap();
            let raw = c["stream"].as_str().unwrap();
            let malformed = match wire {
                Wire::Chat => raw.replace("\"tool_calls\"}]", "\"length\"}]"),
                Wire::Anthropic => raw.replace(
                    "\"stop_reason\":\"tool_use\"",
                    "\"stop_reason\":\"max_tokens\"",
                ),
                Wire::Responses => {
                    raw.replace("\"status\":\"completed\"", "\"status\":\"incomplete\"")
                }
                Wire::Gemini => raw.replace(
                    "\"finishReason\":\"STOP\"",
                    "\"finishReason\":\"MAX_TOKENS\"",
                ),
            };
            assert_ne!(malformed, raw, "fixture mutation must change {}", c["wire"]);
            let mut stream = Stream::new(wire);
            assert!(
                stream
                    .push(malformed.as_bytes())
                    .and_then(|()| stream.finish(String::new()))
                    .is_err()
            );
            let mut stream = Stream::new(wire);
            assert!(stream.push(b"data: {broken\n\n").is_err());
            let mut stream = Stream::new(wire);
            assert!(stream.push(&vec![b'x'; 1024 * 1024 + 1]).is_err());
        }
    }
}

#[cfg(test)]
mod argument_budget_tests {
    use super::*;
    #[test]
    fn all_four_decoders_accept_complete_arguments_above_the_previous_64k_limit() {
        let data: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/model-streams.json"
        ))
        .unwrap();
        for c in data["cases"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| c["kind"] == "tool")
        {
            let path = "x".repeat(90 * 1024);
            let bytes = c["stream"].as_str().unwrap().replace("input.txt", &path);
            let mut stream = Stream::new(serde_json::from_value(c["wire"].clone()).unwrap());
            for chunk in bytes.as_bytes().chunks(16381) {
                stream.push(chunk).unwrap();
            }
            let turn = stream.finish("frozen-fingerprint".into()).unwrap();
            assert_eq!(turn.calls.len(), 1);
            assert_eq!(turn.calls[0].arguments["path"], path, "{}", c["wire"]);
        }
    }
    #[test]
    fn argument_limit_is_explicit_and_does_not_accept_a_partial_object() {
        let args = serde_json::json!({"content":"a".repeat(super::super::TOOL_ARGUMENT_BYTES)})
            .to_string();
        assert!(call("write_file".into(), &args).is_err());
        assert!(call("write_file".into(), "{\"content\":").is_err());
    }

    #[test]
    fn responses_decoder_ignores_harmless_metadata_events() {
        let sse = concat!(
            "data: {\"type\":\"response.created\",\"response\":{\"id\":\"r1\"}}\n\n",
            "data: {\"type\":\"response.metadata\",\"response\":{\"id\":\"r1\"}}\n\n",
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"Hello\"}\n\n",
            "data: {\"type\":\"response.completed\",\"response\":{\"status\":\"completed\",\"output\":[{\"type\":\"message\",\"role\":\"assistant\",\"content\":[{\"type\":\"output_text\",\"text\":\"Hello\"}]}]}}\n\n",
        );
        let mut stream = Stream::new(Wire::Responses);
        stream.push(sse.as_bytes()).unwrap();
        let turn = stream.finish("fp-meta".into()).unwrap();
        assert_eq!(turn.content, "Hello");
    }

    #[test]
    fn stream_decoders_expose_live_and_final_thinking_across_wires() {
        let mut chat = Stream::new(Wire::Chat);
        chat.push(
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning_content\":\"plan \"}}]}\n\n",
        )
        .unwrap();
        assert_eq!(chat.preview_thinking(), "plan ");
        chat.push(
            b"data: {\"choices\":[{\"index\":0,\"delta\":{\"reasoning\":\"step\"}}]}\n\ndata: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"done\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n",
        )
        .unwrap();
        assert_eq!(chat.preview_thinking(), "plan step");
        let turn = chat.finish("fp-chat".into()).unwrap();
        assert_eq!(turn.thinking, "plan step");
        assert_eq!(turn.content, "done");

        let mut anthropic = Stream::new(Wire::Anthropic);
        anthropic
            .push(
                concat!(
                    "data: {\"type\":\"message_start\",\"message\":{\"role\":\"assistant\",\"usage\":{\"input_tokens\":1,\"output_tokens\":1}}}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"thinking\",\"thinking\":\"first \"}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"thinking_delta\",\"thinking\":\"second\"}}\n\n",
                )
                .as_bytes(),
            )
            .unwrap();
        assert_eq!(anthropic.preview_thinking(), "first second");
        anthropic
            .push(
                concat!(
                    "data: {\"type\":\"content_block_stop\",\"index\":0}\n\n",
                    "data: {\"type\":\"content_block_start\",\"index\":1,\"content_block\":{\"type\":\"text\",\"text\":\"\"}}\n\n",
                    "data: {\"type\":\"content_block_delta\",\"index\":1,\"delta\":{\"type\":\"text_delta\",\"text\":\"ok\"}}\n\n",
                    "data: {\"type\":\"content_block_stop\",\"index\":1}\n\n",
                    "data: {\"type\":\"message_delta\",\"delta\":{\"stop_reason\":\"end_turn\"},\"usage\":{\"output_tokens\":2}}\n\n",
                    "data: {\"type\":\"message_stop\"}\n\n",
                )
                .as_bytes(),
            )
            .unwrap();
        let turn = anthropic.finish("fp-anth".into()).unwrap();
        assert_eq!(turn.thinking, "first second");
        assert_eq!(turn.content, "ok");
    }
}
