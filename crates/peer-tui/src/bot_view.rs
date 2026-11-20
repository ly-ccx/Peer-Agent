//! Pure Ratatui Bot-list & Bot-conversation shell views (ADR 122, ADR 84, ADR 85, ADR 130).
//!
//! Renders the Peer Frost 2.0 Bot interface while preserving all ADR 122 chrome guarantees:
//! - List header is `"Peer"` (no host/client banner on list page; no persistent `F2 · 普通任务模式`).
//! - Opened Bot header renders `◆ Peer · <Name>` + workspace path + status pill + hairline rule.
//! - Empty conversation displays centered B3 wordmark hero, identity, and rounded Frost 2.0 cards.
//! - Active conversation displays Crush/Frost 2.0 left rails (`YOU  ▌`, `BOT`) with rounded cards.
//! - Rounded elevated composer frame with pill action focus in placeholder + bottom status bar.

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    classic_view::{ApprovalCard, approval_dock_height, render_approval_dock},
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
        BRAND_MARK, CARET_IDLE, CARET_SELECTED, ONLINE_DOT, QUOTE_PREFIX, RUNNING_ACTIVITY_LABEL,
        SEPARATOR, ThemeMode, TuiLocale, TuiPalette, USER_RAIL_BAR, activity_sweep_color,
        compact_workspace_path, fill_canvas,
    },
    view::draft_view_styled,
    wordmark::b3_wordmark_lines_animated,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph, Wrap},
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
    pub workspace_path: Option<&'a str>,
    pub model_badge: &'a str,
    pub effort_badge: &'a str,
    pub is_running: bool,
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
    pub approval: Option<(&'a ApprovalCard, usize)>,
    pub overlay: Option<&'a ClassicOverlay>,
    pub wordmark_elapsed_ms: Option<u64>,
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
fn short_model_name(model_badge: &str) -> &str {
    model_badge
        .split(" · ")
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model_badge)
}

#[allow(clippy::too_many_arguments)]
fn push_rounded_card_lines(
    lines: &mut Vec<(Line<'static>, Vec<LineLink>)>,
    card: &BotCardRow,
    focused: bool,
    selected_option: usize,
    max_width: usize,
    left_indent: usize,
    palette: &TuiPalette,
    locale: TuiLocale,
    show_numbered_actions: bool,
) {
    let zh = locale.is_zh();
    let surface_bg = if focused {
        palette.selection
    } else {
        palette.panel
    };
    let bg_canvas = Style::new().bg(palette.background);

    if max_width < 22 {
        let pad_str = " ".repeat(left_indent);
        let mut legacy = Vec::new();
        push_card_lines(
            &mut legacy,
            card,
            focused,
            selected_option,
            max_width,
            palette,
            show_numbered_actions,
        );
        for line in legacy {
            let mut spans = Vec::new();
            if left_indent > 0 {
                spans.push(Span::styled(pad_str.clone(), bg_canvas));
            }
            spans.extend(line.spans);
            lines.push((Line::from(spans), Vec::new()));
        }
        return;
    }

    let box_w = max_width.min(76);
    let inner_w = box_w.saturating_sub(4);
    let border_fg = if focused {
        palette.border_focus
    } else {
        palette.border
    };
    let indent_span = (left_indent > 0).then(|| Span::styled(" ".repeat(left_indent), bg_canvas));
    let left_edge = Span::styled("│", Style::new().fg(border_fg).bg(palette.background));
    let right_edge = Span::styled("│", Style::new().fg(border_fg).bg(palette.background));
    let space_fill = Style::new().bg(surface_bg);

    let make_border_row = |ch_left: &str, ch_right: &str| -> Line<'static> {
        let mut spans = Vec::with_capacity(2);
        if let Some(ref ind) = indent_span {
            spans.push(ind.clone());
        }
        spans.push(Span::styled(
            format!("{ch_left}{}{ch_right}", SEPARATOR.repeat(box_w - 2)),
            Style::new().fg(border_fg).bg(palette.background),
        ));
        Line::from(spans)
    };

    let make_content_row = |inner_spans: Vec<Span<'static>>, used_w: usize| -> Line<'static> {
        let pad = inner_w.saturating_sub(used_w);
        let mut spans = Vec::with_capacity(inner_spans.len() + 6);
        if let Some(ref ind) = indent_span {
            spans.push(ind.clone());
        }
        spans.push(left_edge.clone());
        spans.push(Span::styled(" ", space_fill));
        spans.extend(inner_spans);
        if pad > 0 {
            spans.push(Span::styled(" ".repeat(pad), space_fill));
        }
        spans.push(Span::styled(" ", space_fill));
        spans.push(right_edge.clone());
        Line::from(spans)
    };

    lines.push((make_border_row("╭", "╮"), Vec::new()));

    // 1. Header row: [N] · kind · title (left) + status badge (right)
    let badge_text = if card.actions.is_empty() {
        ""
    } else if focused {
        if zh { "● 已选中" } else { "● Focused" }
    } else if zh {
        "Tab 选择"
    } else {
        "Tab"
    };
    let badge_w = badge_text.width();
    let show_badge = !badge_text.is_empty() && inner_w >= badge_w + 14;
    let left_budget = if show_badge {
        inner_w.saturating_sub(badge_w + 2)
    } else {
        inner_w
    };

    let num_str = format!("[{}]", card.number);
    let kind_str = if card.kind.trim().is_empty() {
        String::new()
    } else {
        format!(" {} ·", terminal_text(&card.kind))
    };
    let prefix_w = num_str.width() + kind_str.width() + 1;
    let title_budget = left_budget.saturating_sub(prefix_w);
    let clean_title = clip_bot_line(&terminal_text(&card.title), title_budget);
    let mut header_spans = vec![Span::styled(
        num_str,
        Style::new()
            .fg(palette.warning)
            .bg(surface_bg)
            .add_modifier(Modifier::BOLD),
    )];
    let mut left_w = header_spans[0].width();
    if !kind_str.is_empty() && left_w + kind_str.width() < left_budget {
        left_w += kind_str.width();
        header_spans.push(Span::styled(
            kind_str,
            Style::new().fg(palette.accent_soft).bg(surface_bg),
        ));
    }
    if left_w + 1 < left_budget && !clean_title.is_empty() {
        let max_t = left_budget.saturating_sub(left_w + 1);
        let t = clip_bot_line(&clean_title, max_t);
        left_w += 1 + t.width();
        header_spans.push(Span::styled(" ", space_fill));
        header_spans.push(Span::styled(
            t,
            Style::new()
                .fg(palette.text)
                .bg(surface_bg)
                .add_modifier(Modifier::BOLD),
        ));
    }
    if show_badge {
        let gap = inner_w.saturating_sub(left_w + badge_w);
        if gap > 0 {
            header_spans.push(Span::styled(" ".repeat(gap), space_fill));
        }
        let badge_style = if focused {
            Style::new()
                .fg(palette.accent)
                .bg(surface_bg)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.muted).bg(surface_bg)
        };
        header_spans.push(Span::styled(badge_text, badge_style));
        left_w += gap + badge_w;
    }
    lines.push((make_content_row(header_spans, left_w), Vec::new()));

    // 2. Optional summary row
    let has_summary = !card.summary.trim().is_empty();
    if has_summary {
        let sum = clip_bot_line(&terminal_text(&card.summary), inner_w);
        let sw = sum.width();
        lines.push((
            make_content_row(
                vec![Span::styled(
                    sum,
                    Style::new().fg(palette.text_soft).bg(surface_bg),
                )],
                sw,
            ),
            Vec::new(),
        ));
    }

    // 3. Actions inside box: numbered rows on `/cards`, pill chips on Conversation
    if show_numbered_actions {
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
            let row_txt = clip_bot_line(
                &format!("{caret}{}. {}", idx + 1, terminal_text(act)),
                inner_w,
            );
            let rw = row_txt.width();
            lines.push((
                make_content_row(vec![Span::styled(row_txt, style)], rw),
                Vec::new(),
            ));
        }
    } else if !card.actions.is_empty() {
        if !has_summary {
            lines.push((make_content_row(Vec::new(), 0), Vec::new()));
        }
        let mut pill_spans: Vec<Span<'static>> = Vec::new();
        let mut pill_w = 0usize;
        for (idx, act) in card.actions.iter().enumerate() {
            let active_opt = focused && idx == selected_option;
            let sep_w = usize::from(idx > 0) * 2;
            let chrome_w = if active_opt { 6 } else { 4 };
            let avail = inner_w.saturating_sub(pill_w + sep_w + chrome_w);
            if avail < 4 {
                break;
            }
            if sep_w > 0 {
                pill_spans.push(Span::styled("  ", space_fill));
                pill_w += sep_w;
            }
            if active_opt {
                pill_spans.push(Span::styled(
                    "› ",
                    Style::new()
                        .fg(palette.accent)
                        .bg(surface_bg)
                        .add_modifier(Modifier::BOLD),
                ));
                pill_w += 2;
            }
            let act_clipped = clip_bot_line(&terminal_text(act), avail);
            let chip = format!("[ {act_clipped} ]");
            let chip_w = chip.width();
            let chip_style = if active_opt {
                Style::new()
                    .fg(palette.text_selection_fg)
                    .bg(palette.accent)
                    .add_modifier(Modifier::BOLD)
            } else if focused {
                Style::new().fg(palette.muted).bg(surface_bg)
            } else {
                Style::new().fg(palette.text_soft).bg(palette.panel_raised)
            };
            pill_spans.push(Span::styled(chip, chip_style));
            pill_w += chip_w;
        }
        lines.push((make_content_row(pill_spans, pill_w), Vec::new()));

        if focused {
            let hint = if zh {
                "←/→ 切选项 · Enter 执行 · Esc 返回"
            } else {
                "←/→ option · Enter run · Esc back"
            };
            let clipped = clip_bot_line(hint, inner_w);
            let hw = clipped.width();
            lines.push((
                make_content_row(
                    vec![Span::styled(
                        clipped,
                        Style::new().fg(palette.muted).bg(surface_bg),
                    )],
                    hw,
                ),
                Vec::new(),
            ));
        }
    }

    lines.push((make_border_row("╰", "╯"), Vec::new()));
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
    // In Conversation view, pill chips render inside `push_rounded_card_lines`.
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

