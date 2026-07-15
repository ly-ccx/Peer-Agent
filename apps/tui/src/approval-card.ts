import type { TuiApprovalDecision } from './tui-host.ts';

export interface TuiApprovalOption {
  readonly decision: TuiApprovalDecision;
  readonly label: string;
  readonly shortcut: string;
  readonly color: string;
}

export const TUI_APPROVAL_OPTIONS = [
  {
    decision: 'allow-once',
    label: 'Allow once',
    shortcut: '1',
    color: '#86efac',
  },
  {
    decision: 'allow-session',
    label: 'Allow similar this session',
    shortcut: '2',
    color: '#67e8f9',
  },
  {
    decision: 'deny',
    label: 'Deny',
    shortcut: '3',
    color: '#fda4af',
  },
] as const satisfies readonly TuiApprovalOption[];

export function formatApprovalArguments(args: unknown, maxLength = 180): string {
  let formatted: string;
  try {
    formatted = typeof args === 'string' ? args : JSON.stringify(args);
  } catch {
    formatted = String(args);
  }
  if (!formatted) return '—';
  return formatted.length <= maxLength ? formatted : `${formatted.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatApprovalRisk(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  return 'runtime governed';
}

export function moveApprovalSelection(current: number, delta: -1 | 1): number {
  return (current + delta + TUI_APPROVAL_OPTIONS.length) % TUI_APPROVAL_OPTIONS.length;
}

export function approvalDecisionForKey(
  keyName: string,
  selectedIndex: number,
): TuiApprovalDecision | null {
  if (keyName === '1' || keyName === 'y') return 'allow-once';
  if (keyName === '2') return 'allow-session';
  if (keyName === '3' || keyName === 'n' || keyName === 'escape') return 'deny';
  if (keyName === 'return' || keyName === 'enter') {
    return TUI_APPROVAL_OPTIONS[selectedIndex]?.decision ?? null;
  }
  return null;
}
