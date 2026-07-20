import { describe, expect, test } from 'bun:test';

import {
  cycleTuiMode,
  isTuiMode,
  normalizeTuiMode,
  TUI_MODE_PROJECTION_RULES,
  TUI_MODES,
  TUI_RUNTIME_MODES,
  tuiModeAllowsWriteTools,
  tuiModeForKey,
  tuiModeOption,
  tuiModeProjectionRule,
} from './tui-mode.ts';

describe('TUI modes', () => {
  test('declares only user-facing chat, plan and goal modes in stable keyboard order', () => {
    expect(TUI_MODES.map(({ mode, shortcut }) => [mode, shortcut])).toEqual([
      // Wire value remains `chat` for Runtime/Desktop; product label is Agent.
      ['chat', '1'],
      ['plan', '2'],
      ['goal', '3'],
    ]);
    expect(tuiModeOption('chat').label).toBe('Agent');
    expect(tuiModeOption('plan').readOnly).toBe(true);
    expect(tuiModeOption('goal').readOnly).toBe(false);
    expect(TUI_MODES.some(({ mode }) => mode === 'explorer')).toBe(false);
  });

  test('defines projection rules for all four runtime modes', () => {
    expect(TUI_RUNTIME_MODES).toEqual(['chat', 'plan', 'goal', 'explorer']);
    expect(TUI_MODE_PROJECTION_RULES.map((rule) => rule.mode)).toEqual([
      'chat',
      'plan',
      'goal',
      'explorer',
    ]);
    expect(tuiModeAllowsWriteTools('chat')).toBe(true);
    expect(tuiModeAllowsWriteTools('goal')).toBe(true);
    expect(tuiModeAllowsWriteTools('plan')).toBe(false);
    expect(tuiModeAllowsWriteTools('explorer')).toBe(false);
    expect(tuiModeProjectionRule('plan')).toMatchObject({
      readOnly: true,
      userSelectable: true,
    });
    expect(tuiModeProjectionRule('explorer')).toMatchObject({
      readOnly: true,
      userSelectable: false,
    });
  });

  test('keeps Explorer valid for internal Runtime use while excluding it from user choices', () => {
    expect(TUI_MODES.every(({ mode }) => isTuiMode(mode))).toBe(true);
    expect(isTuiMode('explorer')).toBe(true);
    expect(isTuiMode('system')).toBe(false);
    expect(normalizeTuiMode('unknown')).toBe('chat');
    expect(normalizeTuiMode('unknown', 'goal')).toBe('goal');
  });

  test('cycles only through user-facing modes in both directions', () => {
    expect(cycleTuiMode('chat')).toBe('plan');
    expect(cycleTuiMode('goal')).toBe('chat');
    expect(cycleTuiMode('chat', -1)).toBe('goal');
    expect(cycleTuiMode('explorer')).toBe('chat');
  });

  test('maps only Ctrl+1 through Ctrl+3 to direct mode changes', () => {
    expect(tuiModeForKey('1', true)).toBe('chat');
    expect(tuiModeForKey('2', true)).toBe('plan');
    expect(tuiModeForKey('3', true)).toBe('goal');
    expect(tuiModeForKey('4', true)).toBeNull();
    expect(tuiModeForKey('2', false)).toBeNull();
    expect(tuiModeForKey('5', true)).toBeNull();
  });
});
