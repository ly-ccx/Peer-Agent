//! Pure slash-command autocomplete menu rendered in Peer Frost terminal layer style.
//!
//! No borders/cards: a single `─` divider separates the prompt list from context,
//! with `› /cmd` highlighted in `palette.accent`, descriptions and right-aligned shortcuts in `palette.muted`.

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

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum GoalMenuStatus {
    #[default]
    None,
    Running,
    Paused,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SlashFilterContext {
    pub fast_available: bool,
    pub goal_status: GoalMenuStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SlashItem {
    pub command: &'static str,
    pub desc_zh: &'static str,
    pub desc_en: &'static str,
    pub keywords: &'static str,
    pub shortcut: &'static str,
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
        keywords: "list directory 机器人",
        shortcut: "",
    },
    SlashItem {
        command: "/tasks",
        desc_zh: "查看委派任务列表",
        desc_en: "List delegated tasks",
        keywords: "delegation work 任务",
        shortcut: "",
    },
    SlashItem {
        command: "/task ",
        desc_zh: "查看第 N 个任务详情与核验依据",
        desc_en: "Inspect task report (/task N)",
        keywords: "detail report 详情",
        shortcut: "",
    },
    SlashItem {
        command: "/result ",
        desc_zh: "查看第 N 个任务交付结果",
        desc_en: "Inspect task result (/result N)",
        keywords: "artifact output 结果",
        shortcut: "",
    },
    SlashItem {
        command: "/cards",
        desc_zh: "查看待处理卡片",
        desc_en: "View actionable cards",
        keywords: "approval question 卡片",
        shortcut: "",
    },
    SlashItem {
        command: "/approve ",
        desc_zh: "批准第 N 张卡片",
        desc_en: "Approve card N",
        keywords: "allow yes 批准",
        shortcut: "",
    },
    SlashItem {
        command: "/deny ",
        desc_zh: "拒绝第 N 张卡片",
        desc_en: "Deny card N",
        keywords: "reject no 拒绝",
        shortcut: "",
    },
    SlashItem {
        command: "/answer ",
        desc_zh: "回答第 N 张提问卡片",
        desc_en: "Answer question card N",
        keywords: "reply 回答",
        shortcut: "",
    },
    SlashItem {
        command: "/action ",
        desc_zh: "执行第 N 张卡片的第 M 个动作 (/action N M)",
        desc_en: "Trigger action M on card N",
        keywords: "card 动作",
        shortcut: "",
    },
    SlashItem {
        command: "/retry-input ",
        desc_zh: "重试失败的用户输入 (/retry-input ID)",
        desc_en: "Retry failed input by ID",
        keywords: "retry 重试",
        shortcut: "",
    },
    SlashItem {
        command: "/memory",
        desc_zh: "查看项目记忆",
        desc_en: "View project memory",
        keywords: "memory facts 记忆",
        shortcut: "",
    },
    SlashItem {
        command: "/objectives",
        desc_zh: "查看项目目标",
        desc_en: "View project objectives",
        keywords: "goal objectives 目标",
        shortcut: "",
    },
    SlashItem {
        command: "/diagnostics",
        desc_zh: "查看机器人运行诊断信息",
        desc_en: "View bot runtime diagnostics",
        keywords: "diag health lease 诊断",
        shortcut: "",
    },
    SlashItem {
        command: "/model",
        desc_zh: "打开模型选择器 (F3)",
        desc_en: "Open model picker (F3)",
        keywords: "llm provider 模型",
        shortcut: "F3",
    },
    SlashItem {
        command: "/theme",
        desc_zh: "打开主题选择器或直接传 dark / light / system",
        desc_en: "Open theme picker (dark / light / system)",
        keywords: "appearance color frost 主题 深色 浅色",
        shortcut: "",
    },
    SlashItem {
        command: "/language",
        desc_zh: "打开语言选择器或直接传 zh-CN / en-US",
        desc_en: "Open language picker (zh-CN / en-US)",
        keywords: "locale lang 中文 english 语言",
        shortcut: "",
    },
    SlashItem {
        command: "/takeover",
        desc_zh: "接管当前工作区宿主租约",
        desc_en: "Take over workspace host lease",
        keywords: "lease host 接管",
        shortcut: "",
    },
    SlashItem {
        command: "/classic",
        desc_zh: "切换到普通任务对话模式 (F2)",
        desc_en: "Switch to ordinary task mode (F2)",
        keywords: "ordinary chat 普通",
        shortcut: "F2",
    },
    SlashItem {
        command: "/older",
        desc_zh: "加载更早历史消息",
        desc_en: "Load earlier messages",
        keywords: "history 历史",
        shortcut: "",
    },
    SlashItem {
        command: "/latest",
        desc_zh: "回到最新消息",
        desc_en: "Jump to latest messages",
        keywords: "bottom 最新",
        shortcut: "",
    },
    SlashItem {
        command: "/save-draft",
        desc_zh: "立即持久化草稿",
        desc_en: "Flush draft to disk",
        keywords: "draft 草稿",
        shortcut: "",
    },
    SlashItem {
        command: "/version",
        desc_zh: "查看 Peer CLI 版本",
        desc_en: "Show Peer CLI version",
        keywords: "release build 版本",
        shortcut: "",
    },
    SlashItem {
        command: "/help",
        desc_zh: "查看命令帮助",
        desc_en: "Show help",
        keywords: "shortcuts keys 帮助",
        shortcut: "",
    },
    SlashItem {
        command: "/quit",
        desc_zh: "退出终端",
        desc_en: "Exit Peer CLI",
        keywords: "exit 退出",
        shortcut: "",
    },
];

pub static CLASSIC_SLASH_ITEMS: &[SlashItem] = &[
    SlashItem {
        command: "/model",
        desc_zh: "选择模型与推理深度",
        desc_en: "Choose model and reasoning effort",
        keywords: "provider llm effort 模型",
        shortcut: "Ctrl+X M",
    },
    SlashItem {
        command: "/mode",
        desc_zh: "切换运行模式 (Agent / Plan)",
        desc_en: "Choose Agent or Plan",
        keywords: "agent chat plan goal 模式",
        shortcut: "Ctrl+X O",
    },
    SlashItem {
        command: "/fast",
        desc_zh: "开关优先加速模式 (ChatGPT/Grok OAuth)",
        desc_en: "Toggle Fast (priority) for this session",
        keywords: "priority service_tier speed oauth 加速",
        shortcut: "",
    },
    SlashItem {
        command: "/permissions",
        desc_zh: "切换会话权限策略 (ask / session / full)",
        desc_en: "Choose session permission policy",
        keywords: "access approval ask full 权限",
        shortcut: "Ctrl+X P",
    },
    SlashItem {
        command: "/language",
        desc_zh: "切换界面与模型回复语言",
        desc_en: "Switch UI and model reply language",
        keywords: "locale lang zh en 中文 english 语言",
        shortcut: "",
    },
    SlashItem {
        command: "/theme",
        desc_zh: "切换 Peer Frost 深浅主题",
        desc_en: "Switch light / dark / system theme",
        keywords: "appearance light dark system frost 主题 白 黑 浅色 深色",
        shortcut: "",
    },
    SlashItem {
        command: "/skill",
        desc_zh: "浏览、启用/停用、刷新或插入 Skills",
        desc_en: "Browse, toggle, refresh, or insert Skills",
        keywords: "skills capability 技能",
        shortcut: "",
    },
    SlashItem {
        command: "/mcp",
        desc_zh: "管理 MCP Servers 与查看工具状态",
        desc_en: "Manage MCP Servers and inspect tool status",
        keywords: "server tools capability mcp",
        shortcut: "",
    },
    SlashItem {
        command: "/new",
        desc_zh: "开始新任务并返回欢迎页",
        desc_en: "Start a fresh empty task",
        keywords: "session task home fresh reset create 新建",
        shortcut: "Ctrl+X N",
    },
    SlashItem {
        command: "/clear",
        desc_zh: "清空当前对话并开启新会话",
        desc_en: "Clear chat and start a new conversation",
        keywords: "reset conversation error 清空",
        shortcut: "",
    },
    SlashItem {
        command: "/compact",
        desc_zh: "使用结构化摘要压缩模型上下文",
        desc_en: "Compress model context with structural summary",
        keywords: "compress summary context tokens 压缩 摘要",
        shortcut: "",
    },
    SlashItem {
        command: "/history",
        desc_zh: "浏览压缩前的更早历史 (/history later|latest)",
        desc_en: "Browse compacted history (/history later|latest)",
        keywords: "older previous earlier later latest archive 历史",
        shortcut: "",
    },
    SlashItem {
        command: "/resume",
        desc_zh: "恢复并继续已保存的历史会话",
        desc_en: "Restore and continue a saved conversation",
        keywords: "session conversation history restore 恢复 会话",
        shortcut: "Ctrl+X L",
    },
    SlashItem {
        command: "/goals",
        desc_zh: "查看或切换本会话中的正式目标",
        desc_en: "Switch between formal goals in this session",
        keywords: "goal mission history switch 目标",
        shortcut: "",
    },
    SlashItem {
        command: "/goal-pause",
        desc_zh: "停止当前推进中的目标",
        desc_en: "Pause the active goal",
        keywords: "hold pause 暂停 目标",
        shortcut: "",
    },
    SlashItem {
        command: "/goal-resume",
        desc_zh: "继续已暂停的目标",
        desc_en: "Resume the paused goal",
        keywords: "continue resume 继续 目标",
        shortcut: "",
    },
    SlashItem {
        command: "/goal-cancel",
        desc_zh: "取消当前活跃目标",
        desc_en: "Cancel the active goal",
        keywords: "stop abort cancel 取消 目标",
        shortcut: "",
    },
    SlashItem {
        command: "/bots",
        desc_zh: "切换到项目机器人列表",
        desc_en: "Switch to project bots",
        keywords: "project bot 机器人",
        shortcut: "F2",
    },
    SlashItem {
        command: "/help",
        desc_zh: "查看快捷键与斜杠命令说明",
        desc_en: "Show keyboard shortcuts and commands",
        keywords: "keys shortcuts 帮助",
        shortcut: "",
    },
    SlashItem {
        command: "/version",
        desc_zh: "显示 Peer Agent CLI 版本号",
        desc_en: "Show Peer Agent CLI version",
        keywords: "release build update 版本",
        shortcut: "",
    },
    SlashItem {
        command: "/quit",
        desc_zh: "退出终端",
        desc_en: "Exit Peer CLI",
        keywords: "exit 退出",
        shortcut: "",
    },
];

pub fn classic_item_visible(item: &SlashItem, ctx: SlashFilterContext) -> bool {
    match item.command.trim_end() {
        "/fast" => ctx.fast_available,
        "/goal-pause" => ctx.goal_status == GoalMenuStatus::Running,
        "/goal-resume" => ctx.goal_status == GoalMenuStatus::Paused,
        "/goal-cancel" => ctx.goal_status != GoalMenuStatus::None,
        _ => true,
    }
}

fn filter_items<'a>(
    draft: &str,
    items: &'a [SlashItem],
    predicate: impl Fn(&SlashItem) -> bool,
) -> Vec<&'a SlashItem> {
    if !draft.starts_with('/') || draft.contains(char::is_whitespace) {
        return Vec::new();
    }
    let query_full = draft.to_ascii_lowercase();
    let term = query_full.trim_start_matches('/');
    let mut exact_hits = Vec::new();
    let mut prefix_hits = Vec::new();
    let mut fuzzy_hits = Vec::new();
    for item in items {
        if !predicate(item) {
            continue;
        }
        let cmd = item.command.trim_end();
        if cmd == query_full {
            exact_hits.push(item);
        } else if cmd.starts_with(&query_full) {
            prefix_hits.push(item);
        } else if !term.is_empty()
            && (cmd.contains(term)
                || item.desc_en.to_ascii_lowercase().contains(term)
                || item.desc_zh.contains(term)
                || item.keywords.to_ascii_lowercase().contains(term))
        {
            fuzzy_hits.push(item);
        }
    }
    exact_hits.extend(prefix_hits);
    exact_hits.extend(fuzzy_hits);
    exact_hits
}

