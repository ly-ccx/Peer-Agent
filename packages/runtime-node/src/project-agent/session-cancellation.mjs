import { randomUUID } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';
import { isCanonicalUserInput } from './user-priority.mjs';
import { sessionFactsFromPlan } from './session-facts.mjs';

/** Execution return is not cancellation settlement; accepted results stay immutable. */
export function sessionNeedsCancellation(session) {
  if (!session || session.status === 'accepted') return false;
  if (session.status === 'superseded') return session.followUp?.inCurrentList === true;
  return session.status !== 'cancelled' || session.origin?.cancellation?.phase !== 'completed'
    || session.origin?.cancellation?.cleanupPending === true || session.followUp?.inCurrentList === true;
}

/** Register under the project writer, settle outside it, then conditionally commit. */
export function createSessionCancellation({ findBySession, goalPlanStore, goalRunner, executionScheduler, canManageWorkspace,
  abortStream, isolationPlanner, exclusive, project, emit, promote, readMessages = () => [], now }) {
  const pending = new Map();
  function withdrawalFor(plan, input, context) {
    const origin = plan.delegationOrigin;
    const scope = { workspaceId: origin.workspaceId, parentConversationId: origin.parentConversationId,
      sessionId: origin.sessionId, planId: plan.planId };
    const current = new Set(context.currentInputAnchors || []);
    const recorded = origin.cancellation?.withdrawal;
    if (!current.size && !recorded) return null;
    const scoped = context.workspaceId === origin.workspaceId
      && (context.parentConversationId || context.conversationId) === origin.parentConversationId;
    if (current.size && !scoped) return null;
    const messages = readMessages(origin.parentConversationId).filter(isCanonicalUserInput);
    const source = scoped && messages.findLast(row => current.has(row.id) && (!input.anchorMessageId || row.id === input.anchorMessageId));
    if (source) return { ...scope, anchorMessageId: source.id, inputId: source.inputId || source.id, admittedAt: now() };
    if (current.size) return null;
    if (recorded && Object.entries(scope).every(([key, value]) => recorded[key] === value)
      && messages.some(row => row.id === recorded.anchorMessageId && (row.inputId || row.id) === recorded.inputId)) return recorded;
    return null;
  }
  function begin(input, context) {
    const plan = findBySession(input.sessionId);
    if (!plan) return { error: 'session_not_found' };
    const origin = plan.delegationOrigin;
    const parent = context.parentConversationId || context.conversationId;
    if (context.workspaceId && context.workspaceId !== origin.workspaceId || parent && parent !== origin.parentConversationId) return { error: 'out_of_scope' };
    if (!canManageWorkspace(origin.workspaceId)) return { error: 'lease_unavailable' };
    if (plan.resultAcceptance?.acceptedAt) return { error: 'session_not_running' };
    if (plan.status === 'cancelled' && !sessionNeedsCancellation(project(plan))) return { completed: project(plan) };
    const withdrawal = withdrawalFor(plan, input, context);
    if (context.currentInputAnchors?.length && !withdrawal) return { error: 'current_user_required' };
    const receipt = { ...(origin.cancellation || { operationId: input.operationId || `cancel-${randomUUID()}`, reason: input.reason || 'cancelled', requestedAt: now() }),
      phase: 'stopping',
      ...(withdrawal ? { withdrawal } : {}),
      ...(input.preserveArtifacts === true || ['completed', 'failed'].includes(plan.status) ? { preserveArtifacts: true } : {}) };
    // pause() closes the runner pump before cancellation returns any acknowledgement.
    goalRunner?.pause?.(plan.planId, receipt.reason);
    const fresh = goalPlanStore.getPlan(plan.planId);
    goalPlanStore.revisePlan(plan.planId, { status: 'paused', delegationOrigin: { ...fresh.delegationOrigin, phase: 'paused', cancellation: receipt } },
      { reason: receipt.reason, changedBy: 'session-cancellation' });
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
        if (plan.resultAcceptance?.acceptedAt) return { error: 'session_not_running' };
        const binding = workBudgetBinding(registration.workspaceId);
        const work = binding?.store.read().works[plan.delegationOrigin.workId];
        const unknown = work?.budget?.uncertainDispatches?.filter(row => row.planId === plan.planId || !row.planId);
        if (sessionFactsFromPlan(plan).executionOwnership === 'live' || unknown?.some(row => binding.activeAttempts?.has(row.attemptId))) {
          return { error: 'execution_still_running', cancellationPending: true };
        }
        if (unknown?.length && !registration.receipt.withdrawal) {
          goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin,
            cancellation: { ...registration.receipt, phase: 'awaiting_outcome', evidenceCalls: unknown.map(row => row.toolCallId) } } },
          { reason: 'cancelled execution outcome requires reconciliation', changedBy: 'session-cancellation' });
          emit({ kind: 'interrupted', eventId: `coordination-outcome:${registration.receipt.operationId}`,
            sessionId: registration.sessionId, workspaceId: registration.workspaceId, planId: plan.planId,
            reason: 'execution_outcome_unknown' });
          return { ...project(goalPlanStore.getPlan(plan.planId)), error: 'execution_outcome_unknown', cancellationPending: true };
        }
        // Withdraw responsibility without pretending to resolve or erase historical effects.
        const disposition = unknown?.length ? { disposition: 'user_withdrawn',
          evidenceCalls: [...new Set(unknown.map(row => row.toolCallId))], preserveArtifacts: true } : {};
        goalPlanStore.revisePlan(plan.planId, { status: 'cancelled', delegationOrigin: { ...plan.delegationOrigin,
          cancellation: { ...registration.receipt, ...disposition, ...(['completed', 'failed'].includes(plan.status) ? { preserveArtifacts: true } : {}),
            phase: 'completed', completedAt: now(), cleanupPending: true } } },
        { reason: registration.receipt.reason, changedBy: 'session-cancellation' });
        await isolationPlanner?.cleanup(goalPlanStore.getPlan(plan.planId));
        const cleaned = goalPlanStore.getPlan(plan.planId);
        goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...cleaned.delegationOrigin, cancellation: { ...cleaned.delegationOrigin.cancellation, cleanupPending: false } } },
          { reason: 'cancellation cleanup settled', changedBy: 'session-cancellation' });
        const settled = project(goalPlanStore.getPlan(plan.planId));
        if (settled.status !== 'cancelled' || settled.actionRight !== 'terminal' || settled.nextAction !== 'none'
          || settled.followUp?.inCurrentList !== false) {
          return { ...settled, error: 'cancellation_not_settled', cancellationPending: true };
        }
        emit({ kind: 'cancelled', sessionId: registration.sessionId, planId: plan.planId, workspaceId: registration.workspaceId, reason: registration.receipt.reason,
          ...(registration.receipt.reason === 'supersession_expired' ? { surfacing: 'silent', payload: { reason: 'supersession_expired', surfacing: 'silent' } } : {}) });
        if (input.promote !== false) await promote();
        return project(goalPlanStore.getPlan(plan.planId));
      });
    } catch (error) {
      return { error: error?.message || 'cancellation_failed', cancellationPending: true };
    }
  }
  async function request(input, wait = false, context = {}) {
    const registration = await exclusive(() => begin(input, context));
    if (registration.error) return registration;
    if (registration.completed) return registration.completed;
    let done = pending.get(registration.receipt.operationId);
    if (!done) {
      done = settle(registration, input).finally(() => pending.delete(registration.receipt.operationId));
      pending.set(registration.receipt.operationId, done);
    }
    return wait ? done : { ...project(goalPlanStore.getPlan(registration.planId)), cancellationPending: true, operationId: registration.receipt.operationId };
  }
  return { request: (input, context) => request(input, false, context), cancel: (input, context) => request(input, true, context),
    async recover(plans) { for (const plan of plans) if (plan.delegationOrigin?.cancellation && (plan.status !== 'cancelled' || plan.delegationOrigin.cancellation.cleanupPending)) await request({ sessionId: plan.delegationOrigin.sessionId }, false); } };
}
