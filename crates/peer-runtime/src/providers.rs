//! Capability Provider -> Manifest -> immutable Runtime Projection -> effect.
//! The model selects an alias in a projection, never a Provider or permission.
use crate::{
    CancellationToken,
    capability::{CapabilityError as HostError, ProviderPermission, ShellRisk as HostShellRisk},
};
use peer_protocol::ExecutionResourceScope;
use serde_json::{Value, json};
use std::{
    future::Future,
    path::{Path, PathBuf},
    pin::Pin,
    sync::Arc,
};
mod file;
mod git;
pub(crate) mod goal;
mod mcp;
mod projection;
pub use projection::RuntimeMode;
mod shell;
mod skill;
pub(crate) use skill::PREFIX as SKILL_PREFIX;
pub use skill::{skill_id, wire_skill_name};
mod tool_artifact;
mod web;
pub use crate::effect_admission::EffectAdmission;
pub(crate) use crate::recorder::group_absent;
pub(crate) use shell::{
    background_start_fields, restore_background_start_fields, shell_stop_outcome,
};
pub(crate) mod interaction;
mod shell_risk;
#[cfg(test)]
mod tests;
pub struct EffectOutcome {
    pub status: &'static str,
    pub output: Value,
    pub error: Option<&'static str>,
    pub artifacts: Vec<String>,
    pub ended: bool,
    pub materialization: Option<peer_store::ResourceIdentity>,
    /// Trusted Provider observation that the capability request was not issued.
    /// Never decode this from output. A started connection still requires drain.
    pub not_dispatched: bool,
}
impl EffectOutcome {
    pub(crate) fn not_dispatched(code: &'static str) -> Self {
        let mut result = Self::failed(code);
        result.not_dispatched = true;
        if code == "CANCELLED" {
            result.status = "cancelled";
        }
        result
    }
    pub fn failed(code: &'static str) -> Self {
        Self {
            status: "failed",
            output: json!({}),
            error: Some(code),
            artifacts: vec![],
            ended: true,
            materialization: None,
            not_dispatched: false,
        }
    }
}
pub type EffectFuture = Pin<Box<dyn Future<Output = EffectOutcome> + Send>>;
/// Host-issued correlation facts, never an execution grant. All actual effects
/// require a live response from the separately bound EffectAdmission port.
pub struct ProviderCall {
    conversation: String,
    tool_call: String,
    started_at: String,
    pub(crate) goal_runner: Option<peer_store::OrdinaryRunner>,
}
impl ProviderCall {
    pub(crate) fn new(conversation: &str, tool_call: &str, started_at: &str) -> Self {
        Self {
            conversation: conversation.into(),
            tool_call: tool_call.into(),
            started_at: started_at.into(),
            goal_runner: None,
        }
    }
    /// Construct a host-issued correlation context for a projected capability call.
    pub fn for_host(conversation: &str, tool_call: &str, started_at: &str) -> Self {
        Self::new(conversation, tool_call, started_at)
    }
    pub fn conversation_id(&self) -> &str {
        &self.conversation
    }
    pub fn tool_call_id(&self) -> &str {
        &self.tool_call
    }
    pub fn started_at(&self) -> &str {
        &self.started_at
    }
}
pub use crate::tool_result_content::ToolOutputKind;
pub trait PreparedEffect {
    fn output_kind(&self) -> ToolOutputKind {
        ToolOutputKind::Structured
    }

