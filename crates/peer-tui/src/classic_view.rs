//! Full Classic interactive chat shell view (`peer --classic` & `peer sessions resume <id>`).
//!
//! Styled with Peer Frost tokens (`apps/tui/src/app.tsx`, `b3-wordmark.ts`, `composer-status-view.tsx`)
//! over bounded display items, byte-LRU Markdown/code/diff cache, reading-anchor virtualization,
//! two-column Crush role rails (`YOU`/`PEER`), centered B3 welcome composer dock, inline
//! `ModelPicker` dock, topbar subscription quota, and `ComposerStatusBar` visual meter.

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    commands::clip_bot_line,
    markdown::{RenderedBlock, WrapCacheKey, render_markdown_themed, stable_hash},
    model_picker::{ModelPickerState, render_model_picker_dock},
    overlays::{ClassicOverlay, OverlayContext, render_classic_overlay},
    slash_menu::{
        GoalMenuStatus, SlashFilterContext, SlashItem, filter_classic_slash_items,
        render_slash_menu,
    },
    terminal_text,
    theme::{
        BRAND_MARK, CARET_SELECTED, ONLINE_DOT, SEPARATOR, ThemeMode, TuiLocale, TuiPalette,
        USER_RAIL_BAR, context_meter_parts, context_usage_color, fill_canvas,
        subscription_quota_color,
    },
    view::draft_view_styled,
    wordmark::b3_wordmark_lines,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassicMessage {
    pub id: String,
    pub revision: u64,
    pub role: String,
    pub text: String,
}

pub struct ClassicView<'a> {
    pub title: &'a str,
    pub workspace_label: &'a str,
    pub model_badge: &'a str,
    pub effort_badge: &'a str,
    pub mode_badge: &'a str,
    pub access_badge: &'a str,
    pub context_percent: Option<u8>,
    pub quota_label: Option<&'a str>,
    pub quota_remaining: Option<u8>,
    pub fast_mode: bool,
    pub fast_available: bool,
    pub goal_status: GoalMenuStatus,
    pub goal_banner: Option<&'a str>,
    pub is_running: bool,
    pub activity_label: Option<&'a str>,
    pub notice: Option<&'a str>,
    pub notice_is_error: bool,
    pub palette: &'static TuiPalette,
    pub scheme_id: u8,
    pub current_theme: ThemeMode,
    pub locale: TuiLocale,
    pub messages: &'a [ClassicMessage],
    pub live_stream: &'a str,
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub status: &'a str,
    pub approval: Option<(&'a str, usize)>,
    pub model_picker: &'a ModelPickerState,
    pub overlay: &'a ClassicOverlay,
    pub slash_selected: usize,
    pub wrap_cache: &'a mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

fn short_model_name(model_badge: &str) -> &str {
    model_badge
        .split(" · ")
        .next()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(model_badge)
}

fn format_access_label(access_badge: &str, mode_badge: &str, short: bool) -> &'static str {
    if mode_badge == "plan" {
        return if short { "read-only" } else { "Read-only" };
    }
    match access_badge {
        "ask" => {
            if short {
                "ask"
            } else {
                "Ask"
            }
        }
        "session" => {
            if short {
                "approve"
            } else {
                "Approve"
            }
        }
        "full" => {
            if short {
                "full"
            } else {
                "Full access"
            }
        }
        _ => "Restricted",
    }
}

