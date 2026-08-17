import assert from 'node:assert/strict';
import test from 'node:test';

import { formatGoalDeliveryHandoff, formatGoalDeliveryRoute, type GoalDeliveryBinding, type GoalPlan } from './goal.ts';

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

test('deliveryBinding 能记下任务分支和 Worktree 路径，并把隔离标成 worktree', () => {
  const binding: GoalDeliveryBinding = {
    repoId: 'peer_agent',
    targetWorkspacePath: '/repo/peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    executionIsolation: 'worktree',
    taskBranch: 'peer-goal/plan-delivery',
    worktreePath: '/tmp/peer-goal-worktrees/plan-delivery',
    boundAt: '2026-08-13T08:40:00.000Z',
  };
  const plan = planWithDelivery({
    targetRepoId: binding.repoId,
    targetBranch: binding.targetBranch,
    targetBranchSource: binding.targetBranchSource,
    deliveryBinding: binding,
  });
  assert.equal(plan.deliveryBinding?.taskBranch, 'peer-goal/plan-delivery');
  assert.equal(plan.deliveryBinding?.worktreePath, '/tmp/peer-goal-worktrees/plan-delivery');
  assert.equal(plan.deliveryBinding?.executionIsolation, 'worktree');
  assert.equal(
    formatGoalDeliveryRoute(plan),
    '来源 peer-knowledge · 交付 peer_agent · PeerAgent/0.0.4 · 独立执行环境',
  );
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

test('formatGoalDeliveryHandoff 只在已隔离且已验收时展示交回状态', () => {
  const binding: GoalDeliveryBinding = {
    repoId: 'peer_agent',
    targetWorkspacePath: '/repo/peer_agent',
    targetBranch: 'PeerAgent/0.0.4',
    targetBranchSource: 'workspace_head',
    executionIsolation: 'worktree',
    taskBranch: 'peer-goal/plan-delivery',
    worktreePath: '/tmp/peer-goal-worktrees/plan-delivery',
    boundAt: '2026-08-13T08:40:00.000Z',
  };
  const accepted = {
    acceptedAt: '2026-08-14T01:00:00.000Z',
    acceptedBy: 'user' as const,
  };
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      resultAcceptance: accepted,
      deliveryHandoff: {
        status: 'delivered',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '已交回 peer_agent / PeerAgent/0.0.4',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      resultAcceptance: accepted,
      deliveryHandoff: {
        status: 'delivering',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '正在交回目标分支',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      resultAcceptance: accepted,
      deliveryHandoff: {
        status: 'stopped',
        stoppedReason: 'target_branch_moved',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '目标分支已更新',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      resultAcceptance: accepted,
      deliveryHandoff: {
        status: 'stopped',
        stoppedReason: 'target_checkout_dirty',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '你正在目标分支上，还有未提交改动，交回已暂停',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: { ...binding, executionIsolation: 'none' },
      resultAcceptance: accepted,
      deliveryHandoff: {
        status: 'delivered',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    undefined,
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'delivered',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    undefined,
  );
});
