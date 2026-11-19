#![forbid(unsafe_code)]

pub mod bot_view;
pub mod bounded_cache;
pub mod classic_view;
pub mod commands;
mod composer;
pub mod markdown;
pub mod model_picker;
mod resumed_view;
mod view;

pub use bot_view::{
    BotCardRow, BotMessageView, BotRowView, BotScreen, BotShellView, BotTaskRow, render_bot_shell,
};
pub use bounded_cache::{
    ByteBudgetLru, ByteSized, DISPLAY_PAGE_CACHE_BYTES, MARKDOWN_WRAP_CACHE_BYTES, ReadingAnchor,
    STREAMING_BUFFER_BYTES,
};
pub use classic_view::{ClassicMessage, ClassicView, render_classic};
pub use commands::{
    BotSubView, CardNumbers, CardOperation, ClassicCommand, ProjectCommand, clip_bot_line,
    format_bot_when, parse_classic_command, parse_project_command,
};
pub use composer::{Action, Composer, Effect, MAX_DRAFT_BYTES, action_for_event};
pub use markdown::{
    MAX_MARKDOWN_INPUT_BYTES, MAX_WRAPPED_LINES_PER_ITEM, RenderedBlock, StyledLine, WrapCacheKey,
    render_markdown_bounded, stable_hash,
};
pub use model_picker::{
    ModelPickerEvent, ModelPickerGroup, ModelPickerOption, ModelPickerState, render_model_picker,
};
pub use resumed_view::{ResumeView, render_resume};
pub use view::render;

pub fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            (!c.is_control() || matches!(c, '\n' | '\t'))
                && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect()
}
