import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  assembleSystemContext,
  buildHostConfigInstructions,
} from '@peer-agent/system-context';

import {
  buildReplyLanguageInstruction,
  buildTuiSystemContext,
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
      JSON.stringify({
        locale: 'en-US',
        replyLanguage: 'zh-CN',
        systemInstructions: 'Keep answers concise.',
        gitBranchPrefix: 'team/',
      }, null, 2),
      'utf8',
    );
    const store = createTuiLanguageStore({ userDataPath });
    expect(store.getLocale()).toBe('en-US');
    expect(store.getReplyLanguage()).toBe('zh-CN');
    expect(store.getPromptSettings()).toEqual({
      replyLanguage: 'zh-CN',
      systemInstructions: 'Keep answers concise.',
      gitBranchPrefix: 'team/',
    });
  });

  test('preserves Desktop auto reply-language semantics in prompt settings', () => {
    const userDataPath = tempDir();
    writeFileSync(
      path.join(userDataPath, 'settings.json'),
      JSON.stringify({ locale: 'en-US', replyLanguage: 'auto' }, null, 2),
      'utf8',
    );

    const store = createTuiLanguageStore({ userDataPath });
    expect(store.getPromptSettings().replyLanguage).toBe('auto');
    const context = buildTuiSystemContext(store.getPromptSettings(), {
      workspacePath: userDataPath,
    });
    expect(context.sections.map((section) => section.id)).not.toContain(
      'project.instructions.config.settings.replylanguage',
    );
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

  test('uses the canonical assembler layers and stable hash', () => {
    const input = {
      workspacePath: tempDir(),
      conversationId: 'shared-conversation',
      provider: 'openai',
      model: 'gpt-test',
      mode: 'goal',
    };
    const first = buildTuiSystemContext('en-US', input);
    const second = buildTuiSystemContext('en-US', input);

    expect(first.sections.map((section) => section.id)).toContain('core.identity');
    expect(first.sections.map((section) => section.id)).toContain('runtime.mode');
    expect(first.sections.map((section) => section.id)).not.toContain('runtime.contextExtensions.tui.host-extension-1');
    expect(first.snapshot.renderedHash).toBe(second.snapshot.renderedHash);
    expect(first.rendered).toBe(second.rendered);
  });

  test('uses the same configured host instructions as Desktop without a TUI-only capability catalog', () => {
    const settings = {
      replyLanguage: 'ja-JP',
      systemInstructions: '  Keep answers concise.  ',
      gitBranchPrefix: '  team/  ',
    };
    const input = {
      workspacePath: tempDir(),
      provider: 'openai',
      model: 'gpt-test',
      mode: 'chat',
    };
    const context = buildTuiSystemContext(settings, input);
    const canonical = assembleSystemContext({
      ...input,
      configInstructions: buildHostConfigInstructions(settings),
    });

    const sectionIds = context.sections.map((section) => section.id);
    expect(sectionIds).toContain('project.instructions.config.settings.systeminstructions');
    expect(sectionIds).toContain('project.instructions.config.settings.replylanguage');
    expect(sectionIds).toContain('project.instructions.config.settings.gitbranchprefix');
    expect(sectionIds).not.toContain('project.instructions.config.tui.reply-language');
    expect(sectionIds.some((id) => id.startsWith(
      'runtime.contextExtensions.tui.host-extension-',
    ))).toBe(false);
    expect(context.rendered).toContain('Keep answers concise.');
    expect(context.rendered).toContain('Japanese (日本語)');
    expect(context.rendered).toContain('prefix "team/"');
    expect(context.rendered).toBe(canonical.rendered);
  });

  test('keeps Explorer sections in their canonical layers and provenance', () => {
    const context = buildTuiSystemContext('en-US', {
      workspacePath: tempDir(),
      mode: 'explorer',
      explorerContext: {
        explorerId: 'explorer-1',
        planId: 'plan-1',
        question: 'Find the projection.',
      },
    });

    const contract = context.sections.find((section) => section.id === 'runtime.explorer.contract');
    const brief = context.sections.find((section) => section.id === 'runtime.explorer.brief');
    expect(contract?.layer).toBe('L6_MODE_REMINDER');
    expect(contract?.source.kind).toBe('explorer-contract');
    expect(brief?.layer).toBe('L7_CONTINUITY');
    expect(brief?.source.kind).toBe('explorer-brief');
    expect(context.sections.map((section) => section.id)).not.toContain('runtime.continuity');
  });

  test('keeps Verifier sections in their canonical layers and provenance', () => {
    const context = buildTuiSystemContext('en-US', {
      workspacePath: tempDir(),
      mode: 'explorer',
      verifierContext: {
        verifierRunId: 'verifier-1',
        planId: 'plan-1',
        plan: { planId: 'plan-1', title: 'Verify parity' },
      },
    });

    const contract = context.sections.find((section) => section.id === 'runtime.verifier.contract');
    const brief = context.sections.find((section) => section.id === 'runtime.verifier.brief');
    expect(contract?.layer).toBe('L6_MODE_REMINDER');
    expect(contract?.source.kind).toBe('verifier-contract');
    expect(brief?.layer).toBe('L7_CONTINUITY');
    expect(brief?.source.kind).toBe('verifier-brief');
    expect(context.sections.map((section) => section.id)).not.toContain('runtime.continuity');
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
    expect(composerRunningStatusLabel('zh-CN', 'compacting')).toBe('压缩中…');
    expect(composerRunningStatusLabel('en-US', 'compacting')).toBe('Compacting…');
  });

  test('Skill and MCP command messages follow locale', () => {
    expect(tuiMessage('zh-CN', 'command.skill.label')).toBe('技能');
    expect(tuiMessage('zh-CN', 'command.skill.description')).toBe('浏览、启用、禁用、刷新、插入或调用技能');
    expect(tuiMessage('zh-CN', 'command.mcp.label')).toBe('MCP 服务器');
    expect(tuiMessage('zh-CN', 'command.mcp.description')).toBe('管理 MCP 服务器并查看工具状态');
    expect(tuiMessage('en-US', 'command.skill.label')).toBe('Skills');
    expect(tuiMessage('en-US', 'command.mcp.label')).toBe('MCP Servers');
  });

  test('history navigation command messages follow locale', () => {
    expect(tuiMessage('zh-CN', 'command.history.label')).toBe('历史');
    expect(tuiMessage('en-US', 'command.history.label')).toBe('History');
  });

  test('Skill and MCP picker hints follow locale', () => {
    expect(tuiMessage('zh-CN', 'picker.skill.hint')).toContain('插入');
    expect(tuiMessage('en-US', 'picker.skill.hint')).toContain('insert');
    expect(tuiMessage('zh-CN', 'picker.mcp.hint')).toContain('切换');
    expect(tuiMessage('en-US', 'picker.mcp.hint')).toContain('toggle');
  });

  test('Skill and MCP refresh notices follow locale', () => {
    expect(tuiMessage('zh-CN', 'notice.skill.refreshed')).toBe('技能已刷新');
    expect(tuiMessage('en-US', 'notice.skill.refreshed')).toBe('Skills refreshed');
    expect(tuiMessage('zh-CN', 'notice.mcp.refreshed')).toBe('MCP 服务器已刷新');
    expect(tuiMessage('en-US', 'notice.mcp.refreshed')).toBe('MCP Servers refreshed');
  });
});
