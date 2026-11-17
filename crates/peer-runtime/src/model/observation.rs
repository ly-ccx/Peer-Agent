//! Factual model usage captured before a Host can reject a late response.
use super::{ModelError, ModelTurn};
use peer_protocol::UsageAmounts;

/// Captured before the ownership wait can reject a late result. Known provider
/// facts survive lease loss; executable calls still require the ownership gate.
#[derive(Default)]
pub(crate) struct ModelObservation {
    pub(crate) usage: Option<UsageAmounts>,
    pub(crate) fingerprint: Option<String>,
    pub(crate) invalid: bool,
}
impl ModelObservation {
    pub(crate) fn usage(&self) -> Option<&UsageAmounts> {
        self.usage.as_ref()
    }
    pub(crate) fn capture(result: &Result<ModelTurn, ModelError>) -> Self {
        match result {
            Ok(turn) => {
                let usage = turn
                    .usage
                    .as_ref()
                    .filter(|v| !v.is_null())
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose();
                match usage {
                    Ok(usage) => Self {
                        usage,
                        fingerprint: Some(turn.request_fingerprint.clone()),
                        invalid: false,
                    },
                    Err(_) => Self {
                        invalid: true,
                        ..Self::default()
                    },
                }
            }
            Err(error) => error
                .observation
                .as_ref()
                .map(|o| Self {
                    usage: o.usage.clone(),
                    fingerprint: Some(o.request_fingerprint.clone()),
                    invalid: false,
                })
                .unwrap_or_default(),
        }
    }
}
