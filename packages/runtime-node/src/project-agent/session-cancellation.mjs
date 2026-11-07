import { createSessionControl } from './session-control.mjs';
import { randomUUID } from 'node:crypto';
import { workBudgetBinding } from './work-budget.mjs';
import { isCanonicalUserInput } from './user-priority.mjs';
import { unsettledExecution } from './execution-resources.mjs';
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
  sessionControl = null, abortStream, isolationPlanner, exclusive, project, emit, promote, readMessages = () => [], now }) {
  sessionControl ??= createSessionControl({ goalPlanStore, goalRunner, executionScheduler, canManageWorkspace, abortStream, now });
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
    if (plan.status === 'cancelled' && origin.takeover?.phase !== 'stopping' && !sessionNeedsCancellation(project(plan))) return { completed: project(plan) };
    const withdrawal = withdrawalFor(plan, input, context);
    if (context.currentInputAnchors?.length && !withdrawal) return { error: 'current_user_required' };
    // One user input may stop several plans in the workspace-wide control journal.
    const receipt = { ...(origin.cancellation || { operationId: input.operationId || `cancel-${randomUUID()}`, reason: input.reason || 'cancelled', requestedAt: now() }),
      ...(withdrawal && withdrawal.inputId !== origin.cancellation?.withdrawal?.inputId ? { operationId: `cancel-user:${withdrawal.inputId}:${plan.planId}` } : {}),
      phase: 'stopping',
      ...(withdrawal ? { withdrawal } : {}),
      ...(input.preserveArtifacts === true || ['completed', 'failed'].includes(plan.status) ? { preserveArtifacts: true } : {}) };
    // pause() closes the runner pump before cancellation returns any acknowledgement.
    const control = sessionControl.begin(plan, { kind: 'cancel', operationId: receipt.operationId,
      authorityRef: withdrawal?.anchorMessageId || `cancellation:${receipt.operationId}`, reason: receipt.reason });
    const fresh = goalPlanStore.getPlan(plan.planId);
    goalPlanStore.revisePlan(plan.planId, { status: 'paused', delegationOrigin: { ...fresh.delegationOrigin, phase: 'paused', cancellation: receipt } },
      { reason: receipt.reason, changedBy: 'session-cancellation' });
    executionScheduler.cancelPlan(plan.planId);
    return { planId: plan.planId, sessionId: input.sessionId, workspaceId: origin.workspaceId, conversationId: plan.conversationId, receipt, control };
  }
  async function settle(registration, input) {
    try {
      const stopReceipt = await sessionControl.drain(goalPlanStore.getPlan(registration.planId), registration.control);
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
        const controlled = sessionControl.settle(plan, registration.control, stopReceipt, { withdrawal: Boolean(registration.receipt.withdrawal) });
        if (controlled.phase === 'reconciling') {
          goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...goalPlanStore.getPlan(plan.planId).delegationOrigin,
            cancellation: { ...registration.receipt, phase: 'awaiting_outcome', evidenceCalls: stopReceipt.unknownCalls } } },
          { reason: 'cancelled execution outcome requires reconciliation', changedBy: 'session-cancellation' });
          emit({ kind: 'interrupted', eventId: `coordination-outcome:${registration.receipt.operationId}`,
            sessionId: registration.sessionId, workspaceId: registration.workspaceId, planId: plan.planId,
            reason: 'execution_outcome_unknown' });
          return { ...project(goalPlanStore.getPlan(plan.planId)), error: 'execution_outcome_unknown', cancellationPending: true };
        }
        // Withdraw responsibility without pretending to resolve or erase historical effects.
        const disposition = stopReceipt.unknownCalls.length ? { disposition: 'user_withdrawn',
          evidenceCalls: stopReceipt.unknownCalls, preserveArtifacts: true } : {};
        goalPlanStore.revisePlan(plan.planId, { status: 'cancelled', delegationOrigin: { ...goalPlanStore.getPlan(plan.planId).delegationOrigin,
          cancellation: { ...registration.receipt, ...disposition, ...(['completed', 'failed'].includes(plan.status) ? { preserveArtifacts: true } : {}),
            phase: 'completed', completedAt: now(), cleanupPending: true } } },
        { reason: registration.receipt.reason, changedBy: 'session-cancellation' });
        sessionControl.retireTakeover(goalPlanStore.getPlan(plan.planId), registration.control.operationId);
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
    async recover(plans) { for (const plan of plans) {
      const origin = plan.delegationOrigin;
      if (!origin?.cancellation || plan.status === 'cancelled' && !origin.cancellation.cleanupPending) continue;
      if (origin.cancellation.phase === 'awaiting_outcome'
        && JSON.stringify(origin.cancellation.evidenceCalls || []) === JSON.stringify(unsettledExecution(plan))) continue;
      await request({ sessionId: origin.sessionId }, true);
    } } };
}
