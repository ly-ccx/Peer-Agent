import { describe, expect, test } from 'bun:test';

import {
  permissionPolicyForKey,
  permissionPolicyIndex,
  permissionPolicyLabels,
  selectablePermissionPolicy,
  TUI_PERMISSION_POLICIES,
} from './tui-permission-policy.ts';

describe('TUI permission policy', () => {
  test('exposes only implemented session policies in the designed order', () => {
    expect(TUI_PERMISSION_POLICIES.map(({ policy, label }) => [policy, label])).toEqual([
      ['ask', 'Ask'],
      ['read-only', 'Read only'],
      ['workspace-write', 'Workspace write'],
    ]);
  });

  test('keeps ask as the safe default and does not expose custom without a rule editor', () => {
    expect(selectablePermissionPolicy(undefined)).toBe('ask');
    expect(selectablePermissionPolicy('invalid')).toBe('ask');
    expect(selectablePermissionPolicy('custom')).toBe('ask');
  });

  test('maps direct keys and selection indexes', () => {
    expect(permissionPolicyForKey('1')).toBe('ask');
    expect(permissionPolicyForKey('2')).toBe('read-only');
    expect(permissionPolicyForKey('3')).toBe('workspace-write');
    expect(permissionPolicyForKey('4')).toBeNull();
    expect(permissionPolicyIndex('workspace-write')).toBe(2);
    expect(permissionPolicyIndex('custom')).toBe(0);
  });

  test('provides full and compact status labels', () => {
    expect(permissionPolicyLabels('read-only')).toEqual({ label: 'read only', shortLabel: 'read' });
    expect(permissionPolicyLabels('workspace-write')).toEqual({ label: 'workspace write', shortLabel: 'write' });
    expect(permissionPolicyLabels('custom')).toEqual({ label: 'custom', shortLabel: 'custom' });
  });
});
