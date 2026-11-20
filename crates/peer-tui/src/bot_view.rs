//! Pure Ratatui Bot-list & Bot-conversation shell views (ADR 122, ADR 84, ADR 85, ADR 130).
//!
//! Matches `apps/tui/src/project-agent/{ProjectApp,BotListView,BotConversationView,CardLine}.tsx`
//! and Peer Frost palette tokens while keeping all ADR 122 chrome guarantees:
//! - List header is `"Peer"` (no host/client banner on list page; no persistent `F2 · 普通任务模式`).
//! - Opened Bot header is `"Peer · <Name>"` with subtle host/client status on right.
//! - List rows use 3-line structure (name + right-aligned `MM-DD HH:mm`, `待处理 N    进行中 N`,
//!   clipped preview on its own line) + `› ` caret selection (no full-row background block).
//! - Full-width thin `─` divider above full-width `› ` composer.
//! - Draft recovery warning displays cleanly and never blocks typing.

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    commands::{clip_bot_line, format_bot_when},
    markdown::{
        LineLink, RenderedBlock, ScreenHyperlink, WrapCacheKey, project_line_links,
        render_markdown_themed, stable_hash, stamp_screen_link_id,
    },
    model_picker::{ModelPickerState, render_model_picker},
    overlays::{ClassicOverlay, OverlayContext, render_classic_overlay},
    slash_menu::{BOT_SLASH_ITEMS, GoalMenuStatus, filter_slash_items, render_slash_menu},
    terminal_text,
    theme::{
        CARET_IDLE, CARET_SELECTED, QUOTE_PREFIX, RUNNING_ACTIVITY_LABEL, SEPARATOR, ThemeMode,
        TuiLocale, TuiPalette, activity_sweep_color, fill_canvas,
    },
    view::draft_view_styled,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
};
use unicode_width::UnicodeWidthStr;

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
    pub reply_to_echo: Option<String>,
    pub marks: Vec<String>,
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
    pub palette: &'static TuiPalette,
    pub scheme_id: u8,
    pub current_theme: ThemeMode,
    pub locale: TuiLocale,
    pub is_host: bool,
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
    pub card_focus: bool,
    pub selected_card: usize,
    pub selected_card_option: usize,
    pub slash_selected: usize,
    pub animation_frame: usize,
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub draft_warning: Option<&'a str>,
    pub notice: Option<&'a str>,
    pub model_picker: &'a ModelPickerState,
    pub overlay: Option<&'a ClassicOverlay>,
    pub wrap_cache: &'a mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

fn project_status_label(locale: TuiLocale, status: &str) -> &str {
    let zh = locale.is_zh();
    match status {
        "running" => {
            if zh {
                "进行中"
            } else {
                "Running"
            }
        }
        "waiting_user" => {
            if zh {
                "等你回答"
            } else {
                "Waiting for you"
            }
        }
        "waiting_approval" => {
            if zh {
                "待批准"
            } else {
                "Waiting for approval"
            }
        }
        "accepted" => {
            if zh {
                "已签收"
            } else {
                "Accepted"
            }
        }
        "result_ready" => {
            if zh {
                "待签收"
            } else {
                "Ready to confirm"
            }
        }
        "queued" => {
            if zh {
                "排队中"
            } else {
                "Queued"
            }
        }
        "starting" => {
            if zh {
                "启动中"
            } else {
                "Starting"
            }
        }
        "verifying" => {
            if zh {
                "核验中"
            } else {
                "Verifying"
            }
        }
        "paused" => {
            if zh {
                "已暂停"
            } else {
                "Paused"
            }
        }
        "completed" => {
            if zh {
                "已完成"
            } else {
                "Completed"
            }
        }
        "failed" => {
            if zh {
                "失败"
            } else {
                "Failed"
            }
        }
        "cancelled" => {
            if zh {
                "已取消"
            } else {
                "Cancelled"
            }
        }
        _ => status,
    }
}

fn is_running_session_status(status: &str) -> bool {
    matches!(status, "queued" | "starting" | "running" | "verifying")
}

fn render_bot_running_bar(
    frame: &mut Frame<'_>,
    area: Rect,
    status_label: &str,
    animation_frame: usize,
    palette: &TuiPalette,
) {
    let rw = usize::from(area.width).max(1);
    let badge = "PEER / ACTIVE";
    let badge_w = badge.width();
    let activity = RUNNING_ACTIVITY_LABEL;
    let activity_chars = activity.chars().count();
    let show_badge = rw >= badge_w + 4;
    let left_budget = if show_badge {
        rw.saturating_sub(badge_w + 2)
    } else {
        rw
    };
    let mut spans: Vec<Span<'static>> = Vec::new();
    let mut left_w = 0usize;
    for (idx, ch) in activity.chars().enumerate() {
        let mut buf = [0u8; 4];
        let s = ch.encode_utf8(&mut buf);
        let cw = s.width();
        if left_w + cw > left_budget {
            break;
        }
        spans.push(Span::styled(
            s.to_owned(),
            Style::new()
                .fg(activity_sweep_color(
                    idx,
                    animation_frame,
                    activity_chars,
                    palette,
                ))
                .bg(palette.background),
        ));
        left_w += cw;
    }
    let clean_label = terminal_text(status_label);
    let suffix_budget = left_budget.saturating_sub(left_w);
    if !clean_label.is_empty() && suffix_budget >= 3 {
        spans.push(Span::styled("  ", Style::new().bg(palette.background)));
        let clipped = clip_bot_line(&clean_label, suffix_budget - 2);
        left_w += 2 + clipped.width();
        spans.push(Span::styled(
            clipped,
            Style::new().fg(palette.text_soft).bg(palette.background),
        ));
    }
    if show_badge {
        let gap = rw.saturating_sub(left_w + badge_w);
        if gap >= 2 {
            spans.push(Span::styled(
                " ".repeat(gap),
                Style::new().bg(palette.background),
            ));
            spans.push(Span::styled(
                "PEER",
                Style::new().fg(palette.subtle).bg(palette.background),
            ));
            spans.push(Span::styled(
                " / ACTIVE",
                Style::new().fg(palette.accent).bg(palette.background),
            ));
        }
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), area);
}

#[allow(clippy::too_many_arguments)]
fn push_card_lines(
    lines: &mut Vec<Line<'static>>,
    card: &BotCardRow,
    focused: bool,
    selected_option: usize,
    width: usize,
    palette: &TuiPalette,
    show_actions: bool,
) {
    let surface_bg = if focused {
        palette.selection
    } else {
        palette.panel
    };
    let header_text = if card.kind.trim().is_empty() {
        format!(
            " [{}] {}",
            card.number,
            clip_bot_line(&card.title, width.saturating_sub(8).max(12))
        )
    } else {
        format!(
            " [{}] {} · {}",
            card.number,
            card.kind,
            clip_bot_line(&card.title, width.saturating_sub(12).max(12))
        )
    };
    lines.push(Line::styled(
        header_text,
        Style::new()
            .fg(palette.warning)
            .bg(surface_bg)
            .add_modifier(Modifier::BOLD),
    ));
    if !card.summary.is_empty() {
        lines.push(Line::styled(
            format!(
                " {}",
                clip_bot_line(&card.summary, width.saturating_sub(3).max(8))
            ),
            Style::new().fg(palette.text_soft).bg(surface_bg),
        ));
    }
    if show_actions {
        for (idx, act) in card.actions.iter().enumerate() {
            let active_opt = focused && idx == selected_option;
            let caret = if active_opt {
                CARET_SELECTED
            } else {
                CARET_IDLE
            };
            let style = if active_opt {
                Style::new()
                    .fg(palette.accent)
                    .bg(surface_bg)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text_soft).bg(surface_bg)
            };
            lines.push(Line::styled(format!(" {caret}{}. {}", idx + 1, act), style));
        }
    }
    // In Conversation view, card actions stay on the composer row, not inside the card box.
}

