//! Device-local resource ownership. These records cannot grant a capability,
//! assert a stopped process, or turn an unknown tool outcome into success.
use peer_protocol::{ExecutionResourceScope, SessionExecutionIdentity};
use rusqlite::Connection;
use serde_json::Value;
use std::{fmt, path::PathBuf};
mod claims;
mod closure;
mod database;
mod scopes;
mod settlement;
pub use scopes::{
    ResourceIdentity, directory_resource, file_resource, provider_execution_scopes,
    provider_file_scopes, resource_conflicts,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ResourceError {
    Invalid,
    Scope,
    Unavailable,
    Changed,
    Missing,
    Schema,
    Limit,
    Cancelled,
    ClaimClosed,
    OwnerUnknown,
    ReceiptInvalid,
    ReceiptConflict,
    ReceiptStale,
    StopUnconfirmed,
    ReadOnly,
    ClosureInvalid,
    ClaimMissing,
    ClaimScope,
    ClaimActive,
    ClosureStale,
    UnknownMismatch,
    ReconciliationInvalid,
}
impl ResourceError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Invalid => "execution_resource_store_invalid",
            Self::Scope => "execution_resource_scope_unknown",
            Self::Unavailable => "execution_resource_store_unavailable",
            Self::Changed => "execution_resource_store_changed",
            Self::Missing => "execution_resource_store_missing",
            Self::Schema => "execution_resource_schema_unsupported",
            Self::Limit => "execution_resource_limit",
            Self::Cancelled => "CANCELLED",
            Self::ClaimClosed => "execution_resource_claim_closed",
            Self::OwnerUnknown => "execution_resource_owner_unknown",
            Self::ReceiptInvalid => "execution_resource_receipt_invalid",
            Self::ReceiptConflict => "execution_resource_receipt_conflict",
            Self::ReceiptStale => "execution_resource_receipt_stale",
            Self::StopUnconfirmed => "execution_stop_unconfirmed",
            Self::ReadOnly => "execution_resource_read_only",
            Self::ClosureInvalid => "execution_resource_closure_invalid",
            Self::ClaimMissing => "execution_resource_claim_missing",
            Self::ClaimScope => "execution_resource_claim_scope",
            Self::ClaimActive => "execution_resource_claim_active",
            Self::ClosureStale => "execution_resource_closure_stale",
            Self::UnknownMismatch => "execution_resource_closure_unknown_mismatch",
            Self::ReconciliationInvalid => "reconciliation_evidence_invalid",
        }
    }
}
impl fmt::Display for ResourceError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}
impl std::error::Error for ResourceError {}
impl From<rusqlite::Error> for ResourceError {
    fn from(_: rusqlite::Error) -> Self {
        Self::Unavailable
    }
}

/// Fresh facts supplied by the Host's canonical plan adapter. Deliberately not
/// Deserialize: UI/model arguments are not a source of execution ownership.
pub struct HostResourcePlan {
    pub execution: SessionExecutionIdentity,
    pub workspace_id: String,
    pub directory: Option<PathBuf>,
    pub title: String,
    pub read_only: bool,
}
impl HostResourcePlan {
    fn check(&self) -> Result<(), ResourceError> {
        if !crate::valid_id(&self.workspace_id, true)
            || self.title.len() > 8192
            || peer_protocol::normalize_session_execution_identity(&claims::execution_json(
                &self.execution,
            ))
            .as_ref()
                != Some(&self.execution)
        {
            return Err(ResourceError::Invalid);
        }
        Ok(())
    }
}
pub struct ExecutionResourceStore {
    file: crate::sqlite_file::SqliteFile,
    connection: Connection,
    writable: bool,
}

/// Scope sets come from Provider effect derivation, never permission text.
pub struct ResourceReservation<'a> {
    pub host_epoch: &'a str,
    pub scopes: &'a [ExecutionResourceScope],
    pub record_conflict: bool,
}
/// Host projection of canonical dispatch records, not a model-declared proof.
pub struct HostDispatchScopes {
    pub tool_call_id: String,
    pub scopes: Vec<ExecutionResourceScope>,
}
pub struct HostClaimClosure<'a> {
    pub claim_id: &'a str,
    pub claim_revision: u64,
    pub authority_ref: &'a str,
    pub unknown_calls: &'a [String],
    pub proof: &'a str,
    pub resolution: Option<&'a Value>,
    pub at: &'a str,
}

fn sql_json(value: &Value) -> Result<String, ResourceError> {
    let text = peer_protocol::javascript_json_string(value).map_err(|_| ResourceError::Limit)?;
    if text.len() > 1_048_576 {
        return Err(ResourceError::Limit);
    }
    Ok(text)
}
fn parse_json(text: &str) -> Result<Value, ResourceError> {
    peer_protocol::decode_json_bounded(
        text.as_bytes(),
        peer_protocol::JsonLimits {
            bytes: 1_048_576,
            nodes: 16_384,
            depth: 64,
            string_bytes: 1_048_576,
        },
    )
    .map(|v| v.value)
    .map_err(|e| match e {
        peer_protocol::JsonDecodeError::LimitExceeded => ResourceError::Limit,
        peer_protocol::JsonDecodeError::InvalidJson => ResourceError::Invalid,
    })
}
fn text(value: &Value) -> Result<&str, ResourceError> {
    value
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 8192)
        .ok_or(ResourceError::Invalid)
}
fn revision(value: &Value) -> Result<u64, ResourceError> {
    value
        .as_f64()
        .filter(|v| v.fract() == 0.0 && (1.0..9_007_199_254_740_991.0).contains(v))
        .map(|v| v as u64)
        .ok_or(ResourceError::Invalid)
}
fn next_revision(value: &Value) -> Result<Value, ResourceError> {
    Ok((revision(&value["revision"])? + 1).into())
}
fn ids(value: &Value) -> Result<Vec<String>, ResourceError> {
    let values = value
        .as_array()
        .filter(|v| v.len() <= 4096)
        .ok_or(ResourceError::Invalid)?;
    let mut result = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut bytes = 0usize;
    for value in values {
        let s = text(value)?;
        bytes += s.len();
        if bytes > 1_048_576 {
            return Err(ResourceError::Limit);
        }
        if seen.insert(s) {
            result.push(s.to_owned());
        }
    }
    Ok(result)
}
fn borrowed_ids(values: &[String]) -> Result<Vec<String>, ResourceError> {
    if values.len() > 4096 {
        return Err(ResourceError::Limit);
    }
    let mut bytes = 0usize;
    for s in values {
        bytes = bytes.checked_add(s.len()).ok_or(ResourceError::Limit)?;
        if s.is_empty() || s.len() > 8192 || bytes > 1_048_576 {
            return Err(ResourceError::Limit);
        }
    }
    let mut seen = std::collections::HashSet::new();
    Ok(values
        .iter()
        .filter(|s| seen.insert(s.as_str()))
        .cloned()
        .collect())
}
fn sorted_ids(value: &Value) -> Result<Vec<String>, ResourceError> {
    let mut values = ids(value)?;
    values.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    Ok(values)
}
fn stamp(at: &str) -> Result<(), ResourceError> {
    if at.is_empty() || at.len() > 1024 {
        return Err(ResourceError::Invalid);
    }
    Ok(())
}
