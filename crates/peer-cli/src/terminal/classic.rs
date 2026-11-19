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
};
use peer_store::{
    ConversationModelSelection, ConversationStore, GoalStore, TranscriptLimits, TranscriptReader,
};
use peer_tui::{
    Action, ByteBudgetLru, ClassicCommand, ClassicMessage, ClassicOverlay, ClassicView, Composer,
    Effect, GoalMenuStatus, GoalPickerRow, HistoryDirection, LeaderAction, LeaderKeyState,
    MARKDOWN_WRAP_CACHE_BYTES, ModelPickerEvent, ModelPickerState, ReadingAnchor, RenderedBlock,
    ResumeSessionRow, SlashFilterContext, ThemeMode, TuiLocale, WrapCacheKey, action_for_event,
    filter_classic_slash_items, parse_classic_command, render_classic, terminal_text,
};
use std::{io, path::PathBuf, rc::Rc, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, LocalSet},
};

const MAX_DISPLAY_MESSAGES: usize = 64;
const IDLE_STATUS: &str =
    "Enter 发送 · /resume 恢复会话 · /model 选模型 · Ctrl+X 快捷键 · /help 帮助";
const ACTIVE_STATUS: &str = "本轮进行中 · ↑/↓ 阅读 · End/PgDn 最新 · Ctrl-C 停止本轮";
const COMPACTING_STATUS: &str = "正在压缩上下文… · Ctrl-C 取消";
const APPROVAL_STATUS: &str = "y 仅允许本次 · n / Esc 拒绝 · ↑/↓ 滚动 · Ctrl-C 停止本轮";

struct ActiveTurn {
    cancel: CancellationToken,
    task: JoinHandle<Result<String, &'static str>>,
    display: watch::Receiver<Display>,
    prompts: mpsc::Receiver<Approval>,
    accepted: bool,
    revision: usize,
}

