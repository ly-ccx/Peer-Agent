//! One tool's permission lifecycle, including discovered local read scopes.
//! It uses the existing live Authority, pending wait and ApprovalStore seams.
use super::read_scope::{ReadScopes, ResolvedReadScope};
use super::*;
use crate::CancellationToken;
use peer_protocol::ExecutionResourceScope;

pub(super) struct ToolAuthorizationRequest<'a> {
    pub identity: HostCallIdentity<'a>,
    pub args: &'a Value,
    pub tool: &'a str,
    pub scopes: &'a [ExecutionResourceScope],
    pub read_path: Result<Option<&'a Path>, HostError>,
    pub workspace: &'a Path,
    pub hooks: Option<&'a peer_store::HookConfig>,
    pub require_confirmation: bool,
}
pub(super) struct ToolAuthorization {
    pub grant: Option<HostPermissionGrant>,
    pub reason: Option<&'static str>,
    pub terminal: Option<HostError>,
    pub failure: Option<HostError>,
    pub reads: Option<ReadScopes>,
    scope: Option<Value>,
}
impl ToolAuthorization {
    pub(super) fn hook_block(reason: &'static str, terminal: Option<HostError>) -> Self {
        Self {
            grant: None,
            reason: Some(reason),
            terminal,
            failure: None,
            reads: None,
            scope: None,
        }
    }

