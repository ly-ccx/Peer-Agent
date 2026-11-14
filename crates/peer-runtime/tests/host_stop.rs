#![cfg(feature = "test-fixtures")]
use peer_protocol::{SessionExecutionIdentity, normalize_session_execution_identity};
use peer_runtime::{
    coordination::NativeCoordinationReducer,
    live_execution::{ExecutionRegistry, LiveError, Ownership},
    session_host::NativeSessionHost,
};
use peer_store::{
    AcquireLease, CoordinationStore, ExecutionResourceStore, GoalStore, HostIdentity,
    HostLeaseStore, HostResourcePlan, HostSurface, ResourceReservation,
};
use serde_json::{Value, json};
use std::time::Duration;
use tokio_util::sync::CancellationToken;
const NOW: &str = "2026-11-14T04:00:00.000Z";
const MS: i64 = 1_794_628_800_000;
struct Fixture {
    root: tempfile::TempDir,
    plan: Value,
    execution: SessionExecutionIdentity,
    host: NativeSessionHost,
}
fn fixture() -> Fixture {
    let root = tempfile::tempdir().unwrap();
    std::fs::write(root.path().join(".native-cli-fixture"), "isolated").unwrap();
    let mut resources = ExecutionResourceStore::initialize(root.path(), None).unwrap();
    let contracts: Value = serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/goal-execution-facts.json"
    ))
    .unwrap();
    let mut plan = contracts["cases"]
        .as_array()
        .unwrap()
        .iter()
        .find(|c| c["name"] == "delegated current identity")
        .unwrap()["raw"]
        .clone();
    std::fs::create_dir(root.path().join("workspace")).unwrap();
    plan["targetWorkspacePath"] = json!(root.path().join("workspace"));
    std::fs::create_dir(root.path().join("goal-plans")).unwrap();
    std::fs::write(
        root.path().join("goal-plans/p.json"),
        serde_json::to_vec(&plan).unwrap(),
    )
    .unwrap();
    std::fs::write(root.path().join("goal-plans/index.jsonl"),
        format!("{}\n",json!({"planId":"p","title":"p","conversationId":"c","status":plan["status"],"version":plan["version"],"updatedAt":plan["updatedAt"],"createdAt":plan["createdAt"]}))).unwrap();
    let goal = GoalStore::new(root.path())
        .read(
            "p",
            &peer_runtime::goal_facts::TuiGoalProjector::new(NOW).unwrap(),
            None,
        )
        .unwrap();
    let execution = normalize_session_execution_identity(&goal.facts["execution"]).unwrap();
    let identity = HostIdentity::new(
        "native-stop-test",
        HostSurface::Tui,
        std::process::id(),
        "fixture",
    )
    .unwrap();
    let AcquireLease::Acquired { token, .. } = HostLeaseStore::new(root.path())
        .acquire("w", &identity, MS)
        .unwrap()
    else {
        panic!("isolated lease");
    };
    let epoch = format!("{}:{}", token.record().host_id, token.record().acquired_at);
    let resource = HostResourcePlan {
        execution: execution.clone(),
        workspace_id: "w".into(),
        directory: Some(root.path().join("workspace")),
        title: "p".into(),
        read_only: false,
    };
    resources
        .reserve(
            &resource,
            ResourceReservation {
                host_epoch: &epoch,
                scopes: &[],
                record_conflict: false,
            },
            NOW,
        )
        .unwrap();
    let mut journal = CoordinationStore::new(token);
    journal
        .initialize(&NativeCoordinationReducer, None)
        .unwrap();
    drop(resources);
    let host = NativeSessionHost::open(root.path(), journal, ExecutionRegistry::default()).unwrap();
    Fixture {
        root,
        plan,
        execution,
        host,
    }
}
fn control(host: &NativeSessionHost) -> Value {
    let state = host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap()
        .state;
    let id = state["sessionControlHeads"]["s"]["operationId"]
        .as_str()
        .unwrap();
    state["sessionControls"][id].clone()
}
#[tokio::test]
async fn real_native_child_is_cancelled_reaped_then_stop_is_durable() {
    use tokio::io::AsyncWriteExt;
    let mut f = fixture();
    std::fs::write(f.root.path().join("mode"), "sleep").unwrap();
    let attempt = f.host.live.begin(&f.execution).unwrap();
    let runner_cancel = attempt.cancellation();
    let child_cancel = CancellationToken::new();
    let stopped = child_cancel.clone();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_helper-test-fixture"))
        .env("PEER_AGENT_HOME", f.root.path())
        .env("PATH", "/nonexistent")
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let pid = child.id().unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(br#"{"version":1,"action":"ping"}"#)
        .await
        .unwrap();
    let resource = HostResourcePlan {
        execution: f.execution.clone(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().into()),
        title: "p".into(),
        read_only: false,
    };
    f.host
        .resources
        .mark_handle(
            &resource,
            &json!({"handleId":"child","toolCallId":"call","state":"active"}),
            NOW,
        )
        .unwrap();
    f.host
        .live
        .track_handle(&f.execution, "child", "call", child_cancel, async move {
            stopped.cancelled().await;
            child.kill().await.map_err(|_| ())?;
            child.wait().await.map_err(|_| ())?;
            Ok(())
        })
        .unwrap();
    tokio::spawn(async move {
        runner_cancel.cancelled().await;
        attempt.finish();
    });
    let operation = f
        .host
        .begin_stop("p", "pause", "stop", "local-user:test", NOW)
        .await
        .unwrap();
    assert_eq!(operation["phase"], "draining");
    let receipt = f
        .host
        .drain_stop("p", "stop", Duration::from_secs(3), NOW)
        .await
        .unwrap();
    assert_eq!(receipt["unknownCalls"], json!([]));
    assert_eq!(
        rustix::process::test_kill_process(rustix::process::Pid::from_raw(pid as i32).unwrap()),
        Err(rustix::io::Errno::SRCH)
    );
    assert_eq!(
        f.host.settle_stop("p", "stop", NOW).unwrap()["phase"],
        "settled"
    );
    assert_eq!(control(&f.host)["stopReceipt"], receipt);
    assert!(matches!(
        f.host.live.begin(&f.execution),
        Err(LiveError::Closed)
    ));
    assert!(f.host.resources.snapshot().unwrap().is_empty());
    let mut next = resource;
    next.execution.plan_id = "next".into();
    next.execution.execution_epoch = "next-epoch".into();
    let lease = f.host.journal.lease().record();
    let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
    f.host
        .resources
        .reserve(
            &next,
            ResourceReservation {
                host_epoch: &epoch,
                scopes: &[],
                record_conflict: false,
            },
            NOW,
        )
        .unwrap();
    assert_eq!(
        f.host.resources.snapshot().unwrap()[0]["execution"]["planId"],
        "next"
    );
}
#[tokio::test]
async fn timeout_retains_real_owner_and_later_completion_can_settle() {
    let mut f = fixture();
    let attempt = f.host.live.begin(&f.execution).unwrap();
    f.host
        .begin_stop("p", "pause", "late", "local-user:test", NOW)
        .await
        .unwrap();
    assert_eq!(
        f.host
            .drain_stop("p", "late", Duration::from_millis(10), NOW)
            .await
            .unwrap_err()
            .0,
        "execution_stop_unconfirmed"
    );
    assert_eq!(control(&f.host)["phase"], "reconciling");
    assert_eq!(
        f.host.live.ownership(&f.execution).unwrap(),
        Ownership::Live
    );
    attempt.finish();
    f.host
        .drain_stop("p", "late", Duration::from_secs(1), NOW)
        .await
        .unwrap();
    f.host.settle_stop("p", "late", NOW).unwrap();
    assert_eq!(control(&f.host)["phase"], "settled");
}
#[tokio::test]
async fn restart_without_token_cannot_stop_old_running_execution() {
    let mut f = fixture();
    assert_eq!(
        f.host.live.ownership(&f.execution).unwrap(),
        Ownership::Unknown
    );
    f.host
        .begin_stop("p", "pause", "restart", "local-user:test", NOW)
        .await
        .unwrap();
    assert_eq!(
        f.host
            .drain_stop("p", "restart", Duration::from_millis(10), NOW)
            .await
            .unwrap_err()
            .0,
        "execution_stop_unconfirmed"
    );
    assert_eq!(control(&f.host)["phase"], "reconciling");
    assert_ne!(f.host.resources.snapshot().unwrap()[0]["state"], "released");
    assert!(f.host.settle_stop("p", "restart", NOW).is_err());
}
#[tokio::test]
async fn stale_goal_epoch_and_abandoned_attempt_do_not_create_stop_receipt() {
    let mut f = fixture();
    let attempt = f.host.live.begin(&f.execution).unwrap();
    f.host
        .begin_stop("p", "pause", "stale", "local-user:test", NOW)
        .await
        .unwrap();
    attempt.finish();
    f.plan["delegationOrigin"]["coordinationBinding"]["executionEpoch"] = json!("new-epoch");
    std::fs::write(
        f.root.path().join("goal-plans/p.json"),
        serde_json::to_vec(&f.plan).unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.host
            .drain_stop("p", "stale", Duration::from_secs(1), NOW)
            .await
            .unwrap_err()
            .0,
        "execution_revision_stale"
    );
    assert!(control(&f.host)["stopReceipt"].is_null());
    let registry = ExecutionRegistry::default();
    drop(registry.begin(&f.execution).unwrap());
    assert_eq!(
        registry.ownership(&f.execution).unwrap(),
        Ownership::Unknown
    );
    assert!(matches!(
        registry.begin(&f.execution),
        Err(LiveError::Closed)
    ));
}
#[tokio::test]
async fn failed_handle_stays_unknown_and_blocks_receipt() {
    let mut f = fixture();
    let attempt = f.host.live.begin(&f.execution).unwrap();
    f.host
        .live
        .track_handle(
            &f.execution,
            "failed",
            "call",
            CancellationToken::new(),
            async { Err(()) },
        )
        .unwrap();
    tokio::task::yield_now().await;
    attempt.finish();
    f.host
        .begin_stop("p", "pause", "failed-handle", "local-user:test", NOW)
        .await
        .unwrap();
    assert!(
        f.host
            .drain_stop("p", "failed-handle", Duration::from_secs(1), NOW)
            .await
            .is_err()
    );
    assert!(control(&f.host)["stopReceipt"].is_null());
}
fn prepare_authority(f: &mut Fixture) {
    use peer_protocol::LocalAccessLevel;
    use peer_store::PolicyStore;
    std::fs::create_dir_all(f.root.path().join("projects/w")).unwrap();
    std::fs::write(f.root.path().join("projects/w/profile.json"),br#"{"workspaceId":"w","agentConversationId":"bot","status":"active","displayName":"Fixture Bot","avatar":{"kind":"generated"}}"#).unwrap();
    PolicyStore::new(f.root.path())
        .initialize(LocalAccessLevel::AskBeforeLocal, NOW, None)
        .unwrap();
    std::fs::create_dir_all(f.root.path().join("conversations")).unwrap();
    std::fs::write(f.root.path().join("conversations/index.jsonl"),b"{\"id\":\"c\",\"role\":\"work_session\",\"workspaceId\":\"w\",\"parentConversationId\":\"bot\"}\n").unwrap();
    let before = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap();
    let decision = json!({"kind":"coordination_decision","mandate":{"schemaVersion":1,"mandateId":"mandate","workId":"work","workspaceId":"w","parentConversationId":"bot","goalRevision":2,"lifecycle":"active","sessionIds":["s"],"executionBindings":{},"revokedSessionIds":[],"rootInputIds":["input"],"revisionInputIds":["input"],"materialRefs":[],"allowedActions":["parallel"],"policyRevision":"existing-project-policy"},"receipt":{"operationId":"decision","expectedRevision":0,"sourceInputIds":["input"]},"transition":{"schemaVersion":1,"minimumExecutorVersion":1,"operationId":"decision","workId":"work","executionEpoch":"epoch","expectedGoalRevision":2,"phase":"started"}});
    f.host
        .journal
        .append(&before, &decision, MS, &NativeCoordinationReducer, None)
        .unwrap();
}
fn call() -> peer_runtime::session_host::HostCallIdentity<'static> {
    peer_runtime::session_host::HostCallIdentity {
        plan_id: "p",
        session_id: "s",
        conversation_id: "c",
        tool_call_id: "tool-call",
        stream_id: "stream",
        capability_id: "local.file.write",
        permission: peer_runtime::session_host::ProviderPermission::FileWrite,
    }
}
#[tokio::test]
async fn live_approval_is_bound_to_args_and_current_policy_at_dispatch() {
    use peer_protocol::LocalAccessLevel;
    use peer_runtime::session_host::LocalPermissionDecision;
    use peer_store::{ApprovalStore, PolicyStore};
    let mut f = fixture();
    prepare_authority(&mut f);
    let attempt = f.host.live.begin(&f.execution).unwrap();
    let args = json!({"path":"example.txt","content":"synthetic"});
    let pending = f.host.request_permission(call(), &args, NOW).unwrap();
    let id = pending.record()["approvalId"].as_str().unwrap().to_owned();
    let grant = f
        .host
        .decide_permission(pending, LocalPermissionDecision::Approve, &args, NOW)
        .unwrap()
        .unwrap();
    f.host.validate_permission(&grant, &args, NOW).unwrap();
    assert!(
        f.host
            .validate_permission(
                &grant,
                &json!({"path":"elsewhere.txt","content":"synthetic"}),
                NOW
            )
            .is_err()
    );
    let policy = PolicyStore::new(f.root.path());
    let previous = policy.read_existing("w").unwrap();
    policy
        .update_existing("w", previous.revision, LocalAccessLevel::FullLocal, NOW)
        .unwrap();
    assert_eq!(
        f.host
            .validate_permission(&grant, &args, NOW)
            .unwrap_err()
            .0,
        "permission_policy_changed"
    );
    assert_eq!(
        ApprovalStore::new(f.root.path())
            .list(Some("w"), None)
            .unwrap()
            .iter()
            .find(|r| r["approvalId"] == id)
            .unwrap()["state"],
        "approved"
    );
    attempt.finish();
}
#[tokio::test]
async fn pending_approval_expires_when_authority_changes_and_stop_closes_existing_grant() {
    use peer_protocol::LocalAccessLevel;
    use peer_runtime::session_host::LocalPermissionDecision;
    use peer_store::{ApprovalStore, PolicyStore};
    let mut f = fixture();
    prepare_authority(&mut f);
    let attempt = f.host.live.begin(&f.execution).unwrap();
    let args = json!({"path":"example.txt"});
    let pending = f.host.request_permission(call(), &args, NOW).unwrap();
    let p = PolicyStore::new(f.root.path());
    p.update_existing("w", 1, LocalAccessLevel::FullLocal, NOW)
        .unwrap();
    assert!(
        f.host
            .decide_permission(pending, LocalPermissionDecision::Approve, &args, NOW)
            .is_err()
    );
    assert_eq!(
        ApprovalStore::new(f.root.path())
            .list(Some("w"), None)
            .unwrap()[0]["state"],
        "expired"
    );
    let pending = f.host.request_permission(call(), &args, NOW).unwrap();
    let grant = f
        .host
        .decide_permission(pending, LocalPermissionDecision::Approve, &args, NOW)
        .unwrap()
        .unwrap();
    f.host
        .begin_stop("p", "pause", "auth-stop", "local-user:test", NOW)
        .await
        .unwrap();
    assert!(f.host.validate_permission(&grant, &args, NOW).is_err());
    attempt.finish();
}
#[tokio::test]
async fn foreign_scope_cancelled_plan_and_changed_ancestry_fail_before_approval() {
    let mut f = fixture();
    prepare_authority(&mut f);
    let attempt = f.host.live.begin(&f.execution).unwrap();
    let mut foreign = call();
    foreign.session_id = "other";
    assert!(f.host.request_permission(foreign, &json!({}), NOW).is_err());
    std::fs::write(f.root.path().join("conversations/index.jsonl"),b"{\"id\":\"c\",\"role\":\"work_session\",\"workspaceId\":\"other\",\"parentConversationId\":\"bot\"}\n").unwrap();
    assert_eq!(
        f.host
            .request_permission(call(), &json!({}), NOW)
            .err()
            .unwrap()
            .0,
        "out_of_scope"
    );
    f.plan["delegationOrigin"]["cancellation"] = json!({"operationId":"cancel","phase":"stopping"});
    std::fs::write(
        f.root.path().join("goal-plans/p.json"),
        serde_json::to_vec(&f.plan).unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.host
            .request_permission(call(), &json!({}), NOW)
            .err()
            .unwrap()
            .0,
        "work_execution_stopped"
    );
    attempt.finish();
}
fn git(root: &std::path::Path, args: &[&str]) {
    let result = std::process::Command::new("/usr/bin/git")
        .args(args)
        .current_dir(root)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "git fixture failed: {}",
        String::from_utf8_lossy(&result.stderr)
    );
}
fn prepare_unknown(f: &mut Fixture, capability: &str, answered: bool) -> String {
    prepare_authority(f);
    let mut profile: Value = serde_json::from_slice(
        &std::fs::read(f.root.path().join("projects/w/profile.json")).unwrap(),
    )
    .unwrap();
    profile["unknownOutcomePolicy"] = json!({"tier":"bot_verified","policyId":"policy","revision":1,"updatedAt":NOW,"delegatedAt":NOW});
    std::fs::write(
        f.root.path().join("projects/w/profile.json"),
        serde_json::to_vec(&profile).unwrap(),
    )
    .unwrap();
    let workspace = f.root.path().join("workspace");
    git(&workspace, &["init", "-q"]);
    std::fs::write(workspace.join("base.txt"), "base").unwrap();
    git(&workspace, &["add", "base.txt"]);
    git(
        &workspace,
        &[
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "-qm",
            "base",
        ],
    );
    let execution = serde_json::to_value(&f.execution).unwrap();
    let mut operation = json!({"kind":"pause","operationId":"old-stop","authorityRef":"local-user:old","execution":execution});
    let digest = peer_protocol::javascript_json_digest(&operation).unwrap();
    operation.as_object_mut().unwrap().extend(json!({"requestDigest":digest,"revision":1,"workspaceId":"w","parentConversationId":"bot","sessionId":"s","planId":"p","expectedExecution":execution,"hostEpoch":"old-host:old-lease","recorder":{"bootId":"previous-boot","pid":4242,"pidStart":"old-start","hostId":"old-host","acquiredAt":NOW},"phase":"recorded","updatedAt":NOW}).as_object().unwrap().clone());
    let before = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap();
    f.host.journal.append(&before,&json!({"kind":"session_control","minimumExecutorVersion":9,"operation":operation,"expectedRevision":0,"expectedCurrentOperationId":null}),MS,&NativeCoordinationReducer,None).unwrap();
    let receipts = if answered {
        json!({"dispatch":{"toolCallId":"unknown","outcome":"not_dispatched","dispatchId":"dispatch"}})
    } else {
        json!({})
    };
    let before = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap();
    f.host.journal.append(&before,&json!({"kind":"work","work":{"workId":"work","state":"running","budget":{"uncertainDispatches":[{"toolCallId":"unknown","capabilityId":capability,"dispatchId":"dispatch","registeredAt":NOW,"planId":"p"}],"dispatchReceipts":receipts}}}),MS,&NativeCoordinationReducer,None).unwrap();
    let resource = HostResourcePlan {
        execution: f.execution.clone(),
        workspace_id: "w".into(),
        directory: Some(workspace),
        title: "p".into(),
        read_only: false,
    };
    f.host
        .resources
        .protect(
            &resource,
            Some("old-host:old-lease"),
            Some("old-stop"),
            "reconciling",
            &["unknown".into()],
            NOW,
        )
        .unwrap();
    f.host.resources.snapshot().unwrap()[0]["claimId"]
        .as_str()
        .unwrap()
        .to_owned()
}
#[tokio::test]
async fn native_git_probe_observes_clean_dirty_and_disables_executable_filters() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", false);
    let cancel = CancellationToken::new();
    let clean = f
        .host
        .reconcile_unknown("p", &claim, NOW, &cancel)
        .await
        .unwrap();
    assert_eq!(clean["verdict"], "no_effect_observed", "{clean}");
    let replay = f
        .host
        .reconcile_unknown("p", &claim, NOW, &cancel)
        .await
        .unwrap();
    assert_eq!(replay, clean);
    let workspace = f.root.path().join("workspace");
    std::fs::write(workspace.join("late.txt"), "late").unwrap();
    let dirty = f
        .host
        .reconcile_unknown("p", &claim, NOW, &cancel)
        .await
        .unwrap();
    assert_eq!(dirty["verdict"], "inconclusive");
    std::fs::remove_file(workspace.join("late.txt")).unwrap();
    std::fs::write(
        workspace.join(".gitattributes"),
        "base.txt filter=blocked\n",
    )
    .unwrap();
    let sentinel = f.root.path().join("filter-ran");
    let command = format!("touch {}", sentinel.display());
    git(&workspace, &["config", "filter.blocked.clean", &command]);
    git(&workspace, &["config", "filter.blocked.process", &command]);
    let filtered = peer_runtime::git_probe::GitStatusProbe::default()
        .observe(&workspace, &cancel)
        .await
        .unwrap();
    assert!(filtered["clean"].is_null());
    assert!(!sentinel.exists());
    std::fs::create_dir(workspace.join("nested")).unwrap();
    assert_eq!(
        peer_runtime::git_probe::GitStatusProbe::default()
            .observe(&workspace.join("nested"), &cancel)
            .await
            .unwrap_err()
            .0,
        "reconciliation_scope_exceeded"
    );
    cancel.cancel();
    assert_eq!(
        f.host
            .reconcile_unknown("p", &claim, NOW, &cancel)
            .await
            .unwrap_err()
            .0,
        "CANCELLED"
    );
}
#[tokio::test]
async fn delegated_unknown_closure_retains_unknown_and_never_marks_call_success() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    let evidence = f
        .host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(evidence["verdict"], "no_effect_observed");
    let closure = f
        .host
        .resolve_unknown_bot_verified("p", &claim, NOW)
        .await
        .unwrap();
    assert_eq!(closure["unknownCalls"], json!(["unknown"]));
    assert_eq!(closure["resolution"]["tier"], "bot_verified");
    assert!(f.host.resources.snapshot().unwrap().is_empty());
    let resource = HostResourcePlan {
        execution: f.execution.clone(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().join("workspace")),
        title: "p".into(),
        read_only: false,
    };
    assert_eq!(
        f.host.resources.retained_unknowns(&resource).unwrap()[0]["unknownCalls"],
        json!(["unknown"])
    );
    let state = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap()
        .state;
    assert_eq!(
        state["works"]["work"]["budget"]["uncertainDispatches"][0]["toolCallId"],
        "unknown"
    );
}
#[tokio::test]
async fn shell_unknown_requires_manual_gate_and_revoked_policy_blocks_file_closure() {
    let mut shell = fixture();
    let id = prepare_unknown(&mut shell, "local.shell.exec", true);
    shell
        .host
        .reconcile_unknown("p", &id, NOW, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(
        shell
            .host
            .resolve_unknown_bot_verified("p", &id, NOW)
            .await
            .unwrap_err()
            .0,
        "capability_not_confined"
    );
    let mut f = fixture();
    let id = prepare_unknown(&mut f, "local.file.write", true);
    f.host
        .reconcile_unknown("p", &id, NOW, &CancellationToken::new())
        .await
        .unwrap();
    let mut profile: Value = serde_json::from_slice(
        &std::fs::read(f.root.path().join("projects/w/profile.json")).unwrap(),
    )
    .unwrap();
    profile["unknownOutcomePolicy"]["tier"] = json!("ask");
    profile["unknownOutcomePolicy"]["revision"] = json!(2);
    std::fs::write(
        f.root.path().join("projects/w/profile.json"),
        serde_json::to_vec(&profile).unwrap(),
    )
    .unwrap();
    assert_eq!(
        f.host
            .resolve_unknown_bot_verified("p", &id, NOW)
            .await
            .unwrap_err()
            .0,
        "authorization_required"
    );
    assert!(!f.host.resources.snapshot().unwrap().is_empty());
}
fn close_ledger_only(f: &mut Fixture, id: &str, evidence: &Value) -> Value {
    let claim = f
        .host
        .resources
        .snapshot()
        .unwrap()
        .into_iter()
        .find(|c| c["claimId"] == id)
        .unwrap();
    let resource = HostResourcePlan {
        execution: f.execution.clone(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().join("workspace")),
        title: "p".into(),
        read_only: false,
    };
    let resolution = json!({"tier":"bot_verified","verdict":evidence["verdict"],"evidenceDigest":evidence["evidenceDigest"],"policyRef":"policy:policy"});
    f.host
        .resources
        .close_claim(
            &resource,
            peer_store::HostClaimClosure {
                claim_id: id,
                claim_revision: claim["revision"].as_u64().unwrap(),
                authority_ref: "policy:policy",
                unknown_calls: &["unknown".into()],
                proof: "verified_dead",
                resolution: Some(&resolution),
                at: NOW,
            },
        )
        .unwrap()
}
#[tokio::test]
async fn closure_before_mirror_recovery_preserves_unknown_and_is_idempotent() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    let evidence = f
        .host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    let closure = close_ledger_only(&mut f, &claim, &evidence);
    let goals = GoalStore::new(f.root.path());
    let projector = peer_runtime::goal_facts::TuiGoalProjector::new(NOW).unwrap();
    assert!(goals.read("p",&projector,None).unwrap().facts["delegationOrigin"]["executionClaimClosure"].is_null());
    assert_eq!(f.host.recover_execution_mirrors("p", NOW).unwrap(), 2);
    let recovered = goals.read("p", &projector, None).unwrap();
    assert_eq!(
        recovered.facts["delegationOrigin"]["executionClaimClosure"],
        closure
    );
    let body: Value =
        serde_json::from_slice(&std::fs::read(f.root.path().join("goal-plans/p.json")).unwrap())
            .unwrap();
    assert_eq!(body["future"]["opaque"], "preserved");
    let events = std::fs::read(f.root.path().join("goal-plans/.changes.jsonl")).unwrap();
    assert_eq!(f.host.recover_execution_mirrors("p", NOW).unwrap(), 0);
    assert_eq!(
        goals.read("p", &projector, None).unwrap().source_revision,
        recovered.source_revision
    );
    assert_eq!(
        std::fs::read(f.root.path().join("goal-plans/.changes.jsonl")).unwrap(),
        events
    );
    let state = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap()
        .state;
    assert_eq!(
        state["works"]["work"]["budget"]["uncertainDispatches"][0]["toolCallId"],
        "unknown"
    );
}
#[tokio::test]
async fn mirror_body_before_index_repairs_metadata_without_duplicate_goal_revision() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    let evidence = f
        .host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    let closure = close_ledger_only(&mut f, &claim, &evidence);
    let goals = GoalStore::new(f.root.path());
    let projector = peer_runtime::goal_facts::TuiGoalProjector::new(NOW).unwrap();
    let before = goals.read("p", &projector, None).unwrap();
    let transaction = goals
        .prepare_execution_mirror(
            f.host.journal.lease(),
            "p",
            &before.source_revision,
            &projector,
            None,
        )
        .unwrap();
    assert_eq!(
        transaction
            .commit_before_index_fixture(peer_store::GoalExecutionFact::ClaimClosure(&closure), NOW)
            .err()
            .unwrap()
            .code(),
        "STORE_COMMIT_UNCERTAIN"
    );
    let written = goals.read("p", &projector, None).unwrap();
    assert_eq!(written.facts["version"], 2);
    let index: Value = serde_json::from_slice(
        &std::fs::read(f.root.path().join("goal-plans/index.jsonl")).unwrap(),
    )
    .unwrap();
    assert_eq!(index["version"], 1);
    let transaction = goals
        .prepare_execution_mirror(
            f.host.journal.lease(),
            "p",
            &written.source_revision,
            &projector,
            None,
        )
        .unwrap();
    assert!(
        !transaction
            .commit(
                peer_store::GoalExecutionFact::ClaimClosure(&closure),
                NOW,
                None
            )
            .unwrap()
            .changed
    );
    assert_eq!(
        goals.read("p", &projector, None).unwrap().facts["version"],
        2
    );
    let index: Value = serde_json::from_slice(
        &std::fs::read(f.root.path().join("goal-plans/index.jsonl")).unwrap(),
    )
    .unwrap();
    assert_eq!(index["version"], 2);
}
#[tokio::test]
async fn missing_goal_index_or_orphan_lock_prevents_closure_before_sql_effect() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    f.host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    let lock = f.root.path().join("goal-plans/index.jsonl.lock");
    std::fs::create_dir(&lock).unwrap();
    assert_eq!(
        f.host
            .resolve_unknown_bot_verified("p", &claim, NOW)
            .await
            .unwrap_err()
            .0,
        "STORE_LOCK_BUSY"
    );
    assert!(!f.host.resources.snapshot().unwrap().is_empty());
    assert!(lock.is_dir());
    std::fs::remove_dir(&lock).unwrap();
    std::fs::write(f.root.path().join("goal-plans/index.jsonl"), b"").unwrap();
    assert_eq!(
        f.host
            .resolve_unknown_bot_verified("p", &claim, NOW)
            .await
            .unwrap_err()
            .0,
        "GOAL_INDEX_RECONCILIATION_REQUIRED"
    );
    assert!(!f.host.resources.snapshot().unwrap().is_empty());
}
#[tokio::test]
async fn new_canonical_task_is_admitted_by_host_after_old_unknown_closure() {
    use peer_runtime::session_host::{
        HostCallIdentity, LocalPermissionDecision, ProviderPermission,
    };
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    f.host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    f.host
        .resolve_unknown_bot_verified("p", &claim, NOW)
        .await
        .unwrap();
    // Seed a separate canonical task fixture, not an alternative execution log.
    let mut next = f.plan.clone();
    next["planId"] = json!("next");
    next["conversationId"] = json!("next-conversation");
    next["delegationOrigin"]["sessionId"] = json!("next-session");
    next["delegationOrigin"]["coordinationBinding"]["executionEpoch"] = json!("next-epoch");
    std::fs::write(
        f.root.path().join("goal-plans/next.json"),
        serde_json::to_vec(&next).unwrap(),
    )
    .unwrap();
    let mut index = std::fs::read_to_string(f.root.path().join("goal-plans/index.jsonl")).unwrap();
    index.push_str(&format!("{}\n",json!({"planId":"next","conversationId":"next-conversation","status":"executing","version":1,"updatedAt":NOW})));
    std::fs::write(f.root.path().join("goal-plans/index.jsonl"), index).unwrap();
    let meta = format!(
        "{}\n{}\n",
        json!({"id":"c","workspaceId":"w","role":"work_session","parentConversationId":"bot"}),
        json!({"id":"next-conversation","workspaceId":"w","role":"work_session","parentConversationId":"bot"})
    );
    std::fs::write(f.root.path().join("conversations/index.jsonl"), meta).unwrap();
    let before = f
        .host
        .journal
        .read(&NativeCoordinationReducer, None)
        .unwrap();
    f.host.journal.append(&before,&json!({"kind":"coordination_decision","mandate":before.state["mandates"]["work"],"receipt":{"operationId":"next-decision","expectedRevision":2,"sourceInputIds":["next-input"]},"transition":{"schemaVersion":1,"minimumExecutorVersion":1,"executionEpoch":"next-epoch","expectedGoalRevision":2,"phase":"started"}}),MS,&NativeCoordinationReducer,None).unwrap();
    let facts = GoalStore::new(f.root.path())
        .read(
            "next",
            &peer_runtime::goal_facts::TuiGoalProjector::new(NOW).unwrap(),
            None,
        )
        .unwrap()
        .facts;
    let execution = normalize_session_execution_identity(&facts["execution"]).unwrap();
    let resource = HostResourcePlan {
        execution: execution.clone(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().join("workspace")),
        title: "next".into(),
        read_only: false,
    };
    let lease = f.host.journal.lease().record();
    let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
    f.host
        .resources
        .reserve(
            &resource,
            ResourceReservation {
                host_epoch: &epoch,
                scopes: &[],
                record_conflict: false,
            },
            NOW,
        )
        .unwrap();
    let attempt = f.host.live.begin(&execution).unwrap();
    let args = json!({"path":"next.txt","content":"next"});
    let pending = f
        .host
        .request_permission(
            HostCallIdentity {
                plan_id: "next",
                session_id: "next-session",
                conversation_id: "next-conversation",
                tool_call_id: "next-call",
                stream_id: "next-stream",
                capability_id: "local.file.write",
                permission: ProviderPermission::FileWrite,
            },
            &args,
            NOW,
        )
        .unwrap();
    let grant = f
        .host
        .decide_permission(pending, LocalPermissionDecision::Approve, &args, NOW)
        .unwrap()
        .unwrap();
    f.host.validate_permission(&grant, &args, NOW).unwrap();
    attempt.finish();
    let old_resource = HostResourcePlan {
        execution: f.execution.clone(),
        workspace_id: "w".into(),
        directory: Some(f.root.path().join("workspace")),
        title: "p".into(),
        read_only: false,
    };
    assert_eq!(
        f.host.resources.retained_unknowns(&old_resource).unwrap()[0]["unknownCalls"],
        json!(["unknown"])
    );
}
#[tokio::test]
async fn goal_mirror_rechecks_source_and_lock_owner_before_writing() {
    let mut f = fixture();
    let claim = prepare_unknown(&mut f, "local.file.write", true);
    let evidence = f
        .host
        .reconcile_unknown("p", &claim, NOW, &CancellationToken::new())
        .await
        .unwrap();
    let closure = close_ledger_only(&mut f, &claim, &evidence);
    let goals = GoalStore::new(f.root.path());
    let projector = peer_runtime::goal_facts::TuiGoalProjector::new(NOW).unwrap();
    let before = goals.read("p", &projector, None).unwrap();
    let transaction = goals
        .prepare_execution_mirror(
            f.host.journal.lease(),
            "p",
            &before.source_revision,
            &projector,
            None,
        )
        .unwrap();
    let lock = f.root.path().join("goal-plans/index.jsonl.lock");
    let retained = f.root.path().join("goal-plans/retained-index-lock");
    std::fs::rename(&lock, &retained).unwrap();
    std::fs::create_dir(&lock).unwrap();
    assert_eq!(
        transaction
            .commit(
                peer_store::GoalExecutionFact::ClaimClosure(&closure),
                NOW,
                None
            )
            .err()
            .unwrap()
            .code(),
        "STORE_LOCK_OWNERSHIP_CHANGED"
    );
    assert_eq!(
        goals.read("p", &projector, None).unwrap().source_revision,
        before.source_revision
    );
    assert!(lock.is_dir());
    assert!(retained.is_dir());
    std::fs::remove_dir(&lock).unwrap();
    let transaction = goals
        .prepare_execution_mirror(
            f.host.journal.lease(),
            "p",
            &before.source_revision,
            &projector,
            None,
        )
        .unwrap();
    f.plan["future"] = json!({"opaque":"new external source"});
    std::fs::write(
        f.root.path().join("goal-plans/p.json"),
        serde_json::to_vec(&f.plan).unwrap(),
    )
    .unwrap();
    assert_eq!(
        transaction
            .commit(
                peer_store::GoalExecutionFact::ClaimClosure(&closure),
                NOW,
                None
            )
            .err()
            .unwrap()
            .code(),
        "GOAL_SOURCE_CHANGED"
    );
    assert_eq!(
        serde_json::from_slice::<Value>(
            &std::fs::read(f.root.path().join("goal-plans/p.json")).unwrap()
        )
        .unwrap()["future"]["opaque"],
        "new external source"
    );
}
