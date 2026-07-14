import { describe, expect, test } from 'bun:test';

import {
  approvalDecisionForKey,
  moveApprovalSelection,
  TUI_APPROVAL_OPTIONS,
} from './approval-card.ts';

describe('TUI approval card', () => {
  test('exposes the three ordered approval choices', () => {
    expect(TUI_APPROVAL_OPTIONS.map(({ label, decision }) => [label, decision])).toEqual([
      ['Allow once', 'allow-once'],
      ['Allow for session', 'allow-session'],
      ['Deny', 'deny'],
    ]);
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
