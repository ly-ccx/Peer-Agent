import { describe, expect, test } from 'bun:test';

import {
  cycleTuiMode,
  isTuiMode,
  normalizeTuiMode,
  TUI_MODES,
  tuiModeForKey,
  tuiModeOption,
} from './tui-mode.ts';

describe('TUI modes', () => {
  test('declares only user-facing chat, plan and goal modes in stable keyboard order', () => {
    expect(TUI_MODES.map(({ mode, shortcut }) => [mode, shortcut])).toEqual([
      ['chat', '1'],
      ['plan', '2'],
      ['goal', '3'],
    ]);
    expect(tuiModeOption('plan').readOnly).toBe(true);
    expect(tuiModeOption('goal').readOnly).toBe(false);
    expect(TUI_MODES.some(({ mode }) => mode === 'explorer')).toBe(false);
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
