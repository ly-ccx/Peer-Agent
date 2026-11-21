//! Durable PendingApproval facts in the existing project-runtime format.
//! Stored approved history is audit data, never a runtime PermissionGrant.
use crate::{DirectoryLock, StoreError, durable_jsonl as log, valid_id};
use peer_protocol::javascript_trim;
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::atomic::AtomicBool,
    time::Duration,
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalState {
    Open,
    Approved,
    Denied,
    Expired,
    Stale,
    Cancelled,
}
impl ApprovalState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Approved => "approved",
            Self::Denied => "denied",
            Self::Expired => "expired",
            Self::Stale => "stale",
            Self::Cancelled => "cancelled",
        }
    }
    fn from_str(s: &str) -> Option<Self> {
        Some(match s {
            "open" => Self::Open,
            "approved" => Self::Approved,
            "denied" => Self::Denied,
            "expired" => Self::Expired,
            "stale" => Self::Stale,
            "cancelled" => Self::Cancelled,
            _ => return None,
        })
    }
}
/// Issued by a Host from a current projected operation. Deliberately not Deserialize.
/// Summary is fixed capability copy; never pass arguments or secrets here.
pub struct HostApproval<'a> {
    pub approval_id: &'a str,
    pub workspace_id: Option<&'a str>,
    pub conversation_id: &'a str,
    pub stream_id: &'a str,
    pub plan_id: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub capability_id: &'a str,
    pub args_digest: &'a str,
    pub policy_revision: &'a str,
    pub created_at: &'a str,
    pub deadline_at: Option<&'a str>,
}
/// Facts from an authenticated local interaction or current policy evaluation.
/// The Store does not infer either provenance from model text or a JSON flag.
#[derive(Debug, Clone, Copy)]
pub enum ApprovalDecision {
    LocalUser,
    Policy,
}
impl ApprovalDecision {
    fn as_str(self) -> &'static str {
        match self {
            Self::LocalUser => "local_ui",
            Self::Policy => "policy",
        }
    }
}
pub struct ApprovalStore {
    root: PathBuf,
}
impl ApprovalStore {
    /// No mkdir or migration during discovery.
    pub fn new(data_home: impl AsRef<Path>) -> Self {
        Self {
            root: data_home.as_ref().join("project-runtime"),
        }
    }
    fn path(&self, workspace: Option<&str>) -> Result<PathBuf, StoreError> {
        let name = match workspace {
            Some(id) if valid_id(id, true) => id,
            Some(_) => return Err(StoreError::InvalidInput),
            None => "_unscoped",
        };
        Ok(self.root.join(name).join("approvals.jsonl"))
    }
    /// Strictly folds the requested workspace only. Corrupt or oversized facts
    /// block recovery; they are not silently skipped as an empty approval set.
    pub fn list(
        &self,
        workspace: Option<&str>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<Value>, StoreError> {
        let path = self.path(workspace)?;
        let mut folded = BTreeMap::new();
        for row in log::read(&path, cancel)? {
            validate(&row, workspace)?;
            folded.insert(row["approvalId"].as_str().unwrap().to_owned(), row);
        }
        Ok(folded.into_values().collect())
    }
    pub fn open(
        &self,
        request: &HostApproval<'_>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        let mut row = json!({"approvalId":request.approval_id,"workspaceId":request.workspace_id,"conversationId":request.conversation_id,"streamId":request.stream_id,"planId":request.plan_id,"capabilityId":request.capability_id,"summary":request.capability_id,"riskLevel":null,"argsDigest":request.args_digest,"createdAt":request.created_at,"state":"open","policyRevision":request.policy_revision});
        if let Some(v) = request.session_id {
            row["sessionId"] = json!(v)
        }
        if let Some(v) = request.deadline_at {
            row["deadlineAt"] = json!(v)
        }
        validate(&row, request.workspace_id)?;
        self.mutate(row, None, cancel)
    }
    fn mutate(
        &self,
        row: Value,
        expected: Option<&Value>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        log::check_cancel(cancel)?;
        let workspace = row["workspaceId"].as_str();
        let path = self.path(workspace)?;
        let parent = log::directory(path.parent().unwrap())?;
        let path = parent.join("approvals.jsonl");
        let _lock = DirectoryLock::acquire(&path, Duration::from_millis(100), cancel)?;
        let mut history = log::read(&path, cancel)?;
        if history.len() >= 4096 {
            return Err(StoreError::HistoryLimit);
        }
        let rows = self.list(workspace, cancel)?;
        let current = rows.iter().find(|r| r["approvalId"] == row["approvalId"]);
        if current == Some(&row) {
            return Ok(row);
        }
        if current != expected {
            return Err(StoreError::ApprovalConflict);
        }
        history.push(row.clone());
        log::encode(&history)?;
        log::append(&path, &log::encode(std::slice::from_ref(&row))?, cancel)?;
        Ok(row)
    }
    /// CAS binds the entire latest record, including scope and policy revision.
    /// A decided record cannot be approved again. Stale approval requires a new
    /// live Host request; this API never replays a historical approval.
    pub fn decide(
        &self,
        expected: &Value,
        state: ApprovalState,
        decider: ApprovalDecision,
        at: &str,
        reason: Option<&str>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        validate(expected, expected["workspaceId"].as_str())?;
        if expected["state"] != "open" || state == ApprovalState::Open || !timestamp(at) {
            return Err(StoreError::ApprovalConflict);
        }
        let mut next = expected.clone();
        next["state"] = json!(state.as_str());
        next["decidedAt"] = json!(at);
        next["decidedBy"] = json!(decider.as_str());
        if let Some(reason) = reason {
            if ![
                "permission_cancelled",
                "permission_timeout",
                "permission_unavailable",
                "local_user_denied",
                "permission_policy_changed",
            ]
            .contains(&reason)
            {
                return Err(StoreError::InvalidInput);
            }
            next["decisionReason"] = json!(reason);
        }
        self.mutate(next, Some(expected), cancel)
    }
    /// Only after Host ownership/recovery checks for this exact workspace.
    /// No global startup sweep over another Host's open approvals.
    pub fn recover_owned(
        &self,
        workspace: Option<&str>,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<Value>, StoreError> {
        if !timestamp(at) {
            return Err(StoreError::InvalidInput);
        }
        let now = parse_time(at).unwrap();
        let mut changed = Vec::new();
        for row in self.list(workspace, cancel)? {
            if row["state"] != "open" {
                continue;
            }
            let expired = row["deadlineAt"]
                .as_str()
                .and_then(parse_time)
                .is_some_and(|v| v <= now);
            changed.push(self.decide(
                &row,
                if expired {
                    ApprovalState::Expired
                } else {
                    ApprovalState::Stale
                },
                ApprovalDecision::Policy,
                at,
                expired.then_some("permission_timeout"),
                cancel,
            )?);
        }
        Ok(changed)
    }
}
fn parse_time(v: &str) -> Option<time::OffsetDateTime> {
    time::OffsetDateTime::parse(v, &time::format_description::well_known::Rfc3339).ok()
}
fn timestamp(v: &str) -> bool {
    v.len() <= 64 && parse_time(v).is_some()
}
fn nonempty(v: &Value, limit: usize) -> bool {
    v.as_str()
        .is_some_and(|s| !javascript_trim(s).is_empty() && s.encode_utf16().count() <= limit)
}
fn validate(row: &Value, workspace: Option<&str>) -> Result<(), StoreError> {
    let bad = StoreError::ApprovalCorrupt;
    if !row.is_object()
        || !nonempty(&row["approvalId"], 200)
        || ApprovalState::from_str(row["state"].as_str().unwrap_or("")).is_none()
        || row["workspaceId"].as_str() != workspace
        || !(row["workspaceId"].is_null() || row["workspaceId"].is_string())
        || !nonempty(&row["capabilityId"], 200)
        || !timestamp(row["createdAt"].as_str().unwrap_or(""))
    {
        return Err(bad);
    }
    let digest = row["argsDigest"].as_str().ok_or(bad)?;
    if digest.len() != 64 || !digest.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(bad);
    }
    for key in [
        "conversationId",
        "streamId",
        "planId",
        "sessionId",
        "policyRevision",
    ] {
        if let Some(v) = row.get(key)
            && !v.is_null()
            && !nonempty(v, 200)
        {
            return Err(bad);
        }
    }
    if row["summary"]
        .as_str()
        .is_none_or(|s| s.encode_utf16().count() > 240)
    {
        return Err(bad);
    }
    for key in ["decidedAt", "deadlineAt"] {
        if let Some(v) = row.get(key)
            && !timestamp(v.as_str().unwrap_or(""))
        {
            return Err(bad);
        }
    }
    if let Some(v) = row.get("decidedBy")
        && !["local_ui", "policy"].contains(&v.as_str().unwrap_or(""))
    {
        return Err(bad);
    }
    if let Some(v) = row.get("kind")
        && !["approval", "plan_approval", "image_read_grant"].contains(&v.as_str().unwrap_or(""))
    {
        return Err(bad);
    }
    Ok(())
}
