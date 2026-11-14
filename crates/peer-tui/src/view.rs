use crate::Composer;
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    text::Line,
    widgets::{Block, Borders, Paragraph, Wrap},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

const MAX_RENDER_DRAFT_BYTES: usize = 8192;

/// Only a bounded window around the caret is laid out, even for a 1 MiB paste.
fn draft_view(
    composer: &Composer,
    width: usize,
    height: usize,
) -> (Vec<Line<'static>>, Option<(u16, u16)>) {
    if width == 0 || height == 0 {
        return (Vec::new(), None);
    }
    let draft = composer.draft();
    if draft.is_empty() {
        return (vec![Line::raw("输入临时草稿")], Some((0, 0)));
    }
    let mut start = composer.cursor().saturating_sub(MAX_RENDER_DRAFT_BYTES / 2);
    while !draft.is_char_boundary(start) {
        start += 1;
    }
    let mut end = draft.len().min(start + MAX_RENDER_DRAFT_BYTES);
    while !draft.is_char_boundary(end) {
        end -= 1;
    }
    let mut lines = vec![String::new()];
    let (mut column, mut caret) = (0, (0, 0));
    for (offset, grapheme) in draft[start..end].grapheme_indices(true) {
        let size = if grapheme == "\t" {
            4.min(width)
        } else {
            grapheme.width().min(width)
        };
        if column + size > width || column == width {
            lines.push(String::new());
            column = 0;
        }
        if start + offset == composer.cursor() {
            caret = (column, lines.len() - 1);
        }
        if grapheme == "\n" {
            lines.push(String::new());
            column = 0;
        } else {
            lines
                .last_mut()
                .unwrap()
                .push_str(if grapheme == "\t" { " " } else { grapheme });
            if grapheme == "\t" {
                lines
                    .last_mut()
                    .unwrap()
                    .push_str(&" ".repeat(size.saturating_sub(1)));
            }
            column += size;
        }
    }
    if composer.cursor() == end {
        if column == width {
            lines.push(String::new());
            column = 0;
        }
        caret = (column, lines.len() - 1);
    }
    let top = caret.1.saturating_sub(height - 1);
    let visible = lines
        .into_iter()
        .skip(top)
        .take(height)
        .map(Line::raw)
        .collect();
    (
        visible,
        Some((caret.0.min(width - 1) as u16, (caret.1 - top) as u16)),
    )
}

pub fn render(frame: &mut Frame<'_>, composer: &Composer) {
    let areas = Layout::vertical([
        Constraint::Length(2),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(5),
        Constraint::Length(2),
    ])
    .split(frame.area());
    frame.render_widget(Paragraph::new("Peer"), areas[0]);
    frame.render_widget(Paragraph::new("原生 CLI 候选\n\n当前仅支持临时草稿编辑，尚不能发送或执行任务。\n继续日常工作请使用原有 peer。\n\nCtrl-C 退出。".to_string()).wrap(Wrap { trim: false }), areas[1]);
    frame.render_widget(Block::default().borders(Borders::TOP), areas[2]);
    let (lines, caret) = draft_view(composer, areas[3].width.into(), areas[3].height.into());
    frame.render_widget(Paragraph::new(lines), areas[3]);
    if let Some((x, y)) = caret {
        frame.set_cursor_position((areas[3].x + x, areas[3].y + y));
    }
    frame.render_widget(
        Paragraph::new(composer.status.unwrap_or("尚未发送；此候选不会执行工具。")),
        areas[4],
    );
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Action;
    use ratatui::{Terminal, backend::TestBackend};

    #[test]
    fn narrow_and_wide_frames_preserve_unicode_draft_and_truthful_state() {
        let mut state = Composer::default();
        state.apply(Action::Insert("中文草稿".into()));
        for (width, height) in [(120, 40), (40, 16), (10, 6), (1, 1)] {
            let mut terminal = Terminal::new(TestBackend::new(width, height)).unwrap();
            terminal.draw(|frame| render(frame, &state)).unwrap();
            assert_eq!(state.draft(), "中文草稿");
        }
        assert!(!state.draft().contains("已接收"));
    }

    #[test]
    fn huge_draft_layout_is_bounded_and_caret_stays_in_visible_area() {
        let mut state = Composer::default();
        state.apply(Action::Insert("中".repeat(300_000)));
        for action in [Action::Refresh, Action::Home, Action::Right, Action::End] {
            state.apply(action);
            let (lines, caret) = draft_view(&state, 40, 5);
            assert!(lines.len() <= 5);
            assert!(
                lines
                    .iter()
                    .map(|line| line.to_string().len())
                    .sum::<usize>()
                    <= 40 * 5 * 4
            );
            let (x, y) = caret.unwrap();
            assert!(x < 40 && y < 5);
        }
        assert_eq!(state.draft().len(), 900_000);
    }
}
