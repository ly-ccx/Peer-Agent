import { createSessionControl } from './session-control.mjs';
import { hasCurrentUserUrgency, isCanonicalUserInput } from './user-priority.mjs';

const ENDED = new Set(['completed', 'failed', 'cancelled']);
const SUSPENDED = new Set(['paused', 'superseded']);
export const SUPERSESSION_RETENTION_MS = 7 * 24 * 60 * 60_000;

/** Owns reversible suspension; execution and cleanup remain on the existing Goal ports. */
export function createSessionContinuity({ goalPlanStore, conversationStore, goalRunner, executionScheduler,
  sessionControl = null, findBySession, canManageWorkspace, abortStream, emit, now } = {}) {
  sessionControl ??= createSessionControl({ goalPlanStore, goalRunner, executionScheduler, canManageWorkspace, abortStream, now });
  const error = (code) => ({ ok: false, error: code });
  function eligible(plan) {
    return Boolean(plan && !ENDED.has(plan.status) && !plan.resultAcceptance?.acceptedAt && !plan.delegationOrigin?.cancellation);
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
    const operation = sessionControl.begin(plan, { kind: 'pause', operationId: `suspend:${sessionId}:${bySessionId || plan.updatedAt}`,
      authorityRef: `supersession:${bySessionId || sessionId}`, reason: 'superseded' });
    // Persist the admission gate before interrupting an asynchronous tool.
    saveOrigin(goalPlanStore.getPlan(plan.planId), { phase: bySessionId ? 'superseded' : 'paused', supersededBy: bySessionId, supersededAt: now(),
      pausedFromPhase: plan.delegationOrigin.pausedFromPhase || plan.delegationOrigin.phase,
      pausedRunnerIntent: plan.delegationOrigin.pausedRunnerIntent || plan.runner?.intent || 'execute' }, 'session superseded');
    executionScheduler.cancelPlan(plan.planId);
    goalRunner?.pause?.(plan.planId, 'superseded');
    const receipt = await sessionControl.drain(goalPlanStore.getPlan(plan.planId), operation);
    const controlled = sessionControl.settle(goalPlanStore.getPlan(plan.planId), operation, receipt);
    if (controlled.phase !== 'settled') return error('execution_outcome_unknown');
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
    return history?.messages?.some(message => message.id === anchorMessageId && isCanonicalUserInput(message)) === true;
  }
  function resumeAdmission(input, context) {
    const plan = findBySession(input.sessionId);
    const checked = check(plan, context);
    if (!checked.ok) return checked;
    // The original takeover still owns stopping, outcome reconciliation and
    // rebinding. A native resume must not supersede half of that transaction.
    if (plan.delegationOrigin.takeover?.phase === 'stopping') return error('coordination_reconciliation_required');
    if (executionScheduler.inspect(plan).reason === 'coordination_reconciliation_required') return error('coordination_reconciliation_required');
    if (!anchor(plan, input.anchorMessageId)) return error('invalid_anchor');
    if (plan.delegationOrigin.lastResumeAnchorMessageId === input.anchorMessageId) return { ok: true, replayed: true, plan };
    if (!SUSPENDED.has(plan.delegationOrigin.phase)) return error('session_not_paused');
    return { ok: true, plan };
  }
  async function resume(input, context) {
    const admitted = resumeAdmission(input, context);
    if (!admitted.ok || admitted.replayed) return admitted;
    const { plan } = admitted;
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
    const previous = sessionControl.read(fresh);
    if (previous && previous.phase !== 'settled') {
      const receipt = await sessionControl.drain(fresh, previous);
      if (sessionControl.settle(goalPlanStore.getPlan(plan.planId), previous, receipt).phase !== 'settled') return error('execution_outcome_unknown');
    }
    await sessionControl.resume(goalPlanStore.getPlan(plan.planId), input.anchorMessageId);
    const resumedOrigin = goalPlanStore.getPlan(plan.planId).delegationOrigin;
    const phase = fresh.delegationOrigin.pausedFromPhase === 'awaiting_approval' ? 'awaiting_approval' : 'queued';
    goalPlanStore.setRunnerState(plan.planId, { intent: fresh.delegationOrigin.pausedRunnerIntent || 'execute' });
    const restored = saveOrigin(goalPlanStore.getPlan(plan.planId), { executionControl: resumedOrigin.executionControl, phase, supersededBy: null, supersededAt: null, pausedFromPhase: null, pausedRunnerIntent: null,
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
  async function prepareResume(input, context, exclusive) {
    const checked = await exclusive(() => resumeAdmission(input, context));
    if (!checked.ok || checked.replayed) return checked;
    try { await sessionControl.prepareResume(checked.plan, input.anchorMessageId, exclusive); return { ok: true }; }
    catch (failure) { return error(failure.message); }
  }
  return { replacement, suspend, resume, prepareResume, reprioritize, expired };
}
