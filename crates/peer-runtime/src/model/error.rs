use peer_protocol::UsageAmounts;

/// A failed request may still have provider-observed usage. No raw response body,
/// credential, assistant text or executable tool call is retained here.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelRequestObservation {
    pub request_fingerprint: String,
    pub usage: Option<UsageAmounts>,
}
#[derive(Clone, PartialEq, Eq)]
pub struct ModelError {
    pub code: &'static str,
    pub observation: Option<Box<ModelRequestObservation>>,
    pub context_overflow_status: Option<u16>,
    pub http_status: Option<u16>,
    /// Bounded, credential-scrubbed structured error summary extracted from a JSON provider error.
    pub http_detail: Option<String>,
}
impl std::fmt::Debug for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ModelError")
            .field("code", &self.code)
            .field("observation", &self.observation)
            .field("context_overflow_status", &self.context_overflow_status)
            .field("http_status", &self.http_status)
            .field("has_http_detail", &self.http_detail.is_some())
            .finish()
    }
}
impl ModelError {
    pub const AUTH_REJECTED: &'static str = "model_auth_rejected";

    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            observation: None,
            context_overflow_status: None,
            http_status: None,
            http_detail: None,
        }
    }
    pub(super) fn with_detail(mut self, detail: impl AsRef<str>) -> Self {
        self.http_detail = sanitize_provider_error_text(detail.as_ref());
        self
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
        let http_detail = (!overflow && !matches!(status, 401 | 403 | 407))
            .then(|| extract_safe_http_detail(body))
            .flatten();
        Self {
            context_overflow_status: overflow.then_some(status),
            http_status: Some(status),
            http_detail,
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
        if self.code == "model_stream_incomplete" {
            return self.is_retryable_incomplete_stream();
        }
        matches!(self.http_status, Some(408 | 429 | 500 | 502 | 503 | 504))
            || matches!(
                self.code,
                "model_timeout" | "model_transport_failed" | "model_stream_interrupted"
            )
    }

    fn is_retryable_incomplete_stream(&self) -> bool {
        let Some(detail) = self.http_detail.as_deref() else {
            return true;
        };
        let upper = detail.to_ascii_uppercase();
        // Deterministic terminal stop reasons (token cap or safety/policy blocks) will not
        // recover by replaying the identical request; premature EOF and transient Gemini
        // MALFORMED_FUNCTION_CALL / OTHER flakes recover on retry.
        !(upper.contains("MAX_TOKENS")
            || upper.contains("LENGTH")
            || upper.contains("SAFETY")
            || upper.contains("RECITATION")
            || upper.contains("PROHIBITED_CONTENT")
            || upper.contains("BLOCKLIST")
            || upper.contains("SPII")
            || upper.contains("CONTENT_FILTER"))
    }

    pub fn observed_usage(&self) -> Option<&UsageAmounts> {
        self.observation.as_deref().and_then(|o| o.usage.as_ref())
    }

    /// Safe user-facing summary for HTTP rejections (e.g. `HTTP 400 (model_http_rejected): INVALID_ARGUMENT: ...`).
    pub fn format_http_rejection(&self) -> Option<String> {
        let status = self.http_status?;
        if self.code != "model_http_rejected" {
            return None;
        }
        Some(match self.http_detail.as_deref() {
            Some(detail) if !detail.is_empty() => {
                format!("HTTP {status} ({}): {detail}", self.code)
            }
            _ => format!("HTTP {status} ({})", self.code),
        })
    }

    /// Safe user-facing diagnostic summary for HTTP rejections and structured stream failures.
    pub fn format_diagnostic(&self) -> Option<String> {
        if let Some(http) = self.format_http_rejection() {
            return Some(http);
        }
        let detail = self.http_detail.as_deref().filter(|s| !s.is_empty())?;
        Some(format!("{} ({detail})", self.code))
    }
}
impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.code)
    }
}
impl std::error::Error for ModelError {}

