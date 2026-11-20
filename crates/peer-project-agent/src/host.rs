//! Native Project Agent Host composition root (ADR 80, ADR 85, ADR 88, ADR 129–131).
//!
//! Coordinates `ProjectRegistry`, `BotProfileStore`, `HostLeaseStore`, `InputQueue`,
//! `InputDraftStore`, `ProjectInbox`, `ApprovalStore`, `MemoryStore`, `ObjectiveStore`,
//! `WatchHost`, `SessionSupervisor`, `ProjectAgentRunner`, and `BotDirectory`.

use crate::{
    AgentTurnOutcome, BotDirectory, BotProfile, BotProfileStore, CreateBotProfile, InputDraftStore,
    InputQueue, MemoryStore, ObjectiveStore, ProjectError, ProjectInbox, ProjectInput,
    ProjectRegistry, ProjectRegistryEntry, SessionSupervisor, SpawnCriterion, SpawnSessionRequest,
    SubmitInputRequest, WatchHost, now_iso, parse_iso_ms,
    runner::{ProjectAgentRunner, RunTurnOptions},
};
use peer_runtime::{CancellationToken, model::NativeModel, session_host::PermissionInput};
use peer_store::{
    AcquireLease, ApprovalStore, ConversationStore, HostIdentity, HostLeaseRecord, HostLeaseStore,
    HostSurface, LeaseToken, NewProjectConversation, PolicyStore, StoreError,
};
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
        self.held_leases
            .lock()
            .ok()
            .and_then(|held| {
                held.get(workspace_id)
                    .map(|tok| tok.takeover_requested().unwrap_or(false))
            })
            .unwrap_or(false)
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

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(report);
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
                return Ok(report);
            }
        }

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(report);
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

        if self.takeover_requested(workspace_id) {
            report.held_lease = false;
            let _ = self.release_lease(workspace_id);
            return Ok(report);
        }

        // Refresh lease heartbeat after worker execution before draining inbox wakes.
        if !cancel.is_cancelled() && self.holds_lease(workspace_id) {
            let _ = self.ensure_lease(workspace_id);
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
