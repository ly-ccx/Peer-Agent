/**
 * 机器人界面快捷键。经典界面不走这里。
 * 搜索面板打开时，⌘1…⌘9 仍留给面板跳到结果，不切机器人。
 */
export type BotShortcut =
  | { readonly action: 'new-bot' }
  | { readonly action: 'list-search' }
  | { readonly action: 'toggle-profile' }
  | { readonly action: 'switch-bot'; readonly index: number }
  | null;

export function resolveBotShortcut(input: {
  key: string;
  meta: boolean;
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  palette: boolean;
  shell: 'bots' | 'classic';
}): BotShortcut {
  if (input.shell !== 'bots') return null;
  const key = input.key.toLowerCase();
  const command = input.meta || input.ctrl;
  if (!command || input.alt) return null;
  if (key === 'n' && !input.shift) return { action: 'new-bot' };
  if (key === 'f' && !input.shift) return { action: 'list-search' };
  if (key === 'p' && input.shift) return { action: 'toggle-profile' };
  if (!input.shift && /^[1-9]$/.test(key)) {
    if (input.palette) return null;
    return { action: 'switch-bot', index: Number(key) - 1 };
  }
  return null;
}

export const BOT_SHORTCUT_TABLE = [
  { combo: '⌘1…⌘9', action: '切到列表前 9 个机器人', note: '搜索面板打开时仍跳到第 N 条结果' },
  { combo: '⌘N', action: '新建机器人', note: '经典界面仍是新建任务' },
  { combo: '⌘⇧P', action: '开关当前机器人的档案', note: '设置里的快捷键表没有占用这个组合' },
  { combo: '⌘F', action: '聚焦机器人列表搜索', note: '经典界面仍是会话内查找' },
  { combo: '⌘K', action: '搜索机器人、消息、任务、记忆', note: '经典界面仍是搜索会话' },
  { combo: '⌘⇧N', action: '打开快速会话', note: '两种界面都保留' },
] as const;
