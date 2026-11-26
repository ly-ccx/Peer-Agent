use peer_protocol::UsageAmounts;
use serde_json::Value;

/// A failed request may still have provider-observed usage.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRequestObservation {
    pub request_fingerprint: String,
    pub usage: Option<UsageAmounts>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelFailurePhase {
    Connect,
    Headers,
    FirstByte,
    MidStream,
    Terminal,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelError {
    pub code: &'static str,
    pub observation: Option<Box<ModelRequestObservation>>,
    pub context_overflow_status: Option<u16>,
    pub http_status: Option<u16>,
    pub sse_event_kind: Option<&'static str>,
    pub provider_code: Option<&'static str>,
    pub failure_phase: Option<ModelFailurePhase>,
    pub retry_after_ms: Option<u64>,
    pub attempts_used: u32,
    /// Generated from recognized provider assertions. Never contains body text.
    pub http_detail: Option<&'static str>,
}

const TRANSIENT_CODES: &[&str] = &[
    "server_error",
    "internal_error",
    "internal",
    "api_error",
    "overloaded_error",
    "overloaded",
    "service_unavailable",
    "unavailable",
    "timeout",
    "upstream_timeout",
    "deadline_exceeded",
    "bad_gateway",
    "stream_interrupted",
    "connection_reset",
    "connection_error",
    "rate_limit",
    "rate_limit_error",
    "rate_limit_exceeded",
    "too_many_requests",
];
const QUOTA_CODES: &[&str] = &[
    "insufficient_quota",
    "quota_exceeded",
    "billing_hard_limit_reached",
    "billing_not_active",
    "billing_error",
    "usage_limit_reached",
    "monthly_limit_exceeded",
    "credits_exhausted",
];
const TERMINAL_CODES: &[&str] = &[
    "invalid_api_key",
    "invalid_request_error",
    "invalid_argument",
    "authentication_error",
    "permission_error",
    "permission_denied",
    "unauthenticated",
    "not_found",
    "resource_exhausted",
    "policy_violation",
    "content_policy_violation",
    "content_filter",
    "safety",
    "recitation",
    "prohibited_content",
    "blocklist",
    "spii",
    "refusal",
    "max_output_tokens",
    "max_tokens",
    "length",
    "model_length",
    "malformed_function_call",
    "unexpected_tool_call",
    "other",
    "context_length_exceeded",
    "prompt_too_long",
    "failed_precondition",
    "cancelled",
    "request_too_large",
];

impl ModelError {
    pub const AUTH_REJECTED: &'static str = "model_auth_rejected";

    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            observation: None,
            context_overflow_status: None,
            http_status: None,
            sse_event_kind: None,
            provider_code: None,
            failure_phase: None,
            retry_after_ms: None,
            attempts_used: 0,
            http_detail: None,
        }
    }

    pub(super) fn at(mut self, phase: ModelFailurePhase) -> Self {
        self.failure_phase.get_or_insert(phase);
        self
    }

    pub(super) fn response(mut self, status: u16, retry_after_ms: Option<u64>) -> Self {
        self.http_status = Some(status);
        self.retry_after_ms = retry_after_ms;
        self
    }

    pub(super) fn request_failed(error: reqwest::Error) -> Self {
        let phase = if error.is_connect() {
            ModelFailurePhase::Connect
        } else {
            ModelFailurePhase::Headers
        };
        if request_error_matches(&error, |cause| {
            cause.to_string() == "tunnel error: proxy authorization required"
        }) {
            return Self::new("model_http_rejected")
                .response(407, None)
                .at(phase);
        }
        let code = if is_certificate_error(&error) {
            "model_tls_certificate_invalid"
        } else if error.is_timeout() {
            "model_timeout"
        } else if error.is_builder() {
            "model_request_invalid"
        } else {
            "model_transport_failed"
        };
        Self::new(code).at(phase)
    }

    pub(super) fn provider_event(kind: &'static str, value: &Value) -> Self {
        let mut error = Self::new("model_provider_error");
        error.sse_event_kind = Some(kind);
        error.provider_code = if kind == "response.incomplete" {
            value
                .pointer("/response/incomplete_details/reason")
                .and_then(Value::as_str)
                .and_then(safe_code)
        } else {
            provider_code(error_object(value))
        };
        if matches!(
            error.provider_code,
            Some("context_length_exceeded" | "prompt_too_long")
        ) {
            error.code = "model_context_overflow";
            // Capacity recovery expects the equivalent rejection status.
            error.context_overflow_status = Some(400);
        }
        error.at(ModelFailurePhase::Terminal)
    }

    pub(super) fn terminal_stop(kind: &'static str, reason: Option<&str>) -> Self {
        let mut error = Self::new("model_stream_incomplete");
        error.sse_event_kind = Some(kind);
        error.provider_code = reason.and_then(safe_code);
        error.at(ModelFailurePhase::Terminal)
    }

    pub(super) fn http_access_rejection(status: u16) -> Option<Self> {
        matches!(status, 401 | 403).then(|| {
            Self::new(Self::AUTH_REJECTED)
                .response(status, None)
                .at(ModelFailurePhase::Headers)
        })
    }

    pub(super) fn http(status: u16, body: &[u8]) -> Self {
        let parsed = serde_json::from_slice::<Value>(body).ok();
        let error = parsed.as_ref().map(error_object);
        let provider_code = error.and_then(provider_code);
        // Keep the pre-existing capacity recovery for textual HTTP assertions.
        // The response bytes never leave this function.
        let text = std::str::from_utf8(body).unwrap_or("").to_ascii_lowercase();
        let overflow = status == 413
            || matches!(status, 400 | 422)
                && [
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
                .any(|marker| text.contains(marker));
        let mut result = Self::new(if overflow {
            "model_context_overflow"
        } else {
            "model_http_rejected"
        });
        result.context_overflow_status = overflow.then_some(status);
        result.provider_code = provider_code;
        if status == 400 && provider_code == Some("invalid_argument") {
            let assertion = error.and_then(|e| e["message"].as_str());
            result.http_detail = match assertion {
                Some("bad schema") => Some("INVALID_ARGUMENT: bad schema"),
                Some(message)
                    if message.starts_with(
                        "Invalid JSON payload received. Unknown name \"additionalProperties\"",
                    ) =>
                {
                    Some(
                        "INVALID_ARGUMENT: Invalid JSON payload. Unsupported schema field additionalProperties.",
                    )
                }
                _ => None,
            };
        }
        result
            .response(status, None)
            .at(ModelFailurePhase::Terminal)
    }

    pub(super) fn observed(mut self, fingerprint: String, usage: Option<UsageAmounts>) -> Self {
        self.observation = Some(Box::new(ModelRequestObservation {
            request_fingerprint: fingerprint,
            usage,
        }));
        self
    }

    pub fn is_usage_limit(&self) -> bool {
        self.http_status == Some(429)
            || self.code.contains("rate_limit")
            || self.provider_code.is_some_and(|code| {
                QUOTA_CODES.contains(&code)
                    || matches!(
                        code,
                        "rate_limit"
                            | "rate_limit_error"
                            | "rate_limit_exceeded"
                            | "too_many_requests"
                            | "overloaded"
                            | "overloaded_error"
                            | "resource_exhausted"
                    )
            })
    }

    pub fn is_transient_retryable(&self) -> bool {
        if matches!(
            self.code,
            "CANCELLED" | Self::AUTH_REJECTED | "model_tls_certificate_invalid"
        ) || self.context_overflow_status.is_some()
            || self.provider_code.is_some_and(|code| {
                QUOTA_CODES.contains(&code)
                    || (TERMINAL_CODES.contains(&code) && !TRANSIENT_CODES.contains(&code))
            })
        {
            return false;
        }
        if self.sse_event_kind.is_some() {
            return self.code == "model_provider_error"
                && self.provider_code.is_some_and(|code| {
                    TRANSIENT_CODES.contains(&code)
                        && (self.sse_event_kind != Some("response.incomplete")
                            || !matches!(
                                code,
                                "rate_limit"
                                    | "rate_limit_error"
                                    | "rate_limit_exceeded"
                                    | "too_many_requests"
                            ))
                });
        }
        if let Some(status) = self.http_status.filter(|status| *status >= 300) {
            return match status {
                429 => self.code == "model_http_rejected", // The complete body can distinguish quota.
                408 | 500 | 502 | 503 | 504 | 520..=524 => true,
                _ => false,
            };
        }
        matches!(
            self.code,
            "model_timeout"
                | "model_transport_failed"
                | "model_stream_interrupted"
                | "model_stream_incomplete"
        )
    }

    pub fn observed_usage(&self) -> Option<&UsageAmounts> {
        self.observation.as_deref().and_then(|o| o.usage.as_ref())
    }

    pub fn format_http_rejection(&self) -> Option<String> {
        let status = self.http_status?;
        if self.code != "model_http_rejected" {
            return None;
        }
        Some(match self.http_detail {
            Some(detail) => format!("HTTP {status} ({}): {detail}", self.code),
            None => format!("HTTP {status} ({})", self.code),
        })
    }

    /// Stable error category and bounded metadata. Safe to forward or log.
    pub fn format_diagnostic(&self) -> Option<String> {
        let mut fields = Vec::new();
        if let Some(phase) = self.failure_phase {
            fields.push(format!("failure_phase={phase:?}"));
        }
        if let Some(status) = self.http_status {
            fields.push(format!("http_status={status}"));
        }
        if let Some(kind) = self.sse_event_kind {
            fields.push(format!("sse_event_kind={kind}"));
        }
        if let Some(code) = self.provider_code {
            fields.push(format!("provider_code={code}"));
        }
        if let Some(delay) = self.retry_after_ms {
            fields.push(format!("retry_after_ms={delay}"));
        }
        if self.attempts_used != 0 {
            fields.push(format!("attempts_used={}", self.attempts_used));
        }
        (!fields.is_empty()).then(|| {
            let label = self
                .format_http_rejection()
                .unwrap_or_else(|| self.code.into());
            format!("{label} [{}]", fields.join(", "))
        })
    }
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for ModelError {}

fn error_object(root: &Value) -> &Value {
    let root = root
        .as_array()
        .and_then(|items| items.first())
        .unwrap_or(root);
    root.get("error")
        .filter(|v| !v.is_null())
        .or_else(|| root.pointer("/response/error").filter(|v| !v.is_null()))
        .or_else(|| root.get("promptFeedback").filter(|v| !v.is_null()))
        .unwrap_or(root)
}

fn provider_code(error: &Value) -> Option<&'static str> {
    let codes = ["code", "reason", "blockReason", "status", "type"]
        .into_iter()
        .filter_map(|key| error[key].as_str().and_then(safe_code));
    // A deterministic code wins even when a second field reports a broad
    // upstream category (e.g. insufficient_quota + rate_limit_error).
    codes
        .clone()
        .find(|code| !TRANSIENT_CODES.contains(code))
        .or_else(|| codes.into_iter().next())
}