fn render_bot_list(
    frame: &mut Frame<'_>,
    area: Rect,
    bots: &[BotRowView],
    selected: usize,
    palette: &TuiPalette,
    locale: TuiLocale,
) {
    let w = usize::from(area.width).max(1);
    let h = usize::from(area.height);
    if h < 3 {
        frame.set_cursor_position((area.x, area.y));
        return;
    }

    let chunks = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
    ])
    .split(area);

    // Top row: `机器人` (left) + count (right)
    let title_lbl = if locale.is_zh() { "机器人" } else { "Bots" };
    let count_str = bots.len().to_string();
    let gap = w.saturating_sub(title_lbl.width() + count_str.width());
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                title_lbl,
                Style::new().fg(palette.text).bg(palette.background),
            ),
            Span::styled(" ".repeat(gap), Style::new().bg(palette.background)),
            Span::styled(
                count_str,
                Style::new().fg(palette.muted).bg(palette.background),
            ),
        ])),
        chunks[0],
    );

    // Thin divider rule matching BotListView (`Math.min(inner, 72)`)
    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(w.min(72)),
            Style::new().fg(palette.border).bg(palette.background),
        )),
        chunks[1],
    );

    let list_area = chunks[2];
    if bots.is_empty() {
        frame.render_widget(
            Paragraph::new(
                "暂无已绑定的项目机器人。\n进入任意工作目录运行 `peer` 绑定，或按 `F2` / `/classic` 进入普通对话。",
            )
            .style(Style::new().fg(palette.muted).bg(palette.background))
            .wrap(Wrap { trim: false }),
            list_area,
        );
        frame.set_cursor_position((list_area.x, list_area.y));
    } else {
        // Exact BotListView 4-line cadence (meta row, counts row, preview row, blank row)
        let list_h = usize::from(list_area.height);
        let rows_per_bot = if list_h >= 8 { 4usize } else { 3usize };
        let visible_bots = (list_h / rows_per_bot).max(1);
        let start = selected.saturating_sub(visible_bots / 2);

        let mut lines: Vec<Line<'static>> = Vec::with_capacity(list_h);
        let mut cursor_y = list_area.y;
        for (idx, bot) in bots.iter().enumerate().skip(start).take(visible_bots) {
            let is_selected = idx == selected;
            if is_selected {
                cursor_y = list_area.y + lines.len() as u16;
            }
            let caret = if is_selected {
                CARET_SELECTED
            } else {
                CARET_IDLE
            };
            let when = bot
                .last_activity
                .as_deref()
                .map(format_bot_when)
                .unwrap_or_default();

            let name_budget = w.saturating_sub(when.width() + 4).max(6);
            let name = clip_bot_line(&bot.display_name, name_budget);
            let right_pad = w.saturating_sub(2 + name.width() + when.width());

            let name_style = if is_selected {
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text).bg(palette.background)
            };

            let mut row1 = vec![
                Span::styled(caret, name_style),
                Span::styled(name, name_style),
            ];
            if !when.is_empty() {
                row1.push(Span::styled(
                    " ".repeat(right_pad.max(1)),
                    Style::new().bg(palette.background),
                ));
                row1.push(Span::styled(
                    when,
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            }
            lines.push(Line::from(row1));

            // Row 2: independent counts line (`  待处理 N    进行中 N`)
            let count_style = if bot.needs_you > 0 {
                Style::new().fg(palette.warning).bg(palette.background)
            } else if bot.running > 0 {
                Style::new().fg(palette.info).bg(palette.background)
            } else {
                Style::new().fg(palette.muted).bg(palette.background)
            };
            let counts_line = format!("  待处理 {}    进行中 {}", bot.needs_you, bot.running);
            lines.push(Line::styled(clip_bot_line(&counts_line, w), count_style));

            // Row 3: preview on its OWN clipped line (ADR 122 §1)
            let preview_text = bot
                .preview
                .as_deref()
                .map(|p| clip_bot_line(p, w.saturating_sub(2)))
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| "暂无消息".to_owned());
            let preview_style = if bot.preview.is_some() {
                Style::new().fg(palette.text_soft).bg(palette.background)
            } else {
                Style::new().fg(palette.muted).bg(palette.background)
            };
            lines.push(Line::styled(format!("  {preview_text}"), preview_style));

            if rows_per_bot == 4 {
                lines.push(Line::styled("", Style::new().bg(palette.background)));
            }
        }
        frame.render_widget(Paragraph::new(lines), list_area);
        let cy = cursor_y.min(list_area.y + list_area.height.saturating_sub(1));
        frame.set_cursor_position((list_area.x, cy));
    }

    // Bottom quiet hint line separated cleanly
    let hint = if locale.is_zh() {
        "上下键选择 · 回车打开 · Esc 返回"
    } else {
        "Up/down to select · Enter to open · Esc to return"
    };
    frame.render_widget(
        Paragraph::new(Line::styled(
            clip_bot_line(hint, w),
            Style::new().fg(palette.muted).bg(palette.background),
        )),
        chunks[3],
    );
}

