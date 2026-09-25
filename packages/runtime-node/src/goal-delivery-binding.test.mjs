import assert from 'node:assert/strict';
import test from 'node:test';

import { attachWorkspaceHeadBinding, resolveWorkspaceHead } from './goal-delivery-binding.mjs';

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

test('绑定跟随实时 HEAD（workspace_head），不再使用 preconfigured 来源', () => {
  const plan = attachWorkspaceHeadBinding({
    planId: 'p-base',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: '/repo/peer_agent',
  }, {
    now: '2026-08-22T06:00:00.000Z',
    readWorkspaceHead: () => ({
      branch: 'PeerAgent/dev/0.0.18',
      commit: 'abc1234',
      source: 'workspace_head',
    }),
  });
  assert.equal(plan.targetBranch, 'PeerAgent/dev/0.0.18');
  assert.equal(plan.targetBranchSource, 'workspace_head');
  assert.equal(plan.deliveryBinding?.targetBranchSource, 'workspace_head');
  assert.equal(plan.deliveryBinding?.baseCommit, 'abc1234');
});

test('ADR 79/传入 preferredBranch 也只绑实时 HEAD，忽略预配置分支', () => {
  const head = resolveWorkspaceHead('/repo/peer_agent', {
    preferredBranch: 'develop',
    run: (_root, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'develop') return 'def5678';
      if (args[0] === 'branch') return 'feature/live';
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'fff9999';
      return '';
    },
  });
  assert.equal(head?.branch, 'feature/live');
  assert.equal(head?.commit, 'fff9999');
  assert.equal(head?.source, 'workspace_head');
  assert.notEqual(head?.branch, 'develop');
});
