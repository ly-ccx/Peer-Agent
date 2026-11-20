//! Pure Frost overlays for Classic & Bot interactive shells.
//!
//! Renders docked pickers (`Resume`, `Mode`, `Permissions`, `Theme`, `Language`, `Goals`, `Help`)
//! and centered modal managers (`Skills`, `MCP`) matching `apps/tui/src/app.tsx` and
//! `apps/tui/src/goal-status-view.tsx` with zero filesystem or process I/O.

use crate::{
    commands::{clip_bot_line, format_bot_when},
    goal_panel::goal_status_color,
    slash_menu::{CLASSIC_SLASH_ITEMS, GoalMenuStatus, SlashFilterContext, classic_item_visible},
    theme::{
        CARET_IDLE, CARET_SELECTED, CHECK_CURRENT, OFFLINE_DOT, ONLINE_DOT, SEPARATOR, ThemeMode,
        TuiLocale, TuiPalette, fill_canvas,
    },
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, BorderType, Borders, Clear, Paragraph},
};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

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
        query: String,
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
            Self::Resume { rows, .. } => (rows.len().clamp(1, 8) as u16) + 6,
            Self::Mode { .. } => 10,
            Self::Permissions { .. } => 12,
            Self::Theme { .. } => 8,
            Self::Language { .. } => 7,
            Self::Goals { plans, .. } => (plans.len().clamp(1, 8) as u16) + 6,
            Self::Help { .. } => 17,
        };
        desired.min(max_h.max(3))
    }

    pub fn filtered_resume_indices(&self) -> Vec<usize> {
        let Self::Resume { rows, query, .. } = self else {
            return Vec::new();
        };
        let q = query.trim().to_ascii_lowercase();
        rows.iter()
            .enumerate()
            .filter(|(_, row)| {
                q.is_empty()
                    || row.title.to_ascii_lowercase().contains(&q)
                    || row.id.to_ascii_lowercase().contains(&q)
                    || row.mode.to_ascii_lowercase().contains(&q)
                    || row
                        .workspace_tag
                        .as_deref()
                        .is_some_and(|ws| ws.to_ascii_lowercase().contains(&q))
            })
            .map(|(i, _)| i)
            .collect()
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

/// Preserves leading indentation and internal spacing while normalizing tabs/newlines
/// and clipping by Unicode display width with a trailing ellipsis.
pub(crate) fn clip_preserve_indent(text: &str, max_cols: usize) -> String {
    let clean = crate::terminal_text(text).replace(['\r', '\n', '\t'], " ");
    let trimmed = clean.trim_end();
    if trimmed.width() <= max_cols {
        return trimmed.to_owned();
    }
    if max_cols == 0 {
        return String::new();
    }
    if max_cols == 1 {
        return "…".to_owned();
    }
    let target = max_cols - 1;
    let mut out = String::new();
    let mut used = 0;
    for ch in trimmed.chars() {
        let cw = ch.width().unwrap_or(0);
        if used + cw > target {
            break;
        }
        out.push(ch);
        used += cw;
    }
    out.push('…');
    out
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
    let inner_raw = block.inner(box_area);
    frame.render_widget(block, box_area);
    let inner = if inner_raw.width >= 4 {
        Rect {
            x: inner_raw.x + 1,
            y: inner_raw.y,
            width: inner_raw.width - 2,
            height: inner_raw.height,
        }
    } else {
        inner_raw
    };
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
        muted_line_with_bg(spec.hint, iw, palette, palette.panel),
    ];
    let list_cap = ih.saturating_sub(3) / 2;
    if spec.rows.is_empty() {
        lines.push(muted_indent_line(
            spec.empty_label,
            iw,
            palette,
            palette.panel,
        ));
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
            let caret_w = caret.width();
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
            let title_budget = iw.saturating_sub(caret_w);
            let clipped_title = clip_bot_line(&format!("{dot} {}", row.name), title_budget);
            let pad_w = iw.saturating_sub(caret_w + clipped_title.width());
            let mut title_style = Style::new().fg(row_fg).bg(row_bg);
            if is_sel {
                title_style = title_style.add_modifier(Modifier::BOLD);
            }
            lines.push(Line::from(vec![
                Span::styled(caret, Style::new().fg(row_fg).bg(row_bg)),
                Span::styled(clipped_title, title_style),
                Span::styled(" ".repeat(pad_w), Style::new().bg(row_bg)),
            ]));
            if lines.len() + 1 < ih {
                lines.push(Line::styled(
                    clip_preserve_indent(&format!("  {}", row.detail), iw),
                    Style::new().fg(palette.muted).bg(palette.panel),
                ));
            }
        }
    }
    while lines.len() + 1 < ih {
        lines.push(Line::styled("", Style::new().bg(palette.panel)));
    }
    lines.push(search_line(spec.zh, spec.query, iw, palette, palette.panel));
    frame.render_widget(Paragraph::new(lines), inner);
}

