export type TuiMode = 'chat' | 'plan' | 'goal' | 'explorer';

export interface TuiModeOption {
  readonly mode: TuiMode;
  readonly label: string;
  readonly shortcut: string;
  readonly description: string;
  readonly readOnly: boolean;
}

export const TUI_MODES: readonly TuiModeOption[] = Object.freeze([
  {
    mode: 'chat',
    label: 'Chat',
    shortcut: '1',
    description: 'General conversation with projected read and write tools.',
    readOnly: false,
  },
  {
    mode: 'plan',
    label: 'Plan',
    shortcut: '2',
    description: 'Read-only planning until an approved-plan runtime is available.',
    readOnly: true,
  },
  {
    mode: 'goal',
    label: 'Goal',
    shortcut: '3',
    description: 'Autonomous execution with projected read and write tools.',
    readOnly: false,
  },
  {
    mode: 'explorer',
    label: 'Explorer',
    shortcut: '4',
    description: 'Strictly read-only investigation.',
    readOnly: true,
  },
]);

const TUI_MODE_SET = new Set<TuiMode>(TUI_MODES.map((option) => option.mode));

export function isTuiMode(value: unknown): value is TuiMode {
  return typeof value === 'string' && TUI_MODE_SET.has(value as TuiMode);
}

export function normalizeTuiMode(value: unknown, fallback: TuiMode = 'chat'): TuiMode {
  return isTuiMode(value) ? value : fallback;
}

export function cycleTuiMode(current: TuiMode, offset = 1): TuiMode {
  const currentIndex = TUI_MODES.findIndex((option) => option.mode === current);
  const normalizedOffset = ((offset % TUI_MODES.length) + TUI_MODES.length) % TUI_MODES.length;
  return TUI_MODES[(currentIndex + normalizedOffset) % TUI_MODES.length]?.mode ?? 'chat';
}

export function tuiModeForKey(keyName: string, ctrl: boolean): TuiMode | null {
  if (!ctrl) return null;
  const direct = TUI_MODES.find((option) => option.shortcut === keyName);
  return direct?.mode ?? null;
}

export function tuiModeOption(mode: TuiMode): TuiModeOption {
  return TUI_MODES.find((option) => option.mode === mode) ?? TUI_MODES[0]!;
}
