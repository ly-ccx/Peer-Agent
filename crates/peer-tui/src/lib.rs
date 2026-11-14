#![forbid(unsafe_code)]

mod composer;
mod view;

pub use composer::{Action, Composer, Effect, MAX_DRAFT_BYTES, action_for_event};
pub use view::render;

pub fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            (!c.is_control() || matches!(c, '\n' | '\t'))
                && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect()
}
