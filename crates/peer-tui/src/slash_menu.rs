//! Pure slash-command autocomplete menu rendered in Peer Frost terminal layer style.
//!
//! No borders/cards: a single `─` divider separates the prompt list from context,
//! with `› /cmd` highlighted in `palette.accent` and descriptions in `palette.muted`.

use crate::{
    commands::clip_bot_line,
    theme::{CARET_IDLE, CARET_SELECTED, SEPARATOR, TuiLocale, TuiPalette},
};
use ratatui::{
    Frame,
    layout::Rect,
    style::{Modifier, Style},
    text::{Line, Span},
    widgets::{Block, Paragraph},
};
use unicode_width::UnicodeWidthStr;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashItem {
    pub command: &'static str,
    pub desc_zh: &'static str,
    pub desc_en: &'static str,
}

impl SlashItem {
    pub const fn desc(&self, locale: TuiLocale) -> &'static str {
        if locale.is_zh() {
            self.desc_zh
        } else {
            self.desc_en
        }
    }
}

pub static BOT_SLASH_ITEMS: &[SlashItem] = &[
    SlashItem {
        command: "/bots",
        desc_zh: "切换机器人列表",
        desc_en: "Browse project bots",
    },
    SlashItem {
        command: "/tasks",
        desc_zh: "查看委派任务列表",
        desc_en: "List delegated tasks",
    },
    SlashItem {
        command: "/task ",
        desc_zh: "查看第 N 个任务详情与核验依据",
        desc_en: "Inspect task report (/task N)",
    },
    SlashItem {
        command: "/cards",
        desc_zh: "查看待处理卡片",
        desc_en: "View actionable cards",
    },
    SlashItem {
        command: "/approve ",
        desc_zh: "批准第 N 张卡片",
        desc_en: "Approve card N",
    },
    SlashItem {
        command: "/deny ",
        desc_zh: "拒绝第 N 张卡片",
        desc_en: "Deny card N",
    },
    SlashItem {
        command: "/answer ",
        desc_zh: "回答第 N 张提问卡片",
        desc_en: "Answer question card N",
    },
    SlashItem {
        command: "/memory",
        desc_zh: "查看项目记忆",
        desc_en: "View project memory",
    },
    SlashItem {
        command: "/objectives",
        desc_zh: "查看项目目标",
        desc_en: "View project objectives",
    },
    SlashItem {
        command: "/model",
        desc_zh: "打开模型选择器 (F3)",
        desc_en: "Open model picker (F3)",
    },
    SlashItem {
        command: "/theme ",
        desc_zh: "切换主题 (dark / light / system)",
        desc_en: "Switch theme (dark / light / system)",
    },
    SlashItem {
        command: "/language ",
        desc_zh: "切换语言 (zh-CN / en-US)",
        desc_en: "Switch language (zh-CN / en-US)",
    },
    SlashItem {
        command: "/takeover",
        desc_zh: "接管当前工作区宿主租约",
        desc_en: "Take over workspace host lease",
    },
    SlashItem {
        command: "/classic",
        desc_zh: "切换到普通任务对话模式 (F2)",
        desc_en: "Switch to ordinary task mode (F2)",
    },
    SlashItem {
        command: "/older",
        desc_zh: "加载更早历史消息",
        desc_en: "Load earlier messages",
    },
    SlashItem {
        command: "/latest",
        desc_zh: "回到最新消息",
        desc_en: "Jump to latest messages",
    },
    SlashItem {
        command: "/save-draft",
        desc_zh: "立即持久化草稿",
        desc_en: "Flush draft to disk",
    },
    SlashItem {
        command: "/help",
        desc_zh: "查看命令帮助",
        desc_en: "Show help",
    },
    SlashItem {
        command: "/quit",
        desc_zh: "退出终端",
        desc_en: "Exit Peer CLI",
    },
];

