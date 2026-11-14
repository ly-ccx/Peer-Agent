//! Capability Provider -> Manifest -> immutable Runtime Projection -> effect.
//! The model selects an alias in a projection, never a Provider or permission.
use crate::{
    CancellationToken,
    session_host::{
        HostError, HostPermissionGrant, HostShellRisk, NativeSessionHost, ProviderPermission,
    },
};
use peer_protocol::ExecutionResourceScope;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
};
mod file;
mod shell;
mod shell_risk;
pub struct EffectOutcome {
    pub status: &'static str,
    pub output: Value,
    pub error: Option<&'static str>,
    pub artifacts: Vec<String>,
    pub ended: bool,
}
impl EffectOutcome {
    pub fn failed(code: &'static str) -> Self {
        Self {
            status: "failed",
            output: json!({}),
            error: Some(code),
            artifacts: vec![],
            ended: true,
        }
    }
}
pub type EffectFuture = Pin<Box<dyn Future<Output = EffectOutcome> + Send>>;
pub trait PreparedEffect {
    fn args(&self) -> &Value;
    fn permission(&self) -> ProviderPermission;
    fn risk(&self) -> Option<HostShellRisk> {
        None
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError>;
    fn handle(&self) -> Option<&str> {
        None
    }
    /// Start owns the effect. It must revalidate the immutable grant directly
    /// before open/rename/spawn and return an owned completion future.
    fn start(
        self: Box<Self>,
        host: &NativeSessionHost,
        grant: &HostPermissionGrant,
        cancel: CancellationToken,
        now: &str,
    ) -> Result<EffectFuture, HostError>;
}
pub trait CapabilityProvider {
    fn manifests(&self) -> Vec<(String, Value)>;
    fn prepare(
        &mut self,
        capability: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError>;
}
pub struct ProjectedTool {
    pub alias: String,
    pub capability: String,
    provider: usize,
    pub manifest: Value,
}
pub struct RuntimeProjection {
    tools: Vec<ProjectedTool>,
}
pub struct ProviderRegistry {
    providers: Vec<Box<dyn CapabilityProvider>>,
}
impl Default for ProviderRegistry {
    fn default() -> Self {
        Self {
            providers: vec![
                Box::<file::FileProvider>::default(),
                Box::new(shell::ShellProvider),
            ],
        }
    }
}
impl ProviderRegistry {
    pub fn project(&self) -> Result<RuntimeProjection, HostError> {
        let mut tools = Vec::new();
        for (provider, p) in self.providers.iter().enumerate() {
            for (alias, manifest) in p.manifests() {
                if tools.iter().any(|t: &ProjectedTool| t.alias == alias) {
                    return Err(HostError("projection_alias_conflict"));
                }
                let capability = manifest["capabilityId"]
                    .as_str()
                    .ok_or(HostError("manifest_invalid"))?
                    .into();
                tools.push(ProjectedTool {
                    alias,
                    capability,
                    provider,
                    manifest,
                })
            }
        }
        Ok(RuntimeProjection { tools })
    }
    pub fn prepare(
        &mut self,
        projection: &RuntimeProjection,
        alias: &str,
        args: Value,
        workspace: &Path,
        home: &Path,
    ) -> Result<Box<dyn PreparedEffect>, HostError> {
        let tool = projection
            .tools
            .iter()
            .find(|t| t.alias == alias)
            .ok_or(HostError("tool_not_projected"))?;
        let provider = self
            .providers
            .get_mut(tool.provider)
            .ok_or(HostError("tool_not_projected"))?;
        provider.prepare(&tool.capability, args, workspace, home)
    }
}
impl RuntimeProjection {
    pub fn capability(&self, alias: &str) -> Option<&str> {
        self.tools
            .iter()
            .find(|t| t.alias == alias)
            .map(|t| t.capability.as_str())
    }
    pub fn definitions(&self) -> Value {
        json!(self.tools.iter().map(|t|json!({"type":"function","function":{"name":t.alias,"description":t.manifest["description"],"parameters":t.manifest["inputSchema"]}})).collect::<Vec<_>>())
    }
}
pub(super) fn resolve(workspace: &Path, input: &str) -> Result<PathBuf, HostError> {
    if input.is_empty() || input.len() > 16384 || input.contains('\0') {
        return Err(HostError("invalid_path"));
    }
    let p = Path::new(input.trim());
    let p = if p.is_absolute() {
        p.to_owned()
    } else {
        workspace.join(p)
    };
    if p.exists() {
        std::fs::canonicalize(p).map_err(|_| HostError("file_unavailable"))
    } else {
        let parent = std::fs::canonicalize(p.parent().ok_or(HostError("invalid_path"))?)
            .map_err(|_| HostError("file_parent_unavailable"))?;
        Ok(parent.join(p.file_name().ok_or(HostError("invalid_path"))?))
    }
}
pub(super) fn validate_shape(args: &Value, keys: &[&str]) -> Result<(), HostError> {
    let obj = args
        .as_object()
        .ok_or(HostError("tool_arguments_invalid"))?;
    if obj.keys().any(|k| !keys.contains(&k.as_str())) {
        return Err(HostError("tool_arguments_invalid"));
    }
    Ok(())
}
pub(super) fn string<'a>(args: &'a Value, k: &str) -> Result<&'a str, HostError> {
    args[k].as_str().ok_or(HostError("tool_arguments_invalid"))
}
pub(super) fn file_manifests() -> Value {
    serde_json::from_str(include_str!(
        "../../../packages/protocol/contracts/native-cli/file-manifests.json"
    ))
    .expect("compiled manifest")
}
