import assert from 'node:assert/strict';
import test from 'node:test';
import type { ClientToolCall } from '@peer-agent/protocol';
import { buildPermissionGateView } from './permissionGateView.ts';

const baseCall: ClientToolCall = {
  toolCallId: 'tc_1',
  capabilityId: 'local.shell.exec',
  displayName: 'bash',
  reason: 'test',
  arguments: { command: 'pnpm test' },
  argumentsPreview: { command: 'pnpm test' },
  riskLevel: 'L4_privileged',
  dataLevel: 'D2_sensitive',
  requestedAt: '2026-07-04T00:00:00.000Z',
};

test('buildPermissionGateView keeps regular local capabilities generic', () => {
  const view = buildPermissionGateView(baseCall, 'zh-CN');
  assert.equal(view.variant, 'default');
  assert.equal(view.isGoalConfirmation, false);
  assert.equal(view.capabilityLabel, 'local.shell.exec');
  assert.equal(view.preview, 'pnpm test');
});

test('buildPermissionGateView renders Goal scope expansion as a dedicated confirmation card', () => {
  const view = buildPermissionGateView({
    ...baseCall,
    capabilityId: 'goal.scope.expand',
    arguments: { path: 'tests/new.test.ts' },
    argumentsPreview: { kind: 'goal-confirmation', confirmationKind: 'scope_expansion' },
    confirmation: { kind: 'scope_expansion', detail: 'tests/new.test.ts' },
    riskLevel: 'L2_local_write',
  }, 'zh-CN');

  assert.equal(view.variant, 'goal-scope');
  assert.equal(view.isGoalConfirmation, true);
  assert.equal(view.capabilityLabel, '范围扩展');
  assert.equal(view.preview, 'tests/new.test.ts');
  assert.equal(view.allowLabel, '确认扩展');
});

test('buildPermissionGateView renders Goal irreversible actions as a dedicated confirmation card', () => {
  const view = buildPermissionGateView({
    ...baseCall,
    capabilityId: 'goal.irreversible.action',
    arguments: { command: 'git push origin dev' },
    argumentsPreview: { kind: 'goal-confirmation', confirmationKind: 'git_push' },
    confirmation: { kind: 'git_push', detail: 'git push origin dev' },
    riskLevel: 'L5_destructive',
  }, 'en-US');

  assert.equal(view.variant, 'goal-irreversible');
  assert.equal(view.isGoalConfirmation, true);
  assert.equal(view.capabilityLabel, 'Irreversible action');
  assert.equal(view.preview, 'git push origin dev');
  assert.equal(view.allowLabel, 'Allow action');
});

test('buildPermissionGateView renders Goal high-risk actions as a dedicated confirmation card', () => {
  const view = buildPermissionGateView({
    ...baseCall,
    capabilityId: 'goal.high_risk.action',
    arguments: { command: 'node build.js' },
    argumentsPreview: { kind: 'goal-confirmation', confirmationKind: 'high_risk' },
    confirmation: {
      kind: 'high_risk',
      detail: 'bash',
      reason: 'goal_high_risk_confirmation',
      riskLevel: 'L4_privileged',
    },
  }, 'zh-CN');

  assert.equal(view.variant, 'goal-high-risk');
  assert.equal(view.isGoalConfirmation, true);
  assert.equal(view.capabilityLabel, '高风险动作');
  assert.equal(view.preview, 'node build.js');
  assert.equal(view.denyLabel, '拒绝执行');
});
