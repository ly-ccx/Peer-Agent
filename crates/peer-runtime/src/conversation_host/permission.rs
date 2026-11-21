//! Ordinary live authority. A persisted decision is audit, never a reusable grant.
use super::goal_intake::GoalIntake;
use super::*;
use crate::{
    capability::{ProviderPermission, ShellRisk},
    read_scope::ResolvedReadScope,
};
use peer_store::{ApprovalDecision, ApprovalState, ApprovalStore, HostApproval};
#[derive(Clone, Copy)]
pub(super) struct PermissionCall<'a> {
    pub call: &'a str,
    pub capability: &'a str,
    pub tool: &'a str,
    pub args: &'a Value,
}
#[derive(Clone)]
pub(super) struct ToolGrant {
    pub facts: Value,
    pub additional: Vec<Value>,
    pub terminal: Option<HostError>,
    pub capability: String,
    pub call: String,
    pub digest: String,
    pub revision: u64,
    pub scopes: Vec<ResolvedReadScope>,
    pub credential_revision: String,
    readonly_worker_id: Option<String>,
    goal_intake: GoalIntake,
    pub goal_denial: Option<&'static str>,
    pub prompted: bool,
}
struct DecisionContext<'a> {
    risk_level: &'a str,
    reason: &'a str,
    session_key: Option<String>,
}

fn risk_label(permission: ProviderPermission, risk: Option<ShellRisk>) -> &'static str {
    match permission {
        ProviderPermission::Read => "L1_local_read",
        ProviderPermission::FileWrite => "L2_local_write",
        ProviderPermission::Shell | ProviderPermission::External => {
            risk.map_or("L3_external_write", ShellRisk::as_str)
        }
        ProviderPermission::Mcp => "L3_external_write",
        _ => "runtime_governed",
    }
}

fn approval_duration(granted: bool, reason: &str) -> &'static str {
    if !granted {
        "denied"
    } else if reason == "approved_for_tui_session" {
        "session"
    } else {
        "once"
    }
}

fn automatic(
    level: LocalAccessLevel,
    permission: ProviderPermission,
    risk: Option<ShellRisk>,
    inside: Option<bool>,
) -> bool {
    if level == LocalAccessLevel::FullLocal
        || matches!(
            permission,
            ProviderPermission::ConversationGoal | ProviderPermission::ShellStop
        )
    {
        return true;
    }
    if permission == ProviderPermission::Read {
        return inside != Some(false);
    }
    if permission == ProviderPermission::External {
        if level == LocalAccessLevel::AskBeforeLocal {
            return matches!(risk, Some(ShellRisk::Inert));
        }
        return level == LocalAccessLevel::SessionLocal
            && matches!(
                risk,
                Some(
                    ShellRisk::Inert
                        | ShellRisk::LocalRead
                        | ShellRisk::LocalWrite
                        | ShellRisk::ExternalWrite
                )
            );
    }
    level == LocalAccessLevel::SessionLocal
        && (permission == ProviderPermission::FileWrite
            || permission == ProviderPermission::Shell
                && matches!(
                    risk,
                    Some(
                        ShellRisk::Inert
                            | ShellRisk::LocalRead
                            | ShellRisk::LocalWrite
                            | ShellRisk::ExternalWrite
                    )
                ))
}

