export type TuiMode = 'chat' | 'plan' | 'goal' | 'explorer';

export interface TuiModeOption {
  readonly mode: TuiMode;
  readonly label: string;
  readonly shortcut: string;
  readonly description: string;
  readonly readOnly: boolean;
}

/**
 * Product-level projection policy for TUI runtime modes.
 *
 * Actual capability membership still comes from Runtime SDK projection
 * (`modeScopes` on manifests + `createRuntimeProjection`). This table is the
 * TUI-facing contract: which modes are read-only and which allow write tools.
 */
export interface TuiModeProjectionRule {
  readonly mode: TuiMode;
  readonly readOnly: boolean;
  /** Whether write/shell capabilities may be projected for this mode. */
  readonly allowsWriteTools: boolean;
  /** Whether this mode is user-selectable in the mode picker. */
  readonly userSelectable: boolean;
}

export const TUI_MODE_PROJECTION_RULES: readonly TuiModeProjectionRule[] = Object.freeze([
  {
    mode: 'chat',
    readOnly: false,
    allowsWriteTools: true,
    userSelectable: true,
  },
  {
    mode: 'plan',
    readOnly: true,
    allowsWriteTools: false,
    userSelectable: true,
  },
  {
    mode: 'goal',
    readOnly: false,
    allowsWriteTools: true,
    userSelectable: true,
  },
  {
    mode: 'explorer',
    readOnly: true,
    allowsWriteTools: false,
    userSelectable: false,
  },
]);

export const TUI_MODES: readonly TuiModeOption[] = Object.freeze([
  {
    // Wire value stays `chat` for Runtime SDK / Desktop compatibility.
    // User-facing label is Agent (same product copy as Desktop modeLabel).
    mode: 'chat',
    label: 'Agent',
    shortcut: '1',
    description: 'Answer directly and call projected read and write tools as needed.',
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
]);

export const TUI_RUNTIME_MODES: readonly TuiMode[] = Object.freeze([
  ...TUI_MODES.map((option) => option.mode),
  'explorer',
]);

const TUI_MODE_SET = new Set<TuiMode>(TUI_RUNTIME_MODES);
const TUI_MODE_PROJECTION_BY_MODE = new Map(
  TUI_MODE_PROJECTION_RULES.map((rule) => [rule.mode, rule] as const),
);

export function isTuiMode(value: unknown): value is TuiMode {
  return typeof value === 'string' && TUI_MODE_SET.has(value as TuiMode);
}

export function normalizeTuiMode(value: unknown, fallback: TuiMode = 'chat'): TuiMode {
  return isTuiMode(value) ? value : fallback;
}

export function tuiModeProjectionRule(mode: TuiMode): TuiModeProjectionRule {
  return TUI_MODE_PROJECTION_BY_MODE.get(mode) ?? TUI_MODE_PROJECTION_RULES[0]!;
}

export function tuiModeAllowsWriteTools(mode: TuiMode): boolean {
  return tuiModeProjectionRule(mode).allowsWriteTools;
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
  if (mode === 'explorer') {
    return {
      mode,
      label: 'Explorer',
      shortcut: '',
      description: 'Internal read-only profile used by the Goal runner.',
      readOnly: true,
    };
  }
  return TUI_MODES.find((option) => option.mode === mode) ?? TUI_MODES[0]!;
}
