//! Standard native Model Picker view & pure state reducer (model-picker.md spec).
//!
//! - Uses configured provider group IDs and stable model record IDs (never merges same-name models).
//! - Browsing via arrow keys never writes configuration; only explicit Enter submits.
//! - Busy state prevents re-entry while keeping the list readable.
//! - Escape closes the picker without sending messages or clearing composer drafts.

use crate::{
    commands::clip_bot_line,
    theme::{CARET_IDLE, CARET_SELECTED, CHECK_CURRENT, SEPARATOR, TuiLocale, TuiPalette},
};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPickerOption {
    pub record_id: String,
    pub provider_id: String,
    pub model_id: String,
    pub display_name: String,
    pub available: bool,
    pub supports_reasoning: bool,
    pub efforts: Vec<String>,
    pub badges: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModelPickerGroup {
    pub group_id: String,
    pub label: String,
    pub models: Vec<ModelPickerOption>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ModelPickerEvent {
    None,
    Close,
    Select {
        provider_id: String,
        model_id: String,
        effort: Option<String>,
    },
}

#[derive(Debug, Clone, Default)]
pub struct ModelPickerState {
    pub open: bool,
    pub groups: Vec<ModelPickerGroup>,
    pub active_group: usize,
    pub active_model: usize,
    pub active_effort: usize,
    pub selected_provider: Option<String>,
    pub selected_model: Option<String>,
    pub selected_effort: Option<String>,
    pub query: String,
    pub busy: bool,
    pub error: Option<String>,
}

impl ModelPickerState {
    pub fn open_with(
        &mut self,
        groups: Vec<ModelPickerGroup>,
        selected_provider: Option<String>,
        selected_model: Option<String>,
        selected_effort: Option<String>,
    ) {
        self.groups = groups;
        self.selected_provider = selected_provider;
        self.selected_model = selected_model;
        self.selected_effort = selected_effort;
        self.active_group = 0;
        self.active_model = 0;
        self.active_effort = 0;
        self.query.clear();
        self.error = None;
        for (gi, g) in self.groups.iter().enumerate() {
            if let Some(mi) = g.models.iter().position(|m| {
                self.selected_provider.as_deref() == Some(m.provider_id.as_str())
                    && self.selected_model.as_deref() == Some(m.model_id.as_str())
            }) {
                self.active_group = gi;
                self.active_model = mi;
                if let Some(ref eff) = self.selected_effort
                    && let Some(ei) = g.models[mi].efforts.iter().position(|e| e == eff)
                {
                    self.active_effort = ei;
                }
                break;
            }
        }
        self.open = true;
    }

    pub fn close(&mut self) {
        self.open = false;
        self.query.clear();
        self.error = None;
    }

    pub fn filtered_entries(&self) -> Vec<(usize, usize)> {
        let q = self.query.trim().to_ascii_lowercase();
        if q.is_empty() {
            return self
                .groups
                .get(self.active_group)
                .map(|g| {
                    (0..g.models.len())
                        .map(|mi| (self.active_group, mi))
                        .collect()
                })
                .unwrap_or_default();
        }
        let mut out = Vec::new();
        for (gi, group) in self.groups.iter().enumerate() {
            let group_matches = group.label.to_ascii_lowercase().contains(&q);
            for (mi, model) in group.models.iter().enumerate() {
                if group_matches
                    || model.display_name.to_ascii_lowercase().contains(&q)
                    || model.model_id.to_ascii_lowercase().contains(&q)
                    || model.provider_id.to_ascii_lowercase().contains(&q)
                {
                    out.push((gi, mi));
                }
            }
        }
        out
    }

    pub fn dock_height(&self, max_h: u16) -> u16 {
        if !self.open {
            return 0;
        }
        let rows = self.filtered_entries().len().clamp(1, 6) as u16;
        let tabs = u16::from(!self.groups.is_empty());
        // divider + title + search + tabs + top/bottom breath + footer
        let chrome = 5 + tabs + 1;
        (rows + chrome).min(max_h).max(4.min(max_h))
    }

    fn current_pair(&self) -> Option<(usize, usize)> {
        let entries = self.filtered_entries();
        entries.get(self.active_model).copied()
    }

    pub fn current_model(&self) -> Option<&ModelPickerOption> {
        let (gi, mi) = self.current_pair()?;
        self.groups.get(gi)?.models.get(mi)
    }

    pub fn current_display_label(&self) -> Option<String> {
        let (gi, mi) = self.current_pair()?;
        let group = self.groups.get(gi)?;
        let model = group.models.get(mi)?;
        if group.label != "Models" && !group.label.is_empty() && !model.display_name.contains(" · ")
        {
            Some(format!("{} · {}", model.display_name, group.label))
        } else {
            Some(model.display_name.clone())
        }
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> ModelPickerEvent {
        if !self.open || key.kind == KeyEventKind::Release {
            return ModelPickerEvent::None;
        }
        let has_query = !self.query.trim().is_empty();
        match key.code {
            KeyCode::Esc => {
                if !self.query.is_empty() {
                    self.query.clear();
                    self.active_model = 0;
                    self.active_effort = 0;
                    self.error = None;
                    ModelPickerEvent::None
                } else {
                    self.close();
                    ModelPickerEvent::Close
                }
            }
            KeyCode::Left => {
                if !has_query && !self.groups.is_empty() {
                    self.active_group = self.active_group.saturating_sub(1);
                    self.active_model = 0;
                    self.active_effort = 0;
                }
                ModelPickerEvent::None
            }
            KeyCode::Right => {
                if !has_query && self.active_group + 1 < self.groups.len() {
                    self.active_group += 1;
                    self.active_model = 0;
                    self.active_effort = 0;
                }
                ModelPickerEvent::None
            }
            KeyCode::Up => {
                self.active_model = self.active_model.saturating_sub(1);
                self.active_effort = 0;
                ModelPickerEvent::None
            }
            KeyCode::Down => {
                let len = self.filtered_entries().len();
                if self.active_model + 1 < len {
                    self.active_model += 1;
                    self.active_effort = 0;
                }
                ModelPickerEvent::None
            }
            KeyCode::Home => {
                self.active_model = 0;
                self.active_effort = 0;
                ModelPickerEvent::None
            }
            KeyCode::End => {
                let len = self.filtered_entries().len();
                if len > 0 {
                    self.active_model = len - 1;
                    self.active_effort = 0;
                }
                ModelPickerEvent::None
            }
            KeyCode::Tab => {
                if let Some(m) = self.current_model()
                    && !m.efforts.is_empty()
                {
                    self.active_effort = (self.active_effort + 1) % m.efforts.len();
                }
                ModelPickerEvent::None
            }
            KeyCode::Backspace => {
                if !self.query.is_empty() {
                    self.query.pop();
                    self.active_model = 0;
                    self.active_effort = 0;
                    self.error = None;
                }
                ModelPickerEvent::None
            }
            KeyCode::Char(ch)
                if !key.modifiers.intersects(
                    KeyModifiers::CONTROL | KeyModifiers::ALT | KeyModifiers::SUPER,
                ) && !ch.is_control() =>
            {
                self.query.push(ch);
                self.active_model = 0;
                self.active_effort = 0;
                self.error = None;
                ModelPickerEvent::None
            }
            KeyCode::Enter => {
                if self.busy {
                    return ModelPickerEvent::None;
                }
                let Some(m) = self.current_model().cloned() else {
                    return ModelPickerEvent::None;
                };
                if !m.available {
                    self.error = Some("当前模型不可用，未修改配置。".to_owned());
                    return ModelPickerEvent::None;
                }
                let effort = m.efforts.get(self.active_effort).cloned();
                ModelPickerEvent::Select {
                    provider_id: m.provider_id,
                    model_id: m.model_id,
                    effort,
                }
            }
            _ => ModelPickerEvent::None,
        }
    }
}

fn tab_row_width(labels: &[String], start: usize, end: usize, total: usize) -> usize {
    let left = if start > 0 { 2 } else { 0 };
    let right = if end < total { 2 } else { 0 };
    let tabs: usize = labels[start..end].iter().map(|s| s.width()).sum();
    let seps = end.saturating_sub(start).saturating_sub(1) * 2;
    left + tabs + seps + right
}

fn visible_tab_range(labels: &[String], active: usize, max_w: usize) -> (usize, usize) {
    if labels.is_empty() {
        return (0, 0);
    }
    let total = labels.len();
    let active = active.min(total - 1);
    let mut start = 0;
    let mut end = active + 1;
    while start < active && tab_row_width(labels, start, end, total) > max_w {
        start += 1;
    }
    while end < total && tab_row_width(labels, start, end + 1, total) <= max_w {
        end += 1;
    }
    (start, end)
}

pub fn render_model_picker(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &ModelPickerState,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if !state.open || area.width < 12 || area.height < 6 {
        return;
    }
    let w = area.width.clamp(12, 74);
    let h = area.height.clamp(6, 18);
    let popup = Rect {
        x: area.x + area.width.saturating_sub(w) / 2,
        y: area.y + area.height.saturating_sub(h) / 2,
        width: w,
        height: h,
    };
    frame.render_widget(Clear, popup);
    // Peer Frost terminal layer (open-top panel, quiet hairline, no heavy box shadow)
    frame.render_widget(
        Block::default().style(Style::new().bg(palette.panel)),
        popup,
    );
    render_model_picker_body(frame, popup, state, locale, palette, palette.panel, false);
}

/// Docked open-top terminal layer anchored above the composer divider (`app.tsx`).
pub fn render_model_picker_dock(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &ModelPickerState,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if !state.open || area.width < 12 || area.height < 4 {
        return;
    }
    frame.render_widget(
        Block::default().style(Style::new().bg(palette.background)),
        area,
    );
    render_model_picker_body(
        frame,
        area,
        state,
        locale,
        palette,
        palette.background,
        true,
    );
}

fn render_model_picker_body(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &ModelPickerState,
    locale: TuiLocale,
    palette: &TuiPalette,
    bg: ratatui::style::Color,
    docked: bool,
) {
    let pw = usize::from(area.width).max(1);
    let zh = locale.is_zh();
    let has_query = !state.query.trim().is_empty();
    let entries = state.filtered_entries();
    let top_breath = area.height >= if docked { 8 } else { 9 };
    let bottom_breath = area.height >= if docked { 9 } else { 10 };

    let mut constraints = Vec::new();
    if docked {
        constraints.push(Constraint::Length(1)); // Full top hairline divider
    }
    constraints.push(Constraint::Length(1)); // Title
    constraints.push(Constraint::Length(1)); // Search bar
    if !state.groups.is_empty() {
        constraints.push(Constraint::Length(1)); // Provider tabs / match count
    }
    if top_breath {
        constraints.push(Constraint::Length(1));
    }
    constraints.push(Constraint::Min(1)); // Model rows
    if bottom_breath {
        constraints.push(Constraint::Length(1));
    }
    if !docked {
        constraints.push(Constraint::Length(1)); // Separator
    }
    constraints.push(Constraint::Length(1)); // Footer hint

    let outer = Layout::vertical(constraints).split(area);
    let mut slot = 0usize;

    let title_text = if zh { "模型选择" } else { "Model" };
    if docked {
        frame.render_widget(
            Paragraph::new(Line::styled(
                SEPARATOR.repeat(pw),
                Style::new().fg(palette.border).bg(bg),
            )),
            outer[slot],
        );
        slot += 1;
        frame.render_widget(
            Paragraph::new(Line::styled(
                title_text,
                Style::new()
                    .fg(palette.accent)
                    .bg(bg)
                    .add_modifier(Modifier::BOLD),
            )),
            outer[slot],
        );
        slot += 1;
    } else {
        let padded_title = format!(" {title_text} ");
        let sep_w = pw.saturating_sub(padded_title.width());
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(
                    padded_title,
                    Style::new()
                        .fg(palette.accent)
                        .bg(bg)
                        .add_modifier(Modifier::BOLD),
                ),
                Span::styled(
                    SEPARATOR.repeat(sep_w),
                    Style::new().fg(palette.border).bg(bg),
                ),
            ])),
            outer[slot],
        );
        slot += 1;
    }

    // Search row
    let search_prefix = if zh { "搜索: " } else { "Search: " };
    let search_val = if state.query.is_empty() {
        "…"
    } else {
        state.query.as_str()
    };
    let search_fg = if state.query.is_empty() {
        palette.muted
    } else {
        palette.text
    };
    let search_avail = pw.saturating_sub(search_prefix.width());
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(search_prefix, Style::new().fg(palette.muted).bg(bg)),
            Span::styled(
                clip_bot_line(search_val, search_avail.max(1)),
                Style::new().fg(search_fg).bg(bg),
            ),
        ]))
        .style(Style::new().bg(bg)),
        outer[slot],
    );
    slot += 1;

    // Provider tabs row (windowed horizontally, active-only [Group] bracketing)
    if state.groups.is_empty() && !docked {
        // Rendered inside empty list fallback when docked; modal shows single empty hint row below
    } else if !state.groups.is_empty() {
        if has_query {
            let summary = if zh {
                format!("跨供应商匹配 · {} 个", entries.len())
            } else {
                format!("{} matches across providers", entries.len())
            };
            frame.render_widget(
                Paragraph::new(Line::styled(
                    clip_bot_line(&summary, pw),
                    Style::new().fg(palette.muted).bg(bg),
                ))
                .style(Style::new().bg(bg)),
                outer[slot],
            );
        } else {
            let mut tab_spans = Vec::new();
            let cap = pw.saturating_sub(8).clamp(1, 20);
            let clipped: Vec<String> = state
                .groups
                .iter()
                .enumerate()
                .map(|(i, g)| {
                    let raw = clip_bot_line(&g.label, cap);
                    if i == state.active_group {
                        format!("[{raw}]")
                    } else {
                        raw
                    }
                })
                .collect();
            let (start, end) = visible_tab_range(&clipped, state.active_group, pw);
            let muted = Style::new().fg(palette.muted).bg(bg);
            if start > 0 {
                tab_spans.push(Span::styled("‹ ", muted));
            }
            for (i, label) in clipped.iter().enumerate().take(end).skip(start) {
                if i > start {
                    tab_spans.push(Span::styled("  ", Style::new().bg(bg)));
                }
                let style = if i == state.active_group {
                    Style::new()
                        .fg(palette.accent)
                        .bg(bg)
                        .add_modifier(Modifier::BOLD)
                } else {
                    muted
                };
                let shown = if start + 1 == end {
                    let reserve = usize::from(start > 0) * 2 + usize::from(end < clipped.len()) * 2;
                    clip_bot_line(label, pw.saturating_sub(reserve).max(1))
                } else {
                    label.clone()
                };
                tab_spans.push(Span::styled(shown, style));
            }
            if end < clipped.len() {
                tab_spans.push(Span::styled(" ›", muted));
            }
            frame.render_widget(
                Paragraph::new(Line::from(tab_spans)).style(Style::new().bg(bg)),
                outer[slot],
            );
        }
        slot += 1;
    }

    if top_breath {
        frame.render_widget(Block::default().style(Style::new().bg(bg)), outer[slot]);
        slot += 1;
    }

    // Model list (caret alignment preserved via separate Span)
    let list_h = usize::from(outer[slot].height);
    let list_w = usize::from(outer[slot].width);
    let mut rows = Vec::new();
    if state.groups.is_empty() {
        let msg = if zh {
            "无已配置模型"
        } else {
            "No configured models"
        };
        rows.push(Line::from(vec![
            Span::styled(CARET_IDLE, Style::new().bg(bg)),
            Span::styled(
                clip_bot_line(msg, list_w.saturating_sub(CARET_IDLE.width())),
                Style::new().fg(palette.muted).bg(bg),
            ),
        ]));
    } else if entries.is_empty() {
        let msg = if zh {
            "未找到匹配模型"
        } else {
            "No matching models"
        };
        rows.push(Line::from(vec![
            Span::styled(CARET_IDLE, Style::new().bg(bg)),
            Span::styled(
                clip_bot_line(msg, list_w.saturating_sub(CARET_IDLE.width())),
                Style::new().fg(palette.muted).bg(bg),
            ),
        ]));
    } else {
        let top = state.active_model.saturating_sub(list_h.saturating_sub(1));
        for (idx, (gi, mi)) in entries.iter().enumerate().skip(top).take(list_h) {
            let focused = idx == state.active_model;
            let group = &state.groups[*gi];
            let m = &group.models[*mi];
            let selected = state.selected_provider.as_deref() == Some(m.provider_id.as_str())
                && state.selected_model.as_deref() == Some(m.model_id.as_str());
            let caret = if focused { CARET_SELECTED } else { CARET_IDLE };
            let mark = if selected { CHECK_CURRENT } else { "" };

            let mut suffix_parts = Vec::new();
            if has_query && group.label != "Models" && !group.label.is_empty() {
                suffix_parts.push(group.label.clone());
            }
            if !m.available {
                suffix_parts.push(if zh { "[不可用]" } else { "[unavailable]" }.to_owned());
            } else if focused && !m.efforts.is_empty() {
                let eff = m
                    .efforts
                    .get(state.active_effort)
                    .map(String::as_str)
                    .unwrap_or("default");
                suffix_parts.push(if zh {
                    format!("思考:{eff}")
                } else {
                    format!("effort:{eff}")
                });
            } else if !m.badges.is_empty() {
                suffix_parts.push(m.badges.join("/"));
            }
            let suffix = if suffix_parts.is_empty() {
                String::new()
            } else {
                format!(" · {}", suffix_parts.join(" · "))
            };

            let name_budget = list_w
                .saturating_sub(caret.width() + mark.width() + suffix.width().min(list_w / 2));
            let main_name = clip_bot_line(&m.display_name, name_budget);
            let main_style = if !m.available {
                Style::new().fg(palette.muted).bg(bg)
            } else if focused {
                Style::new()
                    .fg(palette.accent)
                    .bg(bg)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text).bg(bg)
            };
            let mut spans = vec![
                Span::styled(caret, main_style),
                Span::styled(main_name, main_style),
            ];
            if selected {
                spans.push(Span::styled(mark, Style::new().fg(palette.success).bg(bg)));
            }
            if !suffix.is_empty() {
                spans.push(Span::styled(
                    clip_bot_line(&suffix, list_w / 2),
                    Style::new().fg(palette.muted).bg(bg),
                ));
            }
            rows.push(Line::from(spans));
        }
    }
    frame.render_widget(Paragraph::new(rows).style(Style::new().bg(bg)), outer[slot]);
    slot += 1;

    if bottom_breath {
        frame.render_widget(Block::default().style(Style::new().bg(bg)), outer[slot]);
        slot += 1;
    }

    if !docked {
        frame.render_widget(
            Paragraph::new(Line::styled(
                SEPARATOR.repeat(pw),
                Style::new().fg(palette.border).bg(bg),
            )),
            outer[slot],
        );
        slot += 1;
    }

    // Footer status (busy / error / controls)
    let footer = if let Some(ref err) = state.error {
        clip_bot_line(err, pw)
    } else if state.busy {
        clip_bot_line(
            if zh {
                "正在保存模型配置…"
            } else {
                "Saving model selection…"
            },
            pw,
        )
    } else {
        clip_bot_line(
            if zh {
                "输入搜索 · ←/→ 供应商 · ↑/↓ 模型 · Tab 思考强度 · Enter 确认 · Esc 关闭"
            } else {
                "type search · ←/→ provider · ↑/↓ model · Tab effort · Enter select · Esc close"
            },
            pw,
        )
    };
    let footer_style = if state.error.is_some() {
        Style::new().fg(palette.danger_soft).bg(bg)
    } else {
        Style::new().fg(palette.muted).bg(bg)
    };
    frame.render_widget(
        Paragraph::new(Line::styled(footer, footer_style)),
        outer[slot],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyModifiers;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn model_picker_navigates_groups_and_refuses_unavailable_selection() {
        let mut picker = ModelPickerState::default();
        picker.open_with(
            vec![ModelPickerGroup {
                group_id: "g1".into(),
                label: "OpenAI".into(),
                models: vec![
                    ModelPickerOption {
                        record_id: "r1".into(),
                        provider_id: "openai".into(),
                        model_id: "gpt-4o".into(),
                        display_name: "GPT-4o".into(),
                        available: true,
                        supports_reasoning: true,
                        efforts: vec!["default".into(), "high".into()],
                        badges: vec!["vision".into()],
                    },
                    ModelPickerOption {
                        record_id: "r2".into(),
                        provider_id: "openai".into(),
                        model_id: "locked".into(),
                        display_name: "Locked Model".into(),
                        available: false,
                        supports_reasoning: false,
                        efforts: vec![],
                        badges: vec![],
                    },
                ],
            }],
            Some("openai".into()),
            Some("gpt-4o".into()),
            Some("default".into()),
        );
        // Move down to unavailable model -> Enter rejected with error
        assert_eq!(
            picker.handle_key(key(KeyCode::Down)),
            ModelPickerEvent::None
        );
        assert_eq!(
            picker.handle_key(key(KeyCode::Enter)),
            ModelPickerEvent::None
        );
        assert!(picker.error.is_some());

        // Move up, Tab effort to "high", Enter commits
        assert_eq!(picker.handle_key(key(KeyCode::Up)), ModelPickerEvent::None);
        assert_eq!(picker.handle_key(key(KeyCode::Tab)), ModelPickerEvent::None);
        assert_eq!(
            picker.handle_key(key(KeyCode::Enter)),
            ModelPickerEvent::Select {
                provider_id: "openai".into(),
                model_id: "gpt-4o".into(),
                effort: Some("high".into()),
            }
        );

        // Escape closes without emitting Select
        assert_eq!(
            picker.handle_key(key(KeyCode::Esc)),
            ModelPickerEvent::Close
        );
        assert!(!picker.open);
    }

    #[test]
    fn current_display_label_and_tab_windowing_keep_active_provider_visible() {
        use crate::theme::DARK_PALETTE;
        use ratatui::{Terminal, backend::TestBackend};

        let mut picker = ModelPickerState::default();
        assert_eq!(picker.current_display_label(), None);

        let providers = [
            ("p1", "ChatGPT 订阅服务", "gpt-6.1-sol", "GPT-6.1 Sol"),
            (
                "p2",
                "DeepSeek 官方渠道",
                "deepseek-flash",
                "DeepSeek Flash",
            ),
            ("p3", "OpenCode Go 平台", "glm-5.3-flash", "GLM-5.3 Flash"),
            ("p4", "GLM Coding Plan（国区）", "glm-5.3", "GLM-5.3"),
            ("p5", "Grok 官方直连渠道", "grok-4.7", "Grok-4.7"),
        ];
        let groups: Vec<ModelPickerGroup> = providers
            .iter()
            .map(|(pid, label, mid, dname)| ModelPickerGroup {
                group_id: (*pid).into(),
                label: (*label).into(),
                models: vec![ModelPickerOption {
                    record_id: format!("{pid}:{mid}"),
                    provider_id: (*pid).into(),
                    model_id: (*mid).into(),
                    display_name: (*dname).into(),
                    available: true,
                    supports_reasoning: true,
                    efforts: vec!["default".into()],
                    badges: vec!["tools".into()],
                }],
            })
            .collect();
        picker.open_with(groups, Some("p5".into()), Some("grok-4.7".into()), None);
        assert_eq!(
            picker.current_display_label().as_deref(),
            Some("Grok-4.7 · Grok 官方直连渠道")
        );

        let mut term = Terminal::new(TestBackend::new(74, 18)).unwrap();
        term.draw(|f| render_model_picker(f, f.area(), &picker, TuiLocale::ZhCn, &DARK_PALETTE))
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
        assert!(rendered.contains("‹"));
        assert!(rendered.contains("Grok 官方直连渠道"));
    }

    #[test]
    fn model_picker_search_active_bracket_and_caret_alignment() {
        use crate::theme::DARK_PALETTE;
        use ratatui::{Terminal, backend::TestBackend};

        let mut picker = ModelPickerState::default();
        let groups = vec![
            ModelPickerGroup {
                group_id: "openai".into(),
                label: "OpenAI".into(),
                models: vec![
                    ModelPickerOption {
                        record_id: "o1".into(),
                        provider_id: "openai".into(),
                        model_id: "gpt-6".into(),
                        display_name: "GPT-6".into(),
                        available: true,
                        supports_reasoning: true,
                        efforts: vec!["default".into()],
                        badges: vec![],
                    },
                    ModelPickerOption {
                        record_id: "o2".into(),
                        provider_id: "openai".into(),
                        model_id: "gpt-6-mini".into(),
                        display_name: "GPT-6 Mini".into(),
                        available: true,
                        supports_reasoning: false,
                        efforts: vec![],
                        badges: vec![],
                    },
                ],
            },
            ModelPickerGroup {
                group_id: "deepseek".into(),
                label: "DeepSeek".into(),
                models: vec![ModelPickerOption {
                    record_id: "d1".into(),
                    provider_id: "deepseek".into(),
                    model_id: "deepseek-r2".into(),
                    display_name: "DeepSeek R2".into(),
                    available: true,
                    supports_reasoning: true,
                    efforts: vec!["high".into()],
                    badges: vec![],
                }],
            },
        ];
        picker.open_with(groups, Some("openai".into()), Some("gpt-6".into()), None);

        // Docked rendering checks: EnUs title, active-only [OpenAI] bracket without underline,
        // and aligned 2-col caret on both focused and unfocused rows.
        let mut dock = Terminal::new(TestBackend::new(72, 12)).unwrap();
        dock.draw(|f| {
            render_model_picker_dock(f, f.area(), &picker, TuiLocale::EnUs, &DARK_PALETTE);
        })
        .unwrap();
        let buf = dock.backend().buffer();
        let row_text = |y: u16| -> String {
            (0..buf.area.width)
                .map(|x| buf[(x, y)].symbol())
                .collect::<String>()
        };
        let all_text: String = (0..12).map(&row_text).collect();
        assert!(all_text.contains("Model"));
        assert!(all_text.contains("[OpenAI]  DeepSeek"));
        assert!(!all_text.contains("[DeepSeek]"));
        let tab_y = (0..12).find(|&y| row_text(y).contains("[OpenAI]")).unwrap();
        assert!(!buf[(0, tab_y)].modifier.contains(Modifier::UNDERLINED));

        let g1_y = (0..12)
            .find(|&y| row_text(y).contains("GPT-6") && !row_text(y).contains("Mini"))
            .unwrap();
        let g2_y = (0..12)
            .find(|&y| row_text(y).contains("GPT-6 Mini"))
            .unwrap();
        assert!(row_text(g1_y).starts_with("› GPT-6"));
        assert!(row_text(g2_y).starts_with("  GPT-6 Mini"));

        // Typing filters across all groups, showing provider suffix; Esc clears query before closing.
        for c in ['r', '2'] {
            assert_eq!(
                picker.handle_key(key(KeyCode::Char(c))),
                ModelPickerEvent::None
            );
        }
        assert_eq!(picker.filtered_entries(), vec![(1, 0)]);
        assert_eq!(
            picker.current_display_label().as_deref(),
            Some("DeepSeek R2 · DeepSeek")
        );
        assert_eq!(
            picker.handle_key(key(KeyCode::Enter)),
            ModelPickerEvent::Select {
                provider_id: "deepseek".into(),
                model_id: "deepseek-r2".into(),
                effort: Some("high".into()),
            }
        );
        assert_eq!(picker.handle_key(key(KeyCode::Esc)), ModelPickerEvent::None);
        assert!(picker.open);
        assert!(picker.query.is_empty());
        assert_eq!(
            picker.handle_key(key(KeyCode::Esc)),
            ModelPickerEvent::Close
        );
        assert!(!picker.open);
    }
}
