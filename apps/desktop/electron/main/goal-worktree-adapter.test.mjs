import assert from 'node:assert/strict';
import test from 'node:test';

import { createGoalWorktreeAdapter, resolveGoalSitePath } from './goal-worktree-adapter.mjs';

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

test('未声明隔离时即使有交付绑定也不建 Worktree', async () => {
  let prepared = 0;
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async prepare() {
        prepared += 1;
        throw new Error('should not prepare');
      },
    },
  });

  const plan = boundPlan();
  assert.equal(adapter.planNeedsIsolatedWorktree(plan), false);
  const next = await adapter.prepareForPlan(plan);
  assert.equal(next, plan);
  assert.equal(prepared, 0);
});

test('显式 worktree 隔离才会创建 Worktree，并回写任务分支和路径', async () => {
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

  const next = await adapter.prepareForPlan(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
    },
  }));
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
      taskBranch: 'PeerAgent/automation-plan-1/run-plan-1',
      worktreePath: '/tmp/peer-goal-worktrees/plan-1',
    },
  }));
  assert.equal(recorded[0].isolation.taskBranch, undefined);
  assert.equal(recorded[0].isolation.worktreePath, undefined);
});

test('交回成功后只收隔离目录，保留任务分支', async () => {
  const recorded = [];
  const gitCalls = [];
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async cleanup() {
        throw new Error('delivered path must not delete the task branch');
      },
    },
    runGit: async (args) => {
      gitCalls.push(args);
      return { stdout: '', stderr: '' };
    },
    goalPlanStore: {
      recordDeliveryIsolation(planId, isolation) {
        recorded.push({ planId, isolation });
        return boundPlan({
          status: 'completed',
          deliveryHandoff: { status: 'delivered' },
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            ...isolation,
          },
        });
      },
    },
  });

  await adapter.retainOrCleanupPlan(boundPlan({
    status: 'completed',
    deliveryHandoff: { status: 'delivered' },
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      taskBranch: 'PeerAgent/feat',
      worktreePath: '/tmp/peer-goal-worktrees/plan-1',
    },
  }));
  assert.equal(recorded[0].isolation.taskBranch, 'PeerAgent/feat');
  assert.equal(recorded[0].isolation.worktreePath, undefined);
  assert.equal(recorded[0].isolation.executionIsolation, 'none');
  assert.ok(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'remove'));
});

test('已有任务分支时给这条线加 Worktree，不再另建 automation 分支', async () => {
  let prepared = 0;
  const gitCalls = [];
  const adapter = createGoalWorktreeAdapter({
    rootDir: '/tmp/peer-goal-worktrees',
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'main\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    worktreeAdapter: {
      async prepare() {
        prepared += 1;
        throw new Error('should not prepare a second branch');
      },
    },
    goalPlanStore: {
      recordDeliveryIsolation(planId, isolation) {
        return boundPlan({
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            ...isolation,
          },
        });
      },
    },
  });

  const next = await adapter.prepareForPlan(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      taskBranch: 'PeerAgent/feat',
      worktreePath: '/tmp/peer-goal-worktrees/does-not-exist',
    },
  }));
  assert.equal(prepared, 0);
  assert.equal(next.deliveryBinding.taskBranch, 'PeerAgent/feat');
  assert.equal(next.deliveryBinding.worktreePath, '/tmp/peer-goal-worktrees/plan-1');
  assert.ok(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'add'));
});

test('isolate 把已有任务线升级为隔离目录', async () => {
  const gitCalls = [];
  const adapter = createGoalWorktreeAdapter({
    rootDir: '/tmp/peer-goal-worktrees',
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'PeerAgent/feat\n', stderr: '' };
      }
      if (args[0] === 'status') return { stdout: '', stderr: '' };
      return { stdout: '', stderr: '' };
    },
    worktreeAdapter: {
      async prepare() {
        throw new Error('should attach the existing branch');
      },
    },
    goalPlanStore: {
      recordDeliveryIsolation(_planId, isolation) {
        return boundPlan({
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            ...isolation,
          },
        });
      },
    },
  });

  const result = await adapter.isolatePlan(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'none',
      taskBranch: 'PeerAgent/feat',
    },
  }));
  assert.equal(result.ok, true);
  assert.equal(result.plan.deliveryBinding.executionIsolation, 'worktree');
  assert.equal(result.plan.deliveryBinding.taskBranch, 'PeerAgent/feat');
  assert.ok(gitCalls.some((args) => args[0] === 'switch' && args[2] === 'PeerAgent/0.0.4'));
  assert.ok(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'add' && args.includes('PeerAgent/feat')));
});

test('主工作区占用任务分支且有脏改动时拒绝隔离', async () => {
  const adapter = createGoalWorktreeAdapter({
    rootDir: '/tmp/peer-goal-worktrees',
    runGit: async (args) => {
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'PeerAgent/feat\n', stderr: '' };
      }
      if (args[0] === 'status') return { stdout: ' M src/app.ts\n', stderr: '' };
      return { stdout: '', stderr: '' };
    },
  });

  const plan = boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'none',
      taskBranch: 'PeerAgent/feat',
    },
  });
  const result = await adapter.isolatePlan(plan);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'task_checkout_dirty');
  assert.equal(result.plan.deliveryBinding.executionIsolation, 'none');
});

test('discardLine 可删隔离目录和任务分支', async () => {
  const gitCalls = [];
  const adapter = createGoalWorktreeAdapter({
    runGit: async (args) => {
      gitCalls.push(args);
      if (args[0] === 'branch' && args[1] === '--show-current') {
        return { stdout: 'main\n', stderr: '' };
      }
      return { stdout: '', stderr: '' };
    },
    goalPlanStore: {
      recordDeliveryIsolation(_planId, isolation) {
        return boundPlan({
          deliveryBinding: {
            ...boundPlan().deliveryBinding,
            ...isolation,
          },
        });
      },
    },
  });

  const result = await adapter.discardLine(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      taskBranch: 'PeerAgent/feat',
      worktreePath: '/tmp/peer-goal-worktrees/plan-1',
    },
  }), { deleteBranch: true });
  assert.equal(result.ok, true);
  assert.equal(result.plan.deliveryBinding.taskBranch, undefined);
  assert.equal(result.plan.deliveryBinding.worktreePath, undefined);
  assert.ok(gitCalls.some((args) => args[0] === 'worktree' && args[1] === 'remove'));
  assert.ok(gitCalls.some((args) => args[0] === 'branch' && args[1] === '-D' && args.includes('PeerAgent/feat')));
});

test('resolveGoalSitePath 隔离时指向 worktree，否则指向目标仓', () => {
  assert.equal(resolveGoalSitePath(boundPlan({
    deliveryBinding: {
      ...boundPlan().deliveryBinding,
      executionIsolation: 'worktree',
      worktreePath: '/tmp/peer-goal-worktrees/plan-1',
    },
  })), '/tmp/peer-goal-worktrees/plan-1');
  assert.equal(resolveGoalSitePath(boundPlan()), '/repo/peer_agent');
});

test('目标仓库已经消失时 prepare 不抛，沿用原计划', async () => {
  const adapter = createGoalWorktreeAdapter({
    worktreeAdapter: {
      async prepare() {
        throw new Error('automation_workspace_missing');
      },
    },
  });
  const plan = boundPlan();
  const next = await adapter.prepareForPlan(plan);
  assert.equal(next, plan);
});
