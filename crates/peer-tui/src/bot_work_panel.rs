//! Pure Peer Frost right-hand Bot work panel (`◆ 工作现场` / `◆ WORK PANEL`).
//!
//! Strictly pure Ratatui display primitives with zero filesystem or process I/O.
//! Mirrors Desktop `apps/desktop/renderer/src/project-agent/conversation/BotWorkPanel.tsx`
//! and Classic `crates/peer-tui/src/goal_panel.rs`.

use crate::{
    classic_view::wrap_plain_lines,
    commands::clip_bot_line,
    goal_panel::{goal_progress_track, render_panel_row, split_pair_line},
    terminal_text,
    theme::{BRAND_MARK, SEPARATOR, TuiLocale, TuiPalette},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotWorkTaskItem {
    pub number: usize,
    pub session_id: String,
    pub title: String,
    pub status: String,
    pub accepted: bool,
    pub needs_user: bool,
    pub blocked: bool,
    pub completed_steps: usize,
    pub total_steps: usize,
    pub current_step: Option<String>,
    pub read_only: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BotWorkMaterialItem {
    pub label: String,
    pub kind: String,
    pub detail: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct BotWorkPanelView {
    pub attention_label: Option<String>,
    pub attention_detail: Option<String>,
    pub recovering: bool,
    pub obligation_count: usize,
    pub obligation_titles: Vec<String>,
    pub pending_cards_count: usize,
    pub tasks: Vec<BotWorkTaskItem>,
    pub blocker_count: usize,
    pub materials: Vec<BotWorkMaterialItem>,
    pub total_tasks_count: usize,
    pub active_objectives_count: usize,
}

fn task_status_badge(locale: TuiLocale, task: &BotWorkTaskItem) -> &'static str {
    let zh = locale.is_zh();
    match task.status.as_str() {
        "waiting_user" => {
            if zh {
                "等你回答"
            } else {
                "Waiting"
            }
        }
        "result_ready" => {
            if zh {
                "待签收"
            } else {
                "Review"
            }
        }
        "waiting_agent" => {
            if zh {
                "协作中"
            } else {
                "Agent wait"
            }
        }
        "running" => {
            if zh {
                "进行中"
            } else {
                "Running"
            }
        }
        "verifying" => {
            if zh {
                "核验中"
            } else {
                "Verifying"
            }
        }
        "starting" => {
            if zh {
                "启动中"
            } else {
                "Starting"
            }
        }
        "stopping" => {
            if zh {
                "收尾中"
            } else {
                "Stopping"
            }
        }
        "awaiting_outcome" => {
            if zh {
                "待确认"
            } else {
                "Confirming"
            }
        }
        "queued" => {
            if zh {
                "排队中"
            } else {
                "Queued"
            }
        }
        _ => {
            if zh {
                "跟进中"
            } else {
                "Active"
            }
        }
    }
}

fn material_kind_badge(locale: TuiLocale, kind: &str) -> &'static str {
    let zh = locale.is_zh();
    match kind {
        "result" => {
            if zh {
                "交互结果"
            } else {
                "Result"
            }
        }
        "output" => {
            if zh {
                "产出"
            } else {
                "Output"
            }
        }
        "artifact" => {
            if zh {
                "产物"
            } else {
                "Artifact"
            }
        }
        _ => {
            if zh {
                "参考"
            } else {
                "Ref"
            }
        }
    }
}

fn material_glyph(kind: &str, palette: &TuiPalette) -> (char, Color) {
    match kind {
        "result" => ('◇', palette.accent),
        "output" => ('▪', palette.success),
        "artifact" => ('▪', palette.info),
        _ => ('·', palette.muted),
    }
}

fn is_active_task_status(status: &str) -> bool {
    matches!(
        status,
        "queued" | "starting" | "running" | "verifying" | "stopping" | "awaiting_outcome"
    )
}

pub fn render_bot_work_panel(
    frame: &mut Frame<'_>,
    area: Rect,
    view: &BotWorkPanelView,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if area.width < 16 || area.height < 6 {
        return;
    }
    let zh = locale.is_zh();
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
    if inner_w < 8 {
        return;
    }
    let cw = usize::from(inner_w);
    let pad_y: u16 = if area.height >= 10 { 1 } else { 0 };
    let mut y = area.y + pad_y;
    let y_end = area.y + area.height - pad_y;

    let muted_style = Style::new().fg(palette.muted).bg(bg);
    let subtle_style = Style::new().fg(palette.subtle).bg(bg);
    let soft_style = Style::new().fg(palette.text_soft).bg(bg);
    let text_style = Style::new().fg(palette.text).bg(bg);

    // Reserve footer line on normal height terminals.
    let show_footer = area.height >= 12 && y < y_end;
    let content_end = if show_footer {
        y_end.saturating_sub(1).max(y)
    } else {
        y_end
    };

    // 1. Header: `◆ 工作现场` + right-aligned status pill
    let title_lbl = if zh {
        format!("{BRAND_MARK} 工作现场")
    } else {
        format!("{BRAND_MARK} WORK PANEL")
    };
    let needs_count = view.obligation_count + view.pending_cards_count;
    let any_active = view.attention_label.is_some()
        || view.tasks.iter().any(|t| is_active_task_status(&t.status));
    let (pill_lbl, pill_fg) = if needs_count > 0 {
        (
            if zh {
                format!("● 待处理 {needs_count}")
            } else {
                format!("● NEEDS {needs_count}")
            },
            palette.warning,
        )
    } else if any_active {
        (
            if zh {
                "● 推进中".to_owned()
            } else {
                "● ACTIVE".to_owned()
            },
            palette.accent,
        )
    } else {
        (
            if zh {
                "● 空闲".to_owned()
            } else {
                "● IDLE".to_owned()
            },
            palette.muted,
        )
    };
    render_panel_row(
        frame,
        &mut y,
        content_end,
        inner_x,
        inner_w,
        split_pair_line(
            &title_lbl,
            Style::new()
                .fg(palette.accent)
                .bg(bg)
                .add_modifier(Modifier::BOLD),
            &pill_lbl,
            Style::new().fg(pill_fg).bg(bg),
            cw,
            bg,
        ),
        bg,
    );

    if area.height >= 16 && y < content_end {
        y += 1;
    }

    // 2. Conditional Pending Obligations block
    if view.obligation_count > 0 && content_end.saturating_sub(y) >= 3 {
        let left_h = if zh {
            "待确认的授权"
        } else {
            "PENDING OBLIGATIONS"
        };
        let right_h = view.obligation_count.to_string();
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            split_pair_line(
                left_h,
                Style::new()
                    .fg(palette.warning)
                    .bg(bg)
                    .add_modifier(Modifier::BOLD),
                &right_h,
                Style::new().fg(palette.warning).bg(bg),
                cw,
                bg,
            ),
            bg,
        );
        for title in view.obligation_titles.iter().take(2) {
            render_panel_row(
                frame,
                &mut y,
                content_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(&format!("! {}", terminal_text(title)), cw),
                    Style::new().fg(palette.warning).bg(bg),
                ),
                bg,
            );
        }
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            Line::styled(
                clip_bot_line(
                    if zh {
                        "Tab / /cards 确认"
                    } else {
                        "Tab / /cards to confirm"
                    },
                    cw,
                ),
                subtle_style,
            ),
            bg,
        );
        if area.height >= 16 && y < content_end {
            y += 1;
        }
    }

    // 3. Bot's current attention
    if y < content_end {
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            Line::styled(
                clip_bot_line(
                    if zh {
                        "○ Bot 的当前注意力"
                    } else {
                        "○ Bot attention"
                    },
                    cw,
                ),
                soft_style.add_modifier(Modifier::BOLD),
            ),
            bg,
        );
        if view.recovering {
            render_panel_row(
                frame,
                &mut y,
                content_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(
                        if zh {
                            "当前回复需要恢复"
                        } else {
                            "Reply needs recovery"
                        },
                        cw,
                    ),
                    Style::new().fg(palette.warning).bg(bg),
                ),
                bg,
            );
        } else if let Some(ref lbl) = view.attention_label {
            render_panel_row(
                frame,
                &mut y,
                content_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(&terminal_text(lbl), cw),
                    Style::new()
                        .fg(palette.accent)
                        .bg(bg)
                        .add_modifier(Modifier::BOLD),
                ),
                bg,
            );
            if let Some(ref detail) = view.attention_detail {
                for dline in wrap_plain_lines(&terminal_text(detail), cw, 2) {
                    render_panel_row(
                        frame,
                        &mut y,
                        content_end,
                        inner_x,
                        inner_w,
                        Line::styled(dline, soft_style),
                        bg,
                    );
                }
            }
        } else {
            render_panel_row(
                frame,
                &mut y,
                content_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(
                        if zh {
                            "当前没有公开的活动"
                        } else {
                            "No public activity"
                        },
                        cw,
                    ),
                    muted_style,
                ),
                bg,
            );
            if content_end.saturating_sub(y) >= 8 {
                let hint = if zh {
                    "任务的最新进展在下方，后台更新不会打断你的阅读。"
                } else {
                    "Task progress stays below without interrupting your reading."
                };
                for hline in wrap_plain_lines(hint, cw, 2) {
                    render_panel_row(
                        frame,
                        &mut y,
                        content_end,
                        inner_x,
                        inner_w,
                        Line::styled(hline, subtle_style),
                        bg,
                    );
                }
            }
        }
    }

    if area.height >= 18 && y < content_end {
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            Line::styled(SEPARATOR.repeat(cw), subtle_style),
            bg,
        );
    }

    // 4. Following Tasks
    let materials_reserve: u16 = if area.height >= 20 { 4 } else { 2 };
    let tasks_y_end = content_end.saturating_sub(materials_reserve).max(y);
    if y < tasks_y_end {
        let task_heading = if zh {
            format!("跟进中的任务  {}", view.tasks.len())
        } else {
            format!("Tasks  {}", view.tasks.len())
        };
        let blocker_badge = if view.blocker_count > 0 {
            if zh {
                format!("{} 处卡点", view.blocker_count)
            } else {
                format!("{} blocked", view.blocker_count)
            }
        } else {
            String::new()
        };
        render_panel_row(
            frame,
            &mut y,
            tasks_y_end,
            inner_x,
            inner_w,
            split_pair_line(
                &task_heading,
                soft_style.add_modifier(Modifier::BOLD),
                &blocker_badge,
                Style::new().fg(palette.warning).bg(bg),
                cw,
                bg,
            ),
            bg,
        );

        if view.tasks.is_empty() {
            render_panel_row(
                frame,
                &mut y,
                tasks_y_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(
                        if zh {
                            "当前没有需要继续跟进的任务。"
                        } else {
                            "No active follow-up tasks."
                        },
                        cw,
                    ),
                    muted_style,
                ),
                bg,
            );
        } else {
            let mut rendered = 0usize;
            for task in view.tasks.iter().take(4) {
                if y >= tasks_y_end {
                    break;
                }
                let glyph = if task.needs_user || task.blocked {
                    "!"
                } else if matches!(task.status.as_str(), "running" | "verifying" | "starting") {
                    "›"
                } else {
                    "·"
                };
                let title_fg = if task.needs_user || task.blocked {
                    palette.warning
                } else if matches!(task.status.as_str(), "running" | "verifying") {
                    palette.tool_running
                } else {
                    palette.text
                };
                let raw_title = if task.title.trim().is_empty() {
                    task.session_id.as_str()
                } else {
                    task.title.as_str()
                };
                let left = format!("{glyph} #{} {}", task.number, terminal_text(raw_title));
                let badge = task_status_badge(locale, task);
                render_panel_row(
                    frame,
                    &mut y,
                    tasks_y_end,
                    inner_x,
                    inner_w,
                    split_pair_line(
                        &left,
                        Style::new().fg(title_fg).bg(bg),
                        badge,
                        Style::new().fg(title_fg).bg(bg),
                        cw,
                        bg,
                    ),
                    bg,
                );
                rendered += 1;

                if task.total_steps > 0 && y < tasks_y_end {
                    let count_lbl = format!("{}/{}", task.completed_steps, task.total_steps);
                    let pct = ((task.completed_steps * 100) / task.total_steps).min(100) as u8;
                    let bar_w = cw.saturating_sub(count_lbl.width() + 3).max(4);
                    let (done_bar, rem_bar) = goal_progress_track(pct, bar_w);
                    render_panel_row(
                        frame,
                        &mut y,
                        tasks_y_end,
                        inner_x,
                        inner_w,
                        Line::from(vec![
                            Span::styled("  ", Style::new().bg(bg)),
                            Span::styled(done_bar, Style::new().fg(palette.accent).bg(bg)),
                            Span::styled(rem_bar, border_style),
                            Span::styled(format!(" {count_lbl}"), muted_style),
                        ]),
                        bg,
                    );
                }

                if let Some(ref step) = task.current_step
                    && !step.trim().is_empty()
                    && tasks_y_end.saturating_sub(y) >= 2
                {
                    let step_txt = clip_bot_line(&format!("  └ {}", terminal_text(step)), cw);
                    render_panel_row(
                        frame,
                        &mut y,
                        tasks_y_end,
                        inner_x,
                        inner_w,
                        Line::styled(step_txt, muted_style),
                        bg,
                    );
                }
            }
            if view.tasks.len() > rendered && y < tasks_y_end {
                let more = view.tasks.len() - rendered;
                let more_lbl = if zh {
                    format!("+{more} 项 · /tasks")
                } else {
                    format!("+{more} more · /tasks")
                };
                render_panel_row(
                    frame,
                    &mut y,
                    tasks_y_end,
                    inner_x,
                    inner_w,
                    Line::styled(clip_bot_line(&more_lbl, cw), subtle_style),
                    bg,
                );
            }
        }
    }

    if area.height >= 20 && y < content_end {
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            Line::styled(SEPARATOR.repeat(cw), subtle_style),
            bg,
        );
    }

    // 5. Materials & outputs
    if y < content_end {
        let mat_heading = if zh {
            format!("产出与资料  {}", view.materials.len())
        } else {
            format!("Materials  {}", view.materials.len())
        };
        render_panel_row(
            frame,
            &mut y,
            content_end,
            inner_x,
            inner_w,
            Line::styled(
                clip_bot_line(&mat_heading, cw),
                soft_style.add_modifier(Modifier::BOLD),
            ),
            bg,
        );
        if view.materials.is_empty() {
            render_panel_row(
                frame,
                &mut y,
                content_end,
                inner_x,
                inner_w,
                Line::styled(
                    clip_bot_line(
                        if zh {
                            "还没有已登记的产出或参考文件。"
                        } else {
                            "No registered outputs or files."
                        },
                        cw,
                    ),
                    muted_style,
                ),
                bg,
            );
        } else {
            for item in view.materials.iter().take(4) {
                if y >= content_end {
                    break;
                }
                let (glyph, gcolor) = material_glyph(&item.kind, palette);
                let kind_badge = material_kind_badge(locale, &item.kind);
                let left = format!("{glyph} {}", terminal_text(&item.label));
                let left_budget = cw.saturating_sub(kind_badge.width() + 2).max(4);
                let clipped_left = clip_bot_line(&left, left_budget);
                let gap = cw.saturating_sub(clipped_left.width() + kind_badge.width());
                render_panel_row(
                    frame,
                    &mut y,
                    content_end,
                    inner_x,
                    inner_w,
                    Line::from(vec![
                        Span::styled(
                            clipped_left.chars().take(1).collect::<String>(),
                            Style::new().fg(gcolor).bg(bg),
                        ),
                        Span::styled(clipped_left.chars().skip(1).collect::<String>(), text_style),
                        Span::styled(" ".repeat(gap), Style::new().bg(bg)),
                        Span::styled(kind_badge, muted_style),
                    ]),
                    bg,
                );
            }
        }
    }

    // 6. Footer hint row
    if show_footer {
        let mut footer = if zh {
            format!("F4 收起 · /tasks {}", view.total_tasks_count)
        } else {
            format!("F4 hide · /tasks {}", view.total_tasks_count)
        };
        if view.active_objectives_count > 0 {
            let obj_part = if zh {
                format!(" · 目标 {}", view.active_objectives_count)
            } else {
                format!(" · objectives {}", view.active_objectives_count)
            };
            if footer.width() + obj_part.width() <= cw {
                footer.push_str(&obj_part);
            }
        }
        let mut fy = y_end - 1;
        render_panel_row(
            frame,
            &mut fy,
            y_end,
            inner_x,
            inner_w,
            Line::styled(clip_bot_line(&footer, cw), subtle_style),
            bg,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::DARK_PALETTE;
    use ratatui::{Terminal, backend::TestBackend};

    fn buf_text(term: &Terminal<TestBackend>) -> String {
        let b = term.backend().buffer();
        let mut out = String::new();
        for r in 0..b.area.height {
            let mut c = 0;
            while c < b.area.width {
                let sym = b[(c, r)].symbol();
                let w = sym.width().max(1);
                out.push_str(sym);
                c += w as u16;
            }
            out.push('\n');
        }
        out
    }

    #[test]
    fn bot_work_panel_renders_quiet_active_obligations_tasks_progress_and_materials() {
        let area = Rect::new(0, 0, 42, 32);

        // 1. Quiet state
        let mut quiet_term = Terminal::new(TestBackend::new(42, 32)).unwrap();
        let quiet = BotWorkPanelView::default();
        quiet_term
            .draw(|f| render_bot_work_panel(f, area, &quiet, TuiLocale::ZhCn, &DARK_PALETTE))
            .unwrap();
        let quiet_txt = buf_text(&quiet_term);
        assert!(quiet_txt.contains("◆ 工作现场"));
        assert!(quiet_txt.contains("● 空闲"));
        assert!(quiet_txt.contains("当前没有公开的活动"));
        assert!(quiet_txt.contains("当前没有需要继续跟进的任务。"));
        assert!(quiet_txt.contains("还没有已登记的产出或参考文件。"));
        assert!(quiet_txt.contains("F4 收起 · /tasks 0"));

        // 2. Active state with obligations, multi-step task progress, blockers, and materials
        let mut active_term = Terminal::new(TestBackend::new(42, 32)).unwrap();
        let active = BotWorkPanelView {
            attention_label: Some("调用工具中…".into()),
            attention_detail: Some("正在汇总测试与文档结论".into()),
            recovering: false,
            obligation_count: 1,
            obligation_titles: vec!["旧分支写锁清理".into()],
            pending_cards_count: 0,
            tasks: vec![BotWorkTaskItem {
                number: 2,
                session_id: "s-2".into(),
                title: "审计工作区权限".into(),
                status: "running".into(),
                accepted: false,
                needs_user: false,
                blocked: false,
                completed_steps: 2,
                total_steps: 4,
                current_step: Some("检查路由权限清单".into()),
                read_only: true,
            }],
            blocker_count: 1,
            materials: vec![
                BotWorkMaterialItem {
                    label: "Benchmark Matrix".into(),
                    kind: "result".into(),
                    detail: None,
                },
                BotWorkMaterialItem {
                    label: "src/lib.rs".into(),
                    kind: "output".into(),
                    detail: None,
                },
            ],
            total_tasks_count: 5,
            active_objectives_count: 2,
        };
        active_term
            .draw(|f| render_bot_work_panel(f, area, &active, TuiLocale::ZhCn, &DARK_PALETTE))
            .unwrap();
        let active_txt = buf_text(&active_term);
        assert!(active_txt.contains("● 待处理 1"));
        assert!(active_txt.contains("待确认的授权"));
        assert!(active_txt.contains("旧分支写锁清理"));
        assert!(active_txt.contains("调用工具中…"));
        assert!(active_txt.contains("审计工作区权限"));
        assert!(active_txt.contains("1 处卡点"));
        assert!(active_txt.contains("2/4"));
        assert!(active_txt.contains("检查路由权限清单"));
        assert!(active_txt.contains("Benchmark Matrix"));
        assert!(active_txt.contains("产出"));
        assert!(active_txt.contains("F4 收起 · /tasks 5 · 目标 2"));
    }

    #[test]
    fn bot_work_panel_handles_small_viewports_and_en_locale_without_panic() {
        let en = BotWorkPanelView {
            attention_label: Some("Thinking…".into()),
            attention_detail: None,
            recovering: false,
            obligation_count: 0,
            obligation_titles: vec![],
            pending_cards_count: 0,
            tasks: vec![BotWorkTaskItem {
                number: 1,
                session_id: "s-1".into(),
                title: "Verify build".into(),
                status: "waiting_user".into(),
                accepted: false,
                needs_user: true,
                blocked: true,
                completed_steps: 1,
                total_steps: 3,
                current_step: None,
                read_only: true,
            }],
            blocker_count: 1,
            materials: vec![BotWorkMaterialItem {
                label: "README.md".into(),
                kind: "reference".into(),
                detail: None,
            }],
            total_tasks_count: 1,
            active_objectives_count: 0,
        };
        let mut small = Terminal::new(TestBackend::new(34, 14)).unwrap();
        small
            .draw(|f| {
                render_bot_work_panel(
                    f,
                    Rect::new(0, 0, 34, 14),
                    &en,
                    TuiLocale::EnUs,
                    &DARK_PALETTE,
                )
            })
            .unwrap();
        let txt = buf_text(&small);
        assert!(txt.contains("◆ WORK PANEL"));
        assert!(txt.contains("Thinking…"));
        assert!(txt.contains("F4 hide · /tasks 1"));

        // Sub-minimum viewport gracefully no-ops
        let mut tiny = Terminal::new(TestBackend::new(10, 4)).unwrap();
        tiny.draw(|f| {
            render_bot_work_panel(
                f,
                Rect::new(0, 0, 10, 4),
                &en,
                TuiLocale::EnUs,
                &DARK_PALETTE,
            )
        })
        .unwrap();
    }
}
