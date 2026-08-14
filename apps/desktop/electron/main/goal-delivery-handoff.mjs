import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const locks = new Map();

function trim(value) {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function nowIso() {
  return new Date().toISOString();
}

async function git(cwd, args) {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    timeout: 30_000,
  });
  return String(stdout || '').trim();
}

function lockKey(plan) {
  const repo = trim(plan?.deliveryBinding?.targetWorkspacePath) || trim(plan?.targetWorkspacePath);
  const branch = trim(plan?.deliveryBinding?.targetBranch) || trim(plan?.targetBranch);
  if (!repo || !branch) return null;
  return `${repo}::${branch}`;
}

function isAccepted(plan) {
  return Boolean(trim(plan?.resultAcceptance?.acceptedAt));
}

function isQualityReady(plan) {
  if (plan?.qualityReview?.status === 'passed') return true;
  return !plan?.deliveryBinding && !plan?.targetBranch;
}

function canHandoff(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (!isAccepted(plan)) return false;
  if (!isQualityReady(plan)) return false;
  const binding = plan.deliveryBinding;
  if (binding?.executionIsolation !== 'worktree') return false;
  return Boolean(trim(binding.worktreePath) && trim(binding.taskBranch) && trim(binding.targetBranch));
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

async function mergeIntoTarget({ repositoryRoot, worktreePath, targetBranch, taskBranch }) {
  const checkout = await git(repositoryRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const mergeBase = await git(worktreePath, ['merge-base', targetBranch, taskBranch]);
  const targetTip = await git(worktreePath, ['rev-parse', targetBranch]);
  if (mergeBase !== targetTip) {
    return {
      ok: false,
      reason: 'target_branch_moved',
      checkout,
    };
  }
  try {
    await git(worktreePath, ['update-ref', `refs/heads/${targetBranch}`, taskBranch]);
    return {
      ok: true,
      commitSha: await git(worktreePath, ['rev-parse', targetBranch]),
      checkout,
    };
  } catch (error) {
    const message = String(error?.stderr || error?.message || error);
    if (/conflict|CONFLICT|failed/i.test(message)) {
      return { ok: false, reason: 'merge_conflict', checkout };
    }
    throw error;
  }
}

export function createGoalDeliveryHandoff({
  goalPlanStore = null,
  now = nowIso,
} = {}) {
  async function handoffPlan(plan) {
    if (!canHandoff(plan) || alreadyDelivered(plan) || alreadyStopped(plan)) return plan;
    const binding = plan.deliveryBinding;
    const repositoryRoot = trim(binding.targetWorkspacePath) || trim(plan.targetWorkspacePath);
    const worktreePath = trim(binding.worktreePath);
    const targetBranch = trim(binding.targetBranch);
    const taskBranch = trim(binding.taskBranch);
    if (!repositoryRoot || !worktreePath || !existsSync(worktreePath)) return plan;

    const key = lockKey(plan);
    if (!key) return plan;
    if (locks.has(key) && locks.get(key) !== plan.planId) {
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'stopped',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        stoppedReason: 'same_target_busy',
        updatedAt: now(),
      }) || plan;
    }

    locks.set(key, plan.planId);
    try {
      const delivering = goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'delivering',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        updatedAt: now(),
      }) || plan;
      const commitSha = await commitWorktreeIfNeeded(
        worktreePath,
        `peer: deliver ${plan.planId} to ${targetBranch}`,
      );
      const merged = await mergeIntoTarget({
        repositoryRoot,
        worktreePath,
        targetBranch,
        taskBranch,
      });
      if (!merged.ok) {
        return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
          status: 'stopped',
          repoId: binding.repoId,
          targetBranch,
          taskBranch,
          stoppedReason: merged.reason,
          updatedAt: now(),
        }) || delivering;
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
      return goalPlanStore?.recordDeliveryHandoff?.(plan.planId, {
        status: 'stopped',
        repoId: binding.repoId,
        targetBranch,
        taskBranch,
        stoppedReason: String(error?.message || error),
        updatedAt: now(),
      }) || plan;
    } finally {
      if (locks.get(key) === plan.planId) locks.delete(key);
    }
  }

  return Object.freeze({
    canHandoff,
    lockKey,
    handoffPlan,
  });
}
