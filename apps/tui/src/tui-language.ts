import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type TuiLocale = 'zh-CN' | 'en-US';

export interface TuiLanguageOption {
  readonly locale: TuiLocale;
  readonly label: string;
  readonly description: string;
  readonly shortcut: string;
}

export interface TuiLanguageState {
  readonly locale: TuiLocale;
  readonly replyLanguage: TuiLocale;
}

export interface TuiLanguageStore {
  getState(): TuiLanguageState;
  getLocale(): TuiLocale;
  getReplyLanguage(): TuiLocale;
  setLocale(value: unknown): TuiLanguageState;
  setLanguage(locale: TuiLocale): TuiLanguageState;
}

export const TUI_LANGUAGE_OPTIONS: readonly TuiLanguageOption[] = Object.freeze([
  {
    locale: 'zh-CN',
    label: '中文',
    description: '界面与模型回复均使用中文',
    shortcut: '1',
  },
  {
    locale: 'en-US',
    label: 'English',
    description: 'UI and model replies in English',
    shortcut: '2',
  },
]);

const REPLY_LANGUAGE_INSTRUCTIONS: Readonly<Record<TuiLocale, string>> = Object.freeze({
  'zh-CN': '请始终使用简体中文回复用户。',
  'en-US': 'Always reply to the user in English.',
});

const BASE_SYSTEM_PROMPT =
  'You are Peer Agent. Use the available governed tools when they help answer the user.';

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function normalizeTuiLocale(value: unknown, fallback: TuiLocale = 'zh-CN'): TuiLocale {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'zh' || normalized === 'zh-cn' || normalized === 'zh_cn' || normalized.startsWith('zh')) {
    return 'zh-CN';
  }
  if (normalized === 'en' || normalized === 'en-us' || normalized === 'en_us' || normalized.startsWith('en')) {
    return 'en-US';
  }
  return fallback;
}

export function languageOption(locale: TuiLocale): TuiLanguageOption {
  return TUI_LANGUAGE_OPTIONS.find((option) => option.locale === locale) ?? TUI_LANGUAGE_OPTIONS[0]!;
}

export function languageIndex(locale: TuiLocale): number {
  const index = TUI_LANGUAGE_OPTIONS.findIndex((option) => option.locale === locale);
  return index >= 0 ? index : 0;
}

export function buildReplyLanguageInstruction(replyLanguage: string | null | undefined): string | null {
  const locale = normalizeTuiLocale(replyLanguage, 'zh-CN');
  if (!replyLanguage || String(replyLanguage).trim() === '' || String(replyLanguage).trim().toLowerCase() === 'auto') {
    return null;
  }
  // Only emit when the value normalizes to a supported explicit locale.
  const raw = String(replyLanguage).trim().toLowerCase();
  if (raw === 'auto') return null;
  if (!(locale in REPLY_LANGUAGE_INSTRUCTIONS)) return null;
  // Unknown free-form values that don't look like zh/en stay out.
  if (!raw.startsWith('zh') && !raw.startsWith('en')) return null;
  return REPLY_LANGUAGE_INSTRUCTIONS[locale];
}

export function buildTuiSystemPrompt(
  replyLanguage: string | null | undefined,
  contextExtensions: readonly string[] = [],
): string {
  const instruction = buildReplyLanguageInstruction(replyLanguage);
  return [BASE_SYSTEM_PROMPT, instruction, ...contextExtensions]
    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
    .join('\n\n');
}

export function createTuiLanguageStore({
  userDataPath,
}: {
  readonly userDataPath: string;
}): TuiLanguageStore {
  const settingsFile = path.join(userDataPath, 'settings.json');

  const readSettings = (): Record<string, unknown> => {
    if (!existsSync(settingsFile)) return {};
    try {
      const parsed = JSON.parse(readFileSync(settingsFile, 'utf8')) as unknown;
      return isObjectRecord(parsed) ? parsed : {};
    } catch {
      return {};
    }
  };

  const writeSettings = (next: Record<string, unknown>): void => {
    mkdirSync(userDataPath, { recursive: true });
    writeFileSync(settingsFile, JSON.stringify(next, null, 2), 'utf8');
  };

  const readState = (): TuiLanguageState => {
    const settings = readSettings();
    const locale = normalizeTuiLocale(settings.locale, 'zh-CN');
    // Desktop may keep replyLanguage independent; /language keeps them paired.
    const replyLanguage = normalizeTuiLocale(
      settings.replyLanguage && String(settings.replyLanguage).trim().toLowerCase() !== 'auto'
        ? settings.replyLanguage
        : locale,
      locale,
    );
    return { locale, replyLanguage };
  };

  return {
    getState: readState,
    getLocale: () => readState().locale,
    getReplyLanguage: () => readState().replyLanguage,
    setLocale(value) {
      const locale = normalizeTuiLocale(value, readState().locale);
      return this.setLanguage(locale);
    },
    setLanguage(locale) {
      const nextLocale = normalizeTuiLocale(locale, 'zh-CN');
      const next = {
        ...readSettings(),
        locale: nextLocale,
        replyLanguage: nextLocale,
      };
      writeSettings(next);
      return { locale: nextLocale, replyLanguage: nextLocale };
    },
  };
}