struct ActiveCompaction {
    cancel: CancellationToken,
    task: JoinHandle<Result<CompactOutcome, &'static str>>,
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
    goal_plans: Vec<GoalPickerRow>,
    selected_goal_plan_id: Option<String>,
    composer: Composer,
    messages: Vec<ClassicMessage>,
    older: Option<TranscriptCursor>,
    anchor: ReadingAnchor,
    status: String,
    interrupted_preview: String,
    active: Option<ActiveTurn>,
    compacting: Option<ActiveCompaction>,
    approval: Option<Approval>,
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
            goal_plans: Vec::new(),
            selected_goal_plan_id: None,
            composer: Composer::default(),
            messages: Vec::new(),
            older: None,
            anchor: ReadingAnchor::FollowingLatest,
            status: IDLE_STATUS.to_owned(),
            interrupted_preview: String::new(),
            active: None,
            compacting: None,
            approval: None,
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
            records: 24,
            ..TranscriptLimits::default()
        };
        match TranscriptReader::new(&self.home).read_page(conv_id, cursor.as_ref(), limits, None) {
            Ok(page) => {
                self.older = page.older;
                let mut rows = Vec::with_capacity(page.rows.len());
                for (idx, row) in page.rows.into_iter().enumerate() {
                    let (id, role, text) = format_transcript_row(row, idx);
                    rows.push(ClassicMessage {
                        id,
                        revision: 1,
                        role,
                        text,
                    });
                }
                if cursor.is_some() {
                    rows.extend(std::mem::take(&mut self.messages));
                    if rows.len() > MAX_DISPLAY_MESSAGES {
                        rows.truncate(MAX_DISPLAY_MESSAGES);
                    }
                    self.messages = rows;
                } else {
                    if rows.len() > MAX_DISPLAY_MESSAGES {
                        let drop_n = rows.len() - MAX_DISPLAY_MESSAGES;
                        rows.drain(..drop_n);
                    }
                    self.messages = rows;
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

        self.conversation_id = Some(id.to_owned());
        self.interrupted_preview.clear();
        self.anchor.jump_to_latest();
        self.reload_transcript(None);
        self.refresh_context_percent();
        self.refresh_goal_plans();
        self.overlay = ClassicOverlay::None;
        self.composer.accepted();

        let title = metadata["title"].as_str().unwrap_or(id);
        self.status = if let Some(note) = model_notice {
            format!("已恢复会话：{}（{note}）", terminal_text(title))
        } else {
            format!("已恢复会话：{}", terminal_text(title))
        };
    }

    fn apply_mode(&mut self, next: RuntimeMode) {
        if let Some(ref cid) = self.conversation_id
            && !self.is_busy()
            && let Err(err) = self
                .runtime
                .update_ordinary_mode(cid, &self.workspace, next)
        {
            self.status = format!("切换模式失败（{}）。", err.0);
            return;
        }
        self.mode = next;
        let label = match next {
            RuntimeMode::Chat => "Agent",
            RuntimeMode::Plan => "Plan",
            RuntimeMode::Goal => "Goal",
            other => other.as_str(),
        };
        self.status = format!("运行模式已切换为 {label}。");
    }

    fn apply_access(&mut self, next_wire: &str) {
        let next = match next_wire {
            "full" => LocalAccessLevel::FullLocal,
            "session" => LocalAccessLevel::SessionLocal,
            _ => LocalAccessLevel::AskBeforeLocal,
        };
        if self.access.set(next).is_ok() {
            self.access_level = next;
            self.status = format!("本地权限策略已切换为 {next_wire}。");
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
                self.status = format!("保存模型选择失败（{}），请停止当前执行后再试。", err.0);
                return;
            }
        }
        self.selected_provider = Some(provider_id);
        self.selected_model = Some(model_id);
        self.selected_display_name = display_name;
        self.selected_effort = effort;
        self.refresh_fast_available();
        self.refresh_context_percent();
        self.status = format!("当前模型已切换为 {}。", self.model_badge());
    }

    fn apply_theme_mode(&mut self, next_mode: ThemeMode) {
        match theme_store::save_theme_mode(&self.home, next_mode) {
            Ok(scheme) => {
                self.prefs.mode = next_mode;
                self.prefs.scheme = scheme;
                self.wrap_cache.clear();
                self.status = format!(
                    "主题已切换为 {}（配色: {}）。",
                    next_mode.as_str(),
                    scheme.as_str()
                );
            }
            Err(err) => {
                self.status = format!("保存主题失败：{err}");
            }
        }
    }

    fn apply_locale(&mut self, next_locale: TuiLocale) {
        match theme_store::save_locale(&self.home, next_locale) {
            Ok(()) => {
                self.prefs.locale = next_locale;
                self.status = format!("界面语言已切换为 {}。", next_locale.as_str());
            }
            Err(err) => {
                self.status = format!("保存语言失败：{err}");
            }
        }
    }

    fn reset_conversation(&mut self, notice: &str) {
        self.conversation_id = None;
        self.workspace = self.launch_workspace.clone();
        self.messages.clear();
        self.older = None;
        self.context_percent = None;
        self.goal_plans.clear();
        self.selected_goal_plan_id = None;
        self.interrupted_preview.clear();
        self.anchor.jump_to_latest();
        self.composer.accepted();
        self.status = notice.to_owned();
    }

    fn start_compaction(&mut self) {
        if self.is_busy() {
            self.status = "当前回合进行中，无法压缩上下文。".to_owned();
            return;
        }
        let Some(conv_id) = self.conversation_id.clone() else {
            self.status = "当前尚无已保存会话可压缩。".to_owned();
            return;
        };
        if self.messages.len() < 2 {
            self.status = "当前对话轮次较少，暂无需压缩上下文。".to_owned();
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
                self.status = format!("模型未就绪（{}），无法压缩上下文。", err.detail);
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
        self.compacting = Some(ActiveCompaction { cancel, task });
        self.status = COMPACTING_STATUS.to_owned();
    }

    fn draw(&mut self, terminal: &mut TerminalGuard) -> io::Result<()> {
        let live_buf = self
            .active
            .as_ref()
            .map(|a| a.display.borrow().live.clone())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| self.interrupted_preview.clone());
        let title = match &self.conversation_id {
            Some(id) => format!("Peer · 对话  {}", terminal_text(id)),
            None => "Peer · 对话".to_owned(),
        };
        let workspace_label = self
            .workspace
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_owned();
        let model_badge = self.model_badge();
        let mode_badge = self.mode.as_str();
        let access_badge = self.access_badge();
        let goal_status = self.goal_menu_status();
        let goal_banner = self.goal_banner();
        let is_running = self.is_busy();
        let palette = self.prefs.palette();
        let scheme_id = self.prefs.scheme.cache_id();
        let current_theme = self.prefs.mode;
        let locale = self.prefs.locale;
        let status = if self.approval.is_some() {
            APPROVAL_STATUS.to_owned()
        } else if self.compacting.is_some() {
            COMPACTING_STATUS.to_owned()
        } else if self.active.is_some() {
            ACTIVE_STATUS.to_owned()
        } else if let Some(s) = self.composer.status {
            s.to_owned()
        } else {
            self.status.clone()
        };
        let approval_view = self.approval.as_ref().map(|a| (a.text.as_str(), a.scroll));
        let mut shown_size = None;
        terminal.draw_frame(|frame| {
            shown_size = Some((frame.area().width, frame.area().height));
            render_classic(
                frame,
                ClassicView {
                    title: &title,
                    workspace_label: &workspace_label,
                    model_badge: &model_badge,
                    mode_badge,
                    access_badge,
                    context_percent: self.context_percent,
                    fast_mode: self.fast_mode,
                    fast_available: self.fast_available,
                    goal_status,
                    goal_banner: goal_banner.as_deref(),
                    is_running,
                    palette,
                    scheme_id,
                    current_theme,
                    locale,
                    messages: &self.messages,
                    live_stream: &live_buf,
                    anchor: &self.anchor,
                    composer: &self.composer,
                    status: &status,
                    approval: approval_view,
                    model_picker: &self.model_picker,
                    overlay: &self.overlay,
                    slash_selected: self.slash_selected,
                    wrap_cache: &mut self.wrap_cache,
                },
            );
        })?;
        if let (Some(approval), Some(size)) = (self.approval.as_mut(), shown_size) {
            approval.shown_at = Some(size);
        }
        Ok(())
    }

    fn submit_prompt(&mut self, prompt: String) {
        if self.is_busy() {
            self.status = "当前回合进行中，请等待完成或按 Ctrl-C 停止本轮。".to_owned();
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
                self.status = format!(
                    "模型未就绪（{}），原草稿已保留。输入 `/model` 选择模型。",
                    err.detail
                );
                return;
            }
        };
        self.selected_provider = Some(selected.entry.provider_id.clone());
        self.selected_model = Some(selected.entry.model_id.clone());
        self.selected_display_name = Some(selected.entry.display_name.clone());
        self.interrupted_preview.clear();
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
                .execute_observed(
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
        });
        self.status = ACTIVE_STATUS.to_owned();
    }

    async fn poll_active(&mut self) -> bool {
        let mut dirty = false;
        let mut finished = None;
        let mut need_reload = false;
        if let Some(active) = self.active.as_mut() {
            let (accepted, revision, notice, conv_id, has_live) = {
                let d = active.display.borrow();
                (
                    d.accepted,
                    d.revision,
                    d.notice,
                    d.conversation_id.clone(),
                    !d.live.is_empty(),
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
            if let Some(n) = notice {
                self.status = n.to_owned();
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
                    self.status = IDLE_STATUS.to_owned();
                }
                Ok(Err("CANCELLED")) => {
                    if !live_tail.is_empty() {
                        self.interrupted_preview =
                            format!("{live_tail}\n［本轮已停止，内容不完整］");
                    }
                    self.reload_transcript(None);
                    self.refresh_context_percent();
                    self.refresh_goal_plans();
                    self.status = "本轮已停止，可继续输入下一条消息。".to_owned();
                }
                Ok(Err("conversation_execution_busy")) => {
                    self.reload_transcript(None);
                    let cid = self.conversation_id.as_deref().unwrap_or("");
                    self.status = format!(
                        "会话仍在执行或有结果待核对（conversation_execution_busy） · peer recover --session {cid}"
                    );
                }
                Ok(Err(code)) => {
                    self.reload_transcript(None);
                    self.status = format!("执行未完成（{code}）；原草稿或历史已保留。");
                }
                Err(_) => {
                    self.status = "内部执行任务异常结束。".to_owned();
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
                    self.status = format!(
                        "已完成上下文压缩（{} · 原 {} 条消息）。",
                        outcome.method, outcome.original_message_count
                    );
                }
                Ok(Err("CANCELLED")) => {
                    self.status = "已取消上下文压缩。".to_owned();
                }
                Ok(Err("native_context_pressure")) => {
                    self.status = "当前对话轮次较少，暂无需压缩上下文。".to_owned();
                }
                Ok(Err(code)) => {
                    self.status = format!("上下文压缩未完成（{code}）。");
                }
                Err(_) => {
                    self.status = "上下文压缩任务异常结束。".to_owned();
                }
            }
            dirty = true;
        }
        if self.approval.as_ref().is_some_and(Approval::expired) {
            self.approval = None;
            dirty = true;
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
        match key.code {
            KeyCode::Up => {
                approval.scroll = approval.scroll.saturating_sub(1);
                true
            }
            KeyCode::Down => {
                approval.scroll = approval.scroll.saturating_add(1);
                true
            }
            KeyCode::Char('y') | KeyCode::Char('Y')
                if key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT =>
            {
                if terminal_size.0 < 30 || terminal_size.1 < 10 {
                    self.status =
                        "终端视口过小，无法完整核验授权详情，请调大窗口或按 n 拒绝。".to_owned();
                    return true;
                }
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::Approve);
                }
                true
            }
            KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc => {
                if let Some(a) = self.approval.take() {
                    let _ = a.reply.send(LocalPermissionDecision::Deny);
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
                    None => self.status = "主题仅支持 dark / light / system。".to_owned(),
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
                    None => self.status = "语言仅支持 zh-CN / en-US。".to_owned(),
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
                                self.status = IDLE_STATUS.to_owned();
                            }
                        } else {
                            self.status = "已在最新位置。".to_owned();
                        }
                    }
                    HistoryDirection::Latest => {
                        self.anchor.jump_to_latest();
                        self.status = "已回到最新对话。".to_owned();
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
                if let Some(active) = self.active.as_ref()
                    && self.mode == RuntimeMode::Goal
                {
                    active.cancel.cancel();
                    self.status = "正在安全边界停止当前目标回合…".to_owned();
                } else {
                    self.status = "当前无运行中的目标执行回合。".to_owned();
                }
                None
            }
            ClassicCommand::GoalResume => {
                self.composer.accepted();
                if self.goal_menu_status() == GoalMenuStatus::Paused {
                    self.mode = RuntimeMode::Goal;
                    self.submit_prompt("继续推进当前未完成的目标。".to_owned());
                } else {
                    self.status = "当前无已暂停的目标可继续。".to_owned();
                }
                None
            }
            ClassicCommand::GoalCancel => {
                self.composer.accepted();
                if let Some(active) = self.active.as_ref() {
                    active.cancel.cancel();
                    self.status = "正在取消当前目标执行…".to_owned();
                } else {
                    self.status = "当前无活跃运行中的目标。".to_owned();
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
                self.status = "未知命令，输入 `/help` 查看支持命令。".to_owned();
                None
            }
        }
    }

    pub(super) async fn run(
        mut self,
        terminal: &mut TerminalGuard,
        shutdown: &CancellationToken,
    ) -> io::Result<ShellOutcome> {
        self.draw(terminal)?;
        loop {
            if shutdown.is_cancelled() {
                if let Some(active) = self.active.take() {
                    active.cancel.cancel();
                    let _ = active.task.await;
                }
                if let Some(comp) = self.compacting.take() {
                    comp.cancel.cancel();
                    let _ = comp.task.await;
                }
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
                                return Ok(ShellOutcome::SwitchToBots);
                            }
                        } else if key.code == KeyCode::F(3) {
                            self.open_model_picker();
                            dirty = true;
                        } else if key.code == KeyCode::Char('d')
                            && key.modifiers.contains(KeyModifiers::CONTROL)
                            && self.composer.draft().is_empty()
                        {
                            if let Some(active) = self.active.take() {
                                active.cancel.cancel();
                                let _ = active.task.await;
                            }
                            if let Some(comp) = self.compacting.take() {
                                comp.cancel.cancel();
                                let _ = comp.task.await;
                            }
                            return Ok(ShellOutcome::Quit);
                        } else {
                            match self.leader.resolve(key) {
                                LeaderAction::Armed => {
                                    self.status = "Ctrl+X · M 模型 · O 模式 · P 权限 · N 新建 · L 恢复 · 1/2/3 模式".to_owned();
                                    dirty = true;
                                }
                                LeaderAction::Consumed => {}
                                LeaderAction::Cancelled => {
                                    self.status = IDLE_STATUS.to_owned();
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
                                                    if let Some(active) = self.active.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    if let Some(comp) = self.compacting.take() {
                                                        comp.cancel.cancel();
                                                        let _ = comp.task.await;
                                                    }
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            _ => {}
                                        }
                                    } else if key.code == KeyCode::Esc
                                        && !self.anchor.is_following()
                                    {
                                        self.anchor.jump_to_latest();
                                        self.status = "已回到最新对话。".to_owned();
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
                                        if let Some(active) = self.active.as_ref() {
                                            active.cancel.cancel();
                                            self.status = "正在停止本轮…".to_owned();
                                        }
                                        if let Some(comp) = self.compacting.as_ref() {
                                            comp.cancel.cancel();
                                            self.status = "正在取消压缩…".to_owned();
                                        }
                                        dirty = true;
                                    } else if let Some(action) = action_for_event(Event::Key(key)) {
                                        match action {
                                            Action::Submit => {
                                                let text = self.composer.draft().to_owned();
                                                if let Some(outcome) = self.handle_command(&text) {
                                                    if let Some(active) = self.active.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    if let Some(comp) = self.compacting.take() {
                                                        comp.cancel.cancel();
                                                        let _ = comp.task.await;
                                                    }
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            other => match self.composer.apply(other) {
                                                Effect::Quit => {
                                                    if let Some(active) = self.active.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    if let Some(comp) = self.compacting.take() {
                                                        comp.cancel.cancel();
                                                        let _ = comp.task.await;
                                                    }
                                                    return Ok(ShellOutcome::Quit);
                                                }
                                                Effect::Redraw => {
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

fn format_transcript_row(row: TranscriptRow, idx: usize) -> (String, String, String) {
    let TranscriptRow::Message { raw, .. } = row else {
        return (
            format!("corrupt-{idx}"),
            "system".into(),
            "历史中有一条无法读取的记录。".into(),
        );
    };
    let val = &raw;
    let id = val["id"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| format!("row-{idx}"));
    let role = val["role"].as_str().unwrap_or("assistant").to_owned();
    let content = val["content"]
        .as_str()
        .map(|s| bounded_text(s, 16 * 1024))
        .unwrap_or_default();
    if !content.is_empty() {
        return (id, role, content);
    }
    if let Some(segments) = val["segments"].as_array() {
        let mut parts = Vec::new();
        for seg in segments {
            match seg["type"].as_str() {
                Some("tool-call") => {
                    let tool = seg["tool"].as_str().unwrap_or("tool");
                    parts.push(format!("[工具调用] {tool}"));
                }
                Some("tool-result") => {
                    let status = seg["status"].as_str().unwrap_or("done");
                    parts.push(format!("[工具结果] {status}"));
                }
                _ => {}
            }
        }
        if !parts.is_empty() {
            return (id, "tool".to_owned(), parts.join(" · "));
        }
    }
    (id, role, String::new())
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
