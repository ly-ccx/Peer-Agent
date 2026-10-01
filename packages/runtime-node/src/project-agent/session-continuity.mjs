import { hasCurrentUserUrgency } from './user-priority.mjs';

const ENDED = new Set(['completed', 'failed', 'cancelled']);
const SUSPENDED = new Set(['paused', 'superseded']);
export const SUPERSESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Owns reversible suspension; execution and cleanup remain on the existing Goal ports. */
export function createSessionContinuity({ goalPlanStore, conversationStore, goalRunner, executionScheduler,
  findBySession, canManageWorkspace, abortStream, emit, now } = {}) {
  const error = (code) => ({ ok: false, error: code });
  function eligible(plan) {
    return Boolean(plan && !ENDED.has(plan.status) && !plan.resultAcceptance?.acceptedAt);
  }
  function check(plan, context) {
    if (!plan) return error('session_not_found');
    const origin = plan.delegationOrigin;
    if (origin.workspaceId !== context.workspaceId || origin.parentConversationId !== context.parentConversationId) return error('out_of_scope');
    if (canManageWorkspace(origin.workspaceId) !== true) return error('lease_unavailable');
    if (!eligible(plan)) return error('session_not_running');
    return { ok: true };
  }
  function replacement(sessionId, context) {
    const plan = findBySession(sessionId);
    const checked = check(plan, context);
    return checked.ok && SUSPENDED.has(plan.delegationOrigin.phase) ? error('session_not_running') : checked;
  }
  function saveOrigin(plan, patch, reason) {
    return goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin, ...patch } },
      { reason, changedBy: 'session-continuity' });
  }
  async function suspend(sessionId, bySessionId, context) {
    const plan = findBySession(sessionId);
    const checked = check(plan, context);
    if (!checked.ok) return checked;
    if (SUSPENDED.has(plan.delegationOrigin.phase) && plan.delegationOrigin.supersededBy === bySessionId) return { ok: true, plan };
    // Persist the admission gate before interrupting an asynchronous tool.
    saveOrigin(plan, { phase: 'superseded', supersededBy: bySessionId, supersededAt: now(),
      pausedFromPhase: plan.delegationOrigin.pausedFromPhase || plan.delegationOrigin.phase,
      pausedRunnerIntent: plan.delegationOrigin.pausedRunnerIntent || plan.runner?.intent || 'execute' }, 'session superseded');
    executionScheduler.cancelPlan(plan.planId);
    goalRunner?.pause?.(plan.planId, 'superseded');
    if (typeof abortStream === 'function') await abortStream({ sessionId, planId: plan.planId, conversationId: plan.conversationId, reason: 'superseded' });
    if (typeof goalRunner?.waitForIdle === 'function') await goalRunner.waitForIdle(plan.planId);
    const fresh = goalPlanStore.getPlan(plan.planId);
    if (!eligible(fresh)) {
      saveOrigin(fresh, { phase: 'running', supersededBy: null, supersededAt: null, pausedFromPhase: null }, 'finished before suspension');
      return error('session_not_running');
    }
    goalPlanStore.setPlanStatus(plan.planId, 'paused');
    emit({ kind: 'session_superseded', sessionId, planId: plan.planId, workspaceId: context.workspaceId, supersededBy: bySessionId });
    return { ok: true, plan: goalPlanStore.getPlan(plan.planId) };
  }
  function anchor(plan, anchorMessageId) {
    const history = conversationStore.getPersistedConversationHistory?.(plan.delegationOrigin.parentConversationId);
    return history?.messages?.some(message => message.id === anchorMessageId && message.role === 'user' && message.kind === 'user_input') === true;
  }
  async function resume(input, context) {
    const plan = findBySession(input.sessionId);
    const checked = check(plan, context);
    if (!checked.ok) return checked;
    if (!anchor(plan, input.anchorMessageId)) return error('invalid_anchor');
    if (plan.delegationOrigin.lastResumeAnchorMessageId === input.anchorMessageId) return { ok: true, replayed: true, plan };
    if (!SUSPENDED.has(plan.delegationOrigin.phase)) return error('session_not_paused');
    const seen = new Set([input.sessionId]);
    let nextId = plan.delegationOrigin.supersededBy;
    const chain = [];
    while (nextId) {
      if (seen.has(nextId)) return error('invalid_supersession_chain');
      seen.add(nextId);
      const next = findBySession(nextId);
      if (!next) break;
      if (next.delegationOrigin.workspaceId !== context.workspaceId || next.delegationOrigin.parentConversationId !== context.parentConversationId) return error('out_of_scope');
      chain.push(next);
      nextId = next.delegationOrigin.supersededBy;
    }
    for (const next of chain) {
      if (eligible(next)) {
        const stopped = await suspend(next.delegationOrigin.sessionId, input.sessionId, context);
        if (!stopped.ok) return stopped;
      }
    }
    const fresh = goalPlanStore.getPlan(plan.planId);
    const phase = fresh.delegationOrigin.pausedFromPhase === 'awaiting_approval' ? 'awaiting_approval' : 'queued';
    goalPlanStore.setRunnerState(plan.planId, { intent: fresh.delegationOrigin.pausedRunnerIntent || 'execute' });
    const restored = saveOrigin(goalPlanStore.getPlan(plan.planId), { phase, supersededBy: null, supersededAt: null, pausedFromPhase: null, pausedRunnerIntent: null,
      lastResumeAnchorMessageId: input.anchorMessageId }, 'user resumed session');
    emit({ kind: 'session_resumed', sessionId: input.sessionId, planId: plan.planId, workspaceId: context.workspaceId, anchorMessageId: input.anchorMessageId });
    return { ok: true, plan: restored };
  }
  function reprioritize(input, context) {
    const plan = findBySession(input.sessionId);
    const checked = check(plan, context);
    if (!checked.ok) return checked;
    if (!['high', 'normal', 'low'].includes(input.priority)) return error('invalid_priority');
    if (input.priority === 'high' && !hasCurrentUserUrgency({ conversationStore, ...context, anchorMessageIds: [input.anchorMessageId] })) return error('urgency_required');
    return { ok: true, plan: saveOrigin(plan, { priority: input.priority }, 'session priority changed') };
  }
  function expired(plan) {
    const at = Date.parse(plan?.delegationOrigin?.supersededAt);
    return plan?.delegationOrigin?.phase === 'superseded' && eligible(plan) && Number.isFinite(at)
      && Date.parse(now()) - at >= SUPERSESSION_RETENTION_MS;
  }
  return { replacement, suspend, resume, reprioritize, expired };
}
