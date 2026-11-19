//! Native Project Agent Host composition root (ADR 80, ADR 85, ADR 88, ADR 129–131).
//!
//! Coordinates `ProjectRegistry`, `BotProfileStore`, `HostLeaseStore`, `InputQueue`,
//! `InputDraftStore`, `ProjectInbox`, `ApprovalStore`, `MemoryStore`, `ObjectiveStore`,
//! `WatchHost`, `SessionSupervisor`, `ProjectAgentRunner`, and `BotDirectory`.

use crate::{
    AgentTurnOutcome, BotDirectory, BotProfile, BotProfileStore, CreateBotProfile, InputDraftStore,
    InputQueue, MemoryStore, ObjectiveStore, ProjectError, ProjectInbox, ProjectInput,
    ProjectRegistry, ProjectRegistryEntry, SessionSupervisor, SubmitInputRequest, WatchHost,
    now_iso, parse_iso_ms,
    runner::{ProjectAgentRunner, RunTurnOptions},
};
use peer_runtime::{CancellationToken, model::NativeModel, session_host::PermissionInput};
use peer_store::{
    AcquireLease, ApprovalStore, ConversationStore, HostIdentity, HostLeaseRecord, HostLeaseStore,
    HostSurface, LeaseToken, NewProjectConversation, PolicyStore,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

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

pub struct NativeProjectHost {
    data_home: PathBuf,
    host_identity: HostIdentity,
    registry: ProjectRegistry,
    profiles: BotProfileStore,
    leases: HostLeaseStore,
    held_leases: Mutex<HashMap<String, LeaseToken>>,
    recovered_workspaces: Mutex<HashMap<String, bool>>,
    inputs: InputQueue,
    drafts: InputDraftStore,
    inbox: ProjectInbox,
    approvals: ApprovalStore,
    memory: MemoryStore,
    objectives: ObjectiveStore,
    watches: WatchHost,
    supervisor: Arc<SessionSupervisor>,
    runner: ProjectAgentRunner,
    directory: BotDirectory,
    conversations: ConversationStore,
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
        let runner = ProjectAgentRunner::new(&home, Arc::clone(&supervisor));
        Ok(Self {
            registry: ProjectRegistry::new(&home),
            profiles: BotProfileStore::new(&home),
            leases: HostLeaseStore::new(&home),
            held_leases: Mutex::new(HashMap::new()),
            recovered_workspaces: Mutex::new(HashMap::new()),
            inputs: InputQueue::new(&home),
            drafts: InputDraftStore::new(&home),
            inbox: ProjectInbox::new(&home),
            approvals: ApprovalStore::new(&home),
            memory: MemoryStore::new(&home),
            objectives: ObjectiveStore::new(&home),
            watches: WatchHost::new(&home),
            directory: BotDirectory::new(&home),
            conversations: ConversationStore::new(&home),
            supervisor,
            runner,
            host_identity,
            data_home: home,
        })
    }

    pub fn data_home(&self) -> &Path {
        &self.data_home
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
    pub fn watches(&self) -> &WatchHost {
        &self.watches
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
        let mut held = self
            .held_leases
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?;
        if let Some(token) = held.get_mut(workspace_id) {
            match token.heartbeat(now_ms) {
                Ok(_) => return Ok(LeaseStatus::Acquired { took_over: false }),
                Err(_) => {
                    held.remove(workspace_id);
                }
            }
        }
        match self
            .leases
            .acquire(workspace_id, &self.host_identity, now_ms)?
        {
            AcquireLease::Acquired { token, took_over } => {
                held.insert(workspace_id.to_owned(), token);
                Ok(LeaseStatus::Acquired { took_over })
            }
            AcquireLease::Held(record) => Ok(LeaseStatus::HeldByOther(record)),
        }
    }

    pub fn holds_lease(&self, workspace_id: &str) -> bool {
        self.held_leases
            .lock()
            .map(|g| g.contains_key(workspace_id))
            .unwrap_or(false)
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
        let token = self
            .held_leases
            .lock()
            .map_err(|_| ProjectError::code("STATE_LOCK_POISONED"))?
            .remove(workspace_id);
        if let Some(tok) = token {
            tok.release()?;
        }
        Ok(())
    }

    pub fn release_all_leases(&self) {
        if let Ok(mut held) = self.held_leases.lock() {
            for (_, token) in held.drain() {
                let _ = token.release();
            }
        }
    }

    /// Submit a durable user input to the shared `InputQueue` (works both as Host and Client).
    pub fn submit_user_input(
        &self,
        workspace_id: &str,
        input_id: &str,
        text: &str,
        answer_to: Option<String>,
    ) -> Result<ProjectInput, ProjectError> {
        self.inputs.submit_input(&SubmitInputRequest {
            workspace_id,
            input_id,
            surface: "tui",
            text,
            anchor_refs: vec![],
            quote_refs: vec![],
            attachment_refs: vec![],
            answer_to,
        })
    }

    /// Run one full native host synchronization cycle for `workspace_id`:
    /// 1. Lease acquisition / heartbeat (if another host holds fresh lease, returns immediately as client).
    /// 2. Startup recovery once per lease epoch.
    /// 3. Consume durable `InputQueue` into bot conversation.
    /// 4. Drive main Bot cognition for pending user inputs (user input preempts wakes).
    /// 5. Promote & execute eligible delegated work sessions via `NativeSessionHost`.
    /// 6. Drain `ProjectInbox` wake events so main Bot reports verified results and triggers policy acceptance.
    pub async fn tick(
        &self,
        workspace_id: &str,
        model: &NativeModel,
        worker_model_selection: Value,
        worker_permission: &mut impl PermissionInput,
        cancel: &CancellationToken,
    ) -> Result<HostTickReport, ProjectError> {
        let mut report = HostTickReport {
            workspace_id: workspace_id.to_owned(),
            held_lease: false,
            inputs_consumed: 0,
            bot_turns_run: 0,
            sessions_promoted: 0,
            sessions_executed: 0,
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
                return Ok(report);
            }
        }

        // Run one-time startup recovery for this workspace on first tick after lease acquisition.
        let needs_recovery = self
            .recovered_workspaces
            .lock()
            .map(|g| !g.contains_key(workspace_id))
            .unwrap_or(false);
        if needs_recovery {
            let _ = self
                .supervisor
                .recover_workspace(workspace_id, cancel, true)
                .await;
            if let Ok(mut g) = self.recovered_workspaces.lock() {
                g.insert(workspace_id.to_owned(), true);
            }
        }

        // Step 1: Consume pending durable inputs into bot conversation.
        let consumed = self
            .inputs
            .consume(workspace_id, &conv_id, &self.conversations, true)?;
        report.inputs_consumed = consumed.consumed.len();

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
            let completed_id = vec![input.input_id.clone()];
            let _ = self
                .inputs
                .mark_executed(workspace_id, &completed_id, &[], true);
            report.last_turn = Some(outcome);
        }

        // Step 3: Promote queued delegated work sessions and run ready episodes.
        let promoted = self.supervisor.promote_queued(workspace_id, true)?;
        report.sessions_promoted = promoted.start.len();
        for sid in promoted.start {
            if cancel.is_cancelled() {
                break;
            }
            let is_legacy = self
                .supervisor
                .find_plan_by_session(workspace_id, &sid)
                .is_some_and(|p| p["delegationOrigin"]["coordinationBinding"].is_object());
            if is_legacy {
                self.release_lease(workspace_id)?;
            }
            let run_res = Box::pin(self.supervisor.run_session_episode(
                workspace_id,
                &sid,
                model,
                worker_permission,
                16,
                cancel,
                true,
            ))
            .await;
            if is_legacy {
                let _ = self.ensure_lease(workspace_id)?;
            }
            if run_res.is_ok() {
                report.sessions_executed += 1;
            }
        }

        // Step 4: Drain ProjectInbox wake events (e.g. report_available / session_ended).
        let now_ms = parse_iso_ms(&now_iso()).unwrap_or(0);
        let batch = self.inbox.take_batch(workspace_id, now_ms, true);
        if !batch.events.is_empty() && !cancel.is_cancelled() && self.holds_lease(workspace_id) {
            let outcome = Box::pin(self.runner.run_turn(
                &RunTurnOptions {
                    workspace_id,
                    workspace_path: &ws_path,
                    conversation_id: &conv_id,
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

    pub fn close(&self) {
        self.release_all_leases();
    }
}

impl Drop for NativeProjectHost {
    fn drop(&mut self) {
        self.release_all_leases();
    }
}

/// Helper for tests and `peer exec --bot` to serialize a compact bot list snapshot.
pub fn bot_list_json(host: &NativeProjectHost) -> Value {
    let mut by_ws = HashMap::new();
    for ws in host.profiles().list_workspace_ids() {
        by_ws.insert(ws.clone(), host.supervisor().list_bot_sessions(&ws));
    }
    json!(host.directory().list(&by_ws))
}
