import type { GoalPlan } from '@peer-agent/protocol';

const FORMAL_GOAL_ACTIVATIONS = new Set<NonNullable<GoalPlan['activation']>['kind']>([
  'approved_plan',
  'accepted_goal',
]);

/**
 * Completion feedback celebrates execution, not the intake plan used to clarify a draft Goal.
 * Keep lifecycle semantics as the source of truth instead of inferring from task names or copy.
 */
export function shouldShowGoalCompletionFeedback(plan: GoalPlan): boolean {
  const activationKind = plan.activation?.kind;
  return plan.status === 'completed'
    && activationKind !== undefined
    && FORMAL_GOAL_ACTIVATIONS.has(activationKind);
}
