//! Native Project Agent Host composition root (ADR 80, ADR 85, ADR 88, ADR 129–131).
//!
//! Coordinates `ProjectRegistry`, `BotProfileStore`, `HostLeaseStore`, `InputQueue`,
//! `InputDraftStore`, `ProjectInbox`, `ApprovalStore`, `MemoryStore`, `ObjectiveStore`,
//! `WatchHost`, `SessionSupervisor`, `ProjectAgentRunner`, and `BotDirectory`.

use crate::{
    AcceptanceDecision, AgentTurnOutcome, BotDirectory, BotProfile, BotProfileStore,
    ConversationSearchHit, ConversationSearchIndex, CoordinationHub, CreateBotProfile, DigestQueue,
    ExecutionObligationService, HandoffOutcome, InputDraftStore, InputQueue,
    InteractiveResultStore, MemoryCurator, MemoryFilter, MemoryMaintenance, MemoryStore,
    ObjectiveActionItem, ObjectiveActions, ObjectiveStore, ProjectError, ProjectInbox,
    ProjectInput, ProjectRecoveryBarrier, ProjectRegistry, ProjectRegistryEntry, QuestionState,
    RecoveryDiagnostic, SessionSupervisor, SpawnCriterion, SpawnSessionRequest, SubmitInputRequest,
    WatchHost, WatchPublisher, build_session_report, collect_conversation_search_documents,
    get_session_projected, handoff_question_id, is_handoff_conflict, now_iso, parse_iso_ms,
    project_completion_review_for_plan,
    runner::{ProjectAgentRunner, RunTurnOptions},
    task_result_references,
};
use peer_protocol::interactive_result::{
    InteractiveOwner, InteractiveResultReference, InteractiveResultSummary,
};
use peer_runtime::{
    CancellationToken,
    model::NativeModel,
    session_host::{EpisodeOutcome, PermissionInput},
};
use peer_store::{
    AcquireLease, ApprovalStore, ConversationStore, HostIdentity, HostLeaseRecord, HostLeaseStore,
    HostSurface, NewProjectConversation, PolicyStore, StoreError, read_interactive_result,
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::Arc,
};

