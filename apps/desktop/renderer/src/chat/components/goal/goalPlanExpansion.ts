import type { GoalPlan, GoalPlanStatus } from '@peer-agent/protocol';

const TERMINAL_PLAN_STATUSES: ReadonlySet<GoalPlanStatus> = new Set([
  'completed',
  'cancelled',
]);

/** Active plans still contain work or decisions worth showing; only history starts collapsed. */
export function shouldDefaultExpandGoalPlan(
  plan: Pick<GoalPlan, 'status'>,
): boolean {
  return !TERMINAL_PLAN_STATUSES.has(plan.status);
}

export function selectPrimaryGoalPlan(
  plans: readonly GoalPlan[],
): GoalPlan | null {
  return (
    plans.find((plan) => plan.status === 'awaiting_approval') ??
    plans.find((plan) => plan.status === 'executing') ??
    plans.find(shouldDefaultExpandGoalPlan) ??
    null
  );
}