fn render_topbar(frame: &mut Frame<'_>, area: Rect, divider_area: Rect, view: &ClassicView<'_>) {
    let palette = view.palette;
    let tw = usize::from(area.width).max(1);
    let title_part = clip_bot_line(view.title, tw.saturating_sub(4).max(4));
    let quota_str = view.quota_label.filter(|s| !s.is_empty());
    let dot_str = format!(" {ONLINE_DOT}");
    let quota_part = quota_str.map(|q| format!("  {q}")).unwrap_or_default();
    let max_model_w = tw.saturating_sub(title_part.width() + quota_part.width() + 10);
    let model_text = if max_model_w > 0 {
        clip_bot_line(view.model_badge, max_model_w)
    } else {
        String::new()
    };
    let right_len = model_text.width() + dot_str.width() + quota_part.width();
    let ws_budget = tw.saturating_sub(2 + title_part.width() + right_len + 4);
    let ws_part = if ws_budget >= 6 && !view.workspace_label.is_empty() {
        format!(
            "  {}",
            clip_bot_line(view.workspace_label, ws_budget.saturating_sub(2))
        )
    } else {
        String::new()
    };
    let left_len = 2 + title_part.width() + ws_part.width();
    let gap = tw.saturating_sub(left_len + right_len);

    let mut top_spans = vec![
        Span::styled(
            format!("{BRAND_MARK} "),
            Style::new().fg(palette.accent).bg(palette.background),
        ),
        Span::styled(
            title_part,
            Style::new()
                .fg(palette.text_soft)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
        ),
    ];
    if !ws_part.is_empty() {
        top_spans.push(Span::styled(
            ws_part,
            Style::new().fg(palette.muted).bg(palette.background),
        ));
    }
    if gap >= 2 {
        top_spans.push(Span::styled(
            " ".repeat(gap),
            Style::new().bg(palette.background),
        ));
        if !model_text.is_empty() {
            top_spans.push(Span::styled(
                model_text,
                Style::new().fg(palette.muted).bg(palette.background),
            ));
        }
        top_spans.push(Span::styled(
            dot_str,
            Style::new().fg(palette.success).bg(palette.background),
        ));
        if !quota_part.is_empty() {
            top_spans.push(Span::styled(
                quota_part,
                Style::new()
                    .fg(subscription_quota_color(view.quota_remaining, palette))
                    .bg(palette.background),
            ));
        }
    }
    frame.render_widget(Paragraph::new(Line::from(top_spans)), area);
    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(usize::from(divider_area.width)),
            Style::new().fg(palette.border).bg(palette.background),
        )),
        divider_area,
    );
}

fn push_railed_block(
    out: &mut Vec<Line<'static>>,
    role: &str,
    block: &RenderedBlock,
    use_rail: bool,
    palette: &TuiPalette,
) {
    let (rail_label, rail_style, user_bar) = match role {
        "user" => (
            "YOU  ",
            Style::new().fg(palette.muted).bg(palette.background),
            true,
        ),
        "tool" => (
            "TOOL ",
            Style::new()
                .fg(palette.tool_detail)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
            false,
        ),
        "system" => (
            "SYS  ",
            Style::new()
                .fg(palette.warning)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
            false,
        ),
        _ => (
            "PEER ",
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
            false,
        ),
    };

    if !use_rail {
        let short_hdr = match role {
            "user" => "YOU",
            "tool" => "TOOL",
            "system" => "SYS",
            _ => "PEER",
        };
        out.push(Line::styled(short_hdr, rail_style));
        for styled in &block.lines {
            out.push(styled.to_ratatui_line());
        }
        out.push(Line::styled("", Style::new().bg(palette.background)));
        return;
    }

    let bg = Style::new().bg(palette.background);
    let bar_style = Style::new().fg(palette.user).bg(palette.background);
    if block.lines.is_empty() {
        let mut spans = vec![Span::styled(rail_label, rail_style), Span::styled(" ", bg)];
        if user_bar {
            spans.push(Span::styled(USER_RAIL_BAR, bar_style));
        }
        out.push(Line::from(spans));
    } else {
        for (idx, styled) in block.lines.iter().enumerate() {
            let mut spans = Vec::with_capacity(styled.to_ratatui_line().spans.len() + 3);
            if idx == 0 {
                spans.push(Span::styled(rail_label, rail_style));
                spans.push(Span::styled(" ", bg));
            } else {
                spans.push(Span::styled("      ", bg));
            }
            if user_bar {
                spans.push(Span::styled(USER_RAIL_BAR, bar_style));
            }
            spans.extend(styled.to_ratatui_line().spans);
            out.push(Line::from(spans));
        }
    }
    out.push(Line::styled("", bg));
}

