//! Structured fixed Git commands under the same Host projection/grants and
//! canonical child ownership as every other locally executed capability.
use super::*;
use crate::git_read::{AuthorityFuture, GitRead, GitReadAuthority, GitReadError};
use std::sync::{Arc, OnceLock};
use tokio::sync::Semaphore;
mod presentation;
static MEMORY: OnceLock<Arc<Semaphore>> = OnceLock::new();
pub(super) struct GitProvider;
struct ReadGit {
    args: Value,
    path: Result<PathBuf, HostError>,
    home: PathBuf,
    handle: String,
    port: Option<EffectAdmission>,
}
struct Authority {
    port: EffectAdmission,
    cancel: CancellationToken,
}
fn error(e: HostError) -> GitReadError {
    GitReadError {
        code: e.0,
        ended: true,
    }
}
impl GitReadAuthority for Authority {
    fn check(&self) -> AuthorityFuture<'_> {
        Box::pin(async {
            if self.cancel.is_cancelled() {
                return Err(error(HostError("CANCELLED")));
            }
            self.port.check().await.map_err(error)
        })
    }
    fn authorize<'a>(&'a self, path: &'a Path) -> AuthorityFuture<'a> {
        Box::pin(async move { self.port.read_scope(path.into()).await.map_err(error) })
    }
    fn starting(&self) -> AuthorityFuture<'_> {
        Box::pin(async { self.port.command_starting().await.map_err(error) })
    }
    fn spawned(&self, pid: u32) -> AuthorityFuture<'_> {
        Box::pin(async move { self.port.command_started(pid).await.map_err(error) })
    }
}
impl CapabilityProvider for GitProvider {
    fn manifests(&self) -> Vec<(String, Value)> {
        let c: Value = serde_json::from_str(include_str!(
            "../../../../packages/protocol/contracts/native-cli/git-query.json"
        ))
        .expect("compiled Git manifest");
        vec![("git_query".into(), c["manifest"].clone())]
    }
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        if capability != "local.git.query" {
            return Err(HostError("tool_not_projected"));
        }
        let path = crate::git_read::input(&args)
            .map(|i| {
                if i.path.is_absolute() {
                    i.path
                } else {
                    workspace.join(i.path)
                }
            })
            .map_err(|e| HostError(e.code));
        Ok(Box::new(ReadGit {
            args,
            path,
            home: home.into(),
            handle: format!("native-git-{}", uuid::Uuid::new_v4()),
            port: None,
        }))
    }
}
impl PreparedEffect for ReadGit {
    fn args(&self) -> &Value {
        &self.args
    }
    fn permission(&self) -> ProviderPermission {
        ProviderPermission::Read
    }
    fn read_scope(&self) -> Result<Option<&Path>, HostError> {
        self.path
            .as_ref()
            .map(|p| Some(p.as_path()))
            .map_err(|e| *e)
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError> {
        Ok(vec![])
    }
    fn handle(&self) -> Option<&str> {
        Some(&self.handle)
    }
    fn owned_command(&self) -> bool {
        true
    }
    fn admission(&mut self, port: EffectAdmission) {
        self.port = Some(port)
    }
    fn evidence(&self) -> Option<Value> {
        Some(json!({"operation":"git_query","evidenceKind":"local_git_observation"}))
    }
    fn start(
        mut self: Box<Self>,
        host: &mut NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError> {
        host.validate_permission(grant, &self.args, now)?;
        let path = self.path.as_ref().map_err(|e| *e)?.clone();
        let port = self
            .port
            .take()
            .ok_or(HostError("execution_admission_closed"))?;
        let conversation = grant.conversation_id().to_owned();
        let limit = crate::git_read::input(&self.args)
            .map_err(|e| HostError(e.code))?
            .limit;
        Ok(Box::pin(async move {
            let pool = MEMORY.get_or_init(|| Arc::new(Semaphore::new(1))).clone();
            let permit = tokio::select! {biased;_=cancel.cancelled()=>return EffectOutcome::not_dispatched("CANCELLED"),p=pool.acquire_owned()=>match p{Ok(p)=>p,Err(_)=>return EffectOutcome::not_dispatched("git_query_unavailable")}};
            let authority = Authority {
                port: port.clone(),
                cancel: cancel.clone(),
            };
            let mut input = self.args.clone();
            input["path"] = json!(path);
            let observation = match GitRead::default()
                .observe(&input, &authority, &cancel)
                .await
            {
                Ok(v) => v,
                Err(e) => {
                    let mut outcome = EffectOutcome::failed(if e.ended {
                        e.code
                    } else {
                        "execution_outcome_unknown"
                    });
                    outcome.ended = e.ended;
                    outcome.output = json!({"reason":e.code});
                    if e.ended {
                        if matches!(e.code, "CANCELLED" | "git_query_cancelled") {
                            outcome.status = "cancelled"
                        } else if matches!(
                            e.code,
                            "git_read_permission_denied"
                                | "permission_policy_changed"
                                | "permission_authority_changed"
                                | "read_scope_changed"
                        ) {
                            outcome.status = "denied"
                        }
                    }
                    return outcome;
                }
            };
            let guard = port.blocking_guard();
            let task = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                presentation::save(&self.home, &conversation, observation, limit, &guard)
            });
            task.await
                .unwrap_or_else(|_| EffectOutcome::failed("execution_outcome_unknown"))
        }))
    }
}
