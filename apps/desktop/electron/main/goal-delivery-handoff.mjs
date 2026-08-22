import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const locks = new Map();
const inFlight = new Map();

function trim(value) {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function nowIso() {
  return new Date().toISOString();
}

function classifyGitError(error) {
  const message = String(error?.stderr || error?.message || error);
  if (/timed?\s*out|ETIMEDOUT/i.test(message)) return 'git_timeout';
  if (/index\.lock|unable to create .*lock|Another git process/i.test(message)) return 'git_lock';
  if (/conflict|CONFLICT|failed/i.test(message)) return 'merge_conflict';
  return null;
}

async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      encoding: 'utf8',
      timeout: 30_000,
    });
    return String(stdout || '').trim();
  } catch (error) {
    const reason = classifyGitError(error);
    if (reason) {
      const next = new Error(reason);
      next.handoffReason = reason;
      next.cause = error;
      throw next;
    }
    throw error;
  }
}

function isAccepted(plan) {
  return Boolean(trim(plan?.resultAcceptance?.acceptedAt));
}

function isQualityReady(plan) {
  if (plan?.qualityReview?.status === 'passed') return true;
  return !plan?.deliveryBinding && !plan?.targetBranch;
}

function defaultMergeTarget(plan) {
  return trim(plan?.deliveryBinding?.targetBranch) || trim(plan?.targetBranch);
}

function alreadyDelivered(plan) {
  return plan?.deliveryHandoff?.status === 'delivered';
}

function alreadyStopped(plan) {
  return plan?.deliveryHandoff?.status === 'stopped';
}

async function commitWorktreeIfNeeded(worktreePath, message) {
  const status = await git(worktreePath, ['status', '--porcelain']);
  if (!status) return git(worktreePath, ['rev-parse', 'HEAD']);
  await git(worktreePath, ['add', '-A']);
  await git(worktreePath, ['commit', '-m', message]);
  return git(worktreePath, ['rev-parse', 'HEAD']);
}

async function mergeIntoTarget({ repositoryRoot, worktreePath, targetBranch, taskBranch, isolated = false }) {
  const checkout = await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const mergeBase = await git(repositoryRoot, ['merge-base', targetBranch, taskBranch]);
  const targetTip = await git(repositoryRoot, ['rev-parse', targetBranch]);
  const canRebaseHere = isolated || checkout === taskBranch;
  if (mergeBase !== targetTip) {
    if (!canRebaseHere) {
      return {
        ok: false,
        reason: 'merge_conflict',
        checkout,
      };
    }
    try {
      await git(worktreePath, ['rebase', targetBranch]);
    } catch (error) {
      try {
        await git(worktreePath, ['rebase', '--abort']);
      } catch {
        // rebase may not have started; keep the original failure
      }
      return {
        ok: false,
        reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
        checkout,
      };
    }
  }

  const occupyingTarget = checkout === targetBranch;
  if (occupyingTarget) {
    const dirty = await git(repositoryRoot, ['status', '--porcelain']);
    if (dirty) {
      return {
        ok: false,
        reason: 'target_checkout_dirty',
        checkout,
      };
    }
    try {
      // occupy target: merge --ff-only
      await git(repositoryRoot, ['merge', '--ff-only', taskBranch]);
      return {
        ok: true,
        commitSha: await git(repositoryRoot, ['rev-parse', 'HEAD']),
        checkout,
      };
    } catch (error) {
      return {
        ok: false,
        reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
        checkout,
      };
    }
  }

  try {
    await git(worktreePath, ['update-ref', `refs/heads/${targetBranch}`, taskBranch]);
    return {
      ok: true,
      commitSha: await git(worktreePath, ['rev-parse', targetBranch]),
      checkout,
    };
  } catch (error) {
    return {
      ok: false,
      reason: error?.handoffReason || classifyGitError(error) || 'merge_conflict',
      checkout,
    };
  }
}

