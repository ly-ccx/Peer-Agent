//! Concrete read scope ownership for one immutable tool call. Facts in this
//! module are issued by the Host; Provider output cannot append a grant.
use super::*;
use peer_protocol::{LocalReadPermissionScope, LocalReadScopeKind};
use std::path::{Path, PathBuf};

#[derive(Clone)]
pub(super) struct ResolvedReadScope {
    pub(super) facts: LocalReadPermissionScope,
    directory: bool,
}
impl ResolvedReadScope {
    pub(super) async fn observe(
        path: PathBuf,
        capability: String,
        workspace: PathBuf,
    ) -> Result<Self, HostError> {
        if !path.is_absolute() || path.as_os_str().len() > 8192 {
            return Err(HostError("read_scope_invalid"));
        }
        tokio::task::spawn_blocking(move || {
            let path = std::fs::canonicalize(path).map_err(|_| HostError("git_path_not_found"))?;
            let meta = std::fs::metadata(&path).map_err(|_| HostError("git_path_not_found"))?;
            if !meta.is_dir() && !meta.is_file() {
                return Err(HostError("read_scope_invalid"));
            }
            let path = path
                .to_str()
                .filter(|s| s.len() <= 8192)
                .ok_or(HostError("read_scope_invalid"))?
                .to_owned();
            let workspace =
                std::fs::canonicalize(workspace).map_err(|_| HostError("read_scope_invalid"))?;
            if !std::fs::metadata(&workspace).is_ok_and(|m| m.is_dir()) {
                return Err(HostError("read_scope_invalid"));
            }
            let workspace = workspace
                .to_str()
                .filter(|s| s.len() <= 8192)
                .ok_or(HostError("read_scope_invalid"))?
                .to_owned();
            Ok(Self {
                facts: LocalReadPermissionScope {
                    kind: LocalReadScopeKind::FileRead,
                    capability_id: capability,
                    path,
                    workspace_path: Some(workspace),
                },
                directory: meta.is_dir(),
            })
        })
        .await
        .map_err(|_| HostError("read_scope_unavailable"))?
    }
    pub(super) fn validate(&self) -> Result<(), HostError> {
        let path = Path::new(&self.facts.path);
        let current = std::fs::canonicalize(path).map_err(|_| HostError("read_scope_changed"))?;
        let meta = std::fs::metadata(&current).map_err(|_| HostError("read_scope_changed"))?;
        if current != path
            || meta.is_dir() != self.directory
            || (!self.directory && !meta.is_file())
        {
            return Err(HostError("read_scope_changed"));
        }
        Ok(())
    }
    pub(super) fn covers(&self, path: &Path) -> bool {
        let root = Path::new(&self.facts.path);
        path == root || self.directory && path.starts_with(root)
    }
    pub(super) fn value(&self) -> Value {
        serde_json::to_value(&self.facts).expect("read scope facts")
    }
    pub(super) fn approval_digest(&self, original: &str) -> Result<String, HostError> {
        peer_protocol::approval_args_digest(
            &json!({"originalArgsDigest":original,"readScope":self.facts}),
        )
        .map_err(|_| HostError("permission_arguments_invalid"))
    }
}

pub(super) struct ReadScopes {
    /// Canonical root derived from the current Host/Goal, never tool arguments.
    pub(super) workspace: ResolvedReadScope,
    pub(super) tool: String,
    pub(super) grants: Vec<HostPermissionGrant>,
    pub(super) decisions: Vec<Value>,
    pub(super) terminal: Option<HostError>,
}
pub(super) struct ScopeAuthorization<'a> {
    pub primary: &'a HostPermissionGrant,
    pub args: &'a Value,
    pub reads: &'a mut ReadScopes,
    pub input: &'a mut dyn PermissionInput,
}
impl ReadScopes {
    pub(super) fn new(workspace: ResolvedReadScope, tool: String) -> Self {
        Self {
            workspace,
            tool,
            grants: Vec::new(),
            decisions: Vec::new(),
            terminal: None,
        }
    }
    pub(super) fn check(
        &self,
        host: &NativeSessionHost,
        primary: &HostPermissionGrant,
        args: &Value,
    ) -> Result<(), HostError> {
        host.validate_permission(primary, args, &episode_time())?;
        for grant in &self.grants {
            // The primary fresh check covers the same current operation. A
            // supplemental grant must also have exactly that immutable owner,
            // source/policy revision and args, plus its own concrete path.
            if !grant.same_authority(primary) {
                return Err(HostError("permission_authority_changed"));
            }
            grant.validate_read_scope()?;
        }
        Ok(())
    }
    pub(super) fn covers(&self, primary: &HostPermissionGrant, path: &Path) -> bool {
        primary.covers_read_scope(path) || self.grants.iter().any(|g| g.covers_read_scope(path))
    }
}
impl NativeSessionHost {
    /// Read anchoring is separate from the write-directory claim. Only current
    /// canonical Goal and conversation sources participate in this choice.
    pub(super) fn read_workspace(&self, plan: &str, at: &str) -> Result<PathBuf, HostError> {
        let current = self.current(plan, at)?;
        if let Some(directory) = current.resource.directory {
            return Ok(directory);
        }
        let raw = self
            .goals
            .read_context(plan, &current.goal.source_revision)?;
        let conversation = current.goal.facts["conversationId"]
            .as_str()
            .ok_or(HostError("out_of_scope"))?;
        let metadata =
            peer_store::ConversationStore::new(&self.home).read_metadata(conversation)?;
        let meta = metadata
            .metadata
            .as_ref()
            .ok_or(HostError("out_of_scope"))?;
        let binding = &raw["deliveryBinding"];
        let isolated = (binding["executionIsolation"] == "worktree")
            .then(|| binding["worktreePath"].as_str())
            .flatten();
        let selected = [
            isolated,
            raw["targetWorkspacePath"].as_str(),
            meta["workspacePath"].as_str(),
            raw["originWorkspacePath"].as_str(),
        ]
        .into_iter()
        .flatten()
        .find(|p| !peer_protocol::javascript_trim(p).is_empty())
        .filter(|p| p.len() <= 8192)
        .ok_or(HostError("execution_resource_scope_unknown"))?;
        let path = PathBuf::from(selected);
        if !path.is_absolute() {
            return Err(HostError("execution_resource_scope_unknown"));
        }
        if self.goals.revision(plan)? != current.goal.source_revision {
            return Err(HostError("permission_authority_changed"));
        }
        Ok(path)
    }
    pub(super) fn validate_scope_workspace(
        &self,
        scope: &ResolvedReadScope,
        plan: &str,
        at: &str,
    ) -> Result<(), HostError> {
        let workspace = std::fs::canonicalize(self.read_workspace(plan, at)?)
            .map_err(|_| HostError("read_scope_changed"))?;
        if workspace.to_str() != scope.facts.workspace_path.as_deref() {
            return Err(HostError("read_scope_changed"));
        }
        Ok(())
    }
}
