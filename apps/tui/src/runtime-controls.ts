export type RuntimeControlAction =
  | 'copy-selection'
  | 'interrupt'
  | 'dismiss-surface'
  | 'clear-composer'
  | 'none';

export interface RuntimeControlInput {
  readonly keyName: string;
  readonly ctrl: boolean;
  /** Cmd/Super on macOS terminals (OpenTUI reports this as meta or super). */
  readonly meta?: boolean;
  readonly isRunning: boolean;
  readonly hasSurface: boolean;
  readonly hasDraft: boolean;
  /** True when the terminal has an active non-empty text selection. */
  readonly hasSelection?: boolean;
}

/**
 * Resolves global cancellation before any picker or composer-specific binding.
 * An active text selection makes Ctrl/Cmd+C copy instead of interrupt/quit.
 * Runtime execution still wins over surface dismissal so Esc cannot be
 * swallowed by an open picker while a turn is active.
 */
export function runtimeControlAction(input: RuntimeControlInput): RuntimeControlAction {
  const isEscape = input.keyName === 'escape';
  const isCopyChord = (input.ctrl || Boolean(input.meta)) && input.keyName === 'c';
  const isCtrlC = input.ctrl && input.keyName === 'c';

  if (isCopyChord && input.hasSelection) return 'copy-selection';
  if (input.isRunning && (isEscape || isCtrlC)) return 'interrupt';
  if (input.hasSurface && (isEscape || isCtrlC)) return 'dismiss-surface';
  if (isCtrlC && input.hasDraft) return 'clear-composer';
  return 'none';
}

export interface ComposerEnterInput {
  readonly keyName: string;
  readonly shift: boolean;
  readonly eventType: 'press' | 'repeat' | 'release';
}

export type ComposerEnterAction = 'submit' | 'newline' | 'suppress' | 'none';

/**
 * Keeps the text area's multiline editing and message submission bindings separate.
 * Only the first unmodified Enter submits; Shift+Enter is handled as newline
 * (caller must insert via Textarea.newLine — OpenTUI has no shift+return binding),
 * while repeat/release events are suppressed so one physical key press acts once.
 */
export function composerEnterAction(input: ComposerEnterInput): ComposerEnterAction {
  const isEnter = input.keyName === 'return' || input.keyName === 'enter';
  if (!isEnter) return 'none';
  if (input.eventType !== 'press') return 'suppress';
  return input.shift ? 'newline' : 'submit';
}
