//! Full Classic interactive chat shell view (`peer --classic` & `peer sessions resume <id>`).
//!
//! Pure view over bounded display items, byte-LRU Markdown/code/diff cache,
//! reading-anchor virtualization, small-viewport-guarded approval overlay,
//! full-width composer, and embedded ModelPicker (ADR 130 + Interaction Contract).

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    commands::clip_bot_line,
    markdown::{RenderedBlock, WrapCacheKey, render_markdown_bounded, stable_hash},
    model_picker::{ModelPickerState, render_model_picker},
    terminal_text,
    view::draft_view,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Color, Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Borders, Paragraph, Wrap},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClassicMessage {
    pub id: String,
    pub revision: u64,
    pub role: String,
    pub text: String,
}

pub struct ClassicView<'a> {
    pub title: &'a str,
    pub model_badge: &'a str,
    pub mode_badge: &'a str,
    pub access_badge: &'a str,
    pub messages: &'a [ClassicMessage],
    pub live_stream: &'a str,
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub status: &'a str,
    pub approval: Option<(&'a str, usize)>,
    pub model_picker: &'a ModelPickerState,
    pub wrap_cache: &'a mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
}

pub fn render_classic(frame: &mut Frame<'_>, view: ClassicView<'_>) {
    let area = frame.area();
    if area.width == 0 || area.height == 0 {
        return;
    }

    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(3),
        Constraint::Length(1),
    ])
    .split(area);

    // Header: title + compact model / mode / access badges
    let w = usize::from(areas[0].width).max(1);
    let badge_str = format!(
        "{} · {} · {}",
        view.model_badge, view.mode_badge, view.access_badge
    );
    let title_budget = w.saturating_sub(badge_str.len().min(w / 2) + 2).max(4);
    let header = Line::from(vec![
        Span::styled(
            clip_bot_line(view.title, title_budget),
            Style::new().add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
        Span::styled(
            clip_bot_line(&badge_str, w.saturating_sub(title_budget + 2)),
            Style::new().fg(Color::DarkGray),
        ),
    ]);
    frame.render_widget(Paragraph::new(header), areas[0]);

    // Main viewport: either approval overlay (with full details scrolling) or virtualized transcript
    let body_w = usize::from(areas[1].width).max(1);
    let body_h = usize::from(areas[1].height);
    if let Some((approval_text, scroll_top)) = view.approval {
        let block =
            render_markdown_bounded(approval_text, body_w, Style::new().fg(Color::Yellow), 512);
        let last = block.lines.len().saturating_sub(body_h);
        let visible: Vec<Line<'static>> = block
            .lines
            .iter()
            .skip(scroll_top.min(last))
            .take(body_h)
            .map(|l| l.to_ratatui_line())
            .collect();
        frame.render_widget(Paragraph::new(visible), areas[1]);
    } else {
        let mut all_lines: Vec<Line<'static>> = Vec::new();
        for msg in view.messages {
            let (label, label_style) = match msg.role.as_str() {
                "user" => (
                    "你",
                    Style::new().fg(Color::Cyan).add_modifier(Modifier::BOLD),
                ),
                "tool" => (
                    "工具",
                    Style::new()
                        .fg(Color::DarkGray)
                        .add_modifier(Modifier::BOLD),
                ),
                "system" => (
                    "系统",
                    Style::new().fg(Color::Yellow).add_modifier(Modifier::BOLD),
                ),
                _ => (
                    "Peer",
                    Style::new().fg(Color::Green).add_modifier(Modifier::BOLD),
                ),
            };
            all_lines.push(Line::styled(label.to_owned(), label_style));
            let key = WrapCacheKey {
                item_hash: stable_hash(&msg.id),
                revision: msg.revision,
                width: areas[1].width,
            };
            let block = if let Some(cached) = view.wrap_cache.get(&key) {
                cached.clone()
            } else {
                let computed = render_markdown_bounded(&msg.text, body_w, Style::default(), 200);
                view.wrap_cache.insert(key, computed.clone());
                computed
            };
            for styled in &block.lines {
                all_lines.push(styled.to_ratatui_line());
            }
            all_lines.push(Line::raw(""));
        }

        if !view.live_stream.is_empty() {
            let live_block =
                render_markdown_bounded(view.live_stream, body_w, Style::default(), 120);
            for styled in &live_block.lines {
                all_lines.push(styled.to_ratatui_line());
            }
        }

        if all_lines.is_empty() {
            frame.render_widget(
                Paragraph::new(
                    "输入消息开始对话。`/model` 切模型 · `/bots` 切机器人 · `/help` 查看命令。",
                )
                .style(Style::new().fg(Color::DarkGray))
                .wrap(Wrap { trim: false }),
                areas[1],
            );
        } else {
            let max_back = all_lines.len().saturating_sub(body_h);
            let back = view.anchor.lines_back().min(max_back);
            let end = all_lines.len().saturating_sub(back);
            let start = end.saturating_sub(body_h);
            let visible: Vec<Line<'static>> = all_lines
                .into_iter()
                .skip(start)
                .take(end - start)
                .collect();
            frame.render_widget(Paragraph::new(visible), areas[1]);
        }
    }

    // Full-width divider
    frame.render_widget(Block::default().borders(Borders::TOP), areas[2]);

    // Full-width composer
    let (draft_lines, caret) = if view.composer.draft().is_empty() {
        (
            vec![Line::styled(
                "输入消息或 `/help`…",
                Style::new().fg(Color::DarkGray),
            )],
            Some((0u16, 0u16)),
        )
    } else {
        draft_view(
            view.composer,
            usize::from(areas[3].width),
            usize::from(areas[3].height),
        )
    };
    frame.render_widget(Paragraph::new(draft_lines), areas[3]);
    if view.approval.is_none()
        && !view.model_picker.open
        && let Some((x, y)) = caret
    {
        frame.set_cursor_position((areas[3].x + x, areas[3].y + y));
    }

    // Quiet status line (shows reading-history badge if scrolled up)
    let status_text = if !view.anchor.is_following() && view.approval.is_none() {
        "↑ 历史阅读中 · End/PgDn 回到最新".to_owned()
    } else {
        clip_bot_line(&terminal_text(view.status), usize::from(areas[4].width))
    };
    frame.render_widget(
        Paragraph::new(Line::styled(status_text, Style::new().fg(Color::DarkGray))),
        areas[4],
    );

    if view.model_picker.open {
        render_model_picker(frame, area, view.model_picker);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bounded_cache::MARKDOWN_WRAP_CACHE_BYTES;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn classic_view_renders_markdown_stream_anchor_and_model_picker_without_panic() {
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
                        title: "Peer · 对话",
                        model_badge: "gpt-4o",
                        mode_badge: "chat",
                        access_badge: "session",
                        messages: &msgs,
                        live_stream: "Peer  正在流式输出…",
                        anchor: &anchor,
                        composer: &composer,
                        status: "Enter 发送 · Ctrl-C 退出",
                        approval: None,
                        model_picker: &picker,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        }
    }
}