    pub(super) fn denied_facts(&self, call: &str, capability: &str) -> Value {
        denied(
            call,
            self.scope.clone().unwrap_or_else(|| json!(capability)),
            self.reason.unwrap_or("local_permission_denied"),
        )
    }
}
fn denied(call: &str, scope: Value, reason: &str) -> Value {
    json!({"grantId":format!("grant-{}",uuid::Uuid::new_v4()),"toolCallId":call,"granted":false,"scope":scope,"duration":"denied","decidedAt":episode_time(),"reason":reason})
}
impl NativeSessionHost {
    pub(super) async fn authorize_tool(
        &mut self,
        request: ToolAuthorizationRequest<'_>,
        permission: &mut dyn PermissionInput,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<ToolAuthorization, HostError> {
        let mut result = ToolAuthorization {
            grant: None,
            reason: None,
            terminal: None,
            failure: None,
            reads: None,
            scope: None,
        };
        let mut scope = None;
        let mut admitted = false;
        let read_path = match request.read_path {
            Ok(path) => path,
            Err(error) => {
                result.reason = Some(error.0);
                result.failure = Some(error);
                return Ok(result);
            }
        };
        if let Some(path) = read_path {
            if request.identity.permission != ProviderPermission::Read {
                return Err(HostError("read_scope_capability_denied"));
            }
            let observed = self
                .wait_owned(
                    async {
                        let workspace = ResolvedReadScope::observe(
                            request.workspace.into(),
                            request.identity.capability_id.into(),
                            request.workspace.into(),
                        )
                        .await?;
                        let target = ResolvedReadScope::observe(
                            path.into(),
                            request.identity.capability_id.into(),
                            request.workspace.into(),
                        )
                        .await?;
                        Ok::<_, HostError>((workspace, target))
                    },
                    owned,
                    external,
                )
                .await?;
            let (workspace, target) = match observed {
                Ok(v) => v,
                Err(error) => {
                    result.reason = Some(error.0);
                    result.failure = Some(error);
                    return Ok(result);
                }
            };
            admitted = workspace.covers(Path::new(&target.facts.path));
            scope = Some(if admitted { workspace.clone() } else { target });
            result.reads = Some(ReadScopes::new(workspace, request.tool.to_owned()));
        }
        result.scope = scope.as_ref().map(|s| s.value());
        let grant = if request.require_confirmation {
            None
        } else if let Some(scope) = scope.as_ref() {
            self.automatic_read_permission(
                request.identity,
                request.args,
                scope.clone(),
                admitted,
                &episode_time(),
            )?
        } else {
            self.automatic_permission(request.identity, request.args, &episode_time())?
        };
        if let Some(grant) = grant {
            result.grant = Some(grant);
            return Ok(result);
        }
        let pending = if let Some(scope) = scope {
            self.request_read_permission(request.identity, request.args, scope, &episode_time())?
        } else {
            self.request_permission(request.identity, request.args, &episode_time())?
        };
        let prompt = json!({"approval":pending.record(),"tool":request.tool,"arguments":request.args,"scopes":result.scope.as_ref().map(|s|json!([s])).unwrap_or_else(||json!(request.scopes))});
        let wait = async {
            let answer = pending.wait(permission, prompt, owned);
            let source = async {
                let Some(hooks) = request.hooks else {
                    return std::future::pending().await;
                };
                let mut tick = tokio::time::interval(std::time::Duration::from_millis(100));
                loop {
                    tick.tick().await;
                    if hooks.check_current().is_err() {
                        return HostError("native_hook_source_changed");
                    }
                }
            };
            tokio::select! {
                biased;
                error = source => Err(error),
                answer = answer => Ok(answer),
            }
        };
        let answer = self.wait_owned(wait, owned, external).await?;
        let source_error = answer.as_ref().err().copied().or_else(|| {
            request.hooks.and_then(|hooks| {
                hooks
                    .check_current()
                    .err()
                    .map(|_| HostError("native_hook_source_changed"))
            })
        });
        let decision = if source_error.is_some() {
            LocalPermissionDecision::Cancel
        } else {
            answer?
        };
        let settled = self.settle_permission(pending, decision, request.args, &episode_time())?;
        if let Some(error) = source_error {
            return Ok(ToolAuthorization::hook_block(error.0, Some(error)));
        }
        result.grant = settled.grant;
        result.reason = settled.reason;
        result.terminal = settled.terminal;
        Ok(result)
    }
    pub(super) async fn authorize_read_scope(
        &mut self,
        authorization: super::read_scope::ScopeAuthorization<'_>,
        path: std::path::PathBuf,
        owned: &CancellationToken,
        external: &CancellationToken,
    ) -> Result<(), HostError> {
        let super::read_scope::ScopeAuthorization {
            primary,
            args,
            reads,
            input: permission,
        } = authorization;
        reads.check(self, primary, args)?;
        let scope = self
            .wait_owned(
                ResolvedReadScope::observe(
                    path,
                    primary.identity().capability_id.into(),
                    PathBuf::from(&reads.workspace.facts.path),
                ),
                owned,
                external,
            )
            .await??;
        reads.check(self, primary, args)?;
        if reads.covers(primary, Path::new(&scope.facts.path)) {
            return Ok(());
        }
        if reads.grants.len() + reads.decisions.len() >= 128 {
            return Err(HostError("permission_resource_limit"));
        }
        let admitted = reads.workspace.covers(Path::new(&scope.facts.path));
        let scope = if admitted {
            reads.workspace.clone()
        } else {
            scope
        };
        if let Some(grant) = self.automatic_read_permission(
            primary.identity(),
            args,
            scope.clone(),
            admitted,
            &episode_time(),
        )? {
            reads.grants.push(grant);
            return reads.check(self, primary, args);
        }
        let pending =
            self.request_read_permission(primary.identity(), args, scope.clone(), &episode_time())?;
        let prompt = json!({"approval":pending.record(),"tool":reads.tool,"arguments":args,"scopes":[scope.facts]});
        // Box the nested heartbeat wait: this control request belongs to the
        // suspended Provider and cannot recursively poll that same Provider.
        let decision =
            Box::pin(self.wait_owned(pending.wait(permission, prompt, owned), owned, external))
                .await?;
        let resolution = self.settle_permission(pending, decision, args, &episode_time())?;
        if let Some(grant) = resolution.grant {
            reads.grants.push(grant);
            reads.check(self, primary, args)
        } else {
            reads.decisions.push(denied(
                primary.identity().tool_call_id,
                scope.value(),
                resolution.reason.unwrap_or("local_permission_denied"),
            ));
            reads.terminal = resolution.terminal;
            Err(resolution
                .terminal
                .unwrap_or(HostError("git_read_permission_denied")))
        }
    }
}
