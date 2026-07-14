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
  test('declares chat, plan, goal and explorer in stable keyboard order', () => {
    expect(TUI_MODES.map(({ mode, shortcut }) => [mode, shortcut])).toEqual([
      ['chat', '1'],
      ['plan', '2'],
      ['goal', '3'],
      ['explorer', '4'],
    ]);
    expect(tuiModeOption('plan').readOnly).toBe(true);
    expect(tuiModeOption('explorer').readOnly).toBe(true);
    expect(tuiModeOption('goal').readOnly).toBe(false);
  });

  test('normalizes invalid modes to chat and recognizes every supported mode', () => {
    expect(TUI_MODES.every(({ mode }) => isTuiMode(mode))).toBe(true);
    expect(isTuiMode('system')).toBe(false);
    expect(normalizeTuiMode('unknown')).toBe('chat');
    expect(normalizeTuiMode('unknown', 'goal')).toBe('goal');
  });

  test('cycles modes in both directions', () => {
    expect(cycleTuiMode('chat')).toBe('plan');
    expect(cycleTuiMode('explorer')).toBe('chat');
    expect(cycleTuiMode('chat', -1)).toBe('explorer');
  });

  test('maps only Ctrl+1 through Ctrl+4 to direct mode changes', () => {
    expect(tuiModeForKey('1', true)).toBe('chat');
    expect(tuiModeForKey('2', true)).toBe('plan');
    expect(tuiModeForKey('3', true)).toBe('goal');
    expect(tuiModeForKey('4', true)).toBe('explorer');
    expect(tuiModeForKey('2', false)).toBeNull();
    expect(tuiModeForKey('5', true)).toBeNull();
  });
});
