//! Pure Frost overlays for Classic & Bot interactive shells.
//!
//! Renders docked pickers (`Resume`, `Mode`, `Permissions`, `Theme`, `Language`, `Goals`, `Help`)
//! and centered modal managers (`Skills`, `MCP`) matching `apps/tui/src/app.tsx` and
//! `apps/tui/src/goal-status-view.tsx` with zero filesystem or process I/O.

use crate::{
    commands::clip_bot_line,
    slash_menu::{CLASSIC_SLASH_ITEMS, GoalMenuStatus, SlashFilterContext, classic_item_visible},
    theme::{
        CARET_IDLE, CARET_SELECTED, CHECK_CURRENT, OFFLINE_DOT, ONLINE_DOT, SEPARATOR, ThemeMode,
        TuiLocale, TuiPalette,
    },
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResumeSessionRow {
    pub id: String,
    pub title: String,
    pub message_count: u64,
    pub updated_at: Option<String>,
    pub workspace_tag: Option<String>,
    pub mode: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SkillPickerRow {
    pub skill_id: String,
    pub name: String,
    pub description: String,
    pub enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpPickerRow {
    pub id: String,
    pub display_name: String,
    pub enabled: bool,
    pub health_status: String,
    pub visible_tools: usize,
    pub total_tools: usize,
    pub tool_names: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalPickerRow {
    pub plan_id: String,
    pub title: String,
    pub status: String,
    pub completed: usize,
    pub total: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ClassicOverlay {
    #[default]
    None,
    Resume {
        rows: Vec<ResumeSessionRow>,
        selected: usize,
    },
    Mode {
        selected: usize,
    },
    Permissions {
        selected: usize,
    },
    Theme {
        selected: usize,
    },
    Language {
        selected: usize,
    },
    Skills {
        items: Vec<SkillPickerRow>,
        query: String,
        selected: usize,
    },
    Mcp {
        items: Vec<McpPickerRow>,
        query: String,
        selected: usize,
    },
    Goals {
        plans: Vec<GoalPickerRow>,
        current_plan_id: Option<String>,
        query: String,
        selected: usize,
    },
    Help {
        scroll: usize,
    },
}

impl ClassicOverlay {
    pub fn is_open(&self) -> bool {
        !matches!(self, Self::None)
    }

    pub fn is_modal(&self) -> bool {
        matches!(self, Self::Skills { .. } | Self::Mcp { .. })
    }

    pub fn dock_height(&self, max_h: u16) -> u16 {
        let desired = match self {
            Self::None => return 0,
            Self::Skills { .. } | Self::Mcp { .. } => return 0,
            Self::Resume { rows, .. } => (rows.len().clamp(1, 8) as u16) + 4,
            Self::Mode { .. } => 8,
            Self::Permissions { .. } => 10,
            Self::Theme { .. } | Self::Language { .. } => 8,
            Self::Goals { plans, .. } => (plans.len().clamp(1, 8) as u16) + 5,
            Self::Help { .. } => 16,
        };
        desired.min(max_h.max(3))
    }

    pub fn filtered_skill_indices(&self) -> Vec<usize> {
        let Self::Skills { items, query, .. } = self else {
            return Vec::new();
        };
        let q = query.trim().to_ascii_lowercase();
        items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                q.is_empty()
                    || item.name.to_ascii_lowercase().contains(&q)
                    || item.skill_id.to_ascii_lowercase().contains(&q)
                    || item.description.to_ascii_lowercase().contains(&q)
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn filtered_mcp_indices(&self) -> Vec<usize> {
        let Self::Mcp { items, query, .. } = self else {
            return Vec::new();
        };
        let q = query.trim().to_ascii_lowercase();
        items
            .iter()
            .enumerate()
            .filter(|(_, item)| {
                q.is_empty()
                    || item.display_name.to_ascii_lowercase().contains(&q)
                    || item.id.to_ascii_lowercase().contains(&q)
                    || item
                        .tool_names
                        .iter()
                        .any(|t| t.to_ascii_lowercase().contains(&q))
            })
            .map(|(i, _)| i)
            .collect()
    }

    pub fn filtered_goal_indices(&self) -> Vec<usize> {
        let Self::Goals { plans, query, .. } = self else {
            return Vec::new();
        };
        let q = query.trim().to_ascii_lowercase();
        plans
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                q.is_empty()
                    || p.title.to_ascii_lowercase().contains(&q)
                    || p.plan_id.to_ascii_lowercase().contains(&q)
                    || p.status.to_ascii_lowercase().contains(&q)
            })
            .map(|(i, _)| i)
            .collect()
    }
}

pub struct OverlayContext<'a> {
    pub current_mode: &'a str,
    pub current_access: &'a str,
    pub current_theme: ThemeMode,
    pub current_locale: TuiLocale,
    pub fast_available: bool,
    pub goal_status: GoalMenuStatus,
}

fn fill_panel(frame: &mut Frame<'_>, area: Rect, palette: &TuiPalette) {
    frame.render_widget(Block::default().style(Style::new().bg(palette.panel)), area);
}

struct ModalRow<'a> {
    name: &'a str,
    detail: String,
    enabled: bool,
}

struct ModalSpec<'a> {
    title: &'a str,
    hint: &'a str,
    empty_label: &'a str,
    rows: &'a [ModalRow<'a>],
    selected: usize,
    query: &'a str,
    zh: bool,
}

