//! Full native Bot-list & Bot-conversation Ratatui shell (ADR 80, ADR 84, ADR 85, ADR 122, ADR 130).
//!
//! Composes `NativeProjectHost` with pure `peer_tui::render_bot_shell`, enforcing:
//! - Zero premature disk writes when browsing `BindWorkspace` or `BotList`.
//! - ADR 122 chrome: `"Peer"` on list page, `"Peer · <Name>"` inside bot, caret selection,
//!   full-width divider + composer, draft restore warnings NEVER blocking typing.
//! - Single-host lease awareness: shows quiet takeover banner when another host holds lease,
//!   runs `NativeProjectHost::tick` asynchronously without blocking keyboard/navigation/cancel.
//! - Full Bot slash commands (`/bots`, `/tasks`, `/task N`, `/cards`, `/approve N`, `/deny N`,
//!   `/answer N ...`, `/memory`, `/objectives`, `/model`, `/takeover`, `/older`, `/latest`,
//!   `/save-draft`, `/classic`, `/help`, `/quit`) + `F2` Classic switch + `F3` ModelPicker.

use super::{
    ShellOutcome, TerminalGuard,
    model_picker_adapter::load_picker_groups,
    theme_store::{self, TerminalPreferences},
};
use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use peer_project_agent::{
    BotProfile, DraftBody, DraftWriteRequest, FamiliarizeKind, LeaseStatus, MemoryFilter,
    NativeProjectHost,
};
use peer_runtime::{CancellationToken, model_catalog::resolve_exec};
use peer_tui::{
    Action, BOT_SLASH_ITEMS, BotCardRow, BotMessageView, BotRowView, BotScreen, BotShellView,
    BotSubView, BotTaskRow, ByteBudgetLru, CardNumbers, CardOperation, ClassicOverlay, Composer,
    Effect, MARKDOWN_WRAP_CACHE_BYTES, ModelPickerEvent, ModelPickerState, ProjectCommand,
    ReadingAnchor, RenderedBlock, ThemeMode, TuiLocale, WrapCacheKey, action_for_event,
    filter_slash_items, parse_project_command, render_bot_shell, terminal_text,
};
use std::{
    collections::HashMap,
    io,
    path::PathBuf,
    sync::Arc,
    time::{Duration, Instant},
};
use tokio::task::{JoinHandle, LocalSet};

struct ActiveTick {
    cancel: CancellationToken,
    task: JoinHandle<Result<(), String>>,
}

#[derive(Debug, Clone)]
enum BotCardAction {
    StartFamiliarize,
    Command(String),
}

fn is_transient_nav_command(raw: &str) -> bool {
    matches!(
        parse_project_command(raw),
        ProjectCommand::Classic
            | ProjectCommand::Quit
            | ProjectCommand::Help
            | ProjectCommand::Version
            | ProjectCommand::View(_)
            | ProjectCommand::Model
            | ProjectCommand::Theme(_)
            | ProjectCommand::Language(_)
            | ProjectCommand::Older
            | ProjectCommand::Latest
    )
}

struct BotShellState<'a> {
    home: PathBuf,
    workspace: PathBuf,
    prefs: &'a mut TerminalPreferences,
    host: Arc<NativeProjectHost>,
    screen: BotScreen,
    bots: Vec<BotRowView>,
    selected_bot: usize,
    active_workspace_id: Option<String>,
    active_bot_name: Option<String>,
    lease_banner: Option<String>,
    messages: Vec<BotMessageView>,
    tasks: Vec<BotTaskRow>,
    memories: Vec<String>,
    objectives: Vec<String>,
    cards: Vec<BotCardRow>,
    card_actions: Vec<Vec<BotCardAction>>,
    card_numbers: CardNumbers,
    card_focus: bool,
    selected_card: usize,
    selected_card_option: usize,
    slash_selected: usize,
    anchor: ReadingAnchor,
    composer: Composer,
    draft_revision: u64,
    has_persisted_draft: bool,
    draft_warning: Option<String>,
    notice: Option<String>,
    selected_provider: Option<String>,
    selected_model: Option<String>,
    selected_effort: Option<String>,
    model_picker: ModelPickerState,
    overlay: ClassicOverlay,
    wrap_cache: ByteBudgetLru<WrapCacheKey, RenderedBlock>,
    active_tick: Option<ActiveTick>,
    last_refresh: Instant,
    interaction_limit: usize,
}

