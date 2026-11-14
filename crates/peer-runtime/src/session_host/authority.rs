//! Fresh canonical authorization for Host-bound delegated calls. Approval is one
//! factor; policy, ancestry, execution binding, lease and resources stay live.
use super::*;
use peer_protocol::{BotAccessPolicy, approval_args_digest, javascript_json_digest};
use peer_store::{
    ApprovalDecision, ApprovalState, ApprovalStore, ConversationStore, HostApproval, PolicyStore,
};
use tokio::sync::OwnedSemaphorePermit;

/// Trusted Provider manifest classification, never deserialized from call args.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ProviderPermission {
    Read,
    FileWrite,
    Shell,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HostExecutionRole {
    Worker,
    ProjectAgent,
    Explorer,
    Verifier,
    VisualVerifier,
}
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum HostShellRisk {
    Inert,
    LocalRead,
    LocalWrite,
    ExternalWrite,
    Privileged,
    Destructive,
}
impl HostShellRisk {
    fn as_str(self) -> &'static str {
        match self {
            Self::Inert => "L0_inert",
            Self::LocalRead => "L1_local_read",
            Self::LocalWrite => "L2_local_write",
            Self::ExternalWrite => "L3_external_write",
            Self::Privileged => "L4_privileged",
            Self::Destructive => "L5_destructive",
        }
    }
}
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
}
impl PendingPermission {
    pub fn record(&self) -> &Value {
        &self.record
    }
}
pub enum LocalPermissionDecision {
    Approve,
    Deny,
    Cancel,
}
pub struct HostPermissionGrant {
    authority: Authority,
    facts: Value,
    _permit: OwnedSemaphorePermit,
}
impl HostPermissionGrant {
    pub fn facts(&self) -> &Value {
        &self.facts
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
        let permit = self
            .permissions
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError("permission_resource_limit"))?;
        let authority = self.authority(&call, args, now)?;
        let approval_id = format!("approval-{}", uuid::Uuid::new_v4());
        let stamp = policy_stamp(&authority.policy);
        let record = ApprovalStore::new(&self.home).open(
            &HostApproval {
                approval_id: &approval_id,
                workspace_id: Some(&authority.policy.workspace_id),
                conversation_id: &authority.conversation,
                stream_id: &authority.stream,
                plan_id: Some(&authority.plan_id),
                session_id: Some(&authority.session_id),
                capability_id: &authority.capability,
                args_digest: &authority.digest,
                policy_revision: &stamp,
                created_at: now,
                deadline_at: None,
            },
            None,
        )?;
        Ok(PendingPermission {
            authority,
            record,
            permit,
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
        let valid = self.validate_authority(&pending.authority, args, now);
        let state = if valid.is_err() {
            ApprovalState::Expired
        } else {
            match decision {
                LocalPermissionDecision::Approve => ApprovalState::Approved,
                LocalPermissionDecision::Deny => ApprovalState::Denied,
                LocalPermissionDecision::Cancel => ApprovalState::Cancelled,
            }
        };
        ApprovalStore::new(&self.home).decide(
            &pending.record,
            state,
            ApprovalDecision::LocalUser,
            now,
            valid.as_ref().err().map(|e| e.0),
            None,
        )?;
        valid?;
        if !matches!(decision, LocalPermissionDecision::Approve) {
            return Ok(None);
        }
        self.validate_authority(&pending.authority, args, now)?;
        let facts = json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":pending.authority.tool_call,"granted":true,"scope":pending.authority.capability,"duration":"once","decidedAt":now,"reason":"approved_once_in_tui","policyRevision":policy_stamp(&pending.authority.policy)});
        Ok(Some(HostPermissionGrant {
            authority: pending.authority,
            facts,
            _permit: pending.permit,
        }))
    }
    /// The actual Provider must call this immediately at the effect seam, with
    /// the same immutable operation. Owning the grant is not a durable lease.
    pub fn validate_permission(
        &self,
        grant: &HostPermissionGrant,
        args: &Value,
        now: &str,
    ) -> Result<(), HostError> {
        self.validate_authority(&grant.authority, args, now)
    }
    /// Current policy is an approval factor only. Fresh Goal/role/binding/lease/
    /// resource admission is evaluated first, then again at the Provider seam.
    pub fn automatic_permission(
        &self,
        call: HostCallIdentity<'_>,
        args: &Value,
        now: &str,
    ) -> Result<Option<HostPermissionGrant>, HostError> {
        let permit = self
            .permissions
            .clone()
            .try_acquire_owned()
            .map_err(|_| HostError("permission_resource_limit"))?;
        let authority = self.authority(&call, args, now)?;
        let prompt = json!({"confirmation":{"kind":"capability-approval","approvalKind":match call.permission{ProviderPermission::Read=>"other",ProviderPermission::FileWrite=>"file-write",ProviderPermission::Shell=>"shell-exec"}},"riskLevel":call.shell_risk.map(HostShellRisk::as_str)});
        let Some(decision) = crate::access_policy::automatic_access_decision(
            authority.policy.access_level.as_str(),
            &prompt,
            true,
        ) else {
            return Ok(None);
        };
        self.validate_authority(&authority, args, now)?;
        let facts = json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":authority.tool_call,"granted":true,"scope":authority.capability,"duration":"once","decidedAt":now,"reason":decision["reason"],"policyRevision":policy_stamp(&authority.policy)});
        Ok(Some(HostPermissionGrant {
            authority,
            facts,
            _permit: permit,
        }))
    }
}
fn policy_stamp(policy: &BotAccessPolicy) -> String {
    format!(
        "bot:{}:{}:{}",
        policy.workspace_id, policy.conversation_id, policy.revision
    )
}
fn read_capability(capability: &str) -> bool {
    matches!(
        capability,
        "local.file.read"
            | "local.file.list"
            | "local.file.search"
            | "local.search.aggregate"
            | "local.image.read"
            | "local.git.query"
    )
}
