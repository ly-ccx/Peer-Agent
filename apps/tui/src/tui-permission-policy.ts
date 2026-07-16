import type { LocalAccessLevel } from '@peer-agent/protocol';

export type TuiSelectablePermissionPolicy = Exclude<LocalAccessLevel, 'restricted_local'>;
export type TuiPermissionStatus = LocalAccessLevel | 'read_only';

export interface TuiPermissionPolicyOption {
  readonly policy: TuiSelectablePermissionPolicy;
  readonly label: string;
  readonly shortLabel: string;
  readonly shortcut: string;
  readonly description: string;
}

export const TUI_PERMISSION_POLICIES: readonly TuiPermissionPolicyOption[] = Object.freeze([
  {
    policy: 'ask_before_local',
    label: 'Ask',
    shortLabel: 'ask',
    shortcut: '1',
    description: 'Ask before local actions.',
  },
  {
    policy: 'session_local',
    label: 'Approve for me',
    shortLabel: 'approve',
    shortcut: '2',
    description: 'Auto-approve low/medium-risk commands; high-risk actions still ask.',
  },
  {
    policy: 'full_local',
    label: 'Full access',
    shortLabel: 'full',
    shortcut: '3',
    description: 'Auto-approve all local tool calls; use only for trusted tasks.',
  },
]);

export function normalizeLocalAccessLevel(value: unknown): LocalAccessLevel {
  return value === 'ask_before_local'
    || value === 'session_local'
    || value === 'restricted_local'
    || value === 'full_local'
    ? value
    : 'ask_before_local';
}

export function selectablePermissionPolicy(value: unknown): TuiSelectablePermissionPolicy {
  const normalized = normalizeLocalAccessLevel(value);
  return normalized === 'restricted_local' ? 'ask_before_local' : normalized;
}

export function permissionPolicyOption(policy: LocalAccessLevel): TuiPermissionPolicyOption | null {
  return TUI_PERMISSION_POLICIES.find((option) => option.policy === policy) ?? null;
}

export function permissionPolicyIndex(policy: LocalAccessLevel): number {
  const index = TUI_PERMISSION_POLICIES.findIndex((option) => option.policy === policy);
  return index < 0 ? 0 : index;
}

export function permissionPolicyForKey(keyName: string): TuiSelectablePermissionPolicy | null {
  return TUI_PERMISSION_POLICIES.find((option) => option.shortcut === keyName)?.policy ?? null;
}

export function permissionPolicyLabels(policy: TuiPermissionStatus): {
  readonly label: string;
  readonly shortLabel: string;
} {
  if (policy === 'read_only') return { label: 'read only', shortLabel: 'read' };
  if (policy === 'restricted_local') return { label: 'restricted', shortLabel: 'restricted' };
  const option = permissionPolicyOption(policy) ?? TUI_PERMISSION_POLICIES[0]!;
  return { label: option.label.toLowerCase(), shortLabel: option.shortLabel };
}
