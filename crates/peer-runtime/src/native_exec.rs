//! Native composition root. Development fixtures and CLI share this entry.
use crate::{
    CancellationToken,
    coordination::NativeCoordinationReducer,
    goal_facts::TuiGoalProjector,
    live_execution::ExecutionRegistry,
    model_config::load_model,
    session_host::{EpisodeOutcome, HostError, NativeSessionHost, PermissionInput},
};
use peer_store::{
    AcquireLease, CoordinationStore, GoalStore, HostIdentity, HostLeaseStore, HostSurface,
};
use std::path::Path;
fn open_host(home: &Path, workspace: &str) -> Result<NativeSessionHost, HostError> {
    let identity = HostIdentity::new(
        &format!("native-{}", uuid::Uuid::new_v4()),
        HostSurface::Tui,
        std::process::id(),
        env!("CARGO_PKG_VERSION"),
    )?;
    let lease = HostLeaseStore::new(home).acquire(
        workspace,
        &identity,
        super::session_host::milliseconds(&super::session_host::episode_time())?,
    )?;
    let AcquireLease::Acquired { token, .. } = lease else {
        return Err(HostError("HOST_LEASE_CONTENDED"));
    };
    let mut journal = CoordinationStore::new(token);
    let prepared = (|| {
        let snapshot = journal.prepare(&NativeCoordinationReducer, None)?;
        journal.checkpoint_head(&snapshot, &NativeCoordinationReducer, None)
    })();
    if let Err(error) = prepared {
        journal.into_lease().release()?;
        return Err(error.into());
    }
    NativeSessionHost::open(home, journal, ExecutionRegistry::default())
}
fn release_idle(host: NativeSessionHost) -> Result<(), HostError> {
    let lease = host.journal.lease().record();
    let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
    let state = host.journal.read(&NativeCoordinationReducer, None)?.state;
    let pending = host
        .resources
        .snapshot()?
        .into_iter()
        .filter(|r| r["hostEpoch"] == epoch)
        .any(|claim| {
            if claim["state"] != "reconciling"
                || claim["handles"]
                    .as_object()
                    .into_iter()
                    .flat_map(|m| m.values())
                    .any(|h| h["state"] != "ended")
            {
                return true;
            }
            let session = claim["execution"]["sessionId"].as_str().unwrap_or("");
            let id = state["sessionControlHeads"][session]["operationId"]
                .as_str()
                .unwrap_or("");
            let receipt = &state["sessionControls"][id]["stopReceipt"];
            receipt["execution"] != claim["execution"]
                || receipt["scope"] != "managed_execution"
                || receipt["runnerIdle"] != true
                || receipt["schedulerIdle"] != true
                || receipt["admissionClosed"] != true
        });
    if !pending {
        host.journal.into_lease().release()?;
    }
    Ok(())
}
pub async fn recover_plan(
    home: &Path,
    plan: &str,
    cancel: &CancellationToken,
) -> Result<serde_json::Value, HostError> {
    let goal = GoalStore::new(home).read(
        plan,
        &TuiGoalProjector::new(&super::session_host::episode_time()).map_err(HostError)?,
        None,
    )?;
    let workspace = goal.facts["delegationOrigin"]["workspaceId"]
        .as_str()
        .ok_or(HostError("out_of_scope"))?;
    let mut host = open_host(home, workspace)?;
    let result = host.recover_native_episode(plan, cancel).await;
    release_idle(host)?;
    result
}
pub async fn execute_plan(
    home: &Path,
    plan: &str,
    permission: &mut impl PermissionInput,
    max_turns: usize,
    cancel: &CancellationToken,
) -> Result<EpisodeOutcome, HostError> {
    let now = super::session_host::episode_time();
    let goal =
        GoalStore::new(home).read(plan, &TuiGoalProjector::new(&now).map_err(HostError)?, None)?;
    let workspace = goal.facts["delegationOrigin"]["workspaceId"]
        .as_str()
        .ok_or(HostError("out_of_scope"))?;
    let model = load_model(
        home,
        &goal.facts["delegationOrigin"]["modelSelection"]["worker"],
        cancel,
    )
    .await
    .map_err(|e| HostError(e.0))?;
    if cancel.is_cancelled() {
        return Err(HostError("CANCELLED"));
    }
    let mut host = open_host(home, workspace)?;
    let result = host
        .run_episode(plan, &model, permission, max_turns, cancel)
        .await;
    // Unknown stays fenced for stop/reconciliation, including after restart.
    release_idle(host)?;
    result
}