pub const FAMILIARIZE_READ_CAPABILITIES: [&str; 5] = [
    "local.file.list",
    "local.file.read",
    "local.git.query",
    "local.file.search",
    "local.search.aggregate",
];
pub const RESPONSIBILITY_QUESTION: &str = "这个机器人主要负责什么";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FamiliarizeKind {
    Blank,
    Research { session_id: Option<String> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StartFamiliarizeResult {
    pub kind: FamiliarizeKind,
    pub reused: bool,
}

fn read_git_head_snapshot(ws_path: &Path) -> Option<(String, Option<String>)> {
    let git_dir = ws_path.join(".git");
    if !git_dir.is_dir() {
        return None;
    }
    let head = fs::read_to_string(git_dir.join("HEAD")).ok()?;
    let ref_path = head.trim().strip_prefix("ref:")?.trim();
    let branch = ref_path.strip_prefix("refs/heads/")?.trim();
    if branch.is_empty() {
        return None;
    }
    let commit = fs::read_to_string(git_dir.join(ref_path))
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    Some((branch.to_owned(), commit))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LeaseStatus {
    Acquired { took_over: bool },
    HeldByOther(HostLeaseRecord),
}

#[derive(Debug, Clone)]
pub struct HostTickReport {
    pub workspace_id: String,
    pub held_lease: bool,
    pub inputs_consumed: usize,
    pub bot_turns_run: usize,
    pub sessions_promoted: usize,
    pub sessions_executed: usize,
    pub wake_turns_run: usize,
    pub last_turn: Option<AgentTurnOutcome>,
}

#[derive(Debug, Clone)]
pub struct ForegroundTickReport {
    pub workspace_id: String,
    pub held_lease: bool,
    pub inputs_consumed: usize,
    pub bot_turns_run: usize,
    pub promoted_session_ids: Vec<String>,
    pub wake_turns_run: usize,
    pub last_turn: Option<AgentTurnOutcome>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaintenanceReport {
    pub watchdog_events: usize,
    pub watch_observations: usize,
    pub watch_signals: usize,
    pub memory_maintained_ids: Vec<String>,
    pub curator_learned_ids: Vec<String>,
    pub flushed_digest: bool,
}

pub struct NativeProjectHost {
    data_home: PathBuf,
    host_identity: HostIdentity,
    registry: ProjectRegistry,
    profiles: BotProfileStore,
    leases: HostLeaseStore,
    coordination: Arc<CoordinationHub>,
    recovery: ProjectRecoveryBarrier,
    watch_publisher: WatchPublisher,
    inputs: InputQueue,
    drafts: InputDraftStore,
    inbox: ProjectInbox,
    approvals: ApprovalStore,
    memory: MemoryStore,
    memory_maintenance: MemoryMaintenance,
    memory_curator: MemoryCurator,
    objectives: ObjectiveStore,
    objective_actions: ObjectiveActions,
    watches: WatchHost,
    supervisor: Arc<SessionSupervisor>,
    runner: ProjectAgentRunner,
    directory: BotDirectory,
    conversations: ConversationStore,
    digests: DigestQueue,
    interactive_results: InteractiveResultStore,
}

impl NativeProjectHost {
    pub fn new(
        data_home: impl AsRef<Path>,
        app_version: &str,
        concurrency: Option<usize>,
    ) -> Result<Self, ProjectError> {
        Self::new_for_surface(data_home, HostSurface::Tui, app_version, concurrency)
    }

    pub fn new_for_surface(
        data_home: impl AsRef<Path>,
        surface: HostSurface,
        app_version: &str,
        concurrency: Option<usize>,
    ) -> Result<Self, ProjectError> {
        let home = data_home.as_ref().to_path_buf();
        let prefix = match surface {
            HostSurface::Desktop => "desktop",
            HostSurface::Tui => "tui",
        };
        let host_identity = HostIdentity::new(
            &format!("{prefix}-{}", uuid::Uuid::new_v4()),
            surface,
            std::process::id(),
            app_version,
        )?;
        let supervisor = Arc::new(SessionSupervisor::new(&home, concurrency));
        let coordination = Arc::new(CoordinationHub::new());
        let runner = ProjectAgentRunner::with_coordination(
            &home,
            Arc::clone(&supervisor),
            Arc::clone(&coordination),
        );
        Ok(Self {
            registry: ProjectRegistry::new(&home),
            profiles: BotProfileStore::new(&home),
            leases: HostLeaseStore::new(&home),
            coordination,
            recovery: ProjectRecoveryBarrier::new(&home),
            watch_publisher: WatchPublisher::new(),
            inputs: InputQueue::new(&home),
            drafts: InputDraftStore::new(&home),
            inbox: ProjectInbox::new(&home),
            approvals: ApprovalStore::new(&home),
            memory: MemoryStore::new(&home),
            memory_maintenance: MemoryMaintenance::new(&home),
            memory_curator: MemoryCurator::new(&home),
            objectives: ObjectiveStore::new(&home),
            objective_actions: ObjectiveActions::new(&home),
            watches: WatchHost::new(&home),
            directory: BotDirectory::new(&home),
            conversations: ConversationStore::new(&home),
            digests: DigestQueue::new(&home),
            interactive_results: InteractiveResultStore::new(&home),
            supervisor,
            runner,
            host_identity,
            data_home: home,
        })
    }

    pub fn data_home(&self) -> &Path {
        &self.data_home
    }
    pub fn host_identity(&self) -> &HostIdentity {
        &self.host_identity
    }
    pub fn host_id(&self) -> &str {
        self.host_identity.host_id()
    }
    pub fn lease_epoch(&self, workspace_id: &str) -> Option<String> {
        self.coordination.lease_epoch(workspace_id)
    }
    pub fn owned_workspaces(&self) -> Vec<String> {
        self.coordination.owned_workspaces()
    }
    pub fn interactive_results(&self) -> &InteractiveResultStore {
        &self.interactive_results
    }
    pub fn registry(&self) -> &ProjectRegistry {
        &self.registry
    }
    pub fn profiles(&self) -> &BotProfileStore {
        &self.profiles
    }
    pub fn inputs(&self) -> &InputQueue {
        &self.inputs
    }
    pub fn drafts(&self) -> &InputDraftStore {
        &self.drafts
    }
    pub fn inbox(&self) -> &ProjectInbox {
        &self.inbox
    }
    pub fn approvals(&self) -> &ApprovalStore {
        &self.approvals
    }
    pub fn memory(&self) -> &MemoryStore {
        &self.memory
    }
    pub fn objectives(&self) -> &ObjectiveStore {
        &self.objectives
    }
    pub fn objective_actions(&self) -> &ObjectiveActions {
        &self.objective_actions
    }
    pub fn watches(&self) -> &WatchHost {
        &self.watches
    }
    pub fn watch_publisher(&self) -> &WatchPublisher {
        &self.watch_publisher
    }
    pub fn recovery(&self) -> &ProjectRecoveryBarrier {
        &self.recovery
    }
    pub fn memory_maintenance(&self) -> &MemoryMaintenance {
        &self.memory_maintenance
    }
    pub fn memory_curator(&self) -> &MemoryCurator {
        &self.memory_curator
    }
    pub fn supervisor(&self) -> &SessionSupervisor {
        &self.supervisor
    }
    pub fn runner(&self) -> &ProjectAgentRunner {
        &self.runner
    }
    pub fn set_tool_projection_mode(&self, mode: crate::ToolProjectionMode) {
        self.runner.set_projection_mode(mode);
    }
    pub fn directory(&self) -> &BotDirectory {
        &self.directory
    }
    pub fn conversations(&self) -> &ConversationStore {
        &self.conversations
    }
    pub fn digests(&self) -> &DigestQueue {
        &self.digests
    }
    pub fn coordination(&self) -> &Arc<CoordinationHub> {
        &self.coordination
    }
    pub fn obligation_service(&self) -> ExecutionObligationService<'_> {
        ExecutionObligationService::new(&self.data_home, &self.coordination, &self.supervisor)
    }

    /// Bind a local folder to a persistent project Bot (register workspace, create canonical
    /// `project_agent` conversation, create profile, ensure `bot-access.sqlite` exists).
    pub fn bind_workspace(
        &self,
        workspace_path: &Path,
        display_name: Option<&str>,
    ) -> Result<(ProjectRegistryEntry, BotProfile), ProjectError> {
        let path_str = workspace_path
            .to_str()
            .ok_or_else(|| ProjectError::code("INVALID_PATH"))?;
        let entry = self.registry.register(path_str, None)?;
        if let Some(existing) = self.profiles.read(&entry.workspace_id)
            && existing.is_active()
        {
            return Ok((entry, existing));
        }
        let default_name = workspace_path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Project");
        let name = display_name.unwrap_or(default_name);
        let at = now_iso();
        let conv = self.conversations.create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: name,
                workspace_id: &entry.workspace_id,
                workspace_path: Some(&entry.path),
                role: "project_agent",
                parent_conversation_id: None,
                mode: "project_agent",
                created_at: &at,
            },
            None,
            None,
        )?;
        let conv_id = conv["id"]
            .as_str()
            .ok_or_else(|| ProjectError::code("CONVERSATION_CREATE_FAILED"))?;
        let (profile, _) = self.profiles.create(&CreateBotProfile {
            workspace_id: &entry.workspace_id,
            display_name: name,
            managed: false,
            agent_conversation_id: conv_id,
            avatar_salt: "",
        })?;
        // Ensure bot-access SQLite policy store is initialized for this data home.
        let _ = PolicyStore::new(&self.data_home);
        Ok((entry, profile))
    }

    /// Acquire or heartbeat the per-workspace host lease (`host.lease`).
    pub fn ensure_lease(&self, workspace_id: &str) -> Result<LeaseStatus, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        if self.coordination.heartbeat(workspace_id, now_ms)? {
            return Ok(LeaseStatus::Acquired { took_over: false });
        }
        match self
            .leases
            .acquire(workspace_id, &self.host_identity, now_ms)?
        {
            AcquireLease::Acquired { token, took_over } => {
                self.coordination.insert_lease(workspace_id, token);
                Ok(LeaseStatus::Acquired { took_over })
            }
            AcquireLease::Held(record) => Ok(LeaseStatus::HeldByOther(record)),
        }
    }

    pub fn holds_lease(&self, workspace_id: &str) -> bool {
        self.coordination.holds(workspace_id)
    }

    pub fn has_pending_work(&self, workspace_id: &str) -> bool {
        self.inputs.has_pending(workspace_id)
            || self
                .supervisor
                .list_sessions(workspace_id)
                .iter()
                .any(|s| s.status == "queued")
            || self.inbox.has_pending(workspace_id)
    }

    /// Read-only inspection of an existing active lease holder (never creates files or steals lease).
    pub fn leases_status_readonly(&self, workspace_id: &str) -> Option<String> {
        let record = self.leases.inspect(workspace_id).ok()??;
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let hb_ms = parse_iso_ms(&record.heartbeat_at).unwrap_or(0);
        if now_ms.saturating_sub(hb_ms) > 30_000 {
            return None;
        }
        Some(record.host_id)
    }

    pub fn release_lease(&self, workspace_id: &str) -> Result<(), ProjectError> {
        self.recovery.drop_workspace(workspace_id);
        self.watch_publisher.forget(workspace_id);
        self.coordination.release(workspace_id)
    }

    pub fn release_all_leases(&self) {
        if let Ok(entries) = self.registry.list() {
            for entry in entries {
                self.recovery.drop_workspace(&entry.workspace_id);
                self.watch_publisher.forget(&entry.workspace_id);
            }
        }
        self.coordination.release_all();
    }

    /// Write `host.yield` targeting the active lease holder (`true` if a holder existed,
    /// `false` if no active holder exists so the caller may acquire directly).
    pub fn request_takeover(&self, workspace_id: &str) -> Result<bool, ProjectError> {
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let written = self
            .leases
            .request_takeover(workspace_id, &self.host_identity, now_ms)?;
        Ok(written)
    }

    /// Check whether another host has written `host.yield` targeting this host's held lease.
    pub fn takeover_requested(&self, workspace_id: &str) -> bool {
        self.coordination.takeover_requested(workspace_id)
    }

    /// Resolve a role model using this bot profile's `modelPolicy` and global `settings.json`.
    pub fn resolve_bot_model_selection(
        &self,
        workspace_id: &str,
        role: &str,
        explicit_provider: Option<&str>,
        explicit_model: Option<&str>,
        explicit_effort: Option<&str>,
        fast: bool,
    ) -> Result<
        peer_runtime::model_catalog::ExecSelection,
        peer_runtime::model_catalog::ExecSelectionError,
    > {
        let profile = self.profiles.read(workspace_id);
        peer_runtime::model_catalog::resolve_role_model(
            &self.data_home,
            role,
            profile.as_ref().and_then(|p| p.model_policy.as_ref()),
            explicit_provider,
            explicit_model,
            explicit_effort,
            fast,
        )
    }

    /// Submit a durable user input to the shared `InputQueue` (works both as Host and Client).
    pub fn submit_user_input(
        &self,
        workspace_id: &str,
        input_id: &str,
        text: &str,
        answer_to: Option<String>,
    ) -> Result<ProjectInput, ProjectError> {
        self.submit_user_input_with_attachments(workspace_id, input_id, text, answer_to, vec![])
    }

    /// Submit a durable user input with normalized multimodal attachments to `InputQueue`.
    pub fn submit_user_input_with_attachments(
        &self,
        workspace_id: &str,
        input_id: &str,
        text: &str,
        answer_to: Option<String>,
        attachments: Vec<Value>,
    ) -> Result<ProjectInput, ProjectError> {
        self.inputs.submit_input(&SubmitInputRequest {
            workspace_id,
            input_id,
            surface: "tui",
            text,
            anchor_refs: vec![],
            quote_refs: vec![],
            task_refs: vec![],
            attachment_refs: vec![],
            attachments,
            answer_to,
            history_ref: None,
            history_snapshot_id: None,
            history_confirmed: None,
        })
    }

    async fn run_user_input_phase(
        &self,
        workspace_id: &str,
        model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        worker_model_selection: &Value,
        cancel: &CancellationToken,
    ) -> Result<Option<(String, PathBuf, ForegroundTickReport, bool)>, ProjectError> {
        let mut report = ForegroundTickReport {
            workspace_id: workspace_id.to_owned(),
            held_lease: false,
            inputs_consumed: 0,
            bot_turns_run: 0,
            promoted_session_ids: Vec::new(),
            wake_turns_run: 0,
            last_turn: None,
        };
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("CONVERSATION_REQUIRED"))?;
        let ws_entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
        let ws_path = PathBuf::from(&ws_entry.path);

        match self.ensure_lease(workspace_id)? {
            LeaseStatus::Acquired { .. } => {
                report.held_lease = true;
            }
            LeaseStatus::HeldByOther(_) => {
                return Ok(None);
            }
        }

        // Run 7-phase startup recovery barrier once per lease acquisition epoch.
        if !self
            .recovery
            .is_ready(workspace_id, self.holds_lease(workspace_id))
        {
            Box::pin(self.recover_workspace_barrier(workspace_id, cancel)).await?;
        }

        // Step 1: Consume pending durable inputs into bot conversation.
        let consumed = self
            .inputs
            .consume(workspace_id, &conv_id, &self.conversations, true)?;
        report.inputs_consumed = consumed.consumed.len();

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(Some((conv_id, ws_path, report, true)));
        }

        // Step 2: Run main Bot turn for each pending user input (user input priority).
        for input in &consumed.pending_execution {
            if cancel.is_cancelled() {
                break;
            }
            let outcome = Box::pin(self.runner.run_turn_with_verifier(
                &RunTurnOptions {
                    workspace_id,
                    workspace_path: &ws_path,
                    conversation_id: &conv_id,
                    kind: "user",
                    user_inputs: std::slice::from_ref(input),
                    wake_events: &[],
                    worker_model_selection: worker_model_selection.clone(),
                    holds_lease: true,
                },
                model,
                verifier_model,
                cancel,
            ))
            .await?;
            report.bot_turns_run += 1;
            let should_mark_executed = !matches!(
                outcome.end,
                crate::runner::TurnEndKind::Failed { .. } | crate::runner::TurnEndKind::CircuitOpen
            );
            let stop_tick = matches!(
                outcome.end,
                crate::runner::TurnEndKind::Failed { .. }
                    | crate::runner::TurnEndKind::CircuitOpen
                    | crate::runner::TurnEndKind::UserStopped
            );
            if should_mark_executed {
                let completed_id = vec![input.input_id.clone()];
                let _ = self
                    .inputs
                    .mark_executed(workspace_id, &completed_id, &[], true);
            }
            report.last_turn = Some(outcome);
            if stop_tick {
                return Ok(Some((conv_id, ws_path, report, true)));
            }
        }

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(Some((conv_id, ws_path, report, true)));
        }

        Ok(Some((conv_id, ws_path, report, false)))
    }

    async fn maybe_run_wake_turn(
        &self,
        workspace_id: &str,
        ws_path: &Path,
        conv_id: &str,
        models: (&NativeModel, Option<&NativeModel>),
        worker_model_selection: Value,
        cancel: &CancellationToken,
    ) -> Result<Option<AgentTurnOutcome>, ProjectError> {
        // User-input priority preemption: skip wake turns if fresh user inputs await execution.
        if self.inputs.has_pending(workspace_id)
            || cancel.is_cancelled()
            || !self.holds_lease(workspace_id)
        {
            return Ok(None);
        }
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let batch = self.inbox.take_batch(workspace_id, now_ms, true);
        if batch.events.is_empty() {
            return Ok(None);
        }
        let sessions = self.supervisor.list_sessions(workspace_id);
        if is_routine_host_wake_wait(&batch.events, &sessions) {
            let _ = self
                .inbox
                .commit_batch(workspace_id, batch.through_seq, true);
            return Ok(None);
        }
        let (model, verifier_model) = models;
        let outcome = Box::pin(self.runner.run_turn_with_verifier(
            &RunTurnOptions {
                workspace_id,
                workspace_path: ws_path,
                conversation_id: conv_id,
                kind: "wake",
                user_inputs: &[],
                wake_events: &batch.events,
                worker_model_selection,
                holds_lease: true,
            },
            model,
            verifier_model,
            cancel,
        ))
        .await?;
        let ok = !matches!(outcome.end, crate::runner::TurnEndKind::Failed { .. });
        let _ = self.inbox.commit_batch(workspace_id, batch.through_seq, ok);
        Ok(Some(outcome))
    }

    /// Foreground host tick for interactive TUI: runs user inputs, promotes queued workers without
    /// blocking on them, and drains wake turns only when no fresh user inputs are waiting.
    pub async fn tick_foreground(
        &self,
        workspace_id: &str,
        model: &NativeModel,
        worker_model_selection: Value,
        cancel: &CancellationToken,
    ) -> Result<ForegroundTickReport, ProjectError> {
        self.tick_foreground_with_verifier(
            workspace_id,
            model,
            None,
            worker_model_selection,
            cancel,
        )
        .await
    }

    pub async fn tick_foreground_with_verifier(
        &self,
        workspace_id: &str,
        model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        worker_model_selection: Value,
        cancel: &CancellationToken,
    ) -> Result<ForegroundTickReport, ProjectError> {
        let Some((conv_id, ws_path, mut report, stopped)) = self
            .run_user_input_phase(
                workspace_id,
                model,
                verifier_model,
                &worker_model_selection,
                cancel,
            )
            .await?
        else {
            return Ok(ForegroundTickReport {
                workspace_id: workspace_id.to_owned(),
                held_lease: false,
                inputs_consumed: 0,
                bot_turns_run: 0,
                promoted_session_ids: Vec::new(),
                wake_turns_run: 0,
                last_turn: None,
            });
        };
        if stopped {
            return Ok(report);
        }

        let promoted = self.supervisor.promote_queued(workspace_id, true)?;
        report.promoted_session_ids = promoted.start;

        if let Some(outcome) = self
            .maybe_run_wake_turn(
                workspace_id,
                &ws_path,
                &conv_id,
                (model, verifier_model),
                worker_model_selection,
                cancel,
            )
            .await?
        {
            report.wake_turns_run += 1;
            report.last_turn = Some(outcome);
            if !cancel.is_cancelled() && self.holds_lease(workspace_id) {
                let starts = self.supervisor.promote_queued(workspace_id, true)?.start;
                for id in starts {
                    if !report.promoted_session_ids.contains(&id) {
                        report.promoted_session_ids.push(id);
                    }
                }
            }
        }

        Ok(report)
    }

    /// Execute one previously promoted delegated session asynchronously with optional verifier.
    #[allow(clippy::too_many_arguments)]
    pub async fn run_promoted_session(
        &self,
        workspace_id: &str,
        session_id: &str,
        worker_model: &NativeModel,
        verifier_model: Option<&NativeModel>,
        worker_permission: &mut impl PermissionInput,
        max_turns: usize,
        cancel: &CancellationToken,
    ) -> Result<EpisodeOutcome, ProjectError> {
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let is_legacy = self
            .supervisor
            .find_plan_by_session(workspace_id, session_id)
            .is_some_and(|p| p["delegationOrigin"]["coordinationBinding"].is_object());
        if is_legacy {
            self.release_lease(workspace_id)?;
        }
        let run_res = Box::pin(self.supervisor.run_session_episode_with_verifier(
            workspace_id,
            session_id,
            worker_model,
            verifier_model,
            worker_permission,
            max_turns,
            cancel,
            true,
        ))
        .await;
        if is_legacy {
            let _ = self.ensure_lease(workspace_id)?;
        } else if !cancel.is_cancelled() && self.holds_lease(workspace_id) {
            let _ = self.ensure_lease(workspace_id);
        }
        run_res
    }

    /// Run one full native host synchronization cycle for `workspace_id`:
    /// 1. Lease acquisition / heartbeat (if another host holds fresh lease, returns immediately as client).
    /// 2. Startup recovery once per lease epoch.
    /// 3. Consume durable `InputQueue` into bot conversation.
    /// 4. Drive main Bot cognition for pending user inputs (user input preempts wakes).
    /// 5. Promote & execute eligible delegated work sessions via `NativeSessionHost`.
    /// 6. Drain `ProjectInbox` wake events unless preempted by fresh user inputs.
    pub async fn tick(
        &self,
        workspace_id: &str,
        model: &NativeModel,
        worker_model_selection: Value,
        worker_permission: &mut impl PermissionInput,
        cancel: &CancellationToken,
    ) -> Result<HostTickReport, ProjectError> {
        let Some((conv_id, ws_path, fg, stopped)) = self
            .run_user_input_phase(workspace_id, model, None, &worker_model_selection, cancel)
            .await?
        else {
            return Ok(HostTickReport {
                workspace_id: workspace_id.to_owned(),
                held_lease: false,
                inputs_consumed: 0,
                bot_turns_run: 0,
                sessions_promoted: 0,
                sessions_executed: 0,
                wake_turns_run: 0,
                last_turn: None,
            });
        };
        let mut report = HostTickReport {
            workspace_id: fg.workspace_id,
            held_lease: fg.held_lease,
            inputs_consumed: fg.inputs_consumed,
            bot_turns_run: fg.bot_turns_run,
            sessions_promoted: 0,
            sessions_executed: 0,
            wake_turns_run: fg.wake_turns_run,
            last_turn: fg.last_turn,
        };
        if stopped {
            return Ok(report);
        }

        // Step 3: Promote queued delegated work sessions and run ready episodes.
        let promoted = self.supervisor.promote_queued(workspace_id, true)?;
        report.sessions_promoted = promoted.start.len();
        for sid in promoted.start {
            if cancel.is_cancelled() {
                break;
            }
            if Box::pin(self.run_promoted_session(
                workspace_id,
                &sid,
                model,
                None,
                worker_permission,
                crate::DEFAULT_WORKER_MAX_TURNS,
                cancel,
            ))
            .await
            .is_ok()
            {
                report.sessions_executed += 1;
            }
        }

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(report);
        }

        // Refresh lease heartbeat after worker execution before draining inbox wakes.
        if !cancel.is_cancelled() && self.holds_lease(workspace_id) {
            let _ = self.ensure_lease(workspace_id);
        }

        // Step 4: Drain ProjectInbox wake events unless preempted by fresh user inputs.
        if let Some(outcome) = self
            .maybe_run_wake_turn(
                workspace_id,
                &ws_path,
                &conv_id,
                (model, None),
                worker_model_selection,
                cancel,
            )
            .await?
        {
            report.wake_turns_run += 1;
            report.last_turn = Some(outcome);
        }

        Ok(report)
    }

    /// Find canonical `agent_reply` answering `input_id` in `workspace_id`'s bot conversation.
    pub fn find_reply_for_input(
        &self,
        workspace_id: &str,
        input_id: &str,
    ) -> Result<Option<Value>, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        let Some(conv_id) = profile.agent_conversation_id.as_deref() else {
            return Ok(None);
        };
        let target_msg_id = crate::input_message_id(input_id)?;
        let messages = match crate::read_full_conversation_messages(&self.conversations, conv_id) {
            Ok(msgs) => msgs,
            Err(peer_store::StoreError::NotFound) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        Ok(messages.into_iter().find(|msg| {
            msg["role"] == "assistant"
                && msg["kind"] == "agent_reply"
                && msg["replyTo"]
                    .as_array()
                    .is_some_and(|arr| arr.iter().any(|v| v.as_str() == Some(&target_msg_id)))
        }))
    }

    /// Trigger the first-open project familiarization workflow (`familiarize-template.mjs`):
    /// empty/dotfile-only directories ask the responsibility question directly in conversation;
    /// non-empty directories spawn one idempotent read-only `research` session.
    pub fn start_familiarize(
        &self,
        workspace_id: &str,
        worker_model_selection: Value,
    ) -> Result<StartFamiliarizeResult, ProjectError> {
        let mut profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;

        if let Some(existing) = profile.familiarize.as_ref()
            && existing["plan"].is_object()
            && (existing["kind"] == "blank" || existing["dispatched"] == true)
        {
            let kind = if existing["kind"] == "blank" {
                FamiliarizeKind::Blank
            } else {
                FamiliarizeKind::Research {
                    session_id: existing["sessionId"].as_str().map(str::to_owned),
                }
            };
            return Ok(StartFamiliarizeResult { kind, reused: true });
        }

        let ws_entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let ws_path = PathBuf::from(&ws_entry.path);
        let dir_entries =
            fs::read_dir(&ws_path).map_err(|_| ProjectError::code("WORKSPACE_UNREADABLE"))?;
        let mut names = Vec::new();
        for entry in dir_entries {
            let entry = entry.map_err(|_| ProjectError::code("WORKSPACE_UNREADABLE"))?;
            names.push(entry.file_name().to_string_lossy().into_owned());
        }
        let is_blank = names
            .iter()
            .all(|n| n.trim().is_empty() || n.trim().starts_with('.'));

        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("CONVERSATION_REQUIRED"))?;
        let at = now_iso();

        if is_blank {
            match self.conversations.read_metadata(&conv_id) {
                Ok(snap) if snap.metadata.is_some() => {}
                Ok(_) | Err(StoreError::NotFound) => {
                    self.conversations.create_project_conversation(
                        &NewProjectConversation {
                            id: Some(&conv_id),
                            title: &profile.display_name,
                            workspace_id,
                            workspace_path: Some(&ws_entry.path),
                            role: "project_agent",
                            parent_conversation_id: None,
                            mode: "project_agent",
                            created_at: &at,
                        },
                        None,
                        None,
                    )?;
                }
                Err(err) => return Err(err.into()),
            }
            self.conversations.append_message_idempotent(
                &conv_id,
                &json!({
                    "id": format!("assistant-{}", uuid::Uuid::new_v4()),
                    "role": "assistant",
                            "kind": "agent_reply",
                    "content": RESPONSIBILITY_QUESTION,
                    "createdAt": at,
                }),
                &at,
                None,
            )?;
            profile.familiarize = Some(json!({
                "kind": "blank",
                "plan": {
                    "kind": "blank",
                    "question": RESPONSIBILITY_QUESTION,
                    "task": Value::Null,
                },
                "dispatched": false,
                "startedAt": at,
            }));
            self.profiles.save(profile)?;
            return Ok(StartFamiliarizeResult {
                kind: FamiliarizeKind::Blank,
                reused: false,
            });
        }

        match self.ensure_lease(workspace_id)? {
            LeaseStatus::Acquired { .. } => {}
            LeaseStatus::HeldByOther(_) => {
                return Err(ProjectError::code("desktop_approval_required"));
            }
        }

        let display_name = if profile.display_name.trim().is_empty() {
            "这个项目"
        } else {
            profile.display_name.trim()
        };
        let git_head = read_git_head_snapshot(&ws_path);
        let mut lines = vec![
            format!("只读熟悉「{display_name}」。"),
            "查看目录、AGENTS.md、脚本和最近提交。".to_owned(),
            "只使用结构化文件读取与 git_query。不要使用 shell，不要写入、修改或执行会改变工作区的操作。".to_owned(),
            "用 git_query 核对当前仓库身份、工作树和最近提交；非 Git 目录如实记录，不用旧分支/提交快照代替当前检查。".to_owned(),
            "交付带证据引用的阅读结果；记忆是否写入由宿主按用户设置决定。无法核实的内容标为未知，并说明原因。".to_owned(),
            "本次目标是了解项目。发现缺陷或缺失文件也应先完成阅读报告，不要为新增修复、扩大检查或写入记忆要求用户选择。只有完成本次读取所必需且无法自行查明的决定才向用户提问。".to_owned(),
        ];
        if let Some((ref branch, ref commit)) = git_head {
            lines.push(format!("建立任务时的分支快照（需重新核对）：{branch}"));
            if let Some(sha) = commit {
                lines.push(format!("建立任务时的提交快照（需重新核对）：{sha}"));
            }
        } else {
            lines.push("没有可读的 git 分支。".to_owned());
        }
        let brief = lines.join("\n");
        let caps: Vec<String> = FAMILIARIZE_READ_CAPABILITIES
            .iter()
            .map(|c| (*c).to_owned())
            .collect();
        let criteria = vec![
            SpawnCriterion {
                id: Some("c1".to_owned()),
                kind: "model_review".to_owned(),
                description: "用文件读取工具看过项目结构".to_owned(),
                command: None,
                path: None,
                expect: None,
            },
            SpawnCriterion {
                id: Some("c2".to_owned()),
                kind: "model_review".to_owned(),
                description: "确认过的事实带有证据引用".to_owned(),
                command: None,
                path: None,
                expect: None,
            },
            SpawnCriterion {
                id: Some("c3".to_owned()),
                kind: "model_review".to_owned(),
                description: "以当前 Git 读取事实核对仓库身份、工作树与最近提交；非仓库如实记录"
                    .to_owned(),
                command: None,
                path: None,
                expect: None,
            },
        ];

        let summary = self.supervisor.spawn_session(
            SpawnSessionRequest {
                workspace_id: workspace_id.to_owned(),
                workspace_path: ws_path,
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![format!("lifecycle-familiarize-{workspace_id}")],
                input_id: format!("familiarize-{workspace_id}"),
                surface: "tui".to_owned(),
                title: "熟悉项目".to_owned(),
                brief: brief.clone(),
                kind: "research".to_owned(),
                read_only: true,
                required_capabilities: caps.clone(),
                success_criteria: criteria,
                priority: "normal".to_owned(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".to_owned(),
                worker_model_selection,
            },
            true,
        )?;

        let git_json = match git_head {
            Some((branch, commit)) => json!({ "branch": branch, "commit": commit }),
            None => Value::Null,
        };
        profile.familiarize = Some(json!({
            "kind": "research",
            "plan": {
                "kind": "research",
                "question": Value::Null,
                "task": {
                    "kind": "research",
                    "readOnly": true,
                    "title": "熟悉项目",
                    "brief": brief,
                    "requiredCapabilities": caps,
                    "allowedCapabilities": caps,
                    "git": git_json,
                }
            },
            "dispatched": true,
            "sessionId": summary.session_id,
            "startedAt": at,
        }));
        self.profiles.save(profile)?;

        Ok(StartFamiliarizeResult {
            kind: FamiliarizeKind::Research {
                session_id: Some(summary.session_id),
            },
            reused: false,
        })
    }

    /// Flush due digest items for `workspace_id` at `at_iso` against `digest_time` (`HH:MM` UTC).
    pub fn flush_due_digest(
        &self,
        workspace_id: &str,
        at_iso: &str,
        digest_time: &str,
    ) -> Result<Option<Value>, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("CONVERSATION_REQUIRED"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => return Ok(None),
            }
        }
        let Some(due) = self.digests.consider(workspace_id, at_iso, digest_time)? else {
            return Ok(None);
        };
        let mut msg = due.message.clone();
        let created_at = if parse_iso_ms(at_iso).is_some() {
            at_iso.to_owned()
        } else {
            now_iso()
        };
        if let Some(obj) = msg.as_object_mut() {
            obj.entry("createdAt").or_insert_with(|| json!(created_at));
        }
        self.conversations
            .append_message_idempotent(&conv_id, &msg, &created_at, None)?;
        self.digests.acknowledge(workspace_id, &due.date)?;
        Ok(Some(msg))
    }

    /// Explicit local-user confirmation of a `result_ready` delegated session.
    pub fn confirm_session_result(
        &self,
        workspace_id: &str,
        session_id: &str,
        independent_verifier: Option<&str>,
    ) -> Result<AcceptanceDecision, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let decision = self.supervisor.settle_session(
            workspace_id,
            session_id,
            true,
            true,
            independent_verifier,
            true,
        )?;
        if decision.accepted_by.is_some() && profile.auto_handoff_on_policy_accept {
            let _ = self
                .supervisor
                .handoff_worktree(workspace_id, session_id, true);
        }
        Ok(decision)
    }

    /// Merge (`merge = true`) or discard (`merge = false`) an isolated session worktree.
    pub fn handoff_session_worktree(
        &self,
        workspace_id: &str,
        session_id: &str,
        merge: bool,
    ) -> Result<Value, ProjectError> {
        let _ = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        if merge {
            let outcome = self
                .supervisor
                .handoff_worktree(workspace_id, session_id, true)?;
            Ok(match outcome {
                HandoffOutcome::Merged { commit_sha } => json!({
                    "action": "merge",
                    "status": "delivered",
                    "commitSha": commit_sha,
                }),
                HandoffOutcome::NothingToMerge => json!({
                    "action": "merge",
                    "status": "nothing_to_merge",
                }),
                HandoffOutcome::Stopped { reason, detail } => json!({
                    "action": "merge",
                    "status": "stopped",
                    "reason": reason,
                    "detail": detail,
                }),
            })
        } else {
            let cleaned = self
                .supervisor
                .discard_worktree(workspace_id, session_id, true)?;
            Ok(json!({
                "action": "discard",
                "status": "discarded",
                "cleaned": cleaned,
            }))
        }
    }

    /// Requeue a previously user-stopped input so the next `tick` re-runs it with retry continuity.
    pub fn retry_stopped_input(
        &self,
        workspace_id: &str,
        anchor_or_input_id: &str,
    ) -> Result<bool, ProjectError> {
        let _ = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let trimmed = anchor_or_input_id.trim();
        let input_id = trimmed.strip_prefix("input-").unwrap_or(trimmed);
        self.inputs.requeue_executed(workspace_id, input_id, true)
    }

    /// Execute the 7-phase workspace recovery barrier (`lease` -> `inputs` -> `inbox` -> `queue` -> `tasks` -> `watch` -> `digest`).
    pub async fn recover_workspace_barrier(
        &self,
        workspace_id: &str,
        cancel: &CancellationToken,
    ) -> Result<RecoveryDiagnostic, ProjectError> {
        let profile = self.profiles.read(workspace_id);
        let digest_time = profile
            .as_ref()
            .and_then(|p| p.extra.get("digestTime").and_then(Value::as_str))
            .unwrap_or("09:00")
            .to_owned();
        let ws_path = self
            .registry
            .get(workspace_id)?
            .map(|e| PathBuf::from(e.path))
            .unwrap_or_default();

        let conv_id_opt = profile
            .as_ref()
            .and_then(|p| p.agent_conversation_id.clone());

        self.recovery
            .run_phases(
                workspace_id,
                |ws| self.holds_lease(ws),
                |phase, mut counts| {
                    let ws_path = ws_path.clone();
                    let digest_time = digest_time.clone();
                    let conv_id_opt = conv_id_opt.clone();
                    Box::pin(async move {
                        match phase {
                            "lease" => {
                                let _ = self.coordination.ensure_snapshot(workspace_id)?;
                            }
                            "inputs" => {
                                let _ = self.inputs.has_pending(workspace_id);
                            }
                            "inbox" => {
                                let _ = self.inbox.read_cursor(workspace_id);
                            }
                            "tasks" => {
                                counts.recovered_sessions = Box::pin(
                                    self.supervisor
                                        .recover_workspace(workspace_id, cancel, true),
                                )
                                .await?;
                                let plans = self.supervisor.list_workspace_plans(workspace_id);
                                let _ =
                                    self.obligation_service().suspend_live(workspace_id, &plans);
                                if let Some(ref conv_id) = conv_id_opt {
                                    let owner = InteractiveOwner {
                                        workspace_id: workspace_id.to_owned(),
                                        conversation_id: conv_id.clone(),
                                    };
                                    let _ = self.interactive_results.reconcile_pending(&owner);
                                }
                            }
                            "watch" => {
                                let plans = self.supervisor.list_workspace_plans(workspace_id);
                                let wd = self.watch_publisher.publish(
                                    workspace_id,
                                    &plans,
                                    &now_iso(),
                                    None,
                                );
                                if !wd.is_empty() {
                                    let _ = self.inbox.append(workspace_id, &wd)?;
                                }
                                let rec = Box::pin(self.watches.reconcile_workspace(
                                    workspace_id,
                                    &ws_path,
                                    &now_iso(),
                                    60_000,
                                    None,
                                    cancel,
                                ))
                                .await?;
                                counts.watch_signals += wd.len() + rec.signals_emitted;
                            }
                            "digest" if self.digests.pending(workspace_id) > 0 => {
                                counts.flushed_digest = self
                                    .flush_due_digest(workspace_id, &now_iso(), &digest_time)?
                                    .is_some();
                            }
                            _ => {}
                        }
                        Ok(counts)
                    })
                },
            )
            .await
    }

    pub fn pending_obligation_grants(&self, workspace_id: &str) -> Vec<Value> {
        let Some(profile) = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
        else {
            return Vec::new();
        };
        let parent_conv = profile.agent_conversation_id.as_deref();
        if !self.holds_lease(workspace_id) {
            return Vec::new();
        }
        self.obligation_service()
            .pending_grants(workspace_id, parent_conv)
    }

    pub fn confirm_obligation_grant(
        &self,
        workspace_id: &str,
        grant_id: &str,
        confirm: bool,
    ) -> Result<Value, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let svc = self.obligation_service();
        let res = if confirm {
            let out = svc.confirm_grant(
                workspace_id,
                profile.agent_conversation_id.as_deref(),
                grant_id,
            )?;
            let _ = self.inbox.append(
                workspace_id,
                &[json!({
                    "eventId": format!("obl-confirm:{grant_id}"),
                    "kind": "obligation_grant_confirmed",
                    "workspaceId": workspace_id,
                    "grantId": grant_id,
                    "at": now_iso(),
                    "payload": { "grantId": grant_id, "status": "confirmed" },
                })],
            );
            out
        } else {
            svc.revoke_grant(workspace_id, grant_id)?
        };
        Ok(res)
    }

    pub fn decide_objective_proposal(
        &self,
        workspace_id: &str,
        action_id: &str,
        approve: bool,
    ) -> Result<ObjectiveActionItem, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("CONVERSATION_REQUIRED"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let existing = self
            .objective_actions
            .get(workspace_id, action_id)
            .ok_or_else(|| ProjectError::code("objective_proposal_stale"))?;
        let obj = self
            .objectives
            .get(workspace_id, &existing.objective_id)?
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let ws_entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
        let anchor = format!("proposal:{action_id}");
        let updated =
            self.objective_actions
                .approve(workspace_id, action_id, &obj, &anchor, !approve)?;
        if approve && updated.state == "reserved" && updated.session_id.is_none() {
            let t = &updated.input;
            let anchors: Vec<String> = t["anchorMessageIds"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .filter(|v: &Vec<String>| !v.is_empty())
                .unwrap_or_else(|| vec![obj.origin_message_id.clone()]);
            let req_caps: Vec<String> = t["requiredCapabilities"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let depends_on: Vec<String> = t["dependsOn"]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(Value::as_str)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default();
            let criteria: Vec<SpawnCriterion> = t
                .get("successCriteria")
                .cloned()
                .and_then(|v| serde_json::from_value(v).ok())
                .unwrap_or_default();
            let spawned = self.supervisor.spawn_session(
                SpawnSessionRequest {
                    workspace_id: workspace_id.to_owned(),
                    workspace_path: PathBuf::from(ws_entry.path),
                    parent_conversation_id: conv_id,
                    anchor_message_ids: anchors,
                    input_id: format!("obj-action-{}", updated.action_id),
                    surface: "tui".into(),
                    title: t["title"].as_str().unwrap_or(&obj.title).to_owned(),
                    brief: t["brief"].as_str().unwrap_or(&obj.outcome).to_owned(),
                    kind: t["kind"].as_str().unwrap_or("other").to_owned(),
                    read_only: t["readOnly"].as_bool().unwrap_or(true),
                    required_capabilities: req_caps,
                    success_criteria: criteria,
                    priority: t["priority"].as_str().unwrap_or("normal").to_owned(),
                    depends_on,
                    supersedes: t["supersedes"].as_str().map(str::to_owned),
                    objective_id: Some(obj.objective_id),
                    isolation: t["isolation"].as_str().unwrap_or("auto").to_owned(),
                    worker_model_selection: json!({}),
                },
                true,
            )?;
            let _ = self.objective_actions.link_session(
                workspace_id,
                action_id,
                &spawned.session_id,
            )?;
            return Ok(self
                .objective_actions
                .get(workspace_id, action_id)
                .unwrap_or(updated));
        }
        Ok(updated)
    }

    /// Periodic background maintenance pass: watchdog stalls/failures -> inbox, objective watch
    /// reconciliation, daily memory maintenance, optional model-backed curator, and due digest flush.
    pub async fn run_background_maintenance(
        &self,
        workspace_id: &str,
        at_iso: &str,
        model_opt: Option<&NativeModel>,
        cancel: &CancellationToken,
    ) -> Result<MaintenanceReport, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        if !self.holds_lease(workspace_id) {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Err(ProjectError::code("LEASE_HELD_BY_OTHER"));
                }
            }
        }
        let ws_entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("WORKSPACE_NOT_FOUND"))?;
        let ws_path = PathBuf::from(&ws_entry.path);
        let digest_time = profile
            .extra
            .get("digestTime")
            .and_then(Value::as_str)
            .unwrap_or("09:00");
        let learn_prefs = profile
            .extra
            .get("learnPreferences")
            .and_then(Value::as_bool)
            .unwrap_or(true);

        let mut report = MaintenanceReport::default();

        // 1. Watchdog & delegation facts -> inbox
        let plans = self.supervisor.list_workspace_plans(workspace_id);
        let wd_events = self
            .watch_publisher
            .publish(workspace_id, &plans, at_iso, None);
        if !wd_events.is_empty() {
            report.watchdog_events = wd_events.len();
            let _ = self.inbox.append(workspace_id, &wd_events)?;
        }

        // 2. Objective watches reconcile
        let watch_rep = Box::pin(self.watches.reconcile_workspace(
            workspace_id,
            &ws_path,
            at_iso,
            60_000,
            model_opt,
            cancel,
        ))
        .await?;
        report.watch_observations = watch_rep.observations_recorded;
        report.watch_signals = watch_rep.signals_emitted;

        // 3. Deterministic memory maintenance
        let maint = self
            .memory_maintenance
            .run_due(workspace_id, &ws_path, at_iso, digest_time)?;
        report.memory_maintained_ids = maint.changed_ids;

        // 4. Optional model-backed episodic memory curation
        if let Some(model) = model_opt {
            let cur = Box::pin(self.memory_curator.extract_due_with_model(
                workspace_id,
                &ws_path,
                at_iso,
                learn_prefs,
                model,
                cancel,
            ))
            .await?;
            report.curator_learned_ids = cur.learned_ids;
        }

        // 5. Due digest summary
        if self.digests.pending(workspace_id) > 0 {
            report.flushed_digest = self
                .flush_due_digest(workspace_id, at_iso, digest_time)?
                .is_some();
        }

        Ok(report)
    }

    pub fn read_interactive_result_summary(
        &self,
        workspace_id: &str,
        locator: &str,
    ) -> Result<InteractiveResultSummary, ProjectError> {
        let reference = InteractiveResultReference::parse(locator)
            .ok_or_else(|| ProjectError::code("interactive_reference_invalid"))?;
        if reference.owner.workspace_id != workspace_id {
            return Err(ProjectError::code("interactive_scope_denied"));
        }
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("interactive_scope_denied"))?;
        if profile.agent_conversation_id.as_deref()
            != Some(reference.owner.conversation_id.as_str())
        {
            return Err(ProjectError::code("interactive_scope_denied"));
        }
        read_interactive_result(&self.data_home, &reference)
            .map_err(|e| ProjectError::code(e.code()))
    }

    pub fn read_task_result(
        &self,
        workspace_id: &str,
        session_id: &str,
        locator: &str,
    ) -> Result<InteractiveResultSummary, ProjectError> {
        let rep = self
            .supervisor
            .read_report(workspace_id, session_id)
            .map_err(|_| ProjectError::code("interactive_scope_denied"))?;
        let allowed = task_result_references(&rep.evidence_refs);
        if !allowed.iter().any(|r| r == locator) {
            return Err(ProjectError::code("interactive_scope_denied"));
        }
        self.read_interactive_result_summary(workspace_id, locator)
    }

    pub fn search_workspace(
        &self,
        workspace_id: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ConversationSearchHit>, ProjectError> {
        let mut msg_storage: Vec<(String, Value)> = Vec::new();
        if let Some(conv_id) = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .and_then(|p| p.agent_conversation_id)
            && let Ok(msgs) = crate::read_full_conversation_messages(&self.conversations, &conv_id)
        {
            for m in msgs {
                msg_storage.push((workspace_id.to_owned(), m));
            }
        }
        let msg_refs: Vec<(&str, &Value)> =
            msg_storage.iter().map(|(ws, m)| (ws.as_str(), m)).collect();
        let tasks: Vec<Value> = self
            .supervisor
            .list_sessions(workspace_id)
            .into_iter()
            .filter_map(|s| serde_json::to_value(s).ok())
            .collect();
        let memories = self.memory.list(&MemoryFilter {
            scope: None,
            workspace_id: Some(workspace_id),
            kind: None,
            status: Some("active"),
        });
        let docs = collect_conversation_search_documents(&[], &msg_refs, &tasks, &memories);
        let db_path = self
            .data_home
            .join("project-runtime")
            .join(workspace_id)
            .join("search-index.sqlite");
        let idx = ConversationSearchIndex::open(&db_path)?;
        idx.sync(&docs)?;
        idx.search(query, Some(workspace_id), None, limit)
    }

    pub fn search_all(
        &self,
        query: &str,
        limit: usize,
    ) -> Result<Vec<ConversationSearchHit>, ProjectError> {
        let bots_val = bot_list_json(self);
        let bots: Vec<Value> = bots_val
            .as_array()
            .or_else(|| bots_val["items"].as_array())
            .cloned()
            .unwrap_or_default();
        let mut msg_storage: Vec<(String, Value)> = Vec::new();
        let mut tasks: Vec<Value> = Vec::new();
        for bot in &bots {
            let Some(ws_id) = bot["workspaceId"].as_str() else {
                continue;
            };
            if let Some(conv_id) = bot["profile"]["agentConversationId"].as_str()
                && let Ok(msgs) =
                    crate::read_full_conversation_messages(&self.conversations, conv_id)
            {
                for m in msgs {
                    msg_storage.push((ws_id.to_owned(), m));
                }
            }
            for s in self.supervisor.list_sessions(ws_id) {
                if let Ok(v) = serde_json::to_value(s) {
                    tasks.push(v);
                }
            }
        }
        let msg_refs: Vec<(&str, &Value)> =
            msg_storage.iter().map(|(ws, m)| (ws.as_str(), m)).collect();
        let memories = self.memory.list(&MemoryFilter {
            scope: None,
            workspace_id: None,
            kind: None,
            status: Some("active"),
        });
        let docs = collect_conversation_search_documents(&bots, &msg_refs, &tasks, &memories);
        let idx = ConversationSearchIndex::open_in_memory()?;
        idx.rebuild(&docs)?;
        idx.search(query, None, None, limit)
    }

    pub fn close(&self) {
        self.release_all_leases();
    }

    fn require_held_or_acquire_lease(&self, workspace_id: &str) -> Result<(), ProjectError> {
        if self.holds_lease(workspace_id) {
            return Ok(());
        }
        match self.ensure_lease(workspace_id)? {
            LeaseStatus::Acquired { .. } => Ok(()),
            LeaseStatus::HeldByOther(_) => Err(ProjectError::code("LEASE_HELD_BY_OTHER")),
        }
    }

    fn ensure_bot_anchor_message(
        &self,
        conv_id: &str,
        workspace_id: &str,
        ws_path: &str,
        display_name: &str,
        anchor_id: &str,
        content: &str,
    ) -> Result<(), ProjectError> {
        let at = now_iso();
        let existing_messages =
            match crate::read_full_conversation_messages(&self.conversations, conv_id) {
                Ok(msgs) => msgs,
                Err(StoreError::NotFound) => {
                    self.conversations.create_project_conversation(
                        &NewProjectConversation {
                            id: Some(conv_id),
                            title: display_name,
                            workspace_id,
                            workspace_path: Some(ws_path),
                            role: "project_agent",
                            parent_conversation_id: None,
                            mode: "project_agent",
                            created_at: &at,
                        },
                        None,
                        None,
                    )?;
                    Vec::new()
                }
                Err(err) => return Err(err.into()),
            };
        if !existing_messages
            .iter()
            .any(|m| m["id"].as_str() == Some(anchor_id))
        {
            self.conversations.append_message_idempotent(
                conv_id,
                &json!({
                    "id": anchor_id,
                    "role": "user",
                    "kind": "user_input",
                    "content": content,
                    "createdAt": at,
                }),
                &at,
                None,
            )?;
        }
        Ok(())
    }

    /// Ensure an active Bot profile & `project_agent` conversation exist for an already registered workspace.
    pub fn ensure_bot(
        &self,
        workspace_id: &str,
        managed: bool,
        display_name: Option<&str>,
    ) -> Result<(BotProfile, bool), ProjectError> {
        let entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        if let Some(existing) = self.profiles.read(workspace_id) {
            if !existing.is_active() {
                return Err(ProjectError::code("ARCHIVED"));
            }
            return Ok((existing, false));
        }
        let default_name = Path::new(&entry.path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("Project");
        let name = display_name
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(default_name);
        let at = now_iso();
        let conv = self.conversations.create_project_conversation(
            &NewProjectConversation {
                id: None,
                title: name,
                workspace_id,
                workspace_path: Some(&entry.path),
                role: "project_agent",
                parent_conversation_id: None,
                mode: "project_agent",
                created_at: &at,
            },
            None,
            None,
        )?;
        let conv_id = conv["id"]
            .as_str()
            .ok_or_else(|| ProjectError::code("CONVERSATION_CREATE_FAILED"))?;
        let (profile, created) = self.profiles.create(&CreateBotProfile {
            workspace_id,
            display_name: name,
            managed,
            agent_conversation_id: conv_id,
            avatar_salt: "",
        })?;
        let _ = PolicyStore::new(&self.data_home);
        Ok((profile, created))
    }

    /// Accept a Bot's offered README generation task (`bot-lifecycle.mjs#acceptReadme`).
    pub fn accept_readme(
        &self,
        workspace_id: &str,
        worker_model_selection: Value,
    ) -> Result<Value, ProjectError> {
        let mut profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        let Some(offer) = profile.readme_offer.as_ref() else {
            return Ok(json!({ "ok": false, "code": "OFFER_MISSING" }));
        };
        if offer["offered"] != true {
            return Ok(json!({ "ok": false, "code": "OFFER_MISSING" }));
        }
        if offer["accepted"] == true {
            return Ok(json!({ "ok": true, "reused": true, "profile": profile }));
        }
        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("CONVERSATION_REQUIRED"))?;
        let ws_entry = self
            .registry
            .get(workspace_id)?
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let ws_path = PathBuf::from(&ws_entry.path);
        match self.ensure_lease(workspace_id)? {
            LeaseStatus::Acquired { .. } => {}
            LeaseStatus::HeldByOther(_) => {
                return Err(ProjectError::code("desktop_approval_required"));
            }
        }
        let responsibility = self
            .memory
            .list(&MemoryFilter {
                scope: Some("project"),
                workspace_id: Some(workspace_id),
                kind: None,
                status: Some("active"),
            })
            .into_iter()
            .find(|m| m.kind == "responsibility" && m.pinned)
            .map(|m| m.text.trim().to_owned())
            .unwrap_or_default();
        let display_name = if profile.display_name.trim().is_empty() {
            "这个项目"
        } else {
            profile.display_name.trim()
        };
        let brief = [
            format!("在「{display_name}」的文件夹里写一份 README，记录这个机器人的职责。"),
            if responsibility.is_empty() {
                "职责以用户刚刚说的为准。".to_owned()
            } else {
                format!("职责：{responsibility}")
            },
        ]
        .join("\n");
        let anchor_id = format!("lifecycle-readme-{workspace_id}");
        self.ensure_bot_anchor_message(
            &conv_id,
            workspace_id,
            &ws_entry.path,
            display_name,
            &anchor_id,
            &brief,
        )?;
        let summary = self.supervisor.spawn_session(
            SpawnSessionRequest {
                workspace_id: workspace_id.to_owned(),
                workspace_path: ws_path,
                parent_conversation_id: conv_id,
                anchor_message_ids: vec![anchor_id],
                input_id: format!("readme-{workspace_id}"),
                surface: match self.host_identity.surface() {
                    HostSurface::Desktop => "desktop".to_owned(),
                    HostSurface::Tui => "tui".to_owned(),
                },
                title: "写 README".to_owned(),
                brief: brief.clone(),
                kind: "docs".to_owned(),
                read_only: false,
                required_capabilities: vec![
                    "local.file.write".to_owned(),
                    "local.file.read".to_owned(),
                ],
                success_criteria: vec![SpawnCriterion {
                    id: Some("c1".to_owned()),
                    kind: "model_review".to_owned(),
                    description: "README 写明这个机器人主要负责什么".to_owned(),
                    command: None,
                    path: None,
                    expect: None,
                }],
                priority: "normal".to_owned(),
                depends_on: vec![],
                supersedes: None,
                objective_id: None,
                isolation: "none".to_owned(),
                worker_model_selection,
            },
            true,
        )?;
        profile.readme_offer = Some(json!({
            "offered": true,
            "accepted": true,
            "sessionId": summary.session_id,
        }));
        let saved = self.profiles.save(profile)?;
        Ok(json!({
            "ok": true,
            "sessionId": summary.session_id,
            "profile": saved,
            "session": summary,
        }))
    }

    /// Phase 1 of Bot deletion: validate managed confirmation, archive profile, and record
    /// pending disk cleanup metadata so the shell can trash/unregister the folder safely.
    pub fn delete_bot_prepare(
        &self,
        workspace_id: &str,
        confirm_managed: bool,
    ) -> Result<Value, ProjectError> {
        if !crate::is_valid_workspace_id(workspace_id) {
            return Ok(json!({ "ok": false, "code": "INVALID_WORKSPACE" }));
        }
        let Some(mut profile) = self.profiles.read(workspace_id) else {
            return Ok(json!({ "ok": false, "code": "NOT_FOUND" }));
        };
        if profile.status == "archived" && profile.deletion_cleanup.is_none() {
            return Ok(json!({ "ok": true, "profile": profile, "reused": true }));
        }
        if profile.managed && !confirm_managed {
            return Ok(json!({ "ok": false, "code": "CONFIRM_REQUIRED" }));
        }
        let existing_folder = profile
            .deletion_cleanup
            .as_ref()
            .and_then(|c| c["folder"].as_str())
            .map(str::to_owned);
        let folder = existing_folder
            .or_else(|| {
                self.registry
                    .get(workspace_id)
                    .ok()
                    .flatten()
                    .map(|e| e.path)
            })
            .unwrap_or_default();
        if profile.managed && folder.is_empty() {
            return Ok(json!({ "ok": false, "code": "NOT_FOUND" }));
        }
        if profile.status != "archived" {
            let mut extra = profile.extra.clone();
            extra.insert("archivedAt".to_owned(), json!(now_iso()));
            profile.status = "archived".to_owned();
            profile.extra = extra;
            profile.deletion_cleanup = Some(json!({
                "folder": folder,
                "trashPending": profile.managed,
                "removePending": !folder.is_empty(),
            }));
            profile = self.profiles.save(profile)?;
        }
        Ok(json!({
            "ok": true,
            "archived": true,
            "managed": profile.managed,
            "path": folder,
            "profile": profile,
        }))
    }

    /// Phase 2 of Bot deletion: clear or record error on `deletionCleanup` after shell trash/remove.
    pub fn delete_bot_finalize_cleanup(
        &self,
        workspace_id: &str,
        folder_removed: bool,
        cleanup_error: Option<&str>,
    ) -> Result<Value, ProjectError> {
        if !crate::is_valid_workspace_id(workspace_id) {
            return Ok(json!({ "ok": false, "code": "INVALID_WORKSPACE" }));
        }
        let Some(mut profile) = self.profiles.read(workspace_id) else {
            return Ok(json!({ "ok": false, "code": "NOT_FOUND" }));
        };
        let folder = profile
            .deletion_cleanup
            .as_ref()
            .and_then(|c| c["folder"].as_str())
            .map(str::to_owned)
            .unwrap_or_default();
        if folder_removed {
            profile.deletion_cleanup = None;
            let saved = self.profiles.save(profile)?;
            Ok(json!({
                "ok": true,
                "archived": true,
                "profile": saved,
                "removedPath": if folder.is_empty() { Value::Null } else { json!(folder) },
                "trashed": if saved.managed && !folder.is_empty() { json!(folder) } else { Value::Null },
            }))
        } else {
            let mut cleanup = profile
                .deletion_cleanup
                .take()
                .unwrap_or_else(|| json!({ "folder": folder }));
            if let Some(obj) = cleanup.as_object_mut() {
                if let Some(err) = cleanup_error {
                    obj.insert("error".to_owned(), json!(err));
                }
                obj.insert("failedAt".to_owned(), json!(now_iso()));
            }
            profile.deletion_cleanup = Some(cleanup);
            let saved = self.profiles.save(profile)?;
            Ok(json!({
                "ok": false,
                "archived": true,
                "cleanupPending": true,
                "code": cleanup_error.unwrap_or("CLEANUP_FAILED"),
                "profile": saved,
            }))
        }
    }

    /// Submit a user input with full question-state idempotency and closed-question rejection.
    pub fn submit_user_input_full(
        &self,
        req: &SubmitInputRequest<'_>,
    ) -> Result<ProjectInput, ProjectError> {
        let answer_to = req.answer_to.as_deref().map(str::trim).unwrap_or("");
        if let Some(qid) = answer_to.strip_prefix("card:question:reply:") {
            let existing = self.inputs.list(req.workspace_id)?;
            if let Some(found) = existing.iter().find(|i| i.input_id == req.input_id) {
                return Ok(found.clone());
            }
            if existing
                .iter()
                .any(|i| i.answer_to.as_deref().map(str::trim) == Some(answer_to))
                || self.directory.question_state(req.workspace_id, qid) != Some(QuestionState::Open)
            {
                return Err(ProjectError::code("QUESTION_CLOSED"));
            }
        }
        self.inputs.submit_input(req)
    }

    /// Handle a user reply answering a worktree handoff / merge-conflict question card.
    pub fn handle_handoff_answer(
        &self,
        workspace_id: &str,
        session_id: &str,
        answer_to: &str,
        text: &str,
    ) -> Result<Value, ProjectError> {
        let sid = session_id.trim();
        if sid.is_empty() {
            return Ok(json!({ "handled": false }));
        }
        let Some(mut plan) = self.supervisor.find_plan_by_session(workspace_id, sid) else {
            return Ok(json!({ "handled": false }));
        };
        if !self.holds_lease(workspace_id) {
            return Ok(json!({ "handled": false }));
        }
        if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id) {
            return Ok(json!({ "handled": false }));
        }
        let accepted_at = plan["resultAcceptance"]["acceptedAt"].as_str();
        let worktree_path = plan["deliveryBinding"]["worktreePath"].as_str();
        if accepted_at.is_none() || worktree_path.is_none() || plan["status"] != "completed" {
            return Ok(json!({ "handled": false }));
        }
        let handoff = plan
            .get("deliveryHandoff")
            .filter(|v| !v.is_null() && v.is_object());
        let conflict = handoff.is_some_and(is_handoff_conflict);
        let question_id = handoff_question_id(
            accepted_at.unwrap_or(""),
            conflict,
            handoff.and_then(|h| h["updatedAt"].as_str()),
            handoff.and_then(|h| h["commitSha"].as_str()),
            handoff.and_then(|h| h["stoppedReason"].as_str()),
        );
        if answer_to != format!("card:question:{sid}:{question_id}") {
            return Ok(json!({ "handled": false }));
        }
        let at = now_iso();
        if !conflict && text == "合回改动" {
            plan["delegationOrigin"]["handoffAuthorizedAt"] = json!(at);
            plan["delegationOrigin"]["handoffDeferredAt"] = Value::Null;
            plan["updatedAt"] = json!(at);
            self.supervisor.save_plan_json(&plan)?;
            let outcome = self.handoff_session_worktree(workspace_id, sid, true)?;
            return Ok(json!({ "handled": true, "outcome": outcome }));
        }
        if conflict && text == "让任务自己解决" {
            let stopped_reason = plan["deliveryHandoff"]["stoppedReason"]
                .as_str()
                .unwrap_or("merge_conflict");
            let target_branch = plan["deliveryBinding"]["targetBranch"]
                .as_str()
                .unwrap_or("HEAD");
            let instruction = format!(
                "用户要求解决合回问题：{stopped_reason}。在自己的 worktree 中整合目标分支 {target_branch}，解决冲突并重新验证，再交回结果。"
            );
            let child_conv = plan["conversationId"].as_str().unwrap_or(sid);
            self.conversations.append_message_idempotent(
                child_conv,
                &json!({
                    "id": format!("handoff-repair-{}", uuid::Uuid::new_v4()),
                    "role": "user",
                    "kind": "user_input",
                    "content": instruction,
                    "createdAt": at,
                }),
                &at,
                None,
            )?;
            let mut tasks = plan["tasks"].as_array().cloned().unwrap_or_default();
            tasks.push(json!({
                "taskId": format!("repair-{}", uuid::Uuid::new_v4()),
                "title": instruction,
                "status": "pending",
            }));
            plan["status"] = json!("executing");
            plan["resultAcceptance"] = Value::Null;
            plan["qualityReview"] = Value::Null;
            plan["tasks"] = Value::Array(tasks);
            plan["delegationOrigin"]["phase"] = json!("queued");
            plan["delegationOrigin"]["handoffAuthorizedAt"] = json!(at);
            plan["delegationOrigin"]["handoffDeferredAt"] = Value::Null;
            plan["runner"] = json!({
                "enabled": true,
                "status": "paused",
                "phase": "orient",
                "intent": "execute",
                "turnCount": 0,
            });
            plan["updatedAt"] = json!(at);
            self.supervisor.save_plan_json(&plan)?;
            let _ = self.supervisor.promote_queued(workspace_id, true);
            return Ok(json!({ "handled": true, "repairing": true }));
        }
        if (conflict && text == "我来处理") || (!conflict && text == "暂不合回") {
            let deferred_at = plan["deliveryHandoff"]["updatedAt"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| at.clone());
            plan["delegationOrigin"]["handoffDeferredAt"] = json!(deferred_at);
            plan["updatedAt"] = json!(at);
            self.supervisor.save_plan_json(&plan)?;
            return Ok(json!({ "handled": true, "deferred": true }));
        }
        if conflict && text == "放弃这次改动" {
            match self.supervisor.discard_worktree(workspace_id, sid, true) {
                Ok(true) => {
                    if let Some(mut refreshed) =
                        self.supervisor.find_plan_by_session(workspace_id, sid)
                    {
                        refreshed["status"] = json!("cancelled");
                        refreshed["delegationOrigin"]["phase"] = json!("cancelled");
                        refreshed["updatedAt"] = json!(at);
                        let _ = self.supervisor.save_plan_json(&refreshed);
                    }
                    return Ok(json!({ "handled": true, "discarded": true }));
                }
                Ok(false) => return Ok(json!({ "handled": true, "error": "cleanup_failed" })),
                Err(err) => return Ok(json!({ "handled": true, "error": err.code })),
            }
        }
        Ok(json!({ "handled": false }))
    }

    /// Explicit human confirmation of a `manual_dod_confirmation_required` completion review gate.
    pub fn confirm_completion_review(
        &self,
        workspace_id: &str,
        session_id: &str,
        review_token: &str,
    ) -> Result<Value, ProjectError> {
        let _ = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("BOT_NOT_BOUND"))?;
        self.require_held_or_acquire_lease(workspace_id)?;
        let token = review_token.trim();
        if token.is_empty() {
            return Ok(json!({ "ok": false, "error": "invalid_review" }));
        }
        let mut plan = self
            .supervisor
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let plan_id = plan["planId"]
            .as_str()
            .ok_or_else(|| ProjectError::code("INVALID_PLAN"))?
            .to_owned();
        let child_msgs = self
            .supervisor
            .child_conversation_messages(plan["conversationId"].as_str().unwrap_or(session_id));
        let report = build_session_report(
            &plan,
            session_id,
            plan["status"].as_str().unwrap_or(""),
            &child_msgs,
        );
        let review = project_completion_review_for_plan(&plan, &report);
        let confirmation_id = format!("completion-review:{token}");
        let previous = plan["manualConfirmations"].as_array().and_then(|arr| {
            arr.iter()
                .find(|row| row["confirmationId"].as_str() == Some(&confirmation_id))
                .cloned()
        });
        if let Some(ref prev) = previous {
            if prev["decision"] != "approve" {
                return Ok(json!({ "ok": false, "error": "stale_completion_review" }));
            }
            if plan["runner"]["status"] == "blocked"
                && plan["runner"]["blockedReason"] == "manual_dod_confirmation_required"
                && review.as_ref().and_then(|r| r["reviewToken"].as_str()) != Some(token)
            {
                return Ok(json!({ "ok": false, "error": "stale_completion_review" }));
            }
        } else {
            let Some(ref rev) = review else {
                return Ok(json!({ "ok": false, "error": "stale_completion_review" }));
            };
            if rev["reviewToken"].as_str() != Some(token) {
                return Ok(json!({ "ok": false, "error": "stale_completion_review" }));
            }
            let criterion_ids: Vec<Value> = rev["criteria"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|c| c.get("id").cloned())
                .collect();
            let at = now_iso();
            let mut confirmations = plan["manualConfirmations"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            confirmations.push(json!({
                "confirmationId": confirmation_id,
                "kind": "manual_dod",
                "decision": "approve",
                "criterionIds": criterion_ids,
                "decidedBy": "local_ui",
                "decidedAt": at,
            }));
            plan["manualConfirmations"] = Value::Array(confirmations);
            plan["updatedAt"] = json!(at);
            self.supervisor.save_plan_json(&plan)?;
            plan = self.supervisor.read_plan(&plan_id)?;
        }
        let still_blocked = !matches!(plan["status"].as_str(), Some("failed" | "cancelled"))
            && plan["runner"]["status"] == "blocked"
            && plan["runner"]["blockedReason"] == "manual_dod_confirmation_required";
        if still_blocked {
            plan["runner"]["status"] = json!("running");
            plan["runner"]["phase"] = json!("verify");
            plan["runner"]["intent"] = json!("verify");
            if let Some(obj) = plan["runner"].as_object_mut() {
                obj.remove("blockedReason");
            }
            plan["delegationOrigin"]["phase"] = json!("queued");
            plan["updatedAt"] = json!(now_iso());
            self.supervisor.save_plan_json(&plan)?;
        }
        Ok(if previous.is_some() {
            json!({ "ok": true, "alreadyConfirmed": true })
        } else {
            json!({ "ok": true })
        })
    }

    /// Resume a `paused` or `superseded` delegated session with idempotent user anchor message.
    pub fn resume_session_with_anchor(
        &self,
        workspace_id: &str,
        session_id: &str,
        request_id: &str,
    ) -> Result<Value, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("OUT_OF_SCOPE"))?;
        let conv_id = profile
            .agent_conversation_id
            .clone()
            .ok_or_else(|| ProjectError::code("OUT_OF_SCOPE"))?;
        if !self.holds_lease(workspace_id) {
            return Err(ProjectError::code("AGENT_OFFLINE"));
        }
        if request_id.is_empty()
            || request_id.len() > 100
            || !request_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(ProjectError::code("INVALID_INPUT"));
        }
        let mut plan = self
            .supervisor
            .find_plan_by_session(workspace_id, session_id)
            .ok_or_else(|| ProjectError::code("OUT_OF_SCOPE"))?;
        if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id)
            || plan["delegationOrigin"]["parentConversationId"].as_str() != Some(conv_id.as_str())
        {
            return Err(ProjectError::code("OUT_OF_SCOPE"));
        }
        let anchor_id = format!("resume:{session_id}:{request_id}");
        if plan["delegationOrigin"]["lastResumeAnchorMessageId"].as_str() == Some(&anchor_id) {
            let projected = get_session_projected(&self.data_home, session_id, Some("report"))
                .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
            return Ok(projected);
        }
        let summary = self
            .supervisor
            .list_sessions(workspace_id)
            .into_iter()
            .find(|s| s.session_id == session_id)
            .ok_or_else(|| ProjectError::code("OUT_OF_SCOPE"))?;
        if !matches!(summary.status.as_str(), "paused" | "superseded") {
            return Err(ProjectError::code("NOT_PAUSED"));
        }
        let ws_path = self
            .registry
            .get(workspace_id)?
            .map(|e| e.path)
            .unwrap_or_default();
        self.ensure_bot_anchor_message(
            &conv_id,
            workspace_id,
            &ws_path,
            &profile.display_name,
            &anchor_id,
            &format!("恢复任务「{}」", summary.title),
        )?;
        plan["delegationOrigin"]["lastResumeAnchorMessageId"] = json!(anchor_id);
        plan["updatedAt"] = json!(now_iso());
        self.supervisor.save_plan_json(&plan)?;
        self.supervisor
            .resume_session(workspace_id, session_id, true)?;
        let projected = get_session_projected(&self.data_home, session_id, Some("report"))
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        Ok(projected)
    }

    /// Retry a stopped/failed Bot turn by clearing its circuit breaker and requeuing its inputs.
    pub fn retry_turn(&self, workspace_id: &str, turn_id: &str) -> Result<Value, ProjectError> {
        let profile = self
            .profiles
            .read(workspace_id)
            .filter(BotProfile::is_active)
            .ok_or_else(|| ProjectError::code("NOT_FOUND"))?;
        let trimmed = turn_id.trim();
        if trimmed.is_empty() || trimmed.len() > 200 {
            return Err(ProjectError::code("INVALID_INPUT"));
        }
        self.require_held_or_acquire_lease(workspace_id)?;
        let mut target_inputs: Vec<String> = Vec::new();
        if let Some(ref conv_id) = profile.agent_conversation_id
            && let Ok(messages) =
                crate::read_full_conversation_messages(&self.conversations, conv_id)
        {
            for msg in messages.iter().rev() {
                let matches_turn =
                    msg["turnId"].as_str() == Some(trimmed) || msg["id"].as_str() == Some(trimmed);
                if !matches_turn {
                    continue;
                }
                for key in ["userInputs", "replyTo"] {
                    if let Some(arr) = msg[key].as_array() {
                        for val in arr {
                            if let Some(raw) = val.as_str() {
                                let iid = raw.strip_prefix("input-").unwrap_or(raw);
                                if !iid.is_empty() && !target_inputs.iter().any(|s| s == iid) {
                                    target_inputs.push(iid.to_owned());
                                }
                            }
                        }
                    }
                }
                if !target_inputs.is_empty() {
                    break;
                }
            }
        }
        self.runner.reset_circuit_breaker_for(workspace_id);
        let mut requeued = 0usize;
        if target_inputs.is_empty() {
            if self.retry_stopped_input(workspace_id, trimmed)? {
                requeued += 1;
            }
        } else {
            for iid in &target_inputs {
                if self.inputs.requeue_executed(workspace_id, iid, true)? {
                    requeued += 1;
                }
            }
        }
        Ok(json!({
            "ok": true,
            "turnId": trimmed,
            "requeued": requeued,
        }))
    }

    /// Deliver a user's question answer directly to an existing delegated session when the Bot agent is offline.
    pub fn deliver_offline_answer(
        &self,
        workspace_id: &str,
        session_id: &str,
        text: &str,
    ) -> Result<Value, ProjectError> {
        let sid = session_id.trim();
        let Some(plan) = self.supervisor.find_plan_by_session(workspace_id, sid) else {
            return Ok(json!({ "ok": false, "error": "workspace_mismatch" }));
        };
        if plan["delegationOrigin"]["workspaceId"].as_str() != Some(workspace_id) {
            return Ok(json!({ "ok": false, "error": "workspace_mismatch" }));
        }
        let had_lease = self.holds_lease(workspace_id);
        if !had_lease {
            match self.ensure_lease(workspace_id)? {
                LeaseStatus::Acquired { .. } => {}
                LeaseStatus::HeldByOther(_) => {
                    return Ok(json!({ "ok": false, "error": "lease_held" }));
                }
            }
        }
        let res = self
            .supervisor
            .message_session(workspace_id, sid, text, "answer", true);
        if !had_lease {
            let _ = self.release_lease(workspace_id);
        }
        res?;
        Ok(json!({ "ok": true, "userIntervened": true }))
    }
}