fn render_capability_modal(
    frame: &mut Frame<'_>,
    area: Rect,
    spec: &ModalSpec<'_>,
    palette: &TuiPalette,
) {
    let box_w = area.width.min(76).max(32.min(area.width));
    let box_h = area.height.saturating_sub(4).clamp(8.min(area.height), 22);
    let box_area = Rect {
        x: area.x + area.width.saturating_sub(box_w) / 2,
        y: area.y + area.height.saturating_sub(box_h) / 2,
        width: box_w,
        height: box_h,
    };
    frame.render_widget(Clear, box_area);
    let block = Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(Style::new().fg(palette.accent).bg(palette.panel))
        .style(Style::new().bg(palette.panel));
    let inner = block.inner(box_area);
    frame.render_widget(block, box_area);
    let iw = usize::from(inner.width).max(1);
    let ih = usize::from(inner.height);
    if ih < 3 {
        return;
    }
    let mut lines = vec![
        Line::styled(
            clip_bot_line(spec.title, iw),
            Style::new()
                .fg(palette.text)
                .bg(palette.panel)
                .add_modifier(Modifier::BOLD),
        ),
        muted_line(spec.hint, iw, palette),
    ];
    let list_cap = ih.saturating_sub(3) / 2;
    if spec.rows.is_empty() {
        lines.push(muted_line(spec.empty_label, iw, palette));
    } else {
        let cap = list_cap.max(1);
        let sel = spec.selected.min(spec.rows.len() - 1);
        let start = sel
            .saturating_sub(cap / 2)
            .min(spec.rows.len().saturating_sub(cap));
        for (offset, row) in spec.rows.iter().skip(start).take(cap).enumerate() {
            let is_sel = start + offset == sel;
            let dot = if row.enabled { ONLINE_DOT } else { OFFLINE_DOT };
            let caret = if is_sel { CARET_SELECTED } else { CARET_IDLE };
            let row_bg = if is_sel {
                palette.selection
            } else {
                palette.panel
            };
            let row_fg = if !row.enabled {
                palette.muted
            } else if is_sel {
                palette.accent
            } else {
                palette.text
            };
            lines.push(Line::styled(
                clip_bot_line(&format!("{caret}{dot} {}", row.name), iw),
                Style::new().fg(row_fg).bg(row_bg),
            ));
            if lines.len() + 1 < ih {
                lines.push(Line::styled(
                    clip_bot_line(&format!("  {}", row.detail), iw),
                    Style::new().fg(palette.muted).bg(palette.panel),
                ));
            }
        }
    }
    let search = if spec.query.is_empty() {
        "…"
    } else {
        spec.query
    };
    while lines.len() + 1 < ih {
        lines.push(Line::styled("", Style::new().bg(palette.panel)));
    }
    lines.push(muted_line(
        &format!("{}{}", if spec.zh { "过滤：" } else { "Search: " }, search),
        iw,
        palette,
    ));
    frame.render_widget(Paragraph::new(lines), inner);
}

