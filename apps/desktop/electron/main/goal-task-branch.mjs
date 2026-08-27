import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveGitBranchPrefix } from '@peer-agent/system-context';

function trim(value) {
  if (typeof value !== 'string') return null;
  const next = value.trim();
  return next.length > 0 ? next : null;
}

function defaultRunGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 8000,
  }).trim();
}

export function slugifyTaskBranchName(title, planId) {
  const raw = String(title || planId || 'task')
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return (raw || 'task').toLowerCase();
}

function writablePlan(plan) {
  if (!plan || typeof plan !== 'object') return false;
  if (plan.activation?.kind === 'intake') return false;
  const status = plan.status;
  if (status === 'completed' || status === 'cancelled' || status === 'failed') return false;
  if (status === 'approved' || status === 'accepted' || status === 'executing') return true;
  return plan.activation?.kind === 'accepted_goal' || plan.activation?.kind === 'approved_plan';
}

export function planNeedsTaskBranch(plan) {
  if (!writablePlan(plan)) return false;
  if (trim(plan.deliveryBinding?.taskBranch)) return false;
  // ADR 68：非隔离计划不建空壳任务线——它没有合回动作，空 ref 只会误导
  // UI 画出「任务线 → 发版线」路线图。隔离（worktree）计划仍需要任务线承载交付。
  if (plan.deliveryBinding?.executionIsolation != null
    && plan.deliveryBinding.executionIsolation !== 'worktree') {
    return false;
  }
  const workspace = trim(plan.deliveryBinding?.targetWorkspacePath) || trim(plan.targetWorkspacePath);
  const base = trim(plan.deliveryBinding?.targetBranch) || trim(plan.targetBranch);
  return Boolean(workspace && base);
}

function refExists(runGit, root, name) {
  try {
    return Boolean(trim(runGit(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])));
  } catch {
    return false;
  }
}

function resolveStartPoint(runGit, root, baseCommit, baseBranch) {
  const candidates = [trim(baseCommit), trim(baseBranch)].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const sha = trim(runGit(root, ['rev-parse', '--verify', candidate]));
      if (sha) return sha;
    } catch {
      // try the next known fact
    }
  }
  return null;
}

/**
 * Creates a task branch from the bound base without a worktree.
 * Pure chat / intake stay unbound. Dirty workspaces only get the ref.
 */
export function createGoalTaskBranchAdapter({
  runGit = defaultRunGit,
  goalPlanStore = null,
  resolvePrefix = () => resolveGitBranchPrefix(),
} = {}) {
  function ensureTaskBranch(plan) {
    if (!planNeedsTaskBranch(plan)) return plan;
    const root = trim(plan.deliveryBinding?.targetWorkspacePath) || trim(plan.targetWorkspacePath);
    if (!root || !existsSync(path.join(root, '.git'))) return plan;
    const start = resolveStartPoint(
      runGit,
      root,
      plan.deliveryBinding?.baseCommit || plan.baseCommit,
      plan.deliveryBinding?.targetBranch || plan.targetBranch,
    );
    if (!start) return plan;

    const prefix = resolvePrefix() || 'PeerAgent/';
    const slug = slugifyTaskBranchName(plan.title, plan.planId);
    let name = `${prefix}${slug}`;
    if (refExists(runGit, root, name)) {
      name = `${prefix}${slug}-${String(plan.planId || 'task').slice(0, 8)}`;
    }

    try {
      runGit(root, ['branch', '--', name, start]);
    } catch {
      return plan;
    }

    let dirty = false;
    try {
      dirty = Boolean(trim(runGit(root, ['status', '--porcelain'])));
    } catch {
      dirty = true;
    }
    if (!dirty) {
      try {
        runGit(root, ['switch', '--', name]);
      } catch {
        // The ref is the source of truth; checkout is best-effort.
      }
    }

    if (typeof goalPlanStore?.recordDeliveryIsolation === 'function') {
      return goalPlanStore.recordDeliveryIsolation(plan.planId, {
        // ADR 68：保留计划已声明的隔离模式；只有未声明时才落 'none'。
        // 隔离（worktree）计划的任务线由 worktree 链路使用，不能被拉回 none。
        executionIsolation: plan.deliveryBinding?.executionIsolation === 'worktree' ? 'worktree' : 'none',
        taskBranch: name,
        worktreePath: undefined,
      }) || plan;
    }
    return {
      ...plan,
      deliveryBinding: {
        ...(plan.deliveryBinding && typeof plan.deliveryBinding === 'object' ? plan.deliveryBinding : {}),
        executionIsolation: 'none',
        taskBranch: name,
      },
    };
  }

  return Object.freeze({
    planNeedsTaskBranch,
    ensureTaskBranch,
  });
}
