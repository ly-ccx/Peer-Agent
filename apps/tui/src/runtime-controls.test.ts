import { describe, expect, test } from 'bun:test';

import { runtimeControlAction, shouldHandleComposerSubmit } from './runtime-controls.ts';

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

  test('does not treat key repeats or releases as composer submission', () => {
    expect(shouldHandleComposerSubmit('press')).toBe(true);
    expect(shouldHandleComposerSubmit('repeat')).toBe(false);
    expect(shouldHandleComposerSubmit('release')).toBe(false);
  });
});
