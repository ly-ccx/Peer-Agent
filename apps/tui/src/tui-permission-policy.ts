import {
  normalizeRuntimePermissionPolicy,
  type RuntimePermissionPolicy,
} from '@peer-agent/runtime-node';

export interface TuiPermissionPolicyOption {
  readonly policy: Exclude<RuntimePermissionPolicy, 'custom'>;
  readonly label: string;
  readonly shortLabel: string;
  readonly shortcut: string;
  readonly description: string;
}

export const TUI_PERMISSION_POLICIES: readonly TuiPermissionPolicyOption[] = Object.freeze([
  {
    policy: 'ask',
    label: 'Ask',
    shortLabel: 'ask',
    shortcut: '1',
    description: 'Read freely; ask before writes and commands.',
  },
  {
    policy: 'read-only',
    label: 'Read only',
    shortLabel: 'read',
    shortcut: '2',
    description: 'Never write or execute mutating commands.',
  },
  {
    policy: 'workspace-write',
    label: 'Workspace write',
    shortLabel: 'write',
    shortcut: '3',
    description: 'Allow scoped session grants inside this workspace.',
  },
]);

export function selectablePermissionPolicy(value: string | null | undefined): Exclude<RuntimePermissionPolicy, 'custom'> {
  const normalized = normalizeRuntimePermissionPolicy(value);
  return normalized === 'custom' ? 'ask' : normalized;
}

export function permissionPolicyOption(policy: RuntimePermissionPolicy): TuiPermissionPolicyOption | null {
  return TUI_PERMISSION_POLICIES.find((option) => option.policy === policy) ?? null;
}

export function permissionPolicyIndex(policy: RuntimePermissionPolicy): number {
  const index = TUI_PERMISSION_POLICIES.findIndex((option) => option.policy === policy);
  return index < 0 ? 0 : index;
}

export function permissionPolicyForKey(keyName: string): Exclude<RuntimePermissionPolicy, 'custom'> | null {
  return TUI_PERMISSION_POLICIES.find((option) => option.shortcut === keyName)?.policy ?? null;
}

export function permissionPolicyLabels(policy: RuntimePermissionPolicy): {
  readonly label: string;
  readonly shortLabel: string;
} {
  if (policy === 'custom') return { label: 'custom', shortLabel: 'custom' };
  const option = permissionPolicyOption(policy) ?? TUI_PERMISSION_POLICIES[0]!;
  return { label: option.label.toLowerCase(), shortLabel: option.shortLabel };
}