fn render_composer_status_bar(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &ClassicView<'_>,
    palette: &TuiPalette,
) {
    let sw = usize::from(area.width).max(1);
    let narrow = sw < 56;
    let compact = !narrow && sw < 88;
    let mode_label = match view.mode_badge {
        "chat" => "agent",
        "plan" => "plan",
        "goal" => "goal",
        other => other,
    };
    let access_label = format_access_label(view.access_badge, view.mode_badge, narrow || compact);
    let short_model = short_model_name(view.model_badge);
    let effort = if view.effort_badge.is_empty() {
        "default"
    } else {
        view.effort_badge
    };

    let effective_pct = match view.context_percent {
        Some(p) => Some(p),
        None if view.messages.is_empty() && view.live_stream.is_empty() => Some(0),
        None => None,
    };
    let bar_w = if narrow || compact { 6 } else { 12 };
    let (filled, empty) = context_meter_parts(effective_pct, bar_w);
    let pct_text = match effective_pct {
        Some(p) => format!(" {p}%"),
        None => " ?".to_owned(),
    };
    let meter_fg = context_usage_color(effective_pct, palette);

    let subtle = Style::new().fg(palette.subtle).bg(palette.background);
    let soft = Style::new().fg(palette.text_soft).bg(palette.background);
    let accent = Style::new().fg(palette.accent).bg(palette.background);
    let muted = Style::new().fg(palette.muted).bg(palette.background);
    let meter_style = Style::new().fg(meter_fg).bg(palette.background);

    let left_spans = vec![
        Span::styled("mode ", subtle),
        Span::styled(mode_label, accent),
        Span::styled(" · ", subtle),
        Span::styled("access ", subtle),
        Span::styled(access_label, soft),
    ];
    let left_w: usize = left_spans.iter().map(|s| s.width()).sum();

    let model_budget = if narrow {
        sw.saturating_sub(effort.width() + bar_w + pct_text.width() + 6)
    } else {
        sw.saturating_sub(left_w + effort.width() + bar_w + pct_text.width() + 12)
    };
    let clipped_model = clip_bot_line(short_model, model_budget.max(4));
    let mut right_spans = vec![
        Span::styled(clipped_model, soft),
        Span::styled(" · ", subtle),
        Span::styled(effort, soft),
    ];
    if view.fast_mode {
        right_spans.push(Span::styled(" · ", subtle));
        right_spans.push(Span::styled("fast", accent));
    }
    right_spans.push(Span::styled("  ", Style::new().bg(palette.background)));
    right_spans.push(Span::styled(filled, meter_style));
    right_spans.push(Span::styled(empty, muted));
    right_spans.push(Span::styled(pct_text, meter_style));
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
        combined.push(Span::styled(
            " ".repeat(gap),
            Style::new().bg(palette.background),
        ));
        combined.extend(right_spans);
        frame.render_widget(Paragraph::new(Line::from(combined)), area);
    } else {
        frame.render_widget(Paragraph::new(Line::from(left_spans)), area);
    }
}

struct DockSpec<'a, 's> {
    slash_items: &'s [&'a SlashItem],
    slash_rows: u16,
    overlay_dock_h: u16,
    model_dock_h: u16,
    notice_text: Option<&'a str>,
    notice_is_error: bool,
    show_goal_banner: bool,
    composer_rows: u16,
    status_rows: u16,
    total_height: u16,
}

