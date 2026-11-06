import { goalPlanWaitsOnUser } from '../goal-plan-domain.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { hasUnsettledDispatch } from './recovery-policy.mjs';

/** Only an admitted, still-unapplied repair attempt may bypass the old completion shortcut once. */
export function repairExecutionPending(plan) {
  const origin = plan?.delegationOrigin;
  if (origin?.takeover?.repair !== true) return false;
  const journal = workBudgetBinding(origin.workspaceId)?.store;
  const transition = journal?.readLifecycleFacts()?.transitions?.[origin.takeover.operationId];
  return Boolean(transition?.minimumExecutorVersion === 3 && transition.executionEpoch === origin.coordinationBinding?.executionEpoch
    && transition.expectedGoalRevision === origin.coordinationBinding?.goalRevision
    && !['stopping','awaiting_outcome','blocked'].includes(transition.phase)
    && !['applied','unknown','rejected'].includes(transition.executionEffect)
    && !hasUnsettledDispatch(journal.readWork(origin.workId)));
}

export function takeoverHumanBlocker(plan) {
  if (plan?.delegationOrigin?.phase === 'awaiting_approval' || plan?.status === 'awaiting_approval') return 'plan_approval_required';
  return plan?.runner?.status === 'waiting_user' || goalPlanWaitsOnUser(plan) ? 'human_decision_required' : null;
}

/** Returning a result closes an attempt, while an unaccepted goal may still owe repairs. */
export function takeoverBlocker(plan, action, humanGate = false) {
  const human = takeoverHumanBlocker(plan);
  if (human || humanGate) return human || 'human_decision_required';
  if (!plan || plan.resultAcceptance?.acceptedAt || plan.status === 'cancelled' || plan.delegationOrigin?.cancellation
    || plan.status === 'completed' && action !== 'resume') return 'session_not_running';
  return null;
}
