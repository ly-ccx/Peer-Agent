import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalWorktreeAdapter } from './goal-worktree-adapter.mjs';

function boundPlan(overrides = {}) {
  return {
    planId: 'plan-1',
    status: 'executing',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: '/repo/peer_agent',
    deliveryBinding: {
      repoId: 'peer_agent',
      targetWorkspacePath: '/repo/peer_agent',
      targetBranch: 'PeerAgent/0.0.4',
      targetBranchSource: 'workspace_head',
      executionIsolation: 'none',
      boundAt: '2026-08-13T08:40:00.000Z',
    },
    ...overrides,
  };
}

test('有交付绑定的 Goal 才创建 Worktree，并回写任务分支和路径', async () => {
  const recorded = [];
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async prepare(run) {
        assert.equal(run.runId, 'plan-1');
        assert.equal(run.snapshot.workspacePath, '/repo/peer_agent');
        return {
          kind: 'worktree',
          workspacePath: '/tmp/peer-goal-worktrees/plan-1',
          worktreePath: '/tmp/peer-goal-worktrees/plan-1',
          repositoryRoot: '/repo/peer_agent',
          branch: 'peer-goal/plan-1',
          baseline: { commit: '6d98092' },
        };
      },
    },
    goalPlanStore: {
      recordDeliveryIsolation(planId, isolation) {
        recorded.push({ planId, isolation });
        return {
          ...boundPlan(),
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            ...isolation,
          },
        };
      },
    },
  });

  const next = await adapter.prepareForPlan(boundPlan());
  assert.equal(next.deliveryBinding.executionIsolation, 'worktree');
  assert.equal(next.deliveryBinding.taskBranch, 'peer-goal/plan-1');
  assert.equal(next.deliveryBinding.worktreePath, '/tmp/peer-goal-worktrees/plan-1');
  assert.equal(recorded.length, 1);
});

test('问答、intake 和未绑定 Goal 不建 Worktree', async () => {
  let prepared = 0;
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async prepare() {
        prepared += 1;
        throw new Error('should not prepare');
      },
    },
  });

  assert.equal(adapter.planNeedsIsolatedWorktree({
    planId: 'q',
    activation: { kind: 'intake' },
    targetWorkspacePath: '/repo/peer_agent',
  }), false);
  assert.equal(adapter.planNeedsIsolatedWorktree({
    planId: 'unbound',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: '/repo/peer_agent',
  }), false);
  await adapter.prepareForPlan({
    planId: 'q',
    activation: { kind: 'intake' },
    targetWorkspacePath: '/repo/peer_agent',
  });
  assert.equal(prepared, 0);
});

test('做完没有改动就清掉 Worktree', async () => {
  const recorded = [];
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async collect(run, execution) {
        assert.equal(run.runId, 'plan-1');
        assert.equal(execution.worktreePath, '/tmp/peer-goal-worktrees/plan-1');
        return { changedFiles: [] };
      },
      async retainOrCleanup(run, execution, changes) {
        assert.equal(run.runId, 'plan-1');
        assert.equal(execution.worktreePath, '/tmp/peer-goal-worktrees/plan-1');
        assert.deepEqual(changes, { changedFiles: [] });
        return { retained: false, changedFiles: [] };
      },
    },
    goalPlanStore: {
      recordDeliveryIsolation(planId, isolation) {
        recorded.push({ planId, isolation });
        return boundPlan({
          status: 'completed',
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            executionIsolation: 'worktree',
          },
        });
      },
    },
  });

  await adapter.retainOrCleanupPlan(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      taskBranch: 'peer-goal/plan-1',
      worktreePath: '/tmp/peer-goal-worktrees/plan-1',
    },
  }));
  assert.equal(recorded[0].isolation.taskBranch, undefined);
  assert.equal(recorded[0].isolation.worktreePath, undefined);
});
