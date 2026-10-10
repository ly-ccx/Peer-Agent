import { randomUUID } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';

/** Register under the project writer, settle outside it, then conditionally commit. */
export function createSessionCancellation({ findBySession, goalPlanStore, goalRunner, executionScheduler, canManageWorkspace,
  abortStream, isolationPlanner, exclusive, project, emit, promote, now }) {
  const pending = new Map();
  function begin(input) {
    const plan = findBySession(input.sessionId);
    if (!plan) return { error: 'session_not_found' };
    const origin = plan.delegationOrigin;
    if (!canManageWorkspace(origin.workspaceId)) return { error: 'lease_unavailable' };
    if (plan.status === 'completed' || plan.resultAcceptance?.acceptedAt) return { error: 'session_not_running' };
    if (plan.status === 'cancelled' && !origin.cancellation?.cleanupPending) return { completed: project(plan) };
    const receipt = origin.cancellation || { operationId: input.operationId || `cancel-${randomUUID()}`, reason: input.reason || 'cancelled', phase: 'stopping', requestedAt: now() };
    // pause() closes the runner pump before cancellation returns any acknowledgement.
    if (plan.status !== 'cancelled') {
      goalRunner?.pause?.(plan.planId, receipt.reason);
      const fresh = goalPlanStore.getPlan(plan.planId);
      goalPlanStore.revisePlan(plan.planId, { status: 'paused', delegationOrigin: { ...fresh.delegationOrigin, phase: 'paused', cancellation: receipt } },
        { reason: receipt.reason, changedBy: 'session-cancellation' });
    }
    executionScheduler.cancelPlan(plan.planId);
    return { planId: plan.planId, sessionId: input.sessionId, workspaceId: origin.workspaceId, conversationId: plan.conversationId, receipt };
  }
  async function settle(registration, input) {
    try {
      await abortStream?.({ ...registration, reason: registration.receipt.reason });
      await goalRunner?.waitForIdle?.(registration.planId);
      await executionScheduler.waitForPlanIdle(registration.planId);
      return await exclusive(async () => {
        const plan = goalPlanStore.getPlan(registration.planId);
        if (!canManageWorkspace(registration.workspaceId)) return { error: 'lease_unavailable' };
        if (plan?.delegationOrigin?.cancellation?.operationId !== registration.receipt.operationId) return { error: 'cancellation_superseded' };
        if (plan.status === 'completed' || plan.resultAcceptance?.acceptedAt) return { error: 'session_not_running' };
        const work = workBudgetBinding(registration.workspaceId)?.store.read().works[plan.delegationOrigin.workId];
        const unknown = work?.budget?.uncertainDispatches?.filter(row => row.planId === plan.planId || !row.planId);
        if (unknown?.length) {
          goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin,
            cancellation: { ...registration.receipt, phase: 'awaiting_outcome', evidenceCalls: unknown.map(row => row.toolCallId) } } },
          { reason: 'cancelled execution outcome requires reconciliation', changedBy: 'session-cancellation' });
          return { ...project(goalPlanStore.getPlan(plan.planId)), error: 'execution_outcome_unknown', cancellationPending: true };
        }
        goalPlanStore.revisePlan(plan.planId, { status: 'cancelled', delegationOrigin: { ...plan.delegationOrigin,
          cancellation: { ...registration.receipt, phase: 'completed', completedAt: now(), cleanupPending: true } } },
        { reason: registration.receipt.reason, changedBy: 'session-cancellation' });
        await isolationPlanner?.cleanup(goalPlanStore.getPlan(plan.planId));
        const cleaned = goalPlanStore.getPlan(plan.planId);
        goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...cleaned.delegationOrigin, cancellation: { ...cleaned.delegationOrigin.cancellation, cleanupPending: false } } },
          { reason: 'cancellation cleanup settled', changedBy: 'session-cancellation' });
        emit({ kind: 'cancelled', sessionId: registration.sessionId, planId: plan.planId, workspaceId: registration.workspaceId, reason: registration.receipt.reason,
          ...(registration.receipt.reason === 'supersession_expired' ? { surfacing: 'silent', payload: { reason: 'supersession_expired', surfacing: 'silent' } } : {}) });
        if (input.promote !== false) await promote();
        return project(goalPlanStore.getPlan(plan.planId));
      });
    } catch (error) {
      return { error: error?.message || 'cancellation_failed', cancellationPending: true };
    }
  }
  async function request(input, wait = false) {
    const registration = await exclusive(() => begin(input));
    if (registration.error) return registration;
    if (registration.completed) return registration.completed;
    let done = pending.get(registration.receipt.operationId);
    if (!done) {
      done = settle(registration, input).finally(() => pending.delete(registration.receipt.operationId));
      pending.set(registration.receipt.operationId, done);
    }
    return wait ? done : { ...project(goalPlanStore.getPlan(registration.planId)), cancellationPending: true, operationId: registration.receipt.operationId };
  }
  return { request: input => request(input), cancel: input => request(input, true),
    async recover(plans) { for (const plan of plans) if (plan.delegationOrigin?.cancellation && (plan.status !== 'cancelled' || plan.delegationOrigin.cancellation.cleanupPending)) await request({ sessionId: plan.delegationOrigin.sessionId }, false); } };
}
