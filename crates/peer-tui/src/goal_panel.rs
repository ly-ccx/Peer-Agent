//! Pure Peer Frost Goal status side panel, narrow compact bar, and Plan approval dock.
//!
//! Strictly pure Ratatui display primitives with zero filesystem or process I/O.
//! Mirrors `apps/tui/src/{goal-status-view.tsx, goal-status-model.ts, plan-mode.ts}`.

use crate::{
    classic_view::wrap_plain_lines,
    commands::clip_bot_line,
    terminal_text,
    theme::{CARET_SELECTED, TuiLocale, TuiPalette},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalTaskItem {
    pub id: String,
    pub title: String,
    pub status: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalPanelView {
    pub plan_id: String,
    pub title: String,
    pub goal: String,
    pub status: String,
    pub completed: usize,
    pub total: usize,
    pub percent: u8,
    pub current_task: Option<GoalTaskItem>,
    pub tasks: Vec<GoalTaskItem>,
    pub blocked_reason: Option<String>,
    pub mission_position: usize,
    pub total_plans: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PlanApprovalCard {
    pub plan_id: String,
    pub title: String,
    pub goal: String,
    pub tasks: Vec<String>,
}

/// Returns the wide-screen right side panel width (`34..=42` cols when `columns >= 120`, else `0`).
pub fn goal_side_panel_width(columns: u16) -> u16 {
    if columns >= 120 {
        ((usize::from(columns) * 30) / 100).clamp(34, 42) as u16
    } else {
        0
    }
}

pub fn goal_task_glyph(status: &str) -> &'static str {
    match status {
        "completed" => "✓",
        "running" | "executing" => "▶",
        "failed" | "blocked" | "waiting_user" => "!",
        "cancelled" => "–",
        _ => "○",
    }
}

pub fn goal_status_color(status: &str, palette: &TuiPalette) -> Color {
    match status {
        "completed" => palette.success,
        "failed" | "blocked" | "waiting_user" => palette.danger,
        "running" | "executing" | "awaiting_approval" | "approved" | "accepted" => palette.accent,
        _ => palette.muted,
    }
}

pub fn goal_progress_track(percent: u8, width: usize) -> (String, String) {
    let cols = width.max(1);
    let pct = usize::from(percent.min(100));
    let done = ((cols * pct + 50) / 100).min(cols);
    ("━".repeat(done), "─".repeat(cols - done))
}

fn split_pair_line(
    left: &str,
    left_style: Style,
    right: &str,
    right_style: Style,
    width: usize,
    bg: Color,
) -> Line<'static> {
    if width == 0 {
        return Line::default();
    }
    let rw = right.width();
    if rw > 0 && rw + 3 <= width {
        let clipped_left = clip_bot_line(left, width - rw - 2);
        let gap = width.saturating_sub(clipped_left.width() + rw);
        return Line::from(vec![
            Span::styled(clipped_left, left_style),
            Span::styled(" ".repeat(gap), Style::new().bg(bg)),
            Span::styled(right.to_owned(), right_style),
        ]);
    }
    Line::styled(clip_bot_line(left, width), left_style)
}

fn render_panel_row(
    frame: &mut Frame<'_>,
    y: &mut u16,
    y_end: u16,
    x: u16,
    w: u16,
    line: Line<'static>,
    bg: Color,
) {
    if *y >= y_end || w == 0 {
        return;
    }
    frame.render_widget(
        Paragraph::new(line).style(Style::new().bg(bg)),
        Rect {
            x,
            y: *y,
            width: w,
            height: 1,
        },
    );
    *y += 1;
}

pub fn render_goal_status_panel(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &GoalPanelView,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if area.width < 12 || area.height < 4 {
        return;
    }
    let bg = palette.background;
    frame.render_widget(Block::new().style(Style::new().bg(bg)), area);

    let border_style = Style::new().fg(palette.border).bg(bg);
    for row in area.y..area.y + area.height {
        frame.render_widget(
            Paragraph::new(Line::styled("│", border_style)),
            Rect {
                x: area.x,
                y: row,
                width: 1,
                height: 1,
            },
        );
    }

    let pad_x: u16 = if area.width >= 24 { 2 } else { 1 };
    let inner_x = area.x + 1 + pad_x;
    let inner_w = area.width.saturating_sub(1 + pad_x * 2);
    if inner_w < 6 {
        return;
    }
    let cw = usize::from(inner_w);
    let pad_y: u16 = if area.height >= 10 { 1 } else { 0 };
    let mut y = area.y + pad_y;
    let y_end = area.y + area.height - pad_y;

    let muted_style = Style::new().fg(palette.muted).bg(bg);
    let text_style = Style::new().fg(palette.text).bg(bg);

    // 1. Header: `MISSION / 01 OF N` + `● STATUS`
    let mission_lbl = format!(
        "MISSION / {:02} OF {}",
        view.mission_position.max(1),
        view.total_plans.max(1)
    );
    let status_lbl = format!(
        "● {}",
        terminal_text(&view.status).trim().to_ascii_uppercase()
    );
    let status_fg = goal_status_color(&view.status, palette);
    render_panel_row(
        frame,
        &mut y,
        y_end,
        inner_x,
        inner_w,
        split_pair_line(
            &mission_lbl,
            Style::new()
                .fg(palette.accent)
                .bg(bg)
                .add_modifier(Modifier::BOLD),
            &status_lbl,
            Style::new().fg(status_fg).bg(bg),
            cw,
            bg,
        ),
        bg,
    );

    if view.total_plans > 1 {
        let multi = if locale.is_zh() {
            format!("{} GOALS · /goals 切换", view.total_plans)
        } else {
            format!("{} GOALS · /goals switch", view.total_plans)
        };
        render_panel_row(
            frame,
            &mut y,
            y_end,
            inner_x,
            inner_w,
            Line::styled(clip_bot_line(&multi, cw), muted_style),
            bg,
        );
    }

    if area.height >= 16 && y < y_end {
        y += 1;
    }

    // 2. Plan Title
    let title_src = if view.title.trim().is_empty() {
        view.goal.as_str()
    } else {
        view.title.as_str()
    };
    for line in wrap_plain_lines(title_src, cw, 2) {
        render_panel_row(
            frame,
            &mut y,
            y_end,
            inner_x,
            inner_w,
            Line::styled(line, text_style.add_modifier(Modifier::BOLD)),
            bg,
        );
    }

    if area.height >= 16 && y < y_end {
        y += 1;
    }

    // 3. Progress header + bar
    let prog_left = format!("{} / {} COMPLETE", view.completed, view.total);
    let prog_right = format!("{}%", view.percent.min(100));
    render_panel_row(
        frame,
        &mut y,
        y_end,
        inner_x,
        inner_w,
        split_pair_line(&prog_left, muted_style, &prog_right, muted_style, cw, bg),
        bg,
    );
    let (done_bar, rem_bar) = goal_progress_track(view.percent, cw);
    render_panel_row(
        frame,
        &mut y,
        y_end,
        inner_x,
        inner_w,
        Line::from(vec![
            Span::styled(done_bar, Style::new().fg(palette.accent).bg(bg)),
            Span::styled(rem_bar, border_style),
        ]),
        bg,
    );

    // Reserve rows at the bottom for NEEDS ATTENTION when present.
    let blocked_lines = view
        .blocked_reason
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|reason| wrap_plain_lines(reason, cw.saturating_sub(2).max(1), 2))
        .unwrap_or_default();
    let blocked_rows: u16 = if blocked_lines.is_empty() {
        0
    } else {
        1 + blocked_lines.len() as u16 + u16::from(area.height >= 18)
    };
    let tasks_y_end = y_end.saturating_sub(blocked_rows).max(y);

    // 4. NOW WORKING
    if let Some(cur) = &view.current_task
        && tasks_y_end.saturating_sub(y) >= 4
    {
        if area.height >= 18 && y < tasks_y_end {
            y += 1;
        }
        render_panel_row(
            frame,
            &mut y,
            tasks_y_end,
            inner_x,
            inner_w,
            Line::styled(clip_bot_line("NOW WORKING", cw), muted_style),
            bg,
        );
        let accent_bar = Span::styled("│ ", Style::new().fg(palette.accent).bg(bg));
        let active_badge = if view.status == "awaiting_approval" {
            "◇ AWAITING APPROVAL"
        } else {
            "◇ ACTIVE"
        };
        render_panel_row(
            frame,
            &mut y,
            tasks_y_end,
            inner_x,
            inner_w,
            Line::from(vec![
                accent_bar.clone(),
                Span::styled(
                    clip_bot_line(active_badge, cw.saturating_sub(2)),
                    Style::new().fg(palette.accent).bg(bg),
                ),
            ]),
            bg,
        );
        for tline in wrap_plain_lines(&cur.title, cw.saturating_sub(2).max(1), 2) {
            render_panel_row(
                frame,
                &mut y,
                tasks_y_end,
                inner_x,
                inner_w,
                Line::from(vec![accent_bar.clone(), Span::styled(tline, text_style)]),
                bg,
            );
        }
    }

    // 5. TASKS list
    if tasks_y_end.saturating_sub(y) >= 2 && !view.tasks.is_empty() {
        if area.height >= 18 && y < tasks_y_end {
            y += 1;
        }
        if tasks_y_end.saturating_sub(y) >= 2 {
            render_panel_row(
                frame,
                &mut y,
                tasks_y_end,
                inner_x,
                inner_w,
                Line::styled(clip_bot_line("TASKS", cw), muted_style),
                bg,
            );
            let avail_rows = usize::from(tasks_y_end.saturating_sub(y));
            let cap = view.tasks.len().min(10);
            let shown = if view.tasks.len() > avail_rows && avail_rows >= 2 {
                (avail_rows - 1).min(cap)
            } else {
                avail_rows.min(cap)
            };
            for task in view.tasks.iter().take(shown) {
                let glyph = goal_task_glyph(&task.status);
                let style = if matches!(task.status.as_str(), "running" | "executing") {
                    text_style.add_modifier(Modifier::BOLD)
                } else {
                    Style::new()
                        .fg(goal_status_color(&task.status, palette))
                        .bg(bg)
                };
                let prefix = format!("{glyph}  ");
                let clipped_title = clip_bot_line(&task.title, cw.saturating_sub(prefix.width()));
                render_panel_row(
                    frame,
                    &mut y,
                    tasks_y_end,
                    inner_x,
                    inner_w,
                    Line::from(vec![
                        Span::styled(prefix, style),
                        Span::styled(clipped_title, style),
                    ]),
                    bg,
                );
            }
            if view.tasks.len() > shown && y < tasks_y_end {
                render_panel_row(
                    frame,
                    &mut y,
                    tasks_y_end,
                    inner_x,
                    inner_w,
                    Line::styled(
                        clip_bot_line(&format!("+{} more", view.tasks.len() - shown), cw),
                        muted_style,
                    ),
                    bg,
                );
            }
        }
    }

    // 6. NEEDS ATTENTION block
    if !blocked_lines.is_empty() && y < y_end {
        if area.height >= 18 && y + 1 + (blocked_lines.len() as u16) < y_end {
            y += 1;
        }
        let danger_bar = Span::styled("│ ", Style::new().fg(palette.danger).bg(bg));
        render_panel_row(
            frame,
            &mut y,
            y_end,
            inner_x,
            inner_w,
            Line::from(vec![
                danger_bar.clone(),
                Span::styled(
                    clip_bot_line("NEEDS ATTENTION", cw.saturating_sub(2)),
                    Style::new()
                        .fg(palette.danger)
                        .bg(bg)
                        .add_modifier(Modifier::BOLD),
                ),
            ]),
            bg,
        );
        for b_line in blocked_lines {
            render_panel_row(
                frame,
                &mut y,
                y_end,
                inner_x,
                inner_w,
                Line::from(vec![danger_bar.clone(), Span::styled(b_line, text_style)]),
                bg,
            );
        }
    }
}

