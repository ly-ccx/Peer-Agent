//! Standard native Model Picker view & pure state reducer (model-picker.md spec).
//!
//! - Uses configured provider group IDs and stable model record IDs (never merges same-name models).
//! - Browsing via arrow keys never writes configuration; only explicit Enter submits.
//! - Busy state prevents re-entry while keeping the list readable.
//! - Escape closes the picker without sending messages or clearing composer drafts.

use crate::{
    commands::clip_bot_line,
    theme::{CARET_IDLE, CARET_SELECTED, CHECK_CURRENT, SEPARATOR, TuiPalette},
};
use crossterm::event::{KeyCode, KeyEvent, KeyEventKind};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Clear, Paragraph},
};

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
        self.error = None;
    }

    pub fn current_model(&self) -> Option<&ModelPickerOption> {
        self.groups
            .get(self.active_group)
            .and_then(|g| g.models.get(self.active_model))
    }

    pub fn handle_key(&mut self, key: KeyEvent) -> ModelPickerEvent {
        if !self.open || key.kind == KeyEventKind::Release {
            return ModelPickerEvent::None;
        }
        match key.code {
            KeyCode::Esc => {
                self.close();
                ModelPickerEvent::Close
            }
            KeyCode::Left => {
                if !self.groups.is_empty() {
                    self.active_group = self.active_group.saturating_sub(1);
                    self.active_model = 0;
                    self.active_effort = 0;
                }
                ModelPickerEvent::None
            }
            KeyCode::Right => {
                if self.active_group + 1 < self.groups.len() {
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
                if let Some(g) = self.groups.get(self.active_group)
                    && self.active_model + 1 < g.models.len()
                {
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
                if let Some(g) = self.groups.get(self.active_group)
                    && !g.models.is_empty()
                {
                    self.active_model = g.models.len() - 1;
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

pub fn render_model_picker(
    frame: &mut Frame<'_>,
    area: Rect,
    state: &ModelPickerState,
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

    let outer = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(1),
    ])
    .split(popup);

    let pw = usize::from(popup.width).max(1);
    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                " 模型选择 ",
                Style::new()
                    .fg(palette.info)
                    .bg(palette.panel)
                    .add_modifier(Modifier::BOLD),
            ),
            Span::styled(
                SEPARATOR.repeat(pw.saturating_sub(10)),
                Style::new().fg(palette.border).bg(palette.panel),
            ),
        ])),
        outer[0],
    );

    // Provider tabs row
    let mut tab_spans = Vec::new();
    if state.groups.is_empty() {
        tab_spans.push(Span::styled(
            "无已配置模型",
            Style::new().fg(palette.muted).bg(palette.panel),
        ));
    } else {
        for (i, g) in state.groups.iter().enumerate() {
            if i > 0 {
                tab_spans.push(Span::styled("  ", Style::new().bg(palette.panel)));
            }
            let style = if i == state.active_group {
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.panel)
                    .add_modifier(Modifier::BOLD | Modifier::UNDERLINED)
            } else {
                Style::new().fg(palette.muted).bg(palette.panel)
            };
            tab_spans.push(Span::styled(clip_bot_line(&g.label, 18), style));
        }
    }
    frame.render_widget(
        Paragraph::new(Line::from(tab_spans)).style(Style::new().bg(palette.panel)),
        outer[1],
    );

    // Model list inside active provider group (caret selection, internal scroll)
    let list_h = usize::from(outer[2].height);
    let list_w = usize::from(outer[2].width);
    let mut rows = Vec::new();
    if let Some(group) = state.groups.get(state.active_group) {
        let top = state.active_model.saturating_sub(list_h.saturating_sub(1));
        for (idx, m) in group.models.iter().enumerate().skip(top).take(list_h) {
            let focused = idx == state.active_model;
            let selected = state.selected_provider.as_deref() == Some(m.provider_id.as_str())
                && state.selected_model.as_deref() == Some(m.model_id.as_str());
            let caret = if focused { CARET_SELECTED } else { CARET_IDLE };
            let mark = if selected { CHECK_CURRENT } else { "" };
            let suffix = if !m.available {
                " [不可用]".to_owned()
            } else if focused && !m.efforts.is_empty() {
                let eff = m
                    .efforts
                    .get(state.active_effort)
                    .map(String::as_str)
                    .unwrap_or("default");
                format!(" · 思考:{eff}")
            } else if !m.badges.is_empty() {
                format!(" · {}", m.badges.join("/"))
            } else {
                String::new()
            };
            let main_text = clip_bot_line(
                &format!("{caret}{}", m.display_name),
                list_w.saturating_sub(mark.len() + suffix.len().min(list_w / 2)),
            );
            let main_style = if !m.available {
                Style::new().fg(palette.muted).bg(palette.panel)
            } else if focused {
                Style::new()
                    .fg(palette.accent)
                    .bg(palette.panel)
                    .add_modifier(Modifier::BOLD)
            } else {
                Style::new().fg(palette.text).bg(palette.panel)
            };
            let mut spans = vec![Span::styled(main_text, main_style)];
            if selected {
                spans.push(Span::styled(
                    mark,
                    Style::new().fg(palette.success).bg(palette.panel),
                ));
            }
            if !suffix.is_empty() {
                spans.push(Span::styled(
                    clip_bot_line(&suffix, list_w / 2),
                    Style::new().fg(palette.muted).bg(palette.panel),
                ));
            }
            rows.push(Line::from(spans));
        }
    }
    frame.render_widget(
        Paragraph::new(rows).style(Style::new().bg(palette.panel)),
        outer[2],
    );

    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(pw),
            Style::new().fg(palette.border).bg(palette.panel),
        )),
        outer[3],
    );

    // Footer status (busy / error / controls)
    let footer = if let Some(ref err) = state.error {
        clip_bot_line(err, pw)
    } else if state.busy {
        "正在保存模型配置…".to_owned()
    } else {
        clip_bot_line(
            "←/→ 供应商 · ↑/↓ 模型 · Tab 思考强度 · Enter 确认 · Esc 关闭",
            pw,
        )
    };
    let footer_style = if state.error.is_some() {
        Style::new().fg(palette.danger_soft).bg(palette.panel)
    } else {
        Style::new().fg(palette.muted).bg(palette.panel)
    };
    frame.render_widget(Paragraph::new(Line::styled(footer, footer_style)), outer[4]);
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
}
