//! Native local Host: canonical Goal + coordination + device resource ledger.
//! This module owns stop/reconciliation effects; the View never owns these facts.
use crate::{
    coordination::NativeCoordinationReducer, goal_facts::TuiGoalProjector,
    live_execution::ExecutionRegistry,
};
use peer_protocol::normalize_session_execution_identity;
use peer_store::{
    CoordinationSnapshot, CoordinationStore, ExecutionResourceStore, GoalSnapshot, GoalStore,
    HostResourcePlan,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
mod authority;
mod stop;
mod unknown;
pub use authority::{
    HostCallIdentity, HostPermissionGrant, LocalPermissionDecision, PendingPermission,
    ProviderPermission,
};
pub struct NativeSessionHost {
    home: PathBuf,
    goals: GoalStore,
    pub journal: CoordinationStore,
    pub resources: ExecutionResourceStore,
    pub live: ExecutionRegistry,
    permissions: std::sync::Arc<tokio::sync::Semaphore>,
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HostError(pub &'static str);
impl std::fmt::Display for HostError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for HostError {}
impl From<peer_store::StoreError> for HostError {
    fn from(e: peer_store::StoreError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::GoalError> for HostError {
    fn from(e: peer_store::GoalError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::CoordinationError> for HostError {
    fn from(e: peer_store::CoordinationError) -> Self {
        Self(e.code())
    }
}
impl From<peer_store::ResourceError> for HostError {
    fn from(e: peer_store::ResourceError) -> Self {
        Self(e.code())
    }
}
pub(super) struct Current {
    goal: GoalSnapshot,
    journal: CoordinationSnapshot,
    resource: HostResourcePlan,
}
impl NativeSessionHost {
    /// Existing shared stores only. First-run migration/creation is a separate
    /// explicit Host transaction, never a fallback from corrupt authority.
    pub fn open(
        data_home: impl AsRef<Path>,
        journal: CoordinationStore,
        live: ExecutionRegistry,
    ) -> Result<Self, HostError> {
        journal.read(&NativeCoordinationReducer, None)?;
        let home = data_home.as_ref().to_owned();
        Ok(Self {
            goals: GoalStore::new(&home),
            resources: ExecutionResourceStore::open_existing_writable(&home)?,
            home,
            journal,
            live,
            permissions: std::sync::Arc::new(tokio::sync::Semaphore::new(128)),
        })
    }
    fn current(&self, plan_id: &str, now: &str) -> Result<Current, HostError> {
        let projector = TuiGoalProjector::new(now).map_err(HostError)?;
        let goal = self.goals.read(plan_id, &projector, None)?;
        let facts = &goal.facts;
        let execution = normalize_session_execution_identity(&facts["execution"])
            .ok_or(HostError("execution_revision_stale"))?;
        let workspace = self.journal.lease().workspace_id()?;
        if facts["delegationOrigin"]["workspaceId"].as_str() != Some(workspace) {
            return Err(HostError("out_of_scope"));
        }
        let resource = HostResourcePlan {
            execution,
            workspace_id: workspace.into(),
            directory: facts["resourceDirectory"].as_str().map(PathBuf::from),
            title: plan_id.into(),
            read_only: facts["delegationOrigin"]["readOnly"] == true,
        };
        let journal = self.journal.read(&NativeCoordinationReducer, None)?;
        if self.goals.revision(plan_id)? != goal.source_revision {
            return Err(HostError("execution_revision_stale"));
        }
        Ok(Current {
            goal,
            journal,
            resource,
        })
    }
    fn write_control(
        &mut self,
        current: &Current,
        operation: &Value,
        now_ms: i64,
    ) -> Result<(), HostError> {
        if self.goals.revision(&current.resource.execution.plan_id)? != current.goal.source_revision
        {
            return Err(HostError("execution_revision_stale"));
        }
        let prior = control(current);
        let revision = if prior["operationId"] == operation["operationId"] {
            prior["revision"].as_u64().unwrap_or(0)
        } else {
            0
        };
        let entry = json!({"kind":"session_control","minimumExecutorVersion":9,"operation":operation,"expectedRevision":revision,"expectedCurrentOperationId":prior.get("operationId").unwrap_or(&Value::Null)});
        self.journal.append(
            &current.journal,
            &entry,
            now_ms,
            &NativeCoordinationReducer,
            None,
        )?;
        Ok(())
    }
}
fn control(current: &Current) -> Value {
    let session = &current.resource.execution.session_id;
    current.journal.state["sessionControlHeads"][session]["operationId"]
        .as_str()
        .and_then(|id| current.journal.state["sessionControls"].get(id))
        .cloned()
        .unwrap_or_else(|| current.goal.facts["delegationOrigin"]["executionControl"].clone())
}
fn unique(values: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        if !value.is_empty() && !out.contains(&value) {
            out.push(value);
        }
    }
    out
}
fn unsettled(current: &Current) -> Vec<String> {
    let plan = &current.resource.execution.plan_id;
    let work_id = current.goal.facts["delegationOrigin"]["workId"]
        .as_str()
        .unwrap_or("");
    let work = &current.journal.state["works"][work_id];
    let relevant = |row: &Value| row["planId"].as_str().is_none_or(|p| p == plan);
    let uncertain = work["budget"]["uncertainDispatches"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| relevant(r));
    let pending = work["budget"]["attempts"]
        .as_object()
        .into_iter()
        .flat_map(|m| m.values())
        .filter(|r| relevant(r))
        .flat_map(|r| r["pendingTools"].as_array().into_iter().flatten());
    let mut ids: Vec<_> = uncertain
        .chain(pending)
        .filter_map(|r| r["toolCallId"].as_str().map(str::to_owned))
        .collect();
    if work.is_null() {
        ids.extend(
            current.goal.facts["delegationOrigin"]["cancellation"]["evidenceCalls"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|v| v.as_str().map(str::to_owned)),
        );
    }
    unique(ids)
}
fn claim_refs(claims: &[Value]) -> Vec<Value> {
    claims
        .iter()
        .map(|c| json!({"claimId":c["claimId"],"revision":c["revision"]}))
        .collect()
}
fn milliseconds(now: &str) -> Result<i64, HostError> {
    let at = time::OffsetDateTime::parse(now, &time::format_description::well_known::Rfc3339)
        .map_err(|_| HostError("invalid_host_time"))?;
    i64::try_from(at.unix_timestamp_nanos() / 1_000_000).map_err(|_| HostError("invalid_host_time"))
}
