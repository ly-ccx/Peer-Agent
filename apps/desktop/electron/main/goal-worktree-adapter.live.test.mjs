import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { resolveActiveGoalExecutionBinding } from './chat-runtime/goal-mode-gate.mjs';
import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';
import { createGoalWorktreeAdapter } from './goal-worktree-adapter.mjs';

let root;
let repository;
let worktrees;
let artifacts;

function git(args, cwd = repository) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function createStore(initialPlan) {
  const plans = new Map([[initialPlan.planId, structuredClone(initialPlan)]]);
  return {
    getPlan(planId) {
      return plans.get(planId) || null;
    },
    recordDeliveryIsolation(planId, isolation = {}) {
      const plan = plans.get(planId);
      if (!plan) return null;
      const next = {
        ...plan,
        deliveryBinding: {
          ...plan.deliveryBinding,
          executionIsolation: isolation.executionIsolation ?? 'worktree',
          ...(isolation.taskBranch
            ? { taskBranch: isolation.taskBranch }
            : { taskBranch: undefined }),
          ...(isolation.worktreePath
            ? { worktreePath: isolation.worktreePath }
            : { worktreePath: undefined }),
        },
      };
      if (!isolation.taskBranch) delete next.deliveryBinding.taskBranch;
      if (!isolation.worktreePath) delete next.deliveryBinding.worktreePath;
      plans.set(planId, next);
      return next;
    },
  };
}