fn evaluate_automation_policy(
    policy: &AutomationPermissionPolicy,
    capability: &str,
    permission: ProviderPermission,
    risk: Option<ShellRisk>,
) -> Option<(bool, &'static str)> {
    if matches!(
        permission,
        ProviderPermission::UserInput
            | ProviderPermission::ConversationGoal
            | ProviderPermission::ShellStop
    ) {
        return None;
    }
    if permission == ProviderPermission::Shell
        && matches!(risk, Some(ShellRisk::Privileged | ShellRisk::Destructive))
    {
        return Some((false, "automation_high_risk_blocked"));
    }
    if policy
        .blocked_capability_ids
        .iter()
        .any(|id| id == capability)
    {
        return Some((false, "automation_capability_blocked"));
    }
    if policy
        .allowed_capability_ids
        .iter()
        .any(|id| id == capability)
    {
        return Some((true, "automation_grant_allowed"));
    }
    if policy.preset == "observe" {
        return Some((false, "automation_observe_read_only"));
    }
    Some((false, "automation_capability_not_granted"))
}
impl Host<'_> {
    fn session_op_key(
        &self,
        revision: u64,
        capability: &str,
        args: &Value,
    ) -> Result<String, HostError> {
        let key = peer_protocol::permission_operation_key(peer_protocol::PermissionOperation {
            capability_id: capability,
            args,
            conversation_id: Some(&self.identity.conversation_id),
            workspace_path: self.workspace.to_str(),
            session_id: Some(&self.identity.conversation_id),
            plan_id: None,
        })
        .map_err(|_| HostError("permission_arguments_invalid"))?;
        Ok(format!("op:{revision}:{key}"))
    }
    fn session_read_key(&self, revision: u64, capability: &str, canonical_path: &str) -> String {
        format!(
            "read:{revision}:{}:{capability}:{canonical_path}",
            self.identity.conversation_id
        )
    }
    pub(super) fn validate_grant(&self, grant: &ToolGrant, args: &Value) -> Result<(), HostError> {
        self.source_current()?;
        self.validate_grant_binding(grant, args)
    }
    pub(super) fn validate_grant_binding(
        &self,
        grant: &ToolGrant,
        args: &Value,
    ) -> Result<(), HostError> {
        let projection = match &grant.readonly_worker_id {
            None => &self.projection,
            Some(id) => {
                &self
                    .worker
                    .as_ref()
                    .filter(|worker| worker.lease.id() == id)
                    .ok_or(HostError("permission_policy_changed"))?
                    .projection
            }
        };
        if grant.facts["granted"] != true
            || self.access.snapshot()?.1 != grant.revision
            || peer_protocol::approval_args_digest(args)
                .map_err(|_| HostError("permission_arguments_invalid"))?
                != grant.digest
            || !projection.has_capability(&grant.capability)
            || self
                .credentials
                .normalized_conversation(&self.identity)
                .map_err(HostError)?
                .as_deref()
                != Some(grant.credential_revision.as_str())
        {
            return Err(HostError("permission_policy_changed"));
        }
        for scope in &grant.scopes {
            scope.validate()?;
        }
        if let Some(reason) = grant.goal_intake.denial(&self.home) {
            return Err(HostError(reason));
        }
        Ok(())
    }
    pub(super) async fn authorize(
        &mut self,
        operation: PermissionCall<'_>,
        permission: ProviderPermission,
        risk: Option<ShellRisk>,
        read_path: Option<PathBuf>,
        hook: (crate::hook_policy::HookDecision, Option<HostError>),
        goal_intake: GoalIntake,
    ) -> Result<ToolGrant, HostError> {
        use crate::hook_policy::HookDecision;
        let PermissionCall {
            call,
            capability,
            args,
            ..
        } = operation;
        let (hook, hook_interrupted) = hook;
        if hook_interrupted.is_none() {
            self.source_current()?;
        }
        let digest = peer_protocol::approval_args_digest(args)
            .map_err(|_| HostError("permission_arguments_invalid"))?;
        let (level, revision) = self.access.snapshot()?;
        let (scope, inside) = if let Some(path) = read_path {
            let workspace = self.workspace.clone();
            let capability = capability.to_owned();
            let observed = self
                .wait_owned(async {
                    let root = ResolvedReadScope::observe(
                        workspace.clone(),
                        capability.clone(),
                        workspace.clone(),
                    )
                    .await?;
                    let target = ResolvedReadScope::observe(path, capability, workspace).await?;
                    let inside = root.covers(Path::new(&target.facts.path));
                    Ok::<_, HostError>((if inside { root } else { target }, inside))
                })
                .await??;
            (Some(observed.0), Some(observed.1))
        } else {
            (None, None)
        };
        let scope_value = scope
            .as_ref()
            .map(|s| s.value())
            .unwrap_or_else(|| json!(capability));
        let permitted = automatic(level, permission, risk, inside);
        let mut goal_denial = goal_intake.denial(&self.home);
        let (mut granted, mut reason, terminal, prompted) = if self.worker.is_some()
            && (permission != ProviderPermission::Read || inside == Some(false))
        {
            (false, "explorer_scope_denied", None, false)
        } else if permission == ProviderPermission::UserInput {
            if self.interactive_user_input {
                (
                    true,
                    crate::providers::interaction::SELF_GRANT_REASON,
                    None,
                    false,
                )
            } else {
                (
                    false,
                    crate::providers::interaction::UNAVAILABLE,
                    None,
                    false,
                )
            }
        } else if let Some(interruption) = hook_interrupted {
            (false, "hook_interrupted", Some(interruption), false)
        } else if let Some(reason) = goal_denial {
            (false, reason, None, false)
        } else if hook == HookDecision::Deny {
            (false, "hook_denied", None, false)
        } else if let Some((allowed, auto_reason)) = self
            .automation_policy
            .as_ref()
            .and_then(|policy| evaluate_automation_policy(policy, capability, permission, risk))
        {
            if !allowed {
                (false, auto_reason, None, false)
            } else if hook == HookDecision::Allow {
                (true, auto_reason, None, false)
            } else {
                (false, "hook_denied", None, false)
            }
        } else if permitted && hook == HookDecision::Allow {
            (
                true,
                if permission == ProviderPermission::ShellStop {
                    "shell_task_stop_same_scope"
                } else if permission == ProviderPermission::ConversationGoal {
                    "host_policy_conversation_goal"
                } else if level == LocalAccessLevel::FullLocal {
                    "local_access_level_full"
                } else if permission == ProviderPermission::Read {
                    "host_policy_read"
                } else {
                    "local_access_level_session"
                },
                None,
                false,
            )
        } else {
            let session_key = (self.worker.is_none() && hook == HookDecision::Allow)
                .then(|| self.session_op_key(revision, capability, args))
                .transpose()?;
            if let Some(key) = session_key.as_deref()
                && self.access.has_session_approval(revision, key)?
            {
                (true, "approved_for_tui_session", None, false)
            } else {
                let reason_hint = if hook == HookDecision::Ask {
                    "Hook policy requires approval before local execution."
                } else if permission == ProviderPermission::Read && inside == Some(false) {
                    "Outside workspace file read requires approval."
                } else {
                    "This action needs your approval before local execution."
                };
                let decided = self
                    .decide(
                        operation,
                        &digest,
                        &scope_value,
                        revision,
                        DecisionContext {
                            risk_level: risk_label(permission, risk),
                            reason: reason_hint,
                            session_key,
                        },
                    )
                    .await?;
                (decided.0, decided.1, decided.2, true)
            }
        };
        if granted && let Some(changed) = goal_intake.denial(&self.home) {
            goal_denial = Some(changed);
            reason = changed;
            granted = false;
        }
        let credential_revision = if granted {
            self.credentials
                .normalized_conversation(&self.identity)
                .map_err(HostError)?
                .ok_or(HostError("execution_identity_invalid"))?
        } else {
            String::new()
        };
        let duration = approval_duration(granted, reason);
        let mut grant = ToolGrant {
            facts: json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":call,"granted":granted,"scope":scope_value,"duration":duration,"decidedAt":now(),"reason":reason,"metadata":{"policyRevision":format!("ordinary:{}:{revision}",self.identity.stream_id)}}),
            additional: vec![],
            terminal,
            capability: capability.into(),
            call: call.into(),
            digest,
            revision,
            scopes: scope.into_iter().collect(),
            credential_revision,
            readonly_worker_id: self
                .worker
                .as_ref()
                .map(|worker| worker.lease.id().to_owned()),
            goal_intake,
            goal_denial,
            prompted,
        };
        if let Some(worker) = &self.worker {
            grant.facts["metadata"]["readonlyWorkerId"] = json!(worker.lease.id());
        }
        if granted {
            self.validate_grant(&grant, args)?;
        }
        Ok(grant)
    }
    async fn decide(
        &mut self,
        operation: PermissionCall<'_>,
        digest: &str,
        scope: &Value,
        revision: u64,
        ctx: DecisionContext<'_>,
    ) -> Result<(bool, &'static str, Option<HostError>), HostError> {
        let PermissionCall {
            call,
            capability,
            args,
            tool,
        } = operation;
        self.source_current()?;
        let store = ApprovalStore::new(&self.home);
        let id = format!("approval-{call}-{}", uuid::Uuid::new_v4());
        let at = now();
        let deadline = (time::OffsetDateTime::now_utc() + time::Duration::minutes(5))
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| HostError("invalid_host_time"))?;
        let policy = format!("ordinary:{}:{revision}", self.identity.stream_id);
        let row = store.open(
            &HostApproval {
                approval_id: &id,
                workspace_id: None,
                conversation_id: &self.identity.conversation_id,
                stream_id: &self.identity.stream_id,
                plan_id: None,
                session_id: None,
                capability_id: capability,
                args_digest: digest,
                policy_revision: &policy,
                created_at: &at,
                deadline_at: Some(&deadline),
            },
            None,
        )?;
        let input = self
            .permission
            .take()
            .ok_or(HostError("permission_unavailable"))?;
        let access = self.access.clone();
        let owned = self.owned.clone();
        let prompt = json!({
            "approval": row,
            "toolCallId": call,
            "tool": tool,
            "capabilityId": capability,
            "workspacePath": self.workspace.to_string_lossy(),
            "reason": ctx.reason,
            "riskLevel": ctx.risk_level,
            "arguments": args,
            "scopes": [scope],
        });
        let result=self.wait_owned(async {
            let decision=input.decide(prompt,&owned);tokio::pin!(decision);
            let expiry=tokio::time::sleep(Duration::from_secs(300));tokio::pin!(expiry);
            let mut tick=tokio::time::interval(Duration::from_millis(100));
            loop {tokio::select!{biased;
                _=owned.cancelled()=>return (LocalPermissionDecision::Cancel,false),
                _=&mut expiry=>return (LocalPermissionDecision::Timeout,false),
                _=tick.tick()=>if access.snapshot().is_err()||access.snapshot().is_ok_and(|s|s.1!=revision){return (LocalPermissionDecision::Cancel,true);},
                result=&mut decision=>return (result,false),
            }}
        }).await;
        self.permission = Some(input);
        let (mut decision, changed) = match result {
            Ok(decision) => decision,
            Err(error) => (LocalPermissionDecision::Cancel, error.0 != "CANCELLED"),
        };
        let current = self.source_current();
        let cancelled = current == Err(HostError("CANCELLED"));
        if cancelled {
            decision = LocalPermissionDecision::Cancel;
        }
        let policy_changed =
            !cancelled && (changed || self.access.snapshot()?.1 != revision || current.is_err());
        let permitted = matches!(
            decision,
            LocalPermissionDecision::Approve | LocalPermissionDecision::ApproveSession
        ) && !policy_changed;
        let state = if permitted {
            ApprovalState::Approved
        } else if policy_changed {
            ApprovalState::Stale
        } else {
            match decision {
                LocalPermissionDecision::Timeout => ApprovalState::Expired,
                LocalPermissionDecision::Cancel => ApprovalState::Cancelled,
                _ => ApprovalState::Denied,
            }
        };
        let decision_reason = if policy_changed {
            Some("permission_policy_changed")
        } else {
            match decision {
                LocalPermissionDecision::Approve | LocalPermissionDecision::ApproveSession => None,
                LocalPermissionDecision::Deny => Some("local_user_denied"),
                LocalPermissionDecision::Unavailable => Some("permission_unavailable"),
                LocalPermissionDecision::Cancel => Some("permission_cancelled"),
                LocalPermissionDecision::Timeout => Some("permission_timeout"),
            }
        };
        store.decide(
            &row,
            state,
            if policy_changed
                || decision == LocalPermissionDecision::Timeout
                || decision == LocalPermissionDecision::Unavailable
                || decision == LocalPermissionDecision::Cancel
            {
                ApprovalDecision::Policy
            } else {
                ApprovalDecision::LocalUser
            },
            &now(),
            decision_reason,
            None,
        )?;
        if policy_changed {
            return Ok((
                false,
                "permission_policy_changed",
                Some(
                    current
                        .err()
                        .unwrap_or(HostError("permission_policy_changed")),
                ),
            ));
        }
        Ok(match decision {
            LocalPermissionDecision::Approve => (true, "approved_once_in_tui", None),
            LocalPermissionDecision::ApproveSession => {
                if let Some(key) = ctx.session_key
                    && self.access.remember_session_approval(revision, key)?
                {
                    (true, "approved_for_tui_session", None)
                } else {
                    (true, "approved_once_in_tui", None)
                }
            }
            LocalPermissionDecision::Deny => (false, "denied_in_tui", None),
            LocalPermissionDecision::Unavailable => (false, "tui_approval_unavailable", None),
            LocalPermissionDecision::Cancel => {
                (false, "permission_cancelled", Some(HostError("CANCELLED")))
            }
            LocalPermissionDecision::Timeout => (
                false,
                "permission_wait_expired",
                Some(HostError("waiting_user")),
            ),
        })
    }
    pub(super) async fn authorize_read(
        &mut self,
        grant: &mut ToolGrant,
        args: &Value,
        path: PathBuf,
    ) -> Result<(), HostError> {
        self.validate_grant(grant, args)?;
        let capability = grant.capability.clone();
        let workspace = self.workspace.clone();
        let target = self
            .wait_owned(ResolvedReadScope::observe(path, capability, workspace))
            .await??;
        if grant
            .scopes
            .iter()
            .any(|s| s.covers(Path::new(&target.facts.path)))
        {
            return Ok(());
        }
        if grant.scopes.len() + grant.additional.len() >= 128 {
            return Err(HostError("permission_resource_limit"));
        }
        let root = ResolvedReadScope::observe(
            self.workspace.clone(),
            grant.capability.clone(),
            self.workspace.clone(),
        )
        .await?;
        let inside = root.covers(Path::new(&target.facts.path));
        let scope = if inside { root } else { target };
        let level = self.access.snapshot()?.0;
        let (granted, reason, terminal) = if self.worker.is_some() && !inside {
            (false, "explorer_scope_denied", None)
        } else if !inside
            && let Some((allowed, auto_reason)) = self.automation_policy.as_ref().and_then(|p| {
                evaluate_automation_policy(p, &grant.capability, ProviderPermission::Read, None)
            })
        {
            (allowed, auto_reason, None)
        } else if level == LocalAccessLevel::FullLocal || inside {
            (true, "host_policy_read", None)
        } else {
            let read_key = self.worker.is_none().then(|| {
                self.session_read_key(grant.revision, &grant.capability, &scope.facts.path)
            });
            if let Some(key) = read_key.as_deref()
                && self.access.has_session_approval(grant.revision, key)?
            {
                (true, "approved_for_tui_session", None)
            } else {
                self.decide(
                    PermissionCall {
                        call: &grant.call,
                        capability: &grant.capability,
                        tool: "git_query",
                        args,
                    },
                    &scope.approval_digest(&grant.digest)?,
                    &scope.value(),
                    grant.revision,
                    DecisionContext {
                        risk_level: "L1_local_read",
                        reason: "Outside workspace file read requires approval.",
                        session_key: read_key,
                    },
                )
                .await?
            }
        };
        let duration = approval_duration(granted, reason);
        grant.additional.push(json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":grant.call,"granted":granted,"scope":scope.value(),"duration":duration,"decidedAt":now(),"reason":reason}));
        grant.terminal = terminal;
        if !granted {
            return Err(terminal.unwrap_or(HostError("git_read_permission_denied")));
        }
        grant.scopes.push(scope);
        self.validate_grant(grant, args)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evaluate_automation_policy_enforces_grants_and_blocks_high_risk() {
        let observe = AutomationPermissionPolicy {
            preset: "observe".into(),
            allowed_capability_ids: vec!["local.file.read".into()],
            blocked_capability_ids: vec!["local.file.write".into()],
        };
        assert_eq!(
            evaluate_automation_policy(
                &observe,
                "local.shell.exec",
                ProviderPermission::Shell,
                Some(ShellRisk::Privileged),
            ),
            Some((false, "automation_high_risk_blocked"))
        );
        assert_eq!(
            evaluate_automation_policy(
                &observe,
                "local.shell.exec",
                ProviderPermission::Shell,
                Some(ShellRisk::Destructive),
            ),
            Some((false, "automation_high_risk_blocked"))
        );
        assert_eq!(
            evaluate_automation_policy(
                &observe,
                "local.file.write",
                ProviderPermission::FileWrite,
                None,
            ),
            Some((false, "automation_capability_blocked"))
        );
        assert_eq!(
            evaluate_automation_policy(&observe, "local.file.read", ProviderPermission::Read, None),
            Some((true, "automation_grant_allowed"))
        );
        assert_eq!(
            evaluate_automation_policy(&observe, "local.git.query", ProviderPermission::Read, None,),
            Some((false, "automation_observe_read_only"))
        );
        assert_eq!(
            evaluate_automation_policy(
                &observe,
                "local.goal.create_plan",
                ProviderPermission::ConversationGoal,
                None,
            ),
            None
        );

        let workspace_policy = AutomationPermissionPolicy {
            preset: "work_in_workspace".into(),
            allowed_capability_ids: vec!["local.file.write".into()],
            blocked_capability_ids: vec![],
        };
        assert_eq!(
            evaluate_automation_policy(
                &workspace_policy,
                "local.file.write",
                ProviderPermission::FileWrite,
                None,
            ),
            Some((true, "automation_grant_allowed"))
        );
        assert_eq!(
            evaluate_automation_policy(
                &workspace_policy,
                "local.shell.exec",
                ProviderPermission::Shell,
                Some(ShellRisk::LocalRead),
            ),
            Some((false, "automation_capability_not_granted"))
        );
    }
}
