use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers};
use unicode_segmentation::UnicodeSegmentation;

pub const MAX_DRAFT_BYTES: usize = 1_048_576;

#[derive(Default, Debug)]
pub struct Composer {
    draft: String,
    cursor: usize,
    pub status: Option<&'static str>,
    pub confirm_discard: bool,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Action {
    Insert(String),
    Backspace,
    Delete,
    Left,
    Right,
    Home,
    End,
    Submit,
    Interrupt,
    Escape,
    Refresh,
}
#[derive(Debug, PartialEq, Eq)]
pub enum Effect {
    None,
    Redraw,
    Quit,
}

impl Composer {
    pub fn draft(&self) -> &str {
        &self.draft
    }
    pub fn cursor(&self) -> usize {
        self.cursor
    }
    pub fn apply(&mut self, action: Action) -> Effect {
        match action {
            Action::Interrupt if self.draft.is_empty() || self.confirm_discard => {
                return Effect::Quit;
            }
            Action::Interrupt => {
                self.confirm_discard = true;
                self.status = Some("临时草稿尚未保存。再次 Ctrl-C 退出；Esc 继续编辑。");
            }
            Action::Escape => {
                self.confirm_discard = false;
                self.status = None;
            }
            Action::Submit => self.status = Some("发送尚未启用，临时草稿已保留。"),
            Action::Insert(text) => {
                self.confirm_discard = false;
                if self.draft.len().saturating_add(text.len()) > MAX_DRAFT_BYTES {
                    self.status = Some("输入超过大小限制，原草稿已保留。");
                } else {
                    let text = crate::terminal_text(&text);
                    self.draft.insert_str(self.cursor, &text);
                    self.cursor += text.len();
                    // Inserting a joiner can merge with the following cluster.
                    // Keep the caret on a whole-grapheme boundary afterwards.
                    if let Some((start, cluster)) =
                        self.draft.grapheme_indices(true).find(|(start, cluster)| {
                            *start < self.cursor && self.cursor < *start + cluster.len()
                        })
                    {
                        self.cursor = start + cluster.len();
                    }
                    self.status = None;
                }
            }
            Action::Backspace => {
                if let Some((previous, _)) =
                    self.draft[..self.cursor].grapheme_indices(true).next_back()
                {
                    self.draft.drain(previous..self.cursor);
                    self.cursor = previous;
                }
            }
            Action::Delete => {
                if let Some(next) = self.draft[self.cursor..].graphemes(true).next() {
                    self.draft.drain(self.cursor..self.cursor + next.len());
                }
            }
            Action::Left => {
                self.cursor = self.draft[..self.cursor]
                    .grapheme_indices(true)
                    .next_back()
                    .map_or(0, |(i, _)| i);
            }
            Action::Right => {
                self.cursor += self.draft[self.cursor..]
                    .graphemes(true)
                    .next()
                    .map_or(0, str::len);
            }
            Action::Home => self.cursor = 0,
            Action::End => self.cursor = self.draft.len(),
            Action::Refresh => {}
        }
        Effect::Redraw
    }
}

pub fn action_for_event(event: Event) -> Option<Action> {
    match event {
        Event::Paste(text) => Some(Action::Insert(text)),
        Event::Resize(_, _) | Event::FocusGained => Some(Action::Refresh),
        Event::Key(key) if key.kind != KeyEventKind::Release => {
            let control = key.modifiers.contains(KeyModifiers::CONTROL);
            Some(match key.code {
                KeyCode::Char('c' | 'd') if control => Action::Interrupt,
                KeyCode::Char('a') if control => Action::Home,
                KeyCode::Char('e') if control => Action::End,
                KeyCode::Char(c) if !control && !key.modifiers.contains(KeyModifiers::ALT) => {
                    Action::Insert(c.to_string())
                }
                KeyCode::Enter if key.modifiers.contains(KeyModifiers::SHIFT) => {
                    Action::Insert("\n".into())
                }
                KeyCode::Enter => Action::Submit,
                KeyCode::Backspace => Action::Backspace,
                KeyCode::Delete => Action::Delete,
                KeyCode::Left => Action::Left,
                KeyCode::Right => Action::Right,
                KeyCode::Home => Action::Home,
                KeyCode::End => Action::End,
                KeyCode::Esc => Action::Escape,
                _ => return None,
            })
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unicode_editing_removes_whole_graphemes_and_paste_never_submits() {
        let mut state = Composer::default();
        let action = action_for_event(Event::Paste("中文\ne\u{301}👨‍👩‍👧‍👦".into())).unwrap();
        state.apply(action);
        state.apply(Action::Backspace);
        assert_eq!(state.draft(), "中文\ne\u{301}");
        state.apply(Action::Backspace);
        assert_eq!(state.draft(), "中文\n");
        state.apply(Action::Home);
        state.apply(Action::Delete);
        assert_eq!(state.draft(), "文\n");
        assert_eq!(state.cursor(), 0);
        state.apply(Action::Submit);
        assert_eq!(state.draft(), "文\n");
    }

    #[test]
    fn draft_survives_oversized_paste_resize_submit_and_cancelled_exit() {
        let mut state = Composer::default();
        state.apply(Action::Insert("保留".into()));
        state.apply(Action::Insert("x".repeat(MAX_DRAFT_BYTES)));
        assert_eq!(state.draft(), "保留");
        state.apply(Action::Refresh);
        state.apply(Action::Submit);
        assert_eq!(state.apply(Action::Interrupt), Effect::Redraw);
        state.apply(Action::Escape);
        assert_eq!(state.draft(), "保留");
        assert_eq!(state.apply(Action::Interrupt), Effect::Redraw);
        assert_eq!(state.apply(Action::Interrupt), Effect::Quit);
    }

    #[test]
    fn untrusted_text_cannot_emit_terminal_or_bidi_control_codes() {
        let mut state = Composer::default();
        state.apply(Action::Insert("safe\x1b]52;c;attack\x07\u{202e}".into()));
        assert!(!state.draft().contains('\x1b'));
        assert!(!state.draft().contains('\x07'));
        assert!(!state.draft().contains('\u{202e}'));
    }

    #[test]
    fn inserting_a_joiner_keeps_caret_and_deletion_on_a_whole_cluster() {
        let mut state = Composer::default();
        state.apply(Action::Insert("👩👧".into()));
        state.apply(Action::Left);
        state.apply(Action::Insert("\u{200d}".into()));
        assert_eq!(state.cursor(), state.draft().len());
        state.apply(Action::Backspace);
        assert_eq!(state.draft(), "");
    }
}
