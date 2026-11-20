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
    goal_panel::{
        GoalPanelView, PlanApprovalCard, goal_side_panel_width, plan_approval_dock_height,
        render_goal_compact_summary, render_goal_status_panel, render_plan_approval_dock,
    },
    markdown::{
        LineLink, RenderedBlock, ScreenHyperlink, StyledLine, WrapCacheKey, project_line_links,
        render_markdown_themed, stable_hash, stamp_screen_link_id,
    },
    model_picker::{ModelPickerState, render_model_picker_dock},
    overlays::{ClassicOverlay, OverlayContext, render_classic_overlay},
    slash_menu::{
        GoalMenuStatus, SlashFilterContext, SlashItem, filter_classic_slash_items,
        render_slash_menu,
    },
    terminal_text,
    theme::{
        BRAND_MARK, CARET_SELECTED, ONLINE_DOT, QUOTE_PREFIX, RUNNING_ACTIVITY_LABEL, SEPARATOR,
        TOOL_DETAIL_PIPE, TOOL_GLYPH_CANCELLED, TOOL_GLYPH_COMPLETED, TOOL_GLYPH_FAILED,
        TOOL_GLYPH_RUNNING, TOOL_GLYPH_RUNNING_PULSE, TOOL_GLYPH_UNKNOWN, ThemeMode, TuiLocale,
        TuiPalette, USER_RAIL_BAR, activity_sweep_color, context_meter_parts, context_usage_color,
        fill_canvas, format_running_elapsed, format_tool_duration, subscription_quota_color,
        thinking_status_label,
    },
    view::draft_view_styled,
    wordmark::b3_wordmark_lines,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApprovalCard {
    pub action: String,
    pub location: String,
    pub reason: String,
    pub risk: String,
    pub arguments: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolRowStatus {
    Completed,
    Failed,
    Cancelled,
    Denied,
    Running,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolTimelineRow {
    pub call_id: String,
    pub capability_id: String,
    pub tool_name: String,
    pub summary: String,
    pub status: ToolRowStatus,
    pub duration_ms: Option<u64>,
    pub detail_lines: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UserInputPrompt {
    pub question: String,
    pub options: Vec<String>,
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassicMessage {
    pub id: String,
    pub revision: u64,
    pub role: String,
    pub text: String,
    pub thinking: Option<String>,
    pub tools: Vec<ToolTimelineRow>,
    pub continuation: bool,
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
    pub goal_panel: Option<&'a GoalPanelView>,
    pub plan_approval: Option<(&'a PlanApprovalCard, usize)>,
    pub is_running: bool,
    pub activity_label: Option<&'a str>,
    pub animation_frame: usize,
    pub running_elapsed_ms: u64,
    pub tools_expanded: bool,
    pub notice: Option<&'a str>,
    pub notice_is_error: bool,
    pub palette: &'static TuiPalette,
    pub scheme_id: u8,
    pub current_theme: ThemeMode,
    pub locale: TuiLocale,
    pub messages: &'a [ClassicMessage],
    pub live_stream: &'a str,
    pub live_thinking: &'a str,
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub status: &'a str,
    pub approval: Option<(&'a ApprovalCard, usize)>,
    pub user_input: Option<(&'a UserInputPrompt, usize)>,
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

fn is_evidence_detail(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    lower.contains("tool-result://")
        || lower.contains("local-shell-artifact://")
        || lower.contains("artifact://")
        || lower.contains("evidence://")
        || lower.contains("evidence")
        || lower.contains("artifact")
}

fn render_thinking_lines(thinking: &str, col_w: usize, palette: &TuiPalette) -> Vec<Line<'static>> {
    render_thinking_lines_with_label("Thinking", thinking, col_w, 48, palette)
}

fn render_thinking_lines_with_label(
    label: &str,
    thinking: &str,
    col_w: usize,
    max_lines: usize,
    palette: &TuiPalette,
) -> Vec<Line<'static>> {
    let mut lines = Vec::new();
    let bg = palette.background;
    lines.push(Line::styled(
        label.to_owned(),
        Style::new().fg(palette.muted).bg(bg),
    ));
    let quote_w = col_w.saturating_sub(2).max(6);
    let block = render_markdown_themed(
        thinking,
        quote_w,
        Style::new()
            .fg(palette.muted)
            .bg(bg)
            .add_modifier(Modifier::ITALIC),
        max_lines,
        palette,
    );
    let quote_style = Style::new().fg(palette.subtle).bg(bg);
    for styled in block.lines {
        let mut spans = vec![Span::styled(QUOTE_PREFIX, quote_style)];
        spans.extend(styled.to_ratatui_line().spans);
        lines.push(Line::from(spans));
    }
    lines
}

fn render_tool_timeline_lines(
    row: &ToolTimelineRow,
    col_w: usize,
    animation_frame: usize,
    expanded: bool,
    palette: &TuiPalette,
) -> Vec<Line<'static>> {
    let bg = palette.background;
    let (glyph, glyph_fg) = match row.status {
        ToolRowStatus::Completed => (TOOL_GLYPH_COMPLETED, palette.tool),
        ToolRowStatus::Failed | ToolRowStatus::Denied => (TOOL_GLYPH_FAILED, palette.tool_failed),
        ToolRowStatus::Cancelled => (TOOL_GLYPH_CANCELLED, palette.tool_cancelled),
        ToolRowStatus::Running => {
            let g = if (animation_frame / 3).is_multiple_of(2) {
                TOOL_GLYPH_RUNNING
            } else {
                TOOL_GLYPH_RUNNING_PULSE
            };
            (g, palette.tool_running)
        }
        ToolRowStatus::Unknown => (TOOL_GLYPH_UNKNOWN, palette.tool_detail),
    };

    let mut out = Vec::new();
    let glyph_span = Span::styled(format!("{glyph} "), Style::new().fg(glyph_fg).bg(bg));
    let safe_name = terminal_text(&row.tool_name);
    let name_w = col_w.saturating_sub(4).max(1);
    let name_clipped = clip_bot_line(&safe_name, name_w);
    let name_span = Span::styled(
        name_clipped.clone(),
        Style::new().fg(palette.text_soft).bg(bg),
    );
    let mut spans = vec![glyph_span, name_span];
    let left_w = 2 + name_clipped.width();

    if col_w >= 28 {
        let dur = format_tool_duration(row.status == ToolRowStatus::Running, row.duration_ms);
        let dur_col = format!("{dur:>7}");
        let dur_fg = if row.status == ToolRowStatus::Running {
            palette.accent
        } else {
            palette.subtle
        };
        let (toggle_txt, toggle_fg) = if row.detail_lines.is_empty() {
            ("  ", palette.subtle)
        } else if expanded {
            (" −", palette.muted)
        } else {
            (" +", palette.muted)
        };
        let right_reserve = 2 + 7 + 2; // 2 gap + 7 duration + 2 toggle
        let gap_after_name = if col_w > left_w + 2 { 2 } else { 0 };
        if gap_after_name > 0 {
            spans.push(Span::styled("  ", Style::new().bg(bg)));
        }
        let summary_budget = col_w.saturating_sub(left_w + gap_after_name + right_reserve);
        let summary_txt = if summary_budget >= 4 && !row.summary.is_empty() {
            clip_bot_line(&terminal_text(&row.summary), summary_budget)
        } else {
            String::new()
        };
        let summary_w = summary_txt.width();
        if !summary_txt.is_empty() {
            spans.push(Span::styled(
                summary_txt,
                Style::new().fg(palette.muted).bg(bg),
            ));
        }
        let used = left_w + gap_after_name + summary_w;
        let pad_w = col_w.saturating_sub(used + right_reserve);
        if pad_w + 2 > 0 {
            spans.push(Span::styled(" ".repeat(pad_w + 2), Style::new().bg(bg)));
        }
        spans.push(Span::styled(dur_col, Style::new().fg(dur_fg).bg(bg)));
        spans.push(Span::styled(toggle_txt, Style::new().fg(toggle_fg).bg(bg)));
    } else if col_w > left_w + 2 && !row.summary.is_empty() {
        spans.push(Span::styled("  ", Style::new().bg(bg)));
        let clipped = clip_bot_line(
            &terminal_text(&row.summary),
            col_w.saturating_sub(left_w + 2),
        );
        spans.push(Span::styled(clipped, Style::new().fg(palette.muted).bg(bg)));
    }
    out.push(Line::from(spans));

    if expanded && !row.detail_lines.is_empty() {
        let detail_budget = col_w.saturating_sub(2).max(4);
        for detail in row.detail_lines.iter().take(4) {
            let clean = terminal_text(detail);
            let mut dspans = vec![Span::styled(
                format!("{TOOL_DETAIL_PIPE} "),
                Style::new().fg(palette.subtle).bg(bg),
            )];
            if is_evidence_detail(&clean) && detail_budget > 12 {
                dspans.push(Span::styled(
                    "evidence ",
                    Style::new().fg(palette.success).bg(bg),
                ));
                let rest = clip_bot_line(&clean, detail_budget.saturating_sub(9));
                dspans.push(Span::styled(
                    rest,
                    Style::new().fg(palette.text_soft).bg(bg),
                ));
            } else {
                let clipped = clip_bot_line(&clean, detail_budget);
                dspans.push(Span::styled(
                    clipped,
                    Style::new().fg(palette.tool_detail).bg(bg),
                ));
            }
            out.push(Line::from(dspans));
        }
    }
    out
}

struct VisualLine {
    line: Line<'static>,
    links: Vec<LineLink>,
}

impl VisualLine {
    fn plain(line: Line<'static>) -> Self {
        Self {
            line,
            links: Vec::new(),
        }
    }

    fn from_styled(styled: StyledLine, block_prefix: u32) -> Self {
        let line = styled.to_ratatui_line();
        let links = styled
            .links
            .into_iter()
            .map(|mut link| {
                link.id = stamp_screen_link_id(block_prefix, link.id);
                link
            })
            .collect();
        Self { line, links }
    }
}

fn push_railed_lines(
    out: &mut Vec<VisualLine>,
    role: &str,
    lines: Vec<VisualLine>,
    continuation: bool,
    trailing_blank: bool,
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
        if !continuation {
            let short_hdr = match role {
                "user" => "YOU",
                "tool" => "TOOL",
                "system" => "SYS",
                _ => "PEER",
            };
            out.push(VisualLine::plain(Line::styled(short_hdr, rail_style)));
        }
        out.extend(lines);
        if trailing_blank {
            out.push(VisualLine::plain(Line::styled(
                "",
                Style::new().bg(palette.background),
            )));
        }
        return;
    }

    let bg = Style::new().bg(palette.background);
    let bar_style = Style::new().fg(palette.user).bg(palette.background);
    if lines.is_empty() {
        let mut spans = if continuation {
            vec![Span::styled("      ", bg)]
        } else {
            vec![Span::styled(rail_label, rail_style), Span::styled(" ", bg)]
        };
        if user_bar {
            spans.push(Span::styled(USER_RAIL_BAR, bar_style));
        }
        out.push(VisualLine::plain(Line::from(spans)));
    } else {
        let rail_cols: u16 = if user_bar { 8 } else { 6 };
        for (idx, vline) in lines.into_iter().enumerate() {
            let mut spans = Vec::with_capacity(vline.line.spans.len() + 3);
            if idx == 0 && !continuation {
                spans.push(Span::styled(rail_label, rail_style));
                spans.push(Span::styled(" ", bg));
            } else {
                spans.push(Span::styled("      ", bg));
            }
            if user_bar {
                spans.push(Span::styled(USER_RAIL_BAR, bar_style));
            }
            spans.extend(vline.line.spans);
            let mut links = vline.links;
            for link in &mut links {
                link.col_start = link.col_start.saturating_add(rail_cols);
                link.col_end = link.col_end.saturating_add(rail_cols);
            }
            out.push(VisualLine {
                line: Line::from(spans),
                links,
            });
        }
    }
    if trailing_blank {
        out.push(VisualLine::plain(Line::styled("", bg)));
    }
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
        None if view.messages.is_empty()
            && view.live_stream.is_empty()
            && view.live_thinking.trim().is_empty() =>
        {
            Some(0)
        }
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
    approval_dock_h: u16,
    plan_approval_dock_h: u16,
    user_input_dock_h: u16,
    notice_text: Option<&'a str>,
    notice_is_error: bool,
    show_goal_compact: bool,
    composer_rows: u16,
    status_rows: u16,
    total_height: u16,
}

fn approval_dock_height(panel_budget: u16) -> u16 {
    panel_budget.min(12)
}

fn render_approval_dock(
    frame: &mut Frame<'_>,
    area: Rect,
    card: &ApprovalCard,
    selected: usize,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if area.height < 4 || area.width == 0 {
        return;
    }
    let panel_bg = palette.panel;
    let content_area = if area.height >= 7 && area.width >= 16 {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(palette.danger).bg(palette.background))
            .style(Style::new().bg(panel_bg));
        let inner = block.inner(area);
        frame.render_widget(block, area);
        if inner.width >= 14 {
            Rect {
                x: inner.x + 1,
                y: inner.y,
                width: inner.width - 2,
                height: inner.height,
            }
        } else {
            inner
        }
    } else {
        frame.render_widget(Block::new().style(Style::new().bg(panel_bg)), area);
        area
    };
    if content_area.height == 0 || content_area.width == 0 {
        return;
    }
    let cw = usize::from(content_area.width);
    let mut y = content_area.y;
    let y_end = content_area.y + content_area.height;
    let push_line = |frame: &mut Frame<'_>, row_y: &mut u16, line: Line<'static>| {
        if *row_y < y_end {
            frame.render_widget(
                Paragraph::new(line).style(Style::new().bg(panel_bg)),
                Rect {
                    x: content_area.x,
                    y: *row_y,
                    width: content_area.width,
                    height: 1,
                },
            );
            *row_y += 1;
        }
    };

    let title = if locale.is_zh() {
        "Approval required · 本地授权请求"
    } else {
        "Approval required"
    };
    push_line(
        frame,
        &mut y,
        Line::styled(
            clip_bot_line(title, cw),
            Style::new()
                .fg(palette.danger_soft)
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
    );

    let avail = content_area.height.saturating_sub(4);
    let show_hint = avail >= 6;
    let detail_rows: Vec<(&str, &str, ratatui::style::Color)> = match avail {
        0 => Vec::new(),
        1 => vec![("Action  ", &card.action, palette.danger_soft)],
        2 => vec![
            ("Action  ", &card.action, palette.danger_soft),
            ("Args    ", &card.arguments, palette.text_soft),
        ],
        3 => vec![
            ("Action  ", &card.action, palette.danger_soft),
            ("Where   ", &card.location, palette.muted),
            ("Args    ", &card.arguments, palette.text_soft),
        ],
        4 => vec![
            ("Action  ", &card.action, palette.danger_soft),
            ("Where   ", &card.location, palette.muted),
            ("Risk    ", &card.risk, palette.warning),
            ("Args    ", &card.arguments, palette.text_soft),
        ],
        _ => vec![
            ("Action  ", &card.action, palette.danger_soft),
            ("Where   ", &card.location, palette.muted),
            ("Reason  ", &card.reason, palette.muted),
            ("Risk    ", &card.risk, palette.warning),
            ("Args    ", &card.arguments, palette.text_soft),
        ],
    };
    for (prefix, val, fg) in detail_rows {
        let label_w = prefix.width();
        let line = if cw <= label_w {
            Line::styled(
                clip_bot_line(prefix.trim_end(), cw),
                Style::new().fg(fg).bg(panel_bg),
            )
        } else {
            let val_clean = clip_bot_line(&terminal_text(val), cw - label_w);
            Line::from(vec![
                Span::styled(prefix.to_owned(), Style::new().fg(fg).bg(panel_bg)),
                Span::styled(val_clean, Style::new().fg(fg).bg(panel_bg)),
            ])
        };
        push_line(frame, &mut y, line);
    }

    let sel = selected.min(2);
    let options = if locale.is_zh() {
        [
            ("1. 允许本次", palette.success),
            ("2. 本会话允许此操作", palette.diff_hunk),
            ("3. 拒绝", palette.danger_soft),
        ]
    } else {
        [
            ("1. Allow once", palette.success),
            ("2. Allow this operation this session", palette.diff_hunk),
            ("3. Deny", palette.danger_soft),
        ]
    };
    for (idx, (label, fg)) in options.iter().enumerate() {
        let is_sel = idx == sel;
        let caret = if is_sel { "› " } else { "  " };
        let style = if is_sel {
            Style::new()
                .fg(*fg)
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.muted).bg(panel_bg)
        };
        push_line(
            frame,
            &mut y,
            Line::styled(clip_bot_line(&format!("{caret}{label}"), cw), style),
        );
    }

    if show_hint {
        let hint = if locale.is_zh() {
            "↑/↓ 选择 · Enter 确认 · 1/y 允许本次 · 2 本会话允许 · 3/n/Esc 拒绝"
        } else {
            "↑/↓ select · Enter confirm · 1/y once · 2 session · 3/n/Esc deny"
        };
        push_line(
            frame,
            &mut y,
            Line::styled(
                clip_bot_line(hint, cw),
                Style::new().fg(palette.muted).bg(panel_bg),
            ),
        );
    }
}

pub(crate) fn wrap_plain_lines(text: &str, max_w: usize, max_lines: usize) -> Vec<String> {
    let safe = terminal_text(text);
    let trimmed = safe.trim();
    if trimmed.is_empty() || max_w == 0 || max_lines == 0 {
        return Vec::new();
    }
    let mut out: Vec<String> = Vec::new();
    for raw_line in trimmed.lines() {
        if out.len() >= max_lines {
            break;
        }
        let mut cur = String::new();
        let mut cur_w = 0usize;
        for ch in raw_line.chars() {
            let mut buf = [0u8; 4];
            let cw = ch.encode_utf8(&mut buf).width().max(1);
            if cur_w + cw > max_w && !cur.is_empty() {
                out.push(std::mem::take(&mut cur));
                cur_w = 0;
                if out.len() >= max_lines {
                    break;
                }
            }
            cur.push(ch);
            cur_w += cw;
        }
        if !cur.is_empty() && out.len() < max_lines {
            out.push(cur);
        }
    }
    out
}

fn user_input_dock_layout(
    prompt: &UserInputPrompt,
    dock_width: u16,
    panel_budget: u16,
) -> (Vec<String>, usize, bool) {
    let rem = panel_budget.saturating_sub(2);
    let show_footer = rem >= 3;
    let footer_h = u16::from(show_footer);
    let avail_q_and_opts = rem.saturating_sub(footer_h);
    let q_cap = if avail_q_and_opts >= 3 { 2 } else { 1 };
    let text_w = usize::from(dock_width.saturating_sub(2)).max(1);
    let q_lines = wrap_plain_lines(&prompt.question, text_w, q_cap);
    let q_h = q_lines.len() as u16;
    let avail_opts = usize::from(avail_q_and_opts.saturating_sub(q_h)).max(1);
    let vis_opts = prompt.options.len().min(6).min(avail_opts);
    (q_lines, vis_opts, show_footer)
}

fn user_input_dock_height(prompt: &UserInputPrompt, dock_width: u16, panel_budget: u16) -> u16 {
    let (q_lines, vis_opts, show_footer) = user_input_dock_layout(prompt, dock_width, panel_budget);
    (2 + q_lines.len() as u16 + vis_opts as u16 + u16::from(show_footer)).min(panel_budget)
}

fn render_user_input_dock(
    frame: &mut Frame<'_>,
    area: Rect,
    prompt: &UserInputPrompt,
    selected: usize,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if area.height < 3 || area.width == 0 || prompt.options.is_empty() {
        return;
    }
    let pw = usize::from(area.width).max(1);
    let (q_lines, vis_opts, show_footer) = user_input_dock_layout(prompt, area.width, area.height);

    let divider_area = Rect { height: 1, ..area };
    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(pw),
            Style::new().fg(palette.border).bg(palette.background),
        )),
        divider_area,
    );

    let body_area = Rect {
        x: area.x,
        y: area.y + 1,
        width: area.width,
        height: area.height - 1,
    };
    let panel_bg = palette.panel;
    frame.render_widget(Block::new().style(Style::new().bg(panel_bg)), body_area);

    let mut y = body_area.y;
    let y_end = body_area.y + body_area.height;
    let push_line = |frame: &mut Frame<'_>, row_y: &mut u16, line: Line<'static>| {
        if *row_y < y_end {
            frame.render_widget(
                Paragraph::new(line).style(Style::new().bg(panel_bg)),
                Rect {
                    x: body_area.x,
                    y: *row_y,
                    width: body_area.width,
                    height: 1,
                },
            );
            *row_y += 1;
        }
    };

    let hide_hint = if locale.is_zh() {
        " · Esc 收起"
    } else {
        " · Esc hide"
    };
    let header = Line::from(vec![
        Span::styled(
            clip_bot_line(" Ask user", pw),
            Style::new()
                .fg(palette.accent)
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
        Span::styled(
            clip_bot_line(hide_hint, pw.saturating_sub(9)),
            Style::new().fg(palette.muted).bg(panel_bg),
        ),
    ]);
    push_line(frame, &mut y, header);

    for q in q_lines {
        push_line(
            frame,
            &mut y,
            Line::styled(
                clip_bot_line(&format!(" {q}"), pw),
                Style::new().fg(palette.text).bg(panel_bg),
            ),
        );
    }

    let total = prompt.options.len();
    let sel = selected.min(total - 1);
    let mut start = 0usize;
    if total > vis_opts {
        start = sel.saturating_sub(vis_opts / 2);
        if start + vis_opts > total {
            start = total - vis_opts;
        }
    }
    for (idx, opt) in prompt.options.iter().enumerate().skip(start).take(vis_opts) {
        let is_sel = idx == sel;
        let prefix = if is_sel { " › " } else { "   " };
        let shortcut = if idx < 9 {
            format!("[{}]", idx + 1)
        } else {
            "[•]".to_owned()
        };
        let row_text = clip_bot_line(&format!("{prefix}{shortcut} {}", terminal_text(opt)), pw);
        let style = if is_sel {
            Style::new()
                .fg(palette.accent)
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.muted).bg(panel_bg)
        };
        push_line(frame, &mut y, Line::styled(row_text, style));
    }

    if show_footer {
        let hint = if locale.is_zh() {
            " ↑↓ 选择 · 1-9 / Enter 确认 · 下方可直接输入自由回复"
        } else {
            " ↑↓ select · 1-9 / Enter confirm · type free text below"
        };
        push_line(
            frame,
            &mut y,
            Line::styled(
                clip_bot_line(hint, pw),
                Style::new().fg(palette.muted).bg(panel_bg),
            ),
        );
    }
}

