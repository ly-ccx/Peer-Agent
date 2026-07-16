import { describe, expect, test } from 'bun:test';

import {
  permissionPolicyForKey,
  permissionPolicyIndex,
  permissionPolicyLabels,
  selectablePermissionPolicy,
  TUI_PERMISSION_POLICIES,
} from './tui-permission-policy.ts';

describe('TUI permission policy', () => {
  test('uses the desktop local-access options as the canonical order', () => {
    expect(TUI_PERMISSION_POLICIES.map(({ policy, label }) => [policy, label])).toEqual([
      ['ask_before_local', 'Ask'],
      ['session_local', 'Approve for me'],
      ['full_local', 'Full access'],
    ]);
  });

  test('keeps the desktop ask level as the safe default and does not expose restricted local', () => {
    expect(selectablePermissionPolicy(undefined)).toBe('ask_before_local');
    expect(selectablePermissionPolicy('invalid')).toBe('ask_before_local');
    expect(selectablePermissionPolicy('restricted_local')).toBe('ask_before_local');
  });

  test('maps direct keys and selection indexes', () => {
    expect(permissionPolicyForKey('1')).toBe('ask_before_local');
    expect(permissionPolicyForKey('2')).toBe('session_local');
    expect(permissionPolicyForKey('3')).toBe('full_local');
    expect(permissionPolicyForKey('4')).toBeNull();
    expect(permissionPolicyIndex('full_local')).toBe(2);
    expect(permissionPolicyIndex('restricted_local')).toBe(0);
  });

  test('provides desktop-aligned full and compact status labels', () => {
    expect(permissionPolicyLabels('ask_before_local')).toEqual({ label: 'ask', shortLabel: 'ask' });
    expect(permissionPolicyLabels('session_local')).toEqual({ label: 'approve for me', shortLabel: 'approve' });
    expect(permissionPolicyLabels('full_local')).toEqual({ label: 'full access', shortLabel: 'full' });
    expect(permissionPolicyLabels('read_only')).toEqual({ label: 'read only', shortLabel: 'read' });
  });
});
