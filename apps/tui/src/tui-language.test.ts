import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  buildReplyLanguageInstruction,
  buildTuiSystemPrompt,
  composerPlaceholder,
  composerRunningStatusLabel,
  createTuiLanguageStore,
  languageIndex,
  languageSwitchNotice,
  normalizeTuiLocale,
  tuiMessage,
} from './tui-language.ts';

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'peer-tui-language-'));
  tempDirs.push(dir);
  return dir;
}

describe('normalizeTuiLocale', () => {
  test('maps chinese and english variants', () => {
    expect(normalizeTuiLocale('zh')).toBe('zh-CN');
    expect(normalizeTuiLocale('zh-CN')).toBe('zh-CN');
    expect(normalizeTuiLocale('en')).toBe('en-US');
    expect(normalizeTuiLocale('en-US')).toBe('en-US');
  });
});

describe('createTuiLanguageStore', () => {
  test('defaults to zh-CN and persists paired locale/replyLanguage', () => {
    const userDataPath = tempDir();
    const store = createTuiLanguageStore({ userDataPath });
    expect(store.getLocale()).toBe('zh-CN');

    const next = store.setLanguage('en-US');
    expect(next).toEqual({ locale: 'en-US', replyLanguage: 'en-US' });

    const raw = JSON.parse(readFileSync(path.join(userDataPath, 'settings.json'), 'utf8')) as Record<string, unknown>;
    expect(raw.locale).toBe('en-US');
    expect(raw.replyLanguage).toBe('en-US');

    const reloaded = createTuiLanguageStore({ userDataPath });
    expect(reloaded.getState()).toEqual({ locale: 'en-US', replyLanguage: 'en-US' });
  });

  test('reads existing desktop settings and keeps replyLanguage when present', () => {
    const userDataPath = tempDir();
    writeFileSync(
      path.join(userDataPath, 'settings.json'),
      JSON.stringify({ locale: 'en-US', replyLanguage: 'zh-CN' }, null, 2),
      'utf8',
    );
    const store = createTuiLanguageStore({ userDataPath });
    expect(store.getLocale()).toBe('en-US');
    expect(store.getReplyLanguage()).toBe('zh-CN');
  });
});

describe('reply language prompt', () => {
  test('builds explicit reply instructions for zh/en', () => {
    expect(buildReplyLanguageInstruction('zh-CN')).toContain('中文');
    expect(buildReplyLanguageInstruction('en-US')).toContain('English');
    expect(buildReplyLanguageInstruction('auto')).toBeNull();
    expect(buildReplyLanguageInstruction('')).toBeNull();
  });

  test('system prompt includes reply instruction when set', () => {
    const prompt = buildTuiSystemPrompt('zh-CN');
    expect(prompt).toContain('Peer Agent');
    expect(prompt).toContain('中文');
  });
});

describe('ui messages', () => {
  test('returns localized strings and switch notice', () => {
    expect(tuiMessage('zh-CN', 'command.language.label')).toBe('语言');
    expect(tuiMessage('en-US', 'command.language.label')).toBe('Language');
    expect(languageSwitchNotice('zh-CN')).toContain('中文');
    expect(languageSwitchNotice('en-US')).toContain('English');
    expect(languageIndex('en-US')).toBe(1);
  });

  test('composer placeholder follows locale', () => {
    expect(composerPlaceholder('zh-CN')).toBe('输入任何问题…');
    expect(composerPlaceholder('en-US')).toBe('Ask anything…');
    expect(composerPlaceholder('zh-CN', true)).toBe('请先处理上方请求…');
    expect(composerPlaceholder('en-US', true)).toBe('Resolve the request above…');
  });

  test('composer running status follows locale', () => {
    expect(composerRunningStatusLabel('zh-CN', 'running')).toBe('运行中…');
    expect(composerRunningStatusLabel('en-US', 'running')).toBe('Working…');
    expect(composerRunningStatusLabel('zh-CN', 'cancelling')).toBe('正在取消…');
    expect(composerRunningStatusLabel('en-US', 'cancelling')).toBe('Cancelling…');
  });
});
