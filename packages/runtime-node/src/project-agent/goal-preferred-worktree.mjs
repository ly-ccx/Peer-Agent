/**
 * Apply a conversation's opt-in worktree preference through the existing Goal isolatePlan.
 * Renderer may collect the checkbox; isolation truth stays on deliveryBinding.
 */

export function conversationPrefersWorktree(conversation) {
  return conversation?.preferredExecutionIsolation === 'worktree';
}

const QUIET_ISOLATION_REASONS = new Set([
  'intake',
  'no_delivery_target',
  'not_found',
  'terminal',
]);

function wrapEnsureTaskBranch(ensureTaskBranch) {
  if (typeof ensureTaskBranch !== 'function') return undefined;
  return async (current) => (await ensureTaskBranch(current)) || current;
}

/**
 * Ensure the task branch, then isolate if the conversation opted in.
 * Plans that already declared worktree still go through prepareForPlan.
 * Intake / unbound plans stay quiet until a writable delivery line exists.
 */
export async function preparePlanExecutionWorkspace({
  plan,
  conversation = null,
  ensureTaskBranch = null,
  prepareForPlan = null,
  isolatePlan = null,
  logger = console,
} = {}) {
  if (!plan) return plan;
  let next = plan;
  if (typeof ensureTaskBranch === 'function') {
    try {
      next = (await ensureTaskBranch(next)) || next;
    } catch (error) {
      logger.warn?.('[goal-task-branch] ensure failed:', error?.message || error);
    }
  }

  if (conversationPrefersWorktree(conversation) && typeof isolatePlan === 'function') {
    try {
      const result = await isolatePlan(next, {
        ensureTaskBranch: wrapEnsureTaskBranch(ensureTaskBranch),
      });
      if (result?.ok) return result.plan || next;
      if (result?.plan) next = result.plan;
      if (result?.reason && !QUIET_ISOLATION_REASONS.has(result.reason)) {
        logger.warn?.('[goal-worktree] preferred isolation skipped:', result.reason);
      }
    } catch (error) {
      logger.warn?.('[goal-worktree] preferred isolation failed:', error?.message || error);
    }
    return next;
  }

  if (typeof prepareForPlan === 'function') {
    next = (await prepareForPlan(next)) || next;
  }
  return next;
}