pub static CLASSIC_SLASH_ITEMS: &[SlashItem] = &[
    SlashItem {
        command: "/model",
        desc_zh: "打开模型选择器 (F3)",
        desc_en: "Open model picker (F3)",
    },
    SlashItem {
        command: "/mode ",
        desc_zh: "切换模式 (chat / plan / goal)",
        desc_en: "Switch mode (chat / plan / goal)",
    },
    SlashItem {
        command: "/access ",
        desc_zh: "切换权限策略 (ask / session / full)",
        desc_en: "Switch access policy (ask / session / full)",
    },
    SlashItem {
        command: "/theme ",
        desc_zh: "切换主题 (dark / light / system)",
        desc_en: "Switch theme (dark / light / system)",
    },
    SlashItem {
        command: "/language ",
        desc_zh: "切换语言 (zh-CN / en-US)",
        desc_en: "Switch language (zh-CN / en-US)",
    },
    SlashItem {
        command: "/bots",
        desc_zh: "切换到项目机器人列表 (F2)",
        desc_en: "Switch to project bots (F2)",
    },
    SlashItem {
        command: "/new",
        desc_zh: "开始新会话",
        desc_en: "Start a new conversation",
    },
    SlashItem {
        command: "/older",
        desc_zh: "加载更早历史",
        desc_en: "Load earlier page",
    },
    SlashItem {
        command: "/latest",
        desc_zh: "回到最新消息",
        desc_en: "Return to latest",
    },
    SlashItem {
        command: "/help",
        desc_zh: "查看帮助",
        desc_en: "Show help",
    },
    SlashItem {
        command: "/quit",
        desc_zh: "退出终端",
        desc_en: "Exit Peer CLI",
    },
];

/// Returns matching slash commands when the draft starts with `/` and has no whitespace yet.
pub fn filter_slash_items<'a>(draft: &str, items: &'a [SlashItem]) -> Vec<&'a SlashItem> {
    if !draft.starts_with('/') || draft.contains(char::is_whitespace) {
        return Vec::new();
    }
    let query = draft.to_ascii_lowercase();
    items
        .iter()
        .filter(|item| item.command.trim_end().starts_with(&query))
        .collect()
}

pub fn render_slash_menu(
    frame: &mut Frame<'_>,
    area: Rect,
    items: &[&SlashItem],
    selected: usize,
    locale: TuiLocale,
    palette: &TuiPalette,
) {
    if items.is_empty() || area.height < 2 || area.width < 12 {
        return;
    }
    frame.render_widget(
        Block::default().style(Style::new().bg(palette.background)),
        area,
    );
    let max_rows = usize::from(area.height.saturating_sub(1)).min(5);
    let selected = selected.min(items.len().saturating_sub(1));
    let start = selected.saturating_sub(max_rows.saturating_sub(1));
    let w = usize::from(area.width);

    let mut lines = Vec::with_capacity(max_rows + 1);
    lines.push(Line::styled(
        SEPARATOR.repeat(w),
        Style::new().fg(palette.border).bg(palette.background),
    ));

    let cmd_col_w = 16usize.min(w / 2);
    for (offset, item) in items.iter().skip(start).take(max_rows).enumerate() {
        let is_selected = start + offset == selected;
        let caret = if is_selected {
            CARET_SELECTED
        } else {
            CARET_IDLE
        };
        let cmd_text = item.command.trim_end();
        let pad = cmd_col_w.saturating_sub(cmd_text.width());
        let desc_budget = w.saturating_sub(2 + cmd_col_w + 2);
        let desc = clip_bot_line(item.desc(locale), desc_budget);

        let cmd_style = if is_selected {
            Style::new()
                .fg(palette.accent)
                .bg(palette.background)
                .add_modifier(Modifier::BOLD)
        } else {
            Style::new().fg(palette.text).bg(palette.background)
        };
        let desc_style = Style::new().fg(palette.muted).bg(palette.background);

        lines.push(Line::from(vec![
            Span::styled(caret, cmd_style),
            Span::styled(cmd_text.to_owned(), cmd_style),
            Span::styled(" ".repeat(pad + 2), Style::new().bg(palette.background)),
            Span::styled(desc, desc_style),
        ]));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_filter_matches_prefix_and_stops_after_space() {
        assert_eq!(
            filter_slash_items("/", CLASSIC_SLASH_ITEMS).len(),
            CLASSIC_SLASH_ITEMS.len()
        );
        let matched = filter_slash_items("/mo", CLASSIC_SLASH_ITEMS);
        assert!(matched.iter().any(|i| i.command == "/model"));
        assert!(matched.iter().any(|i| i.command == "/mode "));
        assert!(filter_slash_items("/mode chat", CLASSIC_SLASH_ITEMS).is_empty());
        assert!(filter_slash_items("hello", BOT_SLASH_ITEMS).is_empty());
    }
}
