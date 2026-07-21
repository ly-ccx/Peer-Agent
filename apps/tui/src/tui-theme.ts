/**
 * Unified TUI visual system.
 *
 * Keep chrome colors / selection chrome / timeline glyphs here so pickers,
 * status bars, tool timelines, and markdown share one professional look
 * (inspired by Crush/Qoder density, not a 1:1 skin).
 */

export const COLOR = {
  background: '#0a0a0a',
  panel: '#111111',
  panelRaised: '#161616',
  userPanel: '#10212a',
  selection: '#1c1c1c',
  border: '#2a2a2a',
  borderFocus: '#3f3f46',

  text: '#e5e5e5',
  textSoft: '#d4d4d4',
  muted: '#737373',
  subtle: '#525252',
  dim: '#404040',

  accent: '#a3e635',
  accentSoft: '#bef264',
  user: '#7dd3fc',
  info: '#7189c9',

  success: '#86efac',
  warning: '#fbbf24',
  danger: '#fb7185',
  dangerSoft: '#fca5a5',

  tool: '#86efac',
  toolFailed: '#fb7185',
  toolRunning: '#fde68a',
  toolCancelled: '#a3a3a3',
  toolDetail: '#a3a3a3',

  code: '#bef264',
  codeBackground: '#171717',
  diffAdd: '#4ade80',
  diffDelete: '#f87171',
  diffHunk: '#67e8f9',
  diffMeta: '#737373',
} as const;

export type TuiColor = (typeof COLOR)[keyof typeof COLOR];

/** Shared picker chrome — selected row uses raised selection + accent caret. */
export const PICKER_CHROME = {
  caretSelected: '› ',
  caretIdle: '  ',
  checkCurrent: ' ✓',
  selectedBackground: COLOR.selection,
  idleBackground: COLOR.panel,
  selectedForeground: COLOR.accent,
  idleForeground: COLOR.text,
  mutedForeground: COLOR.muted,
  border: COLOR.border,
  title: COLOR.accent,
  warning: COLOR.warning,
  danger: COLOR.dangerSoft,
} as const;

/** Tool timeline markers and branch characters. */
export const TOOL_CHROME = {
  branchFirst: '  ╰ ',
  branchRest: '    ',
  // Use the same visual footprint for all terminal tool statuses; color carries state.
  glyphCompleted: '●',
  glyphFailed: '●',
  glyphCancelled: '●',
  // Larger filled circle for in-flight tools; UI also breathes this glyph.
  glyphRunning: '●',
  glyphUnknown: '●',
} as const;

export function toolStatusColor(status: string): string {
  switch (status) {
    case 'failed':
    case 'denied':
      return COLOR.toolFailed;
    case 'running':
      return COLOR.toolRunning;
    case 'cancelled':
      return COLOR.toolCancelled;
    case 'completed':
      return COLOR.tool;
    default:
      return COLOR.toolDetail;
  }
}

export function contextUsageColor(percent: number | undefined, fallback = COLOR.muted): string {
  if (percent === undefined) return fallback;
  if (percent >= 90) return COLOR.danger;
  if (percent >= 80) return COLOR.warning;
  return fallback;
}
