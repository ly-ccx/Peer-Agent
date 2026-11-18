//! Ordinary live authority. A persisted decision is audit, never a reusable grant.
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
}
fn automatic(
    level: LocalAccessLevel,
    permission: ProviderPermission,
    risk: Option<ShellRisk>,
    inside: Option<bool>,
) -> bool {
    if level == LocalAccessLevel::FullLocal {
        return true;
    }
    if permission == ProviderPermission::Read {
        return inside != Some(false);
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
impl Host<'_> {
    pub(super) fn validate_grant(&self, grant: &ToolGrant, args: &Value) -> Result<(), HostError> {
        self.source_current()?;
        if grant.facts["granted"] != true
            || self.access.snapshot()?.1 != grant.revision
            || peer_protocol::approval_args_digest(args)
                .map_err(|_| HostError("permission_arguments_invalid"))?
                != grant.digest
            || !self.projection.has_capability(&grant.capability)
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
        Ok(())
    }
    pub(super) async fn authorize(
        &mut self,
        operation: PermissionCall<'_>,
        permission: ProviderPermission,
        risk: Option<ShellRisk>,
        read_path: Option<PathBuf>,
    ) -> Result<ToolGrant, HostError> {
        let PermissionCall {
            call,
            capability,
            args,
            ..
        } = operation;
        self.source_current()?;
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
        let (granted, reason, terminal) = if permitted {
            (
                true,
                if level == LocalAccessLevel::FullLocal {
                    "local_access_level_full"
                } else if permission == ProviderPermission::Read {
                    "host_policy_read"
                } else {
                    "local_access_level_session"
                },
                None,
            )
        } else {
            self.decide(operation, &digest, &scope_value, revision)
                .await?
        };
        let credential_revision = self
            .credentials
            .normalized_conversation(&self.identity)
            .map_err(HostError)?
            .ok_or(HostError("execution_identity_invalid"))?;
        let grant = ToolGrant {
            facts: json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":call,"granted":granted,"scope":scope_value,"duration":if granted{"once"}else{"denied"},"decidedAt":now(),"reason":reason,"metadata":{"policyRevision":format!("ordinary:{}:{revision}",self.identity.stream_id)}}),
            additional: vec![],
            terminal,
            capability: capability.into(),
            call: call.into(),
            digest,
            revision,
            scopes: scope.into_iter().collect(),
            credential_revision,
        };
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
        let prompt =
            json!({"approval":row,"toolCallId":call,"tool":tool,"arguments":args,"scopes":[scope]});
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
        let permitted = decision == LocalPermissionDecision::Approve && !policy_changed;
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
                LocalPermissionDecision::Approve => None,
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
        let (granted, reason, terminal) = if level == LocalAccessLevel::FullLocal || inside {
            (true, "host_policy_read", None)
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
            )
            .await?
        };
        grant.additional.push(json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":grant.call,"granted":granted,"scope":scope.value(),"duration":if granted{"once"}else{"denied"},"decidedAt":now(),"reason":reason}));
        grant.terminal = terminal;
        if !granted {
            return Err(terminal.unwrap_or(HostError("git_read_permission_denied")));
        }
        grant.scopes.push(scope);
        self.validate_grant(grant, args)
    }
}