fn plan_dock_spec<'a, 's>(
    view: &ClassicView<'a>,
    slash_items: &'s [&'a SlashItem],
    dock_width: u16,
    max_dock_h: u16,
    show_side_panel: bool,
) -> DockSpec<'a, 's> {
    let overlay_open = view.overlay.is_open();
    let show_goal_compact = view.goal_panel.is_some()
        && !show_side_panel
        && !overlay_open
        && view.approval.is_none()
        && view.plan_approval.is_none()
        && max_dock_h >= 6;
    let reading_locked =
        !view.anchor.is_following() && view.approval.is_none() && view.plan_approval.is_none();
    let notice_text = if reading_locked {
        Some("↑ 历史阅读中 · End/PgDn 回到最新")
    } else {
        view.notice.filter(|s| !s.is_empty())
    };
    let notice_is_error = if reading_locked {
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
    let base = u16::from(show_goal_compact)
        + u16::from(notice_text.is_some())
        + u16::from(view.is_running)
        + 1
        + composer_rows
        + status_rows;
    let panel_budget = max_dock_h.saturating_sub(base);

    let (
        model_dock_h,
        approval_dock_h,
        plan_approval_dock_h,
        overlay_dock_h,
        user_input_dock_h,
        slash_rows,
    ) = if view.model_picker.open && panel_budget >= 4 {
        (view.model_picker.dock_height(panel_budget), 0, 0, 0, 0, 0)
    } else if view.approval.is_some() && panel_budget >= 4 {
        (0, approval_dock_height(panel_budget), 0, 0, 0, 0)
    } else if let Some((card, _)) = view.plan_approval
        && !view.is_running
        && !overlay_open
        && panel_budget >= 4
    {
        (
            0,
            0,
            plan_approval_dock_height(card, dock_width, panel_budget),
            0,
            0,
            0,
        )
    } else if !view.overlay.is_modal()
        && view.approval.is_none()
        && view.plan_approval.is_none()
        && !view.model_picker.open
        && panel_budget >= 3
    {
        let oh = view.overlay.dock_height(panel_budget);
        if oh > 0 {
            (0, 0, 0, oh, 0, 0)
        } else if !slash_items.is_empty() {
            let sr = ((slash_items.len().min(6) as u16) + 1).min(panel_budget);
            (0, 0, 0, 0, 0, if sr >= 2 { sr } else { 0 })
        } else if let Some((prompt, _)) = view.user_input
            && !view.is_running
            && !prompt.options.is_empty()
            && panel_budget >= 4
        {
            (
                0,
                0,
                0,
                0,
                user_input_dock_height(prompt, dock_width, panel_budget),
                0,
            )
        } else {
            (0, 0, 0, 0, 0, 0)
        }
    } else if view.approval.is_none()
        && view.plan_approval.is_none()
        && !view.model_picker.open
        && !overlay_open
        && !slash_items.is_empty()
        && panel_budget >= 2
    {
        let sr = ((slash_items.len().min(6) as u16) + 1).min(panel_budget);
        (0, 0, 0, 0, 0, if sr >= 2 { sr } else { 0 })
    } else {
        (0, 0, 0, 0, 0, 0)
    };
    let total_height = base
        + model_dock_h
        + approval_dock_h
        + plan_approval_dock_h
        + overlay_dock_h
        + user_input_dock_h
        + slash_rows;
    DockSpec {
        slash_items,
        slash_rows,
        overlay_dock_h,
        model_dock_h,
        approval_dock_h,
        plan_approval_dock_h,
        user_input_dock_h,
        notice_text,
        notice_is_error,
        show_goal_compact,
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
    if spec.show_goal_compact {
        constraints.push(Constraint::Length(1));
    }
    if spec.model_dock_h > 0 {
        constraints.push(Constraint::Length(spec.model_dock_h));
    } else if spec.approval_dock_h > 0 {
        constraints.push(Constraint::Length(spec.approval_dock_h));
    } else if spec.plan_approval_dock_h > 0 {
        constraints.push(Constraint::Length(spec.plan_approval_dock_h));
    } else if spec.overlay_dock_h > 0 {
        constraints.push(Constraint::Length(spec.overlay_dock_h));
    } else if spec.user_input_dock_h > 0 {
        constraints.push(Constraint::Length(spec.user_input_dock_h));
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

    if spec.show_goal_compact
        && let Some(panel) = view.goal_panel
    {
        render_goal_compact_summary(frame, areas[slot], panel, palette);
        slot += 1;
    }

    if spec.model_dock_h > 0 {
        render_model_picker_dock(frame, areas[slot], view.model_picker, palette);
        slot += 1;
    } else if spec.approval_dock_h > 0
        && let Some((card, selected)) = view.approval
    {
        render_approval_dock(frame, areas[slot], card, selected, view.locale, palette);
        slot += 1;
    } else if spec.plan_approval_dock_h > 0
        && let Some((card, selected)) = view.plan_approval
    {
        render_plan_approval_dock(frame, areas[slot], card, selected, view.locale, palette);
        slot += 1;
    } else if spec.overlay_dock_h > 0 {
        render_classic_overlay(frame, areas[slot], view.overlay, overlay_ctx, palette);
        slot += 1;
    } else if spec.user_input_dock_h > 0
        && let Some((prompt, selected)) = view.user_input
    {
        render_user_input_dock(frame, areas[slot], prompt, selected, view.locale, palette);
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
        let badge_w = badge.width();
        let activity = RUNNING_ACTIVITY_LABEL;
        let activity_chars = activity.chars().count();
        let elapsed = format_running_elapsed(view.running_elapsed_ms);
        let label = view.activity_label.map(str::trim).filter(|s| !s.is_empty());
        let suffix_body = if rw < 30 || label.is_none() {
            format!("· {elapsed}")
        } else {
            format!("{} · {elapsed}", label.unwrap_or_default())
        };
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
                        view.animation_frame,
                        activity_chars,
                        palette,
                    ))
                    .bg(palette.background),
            ));
            left_w += cw;
        }
        let suffix_budget = left_budget.saturating_sub(left_w);
        if suffix_budget >= 3 {
            spans.push(Span::styled("  ", Style::new().bg(palette.background)));
            let clipped_suffix = clip_bot_line(&terminal_text(&suffix_body), suffix_budget - 2);
            left_w += 2 + clipped_suffix.width();
            spans.push(Span::styled(
                clipped_suffix,
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
            let placeholder = if view.plan_approval.is_some() {
                if view.locale.is_zh() {
                    "先在上方确认、修改或拒绝当前计划"
                } else {
                    "Approve, revise, or reject the plan above"
                }
            } else if view.locale.is_zh() {
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
            && view.plan_approval.is_none()
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
    let mut ignored = Vec::new();
    render_classic_with_links(frame, view, &mut ignored);
}

pub fn render_classic_with_links(
    frame: &mut Frame<'_>,
    view: ClassicView<'_>,
    out_links: &mut Vec<ScreenHyperlink>,
) {
    out_links.clear();
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
    let slash_items = if view.approval.is_none()
        && view.plan_approval.is_none()
        && !view.model_picker.open
        && !overlay_open
    {
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
        let spec = plan_dock_spec(
            &view,
            &slash_items,
            dock_area.width,
            dock_area.height,
            false,
        );
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
        && view.live_thinking.trim().is_empty()
        && view.approval.is_none()
        && view.plan_approval.is_none()
        && view.user_input.is_none()
        && !view.is_running
        && !view.overlay.is_modal();

    if is_welcome {
        let welcome_w = area.width.min(112);
        let dock_x = area.x + area.width.saturating_sub(welcome_w) / 2;
        let spec = plan_dock_spec(
            &view,
            &slash_items,
            welcome_w,
            main_area.height.saturating_sub(2),
            false,
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

    let side_w = if view.goal_panel.is_some() {
        goal_side_panel_width(full_area.width)
    } else {
        0
    };
    let (conv_main_area, side_panel_area) = if side_w > 0 && area.width > side_w + 48 {
        let cols =
            Layout::horizontal([Constraint::Min(48), Constraint::Length(side_w)]).split(main_area);
        (cols[0], Some(cols[1]))
    } else {
        (main_area, None)
    };

    let spec = plan_dock_spec(
        &view,
        &slash_items,
        conv_main_area.width,
        conv_main_area.height.saturating_sub(1),
        side_panel_area.is_some(),
    );
    let body_dock = Layout::vertical([
        Constraint::Min(1),
        Constraint::Length(spec.total_height.min(conv_main_area.height)),
    ])
    .split(conv_main_area);
    let body_area = body_dock[0];
    let dock_area = body_dock[1];
    let body_w = usize::from(body_area.width).max(1);
    let body_h = usize::from(body_area.height);

    {
        let use_rail = body_w >= 24;
        let has_running_tool = view.messages.last().is_some_and(|m| {
            m.role == "assistant" && m.tools.iter().any(|t| t.status == ToolRowStatus::Running)
        });
        let has_live_thinking = !view.live_thinking.trim().is_empty();
        let has_live_stream = !view.live_stream.is_empty();
        let show_thinking = view.is_running
            && !has_live_stream
            && !has_live_thinking
            && view.approval.is_none()
            && view.activity_label.is_none()
            && !has_running_tool;
        let last_is_assistant = view.messages.last().is_some_and(|m| m.role == "assistant");
        let tail_follows_assistant = has_live_stream || has_live_thinking || show_thinking;
        let mut all_lines: Vec<VisualLine> = Vec::new();

        for (idx, msg) in view.messages.iter().enumerate() {
            let wrap_w = if !use_rail {
                body_w
            } else if msg.role == "user" {
                body_w.saturating_sub(8).max(8)
            } else {
                body_w.saturating_sub(6).max(8)
            };
            let mut body_lines: Vec<VisualLine> = Vec::new();
            if let Some(thinking) = msg
                .thinking
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
            {
                body_lines.extend(
                    render_thinking_lines(thinking, wrap_w, palette)
                        .into_iter()
                        .map(VisualLine::plain),
                );
                if !msg.text.is_empty() || !msg.tools.is_empty() {
                    body_lines.push(VisualLine::plain(Line::styled(
                        "",
                        Style::new().bg(palette.background),
                    )));
                }
            }
            if !msg.text.is_empty() {
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
                let block_prefix = (key.item_hash as u32) ^ ((idx as u32).wrapping_add(1) << 12);
                body_lines.extend(
                    block
                        .lines
                        .into_iter()
                        .map(|s| VisualLine::from_styled(s, block_prefix)),
                );
            }
            for tool in &msg.tools {
                body_lines.extend(
                    render_tool_timeline_lines(
                        tool,
                        wrap_w,
                        view.animation_frame,
                        view.tools_expanded,
                        palette,
                    )
                    .into_iter()
                    .map(VisualLine::plain),
                );
            }
            if body_lines.is_empty() && msg.role != "user" {
                continue;
            }
            let next_continues = view.messages.get(idx + 1).is_some_and(|n| n.continuation);
            let last_continues =
                idx + 1 == view.messages.len() && msg.role == "assistant" && tail_follows_assistant;
            push_railed_lines(
                &mut all_lines,
                &msg.role,
                body_lines,
                msg.continuation,
                !(next_continues || last_continues),
                use_rail,
                palette,
            );
        }

        if has_live_thinking || has_live_stream {
            let wrap_w = if use_rail {
                body_w.saturating_sub(6).max(8)
            } else {
                body_w
            };
            let mut lines: Vec<VisualLine> = Vec::new();
            if has_live_thinking {
                let label = if view.is_running && !has_live_stream {
                    thinking_status_label(view.animation_frame / 4)
                } else {
                    "Thinking"
                };
                lines.extend(
                    render_thinking_lines_with_label(
                        label,
                        view.live_thinking.trim(),
                        wrap_w,
                        48,
                        palette,
                    )
                    .into_iter()
                    .map(VisualLine::plain),
                );
                if has_live_stream {
                    lines.push(VisualLine::plain(Line::styled(
                        "",
                        Style::new().bg(palette.background),
                    )));
                }
            }
            if has_live_stream {
                let live_block = render_markdown_themed(
                    view.live_stream,
                    wrap_w,
                    Style::new().fg(palette.text).bg(palette.background),
                    120,
                    palette,
                );
                lines.extend(
                    live_block
                        .lines
                        .into_iter()
                        .map(|s| VisualLine::from_styled(s, 0x000f_fffe)),
                );
            }
            push_railed_lines(
                &mut all_lines,
                "assistant",
                lines,
                last_is_assistant,
                true,
                use_rail,
                palette,
            );
        } else if show_thinking {
            let label = thinking_status_label(view.animation_frame / 4);
            let line = Line::styled(
                label.to_owned(),
                Style::new().fg(palette.muted).bg(palette.background),
            );
            push_railed_lines(
                &mut all_lines,
                "assistant",
                vec![VisualLine::plain(line)],
                last_is_assistant,
                true,
                use_rail,
                palette,
            );
        }

        let max_back = all_lines.len().saturating_sub(body_h);
        let back = view.anchor.lines_back().min(max_back);
        let end = all_lines.len().saturating_sub(back);
        let start = end.saturating_sub(body_h);
        let visible_slice: Vec<VisualLine> = all_lines
            .into_iter()
            .skip(start)
            .take(end - start)
            .collect();
        let suppress_body_links = view.model_picker.open || view.overlay.is_modal();
        let mut visible: Vec<Line<'static>> = Vec::with_capacity(visible_slice.len());
        for (vis_row, vline) in visible_slice.into_iter().enumerate() {
            if !suppress_body_links {
                project_line_links(&vline.links, body_area, vis_row, out_links);
            }
            visible.push(vline.line);
        }
        frame.render_widget(Paragraph::new(visible), body_area);
    }

    render_composer_dock(frame, dock_area, full_area, &view, &spec, &overlay_ctx);

    if let (Some(side_area), Some(panel)) = (side_panel_area, view.goal_panel) {
        render_goal_status_panel(frame, side_area, panel, view.locale, palette);
    }

    if !view.model_picker.open && view.overlay.is_modal() {
        render_classic_overlay(frame, full_area, view.overlay, &overlay_ctx, palette);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{GoalTaskItem, bounded_cache::MARKDOWN_WRAP_CACHE_BYTES, theme::DARK_PALETTE};
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
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
            ClassicMessage {
                id: "a1".into(),
                revision: 1,
                role: "assistant".into(),
                text: "好的：\n```rust\nfn main() { println!(\"ok\"); }\n```".into(),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
            ClassicMessage {
                id: "a2".into(),
                revision: 1,
                role: "assistant".into(),
                text: String::new(),
                thinking: None,
                tools: vec![
                    ToolTimelineRow {
                        call_id: "c1".into(),
                        capability_id: "local.file.list".into(),
                        tool_name: "List".into(),
                        summary: "~/Documents/Develop/peer-dev".into(),
                        status: ToolRowStatus::Completed,
                        duration_ms: Some(120),
                        detail_lines: vec!["list_files: success · tool-result://c1".into()],
                    },
                    ToolTimelineRow {
                        call_id: "c2".into(),
                        capability_id: "local.git.query".into(),
                        tool_name: "Git".into(),
                        summary: "snapshot .".into(),
                        status: ToolRowStatus::Failed,
                        duration_ms: Some(210),
                        detail_lines: vec!["git_not_repository".into()],
                    },
                ],
                continuation: true,
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
                        goal_panel: None,
                        plan_approval: None,
                        is_running: true,
                        activity_label: Some("正在思考…"),
                        animation_frame: 6,
                        running_elapsed_ms: 8_000,
                        tools_expanded: true,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "流式输出...",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
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
                assert!(!text.contains("TOOL "));
                assert!(text.contains("✓ List"));
                assert!(text.contains("✗ Git"));
                assert!(text.contains("┆ evidence"));
                assert!(text.contains("working...  正在思考… · 8s"));
                assert!(text.contains("PEER / ACTIVE"));
                assert!(text.contains("mode agent · access Approve"));
                assert!(text.contains("GPT-6.1 Sol · high"));
                assert!(text.contains("42%"));
            }
        }

        let pending_msgs = vec![
            msgs[0].clone(),
            ClassicMessage {
                id: "a-run".into(),
                revision: 1,
                role: "assistant".into(),
                text: String::new(),
                thinking: None,
                tools: vec![ToolTimelineRow {
                    call_id: "c3".into(),
                    capability_id: "local.shell.exec".into(),
                    tool_name: "Bash".into(),
                    summary: "git status".into(),
                    status: ToolRowStatus::Running,
                    duration_ms: None,
                    detail_lines: vec!["running detail".into()],
                }],
                continuation: false,
            },
        ];
        let mut running_tool_term = Terminal::new(TestBackend::new(100, 20)).unwrap();
        running_tool_term
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "GPT-6.1 Sol · ChatGPT 订阅",
                        effort_badge: "high",
                        mode_badge: "chat",
                        access_badge: "ask",
                        context_percent: Some(0),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: None,
                        plan_approval: None,
                        is_running: true,
                        activity_label: None,
                        animation_frame: 6,
                        running_elapsed_ms: 8_000,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &pending_msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let running_tool_text = buffer_text(&running_tool_term);
        assert!(running_tool_text.contains("◇ Bash"));
        assert!(running_tool_text.contains("now +"));
        assert!(!running_tool_text.contains("Thinking.."));

        let mut pending_term = Terminal::new(TestBackend::new(100, 20)).unwrap();
        pending_term
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "GPT-6.1 Sol · ChatGPT 订阅",
                        effort_badge: "high",
                        mode_badge: "chat",
                        access_badge: "ask",
                        context_percent: Some(0),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: None,
                        plan_approval: None,
                        is_running: true,
                        activity_label: None,
                        animation_frame: 6,
                        running_elapsed_ms: 8_000,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs[..1],
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let pending_text = buffer_text(&pending_term);
        assert!(pending_text.contains("working...  · 8s"));
        assert!(pending_text.contains("PEER / ACTIVE"));
        assert!(pending_text.contains("Thinking.."));

        let mut live_thinking_term = Terminal::new(TestBackend::new(100, 20)).unwrap();
        live_thinking_term
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "GPT-6.1 Sol · ChatGPT 订阅",
                        effort_badge: "high",
                        mode_badge: "chat",
                        access_badge: "ask",
                        context_percent: Some(0),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: None,
                        plan_approval: None,
                        is_running: true,
                        activity_label: None,
                        animation_frame: 6,
                        running_elapsed_ms: 8_000,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs[..1],
                        live_stream: "",
                        live_thinking: "先检查最近的提交记录。",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let live_thinking_text = buffer_text(&live_thinking_term);
        assert!(live_thinking_text.contains("PEER"));
        assert!(live_thinking_text.contains("Thinking.."));
        assert!(live_thinking_text.contains("先检查最近的提交记录。"));
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
                    goal_panel: None,
                    plan_approval: None,
                    is_running: false,
                    activity_label: None,
                    animation_frame: 0,
                    running_elapsed_ms: 0,
                    tools_expanded: false,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &[],
                    live_stream: "",
                    live_thinking: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "",
                    approval: None,
                    user_input: None,
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

    #[test]
    fn classic_user_input_card_renders_question_options_and_hints_safely() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 16);
        let composer = Composer::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let prompt = UserInputPrompt {
            question: "需要我先做哪一件？".into(),
            options: vec![
                "A 核对 ADR 133 §3".into(),
                "B 盘点剩余缺口".into(),
                "C 梳理合回策略".into(),
            ],
            tool_call_id: Some("call-ask".into()),
        };
        let msgs = vec![ClassicMessage {
            id: "u1".into(),
            revision: 1,
            role: "user".into(),
            text: "看一下状态".into(),
            thinking: None,
            tools: Vec::new(),
            continuation: false,
        }];
        for (w, h) in [(120, 40), (48, 16)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
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
                        context_percent: Some(5),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: None,
                        plan_approval: None,
                        is_running: false,
                        activity_label: None,
                        animation_frame: 0,
                        running_elapsed_ms: 0,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: Some((&prompt, 1)),
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
            let text = buffer_text(&term);
            assert!(text.contains("Ask user"));
            assert!(text.contains("需要我先做哪一件？"));
            assert!(text.contains("[1] A 核对 ADR 133"));
            assert!(text.contains("› [2] B 盘点剩余缺口"));
            if w == 120 {
                assert!(text.contains("1-9 / Enter 确认"));
            }
        }
    }

    #[test]
    fn classic_approval_card_keeps_history_visible_and_renders_selector() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 16);
        let composer = Composer::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let card = ApprovalCard {
            action: "git_query (local.git.query)".into(),
            location: "/Library/Developer/CommandLineTools/usr/share/git-core/gitconfig".into(),
            reason: "Outside workspace file read requires approval.".into(),
            risk: "l1_local_read".into(),
            arguments: "{\"operation\":\"log\",\"limit\":25}".into(),
        };
        let msgs = vec![ClassicMessage {
            id: "u1".into(),
            revision: 1,
            role: "user".into(),
            text: "查看最近提交历史".into(),
            thinking: None,
            tools: Vec::new(),
            continuation: false,
        }];
        for (w, h) in [(120, 40), (48, 22), (48, 18)] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
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
                        context_percent: Some(5),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: None,
                        plan_approval: None,
                        is_running: true,
                        activity_label: Some("等待授权…"),
                        animation_frame: 2,
                        running_elapsed_ms: 4_000,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: Some((&card, 1)),
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
            let text = buffer_text(&term);
            if h >= 22 {
                assert!(text.contains("查看最近提交历史"));
            }
            assert!(text.contains("Approval required"));
            assert!(text.contains("本地授权请求"));
            assert!(text.contains("Action  git_query"));
            assert!(text.contains("Args"));
            assert!(text.contains("› 2. 本会话允许此操作"));
            assert!(text.contains("3. 拒绝"));
        }
    }

    #[test]
    fn classic_renders_rounded_markdown_table_under_peer_rail() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 16);
        let composer = Composer::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let msgs = vec![
            ClassicMessage {
                id: "u1".into(),
                revision: 1,
                role: "user".into(),
                text: "当前仓库状态是什么".into(),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
            ClassicMessage {
                id: "a1".into(),
                revision: 1,
                role: "assistant".into(),
                text: "| 仓库 | 当前分支 | 主线位置 | 说明 |\n|---|---|---|---|\n| Peer-Knowledge | `codex/coding-agent-engineering-charter` | `origin/main` 停在 `7600b00` (11-10, ADR 127) | ADR 133 及全部对齐改动只在分支上，未合入 main |\n| Peer-Agent | `fix/bot-thread-latest-floating` | `origin/main` 为 `48e88a25` (RC29 相关) | 最近提交是桌面端「返回最新消息」浮动按钮等体验修复；Rust CLI 线在 `codex/native-rust-cli` |".into(),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
        ];

        let mut term = Terminal::new(TestBackend::new(110, 28)).unwrap();
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
                    context_percent: Some(5),
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_panel: None,
                    plan_approval: None,
                    is_running: false,
                    activity_label: None,
                    animation_frame: 0,
                    running_elapsed_ms: 0,
                    tools_expanded: false,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &msgs,
                    live_stream: "",
                    live_thinking: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "",
                    approval: None,
                    user_input: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::None,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();

        let text = buffer_text(&term);
        assert!(text.contains("PEER"));
        assert!(text.contains('╭'));
        assert!(text.contains('╰'));
        assert!(text.contains('├'));
        assert!(text.contains('┼'));
        assert!(text.contains('┤'));
        assert!(text.contains("Peer-Knowledge"));
        assert!(text.contains("Peer-Agent"));
        assert!(text.contains("codex/native-rust-cli"));
        assert!(!text.contains("[1]"));
    }

    #[test]
    fn classic_projects_screen_hyperlinks_through_rails_and_suppresses_under_modal() {
        let mut term = Terminal::new(TestBackend::new(90, 18)).unwrap();
        let composer = Composer::default();
        let picker = ModelPickerState::default();
        let anchor = ReadingAnchor::default();
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 64);
        let adr = "/Users/yinliang/Documents/Develop/peer-dev/Peer-Knowledge/knowledge/decisions/133-unified-rust-core-and-dual-host-architecture.md";
        let msgs = vec![
            ClassicMessage {
                id: "m-link".into(),
                revision: 1,
                role: "assistant".into(),
                text: format!("阅读 [架构](file:///tmp/arch.md) 和 `{adr}`"),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
            ClassicMessage {
                id: "m-link-2".into(),
                revision: 1,
                role: "assistant".into(),
                text: "第二条消息：https://example.com/second".into(),
                thinking: None,
                tools: Vec::new(),
                continuation: false,
            },
        ];

        let mut links = Vec::new();
        term.draw(|f| {
            render_classic_with_links(
                f,
                ClassicView {
                    title: "Peer",
                    workspace_label: "~/Documents/Develop/peer-dev",
                    model_badge: "gpt-6.1-sol",
                    effort_badge: "default",
                    mode_badge: "chat",
                    access_badge: "ask",
                    context_percent: None,
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_panel: None,
                    plan_approval: None,
                    is_running: false,
                    activity_label: None,
                    animation_frame: 0,
                    running_elapsed_ms: 0,
                    tools_expanded: false,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &msgs,
                    live_stream: "",
                    live_thinking: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "",
                    approval: None,
                    user_input: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::None,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
                &mut links,
            );
        })
        .unwrap();

        let buf = term.backend().buffer();
        let read_buffer_span = |l: &ScreenHyperlink| {
            let mut out = String::new();
            let mut x = l.col_start;
            while x < l.col_end {
                let sym = buf[(x, l.row)].symbol();
                out.push_str(sym);
                x = x.saturating_add(sym.width().max(1) as u16);
            }
            out
        };

        let arch = links
            .iter()
            .find(|l| l.target == "file:///tmp/arch.md")
            .expect("arch markdown link projected");
        assert_eq!(read_buffer_span(arch), "架构");

        let adr_links: Vec<&ScreenHyperlink> = links.iter().filter(|l| l.target == adr).collect();
        assert!(!adr_links.is_empty());
        assert!(adr_links.iter().all(|l| l.id == adr_links[0].id));
        let adr_rendered: String = adr_links.iter().map(|l| read_buffer_span(l)).collect();
        assert_eq!(adr_rendered, adr);

        let second = links
            .iter()
            .find(|l| l.target == "https://example.com/second")
            .expect("second message link projected");
        assert_eq!(read_buffer_span(second), "https://example.com/second");
        assert_ne!(second.id, arch.id);
        assert_ne!(second.id, adr_links[0].id);

        // Modal overlay clears body hyperlinks so hidden text behind modal is not clickable.
        let mut modal_links = Vec::new();
        term.draw(|f| {
            render_classic_with_links(
                f,
                ClassicView {
                    title: "Peer",
                    workspace_label: "~/Documents/Develop/peer-dev",
                    model_badge: "gpt-6.1-sol",
                    effort_badge: "default",
                    mode_badge: "chat",
                    access_badge: "ask",
                    context_percent: None,
                    quota_label: None,
                    quota_remaining: None,
                    fast_mode: false,
                    fast_available: false,
                    goal_status: GoalMenuStatus::None,
                    goal_panel: None,
                    plan_approval: None,
                    is_running: false,
                    activity_label: None,
                    animation_frame: 0,
                    running_elapsed_ms: 0,
                    tools_expanded: false,
                    notice: None,
                    notice_is_error: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    current_theme: ThemeMode::Dark,
                    locale: TuiLocale::ZhCn,
                    messages: &msgs,
                    live_stream: "",
                    live_thinking: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "",
                    approval: None,
                    user_input: None,
                    model_picker: &picker,
                    overlay: &ClassicOverlay::Help { scroll: 0 },
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
                &mut modal_links,
            );
        })
        .unwrap();
        assert!(modal_links.is_empty());
    }

    #[test]
    fn classic_renders_goal_side_panel_on_wide_compact_on_narrow_and_plan_approval_card() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 32);
        let composer = Composer::default();
        let picker = ModelPickerState::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let msgs = vec![ClassicMessage {
            id: "m-goal".into(),
            revision: 1,
            role: "assistant".into(),
            text: "已整理任务并输出参考链接：[Doc](https://example.com/plan)".into(),
            thinking: None,
            tools: Vec::new(),
            continuation: false,
        }];
        let panel = GoalPanelView {
            plan_id: "plan-side-1".into(),
            title: "补齐 Classic Plan 任务侧栏".into(),
            goal: "实现右侧任务面板与交互确认卡".into(),
            status: "executing".into(),
            completed: 1,
            total: 3,
            percent: 33,
            current_task: Some(GoalTaskItem {
                id: "t2".into(),
                title: "渲染右侧任务状态区".into(),
                status: "running".into(),
                detail: None,
            }),
            tasks: vec![
                GoalTaskItem {
                    id: "t1".into(),
                    title: "定义审批写入".into(),
                    status: "completed".into(),
                    detail: None,
                },
                GoalTaskItem {
                    id: "t2".into(),
                    title: "渲染右侧任务状态区".into(),
                    status: "running".into(),
                    detail: None,
                },
                GoalTaskItem {
                    id: "t3".into(),
                    title: "校验窄屏降级".into(),
                    status: "pending".into(),
                    detail: None,
                },
            ],
            blocked_reason: Some("等待用户确认高风险变更".into()),
            mission_position: 1,
            total_plans: 2,
        };
        let approval_card = PlanApprovalCard {
            plan_id: "plan-side-1".into(),
            title: "补齐 Classic Plan 任务侧栏".into(),
            goal: "实现右侧任务面板与交互确认卡".into(),
            tasks: vec![
                "定义审批写入".into(),
                "渲染右侧任务状态区".into(),
                "校验窄屏降级".into(),
            ],
        };

        // 1. Wide (140x32) renders side panel + accurate OSC 8 coordinates in left column
        let mut wide_term = Terminal::new(TestBackend::new(140, 32)).unwrap();
        let mut wide_links = Vec::new();
        wide_term
            .draw(|f| {
                render_classic_with_links(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "gpt-6.1-sol",
                        effort_badge: "high",
                        mode_badge: "goal",
                        access_badge: "session",
                        context_percent: Some(12),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::Running,
                        goal_panel: Some(&panel),
                        plan_approval: None,
                        is_running: false,
                        activity_label: None,
                        animation_frame: 0,
                        running_elapsed_ms: 0,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                    &mut wide_links,
                );
            })
            .unwrap();
        let wide_text = buffer_text(&wide_term);
        assert!(wide_text.contains("MISSION / 01 OF 2"));
        assert!(wide_text.contains("NOW WORKING"));
        assert!(wide_text.contains("TASKS"));
        assert!(wide_text.contains("NEEDS ATTENTION"));
        let doc_link = wide_links
            .iter()
            .find(|l| l.target == "https://example.com/plan")
            .expect("left column link projected");
        assert!(doc_link.col_end <= 140 - goal_side_panel_width(140));
        let buf = wide_term.backend().buffer();
        let link_text: String = (doc_link.col_start..doc_link.col_end)
            .map(|x| buf[(x, doc_link.row)].symbol())
            .collect();
        assert_eq!(link_text, "Doc");

        // 2. Narrow (96x24) hides side panel and renders compact progress summary bar
        let mut narrow_term = Terminal::new(TestBackend::new(96, 24)).unwrap();
        narrow_term
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "gpt-6.1-sol",
                        effort_badge: "high",
                        mode_badge: "goal",
                        access_badge: "session",
                        context_percent: Some(12),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::Running,
                        goal_panel: Some(&panel),
                        plan_approval: None,
                        is_running: false,
                        activity_label: None,
                        animation_frame: 0,
                        running_elapsed_ms: 0,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let narrow_text = buffer_text(&narrow_term);
        assert!(!narrow_text.contains("MISSION / 01 OF 2"));
        assert!(narrow_text.contains("━"));
        assert!(narrow_text.contains("1/3"));

        // 3. Pending Plan Approval card renders rounded selector dock
        let mut approval_term = Terminal::new(TestBackend::new(100, 28)).unwrap();
        approval_term
            .draw(|f| {
                render_classic(
                    f,
                    ClassicView {
                        title: "Peer",
                        workspace_label: "~/Documents/Develop/peer-dev",
                        model_badge: "gpt-6.1-sol",
                        effort_badge: "high",
                        mode_badge: "plan",
                        access_badge: "ask",
                        context_percent: Some(12),
                        quota_label: None,
                        quota_remaining: None,
                        fast_mode: false,
                        fast_available: false,
                        goal_status: GoalMenuStatus::None,
                        goal_panel: Some(&panel),
                        plan_approval: Some((&approval_card, 0)),
                        is_running: false,
                        activity_label: None,
                        animation_frame: 0,
                        running_elapsed_ms: 0,
                        tools_expanded: false,
                        notice: None,
                        notice_is_error: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        current_theme: ThemeMode::Dark,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "",
                        live_thinking: "",
                        anchor: &anchor,
                        composer: &composer,
                        status: "",
                        approval: None,
                        user_input: None,
                        model_picker: &picker,
                        overlay: &ClassicOverlay::None,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        let approval_text = buffer_text(&approval_term);
        assert!(approval_text.contains("计划审批"));
        assert!(approval_text.contains("1. 定义审批写入"));
        assert!(approval_text.contains("[1] 批准并执行"));
        assert!(approval_text.contains("[2] 修改计划"));
        assert!(approval_text.contains("[3] 拒绝"));
    }
}
