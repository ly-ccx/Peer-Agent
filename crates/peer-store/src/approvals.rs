//! Durable PendingApproval facts in the existing project-runtime format.
//! Approved history is audit data. Only a separate, exact `image_read_grant`
//! row can carry durable image authority for the desktop image gate.
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
        self.mutate_with_image_grant(row, expected, None, cancel)
    }

    fn mutate_with_image_grant(
        &self,
        row: Value,
        expected: Option<&Value>,
        grant_row: Option<Value>,
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
        if current == Some(&row) && grant_row.is_none() {
            return Ok(row);
        }
        if current != expected {
            return Err(StoreError::ApprovalConflict);
        }
        let mut appended = Vec::new();
        if let Some(grant_row) = grant_row {
            let grant = &grant_row["imageReadGrant"];
            let now = epoch_ms(parse_time(grant_row["decidedAt"].as_str().unwrap()).unwrap());
            if !rows.iter().any(|r| matches_image_grant(r, grant, now)) {
                appended.push(grant_row);
            }
        }
        if current != Some(&row) {
            appended.push(row.clone());
        }
        if !appended.is_empty() {
            history.extend(appended.iter().cloned());
            log::encode(&history)?;
            log::append(&path, &log::encode(&appended)?, cancel)?;
        }
        Ok(row)
    }
    /// Normalize the scope from durable facts, never from the decision payload.
    pub fn image_read_scope(row: &Value) -> Option<Value> {
        if !is_image_request(row) {
            return None;
        }
        normalize_image_scope(&row["imageReadScope"])
    }

    /// Finish a recovered image card without replaying a live permission.
    /// Only an explicit task choice supplies a host-resolved conversation for a durable grant.
    pub fn decide_stale_image_read(
        &self,
        expected: &Value,
        state: ApprovalState,
        at: &str,
        grant_conversation: Option<&str>,
    ) -> Result<Value, StoreError> {
        if expected["state"] != "stale" || !is_image_request(expected) {
            return Err(StoreError::ApprovalConflict);
        }
        let (decider, reason) = match state {
            ApprovalState::Approved if Self::image_read_scope(expected).is_some() => {
                if expected["deadlineAt"]
                    .as_str()
                    .and_then(parse_time)
                    .is_some_and(|deadline| parse_time(at).is_none_or(|at| deadline <= at))
                {
                    return Err(StoreError::ApprovalConflict);
                }
                (ApprovalDecision::LocalUser, None)
            }
            ApprovalState::Denied => (ApprovalDecision::LocalUser, Some("local_user_denied")),
            ApprovalState::Cancelled => (ApprovalDecision::LocalUser, Some("permission_cancelled")),
            _ => return Err(StoreError::InvalidInput),
        };
        let decided = decision_row(expected, state, decider, at, reason)?;
        let grant = match grant_conversation {
            Some(conversation) if state == ApprovalState::Approved => {
                Some(image_grant_row(&decided, conversation)?)
            }
            Some(_) => return Err(StoreError::InvalidInput),
            None => None,
        };
        self.mutate_with_image_grant(decided, Some(expected), grant, None)
    }

    /// A live approval must be settled by its waiter before a scoped grant can be remembered.
    pub fn remember_live_image_read(
        &self,
        opened: &Value,
        decided: &Value,
        grant_conversation: &str,
    ) -> Result<(), StoreError> {
        if opened["state"] != "open"
            || decided["state"] != "approved"
            || decided["decidedBy"] != "local_ui"
            || decision_row(
                opened,
                ApprovalState::Approved,
                ApprovalDecision::LocalUser,
                decided["decidedAt"].as_str().unwrap_or_default(),
                None,
            )? != *decided
        {
            return Err(StoreError::ApprovalConflict);
        }
        let grant = image_grant_row(decided, grant_conversation)?;
        self.mutate_with_image_grant(decided.clone(), Some(decided), Some(grant), None)?;
        Ok(())
    }

    /// CAS binds the entire latest record, including scope and policy revision.
    /// Outside of expiring an image prompt, this generic API only decides open approvals.
    pub fn decide(
        &self,
        expected: &Value,
        state: ApprovalState,
        decider: ApprovalDecision,
        at: &str,
        reason: Option<&str>,
        cancel: Option<&AtomicBool>,
    ) -> Result<Value, StoreError> {
        let can_expire_stale_image = expected["state"] == "stale"
            && is_image_request(expected)
            && state == ApprovalState::Expired
            && matches!(decider, ApprovalDecision::Policy);
        if (expected["state"] != "open" && !can_expire_stale_image)
            || state == ApprovalState::Open
            || !timestamp(at)
        {
            return Err(StoreError::ApprovalConflict);
        }
        self.mutate(
            decision_row(expected, state, decider, at, reason)?,
            Some(expected),
            cancel,
        )
    }
    /// Only after Host ownership/recovery checks for this exact workspace.
    /// No global startup sweep over another Host's open approvals.
    pub fn recover_owned(
        &self,
        workspace: Option<&str>,
        at: &str,
        cancel: Option<&AtomicBool>,
    ) -> Result<Vec<Value>, StoreError> {
        self.recover_owned_preserving(workspace, at, cancel, |_| false)
    }

    /// Preserve an unexpired open request only when the current owner can
    /// still serve it. The caller supplies the durable request binding.
    pub fn recover_owned_preserving(
        &self,
        workspace: Option<&str>,
        at: &str,
        cancel: Option<&AtomicBool>,
        preserve: impl Fn(&Value) -> bool,
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
            if !expired && preserve(&row) {
                continue;
            }
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
const IMAGE_READ_CAPABILITY: &str = "local.image.read";
const IMAGE_READ_ACTION: &str = "read_image_for_model";
const IMAGE_READ_TTL_MS: i64 = 30 * 60 * 1000;

fn is_image_request(row: &Value) -> bool {
    row["capabilityId"] == IMAGE_READ_CAPABILITY
        && matches!(row["kind"].as_str(), None | Some("approval"))
        && row["approvalId"]
            .as_str()
            .is_some_and(|id| !id.starts_with("plan:"))
}

fn normalize_image_scope(scope: &Value) -> Option<Value> {
    let path = scope["path"].as_str()?;
    if scope["capabilityId"] != IMAGE_READ_CAPABILITY
        || scope["action"] != IMAGE_READ_ACTION
        || !Path::new(path).is_absolute()
        || path.contains('\0')
    {
        return None;
    }
    let mut identity = serde_json::Map::new();
    for key in ["dev", "ino", "size", "mtimeMs", "ctimeMs"] {
        let value = scope["fileIdentity"].get(key)?;
        if !value.as_f64().is_some_and(f64::is_finite) {
            return None;
        }
        identity.insert(key.to_owned(), value.clone());
    }
    let workspace_path = scope["workspacePath"]
        .as_str()
        .map(javascript_trim)
        .filter(|s| !s.is_empty());
    Some(
        json!({"capabilityId": IMAGE_READ_CAPABILITY, "action": IMAGE_READ_ACTION,
        "path": path, "workspacePath": workspace_path, "fileIdentity": identity}),
    )
}

fn epoch_ms(at: time::OffsetDateTime) -> i64 {
    (at.unix_timestamp_nanos() / 1_000_000) as i64
}

fn image_grant_row(decided: &Value, conversation: &str) -> Result<Value, StoreError> {
    let scope = ApprovalStore::image_read_scope(decided).ok_or(StoreError::InvalidInput)?;
    let conversation = javascript_trim(conversation);
    if conversation.is_empty()
        || (decided["planId"].is_null()
            && decided["conversationId"].as_str().map(javascript_trim) != Some(conversation))
    {
        return Err(StoreError::InvalidInput);
    }
    let at = decided["decidedAt"]
        .as_str()
        .and_then(parse_time)
        .ok_or(StoreError::InvalidInput)?;
    if decided["deadlineAt"]
        .as_str()
        .and_then(parse_time)
        .is_some_and(|deadline| deadline <= at)
    {
        return Err(StoreError::ApprovalConflict);
    }
    let id = format!("image-{}", uuid::Uuid::new_v4());
    let mut grant = json!({"schemaVersion": 1, "grantId": id, "workspaceId": decided["workspaceId"],
        "conversationId": conversation, "expiresAt": epoch_ms(at) + IMAGE_READ_TTL_MS, "scope": scope});
    if let Some(revision) = decided["policyRevision"].as_str() {
        grant["policyRevision"] = json!(revision);
    }
    let mut row = decided.clone();
    row["approvalId"] = json!(id);
    row["kind"] = json!("image_read_grant");
    row["imageReadGrant"] = grant;
    Ok(row)
}

fn matches_image_grant(row: &Value, grant: &Value, now: i64) -> bool {
    let existing = &row["imageReadGrant"];
    row["kind"] == "image_read_grant"
        && row["capabilityId"] == IMAGE_READ_CAPABILITY
        && row["state"] == "approved"
        && row["decidedBy"] == "local_ui"
        && existing["schemaVersion"] == 1
        && existing["grantId"] == row["approvalId"]
        && existing["expiresAt"]
            .as_f64()
            .is_some_and(|expiry| expiry > now as f64)
        && existing["workspaceId"] == grant["workspaceId"]
        && existing["conversationId"] == grant["conversationId"]
        && (existing["policyRevision"] == grant["policyRevision"]
            || (existing["policyRevision"].is_null()
                && grant["policyRevision"].as_str().is_some_and(|revision| {
                    revision.starts_with("bot:") && revision.ends_with(":1")
                })))
        && normalize_image_scope(&existing["scope"]).is_some_and(|scope| {
            scope["path"] == grant["scope"]["path"]
                && scope["fileIdentity"] == grant["scope"]["fileIdentity"]
        })
}

fn decision_row(
    expected: &Value,
    state: ApprovalState,
    decider: ApprovalDecision,
    at: &str,
    reason: Option<&str>,
) -> Result<Value, StoreError> {
    validate(expected, expected["workspaceId"].as_str())?;
    if !timestamp(at) {
        return Err(StoreError::InvalidInput);
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
    Ok(next)
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
