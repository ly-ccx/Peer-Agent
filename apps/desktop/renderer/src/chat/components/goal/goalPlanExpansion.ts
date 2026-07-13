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

/**
 * A plan that needs a user decision must stay visible in the bottom bar.
 * Goal-mode plans deliberately wait in `accepted` until the user starts,
 * adjusts, or cancels them, so they are actionable just like explicit
 * `awaiting_approval` plans.
 */
export function hasPendingGoalApproval(
  plans: readonly Pick<GoalPlan, 'status' | 'workflowKind' | 'runner'>[],
): boolean {
  return plans.some(
    (plan) =>
      plan.status === 'awaiting_approval' ||
      (plan.workflowKind === 'goal_self_driven' && plan.status === 'accepted' && !plan.runner?.enabled),
  );
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
