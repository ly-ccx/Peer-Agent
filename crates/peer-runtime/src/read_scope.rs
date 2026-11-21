//! Concrete local read scopes, shared by actual native Hosts.
use crate::capability::CapabilityError as HostError;
use peer_protocol::{LocalReadPermissionScope, LocalReadScopeKind};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
#[derive(Clone)]
pub(crate) struct ResolvedReadScope {
    pub(crate) facts: LocalReadPermissionScope,
    directory: bool,
}
impl ResolvedReadScope {
    pub(crate) async fn observe(
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
    pub(crate) fn validate(&self) -> Result<(), HostError> {
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
    pub(crate) fn covers(&self, path: &Path) -> bool {
        let root = Path::new(&self.facts.path);
        path == root || self.directory && path.starts_with(root)
    }
    pub(crate) fn value(&self) -> Value {
        serde_json::to_value(&self.facts).expect("read scope facts")
    }
    pub(crate) fn approval_digest(&self, original: &str) -> Result<String, HostError> {
        peer_protocol::approval_args_digest(
            &json!({"originalArgsDigest":original,"readScope":self.facts}),
        )
        .map_err(|_| HostError("permission_arguments_invalid"))
    }
}