#[allow(clippy::too_many_arguments)]
fn render_conversation_body(
    frame: &mut Frame<'_>,
    area: Rect,
    messages: &[BotMessageView],
    cards: &[BotCardRow],
    tasks: &[BotTaskRow],
    card_focus: bool,
    selected_card: usize,
    selected_option: usize,
    live_activity: Option<&str>,
    anchor: &ReadingAnchor,
    wrap_cache: &mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
    palette: &TuiPalette,
    scheme_id: u8,
    locale: TuiLocale,
    out_links: &mut Vec<ScreenHyperlink>,
) {
    let width = usize::from(area.width).max(1);
    let height = usize::from(area.height);
    if height == 0 {
        return;
    }

    let mut rendered_card_ids = Vec::new();
    let mut all_lines: Vec<(Line<'static>, Vec<LineLink>)> = Vec::new();
    let focused_card_num = cards.get(selected_card).map(|c| c.number);

    for (msg_idx, msg) in messages.iter().enumerate() {
        if msg.kind != "system_card" {
            let (prefix, header_style) = if msg.role == "user" {
                (
                    "你",
                    Style::new()
                        .fg(palette.user)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                )
            } else {
                (
                    "Bot",
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                )
            };
            let stamp = msg
                .created_at
                .as_deref()
                .map(format_bot_when)
                .unwrap_or_default();
            let mut header_spans = vec![Span::styled(prefix, header_style)];
            if !stamp.is_empty() {
                header_spans.push(Span::styled("  ", Style::new().bg(palette.background)));
                header_spans.push(Span::styled(
                    stamp,
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            }
            all_lines.push((Line::from(header_spans), Vec::new()));
        }

        if let Some(ref echo) = msg.reply_to_echo
            && !echo.is_empty()
        {
            all_lines.push((
                Line::from(vec![
                    Span::styled(
                        "回复: ",
                        Style::new().fg(palette.muted).bg(palette.background),
                    ),
                    Span::styled(
                        QUOTE_PREFIX,
                        Style::new().fg(palette.border_focus).bg(palette.background),
                    ),
                    Span::styled(
                        clip_bot_line(echo, width.saturating_sub(8).max(8)),
                        Style::new().fg(palette.text_soft).bg(palette.background),
                    ),
                ]),
                Vec::new(),
            ));
        }

        let body_text = msg
            .card_summary
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(msg.content.as_str());
        if !body_text.is_empty() && !(msg.kind == "system_card" && msg.card_number.is_some()) {
            let body_style = Style::new().fg(palette.text).bg(palette.background);
            let cache_key = WrapCacheKey {
                item_hash: stable_hash(&msg.id),
                revision: msg.revision,
                width: area.width,
                scheme: scheme_id,
            };
            let block = if let Some(cached) = wrap_cache.get(&cache_key) {
                cached.clone()
            } else {
                let computed = render_markdown_themed(body_text, width, body_style, 160, palette);
                wrap_cache.insert(cache_key, computed.clone());
                computed
            };
            let block_prefix =
                (cache_key.item_hash as u32) ^ ((msg_idx as u32).wrapping_add(1) << 12);
            for styled in &block.lines {
                let links = styled
                    .links
                    .iter()
                    .cloned()
                    .map(|mut link| {
                        link.id = stamp_screen_link_id(block_prefix, link.id);
                        link
                    })
                    .collect();
                all_lines.push((styled.to_ratatui_line(), links));
            }
        }

        if !msg.marks.is_empty() {
            all_lines.push((
                Line::styled(
                    format!("结果: {}", msg.marks.join(" · ")),
                    Style::new().fg(palette.success).bg(palette.background),
                ),
                Vec::new(),
            ));
        }

        if let Some(cnum) = msg.card_number
            && let Some(card) = cards.iter().find(|c| c.number == cnum)
        {
            rendered_card_ids.push(cnum);
            let is_focused = card_focus && focused_card_num == Some(cnum);
            let mut card_lines = Vec::new();
            push_card_lines(
                &mut card_lines,
                card,
                is_focused,
                selected_option,
                width,
                palette,
                false,
            );
            for line in card_lines {
                all_lines.push((line, Vec::new()));
            }
        } else if let Some(cnum) = msg.card_number {
            all_lines.push((
                Line::styled(
                    format!("卡片 [#{cnum}]"),
                    Style::new().fg(palette.warning).bg(palette.background),
                ),
                Vec::new(),
            ));
        }

        all_lines.push((
            Line::styled("", Style::new().bg(palette.background)),
            Vec::new(),
        ));
    }

    // Any remaining active cards not directly attached to a visible message
    for card in cards {
        if !rendered_card_ids.contains(&card.number) {
            let is_focused = card_focus && focused_card_num == Some(card.number);
            let mut card_lines = Vec::new();
            push_card_lines(
                &mut card_lines,
                card,
                is_focused,
                selected_option,
                width,
                palette,
                false,
            );
            for line in card_lines {
                all_lines.push((line, Vec::new()));
            }
            all_lines.push((
                Line::styled("", Style::new().bg(palette.background)),
                Vec::new(),
            ));
        }
    }

    if !tasks.is_empty() {
        if !all_lines.is_empty() && all_lines.last().is_some_and(|(line, _)| line.width() > 0) {
            all_lines.push((
                Line::styled("", Style::new().bg(palette.background)),
                Vec::new(),
            ));
        }
        for task in tasks {
            let glyph = match task.status.as_str() {
                "running" => '›',
                "completed" | "accepted" => '✓',
                "failed" => '×',
                _ => '·',
            };
            let fg = match task.status.as_str() {
                "failed" => palette.danger,
                "completed" | "accepted" => palette.success,
                _ => palette.text_soft,
            };
            let raw_title = if task.title.trim().is_empty() {
                task.session_id.as_str()
            } else {
                task.title.as_str()
            };
            let clean_title = terminal_text(raw_title);
            let status_label = project_status_label(locale, &task.status);
            let row_text = clip_bot_line(&format!("{glyph} {clean_title} · {status_label}"), width);
            all_lines.push((
                Line::styled(row_text, Style::new().fg(fg).bg(palette.background)),
                Vec::new(),
            ));
        }
    }

    if let Some(live) = live_activity
        && !live.trim().is_empty()
    {
        let rendered = render_markdown_themed(
            live,
            width,
            Style::new().fg(palette.info).bg(palette.background),
            48,
            palette,
        );
        for styled in &rendered.lines {
            let links = styled
                .links
                .iter()
                .cloned()
                .map(|mut link| {
                    link.id = stamp_screen_link_id(0x000f_fffd, link.id);
                    link
                })
                .collect();
            all_lines.push((styled.to_ratatui_line(), links));
        }
    }

    if all_lines.is_empty() {
        let empty_text = if locale.is_zh() {
            "这里暂时没有内容"
        } else {
            "Nothing here yet"
        };
        frame.render_widget(
            Paragraph::new(empty_text).style(Style::new().fg(palette.muted).bg(palette.background)),
            area,
        );
        return;
    }

    let max_back = all_lines.len().saturating_sub(height);
    let back = anchor.lines_back().min(max_back);
    let end = all_lines.len().saturating_sub(back);
    let start = end.saturating_sub(height);
    let visible_slice: Vec<(Line<'static>, Vec<LineLink>)> = all_lines
        .into_iter()
        .skip(start)
        .take(end - start)
        .collect();
    let mut visible: Vec<Line<'static>> = Vec::with_capacity(visible_slice.len());
    for (vis_row, (line, links)) in visible_slice.into_iter().enumerate() {
        project_line_links(&links, area, vis_row, out_links);
        visible.push(line);
    }
    frame.render_widget(Paragraph::new(visible), area);
}

pub fn render_bot_shell(frame: &mut Frame<'_>, view: BotShellView<'_>) {
    let mut ignored = Vec::new();
    render_bot_shell_with_links(frame, view, &mut ignored);
}

pub fn render_bot_shell_with_links(
    frame: &mut Frame<'_>,
    view: BotShellView<'_>,
    out_links: &mut Vec<ScreenHyperlink>,
) {
    out_links.clear();
    let full_area = frame.area();
    if full_area.width == 0 || full_area.height == 0 {
        return;
    }
    let palette = view.palette;
    fill_canvas(frame, full_area, palette.background);

    // Match ProjectApp outer padding=1 when viewport allows
    let pad: u16 = if full_area.width >= 16 && full_area.height >= 10 {
        1
    } else {
        0
    };
    let area = Rect {
        x: full_area.x + pad,
        y: full_area.y + pad,
        width: full_area.width.saturating_sub(pad * 2),
        height: full_area.height.saturating_sub(pad * 2),
    };
    if area.width == 0 || area.height == 0 {
        frame.set_cursor_position((full_area.x, full_area.y));
        return;
    }

    if let BotScreen::BindWorkspace {
        workspace_path,
        confirm_yes,
    } = view.screen
    {
        // Centered Frost bind prompt matching ProjectApp.tsx:193-205 & project-copy.ts:13-15,43-45
        let zh = view.locale.is_zh();
        let w = usize::from(area.width);
        let h = usize::from(area.height);
        let yes_style = if *confirm_yes {
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.muted).bg(palette.background)
        };
        let no_style = if !*confirm_yes {
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.muted).bg(palette.background)
        };
        let ws_clean = clip_bot_line(workspace_path, w.saturating_sub(4).max(8));
        let yes_txt = format!(
            "{}{}  Y",
            if *confirm_yes {
                CARET_SELECTED
            } else {
                CARET_IDLE
            },
            if zh {
                "是，创建机器人"
            } else {
                "Yes, create a bot"
            }
        );
        let no_txt = format!(
            "{}{}  N",
            if !*confirm_yes {
                CARET_SELECTED
            } else {
                CARET_IDLE
            },
            if zh {
                "否，进入普通任务模式"
            } else {
                "No, open task mode"
            }
        );
        let horizontal = yes_txt.width() + 3 + no_txt.width() <= w.saturating_sub(4);
        let mut lines = vec![
            Line::styled(
                if zh {
                    "Peer · 机器人模式"
                } else {
                    "Peer · Bot mode"
                },
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            ),
            Line::styled("", Style::new().bg(palette.background)),
            Line::styled(
                if zh {
                    "把这个目录绑定为机器人？"
                } else {
                    "Bind this directory to a bot?"
                },
                Style::new().fg(palette.text).bg(palette.background),
            ),
            Line::styled(
                ws_clean,
                Style::new().fg(palette.muted).bg(palette.background),
            ),
            Line::styled("", Style::new().bg(palette.background)),
        ];
        let options_start_row = lines.len() as u16;
        if horizontal {
            lines.push(Line::from(vec![
                Span::styled(yes_txt.clone(), yes_style),
                Span::styled("   ", Style::new().bg(palette.background)),
                Span::styled(no_txt, no_style),
            ]));
        } else {
            lines.push(Line::styled(yes_txt.clone(), yes_style));
            lines.push(Line::styled(no_txt, no_style));
        }
        if let Some(msg) = view.notice.filter(|s| !s.is_empty()) {
            lines.push(Line::styled(
                clip_bot_line(&terminal_text(msg), w.saturating_sub(4).max(8)),
                Style::new().fg(palette.warning).bg(palette.background),
            ));
        }
        lines.push(Line::styled("", Style::new().bg(palette.background)));
        lines.push(Line::styled(
            clip_bot_line(
                if zh {
                    "←/→ 选择 · 回车确认 · Esc 进入普通任务模式"
                } else {
                    "←/→ to choose · Enter to confirm · Esc for task mode"
                },
                w.saturating_sub(4).max(8),
            ),
            Style::new().fg(palette.muted).bg(palette.background),
        ));
        let content_w = lines.iter().map(|l| l.width()).max().unwrap_or(1).min(w) as u16;
        let top_pad = h.saturating_sub(lines.len()) / 2;
        let left_pad = w.saturating_sub(usize::from(content_w)) / 2;
        let bind_rect = Rect {
            x: area.x + left_pad as u16,
            y: area.y + top_pad as u16,
            width: area.width.saturating_sub(left_pad as u16),
            height: area.height.saturating_sub(top_pad as u16),
        };
        frame.render_widget(Paragraph::new(lines).wrap(Wrap { trim: false }), bind_rect);
        let (cursor_dx, cursor_dy) = if horizontal {
            let dx = if *confirm_yes {
                0u16
            } else {
                (yes_txt.width() + 3) as u16
            };
            (dx, options_start_row)
        } else {
            (0u16, options_start_row + u16::from(!*confirm_yes))
        };
        let cy = (bind_rect.y + cursor_dy).min(full_area.y + full_area.height - 1);
        let cx = (bind_rect.x + cursor_dx).min(full_area.x + full_area.width - 1);
        frame.set_cursor_position((cx, cy));
        return;
    }

    let is_list = matches!(view.screen, BotScreen::BotList);
    let has_lease_banner = !is_list && view.lease_banner.is_some();
    let show_composer = !is_list;
    let active_dock = view
        .overlay
        .filter(|ov| show_composer && ov.is_open() && !ov.is_modal() && !view.model_picker.open);
    let dock_h = active_dock.map_or(0, |ov| ov.dock_height(area.height.saturating_sub(8)));
    let draft = view.composer.draft();
    let slash_open = show_composer
        && !view.model_picker.open
        && active_dock.is_none()
        && draft.starts_with('/')
        && !draft.contains(char::is_whitespace);
    let slash_items = if slash_open {
        filter_slash_items(draft, BOT_SLASH_ITEMS)
    } else {
        Vec::new()
    };
    let slash_rows = if !slash_open {
        0u16
    } else if slash_items.is_empty() {
        2u16
    } else {
        (slash_items.len().min(6) as u16) + 1
    };
    let transient_status: Option<(String, Color)> = if let Some(warn) = view.draft_warning {
        Some((warn.to_owned(), palette.warning))
    } else if !view.anchor.is_following() {
        Some((
            if view.locale.is_zh() {
                "↑ 正在阅读历史 · PgDn/End 或 `/latest` 回到最新".to_owned()
            } else {
                "↑ Reading history · PgDn/End or `/latest` for latest".to_owned()
            },
            palette.info,
        ))
    } else if let Some(n) = view.notice.filter(|s| !s.is_empty()) {
        Some((n.to_owned(), palette.info))
    } else {
        view.composer
            .status
            .filter(|s| !s.is_empty())
            .map(|s| (s.to_owned(), palette.info))
    };
    let running_bar_label: Option<String> = if show_composer && area.height >= 8 {
        view.tasks
            .iter()
            .find(|t| is_running_session_status(&t.status))
            .map(|t| {
                let name = if t.title.trim().is_empty() {
                    t.session_id.as_str()
                } else {
                    t.title.as_str()
                };
                format!(
                    "{} · {}",
                    terminal_text(name),
                    project_status_label(view.locale, &t.status)
                )
            })
    } else {
        None
    };

    let mut constraints = vec![Constraint::Length(1)];
    if has_lease_banner {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Min(1));
    if show_composer {
        if transient_status.is_some() {
            constraints.push(Constraint::Length(1)); // transient notice / draft warning / reading history
        }
        if dock_h > 0 && area.height >= 10 {
            constraints.push(Constraint::Length(dock_h));
        } else if slash_rows > 0 && area.height >= 10 {
            constraints.push(Constraint::Length(slash_rows));
        }
        if running_bar_label.is_some() {
            constraints.push(Constraint::Length(1)); // shared working... sweep bar
        }
        constraints.push(Constraint::Length(1)); // thin `─` divider
        constraints.push(Constraint::Length(3)); // `› ` full-width composer
    } else {
        constraints.push(Constraint::Length(1));
    }

    let areas = Layout::vertical(constraints).split(area);
    let mut slot = 0usize;

    // ADR 122 §2 Header: list page is simply "Peer" (no host/client banner, no mode tag).
    let header_area = areas[slot];
    let hw = usize::from(header_area.width).max(1);
    if is_list {
        frame.render_widget(
            Paragraph::new(Line::styled(
                "Peer",
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )),
            header_area,
        );
    } else {
        let title_str = match view.active_bot_name {
            Some(name) if !name.trim().is_empty() => {
                format!(
                    "Peer · {}",
                    clip_bot_line(name, hw.saturating_sub(24).max(6))
                )
            }
            _ => "Peer".to_owned(),
        };
        let right_label = if view.is_host {
            if view.locale.is_zh() {
                "由本终端运行"
            } else {
                "Running here"
            }
        } else if view.locale.is_zh() {
            "客户端 · 只读"
        } else {
            "Client · read-only"
        };
        let gap = hw.saturating_sub(title_str.width() + right_label.width());
        let mut spans = vec![Span::styled(
            title_str,
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
        )];
        if gap >= 2 {
            spans.push(Span::styled(
                " ".repeat(gap),
                Style::new().bg(palette.background),
            ));
            spans.push(Span::styled(
                right_label,
                Style::new().fg(palette.muted).bg(palette.background),
            ));
        }
        frame.render_widget(Paragraph::new(Line::from(spans)), header_area);
    }
    slot += 1;

    if let Some(banner) = view.lease_banner
        && has_lease_banner
    {
        frame.render_widget(
            Paragraph::new(Line::styled(
                clip_bot_line(banner, usize::from(areas[slot].width)),
                Style::new().fg(palette.warning).bg(palette.background),
            )),
            areas[slot],
        );
        slot += 1;
    }

    let body_area = areas[slot];
    slot += 1;
    match view.screen {
        BotScreen::BindWorkspace { .. } => unreachable!(),
        BotScreen::BotList => {
            render_bot_list(
                frame,
                body_area,
                view.bots,
                view.selected_bot,
                palette,
                view.locale,
            );
        }
        BotScreen::Conversation => {
            render_conversation_body(
                frame,
                body_area,
                view.messages,
                view.cards,
                view.tasks,
                view.card_focus,
                view.selected_card,
                view.selected_card_option,
                view.live_activity,
                view.anchor,
                view.wrap_cache,
                palette,
                view.scheme_id,
                view.locale,
                out_links,
            );
        }
        BotScreen::Tasks => {
            let mut lines = vec![Line::styled(
                "委派任务列表（输入 `/task N` 查看详情，Esc 返回对话）",
                Style::new()
                    .fg(palette.text_soft)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            if view.tasks.is_empty() {
                lines.push(Line::styled(
                    "暂无委派任务。",
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            } else {
                for t in view.tasks {
                    let acc = if t.accepted { " · 已签收" } else { "" };
                    let status_color = match t.status.as_str() {
                        "completed" | "accepted" => palette.success,
                        "failed" | "cancelled" => palette.danger,
                        "running" => palette.tool_running,
                        _ => palette.info,
                    };
                    lines.push(Line::from(vec![
                        Span::styled(
                            format!("{}. ", t.number),
                            Style::new().fg(palette.accent).bg(palette.background),
                        ),
                        Span::styled(
                            clip_bot_line(&t.title, 48),
                            Style::new().fg(palette.text).bg(palette.background),
                        ),
                        Span::styled(
                            format!(" · {}{acc}", t.status),
                            Style::new().fg(status_color).bg(palette.background),
                        ),
                        Span::styled(
                            format!("  {}", format_bot_when(&t.updated_at)),
                            Style::new().fg(palette.muted).bg(palette.background),
                        ),
                    ]));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::TaskDetail { title, body } => {
            let full = format!("# {}\n\n{}", terminal_text(title), terminal_text(body));
            let rendered = render_markdown_themed(
                &full,
                usize::from(body_area.width).max(1),
                Style::new().fg(palette.text).bg(palette.background),
                usize::from(body_area.height).max(1),
                palette,
            );
            let mut lines: Vec<Line<'static>> = Vec::with_capacity(rendered.lines.len());
            for (vis_row, styled) in rendered.lines.iter().enumerate() {
                let stamped: Vec<LineLink> = styled
                    .links
                    .iter()
                    .cloned()
                    .map(|mut link| {
                        link.id = stamp_screen_link_id(0x000f_fffc, link.id);
                        link
                    })
                    .collect();
                project_line_links(&stamped, body_area, vis_row, out_links);
                lines.push(styled.to_ratatui_line());
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Memory => {
            let mut lines = vec![Line::styled(
                "项目记忆（Esc 返回对话）",
                Style::new()
                    .fg(palette.text_soft)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            if view.memories.is_empty() {
                lines.push(Line::styled(
                    "暂无记忆条目。",
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            } else {
                for (i, m) in view.memories.iter().enumerate() {
                    lines.push(Line::styled(
                        format!(
                            "{}. {}",
                            i + 1,
                            clip_bot_line(m, usize::from(body_area.width).saturating_sub(4))
                        ),
                        Style::new().fg(palette.text).bg(palette.background),
                    ));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Objectives => {
            let mut lines = vec![Line::styled(
                "项目目标（Esc 返回对话）",
                Style::new()
                    .fg(palette.text_soft)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            if view.objectives.is_empty() {
                lines.push(Line::styled(
                    "暂无进行中目标。",
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            } else {
                for (i, o) in view.objectives.iter().enumerate() {
                    lines.push(Line::styled(
                        format!(
                            "{}. {}",
                            i + 1,
                            clip_bot_line(o, usize::from(body_area.width).saturating_sub(4))
                        ),
                        Style::new().fg(palette.text).bg(palette.background),
                    ));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Cards => {
            let cards_hdr = if view.locale.is_zh() {
                "待处理 · ↑↓选卡片 · ←→选按钮 · Enter 执行 · `/action N 选项` · `/approve N` · `/deny N` · Esc 返回"
            } else {
                "Needs you · Up/down card · Left/right option · Enter to act · /action N option · Esc back"
            };
            let mut lines = vec![Line::styled(
                clip_bot_line(cards_hdr, usize::from(body_area.width).max(1)),
                Style::new()
                    .fg(palette.text_soft)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )];
            if view.cards.is_empty() {
                lines.push(Line::styled(
                    "当前无待处理卡片。",
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            } else {
                for (idx, c) in view.cards.iter().enumerate() {
                    push_card_lines(
                        &mut lines,
                        c,
                        idx == view.selected_card,
                        view.selected_card_option,
                        usize::from(body_area.width).max(1),
                        palette,
                        true,
                    );
                    lines.push(Line::styled("", Style::new().bg(palette.background)));
                }
            }
            frame.render_widget(Paragraph::new(lines), body_area);
        }
        BotScreen::Help => {
            let help_text = "命令列表（Esc 返回）：\n\
                /bots              切换机器人列表\n\
                /tasks             查看委派任务\n\
                /task N            查看第 N 个任务详情与核验依据\n\
                /cards             查看待处理卡片（对话内 Tab 可直选卡片按钮）\n\
                /approve N         批准第 N 张卡片\n\
                /deny N            拒绝第 N 张卡片\n\
                /answer N <内容>   回复第 N 张提问卡片\n\
                /memory            查看项目记忆\n\
                /objectives        查看项目目标\n\
                /model             打开模型选择器 (F3)\n\
                /theme [mode]      打开主题选择器或切换 (dark / light / system)\n\
                /language [lang]   打开语言选择器或切换 (zh-CN / en-US)\n\
                /diagnostics       查看机器人诊断\n\
                /takeover          接管当前工作区宿主租约\n\
                /older / /latest   阅读更早历史 / 回到最新\n\
                /classic           切换到普通任务对话模式 (F2)\n\
                /save-draft        立即保存草稿\n\
                /version           显示版本\n\
                /quit              退出";
            frame.render_widget(
                Paragraph::new(help_text)
                    .style(Style::new().fg(palette.text_soft).bg(palette.background))
                    .wrap(Wrap { trim: false }),
                body_area,
            );
        }
    }

    if show_composer {
        if let Some((ref status_line, status_fg)) = transient_status {
            let status_area = areas[slot];
            let sw = usize::from(status_area.width);
            frame.render_widget(
                Paragraph::new(Line::styled(
                    clip_bot_line(status_line, sw),
                    Style::new().fg(status_fg).bg(palette.background),
                )),
                status_area,
            );
            slot += 1;
        }

        if let Some(ov) = active_dock
            && dock_h > 0
            && area.height >= 10
        {
            let ctx = OverlayContext {
                current_mode: "bot",
                current_access: "ask",
                current_theme: view.current_theme,
                current_locale: view.locale,
                fast_available: false,
                goal_status: GoalMenuStatus::None,
            };
            render_classic_overlay(frame, areas[slot], ov, &ctx, palette);
            slot += 1;
        } else if slash_rows > 0 && area.height >= 10 {
            if slash_items.is_empty() {
                let sw = usize::from(areas[slot].width).max(1);
                let invalid_hint = if view.locale.is_zh() {
                    "命令无效或卡片已过期。输入 / 查看命令。"
                } else {
                    "Invalid command or expired card. Type / for commands."
                };
                frame.render_widget(
                    Paragraph::new(vec![
                        Line::styled(
                            SEPARATOR.repeat(sw),
                            Style::new().fg(palette.subtle).bg(palette.background),
                        ),
                        Line::styled(
                            clip_bot_line(invalid_hint, sw),
                            Style::new().fg(palette.muted).bg(palette.background),
                        ),
                    ]),
                    areas[slot],
                );
            } else {
                render_slash_menu(
                    frame,
                    areas[slot],
                    &slash_items,
                    view.slash_selected,
                    view.locale,
                    palette,
                );
            }
            slot += 1;
        }

        if let Some(ref bar_label) = running_bar_label {
            render_bot_running_bar(frame, areas[slot], bar_label, view.animation_frame, palette);
            slot += 1;
        }

        // ADR 122 §4: crisp full-width hairline divider (`─`)
        let div_w = usize::from(areas[slot].width);
        frame.render_widget(
            Paragraph::new(Line::styled(
                SEPARATOR.repeat(div_w),
                Style::new().fg(palette.subtle).bg(palette.background),
            )),
            areas[slot],
        );
        slot += 1;

        // Composer row: left Frost accent caret `› ` + full-width input
        let composer_area = areas[slot];
        if composer_area.width >= 4 {
            let cols = Layout::horizontal([Constraint::Length(2), Constraint::Min(1)])
                .split(composer_area);
            frame.render_widget(
                Paragraph::new(Line::styled(
                    CARET_SELECTED,
                    Style::new().fg(palette.accent).bg(palette.background),
                )),
                cols[0],
            );
            let input_area = cols[1];
            let (lines, caret) = if view.composer.draft().is_empty() {
                let focused_action = (matches!(view.screen, BotScreen::Conversation)
                    && view.card_focus)
                    .then(|| {
                        view.cards.get(view.selected_card).and_then(|c| {
                            (!c.actions.is_empty()).then(|| {
                                c.actions[view.selected_card_option.min(c.actions.len() - 1)]
                                    .as_str()
                            })
                        })
                    })
                    .flatten();
                let placeholder = focused_action.unwrap_or(if view.locale.is_zh() {
                    "跟机器人说话"
                } else {
                    "Message this bot"
                });
                (
                    vec![Line::styled(
                        clip_bot_line(&terminal_text(placeholder), usize::from(input_area.width)),
                        Style::new()
                            .fg(palette.input_placeholder)
                            .bg(palette.input_bg),
                    )],
                    Some((0u16, 0u16)),
                )
            } else {
                draft_view_styled(
                    view.composer,
                    usize::from(input_area.width),
                    usize::from(input_area.height),
                    Style::new().fg(palette.input_fg).bg(palette.input_bg),
                )
            };
            frame.render_widget(Paragraph::new(lines), input_area);
            if !view.model_picker.open
                && !view.card_focus
                && active_dock.is_none()
                && let Some((x, y)) = caret
            {
                frame.set_cursor_position((
                    (input_area.x + x).min(full_area.x + full_area.width - 1),
                    (input_area.y + y).min(full_area.y + full_area.height - 1),
                ));
            } else {
                frame.set_cursor_position((input_area.x, input_area.y));
            }
        } else {
            frame.set_cursor_position((composer_area.x, composer_area.y));
        }
    } else if !is_list {
        frame.set_cursor_position((area.x, area.y));
    }

    if view.model_picker.open {
        out_links.clear();
        render_model_picker(frame, full_area, view.model_picker, palette);
    }
    if active_dock.is_some_and(|ov| ov.is_modal()) {
        out_links.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bounded_cache::MARKDOWN_WRAP_CACHE_BYTES, theme::DARK_PALETTE};
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

        // 1. BotList page: title is "Peer", NO "F2 · 普通任务模式", NO host/client banner, `› ` caret selection.
        let mut term = Terminal::new(TestBackend::new(80, 20)).unwrap();
        term.draw(|f| {
            render_bot_shell(
                f,
                BotShellView {
                    screen: &BotScreen::BotList,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    is_host: true,
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
                    card_focus: false,
                    selected_card: 0,
                    selected_card_option: 0,
                    slash_selected: 0,
                    animation_frame: 0,
                    anchor: &anchor,
                    composer: &composer,
                    draft_warning: None,
                    notice: None,
                    model_picker: &picker,
                    overlay: None,
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
            if sym.width() > 1 {
                skip_next = true;
            }
        }
        assert!(rendered.contains("Peer"));
        assert!(rendered.contains("› Peer-Agent"));
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
            reply_to_echo: Some("先核验一下".into()),
            marks: vec!["验证通过".into()],
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
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        is_host: true,
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
                        card_focus: false,
                        selected_card: 0,
                        selected_card_option: 0,
                        slash_selected: 0,
                        animation_frame: 0,
                        anchor: &anchor,
                        composer: &composer,
                        draft_warning: Some("草稿恢复失败，可继续输入或 /save-draft"),
                        notice: None,
                        model_picker: &picker,
                        overlay: None,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        }
    }

    #[test]
    fn bind_workspace_prompt_matches_opentui_zh_and_en() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 128);
        let anchor = ReadingAnchor::FollowingLatest;
        let composer = Composer::default();
        let picker = ModelPickerState::default();
        let screen = BotScreen::BindWorkspace {
            workspace_path: "/tmp/demo-project".into(),
            confirm_yes: true,
        };

        for (locale, expected) in [
            (
                TuiLocale::ZhCn,
                [
                    "Peer · 机器人模式",
                    "把这个目录绑定为机器人？",
                    "是，创建机器人  Y",
                    "否，进入普通任务模式  N",
                    "←/→ 选择 · 回车确认 · Esc 进入普通任务模式",
                ],
            ),
            (
                TuiLocale::EnUs,
                [
                    "Peer · Bot mode",
                    "Bind this directory to a bot?",
                    "Yes, create a bot  Y",
                    "No, open task mode  N",
                    "←/→ to choose · Enter to confirm · Esc for task mode",
                ],
            ),
        ] {
            for (w, h) in [(120, 40), (32, 14)] {
                let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
                term.draw(|f| {
                    render_bot_shell(
                        f,
                        BotShellView {
                            screen: &screen,
                            palette: &DARK_PALETTE,
                            scheme_id: 0,
                            current_theme: ThemeMode::Dark,
                            locale,
                            is_host: true,
                            bots: &[],
                            selected_bot: 0,
                            active_bot_name: None,
                            lease_banner: None,
                            messages: &[],
                            live_activity: None,
                            tasks: &[],
                            memories: &[],
                            objectives: &[],
                            cards: &[],
                            card_focus: false,
                            selected_card: 0,
                            selected_card_option: 0,
                            slash_selected: 0,
                            animation_frame: 0,
                            anchor: &anchor,
                            composer: &composer,
                            draft_warning: None,
                            notice: None,
                            model_picker: &picker,
                            overlay: None,
                            wrap_cache: &mut cache,
                        },
                    );
                })
                .unwrap();
                if w == 120 {
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
                        if sym.width() > 1 {
                            skip_next = true;
                        }
                    }
                    for needle in expected {
                        assert!(
                            rendered.contains(needle),
                            "missing {needle:?} in bind screen ({locale:?})"
                        );
                    }
                }
            }
        }
    }

    fn buffer_text(term: &Terminal<TestBackend>) -> String {
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
            if sym.width() > 1 {
                skip_next = true;
            }
        }
        rendered
    }

    #[test]
    fn bot_conversation_keeps_actions_in_composer_placeholder() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 128);
        let anchor = ReadingAnchor::FollowingLatest;
        let composer = Composer::default();
        let picker = ModelPickerState::default();

        let render_with = |cache: &mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
                           locale: TuiLocale,
                           card_focus: bool,
                           selected_option: usize,
                           multi_action: bool|
         -> String {
            let zh = locale.is_zh();
            let actions = if multi_action {
                vec![
                    if zh { "批准" } else { "Approve" }.into(),
                    if zh { "拒绝" } else { "Deny" }.into(),
                ]
            } else {
                vec![
                    if zh {
                        "先熟悉一下项目"
                    } else {
                        "Familiarize with project"
                    }
                    .into(),
                ]
            };
            let cards = vec![BotCardRow {
                number: 1,
                card_id: "offer:familiarize:ws-demo".into(),
                kind: String::new(),
                title: if zh {
                    "要我先熟悉一下这个项目吗？"
                } else {
                    "Shall I familiarize myself with this project?"
                }
                .into(),
                summary: String::new(),
                actions,
            }];
            let mut term = Terminal::new(TestBackend::new(100, 24)).unwrap();
            term.draw(|f| {
                render_bot_shell(
                    f,
                    BotShellView {
                        screen: &BotScreen::Conversation,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale,
                        is_host: true,
                        bots: &[],
                        selected_bot: 0,
                        active_bot_name: Some("peer-dev"),
                        lease_banner: None,
                        messages: &[],
                        live_activity: None,
                        tasks: &[],
                        memories: &[],
                        objectives: &[],
                        cards: &cards,
                        card_focus,
                        selected_card: 0,
                        selected_card_option: selected_option,
                        slash_selected: 0,
                        animation_frame: 0,
                        anchor: &anchor,
                        composer: &composer,
                        draft_warning: None,
                        notice: None,
                        model_picker: &picker,
                        overlay: None,
                        wrap_cache: cache,
                    },
                );
            })
            .unwrap();
            buffer_text(&term)
        };

        let zh_idle = render_with(&mut cache, TuiLocale::ZhCn, false, 0, false);
        assert!(zh_idle.contains("[1] 要我先熟悉一下这个项目吗？"));
        assert!(zh_idle.contains("跟机器人说话"));
        assert!(!zh_idle.contains("1. 先熟悉一下项目"));
        assert!(!zh_idle.contains("跟机器人说话，或输入 /help"));
        assert!(!zh_idle.contains("Tab 选择卡片"));
        assert!(!zh_idle.contains("F2 · 普通任务模式"));

        let zh_focus = render_with(&mut cache, TuiLocale::ZhCn, true, 0, false);
        assert!(zh_focus.contains("先熟悉一下项目"));
        assert!(!zh_focus.contains("1. 先熟悉一下项目"));
        assert!(!zh_focus.contains("跟机器人说话"));
        assert!(!zh_focus.contains("Tab 选择卡片"));

        let zh_opt2 = render_with(&mut cache, TuiLocale::ZhCn, true, 1, true);
        assert!(zh_opt2.contains("拒绝"));
        assert!(!zh_opt2.contains("1. 批准"));
        assert!(!zh_opt2.contains("跟机器人说话"));

        let en_idle = render_with(&mut cache, TuiLocale::EnUs, false, 0, false);
        assert!(en_idle.contains("[1] Shall I familiarize myself with this project?"));
        assert!(en_idle.contains("Message this bot"));
        assert!(!en_idle.contains("1. Familiarize with project"));
        assert!(!en_idle.contains("Message this bot, or /help"));
        assert!(!en_idle.contains("Tab to select cards"));

        let en_focus = render_with(&mut cache, TuiLocale::EnUs, true, 0, false);
        assert!(en_focus.contains("Familiarize with project"));
        assert!(!en_focus.contains("1. Familiarize with project"));
        assert!(!en_focus.contains("Message this bot"));
    }

    #[test]
    fn bot_conversation_renders_inline_sessions_working_bar_slash_invalid_and_cards_actions() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 128);
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let tasks = vec![
            BotTaskRow {
                number: 1,
                session_id: "s-run".into(),
                title: "运行中任务".into(),
                status: "running".into(),
                accepted: false,
                updated_at: String::new(),
            },
            BotTaskRow {
                number: 2,
                session_id: "s-done".into(),
                title: "已完成任务".into(),
                status: "completed".into(),
                accepted: true,
                updated_at: String::new(),
            },
            BotTaskRow {
                number: 3,
                session_id: "s-fail".into(),
                title: "失败任务".into(),
                status: "failed".into(),
                accepted: false,
                updated_at: String::new(),
            },
        ];

        let composer_empty = Composer::default();
        let mut term = Terminal::new(TestBackend::new(100, 24)).unwrap();
        term.draw(|f| {
            render_bot_shell(
                f,
                BotShellView {
                    screen: &BotScreen::Conversation,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    is_host: true,
                    bots: &[],
                    selected_bot: 0,
                    active_bot_name: Some("peer-dev"),
                    lease_banner: None,
                    messages: &[],
                    live_activity: None,
                    tasks: &tasks,
                    memories: &[],
                    objectives: &[],
                    cards: &[],
                    card_focus: false,
                    selected_card: 0,
                    selected_card_option: 0,
                    slash_selected: 0,
                    animation_frame: 6,
                    anchor: &anchor,
                    composer: &composer_empty,
                    draft_warning: None,
                    notice: None,
                    model_picker: &picker,
                    overlay: None,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
        let with_tasks = buffer_text(&term);
        assert!(with_tasks.contains("› 运行中任务 · 进行中"));
        assert!(with_tasks.contains("✓ 已完成任务 · 已完成"));
        assert!(with_tasks.contains("× 失败任务 · 失败"));
        assert!(with_tasks.contains("working..."));
        assert!(with_tasks.contains("PEER / ACTIVE"));

        let mut composer_invalid = Composer::default();
        composer_invalid.apply(crate::Action::Insert("/nope".into()));
        let mut slash_term = Terminal::new(TestBackend::new(100, 24)).unwrap();
        slash_term
            .draw(|f| {
                render_bot_shell(
                    f,
                    BotShellView {
                        screen: &BotScreen::Conversation,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        is_host: true,
                        bots: &[],
                        selected_bot: 0,
                        active_bot_name: Some("peer-dev"),
                        lease_banner: None,
                        messages: &[],
                        live_activity: None,
                        tasks: &[],
                        memories: &[],
                        objectives: &[],
                        cards: &[],
                        card_focus: false,
                        selected_card: 0,
                        selected_card_option: 0,
                        slash_selected: 0,
                        animation_frame: 0,
                        anchor: &anchor,
                        composer: &composer_invalid,
                        draft_warning: None,
                        notice: None,
                        model_picker: &picker,
                        overlay: None,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let slash_out = buffer_text(&slash_term);
        assert!(slash_out.contains("输入 / 查看命令。"));

        let mut en_slash_term = Terminal::new(TestBackend::new(100, 24)).unwrap();
        en_slash_term
            .draw(|f| {
                render_bot_shell(
                    f,
                    BotShellView {
                        screen: &BotScreen::Conversation,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::EnUs,
                        is_host: true,
                        bots: &[],
                        selected_bot: 0,
                        active_bot_name: Some("peer-dev"),
                        lease_banner: None,
                        messages: &[],
                        live_activity: None,
                        tasks: &[],
                        memories: &[],
                        objectives: &[],
                        cards: &[],
                        card_focus: false,
                        selected_card: 0,
                        selected_card_option: 0,
                        slash_selected: 0,
                        animation_frame: 0,
                        anchor: &anchor,
                        composer: &composer_invalid,
                        draft_warning: None,
                        notice: None,
                        model_picker: &picker,
                        overlay: None,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        assert!(buffer_text(&en_slash_term).contains("Type / for commands."));

        // /cards screen still keeps numbered action rows inside the card list
        let cards = vec![BotCardRow {
            number: 1,
            card_id: "c1".into(),
            kind: "计划批准".into(),
            title: "计划审批".into(),
            summary: String::new(),
            actions: vec!["批准".into(), "拒绝".into()],
        }];
        let mut cards_term = Terminal::new(TestBackend::new(100, 24)).unwrap();
        cards_term
            .draw(|f| {
                render_bot_shell(
                    f,
                    BotShellView {
                        screen: &BotScreen::Cards,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        is_host: true,
                        bots: &[],
                        selected_bot: 0,
                        active_bot_name: Some("peer-dev"),
                        lease_banner: None,
                        messages: &[],
                        live_activity: None,
                        tasks: &[],
                        memories: &[],
                        objectives: &[],
                        cards: &cards,
                        card_focus: true,
                        selected_card: 0,
                        selected_card_option: 0,
                        slash_selected: 0,
                        animation_frame: 0,
                        anchor: &anchor,
                        composer: &composer_empty,
                        draft_warning: None,
                        notice: None,
                        model_picker: &picker,
                        overlay: None,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let cards_out = buffer_text(&cards_term);
        assert!(cards_out.contains("1. 批准"));
        assert!(cards_out.contains("2. 拒绝"));
    }

    #[test]
    fn bot_conversation_and_task_detail_project_screen_hyperlinks() {
        let mut term = Terminal::new(TestBackend::new(84, 16)).unwrap();
        let composer = Composer::default();
        let picker = ModelPickerState::default();
        let anchor = ReadingAnchor::default();
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 64);
        let doc_path = "/Users/yinliang/Documents/Develop/peer-dev/Peer-Knowledge/knowledge/decisions/133-unified-rust-core-and-dual-host-architecture.md";
        let msgs = vec![BotMessageView {
            id: "b1".into(),
            revision: 1,
            kind: "text".into(),
            role: "assistant".into(),
            content: format!("请查阅 `{doc_path}` 与 [Docs](https://example.com/docs)"),
            reply_to_echo: None,
            card_number: None,
            card_summary: None,
            marks: Vec::new(),
            created_at: None,
        }];

        let mut links = Vec::new();
        term.draw(|f| {
            render_bot_shell_with_links(
                f,
                BotShellView {
                    screen: &BotScreen::Conversation,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    is_host: true,
                    bots: &[],
                    selected_bot: 0,
                    active_bot_name: Some("peer-dev"),
                    lease_banner: None,
                    messages: &msgs,
                    live_activity: None,
                    tasks: &[],
                    memories: &[],
                    objectives: &[],
                    cards: &[],
                    card_focus: false,
                    selected_card: 0,
                    selected_card_option: 0,
                    slash_selected: 0,
                    animation_frame: 0,
                    anchor: &anchor,
                    composer: &composer,
                    draft_warning: None,
                    notice: None,
                    model_picker: &picker,
                    overlay: None,
                    wrap_cache: &mut cache,
                },
                &mut links,
            );
        })
        .unwrap();

        let buf = term.backend().buffer();
        let docs = links
            .iter()
            .find(|l| l.target == "https://example.com/docs")
            .expect("Docs link projected");
        let docs_text: String = (docs.col_start..docs.col_end)
            .map(|x| buf[(x, docs.row)].symbol())
            .collect();
        assert_eq!(docs_text, "Docs");

        let path_text: String = links
            .iter()
            .filter(|l| l.target == doc_path)
            .flat_map(|l| (l.col_start..l.col_end).map(move |x| buf[(x, l.row)].symbol()))
            .collect();
        assert_eq!(path_text, doc_path);

        // TaskDetail screen also projects links from Markdown body
        let detail = BotScreen::TaskDetail {
            title: "ADR 核验".into(),
            body: "证据见 `crates/peer-tui/src/bot_view.rs:42`".into(),
        };
        let mut detail_links = Vec::new();
        term.draw(|f| {
            render_bot_shell_with_links(
                f,
                BotShellView {
                    screen: &detail,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    is_host: true,
                    bots: &[],
                    selected_bot: 0,
                    active_bot_name: Some("peer-dev"),
                    lease_banner: None,
                    messages: &[],
                    live_activity: None,
                    tasks: &[],
                    memories: &[],
                    objectives: &[],
                    cards: &[],
                    card_focus: false,
                    selected_card: 0,
                    selected_card_option: 0,
                    slash_selected: 0,
                    animation_frame: 0,
                    anchor: &anchor,
                    composer: &composer,
                    draft_warning: None,
                    notice: None,
                    model_picker: &picker,
                    overlay: None,
                    wrap_cache: &mut cache,
                },
                &mut detail_links,
            );
        })
        .unwrap();
        assert_eq!(detail_links.len(), 1);
        assert_eq!(detail_links[0].target, "crates/peer-tui/src/bot_view.rs:42");
    }
}
