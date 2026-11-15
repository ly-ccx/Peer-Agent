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
                stream.frames.push(chunk, |bytes| {
                    let event = decode(bytes, 1024 * 1024)?;
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
    pub fn finish(self, fingerprint: String) -> Result<ModelTurn, ModelError> {
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
    let arguments = decode(args.as_bytes(), 65536)?;
    if !arguments.is_object() {
        return Err(ModelError::new("model_arguments_invalid"));
    }
    Ok(ModelToolCall { name, arguments })
}
fn finish(
    text: String,
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
                for chunk in bytes.chunks(size) {
                    stream.push(chunk).unwrap();
                }
                assert!(stream.terminal());
                let turn = stream.finish("fingerprint".into()).unwrap();
                assert_eq!(turn.content, c["expected"]["content"]);
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