export type TuiMessageKey =
  | 'language.switched'
  | 'language.current'
  | 'help.keyboard'
  | 'help.commands'
  | 'help.modes'
  | 'help.tips'
  | 'help.close'
  | 'status.language'
  | 'picker.language.title'
  | 'picker.language.hint'
  | 'composer.placeholder'
  | 'composer.placeholder.disabled'
  | 'composer.running'
  | 'composer.cancelling'
  | 'composer.compacting'
  | 'command.model.label'
  | 'command.model.description'
  | 'command.mode.label'
  | 'command.mode.description'
  | 'command.permissions.label'
  | 'command.permissions.description'
  | 'command.language.label'
  | 'command.language.description'
  | 'command.theme.label'
  | 'command.theme.description'
  | 'picker.theme.title'
  | 'picker.theme.hint'
  | 'picker.theme.description'
  | 'theme.switched.light'
  | 'theme.switched.dark'
  | 'theme.switched.system'
  | 'command.clear.label'
  | 'command.clear.description'
  | 'command.compact.label'
  | 'command.compact.description'
  | 'command.resume.label'
  | 'command.resume.description'
  | 'command.goal-pause.label'
  | 'command.goal-pause.description'
  | 'command.goal-resume.label'
  | 'command.goal-resume.description'
  | 'command.goal-cancel.label'
  | 'command.goal-cancel.description'
  | 'command.help.label'
  | 'command.help.description'
  | 'command.quit.label'
  | 'command.quit.description';

