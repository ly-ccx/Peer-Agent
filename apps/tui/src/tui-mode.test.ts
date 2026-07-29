import { describe, expect, test } from 'bun:test';

import {
  cycleTuiMode,
  isTuiMode,
  isTuiRuntimeMode,
  normalizeTuiMode,
  normalizeTuiRuntimeMode,
  TUI_MODE_PROJECTION_RULES,
  TUI_MODES,
  TUI_RUNTIME_MODES,
  tuiModeAllowsWriteTools,
  tuiModeForKey,
  tuiModeOption,
  tuiModePickerValue,
  tuiModeProjectionRule,
} from './tui-mode.ts';

describe('tui mode catalog', () => {
  test('exposes only Agent(chat) and Plan in the user-facing picker', () => {
    expect(TUI_MODES.map(({ mode, shortcut, label }) => [mode, shortcut, label])).toEqual([
      // Wire value remains `chat` for Runtime/Desktop; product label is Agent.
      ['chat', '1', 'Agent'],
      ['plan', '2', 'Plan'],
    ]);
    expect(TUI_MODES.some(({ mode }) => mode === 'goal')).toBe(false);
    expect(TUI_MODES.some(({ mode }) => mode === 'explorer')).toBe(false);
    expect(tuiModeOption('chat').label).toBe('Agent');
    expect(tuiModeOption('goal').label).toBe('Agent');
    expect(tuiModeOption('goal').readOnly).toBe(false);
    expect(tuiModeOption('plan').readOnly).toBe(true);
  });

  test('keeps legacy goal as a valid wire mode, not user-selectable', () => {
    expect(isTuiMode('goal')).toBe(true);
    expect(tuiModeProjectionRule('goal')).toMatchObject({
      mode: 'goal',
      readOnly: false,
      allowsWriteTools: true,
      userSelectable: false,
    });
    expect(tuiModePickerValue('goal')).toBe('chat');
    expect(tuiModePickerValue('chat')).toBe('chat');
    expect(tuiModePickerValue('plan')).toBe('plan');
  });

  test('declares projection rules for user-facing and runtime-only modes', () => {
    expect(TUI_MODE_PROJECTION_RULES.map(({ mode }) => mode)).toEqual([
      'chat',
      'plan',
      'goal',
      'explorer',
      'compact',
      'system',
    ]);
    expect(TUI_RUNTIME_MODES).toEqual([
      'chat',
      'plan',
      'goal',
      'explorer',
      'compact',
      'system',
    ]);
    expect(tuiModeAllowsWriteTools('chat')).toBe(true);
    expect(tuiModeAllowsWriteTools('goal')).toBe(true);
    expect(tuiModeAllowsWriteTools('plan')).toBe(false);
    expect(tuiModeAllowsWriteTools('explorer')).toBe(false);
    expect(tuiModeProjectionRule('plan')).toMatchObject({
      mode: 'plan',
      readOnly: true,
      allowsWriteTools: false,
      userSelectable: true,
    });
    expect(tuiModeProjectionRule('explorer')).toMatchObject({
      mode: 'explorer',
      readOnly: true,
      allowsWriteTools: false,
      userSelectable: false,
    });
  });

  test('normalizes unknown values and validates runtime mode aliases', () => {
    expect(TUI_MODES.every(({ mode }) => isTuiMode(mode))).toBe(true);
    expect(isTuiMode('explorer')).toBe(true);
    expect(isTuiMode('compact')).toBe(false);
    expect(isTuiRuntimeMode('compact')).toBe(true);
    expect(isTuiRuntimeMode('system')).toBe(true);
    expect(isTuiRuntimeMode('unknown')).toBe(false);
    expect(normalizeTuiMode('unknown')).toBe('chat');
    expect(normalizeTuiMode('goal')).toBe('goal');
    expect(normalizeTuiMode('unknown', 'plan')).toBe('plan');
    expect(normalizeTuiRuntimeMode('system')).toBe('system');
    expect(normalizeTuiRuntimeMode('unknown', 'compact')).toBe('compact');
  });

  test('cycles only Agent and Plan; legacy goal pivots from Agent', () => {
    expect(cycleTuiMode('chat')).toBe('plan');
    expect(cycleTuiMode('plan')).toBe('chat');
    expect(cycleTuiMode('goal')).toBe('plan');
    expect(cycleTuiMode('chat', -1)).toBe('plan');
    expect(cycleTuiMode('goal', -1)).toBe('plan');
  });

  test('maps bare digit shortcuts only for picker modes', () => {
    expect(tuiModeForKey('1', false)).toBe('chat');
    expect(tuiModeForKey('2', false)).toBe('plan');
    expect(tuiModeForKey('3', false)).toBe(null);
    expect(tuiModeForKey('1', true)).toBe(null);
    expect(tuiModeForKey('2', false, true)).toBe(null);
  });
});
