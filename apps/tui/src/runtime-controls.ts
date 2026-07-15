export type RuntimeControlAction =
  | 'interrupt'
  | 'dismiss-surface'
  | 'clear-composer'
  | 'none';

export interface RuntimeControlInput {
  readonly keyName: string;
  readonly ctrl: boolean;
  readonly isRunning: boolean;
  readonly hasSurface: boolean;
  readonly hasDraft: boolean;
}

/**
 * Resolves global cancellation before any picker or composer-specific binding.
 * Runtime execution always wins over surface dismissal so Esc/Ctrl+C cannot be
 * swallowed by an open picker while a turn is active.
 */
export function runtimeControlAction(input: RuntimeControlInput): RuntimeControlAction {
  const isEscape = input.keyName === 'escape';
  const isCtrlC = input.ctrl && input.keyName === 'c';

  if (input.isRunning && (isEscape || isCtrlC)) return 'interrupt';
  if (input.hasSurface && (isEscape || isCtrlC)) return 'dismiss-surface';
  if (isCtrlC && input.hasDraft) return 'clear-composer';
  return 'none';
}

export function shouldHandleComposerSubmit(eventType: 'press' | 'repeat' | 'release'): boolean {
  return eventType === 'press';
}
