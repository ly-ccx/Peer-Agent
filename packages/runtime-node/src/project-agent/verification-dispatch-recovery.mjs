import { historyExecutionHeld } from './history-resumption.mjs';
const VERIFICATION = new Set(['verify_session', 'local.delegation.verify_session']);
const argsOf = value => { try { return typeof value === 'string' ? JSON.parse(value) : value; } catch { return null; } };
const keyOf = row => `${row.attemptId}:${row.toolCallId}`;

/** Invocation identity only; the host must independently validate ownership and liveness. */
export function verificationDispatchTarget(call) {
  if (!VERIFICATION.has(call?.capabilityId || call?.name)) return undefined;
  const input = argsOf(call.arguments ?? call.input);
  return typeof input?.sessionId === 'string' && input.sessionId.trim().length <= 200 ? input.sessionId.trim() || undefined : undefined;
}

function legacyTarget(work, row, messages, unsettled, origin) {
  if (unsettled.length !== 1) return null;
  const candidates = [];
  for (const message of messages.slice(-256)) {
    if (message.kind !== 'agent_turn' || message.meta?.workId && message.meta.workId !== work.workId
      || (origin ? message.id !== origin.turnId && message.turnId !== origin.turnId : message.meta?.workId !== work.workId)) continue;
    for (const round of message.rounds || []) for (const call of round.toolCalls || []) {
      if (!VERIFICATION.has(call.name) || call.toolCallId && call.toolCallId !== row.toolCallId) continue;
      const result = argsOf(call.result);
      if (!['cancelled_outcome_unknown', 'execution_outcome_unknown'].includes(result?.error)) continue;
      const sessionId = argsOf(call.input)?.sessionId;
      if (typeof sessionId === 'string') candidates.push(sessionId);
    }
  }
  return candidates.length === 1 ? candidates[0] : null;
}

/** Read-only reconciliation, never a tool executor or a success/verification authority. */
export function createVerificationDispatchRecovery({ store, readMessages, activeAttempts, reconcileVerification, now }) {
  const readSnapshot = () => typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const readWork = id => typeof store.readWork === 'function' ? store.readWork(id) : readSnapshot().works[id];
  function reconcile(workId) {
    if (typeof reconcileVerification !== 'function') return;
    const work = readWork(workId);
    if (!work || historyExecutionHeld(work) || ['cancelled', 'delivered', 'budget_limited', 'coalesced'].includes(work.state)) return;
    const attempts = work.budget?.attempts || {};
    const unsettled = [...(work.budget?.uncertainDispatches || []), ...Object.entries(attempts).flatMap(([attemptId, attempt]) =>
      activeAttempts()?.has(attemptId) ? [] : (attempt.pendingTools || []).map(row => ({ ...row, attemptId, role: attempt.role })))];
    const seen = new Set();
    for (const row of unsettled) {
      if (!row.toolCallId || !row.attemptId || seen.has(keyOf(row)) || !VERIFICATION.has(row.capabilityId)
        || row.role !== 'project_agent' || activeAttempts()?.has(row.attemptId)) continue;
      seen.add(keyOf(row));
      const sessionId = row.verificationSessionId || legacyTarget(work, row, readMessages(), unsettled, store.dispatchOrigin?.(workId, row.attemptId, row.toolCallId));
      if (!sessionId || !work.sessionIds?.includes(sessionId)) continue;
      store.assertOwner();
      let receipt;
      try { receipt = reconcileVerification({ workspaceId: work.workspaceId, parentConversationId: work.parentConversationId, sessionId }); }
      catch { continue; }
      if (typeof receipt?.then === 'function') { Promise.resolve(receipt).catch(() => {}); continue; }
      // A Promise or missing/ambiguous receipt is not proof of an inactive local invocation.
      if (!receipt || receipt.status !== 'inactive' || receipt.workspaceId !== work.workspaceId
        || receipt.parentConversationId !== work.parentConversationId || receipt.sessionId !== sessionId
        || typeof receipt.planId !== 'string' || !receipt.planId || typeof receipt.sourceRevision !== 'string' || !receipt.sourceRevision) continue;
      store.assertOwner();
      const current = readWork(workId);
      if (!current || ['cancelled', 'delivered', 'budget_limited'].includes(current.state) || activeAttempts()?.has(row.attemptId)) continue;
      const budget = structuredClone(current.budget);
      const present = budget.uncertainDispatches?.find(item => keyOf(item) === keyOf(row))
        || budget.attempts?.[row.attemptId]?.pendingTools?.find(item => item.toolCallId === row.toolCallId);
      if (!present || present.capabilityId !== row.capabilityId
        || present.verificationSessionId && present.verificationSessionId !== sessionId
        || current.workspaceId !== work.workspaceId || current.parentConversationId !== work.parentConversationId
        || !current.sessionIds?.includes(sessionId)) continue;
      budget.uncertainDispatches = (budget.uncertainDispatches || []).filter(item => keyOf(item) !== keyOf(row));
      if (budget.attempts?.[row.attemptId]) budget.attempts[row.attemptId].pendingTools =
        (budget.attempts[row.attemptId].pendingTools || []).filter(item => item.toolCallId !== row.toolCallId);
      budget.reconciledDispatches = [...(budget.reconciledDispatches || []), { ...row, sessionId,
        planId: receipt.planId, sourceRevision: receipt.sourceRevision, outcome: 'verification_interrupted', at: now() }].slice(-64);
      const remaining = budget.uncertainDispatches.length || Object.entries(budget.attempts || {}).some(([id, item]) => item.pendingTools?.length && !activeAttempts()?.has(id));
      const cleared = !remaining && current.recovery?.failureKind === 'execution_outcome_unknown';
      store.saveWork({ ...current, budget, ...(cleared ? { recovery: { ...current.recovery, failureKind: 'cancelled', retryable: false,
        dispatchesReconciled: true, retryAt: undefined, reservationId: undefined } } : {}) }, { returnState: false });
    }
  }
  return {
    reconcile,
    reconcileAll() {
      for (const work of Object.values(readSnapshot().works)) {
        const pending = [...(work.budget?.uncertainDispatches || []),
          ...Object.entries(work.budget?.attempts || {}).flatMap(([attemptId, attempt]) =>
            activeAttempts()?.has(attemptId) ? [] : (attempt.pendingTools || []).map(row => ({ ...row, role: attempt.role })))];
        if (pending.some(row => VERIFICATION.has(row.capabilityId) && row.role === 'project_agent')) reconcile(work.workId);
      }
    },
    facts(workId) { return (readWork(workId)?.budget?.reconciledDispatches || []).slice(-8).map(row => ({
      toolCallId: row.toolCallId, sessionId: row.sessionId, outcome: row.outcome, verdict: 'unconfirmed', at: row.at,
    })); },
  };
}