fn push_inline_task_rows(
    lines: &mut Vec<(Line<'static>, Vec<LineLink>)>,
    tasks: &[BotTaskRow],
    width: usize,
    left_indent: usize,
    show_section_title: bool,
    palette: &TuiPalette,
    locale: TuiLocale,
) {
    if tasks.is_empty() {
        return;
    }
    let bg_style = Style::new().bg(palette.background);
    let indent = " ".repeat(left_indent);
    if show_section_title {
        let title = if locale.is_zh() {
            "── 委派任务 ──"
        } else {
            "── Delegated tasks ──"
        };
        let clipped = clip_bot_line(title, width);
        let text = if left_indent > 0 {
            format!("{indent}{clipped}")
        } else {
            clipped
        };
        lines.push((
            Line::styled(text, Style::new().fg(palette.subtle).bg(palette.background)),
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
        let clipped = clip_bot_line(&format!("{glyph} {clean_title} · {status_label}"), width);
        let mut spans = Vec::with_capacity(2);
        if left_indent > 0 {
            spans.push(Span::styled(indent.clone(), bg_style));
        }
        spans.push(Span::styled(
            clipped,
            Style::new().fg(fg).bg(palette.background),
        ));
        lines.push((Line::from(spans), Vec::new()));
    }
}

fn render_bot_topbar(
    frame: &mut Frame<'_>,
    header_area: Rect,
    divider_area: Option<Rect>,
    view: &BotShellView<'_>,
) {
    let palette = view.palette;
    let zh = view.locale.is_zh();
    let hw = usize::from(header_area.width).max(1);
    let bg = Style::new().bg(palette.background);

    let brand = format!("{BRAND_MARK} ");
    let name_part = match view
        .active_bot_name
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(name) => format!(
            "Peer · {}",
            clip_bot_line(name, hw.saturating_sub(24).max(6))
        ),
        None => "Peer".to_owned(),
    };
    let subview_tag = match view.screen {
        BotScreen::Tasks => Some(if zh { " · 任务" } else { " · Tasks" }),
        BotScreen::TaskDetail { .. } => Some(if zh { " · 任务详情" } else { " · Task" }),
        BotScreen::Memory => Some(if zh { " · 记忆" } else { " · Memory" }),
        BotScreen::Objectives => Some(if zh { " · 目标" } else { " · Objectives" }),
        BotScreen::Cards => Some(if zh { " · 待处理" } else { " · Needs you" }),
        BotScreen::Help => Some(if zh { " · 命令" } else { " · Help" }),
        _ => None,
    };

    let dot_str = format!("{ONLINE_DOT} ");
    let dot_color = if view.is_host {
        palette.success
    } else {
        palette.warning
    };
    let host_label = if view.is_host {
        if zh {
            "由本终端运行"
        } else {
            "Running here"
        }
    } else if zh {
        "客户端 · 只读"
    } else {
        "Client · read-only"
    };

    let pending_count = view.cards.len();
    let running_count = view
        .tasks
        .iter()
        .filter(|t| is_running_session_status(&t.status))
        .count();
    let pending_label = if pending_count > 0 {
        Some(if zh {
            format!(" · 待处理 {pending_count}")
        } else {
            format!(" · needs you {pending_count}")
        })
    } else {
        None
    };
    let running_label = if running_count > 0 {
        Some(if zh {
            format!(" · 进行中 {running_count}")
        } else {
            format!(" · running {running_count}")
        })
    } else {
        None
    };

    let base_right_w = dot_str.width() + host_label.width();
    let base_left_w = brand.width() + name_part.width();
    let mut extra_right_w = 0usize;
    let show_pending = pending_label
        .as_ref()
        .is_some_and(|s| base_left_w + base_right_w + s.width() + 4 <= hw);
    if show_pending {
        extra_right_w += pending_label.as_ref().map_or(0, |s| s.width());
    }
    let show_running = running_label
        .as_ref()
        .is_some_and(|s| base_left_w + base_right_w + extra_right_w + s.width() + 4 <= hw);
    if show_running {
        extra_right_w += running_label.as_ref().map_or(0, |s| s.width());
    }
    let total_right_w = base_right_w + extra_right_w;

    let show_subview =
        subview_tag.is_some_and(|tag| base_left_w + tag.width() + total_right_w + 3 <= hw);
    let subview_w = if show_subview {
        subview_tag.map_or(0, |t| t.width())
    } else {
        0
    };
    let ws_budget = hw.saturating_sub(base_left_w + subview_w + total_right_w + 4);
    let ws_part = view
        .workspace_path
        .map(compact_workspace_path)
        .filter(|s| !s.is_empty() && ws_budget >= 8)
        .map(|s| format!("  {}", clip_bot_line(&s, ws_budget.saturating_sub(2))))
        .unwrap_or_default();

    let left_w = base_left_w + subview_w + ws_part.width();
    let gap = hw.saturating_sub(left_w + total_right_w);

    let mut spans = vec![
        Span::styled(
            brand,
            Style::new().fg(palette.accent).bg(palette.background),
        ),
        Span::styled(
            name_part,
            Style::new()
                .fg(palette.text)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    if show_subview && let Some(tag) = subview_tag {
        spans.push(Span::styled(
            tag,
            Style::new().fg(palette.accent_soft).bg(palette.background),
        ));
    }
    if !ws_part.is_empty() {
        spans.push(Span::styled(
            ws_part,
            Style::new().fg(palette.muted).bg(palette.background),
        ));
    }
    if gap >= 2 {
        spans.push(Span::styled(" ".repeat(gap), bg));
        spans.push(Span::styled(
            dot_str,
            Style::new().fg(dot_color).bg(palette.background),
        ));
        spans.push(Span::styled(
            host_label,
            Style::new().fg(palette.muted).bg(palette.background),
        ));
        if show_pending && let Some(lbl) = pending_label {
            spans.push(Span::styled(
                lbl,
                Style::new().fg(palette.warning).bg(palette.background),
            ));
        }
        if show_running && let Some(lbl) = running_label {
            spans.push(Span::styled(
                lbl,
                Style::new().fg(palette.tool_running).bg(palette.background),
            ));
        }
    }
    frame.render_widget(Paragraph::new(Line::from(spans)), header_area);

    if let Some(div_area) = divider_area {
        frame.render_widget(
            Paragraph::new(Line::styled(
                SEPARATOR.repeat(usize::from(div_area.width)),
                Style::new().fg(palette.border).bg(palette.background),
            )),
            div_area,
        );
    }
}

fn render_bot_status_bar(frame: &mut Frame<'_>, area: Rect, view: &BotShellView<'_>) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let palette = view.palette;
    let zh = view.locale.is_zh();
    let sw = usize::from(area.width).max(1);
    let narrow = sw < 56;
    let bg = Style::new().bg(palette.background);
    let subtle = Style::new().fg(palette.subtle).bg(palette.background);
    let muted = Style::new().fg(palette.muted).bg(palette.background);
    let soft = Style::new().fg(palette.text_soft).bg(palette.background);
    let accent = Style::new()
        .fg(palette.accent)
        .bg(palette.background)
        .add_modifier(Modifier::BOLD);

    let host_val = if view.is_host {
        if zh { "本机宿主" } else { "local" }
    } else if zh {
        "只读客户端"
    } else {
        "client"
    };
    let host_fg = if view.is_host {
        palette.success
    } else {
        palette.warning
    };

    let mut left_spans = vec![
        Span::styled("mode ", subtle),
        Span::styled("bot", accent),
        Span::styled(" · ", subtle),
        Span::styled("host ", subtle),
        Span::styled(host_val, Style::new().fg(host_fg).bg(palette.background)),
    ];

    let pending_count = view.cards.len();
    if pending_count > 0 && (narrow || sw >= 72) {
        left_spans.push(Span::styled(" · ", subtle));
        left_spans.push(Span::styled(
            if zh {
                format!("待处理 {pending_count}")
            } else {
                format!("needs you {pending_count}")
            },
            Style::new().fg(palette.warning).bg(palette.background),
        ));
    }

    let running_count = view
        .tasks
        .iter()
        .filter(|t| is_running_session_status(&t.status))
        .count();
    if running_count > 0 && (narrow || sw >= 84) {
        left_spans.push(Span::styled(" · ", subtle));
        left_spans.push(Span::styled(
            if zh {
                format!("进行中 {running_count}")
            } else {
                format!("running {running_count}")
            },
            Style::new().fg(palette.tool_running).bg(palette.background),
        ));
    }

    let left_w: usize = left_spans.iter().map(|s| s.width()).sum();

    let model_raw = short_model_name(view.model_badge).trim();
    let has_model = !model_raw.is_empty();
    let model_text = if has_model {
        model_raw.to_owned()
    } else if zh {
        "未配置模型".to_owned()
    } else {
        "no model".to_owned()
    };
    let effort_text = if view.effort_badge.trim().is_empty() {
        "default"
    } else {
        view.effort_badge.trim()
    };
    let hint_suffix = if sw >= 112 {
        if zh {
            " · /classic 普通对话 · / 命令 · F3 模型"
        } else {
            " · /classic chat · / cmds · F3 model"
        }
    } else if sw >= 88 {
        if zh {
            " · /classic 普通对话 · F3 模型"
        } else {
            " · /classic chat · F3 model"
        }
    } else if sw >= 72 {
        " · /classic"
    } else {
        ""
    };

    let model_budget = if narrow {
        sw.saturating_sub(effort_text.width() + hint_suffix.width() + 4)
    } else {
        sw.saturating_sub(left_w + effort_text.width() + hint_suffix.width() + 7)
    };
    let clipped_model = clip_bot_line(&model_text, model_budget.max(4));
    let mut right_spans = vec![
        Span::styled(clipped_model, if has_model { soft } else { muted }),
        Span::styled(" · ", subtle),
        Span::styled(effort_text, soft),
    ];
    if !hint_suffix.is_empty() {
        right_spans.push(Span::styled(hint_suffix, muted));
    }
    let right_w: usize = right_spans.iter().map(|s| s.width()).sum();

    if narrow && area.height >= 2 {
        frame.render_widget(
            Paragraph::new(vec![Line::from(left_spans), Line::from(right_spans)]),
            area,
        );
        return;
    }

    let gap = sw.saturating_sub(left_w + right_w);
    if gap >= 2 {
        let mut combined = left_spans;
        combined.push(Span::styled(" ".repeat(gap), bg));
        combined.extend(right_spans);
        frame.render_widget(Paragraph::new(Line::from(combined)), area);
    } else {
        frame.render_widget(Paragraph::new(Line::from(left_spans)), area);
    }
}

#[allow(clippy::too_many_arguments)]
fn render_conversation_body(
    frame: &mut Frame<'_>,
    area: Rect,
    active_bot_name: Option<&str>,
    workspace_path: Option<&str>,
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
    wordmark_elapsed_ms: Option<u64>,
    out_links: &mut Vec<ScreenHyperlink>,
) {
    let width = usize::from(area.width).max(1);
    let height = usize::from(area.height);
    if height == 0 {
        return;
    }

    let zh = locale.is_zh();
    let bg = Style::new().bg(palette.background);
    let focused_card_num = cards.get(selected_card).map(|c| c.number);

    // Centered empty-state Hero when no messages or live stream are present yet.
    if messages.is_empty() && live_activity.is_none() {
        if height >= 12 && width >= 30 {
            let mut hero_lines: Vec<(Line<'static>, Vec<LineLink>)> = Vec::new();
            if height >= 18 && width >= 42 {
                let (wm_lines, wm_w) =
                    b3_wordmark_lines_animated(area.width, palette, wordmark_elapsed_ms);
                let wm_pad = width.saturating_sub(usize::from(wm_w)) / 2;
                let wm_pad_str = (wm_pad > 0).then(|| " ".repeat(wm_pad));
                for line in wm_lines {
                    if let Some(ref pad) = wm_pad_str {
                        let mut spans = vec![Span::styled(pad.clone(), bg)];
                        spans.extend(line.spans);
                        hero_lines.push((Line::from(spans), Vec::new()));
                    } else {
                        hero_lines.push((line, Vec::new()));
                    }
                }
                hero_lines.push((Line::styled("", bg), Vec::new()));
            }

            let bot_name = active_bot_name
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .unwrap_or("Peer");
            let ws_short = workspace_path
                .map(compact_workspace_path)
                .filter(|s| !s.is_empty());
            let mut id_spans = vec![
                Span::styled(
                    format!("{BRAND_MARK} "),
                    Style::new().fg(palette.accent).bg(palette.background),
                ),
                Span::styled(
                    clip_bot_line(bot_name, width.saturating_sub(4).max(6)),
                    Style::new()
                        .fg(palette.text)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                ),
            ];
            let mut id_w: usize = id_spans.iter().map(|s| s.width()).sum();
            if let Some(ws) = ws_short {
                let budget = width.saturating_sub(id_w + 5);
                if budget >= 6 {
                    let ws_piece = format!("  ·  {}", clip_bot_line(&ws, budget));
                    id_w += ws_piece.width();
                    id_spans.push(Span::styled(
                        ws_piece,
                        Style::new().fg(palette.muted).bg(palette.background),
                    ));
                }
            }
            let id_pad = width.saturating_sub(id_w) / 2;
            if id_pad > 0 {
                id_spans.insert(0, Span::styled(" ".repeat(id_pad), bg));
            }
            hero_lines.push((Line::from(id_spans), Vec::new()));

            let subtitle = if zh {
                if width >= 88 {
                    "输入消息即可对话或委派任务 · /tasks 任务 · /bots 切换 · /model 模型 · /classic 普通对话"
                } else {
                    "/tasks 任务 · /bots 切换 · /model 模型 · /classic 普通对话"
                }
            } else if width >= 76 {
                "Send a message to chat or delegate · /tasks · /bots · /model · /classic chat"
            } else {
                "/tasks · /bots · /model · /classic chat"
            };
            let sub_clipped = clip_bot_line(subtitle, width);
            let sub_pad = width.saturating_sub(sub_clipped.width()) / 2;
            hero_lines.push((
                Line::styled(
                    format!("{}{sub_clipped}", " ".repeat(sub_pad)),
                    Style::new().fg(palette.muted).bg(palette.background),
                ),
                Vec::new(),
            ));

            if !cards.is_empty() {
                let card_max_w = width.saturating_sub(4).min(76);
                let card_pad = width.saturating_sub(card_max_w) / 2;
                for card in cards {
                    hero_lines.push((Line::styled("", bg), Vec::new()));
                    let is_focused = card_focus && focused_card_num == Some(card.number);
                    push_rounded_card_lines(
                        &mut hero_lines,
                        card,
                        is_focused,
                        selected_option,
                        card_max_w,
                        card_pad,
                        palette,
                        locale,
                        false,
                    );
                }
            }

            if !tasks.is_empty() {
                hero_lines.push((Line::styled("", bg), Vec::new()));
                let block_w = width.saturating_sub(4).min(76);
                let task_pad = width.saturating_sub(block_w) / 2;
                push_inline_task_rows(
                    &mut hero_lines,
                    tasks,
                    block_w,
                    task_pad,
                    false,
                    palette,
                    locale,
                );
            }

            if hero_lines.len() <= height {
                let top_pad = (height - hero_lines.len()) / 2;
                let mut padded = Vec::with_capacity(top_pad + hero_lines.len());
                for _ in 0..top_pad {
                    padded.push(Line::styled("", bg));
                }
                for (line, _) in hero_lines {
                    padded.push(line);
                }
                frame.render_widget(Paragraph::new(padded), area);
                return;
            }

            // Overflow fallback cleanly pages from bottom.
            let start = hero_lines.len().saturating_sub(height);
            let visible: Vec<Line<'static>> =
                hero_lines.into_iter().skip(start).map(|(l, _)| l).collect();
            frame.render_widget(Paragraph::new(visible), area);
            return;
        }

        // Tiny viewport fallback when height < 12 or width < 30.
        let mut tiny_lines: Vec<(Line<'static>, Vec<LineLink>)> = Vec::new();
        for card in cards {
            let is_focused = card_focus && focused_card_num == Some(card.number);
            push_rounded_card_lines(
                &mut tiny_lines,
                card,
                is_focused,
                selected_option,
                width,
                0,
                palette,
                locale,
                false,
            );
            tiny_lines.push((Line::styled("", bg), Vec::new()));
        }
        push_inline_task_rows(&mut tiny_lines, tasks, width, 0, false, palette, locale);
        if tiny_lines.is_empty() {
            let empty_text = if zh {
                "这里暂时没有内容"
            } else {
                "Nothing here yet"
            };
            frame.render_widget(
                Paragraph::new(empty_text)
                    .style(Style::new().fg(palette.muted).bg(palette.background)),
                area,
            );
            return;
        }
        let start = tiny_lines.len().saturating_sub(height);
        let visible: Vec<Line<'static>> =
            tiny_lines.into_iter().skip(start).map(|(l, _)| l).collect();
        frame.render_widget(Paragraph::new(visible), area);
        return;
    }

    // Active conversation stream with Crush/Frost 2.0 left rail when width permits.
    let use_rail = width >= 44;
    let body_indent = if use_rail { 6usize } else { 0usize };
    let mut rendered_card_ids = Vec::new();
    let mut all_lines: Vec<(Line<'static>, Vec<LineLink>)> = Vec::new();

    for (msg_idx, msg) in messages.iter().enumerate() {
        let is_system_card = msg.kind == "system_card";
        let is_user = msg.role == "user";
        let rail_cols: usize = if !use_rail || is_system_card {
            0
        } else if is_user {
            8
        } else {
            6
        };
        let stamp = msg
            .created_at
            .as_deref()
            .map(format_bot_when)
            .unwrap_or_default();
        let mut emitted_first_rail = false;

        let push_rail_prefix = |spans: &mut Vec<Span<'static>>, is_first: bool| {
            if !use_rail || is_system_card {
                return;
            }
            if is_user {
                if is_first {
                    spans.push(Span::styled(
                        " YOU  ",
                        Style::new()
                            .fg(palette.user)
                            .bg(palette.background)
                            .add_modifier(Modifier::BOLD),
                    ));
                } else {
                    spans.push(Span::styled("      ", bg));
                }
                spans.push(Span::styled(
                    USER_RAIL_BAR,
                    Style::new().fg(palette.user).bg(palette.background),
                ));
            } else if is_first {
                spans.push(Span::styled(
                    " BOT  ",
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                ));
            } else {
                spans.push(Span::styled("      ", bg));
            }
        };

        if !use_rail && !is_system_card {
            let (prefix, header_style) = if is_user {
                (
                    "YOU",
                    Style::new()
                        .fg(palette.user)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                )
            } else {
                (
                    "BOT",
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                )
            };
            let mut header_spans = vec![Span::styled(prefix, header_style)];
            if !stamp.is_empty() {
                header_spans.push(Span::styled("  ", bg));
                header_spans.push(Span::styled(
                    stamp.clone(),
                    Style::new().fg(palette.muted).bg(palette.background),
                ));
            }
            all_lines.push((Line::from(header_spans), Vec::new()));
        }

        if let Some(ref echo) = msg.reply_to_echo
            && !echo.is_empty()
        {
            let content_w = width.saturating_sub(rail_cols + 8).max(8);
            let mut spans = Vec::new();
            let is_first = !emitted_first_rail;
            emitted_first_rail = true;
            push_rail_prefix(&mut spans, is_first);
            spans.push(Span::styled(
                if zh { "回复: " } else { "Reply: " },
                Style::new().fg(palette.muted).bg(palette.background),
            ));
            spans.push(Span::styled(
                QUOTE_PREFIX,
                Style::new().fg(palette.border_focus).bg(palette.background),
            ));
            spans.push(Span::styled(
                clip_bot_line(echo, content_w),
                Style::new().fg(palette.text_soft).bg(palette.background),
            ));
            all_lines.push((Line::from(spans), Vec::new()));
        }

        let body_text = msg
            .card_summary
            .as_deref()
            .filter(|s| !s.is_empty())
            .unwrap_or(msg.content.as_str());
        if !body_text.is_empty() && !(is_system_card && msg.card_number.is_some()) {
            let content_w = width.saturating_sub(rail_cols).max(12);
            let body_style = Style::new().fg(palette.text).bg(palette.background);
            let cache_key = WrapCacheKey {
                item_hash: stable_hash(&msg.id),
                revision: msg.revision,
                width: content_w as u16,
                scheme: scheme_id,
            };
            let block = if let Some(cached) = wrap_cache.get(&cache_key) {
                cached.clone()
            } else {
                let computed =
                    render_markdown_themed(body_text, content_w, body_style, 160, palette);
                wrap_cache.insert(cache_key, computed.clone());
                computed
            };
            let block_prefix =
                (cache_key.item_hash as u32) ^ ((msg_idx as u32).wrapping_add(1) << 12);
            for styled in &block.lines {
                let is_first = !emitted_first_rail;
                emitted_first_rail = true;
                let mut links: Vec<LineLink> = styled
                    .links
                    .iter()
                    .cloned()
                    .map(|mut link| {
                        link.id = stamp_screen_link_id(block_prefix, link.id);
                        link.col_start = link.col_start.saturating_add(rail_cols as u16);
                        link.col_end = link.col_end.saturating_add(rail_cols as u16);
                        link
                    })
                    .collect();
                let mut line = styled.to_ratatui_line();
                if use_rail && !is_system_card {
                    let line_w = rail_cols + line.width();
                    let mut spans = Vec::with_capacity(line.spans.len() + 4);
                    push_rail_prefix(&mut spans, is_first);
                    spans.extend(line.spans);
                    if is_first && !stamp.is_empty() && line_w + 2 + stamp.width() <= width {
                        spans.push(Span::styled(" ".repeat(width - line_w - stamp.width()), bg));
                        spans.push(Span::styled(
                            stamp.clone(),
                            Style::new().fg(palette.muted).bg(palette.background),
                        ));
                    }
                    line = Line::from(spans);
                }
                all_lines.push((line, std::mem::take(&mut links)));
            }
        }

        if use_rail && !is_system_card && !emitted_first_rail {
            let mut spans = Vec::new();
            push_rail_prefix(&mut spans, true);
            all_lines.push((Line::from(spans), Vec::new()));
        }

        if !msg.marks.is_empty() {
            let mark_indent = if is_system_card { 0 } else { body_indent };
            let mark_text = clip_bot_line(
                &format!(
                    "✓ {}: {}",
                    if zh { "结果" } else { "Result" },
                    msg.marks.join(" · ")
                ),
                width.saturating_sub(mark_indent).max(8),
            );
            let mut spans = Vec::new();
            if mark_indent > 0 {
                spans.push(Span::styled(" ".repeat(mark_indent), bg));
            }
            spans.push(Span::styled(
                mark_text,
                Style::new().fg(palette.success).bg(palette.background),
            ));
            all_lines.push((Line::from(spans), Vec::new()));
        }

        if let Some(cnum) = msg.card_number
            && let Some(card) = cards.iter().find(|c| c.number == cnum)
        {
            rendered_card_ids.push(cnum);
            let is_focused = card_focus && focused_card_num == Some(cnum);
            let card_max_w = width.saturating_sub(body_indent).max(12);
            push_rounded_card_lines(
                &mut all_lines,
                card,
                is_focused,
                selected_option,
                card_max_w,
                body_indent,
                palette,
                locale,
                false,
            );
        } else if let Some(cnum) = msg.card_number {
            let mut spans = Vec::new();
            if body_indent > 0 {
                spans.push(Span::styled(" ".repeat(body_indent), bg));
            }
            spans.push(Span::styled(
                format!("卡片 [#{cnum}]"),
                Style::new().fg(palette.warning).bg(palette.background),
            ));
            all_lines.push((Line::from(spans), Vec::new()));
        }

        all_lines.push((Line::styled("", bg), Vec::new()));
    }

    // Remaining active cards not attached to a visible message
    for card in cards {
        if !rendered_card_ids.contains(&card.number) {
            let is_focused = card_focus && focused_card_num == Some(card.number);
            let card_max_w = width.saturating_sub(body_indent).max(12);
            push_rounded_card_lines(
                &mut all_lines,
                card,
                is_focused,
                selected_option,
                card_max_w,
                body_indent,
                palette,
                locale,
                false,
            );
            all_lines.push((Line::styled("", bg), Vec::new()));
        }
    }

    if !tasks.is_empty() {
        if !all_lines.is_empty() && all_lines.last().is_some_and(|(line, _)| line.width() > 0) {
            all_lines.push((Line::styled("", bg), Vec::new()));
        }
        push_inline_task_rows(
            &mut all_lines,
            tasks,
            width.saturating_sub(body_indent).max(12),
            body_indent,
            true,
            palette,
            locale,
        );
    }

    if let Some(live) = live_activity
        && !live.trim().is_empty()
    {
        let content_w = width.saturating_sub(body_indent).max(12);
        let rendered = render_markdown_themed(
            live,
            content_w,
            Style::new().fg(palette.info).bg(palette.background),
            48,
            palette,
        );
        for (line_idx, styled) in rendered.lines.iter().enumerate() {
            let links: Vec<LineLink> = styled
                .links
                .iter()
                .cloned()
                .map(|mut link| {
                    link.id = stamp_screen_link_id(0x000f_fffd, link.id);
                    link.col_start = link.col_start.saturating_add(body_indent as u16);
                    link.col_end = link.col_end.saturating_add(body_indent as u16);
                    link
                })
                .collect();
            let mut line = styled.to_ratatui_line();
            if use_rail {
                let mut spans = Vec::with_capacity(line.spans.len() + 2);
                if line_idx == 0 {
                    spans.push(Span::styled(
                        " BOT  ",
                        Style::new()
                            .fg(palette.accent)
                            .bg(palette.background)
                            .add_modifier(Modifier::BOLD),
                    ));
                } else {
                    spans.push(Span::styled("      ", bg));
                }
                spans.extend(line.spans);
                line = Line::from(spans);
            }
            all_lines.push((line, links));
        }
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
        // Centered Frost 2.0 bind prompt matching ProjectApp.tsx & project-copy.ts
        let zh = view.locale.is_zh();
        let w = usize::from(area.width);
        let h = usize::from(area.height);
        let use_card = w >= 38 && h >= 12;
        let surf_bg = if use_card {
            palette.panel
        } else {
            palette.background
        };
        let content_budget = if use_card {
            w.saturating_sub(8).min(62)
        } else {
            w.saturating_sub(4).max(8)
        };
        let yes_style = if *confirm_yes {
            if use_card {
                Style::new()
                    .fg(palette.text_selection_fg)
                    .bg(palette.accent)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new()
                    .fg(palette.accent)
                    .bg(surf_bg)
                    .add_modifier(Modifier::BOLD)
            }
        } else {
            Style::new().fg(palette.muted).bg(surf_bg)
        };
        let no_style = if !*confirm_yes {
            if use_card {
                Style::new()
                    .fg(palette.text_selection_fg)
                    .bg(palette.accent)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new()
                    .fg(palette.accent)
                    .bg(surf_bg)
                    .add_modifier(Modifier::BOLD)
            }
        } else {
            Style::new().fg(palette.muted).bg(surf_bg)
        };
        let ws_clean = clip_bot_line(workspace_path, content_budget);
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
        let horizontal = yes_txt.width() + 3 + no_txt.width() <= content_budget;
        let title_lbl = if zh {
            "Peer · 机器人模式"
        } else {
            "Peer · Bot mode"
        };
        let header_line = if use_card {
            Line::from(vec![
                Span::styled(
                    format!("{BRAND_MARK} "),
                    Style::new().fg(palette.accent).bg(surf_bg),
                ),
                Span::styled(
                    title_lbl,
                    Style::new()
                        .fg(palette.accent)
                        .bg(surf_bg)
                        .add_modifier(Modifier::BOLD),
                ),
            ])
        } else {
            Line::styled(
                title_lbl,
                Style::new()
                    .fg(palette.accent)
                    .bg(surf_bg)
                    .add_modifier(Modifier::BOLD),
            )
        };
        let mut lines = vec![
            header_line,
            Line::styled("", Style::new().bg(surf_bg)),
            Line::styled(
                clip_bot_line(
                    if zh {
                        "把这个目录绑定为机器人？"
                    } else {
                        "Bind this directory to a bot?"
                    },
                    content_budget,
                ),
                Style::new()
                    .fg(palette.text)
                    .bg(surf_bg)
                    .add_modifier(Modifier::BOLD),
            ),
            Line::styled(ws_clean, Style::new().fg(palette.muted).bg(surf_bg)),
            Line::styled("", Style::new().bg(surf_bg)),
        ];
        let options_start_row = lines.len() as u16;
        if horizontal {
            lines.push(Line::from(vec![
                Span::styled(yes_txt.clone(), yes_style),
                Span::styled("   ", Style::new().bg(surf_bg)),
                Span::styled(no_txt, no_style),
            ]));
        } else {
            lines.push(Line::styled(yes_txt.clone(), yes_style));
            lines.push(Line::styled(no_txt, no_style));
        }
        if let Some(msg) = view.notice.filter(|s| !s.is_empty()) {
            lines.push(Line::styled(
                clip_bot_line(&terminal_text(msg), content_budget),
                Style::new().fg(palette.warning).bg(surf_bg),
            ));
        }
        lines.push(Line::styled("", Style::new().bg(surf_bg)));
        lines.push(Line::styled(
            clip_bot_line(
                if zh {
                    "←/→ 选择 · 回车确认 · Esc 进入普通任务模式"
                } else {
                    "←/→ to choose · Enter to confirm · Esc for task mode"
                },
                content_budget,
            ),
            Style::new().fg(palette.muted).bg(surf_bg),
        ));

        if use_card {
            let max_line_w = lines.iter().map(|l| l.width()).max().unwrap_or(24);
            let card_w = (max_line_w + 4).clamp(38, w.min(66)) as u16;
            let card_h = (lines.len() as u16 + 2).min(area.height);
            let box_rect = Rect {
                x: area.x + area.width.saturating_sub(card_w) / 2,
                y: area.y + area.height.saturating_sub(card_h) / 2,
                width: card_w,
                height: card_h,
            };
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::new().fg(palette.border_focus).bg(palette.background))
                .style(Style::new().bg(palette.panel));
            let raw_inner = block.inner(box_rect);
            frame.render_widget(block, box_rect);
            let inner = if raw_inner.width >= 10 {
                Rect {
                    x: raw_inner.x + 1,
                    y: raw_inner.y,
                    width: raw_inner.width - 2,
                    height: raw_inner.height,
                }
            } else {
                raw_inner
            };
            frame.render_widget(
                Paragraph::new(lines)
                    .style(Style::new().bg(palette.panel))
                    .wrap(Wrap { trim: false }),
                inner,
            );
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
            let cy = (inner.y + cursor_dy).min(full_area.y + full_area.height - 1);
            let cx = (inner.x + cursor_dx).min(full_area.x + full_area.width - 1);
            frame.set_cursor_position((cx, cy));
            return;
        }

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
    let has_header_divider = !is_list && area.height >= 10;
    let has_lease_banner = !is_list && view.lease_banner.is_some();
    let show_composer = !is_list;
    let approval_dock_h =
        if show_composer && !view.model_picker.open && view.approval.is_some() && area.height >= 10
        {
            approval_dock_height(area.height.saturating_sub(9).max(4))
        } else {
            0
        };
    let active_dock = view.overlay.filter(|ov| {
        show_composer
            && ov.is_open()
            && !ov.is_modal()
            && !view.model_picker.open
            && approval_dock_h == 0
    });
    let dock_h = active_dock.map_or(0, |ov| ov.dock_height(area.height.saturating_sub(10)));
    let draft = view.composer.draft();
    let slash_open = show_composer
        && !view.model_picker.open
        && approval_dock_h == 0
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
        if view.approval.is_some() {
            Some(
                if view.locale.is_zh() {
                    "等待授权…"
                } else {
                    "Awaiting approval…"
                }
                .to_owned(),
            )
        } else {
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
                .or_else(|| {
                    view.is_running.then(|| {
                        if view.locale.is_zh() {
                            "正在推进回复 · 进行中".to_owned()
                        } else {
                            "Processing reply · Running".to_owned()
                        }
                    })
                })
        }
    } else {
        None
    };

    let use_framed_composer = show_composer && area.height >= 12 && area.width >= 20;
    let status_bar_rows: u16 = if !show_composer || area.height < 8 {
        0
    } else if area.width < 56 && area.height >= 12 {
        2
    } else {
        1
    };
    let composer_inner_w = if use_framed_composer {
        usize::from(area.width).saturating_sub(6).max(1)
    } else {
        usize::from(area.width).saturating_sub(2).max(1)
    };
    let composer_inner_rows: u16 = if draft.is_empty() {
        1
    } else {
        let (lines, _) = draft_view_styled(view.composer, composer_inner_w, 3, Style::default());
        (lines.len() as u16).clamp(1, 3)
    };
    let composer_rows = if use_framed_composer {
        composer_inner_rows + 2
    } else {
        composer_inner_rows
    };

    let mut constraints = vec![Constraint::Length(1)];
    if has_header_divider {
        constraints.push(Constraint::Length(1));
    }
    if has_lease_banner {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Min(1));
    if show_composer {
        if transient_status.is_some() {
            constraints.push(Constraint::Length(1)); // transient notice / draft warning / reading history
        }
        if approval_dock_h > 0 {
            constraints.push(Constraint::Length(approval_dock_h));
        } else if dock_h > 0 && area.height >= 10 {
            constraints.push(Constraint::Length(dock_h));
        } else if slash_rows > 0 && area.height >= 10 {
            constraints.push(Constraint::Length(slash_rows));
        }
        if running_bar_label.is_some() {
            constraints.push(Constraint::Length(1)); // shared working... sweep bar
        }
        if !use_framed_composer {
            constraints.push(Constraint::Length(1)); // compact thin divider
        }
        constraints.push(Constraint::Length(composer_rows));
        if status_bar_rows > 0 {
            constraints.push(Constraint::Length(status_bar_rows));
        }
    } else {
        constraints.push(Constraint::Length(1));
    }

    let areas = Layout::vertical(constraints).split(area);
    let mut slot = 0usize;

    // ADR 122 §2 Header: BotList is strictly "Peer" (no host/client banner, no ◆ prefix).
    let header_area = areas[slot];
    slot += 1;
    let header_divider_area = if has_header_divider {
        let div = areas[slot];
        slot += 1;
        Some(div)
    } else {
        None
    };

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
        render_bot_topbar(frame, header_area, header_divider_area, &view);
    }

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
                view.active_bot_name,
                view.workspace_path,
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
                view.wordmark_elapsed_ms,
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
                let card_w = usize::from(body_area.width).max(1);
                for (idx, c) in view.cards.iter().enumerate() {
                    let mut card_lines = Vec::new();
                    push_rounded_card_lines(
                        &mut card_lines,
                        c,
                        idx == view.selected_card,
                        view.selected_card_option,
                        card_w,
                        0,
                        palette,
                        view.locale,
                        true,
                    );
                    for (l, _) in card_lines {
                        lines.push(l);
                    }
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

        if approval_dock_h > 0
            && let Some((card, selected)) = view.approval
        {
            render_approval_dock(frame, areas[slot], card, selected, view.locale, palette);
            slot += 1;
        } else if let Some(ov) = active_dock
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

        if !use_framed_composer {
            let div_w = usize::from(areas[slot].width);
            frame.render_widget(
                Paragraph::new(Line::styled(
                    SEPARATOR.repeat(div_w),
                    Style::new().fg(palette.subtle).bg(palette.background),
                )),
                areas[slot],
            );
            slot += 1;
        }

        let composer_rect = areas[slot];
        slot += 1;
        let (inner_rect, composer_bg) = if use_framed_composer {
            let actively_editing = !view.card_focus
                && !view.model_picker.open
                && active_dock.is_none()
                && approval_dock_h == 0;
            let border_fg = if actively_editing {
                palette.border_focus
            } else {
                palette.border
            };
            let block = Block::default()
                .borders(Borders::ALL)
                .border_type(BorderType::Rounded)
                .border_style(Style::new().fg(border_fg).bg(palette.background))
                .style(Style::new().bg(palette.panel));
            let raw_inner = block.inner(composer_rect);
            frame.render_widget(block, composer_rect);
            let padded = if raw_inner.width >= 10 {
                Rect {
                    x: raw_inner.x + 1,
                    y: raw_inner.y,
                    width: raw_inner.width - 2,
                    height: raw_inner.height,
                }
            } else {
                raw_inner
            };
            (padded, palette.panel)
        } else {
            (composer_rect, palette.input_bg)
        };

        if inner_rect.width >= 4 && inner_rect.height >= 1 {
            let cols =
                Layout::horizontal([Constraint::Length(2), Constraint::Min(1)]).split(inner_rect);
            let caret_fg = if view.is_running {
                palette.warning
            } else {
                palette.accent
            };
            frame.render_widget(
                Paragraph::new(Line::styled(
                    CARET_SELECTED,
                    Style::new()
                        .fg(caret_fg)
                        .bg(composer_bg)
                        .add_modifier(Modifier::BOLD),
                )),
                cols[0],
            );
            let input_area = cols[1];
            let (lines, caret) = if draft.is_empty() {
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
                let (placeholder, placeholder_fg) = match focused_action {
                    Some(act) => (act, palette.accent_soft),
                    None => (
                        if view.locale.is_zh() {
                            "跟机器人说话"
                        } else {
                            "Message this bot"
                        },
                        palette.input_placeholder,
                    ),
                };
                (
                    vec![Line::styled(
                        clip_bot_line(&terminal_text(placeholder), usize::from(input_area.width)),
                        Style::new().fg(placeholder_fg).bg(composer_bg),
                    )],
                    Some((0u16, 0u16)),
                )
            } else {
                draft_view_styled(
                    view.composer,
                    usize::from(input_area.width),
                    usize::from(input_area.height),
                    Style::new().fg(palette.input_fg).bg(composer_bg),
                )
            };
            frame.render_widget(Paragraph::new(lines), input_area);
            if !view.model_picker.open
                && !view.card_focus
                && active_dock.is_none()
                && approval_dock_h == 0
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
            frame.set_cursor_position((composer_rect.x, composer_rect.y));
        }

        if status_bar_rows > 0 {
            render_bot_status_bar(frame, areas[slot], &view);
        }
    } else if !is_list {
        frame.set_cursor_position((area.x, area.y));
    }

    if view.model_picker.open {
        out_links.clear();
        render_model_picker(frame, full_area, view.model_picker, view.locale, palette);
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
                    workspace_path: None,
                    model_badge: "",
                    effort_badge: "",
                    is_running: false,
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
                    approval: None,
                    overlay: None,
                    wordmark_elapsed_ms: None,
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
                        workspace_path: Some("/Users/demo/peer-dev"),
                        model_badge: "claude-sonnet-4-5 · Anthropic",
                        effort_badge: "high",
                        is_running: false,
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
                        approval: None,
                        overlay: None,
                        wordmark_elapsed_ms: None,
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
                            workspace_path: None,
                            model_badge: "",
                            effort_badge: "",
                            is_running: false,
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
                            approval: None,
                            overlay: None,
                            wordmark_elapsed_ms: None,
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
            let mut term = Terminal::new(TestBackend::new(100, 32)).unwrap();
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
                        workspace_path: Some("/Users/demo/Documents/Develop/peer-dev"),
                        model_badge: "claude-sonnet-4-5 · Anthropic",
                        effort_badge: "high",
                        is_running: false,
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
                        approval: None,
                        overlay: None,
                        wordmark_elapsed_ms: None,
                        wrap_cache: cache,
                    },
                );
            })
            .unwrap();
            buffer_text(&term)
        };

        let zh_idle = render_with(&mut cache, TuiLocale::ZhCn, false, 0, false);
        assert!(zh_idle.contains("◆ Peer · peer-dev"));
        assert!(zh_idle.contains("~/Documents/Develop/peer-dev"));
        assert!(zh_idle.contains("由本终端运行"));
        assert!(zh_idle.contains("──"));
        assert!(zh_idle.contains("██") && zh_idle.contains("agent"));
        assert!(zh_idle.contains("╭") && zh_idle.contains("╰"));
        assert!(zh_idle.contains("[1] 要我先熟悉一下这个项目吗？"));
        assert!(zh_idle.contains("[ 先熟悉一下项目 ]"));
        assert!(zh_idle.contains("mode bot"));
        assert!(zh_idle.contains("host 本机宿主"));
        assert!(zh_idle.contains("claude-sonnet-4-5"));
        assert!(zh_idle.contains("high"));
        assert!(zh_idle.contains("/classic 普通对话"));
        assert!(zh_idle.contains("跟机器人说话"));
        assert!(!zh_idle.contains("1. 先熟悉一下项目"));
        assert!(!zh_idle.contains("跟机器人说话，或输入 /help"));
        assert!(!zh_idle.contains("Tab 选择卡片"));
        assert!(!zh_idle.contains("F2 · 普通任务模式"));

        let zh_focus = render_with(&mut cache, TuiLocale::ZhCn, true, 0, false);
        assert!(zh_focus.contains("● 已选中"));
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
        assert!(en_idle.contains("[ Familiarize with project ]"));
        assert!(en_idle.contains("mode bot"));
        assert!(en_idle.contains("host local"));
        assert!(en_idle.contains("/classic chat"));
        assert!(en_idle.contains("Message this bot"));
        assert!(!en_idle.contains("1. Familiarize with project"));
        assert!(!en_idle.contains("Message this bot, or /help"));
        assert!(!en_idle.contains("Tab to select cards"));

        let en_focus = render_with(&mut cache, TuiLocale::EnUs, true, 0, false);
        assert!(en_focus.contains("● Focused"));
        assert!(en_focus.contains("Familiarize with project"));
        assert!(!en_focus.contains("1. Familiarize with project"));
        assert!(!en_focus.contains("Message this bot"));

        // Narrow & tiny empty-state stress checks
        for (w, h) in [(120, 40), (80, 24), (40, 14), (16, 8)] {
            let mut small = Terminal::new(TestBackend::new(w, h)).unwrap();
            small
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
                            workspace_path: Some("/Users/demo/peer-dev"),
                            model_badge: "claude-sonnet-4-5 · Anthropic",
                            effort_badge: "high",
                            is_running: false,
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
                            approval: None,
                            overlay: None,
                            wordmark_elapsed_ms: None,
                            wrap_cache: &mut cache,
                        },
                    );
                })
                .unwrap();
            if w == 80 {
                let text = buffer_text(&small);
                assert!(text.contains("/classic 普通对话"));
                assert!(text.contains("claude-sonnet-4-5"));
            }
        }
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
                    workspace_path: None,
                    model_badge: "gpt-5",
                    effort_badge: "medium",
                    is_running: false,
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
                    approval: None,
                    overlay: None,
                    wordmark_elapsed_ms: None,
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
                        workspace_path: None,
                        model_badge: "",
                        effort_badge: "",
                        is_running: false,
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
                        approval: None,
                        overlay: None,
                        wordmark_elapsed_ms: None,
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
                        workspace_path: None,
                        model_badge: "",
                        effort_badge: "",
                        is_running: false,
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
                        approval: None,
                        overlay: None,
                        wordmark_elapsed_ms: None,
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
                        workspace_path: None,
                        model_badge: "",
                        effort_badge: "",
                        is_running: false,
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
                        approval: None,
                        overlay: None,
                        wordmark_elapsed_ms: None,
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
                    workspace_path: None,
                    model_badge: "gpt-5",
                    effort_badge: "high",
                    is_running: false,
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
                    approval: None,
                    overlay: None,
                    wordmark_elapsed_ms: None,
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
                    workspace_path: None,
                    model_badge: "gpt-5",
                    effort_badge: "high",
                    is_running: false,
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
                    approval: None,
                    overlay: None,
                    wordmark_elapsed_ms: None,
                    wrap_cache: &mut cache,
                },
                &mut detail_links,
            );
        })
        .unwrap();
        assert_eq!(detail_links.len(), 1);
        assert_eq!(detail_links[0].target, "crates/peer-tui/src/bot_view.rs:42");
    }

    #[test]
    fn bot_conversation_renders_approval_dock_cleanly_without_corrupting_layout() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 32);
        let composer = Composer::default();
        let anchor = ReadingAnchor::default();
        let picker = ModelPickerState::default();
        let card = ApprovalCard {
            action: "git_query".into(),
            location: "/Users/yinliang/Documents/Develop/peer-dev/Peer-Agent".into(),
            reason: "Outside workspace file read requires approval.".into(),
            risk: "l1_local_read".into(),
            arguments: "{\"operation\":\"snapshot\",\"limit\":30}".into(),
        };

        for (w, h) in [(100u16, 30u16), (48u16, 22u16)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
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
                        workspace_path: Some("~/Documents/Develop/peer-dev"),
                        model_badge: "gpt-6.1-sol",
                        effort_badge: "default",
                        is_running: true,
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
                        approval: Some((&card, 1)),
                        overlay: None,
                        wordmark_elapsed_ms: None,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
            let buf = term.backend().buffer().clone();
            let mut text = String::new();
            let mut skip_next = false;
            for cell in &buf.content {
                if skip_next {
                    skip_next = false;
                    continue;
                }
                let sym = cell.symbol();
                text.push_str(sym);
                if sym.width() > 1 {
                    skip_next = true;
                }
            }
            assert!(text.contains("Approval required"));
            assert!(text.contains("本地授权请求"));
            assert!(text.contains("Action  git_query"));
            assert!(text.contains("› 2. 本会话允许此操作"));
        }
    }
}