pub fn render_goal_compact_summary(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &GoalPanelView,
    palette: &TuiPalette,
) {
    if area.height == 0 || area.width == 0 {
        return;
    }
    let sw = usize::from(area.width);
    let bg = palette.background;
    let live_status = view
        .current_task
        .as_ref()
        .map_or(view.status.as_str(), |t| t.status.as_str());
    let glyph = goal_task_glyph(live_status);
    let glyph_fg = goal_status_color(live_status, palette);
    let raw_title = view
        .current_task
        .as_ref()
        .map_or(view.title.as_str(), |t| t.title.as_str());
    let title = terminal_text(if raw_title.trim().is_empty() {
        view.goal.as_str()
    } else {
        raw_title
    });

    let mut right_spans: Vec<Span<'static>> = Vec::new();
    if view.total_plans > 1 {
        right_spans.push(Span::styled(
            format!("{}/{}  ", view.mission_position.max(1), view.total_plans),
            Style::new().fg(palette.subtle).bg(bg),
        ));
    }
    let (done_bar, rem_bar) = goal_progress_track(view.percent, 4);
    right_spans.push(Span::styled(
        done_bar,
        Style::new().fg(palette.accent).bg(bg),
    ));
    right_spans.push(Span::styled(
        rem_bar,
        Style::new().fg(palette.border).bg(bg),
    ));
    right_spans.push(Span::styled(
        format!("  {}/{}", view.completed, view.total),
        Style::new().fg(palette.subtle).bg(bg),
    ));
    if sw >= 80 {
        right_spans.push(Span::styled(
            "  /goals",
            Style::new().fg(palette.muted).bg(bg),
        ));
    }
    let right_w: usize = right_spans.iter().map(Span::width).sum();

    let glyph_w = glyph.width();
    let max_left_title = sw.saturating_sub(glyph_w + 1 + right_w + 2);
    if right_w + glyph_w + 4 <= sw {
        let clipped_title = clip_bot_line(&title, max_left_title.max(1));
        let left_w = glyph_w + 1 + clipped_title.width();
        let gap = sw.saturating_sub(left_w + right_w);
        let mut spans = vec![
            Span::styled(glyph, Style::new().fg(glyph_fg).bg(bg)),
            Span::styled(
                format!(" {clipped_title}"),
                Style::new().fg(palette.text).bg(bg),
            ),
            Span::styled(" ".repeat(gap), Style::new().bg(bg)),
        ];
        spans.extend(right_spans);
        frame.render_widget(Paragraph::new(Line::from(spans)), area);
    } else {
        let clipped = clip_bot_line(&format!("{glyph} {title}"), sw);
        frame.render_widget(
            Paragraph::new(Line::styled(clipped, Style::new().fg(palette.text).bg(bg))),
            area,
        );
    }
}

