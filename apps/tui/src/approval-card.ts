import type { TuiApprovalDecision } from './tui-host.ts';
import { COLOR } from './tui-theme.ts';

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
    color: COLOR.success,
  },
  {
    decision: 'allow-session',
    label: 'Allow similar this session',
    shortcut: '2',
    color: COLOR.diffHunk,
  },
  {
    decision: 'deny',
    label: 'Deny',
    shortcut: '3',
    color: COLOR.dangerSoft,
  },
] as const satisfies readonly TuiApprovalOption[];

export function formatApprovalArguments(args: unknown, maxLength = 240): string {
  let formatted: string;
  if (typeof args === 'string') {
    formatted = args;
  } else {
    try {
      formatted = JSON.stringify(args, null, 2) ?? 'No arguments';
    } catch {
      formatted = 'Arguments could not be displayed';
    }
  }
  const singleLine = formatted.replace(/\s+/g, ' ').trim();
  if (!singleLine) return 'No arguments';
  return singleLine.length <= maxLength
    ? singleLine
    : `${singleLine.slice(0, Math.max(0, maxLength - 1))}…`;
}

export function formatApprovalRisk(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
  return 'runtime governed';
}

export interface ApprovalCardDetails {
  readonly action: string;
  readonly location: string;
  readonly reason: string;
  readonly risk: string;
  readonly arguments: string;
}

export function approvalCardDetails(prompt: {
  readonly toolName: string;
  readonly capabilityId: string;
  readonly args: unknown;
  readonly workspacePath?: string;
  readonly reason: string;
  readonly scope: { readonly kind?: string; readonly workspaceRoot?: string };
  readonly riskLevel: unknown;
}): ApprovalCardDetails {
  return {
    action: `${prompt.toolName} (${prompt.capabilityId})`,
    location: prompt.workspacePath || prompt.scope.workspaceRoot || 'Current workspace',
    reason: prompt.reason || 'This action needs your approval before local execution.',
    risk: formatApprovalRisk(prompt.riskLevel),
    arguments: formatApprovalArguments(prompt.args),
  };
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
