//! Full native `--classic` interactive chat shell (ADR 80, ADR 129, ADR 130, ADR 131).
//!
//! Runs new or ongoing conversations directly on `NativeConversationRuntime` with
//! bounded Markdown/code/diff virtualization, reading-anchor protection, separated
//! permission/display channels, unified ModelPicker (`F3` or `/model`), and clean
//! Ctrl-C cancellation + continuation. Zero files are created until the first prompt is sent.

use super::{
    ShellOutcome, TerminalGuard,
    model_picker_adapter::load_picker_groups,
    resumed::ports::{Approval, Display, OutputPort, PermissionPort, bounded_text},
    theme_store::{self, TerminalPreferences},
};
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use peer_protocol::{LocalAccessLevel, TranscriptCursor, TranscriptRow};
use peer_runtime::{
    CancellationToken,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model_catalog::resolve_exec,
    providers::RuntimeMode,
    session_host::LocalPermissionDecision,
};
use peer_store::{TranscriptLimits, TranscriptReader};
use peer_tui::{
    Action, ByteBudgetLru, CLASSIC_SLASH_ITEMS, ClassicCommand, ClassicMessage, ClassicView,
    Composer, Effect, MARKDOWN_WRAP_CACHE_BYTES, ModelPickerEvent, ModelPickerState, ReadingAnchor,
    RenderedBlock, ThemeMode, TuiLocale, WrapCacheKey, action_for_event, filter_slash_items,
    parse_classic_command, render_classic, terminal_text,
};
use std::{io, path::PathBuf, rc::Rc, time::Duration};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, LocalSet},
};

const MAX_DISPLAY_MESSAGES: usize = 64;
const IDLE_STATUS: &str = "Enter 发送 · /model 选模型 · /bots 机器人 · /help 帮助 · Ctrl-C 退出";
const ACTIVE_STATUS: &str = "本轮进行中 · ↑/↓ 阅读 · End/PgDn 最新 · Ctrl-C 停止本轮";
const APPROVAL_STATUS: &str = "y 仅允许本次 · n / Esc 拒绝 · ↑/↓ 滚动 · Ctrl-C 停止本轮";

struct ActiveTurn {
    cancel: CancellationToken,
    task: JoinHandle<Result<String, &'static str>>,
    display: watch::Receiver<Display>,
    prompts: mpsc::Receiver<Approval>,
    accepted: bool,
    revision: usize,
}

pub(super) struct ClassicSession<'a> {
    home: PathBuf,
    workspace: PathBuf,
    prefs: &'a mut TerminalPreferences,
    conversation_id: Option<String>,
    runtime: Rc<NativeConversationRuntime>,
    access: ConversationAccess,
    access_level: LocalAccessLevel,
    mode: RuntimeMode,
    selected_provider: Option<String>,
    selected_model: Option<String>,
    selected_effort: Option<String>,
    composer: Composer,
    messages: Vec<ClassicMessage>,
    older: Option<TranscriptCursor>,
    anchor: ReadingAnchor,
    status: String,
    interrupted_preview: String,
    active: Option<ActiveTurn>,
    approval: Option<Approval>,
    model_picker: ModelPickerState,
    slash_selected: usize,
    wrap_cache: ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

