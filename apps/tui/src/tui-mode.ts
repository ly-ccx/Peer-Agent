export type TuiMode = 'chat' | 'plan' | 'goal' | 'explorer';
export type TuiRuntimeMode = TuiMode | 'compact' | 'system';

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
 *
 * Product surface (aligned with Desktop Agent default):
 * - user-selectable: Agent(chat) / Plan only
 * - legacy wire `goal` remains valid for old sessions but is not a picker entry
 */
export interface TuiModeProjectionRule {
  readonly mode: TuiRuntimeMode;
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
    // Legacy self-driven wire; same kernel as Agent(chat), not a product picker entry.
    mode: 'goal',
    readOnly: false,
    allowsWriteTools: true,
    userSelectable: false,
  },
  {
    mode: 'explorer',
    readOnly: true,
    allowsWriteTools: false,
    userSelectable: false,
  },
  {
    mode: 'compact',
    readOnly: true,
    allowsWriteTools: false,
    userSelectable: false,
  },
  {
    mode: 'system',
    readOnly: true,
    allowsWriteTools: false,
    userSelectable: false,
  },
]);

/** User-facing mode picker options only (Agent / Plan). */
export const TUI_MODES: readonly TuiModeOption[] = Object.freeze([
  {
    // Wire value stays `chat` for Runtime SDK / Desktop compatibility.
    // User-facing label is Agent (same product copy as Desktop modeLabel).
    mode: 'chat',
    label: 'Agent',
    shortcut: '1',
    description:
      'Default Agent: adaptively plan and execute (L0–L3); interrupt only for high-risk or decisions.',
    readOnly: false,
  },
  {
    mode: 'plan',
    label: 'Plan',
    shortcut: '2',
    description: 'Plan before execute: co-author a structured plan, then run after approval.',
    readOnly: true,
  },
]);

/** Full wire set retained for runtime/session compatibility (includes legacy goal). */
const TUI_KNOWN_USER_MODES: readonly TuiMode[] = Object.freeze(['chat', 'plan', 'goal', 'explorer']);

export const TUI_RUNTIME_MODES: readonly TuiRuntimeMode[] = Object.freeze([
  ...TUI_KNOWN_USER_MODES,
  'compact',
  'system',
]);

const TUI_MODE_SET = new Set<TuiMode>(TUI_KNOWN_USER_MODES);
const TUI_RUNTIME_MODE_SET = new Set<TuiRuntimeMode>(TUI_RUNTIME_MODES);
const TUI_MODE_PROJECTION_BY_MODE = new Map(
  TUI_MODE_PROJECTION_RULES.map((rule) => [rule.mode, rule] as const),
);

const LEGACY_GOAL_OPTION: TuiModeOption = Object.freeze({
  // Display/compat only: product treats legacy goal as Agent.
  mode: 'goal',
  label: 'Agent',
  shortcut: '1',
  description:
    'Legacy goal wire mapped to Agent: same self-driven kernel as chat (not a separate picker entry).',
  readOnly: false,
});

const EXPLORER_OPTION: TuiModeOption = Object.freeze({
  mode: 'explorer',
  label: 'Explorer',
  shortcut: '',
  description: 'Read-only sub-agent exploration mode.',
  readOnly: true,
});

export function isTuiMode(value: unknown): value is TuiMode {
  return typeof value === 'string' && TUI_MODE_SET.has(value as TuiMode);
}

export function normalizeTuiMode(value: unknown, fallback: TuiMode = 'chat'): TuiMode {
  return isTuiMode(value) ? value : fallback;
}

export function isTuiRuntimeMode(value: unknown): value is TuiRuntimeMode {
  return typeof value === 'string' && TUI_RUNTIME_MODE_SET.has(value as TuiRuntimeMode);
}

export function normalizeTuiRuntimeMode(
  value: unknown,
  fallback: TuiRuntimeMode = 'chat',
): TuiRuntimeMode {
  return isTuiRuntimeMode(value) ? value : fallback;
}

export function tuiModeProjectionRule(mode: TuiRuntimeMode): TuiModeProjectionRule {
  return TUI_MODE_PROJECTION_BY_MODE.get(mode) ?? TUI_MODE_PROJECTION_RULES[0]!;
}

export function tuiModeAllowsWriteTools(mode: TuiRuntimeMode): boolean {
  return tuiModeProjectionRule(mode).allowsWriteTools;
}

/** Map wire mode to the product picker value (goal → chat/Agent). */
export function tuiModePickerValue(mode: TuiMode): 'chat' | 'plan' {
  return mode === 'plan' ? 'plan' : 'chat';
}

function selectableModes(): readonly TuiModeOption[] {
  return TUI_MODES;
}

export function cycleTuiMode(current: TuiMode, offset = 1): TuiMode {
  const modes = selectableModes();
  // Legacy goal (and other non-picker modes) cycle from Agent(chat).
  const pivot = current === 'plan' ? 'plan' : 'chat';
  const currentIndex = modes.findIndex((option) => option.mode === pivot);
  const base = currentIndex >= 0 ? currentIndex : 0;
  const normalizedOffset = ((offset % modes.length) + modes.length) % modes.length;
  return modes[(base + normalizedOffset) % modes.length]?.mode ?? 'chat';
}

export function tuiModeForKey(
  keyName: string,
  ctrlKey: boolean,
  metaKey = false,
): TuiMode | null {
  if (ctrlKey || metaKey) return null;
  const direct = TUI_MODES.find((option) => option.shortcut === keyName);
  if (direct) return direct.mode;
  // Ctrl+X then digit is handled by the host; bare digits still map to picker modes only.
  return null;
}

export function tuiModeOption(mode: TuiMode): TuiModeOption {
  if (mode === 'goal') return LEGACY_GOAL_OPTION;
  if (mode === 'explorer') return EXPLORER_OPTION;
  return TUI_MODES.find((option) => option.mode === mode) ?? TUI_MODES[0]!;
}