fn safe_code(raw: &str) -> Option<&'static str> {
    (raw.len() <= 64)
        .then(|| {
            TRANSIENT_CODES
                .iter()
                .chain(QUOTA_CODES)
                .chain(TERMINAL_CODES)
                .copied()
                .find(|code| code.eq_ignore_ascii_case(raw))
        })
        .flatten()
}

fn is_certificate_error(error: &(dyn std::error::Error + 'static)) -> bool {
    request_error_matches(error, |cause| {
        matches!(
            cause.downcast_ref::<rustls::Error>(),
            Some(
                rustls::Error::InvalidCertificate(_)
                    | rustls::Error::NoCertificatesPresented
                    | rustls::Error::UnsupportedNameType
            )
        )
    })
}

fn request_error_matches(
    error: &(dyn std::error::Error + 'static),
    predicate: impl Fn(&(dyn std::error::Error + 'static)) -> bool,
) -> bool {
    let mut cause = Some(error);
    while let Some(error) = cause {
        if predicate(error) {
            return true;
        }
        // io::Error may omit its embedded error from source() itself.
        cause = error
            .downcast_ref::<std::io::Error>()
            .and_then(std::io::Error::get_ref)
            .map(|error| error as &(dyn std::error::Error + 'static))
            .or_else(|| error.source());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn redacts_all_provider_text_and_gives_terminal_codes_priority() {
        let error = ModelError::provider_event(
            "response.failed",
            &json!({
                "response":{"error":{
                    "type":"rate_limit_error", "code":"insufficient_quota",
                    "message":"prompt echo and plain unrecognizable credentials"
                }}
            }),
        );
        assert_eq!(error.provider_code, Some("insufficient_quota"));
        assert!(error.is_usage_limit());
        assert!(!error.is_transient_retryable());
        assert!(!error.format_diagnostic().unwrap().contains("prompt echo"));
        let error = ModelError::provider_event(
            "error",
            &json!({
                "error":{"code":"oauth_token_11111111111111111","message":"Bearer secret"}
            }),
        );
        assert_eq!(error.provider_code, None);
        assert!(!error.format_diagnostic().unwrap().contains("secret"));
        assert!(!error.is_transient_retryable());
    }

    #[test]
    fn generates_safe_http_detail_for_known_schema_assertion() {
        let error = ModelError::http(400, br#"[{"error":{"status":"INVALID_ARGUMENT","message":"Invalid JSON payload received. Unknown name \"additionalProperties\". secret tail"}}]"#);
        let label = error.format_http_rejection().unwrap();
        assert!(label.starts_with("HTTP 400 (model_http_rejected): INVALID_ARGUMENT:"));
        assert!(label.contains("additionalProperties"));
        assert!(!label.contains("secret tail"));
    }
}
