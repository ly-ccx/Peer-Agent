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
    pub http_status: Option<u16>,
    pub(crate) retry: Option<super::qoder_retry::Hint>,
}
impl ModelError {
    pub const AUTH_REJECTED: &'static str = "model_auth_rejected";

    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            observation: None,
            context_overflow_status: None,
            http_status: None,
            retry: None,
        }
    }
    pub(super) fn http_access_rejection(status: u16) -> Option<Self> {
        matches!(status, 401 | 403).then(|| Self {
            http_status: Some(status),
            ..Self::new(Self::AUTH_REJECTED)
        })
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
            http_status: Some(status),
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

    pub fn is_transient_retryable(&self) -> bool {
        if self.code == "CANCELLED"
            || self.code == Self::AUTH_REJECTED
            || self.context_overflow_status.is_some()
        {
            return false;
        }
        self.retry.is_some()
            || matches!(self.http_status, Some(408 | 429 | 500 | 502 | 503 | 504))
            || matches!(
                self.code,
                "model_timeout" | "model_transport_failed" | "model_stream_interrupted"
            )
    }

    pub fn observed_usage(&self) -> Option<&UsageAmounts> {
        self.observation.as_deref().and_then(|o| o.usage.as_ref())
    }
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for ModelError {}
