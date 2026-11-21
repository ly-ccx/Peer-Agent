//! Ordinary conversation Host over the same cognition, turn and Provider seams.
//! A conversation/stream is its actual principal; no Goal/Work is synthesized.
use crate::{
    CancellationToken,
    capability::{CapabilityError as HostError, now},
    cognition::{CognitionHost, CognitionRequest, ContextPipeline},
    live_execution::{Attempt, ExecutionRegistry},
    model::{
        ModelContinuation, ModelError, ModelObservation, ModelToolCall, ModelTurn, NativeModel,
        PreparedRequest,
    },
    providers::{ProviderRegistry, RuntimeMode, RuntimeProjection},
    session_host::{LocalPermissionDecision, PermissionInput},
    system_context::{
        ConversationContext, assemble_conversation_context, instructions::ProjectInstructions,
    },
    usage_accounting::{RequestMetadata, RuntimeUsageAccounting, UsageSnapshot},
};
use peer_protocol::{
    ConversationExecution, ConversationExecutionIdentity, ConversationExecutionPhase,
    LocalAccessLevel, UsagePurpose,
};
use peer_store::{
    ConversationExecutionToken, ConversationMetadataPublication, ConversationModelSelection,
    ConversationStore, GoalStore, HistorySnapshot, McpRegistryStore, NewConversation,
    NewConversationExecution, RunnerAdmission, RunnerStop,
};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet, HashSet},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
mod background_shell;
mod effect;
mod explorer;
mod foreground_shell;
mod goal_inspect;
mod goal_intake;
mod hooks;
mod permission;
mod readonly_worker;
mod recovery;
mod runner;
mod tool;
mod user_input;
mod verifier;
use permission::ToolGrant;
use runner::RunnerOutcome;

struct AccessState {
    level: LocalAccessLevel,
    revision: u64,
    session_approvals: HashSet<String>,
}

/// Host-owned live access revision. UI/ACP commands change this actual authority;
/// persisted approval history alone never constructs it or a ToolGrant.
#[derive(Clone)]
pub struct ConversationAccess(Arc<Mutex<AccessState>>);
impl ConversationAccess {
    pub fn new(level: LocalAccessLevel) -> Self {
        Self(Arc::new(Mutex::new(AccessState {
            level,
            revision: 0,
            session_approvals: HashSet::new(),
        })))
    }
    pub fn set(&self, level: LocalAccessLevel) -> Result<(), HostError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| HostError("permission_unavailable"))?;
        if state.level != level {
            state.revision = state
                .revision
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or(HostError("permission_revision_limit"))?;
            state.level = level;
            state.session_approvals.clear();
        }
        Ok(())
    }
    pub fn clear_session_approvals(&self) {
        if let Ok(mut state) = self.0.lock() {
            state.session_approvals.clear();
        }
    }
    pub(super) fn has_session_approval(&self, revision: u64, key: &str) -> Result<bool, HostError> {
        let state = self
            .0
            .lock()
            .map_err(|_| HostError("permission_unavailable"))?;
        Ok(state.revision == revision && state.session_approvals.contains(key))
    }
    pub(super) fn remember_session_approval(
        &self,
        revision: u64,
        key: String,
    ) -> Result<bool, HostError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| HostError("permission_unavailable"))?;
        if state.revision != revision {
            return Ok(false);
        }
        if state.session_approvals.len() < 512 {
            state.session_approvals.insert(key);
        }
        Ok(true)
    }
    fn snapshot(&self) -> Result<(LocalAccessLevel, u64), HostError> {
        self.0
            .lock()
            .map(|s| (s.level, s.revision))
            .map_err(|_| HostError("permission_unavailable"))
    }
}
pub struct ConversationOptions<'a> {
    pub workspace: &'a Path,
    pub conversation_id: Option<&'a str>,
    pub resume_from: Option<&'a ConversationExecution>,
    pub prompt: &'a str,
    pub image_paths: &'a [PathBuf],
    pub provider_id: &'a str,
    pub mode: RuntimeMode,
    pub effort: &'a str,
    pub persist_model_selection: bool,
    pub allowlist: Option<&'a [String]>,
    pub max_turns: Option<usize>,
}
pub struct PreparedConversationOptions<'a> {
    pub workspace: &'a Path,
    pub conversation_id: &'a str,
    pub stream_id: &'a str,
    pub assistant_message_id: &'a str,
    pub provider_id: &'a str,
    pub mode: RuntimeMode,
    pub effort: &'a str,
    pub persist_model_selection: bool,
    pub resume_interrupted_reply: bool,
    pub runtime_reminders: &'a [(String, String)],
    pub config_instructions: Option<&'a [crate::system_context::instructions::ConfigInstruction]>,
    pub context_attachments: &'a [Value],
    pub context_extensions: &'a [Value],
    pub allowlist: Option<&'a [String]>,
    pub max_turns: Option<usize>,
    pub extra_providers: Vec<Box<dyn crate::providers::CapabilityProvider>>,
}
pub struct ConversationOutcome {
    pub session_id: String,
    pub content: String,
    pub turns: usize,
    pub usage: UsageSnapshot,
    pub lifetime_usage: Option<Value>,
    pub error: Option<&'static str>,
    pub goal: Option<Value>,
    pub context_accounting: Option<Value>,
    pub stop_reason: Option<&'static str>,
}
pub struct CompactOutcome {
    pub method: String,
    pub original_message_count: usize,
}
pub struct CompactOptions<'a> {
    pub workspace: &'a Path,
    pub conversation_id: &'a str,
    pub resume_from: Option<&'a ConversationExecution>,
    pub provider_id: &'a str,
    pub mode: RuntimeMode,
    pub effort: &'a str,
    pub desktop_host: bool,
}
/// Presentation events from the ordinary Host. Assistant deltas are provisional
/// display text; AssistantText is published after the complete text is committed.
pub enum ConversationEvent<'a> {
    Started {
        conversation_id: &'a str,
    },
    ThinkingDelta(&'a str),
    AssistantDelta(&'a str),
    AssistantText(&'a str),
    ToolPrepared {
        call_id: &'a str,
        tool: &'a str,
        arguments: &'a Value,
    },
    PermissionSettled {
        call_id: &'a str,
        granted: bool,
        reason: &'a str,
    },
    ToolSettled {
        call_id: &'a str,
        result: &'a Value,
        evidence_ref: Option<&'a str>,
    },
    Usage(&'a UsageSnapshot),
}
pub trait ConversationOutput {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), HostError>> + 'a>>;
}

pub enum GoalRunnerEvent<'a> {
    Started {
        plan_id: &'a str,
        conversation_id: &'a str,
    },
    TickStarted {
        plan_id: &'a str,
        conversation_id: &'a str,
        stream_id: &'a str,
        turn_number: u64,
        assistant_message_id: &'a str,
        started_at_ms: i64,
    },
    TickFinished {
        plan_id: &'a str,
        conversation_id: &'a str,
        stream_id: &'a str,
        error: Option<&'a str>,
        cancelled: bool,
        usage: &'a UsageSnapshot,
    },
    PlanChanged {
        plan_id: &'a str,
        conversation_id: &'a str,
        change_kind: &'a str,
    },
    StateChanged {
        plan_id: &'a str,
        conversation_id: &'a str,
        event_type: &'a str,
        detail: Value,
    },
}

#[derive(Debug, Clone)]
pub struct VisualVerificationOutcome {
    pub required: bool,
    pub passed: bool,
    pub report: Value,
}

pub trait GoalHostHooks {
    fn on_goal_event<'a>(
        &'a mut self,
        event: GoalRunnerEvent<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ()> + 'a>>;

    fn run_visual_verification<'a>(
        &'a mut self,
        plan_id: &'a str,
        conversation_id: &'a str,
        verifier_run_id: &'a str,
        workspace: &'a Path,
        cancel: &'a CancellationToken,
    ) -> std::pin::Pin<
        Box<dyn std::future::Future<Output = Result<VisualVerificationOutcome, HostError>> + 'a>,
    >;
}

pub struct GoalPlanRunOptions<'a> {
    pub plan_id: &'a str,
    pub workspace: &'a Path,
    pub stream_id: &'a str,
    pub provider_id: &'a str,
    pub effort: &'a str,
    pub allow_resume: bool,
    pub pause_requested: Option<Arc<AtomicBool>>,
    pub allowlist: Option<&'a [String]>,
    pub max_turns: Option<usize>,
    pub extra_providers: Vec<Box<dyn crate::providers::CapabilityProvider>>,
}

pub struct GoalPlanRunOutcome {
    pub plan_id: String,
    pub conversation_id: String,
    pub turns: usize,
    pub usage: UsageSnapshot,
    pub lifetime_usage: Option<Value>,
    pub error: Option<&'static str>,
    pub goal: Option<Value>,
}
/// One Host instance owns the bounded live registry across ordinary sessions.
/// Discovery is read-only. A dropped runner stays unknown, never implicitly idle.
pub struct NativeConversationRuntime {
    home: PathBuf,
    live: ExecutionRegistry,
    access: ConversationAccess,
}
#[derive(Clone, Copy)]
enum ExecutionSurface {
    Headless,
    Observed,
    Interactive,
}

