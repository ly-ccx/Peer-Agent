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

export function buildTuiSystemPrompt(replyLanguage: string | null | undefined): string {
  const instruction = buildReplyLanguageInstruction(replyLanguage);
  return instruction ? `${BASE_SYSTEM_PROMPT}\n\n${instruction}` : BASE_SYSTEM_PROMPT;
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
  | 'command.language.label'
  | 'command.language.description';

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
    'command.language.label': '语言',
    'command.language.description': '切换界面与模型回复语言（中文/英文）',
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
    'command.language.label': 'Language',
    'command.language.description': 'Switch UI and model reply language (Chinese/English)',
  },
});

export function tuiMessage(locale: TuiLocale, key: TuiMessageKey): string {
  return MESSAGES[locale][key] ?? MESSAGES['en-US'][key] ?? key;
}

export function languageSwitchNotice(locale: TuiLocale): string {
  if (locale === 'zh-CN') return MESSAGES['zh-CN']['language.switched'];
  return MESSAGES['en-US']['language.switched'];
}