    fn admission(&mut self, _port: crate::effect_admission::EffectAdmission) {}
    fn evidence(&self) -> Option<Value> {
        None
    }
    fn projection(&mut self, _id: &str) {}
    fn args(&self) -> &Value;
    fn permission(&self) -> ProviderPermission;
    /// A trusted read Provider asks the Host to authorize this concrete target,
    /// and each additional discovered target, before issuing its operation.
    fn read_scope(&self) -> Result<Option<&Path>, HostError> {
        Ok(None)
    }
    fn confined_read_scope(&self) -> Result<Option<&Path>, HostError> {
        self.read_scope()
    }
    fn risk(&self) -> Option<HostShellRisk> {
        None
    }
    fn scopes(&self) -> Result<Vec<ExecutionResourceScope>, HostError>;
    fn handle_metadata(&self) -> Option<Value> {
        None
    }
    fn handle(&self) -> Option<&str> {
        None
    }
    /// A fixed local command must journal its spawn intent and real child
    /// identity through the Host before its owned completion can settle.
    fn owned_command(&self) -> bool {
        false
    }
    fn background_shell(&self) -> bool {
        false
    }
    fn foreground_shell(&self) -> bool {
        false
    }
    /// Start owns a future, not permission. Before open/rename/spawn the actual
    /// worker must obtain fresh admission from its Host-bound control port.
    fn start(
        self: Box<Self>,
        call: ProviderCall,
        cancel: CancellationToken,
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
    id: String,
}
pub struct ProviderRegistry {
    providers: Vec<Box<dyn CapabilityProvider>>,
}
#[derive(Clone, Copy)]
pub(crate) enum ShellHostMode {
    OneShot,
    Work,
    Conversation,
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::builtins(false, ShellHostMode::OneShot)
    }
}
impl ProviderRegistry {
    fn builtins(result_reader_in_all_chat_modes: bool, shell_mode: ShellHostMode) -> Self {
        Self {
            providers: vec![
                Box::<file::FileProvider>::default(),
                Box::new(file::BatchSearchProvider),
                Box::new(web::WebProvider),
                Box::new(git::GitProvider),
                Box::new(shell::ShellProvider::new(shell_mode)),
                Box::new(tool_artifact::ToolArtifactProvider(
                    result_reader_in_all_chat_modes,
                )),
            ],
        }
    }
    pub(crate) fn project_read_only(&self) -> Result<RuntimeProjection, HostError> {
        let mut p = self.project_for_mode(RuntimeMode::Goal, None)?;
        p.tools
            .retain(|t| crate::capability::read_capability(&t.capability));
        p.id = peer_protocol::javascript_json_digest(&json!(
            p.tools.iter().map(|t| &t.manifest).collect::<Vec<_>>()
        ))
        .map_err(|_| HostError("projection_limit"))?;
        Ok(p)
    }
    pub(crate) fn with_extensions(
        snapshot: &peer_store::McpRegistrySnapshot,
        owner: &Value,
        home: &Path,
        credentials: crate::mcp_oauth::CredentialEpoch,
        skills: Arc<peer_store::SkillCatalog>,
        shell_mode: ShellHostMode,
    ) -> Result<Self, HostError> {
        if skills
            .mounted
            .iter()
            .any(|entry| !skill::skill_id(&entry.manifest.id))
        {
            return Err(HostError("skill_identity_invalid"));
        }
        let ordinary = matches!(shell_mode, ShellHostMode::Conversation);
        let mut registry = Self::builtins(ordinary || !skills.mounted.is_empty(), shell_mode);
        if !skills.mounted.is_empty() {
            registry
                .providers
                .push(Box::new(skill::SkillProvider(skills)));
        }
        registry.providers.push(Box::new(mcp::McpProvider::new(
            snapshot,
            owner,
            home,
            credentials,
        )?));
        Ok(registry)
    }
    pub(crate) fn add_ordinary_tools(&mut self, mode: RuntimeMode) {
        self.providers.push(Box::new(goal::GoalProvider(mode)));
        self.providers
            .push(Box::new(interaction::UnavailableInputProvider));
    }
    /// Register an additional governed capability provider into this registry.
    /// All tools still pass through `project_for_mode` before becoming model-visible.
    pub fn register(&mut self, provider: Box<dyn CapabilityProvider>) {
        self.providers.push(provider);
    }
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
        let id = peer_protocol::javascript_json_digest(&json!(
            tools.iter().map(|t| &t.manifest).collect::<Vec<_>>()
        ))
        .map_err(|_| HostError("projection_limit"))?;
        Ok(RuntimeProjection { tools, id })
    }
    /// The caller owns the actual turn mode and canonical capability allowlist.
    /// Filtering never grants a visible capability or installs a Provider.
    pub fn project_for_mode(
        &self,
        mode: RuntimeMode,
        allowlist: Option<&[String]>,
    ) -> Result<RuntimeProjection, HostError> {
        self.project()?.restrict(mode, allowlist)
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
        let mut effect = provider.prepare(&tool.capability, args, workspace, home)?;
        effect.projection(&projection.id);
        Ok(effect)
    }
}
impl RuntimeProjection {
    pub(crate) fn id(&self) -> &str {
        &self.id
    }
    pub(crate) fn has_capability(&self, capability: &str) -> bool {
        self.tools.iter().any(|t| t.capability == capability)
    }
    pub fn capability(&self, alias: &str) -> Option<&str> {
        self.tools
            .iter()
            .find(|t| t.alias == alias)
            .map(|t| t.capability.as_str())
    }
    pub(crate) fn skill_names(&self) -> Vec<&str> {
        self.tools
            .iter()
            .filter(|tool| tool.capability.starts_with(SKILL_PREFIX))
            .map(|tool| tool.alias.as_str())
            .collect()
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
