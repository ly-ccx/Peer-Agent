import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';
import {
  createGoalDeliveryHandoff,
  commitSourceCheckout,
  inspectSourceCheckout,
  resolveHandoffConflicts,
  stashSourceCheckout,
  triageTaskLine,
} from './goal-delivery-handoff.mjs';
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

  it('records delivered for an empty shell even when the occupied target checkout is dirty', async () => {
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    writeFileSync(path.join(repository, 'README.md'), 'user is editing something else\n');
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);
    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(next.deliveryHandoff.verdict, 'AUTO_CLEAN');
    assert.equal(readFileSync(path.join(repository, 'README.md'), 'utf8'), 'user is editing something else\n');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });

  it('fast-forwards when an untracked file in a collapsed directory byte-matches the task change', async () => {
    // 复现 bug：占用目标分支时，未跟踪目录会被 `status --porcelain` 折叠成目录条目（demo/），
    // 旧逻辑对目录条目碰撞保守挡 target_checkout_dirty，即使内容与任务线逐字节一致。
    // 修复后（-uall 展开到单文件）应比对内容、暂移同内容碰撞，再 ff-only 合入。
    const content = '<!doctype html><title>version map</title>\n';
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    const isolationDir = path.join(prepared.deliveryBinding.worktreePath, 'demo');
    mkdirSync(isolationDir, { recursive: true });
    writeFileSync(path.join(isolationDir, 'version-map.html'), content);
    // 用户在占用 main 的工作区里，放着同一份未跟踪内容（且所在目录此前未被 git 跟踪）。
    const userDir = path.join(repository, 'demo');
    mkdirSync(userDir, { recursive: true });
    const userFile = path.join(userDir, 'version-map.html');
    writeFileSync(userFile, content);
    const mainBefore = git(['rev-parse', 'main']);

    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.notEqual(git(['rev-parse', 'main']), mainBefore);
    assert.equal(readFileSync(userFile, 'utf8'), content);
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });

  it('stops when the occupied target checkout has modified tracked files', async () => {
    // ADR 68：untracked 噪音不再挡；modified tracked 才是真脏。
    writeFileSync(path.join(repository, 'README.md'), 'user is editing\n');
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
    assert.equal(readFileSync(path.join(repository, 'README.md'), 'utf8'), 'user is editing\n');
  });

  it('retries an explicitly stopped handoff after the checkout is clean', async () => {
    // ADR 68：用 modified tracked 文件制造真脏；untracked 噪音不再挡合回。
    writeFileSync(path.join(repository, 'README.md'), 'user is editing\n');
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
    execFileSync('git', ['-C', repository, 'checkout', '--', 'README.md']);
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

  // ADR 68：direct 交付事实。非隔离计划完成且工作确实已落目标分支时，补写 delivered 事实。

  it('records a direct delivered fact when the empty task line stays at base', async () => {
    // 空壳任务线：ref 建了但没有独立提交（merge-base == task head == base）。
    git(['branch', 'PeerAgent/task-3']);
    writeFileSync(path.join(repository, 'direct-work.txt'), 'landed on main\n');
    git(['add', 'direct-work.txt']);
    git(['commit', '-m', 'direct work on target']);
    const store = createStore(boundPlan({
      deliveryBinding: {
        repoId: 'live-repo',
        targetWorkspacePath: repository,
        targetBranch: 'main',
        targetBranchSource: 'workspace_head',
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/task-3',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }));
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const handoff = createGoalDeliveryHandoff({ goalPlanStore: store });
    assert.equal(handoff.canRecordDirectDelivery(completed), true);
    const next = await handoff.handoffPlan(completed);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(next.deliveryHandoff.deliveryMode, 'direct');
    assert.equal(next.deliveryHandoff.targetBranch, 'main');
    assert.ok(next.deliveryHandoff.commitSha);
    // 幂等：再次跑不产生第二条记录，也不覆盖。
    const again = await handoff.handoffPlan(next);
    assert.equal(again.deliveryHandoff.updatedAt, next.deliveryHandoff.updatedAt);
  });

  it('records a direct delivered fact when there is no task line and checkout is the target', async () => {
    writeFileSync(path.join(repository, 'direct-work.txt'), 'landed on main\n');
    git(['add', 'direct-work.txt']);
    git(['commit', '-m', 'direct work on target']);
    const store = createStore(boundPlan({
      deliveryBinding: {
        repoId: 'live-repo',
        targetWorkspacePath: repository,
        targetBranch: 'main',
        targetBranchSource: 'workspace_head',
        executionIsolation: 'none',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }));
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(completed);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(next.deliveryHandoff.deliveryMode, 'direct');
  });

  it('does not record a direct delivered fact while the task line has unmerged work', async () => {
    git(['switch', '-c', 'PeerAgent/task-4']);
    writeFileSync(path.join(repository, 'pending-work.txt'), 'still on task line\n');
    git(['add', 'pending-work.txt']);
    git(['commit', '-m', 'pending work']);
    git(['switch', 'main']);
    const store = createStore(boundPlan({
      deliveryBinding: {
        repoId: 'live-repo',
        targetWorkspacePath: repository,
        targetBranch: 'main',
        targetBranchSource: 'workspace_head',
        executionIsolation: 'none',
        taskBranch: 'PeerAgent/task-4',
        boundAt: '2026-08-22T06:00:00.000Z',
      },
    }));
    const completed = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(completed);

    assert.equal(next.deliveryHandoff, undefined);
  });

  // ADR 68：目标检出脏检查分级。untracked 噪音不再一刀切挡住合回。

  it('merges while target checkout has untracked files that do not collide with the task line', async () => {
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    // 任务线（worktree 内）有真实交付内容。
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'feature.txt'), 'task line feature\n');
    // 目标检出：无关的 untracked 噪音（与任务线变更集无碰撞）。
    writeFileSync(path.join(repository, 'noise-unrelated.txt'), 'untracked noise\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(git(['show', `main:${path.basename('feature.txt')}`]).trim(), 'task line feature');
    assert.equal(existsSync(path.join(repository, 'noise-unrelated.txt')), true);
  });

  it('merges when an untracked collision file is byte-identical to the task line version', async () => {
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    // 任务线（worktree 内）交付 demo.txt。
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'demo.txt'), 'same bytes on both sides\n');
    // 目标检出上有同名 untracked 文件，但内容与任务线版本逐字节一致。
    writeFileSync(path.join(repository, 'demo.txt'), 'same bytes on both sides\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'delivered');
    assert.equal(git(['show', 'main:demo.txt']).trim(), 'same bytes on both sides');
    assert.equal(readFileSync(path.join(repository, 'demo.txt'), 'utf8'), 'same bytes on both sides\n');
  });

  it('stays blocked when an untracked collision file differs from the task line version', async () => {
    const store = createStore(boundPlan());
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    const prepared = await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    writeFileSync(path.join(prepared.deliveryBinding.worktreePath, 'demo.txt'), 'task line version\n');
    // 目标检出上同名 untracked 文件内容不同：真碰撞，必须挡。
    writeFileSync(path.join(repository, 'demo.txt'), 'user has different local edits\n');
    const accepted = store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    const next = await createGoalDeliveryHandoff({ goalPlanStore: store }).handoffPlan(accepted);

    assert.equal(next.deliveryHandoff.status, 'stopped');
    // ADR 69：真冲突从环境挡中分离——CONFLICT verdict + 冲突文件清单落进 deliveryHandoff。
    assert.equal(next.deliveryHandoff.stoppedReason, 'merge_conflict_untracked');
    assert.equal(next.deliveryHandoff.verdict, 'CONFLICT');
    assert.deepEqual(next.deliveryHandoff.conflicts, [{ path: 'demo.txt' }]);
    assert.equal(readFileSync(path.join(repository, 'demo.txt'), 'utf8'), 'user has different local edits\n');
  });
});

describe('triageTaskLine (ADR 69 分类器)', () => {
  /** 建一条任务线分支：从 main 拉出新分支，写入文件并提交。返回分支名。 */
  function makeTaskBranch(name, files) {
    git(['switch', '-c', name]);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
      writeFileSync(path.join(repository, file), content);
    }
    git(['add', '-A']);
    git(['commit', '-m', `task ${name}`]);
    git(['switch', 'main']);
    return name;
  }

  it('AUTO_CLEAN：任务线已被目标线包含（ahead=0）→ 空壳静默清理', async () => {
    const task = makeTaskBranch('task/empty', { 'a.txt': 'x\n' });
    // 目标线快进包含任务线提交，使任务线 ahead=0。
    git(['merge', '--ff-only', task]);
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'AUTO_CLEAN');
    assert.equal(res.detail.ahead, 0);
  });

  it('AUTO_CLEAN：ahead=0 时目标工作区 tracked 脏仍记空壳，不挡成环境挡', async () => {
    const task = makeTaskBranch('task/empty-dirty', { 'shell.txt': 'landed\n' });
    git(['merge', '--ff-only', task]);
    writeFileSync(path.join(repository, 'README.md'), 'unrelated dirty work\n');
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'AUTO_CLEAN');
    assert.equal(res.detail.ahead, 0);
    assert.equal(res.reason, 'empty_shell_already_landed');
  });

  it('AUTO_MERGE：无碰撞的新文件变更 → 可自动合', async () => {
    const task = makeTaskBranch('task/clean', { 'new-file.txt': 'hello\n' });
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'AUTO_MERGE');
    assert.ok(res.detail.ahead > 0);
    assert.deepEqual(res.detail.collisions, []);
  });

  it('AUTO_MERGE：同内容未跟踪碰撞 → 可自动合（暂移后落地同一内容）', async () => {
    const content = 'same bytes\n';
    const task = makeTaskBranch('task/identical', { 'demo.txt': content });
    writeFileSync(path.join(repository, 'demo.txt'), content); // 未跟踪、内容一致
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'AUTO_MERGE');
    assert.deepEqual(res.detail.collisions, [{ path: 'demo.txt', kind: 'identical' }]);
  });

  it('CONFLICT：同名未跟踪文件内容不同 → 真冲突浮现给用户', async () => {
    const task = makeTaskBranch('task/diff', { 'demo.txt': 'task version\n' });
    writeFileSync(path.join(repository, 'demo.txt'), 'user local edits\n'); // 未跟踪、内容不同
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'CONFLICT');
    assert.equal(res.reason, 'untracked_content_differs');
    assert.deepEqual(res.detail.collisions, [{ path: 'demo.txt', kind: 'different' }]);
  });

  it('BLOCKED_ENV：目标工作区 tracked 脏 → 环境挡', async () => {
    const task = makeTaskBranch('task/blocked', { 'b.txt': 'y\n' });
    writeFileSync(path.join(repository, 'README.md'), 'dirty tracked edit\n'); // tracked 未提交改动
    const res = await triageTaskLine({ repositoryRoot: repository, taskBranch: task, targetBranch: 'main' });
    assert.equal(res.verdict, 'BLOCKED_ENV');
    assert.equal(res.reason, 'target_checkout_dirty');
    assert.ok(res.detail.blockingEntry);
  });
});

