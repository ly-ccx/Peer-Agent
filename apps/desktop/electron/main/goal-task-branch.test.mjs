import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  createGoalTaskBranchAdapter,
  planNeedsTaskBranch,
  slugifyTaskBranchName,
} from './goal-task-branch.mjs';

let root;
let repository;

function git(args, cwd = repository) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function boundPlan(overrides = {}) {
  return {
    planId: 'plan-task-1',
    title: '实现验收合入',
    status: 'approved',
    activation: { kind: 'approved_plan' },
    targetWorkspacePath: repository,
    deliveryBinding: {
      repoId: 'live-repo',
      targetWorkspacePath: repository,
      targetBranch: 'main',
      baseCommit: git(['rev-parse', 'HEAD']),
      targetBranchSource: 'preconfigured',
      executionIsolation: 'none',
      boundAt: '2026-08-22T06:00:00.000Z',
    },
    ...overrides,
  };
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'peer-goal-task-branch-'));
  repository = path.join(root, 'repository');
  execFileSync('git', ['init', '-b', 'main', repository]);
  git(['config', 'user.email', 'goal-task-branch@test.invalid']);
  git(['config', 'user.name', 'Goal Task Branch']);
  writeFileSync(path.join(repository, 'README.md'), 'baseline\n');
  git(['add', 'README.md']);
  git(['commit', '-m', 'baseline']);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('goal task branch', () => {
  it('slugifies a title without inventing main', () => {
    assert.equal(slugifyTaskBranchName('实现验收合入', 'plan-1'), 'plan-1');
    assert.match(slugifyTaskBranchName('Fix the gate!!!', 'plan-1'), /fix-the-gate/);
    assert.equal(slugifyTaskBranchName('修复会话阴影截断', 'plan-shadow'), 'plan-shadow');
    assert.equal(slugifyTaskBranchName('Fix 会话阴影 123', 'plan-1'), 'fix-123');
    assert.match(slugifyTaskBranchName('实现验收合入', 'plan-1'), /^[a-z0-9-]+$/);
  });

  it('does not create a line for intake, awaiting approval, or unbound plans', () => {
    assert.equal(planNeedsTaskBranch({
      planId: 'intake',
      status: 'accepted',
      activation: { kind: 'intake' },
      targetWorkspacePath: repository,
      deliveryBinding: { targetBranch: 'main', targetWorkspacePath: repository },
    }), false);
    assert.equal(planNeedsTaskBranch({
      planId: 'waiting',
      status: 'awaiting_approval',
      activation: { kind: 'approval_required' },
      targetWorkspacePath: repository,
      deliveryBinding: { targetBranch: 'main', targetWorkspacePath: repository },
    }), false);
    assert.equal(planNeedsTaskBranch({
      planId: 'unbound',
      status: 'approved',
      activation: { kind: 'approved_plan' },
      targetWorkspacePath: repository,
    }), false);
  });

  it('creates a prefixed task branch from the bound base and records isolation none', () => {
    const recorded = [];
    const adapter = createGoalTaskBranchAdapter({
      resolvePrefix: () => 'PeerAgent/',
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

    const next = adapter.ensureTaskBranch(boundPlan());
    assert.equal(next.deliveryBinding.executionIsolation, 'none');
    assert.match(next.deliveryBinding.taskBranch, /^PeerAgent\//);
    assert.match(next.deliveryBinding.taskBranch, /^PeerAgent\/[a-z0-9-]+$/);
    assert.equal(next.deliveryBinding.taskBranch, 'PeerAgent/plan-task-1');
    assert.equal(next.deliveryBinding.worktreePath, undefined);
    assert.equal(recorded[0].isolation.executionIsolation, 'none');
    assert.equal(git(['rev-parse', '--verify', next.deliveryBinding.taskBranch]), git(['rev-parse', 'HEAD']));
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), next.deliveryBinding.taskBranch);
  });

  it('only creates the ref when the working tree is dirty', () => {
    writeFileSync(path.join(repository, 'dirty.txt'), 'leave me\n');
    const adapter = createGoalTaskBranchAdapter({
      resolvePrefix: () => 'PeerAgent/',
      goalPlanStore: {
        recordDeliveryIsolation(_planId, isolation) {
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
    const next = adapter.ensureTaskBranch(boundPlan());
    assert.ok(next.deliveryBinding.taskBranch);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
    assert.equal(git(['rev-parse', '--verify', next.deliveryBinding.taskBranch]), git(['rev-parse', 'main']));
  });

  it('does not recreate a line once taskBranch is already recorded', () => {
    let created = 0;
    const adapter = createGoalTaskBranchAdapter({
      runGit() {
        created += 1;
        throw new Error('should not run git');
      },
    });
    const plan = boundPlan({
      deliveryBinding: {
        ...boundPlan().deliveryBinding,
        taskBranch: 'PeerAgent/already',
      },
    });
    assert.equal(adapter.ensureTaskBranch(plan), plan);
    assert.equal(created, 0);
  });
});
