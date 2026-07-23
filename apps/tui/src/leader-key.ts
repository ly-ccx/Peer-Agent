/** Ctrl+X leader chords for high-frequency TUI actions. */

export type LeaderKeyResult =
  | { readonly type: 'arm' }
  | { readonly type: 'cancel' }
  | { readonly type: 'consume' }
  | { readonly type: 'command'; readonly commandId: string }
  | { readonly type: 'mode'; readonly mode: 'chat' | 'plan' | 'goal' }
  | { readonly type: 'none' };

export interface LeaderKeyInput {
  readonly armed: boolean;
  readonly keyName: string;
  readonly ctrl: boolean;
  readonly meta?: boolean;
  readonly shift?: boolean;
  readonly eventType?: 'press' | 'repeat' | 'release';
}

/**
 * Ctrl+X is a leader prefix (not a character insert).
 * While armed, the next non-modifier key resolves a chord and disarms.
 * Esc / Ctrl+G / a second Ctrl+X cancels the pending leader.
 */
export function resolveLeaderKey(input: LeaderKeyInput): LeaderKeyResult {
  const eventType = input.eventType ?? 'press';
  if (eventType !== 'press') return { type: 'none' };

  const name = (input.keyName || '').toLowerCase();
  const isCtrlX = input.ctrl && !input.meta && name === 'x';

  if (!input.armed) {
    if (isCtrlX) return { type: 'arm' };
    return { type: 'none' };
  }

  // Armed: swallow the leader key itself and cancel on escape-like chords.
  if (isCtrlX) return { type: 'cancel' };
  if (name === 'escape' || (input.ctrl && name === 'g')) return { type: 'cancel' };

  // Ignore pure modifier re-presses while waiting for the second key.
  if (name === 'control' || name === 'shift' || name === 'meta' || name === 'alt' || name === 'super') {
    return { type: 'consume' };
  }

  if (name === 'm') return { type: 'command', commandId: 'model' };
  if (name === 'o') return { type: 'command', commandId: 'mode' };
  if (name === 'p') return { type: 'command', commandId: 'permissions' };
  if (name === 'n') return { type: 'command', commandId: 'new' };
  if (name === 'l') return { type: 'command', commandId: 'resume' };
  if (name === '1') return { type: 'mode', mode: 'chat' };
  if (name === '2') return { type: 'mode', mode: 'plan' };
  if (name === '3') return { type: 'mode', mode: 'goal' };

  // Unknown second key: disarm and swallow so the chord does not leak into composer.
  return { type: 'cancel' };
}