fn plan_dock_spec<'a, 's>(
    view: &ClassicView<'a>,
    slash_items: &'s [&'a SlashItem],
    dock_width: u16,
    max_dock_h: u16,
) -> DockSpec<'a, 's> {
    let overlay_open = view.overlay.is_open();
    let show_goal_banner =
        view.goal_banner.is_some() && !overlay_open && view.approval.is_none() && max_dock_h >= 6;
    let notice_text = if !view.anchor.is_following() && view.approval.is_none() {
        Some("↑ 历史阅读中 · End/PgDn 回到最新")
    } else {
        view.notice.filter(|s| !s.is_empty())
    };
    let notice_is_error = if !view.anchor.is_following() && view.approval.is_none() {
        false
    } else {
        view.notice_is_error
    };
    let status_rows: u16 = if dock_width < 56 && max_dock_h >= 5 {
        2
    } else {
        1
    };
    let composer_rows: u16 = if view.composer.draft().is_empty() || max_dock_h < 6 {
        1
    } else {
        let inner_w = usize::from(dock_width.saturating_sub(2)).max(1);
        let (lines, _) = draft_view_styled(view.composer, inner_w, 3, Style::default());
        (lines.len() as u16).clamp(1, 3)
    };
    let base = u16::from(show_goal_banner)
        + u16::from(notice_text.is_some())
        + u16::from(view.is_running)
        + 1
        + composer_rows
        + status_rows;
    let panel_budget = max_dock_h.saturating_sub(base);

    let (model_dock_h, overlay_dock_h, slash_rows) = if view.model_picker.open && panel_budget >= 4
    {
        (view.model_picker.dock_height(panel_budget), 0, 0)
    } else if !view.overlay.is_modal()
        && view.approval.is_none()
        && !view.model_picker.open
        && panel_budget >= 3
    {
        let oh = view.overlay.dock_height(panel_budget);
        if oh > 0 {
            (0, oh, 0)
        } else if !slash_items.is_empty() {
            let sr = ((slash_items.len().min(6) as u16) + 1).min(panel_budget);
            (0, 0, if sr >= 2 { sr } else { 0 })
        } else {
            (0, 0, 0)
        }
    } else if view.approval.is_none()
        && !view.model_picker.open
        && !overlay_open
        && !slash_items.is_empty()
        && panel_budget >= 2
    {
        let sr = ((slash_items.len().min(6) as u16) + 1).min(panel_budget);
        (0, 0, if sr >= 2 { sr } else { 0 })
    } else {
        (0, 0, 0)
    };
    let total_height = base + model_dock_h + overlay_dock_h + slash_rows;
    DockSpec {
        slash_items,
        slash_rows,
        overlay_dock_h,
        model_dock_h,
        notice_text,
        notice_is_error,
        show_goal_banner,
        composer_rows,
        status_rows,
        total_height,
    }
}