function boundPlan(overrides = {}) {
  return {
    planId: 'plan-live-1',
    status: 'executing',
    activation: { kind: 'accepted_goal' },
    originWorkspacePath: path.join(root, 'origin-notes'),
    targetWorkspacePath: repository,
    deliveryBinding: {
      repoId: 'live-repo',
      targetWorkspacePath: repository,
      targetBranch: 'main',
      targetBranchSource: 'workspace_head',
      executionIsolation: 'worktree',
      boundAt: '2026-08-13T16:00:00.000Z',
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-goal-worktree-live-'));
  repository = path.join(root, 'repository');
  worktrees = path.join(root, 'worktrees');
  artifacts = path.join(root, 'artifacts');
  execFileSync('git', ['init', '-b', 'main', repository]);
  git(['config', 'user.email', 'goal-live@test.invalid']);
  git(['config', 'user.name', 'Goal Live']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('goal worktree live isolation', () => {
  it('creates a real worktree for a bound Goal and writes only there', async () => {
    writeFileSync(path.join(repository, 'user-dirty.txt'), 'do not touch\n');
    const store = createStore(boundPlan());
    const adapter = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });

    const prepared = await adapter.prepareForPlan(store.getPlan('plan-live-1'));
    const worktreePath = prepared.deliveryBinding.worktreePath;
    const taskBranch = prepared.deliveryBinding.taskBranch;

    assert.equal(prepared.deliveryBinding.executionIsolation, 'worktree');
    assert.ok(worktreePath);
    assert.ok(worktreePath.startsWith(worktrees));
    assert.ok(existsSync(worktreePath));
    assert.ok(taskBranch);
    assert.equal(git(['-C', repository, 'status', '--porcelain']), '?? user-dirty.txt');
    assert.equal(existsSync(path.join(repository, 'goal-only.txt')), false);

    const binding = resolveActiveGoalExecutionBinding('c1', prepared.originWorkspacePath, {
      getActivePlanByConversation: () => prepared,
    });
    assert.equal(binding.executionWorkspacePath, path.resolve(worktreePath));
    assert.deepEqual(binding.writableRoots, [path.resolve(worktreePath)]);

    writeFileSync(path.join(worktreePath, 'goal-only.txt'), 'isolated write\n');
    assert.equal(existsSync(path.join(repository, 'goal-only.txt')), false);
    assert.equal(readFileSync(path.join(worktreePath, 'goal-only.txt'), 'utf8'), 'isolated write\n');
    assert.equal(git(['-C', repository, 'status', '--porcelain']), '?? user-dirty.txt');
    assert.match(git(['-C', worktreePath, 'status', '--porcelain']), /goal-only\.txt/);
  });

  it('does not create a worktree for Q&A, intake, or unbound Goals', async () => {
    const adapter = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
    });

    await adapter.prepareForPlan({
      planId: 'qa',
      status: 'executing',
      activation: { kind: 'intake' },
      targetWorkspacePath: repository,
    });
    await adapter.prepareForPlan({
      planId: 'unbound',
      status: 'executing',
      activation: { kind: 'accepted_goal' },
      targetWorkspacePath: repository,
    });

    assert.equal(existsSync(worktrees), false);
    assert.equal(git(['status', '--porcelain']), '');
  });

  it('cleans an unused worktree and keeps one that has changes', async () => {
    const cleanStore = createStore(boundPlan({ planId: 'plan-clean' }));
    const dirtyStore = createStore(boundPlan({ planId: 'plan-dirty' }));
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const cleanAdapter = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: cleanStore });
    const dirtyAdapter = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: dirtyStore });

    const cleanPrepared = await cleanAdapter.prepareForPlan(cleanStore.getPlan('plan-clean'));
    const dirtyPrepared = await dirtyAdapter.prepareForPlan(dirtyStore.getPlan('plan-dirty'));
    const cleanPath = cleanPrepared.deliveryBinding.worktreePath;
    const dirtyPath = dirtyPrepared.deliveryBinding.worktreePath;

    writeFileSync(path.join(dirtyPath, 'kept.txt'), 'keep this change\n');

    const cleaned = await cleanAdapter.retainOrCleanupPlan(cleanStore.getPlan('plan-clean'));
    const retained = await dirtyAdapter.retainOrCleanupPlan(dirtyStore.getPlan('plan-dirty'));

    assert.equal(existsSync(cleanPath), false);
    assert.equal(cleaned.deliveryBinding.worktreePath, undefined);
    assert.equal(cleaned.deliveryBinding.taskBranch, undefined);
    assert.equal(existsSync(dirtyPath), true);
    assert.equal(retained.deliveryBinding.worktreePath, dirtyPath);
    assert.equal(readFileSync(path.join(dirtyPath, 'kept.txt'), 'utf8'), 'keep this change\n');
    assert.equal(existsSync(path.join(repository, 'kept.txt')), false);
    assert.equal(git(['status', '--porcelain']), '');
  });

  it('removes the isolated worktree after a successful delivery', async () => {
    const store = createStore(boundPlan({
      planId: 'plan-delivered',
      deliveryHandoff: { status: 'delivered' },
    }));
    const adapter = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await adapter.prepareForPlan(store.getPlan('plan-delivered'));
    const worktreePath = prepared.deliveryBinding.worktreePath;
    const taskBranch = prepared.deliveryBinding.taskBranch;
    writeFileSync(path.join(worktreePath, 'landed.txt'), 'already handed off\n');
    const cleaned = await adapter.retainOrCleanupPlan(store.getPlan('plan-delivered'));
    assert.equal(existsSync(worktreePath), false);
    assert.equal(cleaned.deliveryBinding.worktreePath, undefined);
    assert.equal(cleaned.deliveryBinding.taskBranch, taskBranch);
    assert.equal(cleaned.deliveryBinding.executionIsolation, 'none');
    assert.ok(git(['rev-parse', '--verify', `refs/heads/${taskBranch}`]));
  });

  it('upgrades an existing task branch into a worktree without creating another branch', async () => {
    git(['branch', '--', 'PeerAgent/task-live', 'HEAD']);
    const store = createStore(boundPlan({
      planId: 'plan-upgrade',
      deliveryBinding: {
        ...boundPlan().deliveryBinding,
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/task-live',
      },
    }));
    const adapter = createGoalWorktreeAdapter({
      rootDir: worktrees,
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });

    const isolated = await adapter.isolatePlan(store.getPlan('plan-upgrade'));
    assert.equal(isolated.ok, true);
    const worktreePath = isolated.plan.deliveryBinding.worktreePath;
    assert.equal(isolated.plan.deliveryBinding.executionIsolation, 'worktree');
    assert.equal(isolated.plan.deliveryBinding.taskBranch, 'PeerAgent/task-live');
    assert.ok(worktreePath.startsWith(worktrees));
    assert.ok(existsSync(worktreePath));
    assert.equal(git(['branch', '--show-current']), 'main');
    assert.equal(git(['branch', '--show-current'], worktreePath), 'PeerAgent/task-live');
    assert.equal(git(['branch', '--list', 'PeerAgent/automation-*']), '');

    writeFileSync(path.join(worktreePath, 'isolated.txt'), 'from upgrade\n');
    const discarded = await adapter.discardLine(store.getPlan('plan-upgrade'), { deleteBranch: true });
    assert.equal(discarded.ok, true);
    assert.equal(existsSync(worktreePath), false);
    assert.equal(discarded.plan.deliveryBinding.taskBranch, undefined);
    assert.equal(discarded.plan.deliveryBinding.worktreePath, undefined);
    assert.throws(() => git(['rev-parse', '--verify', '--quiet', 'refs/heads/PeerAgent/task-live']));
  });

  it('clears isolation when the recorded worktree is already gone', async () => {
    const store = createStore(boundPlan({ planId: 'plan-stale' }));
    const adapter = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await adapter.prepareForPlan(store.getPlan('plan-stale'));
    const worktreePath = prepared.deliveryBinding.worktreePath;
    rmSync(worktreePath, { recursive: true, force: true });

    const [first, second] = await Promise.all([
      adapter.retainOrCleanupPlan(store.getPlan('plan-stale')),
      adapter.retainOrCleanupPlan(store.getPlan('plan-stale')),
    ]);

    assert.equal(existsSync(worktreePath), false);
    assert.equal(first.deliveryBinding.worktreePath, undefined);
    assert.equal(second.deliveryBinding.worktreePath, undefined);
  });
});
