const EXECUTABLE_PLAN_STATUSES = new Set(['approved', 'accepted', 'executing', 'completed']);
const TERMINAL_PLAN_STATUSES = new Set(['completed', 'cancelled', 'failed']);

/** Read-only projection used by Prompt Sources; execution gating stays in Runtime. */
export function resolveGoalPlanGate(conversationId, goalPlanStore) {
  if (!conversationId || typeof goalPlanStore?.listPlansByConversation !== 'function') {
    return { hasPlan: false, hasApprovedPlan: false, intakeActive: false };
  }
  let plans = [];
  try {
    plans = goalPlanStore.listPlansByConversation(conversationId) ?? [];
  } catch {
    plans = [];
  }
  return {
    hasPlan: plans.length > 0,
    hasApprovedPlan: plans.some((plan) => EXECUTABLE_PLAN_STATUSES.has(plan?.status)),
    intakeActive: plans.some(
      (plan) => plan?.activation?.kind === 'intake' && !TERMINAL_PLAN_STATUSES.has(plan?.status),
    ),
  };
}
