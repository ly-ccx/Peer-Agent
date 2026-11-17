//! Fresh canonical authorization for Host-bound delegated calls. Approval is one
//! factor; policy, ancestry, execution binding, lease and resources stay live.
use super::*;
use peer_protocol::{BotAccessPolicy, approval_args_digest, javascript_json_digest};
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, HostApproval, PolicyStore,
};
use tokio::sync::OwnedSemaphorePermit;

#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HostExecutionRole {
    Worker,
    ProjectAgent,
    Explorer,
    Verifier,
    VisualVerifier,
}
#[derive(Clone, Copy)]
pub struct HostCallIdentity<'a> {
    pub plan_id: &'a str,
    pub session_id: &'a str,
    pub conversation_id: &'a str,
    pub tool_call_id: &'a str,
    pub stream_id: &'a str,
    pub capability_id: &'a str,
    pub permission: ProviderPermission,
    pub role: HostExecutionRole,
    /// Derived by the actual Shell Provider, never a model-declared risk label.
    pub shell_risk: Option<HostShellRisk>,
}
#[derive(PartialEq, Eq)]
struct Authority {
    plan_id: String,
    session_id: String,
    conversation: String,
    tool_call: String,
    stream: String,
    capability: String,
    permission: ProviderPermission,
    role: HostExecutionRole,
    shell_risk: Option<HostShellRisk>,
    digest: String,
    policy: BotAccessPolicy,
    source_digest: String,
}
pub struct PendingPermission {
    authority: Authority,
    record: Value,
    permit: OwnedSemaphorePermit,
    deadline: tokio::time::Instant,
    scope: Option<super::read_scope::ResolvedReadScope>,
}
impl PendingPermission {
    pub fn record(&self) -> &Value {
        &self.record
    }
    /// The same live request owns its timer and the borrowed input future.
    /// Dropping the wait drops the reader; no stdin task survives this request.
    pub(super) async fn wait(
        &self,
        input: &mut (impl PermissionInput + ?Sized),
        prompt: Value,
        cancel: &crate::CancellationToken,
    ) -> LocalPermissionDecision {
        tokio::select! {biased;
            _=cancel.cancelled()=>LocalPermissionDecision::Cancel,
            _=tokio::time::sleep_until(self.deadline)=>LocalPermissionDecision::Timeout,
            decision=input.decide(prompt,cancel)=>{
                if cancel.is_cancelled(){LocalPermissionDecision::Cancel}
                else if tokio::time::Instant::now()>=self.deadline{LocalPermissionDecision::Timeout}
                else{decision}
            }
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LocalPermissionDecision {
    Approve,
    Deny,
    Cancel,
    Unavailable,
    Timeout,
}
pub(super) struct PermissionResolution {
    pub grant: Option<HostPermissionGrant>,
    pub reason: Option<&'static str>,
    pub terminal: Option<HostError>,
}
pub struct HostPermissionGrant {
    authority: Authority,
    facts: Value,
    _permit: OwnedSemaphorePermit,
    scope: Option<super::read_scope::ResolvedReadScope>,
}
impl HostPermissionGrant {
    pub fn facts(&self) -> &Value {
        &self.facts
    }
    pub(crate) fn conversation_id(&self) -> &str {
        &self.authority.conversation
    }
    pub(super) fn identity(&self) -> HostCallIdentity<'_> {
        let a = &self.authority;
        HostCallIdentity {
            plan_id: &a.plan_id,
            session_id: &a.session_id,
            conversation_id: &a.conversation,
            tool_call_id: &a.tool_call,
            stream_id: &a.stream,
            capability_id: &a.capability,
            permission: a.permission,
            role: a.role,
            shell_risk: a.shell_risk,
        }
    }
    pub(super) fn same_authority(&self, other: &Self) -> bool {
        self.authority == other.authority
    }
    pub(super) fn covers_read_scope(&self, path: &Path) -> bool {
        self.scope.as_ref().is_some_and(|s| s.covers(path))
    }
    pub(super) fn validate_read_scope(&self) -> Result<(), HostError> {
        self.scope.as_ref().map_or(Ok(()), |s| s.validate())
    }
}
impl NativeSessionHost {
    fn authority(
        &self,
        call: &HostCallIdentity<'_>,
        args: &Value,
        now: &str,
    ) -> Result<Authority, HostError> {
        if [
            call.plan_id,
            call.session_id,
            call.conversation_id,
            call.tool_call_id,
            call.stream_id,
            call.capability_id,
        ]
        .into_iter()
        .any(|s| s.is_empty() || s.len() > 512)
        {
            return Err(HostError("access_identity_invalid"));
        }
        let current = self.current(call.plan_id, now)?;
        let kind = match call.permission {
            ProviderPermission::Read => "",
            ProviderPermission::FileWrite => "file-write",
            ProviderPermission::Shell => "shell",
            ProviderPermission::Mcp => "mcp-tool",
        };
        let mode = crate::access_policy::evaluate_project_agent_turn(
            &json!({"role":if call.role==HostExecutionRole::ProjectAgent{"project_agent"}else{"work_session"},"capabilityId":call.capability_id,"permissionKind":kind}),
        );
        if mode["allowed"] != true {
            return Err(HostError("project_agent_capability_denied"));
        }
        if matches!(
            call.role,
            HostExecutionRole::Explorer
                | HostExecutionRole::Verifier
                | HostExecutionRole::VisualVerifier
        ) && (call.permission != ProviderPermission::Read
            || !read_capability(call.capability_id))
        {
            return Err(HostError("read_only"));
        }
        if current.resource.execution.session_id != call.session_id
            || current.goal.facts["conversationId"] != call.conversation_id
        {
            return Err(HostError("access_identity_invalid"));
        }
        if !self
            .live
            .admission_open(&current.resource.execution)
            .map_err(|_| HostError("execution_resource_owner_unknown"))?
        {
            return Err(HostError("work_execution_stopped"));
        }
        if current.goal.facts["inheritanceStopped"] == true {
            return Err(HostError("work_execution_stopped"));
        }
        let control = control(&current);
        if control.is_object() && (control["phase"] != "settled" || control["kind"] == "cancel") {
            return Err(HostError("work_execution_stopped"));
        }
        let origin = &current.goal.facts["delegationOrigin"];
        if call.role != HostExecutionRole::ProjectAgent
            && crate::execution_budget::worker_work_stopped(
                &current.journal.state["works"][origin["workId"].as_str().unwrap_or("")],
            )
        {
            return Err(HostError("work_execution_stopped"));
        }
        let binding = &origin["coordinationBinding"];
        if binding.is_object() {
            let work_id = binding["workId"]
                .as_str()
                .ok_or(HostError("execution_revision_stale"))?;
            let transition = current.journal.state["transitions"]
                .as_object()
                .into_iter()
                .flat_map(|m| m.values())
                .find(|r| r["executionEpoch"] == binding["executionEpoch"])
                .unwrap_or(&Value::Null);
            if !crate::coordination::execution_binding_current(
                &current.journal.state["mandates"][work_id],
                transition,
                binding,
            ) {
                return Err(HostError("execution_revision_stale"));
            }
        }
        if current.resource.read_only
            && (call.permission != ProviderPermission::Read || !read_capability(call.capability_id))
        {
            return Err(HostError("read_only"));
        }
        // Interactive publication has a separate role/projection contract. It
        // cannot acquire ordinary file/shell authority through this port.
        if call.capability_id.starts_with("local.interactive.") {
            return Err(HostError("interactive_role_denied"));
        }
        let lease = self.journal.lease().record();
        let epoch = format!("{}:{}", lease.host_id, lease.acquired_at);
        if !self.resources.admitted(&current.resource, &epoch)? {
            return Err(HostError("execution_resource_owner_unknown"));
        }
        let policy = PolicyStore::new(&self.home).read_existing(&current.resource.workspace_id)?;
        let mut parent = origin["parentConversationId"]
            .as_str()
            .ok_or(HostError("out_of_scope"))?
            .to_owned();
        let mut conversation = call.conversation_id.to_owned();
        let mut sources = vec![json!([call.plan_id, current.goal.source_revision])];
        if call.permission == ProviderPermission::Mcp {
            sources.push(json!([
                "mcp-credentials",
                match &self.mcp_credentials {
                    Some(epoch) => epoch
                        .normalized(&current.resource.execution)
                        .map_err(HostError)?
                        .unwrap_or(peer_store::McpCredentialStore::new(&self.home).revision()?),
                    None => peer_store::McpCredentialStore::new(&self.home).revision()?,
                }
            ]));
            sources.push(json!([
                "mcp-registry",
                peer_store::McpRegistryStore::new(&self.home)
                    .read()?
                    .source_revision
            ]));
        }
        let mut seen = std::collections::HashSet::new();
        let projector = TuiGoalProjector::new(now).map_err(HostError)?;
        for _ in 0..4 {
            if !seen.insert(conversation.clone()) {
                return Err(HostError("out_of_scope"));
            }
            let meta = ConversationStore::new(&self.home).read_metadata(&conversation)?;
            sources.push(json!(["conversation-index", meta.source_revision]));
            if let Some(meta) = meta.metadata {
                if meta["workspaceId"] != policy.workspace_id || meta["role"] != "work_session" {
                    return Err(HostError("out_of_scope"));
                }
                if let Some(p) = meta["parentConversationId"].as_str()
                    && p != parent
                {
                    return Err(HostError("out_of_scope"));
                }
            }
            if parent == policy.conversation_id {
                break;
            }
            let ancestor = self
                .goals
                .active_by_conversation(&parent, &projector, None)?;
            sources.push(json!([parent, ancestor.source_revision]));
            let ancestor = ancestor.snapshot.ok_or(HostError("out_of_scope"))?;
            if ancestor.facts["inheritanceStopped"] == true
                || ancestor.facts["delegationOrigin"]["workspaceId"] != policy.workspace_id
            {
                return Err(HostError("out_of_scope"));
            }
            conversation = parent;
            parent = ancestor.facts["delegationOrigin"]["parentConversationId"]
                .as_str()
                .ok_or(HostError("out_of_scope"))?
                .to_owned();
        }
        if parent != policy.conversation_id {
            return Err(HostError("out_of_scope"));
        }
        // Recheck the initially read source after ancestry I/O, then the caller
        // re-evaluates the whole authority after approval and before dispatch.
        if self.goals.revision(call.plan_id)? != current.goal.source_revision
            || !self.journal.lease().holds()?
        {
            return Err(HostError("permission_authority_changed"));
        }
        let source_digest = javascript_json_digest(&json!([
            sources,
            origin["coordinationBinding"],
            control,
            epoch
        ]))
        .map_err(|_| HostError("permission_resource_limit"))?;
        Ok(Authority {
            plan_id: call.plan_id.into(),
            session_id: call.session_id.into(),
            conversation: call.conversation_id.into(),
            tool_call: call.tool_call_id.into(),
            stream: call.stream_id.into(),
            capability: call.capability_id.into(),
            permission: call.permission,
            role: call.role,
            shell_risk: call.shell_risk,
            digest: approval_args_digest(args)
                .map_err(|_| HostError("permission_arguments_invalid"))?,
            policy,
            source_digest,
        })
    }
    /// Each pending object represents a new live Host request. Historical
    /// approved rows are never loaded into reusable grants after restart.
    pub fn request_permission(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        now: &str,
    ) -> Result<PendingPermission, HostError> {
        self.request_permission_scope(call, args, None, now)
    }
    pub(super) fn request_read_permission(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        scope: super::read_scope::ResolvedReadScope,
        now: &str,
    ) -> Result<PendingPermission, HostError> {
        self.request_permission_scope(call, args, Some(scope), now)
    }
    fn request_permission_scope(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        scope: Option<super::read_scope::ResolvedReadScope>,
        now: &str,
    ) -> Result<PendingPermission, HostError> {
        let permit = self
            .permissions
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError("permission_resource_limit"))?;
        let authority = self.authority(&call, args, now)?;
        validate_scope(&scope, &call)?;
        if let Some(scope) = &scope {
            self.validate_scope_workspace(scope, call.plan_id, now)?;
        }
        let digest = scope
            .as_ref()
            .map(|s| s.approval_digest(&authority.digest))
            .transpose()?
            .unwrap_or_else(|| authority.digest.clone());
        let approval_id = format!("approval-{}", uuid::Uuid::new_v4());
        let stamp = policy_stamp(&authority.policy);
        let wait = std::time::Duration::from_secs(300);
        // A shorter clock is accepted only by the fixture-enabled owned Host.
        // Featureless binaries have neither the variable nor this adapter.
        #[cfg(feature = "test-fixtures")]
        let wait = if self.home.join(".native-cli-fixture").is_file() {
            std::env::var("PEER_NATIVE_PERMISSION_WAIT_MS")
                .ok()
                .and_then(|s| s.parse::<u64>().ok())
                .filter(|n| (1..=300_000).contains(n))
                .map(std::time::Duration::from_millis)
                .unwrap_or(wait)
        } else {
            wait
        };
        let at = time::OffsetDateTime::parse(now, &time::format_description::well_known::Rfc3339)
            .map_err(|_| HostError("invalid_host_time"))?;
        let deadline_at = at
            .checked_add(time::Duration::milliseconds(wait.as_millis() as i64))
            .ok_or(HostError("invalid_host_time"))?
            .to_offset(time::UtcOffset::UTC)
            .format(
                &time::format_description::parse_borrowed::<2>(
                    "[year]-[month]-[day]T[hour]:[minute]:[second].[subsecond digits:3]Z",
                )
                .expect("timestamp format"),
            )
            .map_err(|_| HostError("invalid_host_time"))?;
        let deadline = tokio::time::Instant::now() + wait;
        let record = ApprovalStore::new(&self.home).open(
            &HostApproval {
                approval_id: &approval_id,
                workspace_id: Some(&authority.policy.workspace_id),
                conversation_id: &authority.conversation,
                stream_id: &authority.stream,
                plan_id: Some(&authority.plan_id),
                session_id: Some(&authority.session_id),
                capability_id: &authority.capability,
                args_digest: &digest,
                policy_revision: &stamp,
                created_at: now,
                deadline_at: Some(&deadline_at),
            },
            None,
        )?;
        Ok(PendingPermission {
            authority,
            record,
            permit,
            deadline,
            scope,
        })
    }
    fn validate_authority(&self, a: &Authority, args: &Value, now: &str) -> Result<(), HostError> {
        let fresh = self.authority(
            &HostCallIdentity {
                plan_id: &a.plan_id,
                session_id: &a.session_id,
                conversation_id: &a.conversation,
                tool_call_id: &a.tool_call,
                stream_id: &a.stream,
                capability_id: &a.capability,
                permission: a.permission,
                role: a.role,
                shell_risk: a.shell_risk,
            },
            args,
            now,
        )?;
        if fresh.policy != a.policy {
            return Err(HostError("permission_policy_changed"));
        }
        if fresh.digest != a.digest || fresh.source_digest != a.source_digest {
            return Err(HostError("permission_authority_changed"));
        }
        Ok(())
    }
    pub fn decide_permission(
        &self,
        pending: PendingPermission,
        decision: LocalPermissionDecision,
        args: &Value,
        now: &str,
    ) -> Result<Option<HostPermissionGrant>, HostError> {
        let resolution = self.settle_permission(pending, decision, args, now)?;
        if let Some(error) = resolution.terminal {
            return Err(error);
        }
        Ok(resolution.grant)
    }
    pub(super) fn settle_permission(
        &self,
        pending: PendingPermission,
        decision: LocalPermissionDecision,
        args: &Value,
        now: &str,
    ) -> Result<PermissionResolution, HostError> {
        // Monotonic time also rejects late replies when the wall clock regresses.
        let expired = tokio::time::Instant::now() >= pending.deadline
            || milliseconds(now)?
                >= milliseconds(
                    pending.record["deadlineAt"]
                        .as_str()
                        .ok_or(HostError("invalid_host_time"))?,
                )?;
        let valid = if expired {
            Err(HostError("permission_timeout"))
        } else if milliseconds(now)?
            < milliseconds(
                pending.record["createdAt"]
                    .as_str()
                    .ok_or(HostError("invalid_host_time"))?,
            )?
        {
            Err(HostError("invalid_host_time"))
        } else {
            self.validate_authority(&pending.authority, args, now)
                .and_then(|_| pending.scope.as_ref().map_or(Ok(()), |s| s.validate()))
                .and_then(|_| {
                    pending.scope.as_ref().map_or(Ok(()), |s| {
                        self.validate_scope_workspace(s, &pending.authority.plan_id, now)
                    })
                })
        };
        let (state, decider, reason, terminal) = if let Err(error) = valid {
            (
                ApprovalState::Expired,
                ApprovalDecision::Policy,
                match error.0 {
                    "permission_timeout" | "permission_policy_changed" => Some(error.0),
                    _ => None,
                },
                Some(error),
            )
        } else {
            match decision {
                LocalPermissionDecision::Approve => (
                    ApprovalState::Approved,
                    ApprovalDecision::LocalUser,
                    None,
                    None,
                ),
                LocalPermissionDecision::Deny => (
                    ApprovalState::Denied,
                    ApprovalDecision::LocalUser,
                    Some("local_user_denied"),
                    None,
                ),
                LocalPermissionDecision::Cancel => (
                    ApprovalState::Cancelled,
                    ApprovalDecision::Policy,
                    Some("permission_cancelled"),
                    Some(HostError("CANCELLED")),
                ),
                LocalPermissionDecision::Unavailable => (
                    ApprovalState::Denied,
                    ApprovalDecision::Policy,
                    Some("permission_unavailable"),
                    None,
                ),
                LocalPermissionDecision::Timeout => (
                    ApprovalState::Expired,
                    ApprovalDecision::Policy,
                    Some("permission_timeout"),
                    Some(HostError("permission_timeout")),
                ),
            }
        };
        ApprovalStore::new(&self.home).decide(
            &pending.record,
            state,
            decider,
            now,
            reason,
            None,
        )?;
        if state != ApprovalState::Approved {
            return Ok(PermissionResolution {
                grant: None,
                reason: terminal
                    .map(|e| e.0)
                    .filter(|s| *s != "CANCELLED")
                    .or(reason),
                terminal,
            });
        }
        self.validate_authority(&pending.authority, args, now)?;
        let scope = pending
            .scope
            .as_ref()
            .map(|s| s.value())
            .unwrap_or_else(|| json!(pending.authority.capability));
        let facts = json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":pending.authority.tool_call,"granted":true,"scope":scope,"duration":"once","decidedAt":now,"reason":"approved_once_in_tui","policyRevision":policy_stamp(&pending.authority.policy)});
        Ok(PermissionResolution {
            grant: Some(HostPermissionGrant {
                authority: pending.authority,
                facts,
                _permit: pending.permit,
                scope: pending.scope,
            }),
            reason: None,
            terminal: None,
        })
    }
    /// The actual Provider must call this immediately at the effect seam, with
    /// the same immutable operation. Owning the grant is not a durable lease.
    pub fn validate_permission(
        &self,
        grant: &HostPermissionGrant,
        args: &Value,
        now: &str,
    ) -> Result<(), HostError> {
        self.validate_authority(&grant.authority, args, now)?;
        grant.validate_read_scope()?;
        if let Some(scope) = &grant.scope {
            self.validate_scope_workspace(scope, &grant.authority.plan_id, now)?;
        }
        Ok(())
    }
    /// Current policy is an approval factor only. Fresh Goal/role/binding/lease/
    /// resource admission is evaluated first, then again at the Provider seam.
    pub fn automatic_permission(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        now: &str,
    ) -> Result<Option<HostPermissionGrant>, HostError> {
        self.automatic_permission_scope(call, args, None, false, now)
    }
    pub(super) fn automatic_read_permission(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        scope: super::read_scope::ResolvedReadScope,
        admitted: bool,
        now: &str,
    ) -> Result<Option<HostPermissionGrant>, HostError> {
        self.automatic_permission_scope(call, args, Some(scope), admitted, now)
    }
    fn automatic_permission_scope(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        scope: Option<super::read_scope::ResolvedReadScope>,
        admitted: bool,
        now: &str,
    ) -> Result<Option<HostPermissionGrant>, HostError> {
        let permit = self
            .permissions
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError("permission_resource_limit"))?;
        let authority = self.authority(&call, args, now)?;
        validate_scope(&scope, &call)?;
        if let Some(scope) = &scope {
            self.validate_scope_workspace(scope, call.plan_id, now)?;
        }
        if admitted && scope.is_none() {
            return Err(HostError("read_scope_invalid"));
        }
        let prompt = json!({"confirmation":{"kind":"capability-approval","approvalKind":match call.permission{ProviderPermission::Read|ProviderPermission::Mcp=>"other",ProviderPermission::FileWrite=>"file-write",ProviderPermission::Shell=>"shell-exec"}},"riskLevel":call.shell_risk.map(HostShellRisk::as_str)});
        let Some(decision) = (if admitted {
            Some(json!({"reason":"admitted_read_root"}))
        } else {
            crate::access_policy::automatic_access_decision(
                authority.policy.access_level.as_str(),
                &prompt,
                true,
            )
        }) else {
            return Ok(None);
        };
        self.validate_authority(&authority, args, now)?;
        let scope_facts = scope
            .as_ref()
            .map(|s| s.value())
            .unwrap_or_else(|| json!(authority.capability));
        let facts = json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":authority.tool_call,"granted":true,"scope":scope_facts,"duration":"once","decidedAt":now,"reason":decision["reason"],"policyRevision":policy_stamp(&authority.policy)});
        Ok(Some(HostPermissionGrant {
            authority,
            facts,
            _permit: permit,
            scope,
        }))
    }
}
fn validate_scope(
    scope: &Option<super::read_scope::ResolvedReadScope>,
    call: &HostCallIdentity<'_>,
) -> Result<(), HostError> {
    if let Some(scope) = scope {
        if call.permission != ProviderPermission::Read
            || !read_capability(call.capability_id)
            || scope.facts.capability_id != call.capability_id
        {
            return Err(HostError("read_scope_capability_denied"));
        }
        scope.validate()?;
    }
    Ok(())
}
fn policy_stamp(policy: &BotAccessPolicy) -> String {
    format!(
        "bot:{}:{}:{}",
        policy.workspace_id, policy.conversation_id, policy.revision
    )
}