fn dock_header(width: usize, title: &str, palette: &TuiPalette) -> Vec<Line<'static>> {
    vec![
        Line::styled(
            SEPARATOR.repeat(width.max(1)),
            Style::new().fg(palette.border).bg(palette.panel),
        ),
        Line::styled(
            clip_bot_line(title, width),
            Style::new()
                .fg(palette.accent)
                .bg(palette.panel)
                .add_modifier(Modifier::BOLD),
        ),
    ]
}

fn option_line(
    selected: bool,
    current: bool,
    label: &str,
    suffix: Option<&str>,
    width: usize,
    palette: &TuiPalette,
) -> Line<'static> {
    let caret = if selected { CARET_SELECTED } else { CARET_IDLE };
    let mut main = format!("{caret}{label}");
    if let Some(s) = suffix
        && !s.is_empty()
    {
        main.push_str("  ");
        main.push_str(s);
    }
    let check_w = if current { CHECK_CURRENT.width() } else { 0 };
    let clipped = clip_bot_line(&main, width.saturating_sub(check_w));
    let fg = if selected {
        palette.accent
    } else {
        palette.text_soft
    };
    let mut spans = vec![Span::styled(
        clipped,
        if selected {
            Style::new()
                .fg(fg)
                .bg(palette.panel)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(fg).bg(palette.panel)
        },
    )];
    if current {
        spans.push(Span::styled(
            CHECK_CURRENT,
            Style::new().fg(palette.success).bg(palette.panel),
        ));
    }
    Line::from(spans)
}

fn muted_line(text: &str, width: usize, palette: &TuiPalette) -> Line<'static> {
    Line::styled(
        clip_bot_line(text, width),
        Style::new().fg(palette.muted).bg(palette.panel),
    )
}

pub fn build_help_lines(
    locale: TuiLocale,
    fast_available: bool,
    goal_status: GoalMenuStatus,
) -> Vec<(bool, String)> {
    let mut out = Vec::new();
    let zh = locale.is_zh();
    out.push((
        true,
        if zh {
            "快捷键"
        } else {
            "Keyboard shortcuts"
        }
        .to_owned(),
    ));
    let keys = if zh {
        [
            "  Enter          发送消息 / 执行斜杠命令",
            "  Ctrl+X M/O/P   打开模型 / 模式 / 权限选择器",
            "  Ctrl+X N / L   新建任务 / 恢复历史会话",
            "  Ctrl+X 1/2/3   直接切换 Agent / Plan / Goal",
            "  F2 / F3        切换机器人列表 / 打开模型选择器",
            "  Ctrl+C         停止本轮 / 清空草稿 / 退出",
        ]
    } else {
        [
            "  Enter          Send message / run slash command",
            "  Ctrl+X M/O/P   Open Model / Mode / Permissions picker",
            "  Ctrl+X N / L   New task / Resume session",
            "  Ctrl+X 1/2/3   Switch to Agent / Plan / Goal",
            "  F2 / F3        Switch to Project Bots / Model picker",
            "  Ctrl+C         Cancel stream / clear draft / quit",
        ]
    };
    for line in keys {
        out.push((false, line.to_owned()));
    }

    out.push((
        true,
        if zh { "斜杠命令" } else { "Slash commands" }.to_owned(),
    ));
    let filter_ctx = SlashFilterContext {
        fast_available,
        goal_status,
    };
    for item in CLASSIC_SLASH_ITEMS
        .iter()
        .filter(|i| classic_item_visible(i, filter_ctx))
    {
        let shortcut = if item.shortcut.is_empty() {
            String::new()
        } else {
            format!(" ({})", item.shortcut)
        };
        out.push((
            false,
            format!(
                "  {:<14} {}{}",
                item.command.trim_end(),
                item.desc(locale),
                shortcut
            ),
        ));
    }

    out.push((true, if zh { "运行模式" } else { "Modes" }.to_owned()));
    let modes = if zh {
        [
            "  Agent  默认执行模式（自适应规划与工具执行）",
            "  Plan   只读规划模式（先形成可执行计划再批准运行）",
            "  Goal   目标推进模式（按证据检查点推进长程目标）",
        ]
    } else {
        [
            "  Agent  General conversation with read/write tools",
            "  Plan   Read-only planning before executing changes",
            "  Goal   Execute approved plans with evidence checkpoints",
        ]
    };
    for line in modes {
        out.push((false, line.to_owned()));
    }
    out
}

