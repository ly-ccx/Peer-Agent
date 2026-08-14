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
      executionIsolation: 'none',
      boundAt: '2026-08-13T16:00:00.000Z',
    },
    ...overrides,
  };
}

function markAccepted(plan) {
  return {
    ...plan,
    status: 'completed',
    resultAcceptance: { acceptedAt: '2026-08-13T18:00:00.000Z', acceptedBy: 'user' },
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
    writeFileSync(path.join(repository, 'user-dirty.txt'), 'leave me\n');
    const store = createStore(boundPlan());
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const isolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: store });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'delivered.txt'), 'from isolation\n');
    const accepted = store.setPlan(markAccepted(store.getPlan('plan-handoff-1')));
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

  it('stops when the target branch moved and does not change the user checkout', async () => {
    const store = createStore(boundPlan());
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const isolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: store });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'delivered.txt'), 'from isolation\n');
    writeFileSync(path.join(repository, 'README.md'), 'moved target\n');
    git(['add', 'README.md']);
    git(['commit', '-m', 'move target']);
    const accepted = store.setPlan(markAccepted(store.getPlan('plan-handoff-1')));
    const checkoutBefore = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    const mainBefore = git(['rev-parse', 'main']);

    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const next = await handoff.handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'stopped');
    assert.equal(next.deliveryHandoff.stoppedReason, 'target_branch_moved');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), checkoutBefore);
    assert.equal(git(['rev-parse', 'main']), mainBefore);
  });

  it('only delivers one accepted Goal to the same target at a time', async () => {
    const firstStore = createStore(boundPlan({ planId: 'plan-a' }));
    const secondStore = createStore(boundPlan({ planId: 'plan-b' }));
    const worktreeAdapter = createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts });
    const firstIsolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: firstStore });
    const secondIsolation = createGoalWorktreeAdapter({ worktreeAdapter, goalPlanStore: secondStore });
    const firstPrepared = await firstIsolation.prepareForPlan(firstStore.getPlan('plan-a'));
    const secondPrepared = await secondIsolation.prepareForPlan(secondStore.getPlan('plan-b'));
    writeFileSync(path.join(firstPrepared.deliveryBinding.worktreePath, 'a.txt'), 'a\n');
    writeFileSync(path.join(secondPrepared.deliveryBinding.worktreePath, 'b.txt'), 'b\n');
    const firstAccepted = firstStore.setPlan(markAccepted(firstStore.getPlan('plan-a')));
    const secondAccepted = secondStore.setPlan(markAccepted(secondStore.getPlan('plan-b')));

    const first = createGoalDeliveryHandoff({ goalPlanStore: firstStore });
    const second = createGoalDeliveryHandoff({ goalPlanStore: secondStore });
    const started = first.handoffPlan(firstAccepted);
    const blocked = await second.handoffPlan(secondAccepted);
    const finished = await started;

    assert.equal(finished.deliveryHandoff.status, 'delivered');
    assert.equal(blocked.deliveryHandoff.status, 'stopped');
    assert.equal(blocked.deliveryHandoff.stoppedReason, 'same_target_busy');
  });

  it('does not hand off a Goal that is not isolated or not accepted', async () => {
    const store = createStore(boundPlan({
      resultAcceptance: undefined,
    }));
    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    const next = await handoff.handoffPlan(store.getPlan('plan-handoff-1'));
    assert.equal(next.deliveryHandoff, undefined);
  });
});