fn dock_header(width: usize, title: &str, palette: &TuiPalette) -> Vec<Line<'static>> {
    vec![
        Line::styled(
            SEPARATOR.repeat(width.max(1)),
            Style::new().fg(palette.border).bg(palette.background),
        ),
        Line::styled(
            clip_bot_line(title, width),
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD),
        ),
    ]
}

fn blank_dock_line(palette: &TuiPalette) -> Line<'static> {
    Line::styled("", Style::new().bg(palette.background))
}

fn search_line(
    zh: bool,
    query: &str,
    width: usize,
    palette: &TuiPalette,
    bg: Color,
) -> Line<'static> {
    let prefix = if zh { "过滤: " } else { "Search: " };
    let val = if query.is_empty() { "…" } else { query };
    let val_fg = if query.is_empty() {
        palette.muted
    } else {
        palette.text
    };
    let prefix_w = prefix.width();
    if width <= prefix_w + 1 {
        return muted_line_with_bg(&format!("{prefix}{val}"), width, palette, bg);
    }
    let clipped_val = clip_bot_line(val, width - prefix_w);
    Line::from(vec![
        Span::styled(prefix, Style::new().fg(palette.muted).bg(bg)),
        Span::styled(clipped_val, Style::new().fg(val_fg).bg(bg)),
    ])
}

fn option_line(
    selected: bool,
    current: bool,
    label: &str,
    width: usize,
    palette: &TuiPalette,
) -> Line<'static> {
    option_line_with_meta(selected, current, label, None, width, palette)
}

fn option_line_with_meta(
    selected: bool,
    current: bool,
    label: &str,
    right_meta: Option<(&str, Color)>,
    width: usize,
    palette: &TuiPalette,
) -> Line<'static> {
    let bg = palette.background;
    let caret = if selected { CARET_SELECTED } else { CARET_IDLE };
    let caret_w = caret.width();
    let check_w = if current { CHECK_CURRENT.width() } else { 0 };
    let fg = if selected {
        palette.accent
    } else {
        palette.text_soft
    };
    let label_style = if selected {
        Style::new().fg(fg).bg(bg).add_modifier(Modifier::BOLD)
    } else {
        Style::new().fg(fg).bg(bg)
    };
    let mut spans = Vec::with_capacity(5);
    spans.push(Span::styled(caret, label_style));

    if let Some((meta, meta_color)) = right_meta {
        let rw = meta.width();
        if rw > 0 && width >= caret_w + check_w + rw + 6 {
            let label_budget = width - caret_w - check_w - rw - 2;
            let clipped = clip_bot_line(label, label_budget);
            let used = caret_w + clipped.width() + check_w + rw;
            let gap = width.saturating_sub(used);
            spans.push(Span::styled(clipped, label_style));
            if current {
                spans.push(Span::styled(
                    CHECK_CURRENT,
                    Style::new().fg(palette.success).bg(bg),
                ));
            }
            spans.push(Span::styled(" ".repeat(gap), Style::new().bg(bg)));
            spans.push(Span::styled(
                meta.to_owned(),
                Style::new().fg(meta_color).bg(bg),
            ));
            return Line::from(spans);
        }
    }

    let avail = width.saturating_sub(caret_w + check_w);
    let clipped = clip_bot_line(label, avail);
    spans.push(Span::styled(clipped, label_style));
    if current {
        spans.push(Span::styled(
            CHECK_CURRENT,
            Style::new().fg(palette.success).bg(bg),
        ));
    }
    Line::from(spans)
}

fn muted_line(text: &str, width: usize, palette: &TuiPalette) -> Line<'static> {
    muted_line_with_bg(text, width, palette, palette.background)
}

fn muted_line_with_bg(text: &str, width: usize, palette: &TuiPalette, bg: Color) -> Line<'static> {
    Line::styled(
        clip_bot_line(text, width),
        Style::new().fg(palette.muted).bg(bg),
    )
}

