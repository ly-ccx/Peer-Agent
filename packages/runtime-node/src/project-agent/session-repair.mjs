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

/** The host terminal barrier writes this machine prefix; arbitrary prose is not a fault fact. */
export const isLocalPersistenceFailure = value => typeof value === 'string'
  && /^conversation_persistence_failed(?::|$)/.test(value.trim());

/** Called only after the current takeover's stop/unknown-effect barrier has settled. */
export function prepareLocalPersistenceRetry(plan, goalPlanStore, operationId) {
  if (!isLocalPersistenceFailure(plan?.runner?.lastError)) return [];
  const prior = plan.runTrace?.events?.find(event => event.payload?.summaryCode === 'local_persistence_retry_prepared'
    && event.payload.operationId === operationId);
  const ids = [], prepared = [];
  const prepare = tasks => tasks.map(task => {
    if (task.subtasks?.length) return { ...task, subtasks: prepare(task.subtasks) };
    if (task.status === 'pending' && isLocalPersistenceFailure(task.failureReason) && prior?.payload.taskIds?.includes(task.taskId)) prepared.push(task.taskId);
    if (task.status !== 'failed' || !isLocalPersistenceFailure(task.failureReason)) return task;
    ids.push(task.taskId);
    // Keep the previous result, failure, timestamps and Evidence as attempt history.
    return { ...task, status: 'pending' };
  });
  const tasks = prepare(plan.tasks || []);
  if (!ids.length) return prepared;
  if (!prior) goalPlanStore.appendRunEvent(plan.planId, {
    type: 'problem_found', summary: 'Preparing remaining work after local persistence failure',
    payload: { summaryCode: 'local_persistence_retry_prepared', operationId, taskIds: ids, previousError: plan.runner.lastError },
  });
  goalPlanStore.revisePlan(plan.planId, { tasks }, { reason: 'prepare safe local persistence retry', changedBy: 'session-takeover' });
  return [...ids, ...prepared];
}
