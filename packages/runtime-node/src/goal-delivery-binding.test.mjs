import assert from 'node:assert/strict';
import test from 'node:test';

import { attachWorkspaceHeadBinding } from './goal-delivery-binding.mjs';

test('有目标仓且能读到 HEAD 时才建立未隔离交付绑定', () => {
  const plan = attachWorkspaceHeadBinding({
    planId: 'p1',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: '/repo/peer_agent',
  }, {
    now: '2026-08-13T06:50:00.000Z',
    readWorkspaceHead: (root) => {
      assert.equal(root, '/repo/peer_agent');
      return { branch: 'PeerAgent/0.0.4', commit: '6d98092' };
    },
  });
  assert.equal(plan.targetBranch, 'PeerAgent/0.0.4');
  assert.equal(plan.targetBranchSource, 'workspace_head');
  assert.equal(plan.deliveryBinding?.executionIsolation, 'none');
  assert.notEqual(plan.targetBranch, 'main');
});

test('intake / 纯问答不建立交付绑定', () => {
  const plan = attachWorkspaceHeadBinding({
    planId: 'p-intake',
    activation: { kind: 'intake' },
    targetWorkspacePath: '/repo/peer_agent',
  }, {
    readWorkspaceHead: () => ({ branch: 'PeerAgent/0.0.4', commit: '6d98092' }),
  });
  assert.equal(plan.deliveryBinding, undefined);
  assert.equal(plan.targetBranch, undefined);
});

test('读不到当前分支时保持未绑定，不补 main', () => {
  const plan = attachWorkspaceHeadBinding({
    planId: 'p-nogit',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: '/tmp/not-a-repo',
  }, {
    readWorkspaceHead: () => null,
  });
  assert.equal(plan.deliveryBinding, undefined);
  assert.equal(plan.targetBranch, undefined);
});
