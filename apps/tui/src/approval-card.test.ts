import { describe, expect, test } from 'bun:test';

import {
  approvalCardDetails,
  approvalDecisionForKey,
  formatApprovalArguments,
  formatApprovalRisk,
  moveApprovalSelection,
  TUI_APPROVAL_OPTIONS,
} from './approval-card.ts';

describe('TUI approval card', () => {
  test('exposes the three ordered approval choices', () => {
    expect(TUI_APPROVAL_OPTIONS.map(({ label, decision }) => [label, decision])).toEqual([
      ['Allow once', 'allow-once'],
      ['Allow similar this session', 'allow-session'],
      ['Deny', 'deny'],
    ]);
  });

  test('formats governed request details without unbounded output', () => {
    expect(formatApprovalArguments({ path: 'notes.txt' })).toBe('{ "path": "notes.txt" }');
    expect(formatApprovalArguments('abcdef', 4)).toBe('abc…');
    expect(formatApprovalRisk('HIGH')).toBe('high');
    expect(formatApprovalRisk(undefined)).toBe('runtime governed');
  });

  test('builds a clear action, location, reason, and risk hierarchy', () => {
    expect(approvalCardDetails({
      toolName: 'Write file',
      capabilityId: 'file.write',
      args: { path: 'notes.txt' },
      workspacePath: '/tmp/project',
      reason: 'Writes local data',
      scope: { workspaceRoot: '/tmp/project' },
      riskLevel: 'HIGH',
    })).toEqual({
      action: 'Write file (file.write)',
      location: '/tmp/project',
      reason: 'Writes local data',
      risk: 'high',
      arguments: '{ "path": "notes.txt" }',
    });
  });

  test('cycles keyboard selection in both directions', () => {
    expect(moveApprovalSelection(0, 1)).toBe(1);
    expect(moveApprovalSelection(2, 1)).toBe(0);
    expect(moveApprovalSelection(0, -1)).toBe(2);
  });

  test('resolves Enter, numeric shortcuts, compatibility keys, and Escape', () => {
    expect(approvalDecisionForKey('enter', 0)).toBe('allow-once');
    expect(approvalDecisionForKey('return', 1)).toBe('allow-session');
    expect(approvalDecisionForKey('1', 2)).toBe('allow-once');
    expect(approvalDecisionForKey('2', 0)).toBe('allow-session');
    expect(approvalDecisionForKey('3', 0)).toBe('deny');
    expect(approvalDecisionForKey('y', 2)).toBe('allow-once');
    expect(approvalDecisionForKey('n', 0)).toBe('deny');
    expect(approvalDecisionForKey('escape', 0)).toBe('deny');
    expect(approvalDecisionForKey('x', 0)).toBeNull();
  });
});
