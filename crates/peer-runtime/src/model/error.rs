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
}
impl ModelError {
    pub const fn new(code: &'static str) -> Self {
        Self {
            code,
            observation: None,
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
