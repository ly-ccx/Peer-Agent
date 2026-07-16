import { describe, expect, test } from 'bun:test';

import { composerEnterAction, runtimeControlAction } from './runtime-controls.ts';

describe('runtime controls', () => {
  test('interrupts a running turn before dismissing an open surface', () => {
    expect(runtimeControlAction({
      keyName: 'escape',
      ctrl: false,
      isRunning: true,
      hasSurface: true,
      hasDraft: true,
    })).toBe('interrupt');
    expect(runtimeControlAction({
      keyName: 'c',
      ctrl: true,
      isRunning: true,
      hasSurface: true,
      hasDraft: false,
    })).toBe('interrupt');
  });

  test('dismisses a surface and preserves the composer draft while idle', () => {
    expect(runtimeControlAction({
      keyName: 'escape',
      ctrl: false,
      isRunning: false,
      hasSurface: true,
      hasDraft: true,
    })).toBe('dismiss-surface');
  });

  test('clears a draft on idle Ctrl+C without exiting', () => {
    expect(runtimeControlAction({
      keyName: 'c',
      ctrl: true,
      isRunning: false,
      hasSurface: false,
      hasDraft: true,
    })).toBe('clear-composer');
  });

  test('submits on an unmodified Enter press', () => {
    expect(composerEnterAction({
      keyName: 'return',
      shift: false,
      eventType: 'press',
    })).toBe('submit');
    expect(composerEnterAction({
      keyName: 'enter',
      shift: false,
      eventType: 'press',
    })).toBe('submit');
  });

  test('leaves Shift+Enter to the textarea so it inserts a newline', () => {
    expect(composerEnterAction({
      keyName: 'return',
      shift: true,
      eventType: 'press',
    })).toBe('newline');
  });

  test('prevents repeat and release Enter events from submitting or inserting another newline', () => {
    expect(composerEnterAction({
      keyName: 'return',
      shift: false,
      eventType: 'repeat',
    })).toBe('suppress');
    expect(composerEnterAction({
      keyName: 'return',
      shift: false,
      eventType: 'release',
    })).toBe('suppress');
    expect(composerEnterAction({
      keyName: 'return',
      shift: true,
      eventType: 'repeat',
    })).toBe('suppress');
  });

  test('ignores non-Enter keys', () => {
    expect(composerEnterAction({
      keyName: 'a',
      shift: false,
      eventType: 'press',
    })).toBe('none');
  });
});