fn muted_indent_line(text: &str, width: usize, palette: &TuiPalette, bg: Color) -> Line<'static> {
    Line::styled(
        clip_preserve_indent(text, width),
        Style::new().fg(palette.muted).bg(bg),
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

    out.push((false, String::new()));
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

    out.push((false, String::new()));
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
        ClassicOverlay::Resume {
            rows,
            query,
            selected,
        } => {
            fill_canvas(frame, area, palette.background);
            let filtered = overlay.filtered_resume_indices();
            let title = if query.trim().is_empty() {
                if zh {
                    format!("恢复会话 · {} 个历史对话", rows.len())
                } else {
                    format!("Resume session · {} saved", rows.len())
                }
            } else if zh {
                format!("恢复会话 · {}/{} 个历史对话", filtered.len(), rows.len())
            } else {
                format!("Resume session · {}/{} saved", filtered.len(), rows.len())
            };
            let mut lines = dock_header(w, &title, palette);
            lines.push(search_line(zh, query, w, palette, palette.background));
            if area.height >= 7 {
                lines.push(blank_dock_line(palette));
            }
            if rows.is_empty() {
                lines.push(muted_indent_line(
                    if zh {
                        "  暂无可恢复的历史会话。"
                    } else {
                        "  No saved conversations to resume."
                    },
                    w,
                    palette,
                    palette.background,
                ));
            } else if filtered.is_empty() {
                lines.push(muted_indent_line(
                    if zh {
                        "  没有匹配的历史会话，按 Esc 清空搜索或继续输入。"
                    } else {
                        "  No matching sessions (Esc clears search)."
                    },
                    w,
                    palette,
                    palette.background,
                ));
            } else {
                let overhead = 4 + usize::from(area.height >= 7) + usize::from(area.height >= 8);
                let max_vis = usize::from(area.height)
                    .saturating_sub(overhead)
                    .clamp(1, 8);
                let sel = (*selected).min(filtered.len() - 1);
                let start = sel
                    .saturating_sub(max_vis / 2)
                    .min(filtered.len().saturating_sub(max_vis));
                for (offset, idx) in filtered.iter().skip(start).take(max_vis).enumerate() {
                    let row = &rows[*idx];
                    let is_sel = start + offset == sel;
                    let mut meta_parts = Vec::with_capacity(3);
                    meta_parts.push(if zh {
                        format!("{} 条", row.message_count)
                    } else {
                        format!("{} msgs", row.message_count)
                    });
                    if let Some(ws) = row.workspace_tag.as_deref()
                        && !ws.is_empty()
                    {
                        meta_parts.push(ws.to_owned());
                    }
                    if let Some(when) = row.updated_at.as_deref() {
                        let formatted = format_bot_when(when);
                        if !formatted.is_empty() {
                            meta_parts.push(formatted);
                        }
                    }
                    let meta = meta_parts.join(" · ");
                    lines.push(option_line_with_meta(
                        is_sel,
                        false,
                        &row.title,
                        Some((&meta, palette.muted)),
                        w,
                        palette,
                    ));
                }
            }
            if area.height >= 8 {
                lines.push(blank_dock_line(palette));
            }
            lines.push(muted_line(
                if zh {
                    "输入过滤 · ↑↓ 选择 · Enter 恢复会话 · Esc 关闭"
                } else {
                    "type search · ↑↓ choose · Enter resume · Esc close"
                },
                w,
                palette,
            ));
            frame.render_widget(Paragraph::new(lines), area);
        }
        ClassicOverlay::Mode { selected } => {
            fill_canvas(frame, area, palette.background);
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
                    (
                        "chat",
                        "[1] Agent",
                        "默认智能体模式（自动规划并调用工具）",
                        "[1] Agent — 默认智能体模式（自动规划并调用工具）",
                    ),
                    (
                        "plan",
                        "[2] Plan",
                        "只读规划模式（先协定计划，审批后执行）",
                        "[2] Plan  — 只读规划模式（先协定计划，审批后执行）",
                    ),
                ]
            } else {
                [
                    (
                        "chat",
                        "[1] Agent",
                        "Adaptive planning and execution",
                        "[1] Agent — Adaptive planning and execution",
                    ),
                    (
                        "plan",
                        "[2] Plan",
                        "Read-only planning before approval",
                        "[2] Plan  — Read-only planning before approval",
                    ),
                ]
            };
            let two_line = area.height >= 10;
            if two_line {
                lines.push(blank_dock_line(palette));
            }
            let sel = (*selected).min(options.len() - 1);
            for (idx, (wire, label, desc, one_line)) in options.iter().enumerate() {
                if two_line {
                    lines.push(option_line(
                        idx == sel,
                        ctx.current_mode == *wire,
                        label,
                        w,
                        palette,
                    ));
                    lines.push(muted_indent_line(
                        &format!("    {desc}"),
                        w,
                        palette,
                        palette.background,
                    ));
                } else {
                    lines.push(option_line(
                        idx == sel,
                        ctx.current_mode == *wire,
                        one_line,
                        w,
                        palette,
                    ));
                }
            }
            if two_line {
                lines.push(blank_dock_line(palette));
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
            fill_canvas(frame, area, palette.background);
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
                    (
                        "ask",
                        "[1] Ask",
                        "执行本地操作前逐次确认",
                        "[1] Ask          — 执行本地操作前逐次确认",
                    ),
                    (
                        "session",
                        "[2] Approve",
                        "自动放行低中风险，高风险仍询问",
                        "[2] Approve      — 自动放行低中风险，高风险仍询问",
                    ),
                    (
                        "full",
                        "[3] Full access",
                        "自动放行全部本地工具调用",
                        "[3] Full access  — 自动放行全部本地工具调用",
                    ),
                ]
            } else {
                [
                    (
                        "ask",
                        "[1] Ask",
                        "Ask before local actions",
                        "[1] Ask          — Ask before local actions",
                    ),
                    (
                        "session",
                        "[2] Approve",
                        "Auto-approve low/medium-risk calls",
                        "[2] Approve      — Auto-approve low/medium-risk calls",
                    ),
                    (
                        "full",
                        "[3] Full access",
                        "Auto-approve all local tool calls",
                        "[3] Full access  — Auto-approve all local tool calls",
                    ),
                ]
            };
            let two_line = area.height >= 11;
            let breathe = two_line && area.height >= 12;
            if breathe {
                lines.push(blank_dock_line(palette));
            }
            let sel = (*selected).min(options.len() - 1);
            for (idx, (wire, label, desc, one_line)) in options.iter().enumerate() {
                if two_line {
                    lines.push(option_line(
                        idx == sel,
                        ctx.current_access == *wire,
                        label,
                        w,
                        palette,
                    ));
                    lines.push(muted_indent_line(
                        &format!("    {desc}"),
                        w,
                        palette,
                        palette.background,
                    ));
                } else {
                    lines.push(option_line(
                        idx == sel,
                        ctx.current_access == *wire,
                        one_line,
                        w,
                        palette,
                    ));
                }
            }
            if breathe {
                lines.push(blank_dock_line(palette));
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
            fill_canvas(frame, area, palette.background);
            let mut lines = dock_header(
                w,
                if zh {
                    "主题 · Peer Frost"
                } else {
                    "Theme · Peer Frost"
                },
                palette,
            );
            if area.height >= 8 {
                lines.push(blank_dock_line(palette));
            }
            let options = if zh {
                [
                    (ThemeMode::Dark, "[1] 深色 (Dark)"),
                    (ThemeMode::Light, "[2] 浅色 (Light)"),
                    (ThemeMode::System, "[3] 跟随系统 (System)"),
                ]
            } else {
                [
                    (ThemeMode::Dark, "[1] Dark"),
                    (ThemeMode::Light, "[2] Light"),
                    (ThemeMode::System, "[3] System"),
                ]
            };
            let sel = (*selected).min(options.len() - 1);
            for (idx, (mode, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_theme == *mode,
                    label,
                    w,
                    palette,
                ));
            }
            if area.height >= 8 {
                lines.push(blank_dock_line(palette));
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
            fill_canvas(frame, area, palette.background);
            let mut lines = dock_header(
                w,
                if zh {
                    "界面与回复语言"
                } else {
                    "Language"
                },
                palette,
            );
            if area.height >= 7 {
                lines.push(blank_dock_line(palette));
            }
            let options = [
                (TuiLocale::ZhCn, "[1] 简体中文 (zh-CN)"),
                (TuiLocale::EnUs, "[2] English (en-US)"),
            ];
            let sel = (*selected).min(options.len() - 1);
            for (idx, (loc, label)) in options.iter().enumerate() {
                lines.push(option_line(
                    idx == sel,
                    ctx.current_locale == *loc,
                    label,
                    w,
                    palette,
                ));
            }
            if area.height >= 7 {
                lines.push(blank_dock_line(palette));
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
            fill_canvas(frame, area, palette.background);
            let title = if zh {
                format!("目标历史 · {} 个正式目标", plans.len())
            } else {
                format!("Goal history · {} formal goals", plans.len())
            };
            let mut lines = dock_header(w, &title, palette);
            lines.push(search_line(zh, query, w, palette, palette.background));
            if area.height >= 7 {
                lines.push(blank_dock_line(palette));
            }
            let filtered = overlay.filtered_goal_indices();
            if filtered.is_empty() {
                lines.push(muted_indent_line(
                    if zh {
                        "  当前会话无匹配目标。"
                    } else {
                        "  No matching formal goals."
                    },
                    w,
                    palette,
                    palette.background,
                ));
            } else {
                let overhead = 4 + usize::from(area.height >= 7) + usize::from(area.height >= 8);
                let max_vis = usize::from(area.height)
                    .saturating_sub(overhead)
                    .clamp(1, 8);
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
                    let suffix_color = goal_status_color(&plan.status, palette);
                    lines.push(option_line_with_meta(
                        is_sel,
                        is_cur,
                        &label,
                        Some((&suffix, suffix_color)),
                        w,
                        palette,
                    ));
                }
            }
            if area.height >= 8 {
                lines.push(blank_dock_line(palette));
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
            fill_canvas(frame, area, palette.background);
            let head_h = if area.height >= 8 { 3 } else { 2 };
            let rows = Layout::vertical([
                Constraint::Length(head_h),
                Constraint::Min(1),
                Constraint::Length(1),
            ])
            .split(area);
            let mut head_lines = dock_header(
                w,
                if zh {
                    "帮助 · 快捷键、斜杠命令与模式说明"
                } else {
                    "Help · Shortcuts, commands, and modes"
                },
                palette,
            );
            if head_h == 3 {
                head_lines.push(blank_dock_line(palette));
            }
            frame.render_widget(Paragraph::new(head_lines), rows[0]);
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
                            clip_preserve_indent(text, w),
                            Style::new()
                                .fg(palette.accent)
                                .bg(palette.background)
                                .add_modifier(Modifier::BOLD),
                        )
                    } else {
                        Line::styled(
                            clip_preserve_indent(text, w),
                            Style::new().fg(palette.text_soft).bg(palette.background),
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
                query: String::new(),
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
            for (w, h) in [(100, 30), (44, 14), (44, 8)] {
                let mut term = Terminal::new(TestBackend::new(w, h)).unwrap();
                term.draw(|f| {
                    let area = f.area();
                    render_classic_overlay(f, area, overlay, &ctx, &DARK_PALETTE);
                })
                .unwrap();
            }
        }
    }

    #[test]
    fn overlays_polish_canvas_surface_caret_alignment_help_columns_and_resume_query() {
        let ctx = OverlayContext {
            current_mode: "chat",
            current_access: "ask",
            current_theme: ThemeMode::Dark,
            current_locale: TuiLocale::ZhCn,
            fast_available: true,
            goal_status: GoalMenuStatus::Running,
        };

        // 1. Mode dock uses terminal canvas background, aligns selected/idle carets at col 2,
        // and shows 2-line indented descriptions when height permits.
        let mut mode_term = Terminal::new(TestBackend::new(72, 10)).unwrap();
        mode_term
            .draw(|f| {
                render_classic_overlay(
                    f,
                    f.area(),
                    &ClassicOverlay::Mode { selected: 0 },
                    &ctx,
                    &DARK_PALETTE,
                );
            })
            .unwrap();
        let buf = mode_term.backend().buffer();
        assert_eq!(buf[(0, 1)].bg, DARK_PALETTE.background);
        let buf_row_text = |b: &ratatui::buffer::Buffer, y: u16| -> String {
            let mut out = String::new();
            let mut skip_next = false;
            for x in 0..b.area.width {
                if skip_next {
                    skip_next = false;
                    continue;
                }
                let sym = b[(x, y)].symbol();
                out.push_str(sym);
                if sym.width() > 1 {
                    skip_next = true;
                }
            }
            out
        };
        let agent_y = (0..10)
            .find(|&y| buf_row_text(buf, y).contains("[1] Agent"))
            .unwrap();
        let plan_y = (0..10)
            .find(|&y| buf_row_text(buf, y).contains("[2] Plan"))
            .unwrap();
        let agent_line = buf_row_text(buf, agent_y);
        let plan_line = buf_row_text(buf, plan_y);
        assert!(agent_line.starts_with("› [1] Agent"));
        assert!(plan_line.starts_with("  [2] Plan"));
        assert!(buf_row_text(buf, agent_y + 1).starts_with("    默认智能体模式"));

        // 2. Help preserves multi-space column padding and inserts blank section dividers.
        let help = build_help_lines(TuiLocale::EnUs, true, GoalMenuStatus::Running);
        assert!(help.iter().any(|(hdr, txt)| !hdr && txt.is_empty()));
        let mut help_term = Terminal::new(TestBackend::new(76, 17)).unwrap();
        help_term
            .draw(|f| {
                render_classic_overlay(
                    f,
                    f.area(),
                    &ClassicOverlay::Help { scroll: 0 },
                    &ctx,
                    &DARK_PALETTE,
                );
            })
            .unwrap();
        let hbuf = help_term.backend().buffer();
        let enter_row = (0..17)
            .map(|y| buf_row_text(hbuf, y))
            .find(|line| line.contains("Enter"))
            .unwrap();
        assert!(enter_row.starts_with("  Enter          "));

        // 3. Resume filters across title/workspace/mode/id and right-aligns muted metadata.
        let resume = ClassicOverlay::Resume {
            rows: vec![
                ResumeSessionRow {
                    id: "s-1".into(),
                    title: "修复认证超时".into(),
                    message_count: 6,
                    updated_at: Some("2026-11-19T12:00:00Z".into()),
                    workspace_tag: Some("peer-dev".into()),
                    mode: "chat".into(),
                },
                ResumeSessionRow {
                    id: "s-2".into(),
                    title: "优化缓存池".into(),
                    message_count: 2,
                    updated_at: Some("2026-11-18T09:15:00Z".into()),
                    workspace_tag: Some("api".into()),
                    mode: "plan".into(),
                },
            ],
            query: "认证".into(),
            selected: 0,
        };
        assert_eq!(resume.filtered_resume_indices(), vec![0]);
        let mut res_term = Terminal::new(TestBackend::new(72, 8)).unwrap();
        res_term
            .draw(|f| render_classic_overlay(f, f.area(), &resume, &ctx, &DARK_PALETTE))
            .unwrap();
        let rbuf = res_term.backend().buffer();
        assert_eq!(rbuf[(0, 1)].bg, DARK_PALETTE.background);
        let meta_y = (0..8)
            .find(|&y| {
                (0..rbuf.area.width)
                    .map(|x| rbuf[(x, y)].symbol())
                    .collect::<String>()
                    .contains("11-19 12:00")
            })
            .unwrap();
        assert_eq!(rbuf[(71, meta_y)].fg, DARK_PALETTE.muted);

        // 4. Skills modal retains palette.panel card surface and full-width selection bar.
        let skills = ClassicOverlay::Skills {
            items: vec![SkillPickerRow {
                skill_id: "rust".into(),
                name: "Rust Expert".into(),
                description: "Verify crates cleanly".into(),
                enabled: true,
            }],
            query: String::new(),
            selected: 0,
        };
        let mut sk_term = Terminal::new(TestBackend::new(80, 16)).unwrap();
        sk_term
            .draw(|f| render_classic_overlay(f, f.area(), &skills, &ctx, &DARK_PALETTE))
            .unwrap();
        let sbuf = sk_term.backend().buffer();
        let sel_y = (0..16)
            .find(|&y| {
                (0..sbuf.area.width)
                    .map(|x| sbuf[(x, y)].symbol())
                    .collect::<String>()
                    .contains("Rust Expert")
            })
            .unwrap();
        // Box width is 76 centered on 80 => x in 2..78; border=2,77; 1-col inset => inner x in 4..76.
        assert_eq!(sbuf[(3, sel_y)].bg, DARK_PALETTE.panel);
        assert_eq!(sbuf[(4, sel_y)].bg, DARK_PALETTE.selection);
        assert_eq!(sbuf[(75, sel_y)].bg, DARK_PALETTE.selection);
    }
}