impl<'a> ClassicSession<'a> {
    fn new(home: PathBuf, workspace: PathBuf, prefs: &'a mut TerminalPreferences) -> Self {
        let access = ConversationAccess::new(LocalAccessLevel::AskBeforeLocal);
        let runtime = Rc::new(NativeConversationRuntime::new(&home, access.clone()));
        let mut selected_provider = None;
        let mut selected_model = None;
        let mut selected_effort = None;
        if let Ok(resolved) = resolve_exec(&home, None, None, None, false) {
            selected_provider = Some(resolved.entry.provider_id);
            selected_model = Some(resolved.entry.model_id);
            selected_effort = resolved.selection["reasoningEffort"]
                .as_str()
                .map(str::to_owned);
        }
        Self {
            home,
            workspace,
            prefs,
            conversation_id: None,
            runtime,
            access,
            access_level: LocalAccessLevel::AskBeforeLocal,
            mode: RuntimeMode::Chat,
            selected_provider,
            selected_model,
            selected_effort,
            composer: Composer::default(),
            messages: Vec::new(),
            older: None,
            anchor: ReadingAnchor::FollowingLatest,
            status: IDLE_STATUS.to_owned(),
            interrupted_preview: String::new(),
            active: None,
            approval: None,
            model_picker: ModelPickerState::default(),
            slash_selected: 0,
            wrap_cache: ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 512),
        }
    }

    fn model_badge(&self) -> String {
        match (&self.selected_provider, &self.selected_model) {
            (Some(p), Some(m)) => format!("{p}::{m}"),
            (_, Some(m)) => m.clone(),
            _ => "未配置模型".to_owned(),
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
        let is_running = self.active.is_some();
        let palette = self.prefs.palette();
        let scheme_id = self.prefs.scheme.cache_id();
        let locale = self.prefs.locale;
        let status = if self.approval.is_some() {
            APPROVAL_STATUS.to_owned()
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
                    context_percent: None,
                    is_running,
                    palette,
                    scheme_id,
                    locale,
                    messages: &self.messages,
                    live_stream: &live_buf,
                    anchor: &self.anchor,
                    composer: &self.composer,
                    status: &status,
                    approval: approval_view,
                    model_picker: &self.model_picker,
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
        if self.active.is_some() {
            self.status = "当前回合进行中，请等待完成或按 Ctrl-C 停止本轮。".to_owned();
            return;
        }
        let selected = match resolve_exec(
            &self.home,
            self.selected_provider.as_deref(),
            self.selected_model.as_deref(),
            self.selected_effort.as_deref(),
            false,
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
                        resume_from: None,
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
                    self.status = IDLE_STATUS.to_owned();
                }
                Ok(Err("CANCELLED")) => {
                    if !live_tail.is_empty() {
                        self.interrupted_preview =
                            format!("{live_tail}\n［本轮已停止，内容不完整］");
                    }
                    self.reload_transcript(None);
                    self.status = "本轮已停止，可继续输入下一条消息。".to_owned();
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
                // Small-viewport guard: refuse approving if terminal is too small to inspect details.
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
                if self.active.is_some() {
                    self.status = "本轮进行中，请先停止再新建会话。".to_owned();
                    return None;
                }
                self.conversation_id = None;
                self.messages.clear();
                self.older = None;
                self.interrupted_preview.clear();
                self.anchor.jump_to_latest();
                self.composer.accepted();
                self.status = "已开始新会话。".to_owned();
                None
            }
            ClassicCommand::Model => {
                self.composer.accepted();
                self.open_model_picker();
                None
            }
            ClassicCommand::Mode(m) => {
                if let Ok(parsed) = m.parse::<RuntimeMode>() {
                    self.mode = parsed;
                    self.status = format!("运行模式已切换为 {m}。");
                }
                self.composer.accepted();
                None
            }
            ClassicCommand::Access(a) => {
                let next = match a.as_str() {
                    "full" => LocalAccessLevel::FullLocal,
                    "session" => LocalAccessLevel::SessionLocal,
                    _ => LocalAccessLevel::AskBeforeLocal,
                };
                if self.access.set(next).is_ok() {
                    self.access_level = next;
                    self.status = format!("本地访问级别已切换为 {a}。");
                }
                self.composer.accepted();
                None
            }
            ClassicCommand::Theme(arg) => {
                let next_mode = match arg {
                    Some(raw) => match ThemeMode::parse(&raw) {
                        Some(m) => m,
                        None => {
                            self.status = "主题仅支持 dark / light / system。".to_owned();
                            return None;
                        }
                    },
                    None => match self.prefs.mode {
                        ThemeMode::Dark => ThemeMode::Light,
                        ThemeMode::Light => ThemeMode::System,
                        ThemeMode::System => ThemeMode::Dark,
                    },
                };
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
                self.composer.accepted();
                None
            }
            ClassicCommand::Language(arg) => {
                let next_locale = match arg {
                    Some(raw) => match TuiLocale::parse(&raw) {
                        Some(l) => l,
                        None => {
                            self.status = "语言仅支持 zh-CN / en-US。".to_owned();
                            return None;
                        }
                    },
                    None => match self.prefs.locale {
                        TuiLocale::ZhCn => TuiLocale::EnUs,
                        TuiLocale::EnUs => TuiLocale::ZhCn,
                    },
                };
                match theme_store::save_locale(&self.home, next_locale) {
                    Ok(()) => {
                        self.prefs.locale = next_locale;
                        self.status = format!("界面语言已切换为 {}。", next_locale.as_str());
                    }
                    Err(err) => {
                        self.status = format!("保存语言失败：{err}");
                    }
                }
                self.composer.accepted();
                None
            }
            ClassicCommand::Older => {
                self.composer.accepted();
                if let Some(cursor) = self.older.clone() {
                    self.reload_transcript(Some(cursor));
                    self.anchor.scroll_up(12, 1000, None);
                } else {
                    self.status = "已到最早历史。".to_owned();
                }
                None
            }
            ClassicCommand::Latest => {
                self.composer.accepted();
                self.anchor.jump_to_latest();
                self.status = IDLE_STATUS.to_owned();
                None
            }
            ClassicCommand::Help => {
                self.composer.accepted();
                self.status = "/model 选模型 · /mode chat|plan|goal · /access ask|session|full · /bots 切机器人 · /new 新会话 · /quit 退出".to_owned();
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
                return Ok(ShellOutcome::Quit);
            }

            let mut dirty = self.poll_active().await;

            // Crossterm's Unix TTY source needs a positive poll budget to read the fd.
            let poll_ms = if self.active.is_some() { 2 } else { 25 };
            if event::poll(Duration::from_millis(poll_ms))? {
                match event::read()? {
                    Event::Resize(_, _) => {
                        dirty = true;
                    }
                    Event::Paste(pasted) => {
                        // Paste NEVER triggers approval or model submit!
                        if self.approval.is_none() && !self.model_picker.open {
                            self.composer.apply(Action::Insert(pasted));
                            dirty = true;
                        }
                    }
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        let size = crossterm::terminal::size().unwrap_or((80, 24));
                        if self.model_picker.open {
                            match self.model_picker.handle_key(key) {
                                ModelPickerEvent::None => {}
                                ModelPickerEvent::Close => {}
                                ModelPickerEvent::Select {
                                    provider_id,
                                    model_id,
                                    effort,
                                } => {
                                    self.selected_provider = Some(provider_id);
                                    self.selected_model = Some(model_id);
                                    self.selected_effort = effort;
                                    self.model_picker.close();
                                    self.status =
                                        format!("当前模型已切换为 {}。", self.model_badge());
                                }
                            }
                            dirty = true;
                        } else if self.approval.is_some() {
                            if self.handle_approval_key(key, size) {
                                dirty = true;
                            }
                        } else if key.code == KeyCode::F(2) {
                            if self.active.is_none() {
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
                            return Ok(ShellOutcome::Quit);
                        } else if key.code == KeyCode::Up
                            && !filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS)
                                .is_empty()
                        {
                            let len =
                                filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS)
                                    .len();
                            self.slash_selected = if self.slash_selected == 0 {
                                len.saturating_sub(1)
                            } else {
                                self.slash_selected - 1
                            };
                            dirty = true;
                        } else if key.code == KeyCode::Down
                            && !filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS)
                                .is_empty()
                        {
                            let len =
                                filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS)
                                    .len();
                            self.slash_selected = (self.slash_selected + 1) % len;
                            dirty = true;
                        } else if key.code == KeyCode::Tab
                            && !filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS)
                                .is_empty()
                        {
                            let completed = {
                                let items =
                                    filter_slash_items(self.composer.draft(), CLASSIC_SLASH_ITEMS);
                                items[self.slash_selected.min(items.len() - 1)]
                                    .command
                                    .to_owned()
                            };
                            self.composer.accepted();
                            self.composer.apply(Action::Insert(completed));
                            self.slash_selected = 0;
                            dirty = true;
                        } else if key.code == KeyCode::Up && self.composer.draft().is_empty() {
                            self.anchor.scroll_up(3, 10_000, None);
                            dirty = true;
                        } else if key.code == KeyCode::Down && self.composer.draft().is_empty() {
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
                        } else if key.code == KeyCode::End && self.composer.draft().is_empty() {
                            self.anchor.jump_to_latest();
                            dirty = true;
                        } else if key.code == KeyCode::Char('c')
                            && key.modifiers.contains(KeyModifiers::CONTROL)
                            && let Some(active) = self.active.as_ref()
                        {
                            active.cancel.cancel();
                            self.status = "正在停止本轮…".to_owned();
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
                    _ => {}
                }
            }

            if dirty {
                self.draw(terminal)?;
                tokio::task::yield_now().await;
            } else if self.active.is_some() {
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
