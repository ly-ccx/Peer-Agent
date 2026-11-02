const SPAWN = new Set(['spawn_session', 'local.delegation.spawn_session']);
const keyOf = row => `${row.attemptId}:${row.toolCallId}`;

/** Pair a durable delegation result with its original invocation; never rerun it. */
export function createDelegationDispatchRecovery({ store, readMessages, findEvidenceRecords, readResourceClaims = () => [], activeAttempts, now }) {
  const snapshot = () => store.readSnapshot?.() || store.read();
  const readWork = id => store.readWork?.(id) || snapshot().works[id];
  const pending = work => [...(work.budget?.uncertainDispatches || []),
    ...Object.entries(work.budget?.attempts || {}).flatMap(([attemptId, attempt]) =>
      (attempt.pendingTools || []).map(row => ({ ...row, attemptId, role: attempt.role })))];
  const claimsFor = (work, claims = readResourceClaims()) => claims.filter(claim => claim.workspaceId === work.workspaceId
    && work.sessionIds?.includes(claim.execution?.sessionId));
  const candidates = work => [...pending(work), ...claimsFor(work).flatMap(claim =>
    (claim.evidenceCalls || []).filter(toolCallId => !work.budget?.settledDispatches?.some(row => row.toolCallId === toolCallId
      && row.sessionId === claim.execution.sessionId && row.executionEpoch === claim.execution.executionEpoch))
      .map(toolCallId => ({ toolCallId, claim })))];

  function proof(work, row) {
    if (!row.toolCallId || typeof findEvidenceRecords !== 'function') return null;
    let origin;
    if (!row.claim) {
      if (!SPAWN.has(row.capabilityId) || row.role !== 'project_agent' || !row.attemptId || activeAttempts()?.has(row.attemptId)) return null;
      origin = store.dispatchOrigin?.(work.workId, row.attemptId, row.toolCallId);
      if (!origin?.turnId) return null;
    }
    const evidenceRef = `tool-result://${row.toolCallId}`;
    const records = findEvidenceRecords([evidenceRef]);
    if (!Array.isArray(records) || records.length !== 1) return null;
    const record = records[0];
    if (record.evidenceRef !== evidenceRef || record.toolCallId !== row.toolCallId
      || record.capabilityId !== 'local.delegation.spawn_session' || record.toolName !== 'spawn_session'
      || record.conversationId !== work.parentConversationId || !record.streamId || origin && record.streamId !== origin.turnId) return null;
    const messages = readMessages();
    const turns = messages.filter(message => message.kind === 'agent_turn' && (message.turnId || message.id) === record.streamId
      && message.meta?.workId === work.workId);
    if (turns.length !== 1) return null;
    const results = (turns[0].rounds || []).flatMap(round => round.toolCalls || [])
      .filter(call => SPAWN.has(call.name) && call.result?.ok === true
        && call.result.evidenceRefs?.includes(evidenceRef));
    if (results.length !== 1) return null;
    const result = results[0].result;
    if (result.phase !== 'completed' || result.workId !== work.workId || !work.sessionIds?.includes(result.sessionId)) return null;
    const transition = store.readLifecycleFacts?.().transitions?.[result.operationId];
    if (!transition || transition.phase !== 'completed' || transition.action !== 'parallel' || transition.workId !== work.workId
      || transition.replacementSessionId !== result.sessionId || transition.expectedGoalRevision !== result.goalRevision
      || typeof transition.executionEpoch !== 'string' || !transition.executionEpoch) return null;
    if (row.claim && (row.claim.execution.sessionId !== result.sessionId || row.claim.execution.executionEpoch !== transition.executionEpoch
      || row.claim.execution.goalRevision !== result.goalRevision)) return null;
    return { ...(row.attemptId ? { attemptId: row.attemptId } : {}), turnId: record.streamId,
      toolCallId: row.toolCallId, evidenceRef, operationId: result.operationId,
      sessionId: result.sessionId, executionEpoch: transition.executionEpoch, goalRevision: result.goalRevision, at: now() };
  }

  function reconcile(workId) {
    let work = readWork(workId);
    if (!work) return;
    const seen = new Set();
    for (const row of candidates(work)) {
      if (seen.has(keyOf(row))) continue;
      seen.add(keyOf(row));
      let receipt;
      try { store.assertOwner(); receipt = proof(work, row); } catch { continue; }
      if (!receipt) continue;
      store.assertOwner();
      work = readWork(workId);
      if (!work || activeAttempts()?.has(row.attemptId)) continue;
      const current = row.claim ? claimsFor(work).find(claim => claim.claimId === row.claim.claimId && claim.revision === row.claim.revision)
        : pending(work).find(item => keyOf(item) === keyOf(row));
      if (!current || !row.claim && (current.capabilityId !== row.capabilityId || current.role !== row.role)) continue;
      // Re-read every source after a reader callback; a superseded result is not a receipt.
      let checked;
      try { checked = proof(work, row); } catch { continue; }
      if (!checked || checked.operationId !== receipt.operationId || checked.executionEpoch !== receipt.executionEpoch
        || checked.sessionId !== receipt.sessionId || checked.goalRevision !== receipt.goalRevision) continue;
      store.assertOwner();
      if (readWork(workId)?.revision !== work.revision) continue;
      const budget = structuredClone(work.budget);
      budget.uncertainDispatches = (budget.uncertainDispatches || []).filter(item => keyOf(item) !== keyOf(row));
      const attempt = budget.attempts?.[row.attemptId];
      if (attempt) {
        attempt.pendingTools = (attempt.pendingTools || []).filter(item => item.toolCallId !== row.toolCallId);
        if (!attempt.pendingTools.length) {
          delete budget.attempts[row.attemptId];
          budget.unknownUsage = true;
          budget.unknownCost = true;
        }
      }
      budget.settledDispatches = [...(budget.settledDispatches || []).filter(item => item.toolCallId !== receipt.toolCallId), receipt];
      store.saveWork({ ...work, budget }, { returnState: false });
    }
  }
  return { reconcile, reconcileAll() {
    const claims = readResourceClaims();
    for (const work of Object.values(snapshot().works)) if (pending(work).some(row => SPAWN.has(row.capabilityId))
      || claimsFor(work, claims).some(claim => claim.evidenceCalls?.length)) reconcile(work.workId);
  } };
}
