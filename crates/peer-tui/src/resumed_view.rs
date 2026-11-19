use crate::{
    Composer,
    theme::{BRAND_MARK, CARET_SELECTED, SEPARATOR, TuiPalette, fill_canvas},
    view::draft_view_styled,
};
use ratatui::{
    Frame,
    layout::{Constraint, Layout, Rect},
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Paragraph, Wrap},
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
    pub palette: &'static TuiPalette,
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

    let areas = Layout::vertical([
        Constraint::Length(1),
        Constraint::Min(1),
        Constraint::Length(1),
        Constraint::Length(4),
        Constraint::Length(2),
    ])
    .split(area);

    frame.render_widget(
        Paragraph::new(Line::from(vec![
            Span::styled(
                format!("{BRAND_MARK} "),
                Style::new().fg(palette.accent).bg(palette.background),
            ),
            Span::styled(
                view.title,
                Style::new()
                    .fg(palette.text_soft)
                    .bg(palette.background)
                    .add_modifier(Modifier::BOLD),
            ),
        ])),
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
            .map(|l| Line::styled(l, Style::new().fg(palette.warning).bg(palette.background)))
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
            .map(|l| {
                let fg = if l.starts_with("Peer") {
                    palette.accent
                } else if l.starts_with("你") {
                    palette.user
                } else if l.starts_with("工具") {
                    palette.tool_detail
                } else {
                    palette.text
                };
                Line::styled(l, Style::new().fg(fg).bg(palette.background))
            })
            .collect::<Vec<_>>()
    };
    frame.render_widget(Paragraph::new(lines), areas[1]);

    frame.render_widget(
        Paragraph::new(Line::styled(
            SEPARATOR.repeat(usize::from(areas[2].width)),
            Style::new().fg(palette.subtle).bg(palette.background),
        )),
        areas[2],
    );

    if areas[3].width >= 4 {
        let cols = Layout::horizontal([Constraint::Length(2), Constraint::Min(1)]).split(areas[3]);
        frame.render_widget(
            Paragraph::new(Line::styled(
                CARET_SELECTED,
                Style::new().fg(palette.accent).bg(palette.background),
            )),
            cols[0],
        );
        let input_area = cols[1];
        let (lines, caret) = draft_view_styled(
            view.composer,
            input_area.width.into(),
            input_area.height.into(),
            Style::new().fg(palette.input_fg).bg(palette.input_bg),
        );
        frame.render_widget(Paragraph::new(lines), input_area);
        if let (None, Some((x, y))) = (view.approval, caret) {
            frame.set_cursor_position((
                (input_area.x + x).min(full_area.x + full_area.width - 1),
                (input_area.y + y).min(full_area.y + full_area.height - 1),
            ));
        } else {
            frame.set_cursor_position((input_area.x, input_area.y));
        }
    }

    let status_fg = if view.approval.is_some() {
        palette.warning
    } else {
        palette.muted
    };
    frame.render_widget(
        Paragraph::new(view.status)
            .style(Style::new().fg(status_fg).bg(palette.background))
            .wrap(Wrap { trim: false }),
        areas[4],
    );
}
