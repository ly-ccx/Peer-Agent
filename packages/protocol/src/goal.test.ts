import assert from 'node:assert/strict';
import test from 'node:test';

import { formatGoalDeliveryRoute, type GoalDeliveryBinding, type GoalPlan } from './goal.ts';

function planWithDelivery(overrides: Partial<GoalPlan> = {}): GoalPlan {
  return {
    planId: 'plan-delivery',
    title: '实现 Task 隔离交付',
    goal: '从知识仓发起，改代码仓',
    status: 'accepted',
    workflowKind: 'goal_self_driven',
    originWorkspacePath: '/repo/peer-knowledge',
    targetWorkspacePath: '/repo/peer_agent',
    tasks: [],
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
    ...overrides,
  };
}

test('GoalPlan 用 targetBranch 表达交付分支，不把 workspace 路径当唯一路由', () => {
  const plan = planWithDelivery({
    targetRepoId: 'peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
  });
  assert.equal(plan.targetBranch, 'PeerAgent/0.0.4');
  assert.notEqual(plan.targetBranch, 'main');
  assert.equal(plan.originWorkspacePath, '/repo/peer-knowledge');
  assert.equal(plan.targetWorkspacePath, '/repo/peer_agent');
  assert.equal(plan.targetRepoId, 'peer_agent');
});

test('缺目标分支时 GoalPlan 保持未绑定，不能假装已经指向 main', () => {
  const plan = planWithDelivery();
  assert.equal(plan.targetBranch, undefined);
  assert.equal(plan.targetBranchSource, undefined);
  assert.equal(plan.deliveryBinding, undefined);
});

test('有代码副作用时 deliveryBinding 必须带确认来源，并允许标明未隔离执行', () => {
  const binding: GoalDeliveryBinding = {
    repoId: 'peer_agent',
    targetWorkspacePath: '/repo/peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    baseCommit: '6d98092',
    targetBranchSource: 'user_confirmed',
    executionIsolation: 'none',
    boundAt: '2026-08-13T06:40:00.000Z',
  };
  const plan = planWithDelivery({
    targetRepoId: binding.repoId,
    targetBranch: binding.targetBranch,
    baseCommit: binding.baseCommit,
    targetBranchSource: binding.targetBranchSource,
    deliveryBinding: binding,
  });
  assert.equal(plan.deliveryBinding?.targetBranch, 'PeerAgent/0.0.4');
  assert.equal(plan.deliveryBinding?.targetBranchSource, 'user_confirmed');
  assert.equal(plan.deliveryBinding?.executionIsolation, 'none');
  assert.notEqual(plan.deliveryBinding?.targetBranch, 'main');
});

test('formatGoalDeliveryRoute 展示来源仓、交付仓和目标分支，不补 main', () => {
  assert.equal(
    formatGoalDeliveryRoute({
      originWorkspacePath: '/repo/peer-knowledge',
      targetWorkspacePath: '/repo/peer_agent',
      targetRepoId: 'peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
    }),
    '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4',
  );
  assert.equal(
    formatGoalDeliveryRoute({
      originWorkspacePath: '/repo/peer-knowledge',
      targetWorkspacePath: '/repo/peer_agent',
    }),
    '来源 peer-knowledge · 交付 peer_agent · 目标分支未确认',
  );
  assert.equal(
    formatGoalDeliveryRoute({
      originWorkspacePath: '/repo/peer_agent',
      targetWorkspacePath: '/repo/peer_agent',
    })?.includes('main'),
    false,
  );
});