impl Drop for NativeProjectHost {
    fn drop(&mut self) {
        self.release_all_leases();
    }
}

/// Host-side routine lifecycle absorption (`wake-wait.mjs#hostWakeWait`): suppress redundant
/// wake turns when every event in the batch is a routine lifecycle update for an actively
/// advancing delegated session, or a cancellation event already initiated by the project agent
/// itself, and no session currently requires user or parent attention.
fn is_routine_host_wake_wait(events: &[Value], sessions: &[crate::WorkSessionSummary]) -> bool {
    if events.is_empty() {
        return false;
    }
    if sessions.iter().any(|row| {
        matches!(
            row.status.as_str(),
            "waiting_user" | "waiting_agent" | "result_ready" | "interrupted"
        )
    }) {
        return false;
    }
    let mut active_referenced = Vec::new();
    let mut cancelled_referenced = Vec::new();
    for ev in events {
        let kind = ev["kind"].as_str().unwrap_or("");
        let Some(sid) = ev["sessionId"].as_str().filter(|s| !s.is_empty()) else {
            return false;
        };
        if matches!(
            kind,
            "session_started"
                | "session_spawned"
                | "session_running"
                | "session_resumed"
                | "progress"
                | "session_progress"
        ) {
            if !active_referenced.contains(&sid) {
                active_referenced.push(sid);
            }
        } else if (kind == "session_ended"
            && ev["payload"]["status"].as_str() == Some("cancelled")
            && ev["payload"]["initiatedBy"].as_str() == Some("project_agent"))
            || (kind == "cancelled" && ev["payload"]["status"].as_str() == Some("cancelled"))
        {
            if !cancelled_referenced.contains(&sid) {
                cancelled_referenced.push(sid);
            }
        } else {
            return false;
        }
    }
    active_referenced.iter().all(|sid| {
        sessions.iter().any(|row| {
            row.session_id == *sid
                && matches!(
                    row.status.as_str(),
                    "queued" | "starting" | "running" | "verifying"
                )
        })
    }) && cancelled_referenced.iter().all(|sid| {
        sessions
            .iter()
            .any(|row| row.session_id == *sid && row.status == "cancelled")
    })
}

