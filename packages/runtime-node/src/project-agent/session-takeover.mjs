import { workBudgetBinding } from './work-budget.mjs';
import { agentDelivery } from './agent-delivery.mjs';
import { takeoverBlocker, takeoverHumanBlocker } from './session-repair.mjs';
export { takeoverHumanBlocker } from './session-repair.mjs';

/** Change executor at idle while retaining the task and artifacts. Human approval is not consumed. */
export function createSessionTakeover({ findBySession, goalPlanStore, goalRunner, executionScheduler, exclusive, canManageWorkspace,
  abortStream, promote, emit, now, humanGateOf = () => false }) {
  const pending = new Map();
  async function request(input, context) {
    const store = workBudgetBinding(context.workspaceId)?.store;
    const registration = await exclusive(() => {
      const plan = findBySession(input.sessionId), transition = store?.read().transitions?.[input.operationId];
      if (!plan || plan.delegationOrigin.workspaceId !== context.workspaceId || plan.delegationOrigin.parentConversationId !== context.parentConversationId
        || !canManageWorkspace(context.workspaceId) || !transition || transition.executionEpoch !== input.binding.executionEpoch
        || transition.oldSessionId !== input.sessionId || !['handoff', 'revise', 'resume'].includes(transition.action)) return { error: 'out_of_scope' };
      const humanGate = takeoverBlocker(plan, transition.action, humanGateOf(plan));
      if (humanGate) return { error: humanGate };
      const repair = plan.status === 'completed' || plan.delegationOrigin.takeover?.repair === true;
      if (repair && transition.minimumExecutorVersion !== 3) return {error:'repair_executor_required'};
      store.enableSupervision(repair ? 6 : 5);
      const userRevision = (store.read().decisions[input.operationId]?.sourceInputIds || []).length > 0;
      if (['paused', 'superseded'].includes(plan.delegationOrigin.phase)
        && plan.delegationOrigin.takeover?.operationId !== input.operationId && !userRevision) return { error: 'user_resume_required' };
      if (plan.runner?.interruption?.origin === 'user' && !userRevision) return { error: 'user_resume_required' };
      if (plan.runner?.interruption && (!plan.runner.interruption.origin || plan.runner.interruption.origin === 'unknown') && !userRevision) return { error: 'interruption_origin_unknown' };
      if (plan.delegationOrigin.takeover?.phase === 'completed' && plan.delegationOrigin.takeover.operationId === input.operationId) return { replayed: true };
      goalRunner?.pause?.(plan.planId, 'executor takeover');
      executionScheduler.cancelPlan(plan.planId);
      const fresh = goalPlanStore.getPlan(plan.planId);
      goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...fresh.delegationOrigin, takeover: {
        operationId: input.operationId, phase: 'stopping', text: input.text, binding: input.binding, requestedAt: now(), ...(repair ? {repair:true} : {}) } } },
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
          const work = state.works[input.binding.workId];
          const humanGate = takeoverBlocker(plan, transition.action, humanGateOf(plan));
          if (humanGate || work?.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)) {
            store.advanceTransition(input.operationId, 'stopping', { phase: 'blocked', error: humanGate || 'work_execution_stopped',
              executionAdmission: 'rejected', executionEffect: 'rejected' });
            return;
          }
          const budget = work?.budget;
          const unknown = budget?.uncertainDispatches?.some(row => !row.planId || row.planId === plan.planId)
            || Object.values(budget?.attempts || {}).some(attempt => attempt.pendingTools?.some(row => !row.planId || row.planId === plan.planId));
          if (unknown) {
            store.advanceTransition(input.operationId, 'stopping', { phase: 'awaiting_outcome', error: 'execution_outcome_unknown' });
            emit({kind:'interrupted',eventId:`coordination-outcome:${input.operationId}`,workspaceId:context.workspaceId,sessionId:input.sessionId,planId:plan.planId,reason:'execution_outcome_unknown'}); return;
          }
          const binding = { ...input.binding, sessionId: input.sessionId };
          store.bindSession(binding.workId, binding.goalRevision, input.sessionId, binding);
          // Persist feedback before publishing a queueable plan or ready transition.
          agentDelivery.commit({messageId:`takeover-feedback:${input.operationId}`,operationId:`takeover-feedback:${input.operationId}`,
            workspaceId:context.workspaceId,workId:binding.workId,sessionId:input.sessionId,
            senderConversationId:context.parentConversationId,recipientConversationId:plan.conversationId,direction:'parent_to_child',
            purpose:'update',deliveryIntent:'mailbox_only',text:input.text,goalRevision:binding.goalRevision,
            executionEpoch:binding.executionEpoch,payloadHash:input.operationId,at:now()});
          goalPlanStore.revisePlan(plan.planId, { ...(transition.action === 'revise' ? { goal: input.text } : {}),
            delegationOrigin: { ...plan.delegationOrigin, phase: 'queued', workId: binding.workId, coordinationBinding: binding,
              takeover: { ...plan.delegationOrigin.takeover, phase: 'completed', completedAt: now(), retainedInterruption: plan.runner?.interruption } } },
          { reason: 'executor takeover settled', changedBy: 'session-takeover' });
          // 换执行体的续接是"接着做剩下的活"：核验结论属于被替换的那个执行体，
          // 重放 verify 会让新执行体第一轮就去核验旧成果，然后原地停滞/等用户（复盘症状）。
          const pausedIntent = plan.delegationOrigin.pausedRunnerIntent || 'execute';
          const resumeIntent = plan.delegationOrigin.takeover?.repair === true ? 'execute' : transition.action === 'revise'
            ? 'explore'
            : pausedIntent === 'verify' ? 'execute' : pausedIntent;
          goalPlanStore.setRunnerState(plan.planId, { status: 'paused', intent: resumeIntent, interruption: undefined });
          goalPlanStore.setPlanStatus(plan.planId, 'paused');
          store.advanceTransition(input.operationId, 'stopping', { phase: 'ready' });
          store.advanceTransition(input.operationId, 'ready', { executionAdmission: 'queued', executionEffect: 'pending' });
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
