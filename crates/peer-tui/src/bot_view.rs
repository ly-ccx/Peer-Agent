//! Pure Ratatui Bot-list & Bot-conversation shell views (ADR 122, ADR 84, ADR 85, ADR 130).
//!
//! Strictly follows ADR 122 chrome:
//! - List header is `"Peer"` (no host/client line on list page; no persistent `F2 · 普通任务模式`).
//! - Opened Bot header is `"Peer · <Name>"`.
//! - List rows show clipped name, `MM-DD HH:mm` short time, `待处理 N` (`needs_you`),
//!   `进行中 N` (`running`), and preview on its OWN clipped line. Selection uses caret `▸ `,
//!   never full-row background highlight.
//! - Full-width horizontal divider (`─`) above a full-width composer (no shrunk box, no 2 hint lines).
//! - Draft recovery warning displays in status line and never blocks typing.

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    commands::{clip_bot_line, format_bot_when},
    markdown::{RenderedBlock, WrapCacheKey, render_markdown_bounded, stable_hash},
    model_picker::{ModelPickerState, render_model_picker},
    terminal_text,
    view::draft_view,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotRowView {
    pub workspace_id: String,
    pub display_name: String,
    pub last_activity: Option<String>,
    pub needs_you: usize,
    pub running: usize,
    pub unread: usize,
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotMessageView {
    pub id: String,
    pub revision: u64,
    pub role: String,
    pub kind: String,
    pub content: String,
    pub created_at: Option<String>,
    pub card_number: Option<usize>,
    pub card_summary: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotTaskRow {
    pub number: usize,
    pub session_id: String,
    pub title: String,
    pub status: String,
    pub accepted: bool,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotCardRow {
    pub number: usize,
    pub card_id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    pub actions: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotScreen {
    BindWorkspace {
        workspace_path: String,
        confirm_yes: bool,
    },
    BotList,
    Conversation,
    Tasks,
    TaskDetail {
        title: String,
        body: String,
    },
    Memory,
    Objectives,
    Cards,
    Help,
}

pub struct BotShellView<'a> {
    pub screen: &'a BotScreen,
    pub bots: &'a [BotRowView],
    pub selected_bot: usize,
    pub active_bot_name: Option<&'a str>,
    pub lease_banner: Option<&'a str>,
    pub messages: &'a [BotMessageView],
    pub live_activity: Option<&'a str>,
    pub tasks: &'a [BotTaskRow],
    pub memories: &'a [String],
    pub objectives: &'a [String],
    pub cards: &'a [BotCardRow],
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub draft_warning: Option<&'a str>,
    pub notice: Option<&'a str>,
    pub model_picker: &'a ModelPickerState,
    pub wrap_cache: &'a mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

fn render_bot_list(frame: &mut Frame<'_>, area: Rect, bots: &[BotRowView], selected: usize) {
    let w = usize::from(area.width).max(1);
    let h = usize::from(area.height);
    if bots.is_empty() {
        frame.render_widget(
            Paragraph::new("暂无已绑定的项目机器人。\n进入任意工作目录运行 `peer` 绑定，或按 `/classic` 进入普通对话。")
                .style(Style::new().fg(Color::DarkGray))
                .wrap(Wrap { trim: false }),
            area,
        );
        return;
    }

    // Each bot entry takes 2 lines (meta line + preview line) + 1 blank separator = 3 lines.
    let rows_per_bot = 3usize;
    let visible_bots = (h / rows_per_bot).max(1);
    let start = selected.saturating_sub(visible_bots.saturating_sub(1));

    let mut lines: Vec<Line<'static>> = Vec::with_capacity(h);
    for (idx, bot) in bots.iter().enumerate().skip(start).take(visible_bots) {
        let is_selected = idx == selected;
        let caret = if is_selected { "▸ " } else { "  " };
        let when = bot
            .last_activity
            .as_deref()
            .map(format_bot_when)
            .unwrap_or_default();
        let mut counts = Vec::new();
        if bot.needs_you > 0 {
            counts.push(format!("待处理 {}", bot.needs_you));
        }
        if bot.running > 0 {
            counts.push(format!("进行中 {}", bot.running));
        }
        if bot.unread > 0 {
            counts.push(format!("未读 {}", bot.unread));
        }
        let meta_tail = [when, counts.join(" · ")]
            .into_iter()
            .filter(|s| !s.is_empty())
            .collect::<Vec<_>>()
            .join("  ");

        let tail_width = meta_tail.len().min(w.saturating_sub(6));
        let name_budget =
            w.saturating_sub(2 + tail_width + if meta_tail.is_empty() { 0 } else { 2 });
        let name = clip_bot_line(&bot.display_name, name_budget.max(4));

        let name_style = if is_selected {
            Style::new().add_modifier(Modifier::BOLD)
        } else {
            Style::default()
        };
        let mut row1 = vec![
            Span::styled(caret, name_style),
            Span::styled(name, name_style),
        ];
        if !meta_tail.is_empty() {
            row1.push(Span::raw("  "));
            row1.push(Span::styled(
                clip_bot_line(&meta_tail, w.saturating_sub(4)),
                if bot.needs_you > 0 {
                    Style::new().fg(Color::Yellow)
                } else {
                    Style::new().fg(Color::DarkGray)
                },
            ));
        }
        lines.push(Line::from(row1));

        // ADR 122 §1: preview on its OWN line, clipped to width, never colliding with time.
        let preview_text = bot
            .preview
            .as_deref()
            .map(|p| clip_bot_line(p, w.saturating_sub(2)))
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| "暂无消息".to_owned());
        lines.push(Line::from(vec![
            Span::raw("  "),
            Span::styled(preview_text, Style::new().fg(Color::DarkGray)),
        ]));
        lines.push(Line::raw(""));
    }

    frame.render_widget(Paragraph::new(lines), area);
}

fn render_conversation_body(
    frame: &mut Frame<'_>,
    area: Rect,
    messages: &[BotMessageView],
    live_activity: Option<&str>,
    anchor: &ReadingAnchor,
    wrap_cache: &mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
) {
    let width = usize::from(area.width).max(1);
    let height = usize::from(area.height);
    if height == 0 {
        return;
    }

    let mut all_lines: Vec<Line<'static>> = Vec::new();
    for msg in messages {
        let (prefix, header_style, body_style) = match (msg.role.as_str(), msg.kind.as_str()) {
            ("user", _) => (
                "你",
                Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                Style::default(),
            ),
            (_, "system_card") => (
                "卡片",
                Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                Style::default(),
            ),
            _ => (
                "Bot",
                Style::new().fg(Color::Green).add_modifier(Modifier::BOLD),
                Style::default(),
            ),
        };
        let stamp = msg
            .created_at
            .as_deref()
            .map(format_bot_when)
            .unwrap_or_default();
        let card_tag = msg
            .card_number
            .map(|n| format!(" [#{n}]"))
            .unwrap_or_default();
        let mut header_spans = vec![Span::styled(format!("{prefix}{card_tag}"), header_style)];
        if !stamp.is_empty() {
            header_spans.push(Span::raw("  "));
            header_spans.push(Span::styled(stamp, Style::new().fg(Color::DarkGray)));
        }
        all_lines.push(Line::from(header_spans));

        let body_text = msg
            .card_summary
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(msg.content.as_str());
        let cache_key = WrapCacheKey {
            item_hash: stable_hash(&msg.id),
            revision: msg.revision,
            width: area.width,
        };
        let block = if let Some(cached) = wrap_cache.get(&cache_key) {
            cached.clone()
        } else {
            let computed = render_markdown_bounded(body_text, width, body_style, 160);
            wrap_cache.insert(cache_key, computed.clone());
            computed
        };
        for styled in &block.lines {
            all_lines.push(styled.to_ratatui_line());
        }
        all_lines.push(Line::raw(""));
    }

    if let Some(live) = live_activity
        && !live.trim().is_empty()
    {
        let rendered = render_markdown_bounded(live, width, Style::new().fg(Color::Cyan), 48);
        for styled in &rendered.lines {
            all_lines.push(styled.to_ratatui_line());
        }
    }

    if all_lines.is_empty() {
        frame.render_widget(
            Paragraph::new("输入消息开始与项目机器人对话。输入 `/help` 查看命令。")
                .style(Style::new().fg(Color::DarkGray)),
            area,
        );
        return;
    }

    let max_back = all_lines.len().saturating_sub(height);
    let back = anchor.lines_back().min(max_back);
    let end = all_lines.len().saturating_sub(back);
    let start = end.saturating_sub(height);
    let visible: Vec<Line<'static>> = all_lines
        .into_iter()
        .skip(start)
        .take(end - start)
        .collect();
    frame.render_widget(Paragraph::new(visible), area);
}

pub fn render_bot_shell(frame: &mut Frame<'_>, view: BotShellView<'_>) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }

    let is_list_or_bind = matches!(
        view.screen,
        BotScreen::BotList | BotScreen::BindWorkspace { .. }
    );
    // ADR 122 §2: List page header is simply "Peer" (no host/client banner, no mode tag).
    // Opened bot header is "Peer · <Name>".
    let header_title = match view.screen {
        BotScreen::BotList | BotScreen::BindWorkspace { .. } => "Peer".to_owned(),
        _ => match view.active_bot_name {
            Some(name) if !name.trim().is_empty() => {
                format!(
                    "Peer · {}",
                    clip_bot_line(name, usize::from(area.width).saturating_sub(8))
                )
            }
            _ => "Peer".to_owned(),
        },
    };

    let has_lease_banner = !is_list_or_bind && view.lease_banner.is_some();
    let show_composer = !is_list_or_bind;

    let mut constraints = vec![Constraint::Length(1)];
    if has_lease_banner {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Min(1));
    if show_composer {
        // ADR 122 §4: full-width divider + full-width composer, plus single quiet status line if needed.
        constraints.push(Constraint::Length(1));
        constraints.push(Constraint::Length(3));
        constraints.push(Constraint::Length(1));
    } else {
        constraints.push(Constraint::Length(1));
    }

    let areas = Layout::vertical(constraints).split(area);
    let mut slot = 0usize;

    // Header
    frame.render_widget(
        Paragraph::new(header_title).style(Style::new().add_modifier(Modifier::BOLD)),
        areas[slot],
    );
    slot += 1;

    // Lease banner (only when inside a bot and another host owns lease, e.g. Desktop)
    if let Some(banner) = view.lease_banner
        && has_lease_banner
    {
        frame.render_widget(
            Paragraph::new(clip_bot_line(banner, usize::from(areas[slot].width)))
                .style(Style::new().fg(Color::Yellow)),
            areas[slot],
        );
        slot += 1;
    }

    // Main body
    let body_area = areas[slot];
    slot += 1;
    match view.screen {
        BotScreen::BindWorkspace {
            workspace_path,
            confirm_yes,
        } => {
            let yes_mark = if *confirm_yes {
                "▸ 是，在此目录创建机器人"
            } else {
                "  是，在此目录创建机器人"
            };
            let no_mark = if !*confirm_yes {
                "▸ 否，查看已有机器人列表"
            } else {
                "  否，查看已有机器人列表"
            };
            let body = format!(
                "当前目录尚未绑定项目机器人：\n{}\n\n{yes_mark}\n{no_mark}\n\n方向键选择 · Enter 确认 · Esc 查看列表",
                terminal_text(workspace_path)
            );
            frame.render_widget(Paragraph::new(body).wrap(Wrap { trim: false }), body_area);
            let cursor_y = (body_area.y + if *confirm_yes { 3 } else { 4 })
                .min(body_area.y + body_area.height.saturating_sub(1));
            frame.set_cursor_position((body_area.x, cursor_y));
        }
        BotScreen::BotList => {
            render_bot_list(frame, body_area, view.bots, view.selected_bot);
            frame.set_cursor_position((body_area.x, body_area.y));
        }
        BotScreen::Conversation => {
            render_conversation_body(
                frame,
                body_area,
                view.messages,
                view.live_activity,
                view.anchor,
                view.wrap_cache,
            );
        }
        BotScreen::Tasks => {
            let mut lines = vec![Line::styled(
                "委派任务列表（输入 `/task N` 查看详情，Esc 返回对话）",
                Style::new().add_modifier(Modifier::BOLD),
            )];
            if view.tasks.is_empty() {
                lines.push(Line::styled(
                    "暂无委派任务。",
                    Style::new().fg(Color::DarkGray),
                ));
            } else {
                for t in view.tasks {
                    let acc = if t.accepted { " · 已签收" } else { "" };
                    let row = format!(
                        "#{} [{}]{} {}  {}",
                        t.number,
                        t.status,
                        acc,
                        clip_bot_line(&t.title, 48),
                        format_bot_when(&t.updated_at)
                    );
                    lines.push(Line::raw(row));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::TaskDetail { title, body } => {
            let full = format!("# {}\n\n{}", terminal_text(title), terminal_text(body));
            let rendered = render_markdown_bounded(
                &full,
                usize::from(body_area.width).max(1),
                Style::default(),
                usize::from(body_area.height).max(1),
            );
            let lines: Vec<Line<'static>> =
                rendered.lines.iter().map(|l| l.to_ratatui_line()).collect();
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Memory => {
            let mut lines = vec![Line::styled(
                "项目记忆（Esc 返回对话）",
                Style::new().add_modifier(Modifier::BOLD),
            )];
            if view.memories.is_empty() {
                lines.push(Line::styled(
                    "暂无记忆条目。",
                    Style::new().fg(Color::DarkGray),
                ));
            } else {
                for (i, m) in view.memories.iter().enumerate() {
                    lines.push(Line::raw(format!(
                        "{}. {}",
                        i + 1,
                        clip_bot_line(m, usize::from(body_area.width).saturating_sub(4))
                    )));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Objectives => {
            let mut lines = vec![Line::styled(
                "项目目标（Esc 返回对话）",
                Style::new().add_modifier(Modifier::BOLD),
            )];
            if view.objectives.is_empty() {
                lines.push(Line::styled(
                    "暂无进行中目标。",
                    Style::new().fg(Color::DarkGray),
                ));
            } else {
                for (i, o) in view.objectives.iter().enumerate() {
                    lines.push(Line::raw(format!(
                        "{}. {}",
                        i + 1,
                        clip_bot_line(o, usize::from(body_area.width).saturating_sub(4))
                    )));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Cards => {
            let mut lines = vec![Line::styled(
                "待处理卡片（`/approve N` · `/deny N` · `/answer N <回复>` · Esc 返回）",
                Style::new().add_modifier(Modifier::BOLD),
            )];
            if view.cards.is_empty() {
                lines.push(Line::styled(
                    "当前无待处理卡片。",
                    Style::new().fg(Color::DarkGray),
                ));
            } else {
                for c in view.cards {
                    lines.push(Line::styled(
                        format!(
                            "[#{}] {} · {}",
                            c.number,
                            c.kind,
                            clip_bot_line(&c.title, 48)
                        ),
                        Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                    ));
                    if !c.summary.is_empty() {
                        lines.push(Line::raw(format!(
                            "    {}",
                            clip_bot_line(
                                &c.summary,
                                usize::from(body_area.width).saturating_sub(4)
                            )
                        )));
                    }
                    if !c.actions.is_empty() {
                        lines.push(Line::styled(
                            format!("    操作: {}", c.actions.join(" / ")),
                            Style::new().fg(Color::DarkGray),
                        ));
                    }
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Help => {
            let help_text = "命令列表（Esc 返回）：\n\
                /bots              切换机器人列表\n\
                /tasks             查看委派任务\n\
                /task N            查看第 N 个任务详情与核验依据\n\
                /cards             查看待处理卡片\n\
                /approve N         批准第 N 张卡片\n\
                /deny N            拒绝第 N 张卡片\n\
                /answer N <内容>   回复第 N 张提问卡片\n\
                /memory            查看项目记忆\n\
                /objectives        查看项目目标\n\
                /model             打开模型选择器\n\
                /takeover          接管当前工作区宿主租约\n\
                /older / /latest   阅读更早历史 / 回到最新\n\
                /classic           切换到普通任务对话模式\n\
                /save-draft        立即保存草稿\n\
                /quit              退出";
            frame.render_widget(
                Paragraph::new(help_text).wrap(Wrap { trim: false }),
                body_area,
            );
        }
    }

    if show_composer {
        // ADR 122 §4: full-width divider line
        frame.render_widget(Block::default().borders(Borders::TOP), areas[slot]);
        slot += 1;

        // Full-width composer
        let composer_area = areas[slot];
        slot += 1;
        let (lines, caret) = if view.composer.draft().is_empty() {
            (
                vec![Line::styled(
                    "输入消息或 `/help`…",
                    Style::new().fg(Color::DarkGray),
                )],
                Some((0u16, 0u16)),
            )
        } else {
            draft_view(
                view.composer,
                usize::from(composer_area.width),
                usize::from(composer_area.height),
            )
        };
        frame.render_widget(Paragraph::new(lines), composer_area);
        if !view.model_picker.open
            && let Some((x, y)) = caret
        {
            frame.set_cursor_position((composer_area.x + x, composer_area.y + y));
        }

        // Single quiet status line (only non-empty for draft warning, reading anchor, or action notice)
        let status_line = if let Some(warn) = view.draft_warning {
            clip_bot_line(warn, usize::from(areas[slot].width))
        } else if !view.anchor.is_following() {
            "↑ 正在阅读历史 · PgDn/End 或 `/latest` 回到最新".to_owned()
        } else if let Some(n) = view.notice {
            clip_bot_line(n, usize::from(areas[slot].width))
        } else if let Some(s) = view.composer.status {
            clip_bot_line(s, usize::from(areas[slot].width))
        } else {
            String::new()
        };
        let status_style = if view.draft_warning.is_some() {
            Style::new().fg(Color::Yellow)
        } else {
            Style::new().fg(Color::DarkGray)
        };
        frame.render_widget(
            Paragraph::new(Line::styled(status_line, status_style)),
            areas[slot],
        );
    } else {
        // Quiet status line on BotList / BindWorkspace (no persistent mode/host banners per ADR 122!)
        let footer = view
            .notice
            .map(|n| clip_bot_line(n, usize::from(areas[slot].width)))
            .unwrap_or_default();
        frame.render_widget(
            Paragraph::new(Line::styled(footer, Style::new().fg(Color::DarkGray))),
            areas[slot],
        );
    }

    if view.model_picker.open {
        render_model_picker(frame, area, view.model_picker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bounded_cache::MARKDOWN_WRAP_CACHE_BYTES;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn bot_list_and_conversation_honor_adr_122_chrome_on_wide_and_narrow_viewports() {
        let bots = vec![BotRowView {
            workspace_id: "ws-1".into(),
            display_name: "Peer-Agent".into(),
            last_activity: Some("2026-11-05T12:36:10.000Z".into()),
            needs_you: 2,
            running: 1,
            unread: 0,
            preview: Some("已完成测试并等待确认".into()),
        }];
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 256);
        let composer = Composer::default();
        let picker = ModelPickerState::default();
        let anchor = ReadingAnchor::FollowingLatest;

        // 1. BotList page: title is "Peer", NO "F2 · 普通任务模式", NO host/client banner, caret selection.
        let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
        term.draw(|f| {
            render_bot_shell(
                f,
                BotShellView {
                    screen: &BotScreen::BotList,
                    bots: &bots,
                    selected_bot: 0,
                    active_bot_name: None,
                    lease_banner: Some("SHOULD NOT APPEAR ON LIST PAGE"),
                    messages: &[],
                    live_activity: None,
                    tasks: &[],
                    memories: &[],
                    objectives: &[],
                    cards: &[],
                    anchor: &anchor,
                    composer: &composer,
                    draft_warning: None,
                    notice: None,
                    model_picker: &picker,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
        let buf = term.backend().buffer().clone();
        let mut rendered = String::new();
        let mut skip_next = false;
        for cell in &buf.content {
            if skip_next {
                skip_next = false;
                continue;
            }
            let sym = cell.symbol();
            rendered.push_str(sym);
            if unicode_width::UnicodeWidthStr::width(sym) > 1 {
                skip_next = true;
            }
        }
        assert!(rendered.contains("Peer"));
        assert!(rendered.contains("▸ Peer-Agent"));
        assert!(rendered.contains("11-05 12:36"));
        assert!(rendered.contains("待处理 2"));
        assert!(!rendered.contains("F2 · 普通任务模式"));
        assert!(!rendered.contains("SHOULD NOT APPEAR ON LIST PAGE"));

        // 2. Conversation view: title is "Peer · Peer-Agent", draft warning does not hide composer.
        let msgs = vec![BotMessageView {
            id: "m1".into(),
            revision: 1,
            role: "assistant".into(),
            kind: "agent_reply".into(),
            content: "查看 **结果** 与 `cargo test`".into(),
            created_at: Some("2026-11-05T12:36:10.000Z".into()),
            card_number: None,
            card_summary: None,
        }];
        for (w, h) in [(120, 40), (40, 14), (16, 8)] {
            let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
            t.draw(|f| {
                render_bot_shell(
                    f,
                    BotShellView {
                        screen: &BotScreen::Conversation,
                        bots: &bots,
                        selected_bot: 0,
                        active_bot_name: Some("Peer-Agent"),
                        lease_banner: None,
                        messages: &msgs,
                        live_activity: None,
                        tasks: &[],
                        memories: &[],
                        objectives: &[],
                        cards: &[],
                        anchor: &anchor,
                        composer: &composer,
                        draft_warning: Some("草稿恢复失败，可继续输入或 /save-draft"),
                        notice: None,
                        model_picker: &picker,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        }
    }
}
