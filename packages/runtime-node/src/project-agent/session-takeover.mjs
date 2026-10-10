import { workBudgetBinding } from './work-budget.mjs';

/** Change executor at idle while retaining the task and artifacts. Human approval is not consumed. */
export function createSessionTakeover({ findBySession, goalPlanStore, goalRunner, executionScheduler, exclusive, canManageWorkspace,
  abortStream, promote, emit, now }) {
  const pending = new Map();
  async function request(input, context) {
    const store = workBudgetBinding(context.workspaceId)?.store;
    const registration = await exclusive(() => {
      const plan = findBySession(input.sessionId), transition = store?.read().transitions?.[input.operationId];
      if (!plan || plan.delegationOrigin.workspaceId !== context.workspaceId || plan.delegationOrigin.parentConversationId !== context.parentConversationId
        || !canManageWorkspace(context.workspaceId) || !transition || transition.executionEpoch !== input.binding.executionEpoch
        || transition.oldSessionId !== input.sessionId || !['handoff', 'revise'].includes(transition.action)) return { error: 'out_of_scope' };
      if (plan.resultAcceptance?.acceptedAt || ['completed', 'cancelled'].includes(plan.status) || plan.delegationOrigin.cancellation) return { error: 'session_not_running' };
      if (plan.runner?.status === 'waiting_user') return { error: 'human_decision_required' };
      if (plan.delegationOrigin.takeover?.phase === 'completed' && plan.delegationOrigin.takeover.operationId === input.operationId) return { replayed: true };
      goalRunner?.pause?.(plan.planId, 'executor takeover');
      executionScheduler.cancelPlan(plan.planId);
      const fresh = goalPlanStore.getPlan(plan.planId);
      goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...fresh.delegationOrigin, takeover: {
        operationId: input.operationId, phase: 'stopping', text: input.text, binding: input.binding, requestedAt: now() } } },
      { reason: 'coordinator executor takeover', changedBy: 'session-takeover' });
      return { planId: plan.planId, conversationId: plan.conversationId };
    });
    if (registration.error || registration.replayed) return registration;
    if (!pending.has(input.operationId)) {
      const done = Promise.resolve().then(async () => {
        await abortStream?.({ sessionId: input.sessionId, ...registration, reason: 'executor takeover' });
        await goalRunner?.waitForIdle?.(registration.planId); await executionScheduler.waitForPlanIdle(registration.planId);
        await exclusive(async () => {
          if (!canManageWorkspace(context.workspaceId)) return;
          const state = store.read(), transition = state.transitions[input.operationId], mandate = state.mandates[input.binding.workId];
          const plan = goalPlanStore.getPlan(registration.planId);
          if (mandate.goalRevision !== input.binding.goalRevision || transition.phase !== 'stopping'
            || plan.delegationOrigin.takeover?.operationId !== input.operationId || plan.delegationOrigin.cancellation) return;
          const unknown = state.works[input.binding.workId]?.budget?.uncertainDispatches?.some(row => !row.planId || row.planId === plan.planId);
          if (unknown) {
            store.advanceTransition(input.operationId, 'stopping', { phase: 'awaiting_outcome', error: 'execution_outcome_unknown' }); return;
          }
          const binding = { ...input.binding, sessionId: input.sessionId };
          store.bindSession(binding.workId, binding.goalRevision, input.sessionId, binding);
          store.advanceTransition(input.operationId, 'stopping', { phase: 'ready' });
          goalPlanStore.revisePlan(plan.planId, { ...(transition.action === 'revise' ? { goal: input.text } : {}),
            delegationOrigin: { ...plan.delegationOrigin, phase: 'queued', workId: binding.workId, coordinationBinding: binding,
              takeover: { ...plan.delegationOrigin.takeover, phase: 'completed', completedAt: now() } } },
          { reason: 'executor takeover settled', changedBy: 'session-takeover' });
          goalPlanStore.setRunnerState(plan.planId, { status: 'paused', intent: transition.action === 'revise' ? 'explore' : plan.delegationOrigin.pausedRunnerIntent || 'execute' });
          emit({ kind: 'session_resumed', workspaceId: context.workspaceId, sessionId: input.sessionId, planId: plan.planId,
            reason: 'executor_takeover', payload: { operationId: input.operationId, goalRevision: binding.goalRevision } });
          await promote();
        });
      }).catch(error => {
        if (!canManageWorkspace(context.workspaceId)) return;
        const transition = store.read().transitions[input.operationId];
        if (transition?.phase === 'stopping') store.advanceTransition(input.operationId, 'stopping', { phase: 'blocked', error: error?.message || 'takeover_failed' });
      }).finally(() => pending.delete(input.operationId));
      pending.set(input.operationId, done);
    }
    return { pending: true };
  }
  return { request };
}
