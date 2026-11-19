//! Full native `--classic` interactive chat shell (ADR 80, ADR 129, ADR 130, ADR 131).
//!
//! Runs new or ongoing conversations directly on `NativeConversationRuntime` with
//! bounded Markdown/code/diff virtualization, reading-anchor protection, separated
//! permission/display channels, unified ModelPicker (`F3` / `/model` / `Ctrl+X M`),
//! `/resume` picker (`Ctrl+X L`), `/mode`, `/permissions`, `/fast`, `/theme`,
//! `/language`, `/skill`, `/mcp`, `/clear`, `/compact`, `/history`, `/goals`, `/help`,
//! `/version`, and clean Ctrl-C cancellation + continuation. Zero files are created
//! until the user sends a prompt or explicitly saves/toggles settings.

use super::{
    ShellOutcome, TerminalGuard,
    capability_store::{load_mcp_servers, load_skills, set_mcp_server_enabled, set_skill_enabled},
    model_picker_adapter::load_picker_groups,
    resumed::ports::{Approval, Display, OutputPort, PermissionPort, bounded_text},
    theme_store::{self, TerminalPreferences},
};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use peer_protocol::{LocalAccessLevel, TranscriptCursor, TranscriptRow};
use peer_runtime::{
    CancellationToken, capability,
    conversation_host::{
        CompactOptions, CompactOutcome, ConversationAccess, ConversationOptions,
        NativeConversationRuntime,
    },
    goal_facts::TuiGoalProjector,
    model_catalog::{resolve_exact_session_model, resolve_exec, supports_fast_mode},
    providers::RuntimeMode,
    session_host::LocalPermissionDecision,
    subscription_quota::{
        SubscriptionQuotaSnapshot, fetch_subscription_quota, supports_subscription_quota,
    },
};
use peer_store::{
    ConversationModelSelection, ConversationStore, GoalStore, TranscriptLimits, TranscriptReader,
};
use peer_tui::{
    Action, ByteBudgetLru, ClassicCommand, ClassicMessage, ClassicOverlay, ClassicView, Composer,
    Effect, GoalMenuStatus, GoalPickerRow, HistoryDirection, LeaderAction, LeaderKeyState,
    MARKDOWN_WRAP_CACHE_BYTES, ModelPickerEvent, ModelPickerState, ReadingAnchor, RenderedBlock,
    ResumeSessionRow, SlashFilterContext, ThemeMode, ToolRowStatus, ToolTimelineRow, TuiLocale,
    UserInputPrompt, WORKING_ANIMATION_INTERVAL_MS, WrapCacheKey, action_for_event,
    compact_workspace_path, filter_classic_slash_items, format_topbar_quota, parse_classic_command,
    render_classic, terminal_text,
};
use serde_json::Value;
use std::{
    io,
    path::PathBuf,
    rc::Rc,
    time::{Duration, Instant},
};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, LocalSet},
};

const MAX_DISPLAY_MESSAGES: usize = 64;
const IDLE_STATUS: &str = "";
const APPROVAL_STATUS: &str = "等待授权…";
const QUOTA_REFRESH_INTERVAL: Duration = Duration::from_secs(300);

struct ActiveTurn {
    cancel: CancellationToken,
    task: JoinHandle<Result<String, &'static str>>,
    display: watch::Receiver<Display>,
    prompts: mpsc::Receiver<Approval>,
    accepted: bool,
    revision: usize,
    delta_revision: usize,
    started_at: Instant,
    cancelling: bool,
}

struct ActiveCompaction {
    cancel: CancellationToken,
    task: JoinHandle<Result<CompactOutcome, &'static str>>,
    started_at: Instant,
    cancelling: bool,
}

struct PendingUserInput {
    prompt: UserInputPrompt,
    selected: usize,
    dismissed: bool,
}

pub(super) struct ClassicSession<'a> {
    home: PathBuf,
    launch_workspace: PathBuf,
    workspace: PathBuf,
    prefs: &'a mut TerminalPreferences,
    conversation_id: Option<String>,
    runtime: Rc<NativeConversationRuntime>,
    access: ConversationAccess,
    access_level: LocalAccessLevel,
    mode: RuntimeMode,
    fast_mode: bool,
    fast_available: bool,
    selected_provider: Option<String>,
    selected_model: Option<String>,
    selected_display_name: Option<String>,
    selected_effort: Option<String>,
    context_percent: Option<u8>,
    quota: Option<SubscriptionQuotaSnapshot>,
    quota_provider_id: Option<String>,
    quota_fetched_at: Option<Instant>,
    quota_task: Option<(
        CancellationToken,
        JoinHandle<Option<SubscriptionQuotaSnapshot>>,
    )>,
    goal_plans: Vec<GoalPickerRow>,
    selected_goal_plan_id: Option<String>,
    composer: Composer,
    messages: Vec<ClassicMessage>,
    older: Option<TranscriptCursor>,
    anchor: ReadingAnchor,
    status: String,
    status_is_error: bool,
    interrupted_preview: String,
    active: Option<ActiveTurn>,
    compacting: Option<ActiveCompaction>,
    last_anim_draw: Option<Instant>,
    tools_expanded: bool,
    approval: Option<Approval>,
    pending_user_input: Option<PendingUserInput>,
    model_picker: ModelPickerState,
    overlay: ClassicOverlay,
    leader: LeaderKeyState,
    slash_selected: usize,
    wrap_cache: ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

