use peer_protocol::UsageAmounts;

/// A failed request may still have provider-observed usage. No response body,
/// credential, assistant text or executable tool call is retained here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRequestObservation {
    pub request_fingerprint: String,
    pub usage: Option<UsageAmounts>,
}
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelError {
    pub code: &'static str,
    pub observation: Option<Box<ModelRequestObservation>>,
    pub context_overflow_status: Option<u16>,
}
impl ModelError {
    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            observation: None,
            context_overflow_status: None,
        }
    }
    pub(super) fn http(status: u16, body: &[u8]) -> Self {
        let text = std::str::from_utf8(body).unwrap_or("").to_ascii_lowercase();
        let overflow = status == 413
            || [
                "prompt_too_long",
                "context_length_exceeded",
                "maximum context length",
                "maximum prompt length",
                "context window",
                "context too long",
                "input is too long",
                "exceeds model context",
                "too many tokens",
                "token limit",
            ]
            .iter()
            .any(|s| text.contains(s));
        Self {
            context_overflow_status: overflow.then_some(status),
            ..Self::new(if overflow {
                "model_context_overflow"
            } else {
                "model_http_rejected"
            })
        }
    }
    pub(super) fn observed(mut self, fingerprint: String, usage: Option<UsageAmounts>) -> Self {
        self.observation = Some(Box::new(ModelRequestObservation {
            request_fingerprint: fingerprint,
            usage,
        }));
        self
    }
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for ModelError {}
