//! Pure command parser, monotonic card numbering, and ADR 122 text formatters.
//!
//! Mirrors `apps/tui/src/project-agent/commands.ts` and `bot-list-format.ts`.

use crate::terminal_text;
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum BotSubView {
    Bots,
    Tasks,
    Memory,
    Objectives,
    Cards,
    Diagnostics,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CardOperation {
    Approve,
    Deny,
    Answer,
    Action { option: usize },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProjectCommand {
    Text(String),
    RetryInput(String),
    SaveDraft,
    View(BotSubView),
    Task(usize),
    Result(usize),
    Card {
        operation: CardOperation,
        number: usize,
        text: String,
    },
    Takeover,
    Classic,
    Model,
    Theme(Option<String>),
    Language(Option<String>),
    Older,
    Latest,
    Help,
    Version,
    Quit,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryDirection {
    Earlier,
    Later,
    Latest,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ClassicCommand {
    Text(String),
    Bots,
    NewSession,
    Clear,
    Compact,
    Model,
    Mode(Option<String>),
    Permissions(Option<String>),
    Fast,
    Theme(Option<String>),
    Language(Option<String>),
    Skill,
    Mcp,
    Resume(Option<String>),
    History(HistoryDirection),
    Goals,
    GoalPause,
    GoalResume,
    GoalCancel,
    Help,
    Version,
    Quit,
    Invalid,
}

fn is_valid_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 128
        && bytes[0].is_ascii_alphanumeric()
        && bytes[1..]
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'.' | b':' | b'-'))
}

fn parse_positive_index(raw: &str, max_digits: usize) -> Option<usize> {
    let bytes = raw.as_bytes();
    if bytes.is_empty()
        || bytes.len() > max_digits
        || !matches!(bytes[0], b'1'..=b'9')
        || !bytes.iter().all(u8::is_ascii_digit)
    {
        return None;
    }
    raw.parse::<usize>().ok()
}

pub fn parse_project_command(input: &str) -> ProjectCommand {
    let text = input.trim();
    if !text.starts_with('/') {
        return ProjectCommand::Text(text.to_owned());
    }
    let mut parts = text[1..].split_whitespace();
    let Some(name) = parts.next() else {
        return ProjectCommand::Invalid;
    };
    let args: Vec<&str> = parts.collect();
    if args.is_empty() {
        return match name {
            "bots" => ProjectCommand::View(BotSubView::Bots),
            "tasks" => ProjectCommand::View(BotSubView::Tasks),
            "memory" => ProjectCommand::View(BotSubView::Memory),
            "objectives" => ProjectCommand::View(BotSubView::Objectives),
            "cards" => ProjectCommand::View(BotSubView::Cards),
            "diagnostics" => ProjectCommand::View(BotSubView::Diagnostics),
            "takeover" => ProjectCommand::Takeover,
            "classic" => ProjectCommand::Classic,
            "model" => ProjectCommand::Model,
            "theme" => ProjectCommand::Theme(None),
            "language" | "lang" => ProjectCommand::Language(None),
            "older" => ProjectCommand::Older,
            "latest" => ProjectCommand::Latest,
            "help" => ProjectCommand::Help,
            "version" => ProjectCommand::Version,
            "quit" | "exit" => ProjectCommand::Quit,
            "save-draft" => ProjectCommand::SaveDraft,
            _ => ProjectCommand::Invalid,
        };
    }
    if name == "theme" && args.len() == 1 {
        return ProjectCommand::Theme(Some(args[0].to_owned()));
    }
    if matches!(name, "language" | "lang") && args.len() == 1 {
        return ProjectCommand::Language(Some(args[0].to_owned()));
    }
    if name == "retry-input" && args.len() == 1 && is_valid_id(args[0]) {
        return ProjectCommand::RetryInput(args[0].to_owned());
    }
    let Some(number) = parse_positive_index(args[0], 6) else {
        return ProjectCommand::Invalid;
    };
    match name {
        "task" if args.len() == 1 => ProjectCommand::Task(number),
        "result" if args.len() == 1 => ProjectCommand::Result(number),
        "approve" if args.len() == 1 => ProjectCommand::Card {
            operation: CardOperation::Approve,
            number,
            text: String::new(),
        },
        "deny" if args.len() == 1 => ProjectCommand::Card {
            operation: CardOperation::Deny,
            number,
            text: String::new(),
        },
        "answer" if args.len() >= 2 => {
            let answer_text = args[1..].join(" ");
            if answer_text.trim().is_empty() {
                ProjectCommand::Invalid
            } else {
                ProjectCommand::Card {
                    operation: CardOperation::Answer,
                    number,
                    text: answer_text,
                }
            }
        }
        "action" if args.len() == 2 => {
            if let Some(option) = parse_positive_index(args[1], 4) {
                ProjectCommand::Card {
                    operation: CardOperation::Action { option },
                    number,
                    text: String::new(),
                }
            } else {
                ProjectCommand::Invalid
            }
        }
        _ => ProjectCommand::Invalid,
    }
}

pub fn parse_classic_command(input: &str) -> ClassicCommand {
    let text = input.trim();
    if !text.starts_with('/') {
        return ClassicCommand::Text(text.to_owned());
    }
    let mut parts = text[1..].split_whitespace();
    let Some(raw_name) = parts.next() else {
        return ClassicCommand::Invalid;
    };
    let name = raw_name.to_ascii_lowercase();
    let args: Vec<&str> = parts.collect();
    if args.is_empty() {
        return match name.as_str() {
            "bots" => ClassicCommand::Bots,
            "new" => ClassicCommand::NewSession,
            "clear" => ClassicCommand::Clear,
            "compact" => ClassicCommand::Compact,
            "model" => ClassicCommand::Model,
            "mode" => ClassicCommand::Mode(None),
            "permissions" | "permission" | "access" => ClassicCommand::Permissions(None),
            "fast" => ClassicCommand::Fast,
            "theme" => ClassicCommand::Theme(None),
            "language" | "lang" => ClassicCommand::Language(None),
            "skill" | "skills" => ClassicCommand::Skill,
            "mcp" => ClassicCommand::Mcp,
            "resume" => ClassicCommand::Resume(None),
            "history" | "older" => ClassicCommand::History(HistoryDirection::Earlier),
            "latest" => ClassicCommand::History(HistoryDirection::Latest),
            "goals" | "goal" => ClassicCommand::Goals,
            "goal-pause" => ClassicCommand::GoalPause,
            "goal-resume" => ClassicCommand::GoalResume,
            "goal-cancel" => ClassicCommand::GoalCancel,
            "help" => ClassicCommand::Help,
            "version" => ClassicCommand::Version,
            "quit" | "exit" => ClassicCommand::Quit,
            _ => ClassicCommand::Invalid,
        };
    }
    if args.len() != 1 {
        return ClassicCommand::Invalid;
    }
    let arg_lc = args[0].to_ascii_lowercase();
    match name.as_str() {
        "mode" => match arg_lc.as_str() {
            "chat" | "agent" => ClassicCommand::Mode(Some("chat".into())),
            "plan" => ClassicCommand::Mode(Some("plan".into())),
            "goal" => ClassicCommand::Mode(Some("goal".into())),
            _ => ClassicCommand::Invalid,
        },
        "access" | "permissions" | "permission" => match arg_lc.as_str() {
            "ask" => ClassicCommand::Permissions(Some("ask".into())),
            "session" | "approve" => ClassicCommand::Permissions(Some("session".into())),
            "full" => ClassicCommand::Permissions(Some("full".into())),
            _ => ClassicCommand::Invalid,
        },
        "theme" => ClassicCommand::Theme(Some(args[0].to_owned())),
        "language" | "lang" => ClassicCommand::Language(Some(args[0].to_owned())),
        "resume" if is_valid_id(args[0]) => ClassicCommand::Resume(Some(args[0].to_owned())),
        "history" => match arg_lc.as_str() {
            "earlier" | "older" => ClassicCommand::History(HistoryDirection::Earlier),
            "later" | "newer" => ClassicCommand::History(HistoryDirection::Later),
            "latest" => ClassicCommand::History(HistoryDirection::Latest),
            _ => ClassicCommand::Invalid,
        },
        _ => ClassicCommand::Invalid,
    }
}

/// Workspace-scoped monotonic card numbers (never reused within one workspace even after a card resolves).
#[derive(Debug, Default)]
pub struct CardNumbers {
    workspace_id: String,
    next: usize,
    assigned: HashMap<String, usize>,
}

impl CardNumbers {
    pub fn assign(&mut self, workspace_id: &str, card_id: &str) -> usize {
        if self.workspace_id != workspace_id {
            self.workspace_id = workspace_id.to_owned();
            self.assigned.clear();
            self.next = 1;
        }
        if let Some(&n) = self.assigned.get(card_id) {
            return n;
        }
        let n = self.next.max(1);
        self.next = n + 1;
        self.assigned.insert(card_id.to_owned(), n);
        n
    }
}

/// ADR 122 §1: collapse whitespace and clip by display columns with `…`.
pub fn clip_bot_line(value: &str, max_columns: usize) -> String {
    let cleaned = terminal_text(value);
    let collapsed: String = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    if max_columns == 0 {
        return String::new();
    }
    if collapsed.width() <= max_columns {
        return collapsed;
    }
    if max_columns == 1 {
        return "…".to_owned();
    }
    let mut out = String::new();
    let mut cols = 0usize;
    let limit = max_columns - 1;
    for g in collapsed.graphemes(true) {
        let gw = g.width();
        if cols + gw > limit {
            break;
        }
        out.push_str(g);
        cols += gw;
    }
    while out.ends_with(' ') {
        out.pop();
    }
    out.push('…');
    out
}

/// ADR 122 §1: `2026-11-05T12:36:10.000Z` -> `11-05 12:36` without timezone conversion.
/// Unrecognized values stay clipped to 16 columns on a single line.
pub fn format_bot_when(value: &str) -> String {
    let trimmed = value.trim();
    let bytes = trimmed.as_bytes();
    if bytes.len() >= 16
        && bytes[0..4].iter().all(u8::is_ascii_digit)
        && bytes[4] == b'-'
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[7] == b'-'
        && bytes[8..10].iter().all(u8::is_ascii_digit)
        && matches!(bytes[10], b'T' | b' ')
        && bytes[11..13].iter().all(u8::is_ascii_digit)
        && bytes[13] == b':'
        && bytes[14..16].iter().all(u8::is_ascii_digit)
    {
        return format!("{} {}", &trimmed[5..10], &trimmed[11..16]);
    }
    clip_bot_line(trimmed, 16)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bot_when_and_clip_match_adr_122() {
        assert_eq!(format_bot_when("2026-11-05T12:36:10.000Z"), "11-05 12:36");
        assert_eq!(format_bot_when("2026-01-09 08:04:00"), "01-09 08:04");
        assert_eq!(format_bot_when("刚刚"), "刚刚");
        assert_eq!(clip_bot_line("你好世界测试", 7), "你好世…");
        assert_eq!(clip_bot_line("a\n\tb   c", 20), "a b c");
    }

    #[test]
    fn command_parser_matches_ts_commands_contract() {
        assert_eq!(
            parse_project_command("/bots"),
            ProjectCommand::View(BotSubView::Bots)
        );
        assert_eq!(parse_project_command("/classic"), ProjectCommand::Classic);
        assert_eq!(
            parse_project_command("/save-draft"),
            ProjectCommand::SaveDraft
        );
        assert_eq!(
            parse_project_command("/approve 2"),
            ProjectCommand::Card {
                operation: CardOperation::Approve,
                number: 2,
                text: String::new(),
            }
        );
        assert_eq!(
            parse_project_command("/answer 3 yes please"),
            ProjectCommand::Card {
                operation: CardOperation::Answer,
                number: 3,
                text: "yes please".into(),
            }
        );
        assert_eq!(parse_project_command("/task 0"), ProjectCommand::Invalid);
        assert_eq!(
            parse_project_command("/theme light"),
            ProjectCommand::Theme(Some("light".into()))
        );
        assert_eq!(
            parse_project_command("/language en-US"),
            ProjectCommand::Language(Some("en-US".into()))
        );
        assert_eq!(
            parse_classic_command("/theme system"),
            ClassicCommand::Theme(Some("system".into()))
        );
        assert_eq!(
            parse_classic_command("/language zh"),
            ClassicCommand::Language(Some("zh".into()))
        );
        assert_eq!(
            parse_classic_command("/resume"),
            ClassicCommand::Resume(None)
        );
        assert_eq!(
            parse_classic_command("/resume sess-1"),
            ClassicCommand::Resume(Some("sess-1".into()))
        );
        assert_eq!(parse_classic_command("/mode"), ClassicCommand::Mode(None));
        assert_eq!(
            parse_classic_command("/mode agent"),
            ClassicCommand::Mode(Some("chat".into()))
        );
        assert_eq!(
            parse_classic_command("/permissions"),
            ClassicCommand::Permissions(None)
        );
        assert_eq!(
            parse_classic_command("/access approve"),
            ClassicCommand::Permissions(Some("session".into()))
        );
        assert_eq!(parse_classic_command("/fast"), ClassicCommand::Fast);
        assert_eq!(parse_classic_command("/skill"), ClassicCommand::Skill);
        assert_eq!(parse_classic_command("/mcp"), ClassicCommand::Mcp);
        assert_eq!(parse_classic_command("/clear"), ClassicCommand::Clear);
        assert_eq!(parse_classic_command("/compact"), ClassicCommand::Compact);
        assert_eq!(
            parse_classic_command("/history later"),
            ClassicCommand::History(HistoryDirection::Later)
        );
        assert_eq!(parse_classic_command("/goals"), ClassicCommand::Goals);
        assert_eq!(
            parse_classic_command("/goal-pause"),
            ClassicCommand::GoalPause
        );
        assert_eq!(
            parse_classic_command("/goal-resume"),
            ClassicCommand::GoalResume
        );
        assert_eq!(
            parse_classic_command("/goal-cancel"),
            ClassicCommand::GoalCancel
        );
        assert_eq!(parse_classic_command("/version"), ClassicCommand::Version);
        assert_eq!(parse_project_command("/version"), ProjectCommand::Version);
        assert_eq!(
            parse_project_command("hello world"),
            ProjectCommand::Text("hello world".into())
        );
    }

    #[test]
    fn card_numbers_never_reuse_within_workspace() {
        let mut nums = CardNumbers::default();
        assert_eq!(nums.assign("ws-1", "c-a"), 1);
        assert_eq!(nums.assign("ws-1", "c-b"), 2);
        assert_eq!(nums.assign("ws-1", "c-a"), 1);
        assert_eq!(nums.assign("ws-2", "c-x"), 1);
    }
}
