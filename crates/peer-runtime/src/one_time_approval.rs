//! Exact, one-use approval factor. Matching never bypasses current projection,
//! principal/policy revision, lease, cancellation or execution/resource fences.
use peer_protocol::javascript_trim;
use serde::Serialize;
use std::collections::HashMap;

pub const ONE_TIME_GRANT_TTL_MS: i64 = 30 * 60 * 1000;
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ApprovalBinding {
    capability: String,
    digest: String,
    session: String,
    workspace: String,
    policy_revision: String,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalBookError {
    InvalidInput,
    LimitExceeded,
}

impl ApprovalBinding {
    pub fn new(
        capability: &str,
        digest: &str,
        session: Option<&str>,
        workspace: Option<&str>,
        policy_revision: Option<&str>,
    ) -> Result<Self, ApprovalBookError> {
        let capability = javascript_trim(capability);
        let session = javascript_trim(session.unwrap_or(""));
        let workspace = javascript_trim(workspace.unwrap_or(""));
        let policy_revision = policy_revision.unwrap_or("");
        if capability.is_empty()
            || capability.len() > 256
            || digest.len() != 64
            || !digest.bytes().all(|b| b.is_ascii_hexdigit())
            || session.len() > 512
            || workspace.len() > 512
            || policy_revision.len() > 512
        {
            return Err(ApprovalBookError::InvalidInput);
        }
        Ok(Self {
            capability: capability.to_owned(),
            digest: digest.to_ascii_lowercase(),
            session: session.to_owned(),
            workspace: workspace.to_owned(),
            policy_revision: policy_revision.to_owned(),
        })
    }
    fn bytes(&self) -> usize {
        self.capability.len()
            + self.digest.len()
            + self.session.len()
            + self.workspace.len()
            + self.policy_revision.len()
    }
}
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RememberedApproval {
    pub capability_id: String,
    pub args_digest: String,
    pub expires_at: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_id: Option<String>,
}
pub struct OneTimeApprovalBook {
    entries: HashMap<ApprovalBinding, i64>,
    bytes: usize,
    ttl_ms: i64,
}
impl Default for OneTimeApprovalBook {
    fn default() -> Self {
        Self {
            entries: HashMap::new(),
            bytes: 0,
            ttl_ms: ONE_TIME_GRANT_TTL_MS,
        }
    }
}
impl OneTimeApprovalBook {
    /// Host approval handler only, after a durable exact local decision.
    pub fn remember(
        &mut self,
        key: ApprovalBinding,
        at: i64,
    ) -> Result<RememberedApproval, ApprovalBookError> {
        if !(0..=9_007_199_254_740_991 - self.ttl_ms).contains(&at) {
            return Err(ApprovalBookError::InvalidInput);
        }
        self.entries.retain(|key, expires| {
            if at >= *expires {
                self.bytes -= key.bytes();
                false
            } else {
                true
            }
        });
        let old_bytes = self.entries.get(&key).map_or(0, |_| key.bytes());
        let next_bytes = self.bytes - old_bytes + key.bytes();
        if !self.entries.contains_key(&key) && self.entries.len() >= 1024
            || next_bytes > 1024 * 1024
        {
            return Err(ApprovalBookError::LimitExceeded);
        }
        let expires_at = at + self.ttl_ms;
        let result = RememberedApproval {
            capability_id: key.capability.clone(),
            args_digest: key.digest.clone(),
            expires_at,
            session_id: (!key.session.is_empty()).then(|| key.session.clone()),
            workspace_id: (!key.workspace.is_empty()).then(|| key.workspace.clone()),
        };
        self.entries.insert(key, expires_at);
        self.bytes = next_bytes;
        Ok(result)
    }
    /// Consumes atomically under the host's mutable owner, not a reusable grant.
    pub fn consume(&mut self, key: &ApprovalBinding, at: i64) -> bool {
        if !(0..=9_007_199_254_740_991).contains(&at) {
            return false;
        }
        let Some(expires) = self.entries.remove(key) else {
            return false;
        };
        self.bytes -= key.bytes();
        at < expires
    }
}