struct PlanApprovalLayout {
    framed: bool,
    horizontal_actions: bool,
    goal_lines: Vec<String>,
    vis_tasks: usize,
    more_tasks: usize,
    show_footer: bool,
}

fn plan_approval_layout(card: &PlanApprovalCard, width: u16, max_h: u16) -> PlanApprovalLayout {
    let framed = max_h >= 7 && width >= 20;
    let inner_w = if framed {
        usize::from(width.saturating_sub(4)).max(1)
    } else {
        usize::from(width.saturating_sub(2)).max(1)
    };
    let inner_h = if framed {
        max_h.saturating_sub(2)
    } else {
        max_h
    };
    let horizontal_actions = inner_w >= 54;
    let action_rows: u16 = if horizontal_actions { 1 } else { 3 };
    // Reserve: 1 header + goal (0..=2) + tasks + action_rows + optional footer
    let rem_after_chrome = inner_h.saturating_sub(1 + action_rows);
    let show_footer = rem_after_chrome >= 2;
    let body_budget = rem_after_chrome.saturating_sub(u16::from(show_footer));

    let goal_cap = if body_budget >= 4 { 2 } else { 1 }.min(usize::from(body_budget));
    let goal_lines = wrap_plain_lines(&card.goal, inner_w, goal_cap);
    let task_budget = usize::from(body_budget.saturating_sub(goal_lines.len() as u16));
    let (vis_tasks, more_tasks) = if card.tasks.len() <= task_budget.min(5) {
        (card.tasks.len(), 0)
    } else if task_budget >= 2 {
        let shown = (task_budget - 1).min(4);
        (shown, card.tasks.len().saturating_sub(shown))
    } else {
        (
            task_budget.min(card.tasks.len()),
            card.tasks.len().saturating_sub(task_budget),
        )
    };

    PlanApprovalLayout {
        framed,
        horizontal_actions,
        goal_lines,
        vis_tasks,
        more_tasks,
        show_footer,
    }
}

