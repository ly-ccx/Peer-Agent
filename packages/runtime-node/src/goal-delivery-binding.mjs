import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

function trimName(value) {
  if (value === undefined || value === null) return undefined;
  const normalized = String(value).trim();
  return normalized.length > 0 ? normalized : undefined;
}

function workspaceLeafName(pathValue) {
  const trimmed = trimName(pathValue)?.replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts.at(-1) || undefined;
}

function runGit(workspaceRoot, args) {
  try {
    return execFileSync('git', args, {
      cwd: workspaceRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 3000,
    }).trim();
  } catch {
    return '';
  }
}

/**
 * Read the current HEAD branch/commit of a workspace.
 * Never invents `main`. Detached HEAD or non-git paths return null.
 */
export function readWorkspaceHead(workspaceRoot, run = runGit) {
  const root = trimName(workspaceRoot);
  if (!root || !existsSync(path.join(root, '.git'))) return null;
  const branch = trimName(run(root, ['branch', '--show-current']));
  if (!branch) return null;
  const commit = trimName(run(root, ['rev-parse', 'HEAD'])) || undefined;
  return { branch, commit };
}

function isIntake(plan) {
  return plan?.activation?.kind === 'intake';
}

function alreadyBound(plan) {
  return Boolean(
    plan?.deliveryBinding
    || (trimName(plan?.targetBranch) && trimName(plan?.targetBranchSource)),
  );
}

/**
 * Only bind when this Goal can write a repository.
 * Q&A / intake stay unbound. Missing git facts stay unbound — never default to main.
 */
export function attachWorkspaceHeadBinding(plan, options = {}) {
  if (!plan || typeof plan !== 'object') return plan;
  if (isIntake(plan) || alreadyBound(plan)) return plan;
  const targetWorkspacePath = trimName(plan.targetWorkspacePath);
  if (!targetWorkspacePath) return plan;

  const reader = typeof options.readWorkspaceHead === 'function'
    ? options.readWorkspaceHead
    : readWorkspaceHead;
  const head = reader(targetWorkspacePath);
  if (!head?.branch) return plan;

  const repoId = trimName(plan.targetRepoId) || workspaceLeafName(targetWorkspacePath);
  if (!repoId) return plan;

  const boundAt = options.now || new Date().toISOString();
  return {
    ...plan,
    targetRepoId: repoId,
    targetBranch: head.branch,
    ...(head.commit ? { baseCommit: head.commit } : {}),
    targetBranchSource: 'workspace_head',
    deliveryBinding: {
      repoId,
      targetWorkspacePath,
      targetBranch: head.branch,
      ...(head.commit ? { baseCommit: head.commit } : {}),
      targetBranchSource: 'workspace_head',
      executionIsolation: 'none',
      boundAt,
    },
  };
}
