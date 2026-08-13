import path from 'node:path';
import { pathOf } from '@peer-agent/runtime-node';
import { createAutomationWorktreeAdapter } from './automation-worktree-adapter.mjs';

function trimPath(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
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
  return plan.status !== 'completed' && plan.status !== 'cancelled' && plan.status !== 'failed';
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

/**
 * Reuses Automation Worktree Git chain for Goal isolation.
 * One worktree per Goal / delegated child Goal that already has a delivery binding.
 */
export function createGoalWorktreeAdapter({
  worktreeAdapter = createAutomationWorktreeAdapter({
    rootDir: path.join(pathOf('goalPlans'), 'worktrees'),
    artifactDir: path.join(pathOf('goalPlans'), 'artifacts'),
  }),
  goalPlanStore = null,
} = {}) {
  async function prepareForPlan(plan) {
    if (!planNeedsIsolatedWorktree(plan)) return plan;
    const existingPath = trimPath(plan.deliveryBinding?.worktreePath);
    const existingBranch = trimPath(plan.deliveryBinding?.taskBranch);
    if (existingPath && existingBranch && plan.deliveryBinding?.executionIsolation === 'worktree') {
      return plan;
    }
    const prepared = await worktreeAdapter.prepare(toAdapterRun(plan));
    if (prepared?.kind !== 'worktree' || !prepared.worktreePath || !prepared.branch) {
      return plan;
    }
    if (typeof goalPlanStore?.recordDeliveryIsolation !== 'function') {
      return {
        ...plan,
        deliveryBinding: {
          ...plan.deliveryBinding,
          executionIsolation: 'worktree',
          taskBranch: prepared.branch,
          worktreePath: prepared.worktreePath,
        },
      };
    }
    return goalPlanStore.recordDeliveryIsolation(plan.planId, {
      executionIsolation: 'worktree',
      taskBranch: prepared.branch,
      worktreePath: prepared.worktreePath,
    }) || plan;
  }

  async function retainOrCleanupPlan(plan) {
    if (!hasDeliveryTarget(plan)) return plan;
    if (plan.deliveryBinding?.executionIsolation !== 'worktree') return plan;
    const worktreePath = trimPath(plan.deliveryBinding?.worktreePath);
    const branch = trimPath(plan.deliveryBinding?.taskBranch);
    if (!worktreePath || !branch) return plan;
    const run = toAdapterRun(plan);
    const execution = toExecution(plan, {
      workspacePath: worktreePath,
      worktreePath,
      repositoryRoot: trimPath(plan.deliveryBinding?.targetWorkspacePath) || trimPath(plan.targetWorkspacePath),
      branch,
      baseline: { commit: plan.deliveryBinding?.baseCommit || plan.baseCommit },
    });
    const collected = typeof worktreeAdapter.collect === 'function'
      ? await worktreeAdapter.collect(run, execution)
      : null;
    const changes = typeof worktreeAdapter.retainOrCleanup === 'function'
      ? await worktreeAdapter.retainOrCleanup(run, execution, collected)
      : collected;
    const retained = changes?.retained === true || Boolean(changes?.changedFiles?.length);
    if (!retained && typeof goalPlanStore?.recordDeliveryIsolation === 'function') {
      return goalPlanStore.recordDeliveryIsolation(plan.planId, {
        executionIsolation: 'worktree',
        taskBranch: undefined,
        worktreePath: undefined,
      }) || plan;
    }
    return plan;
  }

  return Object.freeze({
    planNeedsIsolatedWorktree,
    prepareForPlan,
    retainOrCleanupPlan,
  });
}
