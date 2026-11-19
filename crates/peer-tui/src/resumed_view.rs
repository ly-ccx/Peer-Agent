use crate::{Composer, view::draft_view};
use ratatui::{
    Frame,
    layout::{Constraint, Layout},
    style::{Modifier, Style},
    text::Line,
    widgets::{Block, Borders, Paragraph, Wrap},
};
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

pub struct ResumeView<'a> {
    pub title: &'a str,
    pub lines: &'a [String],
    pub live: &'a str,
    pub back: usize,
    pub composer: &'a Composer,
    pub status: &'a str,
    pub approval: Option<(&'a str, usize)>,
}

fn wrap<'a>(text: impl IntoIterator<Item = &'a str>, width: usize) -> Vec<String> {
    let mut lines = Vec::new();
    for text in text {
        for row in text.split('\n') {
            let mut line = String::new();
            let mut column = 0;
            for grapheme in row.graphemes(true) {
                let glyph = if grapheme == "\t" { "    " } else { grapheme };
                let size = glyph.width().min(width);
                if column + size > width && !line.is_empty() {
                    lines.push(std::mem::take(&mut line));
                    column = 0;
                }
                line.push_str(glyph);
                column += size;
            }
            lines.push(line);
        }
    }
    lines
}

pub fn render_resume(frame: &mut Frame<'_>, view: ResumeView<'_>) {
    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(4),
        Constraint::Length(2),
    ])
    .split(frame.area());
    frame.render_widget(
        Paragraph::new(view.title).style(Style::new().add_modifier(Modifier::BOLD)),
        areas[0],
    );
    let width = usize::from(areas[1].width).max(1);
    let height = usize::from(areas[1].height);
    let lines = if let Some((approval, top)) = view.approval {
        let lines = wrap([approval], width);
        let last = lines.len().saturating_sub(height);
        lines
            .into_iter()
            .skip(top.min(last))
            .take(height)
            .map(Line::raw)
            .collect::<Vec<_>>()
    } else {
        let live = (!view.live.is_empty()).then_some(view.live);
        let mut lines = wrap(view.lines.iter().map(String::as_str).chain(live), width);
        let end = lines
            .len()
            .saturating_sub(view.back.min(lines.len().saturating_sub(height)));
        lines.truncate(end);
        lines
            .into_iter()
            .skip(end.saturating_sub(height))
            .map(Line::raw)
            .collect::<Vec<_>>()
    };
    frame.render_widget(Paragraph::new(lines), areas[1]);
    frame.render_widget(Block::default().borders(Borders::TOP), areas[2]);
    let (lines, caret) = draft_view(view.composer, areas[3].width.into(), areas[3].height.into());
    frame.render_widget(Paragraph::new(lines), areas[3]);
    if let (None, Some((x, y))) = (view.approval, caret) {
        frame.set_cursor_position((areas[3].x + x, areas[3].y + y));
    }
    frame.render_widget(
        Paragraph::new(view.status).wrap(Wrap { trim: false }),
        areas[4],
    );
}