impl<'a> BotShellState<'a> {
    fn open(
        home: PathBuf,
        workspace: PathBuf,
        force_list: bool,
        prefs: &'a mut TerminalPreferences,
    ) -> io::Result<Self> {
        let host = Arc::new(
            NativeProjectHost::new(&home, crate::VERSION.trim(), None)
                .map_err(|e| io::Error::other(e.to_string()))?,
        );
        let bound_entry = host
            .registry()
            .find_by_path(&workspace.to_string_lossy())
            .ok()
            .flatten();
        let bound_profile = bound_entry
            .as_ref()
            .and_then(|e| host.profiles().read(&e.workspace_id))
            .filter(BotProfile::is_active);

        let (initial_screen, active_ws, active_name) = if force_list {
            (BotScreen::BotList, None, None)
        } else if let (Some(entry), Some(profile)) = (bound_entry, bound_profile) {
            (
                BotScreen::Conversation,
                Some(entry.workspace_id),
                Some(profile.display_name),
            )
        } else {
            (
                BotScreen::BindWorkspace {
                    workspace_path: workspace.to_string_lossy().into_owned(),
                    confirm_yes: true,
                },
                None,
                None,
            )
        };

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

        let mut state = Self {
            home,
            workspace,
            prefs,
            host,
            screen: initial_screen,
            bots: Vec::new(),
            selected_bot: 0,
            active_workspace_id: active_ws,
            active_bot_name: active_name,
            lease_banner: None,
            messages: Vec::new(),
            tasks: Vec::new(),
            memories: Vec::new(),
            objectives: Vec::new(),
            cards: Vec::new(),
            card_actions: Vec::new(),
            card_numbers: CardNumbers::default(),
            card_focus: false,
            selected_card: 0,
            selected_card_option: 0,
            slash_selected: 0,
            anchor: ReadingAnchor::FollowingLatest,
            composer: Composer::default(),
            draft_revision: 0,
            has_persisted_draft: false,
            draft_warning: None,
            notice: None,
            selected_provider,
            selected_model,
            selected_effort,
            model_picker: ModelPickerState::default(),
            overlay: ClassicOverlay::None,
            wrap_cache: ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 512),
            active_tick: None,
            last_refresh: Instant::now(),
            interaction_limit: 40,
        };
        state.refresh_snapshot(true);
        Ok(state)
    }

    fn refresh_snapshot(&mut self, load_draft: bool) {
        self.last_refresh = Instant::now();
        // Refresh bot directory list (strictly read-only).
        let mut by_ws = HashMap::new();
        for ws in self.host.profiles().list_workspace_ids() {
            by_ws.insert(ws.clone(), self.host.supervisor().list_bot_sessions(&ws));
        }
        let listed = self.host.directory().list(&by_ws);
        self.bots = listed
            .into_iter()
            .map(|item| BotRowView {
                workspace_id: item.workspace_id,
                display_name: item.profile.display_name,
                last_activity: (!item.last_active_at.is_empty()).then_some(item.last_active_at),
                needs_you: item.state.needs_you,
                running: item.state.running,
                unread: item.state.unread,
                preview: (!item.preview.is_empty()).then_some(item.preview),
            })
            .collect();
        if self.selected_bot >= self.bots.len() && !self.bots.is_empty() {
            self.selected_bot = self.bots.len() - 1;
        }

        let Some(ws_id) = self.active_workspace_id.clone() else {
            return;
        };

        // Check lease status passively (only inspect; never steal lease unless user runs /takeover or sends input).
        self.lease_banner = match self.host.leases_status_readonly(&ws_id) {
            Some(owner) if !self.host.holds_lease(&ws_id) => Some(format!(
                "另一宿主（{}）当前持有执行权 · 仍可发送消息，输入 `/takeover` 接管",
                terminal_text(&owner)
            )),
            _ => None,
        };

        // Load recoverable draft on initial open; failure sets warning without blocking typing (ADR 122 §3).
        if load_draft {
            match self.host.drafts().read(&ws_id, "tui", false) {
                Ok(snap) => {
                    self.draft_revision = snap.revision;
                    self.draft_warning = None;
                    self.has_persisted_draft = !snap.draft.text.is_empty();
                    if self.composer.draft().is_empty()
                        && !snap.draft.text.is_empty()
                        && !is_transient_nav_command(&snap.draft.text)
                    {
                        self.composer.apply(Action::Insert(snap.draft.text));
                    }
                }
                Err(err) => {
                    self.draft_warning = Some(format!(
                        "草稿恢复失败（{}），仍可正常输入或运行 /save-draft",
                        err.code
                    ));
                }
            }
        }

        // Load bounded paginated bot interactions
        let mut familiarize_offer = None;
        if let Ok(page) =
            self.host
                .directory()
                .read_interactions(&ws_id, self.interaction_limit, None)
        {
            familiarize_offer = page.familiarize_offer;
            let by_id: HashMap<String, String> = page
                .messages
                .iter()
                .filter_map(|m| {
                    let id = m["id"].as_str()?;
                    let content = m["content"].as_str().unwrap_or("");
                    (!id.is_empty() && !content.is_empty())
                        .then(|| (id.to_owned(), content.to_owned()))
                })
                .collect();
            self.messages = page
                .messages
                .into_iter()
                .map(|m| {
                    let id = m["id"].as_str().unwrap_or("").to_owned();
                    let role = m["role"].as_str().unwrap_or("assistant").to_owned();
                    let kind = m["kind"].as_str().unwrap_or("agent_reply").to_owned();
                    let content = m["content"].as_str().unwrap_or("").to_owned();
                    let created_at = m["createdAt"].as_str().map(str::to_owned);
                    let reply_to_echo = m["replyTo"]
                        .as_array()
                        .or_else(|| m["meta"]["replyTo"].as_array())
                        .and_then(|arr| arr.first())
                        .and_then(|v| v.as_str())
                        .and_then(|rid| by_id.get(rid))
                        .cloned();
                    let marks: Vec<String> = m["marks"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|mk| {
                            mk["outcome"]
                                .as_str()
                                .or_else(|| mk["state"].as_str())
                                .map(str::to_owned)
                        })
                        .collect();
                    let card_number = m["cards"]
                        .as_array()
                        .and_then(|arr| arr.first())
                        .and_then(|c| c["cardId"].as_str())
                        .map(|cid| self.card_numbers.assign(&ws_id, cid));
                    let card_summary = m["cards"]
                        .as_array()
                        .and_then(|arr| arr.first())
                        .and_then(|c| c["content"].as_str())
                        .map(str::to_owned);
                    BotMessageView {
                        id,
                        revision: 1,
                        role,
                        kind,
                        content,
                        created_at,
                        reply_to_echo,
                        marks,
                        card_number,
                        card_summary,
                    }
                })
                .collect();
        }

        // Tasks
        let sessions = self.host.supervisor().list_sessions(&ws_id);
        self.tasks = sessions
            .iter()
            .enumerate()
            .map(|(i, s)| BotTaskRow {
                number: i + 1,
                session_id: s.session_id.clone(),
                title: s.title.clone(),
                status: s.status.clone(),
                accepted: s.accepted,
                updated_at: s.updated_at.clone(),
            })
            .collect();

        // Pending cards (open approvals & awaiting_approval sessions + first-open familiarize offer)
        let zh = self.prefs.locale.is_zh();
        let mut cards = Vec::new();
        let mut card_actions = Vec::new();
        for s in &sessions {
            if let Some(ref aid) = s.approval_id
                && s.phase == "awaiting_approval"
            {
                let num = self.card_numbers.assign(&ws_id, aid);
                cards.push(BotCardRow {
                    number: num,
                    card_id: aid.clone(),
                    kind: if zh { "计划批准" } else { "Approval" }.to_owned(),
                    title: s.title.clone(),
                    summary: if zh {
                        format!("委派会话 {} 等待计划批准", s.session_id)
                    } else {
                        format!("Work session {} awaits plan approval", s.session_id)
                    },
                    actions: vec![
                        if zh { "批准" } else { "Approve" }.to_owned(),
                        if zh { "拒绝" } else { "Deny" }.to_owned(),
                    ],
                });
                card_actions.push(vec![
                    BotCardAction::Command(format!("/approve {num}")),
                    BotCardAction::Command(format!("/deny {num}")),
                ]);
            }
        }
        if familiarize_offer.is_some() {
            let card_id = format!("offer:familiarize:{ws_id}");
            let num = self.card_numbers.assign(&ws_id, &card_id);
            cards.push(BotCardRow {
                number: num,
                card_id,
                kind: String::new(),
                title: if zh {
                    "要我先熟悉一下这个项目吗？"
                } else {
                    "Shall I familiarize myself with this project?"
                }
                .to_owned(),
                summary: String::new(),
                actions: vec![
                    if zh {
                        "先熟悉一下项目"
                    } else {
                        "Familiarize with project"
                    }
                    .to_owned(),
                ],
            });
            card_actions.push(vec![BotCardAction::StartFamiliarize]);
        }
        self.cards = cards;
        self.card_actions = card_actions;
        if self.cards.is_empty() {
            self.card_focus = false;
            self.selected_card = 0;
            self.selected_card_option = 0;
        } else {
            if self.selected_card >= self.cards.len() {
                self.selected_card = self.cards.len() - 1;
                self.selected_card_option = 0;
            }
            let act_len = self.cards[self.selected_card].actions.len();
            if act_len == 0 {
                self.selected_card_option = 0;
            } else if self.selected_card_option >= act_len {
                self.selected_card_option = act_len - 1;
            }
        }

        // Memories & Objectives (bounded read)
        self.memories = self
            .host
            .memory()
            .list(&MemoryFilter {
                workspace_id: Some(&ws_id),
                status: Some("active"),
                ..Default::default()
            })
            .into_iter()
            .take(50)
            .map(|m| format!("[{}/{}] {}", m.scope, m.kind, m.text))
            .collect();
        self.objectives = self
            .host
            .objectives()
            .list(&ws_id)
            .unwrap_or_default()
            .into_iter()
            .take(50)
            .map(|o| format!("[{}] {} — {}", o.status, o.title, o.outcome))
            .collect();

        // Mark read when viewing latest conversation messages.
        if self.screen == BotScreen::Conversation && self.anchor.is_following() {
            let _ = self.host.directory().mark_read(&ws_id, None);
        }
    }

    fn clear_persisted_draft(&mut self) {
        if !self.has_persisted_draft {
            return;
        }
        let Some(ws_id) = self.active_workspace_id.as_deref() else {
            return;
        };
        if self
            .host
            .drafts()
            .write(DraftWriteRequest {
                workspace_id: ws_id,
                surface: "tui",
                revision: self.draft_revision,
                draft: DraftBody::default(),
                pending: vec![],
                uploads: vec![],
            })
            .is_ok()
        {
            self.has_persisted_draft = false;
            if let Ok(snap) = self.host.drafts().read(ws_id, "tui", false) {
                self.draft_revision = snap.revision;
            }
        }
    }

    fn save_draft(&mut self) {
        let Some(ref ws_id) = self.active_workspace_id else {
            return;
        };
        match self.host.drafts().write(DraftWriteRequest {
            workspace_id: ws_id,
            surface: "tui",
            revision: self.draft_revision,
            draft: DraftBody {
                text: self.composer.draft().to_owned(),
                ..Default::default()
            },
            pending: vec![],
            uploads: vec![],
        }) {
            Ok(rev) => {
                self.draft_revision = rev;
                self.has_persisted_draft = !self.composer.draft().is_empty();
                self.draft_warning = None;
                self.notice = Some("草稿已保存。".to_owned());
            }
            Err(err) => {
                self.draft_warning =
                    Some(format!("草稿保存失败（{}），本地编辑已保留。", err.code));
            }
        }
    }

    fn execute_card_action(&mut self, card_idx: usize, opt_idx: usize) -> Option<ShellOutcome> {
        let action = self
            .card_actions
            .get(card_idx)
            .and_then(|acts| acts.get(opt_idx))
            .cloned()?;
        self.card_focus = false;
        match action {
            BotCardAction::StartFamiliarize => {
                let ws_id = self.active_workspace_id.clone()?;
                let selection = resolve_exec(
                    &self.home,
                    self.selected_provider.as_deref(),
                    self.selected_model.as_deref(),
                    self.selected_effort.as_deref(),
                    false,
                )
                .map(|r| r.selection)
                .unwrap_or(serde_json::Value::Null);
                match self.host.start_familiarize(&ws_id, selection) {
                    Ok(res) => {
                        self.screen = BotScreen::Conversation;
                        match res.kind {
                            FamiliarizeKind::Research { .. } => {
                                self.notice = Some(
                                    if res.reused {
                                        "项目熟悉任务已在进行中。"
                                    } else {
                                        "已开始只读熟悉项目，正在后台推进…"
                                    }
                                    .to_owned(),
                                );
                                self.refresh_snapshot(false);
                                self.trigger_background_tick();
                            }
                            FamiliarizeKind::Blank => {
                                self.notice = Some("已询问项目职责。".to_owned());
                                self.refresh_snapshot(false);
                            }
                        }
                    }
                    Err(err) => {
                        if err.code == "desktop_approval_required" {
                            self.notice =
                                Some("请在桌面处理这个操作（当前终端为只读客户端）。".to_owned());
                        } else {
                            self.notice = Some(format!("启动熟悉项目失败（{}）。", err.code));
                        }
                    }
                }
                None
            }
            BotCardAction::Command(cmd) => {
                if cmd.ends_with(' ') {
                    self.composer.accepted();
                    self.composer.apply(Action::Insert(cmd));
                    None
                } else {
                    self.handle_submit(&cmd)
                }
            }
        }
    }

    fn trigger_background_tick(&mut self) {
        if self.active_tick.is_some() {
            return;
        }
        let Some(ws_id) = self.active_workspace_id.clone() else {
            return;
        };
        let resolved = match resolve_exec(
            &self.home,
            self.selected_provider.as_deref(),
            self.selected_model.as_deref(),
            self.selected_effort.as_deref(),
            false,
        ) {
            Ok(s) => s,
            Err(err) => {
                self.notice = Some(format!(
                    "已持久提交输入，但当前未配置模型（{}）；可按 `/model` 配置或由其他宿主处理。",
                    err.detail
                ));
                return;
            }
        };
        let home = self.home.clone();
        let host = Arc::clone(&self.host);
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let selection = resolved.selection;
        let task = tokio::task::spawn_local(async move {
            let model = peer_runtime::model_config::load_model(&home, &selection, &task_cancel)
                .await
                .map_err(|e| e.code.to_owned())?;
            let mut perm = crate::native_exec::TerminalPermission;
            host.tick(&ws_id, &model, selection, &mut perm, &task_cancel)
                .await
                .map(|_| ())
                .map_err(|e| e.to_string())
        });
        self.active_tick = Some(ActiveTick { cancel, task });
    }

    fn handle_submit(&mut self, text: &str) -> Option<ShellOutcome> {
        match parse_project_command(text) {
            ProjectCommand::Text(body) => {
                if body.is_empty() {
                    return None;
                }
                let Some(ws_id) = self.active_workspace_id.clone() else {
                    self.notice = Some("请先打开或绑定一个项目机器人。".to_owned());
                    return None;
                };
                let input_id = uuid::Uuid::new_v4().to_string();
                match self.host.submit_user_input(&ws_id, &input_id, &body, None) {
                    Ok(_) => {
                        self.composer.accepted();
                        // Clear persisted draft after durable commit receipt.
                        self.has_persisted_draft = true;
                        self.clear_persisted_draft();
                        self.anchor.jump_to_latest();
                        self.screen = BotScreen::Conversation;
                        self.notice = Some("已接收，正在推进…".to_owned());
                        self.refresh_snapshot(false);
                        self.trigger_background_tick();
                    }
                    Err(err) => {
                        self.notice = Some(format!("发送失败（{}），草稿已保留。", err.code));
                    }
                }
                None
            }
            ProjectCommand::SaveDraft => {
                self.save_draft();
                None
            }
            ProjectCommand::RetryInput(id) => {
                self.notice = Some(format!("已触发重试输入 {id}…"));
                self.composer.accepted();
                self.clear_persisted_draft();
                self.trigger_background_tick();
                None
            }
            ProjectCommand::View(sub) => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.screen = match sub {
                    BotSubView::Bots => BotScreen::BotList,
                    BotSubView::Tasks => BotScreen::Tasks,
                    BotSubView::Memory => BotScreen::Memory,
                    BotSubView::Objectives => BotScreen::Objectives,
                    BotSubView::Cards | BotSubView::Diagnostics => BotScreen::Cards,
                };
                self.refresh_snapshot(false);
                None
            }
            ProjectCommand::Task(num) => {
                self.composer.accepted();
                self.clear_persisted_draft();
                let ws_id = self.active_workspace_id.as_deref()?;
                let Some(row) = self.tasks.iter().find(|t| t.number == num) else {
                    self.notice = Some(format!("未找到任务 #{num}。"));
                    return None;
                };
                match self.host.supervisor().read_report(ws_id, &row.session_id) {
                    Ok(rep) => {
                        let body = format!(
                            "状态: {}\n核验结论: {}（独立核验: {}）\n签收: {}\n证据引用 ({}): {}\n\n变更文件 ({}): {}\n\n摘要:\n{}",
                            rep.summary.status,
                            rep.verdict_outcome,
                            rep.independent_verifier,
                            if rep.summary.accepted {
                                rep.summary.accepted_by.as_deref().unwrap_or("已签收")
                            } else {
                                "未签收"
                            },
                            rep.evidence_refs.len(),
                            rep.evidence_refs.join(", "),
                            rep.changed_files.len(),
                            rep.changed_files.join(", "),
                            rep.worker_output
                        );
                        self.screen = BotScreen::TaskDetail {
                            title: rep.summary.title,
                            body,
                        };
                    }
                    Err(err) => {
                        self.notice = Some(format!("无法读取任务详情（{}）。", err.code));
                    }
                }
                None
            }
            ProjectCommand::Result(_) => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.notice = Some(
                    "可使用 `peer result <interactive-result://…>` 查看完整固定结果。".to_owned(),
                );
                None
            }
            ProjectCommand::Card {
                operation,
                number,
                text: answer_text,
            } => {
                let ws_id = self.active_workspace_id.clone()?;
                let Some(card_idx) = self.cards.iter().position(|c| c.number == number) else {
                    self.notice = Some(format!("未找到待处理卡片 #{number}。"));
                    return None;
                };
                let card = self.cards[card_idx].clone();
                match operation {
                    CardOperation::Approve | CardOperation::Deny => {
                        let holds = matches!(
                            self.host.ensure_lease(&ws_id),
                            Ok(LeaseStatus::Acquired { .. })
                        );
                        let approved = matches!(operation, CardOperation::Approve);
                        let label = if approved { "已批准" } else { "已拒绝" };
                        match self.host.supervisor().decide_plan_approval(
                            &ws_id,
                            &card.card_id,
                            approved,
                            holds,
                        ) {
                            Ok(_) => {
                                self.composer.accepted();
                                self.clear_persisted_draft();
                                self.notice = Some(format!("卡片 #{number} {label}。"));
                                self.refresh_snapshot(false);
                                if approved {
                                    self.trigger_background_tick();
                                }
                            }
                            Err(err) => {
                                self.notice = Some(format!("卡片决定失败（{}）。", err.code));
                            }
                        }
                    }
                    CardOperation::Answer => {
                        let input_id = uuid::Uuid::new_v4().to_string();
                        if self
                            .host
                            .submit_user_input(&ws_id, &input_id, &answer_text, Some(card.card_id))
                            .is_ok()
                        {
                            self.composer.accepted();
                            self.clear_persisted_draft();
                            self.notice = Some(format!("已回复卡片 #{number}。"));
                            self.refresh_snapshot(false);
                            self.trigger_background_tick();
                        }
                    }
                    CardOperation::Action { option } => {
                        let Some(opt_idx) = option.checked_sub(1) else {
                            self.notice = Some(format!("卡片 #{number} 不存在选项 {option}。"));
                            return None;
                        };
                        if self
                            .card_actions
                            .get(card_idx)
                            .and_then(|acts| acts.get(opt_idx))
                            .is_none()
                        {
                            self.notice = Some(format!("卡片 #{number} 不存在选项 {option}。"));
                            return None;
                        }
                        self.composer.accepted();
                        self.clear_persisted_draft();
                        return self.execute_card_action(card_idx, opt_idx);
                    }
                }
                None
            }
            ProjectCommand::Takeover => {
                self.composer.accepted();
                self.clear_persisted_draft();
                if let Some(ws_id) = self.active_workspace_id.clone() {
                    match self.host.ensure_lease(&ws_id) {
                        Ok(LeaseStatus::Acquired { .. }) => {
                            self.lease_banner = None;
                            self.notice = Some("已取得当前工作区执行权。".to_owned());
                        }
                        Ok(LeaseStatus::HeldByOther(_)) => {
                            self.notice = Some("另一宿主租约仍活跃，无法强抢；请先关闭桌面端窗口或继续作为客户端发送。".to_owned());
                        }
                        Err(err) => {
                            self.notice = Some(format!("接管失败（{}）。", err.code));
                        }
                    }
                }
                None
            }
            ProjectCommand::Classic => {
                self.composer.accepted();
                self.clear_persisted_draft();
                Some(ShellOutcome::SwitchToClassic)
            }
            ProjectCommand::Model => {
                self.composer.accepted();
                self.clear_persisted_draft();
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
                        self.notice = Some(format!("无法读取模型配置（{code}）。"));
                    }
                }
                None
            }
            ProjectCommand::Theme(arg) => {
                self.composer.accepted();
                self.clear_persisted_draft();
                match arg {
                    Some(raw) => match ThemeMode::parse(&raw) {
                        Some(m) => self.apply_theme_mode(m),
                        None => {
                            self.notice = Some("主题仅支持 dark / light / system。".to_owned());
                        }
                    },
                    None => {
                        let sel = match self.prefs.mode {
                            ThemeMode::Dark => 0,
                            ThemeMode::Light => 1,
                            ThemeMode::System => 2,
                        };
                        self.overlay = ClassicOverlay::Theme { selected: sel };
                    }
                }
                None
            }
            ProjectCommand::Language(arg) => {
                self.composer.accepted();
                self.clear_persisted_draft();
                match arg {
                    Some(raw) => match TuiLocale::parse(&raw) {
                        Some(l) => self.apply_locale(l),
                        None => {
                            self.notice = Some("语言仅支持 zh-CN / en-US。".to_owned());
                        }
                    },
                    None => {
                        let sel = if self.prefs.locale.is_zh() { 0 } else { 1 };
                        self.overlay = ClassicOverlay::Language { selected: sel };
                    }
                }
                None
            }
            ProjectCommand::Older => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.interaction_limit = (self.interaction_limit + 40).min(400);
                self.refresh_snapshot(false);
                self.anchor.scroll_up(12, 10_000, None);
                None
            }
            ProjectCommand::Latest => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.anchor.jump_to_latest();
                self.screen = BotScreen::Conversation;
                self.refresh_snapshot(false);
                None
            }
            ProjectCommand::Help => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.screen = BotScreen::Help;
                None
            }
            ProjectCommand::Version => {
                self.composer.accepted();
                self.clear_persisted_draft();
                self.notice = Some(format!("peer {}", crate::VERSION.trim()));
                None
            }
            ProjectCommand::Quit => {
                self.composer.accepted();
                self.clear_persisted_draft();
                Some(ShellOutcome::Quit)
            }
            ProjectCommand::Invalid => {
                self.notice = Some("命令格式无效，输入 `/help` 查看帮助。".to_owned());
                None
            }
        }
    }

    fn apply_theme_mode(&mut self, next_mode: ThemeMode) {
        match theme_store::save_theme_mode(&self.home, next_mode) {
            Ok(scheme) => {
                self.prefs.mode = next_mode;
                self.prefs.scheme = scheme;
                self.wrap_cache.clear();
                self.notice = Some(format!(
                    "主题已切换为 {}（配色: {}）。",
                    next_mode.as_str(),
                    scheme.as_str()
                ));
            }
            Err(err) => {
                self.notice = Some(format!("保存主题失败：{err}"));
            }
        }
    }

    fn apply_locale(&mut self, next_locale: TuiLocale) {
        match theme_store::save_locale(&self.home, next_locale) {
            Ok(()) => {
                self.prefs.locale = next_locale;
                self.notice = Some(format!("界面语言已切换为 {}。", next_locale.as_str()));
            }
            Err(err) => {
                self.notice = Some(format!("保存语言失败：{err}"));
            }
        }
    }

    fn handle_overlay_key(&mut self, code: KeyCode) -> bool {
        match &mut self.overlay {
            ClassicOverlay::Theme { selected } => match code {
                KeyCode::Esc => {
                    self.overlay = ClassicOverlay::None;
                    true
                }
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
            ClassicOverlay::Language { selected } => match code {
                KeyCode::Esc => {
                    self.overlay = ClassicOverlay::None;
                    true
                }
                KeyCode::Up | KeyCode::Left => {
                    *selected = (*selected + 1) % 2;
                    true
                }
                KeyCode::Down | KeyCode::Right | KeyCode::Tab => {
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
            _ => false,
        }
    }

    fn draw(&mut self, terminal: &mut TerminalGuard) -> io::Result<()> {
        let live_activity = self
            .host
            .runner()
            .current_activity()
            .filter(|act| act.finished_at.is_none())
            .map(|act| {
                if !act.reply_text.is_empty() {
                    format!("Bot  {}", act.reply_text)
                } else {
                    format!("Bot  正在推进（{}）…", act.phase)
                }
            });
        let is_host = self.lease_banner.is_none();
        let palette = self.prefs.palette();
        let scheme_id = self.prefs.scheme.cache_id();
        let locale = self.prefs.locale;
        terminal.draw_frame(|frame| {
            render_bot_shell(
                frame,
                BotShellView {
                    screen: &self.screen,
                    palette,
                    scheme_id,
                    current_theme: self.prefs.mode,
                    locale,
                    is_host,
                    bots: &self.bots,
                    selected_bot: self.selected_bot,
                    active_bot_name: self.active_bot_name.as_deref(),
                    lease_banner: self.lease_banner.as_deref(),
                    messages: &self.messages,
                    live_activity: live_activity.as_deref(),
                    tasks: &self.tasks,
                    memories: &self.memories,
                    objectives: &self.objectives,
                    cards: &self.cards,
                    card_focus: self.card_focus,
                    selected_card: self.selected_card,
                    selected_card_option: self.selected_card_option,
                    slash_selected: self.slash_selected,
                    anchor: &self.anchor,
                    composer: &self.composer,
                    draft_warning: self.draft_warning.as_deref(),
                    notice: self.notice.as_deref(),
                    model_picker: &self.model_picker,
                    overlay: Some(&self.overlay),
                    wrap_cache: &mut self.wrap_cache,
                },
            );
        })
    }

    async fn run(
        mut self,
        terminal: &mut TerminalGuard,
        shutdown: &CancellationToken,
    ) -> io::Result<ShellOutcome> {
        self.draw(terminal)?;
        loop {
            if shutdown.is_cancelled() {
                if let Some(active) = self.active_tick.take() {
                    active.cancel.cancel();
                    let _ = active.task.await;
                }
                self.host.close();
                return Ok(ShellOutcome::Quit);
            }

            let mut dirty = false;

            if let Some(active) = self.active_tick.as_ref()
                && active.task.is_finished()
                && let Some(done) = self.active_tick.take()
            {
                match done.task.await {
                    Ok(Ok(())) => {
                        self.notice = None;
                    }
                    Ok(Err(err)) => {
                        self.notice = Some(format!("推进暂停（{}）。", terminal_text(&err)));
                    }
                    Err(_) => {
                        self.notice = Some("后台推进任务中断。".to_owned());
                    }
                }
                self.refresh_snapshot(false);
                dirty = true;
            }

            // Periodic low-frequency refresh only when viewing an active bot conversation (1s interval).
            let refresh_interval = if self.active_tick.is_some() {
                Duration::from_millis(250)
            } else {
                Duration::from_secs(1)
            };
            if self.screen == BotScreen::Conversation
                && self.last_refresh.elapsed() >= refresh_interval
            {
                self.refresh_snapshot(false);
                dirty = true;
            }

            // Crossterm's Unix TTY source needs a positive poll budget to read the fd.
            let poll_ms = if self.active_tick.is_some() { 5 } else { 25 };
            if event::poll(Duration::from_millis(poll_ms))? {
                match event::read()? {
                    Event::Resize(_, _) => {
                        dirty = true;
                    }
                    Event::Paste(pasted) => {
                        if !self.model_picker.open
                            && !self.overlay.is_open()
                            && !matches!(
                                self.screen,
                                BotScreen::BotList | BotScreen::BindWorkspace { .. }
                            )
                        {
                            self.composer.apply(Action::Insert(pasted));
                            dirty = true;
                        }
                    }
                    Event::Key(key) if key.kind != KeyEventKind::Release => {
                        if self.model_picker.open {
                            match self.model_picker.handle_key(key) {
                                ModelPickerEvent::None => {}
                                ModelPickerEvent::Close => {}
                                ModelPickerEvent::Select {
                                    provider_id,
                                    model_id,
                                    effort,
                                } => {
                                    let label = self
                                        .model_picker
                                        .current_display_label()
                                        .unwrap_or_else(|| model_id.clone());
                                    self.selected_provider = Some(provider_id);
                                    self.selected_model = Some(model_id);
                                    self.selected_effort = effort;
                                    self.model_picker.close();
                                    self.notice = Some(format!("本终端会话模型已设为 {label}。"));
                                }
                            }
                            dirty = true;
                        } else if self.overlay.is_open() {
                            if self.handle_overlay_key(key.code) {
                                dirty = true;
                            }
                        } else if key.code == KeyCode::F(2) {
                            if let Some(active) = self.active_tick.take() {
                                active.cancel.cancel();
                                let _ = active.task.await;
                            }
                            self.host.close();
                            return Ok(ShellOutcome::SwitchToClassic);
                        } else if key.code == KeyCode::F(3) {
                            if let Ok(groups) = load_picker_groups(&self.home) {
                                self.model_picker.open_with(
                                    groups,
                                    self.selected_provider.clone(),
                                    self.selected_model.clone(),
                                    self.selected_effort.clone(),
                                );
                                dirty = true;
                            }
                        } else if key.code == KeyCode::Char('d')
                            && key.modifiers.contains(KeyModifiers::CONTROL)
                            && self.composer.draft().is_empty()
                        {
                            if let Some(active) = self.active_tick.take() {
                                active.cancel.cancel();
                                let _ = active.task.await;
                            }
                            self.host.close();
                            return Ok(ShellOutcome::Quit);
                        } else {
                            match &mut self.screen {
                                BotScreen::BindWorkspace { confirm_yes, .. } => match key.code {
                                    KeyCode::Up
                                    | KeyCode::Down
                                    | KeyCode::Left
                                    | KeyCode::Right
                                    | KeyCode::Tab => {
                                        *confirm_yes = !*confirm_yes;
                                        dirty = true;
                                    }
                                    code if matches!(
                                        code,
                                        KeyCode::Char('n' | 'N') | KeyCode::Esc
                                    ) || (code == KeyCode::Enter && !*confirm_yes) =>
                                    {
                                        self.host.close();
                                        return Ok(ShellOutcome::SwitchToClassic);
                                    }
                                    KeyCode::Char('y' | 'Y') | KeyCode::Enter => {
                                        match self.host.bind_workspace(&self.workspace, None) {
                                            Ok((entry, profile)) => {
                                                self.active_workspace_id = Some(entry.workspace_id);
                                                self.active_bot_name = Some(profile.display_name);
                                                self.screen = BotScreen::Conversation;
                                                self.refresh_snapshot(true);
                                            }
                                            Err(err) => {
                                                self.notice =
                                                    Some(format!("绑定失败（{}）。", err.code));
                                            }
                                        }
                                        dirty = true;
                                    }
                                    KeyCode::Char('c')
                                        if key.modifiers.contains(KeyModifiers::CONTROL) =>
                                    {
                                        self.host.close();
                                        return Ok(ShellOutcome::Quit);
                                    }
                                    _ => {}
                                },
                                BotScreen::BotList => match key.code {
                                    KeyCode::Up => {
                                        self.selected_bot = self.selected_bot.saturating_sub(1);
                                        dirty = true;
                                    }
                                    KeyCode::Down => {
                                        if self.selected_bot + 1 < self.bots.len() {
                                            self.selected_bot += 1;
                                        }
                                        dirty = true;
                                    }
                                    KeyCode::Enter => {
                                        if let Some(row) = self.bots.get(self.selected_bot).cloned()
                                        {
                                            self.active_workspace_id = Some(row.workspace_id);
                                            self.active_bot_name = Some(row.display_name);
                                            self.anchor.jump_to_latest();
                                            self.screen = BotScreen::Conversation;
                                            self.refresh_snapshot(true);
                                            dirty = true;
                                        }
                                    }
                                    KeyCode::Esc => {
                                        if self.active_workspace_id.is_some() {
                                            self.screen = BotScreen::Conversation;
                                            dirty = true;
                                        }
                                    }
                                    KeyCode::Char('c')
                                        if key.modifiers.contains(KeyModifiers::CONTROL) =>
                                    {
                                        self.host.close();
                                        return Ok(ShellOutcome::Quit);
                                    }
                                    _ => {}
                                },
                                _ => {
                                    // Conversation & sub-views
                                    let slash_count =
                                        filter_slash_items(self.composer.draft(), BOT_SLASH_ITEMS)
                                            .len();
                                    if self.card_focus && self.screen == BotScreen::Conversation {
                                        match key.code {
                                            KeyCode::Esc | KeyCode::Tab => {
                                                self.card_focus = false;
                                                dirty = true;
                                            }
                                            KeyCode::Up => {
                                                self.selected_card =
                                                    self.selected_card.saturating_sub(1);
                                                self.selected_card_option = 0;
                                                dirty = true;
                                            }
                                            KeyCode::Down => {
                                                if self.selected_card + 1 < self.cards.len() {
                                                    self.selected_card += 1;
                                                    self.selected_card_option = 0;
                                                }
                                                dirty = true;
                                            }
                                            KeyCode::Left => {
                                                self.selected_card_option =
                                                    self.selected_card_option.saturating_sub(1);
                                                dirty = true;
                                            }
                                            KeyCode::Right => {
                                                if let Some(c) = self.cards.get(self.selected_card)
                                                    && self.selected_card_option + 1
                                                        < c.actions.len()
                                                {
                                                    self.selected_card_option += 1;
                                                }
                                                dirty = true;
                                            }
                                            KeyCode::Enter => {
                                                if let Some(outcome) = self.execute_card_action(
                                                    self.selected_card,
                                                    self.selected_card_option,
                                                ) {
                                                    if let Some(active) = self.active_tick.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    self.host.close();
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            KeyCode::Char(c)
                                                if !key.modifiers.intersects(
                                                    KeyModifiers::CONTROL | KeyModifiers::ALT,
                                                ) =>
                                            {
                                                self.card_focus = false;
                                                self.composer.apply(Action::Insert(c.to_string()));
                                                self.slash_selected = 0;
                                                dirty = true;
                                            }
                                            _ => {}
                                        }
                                    } else if self.screen == BotScreen::Cards
                                        && self.composer.draft().is_empty()
                                        && !self.cards.is_empty()
                                        && matches!(
                                            key.code,
                                            KeyCode::Up
                                                | KeyCode::Down
                                                | KeyCode::Left
                                                | KeyCode::Right
                                                | KeyCode::Enter
                                                | KeyCode::Tab
                                        )
                                    {
                                        match key.code {
                                            KeyCode::Up => {
                                                self.selected_card =
                                                    self.selected_card.saturating_sub(1);
                                                self.selected_card_option = 0;
                                                dirty = true;
                                            }
                                            KeyCode::Down => {
                                                if self.selected_card + 1 < self.cards.len() {
                                                    self.selected_card += 1;
                                                    self.selected_card_option = 0;
                                                }
                                                dirty = true;
                                            }
                                            KeyCode::Left => {
                                                self.selected_card_option =
                                                    self.selected_card_option.saturating_sub(1);
                                                dirty = true;
                                            }
                                            KeyCode::Right => {
                                                if let Some(c) = self.cards.get(self.selected_card)
                                                    && self.selected_card_option + 1
                                                        < c.actions.len()
                                                {
                                                    self.selected_card_option += 1;
                                                }
                                                dirty = true;
                                            }
                                            KeyCode::Tab => {
                                                self.screen = BotScreen::Conversation;
                                                dirty = true;
                                            }
                                            KeyCode::Enter => {
                                                if let Some(outcome) = self.execute_card_action(
                                                    self.selected_card,
                                                    self.selected_card_option,
                                                ) {
                                                    if let Some(active) = self.active_tick.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    self.host.close();
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            _ => {}
                                        }
                                    } else if slash_count > 0
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
                                                let completed = {
                                                    let items = filter_slash_items(
                                                        self.composer.draft(),
                                                        BOT_SLASH_ITEMS,
                                                    );
                                                    items[self.slash_selected.min(items.len() - 1)]
                                                        .command
                                                        .to_owned()
                                                };
                                                self.composer.accepted();
                                                self.composer.apply(Action::Insert(completed));
                                                self.slash_selected = 0;
                                                dirty = true;
                                            }
                                            KeyCode::Enter => {
                                                let draft = self.composer.draft().to_owned();
                                                let cmd = if !matches!(
                                                    parse_project_command(&draft),
                                                    ProjectCommand::Invalid
                                                ) {
                                                    draft
                                                } else {
                                                    let items =
                                                        filter_slash_items(&draft, BOT_SLASH_ITEMS);
                                                    items[self.slash_selected.min(items.len() - 1)]
                                                        .command
                                                        .to_owned()
                                                };
                                                if cmd.ends_with(' ') {
                                                    self.composer.accepted();
                                                    self.composer.apply(Action::Insert(cmd));
                                                } else if let Some(outcome) =
                                                    self.handle_submit(&cmd)
                                                {
                                                    if let Some(active) = self.active_tick.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    self.host.close();
                                                    return Ok(outcome);
                                                }
                                                self.slash_selected = 0;
                                                dirty = true;
                                            }
                                            _ => {}
                                        }
                                    } else if key.code == KeyCode::Tab
                                        && self.screen == BotScreen::Conversation
                                        && !self.cards.is_empty()
                                    {
                                        self.card_focus = true;
                                        self.selected_card_option = 0;
                                        dirty = true;
                                    } else if key.code == KeyCode::Esc
                                        && self.screen != BotScreen::Conversation
                                    {
                                        self.screen = BotScreen::Conversation;
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
                                        && let Some(active) = self.active_tick.as_ref()
                                    {
                                        active.cancel.cancel();
                                        self.notice = Some("正在停止本轮回复…".to_owned());
                                        dirty = true;
                                    } else if let Some(action) = action_for_event(Event::Key(key)) {
                                        match action {
                                            Action::Submit => {
                                                let text = self.composer.draft().to_owned();
                                                if let Some(outcome) = self.handle_submit(&text) {
                                                    if let Some(active) = self.active_tick.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    self.host.close();
                                                    return Ok(outcome);
                                                }
                                                dirty = true;
                                            }
                                            other => match self.composer.apply(other) {
                                                Effect::Quit => {
                                                    if let Some(active) = self.active_tick.take() {
                                                        active.cancel.cancel();
                                                        let _ = active.task.await;
                                                    }
                                                    self.host.close();
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
            } else if self.active_tick.is_some() {
                tokio::select! {
                    biased;
                    _ = shutdown.cancelled() => {}
                    _ = tokio::time::sleep(Duration::from_millis(20)) => {}
                }
            } else {
                tokio::task::yield_now().await;
            }
        }
    }
}

pub(super) async fn run_bot_shell(
    home: PathBuf,
    workspace: PathBuf,
    force_list: bool,
    prefs: &mut TerminalPreferences,
    terminal: &mut TerminalGuard,
    shutdown: &CancellationToken,
) -> io::Result<ShellOutcome> {
    let state = BotShellState::open(home, workspace, force_list, prefs)?;
    LocalSet::new()
        .run_until(state.run(terminal, shutdown))
        .await
}

#[cfg(test)]
mod tests {
    use super::is_transient_nav_command;

    #[test]
    fn transient_nav_commands_are_not_restored_as_composer_drafts() {
        assert!(is_transient_nav_command("/classic"));
        assert!(is_transient_nav_command("/bots"));
        assert!(is_transient_nav_command("/help"));
        assert!(is_transient_nav_command("/model"));
        assert!(!is_transient_nav_command("请继续"));
        assert!(!is_transient_nav_command("/answer 1 好的"));
        assert!(!is_transient_nav_command("/approve 1"));
        assert!(!is_transient_nav_command("/action 1 1"));
    }
}
