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
    assert.equal(slugifyTaskBranchName('实现验收合入', 'plan-1'), '实现验收合入');
    assert.match(slugifyTaskBranchName('Fix the gate!!!', 'plan-1'), /fix-the-gate/);
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

  it('creates a prefixed task branch for an isolated plan and records isolation worktree', () => {
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
              executionIsolation: isolation.executionIsolation ?? 'none',
            },
          };
        },
      },
    });

    const isolatedPlan = {
      ...boundPlan(),
      deliveryBinding: {
        ...boundPlan().deliveryBinding,
        executionIsolation: 'worktree',
      },
    };
    const next = adapter.ensureTaskBranch(isolatedPlan);
    assert.equal(next.deliveryBinding.executionIsolation, 'worktree');
    assert.match(next.deliveryBinding.taskBranch, /^PeerAgent\//);
    assert.equal(next.deliveryBinding.worktreePath, undefined);
    assert.equal(recorded[0].isolation.executionIsolation, 'worktree');
    assert.equal(git(['rev-parse', '--verify', next.deliveryBinding.taskBranch]), git(['rev-parse', 'HEAD']));
  });

  it('ADR 68：非隔离（direct）计划不再创建任务线', () => {
    // 非隔离计划没有合回动作；空壳 ref 只会误导 UI 画合回路线图。
    assert.equal(planNeedsTaskBranch(boundPlan()), false);
  });

  it('ADR 68：隔离（worktree）计划仍创建任务线', () => {
    assert.equal(planNeedsTaskBranch({
      ...boundPlan(),
      deliveryBinding: {
        ...boundPlan().deliveryBinding,
        executionIsolation: 'worktree',
      },
    }), true);
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
    const isolatedPlan = {
      ...boundPlan(),
      deliveryBinding: {
        ...boundPlan().deliveryBinding,
        executionIsolation: 'worktree',
      },
    };
    const next = adapter.ensureTaskBranch(isolatedPlan);
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