fn render_composer_dock(
    frame: &mut Frame<'_>,
    dock_area: Rect,
    full_area: Rect,
    view: &ClassicView<'_>,
    spec: &DockSpec<'_, '_>,
    overlay_ctx: &OverlayContext<'_>,
) {
    if dock_area.height == 0 || dock_area.width == 0 {
        return;
    }
    let palette = view.palette;
    let overlay_open = view.overlay.is_open();

    let mut constraints = Vec::new();
    if spec.show_goal_banner {
        constraints.push(Constraint::Length(1));
    }
    if spec.model_dock_h > 0 {
        constraints.push(Constraint::Length(spec.model_dock_h));
    } else if spec.overlay_dock_h > 0 {
        constraints.push(Constraint::Length(spec.overlay_dock_h));
    } else if spec.slash_rows > 0 {
        constraints.push(Constraint::Length(spec.slash_rows));
    }
    if spec.notice_text.is_some() {
        constraints.push(Constraint::Length(1));
    }
    if view.is_running {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Length(1)); // quiet divider
    constraints.push(Constraint::Length(spec.composer_rows));
    constraints.push(Constraint::Length(spec.status_rows));
    let areas = Layout::vertical(constraints).split(dock_area);
    let mut slot = 0usize;

    if spec.show_goal_banner
        && let Some(banner) = view.goal_banner
    {
        frame.render_widget(
            Paragraph::new(Line::styled(
                clip_bot_line(banner, usize::from(areas[slot].width)),
                Style::new().fg(palette.info).bg(palette.background),
            )),
            areas[slot],
        );
        slot += 1;
    }

    if spec.model_dock_h > 0 {
        render_model_picker_dock(frame, areas[slot], view.model_picker, palette);
        slot += 1;
    } else if spec.overlay_dock_h > 0 {
        render_classic_overlay(frame, areas[slot], view.overlay, overlay_ctx, palette);
        slot += 1;
    } else if spec.slash_rows > 0 {
        render_slash_menu(
            frame,
            areas[slot],
            spec.slash_items,
            view.slash_selected,
            view.locale,
            palette,
        );
        slot += 1;
    }

    if let Some(msg) = spec.notice_text {
        let fg = if view.approval.is_some() {
            palette.warning
        } else if spec.notice_is_error {
            palette.danger_soft
        } else {
            palette.accent
        };
        frame.render_widget(
            Paragraph::new(Line::styled(
                clip_bot_line(&terminal_text(msg), usize::from(areas[slot].width)),
                Style::new().fg(fg).bg(palette.background),
            )),
            areas[slot],
        );
        slot += 1;
    }

    if view.is_running {
        let rw = usize::from(areas[slot].width).max(1);
        let badge = "PEER / ACTIVE";
        let act = view
            .activity_label
            .filter(|s| !s.is_empty())
            .unwrap_or(if view.locale.is_zh() {
                "正在思考…"
            } else {
                "Working…"
            });
        let left = clip_bot_line(act, rw.saturating_sub(badge.width() + 2).max(4));
        let gap = rw.saturating_sub(left.width() + badge.width());
        let mut spans = vec![Span::styled(
            left,
            Style::new().fg(palette.accent).bg(palette.background),
        )];
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
        frame.render_widget(Paragraph::new(Line::from(spans)), areas[slot]);
        slot += 1;
    }

    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(usize::from(areas[slot].width)),
            Style::new().fg(palette.subtle).bg(palette.background),
        )),
        areas[slot],
    );
    slot += 1;

    let composer_area = areas[slot];
    slot += 1;
    if composer_area.width >= 4 {
        let cols =
            Layout::horizontal([Constraint::Length(2), Constraint::Min(1)]).split(composer_area);
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
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            )),
            cols[0],
        );
        let input_area = cols[1];
        frame.render_widget(
            Block::default().style(Style::new().bg(palette.input_bg)),
            input_area,
        );
        let (draft_lines, caret) = if view.composer.draft().is_empty() {
            let placeholder = if view.locale.is_zh() {
                "输入消息，或 /help · /resume · /model"
            } else {
                "Message Peer, or /help · /resume · /model"
            };
            (
                vec![Line::styled(
                    clip_bot_line(placeholder, usize::from(input_area.width)),
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
        frame.render_widget(Paragraph::new(draft_lines), input_area);
        if view.approval.is_none()
            && !view.model_picker.open
            && !overlay_open
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

    render_composer_status_bar(frame, areas[slot], view, palette);
}

pub fn render_classic(frame: &mut Frame<'_>, view: ClassicView<'_>) {
    let full_area = frame.area();
    if full_area.width == 0 || full_area.height == 0 {
        return;
    }
    let palette = view.palette;
    fill_canvas(frame, full_area, palette.background);

    let hpad: u16 = if full_area.width >= 20 { 1 } else { 0 };
    let area = Rect {
        x: full_area.x + hpad,
        y: full_area.y,
        width: full_area.width.saturating_sub(hpad * 2),
        height: full_area.height,
    };
    if area.width == 0 || area.height == 0 {
        frame.set_cursor_position((full_area.x, full_area.y));
        return;
    }

    let overlay_open = view.overlay.is_open();
    let slash_items = if view.approval.is_none() && !view.model_picker.open && !overlay_open {
        filter_classic_slash_items(
            view.composer.draft(),
            SlashFilterContext {
                fast_available: view.fast_available,
                goal_status: view.goal_status,
            },
        )
    } else {
        Vec::new()
    };

    let overlay_ctx = OverlayContext {
        current_mode: view.mode_badge,
        current_access: view.access_badge,
        current_theme: view.current_theme,
        current_locale: view.locale,
        fast_available: view.fast_available,
        goal_status: view.goal_status,
    };

    if area.height < 5 {
        render_topbar(
            frame,
            Rect { height: 1, ..area },
            Rect {
                y: area.y + 1,
                height: 1.min(area.height.saturating_sub(1)),
                ..area
            },
            &view,
        );
        let dock_y = area.y + 2.min(area.height.saturating_sub(1));
        let dock_h = area.height.saturating_sub(dock_y - area.y);
        let dock_area = Rect {
            x: area.x,
            y: dock_y,
            width: area.width,
            height: dock_h,
        };
        let spec = plan_dock_spec(&view, &slash_items, dock_area.width, dock_area.height);
        render_composer_dock(frame, dock_area, full_area, &view, &spec, &overlay_ctx);
        return;
    }

    let chrome = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
    ])
    .split(area);
    render_topbar(frame, chrome[0], chrome[1], &view);
    let main_area = chrome[2];

    let is_welcome = view.messages.is_empty()
        && view.live_stream.is_empty()
        && view.approval.is_none()
        && !view.overlay.is_modal();

    if is_welcome {
        let welcome_w = area.width.min(112);
        let dock_x = area.x + area.width.saturating_sub(welcome_w) / 2;
        let spec = plan_dock_spec(
            &view,
            &slash_items,
            welcome_w,
            main_area.height.saturating_sub(2),
        );
        let (wm_lines, wm_w) = b3_wordmark_lines(welcome_w, palette);
        let wm_h = wm_lines.len() as u16;
        let show_wm = wm_h > 0 && main_area.height >= spec.total_height + wm_h + 2;
        let group_h = if show_wm {
            wm_h + 2 + spec.total_height
        } else {
            spec.total_height.min(main_area.height)
        };
        let top_pad = main_area.height.saturating_sub(group_h) / 2;
        let mut cursor_y = main_area.y + top_pad;

        if show_wm {
            let wm_left = usize::from(welcome_w.saturating_sub(wm_w)) / 2;
            let padded: Vec<Line<'static>> = wm_lines
                .into_iter()
                .map(|l| {
                    if wm_left == 0 {
                        l
                    } else {
                        let mut spans = vec![Span::styled(
                            " ".repeat(wm_left),
                            Style::new().bg(palette.background),
                        )];
                        spans.extend(l.spans);
                        Line::from(spans)
                    }
                })
                .collect();
            frame.render_widget(
                Paragraph::new(padded),
                Rect {
                    x: dock_x,
                    y: cursor_y,
                    width: welcome_w,
                    height: wm_h,
                },
            );
            cursor_y += wm_h + 2;
        }

        let dock_h = spec
            .total_height
            .min(main_area.y + main_area.height - cursor_y);
        render_composer_dock(
            frame,
            Rect {
                x: dock_x,
                y: cursor_y,
                width: welcome_w,
                height: dock_h,
            },
            full_area,
            &view,
            &spec,
            &overlay_ctx,
        );
        return;
    }

    let spec = plan_dock_spec(
        &view,
        &slash_items,
        area.width,
        main_area.height.saturating_sub(1),
    );
    let body_dock = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(spec.total_height.min(main_area.height)),
    ])
    .split(main_area);
    let body_area = body_dock[0];
    let dock_area = body_dock[1];
    let body_w = usize::from(body_area.width).max(1);
    let body_h = usize::from(body_area.height);

    if let Some((approval_text, scroll_top)) = view.approval {
        let block = render_markdown_themed(
            approval_text,
            body_w,
            Style::new().fg(palette.warning).bg(palette.background),
            512,
            palette,
        );
        let last = block.lines.len().saturating_sub(body_h);
        let visible: Vec<Line<'static>> = block
            .lines
            .iter()
            .skip(scroll_top.min(last))
            .take(body_h)
            .map(|l| l.to_ratatui_line())
            .collect();
        frame.render_widget(Paragraph::new(visible), body_area);
    } else {
        let use_rail = body_w >= 24;
        let mut all_lines: Vec<Line<'static>> = Vec::new();
        for msg in view.messages {
            let wrap_w = if !use_rail {
                body_w
            } else if msg.role == "user" {
                body_w.saturating_sub(8).max(8)
            } else {
                body_w.saturating_sub(6).max(8)
            };
            let key = WrapCacheKey {
                item_hash: stable_hash(&msg.id),
                revision: msg.revision,
                width: wrap_w as u16,
                scheme: view.scheme_id,
            };
            let block = if let Some(cached) = view.wrap_cache.get(&key) {
                cached.clone()
            } else {
                let computed = render_markdown_themed(
                    &msg.text,
                    wrap_w,
                    Style::new().fg(palette.text).bg(palette.background),
                    200,
                    palette,
                );
                view.wrap_cache.insert(key, computed.clone());
                computed
            };
            push_railed_block(&mut all_lines, &msg.role, &block, use_rail, palette);
        }

        if !view.live_stream.is_empty() {
            let wrap_w = if use_rail {
                body_w.saturating_sub(6).max(8)
            } else {
                body_w
            };
            let live_block = render_markdown_themed(
                view.live_stream,
                wrap_w,
                Style::new().fg(palette.text).bg(palette.background),
                120,
                palette,
            );
            push_railed_block(&mut all_lines, "assistant", &live_block, use_rail, palette);
        }

        let max_back = all_lines.len().saturating_sub(body_h);
        let back = view.anchor.lines_back().min(max_back);
        let end = all_lines.len().saturating_sub(back);
        let start = end.saturating_sub(body_h);
        let visible: Vec<Line<'static>> = all_lines
            .into_iter()
            .skip(start)
            .take(end - start)
            .collect();
        frame.render_widget(Paragraph::new(visible), body_area);
    }

    render_composer_dock(frame, dock_area, full_area, &view, &spec, &overlay_ctx);

    if !view.model_picker.open && view.overlay.is_modal() {
        render_classic_overlay(frame, full_area, view.overlay, &overlay_ctx, palette);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bounded_cache::MARKDOWN_WRAP_CACHE_BYTES, theme::DARK_PALETTE};
    use ratatui::{Terminal, backend::TestBackend};

    fn buffer_text(term: &Terminal<TestBackend>) -> String {
        let buf = term.backend().buffer();
        let mut text = String::new();
        let mut skip_next = false;
        for c in &buf.content {
            if skip_next {
                skip_next = false;
                continue;
            }
            let sym = c.symbol();
            text.push_str(sym);
            if sym.width() > 1 {
                skip_next = true;
            }
        }
        text
    }

    #[test]
    fn classic_view_renders_crush_rails_status_bar_and_quota_without_panic() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 128);
        let composer = Composer::default();
        let mut anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let msgs = vec![
            ClassicMessage {
                id: "u1".into(),
                revision: 1,
                role: "user".into(),
                text: "请帮我写一段 Rust 代码".into(),
            },
            ClassicMessage {
                id: "a1".into(),
                revision: 1,
                role: "assistant".into(),
                text: "好的：\n```rust\nfn main() { println!(\"ok\"); }\n```".into(),
            },
        ];
        anchor.scroll_up(2, 20, Some("u1".into()));

        for (w, h) in [(120, 40), (48, 16), (12, 6)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            term.draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "GPT-6.1 Sol · ChatGPT 订阅",
                        effort_badge: "high",
                        mode_badge: "chat",
                        access_badge: "session",
                        context_percent: Some(42),
                        quota_label: Some("剩余72% · plus"),
                        quota_remaining: Some(72),
                        fast_mode: false,
                        fast_available: true,
                        goal_status: GoalMenuStatus::None,
                        goal_banner: None,
                        is_running: true,
                        activity_label: Some("正在思考…"),
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "流式输出...",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
            if w == 120 {
                let text = buffer_text(&term);
                assert!(text.contains("◆ Peer"));
                assert!(text.contains("剩余72% · plus"));
                assert!(text.contains("YOU"));
                assert!(text.contains("PEER"));
                assert!(text.contains("PEER / ACTIVE"));
                assert!(text.contains("mode agent · access Approve"));
                assert!(text.contains("GPT-6.1 Sol · high"));
                assert!(text.contains("42%"));
            }
        }
    }

    #[test]
    fn classic_welcome_screen_renders_centered_b3_wordmark_and_status_bar() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 16);
        let composer = Composer::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let mut term = Terminal::new(TestBackend::new(100, 30)).unwrap();
        term.draw(|f| {
            render_classic(
                f,
                ClassicView {
                    title: "Peer",
                    workspace_label: "~/Documents/Develop/peer-dev",
                    model_badge: "gpt-6.1-sol · ChatGPT 订阅",
                    effort_badge: "default",
                    mode_badge: "chat",
                    access_badge: "ask",
                    context_percent: None,
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_banner: None,
                    is_running: false,
                    activity_label: None,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &[],
                    live_stream: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "",
                    approval: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::None,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
        let text = buffer_text(&term);
        assert!(text.contains("agent"));
        assert!(text.contains("◆ Peer"));
        assert!(text.contains("mode agent · access Ask"));
        assert!(text.contains("0%"));
    }
}