/// Helper for tests and `peer exec --bot` to serialize a compact bot list snapshot.
pub fn bot_list_json(host: &NativeProjectHost) -> Value {
    let by_ws = host.supervisor().list_all_bot_sessions();
    json!(host.directory().list(&by_ws))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn start_familiarize_spawns_readonly_research_session_and_is_idempotent() {
        let data_dir = tempdir().unwrap();
        let ws_dir = tempdir().unwrap();
        fs::write(ws_dir.path().join("README.md"), "# Demo repo\n").unwrap();
        fs::create_dir_all(ws_dir.path().join(".git/refs/heads")).unwrap();
        fs::write(ws_dir.path().join(".git/HEAD"), "ref: refs/heads/main\n").unwrap();
        fs::write(
            ws_dir.path().join(".git/refs/heads/main"),
            "abcdef1234567890\n",
        )
        .unwrap();

        let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", None).unwrap();
        let (entry, _) = host.bind_workspace(ws_dir.path(), Some("Demo")).unwrap();

        let page_before = host
            .directory()
            .read_interactions(&entry.workspace_id, 50, None)
            .unwrap();
        assert!(page_before.familiarize_offer.is_some());

        let first = host
            .start_familiarize(&entry.workspace_id, json!({}))
            .unwrap();
        assert!(!first.reused);
        let session_id = match first.kind {
            FamiliarizeKind::Research { session_id } => session_id.expect("session_id"),
            FamiliarizeKind::Blank => panic!("expected research plan for non-empty repo"),
        };

        let sessions = host.supervisor().list_sessions(&entry.workspace_id);
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].session_id, session_id);
        assert!(sessions[0].read_only);

        let prof = host.profiles().read(&entry.workspace_id).unwrap();
        let fam = prof.familiarize.expect("familiarize persisted");
        assert_eq!(fam["kind"], "research");
        assert_eq!(fam["dispatched"], true);
        assert!(
            fam["plan"]["task"]["brief"]
                .as_str()
                .unwrap()
                .contains("main")
        );

        let page_after = host
            .directory()
            .read_interactions(&entry.workspace_id, 50, None)
            .unwrap();
        assert!(page_after.familiarize_offer.is_none());

        let second = host
            .start_familiarize(&entry.workspace_id, json!({}))
            .unwrap();
        assert!(second.reused);
        assert_eq!(
            host.supervisor().list_sessions(&entry.workspace_id).len(),
            1
        );
    }

    #[test]
    fn start_familiarize_blank_workspace_asks_responsibility_question_without_spawning() {
        let data_dir = tempdir().unwrap();
        let ws_dir = tempdir().unwrap();
        fs::write(ws_dir.path().join(".gitkeep"), "").unwrap();

        let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", None).unwrap();
        let (entry, _) = host.bind_workspace(ws_dir.path(), Some("Blank")).unwrap();

        let res = host
            .start_familiarize(&entry.workspace_id, json!({}))
            .unwrap();
        assert!(!res.reused);
        assert_eq!(res.kind, FamiliarizeKind::Blank);
        assert_eq!(
            host.supervisor().list_sessions(&entry.workspace_id).len(),
            0
        );

        let page = host
            .directory()
            .read_interactions(&entry.workspace_id, 50, None)
            .unwrap();
        assert!(page.familiarize_offer.is_none());
        assert!(
            page.messages
                .iter()
                .any(|m| m["content"] == RESPONSIBILITY_QUESTION)
        );

        let prof = host.profiles().read(&entry.workspace_id).unwrap();
        assert_eq!(prof.familiarize.unwrap()["kind"], "blank");
    }

    #[test]
    fn desktop_host_lifecycle_readme_delete_and_question_guard() {
        let data_dir = tempdir().unwrap();
        let ws_dir = tempdir().unwrap();
        let host = NativeProjectHost::new_for_surface(
            data_dir.path(),
            HostSurface::Desktop,
            "0.1.0-test",
            None,
        )
        .unwrap();
        assert!(host.host_id().starts_with("desktop-"));
        assert_eq!(host.host_identity().surface(), HostSurface::Desktop);

        let entry = host
            .registry()
            .register(&ws_dir.path().to_string_lossy(), None)
            .unwrap();
        let (prof, created) = host
            .ensure_bot(&entry.workspace_id, true, Some("Managed Bot"))
            .unwrap();
        assert!(created);
        assert!(prof.managed);
        let (_, created_again) = host
            .ensure_bot(&entry.workspace_id, true, Some("Ignored"))
            .unwrap();
        assert!(!created_again);

        // accept_readme requires offer first
        let missing = host.accept_readme(&entry.workspace_id, json!({})).unwrap();
        assert_eq!(missing["ok"], false);
        assert_eq!(missing["code"], "OFFER_MISSING");

        let mut offered = host.profiles().read(&entry.workspace_id).unwrap();
        offered.readme_offer = Some(json!({ "offered": true }));
        host.profiles().save(offered).unwrap();
        let accepted = host.accept_readme(&entry.workspace_id, json!({})).unwrap();
        assert_eq!(accepted["ok"], true);
        let reused = host.accept_readme(&entry.workspace_id, json!({})).unwrap();
        assert_eq!(reused["ok"], true);
        assert_eq!(reused["reused"], true);

        // Question closure guard on submit_user_input_full
        let conv_id = host
            .profiles()
            .read(&entry.workspace_id)
            .unwrap()
            .agent_conversation_id
            .unwrap();
        host.conversations()
            .append_message_idempotent(
                &conv_id,
                &json!({
                    "id": "q-1",
                    "role": "assistant",
                    "kind": "agent_reply",
                    "content": "Choose?",
                    "question": { "prompt": "Choose?", "options": ["A", "B"] },
                    "createdAt": "2026-11-22T01:00:00.000Z",
                }),
                "2026-11-22T01:00:00.000Z",
                None,
            )
            .unwrap();
        let ans = host
            .submit_user_input_full(&SubmitInputRequest {
                workspace_id: &entry.workspace_id,
                input_id: "in-ans-1",
                surface: "desktop",
                text: "A",
                anchor_refs: vec![],
                quote_refs: vec![],
                task_refs: vec![],
                attachment_refs: vec![],
                attachments: vec![],
                answer_to: Some("card:question:reply:q-1".to_owned()),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            })
            .unwrap();
        assert_eq!(ans.input_id, "in-ans-1");
        // Idempotent repeat of same input_id succeeds
        let replay = host
            .submit_user_input_full(&SubmitInputRequest {
                workspace_id: &entry.workspace_id,
                input_id: "in-ans-1",
                surface: "desktop",
                text: "A",
                anchor_refs: vec![],
                quote_refs: vec![],
                task_refs: vec![],
                attachment_refs: vec![],
                attachments: vec![],
                answer_to: Some("card:question:reply:q-1".to_owned()),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            })
            .unwrap();
        assert_eq!(replay.input_id, "in-ans-1");
        // Different input_id for same question rejects
        let closed = host
            .submit_user_input_full(&SubmitInputRequest {
                workspace_id: &entry.workspace_id,
                input_id: "in-ans-2",
                surface: "desktop",
                text: "B",
                anchor_refs: vec![],
                quote_refs: vec![],
                task_refs: vec![],
                attachment_refs: vec![],
                attachments: vec![],
                answer_to: Some("card:question:reply:q-1".to_owned()),
                history_ref: None,
                history_snapshot_id: None,
                history_confirmed: None,
            })
            .unwrap_err();
        assert_eq!(closed.code, "QUESTION_CLOSED");

        // Managed delete prepare requires confirm_managed
        let need_confirm = host.delete_bot_prepare(&entry.workspace_id, false).unwrap();
        assert_eq!(need_confirm["ok"], false);
        assert_eq!(need_confirm["code"], "CONFIRM_REQUIRED");
        let prep = host.delete_bot_prepare(&entry.workspace_id, true).unwrap();
        assert_eq!(prep["archived"], true);
        let fin = host
            .delete_bot_finalize_cleanup(&entry.workspace_id, true, None)
            .unwrap();
        assert_eq!(fin["ok"], true);
        assert!(
            host.profiles()
                .read(&entry.workspace_id)
                .unwrap()
                .deletion_cleanup
                .is_none()
        );
    }

    #[test]
    fn confirm_completion_review_and_retry_turn_and_resume_anchor() {
        let data_dir = tempdir().unwrap();
        let ws_dir = tempdir().unwrap();
        let host = NativeProjectHost::new(data_dir.path(), "0.1.0-test", None).unwrap();
        let (entry, profile) = host.bind_workspace(ws_dir.path(), Some("Test")).unwrap();
        let ws = &entry.workspace_id;
        assert!(matches!(
            host.ensure_lease(ws).unwrap(),
            LeaseStatus::Acquired { .. }
        ));
        assert!(host.lease_epoch(ws).is_some());
        assert_eq!(host.owned_workspaces(), vec![ws.clone()]);

        // Retry turn test
        let inp = host
            .submit_user_input(ws, "retry-inp-1", "do thing", None)
            .unwrap();
        let conv_id = profile.agent_conversation_id.unwrap();
        let consumed = host
            .inputs()
            .consume(ws, &conv_id, host.conversations(), true)
            .unwrap();
        assert_eq!(consumed.pending_execution.len(), 1);
        host.inputs()
            .mark_executed(ws, std::slice::from_ref(&inp.input_id), &[], true)
            .unwrap();
        host.conversations()
            .append_message_idempotent(
                &conv_id,
                &json!({
                    "id": "turn-failed-1",
                    "role": "assistant",
                    "kind": "agent_turn",
                    "turnId": "turn-failed-1",
                    "userInputs": [format!("input-{}", inp.input_id)],
                    "replyTo": [format!("input-{}", inp.input_id)],
                    "createdAt": "2026-11-22T01:05:00.000Z",
                }),
                "2026-11-22T01:05:00.000Z",
                None,
            )
            .unwrap();
        let ret = host.retry_turn(ws, "turn-failed-1").unwrap();
        assert_eq!(ret["ok"], true);
        assert_eq!(ret["requeued"], 1);
        assert!(host.inputs().has_pending(ws));

        // Spawn session for completion review + pause/resume anchor test
        let summary = host
            .supervisor()
            .spawn_session(
                SpawnSessionRequest {
                    workspace_id: ws.clone(),
                    workspace_path: ws_dir.path().to_path_buf(),
                    parent_conversation_id: conv_id.clone(),
                    anchor_message_ids: vec![format!("input-{}", inp.input_id)],
                    input_id: inp.input_id.clone(),
                    surface: "desktop".to_owned(),
                    title: "Manual Review Task".to_owned(),
                    brief: "Do manual task".to_owned(),
                    kind: "implement".to_owned(),
                    read_only: false,
                    required_capabilities: vec![],
                    success_criteria: vec![SpawnCriterion {
                        id: Some("m1".to_owned()),
                        kind: "manual".to_owned(),
                        description: "User approves result".to_owned(),
                        command: None,
                        path: None,
                        expect: None,
                    }],
                    priority: "normal".to_owned(),
                    depends_on: vec![],
                    supersedes: None,
                    objective_id: None,
                    isolation: "none".to_owned(),
                    worker_model_selection: json!({}),
                },
                true,
            )
            .unwrap();
        host.conversations()
            .append_message_idempotent(
                &summary.session_id,
                &json!({
                    "id": "rep-1",
                    "role": "assistant",
                    "content": "Finished manual work summary",
                    "createdAt": "2026-11-22T01:06:00.000Z",
                }),
                "2026-11-22T01:06:00.000Z",
                None,
            )
            .unwrap();
        let mut plan = host.supervisor().read_plan(&summary.plan_id).unwrap();
        plan["delegationOrigin"]["phase"] = json!("running");
        plan["runner"] = json!({
            "enabled": true,
            "status": "blocked",
            "blockedReason": "manual_dod_confirmation_required",
        });
        host.supervisor().save_plan_json(&plan).unwrap();

        let child_msgs = host
            .supervisor()
            .child_conversation_messages(&summary.conversation_id);
        let report = build_session_report(
            &plan,
            &summary.session_id,
            plan["status"].as_str().unwrap_or(""),
            &child_msgs,
        );
        let review = project_completion_review_for_plan(&plan, &report).unwrap();
        let token = review["reviewToken"].as_str().unwrap().to_owned();
        let conf = host
            .confirm_completion_review(ws, &summary.session_id, &token)
            .unwrap();
        assert_eq!(conf["ok"], true);
        let updated_plan = host.supervisor().read_plan(&summary.plan_id).unwrap();
        assert_eq!(updated_plan["delegationOrigin"]["phase"], "queued");
        assert_eq!(updated_plan["runner"]["status"], "running");

        // Pause + resume with anchor
        host.supervisor()
            .control_session(ws, &summary.session_id, "pause", "user_pause", true)
            .unwrap();
        let resumed = host
            .resume_session_with_anchor(ws, &summary.session_id, "req-123")
            .unwrap();
        assert_eq!(resumed["status"], "queued");
        let resumed_idem = host
            .resume_session_with_anchor(ws, &summary.session_id, "req-123")
            .unwrap();
        assert_eq!(resumed_idem["sessionId"], summary.session_id);
    }

    #[test]
    fn routine_host_wake_wait_absorbs_agent_cancelled_events_but_keeps_failures() {
        let cancelled_session = crate::WorkSessionSummary {
            session_id: "sess-1".to_owned(),
            workspace_id: "ws-1".to_owned(),
            conversation_id: "sess-1".to_owned(),
            plan_id: "plan-1".to_owned(),
            title: "熟悉项目".to_owned(),
            status: "cancelled".to_owned(),
            phase: "cancelled".to_owned(),
            read_only: true,
            priority: "normal".to_owned(),
            updated_at: "2026-11-24T12:13:16.000Z".to_owned(),
            accepted: false,
            accepted_by: None,
            worktree_path: None,
            approval_id: None,
            handoff_status: None,
            anchor_message_ids: vec![],
        };
        let agent_cancel = vec![json!({
            "kind": "session_ended",
            "sessionId": "sess-1",
            "payload": { "status": "cancelled", "initiatedBy": "project_agent" }
        })];
        assert!(is_routine_host_wake_wait(
            &agent_cancel,
            std::slice::from_ref(&cancelled_session)
        ));

        let duplicate_cancelled = vec![json!({
            "kind": "cancelled",
            "sessionId": "sess-1",
            "payload": { "status": "cancelled" }
        })];
        assert!(is_routine_host_wake_wait(
            &duplicate_cancelled,
            std::slice::from_ref(&cancelled_session)
        ));

        let failed_event = vec![json!({
            "kind": "session_ended",
            "sessionId": "sess-1",
            "payload": { "status": "failed" }
        })];
        assert!(!is_routine_host_wake_wait(
            &failed_event,
            std::slice::from_ref(&cancelled_session)
        ));

        let external_cancel = vec![json!({
            "kind": "session_ended",
            "sessionId": "sess-1",
            "payload": { "status": "cancelled" }
        })];
        assert!(!is_routine_host_wake_wait(
            &external_cancel,
            std::slice::from_ref(&cancelled_session)
        ));
    }
}
