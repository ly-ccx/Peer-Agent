import type { GoalPlan } from '@peer-agent/protocol';

const CURRENT_STATUSES = new Set<GoalPlan['status']>([
  'drafting',
  'awaiting_approval',
  'approved',
  'accepted',
  'executing',
  'paused',
]);

export interface TaskPlanHistory {
  readonly current: GoalPlan | null;
  readonly historical: readonly GoalPlan[];
}

function newestFirst(left: GoalPlan, right: GoalPlan): number {
  return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
}

/** One Conversation is one Task; GoalPlans are current/history lifecycles below it. */
export function groupTaskPlans(plans: readonly GoalPlan[]): TaskPlanHistory {
  const sorted = [...plans].sort(newestFirst);
  const current = sorted.find((plan) => CURRENT_STATUSES.has(plan.status)) ?? null;
  return {
    current,
    historical: sorted.filter((plan) => plan.planId !== current?.planId),
  };
}