describe('resolveHandoffConflicts (ADR 69 P2 收口执行器)', () => {
  function conflictPlan(repo, taskBranch, conflictPaths) {
    return {
      planId: 'plan-x',
      deliveryBinding: { targetWorkspacePath: repo, targetBranch: 'main', taskBranch },
      deliveryHandoff: { status: 'stopped', verdict: 'CONFLICT', conflicts: conflictPaths.map((p) => ({ path: p })) },
    };
  }
  function makeConflictTask(name, file, taskContent) {
    git(['switch', '-c', name]);
    mkdirSync(path.dirname(path.join(repository, file)), { recursive: true });
    writeFileSync(path.join(repository, file), taskContent);
    git(['add', '-A']);
    git(['commit', '-m', `task ${name}`]);
    git(['switch', 'main']);
    return name;
  }

  it('keep_taskline：暂移工作区版、ff-only 合入任务线版，delivered', async () => {
    const task = makeConflictTask('task/kt', 'demo/p.html', 'task version\n');
    mkdirSync(path.join(repository, 'demo'), { recursive: true });
    writeFileSync(path.join(repository, 'demo', 'p.html'), 'user local\n'); // 未跟踪、内容不同
    const res = await resolveHandoffConflicts({ plan: conflictPlan(repository, task, ['demo/p.html']), resolutions: [{ path: 'demo/p.html', choice: 'keep_taskline' }] });
    assert.equal(res.ok, true);
    assert.equal(res.delivered, true);
    assert.equal(readFileSync(path.join(repository, 'demo', 'p.html'), 'utf8'), 'task version\n');
    assert.equal(readFileSync(path.join(repository, 'demo', 'p.html.worktree-backup'), 'utf8'), 'user local\n');
    assert.equal(git(['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });

  it('keep_both：任务线版另存为 .taskline，工作区版保留，不合并', async () => {
    const headBefore = git(['rev-parse', 'main']);
    const task = makeConflictTask('task/kb', 'demo/q.html', 'task version\n');
    mkdirSync(path.join(repository, 'demo'), { recursive: true });
    writeFileSync(path.join(repository, 'demo', 'q.html'), 'user local\n');
    const res = await resolveHandoffConflicts({ plan: conflictPlan(repository, task, ['demo/q.html']), resolutions: [{ path: 'demo/q.html', choice: 'keep_both' }] });
    assert.equal(res.ok, true);
    assert.equal(res.delivered, false);
    assert.equal(readFileSync(path.join(repository, 'demo', 'q.html'), 'utf8'), 'user local\n');
    assert.equal(readFileSync(path.join(repository, 'demo', 'q.html.taskline'), 'utf8'), 'task version\n');
    assert.equal(git(['rev-parse', 'main']), headBefore); // 未动目标线
  });

  it('keep_worktree：不动 git 不动文件，标记已决', async () => {
    const headBefore = git(['rev-parse', 'main']);
    const task = makeConflictTask('task/kw', 'demo/r.html', 'task version\n');
    mkdirSync(path.join(repository, 'demo'), { recursive: true });
    writeFileSync(path.join(repository, 'demo', 'r.html'), 'user local\n');
    const res = await resolveHandoffConflicts({ plan: conflictPlan(repository, task, ['demo/r.html']), resolutions: [{ path: 'demo/r.html', choice: 'keep_worktree' }] });
    assert.equal(res.ok, true);
    assert.equal(res.delivered, false);
    assert.equal(readFileSync(path.join(repository, 'demo', 'r.html'), 'utf8'), 'user local\n');
    assert.equal(git(['rev-parse', 'main']), headBefore);
  });

  it('未知冲突路径：拒绝并报 unknown_conflict_path', async () => {
    const task = makeConflictTask('task/unk', 'demo/s.html', 'task version\n');
    const res = await resolveHandoffConflicts({ plan: conflictPlan(repository, task, ['demo/s.html']), resolutions: [{ path: 'etc/passwd', choice: 'keep_taskline' }] });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'unknown_conflict_path');
  });
});

describe('source checkout actions', () => {
  it('inspects tracked dirty files on the occupied source checkout', async () => {
    writeFileSync(path.join(repository, 'README.md'), 'blocking work\n');
    const res = await inspectSourceCheckout({ repositoryRoot: repository });
    assert.equal(res.ok, true);
    assert.equal(res.branch, 'main');
    assert.ok(res.files.some((file) => file.path === 'README.md'));
  });

  it('inspects from an explicit workspace even without a plan', async () => {
    writeFileSync(path.join(repository, 'README.md'), 'blocking work\n');
    const res = await createGoalDeliveryHandoff({ goalPlanStore: createStore(boundPlan()) })
      .inspectSource(null, { repositoryRoot: repository });
    assert.equal(res.ok, true);
    assert.ok(res.files.some((file) => file.path === 'README.md'));
  });

  it('commitSourceCheckout treats nothing to commit as ready instead of a failure', async () => {
    const res = await commitSourceCheckout({ repositoryRoot: repository });
    assert.equal(res.ok, true);
    assert.equal(res.reason, 'nothing_to_commit');
  });

  it('commitSourceCheckout surfaces the git stderr when a source commit actually fails', async () => {
    const res = await commitSourceCheckout({
      repositoryRoot: repository,
      gitRunner: async (_cwd, args) => {
        if (args[0] === 'add') return '';
        const error = new Error('Command failed: git commit');
        error.stderr = 'error: pathspec \'README.md\' did not match any file(s) known to git';
        throw error;
      },
    });
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'commit_failed');
    assert.match(res.detail, /pathspec/);
  });

  it('retries all blocked task lines after parking the source checkout', async () => {
    const first = boundPlan({ planId: 'plan-handoff-1' });
    const second = boundPlan({ planId: 'plan-handoff-2' });
    const store = createStore(first);
    store.setPlan(second);
    const isolation = createGoalWorktreeAdapter({
      worktreeAdapter: createAutomationWorktreeAdapter({ rootDir: worktrees, artifactDir: artifacts }),
      goalPlanStore: store,
    });
    await isolation.prepareForPlan(store.getPlan('plan-handoff-1'));
    await isolation.prepareForPlan(store.getPlan('plan-handoff-2'));
    store.setPlan(markCompleted(store.getPlan('plan-handoff-1')));
    store.setPlan(markCompleted(store.getPlan('plan-handoff-2')));
    writeFileSync(path.join(repository, 'README.md'), 'park me\n');
    const parked = await stashSourceCheckout({ repositoryRoot: repository });
    assert.equal(parked.ok, true);
    const retried = await createGoalDeliveryHandoff({ goalPlanStore: store }).retryHandoffs([
      store.getPlan('plan-handoff-1'),
      store.getPlan('plan-handoff-2'),
    ]);
    assert.equal(retried.ok, true);
    assert.equal(retried.results.every((result) => result.ok), true);
    assert.equal(store.getPlan('plan-handoff-1').deliveryHandoff.status, 'delivered');
    assert.equal(store.getPlan('plan-handoff-2').deliveryHandoff.status, 'delivered');
  });
});
