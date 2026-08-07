import { describe, expect, test } from 'bun:test';

import {
  buildTuiHelpSections,
  filterTuiCommandRegistry,
  resolveTuiCommandInput,
  TUI_COMMAND_REGISTRY,
  visibleTuiCommands,
} from './command-registry.ts';
import { tuiMessage } from './tui-language.ts';

const idle = { goalStatus: 'none' } as const;

describe('TUI command registry', () => {
  test('exposes only real P0 actions and keeps Explorer internal', () => {
    expect(visibleTuiCommands(idle).map((command) => command.id)).toEqual([
      'model',
      'mode',
      'permissions',
      'language',
      'theme',
      'skill',
      'mcp',
      'new',
      'clear',
      'compact',
      'history',
      'resume',
      'goals',
      'help',
      'quit',
      'version',
    ]);
    expect(TUI_COMMAND_REGISTRY.some((command) => command.id.includes('explorer'))).toBe(false);
  });

  test('resolves /version to the show-version action', () => {
    expect(resolveTuiCommandInput('/version', idle)?.id).toBe('version');
    expect(resolveTuiCommandInput('/version', idle)?.action).toEqual({ type: 'show-version' });
  });

  test('filters by id, label, description, and keywords', () => {
    expect(filterTuiCommandRegistry('model', idle).map((command) => command.id)).toContain('model');
    expect(filterTuiCommandRegistry('permission', idle).map((command) => command.id)).toEqual(['permissions']);
    expect(filterTuiCommandRegistry('language', idle).map((command) => command.id)).toContain('language');
    expect(filterTuiCommandRegistry('agent', idle).map((command) => command.id)).toContain('mode');
  });

  test('goal controls appear only for matching goal status', () => {
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).toContain('goal-pause');
    expect(visibleTuiCommands({ goalStatus: 'running' }).map((command) => command.id)).toContain('goal-cancel');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).toContain('goal-resume');
    expect(visibleTuiCommands({ goalStatus: 'paused' }).map((command) => command.id)).not.toContain('goal-pause');
  });

    test('resolves /history and direction args on the single history command', () => {
    expect(resolveTuiCommandInput('/history', idle)?.id).toBe('history');
    expect(resolveTuiCommandInput('/history', idle)?.action).toEqual({
      type: 'history-navigation',
      direction: 'earlier',
    });
    expect(resolveTuiCommandInput('/history earlier', idle)?.action).toEqual({
      type: 'history-navigation',
      direction: 'earlier',
    });
    expect(resolveTuiCommandInput('/history later', idle)?.id).toBe('history');
    expect(resolveTuiCommandInput('/history later', idle)?.action).toEqual({
      type: 'history-navigation',
      direction: 'later',
    });
    expect(resolveTuiCommandInput('/history latest', idle)?.action).toEqual({
      type: 'history-navigation',
      direction: 'latest',
    });
    expect(resolveTuiCommandInput('/history-earlier', idle)).toBeNull();
    expect(resolveTuiCommandInput('/history-later', idle)).toBeNull();
    expect(resolveTuiCommandInput('/history-latest', idle)).toBeNull();
    expect(resolveTuiCommandInput('/history unknown', idle)).toBeNull();
  });

  test('exposes /new as a real new-session action', () => {
    expect(resolveTuiCommandInput('/new', idle)?.action).toEqual({ type: 'new-session' });
    expect(filterTuiCommandRegistry('new session', idle).map((command) => command.id)).toContain('new');
  });

  test('exposes a Goal history switcher without treating history as parallel active work', () => {
    expect(resolveTuiCommandInput('/goals', idle)?.action).toEqual({ type: 'open-goal-picker' });
    expect(filterTuiCommandRegistry('goal history', idle).map((command) => command.id)).toContain('goals');
  });

  test('builds help content from the live command registry', () => {
    const sections = buildTuiHelpSections(idle);
    const slash = sections.find((section) => section.title === 'Slash commands')!;
    expect(slash.lines.some((line) => line.startsWith('/help'))).toBe(true);
    expect(slash.lines.some((line) => line.startsWith('/mode'))).toBe(true);
    const modes = sections.find((section) => section.title === 'Modes')!;
    expect(modes.lines.some((line) => line.startsWith('Agent'))).toBe(true);
  });
});

describe('TUI command localization', () => {
  test('localizes command labels and descriptions for zh-CN', () => {
    const commands = visibleTuiCommands(idle, 'zh-CN');
    const model = commands.find((command) => command.id === 'model');
    expect(model?.label).toBe('模型');
    expect(model?.description).toBe('选择模型与思考强度');
    const mode = commands.find((command) => command.id === 'mode');
    expect(mode?.label).toBe('模式');
    expect(mode?.description).toBe('选择 Agent、Plan 或 Goal');
    const skill = commands.find((command) => command.id === 'skill');
    expect(skill?.label).toBe('技能');
    expect(skill?.description).toBe('浏览、启用、禁用、刷新、插入或调用技能');
    const mcp = commands.find((command) => command.id === 'mcp');
    expect(mcp?.label).toBe('MCP 服务器');
    expect(mcp?.description).toBe('管理 MCP 服务器并查看工具状态');
    const newSession = commands.find((command) => command.id === 'new');
    expect(newSession?.label).toBe('新会话');
    expect(newSession?.description).toBe('开启全新空会话并回到首页');
    const history = commands.find((command) => command.id === 'history');
    expect(history?.label).toBe('历史');
    expect(history?.description).toContain('Esc');
    const goals = commands.find((command) => command.id === 'goals');
    expect(goals?.label).toBe('目标历史');
    expect(goals?.description).toBe('切换本会话中的正式目标');
  });

  test('filters by localized Chinese text', () => {
    const hits = filterTuiCommandRegistry('模型', idle, 'zh-CN');
    expect(hits.map((command) => command.id)).toContain('model');
    const modeHits = filterTuiCommandRegistry('权限', idle, 'zh-CN');
    expect(modeHits.map((command) => command.id)).toEqual(['permissions']);
  });

  test('help section titles and command lines follow locale', () => {
    const zh = buildTuiHelpSections(idle, 'zh-CN');
    expect(zh.map((section) => section.title)).toEqual([
      tuiMessage('zh-CN', 'help.keyboard'),
      tuiMessage('zh-CN', 'help.commands'),
      tuiMessage('zh-CN', 'help.modes'),
      tuiMessage('zh-CN', 'help.tips'),
    ]);
    const slash = zh.find((section) => section.title === '斜杠命令')!;
    expect(slash.lines.some((line) => line.includes('选择模型与思考强度'))).toBe(true);
  });
});
