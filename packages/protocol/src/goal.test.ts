import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatGoalDeliveryHandoff,
  formatGoalDeliveryHandoffLamp,
  formatGoalDeliveryRoute,
  type GoalDeliveryBinding,
  type GoalPlan,
} from './goal.ts';

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
  } as GoalPlan;
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
    '来源 peer-knowledge · 交付 peer_agent · peer-goal/plan-delivery · from PeerAgent/0.0.4 · 独立执行环境',
  );
});

test('formatGoalDeliveryRoute 有任务子分支时写成 feat · from 源头', () => {
  assert.equal(
    formatGoalDeliveryRoute({
      targetRepoId: 'peer_agent',
      targetBranch: 'develop',
      deliveryBinding: {
        repoId: 'peer_agent',
        targetWorkspacePath: '/repo/peer_agent',
        targetBranch: 'develop',
        targetBranchSource: 'preconfigured',
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/验收合入',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }),
    '交付 peer_agent · PeerAgent/验收合入 · from develop · 未隔离执行',
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

test('formatGoalDeliveryHandoff 有交付线即可展示合回状态，不必先验收', () => {
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
    '已合进 peer_agent / PeerAgent/0.0.4',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'delivering',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '正在合进 0.0.4',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'stopped',
        stoppedReason: 'quality_review_pending',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '质量自检还没过线，没法合进发版线。',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'stopped',
        stoppedReason: 'missing_task_commits',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '任务线还没有可合入的提交。改动还在工作区里，先提交再合并。',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'stopped',
        targetBranch: 'PeerAgent/0.0.4',
        stoppedReason: 'target_branch_moved',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '0.0.4 已更新',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'stopped',
        targetBranch: 'PeerAgent/0.0.4',
        stoppedReason: 'target_checkout_dirty',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '你正在 0.0.4 上改别的东西，还没提交。没法把这条任务合进去。',
  );
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'stopped',
        targetBranch: 'PeerAgent/0.0.4',
        stoppedReason: 'target_checkout_dirty',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '合不进 0.0.4',
  );
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      status: 'completed',
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'idle',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '还没进 0.0.4',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: {
        ...binding,
        executionIsolation: 'none',
        taskBranch: undefined,
        worktreePath: undefined,
      },
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
      deliveryBinding: {
        ...binding,
        executionIsolation: 'none',
        worktreePath: undefined,
      },
      deliveryHandoff: {
        status: 'delivered',
        repoId: 'peer_agent',
        targetBranch: 'PeerAgent/0.0.4',
        updatedAt: '2026-08-14T01:01:00.000Z',
      },
    }),
    '已合进 peer_agent / PeerAgent/0.0.4',
  );
});

test('ADR 68：direct 交付的灯条与标签用交付语义，不出现「还没进/已合进」', () => {
  const binding: GoalDeliveryBinding = {
    repoId: 'peer_agent',
    targetBranch: '0.0.9',
    targetBranchSource: 'preconfigured',
    executionIsolation: 'none',
    taskBranch: 'PeerAgent/提交右侧拖拽修复',
    boundAt: '2026-08-26T06:31:01.091Z',
  };

  // direct delivered：灯条与标签都用「已随交付」。
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'delivered',
        deliveryMode: 'direct',
        targetBranch: '0.0.9',
        updatedAt: '2026-08-26T07:00:00.000Z',
      },
    }),
    '已随 0.0.9 交付',
  );
  assert.equal(
    formatGoalDeliveryHandoff({
      deliveryBinding: binding,
      deliveryHandoff: {
        status: 'delivered',
        deliveryMode: 'direct',
        repoId: 'peer_agent',
        targetBranch: '0.0.9',
        updatedAt: '2026-08-26T07:00:00.000Z',
      },
    }),
    '已随 peer_agent / 0.0.9 交付',
  );

  // 非隔离完成、还没有 handoff 记录：不显示「还没进」（完成即交付，无合回语义）。
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      status: 'completed',
      deliveryBinding: binding,
    }),
    undefined,
  );

  // 隔离计划完成、无记录：仍显示「还没进」（确有待合回的工作）。
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      status: 'completed',
      deliveryBinding: { ...binding, executionIsolation: 'worktree' },
    }),
    '还没进 0.0.9',
  );

  // merge 模式 delivered（缺省 deliveryMode）：维持「已进」。
  assert.equal(
    formatGoalDeliveryHandoffLamp({
      deliveryBinding: { ...binding, executionIsolation: 'worktree' },
      deliveryHandoff: {
        status: 'delivered',
        targetBranch: '0.0.9',
        updatedAt: '2026-08-26T07:00:00.000Z',
      },
    }),
    '已进 0.0.9',
  );
});
