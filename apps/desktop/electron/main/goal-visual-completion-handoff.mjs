import { goalPlanWaitsOnPreviewReview, isPreviewReviewPendingLeaf, serializeAcceptedGoalRunnerHandoff } from '@peer-agent/runtime-node';

const STOPPED = new Set(['paused', 'waiting_user', 'waiting_permission', 'blocked', 'budget_exhausted', 'failed', 'cancelled', 'interrupted']);

function mayFinish(plan, outcome, conversationId) {
  if (outcome?.terminalStatus !== 'done') return false;
  if (outcome.requestedUserInput) return false;
  if (!plan || plan.conversationId !== conversationId || !['accepted', 'executing', 'completed'].includes(plan.status)) return false;
  if (plan.workflowKind !== 'goal_self_driven' || !['intake', 'accepted_goal'].includes(plan.activation?.kind)) return false;
  if (STOPPED.has(plan.runner?.status) && !(plan.runner?.status === 'waiting_user' && goalPlanWaitsOnPreviewReview(plan))) return false;
  if (plan.runner?.interruption) return false;
  const queue = [...(plan.tasks || [])];
  let leaves = 0;
  while (queue.length) {
    const task = queue.pop();
    if (task?.subtasks?.length) { queue.push(...task.subtasks); continue; }
    if (isPreviewReviewPendingLeaf(task)) continue;
    if (task?.status !== 'completed' || !task.evidenceRefs?.length) return false;
    leaves++;
  }
  return leaves > 0;
}

/** Handoff only; the existing Runner/authority still decides whether UI work passed.
 * Host-owned ports are never projected as model tools. No plan promotion or resume.
 */
export function createGoalVisualCompletionHandoff({ goalPlanStore, authority, forceComplete, startRunner }) {
  const pending = new Map();
  function required(planId) {
    try { return authority?.read(planId)?.required === true; }
    catch { return true; } // Let the Runner fail closed on an unreadable authority.
  }
  function handoff(conversationId, outcome, planId) {
    if (!authority || !planId) return Promise.resolve(false);
    // The foreground caller binds identity before sendMessage. Timestamps are
    // not ownership: a historical plan may have been updated by another event.
    const stillEligible = () => {
      const active = goalPlanStore.getActivePlanByConversation(conversationId);
      if (active && active.planId !== planId) return false;
      return mayFinish(goalPlanStore.getPlan(planId), outcome, conversationId) && required(planId);
    };
    if (!stillEligible()) return Promise.resolve(false);
    if (pending.has(planId)) return pending.get(planId);
    const work = serializeAcceptedGoalRunnerHandoff({
      forceComplete: () => forceComplete(conversationId),
      isStillAccepted: stillEligible,
      startRunner: () => startRunner(planId),
    }).finally(() => pending.delete(planId));
    pending.set(planId, work);
    return work;
  }
  return { handoff };
}