pub fn render_classic_overlay(
    frame: &mut Frame<'_>,
    area: Rect,
    overlay: &ClassicOverlay,
    ctx: &OverlayContext<'_>,
    palette: &TuiPalette,
) {
    if area.width < 12 || area.height < 4 {
        return;
    }
    let w = usize::from(area.width);
    let zh = ctx.current_locale.is_zh();

    match overlay {
        ClassicOverlay::None => {}
        ClassicOverlay::Resume { rows, selected } => {
            fill_panel(frame, area, palette);
            let title = if zh {
                format!("恢复会话 · {} 个历史对话", rows.len())
            } else {
                format!("Resume session · {} saved", rows.len())
            };
            let mut lines = dock_header(w, &title, palette);
            if rows.is_empty() {
                lines.push(muted_line(
                    if zh {
                        "  暂无可恢复的历史会话。"
                    } else {
                        "  No saved conversations to resume."
                    },
                    w,
                    palette,
                ));
            } else {
                let max_vis = usize::from(area.height.saturating_sub(3)).clamp(1, 8);
                let sel = (*selected).min(rows.len() - 1);
                let start = sel
                    .saturating_sub(max_vis / 2)
                    .min(rows.len().saturating_sub(max_vis));
                for (offset, row) in rows.iter().skip(start).take(max_vis).enumerate() {
                    let is_sel = start + offset == sel;
                    let count_str = if zh {
                        format!("{} 条", row.message_count)
                    } else {
                        format!("{} msgs", row.message_count)
                    };
                    let meta = match &row.workspace_tag {
                        Some(ws) => format!("({count_str} · {ws})"),
                        None => format!("({count_str})"),
                    };
                    lines.push(option_line(
                        is_sel,
                        false,
                        &row.title,
                        Some(&meta),
                        w,
                        palette,
                    ));
                }
            }
            lines.push(muted_line(
                if zh {
                    "↑↓ 选择 · Enter 恢复会话 · Esc 关闭"
                } else {
                    "↑↓ choose · Enter resume · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Mode { selected } => {
            fill_panel(frame, area, palette);
            let mut lines = dock_header(w, if zh { "运行模式" } else { "Mode" }, palette);
            lines.push(muted_line(
                if zh {
                    "选择下一条消息的运行模式"
                } else {
                    "Choose how the next message should run"
                },
                w,
                palette,
            ));
            let options = if zh {
                [
                    ("chat", "1. Agent — 默认智能体模式（自动规划并调用工具）"),
                    ("plan", "2. Plan  — 只读规划模式（先协定计划，审批后执行）"),
                ]
            } else {
                [
                    ("chat", "1. Agent — Adaptive planning and execution"),
                    ("plan", "2. Plan  — Read-only planning before approval"),
                ]
            };
            let sel = (*selected).min(options.len() - 1);
            for (idx, (wire, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_mode == *wire,
                    label,
                    None,
                    w,
                    palette,
                ));
            }
            lines.push(muted_line(
                if zh {
                    "↑↓ 选择 · 1–2 直选 · Enter 应用 · Esc 关闭"
                } else {
                    "↑↓ select · 1–2 direct · Enter apply · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Permissions { selected } => {
            fill_panel(frame, area, palette);
            let mut lines = dock_header(
                w,
                if zh {
                    "本地权限策略"
                } else {
                    "Local access"
                },
                palette,
            );
            let options = if zh {
                [
                    ("ask", "1. Ask          — 执行本地操作前逐次确认"),
                    (
                        "session",
                        "2. Approve      — 自动放行低中风险，高风险仍询问",
                    ),
                    ("full", "3. Full access  — 自动放行全部本地工具调用"),
                ]
            } else {
                [
                    ("ask", "1. Ask          — Ask before local actions"),
                    (
                        "session",
                        "2. Approve      — Auto-approve low/medium-risk calls",
                    ),
                    (
                        "full",
                        "3. Full access  — Auto-approve all local tool calls",
                    ),
                ]
            };
            let sel = (*selected).min(options.len() - 1);
            for (idx, (wire, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_access == *wire,
                    label,
                    None,
                    w,
                    palette,
                ));
            }
            lines.push(muted_line(
                if zh {
                    "运行时显式拒绝规则与不可逆保护门始终生效。"
                } else {
                    "Runtime deny rules and irreversible-action gates always win."
                },
                w,
                palette,
            ));
            lines.push(muted_line(
                if zh {
                    "↑↓ 选择 · 1–3 直选 · Enter 应用 · Esc 关闭"
                } else {
                    "↑↓ select · 1–3 direct · Enter apply · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Theme { selected } => {
            fill_panel(frame, area, palette);
            let mut lines = dock_header(
                w,
                if zh {
                    "主题 · Peer Frost"
                } else {
                    "Theme · Peer Frost"
                },
                palette,
            );
            let options = if zh {
                [
                    (ThemeMode::Dark, "1. 深色 (Dark)"),
                    (ThemeMode::Light, "2. 浅色 (Light)"),
                    (ThemeMode::System, "3. 跟随系统 (System)"),
                ]
            } else {
                [
                    (ThemeMode::Dark, "1. Dark"),
                    (ThemeMode::Light, "2. Light"),
                    (ThemeMode::System, "3. System"),
                ]
            };
            let sel = (*selected).min(options.len() - 1);
            for (idx, (mode, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_theme == *mode,
                    label,
                    None,
                    w,
                    palette,
                ));
            }
            lines.push(muted_line(
                if zh {
                    "↑↓ 选择 · 1–3 直选 · Enter 应用 · Esc 关闭"
                } else {
                    "↑↓ select · 1–3 direct · Enter apply · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Language { selected } => {
            fill_panel(frame, area, palette);
            let mut lines = dock_header(
                w,
                if zh {
                    "界面与回复语言"
                } else {
                    "Language"
                },
                palette,
            );
            let options = [
                (TuiLocale::ZhCn, "1. 简体中文 (zh-CN)"),
                (TuiLocale::EnUs, "2. English (en-US)"),
            ];
            let sel = (*selected).min(options.len() - 1);
            for (idx, (loc, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_locale == *loc,
                    label,
                    None,
                    w,
                    palette,
                ));
            }
            lines.push(muted_line(
                if zh {
                    "↑↓ 选择 · 1–2 直选 · Enter 应用 · Esc 关闭"
                } else {
                    "↑↓ select · 1–2 direct · Enter apply · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Goals {
            plans,
            current_plan_id,
            query,
            selected,
        } => {
            fill_panel(frame, area, palette);
            let title = if zh {
                format!("目标历史 · {} 个正式目标", plans.len())
            } else {
                format!("Goal history · {} formal goals", plans.len())
            };
            let mut lines = dock_header(w, &title, palette);
            let search = if query.is_empty() {
                "…"
            } else {
                query.as_str()
            };
            lines.push(muted_line(&format!("Search: {search}"), w, palette));
            let filtered = overlay.filtered_goal_indices();
            if filtered.is_empty() {
                lines.push(muted_line(
                    if zh {
                        "  当前会话无匹配目标。"
                    } else {
                        "  No matching formal goals."
                    },
                    w,
                    palette,
                ));
            } else {
                let max_vis = usize::from(area.height.saturating_sub(4)).clamp(1, 8);
                let sel = (*selected).min(filtered.len() - 1);
                let start = sel
                    .saturating_sub(max_vis / 2)
                    .min(filtered.len().saturating_sub(max_vis));
                for (offset, idx) in filtered.iter().skip(start).take(max_vis).enumerate() {
                    let plan = &plans[*idx];
                    let is_sel = start + offset == sel;
                    let is_cur = current_plan_id.as_deref() == Some(plan.plan_id.as_str());
                    let label = format!("{}. {}", start + offset + 1, plan.title);
                    let suffix = format!("{} · {}/{}", plan.status, plan.completed, plan.total);
                    lines.push(option_line(
                        is_sel,
                        is_cur,
                        &label,
                        Some(&suffix),
                        w,
                        palette,
                    ));
                }
            }
            lines.push(muted_line(
                if zh {
                    "输入过滤 · ↑↓ 选择 · Enter 切换查看 · Esc 关闭"
                } else {
                    "type search · ↑↓ choose · Enter select · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Help { scroll } => {
            fill_panel(frame, area, palette);
            let rows = Layout::vertical([
                Constraint::Length(2),
                Constraint::Min(1),
                Constraint::Length(1),
            ])
            .split(area);
            frame.render_widget(
                Paragraph::new(dock_header(
                    w,
                    if zh {
                        "帮助 · 快捷键、斜杠命令与模式说明"
                    } else {
                        "Help · Shortcuts, commands, and modes"
                    },
                    palette,
                )),
                rows[0],
            );
            let help_lines =
                build_help_lines(ctx.current_locale, ctx.fast_available, ctx.goal_status);
            let vh = usize::from(rows[1].height);
            let max_scroll = help_lines.len().saturating_sub(vh);
            let start = (*scroll).min(max_scroll);
            let rendered: Vec<Line<'static>> = help_lines
                .iter()
                .skip(start)
                .take(vh)
                .map(|(is_header, text)| {
                    if *is_header {
                        Line::styled(
                            clip_bot_line(text, w),
                            Style::new()
                                .fg(palette.accent)
                                .bg(palette.panel)
                                .add_modifier(Modifier::BOLD),
                        )
                    } else {
                        Line::styled(
                            clip_bot_line(text, w),
                            Style::new().fg(palette.text_soft).bg(palette.panel),
                        )
                    }
                })
                .collect();
            frame.render_widget(Paragraph::new(rendered), rows[1]);
            frame.render_widget(
                Paragraph::new(muted_line(
                    if zh {
                        "↑↓ / PgUp / PgDn 滚动 · Enter / Esc / q 关闭"
                    } else {
                        "↑↓ / PgUp / PgDn scroll · Enter / Esc / q close"
                    },
                    w,
                    palette,
                )),
                rows[2],
            );
        }
        ClassicOverlay::Skills {
            items,
            query,
            selected,
        } => {
            let rows: Vec<ModalRow<'_>> = overlay
                .filtered_skill_indices()
                .into_iter()
                .map(|i| ModalRow {
                    name: &items[i].name,
                    detail: items[i].description.clone(),
                    enabled: items[i].enabled,
                })
                .collect();
            render_capability_modal(
                frame,
                area,
                &ModalSpec {
                    title: if zh { "Skills 技能管理" } else { "Skills" },
                    hint: if zh {
                        "↑↓ 选择 · Space 启用/停用 · Enter 插入提示词 · r 刷新 · Esc 关闭"
                    } else {
                        "↑↓ select · Space toggle · Enter insert · r refresh · Esc close"
                    },
                    empty_label: if zh {
                        "无匹配的 Skill（可在 ~/.peer-agent/skills 或工作区 skills/ 安装）"
                    } else {
                        "No matching Skills"
                    },
                    rows: &rows,
                    selected: *selected,
                    query,
                    zh,
                },
                palette,
            );
        }
        ClassicOverlay::Mcp {
            items,
            query,
            selected,
        } => {
            let rows: Vec<ModalRow<'_>> = overlay
                .filtered_mcp_indices()
                .into_iter()
                .map(|i| {
                    let srv = &items[i];
                    let tools_desc = if srv.tool_names.is_empty() {
                        if zh {
                            "无工具".to_owned()
                        } else {
                            "no tools".to_owned()
                        }
                    } else {
                        srv.tool_names.join(", ")
                    };
                    ModalRow {
                        name: &srv.display_name,
                        detail: format!(
                            "{} · {}/{} tools · {}",
                            srv.health_status, srv.visible_tools, srv.total_tools, tools_desc
                        ),
                        enabled: srv.enabled,
                    }
                })
                .collect();
            render_capability_modal(
                frame,
                area,
                &ModalSpec {
                    title: if zh {
                        "MCP Servers 管理"
                    } else {
                        "MCP Servers"
                    },
                    hint: if zh {
                        "↑↓ 选择 · Space 启用/停用 · r 刷新 · Esc 关闭"
                    } else {
                        "↑↓ select · Space toggle · r refresh · Esc close"
                    },
                    empty_label: if zh {
                        "未配置或无匹配的 MCP Server"
                    } else {
                        "No matching MCP servers"
                    },
                    rows: &rows,
                    selected: *selected,
                    query,
                    zh,
                },
                palette,
            );
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::theme::DARK_PALETTE;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn all_classic_overlays_render_without_panic_on_wide_and_narrow_viewports() {
        let ctx = OverlayContext {
            current_mode: "chat",
            current_access: "ask",
            current_theme: ThemeMode::Dark,
            current_locale: TuiLocale::ZhCn,
            fast_available: true,
            goal_status: GoalMenuStatus::Running,
        };
        let overlays = [
            ClassicOverlay::Resume {
                rows: vec![ResumeSessionRow {
                    id: "s-1".into(),
                    title: "修复认证超时".into(),
                    message_count: 6,
                    updated_at: Some("2026-11-19T12:00:00Z".into()),
                    workspace_tag: Some("peer-dev".into()),
                    mode: "chat".into(),
                }],
                selected: 0,
            },
            ClassicOverlay::Mode { selected: 0 },
            ClassicOverlay::Permissions { selected: 1 },
            ClassicOverlay::Theme { selected: 0 },
            ClassicOverlay::Language { selected: 0 },
            ClassicOverlay::Goals {
                plans: vec![GoalPickerRow {
                    plan_id: "g-1".into(),
                    title: "补齐原生命令".into(),
                    status: "executing".into(),
                    completed: 2,
                    total: 4,
                }],
                current_plan_id: Some("g-1".into()),
                query: String::new(),
                selected: 0,
            },
            ClassicOverlay::Help { scroll: 0 },
            ClassicOverlay::Skills {
                items: vec![SkillPickerRow {
                    skill_id: "rust".into(),
                    name: "Rust Expert".into(),
                    description: "Verify crates cleanly".into(),
                    enabled: true,
                }],
                query: String::new(),
                selected: 0,
            },
            ClassicOverlay::Mcp {
                items: vec![McpPickerRow {
                    id: "mcp-1".into(),
                    display_name: "Chrome DevTools".into(),
                    enabled: true,
                    health_status: "ok".into(),
                    visible_tools: 3,
                    total_tools: 3,
                    tool_names: vec!["navigate".into(), "click".into()],
                }],
                query: String::new(),
                selected: 0,
            },
        ];

        for overlay in &overlays {
            for (w, h) in [(100, 30), (44, 14)] {
                let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
                term.draw(|f| {
                    let area = f.area();
                    render_classic_overlay(f, area, overlay, &ctx, &DARK_PALETTE);
                })
                .unwrap();
            }
        }
    }
}