const MESSAGES: Readonly<Record<TuiLocale, Readonly<Record<TuiMessageKey, string>>>> = Object.freeze({
  'zh-CN': {
    'language.switched': '已切换为中文（界面 + 回复）',
    'language.current': '当前语言',
    'help.keyboard': '快捷键',
    'help.commands': '斜杠命令',
    'help.modes': '模式',
    'help.tips': '提示',
    'help.close': '按 Enter / Esc 关闭',
    'status.language': '语言',
    'picker.language.title': '语言',
    'picker.language.hint': '↑↓ 选择 · Enter 确认 · Esc 关闭',
    'composer.placeholder': '输入任何问题…',
    'composer.placeholder.disabled': '请先处理上方请求…',
    'composer.running': '运行中…',
    'composer.cancelling': '正在取消…',
    'composer.compacting': '压缩中…',
    'command.model.label': '模型',
    'command.model.description': '选择模型与思考强度',
    'command.mode.label': '模式',
    'command.mode.description': '选择 Agent、Plan 或 Goal',
    'command.permissions.label': '权限',
    'command.permissions.description': '选择本会话的权限策略',
    'command.language.label': '语言',
    'command.language.description': '切换界面与模型回复语言（中文/英文）',
    'command.theme.label': '主题',
    'command.theme.description': '切换浅色 / 深色 / 跟随系统（Peer Frost）',
    'picker.theme.title': '主题',
    'picker.theme.hint': '↑↓ 选择 · Enter 确认 · Esc 关闭',
    'picker.theme.description': '与桌面端 Peer Frost 浅/深主题对齐',
    'theme.switched.light': '已切换为浅色主题',
    'theme.switched.dark': '已切换为深色主题',
    'theme.switched.system': '已切换为跟随系统主题',
    'command.clear.label': '清空会话',
    'command.clear.description': '清空消息、模型上下文与错误',
    'command.compact.label': '压缩上下文',
    'command.compact.description': '用结构化摘要压缩模型上下文；界面记录保留',
    'command.resume.label': '恢复会话',
    'command.resume.description': '恢复并继续已保存的会话',
    'command.goal-pause.label': '暂停目标',
    'command.goal-pause.description': '在当前安全边界后暂停活动目标',
    'command.goal-resume.label': '继续目标',
    'command.goal-resume.description': '恢复已暂停的目标',
    'command.goal-cancel.label': '取消目标',
    'command.goal-cancel.description': '取消当前活动目标',
    'command.help.label': '帮助',
    'command.help.description': '显示快捷键与命令说明',
    'command.quit.label': '退出',
    'command.quit.description': '退出 Peer Agent',
  },
  'en-US': {
    'language.switched': 'Switched to English (UI + replies)',
    'language.current': 'Current language',
    'help.keyboard': 'Keyboard',
    'help.commands': 'Slash commands',
    'help.modes': 'Modes',
    'help.tips': 'Tips',
    'help.close': 'Press Enter / Esc to close',
    'status.language': 'lang',
    'picker.language.title': 'Language',
    'picker.language.hint': '↑↓ select · Enter confirm · Esc close',
    'composer.placeholder': 'Ask anything…',
    'composer.placeholder.disabled': 'Resolve the request above…',
    'composer.running': 'Working…',
    'composer.cancelling': 'Cancelling…',
    'composer.compacting': 'Compacting…',
    'command.model.label': 'Model',
    'command.model.description': 'Choose model and reasoning effort',
    'command.mode.label': 'Mode',
    'command.mode.description': 'Choose Agent, Plan, or Goal',
    'command.permissions.label': 'Permissions',
    'command.permissions.description': 'Choose the session permission policy',
    'command.language.label': 'Language',
    'command.language.description': 'Switch UI and model reply language (Chinese/English)',
    'command.theme.label': 'Theme',
    'command.theme.description': 'Switch light / dark / system theme (Peer Frost)',
    'picker.theme.title': 'Theme',
    'picker.theme.hint': '↑↓ select · Enter confirm · Esc close',
    'picker.theme.description': 'Aligns with desktop Peer Frost light/dark themes',
    'theme.switched.light': 'Switched to light theme',
    'theme.switched.dark': 'Switched to dark theme',
    'theme.switched.system': 'Switched to system theme',
    'command.clear.label': 'Clear chat',
    'command.clear.description': 'Clear messages, model context, and errors',
    'command.compact.label': 'Compact context',
    'command.compact.description': 'Compress model context with a structural summary; UI transcript stays',
    'command.resume.label': 'Resume session',
    'command.resume.description': 'Restore and continue a saved conversation',
    'command.goal-pause.label': 'Pause goal',
    'command.goal-pause.description': 'Pause the active goal after the current safe boundary',
    'command.goal-resume.label': 'Resume goal',
    'command.goal-resume.description': 'Resume the paused goal',
    'command.goal-cancel.label': 'Cancel goal',
    'command.goal-cancel.description': 'Cancel the active goal',
    'command.help.label': 'Help',
    'command.help.description': 'Show keyboard shortcuts and command syntax',
    'command.quit.label': 'Quit',
    'command.quit.description': 'Exit Peer Agent',
  },
});

export function tuiMessage(locale: TuiLocale, key: TuiMessageKey): string {
  return MESSAGES[locale][key] ?? MESSAGES['en-US'][key] ?? key;
}

export function tuiCommandMessage(
  locale: TuiLocale,
  commandId: string,
  part: 'label' | 'description',
): string | null {
  const key = `command.${commandId}.${part}` as TuiMessageKey;
  const value = MESSAGES[locale][key] ?? MESSAGES['en-US'][key];
  return value ?? null;
}

export function composerPlaceholder(locale: TuiLocale, disabled = false): string {
  return tuiMessage(locale, disabled ? 'composer.placeholder.disabled' : 'composer.placeholder');
}

export function composerRunningStatusLabel(
  locale: TuiLocale,
  status: 'running' | 'cancelling' | 'compacting',
): string {
  if (status === 'cancelling') return tuiMessage(locale, 'composer.cancelling');
  if (status === 'compacting') return tuiMessage(locale, 'composer.compacting');
  return tuiMessage(locale, 'composer.running');
}

export function languageSwitchNotice(locale: TuiLocale): string {
  if (locale === 'zh-CN') return MESSAGES['zh-CN']['language.switched'];
  return MESSAGES['en-US']['language.switched'];
}

export function themeSwitchNotice(
  locale: TuiLocale,
  mode: 'light' | 'dark' | 'system',
): string {
  const key =
    mode === 'light'
      ? 'theme.switched.light'
      : mode === 'dark'
        ? 'theme.switched.dark'
        : 'theme.switched.system';
  return tuiMessage(locale, key);
}