/// Returns matching slash commands when the draft starts with `/` and has no whitespace yet.
pub fn filter_slash_items<'a>(draft: &str, items: &'a [SlashItem]) -> Vec<&'a SlashItem> {
    filter_items(draft, items, |_| true)
}

/// Returns visible Classic slash commands filtered by prefix or keywords/description.
pub fn filter_classic_slash_items(draft: &str, ctx: SlashFilterContext) -> Vec<&'static SlashItem> {
    filter_items(draft, CLASSIC_SLASH_ITEMS, |item| {
        classic_item_visible(item, ctx)
    })
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
    let max_rows = usize::from(area.height.saturating_sub(1)).min(6);
    let selected = selected.min(items.len().saturating_sub(1));
    let start = selected.saturating_sub(max_rows.saturating_sub(1));
    let w = usize::from(area.width);

    let mut lines = Vec::with_capacity(max_rows + 1);
    lines.push(Line::styled(
        SEPARATOR.repeat(w),
        Style::new().fg(palette.border).bg(palette.background),
    ));

    let cmd_col_w = 15usize.min(w / 2);
    for (offset, item) in items.iter().skip(start).take(max_rows).enumerate() {
        let is_selected = start + offset == selected;
        let caret = if is_selected {
            CARET_SELECTED
        } else {
            CARET_IDLE
        };
        let cmd_text = item.command.trim_end();
        let pad = cmd_col_w.saturating_sub(cmd_text.width());
        let sc = if !item.shortcut.is_empty() && w >= 48 {
            item.shortcut
        } else {
            ""
        };
        let sc_reserve = if sc.is_empty() { 0 } else { sc.width() + 2 };
        let desc_budget = w.saturating_sub(2 + cmd_col_w + 2 + sc_reserve);
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

        let mut spans = vec![
            Span::styled(caret, cmd_style),
            Span::styled(cmd_text.to_owned(), cmd_style),
            Span::styled(" ".repeat(pad + 2), Style::new().bg(palette.background)),
            Span::styled(desc.clone(), desc_style),
        ];
        if !sc.is_empty() {
            let used = 2 + cmd_col_w + 2 + desc.width();
            let gap = w.saturating_sub(used + sc.width());
            if gap >= 2 {
                spans.push(Span::styled(
                    " ".repeat(gap),
                    Style::new().bg(palette.background),
                ));
                spans.push(Span::styled(sc, desc_style));
            }
        }
        lines.push(Line::from(spans));
    }
    frame.render_widget(Paragraph::new(lines), area);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slash_filter_matches_prefix_keywords_and_dynamic_visibility() {
        let ctx_off = SlashFilterContext::default();
        let all_hidden_ctx = filter_classic_slash_items("/", ctx_off);
        assert!(all_hidden_ctx.iter().all(|i| i.command != "/fast"));
        assert!(
            all_hidden_ctx
                .iter()
                .all(|i| !i.command.starts_with("/goal-"))
        );
        assert!(all_hidden_ctx.iter().any(|i| i.command == "/resume"));

        let ctx_on = SlashFilterContext {
            fast_available: true,
            goal_status: GoalMenuStatus::Paused,
        };
        let paused_items = filter_classic_slash_items("/", ctx_on);
        assert!(paused_items.iter().any(|i| i.command == "/fast"));
        assert!(paused_items.iter().any(|i| i.command == "/goal-resume"));
        assert!(paused_items.iter().any(|i| i.command == "/goal-cancel"));
        assert!(paused_items.iter().all(|i| i.command != "/goal-pause"));

        let restore = filter_classic_slash_items("/restore", ctx_off);
        assert_eq!(restore.first().map(|i| i.command), Some("/resume"));
        assert_eq!(
            filter_classic_slash_items("/mode", ctx_off)
                .first()
                .map(|i| i.command),
            Some("/mode")
        );
        assert_eq!(
            filter_classic_slash_items("/model", ctx_off)
                .first()
                .map(|i| i.command),
            Some("/model")
        );
        assert_eq!(
            filter_slash_items("/task", BOT_SLASH_ITEMS)
                .first()
                .map(|i| i.command),
            Some("/task ")
        );

        assert!(filter_slash_items("/mode chat", CLASSIC_SLASH_ITEMS).is_empty());
        assert!(filter_slash_items("hello", BOT_SLASH_ITEMS).is_empty());
    }
}
