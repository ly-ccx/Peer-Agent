//! Ordinary conversation Host over the same cognition, turn and Provider seams.
//! A conversation/stream is its actual principal; no Goal/Work is synthesized.
use crate::{
    CancellationToken,
    capability::{CapabilityError as HostError, now},
    cognition::{CognitionHost, CognitionRequest, ContextPipeline},
    live_execution::{Attempt, ExecutionRegistry},
    model::{ModelContinuation, ModelObservation, ModelToolCall, ModelTurn, NativeModel},
    providers::{ProviderRegistry, RuntimeMode, RuntimeProjection},
    session_host::{LocalPermissionDecision, PermissionInput},
    system_context::{
        ConversationContext, assemble_conversation_context, instructions::ProjectInstructions,
    },
    usage_accounting::{RequestMetadata, RuntimeUsageAccounting, UsageSnapshot},
};
use peer_protocol::{
    ConversationExecutionIdentity, ConversationExecutionPhase, LocalAccessLevel, UsagePurpose,
};
use peer_store::{
    ConversationExecutionToken, ConversationMetadataPublication, ConversationModelSelection,
    ConversationStore, HistorySnapshot, McpRegistryStore, NewConversation,
    NewConversationExecution,
};
use serde_json::{Value, json};
use std::{
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
mod effect;
mod permission;
mod recovery;
mod tool;
use permission::ToolGrant;

/// Host-owned live access revision. UI/ACP commands change this actual authority;
/// persisted approval history alone never constructs it or a ToolGrant.
#[derive(Clone)]
pub struct ConversationAccess(Arc<Mutex<(LocalAccessLevel, u64)>>);
impl ConversationAccess {
    pub fn new(level: LocalAccessLevel) -> Self {
        Self(Arc::new(Mutex::new((level, 0))))
    }
    pub fn set(&self, level: LocalAccessLevel) -> Result<(), HostError> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| HostError("permission_unavailable"))?;
        if state.0 != level {
            state.1 = state
                .1
                .checked_add(1)
                .filter(|n| *n <= 9_007_199_254_740_991)
                .ok_or(HostError("permission_revision_limit"))?;
            state.0 = level;
        }
        Ok(())
    }
    fn snapshot(&self) -> Result<(LocalAccessLevel, u64), HostError> {
        self.0
            .lock()
            .map(|s| *s)
            .map_err(|_| HostError("permission_unavailable"))
    }
}
pub struct ConversationOptions<'a> {
    pub workspace: &'a Path,
    pub conversation_id: Option<&'a str>,
    pub prompt: &'a str,
    pub provider_id: &'a str,
    pub mode: RuntimeMode,
    pub effort: &'a str,
    pub persist_model_selection: bool,
    pub allowlist: Option<&'a [String]>,
    pub max_turns: Option<usize>,
}
pub struct ConversationOutcome {
    pub session_id: String,
    pub content: String,
    pub turns: usize,
    pub usage: UsageSnapshot,
    pub lifetime_usage: Option<Value>,
    pub error: Option<&'static str>,
}
/// Facts already accepted by the ordinary Host. Rendering these events does
/// not own the execution or grant permission.
pub enum ConversationEvent<'a> {
    Started { conversation_id: &'a str },
    AssistantText(&'a str),
    ToolPrepared { call_id: &'a str, tool: &'a str },
    ToolSettled { call_id: &'a str, status: &'a str },
}
pub trait ConversationOutput {
    fn publish<'a>(
        &'a mut self,
        event: ConversationEvent<'a>,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), HostError>> + 'a>>;
}
/// One Host instance owns the bounded live registry across ordinary sessions.
/// Discovery is read-only. A dropped runner stays unknown, never implicitly idle.
pub struct NativeConversationRuntime {
    home: PathBuf,
    live: ExecutionRegistry,
    access: ConversationAccess,
}
// These are the actual legacy CLI discovery roots (SkillStore and Node hooks).
// Until their native adapters are wired, an existing configuration must not be
// silently omitted from an ordinary request or tool execution.
fn require_migrated_extensions(home: &Path, workspace: &Path) -> Result<(), HostError> {
    for file in [
        home.join("hooks/hooks.json"),
        workspace.join(".peer/hooks.json"),
    ] {
        match std::fs::symlink_metadata(file) {
            Ok(_) => return Err(HostError("native_hooks_not_migrated")),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(HostError("native_extension_inventory_unavailable")),
        }
    }
    for directory in [home.join("skills"), workspace.join("skills")] {
        match std::fs::read_dir(directory) {
            Ok(mut entries) => {
                if entries.next().is_some() {
                    return Err(HostError("native_skills_not_migrated"));
                }
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return Err(HostError("native_extension_inventory_unavailable")),
        }
    }
    Ok(())
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
    pub async fn execute(
        &self,
        options: &ConversationOptions<'_>,
        model: &NativeModel,
        permission: &mut dyn PermissionInput,
        external: &CancellationToken,
    ) -> Result<ConversationOutcome, HostError> {
        self.execute_observed(options, model, permission, None, external)
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
        if external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        if peer_protocol::javascript_trim(options.prompt).is_empty()
            || options.prompt.len() > 1024 * 1024
            || options.max_turns == Some(0)
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
        require_migrated_extensions(&self.home, &workspace)?;
        let instructions = ProjectInstructions::observe_host(&workspace, &self.home, external)
            .map_err(HostError)?;
        let inventory = McpRegistryStore::new(&self.home).read()?;
        let at = now();
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
                    title: &options.prompt.chars().take(80).collect::<String>(),
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
        let providers = ProviderRegistry::with_mcp(
            &inventory,
            &json!({"recorder":owner}),
            &self.home,
            credentials.clone(),
        )?;
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
        let claimed = store.claim_conversation_execution(
            &initial,
            &NewConversationExecution {
                stream_id: &stream,
                engine: "peer-native",
                owner: &owner,
                attribution: &attribution,
                selected_model: selected.as_ref(),
                at: &at,
            },
            None,
        );
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
            credentials,
            providers,
            projection,
            pipeline: Some(pipeline),
            usage: RuntimeUsageAccounting::default(),
            system: None,
            turns: 0,
            request_admitted: false,
        };
        let result=async {
            host.append(&json!({"id":format!("message-{}",uuid::Uuid::new_v4()),"role":"user","content":options.prompt,"createdAt":at}))?;
            host.publish(ConversationEvent::Started { conversation_id: &conversation }).await?;
            crate::turn_loop::run(&mut host,options.max_turns,&owned,external).await
        }.await;
        let cleanup = host.finish().await;
        let error = cleanup
            .as_ref()
            .err()
            .copied()
            .or_else(|| result.as_ref().err().copied())
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
        Ok(ConversationOutcome {
            session_id: conversation,
            content,
            turns: host.turns,
            usage: host.usage.snapshot(),
            lifetime_usage: cleanup.ok().flatten(),
            error: error.map(|e| e.0),
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
    credentials: crate::mcp_oauth::CredentialEpoch,
    providers: ProviderRegistry,
    projection: RuntimeProjection,
    pipeline: Option<ContextPipeline>,
    usage: RuntimeUsageAccounting,
    system: Option<Value>,
    turns: usize,
    request_admitted: bool,
}
impl Host<'_> {
    async fn publish(&mut self, event: ConversationEvent<'_>) -> Result<(), HostError> {
        if let Some(output) = &mut self.output {
            output.publish(event).await?;
        }
        Ok(())
    }
    fn authority(&self) -> Result<(), HostError> {
        if self.owned.is_cancelled() || self.external.is_cancelled() {
            return Err(HostError("CANCELLED"));
        }
        require_migrated_extensions(&self.home, &self.workspace)?;
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
        Ok(())
    }
    fn source_current(&self) -> Result<(), HostError> {
        self.authority()?;
        let fresh =
            self.store
                .read_committed(&self.identity.conversation_id, None, 8 * 1024 * 1024)?;
        if fresh.source_revision != self.expected.source_revision
            || fresh.history.content_revision != self.expected.history.content_revision
        {
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
        self.expected = self
            .store
            .commit_message(&self.expected, message, &now(), None)?
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
                _=tick.tick(),if stopped.is_none()=>{if let Err(e)=self.authority(){self.owned.cancel();stopped=Some(e);}},
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
            for (handle, _, state) in self
                .live
                .handle_observations(&self.identity)
                .map_err(|_| HostError("native_execution_stop_unproven"))?
            {
                if state != "ended" {
                    return Err(HostError("native_execution_stop_unproven"));
                }
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
        if capacity_bearing && !self.request_admitted {
            self.turns = self
                .turns
                .checked_add(1)
                .ok_or(HostError("runtime_counter_limit"))?;
            self.request_admitted = true;
        }
        Ok(())
    }
    fn assemble(&self, continuity: &[Value]) -> Result<Value, HostError> {
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
                instructions: &self.instructions,
            },
            continuity,
            &now(),
        )
        .map_err(HostError)
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
                    purpose: if capacity {
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
    async fn wait<F: std::future::Future>(
        &mut self,
        future: F,
        _owned: &CancellationToken,
        _external: &CancellationToken,
    ) -> Result<F::Output, HostError> {
        self.wait_owned(future).await
    }
}
impl crate::turn_loop::TurnHost for Host<'_> {
    async fn request(&mut self) -> Result<ModelTurn, HostError> {
        self.source_current()?;
        self.request_admitted = false;
        let mut pipeline = self
            .pipeline
            .take()
            .ok_or(HostError("native_pipeline_unavailable"))?;
        let mut usage = std::mem::take(&mut self.usage);
        let home = self.home.clone();
        let model = self.model;
        let tools = self.projection.definitions();
        let owned = self.owned.clone();
        let external = self.external.clone();
        let response = pipeline
            .request(
                self,
                &CognitionRequest {
                    home: &home,
                    model,
                    tools: &tools,
                    owned: &owned,
                    external: &external,
                },
                &mut usage,
            )
            .await;
        self.pipeline = Some(pipeline);
        self.usage = usage;
        let response = response?;
        self.expected = response.history;
        self.system = Some(response.system);
        Ok(response.turn)
    }
    async fn record_assistant(&mut self, turn: &ModelTurn) -> Result<(), HostError> {
        let system = self
            .system
            .take()
            .ok_or(HostError("context_response_unavailable"))?;
        self.append(&json!({"id":format!("message-{}",uuid::Uuid::new_v4()),"role":"assistant","content":turn.content,"createdAt":now(),"streamId":self.identity.stream_id,"contextSnapshot":system["snapshot"],"requestFingerprint":turn.request_fingerprint}))?;
        if !turn.content.is_empty() {
            self.publish(ConversationEvent::AssistantText(&turn.content))
                .await?;
        }
        Ok(())
    }
    async fn execute_call(&mut self, call: ModelToolCall) -> Result<String, HostError> {
        self.tool(call).await
    }
    async fn completed(
        &mut self,
        continuation: Option<ModelContinuation>,
        ids: &[String],
    ) -> Result<(), HostError> {
        self.source_current()?;
        let projected = crate::canonical_history::project_history(&self.expected.history.messages)
            .map_err(HostError)?;
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
