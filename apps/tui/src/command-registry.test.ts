import { describe, expect, test } from 'bun:test';

import {
  buildTuiHelpSections,
  filterTuiCommandRegistry,
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
      'clear',
      'compact',
      'resume',
      'help',
      'quit',
    ]);
    expect(TUI_COMMAND_REGISTRY.some((command) => command.id.includes('explorer'))).toBe(false);
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
