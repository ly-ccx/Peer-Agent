import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';
import { createGoalDeliveryHandoff } from './goal-delivery-handoff.mjs';
import { createGoalWorktreeAdapter } from './goal-worktree-adapter.mjs';

let root;
let repository;
let worktrees;
let artifacts;

function git(args, cwd = repository) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function checkoutDetachedFromTarget() {
  git(['switch', '-c', 'user-wip']);
}

function createStore(initialPlan) {
  const plans = new Map([[initialPlan.planId, structuredClone(initialPlan)]]);
  return {
    getPlan(planId) {
      return plans.get(planId) || null;
    },
    setPlan(plan) {
      plans.set(plan.planId, plan);
      return plan;
    },
    recordDeliveryIsolation(planId, isolation = {}) {
      const plan = plans.get(planId);
      if (!plan) return null;
      const next = {
        ...plan,
        deliveryBinding: {
          ...plan.deliveryBinding,
          ...isolation,
          executionIsolation: isolation.executionIsolation ?? 'worktree',
        },
      };
      if (!isolation.taskBranch) delete next.deliveryBinding.taskBranch;
      if (!isolation.worktreePath) delete next.deliveryBinding.worktreePath;
      plans.set(planId, next);
      return next;
    },
    recordDeliveryHandoff(planId, handoff = {}) {
      const plan = plans.get(planId);
      if (!plan) return null;
      const next = {
        ...plan,
        deliveryHandoff: {
          ...handoff,
          updatedAt: handoff.updatedAt || '2026-08-13T18:00:00.000Z',
        },
      };
      plans.set(planId, next);
      return next;
    },
  };
}

