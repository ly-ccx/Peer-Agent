//! Full Classic interactive chat shell view (`peer --classic` & `peer sessions resume <id>`).
//!
//! Styled with Peer Frost tokens (`apps/tui/src/app.tsx`, `b3-wordmark.ts`, `composer-status-view.tsx`)
//! over bounded display items, byte-LRU Markdown/code/diff cache, reading-anchor virtualization,
//! slash autocomplete menu, B3 welcome wordmark, small-viewport approval guard, and ModelPicker.

use crate::{
    Composer,
    bounded_cache::{ByteBudgetLru, ReadingAnchor},
    commands::clip_bot_line,
    markdown::{RenderedBlock, WrapCacheKey, render_markdown_themed, stable_hash},
    model_picker::{ModelPickerState, render_model_picker},
    slash_menu::{CLASSIC_SLASH_ITEMS, filter_slash_items, render_slash_menu},
    terminal_text,
    theme::{
        BRAND_MARK, CARET_SELECTED, ONLINE_DOT, SEPARATOR, TuiLocale, TuiPalette, USER_RAIL_BAR,
        context_usage_color, fill_canvas,
    },
    view::draft_view_styled,
    wordmark::b3_wordmark_lines,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::Paragraph,
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
    pub mode_badge: &'a str,
    pub access_badge: &'a str,
    pub context_percent: Option<u8>,
    pub is_running: bool,
    pub palette: &'static TuiPalette,
    pub scheme_id: u8,
    pub locale: TuiLocale,
    pub messages: &'a [ClassicMessage],
    pub live_stream: &'a str,
    pub anchor: &'a ReadingAnchor,
    pub composer: &'a Composer,
    pub status: &'a str,
    pub approval: Option<(&'a str, usize)>,
    pub model_picker: &'a ModelPickerState,
    pub slash_selected: usize,
    pub wrap_cache: &'a mut ByteBudgetLru<WrapCacheKey, RenderedBlock>,
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

    let slash_items = if view.approval.is_none() && !view.model_picker.open {
        filter_slash_items(view.composer.draft(), CLASSIC_SLASH_ITEMS)
    } else {
        Vec::new()
    };
    let slash_rows = if slash_items.is_empty() {
        0u16
    } else {
        (slash_items.len().min(5) as u16) + 1
    };

    let mut constraints = vec![
        Constraint::Length(1), // Session topbar (`◆ title  workspace      model ●`)
        Constraint::Length(1), // Topbar thin divider
        Constraint::Min(1),    // Main viewport / Welcome B3 wordmark
    ];
    if slash_rows > 0 && area.height >= 11 {
        constraints.push(Constraint::Length(slash_rows));
    }
    constraints.push(Constraint::Length(1)); // Quiet composer divider
    constraints.push(Constraint::Length(3)); // `› ` full-width composer
    constraints.push(Constraint::Length(1)); // Mode / access / status / context bar

    let areas = Layout::vertical(constraints).split(area);
    let mut slot = 0usize;

    // 1. Session topbar matching `apps/tui/src/app.tsx:2678-2699`
    let topbar = areas[slot];
    slot += 1;
    let tw = usize::from(topbar.width).max(1);
    let dot_str = format!(" {ONLINE_DOT}");
    let model_text = clip_bot_line(view.model_badge, tw / 3);
    let title_budget = tw.saturating_sub(model_text.width() + 8).max(4);
    let title_part = clip_bot_line(view.title, title_budget);
    let ws_budget = tw.saturating_sub(title_part.width() + model_text.width() + 8);
    let ws_part = if !view.workspace_label.is_empty() && ws_budget >= 6 {
        format!(
            "  {}",
            clip_bot_line(view.workspace_label, ws_budget.saturating_sub(2))
        )
    } else {
        String::new()
    };
    let left_len = 2 + title_part.width() + ws_part.width();
    let right_len = model_text.width() + dot_str.width();
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
        top_spans.push(Span::styled(
            model_text,
            Style::new().fg(palette.muted).bg(palette.background),
        ));
        top_spans.push(Span::styled(
            dot_str,
            Style::new().fg(palette.success).bg(palette.background),
        ));
    }
    frame.render_widget(Paragraph::new(Line::from(top_spans)), topbar);

    // Topbar hairline divider
    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(usize::from(areas[slot].width)),
            Style::new().fg(palette.border).bg(palette.background),
        )),
        areas[slot],
    );
    slot += 1;

    // 2. Main viewport: approval overlay, B3 welcome screen, or virtualized Markdown transcript
    let body_area = areas[slot];
    slot += 1;
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
    } else if view.messages.is_empty() && view.live_stream.is_empty() {
        let (mut wlines, wm_w) = b3_wordmark_lines(body_area.width, palette);
        let hint = if view.locale.is_zh() {
            "输入消息开始对话 · /model 选模型 · /bots 机器人 · /help 帮助"
        } else {
            "Send a message · /model model · /bots bots · /help commands"
        };
        let total_rows = wlines.len() + 2;
        let top_pad = body_h.saturating_sub(total_rows) / 2;
        let wm_left = body_w.saturating_sub(usize::from(wm_w)) / 2;
        let padded_wlines: Vec<Line<'static>> = wlines
            .drain(..)
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
        if body_h > 0 {
            let wm_rect = Rect {
                x: body_area.x,
                y: body_area.y + top_pad as u16,
                width: body_area.width,
                height: body_area.height.saturating_sub(top_pad as u16),
            };
            let mut render_lines = padded_wlines;
            let clipped_hint = clip_bot_line(hint, body_w);
            let h_left = body_w.saturating_sub(clipped_hint.width()) / 2;
            render_lines.push(Line::styled("", Style::new().bg(palette.background)));
            render_lines.push(Line::styled(
                format!("{}{}", " ".repeat(h_left), clipped_hint),
                Style::new().fg(palette.muted).bg(palette.background),
            ));
            frame.render_widget(Paragraph::new(render_lines), wm_rect);
        }
    } else {
        let mut all_lines: Vec<Line<'static>> = Vec::new();
        for msg in view.messages {
            let is_user = msg.role == "user";
            let (label, label_style, msg_bg) = match msg.role.as_str() {
                "user" => (
                    format!("{USER_RAIL_BAR}你"),
                    Style::new()
                        .fg(palette.user)
                        .bg(palette.user_panel)
                        .add_modifier(Modifier::BOLD),
                    palette.user_panel,
                ),
                "tool" => (
                    "工具".to_owned(),
                    Style::new()
                        .fg(palette.tool_detail)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                    palette.background,
                ),
                "system" => (
                    "系统".to_owned(),
                    Style::new()
                        .fg(palette.warning)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                    palette.background,
                ),
                _ => (
                    "Peer".to_owned(),
                    Style::new()
                        .fg(palette.accent)
                        .bg(palette.background)
                        .add_modifier(Modifier::BOLD),
                    palette.background,
                ),
            };
            all_lines.push(Line::styled(label, label_style));

            let _ = is_user;
            let key = WrapCacheKey {
                item_hash: stable_hash(&msg.id),
                revision: msg.revision,
                width: body_area.width,
                scheme: view.scheme_id,
            };
            let block = if let Some(cached) = view.wrap_cache.get(&key) {
                cached.clone()
            } else {
                let computed = render_markdown_themed(
                    &msg.text,
                    body_w,
                    Style::new().fg(palette.text).bg(msg_bg),
                    200,
                    palette,
                );
                view.wrap_cache.insert(key, computed.clone());
                computed
            };
            for styled in &block.lines {
                all_lines.push(styled.to_ratatui_line());
            }
            all_lines.push(Line::styled("", Style::new().bg(palette.background)));
        }

        if !view.live_stream.is_empty() {
            let live_block = render_markdown_themed(
                view.live_stream,
                body_w,
                Style::new().fg(palette.text).bg(palette.background),
                120,
                palette,
            );
            for styled in &live_block.lines {
                all_lines.push(styled.to_ratatui_line());
            }
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

    if slash_rows > 0 && area.height >= 11 {
        render_slash_menu(
            frame,
            areas[slot],
            &slash_items,
            view.slash_selected,
            view.locale,
            palette,
        );
        slot += 1;
    }

    // Quiet divider above composer
    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(usize::from(areas[slot].width)),
            Style::new().fg(palette.subtle).bg(palette.background),
        )),
        areas[slot],
    );
    slot += 1;

    // 3. Full-width `› ` composer
    let composer_area = areas[slot];
    slot += 1;
    if composer_area.width >= 4 {
        let cols =
            Layout::horizontal([Constraint::Length(2), Constraint::Min(1)]).split(composer_area);
        frame.render_widget(
            Paragraph::new(Line::styled(
                CARET_SELECTED,
                Style::new().fg(palette.accent).bg(palette.background),
            )),
            cols[0],
        );
        let input_area = cols[1];
        let (draft_lines, caret) = if view.composer.draft().is_empty() {
            let placeholder = if view.locale.is_zh() {
                "输入消息或 `/help`…"
            } else {
                "Message Peer, or /help…"
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

    // 4. Footer status + context meter (`apps/tui/src/composer-status-view.tsx`)
    let status_area = areas[slot];
    let sw = usize::from(status_area.width).max(1);
    let left_text = if !view.anchor.is_following() && view.approval.is_none() {
        "↑ 历史阅读中 · End/PgDn 回到最新".to_owned()
    } else {
        clip_bot_line(&terminal_text(view.status), sw)
    };
    let left_fg = if view.approval.is_some() {
        palette.warning
    } else if view.is_running || !view.anchor.is_following() {
        palette.info
    } else {
        palette.muted
    };

    let right_badge = match view.context_percent {
        Some(pct) => format!("{} · {} · ctx {}%", view.mode_badge, view.access_badge, pct),
        None => format!("{} · {}", view.mode_badge, view.access_badge),
    };
    let right_fg = if view.context_percent.is_some() {
        context_usage_color(view.context_percent, palette)
    } else {
        palette.muted
    };

    let gap = sw.saturating_sub(left_text.width() + right_badge.width());
    if gap >= 2 {
        frame.render_widget(
            Paragraph::new(Line::from(vec![
                Span::styled(left_text, Style::new().fg(left_fg).bg(palette.background)),
                Span::styled(" ".repeat(gap), Style::new().bg(palette.background)),
                Span::styled(
                    right_badge,
                    Style::new().fg(right_fg).bg(palette.background),
                ),
            ])),
            status_area,
        );
    } else {
        frame.render_widget(
            Paragraph::new(Line::styled(
                clip_bot_line(&left_text, sw),
                Style::new().fg(left_fg).bg(palette.background),
            )),
            status_area,
        );
    }

    if view.model_picker.open {
        render_model_picker(frame, full_area, view.model_picker, palette);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{bounded_cache::MARKDOWN_WRAP_CACHE_BYTES, theme::DARK_PALETTE};
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
                        workspace_label: "peer-dev",
                        model_badge: "gpt-4o",
                        mode_badge: "chat",
                        access_badge: "session",
                        context_percent: Some(42),
                        is_running: false,
                        palette: &DARK_PALETTE,
                        scheme_id: 0,
                        locale: TuiLocale::ZhCn,
                        messages: &msgs,
                        live_stream: "Peer  流式输出...",
                        anchor: &anchor,
                        composer: &composer,
                        status: "就绪",
                        approval: None,
                        model_picker: &picker,
                        slash_selected: 0,
                        wrap_cache: &mut cache,
                    },
                );
            })
            .unwrap();
        }
    }

    #[test]
    fn classic_welcome_screen_renders_b3_wordmark() {
        let mut cache = ByteBudgetLru::new(MARKDOWN_WRAP_CACHE_BYTES, 16);
        let composer = Composer::default();
        let anchor = ReadingAnchor::FollowingLatest;
        let picker = ModelPickerState::default();
        let mut term = Terminal::new(TestBackend::new(100, 30)).unwrap();
        term.draw(|f| {
            render_classic(
                f,
                ClassicView {
                    title: "Peer · 对话",
                    workspace_label: "ws",
                    model_badge: "mock",
                    mode_badge: "chat",
                    access_badge: "ask",
                    context_percent: None,
                    is_running: false,
                    palette: &DARK_PALETTE,
                    scheme_id: 0,
                    locale: TuiLocale::ZhCn,
                    messages: &[],
                    live_stream: "",
                    anchor: &anchor,
                    composer: &composer,
                    status: "就绪",
                    approval: None,
                    model_picker: &picker,
                    slash_selected: 0,
                    wrap_cache: &mut cache,
                },
            );
        })
        .unwrap();
        let buf = term.backend().buffer().clone();
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
        assert!(text.contains("agent"));
        assert!(text.contains("◆ Peer · 对话"));
    }
}