fn extract_safe_http_detail(body: &[u8]) -> Option<String> {
    let parsed: serde_json::Value = serde_json::from_slice(body).ok()?;
    let root = match &parsed {
        serde_json::Value::Array(items) => items.first()?,
        other => other,
    };
    let err = root.get("error").unwrap_or(root);
    let status = err
        .get("status")
        .or_else(|| err.get("type"))
        .or_else(|| err.get("code"))
        .and_then(|v| match v {
            serde_json::Value::String(s) => Some(s.trim().to_owned()),
            _ => None,
        })
        .filter(|s| !s.is_empty() && s.len() <= 64);
    let message = err
        .get("message")
        .and_then(serde_json::Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty());
    let combined = match (status, message) {
        (Some(s), Some(m)) => format!("{s}: {m}"),
        (None, Some(m)) => m.to_owned(),
        (Some(s), None) => s,
        (None, None) => return None,
    };
    sanitize_provider_error_text(&combined)
}

fn sanitize_provider_error_text(raw: &str) -> Option<String> {
    let mut normalized = String::with_capacity(raw.len().min(256));
    let mut prev_space = false;
    for ch in raw.chars() {
        let c = if ch.is_control() || ch.is_whitespace() {
            ' '
        } else {
            ch
        };
        if c == ' ' {
            if !prev_space && !normalized.is_empty() {
                normalized.push(' ');
                prev_space = true;
            }
        } else {
            normalized.push(c);
            prev_space = false;
        }
    }
    let trimmed = normalized.trim();
    if trimmed.is_empty() {
        return None;
    }
    // Never surface credential-shaped substrings in diagnostics.
    let lower = trimmed.to_ascii_lowercase();
    if trimmed.contains("AIza")
        || lower.contains("bearer ")
        || lower.contains("sk-")
        || lower.contains("x-goog-api-key")
        || lower.contains("x-api-key")
        || lower.contains("api_key=")
        || lower.contains("key=")
    {
        return None;
    }
    let clipped: String = trimmed.chars().take(240).collect();
    Some(clipped)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_safe_structured_detail_from_gemini_array_and_scrubs_secrets() {
        let gemini_400 = br#"[{"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \"additionalProperties\" at 'tools[0].function_declarations[0].parameters'.","status":"INVALID_ARGUMENT"}}]"#;
        let err = ModelError::http(400, gemini_400);
        assert_eq!(err.code, "model_http_rejected");
        assert_eq!(err.http_status, Some(400));
        let formatted = err.format_http_rejection().unwrap();
        assert!(formatted.starts_with("HTTP 400 (model_http_rejected): INVALID_ARGUMENT:"));
        assert!(formatted.contains("additionalProperties"));

        let secret_body = br#"{"error":{"status":"INVALID_ARGUMENT","message":"bad key AIzaSySecretToken123456789"}}"#;
        let scrubbed = ModelError::http(400, secret_body);
        assert!(scrubbed.http_detail.is_none());
        assert_eq!(
            scrubbed.format_http_rejection().as_deref(),
            Some("HTTP 400 (model_http_rejected)")
        );

        let html_body = b"<html><body>502 Bad Gateway</body></html>";
        let html_err = ModelError::http(502, html_body);
        assert!(html_err.http_detail.is_none());
        assert_eq!(
            html_err.format_http_rejection().as_deref(),
            Some("HTTP 502 (model_http_rejected)")
        );

        // Incomplete stream retries transient EOF / MALFORMED_FUNCTION_CALL, not deterministic caps.
        let eof = ModelError::new("model_stream_incomplete").with_detail("eof_before_finish_reason");
        assert!(eof.is_transient_retryable());
        assert_eq!(
            eof.format_diagnostic().as_deref(),
            Some("model_stream_incomplete (eof_before_finish_reason)")
        );
        let malformed_call = ModelError::new("model_stream_incomplete")
            .with_detail("finishReason=MALFORMED_FUNCTION_CALL");
        assert!(malformed_call.is_transient_retryable());
        assert_eq!(
            malformed_call.format_diagnostic().as_deref(),
            Some("model_stream_incomplete (finishReason=MALFORMED_FUNCTION_CALL)")
        );
        let max_tokens =
            ModelError::new("model_stream_incomplete").with_detail("finishReason=MAX_TOKENS");
        assert!(!max_tokens.is_transient_retryable());
        assert_eq!(
            max_tokens.format_diagnostic().as_deref(),
            Some("model_stream_incomplete (finishReason=MAX_TOKENS)")
        );
    }
}