impl<'a> ClassicSession<'a> {
    fn new(home: PathBuf, workspace: PathBuf, prefs: &'a mut TerminalPreferences) -> Self {
        let access = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
        let runtime = Rc::new(NativeConversationRuntime::new(&home, access.clone()));
        let mut selected_provider = None;
        let mut selected_model = None;
        let mut selected_display_name = None;
        let mut selected_effort = None;
        if let Ok(resolved) = resolve_exec(&home, None, None, None, false) {
            selected_provider = Some(resolved.entry.provider_id);
            selected_model = Some(resolved.entry.model_id);
            selected_display_name = Some(resolved.entry.display_name);
            selected_effort = resolved.selection["reasoningEffort"]
                .as_str()
                .map(str::to_owned);
        }
        let mut session = Self {
            home,
            launch_workspace: workspace.clone(),
            workspace,
            prefs,
            conversation_id: None,
            runtime,
            access,
            access_level: LocalAccessLevel::AskBeforeLocal,
            mode: RuntimeMode::Chat,
            fast_mode: false,
            fast_available: false,
            selected_provider,
            selected_model,
            selected_display_name,
            selected_effort,
            context_percent: None,
            quota: None,
            quota_provider_id: None,
            quota_fetched_at: None,
            quota_task: None,
            goal_plans: Vec::new(),
            selected_goal_plan_id: None,
            composer: Composer::default(),
            messages: Vec::new(),
            older: None,
            anchor: ReadingAnchor::FollowingLatest,
            status: IDLE_STATUS.to_owned(),
            status_is_error: false,
            interrupted_preview: String::new(),
            active: None,
            compacting: None,
            last_anim_draw: None,
            tools_expanded: false,
            approval: None,
            pending_user_input: None,
            model_picker: ModelPickerState::default(),
            overlay: ClassicOverlay::None,
            leader: LeaderKeyState::default(),
            slash_selected: 0,
            wrap_cache: ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 512),
        };
        session.refresh_fast_available();
        session
    }

    fn is_busy(&self) -> bool {
        self.active.is_some() || self.compacting.is_some()
    }

    fn set_notice(&mut self, message: impl Into<String>, is_error: bool) {
        self.status = message.into();
        self.status_is_error = is_error;
    }

    fn clear_notice(&mut self) {
        self.status.clear();
        self.status_is_error = false;
    }

    fn cancel_quota_task(&mut self) {
        if let Some((cancel, _task)) = self.quota_task.take() {
            cancel.cancel();
        }
    }

    fn maybe_spawn_quota_refresh(&mut self, force: bool) {
        let provider_id = self
            .selected_provider
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        if provider_id != self.quota_provider_id {
            self.cancel_quota_task();
            self.quota = None;
            self.quota_provider_id = provider_id.clone();
            self.quota_fetched_at = None;
        }
        let Some(provider_id) = provider_id else {
            return;
        };
        if !supports_subscription_quota(&self.home, &provider_id) {
            self.cancel_quota_task();
            self.quota = None;
            return;
        }
        let stale = match self.quota_fetched_at {
            None => true,
            Some(at) => at.elapsed() >= QUOTA_REFRESH_INTERVAL,
        };
        if !force && !stale {
            return;
        }
        if self.quota_task.is_some() {
            if !force {
                return;
            }
            self.cancel_quota_task();
        }
        let home = self.home.clone();
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        self.quota_fetched_at = Some(Instant::now());
        let task = tokio::task::spawn_local(async move {
            fetch_subscription_quota(&home, &provider_id, &task_cancel).await
        });
        self.quota_task = Some((cancel, task));
    }

    async fn shutdown_tasks(&mut self) {
        if let Some((cancel, task)) = self.quota_task.take() {
            cancel.cancel();
            let _ = task.await;
        }
        if let Some(active) = self.active.take() {
            active.cancel.cancel();
            let _ = active.task.await;
        }
        if let Some(comp) = self.compacting.take() {
            comp.cancel.cancel();
            let _ = comp.task.await;
        }
    }

    fn model_badge(&self) -> String {
        if let Some(name) = self
            .selected_display_name
            .as_deref()
            .filter(|s| !s.is_empty())
        {
            return name.to_owned();
        }
        match &self.selected_model {
            Some(m) => m.clone(),
            None => "未配置模型".to_owned(),
        }
    }

    fn access_badge(&self) -> &'static str {
        match self.access_level {
            LocalAccessLevel::AskBeforeLocal => "ask",
            LocalAccessLevel::SessionLocal => "session",
            LocalAccessLevel::FullLocal => "full",
            LocalAccessLevel::RestrictedLocal => "restricted",
        }
    }

    fn refresh_fast_available(&mut self) {
        self.fast_available = match (&self.selected_provider, &self.selected_model) {
            (Some(p), Some(m)) => supports_fast_mode(&self.home, p, m),
            _ => false,
        };
        if !self.fast_available {
            self.fast_mode = false;
        }
    }

    fn refresh_context_percent(&mut self) {
        let Some(ref cid) = self.conversation_id else {
            self.context_percent = None;
            return;
        };
        let (Some(provider), Some(model)) = (&self.selected_provider, &self.selected_model) else {
            self.context_percent = None;
            return;
        };
        let key = format!("{provider}::{model}");
        let store = ConversationStore::new(&self.home);
        if let Ok(snap) = store.read_committed(cid, None, 8 * 1024 * 1024)
            && let Ok(Some(ctx)) = store.read_context_snapshot(&snap, &key)
        {
            let pct = ctx["percent"].as_u64().or_else(|| {
                let used = ctx["authoritativeInputTokens"].as_u64()?;
                let budget = ctx["inputBudget"].as_u64().filter(|b| *b > 0)?;
                Some((used * 100 / budget).min(100))
            });
            self.context_percent = pct.map(|p| p.min(100) as u8);
            return;
        }
        self.context_percent = None;
    }

    fn refresh_goal_plans(&mut self) {
        let Some(ref cid) = self.conversation_id else {
            self.goal_plans.clear();
            self.selected_goal_plan_id = None;
            return;
        };
        let Ok(projector) = TuiGoalProjector::new(&capability::now()) else {
            return;
        };
        let store = GoalStore::new(&self.home);
        let Ok(snaps) = store.list_by_conversation(cid, &projector, None) else {
            return;
        };
        self.goal_plans = snaps
            .into_iter()
            .filter_map(|snap| {
                let plan_id = snap.facts["planId"].as_str()?.to_owned();
                let status = snap.facts["runner"]["status"]
                    .as_str()
                    .or_else(|| snap.facts["status"].as_str())
                    .unwrap_or("unknown")
                    .to_owned();
                let completed = snap.facts["progress"]["completed"].as_u64().unwrap_or(0) as usize;
                let total = snap.facts["progress"]["total"].as_u64().unwrap_or(0) as usize;
                let title = store
                    .read_context(&plan_id, &snap.source_revision)
                    .ok()
                    .and_then(|v| {
                        v["title"]
                            .as_str()
                            .or_else(|| v["goal"].as_str())
                            .map(str::trim)
                            .filter(|s| !s.is_empty())
                            .map(str::to_owned)
                    })
                    .unwrap_or_else(|| plan_id.clone());
                Some(GoalPickerRow {
                    plan_id,
                    title,
                    status,
                    completed,
                    total,
                })
            })
            .collect();
        if self
            .selected_goal_plan_id
            .as_ref()
            .is_none_or(|id| !self.goal_plans.iter().any(|p| &p.plan_id == id))
        {
            self.selected_goal_plan_id = self.goal_plans.first().map(|p| p.plan_id.clone());
        }
    }

    fn goal_menu_status(&self) -> GoalMenuStatus {
        let active = self
            .selected_goal_plan_id
            .as_deref()
            .and_then(|id| self.goal_plans.iter().find(|p| p.plan_id == id))
            .or_else(|| self.goal_plans.first());
        match active.map(|p| p.status.as_str()) {
            Some("running" | "executing" | "accepted") => GoalMenuStatus::Running,
            Some("paused" | "interrupted") => GoalMenuStatus::Paused,
            _ => GoalMenuStatus::None,
        }
    }

    fn goal_banner(&self) -> Option<String> {
        let active = self
            .selected_goal_plan_id
            .as_deref()
            .and_then(|id| self.goal_plans.iter().find(|p| p.plan_id == id))
            .or_else(|| self.goal_plans.first())?;
        Some(format!(
            "Goal · {} · {} ({}/{}) · /goals 切换",
            terminal_text(&active.title),
            active.status,
            active.completed,
            active.total
        ))
    }

    fn reload_transcript(&mut self, cursor: Option<TranscriptCursor>) -> bool {
        let Some(ref conv_id) = self.conversation_id else {
            return false;
        };
        let limits = TranscriptLimits {
            records: MAX_DISPLAY_MESSAGES,
            ..TranscriptLimits::default()
        };
        match TranscriptReader::new(&self.home).read_page(conv_id, cursor.as_ref(), limits, None) {
            Ok(page) => {
                self.older = page.older;
                let pending_prompt = if cursor.is_none() {
                    find_pending_user_input(&page.rows)
                } else {
                    None
                };
                let mut rows = Vec::with_capacity(page.rows.len());
                let mut streams = Vec::with_capacity(page.rows.len());
                for (idx, row) in page.rows.into_iter().enumerate() {
                    let (stream_id, msg) = parse_transcript_row(row, idx);
                    streams.push(stream_id);
                    rows.push(msg);
                }
                apply_continuation(&mut rows, &streams);
                if cursor.is_some() {
                    let existing = std::mem::take(&mut self.messages);
                    rows.extend(existing);
                    if rows.len() > MAX_DISPLAY_MESSAGES {
                        rows.truncate(MAX_DISPLAY_MESSAGES);
                    }
                    if let Some(first) = rows.first_mut() {
                        first.continuation = false;
                    }
                    self.messages = rows;
                } else {
                    if rows.len() > MAX_DISPLAY_MESSAGES {
                        let drop_n = rows.len() - MAX_DISPLAY_MESSAGES;
                        rows.drain(..drop_n);
                    }
                    if let Some(first) = rows.first_mut() {
                        first.continuation = false;
                    }
                    self.messages = rows;
                    match pending_prompt {
                        Some(found) => match self.pending_user_input.as_mut() {
                            Some(existing) if existing.prompt == found => {
                                existing.selected = existing.selected.min(found.options.len() - 1);
                            }
                            _ => {
                                self.pending_user_input = Some(PendingUserInput {
                                    prompt: found,
                                    selected: 0,
                                    dismissed: false,
                                });
                            }
                        },
                        None => {
                            self.pending_user_input = None;
                        }
                    }
                }
                true
            }
            Err(_) => false,
        }
    }

    fn open_model_picker(&mut self) {
        match load_picker_groups(&self.home) {
            Ok(groups) => {
                self.model_picker.open_with(
                    groups,
                    self.selected_provider.clone(),
                    self.selected_model.clone(),
                    self.selected_effort.clone(),
                );
            }
            Err(code) => {
                self.status = format!("无法读取模型配置（{code}）");
            }
        }
    }

    fn open_resume_picker(&mut self) {
        if self.is_busy() {
            self.status = "本轮进行中，请先停止再恢复会话。".to_owned();
            return;
        }
        let rows_raw = match ConversationStore::new(&self.home).list_resumable_sessions(None) {
            Ok(r) => r,
            Err(err) => {
                self.status = format!("读取历史会话失败（{}）。", err.code());
                return;
            }
        };
        let cur_ws = std::fs::canonicalize(&self.workspace)
            .ok()
            .and_then(|p| p.to_str().map(str::to_owned));
        let mut current_ws_rows = Vec::new();
        let mut other_ws_rows = Vec::new();
        for item in rows_raw {
            if self.conversation_id.as_deref() == Some(item.id.as_str()) || item.message_count == 0
            {
                continue;
            }
            let same_ws =
                cur_ws.as_deref().is_some() && item.workspace_path.as_deref() == cur_ws.as_deref();
            let workspace_tag = if same_ws {
                None
            } else {
                item.workspace_path.as_deref().and_then(|p| {
                    std::path::Path::new(p)
                        .file_name()
                        .and_then(|n| n.to_str())
                        .map(str::to_owned)
                })
            };
            let title = item
                .title
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("未命名会话")
                .to_owned();
            let row = ResumeSessionRow {
                id: item.id,
                title,
                message_count: item.message_count,
                updated_at: item.updated_at.or(item.created_at),
                workspace_tag,
                mode: item.mode.unwrap_or_else(|| "chat".to_owned()),
            };
            if same_ws {
                current_ws_rows.push(row);
            } else {
                other_ws_rows.push(row);
            }
        }
        current_ws_rows.extend(other_ws_rows);
        self.overlay = ClassicOverlay::Resume {
            rows: current_ws_rows,
            selected: 0,
        };
    }

    fn resume_session_by_id(&mut self, id: &str) {
        if self.is_busy() {
            self.status = "本轮进行中，请先停止再恢复会话。".to_owned();
            return;
        }
        let store = ConversationStore::new(&self.home);
        let metadata = match store.read_metadata(id) {
            Ok(snap) => match snap.metadata {
                Some(m) => m,
                None => {
                    self.status = format!("未找到会话：{}", terminal_text(id));
                    return;
                }
            },
            Err(err) => {
                self.status = format!("无法读取会话（{}）。", err.code());
                return;
            }
        };
        if !matches!(
            metadata["mode"].as_str(),
            Some("chat" | "plan" | "goal") | None
        ) || metadata
            .get("role")
            .is_some_and(|v| !v.is_null() && v != "chat")
            || metadata
                .get("parentConversationId")
                .is_some_and(|v| !v.is_null())
        {
            self.status = "该会话非普通对话会话，无法在 Classic 模式恢复。".to_owned();
            return;
        }
        match store.read_conversation_execution(id) {
            Ok(Some(run)) if !run.permits_new_run() => {
                self.status = format!(
                    "会话仍在执行或有结果待核对（conversation_execution_busy） · peer recover --session {}",
                    terminal_text(id)
                );
                return;
            }
            Err(err) => {
                self.status = format!("检查会话状态失败（{}）。", err.code());
                return;
            }
            _ => {}
        }

        if let Some(ws_raw) = metadata["workspacePath"].as_str() {
            let ws_path = PathBuf::from(ws_raw);
            if ws_path.is_dir() {
                self.workspace = ws_path;
            } else {
                self.workspace = self.launch_workspace.clone();
            }
        }
        self.mode = metadata["mode"]
            .as_str()
            .and_then(|m| m.parse::<RuntimeMode>().ok())
            .unwrap_or(RuntimeMode::Chat);

        let mut model_notice = None;
        if let (Some(p), Some(m)) = (
            metadata["modelProviderId"].as_str(),
            metadata["model"].as_str(),
        ) {
            let effort = metadata["effort"].as_str();
            match resolve_exact_session_model(&self.home, p, m, effort) {
                Ok(sel) => {
                    self.selected_provider = Some(sel.entry.provider_id);
                    self.selected_model = Some(sel.entry.model_id);
                    self.selected_display_name = Some(sel.entry.display_name);
                    self.selected_effort = sel
                        .selection
                        .get("reasoningEffort")
                        .and_then(|v| v.as_str())
                        .map(str::to_owned);
                }
                Err(_) => {
                    model_notice = Some("原会话模型当前不可用，已保留当前模型。".to_owned());
                }
            }
        }
        self.fast_mode = metadata["fastMode"] == true;
        self.refresh_fast_available();

        self.access.clear_session_approvals();
        self.conversation_id = Some(id.to_owned());
        self.interrupted_preview.clear();
        self.pending_user_input = None;
        self.anchor.jump_to_latest();
        self.reload_transcript(None);
        self.refresh_context_percent();
        self.refresh_goal_plans();
        self.overlay = ClassicOverlay::None;
        self.composer.accepted();
        self.maybe_spawn_quota_refresh(true);

        let title = metadata["title"].as_str().unwrap_or(id);
        let msg = if let Some(note) = model_notice {
            format!("已恢复会话：{}（{note}）", terminal_text(title))
        } else {
            format!("已恢复会话：{}", terminal_text(title))
        };
        self.set_notice(msg, false);
    }

    fn apply_mode(&mut self, next: RuntimeMode) {
        if let Some(ref cid) = self.conversation_id
            && !self.is_busy()
            && let Err(err) = self
                .runtime
                .update_ordinary_mode(cid, &self.workspace, next)
        {
            self.set_notice(format!("切换模式失败（{}）。", err.0), true);
            return;
        }
        self.mode = next;
        let label = match next {
            RuntimeMode::Chat => "Agent",
            RuntimeMode::Plan => "Plan",
            RuntimeMode::Goal => "Goal",
            other => other.as_str(),
        };
        self.set_notice(format!("运行模式已切换为 {label}。"), false);
    }

    fn apply_access(&mut self, next_wire: &str) {
        let next = match next_wire {
            "full" => LocalAccessLevel::FullLocal,
            "session" => LocalAccessLevel::SessionLocal,
            _ => LocalAccessLevel::AskBeforeLocal,
        };
        if self.access.set(next).is_ok() {
            self.access_level = next;
            self.set_notice(format!("本地权限策略已切换为 {next_wire}。"), false);
        }
    }

    fn apply_model_selection(
        &mut self,
        provider_id: String,
        model_id: String,
        display_name: Option<String>,
        effort: Option<String>,
    ) {
        if let Some(ref cid) = self.conversation_id
            && !self.is_busy()
        {
            let sel = ConversationModelSelection {
                provider_id: &provider_id,
                model: &model_id,
                effort: effort.as_deref().unwrap_or("default"),
            };
            if let Err(err) = self
                .runtime
                .update_ordinary_model(cid, &self.workspace, &sel)
            {
                self.set_notice(
                    format!("保存模型选择失败（{}），请停止当前执行后再试。", err.0),
                    true,
                );
                return;
            }
        }
        self.selected_provider = Some(provider_id);
        self.selected_model = Some(model_id);
        self.selected_display_name = display_name;
        self.selected_effort = effort;
        self.refresh_fast_available();
        self.refresh_context_percent();
        self.maybe_spawn_quota_refresh(true);
        self.set_notice(format!("当前模型已切换为 {}。", self.model_badge()), false);
    }

    fn apply_theme_mode(&mut self, next_mode: ThemeMode) {
        match theme_store::save_theme_mode(&self.home, next_mode) {
            Ok(scheme) => {
                self.prefs.mode = next_mode;
                self.prefs.scheme = scheme;
                self.wrap_cache.clear();
                self.set_notice(
                    format!(
                        "主题已切换为 {}（配色: {}）。",
                        next_mode.as_str(),
                        scheme.as_str()
                    ),
                    false,
                );
            }
            Err(err) => {
                self.set_notice(format!("保存主题失败：{err}"), true);
            }
        }
    }

    fn apply_locale(&mut self, next_locale: TuiLocale) {
        match theme_store::save_locale(&self.home, next_locale) {
            Ok(()) => {
                self.prefs.locale = next_locale;
                self.set_notice(
                    format!("界面语言已切换为 {}。", next_locale.as_str()),
                    false,
                );
            }
            Err(err) => {
                self.set_notice(format!("保存语言失败：{err}"), true);
            }
        }
    }

    fn reset_conversation(&mut self, notice: &str) {
        self.access.clear_session_approvals();
        self.conversation_id = None;
        self.workspace = self.launch_workspace.clone();
        self.messages.clear();
        self.older = None;
        self.context_percent = None;
        self.goal_plans.clear();
        self.selected_goal_plan_id = None;
        self.interrupted_preview.clear();
        self.pending_user_input = None;
        self.anchor.jump_to_latest();
        self.composer.accepted();
        self.set_notice(notice, false);
    }

    fn start_compaction(&mut self) {
        if self.is_busy() {
            self.set_notice("当前回合进行中，无法压缩上下文。", false);
            return;
        }
        let Some(conv_id) = self.conversation_id.clone() else {
            self.set_notice("当前尚无已保存会话可压缩。", false);
            return;
        };
        if self.messages.len() < 2 {
            self.set_notice("当前对话轮次较少，暂无需压缩上下文。", false);
            return;
        }
        let selected = match resolve_exec(
            &self.home,
            self.selected_provider.as_deref(),
            self.selected_model.as_deref(),
            self.selected_effort.as_deref(),
            self.fast_mode,
        ) {
            Ok(s) => s,
            Err(err) => {
                self.set_notice(
                    format!("模型未就绪（{}），无法压缩上下文。", err.detail),
                    true,
                );
                return;
            }
        };

        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let home = self.home.clone();
        let workspace = self.workspace.clone();
        let runtime = Rc::clone(&self.runtime);
        let mode = self.mode;
        let selection = selected.selection;
        let provider_id = selected.entry.provider_id;
        let effort = selection["reasoningEffort"]
            .as_str()
            .unwrap_or("default")
            .to_owned();

        let task = tokio::task::spawn_local(async move {
            let store = ConversationStore::new(&home);
            let run = store
                .read_conversation_execution(&conv_id)
                .map_err(|e| e.code())?;
            if let Some(ref r) = run
                && !r.permits_new_run()
            {
                return Err("conversation_execution_busy");
            }
            let model = peer_runtime::model_config::load_model(&home, &selection, &task_cancel)
                .await
                .map_err(|e| e.code)?;
            runtime
                .compact_conversation(
                    &CompactOptions {
                        workspace: &workspace,
                        conversation_id: &conv_id,
                        resume_from: run.as_ref(),
                        provider_id: &provider_id,
                        mode,
                        effort: &effort,
                    },
                    &model,
                    &task_cancel,
                )
                .await
                .map_err(|e| e.0)
        });
        self.compacting = Some(ActiveCompaction {
            cancel,
            task,
            started_at: Instant::now(),
            cancelling: false,
        });
        self.clear_notice();
    }

    fn draw(&mut self, terminal: &mut TerminalGuard) -> io::Result<()> {
        let (live_buf, live_thinking_buf) = self
            .active
            .as_ref()
            .map(|a| {
                let d = a.display.borrow();
                (d.live.clone(), d.live_thinking.clone())
            })
            .filter(|(live, thinking)| !live.is_empty() || !thinking.is_empty())
            .unwrap_or_else(|| (self.interrupted_preview.clone(), String::new()));
        let live_stream = live_buf.strip_prefix("Peer  ").unwrap_or(&live_buf);
        let live_thinking = live_thinking_buf.as_str();
        let workspace_label = compact_workspace_path(&self.workspace.to_string_lossy());
        let model_badge = self.model_badge();
        let effort_badge = self.selected_effort.as_deref().unwrap_or("default");
        let mode_badge = self.mode.as_str();
        let access_badge = self.access_badge();
        let goal_status = self.goal_menu_status();
        let goal_banner = self.goal_banner();
        let is_running = self.is_busy();
        let running_elapsed_ms = if let Some(active) = self.active.as_ref() {
            active.started_at.elapsed().as_millis() as u64
        } else if let Some(comp) = self.compacting.as_ref() {
            comp.started_at.elapsed().as_millis() as u64
        } else {
            0
        };
        let animation_frame = if is_running {
            (running_elapsed_ms / WORKING_ANIMATION_INTERVAL_MS) as usize
        } else {
            0
        };
        let palette = self.prefs.palette();
        let scheme_id = self.prefs.scheme.cache_id();
        let current_theme = self.prefs.mode;
        let locale = self.prefs.locale;
        let quota_label = self
            .quota
            .as_ref()
            .map(|q| format_topbar_quota(q.remaining_percent, q.plan_label.as_deref(), locale));
        let quota_remaining = self.quota.as_ref().map(|q| q.remaining_percent);
        let activity_label = if self.approval.is_some() {
            Some(if locale.is_zh() {
                APPROVAL_STATUS
            } else {
                "Awaiting approval…"
            })
        } else if let Some(comp) = self.compacting.as_ref() {
            if comp.cancelling {
                Some(if locale.is_zh() {
                    "正在取消…"
                } else {
                    "Cancelling…"
                })
            } else {
                Some(if locale.is_zh() {
                    "正在压缩上下文…"
                } else {
                    "Compacting…"
                })
            }
        } else if let Some(active) = self.active.as_ref() {
            if active.cancelling {
                Some(if locale.is_zh() {
                    "正在取消…"
                } else {
                    "Cancelling…"
                })
            } else {
                None
            }
        } else {
            None
        };
        let notice_str = if let Some(s) = self.composer.status {
            Some(s)
        } else if !self.status.is_empty() {
            Some(self.status.as_str())
        } else {
            None
        };
        let notice_is_error =
            notice_str.is_some() && self.composer.status.is_none() && self.status_is_error;
        let status = notice_str.unwrap_or("");
        let approval_view = self.approval.as_ref().map(|a| (&a.card, a.selected));
        let user_input_view = if !is_running
            && self.approval.is_none()
            && !self.model_picker.open
            && !self.overlay.is_open()
        {
            self.pending_user_input
                .as_ref()
                .filter(|p| !p.dismissed && !p.prompt.options.is_empty())
                .map(|p| (&p.prompt, p.selected))
        } else {
            None
        };
        let mut shown_size = None;
        terminal.draw_frame(|frame| {
            shown_size = Some((frame.area().width, frame.area().height));
            render_classic(
                frame,
                ClassicView {
                    title: "Peer",
                    workspace_label: &workspace_label,
                    model_badge: &model_badge,
                    effort_badge,
                    mode_badge,
                    access_badge,
                    context_percent: self.context_percent,
                    quota_label: quota_label.as_deref(),
                    quota_remaining,
                    fast_mode: self.fast_mode,
                    fast_available: self.fast_available,
                    goal_status,
                    goal_banner: goal_banner.as_deref(),
                    is_running,
                    activity_label,
                    animation_frame,
                    running_elapsed_ms,
                    tools_expanded: self.tools_expanded,
                    notice: notice_str,
                    notice_is_error,
                    palette,
                    scheme_id,
                    current_theme,
                    locale,
                    messages: &self.messages,
                    live_stream,
                    live_thinking,
                    anchor: &self.anchor,
                    composer: &self.composer,
                    status,
                    approval: approval_view,
                    user_input: user_input_view,
                    model_picker: &self.model_picker,
                    overlay: &self.overlay,
                    slash_selected: self.slash_selected,
                    wrap_cache: &mut self.wrap_cache,
                },
            );
        })?;
        self.last_anim_draw = if is_running {
            Some(Instant::now())
        } else {
            None
        };
        if let (Some(approval), Some(size)) = (self.approval.as_mut(), shown_size) {
            approval.shown_at = Some(size);
        }
        Ok(())
    }

    fn submit_prompt(&mut self, prompt: String) {
        if self.is_busy() {
            self.set_notice("当前回合进行中，请等待完成或按 Ctrl-C 停止本轮。", true);
            return;
        }
        let selected = match resolve_exec(
            &self.home,
            self.selected_provider.as_deref(),
            self.selected_model.as_deref(),
            self.selected_effort.as_deref(),
            self.fast_mode,
        ) {
            Ok(s) => s,
            Err(err) => {
                self.set_notice(
                    format!(
                        "模型未就绪（{}），原草稿已保留。输入 `/model` 选择模型。",
                        err.detail
                    ),
                    true,
                );
                return;
            }
        };
        self.selected_provider = Some(selected.entry.provider_id.clone());
        self.selected_model = Some(selected.entry.model_id.clone());
        self.selected_display_name = Some(selected.entry.display_name.clone());
        self.interrupted_preview.clear();
        self.pending_user_input = None;
        self.anchor.jump_to_latest();

        let (display_tx, display_rx) = watch::channel(Display::default());
        let (perm_tx, perm_rx) = mpsc::channel(4);
        let cancel = CancellationToken::new();
        let home = self.home.clone();
        let workspace = self.workspace.clone();
        let conv_id = self.conversation_id.clone();
        let runtime = Rc::clone(&self.runtime);
        let mode = self.mode;
        let selection = selected.selection;
        let provider_id = selected.entry.provider_id;
        let effort = selection["reasoningEffort"]
            .as_str()
            .unwrap_or("default")
            .to_owned();
        let task_cancel = cancel.clone();

        let task = tokio::task::spawn_local(async move {
            let resume_from = if let Some(ref cid) = conv_id {
                let run = ConversationStore::new(&home)
                    .read_conversation_execution(cid)
                    .map_err(|e| e.code())?;
                if let Some(ref r) = run
                    && !r.permits_new_run()
                {
                    return Err("conversation_execution_busy");
                }
                run
            } else {
                None
            };
            let model = peer_runtime::model_config::load_model(&home, &selection, &task_cancel)
                .await
                .map_err(|e| e.code)?;
            let mut output = OutputPort(display_tx.clone());
            let mut permission = PermissionPort {
                requests: perm_tx,
                display: display_tx,
            };
            let outcome = runtime
                .execute_interactive(
                    &ConversationOptions {
                        workspace: &workspace,
                        conversation_id: conv_id.as_deref(),
                        resume_from: resume_from.as_ref(),
                        prompt: &prompt,
                        image_paths: &[],
                        provider_id: &provider_id,
                        mode,
                        effort: &effort,
                        persist_model_selection: true,
                        allowlist: None,
                        max_turns: None,
                    },
                    &model,
                    &mut permission,
                    Some(&mut output),
                    &task_cancel,
                )
                .await
                .map_err(|e| e.0)?;
            if let Some(err) = outcome.error {
                return Err(err);
            }
            Ok(outcome.session_id)
        });

        self.active = Some(ActiveTurn {
            cancel,
            task,
            display: display_rx,
            prompts: perm_rx,
            accepted: false,
            revision: 0,
            delta_revision: 0,
            started_at: Instant::now(),
            cancelling: false,
        });
        self.clear_notice();
    }

    async fn poll_active(&mut self) -> bool {
        let mut dirty = false;
        let mut finished = None;
        let mut need_reload = false;
        if self
            .quota_task
            .as_ref()
            .is_some_and(|(_, t)| t.is_finished())
            && let Some((_, task)) = self.quota_task.take()
        {
            self.quota_fetched_at = Some(Instant::now());
            if let Ok(Some(snap)) = task.await
                && self.quota_provider_id.as_deref() == Some(snap.provider_id.as_str())
            {
                self.quota = Some(snap);
                dirty = true;
            }
        }
        self.maybe_spawn_quota_refresh(false);
        if let Some(active) = self.active.as_mut() {
            let (accepted, revision, delta_revision, notice, conv_id, has_live) = {
                let d = active.display.borrow();
                (
                    d.accepted,
                    d.revision,
                    d.delta_revision,
                    d.notice,
                    d.conversation_id.clone(),
                    !d.live.is_empty() || !d.live_thinking.is_empty(),
                )
            };
            if let Some(cid) = conv_id
                && self.conversation_id.is_none()
            {
                self.conversation_id = Some(cid);
                dirty = true;
            }
            if accepted && !active.accepted {
                active.accepted = true;
                self.composer.accepted();
                dirty = true;
            }
            if revision != active.revision {
                active.revision = revision;
                need_reload = true;
                dirty = true;
            }
            if delta_revision != active.delta_revision {
                active.delta_revision = delta_revision;
                dirty = true;
            }
            if let Some(n) = notice {
                self.status = n.to_owned();
                self.status_is_error = false;
                dirty = true;
            }
            if has_live {
                dirty = true;
            }
            if self.approval.is_none()
                && let Ok(req) = active.prompts.try_recv()
            {
                self.approval = Some(req);
                dirty = true;
            }
            if active.task.is_finished() {
                finished = self.active.take();
            }
        }
        if need_reload {
            self.reload_transcript(None);
            self.refresh_context_percent();
        }
        if let Some(active) = finished {
            let live_tail = active.display.borrow().live.clone();
            self.approval = None;
            match active.task.await {
                Ok(Ok(session_id)) => {
                    self.conversation_id = Some(session_id);
                    self.interrupted_preview.clear();
                    self.reload_transcript(None);
                    self.refresh_context_percent();
                    self.refresh_goal_plans();
                    self.maybe_spawn_quota_refresh(true);
                    self.clear_notice();
                }
                Ok(Err("CANCELLED")) => {
                    if !live_tail.is_empty() {
                        self.interrupted_preview =
                            format!("{live_tail}\n［本轮已停止，内容不完整］");
                    }
                    self.reload_transcript(None);
                    self.refresh_context_percent();
                    self.refresh_goal_plans();
                    self.set_notice("本轮已停止，可继续输入下一条消息。", false);
                }
                Ok(Err("conversation_execution_busy")) => {
                    self.reload_transcript(None);
                    let cid = self.conversation_id.as_deref().unwrap_or("");
                    self.set_notice(
                        format!(
                            "会话仍在执行或有结果待核对（conversation_execution_busy） · peer recover --session {cid}"
                        ),
                        true,
                    );
                }
                Ok(Err(code)) => {
                    self.reload_transcript(None);
                    self.set_notice(format!("执行未完成（{code}）；原草稿或历史已保留。"), true);
                }
                Err(_) => {
                    self.set_notice("内部执行任务异常结束。", true);
                }
            }
            dirty = true;
        }
        if let Some(comp) = self.compacting.as_ref()
            && comp.task.is_finished()
            && let Some(comp) = self.compacting.take()
        {
            match comp.task.await {
                Ok(Ok(outcome)) => {
                    self.reload_transcript(None);
                    self.refresh_context_percent();
                    self.set_notice(
                        format!(
                            "已完成上下文压缩（{} · 原 {} 条消息）。",
                            outcome.method, outcome.original_message_count
                        ),
                        false,
                    );
                }
                Ok(Err("CANCELLED")) => {
                    self.set_notice("已取消上下文压缩。", false);
                }
                Ok(Err("native_context_pressure")) => {
                    self.set_notice("当前对话轮次较少，暂无需压缩上下文。", false);
                }
                Ok(Err(code)) => {
                    self.set_notice(format!("上下文压缩未完成（{code}）。"), true);
                }
                Err(_) => {
                    self.set_notice("上下文压缩任务异常结束。", true);
                }
            }
            dirty = true;
        }
        if self.approval.as_ref().is_some_and(Approval::expired) {
            self.approval = None;
            dirty = true;
        }
        if self.is_busy() {
            if self
                .last_anim_draw
                .is_none_or(|t| t.elapsed() >= Duration::from_millis(WORKING_ANIMATION_INTERVAL_MS))
            {
                dirty = true;
            }
        } else {
            self.last_anim_draw = None;
        }
        dirty
    }

    fn handle_approval_key(&mut self, key: KeyEvent, terminal_size: (u16, u16)) -> bool {
        let Some(approval) = self.approval.as_mut() else {
            return false;
        };
        if key.kind == KeyEventKind::Release {
            return false;
        }
        let no_ctrl_alt = !key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT);
        let check_viewport = |session: &mut Self| -> bool {
            if terminal_size.0 < 30 || terminal_size.1 < 10 {
                session.set_notice(
                    "终端视口过小，无法完整核验授权详情，请调大窗口或按 n / 3 / Esc 拒绝。",
                    true,
                );
                false
            } else {
                true
            }
        };
        match key.code {
            KeyCode::Up | KeyCode::Left => {
                approval.selected = (approval.selected + 2) % 3;
                true
            }
            KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                approval.selected = (approval.selected + 1) % 3;
                true
            }
            KeyCode::Char('1') | KeyCode::Char('y') | KeyCode::Char('Y') if no_ctrl_alt => {
                if !check_viewport(self) {
                    return true;
                }
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::Approve);
                }
                true
            }
            KeyCode::Char('2') if no_ctrl_alt => {
                if !check_viewport(self) {
                    return true;
                }
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::ApproveSession);
                }
                true
            }
            KeyCode::Char('3') | KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc
                if no_ctrl_alt =>
            {
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::Deny);
                }
                true
            }
            KeyCode::Enter if key.modifiers.is_empty() => {
                let decision = match approval.selected.min(2) {
                    0 => LocalPermissionDecision::Approve,
                    1 => LocalPermissionDecision::ApproveSession,
                    _ => LocalPermissionDecision::Deny,
                };
                if decision != LocalPermissionDecision::Deny && !check_viewport(self) {
                    return true;
                }
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(decision);
                }
                true
            }
            KeyCode::Char('c') if key.modifiers.contains(KeyModifiers::CONTROL) => {
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::Cancel);
                }
                if let Some(active) = self.active.as_ref() {
                    active.cancel.cancel();
                }
                true
            }
            _ => false,
        }
    }

    fn handle_user_input_key(&mut self, key: KeyEvent) -> Option<bool> {
        if self.is_busy() {
            return None;
        }
        let pending = self.pending_user_input.as_mut()?;
        if pending.dismissed || pending.prompt.options.is_empty() {
            return None;
        }
        let count = pending.prompt.options.len();
        let draft_empty = self.composer.draft().is_empty();
        let draft_trimmed_empty = self.composer.draft().trim().is_empty();
        match key.code {
            KeyCode::Up => {
                pending.selected = if pending.selected == 0 {
                    count - 1
                } else {
                    pending.selected - 1
                };
                Some(true)
            }
            KeyCode::Left if draft_empty => {
                pending.selected = if pending.selected == 0 {
                    count - 1
                } else {
                    pending.selected - 1
                };
                Some(true)
            }
            KeyCode::Down | KeyCode::Tab => {
                pending.selected = (pending.selected + 1) % count;
                Some(true)
            }
            KeyCode::Right if draft_empty => {
                pending.selected = (pending.selected + 1) % count;
                Some(true)
            }
            KeyCode::Esc if self.anchor.is_following() => {
                pending.dismissed = true;
                self.set_notice("已收起选项卡片，可直接输入回复。", false);
                Some(true)
            }
            KeyCode::Char(c @ '1'..='9') if key.modifiers.is_empty() && draft_empty => {
                let idx = (c as usize) - ('1' as usize);
                if idx < count {
                    let answer = pending.prompt.options[idx].clone();
                    self.submit_prompt(answer);
                    Some(true)
                } else {
                    Some(false)
                }
            }
            KeyCode::Enter if key.modifiers.is_empty() && draft_trimmed_empty => {
                let answer = pending.prompt.options[pending.selected.min(count - 1)].clone();
                self.submit_prompt(answer);
                Some(true)
            }
            _ => None,
        }
    }

    fn handle_overlay_key(&mut self, key: KeyEvent) -> bool {
        if key.code == KeyCode::Esc
            || (key.code == KeyCode::Char('c') && key.modifiers.contains(KeyModifiers::CONTROL))
        {
            self.overlay = ClassicOverlay::None;
            return true;
        }

        let filtered_skills = if matches!(self.overlay, ClassicOverlay::Skills { .. }) {
            self.overlay.filtered_skill_indices()
        } else {
            Vec::new()
        };
        let filtered_mcp = if matches!(self.overlay, ClassicOverlay::Mcp { .. }) {
            self.overlay.filtered_mcp_indices()
        } else {
            Vec::new()
        };
        let filtered_goals = if matches!(self.overlay, ClassicOverlay::Goals { .. }) {
            self.overlay.filtered_goal_indices()
        } else {
            Vec::new()
        };

        match &mut self.overlay {
            ClassicOverlay::None => false,
            ClassicOverlay::Resume { rows, selected } => match key.code {
                KeyCode::Up | KeyCode::Left => {
                    if !rows.is_empty() {
                        *selected = if *selected == 0 {
                            rows.len() - 1
                        } else {
                            *selected - 1
                        };
                    }
                    true
                }
                KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    if !rows.is_empty() {
                        *selected = (*selected + 1) % rows.len();
                    }
                    true
                }
                KeyCode::Enter => {
                    if let Some(row) = rows.get(*selected).cloned() {
                        self.resume_session_by_id(&row.id);
                    } else {
                        self.overlay = ClassicOverlay::None;
                        self.status = "暂无可恢复的历史会话。".to_owned();
                    }
                    true
                }
                _ => false,
            },
            ClassicOverlay::Mode { selected } => match key.code {
                KeyCode::Up | KeyCode::Left | KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    *selected = (*selected + 1) % 2;
                    true
                }
                KeyCode::Char('1') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_mode(RuntimeMode::Chat);
                    true
                }
                KeyCode::Char('2') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_mode(RuntimeMode::Plan);
                    true
                }
                KeyCode::Enter => {
                    let chosen = if *selected % 2 == 0 {
                        RuntimeMode::Chat
                    } else {
                        RuntimeMode::Plan
                    };
                    self.overlay = ClassicOverlay::None;
                    self.apply_mode(chosen);
                    true
                }
                _ => false,
            },
            ClassicOverlay::Permissions { selected } => match key.code {
                KeyCode::Up | KeyCode::Left => {
                    *selected = (*selected + 2) % 3;
                    true
                }
                KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    *selected = (*selected + 1) % 3;
                    true
                }
                KeyCode::Char('1') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_access("ask");
                    true
                }
                KeyCode::Char('2') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_access("session");
                    true
                }
                KeyCode::Char('3') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_access("full");
                    true
                }
                KeyCode::Enter => {
                    let chosen = match *selected % 3 {
                        0 => "ask",
                        1 => "session",
                        _ => "full",
                    };
                    self.overlay = ClassicOverlay::None;
                    self.apply_access(chosen);
                    true
                }
                _ => false,
            },
            ClassicOverlay::Theme { selected } => match key.code {
                KeyCode::Up | KeyCode::Left => {
                    *selected = (*selected + 2) % 3;
                    true
                }
                KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    *selected = (*selected + 1) % 3;
                    true
                }
                KeyCode::Char('1') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_theme_mode(ThemeMode::Dark);
                    true
                }
                KeyCode::Char('2') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_theme_mode(ThemeMode::Light);
                    true
                }
                KeyCode::Char('3') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_theme_mode(ThemeMode::System);
                    true
                }
                KeyCode::Enter => {
                    let chosen = match *selected % 3 {
                        0 => ThemeMode::Dark,
                        1 => ThemeMode::Light,
                        _ => ThemeMode::System,
                    };
                    self.overlay = ClassicOverlay::None;
                    self.apply_theme_mode(chosen);
                    true
                }
                _ => false,
            },
            ClassicOverlay::Language { selected } => match key.code {
                KeyCode::Up | KeyCode::Left | KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
                    *selected = (*selected + 1) % 2;
                    true
                }
                KeyCode::Char('1') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_locale(TuiLocale::ZhCn);
                    true
                }
                KeyCode::Char('2') => {
                    self.overlay = ClassicOverlay::None;
                    self.apply_locale(TuiLocale::EnUs);
                    true
                }
                KeyCode::Enter => {
                    let chosen = if *selected % 2 == 0 {
                        TuiLocale::ZhCn
                    } else {
                        TuiLocale::EnUs
                    };
                    self.overlay = ClassicOverlay::None;
                    self.apply_locale(chosen);
                    true
                }
                _ => false,
            },
            ClassicOverlay::Goals {
                plans,
                current_plan_id,
                query,
                selected,
            } => match key.code {
                KeyCode::Up => {
                    if !filtered_goals.is_empty() {
                        *selected = if *selected == 0 {
                            filtered_goals.len() - 1
                        } else {
                            *selected - 1
                        };
                    }
                    true
                }
                KeyCode::Down | KeyCode::Tab => {
                    if !filtered_goals.is_empty() {
                        *selected = (*selected + 1) % filtered_goals.len();
                    }
                    true
                }
                KeyCode::Backspace => {
                    query.pop();
                    *selected = 0;
                    true
                }
                KeyCode::Enter => {
                    if let Some(&idx) = filtered_goals.get(*selected) {
                        let pid = plans[idx].plan_id.clone();
                        let title = plans[idx].title.clone();
                        *current_plan_id = Some(pid.clone());
                        self.selected_goal_plan_id = Some(pid);
                        self.overlay = ClassicOverlay::None;
                        self.status = format!("已选中目标：{}", terminal_text(&title));
                    } else {
                        self.overlay = ClassicOverlay::None;
                    }
                    true
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    query.push(c);
                    *selected = 0;
                    true
                }
                _ => false,
            },
            ClassicOverlay::Help { scroll } => match key.code {
                KeyCode::Enter | KeyCode::Char('q') => {
                    self.overlay = ClassicOverlay::None;
                    true
                }
                KeyCode::Up => {
                    *scroll = scroll.saturating_sub(1);
                    true
                }
                KeyCode::Down => {
                    *scroll = scroll.saturating_add(1);
                    true
                }
                KeyCode::PageUp => {
                    *scroll = scroll.saturating_sub(6);
                    true
                }
                KeyCode::PageDown => {
                    *scroll = scroll.saturating_add(6);
                    true
                }
                _ => false,
            },
            ClassicOverlay::Skills {
                items,
                query,
                selected,
            } => match key.code {
                KeyCode::Up => {
                    if !filtered_skills.is_empty() {
                        *selected = if *selected == 0 {
                            filtered_skills.len() - 1
                        } else {
                            *selected - 1
                        };
                    }
                    true
                }
                KeyCode::Down | KeyCode::Tab => {
                    if !filtered_skills.is_empty() {
                        *selected = (*selected + 1) % filtered_skills.len();
                    }
                    true
                }
                KeyCode::Char('r') if key.modifiers.is_empty() => {
                    *items = load_skills(&self.home, &self.workspace);
                    *selected = 0;
                    true
                }
                KeyCode::Char(' ') => {
                    if let Some(&idx) = filtered_skills.get(*selected) {
                        let sid = items[idx].skill_id.clone();
                        let next = !items[idx].enabled;
                        match set_skill_enabled(&self.home, &self.workspace, &sid, next) {
                            Ok(updated) => {
                                *items = updated;
                                self.status = format!(
                                    "Skill {} 已{}。",
                                    sid,
                                    if next { "启用" } else { "停用" }
                                );
                            }
                            Err(err) => {
                                self.status = format!("更新 Skill 设置失败：{err}");
                            }
                        }
                    }
                    true
                }
                KeyCode::Enter => {
                    if let Some(&idx) = filtered_skills.get(*selected) {
                        let name = items[idx].name.clone();
                        let prompt = if self.prefs.locale.is_zh() {
                            format!("使用「{name}」技能处理此请求：")
                        } else {
                            format!("Use the {name} Skill for this request: ")
                        };
                        self.overlay = ClassicOverlay::None;
                        if key.modifiers.contains(KeyModifiers::SHIFT) {
                            self.submit_prompt(prompt);
                        } else {
                            self.composer.accepted();
                            self.composer.apply(Action::Insert(prompt));
                        }
                    } else {
                        self.overlay = ClassicOverlay::None;
                    }
                    true
                }
                KeyCode::Backspace => {
                    query.pop();
                    *selected = 0;
                    true
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    query.push(c);
                    *selected = 0;
                    true
                }
                _ => false,
            },
            ClassicOverlay::Mcp {
                items,
                query,
                selected,
            } => match key.code {
                KeyCode::Up => {
                    if !filtered_mcp.is_empty() {
                        *selected = if *selected == 0 {
                            filtered_mcp.len() - 1
                        } else {
                            *selected - 1
                        };
                    }
                    true
                }
                KeyCode::Down | KeyCode::Tab => {
                    if !filtered_mcp.is_empty() {
                        *selected = (*selected + 1) % filtered_mcp.len();
                    }
                    true
                }
                KeyCode::Char('r') if key.modifiers.is_empty() => {
                    *items = load_mcp_servers(&self.home);
                    *selected = 0;
                    true
                }
                KeyCode::Char(' ') => {
                    if let Some(&idx) = filtered_mcp.get(*selected) {
                        let id = items[idx].id.clone();
                        let next = !items[idx].enabled;
                        match set_mcp_server_enabled(&self.home, &id, next) {
                            Ok(updated) => {
                                *items = updated;
                                self.status = format!(
                                    "MCP Server {} 已{}。",
                                    id,
                                    if next { "启用" } else { "停用" }
                                );
                            }
                            Err(err) => {
                                self.status = format!("更新 MCP 配置失败：{err}");
                            }
                        }
                    }
                    true
                }
                KeyCode::Backspace => {
                    query.pop();
                    *selected = 0;
                    true
                }
                KeyCode::Char(c) if !key.modifiers.contains(KeyModifiers::CONTROL) => {
                    query.push(c);
                    *selected = 0;
                    true
                }
                _ => false,
            },
        }
    }

    fn handle_command(&mut self, text: &str) -> Option<ShellOutcome> {
        match parse_classic_command(text) {
            ClassicCommand::Text(prompt) => {
                if !prompt.is_empty() {
                    self.submit_prompt(prompt);
                }
                None
            }
            ClassicCommand::Bots => {
                self.composer.accepted();
                Some(ShellOutcome::SwitchToBots)
            }
            ClassicCommand::NewSession => {
                self.composer.accepted();
                if self.is_busy() {
                    self.status = "本轮进行中，请先停止再新建会话。".to_owned();
                    return None;
                }
                self.reset_conversation("已开始新会话。");
                None
            }
            ClassicCommand::Clear => {
                self.composer.accepted();
                if self.is_busy() {
                    self.status = "本轮进行中，请先停止再清空对话。".to_owned();
                    return None;
                }
                self.reset_conversation("已清空对话并开启新会话。");
                None
            }
            ClassicCommand::Compact => {
                self.composer.accepted();
                self.start_compaction();
                None
            }
            ClassicCommand::Model => {
                self.composer.accepted();
                self.open_model_picker();
                None
            }
            ClassicCommand::Mode(None) => {
                self.composer.accepted();
                let sel = if self.mode == RuntimeMode::Plan { 1 } else { 0 };
                self.overlay = ClassicOverlay::Mode { selected: sel };
                None
            }
            ClassicCommand::Mode(Some(m)) => {
                self.composer.accepted();
                if let Ok(parsed) = m.parse::<RuntimeMode>() {
                    self.apply_mode(parsed);
                }
                None
            }
            ClassicCommand::Permissions(None) => {
                self.composer.accepted();
                let sel = match self.access_level {
                    LocalAccessLevel::AskBeforeLocal | LocalAccessLevel::RestrictedLocal => 0,
                    LocalAccessLevel::SessionLocal => 1,
                    LocalAccessLevel::FullLocal => 2,
                };
                self.overlay = ClassicOverlay::Permissions { selected: sel };
                None
            }
            ClassicCommand::Permissions(Some(a)) => {
                self.composer.accepted();
                self.apply_access(&a);
                None
            }
            ClassicCommand::Fast => {
                self.composer.accepted();
                self.refresh_fast_available();
                if !self.fast_available {
                    self.status = if self.prefs.locale.is_zh() {
                        "当前模型不支持 Fast（仅 ChatGPT/Grok OAuth）".to_owned()
                    } else {
                        "Fast is only available for ChatGPT/Grok OAuth".to_owned()
                    };
                } else {
                    self.fast_mode = !self.fast_mode;
                    self.status = if self.prefs.locale.is_zh() {
                        if self.fast_mode {
                            "已开启 Fast 加速模式。".to_owned()
                        } else {
                            "已关闭 Fast 加速模式。".to_owned()
                        }
                    } else if self.fast_mode {
                        "Fast on".to_owned()
                    } else {
                        "Fast off".to_owned()
                    };
                }
                None
            }
            ClassicCommand::Theme(None) => {
                self.composer.accepted();
                let sel = match self.prefs.mode {
                    ThemeMode::Dark => 0,
                    ThemeMode::Light => 1,
                    ThemeMode::System => 2,
                };
                self.overlay = ClassicOverlay::Theme { selected: sel };
                None
            }
            ClassicCommand::Theme(Some(raw)) => {
                self.composer.accepted();
                match ThemeMode::parse(&raw) {
                    Some(m) => self.apply_theme_mode(m),
                    None => self.set_notice("主题仅支持 dark / light / system。", true),
                }
                None
            }
            ClassicCommand::Language(None) => {
                self.composer.accepted();
                let sel = if self.prefs.locale.is_zh() { 0 } else { 1 };
                self.overlay = ClassicOverlay::Language { selected: sel };
                None
            }
            ClassicCommand::Language(Some(raw)) => {
                self.composer.accepted();
                match TuiLocale::parse(&raw) {
                    Some(l) => self.apply_locale(l),
                    None => self.set_notice("语言仅支持 zh-CN / en-US。", true),
                }
                None
            }
            ClassicCommand::Skill => {
                self.composer.accepted();
                self.overlay = ClassicOverlay::Skills {
                    items: load_skills(&self.home, &self.workspace),
                    query: String::new(),
                    selected: 0,
                };
                None
            }
            ClassicCommand::Mcp => {
                self.composer.accepted();
                self.overlay = ClassicOverlay::Mcp {
                    items: load_mcp_servers(&self.home),
                    query: String::new(),
                    selected: 0,
                };
                None
            }
            ClassicCommand::Resume(None) => {
                self.composer.accepted();
                self.open_resume_picker();
                None
            }
            ClassicCommand::Resume(Some(id)) => {
                self.composer.accepted();
                self.resume_session_by_id(&id);
                None
            }
            ClassicCommand::History(dir) => {
                self.composer.accepted();
                match dir {
                    HistoryDirection::Earlier => {
                        if let Some(cursor) = self.older.clone() {
                            self.reload_transcript(Some(cursor));
                            self.anchor.scroll_up(12, 10_000, None);
                            self.status =
                                "正在浏览更早历史 · /history later|latest 或 Esc 回到最新"
                                    .to_owned();
                        } else if !self.messages.is_empty() {
                            self.anchor.scroll_up(12, 10_000, None);
                            self.status =
                                "已到最早历史 · /history later|latest 回到最新".to_owned();
                        } else {
                            self.status = "当前对话尚无历史记录。".to_owned();
                        }
                    }
                    HistoryDirection::Later => {
                        if !self.anchor.is_following() {
                            self.anchor.scroll_down(12);
                            if self.anchor.is_following() {
                                self.clear_notice();
                            }
                        } else {
                            self.set_notice("已在最新位置。", false);
                        }
                    }
                    HistoryDirection::Latest => {
                        self.anchor.jump_to_latest();
                        self.set_notice("已回到最新对话。", false);
                    }
                }
                None
            }
            ClassicCommand::Goals => {
                self.composer.accepted();
                self.refresh_goal_plans();
                self.overlay = ClassicOverlay::Goals {
                    plans: self.goal_plans.clone(),
                    current_plan_id: self.selected_goal_plan_id.clone(),
                    query: String::new(),
                    selected: 0,
                };
                None
            }
            ClassicCommand::GoalPause => {
                self.composer.accepted();
                if let Some(active) = self.active.as_mut()
                    && self.mode == RuntimeMode::Goal
                {
                    active.cancelling = true;
                    active.cancel.cancel();
                    self.set_notice("正在安全边界停止当前目标回合…", false);
                } else {
                    self.set_notice("当前无运行中的目标执行回合。", false);
                }
                None
            }
            ClassicCommand::GoalResume => {
                self.composer.accepted();
                if self.goal_menu_status() == GoalMenuStatus::Paused {
                    self.mode = RuntimeMode::Goal;
                    self.submit_prompt("继续推进当前未完成的目标。".to_owned());
                } else {
                    self.set_notice("当前无已暂停的目标可继续。", false);
                }
                None
            }
            ClassicCommand::GoalCancel => {
                self.composer.accepted();
                if let Some(active) = self.active.as_mut() {
                    active.cancelling = true;
                    active.cancel.cancel();
                    self.set_notice("正在取消当前目标执行…", false);
                } else {
                    self.set_notice("当前无活跃运行中的目标。", false);
                }
                None
            }
            ClassicCommand::Help => {
                self.composer.accepted();
                self.overlay = ClassicOverlay::Help { scroll: 0 };
                None
            }
            ClassicCommand::Version => {
                self.composer.accepted();
                self.status = format!("peer {}", crate::VERSION.trim());
                None
            }
            ClassicCommand::Quit => Some(ShellOutcome::Quit),
            ClassicCommand::Invalid => {
                self.set_notice("未知命令，输入 `/help` 查看支持命令。", true);
                None
            }
        }
    }

    pub(super) async fn run(
        mut self,
        terminal: &mut TerminalGuard,
        shutdown: &CancellationToken,
    ) -> io::Result<ShellOutcome> {
        self.maybe_spawn_quota_refresh(true);
        self.draw(terminal)?;
        loop {
            if shutdown.is_cancelled() {
                self.shutdown_tasks().await;
                return Ok(ShellOutcome::Quit);
            }

            let mut dirty = self.poll_active().await;

            // Crossterm's Unix TTY source needs a positive poll budget to read the fd.
            let poll_ms = if self.is_busy() { 2 } else { 25 };
            if event::poll(Duration::from_millis(poll_ms))? {
                match event::read()? {
                    Event::Resize(_, _) => {
                        dirty = true;
                    }
                    Event::Paste(pasted) => {
                        // Paste NEVER triggers approval or model submit!
                        if self.approval.is_none()
                            && !self.model_picker.open
                            && !self.overlay.is_open()
                        {
                            self.composer.apply(Action::Insert(pasted));
                            dirty = true;
                        }
                    }
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        let size = crossterm::terminal::size().unwrap_or((80, 24));
                        let slash_ctx = SlashFilterContext {
                            fast_available: self.fast_available,
                            goal_status: self.goal_menu_status(),
                        };
                        if self.model_picker.open {
                            match self.model_picker.handle_key(key) {
                                ModelPickerEvent::None => {}
                                ModelPickerEvent::Close => {}
                                ModelPickerEvent::Select {
                                    provider_id,
                                    model_id,
                                    effort,
                                } => {
                                    let display_label = self.model_picker.current_display_label();
                                    self.model_picker.close();
                                    self.apply_model_selection(
                                        provider_id,
                                        model_id,
                                        display_label,
                                        effort,
                                    );
                                }
                            }
                            dirty = true;
                        } else if self.approval.is_some() {
                            if self.handle_approval_key(key, size) {
                                dirty = true;
                            }
                        } else if self.overlay.is_open() {
                            if self.handle_overlay_key(key) {
                                dirty = true;
                            }
                        } else if key.code == KeyCode::F(2) {
                            if !self.is_busy() {
                                self.shutdown_tasks().await;
                                return Ok(ShellOutcome::SwitchToBots);
                            }
                        } else if key.code == KeyCode::F(3) {
                            self.open_model_picker();
                            dirty = true;
                        } else if key.code == KeyCode::Char('o')
                            && key.modifiers.contains(KeyModifiers::CONTROL)
                        {
                            self.tools_expanded = !self.tools_expanded;
                            let msg = if self.tools_expanded {
                                "已展开工具详情（Ctrl+O 收起）"
                            } else {
                                "已收起工具详情（Ctrl+O 展开）"
                            };
                            self.set_notice(msg, false);
                            dirty = true;
                        } else if key.code == KeyCode::Char('d')
                            && key.modifiers.contains(KeyModifiers::CONTROL)
                            && self.composer.draft().is_empty()
                        {
                            self.shutdown_tasks().await;
                            return Ok(ShellOutcome::Quit);
                        } else {
                            match self.leader.resolve(key) {
                                LeaderAction::Armed => {
                                    self.set_notice(
                                        "Ctrl+X · M 模型 · O 模式 · P 权限 · N 新建 · L 恢复 · 1/2/3 模式",
                                        false,
                                    );
                                    dirty = true;
                                }
                                LeaderAction::Consumed => {}
                                LeaderAction::Cancelled => {
                                    self.clear_notice();
                                    dirty = true;
                                }
                                LeaderAction::Command(cmd) => {
                                    self.composer.accepted();
                                    let _ = self.handle_command(&format!("/{cmd}"));
                                    dirty = true;
                                }
                                LeaderAction::Mode(wire) => {
                                    if let Ok(m) = wire.parse::<RuntimeMode>() {
                                        self.apply_mode(m);
                                    }
                                    dirty = true;
                                }
                                LeaderAction::None => {
                                    let slash_items = filter_classic_slash_items(
                                        self.composer.draft(),
                                        slash_ctx,
                                    );
                                    let slash_count = slash_items.len();
                                    if slash_count > 0
                                        && matches!(
                                            key.code,
                                            KeyCode::Up
                                                | KeyCode::Down
                                                | KeyCode::Tab
                                                | KeyCode::Esc
                                                | KeyCode::Enter
                                        )
                                    {
                                        match key.code {
                                            KeyCode::Up => {
                                                self.slash_selected = if self.slash_selected == 0 {
                                                    slash_count.saturating_sub(1)
                                                } else {
                                                    self.slash_selected - 1
                                                };
                                                dirty = true;
                                            }
                                            KeyCode::Down => {
                                                self.slash_selected =
                                                    (self.slash_selected + 1) % slash_count;
                                                dirty = true;
                                            }
                                            KeyCode::Esc => {
                                                self.composer.accepted();
                                                self.slash_selected = 0;
                                                dirty = true;
                                            }
                                            KeyCode::Tab => {
                                                let completed = slash_items
                                                    [self.slash_selected.min(slash_count - 1)]
                                                .command
                                                .to_owned();
                                                self.composer.accepted();
                                                self.composer.apply(Action::Insert(completed));
                                                self.slash_selected = 0;
                                                dirty = true;
                                            }
                                            KeyCode::Enter => {
                                                let draft = self.composer.draft().to_owned();
                                                let chosen = if self.slash_selected == 0
                                                    && !matches!(
                                                        parse_classic_command(&draft),
                                                        ClassicCommand::Invalid
                                                            | ClassicCommand::Text(_)
                                                    ) {
                                                    draft
                                                } else {
                                                    slash_items
                                                        [self.slash_selected.min(slash_count - 1)]
                                                    .command
                                                    .to_owned()
                                                };
                                                self.slash_selected = 0;
                                                if let Some(outcome) = self.handle_command(&chosen)
                                                {
                                                    self.shutdown_tasks().await;
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            _ => {}
                                        }
                                    } else if let Some(redraw) = self.handle_user_input_key(key) {
                                        if redraw {
                                            dirty = true;
                                        }
                                    } else if key.code == KeyCode::Esc
                                        && !self.anchor.is_following()
                                    {
                                        self.anchor.jump_to_latest();
                                        self.set_notice("已回到最新对话。", false);
                                        dirty = true;
                                    } else if key.code == KeyCode::Up
                                        && self.composer.draft().is_empty()
                                    {
                                        self.anchor.scroll_up(3, 10_000, None);
                                        dirty = true;
                                    } else if key.code == KeyCode::Down
                                        && self.composer.draft().is_empty()
                                    {
                                        self.anchor.scroll_down(3);
                                        dirty = true;
                                    } else if key.code == KeyCode::PageUp {
                                        self.anchor.scroll_up(12, 10_000, None);
                                        if let Some(cursor) = self.older.clone() {
                                            self.reload_transcript(Some(cursor));
                                        }
                                        dirty = true;
                                    } else if key.code == KeyCode::PageDown {
                                        self.anchor.scroll_down(12);
                                        dirty = true;
                                    } else if key.code == KeyCode::End
                                        && self.composer.draft().is_empty()
                                    {
                                        self.anchor.jump_to_latest();
                                        dirty = true;
                                    } else if key.code == KeyCode::Char('c')
                                        && key.modifiers.contains(KeyModifiers::CONTROL)
                                        && self.is_busy()
                                    {
                                        if let Some(active) = self.active.as_mut() {
                                            active.cancelling = true;
                                            active.cancel.cancel();
                                            self.set_notice("正在停止本轮…", false);
                                        }
                                        if let Some(comp) = self.compacting.as_mut() {
                                            comp.cancelling = true;
                                            comp.cancel.cancel();
                                            self.set_notice("正在取消压缩…", false);
                                        }
                                        dirty = true;
                                    } else if let Some(action) = action_for_event(Event::Key(key)) {
                                        match action {
                                            Action::Submit => {
                                                let text = self.composer.draft().to_owned();
                                                if let Some(outcome) = self.handle_command(&text) {
                                                    self.shutdown_tasks().await;
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            other => match self.composer.apply(other) {
                                                Effect::Quit => {
                                                    self.shutdown_tasks().await;
                                                    return Ok(ShellOutcome::Quit);
                                                }
                                                Effect::Redraw => {
                                                    if !self.is_busy() {
                                                        self.clear_notice();
                                                    }
                                                    self.slash_selected = 0;
                                                    dirty = true;
                                                }
                                                Effect::None => {}
                                            },
                                        }
                                    }
                                }
                            }
                        }
                    }
                    _ => {}
                }
            }

            if dirty {
                self.draw(terminal)?;
                tokio::task::yield_now().await;
            } else if self.is_busy() {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => {}
                    _ = tokio::time::sleep(Duration::from_millis(15)) => {}
                }
            } else {
                tokio::task::yield_now().await;
            }
        }
    }
}

fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let doy = (153 * (m + if m > 2 { -3 } else { 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_iso8601_millis(raw: &str) -> Option<u64> {
    let s = raw.trim();
    if s.len() < 19 || !s.is_ascii() {
        return None;
    }
    let bytes = s.as_bytes();
    if bytes[4] != b'-'
        || bytes[7] != b'-'
        || !(bytes[10] == b'T' || bytes[10] == b't' || bytes[10] == b' ')
        || bytes[13] != b':'
        || bytes[16] != b':'
    {
        return None;
    }
    let year: i64 = s[0..4].parse().ok()?;
    let month: i64 = s[5..7].parse().ok()?;
    let day: i64 = s[8..10].parse().ok()?;
    let hour: i64 = s[11..13].parse().ok()?;
    let min: i64 = s[14..16].parse().ok()?;
    let sec: i64 = s[17..19].parse().ok()?;
    if !(1..=12).contains(&month)
        || !(1..=31).contains(&day)
        || !(0..24).contains(&hour)
        || !(0..60).contains(&min)
        || !(0..60).contains(&sec)
    {
        return None;
    }
    let mut rest = &s[19..];
    let mut ms: i64 = 0;
    if let Some(after_dot) = rest.strip_prefix('.') {
        let digits: String = after_dot
            .chars()
            .take_while(|c| c.is_ascii_digit())
            .collect();
        rest = &after_dot[digits.len()..];
        let mut frac = [b'0'; 3];
        for (i, b) in digits.bytes().take(3).enumerate() {
            frac[i] = b;
        }
        ms = std::str::from_utf8(&frac).ok()?.parse().ok()?;
    }
    let offset_ms: i64 = if rest.is_empty() || rest == "Z" || rest == "z" {
        0
    } else if (rest.starts_with('+') || rest.starts_with('-')) && rest.len() >= 6 {
        let sign = if rest.starts_with('-') { -1 } else { 1 };
        let parts = &rest[1..];
        if parts.as_bytes().get(2) != Some(&b':') {
            return None;
        }
        let oh: i64 = parts[0..2].parse().ok()?;
        let om: i64 = parts[3..5].parse().ok()?;
        if oh >= 24 || om >= 60 {
            return None;
        }
        sign * (oh * 3600 + om * 60) * 1000
    } else {
        return None;
    };
    let days = days_from_civil(year, month, day);
    let utc_ms = (days * 86_400 + hour * 3600 + min * 60 + sec) * 1000 + ms - offset_ms;
    u64::try_from(utc_ms).ok()
}

fn is_request_user_input_tool(capability_id: &str, raw_tool: &str) -> bool {
    let cap = capability_id.to_ascii_lowercase();
    let raw = raw_tool.to_ascii_lowercase();
    cap == "local.interaction.request_user_input"
        || cap == "request_user_input"
        || cap.ends_with(".request_user_input")
        || raw == "local.interaction.request_user_input"
        || raw == "request_user_input"
        || raw.ends_with(".request_user_input")
}

fn tool_display_name(capability_id: &str, raw_tool: &str) -> String {
    if is_request_user_input_tool(capability_id, raw_tool) {
        return "Ask user".to_owned();
    }
    let known = |id: &str| -> Option<&'static str> {
        match id.to_ascii_lowercase().as_str() {
            "local.shell.exec" | "bash" | "shell" => Some("Bash"),
            "local.file.read" | "read_file" | "read" => Some("Read"),
            "local.file.write" | "write_file" | "write" | "edit_file" => Some("Write"),
            "local.file.list" | "list_files" | "list" => Some("List"),
            "local.search.content"
            | "local.search.files"
            | "local.search.aggregate"
            | "search_files"
            | "batch_search"
            | "grep"
            | "glob" => Some("Search"),
            "local.git.query" | "git_query" => Some("Git"),
            "read_tool_result" | "local.tool.read_result" => Some("Read result"),
            "web_fetch" | "local.web.fetch" => Some("Fetch"),
            "web_search" | "local.web.search" => Some("Web search"),
            _ => None,
        }
    };
    if let Some(name) = known(capability_id).or_else(|| known(raw_tool)) {
        return name.to_owned();
    }
    let base = if !raw_tool.trim().is_empty() {
        raw_tool.trim()
    } else {
        capability_id.trim()
    };
    let leaf = base.split('.').rfind(|s| !s.is_empty()).unwrap_or("tool");
    if let Some(name) = known(leaf) {
        return name.to_owned();
    }
    let mut chars = leaf.chars();
    match chars.next() {
        Some(c) => format!("{}{}", c.to_uppercase(), chars.as_str()),
        None => "Tool".to_owned(),
    }
}

fn compact_path_display(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.starts_with("/Users/") || trimmed.starts_with("/home/") {
        compact_workspace_path(trimmed)
    } else {
        trimmed.to_owned()
    }
}

fn str_arg<'a>(args: Option<&'a Value>, key: &str) -> Option<&'a str> {
    args?
        .get(key)?
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn tool_argument_summary(
    capability_id: &str,
    raw_tool: &str,
    args: Option<&Value>,
    result: Option<&Value>,
) -> String {
    let cap_lower = capability_id.to_ascii_lowercase();
    let raw_lower = raw_tool.to_ascii_lowercase();
    let is_cap = |c: &str, t: &str| cap_lower == c || raw_lower == t;

    if is_request_user_input_tool(capability_id, raw_tool)
        && let Some(q) = str_arg(args, "question")
    {
        return bounded_text(q, 120);
    }
    if is_cap("local.shell.exec", "bash")
        && let Some(cmd) = str_arg(args, "command")
    {
        return bounded_text(cmd, 120);
    }
    if (is_cap("local.file.read", "read_file")
        || is_cap("local.file.write", "write_file")
        || is_cap("local.file.write", "edit_file")
        || is_cap("local.file.list", "list_files"))
        && let Some(p) = str_arg(args, "path").or_else(|| str_arg(args, "file"))
    {
        return bounded_text(&compact_path_display(p), 120);
    }
    if is_cap("local.git.query", "git_query") {
        let op = str_arg(args, "operation");
        let path = str_arg(args, "path").map(compact_path_display);
        let summary = match (op, path) {
            (Some(o), Some(p)) => format!("{o} {p}"),
            (Some(o), None) => o.to_owned(),
            (None, Some(p)) => p,
            (None, None) => String::new(),
        };
        if !summary.is_empty() {
            return bounded_text(&summary, 120);
        }
    }
    if (is_cap("local.search.content", "search_files")
        || is_cap("local.search.files", "batch_search")
        || is_cap("local.search.aggregate", "grep")
        || raw_lower == "glob")
        && let Some(q) = str_arg(args, "query")
            .or_else(|| str_arg(args, "pattern"))
            .or_else(|| str_arg(args, "path"))
    {
        return bounded_text(&compact_path_display(q), 120);
    }
    if (raw_lower == "read_tool_result" || cap_lower == "local.tool.read_result")
        && let Some(args_val) = args
        && let Some(bytes) = args_val["reference"]["bytes"].as_u64()
    {
        let offset = args_val["offset"].as_u64().unwrap_or(0);
        return if offset > 0 {
            format!("{bytes}B @ {offset}")
        } else {
            format!("{bytes}B")
        };
    }
    for key in [
        "path",
        "command",
        "query",
        "action",
        "operation",
        "url",
        "name",
        "id",
    ] {
        if let Some(val) = str_arg(args, key) {
            return bounded_text(&compact_path_display(val), 120);
        }
    }
    if let Some(obj) = args.and_then(|v| v.as_object())
        && !obj.is_empty()
    {
        let keys: Vec<&str> = obj.keys().map(String::as_str).take(3).collect();
        return keys.join(", ");
    }
    if let Some(summary) = result.and_then(|r| r["evidence"]["summary"].as_str()) {
        return bounded_text(summary.trim(), 120);
    }
    String::new()
}

fn push_detail_line(out: &mut Vec<String>, raw: &str) {
    if out.len() >= 4 {
        return;
    }
    let clean = bounded_text(raw.trim(), 160);
    if !clean.is_empty() && !out.iter().any(|existing| existing == &clean) {
        out.push(clean);
    }
}

fn parse_string_options(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(|v| v.as_array())
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_str())
        .map(|s| bounded_text(s.trim(), 160))
        .filter(|s| !s.is_empty())
        .take(12)
        .collect()
}

fn extract_user_input_options(
    args: Option<&Value>,
    result: Option<&Value>,
    detail_lines: &[String],
) -> Vec<String> {
    for candidate in [
        args.and_then(|a| a.get("options")),
        result
            .and_then(|r| r.get("output"))
            .and_then(|o| o.get("options")),
        result
            .and_then(|r| r.get("metadata"))
            .and_then(|m| m.get("options")),
    ] {
        let parsed = parse_string_options(candidate);
        if !parsed.is_empty() {
            return parsed;
        }
    }
    let mut recovered = Vec::new();
    for line in detail_lines {
        let trimmed = line.trim();
        if let Some((num, rest)) = trimmed.split_once('.')
            && !num.is_empty()
            && num.chars().all(|c| c.is_ascii_digit())
        {
            let opt = bounded_text(rest.trim(), 160);
            if !opt.is_empty() {
                recovered.push(opt);
            }
        }
    }
    recovered.truncate(12);
    recovered
}

fn extract_user_input_prompt(seg: &Value) -> Option<UserInputPrompt> {
    if seg["type"].as_str() != Some("tool-call") {
        return None;
    }
    let result = seg.get("result").filter(|v| !v.is_null())?;
    if !matches!(result["status"].as_str(), Some("completed" | "success")) {
        return None;
    }
    let raw_tool = seg["tool"].as_str().unwrap_or("");
    let capability_id = result["capabilityId"].as_str().unwrap_or(raw_tool);
    if !is_request_user_input_tool(capability_id, raw_tool) {
        return None;
    }
    let args = seg.get("args");
    let question = str_arg(args, "question")
        .or_else(|| {
            result["output"]["question"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .or_else(|| {
            result["metadata"]["question"]
                .as_str()
                .map(str::trim)
                .filter(|s| !s.is_empty())
        })
        .map(|s| bounded_text(s, 400))?;
    let detail_lines = extract_tool_detail_lines(raw_tool, capability_id, args, Some(result));
    let options = extract_user_input_options(args, Some(result), &detail_lines);
    let tool_call_id = seg["toolCallId"]
        .as_str()
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    Some(UserInputPrompt {
        question,
        options,
        tool_call_id,
    })
}

fn find_pending_user_input(rows: &[TranscriptRow]) -> Option<UserInputPrompt> {
    for row in rows.iter().rev() {
        let TranscriptRow::Message { raw, .. } = row else {
            continue;
        };
        match raw["role"].as_str() {
            Some("user") => break,
            Some("assistant") => {
                if let Some(segments) = raw["segments"].as_array() {
                    for seg in segments.iter().rev() {
                        if let Some(prompt) = extract_user_input_prompt(seg)
                            && !prompt.options.is_empty()
                        {
                            return Some(prompt);
                        }
                    }
                }
            }
            _ => {}
        }
    }
    None
}

fn extract_tool_detail_lines(
    raw_tool: &str,
    capability_id: &str,
    args: Option<&Value>,
    result: Option<&Value>,
) -> Vec<String> {
    let Some(res) = result else {
        return Vec::new();
    };
    let mut out = Vec::new();
    if let Some(err) = res.get("error").filter(|v| !v.is_null()) {
        if let Some(msg) = err["message"].as_str().or_else(|| err["code"].as_str()) {
            push_detail_line(&mut out, msg);
        } else if let Some(msg) = err.as_str() {
            push_detail_line(&mut out, msg);
        }
    }
    if is_request_user_input_tool(capability_id, raw_tool) && out.is_empty() {
        let options = extract_user_input_options(args, Some(res), &[]);
        for (idx, opt) in options.iter().enumerate() {
            push_detail_line(&mut out, &format!("{}. {}", idx + 1, opt));
        }
    }
    if let Some(preview) = res["outputPreview"]["text"].as_str() {
        for line in preview.lines() {
            if !line.trim().is_empty() {
                push_detail_line(&mut out, line);
            }
        }
    }
    if let Some(output) = res.get("output").filter(|v| !v.is_null()) {
        if let Some(text) = output.as_str() {
            for line in text.lines() {
                if !line.trim().is_empty() {
                    push_detail_line(&mut out, line);
                }
            }
        } else if let Some(obj) = output.as_object() {
            for key in ["stdout", "stderr", "content"] {
                if let Some(s) = obj.get(key).and_then(|v| v.as_str()) {
                    for line in s.lines() {
                        if !line.trim().is_empty() {
                            push_detail_line(&mut out, line);
                        }
                    }
                }
            }
            if let Some(entries) = obj.get("entries").and_then(|v| v.as_array())
                && !entries.is_empty()
            {
                let names: Vec<&str> = entries
                    .iter()
                    .filter_map(|e| e["name"].as_str())
                    .take(5)
                    .collect();
                if !names.is_empty() {
                    push_detail_line(
                        &mut out,
                        &format!("{} entries: {}", entries.len(), names.join(", ")),
                    );
                }
            }
        }
    }
    if let Some(summary) = res["evidence"]["summary"].as_str() {
        push_detail_line(&mut out, summary);
    }
    if let Some(refs) = res["evidence"]["artifactRefs"].as_array() {
        for r in refs {
            if let Some(s) = r.as_str() {
                push_detail_line(&mut out, s);
            }
        }
    }
    out
}

fn apply_continuation(rows: &mut [ClassicMessage], streams: &[Option<String>]) {
    let mut prev_stream: Option<&str> = None;
    let mut prev_assistant = false;
    let mut prev_has_tools = false;
    for (idx, msg) in rows.iter_mut().enumerate() {
        let cur_stream = streams.get(idx).and_then(|s| s.as_deref());
        let is_assistant = msg.role == "assistant";
        msg.continuation = prev_assistant
            && is_assistant
            && ((cur_stream.is_some() && cur_stream == prev_stream)
                || !msg.tools.is_empty()
                || prev_has_tools);
        prev_assistant = is_assistant;
        prev_stream = cur_stream;
        prev_has_tools = !msg.tools.is_empty();
    }
    if let Some(first) = rows.first_mut() {
        first.continuation = false;
    }
}

fn parse_transcript_row(row: TranscriptRow, idx: usize) -> (Option<String>, ClassicMessage) {
    let TranscriptRow::Message { raw, .. } = row else {
        return (
            None,
            ClassicMessage {
                id: format!("corrupt-{idx}"),
                revision: 1,
                role: "system".into(),
                text: "历史中有一条无法读取的记录。".into(),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
        );
    };
    let val = &raw;
    let id = val["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("row-{idx}"));
    let role = val["role"].as_str().unwrap_or("assistant").to_owned();
    let stream_id = val["streamId"].as_str().map(str::to_owned);
    let started_ms = val["createdAt"].as_str().and_then(parse_iso8601_millis);
    let mut text = val["content"]
        .as_str()
        .map(|s| bounded_text(s, 16 * 1024))
        .unwrap_or_default();
    let mut thinking_parts = Vec::new();
    let mut tools = Vec::new();
    let mut text_parts = Vec::new();

    if let Some(segments) = val["segments"].as_array() {
        for seg in segments {
            match seg["type"].as_str() {
                Some("text") => {
                    if let Some(s) = seg["content"].as_str()
                        && !s.is_empty()
                    {
                        text_parts.push(bounded_text(s, 16 * 1024));
                    }
                }
                Some("thinking") => {
                    if let Some(s) = seg["content"].as_str()
                        && !s.trim().is_empty()
                    {
                        thinking_parts.push(bounded_text(s.trim(), 4 * 1024));
                    }
                }
                Some("tool-call") => {
                    let raw_tool = seg["tool"].as_str().unwrap_or("tool");
                    let call_id = seg["toolCallId"].as_str().unwrap_or("").to_owned();
                    let result = seg.get("result").filter(|v| !v.is_null());
                    let capability_id = result
                        .and_then(|r| r["capabilityId"].as_str())
                        .unwrap_or(raw_tool)
                        .to_owned();
                    let status = match result.and_then(|r| r["status"].as_str()) {
                        None => ToolRowStatus::Running,
                        Some("success" | "completed") => ToolRowStatus::Completed,
                        Some("failed") => ToolRowStatus::Failed,
                        Some("denied") => ToolRowStatus::Denied,
                        Some("cancelled") => ToolRowStatus::Cancelled,
                        Some("running") => ToolRowStatus::Running,
                        Some(_) => ToolRowStatus::Unknown,
                    };
                    let completed_ms = result
                        .and_then(|r| r["completedAt"].as_str())
                        .and_then(parse_iso8601_millis);
                    let duration_ms = match (started_ms, completed_ms) {
                        (Some(s), Some(e)) => e.checked_sub(s),
                        _ => None,
                    };
                    let args = seg.get("args");
                    tools.push(ToolTimelineRow {
                        call_id,
                        tool_name: tool_display_name(&capability_id, raw_tool),
                        summary: tool_argument_summary(&capability_id, raw_tool, args, result),
                        capability_id: capability_id.clone(),
                        status,
                        duration_ms,
                        detail_lines: extract_tool_detail_lines(
                            raw_tool,
                            &capability_id,
                            args,
                            result,
                        ),
                    });
                }
                Some("tool-result") if tools.is_empty() => {
                    let status_raw = seg["status"].as_str().unwrap_or("done");
                    text_parts.push(format!("[工具结果] {status_raw}"));
                }
                _ => {}
            }
        }
    }
    if text.is_empty() && !text_parts.is_empty() {
        text = text_parts.join("\n");
    }
    if thinking_parts.is_empty()
        && let Some(raw_thinking) = val["thinkingContent"].as_str()
        && !raw_thinking.trim().is_empty()
    {
        thinking_parts.push(bounded_text(raw_thinking.trim(), 4 * 1024));
    }
    let thinking = if thinking_parts.is_empty() {
        None
    } else {
        Some(thinking_parts.join("\n"))
    };
    (
        stream_id,
        ClassicMessage {
            id,
            revision: 1,
            role,
            text,
            thinking,
            tools,
            continuation: false,
        },
    )
}

pub(super) async fn run_classic_shell(
    home: PathBuf,
    workspace: PathBuf,
    prefs: &mut TerminalPreferences,
    terminal: &mut TerminalGuard,
    shutdown: &CancellationToken,
) -> io::Result<ShellOutcome> {
    let session = ClassicSession::new(home, workspace, prefs);
    LocalSet::new()
        .run_until(session.run(terminal, shutdown))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn transcript_tool_rows_and_grouping_match_opentui_timeline() {
        let range = || peer_protocol::TranscriptRange { start: 0, end: 1 };
        let user_row = TranscriptRow::Message {
            raw: json!({
                "id": "m0",
                "role": "user",
                "content": "看一下最近的重点"
            }),
            range: range(),
        };
        let intro_row = TranscriptRow::Message {
            raw: json!({
                "id": "m1",
                "role": "assistant",
                "streamId": "stream-1",
                "createdAt": "2026-11-19T13:03:06.600Z",
                "content": "我先查看状态。"
            }),
            range: range(),
        };
        let git_fail_row = TranscriptRow::Message {
            raw: json!({
                "id": "m2",
                "role": "assistant",
                "streamId": "stream-1",
                "createdAt": "2026-11-19T13:03:06.628Z",
                "content": "",
                "segments": [{
                    "type": "tool-call",
                    "tool": "git_query",
                    "toolCallId": "c1",
                    "args": {"path": "/Users/alice/Documents/peer-dev", "operation": "snapshot"},
                    "result": {
                        "capabilityId": "local.git.query",
                        "status": "failed",
                        "completedAt": "2026-11-19T13:03:06.876Z",
                        "error": {"code": "git_not_repository", "message": "git_not_repository"}
                    }
                }]
            }),
            range: range(),
        };
        let list_ok_row = TranscriptRow::Message {
            raw: json!({
                "id": "m3",
                "role": "assistant",
                "streamId": "stream-1",
                "createdAt": "2026-11-19T13:03:12.504Z",
                "content": "",
                "segments": [{
                    "type": "tool-call",
                    "tool": "list_files",
                    "toolCallId": "c2",
                    "args": {"path": "/Users/alice/Documents/peer-dev"},
                    "result": {
                        "capabilityId": "local.file.list",
                        "status": "success",
                        "completedAt": "2026-11-19T13:03:12.630Z",
                        "evidence": {"summary": "list_files: success"}
                    }
                }]
            }),
            range: range(),
        };
        let bash_running_row = TranscriptRow::Message {
            raw: json!({
                "id": "m4",
                "role": "assistant",
                "streamId": "stream-1",
                "createdAt": "2026-11-19T13:03:36.226Z",
                "content": "",
                "segments": [{
                    "type": "tool-call",
                    "tool": "bash",
                    "toolCallId": "c3",
                    "args": {"command": "git status"}
                }]
            }),
            range: range(),
        };

        let mut streams = Vec::new();
        let mut msgs = Vec::new();
        for (idx, row) in [
            user_row,
            intro_row,
            git_fail_row,
            list_ok_row,
            bash_running_row,
        ]
        .into_iter()
        .enumerate()
        {
            let (s, m) = parse_transcript_row(row, idx);
            streams.push(s);
            msgs.push(m);
        }
        apply_continuation(&mut msgs, &streams);

        assert!(!msgs[0].continuation);
        assert!(!msgs[1].continuation);
        assert!(msgs[2].continuation);
        assert!(msgs[3].continuation);
        assert!(msgs[4].continuation);

        assert_eq!(msgs[2].tools[0].tool_name, "Git");
        assert_eq!(msgs[2].tools[0].status, ToolRowStatus::Failed);
        assert_eq!(msgs[2].tools[0].summary, "snapshot ~/Documents/peer-dev");
        assert_eq!(msgs[2].tools[0].duration_ms, Some(248));
        assert_eq!(msgs[2].tools[0].detail_lines, vec!["git_not_repository"]);

        assert_eq!(msgs[3].tools[0].tool_name, "List");
        assert_eq!(msgs[3].tools[0].status, ToolRowStatus::Completed);
        assert_eq!(msgs[3].tools[0].summary, "~/Documents/peer-dev");
        assert_eq!(msgs[3].tools[0].duration_ms, Some(126));

        assert_eq!(msgs[4].tools[0].tool_name, "Bash");
        assert_eq!(msgs[4].tools[0].status, ToolRowStatus::Running);
        assert_eq!(msgs[4].tools[0].summary, "git status");
        assert_eq!(msgs[4].tools[0].duration_ms, None);
    }

    #[test]
    fn parse_transcript_row_reads_thinking_segments_and_thinking_content_fallback() {
        let range = || peer_protocol::TranscriptRange { start: 0, end: 1 };
        let seg_row = TranscriptRow::Message {
            raw: json!({
                "id": "m-seg",
                "role": "assistant",
                "content": "回答",
                "segments": [
                    {"type": "thinking", "content": "思考步骤一"},
                    {"type": "text", "content": "回答"}
                ]
            }),
            range: range(),
        };
        let fallback_row = TranscriptRow::Message {
            raw: json!({
                "id": "m-fb",
                "role": "assistant",
                "content": "结论",
                "thinkingContent": "顶层思考字段"
            }),
            range: range(),
        };
        let (_, m_seg) = parse_transcript_row(seg_row, 0);
        assert_eq!(m_seg.thinking.as_deref(), Some("思考步骤一"));
        let (_, m_fb) = parse_transcript_row(fallback_row, 1);
        assert_eq!(m_fb.thinking.as_deref(), Some("顶层思考字段"));
    }

    #[test]
    fn find_pending_user_input_extracts_latest_completed_question_until_user_reply() {
        let range = || peer_protocol::TranscriptRange { start: 0, end: 1 };
        let user_q = TranscriptRow::Message {
            raw: json!({
                "id": "u1",
                "role": "user",
                "content": "最近重点是什么"
            }),
            range: range(),
        };
        let denied_ask = TranscriptRow::Message {
            raw: json!({
                "id": "a-denied",
                "role": "assistant",
                "content": "",
                "segments": [{
                    "type": "tool-call",
                    "tool": "request_user_input",
                    "toolCallId": "c0",
                    "args": {"question": "Headless denied?", "options": ["X", "Y"]},
                    "result": {
                        "capabilityId": "local.interaction.request_user_input",
                        "status": "denied",
                        "error": {"code": "request_user_input_unavailable"}
                    }
                }]
            }),
            range: range(),
        };
        assert_eq!(
            find_pending_user_input(&[user_q.clone(), denied_ask.clone()]),
            None
        );

        let completed_ask = TranscriptRow::Message {
            raw: json!({
                "id": "a-ask",
                "role": "assistant",
                "content": "",
                "segments": [{
                    "type": "tool-call",
                    "tool": "request_user_input",
                    "toolCallId": "c1",
                    "args": {"question": "需要我先做哪一件？", "options": ["A 核对", "B 盘点", "C 梳理"]},
                    "result": {
                        "capabilityId": "local.interaction.request_user_input",
                        "status": "completed",
                        "output": {"ok": true, "acknowledged": true}
                    }
                }]
            }),
            range: range(),
        };
        let found = find_pending_user_input(&[user_q.clone(), completed_ask.clone()]).unwrap();
        assert_eq!(found.question, "需要我先做哪一件？");
        assert_eq!(found.options, vec!["A 核对", "B 盘点", "C 梳理"]);
        assert_eq!(found.tool_call_id.as_deref(), Some("c1"));

        let (_, msg) = parse_transcript_row(completed_ask.clone(), 0);
        assert_eq!(msg.tools[0].tool_name, "Ask user");
        assert_eq!(
            msg.tools[0].detail_lines,
            vec!["1. A 核对", "2. B 盘点", "3. C 梳理"]
        );

        let user_reply = TranscriptRow::Message {
            raw: json!({
                "id": "u2",
                "role": "user",
                "content": "A 核对"
            }),
            range: range(),
        };
        assert_eq!(
            find_pending_user_input(&[user_q, completed_ask, user_reply]),
            None
        );
    }

    #[test]
    fn build_approval_card_extracts_action_location_reason_risk_and_compact_args() {
        let prompt = json!({
            "tool": "git_query",
            "capabilityId": "local.git.query",
            "workspacePath": "/Users/yinliang/Documents/Develop/peer-dev",
            "reason": "Outside workspace file read requires approval.",
            "riskLevel": "L1_local_read",
            "arguments": {"operation": "log", "path": "/Users/yinliang/Documents/Develop/peer-dev/Peer-Agent", "limit": 25},
            "scopes": [{
                "kind": "file-read",
                "capabilityId": "local.git.query",
                "path": "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig",
                "workspacePath": "/Users/yinliang/Documents/Develop/peer-dev"
            }]
        });
        let card = super::super::resumed::ports::build_approval_card("git_query", &prompt);
        assert_eq!(card.action, "git_query (local.git.query)");
        assert_eq!(
            card.location,
            "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig"
        );
        assert_eq!(
            card.reason,
            "Outside workspace file read requires approval."
        );
        assert_eq!(card.risk, "l1_local_read");
        assert!(card.arguments.contains("\"operation\":\"log\""));
        assert!(!card.arguments.contains('\n'));
    }
}
