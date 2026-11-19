#![forbid(unsafe_code)]

pub mod bot_view;
pub mod bounded_cache;
pub mod classic_view;
pub mod commands;
mod composer;
pub mod leader_key;
pub mod markdown;
pub mod model_picker;
pub mod overlays;
mod resumed_view;
pub mod slash_menu;
pub mod table;
pub mod theme;
mod view;
pub mod wordmark;

pub use bot_view::{
    BotCardRow, BotMessageView, BotRowView, BotScreen, BotShellView, BotTaskRow, render_bot_shell,
    render_bot_shell_with_links,
};
pub use bounded_cache::{
    ByteBudgetLru, ByteSized, DISPLAY_PAGE_CACHE_BYTES, MARKDOWN_WRAP_CACHE_BYTES, ReadingAnchor,
    STREAMING_BUFFER_BYTES,
};
pub use classic_view::{
    ApprovalCard, ClassicMessage, ClassicView, ToolRowStatus, ToolTimelineRow, UserInputPrompt,
    render_classic, render_classic_with_links,
};
pub use commands::{
    BotSubView, CardNumbers, CardOperation, ClassicCommand, HistoryDirection, ProjectCommand,
    clip_bot_line, format_bot_when, parse_classic_command, parse_project_command,
};
pub use composer::{Action, Composer, Effect, MAX_DRAFT_BYTES, action_for_event};
pub use leader_key::{LeaderAction, LeaderKeyState};
pub use markdown::{
    LineLink, MAX_MARKDOWN_INPUT_BYTES, MAX_SCREEN_HYPERLINKS_PER_FRAME,
    MAX_WRAPPED_LINES_PER_ITEM, RenderedBlock, ScreenHyperlink, StyledLine, WrapCacheKey,
    render_markdown_bounded, render_markdown_themed, stable_hash,
};
pub use model_picker::{
    ModelPickerEvent, ModelPickerGroup, ModelPickerOption, ModelPickerState, render_model_picker,
    render_model_picker_dock,
};
pub use overlays::{
    ClassicOverlay, GoalPickerRow, McpPickerRow, OverlayContext, ResumeSessionRow, SkillPickerRow,
    render_classic_overlay,
};
pub use resumed_view::{ResumeView, render_resume};
pub use slash_menu::{
    BOT_SLASH_ITEMS, CLASSIC_SLASH_ITEMS, GoalMenuStatus, SlashFilterContext, SlashItem,
    filter_classic_slash_items, filter_slash_items, render_slash_menu,
};
pub use table::{TableAlignment, TableBorders, TableSpec, render_table_lines};
pub use theme::{
    DARK_PALETTE, LIGHT_PALETTE, RUNNING_ACTIVITY_LABEL, TOOL_DETAIL_PIPE, TOOL_GLYPH_CANCELLED,
    TOOL_GLYPH_COMPLETED, TOOL_GLYPH_FAILED, TOOL_GLYPH_RUNNING, TOOL_GLYPH_RUNNING_PULSE,
    TOOL_GLYPH_UNKNOWN, ThemeMode, ThemeScheme, TuiLocale, TuiPalette,
    WORKING_ANIMATION_INTERVAL_MS, activity_sweep_color, activity_sweep_intensity,
    blend_hsl_colors, compact_workspace_path, context_meter_parts, format_running_elapsed,
    format_tool_duration, format_topbar_quota, palette_for, subscription_quota_color,
    thinking_status_label,
};
pub use view::render;
pub use wordmark::{B3Variant, b3_wordmark_lines};

pub fn display_width(text: &str) -> usize {
    unicode_width::UnicodeWidthStr::width(text)
}

pub fn terminal_text(text: &str) -> String {
    text.chars()
        .filter(|c| {
            (!c.is_control() || matches!(c, '\n' | '\t'))
                && !matches!(*c, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}')
        })
        .collect()
}