function boundPlan(overrides = {}) {
  return {
    planId: 'plan-handoff-1',
    status: 'executing',
    activation: { kind: 'accepted_goal' },
    targetWorkspacePath: repository,
    qualityReview: { status: 'passed' },
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

function markCompleted(plan) {
  return {
    ...plan,
    status: 'completed',
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-goal-handoff-'));
  repository = path.join(root, 'repository');
  worktrees = path.join(root, 'worktrees');
  artifacts = path.join(root, 'artifacts');
  execFileSync('git', ['init', '-b', 'main', repository]);
  git(['config', 'user.email', 'goal-handoff@test.invalid']);
  git(['config', 'user.name', 'Goal Handoff']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('goal delivery handoff', () => {
  it('lands isolated changes onto the target branch without touching the user checkout', async () => {
    checkoutDetachedFromTarget();
    writeFileSync(path.join(repository, 'user-dirty.txt'), 'leave me\n');
    const store = createStore(boundPlan());
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const isolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: store });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'delivered.txt'), 'from isolation\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const checkoutBefore = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const mainBefore = git(['rev-parse', 'main']);

    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const next = await handoff.handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.ok(next.deliveryHandoff.commitSha);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), checkoutBefore);
    assert.notEqual(git(['rev-parse', 'main']), mainBefore);
    assert.equal(existsSync(path.join(repository, 'user-dirty.txt')), true);
    assert.equal(git(['show', 'main:delivered.txt']), 'from isolation');
    assert.equal(existsSync(path.join(repository, 'delivered.txt')), false);
  });

  it('rebases onto a moved target branch and still delivers without changing the user checkout', async () => {
    checkoutDetachedFromTarget();
    const store = createStore(boundPlan());
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const isolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: store });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'delivered.txt'), 'from isolation\n');
    const mainBeforeMove = git(['rev-parse', 'main']);
    const movedCommit = git(['commit-tree', `${mainBeforeMove}^{tree}`, '-p', mainBeforeMove, '-m', 'move target']);
    git(['update-ref', 'refs/heads/main', movedCommit]);
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const checkoutBefore = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const mainBefore = git(['rev-parse', 'main']);

    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const next = await handoff.handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.ok(next.deliveryHandoff.commitSha);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), checkoutBefore);
    assert.notEqual(git(['rev-parse', 'main']), mainBefore);
    assert.equal(git(['show', 'main:delivered.txt']), 'from isolation');
  });

  it('stops on rebase conflict when the target branch moved', async () => {
    checkoutDetachedFromTarget();
    const store = createStore(boundPlan());
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const isolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: store });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'conflict.txt'), 'from isolation\n');
    git(['add', 'conflict.txt'], prepared.deliveryBinding.worktreePath);
    git(['commit', '-m', 'isolation change'], prepared.deliveryBinding.worktreePath);
    const checkoutBeforeMove = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    git(['checkout', 'main']);
    writeFileSync(path.join(repository, 'conflict.txt'), 'from target\n');
    git(['add', 'conflict.txt']);
    git(['commit', '-m', 'move target with conflict']);
    git(['checkout', checkoutBeforeMove === 'HEAD' ? '--detach' : checkoutBeforeMove]);
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const checkoutBefore = git(['rev-parse', '--abbrev-ref', 'HEAD']);

    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);
    assert.equal(next.deliveryHandoff.status, 'stopped');
    assert.equal(next.deliveryHandoff.stoppedReason, 'merge_conflict');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), checkoutBefore);
  });

  it('only delivers one accepted Goal to the same target at a time', async () => {
    checkoutDetachedFromTarget();
    const firstStore = createStore(boundPlan({ planId: 'plan-a' }));
    const secondStore = createStore(boundPlan({ planId: 'plan-b' }));
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const firstIsolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: firstStore });
    const secondIsolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: secondStore });
    const firstPrepared = await firstIsolation.prepareForPlan(firstStore.getPlan('plan-a'));
    const secondPrepared = await secondIsolation.prepareForPlan(secondStore.getPlan('plan-b'));
    writeFileSync(path.join(firstPrepared.deliveryBinding.worktreePath, 'a.txt'), 'a\n');
    writeFileSync(path.join(secondPrepared.deliveryBinding.worktreePath, 'b.txt'), 'b\n');
    const firstAccepted = firstStore.setPlan(markCompleted(firstStore.getPlan('plan-a')));
    const secondAccepted = secondStore.setPlan(markCompleted(secondStore.getPlan('plan-b')));

    const first = createGoalDeliveryHandoff({ goalPlanStore: firstStore });
    const second = createGoalDeliveryHandoff({ goalPlanStore: secondStore });
    const started = first.handoffPlan(firstAccepted);
    const blocked = await second.handoffPlan(secondAccepted);
    const finished = await started;

    assert.equal(finished.deliveryHandoff.status, 'delivered');
    assert.equal(blocked.deliveryHandoff.status, 'stopped');
    assert.equal(blocked.deliveryHandoff.stoppedReason, 'same_target_busy');
  });

  it('does not hand off a Goal that is not completed', async () => {
    const store = createStore(boundPlan());
    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const next = await handoff.handoffPlan(store.getPlan('plan-handoff-1'));
    assert.equal(next.deliveryHandoff, undefined);
  });

  it('hands off an isolated Goal after completion even without an acceptance stamp', async () => {
    checkoutDetachedFromTarget();
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'delivered.txt'), 'from isolation\n');
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    assert.equal(completed.resultAcceptance, undefined);
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(completed);
    assert.equal(next.deliveryHandoff.status, 'delivered');
  });

  it('reuses the in-flight handoff for the same plan', async () => {
    checkoutDetachedFromTarget();
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'once.txt'), 'once\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const first = handoff.handoffPlan(accepted);
    const second = handoff.handoffPlan(accepted);
    assert.equal(first, second);
    const next = await first;
    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(git(['rev-list', '--count', 'main']), '2');
  });

  it('fast-forwards a clean checkout that occupies the target branch', async () => {
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'landed.txt'), 'from isolation\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);
    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(readFileSync(path.join(repository, 'landed.txt'), 'utf8'), 'from isolation\n');
    assert.equal(git(['status', '--porcelain']), '');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });

  it('stops when the occupied target checkout is dirty', async () => {
    writeFileSync(path.join(repository, 'user-dirty.txt'), 'leave me\n');
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'blocked.txt'), 'should not land\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const mainBefore = git(['rev-parse', 'main']);
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);
    assert.equal(next.deliveryHandoff.status, 'stopped');
    assert.equal(next.deliveryHandoff.stoppedReason, 'target_checkout_dirty');
    assert.equal(git(['rev-parse', 'main']), mainBefore);
    assert.equal(existsSync(path.join(repository, 'blocked.txt')), false);
    assert.equal(readFileSync(path.join(repository, 'user-dirty.txt'), 'utf8'), 'leave me\n');
  });

  it('retries an explicitly stopped handoff after the checkout is clean', async () => {
    writeFileSync(path.join(repository, 'user-dirty.txt'), 'leave me\n');
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'retry.txt'), 'later\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const stopped = await handoff.handoffPlan(accepted);
    assert.equal(stopped.deliveryHandoff.status, 'stopped');
    rmSync(path.join(repository, 'user-dirty.txt'));
    const retried = await handoff.retryHandoff(store.getPlan('plan-handoff-1'));
    assert.equal(retried.deliveryHandoff.status, 'delivered');
    assert.equal(readFileSync(path.join(repository, 'retry.txt'), 'utf8'), 'later\n');
  });

  it('does not merge a completed Goal that was not isolated', async () => {
    git(['switch', '-c', 'PeerAgent/task-1']);
    writeFileSync(path.join(repository, 'delivered.txt'), 'from task line\n');
    git(['add', 'delivered.txt']);
    git(['commit', '-m', 'task work']);
    const store = createStore(boundPlan({
      deliveryBinding: {
        repoId: 'live-repo',
        targetWorkspacePath: repository,
        targetBranch: 'main',
        targetBranchSource: 'workspace_head',
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/task-1',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }));
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(completed);
    assert.equal(next.deliveryHandoff, undefined);
    assert.equal(git(['rev-parse', 'main']), git(['merge-base', 'main', 'PeerAgent/task-1']));
  });

  it('does not merge a completed unisolated Goal onto a later workspace base', async () => {
    git(['branch', 'develop']);
    git(['switch', '-c', 'PeerAgent/task-2']);
    writeFileSync(path.join(repository, 'onto-develop.txt'), 'land here\n');
    git(['add', 'onto-develop.txt']);
    git(['commit', '-m', 'task work']);
    const mainBefore = git(['rev-parse', 'main']);
    const store = createStore(boundPlan({
      deliveryBinding: {
        repoId: 'live-repo',
        targetWorkspacePath: repository,
        targetBranch: 'main',
        targetBranchSource: 'workspace_head',
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/task-2',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }));
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({
      goalPlanStore: store,
      resolveMergeTarget: () => 'develop',
    }).handoffPlan(completed);
    assert.equal(next.deliveryHandoff, undefined);
    assert.equal(git(['rev-parse', 'main']), mainBefore);
    assert.equal(existsSync(path.join(repository, 'onto-develop.txt')), true);
  });
});