pub fn plan_approval_dock_height(card: &PlanApprovalCard, width: u16, panel_budget: u16) -> u16 {
    let layout = plan_approval_layout(card, width, panel_budget.min(14));
    let action_rows: u16 = if layout.horizontal_actions { 1 } else { 3 };
    let inner = 1
        + layout.goal_lines.len() as u16
        + layout.vis_tasks as u16
        + u16::from(layout.more_tasks > 0)
        + action_rows
        + u16::from(layout.show_footer);
    let border = if layout.framed { 2 } else { 0 };
    (inner + border).min(panel_budget).max(4.min(panel_budget))
}

pub fn render_plan_approval_dock(
    frame: &mut Frame<'_>,
    area: Rect,
    card: &PlanApprovalCard,
    selected: usize,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if area.height < 4 || area.width == 0 {
        return;
    }
    let zh = locale.is_zh();
    let panel_bg = palette.panel;
    let layout = plan_approval_layout(card, area.width, area.height);
    let content_area = if layout.framed {
        let block = Block::default()
            .borders(Borders::ALL)
            .border_type(BorderType::Rounded)
            .border_style(Style::new().fg(palette.user).bg(palette.background))
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

    let title_prefix = if zh { "计划审批" } else { "Plan approval" };
    let header_txt = if card.title.trim().is_empty() {
        title_prefix.to_owned()
    } else {
        format!("{title_prefix} · {}", terminal_text(&card.title))
    };
    render_panel_row(
        frame,
        &mut y,
        y_end,
        content_area.x,
        content_area.width,
        Line::styled(
            clip_bot_line(&header_txt, cw),
            Style::new()
                .fg(palette.user)
                .bg(panel_bg)
                .add_modifier(Modifier::BOLD),
        ),
        panel_bg,
    );

    for g_line in &layout.goal_lines {
        render_panel_row(
            frame,
            &mut y,
            y_end,
            content_area.x,
            content_area.width,
            Line::styled(g_line.clone(), Style::new().fg(palette.text).bg(panel_bg)),
            panel_bg,
        );
    }

    for (idx, task) in card.tasks.iter().enumerate().take(layout.vis_tasks) {
        let t_line = clip_bot_line(&format!("{}. {}", idx + 1, terminal_text(task)), cw);
        render_panel_row(
            frame,
            &mut y,
            y_end,
            content_area.x,
            content_area.width,
            Line::styled(t_line, Style::new().fg(palette.muted).bg(panel_bg)),
            panel_bg,
        );
    }
    if layout.more_tasks > 0 {
        let more_txt = if zh {
            format!("另有 {} 项", layout.more_tasks)
        } else {
            format!("+{} more", layout.more_tasks)
        };
        render_panel_row(
            frame,
            &mut y,
            y_end,
            content_area.x,
            content_area.width,
            Line::styled(more_txt, Style::new().fg(palette.subtle).bg(panel_bg)),
            panel_bg,
        );
    }

    let sel = selected.min(2);
    let options = if zh {
        [
            ("[1] 批准并执行", palette.success),
            ("[2] 修改计划", palette.tool_running),
            ("[3] 拒绝", palette.danger_soft),
        ]
    } else {
        [
            ("[1] Approve and execute", palette.success),
            ("[2] Revise", palette.tool_running),
            ("[3] Reject", palette.danger_soft),
        ]
    };
    if layout.horizontal_actions {
        let mut spans: Vec<Span<'static>> = Vec::new();
        for (idx, (label, fg)) in options.iter().enumerate() {
            if idx > 0 {
                spans.push(Span::styled("  ", Style::new().bg(panel_bg)));
            }
            let is_sel = idx == sel;
            let caret = if is_sel { CARET_SELECTED } else { "  " };
            let style = if is_sel {
                Style::new()
                    .fg(*fg)
                    .bg(panel_bg)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.muted).bg(panel_bg)
            };
            spans.push(Span::styled(format!("{caret}{label}"), style));
        }
        render_panel_row(
            frame,
            &mut y,
            y_end,
            content_area.x,
            content_area.width,
            Line::from(spans),
            panel_bg,
        );
    } else {
        for (idx, (label, fg)) in options.iter().enumerate() {
            let is_sel = idx == sel;
            let caret = if is_sel { CARET_SELECTED } else { "  " };
            let style = if is_sel {
                Style::new()
                    .fg(*fg)
                    .bg(panel_bg)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.muted).bg(panel_bg)
            };
            render_panel_row(
                frame,
                &mut y,
                y_end,
                content_area.x,
                content_area.width,
                Line::styled(clip_bot_line(&format!("{caret}{label}"), cw), style),
                panel_bg,
            );
        }
    }

    if layout.show_footer {
        let hint = if zh {
            "←/→ 或 Tab 选择 · 1/2/3 或 Enter 确认 · Esc 拒绝"
        } else {
            "←/→ or Tab select · 1/2/3 or Enter confirm · Esc Reject"
        };
        render_panel_row(
            frame,
            &mut y,
            y_end,
            content_area.x,
            content_area.width,
            Line::styled(
                clip_bot_line(hint, cw),
                Style::new().fg(palette.muted).bg(panel_bg),
            ),
            panel_bg,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::DARK_PALETTE;
    use ratatui::{Terminal, backend::TestBackend};

    fn buffer_text(term: &Terminal<TestBackend>) -> String {
        let buf = term.backend().buffer();
        let mut out = String::new();
        let mut skip_next = false;
        for c in &buf.content {
            if skip_next {
                skip_next = false;
                continue;
            }
            let sym = c.symbol();
            out.push_str(sym);
            if sym.width() > 1 {
                skip_next = true;
            }
        }
        out
    }

    fn sample_panel() -> GoalPanelView {
        GoalPanelView {
            plan_id: "plan-1".into(),
            title: "补齐原生 Classic Plan 任务区".into(),
            goal: "实现右侧任务侧栏与待审批交互卡".into(),
            status: "executing".into(),
            completed: 1,
            total: 3,
            percent: 33,
            current_task: Some(GoalTaskItem {
                id: "t2".into(),
                title: "渲染右侧任务状态栏".into(),
                status: "running".into(),
                detail: None,
            }),
            tasks: vec![
                GoalTaskItem {
                    id: "t1".into(),
                    title: "定义审批状态持久化".into(),
                    status: "completed".into(),
                    detail: None,
                },
                GoalTaskItem {
                    id: "t2".into(),
                    title: "渲染右侧任务状态栏".into(),
                    status: "running".into(),
                    detail: None,
                },
                GoalTaskItem {
                    id: "t3".into(),
                    title: "端到端 PTY 回归".into(),
                    status: "pending".into(),
                    detail: None,
                },
            ],
            blocked_reason: Some("等待手工确认核验输出".into()),
            mission_position: 1,
            total_plans: 2,
        }
    }

    #[test]
    fn goal_panel_layout_widths_glyphs_and_progress_track_match_spec() {
        assert_eq!(goal_side_panel_width(119), 0);
        assert_eq!(goal_side_panel_width(120), 36);
        assert_eq!(goal_side_panel_width(140), 42);
        assert_eq!(goal_side_panel_width(200), 42);
        assert_eq!(goal_task_glyph("completed"), "✓");
        assert_eq!(goal_task_glyph("running"), "▶");
        assert_eq!(goal_task_glyph("blocked"), "!");
        assert_eq!(goal_task_glyph("cancelled"), "–");
        assert_eq!(goal_task_glyph("pending"), "○");
        assert_eq!(goal_progress_track(50, 4), ("━━".into(), "──".into()));
        assert_eq!(goal_progress_track(0, 4), (String::new(), "────".into()));
        assert_eq!(goal_progress_track(100, 4), ("━━━━".into(), String::new()));
    }

    #[test]
    fn goal_side_panel_and_compact_bar_render_safely_across_sizes() {
        let panel = sample_panel();
        let mut term = Terminal::new(TestBackend::new(40, 28)).unwrap();
        term.draw(|f| {
            render_goal_status_panel(f, f.area(), &panel, TuiLocale::ZhCn, &DARK_PALETTE);
        })
        .unwrap();
        let out = buffer_text(&term);
        assert!(out.contains("MISSION / 01 OF 2"));
        assert!(out.contains("● EXECUTING"));
        assert!(out.contains("2 GOALS · /goals 切换"));
        assert!(out.contains("1 / 3 COMPLETE"));
        assert!(out.contains("33%"));
        assert!(out.contains("NOW WORKING"));
        assert!(out.contains("◇ ACTIVE"));
        assert!(out.contains("TASKS"));
        assert!(out.contains("✓  定义审批状态持久化"));
        assert!(out.contains("▶  渲染右侧任务状态栏"));
        assert!(out.contains("NEEDS ATTENTION"));
        assert!(out.contains("等待手工确认核验输出"));

        let mut compact = Terminal::new(TestBackend::new(90, 1)).unwrap();
        compact
            .draw(|f| {
                render_goal_compact_summary(f, f.area(), &panel, &DARK_PALETTE);
            })
            .unwrap();
        let compact_out = buffer_text(&compact);
        assert!(compact_out.contains("▶ 渲染右侧任务状态栏"));
        assert!(compact_out.contains("1/2"));
        assert!(compact_out.contains("1/3"));
        assert!(compact_out.contains("/goals"));

        // Stress tiny bounds without panic
        let mut tiny = Terminal::new(TestBackend::new(24, 8)).unwrap();
        tiny.draw(|f| {
            render_goal_status_panel(f, f.area(), &panel, TuiLocale::EnUs, &DARK_PALETTE);
        })
        .unwrap();
    }

    #[test]
    fn plan_approval_dock_renders_zh_en_and_narrow_layouts() {
        let card = PlanApprovalCard {
            plan_id: "plan-approve-1".into(),
            title: "拆分执行子任务".into(),
            goal: "按计划验证本地状态持久化与侧栏渲染".into(),
            tasks: vec![
                "更新 store 审批接口".into(),
                "实现侧栏与紧凑条".into(),
                "运行全量回归测试".into(),
            ],
        };

        for (w, h, locale) in [
            (96, 12, TuiLocale::ZhCn),
            (46, 11, TuiLocale::EnUs),
            (24, 8, TuiLocale::ZhCn),
        ] {
            let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
            let dock_h = plan_approval_dock_height(&card, w, h);
            assert!(dock_h >= 4 && dock_h <= h);
            term.draw(|f| {
                render_plan_approval_dock(
                    f,
                    Rect {
                        x: 0,
                        y: 0,
                        width: w,
                        height: dock_h,
                    },
                    &card,
                    1,
                    locale,
                    &DARK_PALETTE,
                );
            })
            .unwrap();
            let txt = buffer_text(&term);
            if locale.is_zh() {
                assert!(txt.contains("计划审批"));
                assert!(txt.contains("› [2] 修改计划"));
            } else {
                assert!(txt.contains("Plan approval"));
                assert!(txt.contains("› [2] Revise"));
            }
        }
    }
}