export function createGoalDeliveryHandoff({
  goalPlanStore = null,
  now = nowIso,
  resolveMergeTarget = null,
} = {}) {
  function mergeTargetFor(plan) {
    if (typeof resolveMergeTarget === 'function') {
      const resolved = trim(resolveMergeTarget(plan));
      if (resolved) return resolved;
    }
    return defaultMergeTarget(plan);
  }

  function lockKey(plan) {
    const repo = trim(plan?.deliveryBinding?.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
    const branch = mergeTargetFor(plan);
    if (!repo || !branch) return null;
    return `${repo}::${branch}`;
  }

  function canHandoff(plan) {
    if (!plan || typeof plan !== 'object') return false;
    if (!isAccepted(plan)) return false;
    if (!isQualityReady(plan)) return false;
    const binding = plan.deliveryBinding;
    if (!binding) return false;
    const taskBranch = trim(binding.taskBranch);
    const targetBranch = mergeTargetFor(plan);
    if (!taskBranch || !targetBranch) return false;
    if (binding.executionIsolation === 'worktree') {
      return Boolean(trim(binding.worktreePath));
    }
    return binding.executionIsolation === 'none';
  }
  function stopPlan(plan, reason, extras = {}) {
    const binding = plan.deliveryBinding || {};
    return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      status: 'stopped',
      repoId: binding.repoId,
      targetBranch: extras.targetBranch || trim(binding.targetBranch),
      taskBranch: extras.taskBranch || trim(binding.taskBranch),
      stoppedReason: reason,
      updatedAt: now(),
      ...extras,
    }) || plan;
  }

  async function runHandoff(plan) {
    if (!canHandoff(plan) || alreadyDelivered(plan)) return plan;
    const binding = plan.deliveryBinding;
    const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan.targetWorkspacePath);
    const worktreePath = trim(binding.worktreePath);
    const targetBranch = mergeTargetFor(plan);
    const taskBranch = trim(binding.taskBranch);
    const isolated = binding.executionIsolation === 'worktree';
    const operationRoot = isolated ? worktreePath : repositoryRoot;
    if (!repositoryRoot || !existsSync(repositoryRoot)) return plan;
    if (!operationRoot || !existsSync(operationRoot)) return plan;
    if (isolated && (!worktreePath || !existsSync(worktreePath))) return plan;

    const key = lockKey(plan);
    if (!key) return plan;
    const existing = locks.get(key);
    if (existing && existing.planId !== plan.planId) {
      return stopPlan(plan, 'same_target_busy', { targetBranch, taskBranch });
    }

    const delivering = goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
      status: 'delivering',
      repoId: binding.repoId,
      targetBranch,
      taskBranch,
      updatedAt: now(),
    }) || plan;

    try {
      const checkout = await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
      const canCommitHere = isolated || checkout === taskBranch;
      const commitSha = canCommitHere
        ? await commitWorktreeIfNeeded(
          operationRoot,
          `Peer Agent handoff ${plan.planId}`,
        )
        : await git(repositoryRoot, ['rev-parse', taskBranch]);
      const merged = await mergeIntoTarget({
        repositoryRoot,
        worktreePath: operationRoot,
        targetBranch,
        taskBranch,
        isolated,
      });
      if (!merged.ok) {
        return stopPlan(delivering, merged.reason, {
          targetBranch,
          taskBranch,
          commitSha,
        });
      }
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'delivered',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        commitSha: merged.commitSha || commitSha,
        updatedAt: now(),
      }) || delivering;
    } catch (error) {
      return stopPlan(delivering, error?.handoffReason || String(error?.message || error), {
        targetBranch,
        taskBranch,
      });
    }
  }

  function handoffPlan(plan, { retry = false } = {}) {
    if (!plan || typeof plan !== 'object') return Promise.resolve(plan);
    if (!canHandoff(plan) || alreadyDelivered(plan)) return Promise.resolve(plan);
    if (alreadyStopped(plan) && !retry) return Promise.resolve(plan);

    const existing = inFlight.get(plan.planId);
    if (existing) return existing;

    const key = lockKey(plan);
    if (key) {
      const holder = locks.get(key);
      if (holder && holder.planId !== plan.planId) {
        return Promise.resolve(stopPlan(plan, 'same_target_busy', {
          targetBranch: trim(plan.deliveryBinding?.targetBranch),
          taskBranch: trim(plan.deliveryBinding?.taskBranch),
        }));
      }
      locks.set(key, { planId: plan.planId });
    }
    const task = (async () => {
      try {
        return await runHandoff(plan);
      } finally {
        if (key && locks.get(key)?.planId === plan.planId) locks.delete(key);
      }
    })().finally(() => {
      if (inFlight.get(plan.planId) === task) inFlight.delete(plan.planId);
    });
    inFlight.set(plan.planId, task);
    return task;
  }

  async function retryHandoff(plan) {
    return handoffPlan(plan, { retry: true });
  }

  return Object.freeze({
    canHandoff,
    lockKey,
    handoffPlan,
    retryHandoff,
  });
}
