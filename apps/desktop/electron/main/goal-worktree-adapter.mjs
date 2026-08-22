import { execFile } from 'node:child_process';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathOf } from '@peer-agent/runtime-node';
import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';

const execFileAsync = promisify(execFile);

function trimPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function safeSegment(value, fallback) {
  const result = String(value || '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return result || fallback;
}

function hasDeliveryTarget(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (plan.activation?.kind === 'intake') return false;
  const binding = plan.deliveryBinding && typeof plan.deliveryBinding === 'object'
    ? plan.deliveryBinding
    : null;
  if (!binding?.targetBranch || !binding?.targetBranchSource) return false;
  const target = trimPath(binding.targetWorkspacePath) || trimPath(plan.targetWorkspacePath);
  return Boolean(target);
}

function planNeedsIsolatedWorktree(plan) {
  if (!hasDeliveryTarget(plan)) return false;
  if (plan.deliveryBinding?.executionIsolation !== 'worktree') return false;
  return plan.status !== 'completed' && plan.status !== 'cancelled' && plan.status !== 'failed';
}

function isTerminalPlan(plan) {
  return plan.status === 'completed' || plan.status === 'cancelled' || plan.status === 'failed';
}

function isAutomationStyleBranch(branch) {
  return /\/automation-[^/]+\/run-/.test(branch) || branch.startsWith('PeerAgent/automation-');
}

function errorText(error) {
  return [error?.stderr, error?.message, error?.code].filter(Boolean).join('\n');
}

function isMissingPathError(error) {
  const text = errorText(error);
  return error?.code === 'ENOENT'
    || /no such file or directory/i.test(text)
    || /cannot read current working directory/i.test(text)
    || /不能读取当前工作目录/.test(text);
}

function isMissingGitWorktreeError(error) {
  const text = errorText(error);
  return isMissingPathError(error)
    || /not a git repository/i.test(text)
    || /不是 git 仓库/.test(text)
    || /not a working tree/i.test(text)
    || /不是一个工作区/.test(text)
    || /validation failed/i.test(text)
    || /验证失败/.test(text)
    || /\.git['’`]? does not exist/i.test(text)
    || /\.git['’`]? 不存在/.test(text);
}

function isMissingBranchError(error) {
  const text = errorText(error);
  return isMissingPathError(error)
    || /not found/i.test(text)
    || /未发现/.test(text)
    || /does not exist/i.test(text)
    || /不存在/.test(text);
}

function isUnusableWorkspaceError(error) {
  const message = String(error?.message || error);
  return message === 'automation_workspace_missing'
    || message === 'automation_workspace_not_git'
    || message === 'automation_workspace_not_directory'
    || /ENOENT/.test(message)
    || /cannot read current working directory/i.test(message)
    || /不能读取当前工作目录/.test(message);
}

async function defaultRunGit(args, { cwd }) {
  const result = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  return { stdout: result.stdout, stderr: result.stderr };
}

async function worktreeStillPresent(worktreePath) {
  try {
    const info = await stat(worktreePath);
    if (!info.isDirectory()) return false;
    await stat(path.join(worktreePath, '.git'));
    return true;
  } catch {
    return false;
  }
}

function toAdapterRun(plan) {
  const binding = plan.deliveryBinding || {};
  const workspacePath = trimPath(binding.targetWorkspacePath) || trimPath(plan.targetWorkspacePath);
  return {
    runId: plan.planId,
    automationId: plan.planId,
    snapshot: {
      workspacePath,
      grant: { preset: 'work_in_workspace' },
    },
  };
}

function toExecution(plan, prepared) {
  return {
    kind: 'worktree',
    workspacePath: prepared.workspacePath,
    worktreePath: prepared.worktreePath,
    repositoryRoot: prepared.repositoryRoot,
    branch: prepared.branch,
    baseline: prepared.baseline,
  };
}

export function resolveGoalSitePath(plan) {
  if (!plan || typeof plan !== 'object') return null;
  const worktree = trimPath(plan.deliveryBinding?.worktreePath);
  if (plan.deliveryBinding?.executionIsolation === 'worktree' && worktree) {
    return worktree;
  }
  return worktree
    || trimPath(plan.deliveryBinding?.targetWorkspacePath)
    || trimPath(plan.targetWorkspacePath);
}

/**
 * Reuses Automation Worktree Git chain for Goal isolation.
 * One worktree per Goal / delegated child Goal that already has a delivery binding.
 * Existing task branches are attached in place; automation-style branches stay a fallback.
 */
export function createGoalWorktreeAdapter({
  worktreeAdapter = createAutomationWorktreeAdapter({
    rootDir: path.join(pathOf('goalPlans'), 'worktrees'),
    artifactDir: path.join(pathOf('goalPlans'), 'artifacts'),
  }),
  goalPlanStore = null,
  runGit = defaultRunGit,
  rootDir = path.join(pathOf('goalPlans'), 'worktrees'),
} = {}) {
  const retainLocks = new Map();

  function recordIsolation(plan, isolation) {
    if (typeof goalPlanStore?.recordDeliveryIsolation !== 'function') {
      const nextBinding = {
        ...(plan.deliveryBinding && typeof plan.deliveryBinding === 'object' ? plan.deliveryBinding : {}),
        executionIsolation: isolation.executionIsolation,
      };
      if (isolation.taskBranch) nextBinding.taskBranch = isolation.taskBranch;
      else delete nextBinding.taskBranch;
      if (isolation.worktreePath) nextBinding.worktreePath = isolation.worktreePath;
      else delete nextBinding.worktreePath;
      return {
        ...plan,
        deliveryBinding: nextBinding,
      };
    }
    return goalPlanStore.recordDeliveryIsolation(plan.planId, isolation) || plan;
  }

  async function clearIsolation(plan) {
    return recordIsolation(plan, {
      executionIsolation: 'worktree',
      taskBranch: undefined,
      worktreePath: undefined,
    });
  }

  async function removeWorktreeOnly(repositoryRoot, worktreePath) {
    if (!repositoryRoot || !worktreePath) return;
    try {
      await runGit(['worktree', 'remove', '--force', worktreePath], { cwd: repositoryRoot });
    } catch (error) {
      if (!isMissingGitWorktreeError(error)) throw error;
      await rm(worktreePath, { recursive: true, force: true });
      try {
        await runGit(['worktree', 'prune'], { cwd: repositoryRoot });
      } catch (pruneError) {
        if (!isMissingGitWorktreeError(pruneError)) throw pruneError;
      }
    }
  }

  async function currentBranch(root) {
    try {
      return trimPath((await runGit(['branch', '--show-current'], { cwd: root })).stdout);
    } catch (error) {
      if (isUnusableWorkspaceError(error) || isMissingGitWorktreeError(error)) return null;
      throw error;
    }
  }

  async function workspaceDirty(root) {
    try {
      return Boolean(trimPath((await runGit(['status', '--porcelain'], { cwd: root })).stdout));
    } catch {
      return true;
    }
  }

  async function switchIfOnTaskBranch(plan, root, branch) {
    const checkout = await currentBranch(root);
    if (checkout !== branch) return { ok: true };
    if (await workspaceDirty(root)) return { ok: false, reason: 'task_checkout_dirty' };
    const base = trimPath(plan.deliveryBinding?.targetBranch) || trimPath(plan.targetBranch);
    if (!base) return { ok: false, reason: 'switch_base_failed' };
    try {
      await runGit(['switch', '--', base], { cwd: root });
      return { ok: true };
    } catch {
      return { ok: false, reason: 'switch_base_failed' };
    }
  }

  async function attachWorktreeForBranch(plan, branch) {
    const root = trimPath(plan.deliveryBinding?.targetWorkspacePath) || trimPath(plan.targetWorkspacePath);
    if (!root) return { ok: false, reason: 'no_delivery_target', plan };
    const dest = path.join(rootDir, safeSegment(plan.planId, 'plan'));
    const vacated = await switchIfOnTaskBranch(plan, root, branch);
    if (!vacated.ok) return { ok: false, reason: vacated.reason, plan };

    await mkdir(path.dirname(dest), { recursive: true });
    try {
      await runGit(['worktree', 'remove', '--force', dest], { cwd: root });
    } catch {
      await rm(dest, { recursive: true, force: true });
    }
    try {
      await runGit(['worktree', 'add', dest, branch], { cwd: root });
    } catch (error) {
      if (isUnusableWorkspaceError(error) || isMissingGitWorktreeError(error)) {
        return { ok: false, reason: 'workspace_unusable', plan };
      }
      return { ok: false, reason: 'worktree_add_failed', plan };
    }
    return {
      ok: true,
      plan: recordIsolation(plan, {
        executionIsolation: 'worktree',
        taskBranch: branch,
        worktreePath: dest,
      }),
    };
  }

  async function prepareFromAutomation(plan) {
    let prepared;
    try {
      prepared = await worktreeAdapter.prepare(toAdapterRun(plan));
    } catch (error) {
      if (isUnusableWorkspaceError(error)) return plan;
      throw error;
    }
    if (prepared?.kind !== 'worktree' || !prepared.worktreePath || !prepared.branch) {
      return plan;
    }
    return recordIsolation(plan, {
      executionIsolation: 'worktree',
      taskBranch: prepared.branch,
      worktreePath: prepared.worktreePath,
    });
  }

  async function prepareForPlan(plan) {
    if (!planNeedsIsolatedWorktree(plan)) return plan;
    const existingPath = trimPath(plan.deliveryBinding?.worktreePath);
    const existingBranch = trimPath(plan.deliveryBinding?.taskBranch);
    if (
      existingPath
      && existingBranch
      && plan.deliveryBinding?.executionIsolation === 'worktree'
      && await worktreeStillPresent(existingPath)
    ) {
      return plan;
    }
    if (existingBranch) {
      const attached = await attachWorktreeForBranch(plan, existingBranch);
      return attached.ok ? attached.plan : plan;
    }
    return prepareFromAutomation(plan);
  }

  async function isolatePlan(plan, { ensureTaskBranch } = {}) {
    if (!hasDeliveryTarget(plan)) return { ok: false, reason: 'no_delivery_target', plan };
    if (plan.activation?.kind === 'intake') return { ok: false, reason: 'intake', plan };
    if (isTerminalPlan(plan)) return { ok: false, reason: 'terminal', plan };

    let next = plan;
    if (!trimPath(next.deliveryBinding?.taskBranch) && typeof ensureTaskBranch === 'function') {
      next = await ensureTaskBranch(next) || next;
    }

    const existingPath = trimPath(next.deliveryBinding?.worktreePath);
    if (
      existingPath
      && next.deliveryBinding?.executionIsolation === 'worktree'
      && await worktreeStillPresent(existingPath)
    ) {
      return { ok: true, plan: next };
    }

    const branch = trimPath(next.deliveryBinding?.taskBranch);
    if (branch) return attachWorktreeForBranch(next, branch);

    const prepared = await prepareFromAutomation({
      ...next,
      deliveryBinding: {
        ...(next.deliveryBinding && typeof next.deliveryBinding === 'object' ? next.deliveryBinding : {}),
        executionIsolation: 'worktree',
      },
    });
    if (!trimPath(prepared.deliveryBinding?.worktreePath)) {
      return { ok: false, reason: 'prepare_failed', plan: prepared };
    }
    return { ok: true, plan: prepared };
  }

  async function discardLine(plan, { deleteBranch = false } = {}) {
    if (!plan || typeof plan !== 'object') return { ok: false, reason: 'not_found', plan: null };
    const root = trimPath(plan.deliveryBinding?.targetWorkspacePath) || trimPath(plan.targetWorkspacePath);
    const worktreePath = trimPath(plan.deliveryBinding?.worktreePath);
    const branch = trimPath(plan.deliveryBinding?.taskBranch);
    if (!worktreePath && !branch) {
      return { ok: true, plan };
    }
    if (worktreePath && root) {
      try {
        await removeWorktreeOnly(root, worktreePath);
      } catch (error) {
        if (!isUnusableWorkspaceError(error) && !isMissingGitWorktreeError(error)) {
          return { ok: false, reason: 'worktree_remove_failed', plan };
        }
      }
    }
    if (deleteBranch && branch && root) {
      const vacated = await switchIfOnTaskBranch(plan, root, branch);
      if (!vacated.ok) return { ok: false, reason: vacated.reason, plan };
      try {
        await runGit(['branch', '-D', branch], { cwd: root });
      } catch (error) {
        if (!isMissingBranchError(error)) {
          return { ok: false, reason: 'branch_delete_failed', plan };
        }
      }
    }
    return {
      ok: true,
      plan: recordIsolation(plan, {
        executionIsolation: 'none',
        taskBranch: deleteBranch ? undefined : branch,
        worktreePath: undefined,
      }),
    };
  }

  async function retainOrCleanupPlan(plan) {
    if (!hasDeliveryTarget(plan)) return plan;
    if (plan.deliveryBinding?.executionIsolation !== 'worktree') return plan;
    const worktreePath = trimPath(plan.deliveryBinding?.worktreePath);
    const branch = trimPath(plan.deliveryBinding?.taskBranch);
    if (!worktreePath || !branch) return plan;
    const lockKey = plan.planId;
    const pending = retainLocks.get(lockKey);
    if (pending) return pending;
    let task;
    task = (async () => {
      const run = toAdapterRun(plan);
      const repositoryRoot = trimPath(plan.deliveryBinding?.targetWorkspacePath) || trimPath(plan.targetWorkspacePath);
      const execution = toExecution(plan, {
        workspacePath: worktreePath,
        worktreePath,
        repositoryRoot,
        branch,
        baseline: { commit: plan.deliveryBinding?.baseCommit || plan.baseCommit },
      });
      try {
        if (plan.deliveryHandoff?.status === 'delivered') {
          await removeWorktreeOnly(repositoryRoot, worktreePath);
          return recordIsolation(plan, {
            executionIsolation: 'none',
            taskBranch: branch,
            worktreePath: undefined,
          });
        }
        if (plan.deliveryHandoff?.status === 'stopped') {
          return plan;
        }
        const collected = typeof worktreeAdapter.collect === 'function'
          ? await worktreeAdapter.collect(run, execution)
          : null;
        const retained = collected?.retained === true || Boolean(collected?.changedFiles?.length);
        if (retained) return plan;
        if (isAutomationStyleBranch(branch)) {
          if (typeof worktreeAdapter.retainOrCleanup === 'function') {
            await worktreeAdapter.retainOrCleanup(run, execution, collected);
          } else {
            await removeWorktreeOnly(repositoryRoot, worktreePath);
          }
          return clearIsolation(plan);
        }
        await removeWorktreeOnly(repositoryRoot, worktreePath);
        return recordIsolation(plan, {
          executionIsolation: 'none',
          taskBranch: branch,
          worktreePath: undefined,
        });
      } catch (error) {
        if (isUnusableWorkspaceError(error)) return clearIsolation(plan);
        throw error;
      }
    })().finally(() => {
      if (retainLocks.get(lockKey) === task) retainLocks.delete(lockKey);
    });
    retainLocks.set(lockKey, task);
    return task;
  }

  return Object.freeze({
    planNeedsIsolatedWorktree,
    prepareForPlan,
    isolatePlan,
    discardLine,
    retainOrCleanupPlan,
    resolveSitePath: resolveGoalSitePath,
  });
}
