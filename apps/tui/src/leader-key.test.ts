import { describe, expect, test } from 'bun:test';

import { resolveLeaderKey } from './leader-key.ts';

describe('Ctrl+X leader key', () => {
  test('arms on Ctrl+X and cancels on Esc or second Ctrl+X', () => {
    expect(resolveLeaderKey({ armed: false, keyName: 'x', ctrl: true })).toEqual({ type: 'arm' });
    expect(resolveLeaderKey({ armed: true, keyName: 'escape', ctrl: false })).toEqual({ type: 'cancel' });
    expect(resolveLeaderKey({ armed: true, keyName: 'x', ctrl: true })).toEqual({ type: 'cancel' });
    expect(resolveLeaderKey({ armed: true, keyName: 'g', ctrl: true })).toEqual({ type: 'cancel' });
  });

  test('maps documented command and mode chords', () => {
    expect(resolveLeaderKey({ armed: true, keyName: 'm', ctrl: false })).toEqual({ type: 'command', commandId: 'model' });
    expect(resolveLeaderKey({ armed: true, keyName: 'o', ctrl: false })).toEqual({ type: 'command', commandId: 'mode' });
    expect(resolveLeaderKey({ armed: true, keyName: 'p', ctrl: false })).toEqual({ type: 'command', commandId: 'permissions' });
    expect(resolveLeaderKey({ armed: true, keyName: 'n', ctrl: false })).toEqual({ type: 'command', commandId: 'new' });
    expect(resolveLeaderKey({ armed: true, keyName: 'l', ctrl: false })).toEqual({ type: 'command', commandId: 'resume' });
    expect(resolveLeaderKey({ armed: true, keyName: '1', ctrl: false })).toEqual({ type: 'mode', mode: 'chat' });
    expect(resolveLeaderKey({ armed: true, keyName: '2', ctrl: false })).toEqual({ type: 'mode', mode: 'plan' });
    expect(resolveLeaderKey({ armed: true, keyName: '3', ctrl: false })).toEqual({ type: 'mode', mode: 'goal' });
  });

  test('ignores non-press events and pure modifiers while armed', () => {
    expect(resolveLeaderKey({ armed: false, keyName: 'x', ctrl: true, eventType: 'repeat' })).toEqual({ type: 'none' });
    expect(resolveLeaderKey({ armed: true, keyName: 'shift', ctrl: false })).toEqual({ type: 'consume' });
  });

  test('disarms unknown second keys without treating them as normal input', () => {
    expect(resolveLeaderKey({ armed: true, keyName: 'z', ctrl: false })).toEqual({ type: 'cancel' });
  });

  test('does not arm when meta/cmd is held with x', () => {
    expect(resolveLeaderKey({ armed: false, keyName: 'x', ctrl: true, meta: true })).toEqual({ type: 'none' });
  });
});
