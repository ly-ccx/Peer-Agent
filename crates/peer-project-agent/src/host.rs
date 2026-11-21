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
    ProjectInput, ProjectRecoveryBarrier, ProjectRegistry, ProjectRegistryEntry,
    RecoveryDiagnostic, SessionSupervisor, SpawnCriterion, SpawnSessionRequest, SubmitInputRequest,
    WatchHost, WatchPublisher, collect_conversation_search_documents, now_iso, parse_iso_ms,
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
        let home = data_home.as_ref().to_path_buf();
        let host_identity = HostIdentity::new(
            &format!("tui-{}", uuid::Uuid::new_v4()),
            HostSurface::Tui,
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
            let outcome = Box::pin(self.runner.run_turn(
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
        model: &NativeModel,
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
        let outcome = Box::pin(self.runner.run_turn(
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
        let Some((conv_id, ws_path, mut report, stopped)) = self
            .run_user_input_phase(workspace_id, model, &worker_model_selection, cancel)
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
                model,
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
            .run_user_input_phase(workspace_id, model, &worker_model_selection, cancel)
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
                16,
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
                model,
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
        let snapshot = match self
            .conversations
            .read_committed(conv_id, None, 8 * 1024 * 1024)
        {
            Ok(s) => s,
            Err(peer_store::StoreError::NotFound) => return Ok(None),
            Err(e) => return Err(e.into()),
        };
        Ok(snapshot.history.messages.into_iter().find(|msg| {
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
            match self
                .conversations
                .read_committed(&conv_id, None, 1024 * 1024)
            {
                Ok(_) => {}
                Err(StoreError::NotFound) => {
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
                            "queue" => {
                                let _ = self.approvals.recover_owned(
                                    Some(workspace_id),
                                    &now_iso(),
                                    None,
                                )?;
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
            && let Ok(snap) = self
                .conversations
                .read_committed(&conv_id, None, 4 * 1024 * 1024)
        {
            for m in snap.history.messages {
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
                && let Ok(snap) = self
                    .conversations
                    .read_committed(conv_id, None, 4 * 1024 * 1024)
            {
                for m in snap.history.messages {
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
}

impl Drop for NativeProjectHost {
    fn drop(&mut self) {
        self.release_all_leases();
    }
}

/// Host-side routine lifecycle absorption (`wake-wait.mjs#hostWakeWait`): suppress redundant
/// wake turns when every event in the batch is a routine lifecycle update for an actively
/// advancing delegated session and no session currently requires user or parent attention.
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
    let mut referenced = Vec::new();
    for ev in events {
        let kind = ev["kind"].as_str().unwrap_or("");
        if !matches!(
            kind,
            "session_started"
                | "session_spawned"
                | "session_running"
                | "session_resumed"
                | "progress"
                | "session_progress"
        ) {
            return false;
        }
        let Some(sid) = ev["sessionId"].as_str().filter(|s| !s.is_empty()) else {
            return false;
        };
        if !referenced.contains(&sid) {
            referenced.push(sid);
        }
    }
    referenced.iter().all(|sid| {
        sessions.iter().any(|row| {
            row.session_id == *sid
                && matches!(
                    row.status.as_str(),
                    "queued" | "starting" | "running" | "verifying"
                )
        })
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
}