impl NativeConversationRuntime {
    pub fn new(home: impl AsRef<Path>, access: ConversationAccess) -> Self {
        Self {
            home: home.as_ref().into(),
            live: ExecutionRegistry::default(),
            access,
        }
    }
    pub fn update_chat_model(
        &self,
        conversation: &str,
        workspace: &Path,
        selection: &ConversationModelSelection<'_>,
    ) -> Result<(), HostError> {
        let workspace = workspace.to_str().ok_or(HostError("invalid_workspace"))?;
        ConversationStore::new(&self.home).update_chat_model(
            conversation,
            workspace,
            selection,
            &now(),
        )?;
        Ok(())
    }
    pub fn update_ordinary_mode(
        &self,
        conversation: &str,
        workspace: &Path,
        mode: RuntimeMode,
    ) -> Result<(), HostError> {
        if !matches!(
            mode,
            RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
        ) {
            return Err(HostError("runtime_mode_invalid"));
        }
        let workspace =
            std::fs::canonicalize(workspace).map_err(|_| HostError("invalid_workspace"))?;
        let workspace = workspace.to_str().ok_or(HostError("invalid_workspace"))?;
        ConversationStore::new(&self.home).update_ordinary_mode(
            conversation,
            workspace,
            mode.as_str(),
            &now(),
        )?;
        Ok(())
    }
    pub fn update_ordinary_model(
        &self,
        conversation: &str,
        workspace: &Path,
        selection: &ConversationModelSelection<'_>,
    ) -> Result<(), HostError> {
        let workspace =
            std::fs::canonicalize(workspace).map_err(|_| HostError("invalid_workspace"))?;
        let workspace = workspace.to_str().ok_or(HostError("invalid_workspace"))?;
        ConversationStore::new(&self.home).update_ordinary_model(
            conversation,
            workspace,
            selection,
            &now(),
        )?;
        Ok(())
    }
    pub async fn compact_conversation(
        &self,
        options: &CompactOptions<'_>,
        model: &NativeModel,
        external: &CancellationToken,
    ) -> Result<CompactOutcome, HostError> {
        let workspace = options.workspace;
        let conversation_id = options.conversation_id;
        let resume_from = options.resume_from;
        let provider_id = options.provider_id;
        let mode = options.mode;
        let effort = options.effort;
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if !matches!(
            mode,
            RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
        ) {
            return Err(HostError("runtime_mode_invalid"));
        }
        if resume_from.is_some_and(|run| {
            run.identity.conversation_id != conversation_id || !run.permits_new_run()
        }) {
            return Err(HostError("conversation_execution_busy"));
        }
        let workspace =
            std::fs::canonicalize(workspace).map_err(|_| HostError("invalid_workspace"))?;
        if !workspace.is_dir() || workspace.to_str().is_none() {
            return Err(HostError("invalid_workspace"));
        }
        let at = now();
        let hooks = Arc::new(peer_store::HookConfig::observe(&self.home, &workspace)?);
        let skills = Arc::new(peer_store::SkillCatalog::observe(&self.home, &workspace)?);
        let instructions = if options.desktop_host {
            ProjectInstructions::observe_desktop_host(&workspace, &self.home, None, external)
        } else {
            ProjectInstructions::observe_host(&workspace, &self.home, external)
        }
        .map_err(HostError)?;
        let inventory = McpRegistryStore::new(&self.home).read()?;
        let store = ConversationStore::new(&self.home);
        let meta = store
            .read_metadata(conversation_id)?
            .metadata
            .ok_or(HostError("conversation_unavailable"))?;
        if options.desktop_host {
            if let Some(bound_ws) = meta["workspacePath"].as_str().filter(|s| !s.is_empty()) {
                let bound_canon = std::fs::canonicalize(bound_ws).ok();
                if bound_ws != workspace.to_str().unwrap_or("")
                    && bound_canon.as_deref() != Some(workspace.as_path())
                {
                    return Err(HostError("conversation_scope_changed"));
                }
            }
            if meta["mode"].as_str().is_some_and(|m| m != mode.as_str()) {
                return Err(HostError("conversation_scope_changed"));
            }
        } else if meta["workspacePath"].as_str() != workspace.to_str()
            || meta["mode"] != mode.as_str()
        {
            return Err(HostError("conversation_scope_changed"));
        }
        if meta
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || meta
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            return Err(HostError("out_of_scope"));
        }
        if store
            .read_conversation_execution(conversation_id)?
            .is_some_and(|r| !r.permits_new_run())
        {
            return Err(HostError("conversation_execution_busy"));
        }
        let context_binding = binding(&meta)?;
        let stream = format!("stream-{}", uuid::Uuid::new_v4());
        let owner = crate::recorder::local_recorder(
            &format!("native-compaction-{}", uuid::Uuid::new_v4()),
            &at,
        )
        .await
        .ok_or(HostError("native_recorder_unavailable"))?;
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let attribution = json!({"id":stream,"streamId":stream,"at":at,"modelProviderId":format!("{provider_id}::{}",model.model_id()),"model":model.model_id(),"providerName":model.provider(),"role":"chat"});
        let identity = ConversationExecutionIdentity {
            conversation_id: conversation_id.to_owned(),
            stream_id: stream.clone(),
        };
        let credentials = crate::mcp_oauth::CredentialEpoch::open_conversation(
            &self.home,
            &identity,
            &inventory.source_revision,
        )
        .map_err(HostError)?;
        let providers = ProviderRegistry::with_extensions(
            &inventory,
            &json!({"recorder":owner}),
            &self.home,
            credentials.clone(),
            skills.clone(),
            crate::providers::ShellHostMode::Conversation,
        )?;
        let projection = providers.project_for_mode(mode, None)?;
        let pipeline = if meta["modelProviderId"].is_string() && meta["model"].is_string() {
            ContextPipeline::open_bound(&self.home, conversation_id, provider_id, model)?
        } else {
            ContextPipeline::open(&self.home, conversation_id, provider_id, model)?
        };
        let initial = store.read_committed(conversation_id, None, 8 * 1024 * 1024)?;
        let attempt = self
            .live
            .begin(&identity)
            .map_err(|_| HostError("native_execution_owner_unavailable"))?;
        let intent = NewConversationExecution {
            stream_id: &stream,
            engine: "peer-native",
            owner: &owner,
            attribution: &attribution,
            selected_model: None,
            at: &at,
        };
        let claimed = match resume_from {
            Some(stopped) => {
                store.claim_resumed_conversation_execution(&initial, &intent, stopped, None)
            }
            None => store.claim_conversation_execution(&initial, &intent, None),
        };
        let (run, publication) = match claimed {
            Ok(claimed) => claimed,
            Err(error) => {
                let _ = self.live.close_admission(&identity);
                attempt.finish();
                let _ = self.live.forget_ended(&identity);
                let original = error.error();
                if let Some(cleanup) = error.into_cleanup() {
                    cleanup.close_unstarted(&store, &now())?;
                }
                return Err(original.into());
            }
        };
        let owned = attempt.cancellation();
        let mut expected = initial;
        expected.source_revision = publication
            .advance(
                conversation_id,
                expected.history.content_revision,
                &expected.source_revision,
            )?
            .into();
        struct CompactionDenyPermission;
        impl PermissionInput for CompactionDenyPermission {
            fn decide<'a>(
                &'a mut self,
                _prompt: Value,
                _cancel: &'a CancellationToken,
            ) -> std::pin::Pin<Box<dyn std::future::Future<Output = LocalPermissionDecision> + 'a>>
            {
                Box::pin(async { LocalPermissionDecision::Deny })
            }
        }
        let mut deny_permission = CompactionDenyPermission;
        let mut host = Host {
            home: self.home.clone(),
            store: ConversationStore::new(&self.home),
            run,
            identity,
            workspace,
            mode,
            effort: effort.into(),
            model,
            permission: Some(&mut deny_permission),
            output: None,
            access: self.access.clone(),
            live: self.live.clone(),
            attempt: Some(attempt),
            owned: owned.clone(),
            external: external.clone(),
            expected,
            binding: context_binding,
            instructions,
            servers: inventory.host_context_servers(),
            registry: inventory.source_revision,
            skills,
            hooks,
            credentials,
            providers,
            projection,
            allowlist: None,
            pipeline: Some(pipeline),
            usage: RuntimeUsageAccounting::default(),
            system: None,
            turns: 0,
            request_admitted: false,
            background_shells: BTreeMap::new(),
            completed_shells: BTreeMap::new(),
            foreground_authority: None,
            cognition_source: None,
            interactive_user_input: false,
            worker: None,
            explorer_requests: BTreeSet::new(),
            runner: None,
            prepared_assistant: None,
            goal_hooks: None,
            runtime_reminders: Vec::new(),
            context_attachments: Vec::new(),
            context_extensions: Vec::new(),
        };
        let result = async {
            host.source_current()?;
            let history = host
                .store
                .read_committed(conversation_id, None, 8 * 1024 * 1024)?;
            if history.history.excluded_from_message_id.is_some() {
                return Err(HostError("native_execution_recovery_required"));
            }
            let projected = crate::canonical_history::project_history(&history.history.messages)
                .map_err(HostError)?;
            let mut usage = std::mem::take(&mut host.usage);
            let mut pipeline = host
                .pipeline
                .take()
                .ok_or(HostError("native_pipeline_unavailable"))?;
            let home = host.home.clone();
            let tools = json!([]);
            let req = CognitionRequest {
                home: &home,
                model,
                tools: &tools,
                owned: &owned,
                external,
            };
            let res = pipeline
                .compact(&mut host, &req, &mut usage, &history, &projected)
                .await;
            host.pipeline = Some(pipeline);
            host.usage = usage;
            let (method, original_message_count) = res?;
            Ok(CompactOutcome {
                method,
                original_message_count,
            })
        }
        .await;
        let cleanup = host.finish().await;
        let outcome = result?;
        cleanup?;
        Ok(outcome)
    }
    pub async fn execute(
        &self,
        options: &ConversationOptions<'_>,
        model: &NativeModel,
        permission: &mut dyn PermissionInput,
        external: &CancellationToken,
    ) -> Result<ConversationOutcome, HostError> {
        self.execute_owned(
            options,
            model,
            permission,
            None,
            external,
            ExecutionSurface::Headless,
        )
        .await
    }
    pub async fn execute_observed<'a>(
        &self,
        options: &ConversationOptions<'_>,
        model: &'a NativeModel,
        permission: &'a mut dyn PermissionInput,
        output: Option<&'a mut dyn ConversationOutput>,
        external: &CancellationToken,
    ) -> Result<ConversationOutcome, HostError> {
        self.execute_owned(
            options,
            model,
            permission,
            output,
            external,
            ExecutionSurface::Observed,
        )
        .await
    }
    pub async fn execute_interactive<'a>(
        &self,
        options: &ConversationOptions<'_>,
        model: &'a NativeModel,
        permission: &'a mut dyn PermissionInput,
        output: Option<&'a mut dyn ConversationOutput>,
        external: &CancellationToken,
    ) -> Result<ConversationOutcome, HostError> {
        self.execute_owned(
            options,
            model,
            permission,
            output,
            external,
            ExecutionSurface::Interactive,
        )
        .await
    }
    async fn execute_owned<'a>(
        &self,
        options: &ConversationOptions<'_>,
        model: &'a NativeModel,
        permission: &'a mut dyn PermissionInput,
        output: Option<&'a mut dyn ConversationOutput>,
        external: &CancellationToken,
        surface: ExecutionSurface,
    ) -> Result<ConversationOutcome, HostError> {
        let headless = matches!(surface, ExecutionSurface::Headless);
        let interactive_user_input = matches!(surface, ExecutionSurface::Interactive);
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if (peer_protocol::javascript_trim(options.prompt).is_empty()
            && options.image_paths.is_empty())
            || options.prompt.len() > 1024 * 1024
            || options.max_turns == Some(0)
            || options.resume_from.is_some_and(|run| {
                options.conversation_id != Some(run.identity.conversation_id.as_str())
                    || !run.permits_new_run()
            })
        {
            return Err(HostError("invalid_conversation_input"));
        }
        if !matches!(
            options.mode,
            RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
        ) {
            return Err(HostError("runtime_mode_invalid"));
        }
        let workspace =
            std::fs::canonicalize(options.workspace).map_err(|_| HostError("invalid_workspace"))?;
        if !workspace.is_dir() || workspace.to_str().is_none() {
            return Err(HostError("invalid_workspace"));
        }
        let at = now();
        let user_message = user_input::message(
            &workspace,
            options.prompt,
            options.image_paths,
            &at,
            external,
        )
        .await?;
        if !options.image_paths.is_empty() {
            let projected =
                crate::canonical_history::project_history(std::slice::from_ref(&user_message))
                    .map_err(HostError)?;
            model
                .validate_saved_media(&projected)
                .map_err(|e| HostError(e.code))?;
        }
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let hooks = Arc::new(peer_store::HookConfig::observe(&self.home, &workspace)?);
        let skills = Arc::new(peer_store::SkillCatalog::observe(&self.home, &workspace)?);
        let instructions = ProjectInstructions::observe_host(&workspace, &self.home, external)
            .map_err(HostError)?;
        let inventory = McpRegistryStore::new(&self.home).read()?;
        let stream = format!("stream-{}", uuid::Uuid::new_v4());
        let owner = crate::recorder::local_recorder(
            &format!("native-conversation-{}", uuid::Uuid::new_v4()),
            &at,
        )
        .await
        .ok_or(HostError("native_recorder_unavailable"))?;
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let store = ConversationStore::new(&self.home);
        store.recover_runtime_usage(None)?;
        let selected = options
            .persist_model_selection
            .then_some(ConversationModelSelection {
                provider_id: options.provider_id,
                model: model.model_id(),
                effort: options.effort,
            });
        let conversation = match options.conversation_id {
            Some(id) => id.to_owned(),
            None => store.create_with_model(
                &NewConversation {
                    title: &if options.prompt.trim().is_empty() {
                        "Image attachment".into()
                    } else {
                        options.prompt.chars().take(80).collect::<String>()
                    },
                    workspace_path: workspace.to_str(),
                    mode: options.mode.as_str(),
                    created_at: &at,
                },
                selected.as_ref(),
                None,
            )?["id"]
                .as_str()
                .ok_or(HostError("conversation_invalid"))?
                .into(),
        };
        let meta = store
            .read_metadata(&conversation)?
            .metadata
            .ok_or(HostError("conversation_unavailable"))?;
        if meta["workspacePath"].as_str() != workspace.to_str()
            || meta["mode"] != options.mode.as_str()
        {
            return Err(HostError("conversation_scope_changed"));
        }
        if meta
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || meta
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            return Err(HostError("out_of_scope"));
        }
        if store
            .read_conversation_execution(&conversation)?
            .is_some_and(|r| !r.permits_new_run())
        {
            return Err(HostError("conversation_execution_busy"));
        }
        if selected
            .as_ref()
            .is_some_and(|selection| !selection.matches(&meta))
        {
            return Err(HostError("conversation_model_selection_changed"));
        }
        let context_binding = binding(&meta)?;
        let attribution = json!({"id":stream,"streamId":stream,"at":at,"modelProviderId":format!("{}::{}",options.provider_id,model.model_id()),"model":model.model_id(),"providerName":model.provider(),"role":"chat"});
        let identity = ConversationExecutionIdentity {
            conversation_id: conversation.clone(),
            stream_id: stream.clone(),
        };
        let credentials = crate::mcp_oauth::CredentialEpoch::open_conversation(
            &self.home,
            &identity,
            &inventory.source_revision,
        )
        .map_err(HostError)?;
        let mut providers = ProviderRegistry::with_extensions(
            &inventory,
            &json!({"recorder":owner}),
            &self.home,
            credentials.clone(),
            skills.clone(),
            crate::providers::ShellHostMode::Conversation,
        )?;
        providers.add_ordinary_tools(options.mode, interactive_user_input);
        let projection = providers.project_for_mode(options.mode, options.allowlist)?;
        let pipeline = if selected.is_some() {
            ContextPipeline::open_bound(&self.home, &conversation, options.provider_id, model)?
        } else {
            ContextPipeline::open(&self.home, &conversation, options.provider_id, model)?
        };
        let initial = store.read_committed(&conversation, None, 8 * 1024 * 1024)?;
        let identity = ConversationExecutionIdentity {
            conversation_id: conversation.clone(),
            stream_id: stream.clone(),
        };
        let attempt = self
            .live
            .begin(&identity)
            .map_err(|_| HostError("native_execution_owner_unavailable"))?;
        let intent = NewConversationExecution {
            stream_id: &stream,
            engine: "peer-native",
            owner: &owner,
            attribution: &attribution,
            selected_model: selected.as_ref(),
            at: &at,
        };
        let claimed = match options.resume_from {
            Some(stopped) => {
                store.claim_resumed_conversation_execution(&initial, &intent, stopped, None)
            }
            None => store.claim_conversation_execution(&initial, &intent, None),
        };
        let (run, publication) = match claimed {
            Ok(claimed) => claimed,
            Err(error) => {
                let _ = self.live.close_admission(&identity);
                attempt.finish();
                let _ = self.live.forget_ended(&identity);
                let original = error.error();
                if let Some(cleanup) = error.into_cleanup() {
                    cleanup.close_unstarted(&store, &now())?;
                    return Ok(ConversationOutcome {
                        session_id: conversation,
                        content: String::new(),
                        turns: 0,
                        usage: RuntimeUsageAccounting::default().snapshot(),
                        lifetime_usage: None,
                        error: Some(original.code()),
                        goal: None,
                        context_accounting: None,
                        stop_reason: None,
                    });
                }
                return Err(original.into());
            }
        };
        let owned = attempt.cancellation();
        let mut expected = initial;
        expected.source_revision = publication
            .advance(
                &conversation,
                expected.history.content_revision,
                &expected.source_revision,
            )?
            .into();
        let mut host = Host {
            home: self.home.clone(),
            store,
            run,
            identity,
            workspace,
            mode: options.mode,
            effort: options.effort.into(),
            model,
            permission: Some(permission),
            output,
            access: self.access.clone(),
            live: self.live.clone(),
            attempt: Some(attempt),
            owned: owned.clone(),
            external: external.clone(),
            expected,
            binding: context_binding,
            instructions,
            servers: inventory.host_context_servers(),
            registry: inventory.source_revision,
            skills,
            hooks,
            credentials,
            providers,
            projection,
            allowlist: options.allowlist.map(<[String]>::to_vec),
            pipeline: Some(pipeline),
            usage: RuntimeUsageAccounting::default(),
            system: None,
            turns: 0,
            request_admitted: false,
            background_shells: BTreeMap::new(),
            completed_shells: BTreeMap::new(),
            foreground_authority: None,
            cognition_source: None,
            interactive_user_input,
            worker: None,
            explorer_requests: BTreeSet::new(),
            runner: None,
            prepared_assistant: None,
            goal_hooks: None,
            runtime_reminders: Vec::new(),
            context_attachments: Vec::new(),
            context_extensions: Vec::new(),
        };
        let mut runner_stop = None;
        let result = async {
            host.append(&user_message)?;
            drop(user_message);
            host.publish(ConversationEvent::Started {
                conversation_id: &conversation,
            })
            .await?;
            let result =
                crate::turn_loop::run(&mut host, options.max_turns, &owned, external).await?;
            if result.stop == crate::turn_loop::LoopStop::Replied {
                host.drive_requested_explorers().await?;
            }
            if headless
                && !matches!(
                    result.stop,
                    crate::turn_loop::LoopStop::UserInputUnavailable
                        | crate::turn_loop::LoopStop::RequestedUserInput
                )
            {
                runner_stop = host.drive_new_goal(options.max_turns).await?;
            }
            Ok::<_, HostError>(result)
        }
        .await;
        let cleanup = host.finish().await;
        let goal = if cleanup.is_ok() {
            match runner_stop {
                Some(RunnerOutcome::Stop(stop)) => host.settle_runner(stop),
                Some(RunnerOutcome::Waiting(report)) => Ok(Some(report)),
                None => host.settle_runner(RunnerStop::Blocked(
                    result
                        .as_ref()
                        .err()
                        .map_or("goal_runner_interrupted", |error| error.0),
                )),
            }
        } else {
            Ok(None)
        };
        let error = cleanup
            .as_ref()
            .err()
            .copied()
            .or_else(|| result.as_ref().err().copied())
            .or_else(|| goal.as_ref().err().copied())
            .or_else(|| {
                result
                    .as_ref()
                    .ok()
                    .filter(|r| r.stop == crate::turn_loop::LoopStop::MaxTurns)
                    .map(|_| HostError("agent_loop_exhausted"))
            });
        let content = result
            .as_ref()
            .map(|r| r.content.clone())
            .unwrap_or_default();
        let stop_reason = result.as_ref().ok().map(|r| r.stop.as_str());
        Ok(ConversationOutcome {
            session_id: conversation,
            content,
            turns: host.turns,
            usage: host.usage.snapshot(),
            lifetime_usage: cleanup.ok().flatten(),
            error: error.map(|e| e.0),
            goal: goal.ok().flatten().filter(|_| error.is_none()),
            context_accounting: None,
            stop_reason,
        })
    }

    /// Execute an interactive ordinary conversation turn (`chat`, `plan`, or `goal`) bound to an existing
    /// caller-prepared user + placeholder assistant message (`assistant_message_id`) and explicit
    /// `stream_id`. All tool, permission, context, and usage invariants stay owned by `Host`.
    pub async fn execute_prepared_interactive<'a>(
        &self,
        mut options: PreparedConversationOptions<'_>,
        model: &'a NativeModel,
        permission: &'a mut dyn PermissionInput,
        output: Option<&'a mut dyn ConversationOutput>,
        external: &CancellationToken,
    ) -> Result<ConversationOutcome, HostError> {
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if !matches!(
            options.mode,
            RuntimeMode::Chat | RuntimeMode::Plan | RuntimeMode::Goal
        ) {
            return Err(HostError("runtime_mode_invalid"));
        }
        if options.conversation_id.is_empty()
            || options.stream_id.is_empty()
            || options.assistant_message_id.is_empty()
            || options.max_turns == Some(0)
        {
            return Err(HostError("invalid_conversation_input"));
        }
        let workspace =
            std::fs::canonicalize(options.workspace).map_err(|_| HostError("invalid_workspace"))?;
        let workspace_str = workspace.to_str().ok_or(HostError("invalid_workspace"))?;
        if !workspace.is_dir() {
            return Err(HostError("invalid_workspace"));
        }
        let at = now();
        let hooks = Arc::new(peer_store::HookConfig::observe(&self.home, &workspace)?);
        let skills = Arc::new(peer_store::SkillCatalog::observe(&self.home, &workspace)?);
        let instructions = ProjectInstructions::observe_desktop_host(
            &workspace,
            &self.home,
            options.config_instructions,
            external,
        )
        .map_err(HostError)?;
        let inventory = McpRegistryStore::new(&self.home).read()?;
        let stream = options.stream_id.to_owned();
        let owner = crate::recorder::local_recorder(
            &format!("native-conversation-{}", uuid::Uuid::new_v4()),
            &at,
        )
        .await
        .ok_or(HostError("native_recorder_unavailable"))?;
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        let store = ConversationStore::new(&self.home);
        store.recover_runtime_usage(None)?;
        let conversation = options.conversation_id.to_owned();
        let mut meta = store
            .read_metadata(&conversation)?
            .metadata
            .ok_or(HostError("conversation_unavailable"))?;
        if let Some(bound_ws) = meta["workspacePath"].as_str().filter(|s| !s.is_empty()) {
            let bound_canon = std::fs::canonicalize(bound_ws).ok();
            if bound_ws != workspace_str && bound_canon.as_deref() != Some(workspace.as_path()) {
                return Err(HostError("conversation_scope_changed"));
            }
        }
        if meta["mode"]
            .as_str()
            .is_some_and(|m| m != options.mode.as_str())
        {
            return Err(HostError("conversation_scope_changed"));
        }
        if meta
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || meta
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            return Err(HostError("out_of_scope"));
        }
        if store
            .read_conversation_execution(&conversation)?
            .is_some_and(|r| !r.permits_new_run())
        {
            return Err(HostError("conversation_execution_busy"));
        }
        if options.persist_model_selection {
            let selection = ConversationModelSelection {
                provider_id: options.provider_id,
                model: model.model_id(),
                effort: options.effort,
            };
            if !selection.matches(&meta)
                && let Some(meta_ws) = meta["workspacePath"].as_str().filter(|s| !s.is_empty())
            {
                store.update_ordinary_model(&conversation, meta_ws, &selection, &at)?;
                meta = store
                    .read_metadata(&conversation)?
                    .metadata
                    .ok_or(HostError("conversation_unavailable"))?;
            }
        }
        let selected_for_claim = options
            .persist_model_selection
            .then_some(ConversationModelSelection {
                provider_id: options.provider_id,
                model: model.model_id(),
                effort: options.effort,
            })
            .filter(|selection| selection.matches(&meta));

        let context_binding = binding(&meta)?;
        let attribution = json!({
            "id": stream,
            "streamId": stream,
            "at": at,
            "modelProviderId": format!("{}::{}", options.provider_id, model.model_id()),
            "model": model.model_id(),
            "providerName": model.provider(),
            "role": "chat",
        });
        let identity = ConversationExecutionIdentity {
            conversation_id: conversation.clone(),
            stream_id: stream.clone(),
        };
        let credentials = crate::mcp_oauth::CredentialEpoch::open_conversation(
            &self.home,
            &identity,
            &inventory.source_revision,
        )
        .map_err(HostError)?;
        let mut providers = ProviderRegistry::with_extensions(
            &inventory,
            &json!({"recorder": owner}),
            &self.home,
            credentials.clone(),
            skills.clone(),
            crate::providers::ShellHostMode::Conversation,
        )?;
        providers.add_ordinary_tools(options.mode, true);
        for extra in options.extra_providers.drain(..) {
            providers.register(extra);
        }
        let projection = providers.project_for_mode(options.mode, options.allowlist)?;
        let pipeline = if selected_for_claim.is_some() {
            ContextPipeline::open_bound(&self.home, &conversation, options.provider_id, model)?
        } else {
            ContextPipeline::open(&self.home, &conversation, options.provider_id, model)?
        };
        let initial = store.read_committed(&conversation, None, 8 * 1024 * 1024)?;
        let attempt = self
            .live
            .begin(&identity)
            .map_err(|_| HostError("native_execution_owner_unavailable"))?;
        let intent = NewConversationExecution {
            stream_id: &stream,
            engine: "peer-native",
            owner: &owner,
            attribution: &attribution,
            selected_model: selected_for_claim.as_ref(),
            at: &at,
        };
        let (run, publication) = match store.claim_conversation_execution(&initial, &intent, None) {
            Ok(claimed) => claimed,
            Err(error) => {
                let _ = self.live.close_admission(&identity);
                attempt.finish();
                let _ = self.live.forget_ended(&identity);
                let original = error.error();
                if let Some(cleanup) = error.into_cleanup() {
                    cleanup.close_unstarted(&store, &now())?;
                    return Ok(ConversationOutcome {
                        session_id: conversation,
                        content: String::new(),
                        turns: 0,
                        usage: RuntimeUsageAccounting::default().snapshot(),
                        lifetime_usage: None,
                        error: Some(original.code()),
                        goal: None,
                        context_accounting: None,
                        stop_reason: None,
                    });
                }
                return Err(original.into());
            }
        };
        let owned = attempt.cancellation();
        let mut expected = initial;
        expected.source_revision = publication
            .advance(
                &conversation,
                expected.history.content_revision,
                &expected.source_revision,
            )?
            .into();

        let started_at_ms = crate::capability::milliseconds(&at).unwrap_or(0);
        let prepared_assistant = if let Some(existing) = expected
            .history
            .messages
            .iter()
            .find(|m| m["id"] == options.assistant_message_id)
        {
            if existing["role"] != "assistant" {
                return Err(HostError("prepared_assistant_invalid_role"));
            }
            let content = existing["content"].as_str().unwrap_or("").to_owned();
            let thinking_content = existing["thinkingContent"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let segments = existing["segments"].as_array().cloned().unwrap_or_default();
            let permission_grants = existing["permissionGrants"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            if existing["streamId"].as_str() != Some(stream.as_str())
                || existing["interrupted"] == true
            {
                let patch = json!({
                    "streamId": stream,
                    "interrupted": false,
                    "streamFailure": Value::Null,
                });
                expected = store
                    .commit_terminal_message(
                        &expected,
                        options.assistant_message_id,
                        &patch,
                        &now(),
                        None,
                    )?
                    .snapshot;
            }
            PreparedAssistant {
                message_id: options.assistant_message_id.to_owned(),
                content,
                thinking_content,
                segments,
                permission_grants,
                started_at_ms,
            }
        } else {
            let placeholder = json!({
                "id": options.assistant_message_id,
                "role": "assistant",
                "content": "",
                "segments": [],
                "createdAt": at,
                "streamId": stream,
                "permissionGrants": [],
            });
            expected = store
                .commit_message(&expected, &placeholder, &now(), None)?
                .snapshot;
            PreparedAssistant {
                message_id: options.assistant_message_id.to_owned(),
                content: String::new(),
                thinking_content: String::new(),
                segments: Vec::new(),
                permission_grants: Vec::new(),
                started_at_ms,
            }
        };

        let mut reminders = options.runtime_reminders.to_vec();
        if options.resume_interrupted_reply
            && !reminders
                .iter()
                .any(|(id, _)| id == "resume-interrupted-reply")
        {
            reminders.push((
                "resume-interrupted-reply".to_owned(),
                "The last assistant message in this conversation was truncated by a network interruption mid-generation. It is your own unfinished reply, not user input. Continue exactly where it left off to complete the same reply. Do not repeat, rewrite, summarize, or re-answer what was already generated; do not treat this as a new question or a new turn.".to_owned(),
            ));
        }

        let mut host = Host {
            home: self.home.clone(),
            store,
            run,
            identity,
            workspace,
            mode: options.mode,
            effort: options.effort.into(),
            model,
            permission: Some(permission),
            output,
            access: self.access.clone(),
            live: self.live.clone(),
            attempt: Some(attempt),
            owned: owned.clone(),
            external: external.clone(),
            expected,
            binding: context_binding,
            instructions,
            servers: inventory.host_context_servers(),
            registry: inventory.source_revision,
            skills,
            hooks,
            credentials,
            providers,
            projection,
            allowlist: options.allowlist.map(<[String]>::to_vec),
            pipeline: Some(pipeline),
            usage: RuntimeUsageAccounting::default(),
            system: None,
            turns: 0,
            request_admitted: false,
            background_shells: BTreeMap::new(),
            completed_shells: BTreeMap::new(),
            foreground_authority: None,
            cognition_source: None,
            interactive_user_input: true,
            worker: None,
            explorer_requests: BTreeSet::new(),
            runner: None,
            prepared_assistant: Some(prepared_assistant),
            goal_hooks: None,
            runtime_reminders: reminders,
            context_attachments: options.context_attachments.to_vec(),
            context_extensions: options.context_extensions.to_vec(),
        };

        let mut explorer_error = None;
        let result = async {
            host.publish(ConversationEvent::Started {
                conversation_id: &conversation,
            })
            .await?;
            crate::turn_loop::run(&mut host, options.max_turns, &owned, external).await
        }
        .await;

        let err_code = result.as_ref().err().map(|e| e.0).or_else(|| {
            result
                .as_ref()
                .ok()
                .filter(|r| r.stop == crate::turn_loop::LoopStop::MaxTurns)
                .map(|_| "agent_loop_exhausted")
        });

        host.finalize_prepared_assistant(err_code);

        if err_code.is_none()
            && result
                .as_ref()
                .is_ok_and(|r| r.stop == crate::turn_loop::LoopStop::Replied)
            && let Err(err) = host.drive_requested_explorers().await
        {
            explorer_error = Some(err);
        }

        if err_code.is_none()
            && explorer_error.is_none()
            && host.turns > 0
            && let Some(pipeline) = host.pipeline.as_mut()
        {
            let _ = pipeline.finish(&self.home);
        }

        let cleanup = host.finish().await;
        let final_error = cleanup
            .as_ref()
            .err()
            .copied()
            .or(explorer_error)
            .or_else(|| err_code.map(HostError));
        let stop_reason = result.as_ref().ok().map(|r| r.stop.as_str());
        let content = result
            .as_ref()
            .map(|r| r.content.clone())
            .unwrap_or_default();
        let context_accounting = if final_error.is_none() {
            ConversationStore::new(&self.home)
                .read_metadata(&conversation)
                .ok()
                .and_then(|m| m.metadata)
                .and_then(|v| v.get("contextSnapshot").cloned())
                .filter(|v| !v.is_null())
        } else {
            None
        };
        Ok(ConversationOutcome {
            session_id: conversation,
            content,
            turns: host.turns,
            usage: host.usage.snapshot(),
            lifetime_usage: cleanup.ok().flatten(),
            error: final_error.map(|e| e.0),
            goal: None,
            context_accounting,
            stop_reason,
        })
    }

    /// Drive an existing ordinary GoalPlan using `advance_goal` with interactive user input,
    /// external capabilities, per-tick streaming hooks, and optional desktop visual verification.
    pub async fn drive_goal_plan<'a>(
        &self,
        mut options: GoalPlanRunOptions<'_>,
        model: &'a NativeModel,
        permission: &'a mut dyn PermissionInput,
        output: Option<&'a mut dyn ConversationOutput>,
        mut hooks: Option<&'a mut dyn GoalHostHooks>,
        external: &CancellationToken,
    ) -> Result<GoalPlanRunOutcome, HostError> {
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if options.plan_id.is_empty()
            || options.stream_id.is_empty()
            || options.max_turns == Some(0)
        {
            return Err(HostError("invalid_goal_runner_input"));
        }
        let workspace =
            std::fs::canonicalize(options.workspace).map_err(|_| HostError("invalid_workspace"))?;
        if !workspace.is_dir() || workspace.to_str().is_none() {
            return Err(HostError("invalid_workspace"));
        }
        let at = now();
        let goal_store = GoalStore::new(&self.home);
        let projector = crate::goal_facts::TuiGoalProjector::new(&at).map_err(HostError)?;
        let goal = goal_store
            .observe_plan_for_runner(options.plan_id, &workspace, &projector)
            .map_err(HostError::from)?;
        let plan_snapshot = goal_store.read_local_goal(&goal)?;
        let conversation = plan_snapshot["conversationId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .ok_or(HostError("goal_conversation_invalid"))?
            .to_owned();

        let hooks_cfg = Arc::new(peer_store::HookConfig::observe(&self.home, &workspace)?);
        let skills = Arc::new(peer_store::SkillCatalog::observe(&self.home, &workspace)?);
        let instructions =
            ProjectInstructions::observe_desktop_host(&workspace, &self.home, None, external)
                .map_err(HostError)?;
        let inventory = McpRegistryStore::new(&self.home).read()?;
        let stream = options.stream_id.to_owned();
        let owner = crate::recorder::local_recorder(
            &format!("native-goal-runner-{}", uuid::Uuid::new_v4()),
            &at,
        )
        .await
        .ok_or(HostError("native_recorder_unavailable"))?;
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }

        let store = ConversationStore::new(&self.home);
        store.recover_runtime_usage(None)?;
        let meta = store
            .read_metadata(&conversation)?
            .metadata
            .ok_or(HostError("conversation_unavailable"))?;
        if meta
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || meta
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            return Err(HostError("out_of_scope"));
        }
        if store
            .read_conversation_execution(&conversation)?
            .is_some_and(|r| !r.permits_new_run())
        {
            return Err(HostError("conversation_execution_busy"));
        }

        let context_binding = binding(&meta)?;
        let attribution = json!({
            "id": stream,
            "streamId": stream,
            "at": at,
            "modelProviderId": format!("{}::{}", options.provider_id, model.model_id()),
            "model": model.model_id(),
            "providerName": model.provider(),
            "role": "chat",
        });
        let identity = ConversationExecutionIdentity {
            conversation_id: conversation.clone(),
            stream_id: stream.clone(),
        };
        let credentials = crate::mcp_oauth::CredentialEpoch::open_conversation(
            &self.home,
            &identity,
            &inventory.source_revision,
        )
        .map_err(HostError)?;
        let mut providers = ProviderRegistry::with_extensions(
            &inventory,
            &json!({"recorder": owner}),
            &self.home,
            credentials.clone(),
            skills.clone(),
            crate::providers::ShellHostMode::Conversation,
        )?;
        providers.add_ordinary_tools(RuntimeMode::Goal, true);
        for extra in options.extra_providers.drain(..) {
            providers.register(extra);
        }
        let projection = providers.project_for_mode(RuntimeMode::Goal, options.allowlist)?;
        let pipeline = if meta["modelProviderId"].is_string() && meta["model"].is_string() {
            ContextPipeline::open_bound(&self.home, &conversation, options.provider_id, model)?
        } else {
            ContextPipeline::open(&self.home, &conversation, options.provider_id, model)?
        };
        let initial = store.read_committed(&conversation, None, 8 * 1024 * 1024)?;
        let attempt = self
            .live
            .begin(&identity)
            .map_err(|_| HostError("native_execution_owner_unavailable"))?;
        let intent = NewConversationExecution {
            stream_id: &stream,
            engine: "peer-native",
            owner: &owner,
            attribution: &attribution,
            selected_model: None,
            at: &at,
        };
        let (run, publication) = match store.claim_conversation_execution(&initial, &intent, None) {
            Ok(claimed) => claimed,
            Err(error) => {
                let _ = self.live.close_admission(&identity);
                attempt.finish();
                let _ = self.live.forget_ended(&identity);
                let original = error.error();
                if let Some(cleanup) = error.into_cleanup() {
                    cleanup.close_unstarted(&store, &now())?;
                    return Ok(GoalPlanRunOutcome {
                        plan_id: options.plan_id.to_owned(),
                        conversation_id: conversation,
                        turns: 0,
                        usage: RuntimeUsageAccounting::default().snapshot(),
                        lifetime_usage: None,
                        error: Some(original.code()),
                        goal: None,
                    });
                }
                return Err(original.into());
            }
        };
        let owned = attempt.cancellation();
        let mut expected = initial;
        expected.source_revision = publication
            .advance(
                &conversation,
                expected.history.content_revision,
                &expected.source_revision,
            )?
            .into();

        let mut host = Host {
            home: self.home.clone(),
            store,
            run,
            identity,
            workspace,
            mode: RuntimeMode::Goal,
            effort: options.effort.into(),
            model,
            permission: Some(permission),
            output,
            access: self.access.clone(),
            live: self.live.clone(),
            attempt: Some(attempt),
            owned: owned.clone(),
            external: external.clone(),
            expected,
            binding: context_binding,
            instructions,
            servers: inventory.host_context_servers(),
            registry: inventory.source_revision,
            skills,
            hooks: hooks_cfg,
            credentials,
            providers,
            projection,
            allowlist: options.allowlist.map(<[String]>::to_vec),
            pipeline: Some(pipeline),
            usage: RuntimeUsageAccounting::default(),
            system: None,
            turns: 0,
            request_admitted: false,
            background_shells: BTreeMap::new(),
            completed_shells: BTreeMap::new(),
            foreground_authority: None,
            cognition_source: None,
            interactive_user_input: true,
            worker: None,
            explorer_requests: BTreeSet::new(),
            runner: None,
            prepared_assistant: None,
            goal_hooks: hooks.take(),
            runtime_reminders: Vec::new(),
            context_attachments: Vec::new(),
            context_extensions: Vec::new(),
        };

        let admission = goal_store.begin_ordinary_runner_with_resume(
            &goal,
            &host.identity,
            &now(),
            options.allow_resume,
            || host.source_current().map_err(|error| error.0),
        );

        let lease = match admission {
            Ok(RunnerAdmission::Started(lease)) => lease,
            Ok(RunnerAdmission::Waiting(plan)) => {
                let cleanup = host.finish().await;
                let report = runner::report_value(&plan);
                return Ok(GoalPlanRunOutcome {
                    plan_id: options.plan_id.to_owned(),
                    conversation_id: conversation,
                    turns: 0,
                    usage: host.usage.snapshot(),
                    lifetime_usage: cleanup.ok().flatten(),
                    error: None,
                    goal: Some(report),
                });
            }
            Err(err) => {
                let _ = host.finish().await;
                return Err(err.into());
            }
        };

        host.runner = Some(runner::Runner::new(lease.clone()));
        host.emit_goal_event(GoalRunnerEvent::Started {
            plan_id: options.plan_id,
            conversation_id: &conversation,
        })
        .await;
        host.emit_goal_event(GoalRunnerEvent::PlanChanged {
            plan_id: options.plan_id,
            conversation_id: &conversation,
            change_kind: "runner-state",
        })
        .await;

        let run_result = host
            .advance_goal(&goal_store, &lease, options.max_turns)
            .await;

        host.finalize_prepared_assistant(run_result.as_ref().err().map(|e| e.0));

        if run_result.is_ok()
            && host.turns > 0
            && let Some(pipeline) = host.pipeline.as_mut()
        {
            let _ = pipeline.finish(&self.home);
        }

        let stop = match &run_result {
            Ok(stop) => *stop,
            Err(err) => {
                let paused = options
                    .pause_requested
                    .as_ref()
                    .is_some_and(|flag| flag.load(Ordering::SeqCst))
                    && (external.is_cancelled() || err.0 == "CANCELLED");
                if paused {
                    RunnerStop::Paused
                } else {
                    RunnerStop::Blocked(err.0)
                }
            }
        };

        let cleanup = host.finish().await;
        let goal_report = if cleanup.is_ok() {
            host.settle_runner(stop)
        } else {
            Ok(None)
        };

        host.emit_goal_event(GoalRunnerEvent::PlanChanged {
            plan_id: options.plan_id,
            conversation_id: &conversation,
            change_kind: "runner-state",
        })
        .await;

        if let Ok(Some(ref report)) = goal_report {
            let event_type = match report["runnerStatus"].as_str() {
                Some("completed") => "goalRunner:completed",
                Some("paused") => "goalRunner:paused",
                Some("failed") => "goalRunner:failed",
                _ => "goalRunner:blocked",
            };
            host.emit_goal_event(GoalRunnerEvent::StateChanged {
                plan_id: options.plan_id,
                conversation_id: &conversation,
                event_type,
                detail: report.clone(),
            })
            .await;
        }

        let final_error = cleanup
            .as_ref()
            .err()
            .copied()
            .or_else(|| run_result.as_ref().err().copied())
            .or_else(|| goal_report.as_ref().err().copied());

        Ok(GoalPlanRunOutcome {
            plan_id: options.plan_id.to_owned(),
            conversation_id: conversation,
            turns: host.turns,
            usage: host.usage.snapshot(),
            lifetime_usage: cleanup.ok().flatten(),
            error: final_error.map(|e| e.0),
            goal: goal_report.ok().flatten(),
        })
    }
}
#[cfg(feature = "test-fixtures")]
fn fixture_fault(home: &Path, stage: &str) {
    if home.join(".native-cli-fixture").is_file()
        && std::env::var("PEER_NATIVE_ORDINARY_FAULT").as_deref() == Ok(stage)
    {
        std::process::exit(88);
    }
}
fn binding(meta: &Value) -> Result<String, HostError> {
    peer_protocol::approval_args_digest(&json!({"mode":meta["mode"],"role":meta["role"],"parentConversationId":meta["parentConversationId"],"workspacePath":meta["workspacePath"]})).map_err(|_|HostError("conversation_scope_changed"))
}
struct Host<'a> {
    home: PathBuf,
    store: ConversationStore,
    run: ConversationExecutionToken,
    identity: ConversationExecutionIdentity,
    workspace: PathBuf,
    mode: RuntimeMode,
    effort: String,
    model: &'a NativeModel,
    permission: Option<&'a mut dyn PermissionInput>,
    output: Option<&'a mut dyn ConversationOutput>,
    access: ConversationAccess,
    live: ExecutionRegistry,
    attempt: Option<Attempt>,
    owned: CancellationToken,
    external: CancellationToken,
    expected: HistorySnapshot,
    binding: String,
    instructions: ProjectInstructions,
    servers: Vec<Value>,
    registry: String,
    skills: Arc<peer_store::SkillCatalog>,
    hooks: Arc<peer_store::HookConfig>,
    credentials: crate::mcp_oauth::CredentialEpoch,
    providers: ProviderRegistry,
    projection: RuntimeProjection,
    allowlist: Option<Vec<String>>,
    pipeline: Option<ContextPipeline>,
    usage: RuntimeUsageAccounting,
    system: Option<Value>,
    turns: usize,
    request_admitted: bool,
    background_shells: BTreeMap<String, background_shell::BackgroundShell>,
    completed_shells: BTreeMap<String, crate::providers::EffectOutcome>,
    foreground_authority: Option<foreground_shell::ForegroundAuthority>,
    cognition_source: Option<CognitionSource>,
    interactive_user_input: bool,
    worker: Option<readonly_worker::Worker>,
    explorer_requests: BTreeSet<String>,
    runner: Option<runner::Runner>,
    prepared_assistant: Option<PreparedAssistant>,
    goal_hooks: Option<&'a mut dyn GoalHostHooks>,
    runtime_reminders: Vec<(String, String)>,
    context_attachments: Vec<Value>,
    context_extensions: Vec<Value>,
}
struct PreparedAssistant {
    message_id: String,
    content: String,
    thinking_content: String,
    segments: Vec<Value>,
    permission_grants: Vec<Value>,
    started_at_ms: i64,
}
struct CognitionSource {
    revision: String,
    content_revision: u64,
}
impl Host<'_> {
    pub(super) fn finalize_prepared_assistant(&mut self, err_code: Option<&str>) {
        let Some(mut pa) = self.prepared_assistant.take() else {
            return;
        };
        let ended_ms = crate::capability::milliseconds(&now()).unwrap_or(pa.started_at_ms);
        let duration_ms = (ended_ms - pa.started_at_ms).max(0);
        let interrupted = err_code.is_some();
        for seg in &mut pa.segments {
            if seg["type"] == "tool-call" && seg.get("result").is_none() {
                if let Some(code) = err_code {
                    let tc_id = seg["toolCallId"].as_str().unwrap_or("").to_owned();
                    let status = if code == "CANCELLED" {
                        "cancelled"
                    } else {
                        "failed"
                    };
                    seg["result"] = json!({
                        "toolCallId": tc_id,
                        "status": status,
                        "output": {},
                        "error": { "code": code, "message": code, "recoverable": true },
                        "completedAt": now(),
                    });
                } else {
                    seg["result"] = json!("工具结果未返回（本轮已结束）");
                }
            }
        }
        let mut terminal_patch = json!({
            "durationMs": duration_ms,
            "interrupted": interrupted,
            "segments": pa.segments,
            "streamId": self.identity.stream_id,
        });
        if interrupted {
            if let Some(code) = err_code {
                terminal_patch["streamFailure"] = json!({ "code": code });
            }
        } else {
            terminal_patch["streamFailure"] = Value::Null;
        }
        let amounts = &self.usage.snapshot().turn_total.amounts;
        if amounts.input_tokens > 0
            || amounts.output_tokens > 0
            || amounts.cache_read_tokens > 0
            || amounts.cache_write_tokens > 0
        {
            terminal_patch["usage"] = json!({
                "inputTokens": amounts.input_tokens,
                "outputTokens": amounts.output_tokens,
                "cacheWriteTokens": amounts.cache_write_tokens,
                "cacheReadTokens": amounts.cache_read_tokens,
                "totalTokens": amounts.total_tokens,
            });
        }
        if let Ok(fresh) =
            self.store
                .read_committed(&self.identity.conversation_id, None, 8 * 1024 * 1024)
        {
            let expected_matches = fresh.source_revision == self.expected.source_revision
                && fresh.history.content_revision == self.expected.history.content_revision;
            if let Ok(committed) = self.store.commit_terminal_message(
                &fresh,
                &pa.message_id,
                &terminal_patch,
                &now(),
                None,
            ) && expected_matches
            {
                self.expected = committed.snapshot;
            }
        }
    }

    pub(super) async fn emit_goal_event(&mut self, event: GoalRunnerEvent<'_>) {
        if let Some(hooks) = self.goal_hooks.take() {
            hooks.on_goal_event(event).await;
            self.goal_hooks = Some(hooks);
        }
    }

    pub(super) async fn run_visual_verification_hook(
        &mut self,
        plan_id: &str,
        conversation_id: &str,
        verifier_run_id: &str,
        workspace: &Path,
        cancel: &CancellationToken,
    ) -> Result<VisualVerificationOutcome, HostError> {
        let Some(hooks) = self.goal_hooks.take() else {
            return Ok(VisualVerificationOutcome {
                required: false,
                passed: true,
                report: Value::Null,
            });
        };
        let result = hooks
            .run_visual_verification(plan_id, conversation_id, verifier_run_id, workspace, cancel)
            .await;
        self.goal_hooks = Some(hooks);
        result
    }

    async fn publish(&mut self, event: ConversationEvent<'_>) -> Result<(), HostError> {
        if let Some(output) = self.output.take() {
            let result = if self.background_shells.is_empty() && self.foreground_authority.is_none()
            {
                output.publish(event).await
            } else {
                self.wait_owned(output.publish(event)).await.and_then(|r| r)
            };
            self.output = Some(output);
            result?;
        }
        Ok(())
    }
    fn authority(&self) -> Result<(), HostError> {
        if self.owned.is_cancelled() || self.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        self.hooks
            .check_current()
            .map_err(|_| HostError("native_hook_source_changed"))?;
        self.skills
            .check_current()
            .map_err(|_| HostError("native_skill_source_changed"))?;
        let run = self
            .store
            .read_conversation_execution(&self.identity.conversation_id)?
            .ok_or(HostError("conversation_execution_changed"))?;
        if run.identity != self.identity
            || run.owner != *self.run.owner()
            || run.phase != ConversationExecutionPhase::Active
        {
            return Err(HostError("conversation_execution_changed"));
        }
        if !self
            .live
            .admission_open(&self.identity)
            .map_err(|_| HostError("native_execution_owner_unknown"))?
        {
            return Err(HostError("native_execution_owner_unknown"));
        }
        let meta = self
            .store
            .read_metadata(&self.identity.conversation_id)?
            .metadata
            .ok_or(HostError("conversation_unavailable"))?;
        if binding(&meta)? != self.binding {
            return Err(HostError("conversation_scope_changed"));
        }
        self.credentials.check().map_err(HostError)?;
        self.check_worker()?;
        self.check_runner()?;
        self.validate_foreground_authority()
    }
    fn source_current(&self) -> Result<(), HostError> {
        self.source_matches(
            &self.expected.source_revision,
            self.expected.history.content_revision,
        )
    }
    fn source_matches(&self, revision: &str, content_revision: u64) -> Result<(), HostError> {
        self.authority()?;
        let fresh =
            self.store
                .read_committed(&self.identity.conversation_id, None, 8 * 1024 * 1024)?;
        if fresh.source_revision != revision || fresh.history.content_revision != content_revision {
            return Err(HostError("CONTEXT_SNAPSHOT_CHANGED"));
        }
        Ok(())
    }
    fn publication(&mut self, receipt: ConversationMetadataPublication) -> Result<(), HostError> {
        self.expected.source_revision = receipt
            .advance(
                &self.identity.conversation_id,
                self.expected.history.content_revision,
                &self.expected.source_revision,
            )?
            .into();
        Ok(())
    }
    fn append(&mut self, message: &Value) -> Result<(), HostError> {
        self.source_current()?;
        let tagged = self.worker.as_ref().map(|worker| {
            let mut message = message.clone();
            message["kind"] = json!("agent_activity");
            message[worker.lease.tag()] = json!(worker.lease.id());
            message["nativeGoalPlanId"] = json!(worker.lease.plan_id());
            message
        });
        self.expected = self
            .store
            .commit_message(
                &self.expected,
                tagged.as_ref().unwrap_or(message),
                &now(),
                None,
            )?
            .snapshot;
        Ok(())
    }
    async fn wait_owned<F: std::future::Future>(
        &mut self,
        future: F,
    ) -> Result<F::Output, HostError> {
        tokio::pin!(future);
        let mut stopped = None;
        let mut tick = tokio::time::interval(Duration::from_millis(100));
        tick.tick().await;
        loop {
            tokio::select! {biased;
                _=self.external.cancelled(),if stopped.is_none()=>{self.owned.cancel();stopped=Some(HostError("CANCELLED"));},
                _=tick.tick(),if stopped.is_none()=>{
                    self.check_background_shells();
                    if let Err(e)=self.authority(){self.owned.cancel();stopped=Some(e);}
                },
                result=&mut future=>return match stopped {Some(e)=>Err(e),None=>Ok(result)},
            }
        }
    }
    async fn finish(&mut self) -> Result<Option<Value>, HostError> {
        // The shared loop and all model-observation callbacks have returned.
        // Closing admission cannot replace their actual completion.
        let closing = self
            .store
            .stop_conversation_admission(&mut self.run, &now());
        self.owned.cancel();
        let closed = self
            .live
            .close_admission(&self.identity)
            .map_err(|_| HostError("native_execution_stop_unproven"));
        if let Some(attempt) = self.attempt.take() {
            attempt.finish();
        }
        let drained = self
            .live
            .drain(&self.identity, Duration::from_secs(5))
            .await;
        let stopped = async {
            closing?;
            closed?;
            drained.map_err(|_| HostError("native_execution_stop_unproven"))?;
            self.reap_background_shells(false).await?;
            for (handle, _, state) in self
                .live
                .handle_observations(&self.identity)
                .map_err(|_| HostError("native_execution_stop_unproven"))?
            {
                if state != "ended" {
                    return Err(HostError("native_execution_stop_unproven"));
                }
                self.record_foreground_shell_end(&handle, false)?;
                self.store
                    .end_conversation_handle(&mut self.run, &handle, &now())?;
                self.live
                    .acknowledge_ended_handle(&self.identity, &handle)
                    .map_err(|_| HostError("native_execution_stop_unproven"))?;
            }
            let owner = self.run.owner().clone();
            self.store.finish_conversation_execution(
                &mut self.run,
                &peer_protocol::ConversationStopObservation {
                    owner,
                    observed_at: now(),
                    runner_idle: true,
                    admission_closed: true,
                    handles_ended: true,
                },
                &now(),
            )?;
            Ok::<_, HostError>(())
        }
        .await;
        #[cfg(feature = "test-fixtures")]
        fixture_fault(&self.home, "before_billing");
        // Known charges remain accountable even if a tool/connection stop is unproven.
        let billing = (|| -> Result<Option<Value>, HostError> {
            let receipt = self.store.commit_conversation_usage(&self.run)?;
            let lifetime = receipt.receipt().map(|r| r["lifetimeUsage"].clone());
            self.store
                .acknowledge_conversation_usage(&mut self.run, receipt, &now())?;
            Ok(lifetime)
        })();
        stopped?;
        let lifetime = billing?;
        self.live
            .forget_ended(&self.identity)
            .map_err(|_| HostError("native_execution_stop_unproven"))?;
        Ok(lifetime)
    }
}
impl CognitionHost for Host<'_> {
    fn authority(&self) -> Result<(), HostError> {
        self.authority()
    }
    fn check_request(&self) -> Result<(), HostError> {
        self.authority()
    }
    fn admit_request(&mut self, capacity_bearing: bool) -> Result<(), HostError> {
        // Called only for a real physical request. Model retries are still one
        // logical turn; accounting independently counts every physical response.
        if !self.request_admitted {
            let counter = if capacity_bearing {
                &mut self.turns
            } else if let Some(worker) = &mut self.worker {
                &mut worker.turns
            } else {
                return Ok(());
            };
            *counter = counter
                .checked_add(1)
                .ok_or(HostError("runtime_counter_limit"))?;
            self.request_admitted = true;
        }
        Ok(())
    }
    fn assemble(&self, continuity: &[Value]) -> Result<Value, HostError> {
        if let Some(worker) = &self.worker {
            let workspace = self
                .workspace
                .to_str()
                .ok_or(HostError("invalid_workspace"))?;
            let provider = self.model.provider();
            let model = self.model.model_id();
            let conversation = &self.identity.conversation_id;
            let at = now();
            return match &worker.lease {
                readonly_worker::WorkerLease::Explorer(lease) => {
                    crate::system_context::explorer::assemble(
                        workspace,
                        provider,
                        model,
                        conversation,
                        lease,
                        &at,
                    )
                }
                readonly_worker::WorkerLease::Verifier(lease) => {
                    crate::system_context::verifier::assemble(
                        workspace,
                        provider,
                        model,
                        conversation,
                        lease,
                        &at,
                    )
                }
            }
            .map_err(HostError);
        }
        let registry_path = std::path::absolute(self.home.join("mcp-registry.json"))
            .map_err(|_| HostError("invalid_data_home"))?;
        assemble_conversation_context(
            &ConversationContext {
                conversation: &self.identity.conversation_id,
                workspace: self
                    .workspace
                    .to_str()
                    .ok_or(HostError("invalid_workspace"))?,
                provider: self.model.provider(),
                model: self.model.model_id(),
                mode: self.mode,
                effort: &self.effort,
                registry_path: registry_path
                    .to_str()
                    .ok_or(HostError("invalid_data_home"))?,
                servers: &self.servers,
                skill_names: &self.projection.skill_names(),
                instructions: &self.instructions,
                goal_runner: self
                    .runner
                    .as_ref()
                    .and_then(|runner| runner.frame.as_ref().map(|(_, plan)| plan)),
                runtime_reminders: &self.runtime_reminders,
                context_attachments: &self.context_attachments,
                context_extensions: &self.context_extensions,
            },
            continuity,
            &now(),
        )
        .map_err(HostError)
    }
    fn request_input(&self, projected: &Value) -> Option<(usize, &str)> {
        self.runner_request_input(projected)
    }
    fn observe(
        &mut self,
        accounting: &mut RuntimeUsageAccounting,
        observed: ModelObservation,
        capacity: bool,
    ) -> Result<Option<ConversationMetadataPublication>, HostError> {
        let unknown = observed.usage.is_none() || observed.invalid;
        let invalid = observed.invalid;
        accounting
            .observe(
                observed.usage,
                RequestMetadata {
                    fingerprint: observed.fingerprint.as_deref(),
                    purpose: if capacity || self.worker.is_some() {
                        UsagePurpose::Agent
                    } else {
                        UsagePurpose::CompactionSummary
                    },
                    capacity_bearing: capacity,
                },
            )
            .map_err(HostError)?;
        let receipt = self.store.observe_conversation_usage(
            &mut self.run,
            &accounting.snapshot().turn_total,
            unknown,
            &now(),
        )?;
        if invalid {
            return Err(HostError("native_usage_invalid"));
        }
        Ok(Some(receipt))
    }
    fn advance_owned_source(
        &mut self,
        previous: &str,
        revision: &str,
        content_revision: u64,
    ) -> Result<(), HostError> {
        if let Some(current) = &mut self.cognition_source {
            if current.revision != previous {
                self.owned.cancel();
                return Err(HostError("CONTEXT_SNAPSHOT_CHANGED"));
            }
            current.revision = revision.into();
            current.content_revision = content_revision;
        }
        Ok(())
    }
    async fn wait<F: std::future::Future>(
        &mut self,
        future: F,
        _owned: &CancellationToken,
        _external: &CancellationToken,
    ) -> Result<F::Output, HostError> {
        self.wait_owned(future).await
    }
    async fn send_prepared(
        &mut self,
        prepared: PreparedRequest<'_>,
        request: &CognitionRequest<'_>,
        observed: &mut Option<ModelObservation>,
        primary: bool,
    ) -> Result<Result<ModelTurn, ModelError>, HostError> {
        let mut output = self.output.take();
        let show_delta = primary && self.worker.is_none();
        let result = self
            .wait_owned(async {
                let result = prepared
                    .send_with_deltas(
                        request.owned,
                        async |delta: crate::model::ModelDelta<'_>| {
                            if show_delta && let Some(output) = output.as_mut() {
                                let event = match delta {
                                    crate::model::ModelDelta::Text(text) => {
                                        ConversationEvent::AssistantDelta(text)
                                    }
                                    crate::model::ModelDelta::Thinking(thinking) => {
                                        ConversationEvent::ThinkingDelta(thinking)
                                    }
                                };
                                output
                                    .publish(event)
                                    .await
                                    .map_err(|error| ModelError::new(error.0))?;
                            }
                            Ok(())
                        },
                    )
                    .await;
                *observed = Some(ModelObservation::capture(&result));
                result
            })
            .await;
        self.output = output;
        result
    }
}
impl crate::turn_loop::TurnHost for Host<'_> {
    async fn request(&mut self) -> Result<ModelTurn, HostError> {
        self.source_current()?;
        self.prepare_runner_frame()?;
        self.request_admitted = false;
        let mut pipeline = self
            .pipeline
            .take()
            .ok_or(HostError("native_pipeline_unavailable"))?;
        let mut usage = std::mem::take(&mut self.usage);
        let home = self.home.clone();
        let model = self.model;
        let tools = match &self.worker {
            Some(worker) if worker.format_repair => json!([]),
            Some(worker) => worker.projection.definitions(),
            None => self.projection.definitions(),
        };
        let owned = self.owned.clone();
        let external = self.external.clone();
        self.cognition_source = (!self.background_shells.is_empty()).then(|| CognitionSource {
            revision: self.expected.source_revision.clone(),
            content_revision: self.expected.history.content_revision,
        });
        let request = CognitionRequest {
            home: &home,
            model,
            tools: &tools,
            owned: &owned,
            external: &external,
        };
        let response = async {
            if self.worker.is_some() {
                let projected = self.project_active_history()?;
                let history = self.store.read_committed(
                    &self.identity.conversation_id,
                    None,
                    8 * 1024 * 1024,
                )?;
                if history.source_revision != self.expected.source_revision {
                    return Err(HostError("CONTEXT_SNAPSHOT_CHANGED"));
                }
                pipeline
                    .request_explorer(self, &request, &mut usage, &history, &projected)
                    .await
            } else {
                pipeline.request(self, &request, &mut usage).await
            }
        }
        .await;
        self.cognition_source = None;
        if let Some(runner) = &mut self.runner {
            runner.frame = None;
        }
        self.pipeline = Some(pipeline);
        self.usage = usage;
        let response = response?;
        self.expected = response.history;
        self.system = Some(response.system);
        if self.worker.is_none() {
            let usage_snapshot = self.usage.snapshot();
            self.publish(ConversationEvent::Usage(&usage_snapshot))
                .await?;
        }
        Ok(response.turn)
    }
    async fn record_assistant(&mut self, turn: &ModelTurn) -> Result<(), HostError> {
        let system = self
            .system
            .take()
            .ok_or(HostError("context_response_unavailable"))?;
        if self.worker.is_none()
            && let Some(mut pa) = self.prepared_assistant.take()
        {
            if !turn.thinking.is_empty() {
                pa.thinking_content.push_str(&turn.thinking);
                pa.segments
                    .push(json!({"type": "thinking", "content": turn.thinking}));
            }
            if !turn.content.is_empty() {
                pa.content.push_str(&turn.content);
                pa.segments
                    .push(json!({"type": "text", "content": turn.content}));
            }
            let mut patch = json!({
                "content": pa.content,
                "segments": pa.segments,
                "streamId": self.identity.stream_id,
                "contextSnapshot": system["snapshot"],
                "requestFingerprint": turn.request_fingerprint,
            });
            if !pa.thinking_content.is_empty() {
                patch["thinkingContent"] = json!(pa.thinking_content);
            }
            let message_id = pa.message_id.clone();
            self.source_current()?;
            self.expected = self
                .store
                .commit_terminal_message(&self.expected, &message_id, &patch, &now(), None)?
                .snapshot;
            self.prepared_assistant = Some(pa);
        } else {
            let mut record = json!({"id":format!("message-{}",uuid::Uuid::new_v4()),"role":"assistant","content":turn.content,"createdAt":now(),"streamId":self.identity.stream_id,"contextSnapshot":system["snapshot"],"requestFingerprint":turn.request_fingerprint});
            crate::turn_loop::apply_assistant_thinking(&mut record, turn);
            self.append(&record)?;
        }
        if !turn.content.is_empty() {
            self.publish(ConversationEvent::AssistantText(&turn.content))
                .await?;
        }
        Ok(())
    }
    async fn execute_call(
        &mut self,
        call: ModelToolCall,
    ) -> Result<crate::turn_loop::ToolStep, HostError> {
        self.tool(call).await
    }
    async fn completed(
        &mut self,
        continuation: Option<ModelContinuation>,
        ids: &[String],
    ) -> Result<(), HostError> {
        self.source_current()?;
        let projected = self.project_active_history()?;
        self.pipeline
            .as_mut()
            .ok_or(HostError("native_pipeline_unavailable"))?
            .live
            .remember(&projected, ids, continuation)
            .map_err(|e| HostError(e.code))
    }
}

#[cfg(test)]
mod tests;
