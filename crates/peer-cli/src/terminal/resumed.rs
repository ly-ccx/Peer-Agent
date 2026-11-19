use super::TerminalGuard;
use crossterm::event::{self, Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use peer_protocol::{CliExit, LocalAccessLevel, TranscriptCursor, TranscriptRow};
use peer_runtime::{
    CancellationToken,
    capability::CapabilityError,
    conversation_host::{ConversationAccess, ConversationOptions, NativeConversationRuntime},
    model_catalog::{resolve_exact_session_model, resolve_exec},
    providers::RuntimeMode,
    session_host::LocalPermissionDecision,
};
use peer_store::{
    ConversationStore, StoreError, TranscriptError, TranscriptLimits, TranscriptReader,
};
use peer_tui::{Action, Composer, Effect, ResumeView, action_for_event, terminal_text};
use std::{
    io,
    path::{Path, PathBuf},
    rc::Rc,
    time::Duration,
};
use tokio::{
    sync::{mpsc, watch},
    task::{JoinHandle, LocalSet},
};

pub(super) mod ports;
use ports::{Approval, Display, OutputPort, PermissionPort, bounded_text};

const CONTROLS: &str = "Enter 发送 · ↑/↓ 阅读 · PgUp 更早 · PgDn 最新 · Ctrl-C 退出";
const ACTIVE_CONTROLS: &str = "本轮进行中 · ↑/↓ 阅读 · PgUp 更早 · PgDn 最新 · Ctrl-C 停止本轮";
const APPROVAL_CONTROLS: &str = "y 仅允许本次 · n / Esc 拒绝本次 · ↑/↓ 查看详情 · Ctrl-C 停止本轮";

pub(crate) fn resume(home: PathBuf, id: String) -> io::Result<CliExit> {
    crate::cancellation::run(|shutdown| async move {
        let runtime = Rc::new(NativeConversationRuntime::new(
            &home,
            ConversationAccess::new(LocalAccessLevel::AskBeforeLocal),
        ));
        let mut session = Session::open(home, id, runtime)?;
        let mut terminal = TerminalGuard::enter()?;
        let result = LocalSet::new()
            .run_until(async {
                let result = session.run(&mut terminal, &shutdown).await;
                if let Some(active) = session.active.take() {
                    active.cancel.cancel();
                    let _ = active.task.await;
                }
                result
            })
            .await;
        result?;
        Ok(if shutdown.is_cancelled() {
            CliExit::Cancelled
        } else {
            CliExit::Ok
        })
    })?
}

struct Active {
    cancel: CancellationToken,
    task: JoinHandle<Result<(), &'static str>>,
    display: watch::Receiver<Display>,
    prompts: mpsc::Receiver<Approval>,
    accepted: bool,
    revision: usize,
}

struct Session {
    home: PathBuf,
    id: String,
    title: String,
    runtime: Rc<NativeConversationRuntime>,
    composer: Composer,
    lines: Vec<String>,
    older: Option<TranscriptCursor>,
    following: bool,
    back: usize,
    status: String,
    interrupted_preview: String,
    active: Option<Active>,
    approval: Option<Approval>,
}

impl Session {
    fn open(home: PathBuf, id: String, runtime: Rc<NativeConversationRuntime>) -> io::Result<Self> {
        let metadata = ConversationStore::new(&home)
            .read_metadata(&id)
            .map_err(io::Error::other)?
            .metadata
            .ok_or_else(|| io::Error::other(StoreError::NotFound))?;
        let title = bounded_text(metadata["title"].as_str().unwrap_or("会话"), 320)
            .replace(['\t', '\n'], " ");
        let title = format!("{title}   {}", terminal_text(&id));
        let mut session = Self {
            home,
            id,
            title,
            runtime,
            composer: Composer::default(),
            lines: Vec::new(),
            older: None,
            following: true,
            back: 0,
            status: String::new(),
            interrupted_preview: String::new(),
            active: None,
            approval: None,
        };
        session.read_page(None);
        Ok(session)
    }

    fn read_page(&mut self, cursor: Option<TranscriptCursor>) -> bool {
        let limits = TranscriptLimits {
            records: 16,
            ..TranscriptLimits::default()
        };
        match TranscriptReader::new(&self.home).read_page(&self.id, cursor.as_ref(), limits, None) {
            Ok(page) => {
                self.lines = page.rows.into_iter().map(history_line).collect();
                self.older = page.older;
                true
            }
            Err(TranscriptError::Store(StoreError::NotFound))
                if cursor.is_none() && self.lines.is_empty() =>
            {
                true
            }
            Err(error) => {
                self.status = format!("读取历史受阻（{error}） · PgDn 重读最新");
                false
            }
        }
    }

    async fn run(
        &mut self,
        terminal: &mut TerminalGuard,
        shutdown: &CancellationToken,
    ) -> io::Result<()> {
        self.draw(terminal)?;
        while !shutdown.is_cancelled() {
            // Crossterm's Unix TTY source needs a positive poll budget to read
            // the fd. A zero budget checks only its already queued events.
            let poll_ms = if self.active.is_some() { 2 } else { 25 };
            let input_ready = event::poll(Duration::from_millis(poll_ms))?;
            if self.observe_turn(input_ready).await {
                self.draw(terminal)?;
            }
            // Handle at most one event before yielding to the live Runtime.
            if input_ready {
                match self.input(event::read()?, shutdown) {
                    Effect::Quit => break,
                    Effect::Redraw => self.draw(terminal)?,
                    Effect::None => {}
                }
                tokio::task::yield_now().await;
            } else if self.active.is_some() {
                tokio::select! {
                    _ = shutdown.cancelled() => break,
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                }
            } else {
                tokio::task::yield_now().await;
            }
        }
        Ok(())
    }

    fn draw(&mut self, terminal: &mut TerminalGuard) -> io::Result<()> {
        let active = self.active.as_ref().map(|active| active.display.borrow());
        let live = if self.following {
            active
                .as_ref()
                .map_or(self.interrupted_preview.as_str(), |display| {
                    display.live.as_str()
                })
        } else {
            ""
        };
        let mut shown_at = None;
        terminal.draw_frame(|frame| {
            let (status, approval) = if let Some(approval) = &self.approval {
                let area = frame.area();
                if area.width >= 28 && area.height >= 12 {
                    shown_at = Some((area.width, area.height));
                    (
                        APPROVAL_CONTROLS,
                        Some((approval.text.as_str(), approval.scroll)),
                    )
                } else {
                    ("窗口过小 · 放大后查看权限 · n 拒绝本次", Some(("", 0)))
                }
            } else {
                let status = self.composer.status.unwrap_or_else(|| {
                    if !self.status.is_empty() {
                        &self.status
                    } else if self.active.is_some() {
                        ACTIVE_CONTROLS
                    } else {
                        CONTROLS
                    }
                });
                (status, None)
            };
            peer_tui::render_resume(
                frame,
                ResumeView {
                    title: &self.title,
                    lines: &self.lines,
                    live,
                    back: self.back,
                    composer: &self.composer,
                    status,
                    approval,
                },
            );
        })?;
        if let Some(approval) = &mut self.approval {
            approval.shown_at = shown_at;
        }
        Ok(())
    }

    async fn observe_turn(&mut self, input_ready: bool) -> bool {
        let Some(active) = self.active.as_mut() else {
            return false;
        };
        let mut redraw = active.display.has_changed().unwrap_or(false);
        let (changed_history, display_notice) = if redraw {
            let display = active.display.borrow_and_update();
            if display.accepted && !active.accepted {
                self.composer.accepted();
                active.accepted = true;
            }
            let changed = active.revision != display.revision;
            active.revision = display.revision;
            (changed, display.notice)
        } else {
            (false, None)
        };
        if self.approval.as_ref().is_some_and(Approval::expired) {
            self.approval = None;
            redraw = true;
        }
        // A decision can only use a key after this request has been presented.
        // Buffered terminal input still belongs to the previous UI state.
        if self.approval.is_none()
            && !input_ready
            && let Ok(approval) = active.prompts.try_recv()
            && !approval.expired()
        {
            self.approval = Some(approval);
            redraw = true;
        }
        if let Some(notice) = display_notice {
            self.status = notice.into();
        }
        if active.task.is_finished() {
            let active = self.active.take().expect("observed active turn");
            // A final receipt can arrive between the initial change check and is_finished.
            if active.display.borrow().accepted && !active.accepted {
                self.composer.accepted();
            }
            self.approval = None;
            let outcome = active
                .task
                .await
                .unwrap_or(Err("conversation_task_interrupted"));
            if outcome.is_err() {
                let display = active.display.borrow();
                if !display.live.is_empty() {
                    self.interrupted_preview = format!("{}  ［未完成］", display.live);
                }
            }
            self.status = turn_status(outcome, &self.id);
            if self.following {
                self.read_page(None);
            }
            return true;
        }
        if changed_history && self.following {
            self.read_page(None);
        }
        redraw
    }

    fn input(&mut self, event: Event, shutdown: &CancellationToken) -> Effect {
        if let Event::Key(key) = event {
            if key.kind == KeyEventKind::Release {
                return Effect::None;
            }
            if key.modifiers.contains(KeyModifiers::CONTROL)
                && key.code == KeyCode::Char('c')
                && let Some(active) = &self.active
            {
                active.cancel.cancel();
                self.approval = None;
                self.status = "正在停止本轮，等待本地执行停稳。".into();
                return Effect::Redraw;
            }
            if self.approval.is_some() {
                self.approval_input(key);
                return Effect::Redraw;
            }
            match key.code {
                KeyCode::Up => {
                    self.following = false;
                    self.back = self.back.saturating_add(1).min(32_768);
                    self.status = "正在阅读历史 · PgDn 回到最新".into();
                    return Effect::Redraw;
                }
                KeyCode::Down => {
                    self.back = self.back.saturating_sub(1);
                    return Effect::Redraw;
                }
                KeyCode::PageUp => {
                    if let Some(older) = self.older.clone()
                        && self.read_page(Some(older))
                    {
                        self.following = false;
                        self.back = 0;
                        self.status = "正在阅读历史 · PgUp 更早 · PgDn 回到最新".into();
                    }
                    return Effect::Redraw;
                }
                KeyCode::PageDown => {
                    if self.read_page(None) {
                        self.following = true;
                        self.back = 0;
                        self.status.clear();
                    }
                    return Effect::Redraw;
                }
                // Ctrl-D only exits the idle editor. During execution it is a no-op.
                KeyCode::Char('d')
                    if self.active.is_some() && key.modifiers.contains(KeyModifiers::CONTROL) =>
                {
                    return Effect::None;
                }
                _ => {}
            }
        } else if self.approval.is_some() && matches!(event, Event::Paste(_)) {
            return Effect::None;
        }
        let Some(action) = action_for_event(event) else {
            return Effect::None;
        };
        if action == Action::Submit {
            if self.active.is_none() {
                self.submit(shutdown);
            }
            return Effect::Redraw;
        }
        if self.active.as_ref().is_some_and(|active| !active.accepted) {
            return Effect::None;
        }
        self.composer.apply(action)
    }

    fn approval_input(&mut self, key: KeyEvent) {
        let Some(approval) = self.approval.as_mut() else {
            return;
        };
        if key.modifiers != KeyModifiers::NONE {
            return;
        }
        match key.code {
            KeyCode::Up => approval.scroll = approval.scroll.saturating_sub(1),
            KeyCode::Down => approval.scroll = approval.scroll.saturating_add(1).min(8192),
            KeyCode::PageUp => approval.scroll = approval.scroll.saturating_sub(10),
            KeyCode::PageDown => approval.scroll = approval.scroll.saturating_add(10).min(8192),
            KeyCode::Char('y' | 'n') | KeyCode::Esc if key.kind == KeyEventKind::Press => {
                if key.code == KeyCode::Char('y')
                    && (approval.shown_at.is_none()
                        || crossterm::terminal::size().ok() != approval.shown_at)
                {
                    return;
                }
                let approval = self.approval.take().expect("observed approval");
                let decision = if key.code == KeyCode::Char('y') {
                    LocalPermissionDecision::Approve
                } else {
                    LocalPermissionDecision::Deny
                };
                self.status = if approval.reply.send(decision).is_ok() {
                    ACTIVE_CONTROLS.into()
                } else {
                    "本次授权请求已失效。".into()
                };
            }
            _ => {}
        }
    }

    fn submit(&mut self, shutdown: &CancellationToken) {
        if peer_protocol::javascript_trim(self.composer.draft()).is_empty() {
            return;
        }
        self.composer.apply(Action::Escape);
        self.interrupted_preview.clear();
        self.status = "正在提交，原草稿保留至会话确认接收。 · Ctrl-C 停止本轮".into();
        let home = self.home.clone();
        let id = self.id.clone();
        let runtime = self.runtime.clone();
        let prompt = self.composer.draft().to_owned();
        let cancel = shutdown.child_token();
        let turn_cancel = cancel.clone();
        let (output, display) = watch::channel(Display::default());
        let (permission, prompts) = mpsc::channel(1);
        let task = tokio::task::spawn_local(async move {
            let mut output = OutputPort(output);
            let mut permission = PermissionPort {
                requests: permission,
                display: output.0.clone(),
            };
            execute(
                &home,
                &id,
                &runtime,
                &prompt,
                &mut output,
                &mut permission,
                &turn_cancel,
            )
            .await
        });
        self.active = Some(Active {
            cancel,
            task,
            display,
            prompts,
            accepted: false,
            revision: 0,
        });
    }
}

fn turn_status(outcome: Result<(), &'static str>, id: &str) -> String {
    match outcome {
        Ok(()) => CONTROLS.into(),
        Err("CANCELLED") => "本轮已停止 · Enter 发送 · PgDn 最新".into(),
        Err("conversation_execution_busy") => {
            format!(
                "会话仍在执行或有结果待核对（conversation_execution_busy） · peer recover --session {id}"
            )
        }
        Err("conversation_execution_changed") => {
            "本轮未提交，会话执行记录已更新（conversation_execution_changed） · PgDn 刷新后再发送"
                .into()
        }
        Err("conversation_execution_unrecorded") => {
            "旧会话缺少执行记录（conversation_execution_unrecorded） · 请在原宿主确认停稳".into()
        }
        Err(code) => format!("本轮未完成（{code}） · PgDn 最新"),
    }
}

fn history_line(row: TranscriptRow) -> String {
    let TranscriptRow::Message { raw, .. } = row else {
        return "历史中有一条无法读取的记录。".into();
    };
    let role = match raw["role"].as_str() {
        Some("assistant") => "Peer",
        Some("user") => "你",
        _ => "会话",
    };
    let content = raw["content"].as_str().unwrap_or("");
    if !content.is_empty() {
        return format!("{role}  {}", bounded_text(content, 1800));
    }
    let tool = raw["segments"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|segment| segment["type"] == "tool-call");
    if let Some(tool) = tool {
        let name = bounded_text(tool["tool"].as_str().unwrap_or(""), 100);
        let status = tool["result"]["status"].as_str().unwrap_or("已记录调用");
        return format!("工具  {name}  {}", bounded_text(status, 100));
    }
    format!("{role}  ［消息详情见导出］")
}

async fn execute(
    home: &Path,
    id: &str,
    runtime: &NativeConversationRuntime,
    prompt: &str,
    output: &mut OutputPort,
    permission: &mut PermissionPort,
    cancel: &CancellationToken,
) -> Result<(), &'static str> {
    let store = ConversationStore::new(home);
    let metadata = store
        .read_metadata(id)
        .map_err(StoreError::code)?
        .metadata
        .ok_or("conversation_unavailable")?;
    let run = store
        .read_conversation_execution(id)
        .map_err(StoreError::code)?
        .ok_or("conversation_execution_unrecorded")?;
    if !run.permits_new_run() {
        return Err("conversation_execution_busy");
    }
    let workspace = metadata["workspacePath"]
        .as_str()
        .ok_or("invalid_workspace")?;
    let mode = metadata["mode"]
        .as_str()
        .and_then(|mode| mode.parse::<RuntimeMode>().ok())
        .ok_or("runtime_mode_invalid")?;
    let effort = metadata["effort"].as_str();
    let (selected, bound) = match (&metadata["modelProviderId"], &metadata["model"]) {
        (provider, model) if provider.is_null() && model.is_null() => (
            resolve_exec(home, None, None, effort, metadata["fastMode"] == true),
            false,
        ),
        (provider, model) => (
            resolve_exact_session_model(
                home,
                provider.as_str().ok_or("model_selection_unavailable")?,
                model.as_str().ok_or("model_selection_unavailable")?,
                effort,
            ),
            true,
        ),
    };
    let selected = selected.map_err(|error| error.code)?;
    let model =
        peer_runtime::model_config::load_session_model(home, &selected.selection, None, cancel)
            .await
            .map_err(|error| error.code)?;
    let outcome = runtime
        .execute_observed(
            &ConversationOptions {
                workspace: Path::new(workspace),
                conversation_id: Some(id),
                resume_from: Some(&run),
                prompt,
                image_paths: &[],
                provider_id: &selected.entry.provider_id,
                mode,
                effort: selected.selection["reasoningEffort"]
                    .as_str()
                    .unwrap_or("default"),
                persist_model_selection: bound,
                allowlist: None,
                max_turns: None,
            },
            &model,
            permission,
            Some(output),
            cancel,
        )
        .await
        .map_err(|CapabilityError(code)| code)?;
    outcome.error.map_or(Ok(()), Err)
}
