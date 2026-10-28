import { createHash } from 'node:crypto';
export function historyCheckpointBindings(work) {
  const rows = work.checkpointRef ? [{ ref: work.checkpointRef, owner: work.workId }] : [];
  for (const [id, attempt] of Object.entries(work.budget?.attempts || {})) if (attempt.checkpointRef) rows.push({ ref: attempt.checkpointRef, owner: `${work.workId}:${id}` });
  if (work.nativeCheckpointRef && !rows.some(row => row.ref === work.nativeCheckpointRef)) rows.push({ ref: work.nativeCheckpointRef, owner: work.workId });
  return rows;
}
const hasUnsettledDispatch = work => Boolean(work?.budget?.uncertainDispatches?.length
  || Object.values(work?.budget?.attempts || {}).some(attempt => attempt.pendingTools?.length));
function recoveryCheckpointAvailable(work, checkpoint, readCheckpoint) {
  if (!checkpoint || checkpoint.job?.workId !== work.workId) return false;
  const calls = (checkpoint.outcome?.rounds || []).flatMap(round => round.toolCalls || []);
  if (calls.some(call => call.result == null)) return false;
  if (!calls.length && !(work.budget?.toolCalls > 0)) return true;
  const native = work.nativeCheckpointRef ? readCheckpoint(work.nativeCheckpointRef) : checkpoint.outcome?.providerCheckpoint;
  return Boolean(native && typeof native === 'object' && !Array.isArray(native));
}

export const historyWorkHeld = work => work?.historyRecovery?.disposition === 'held';
export const historyExecutionHeld = work => ['held', 'retained'].includes(work?.historyRecovery?.disposition);
export const historyTerminal = work => ['delivered', 'cancelled', 'coalesced'].includes(work?.state);
export const recoveryHash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest('hex');

/** Derive admission from immutable local facts, never from a renderer's verdict. */
export function planHistoryResumption(state, inspection, { readCheckpoint, sessionSafe = () => false } = {}) {
  if (inspection.conflicts.some(row => row.bucket !== 'works')) throw new Error('coordination_recovery_identity_conflict');
  const conflicts = new Set(inspection.conflicts.map(row => row.id));
  const owners = new Map();
  const originals = inspection.conflicts.filter(row => row.bucket === 'works').flatMap(row => [row.baseline, row.current, row.legacy]).filter(Boolean);
  for (const work of [...Object.values(state.works), ...originals]) for (const input of work.anchorInputIds || []) {
    if (!owners.has(input)) owners.set(input, new Set());
    owners.get(input).add(work.workId);
  }
  const prepared = new Set();
  for (const row of Object.values(state.deliveries || {})) if (row.state === 'prepared') {
    const id = row.message?.meta?.workId;
    if (!id || !state.works[id]) throw new Error('coordination_recovery_unbound_delivery');
    prepared.add(id);
  }
  return Object.values(state.works).filter(work => !historyTerminal(work)
    && (state.lastRecovery?.executionBlocked !== false || historyWorkHeld(work))).map(work => {
    const previous = work.historyRecovery?.previousRecovery ?? work.recovery;
    const previousState = work.historyRecovery?.previousState ?? work.state;
    let reason = conflicts.has(work.workId) ? 'history_conflict'
      : (work.anchorInputIds || []).some(id => owners.get(id)?.size > 1) ? 'input_ownership'
      : prepared.has(work.workId) ? 'delivery_pending'
      : Object.values(state.transitions || {}).some(row => row.workId === work.workId && !['completed', 'blocked'].includes(row.phase)) ? 'coordination_pending'
      : hasUnsettledDispatch(work) || previous?.failureKind === 'execution_outcome_unknown' ? 'execution_unknown'
      : work.budget?.unknownUsage || work.budget?.unconfirmedUsd > 0 ? 'budget_unconfirmed'
      : work.stopScope === 'work' || previousState === 'paused' ? 'paused'
      : previousState === 'waiting_user' ? 'waiting_user'
      : (work.sessionIds || []).some(id => sessionSafe(id) !== true) ? 'child_execution'
      : !['runnable', 'retry_wait', 'blocked_system', 'waiting_children'].includes(previousState) ? 'checkpoint_unavailable'
      : null;
    let checkpoint;
    if (!reason) {
      try {
        checkpoint = readCheckpoint(work.workId, work.checkpointRef);
        const original = { ...work, recovery: previous };
        const inputIds = (checkpoint?.job?.userInputs || []).map(row => row.inputId).sort();
        if (recoveryHash(inputIds) !== recoveryHash([...(work.anchorInputIds || [])].sort())) reason = 'input_ownership';
        else if ((checkpoint?.outcome?.rounds || []).some(round => (round.toolCalls || []).some(call => call.result == null
          || [call.terminalReason, call.result?.error].some(value => /outcome_unknown$/.test(value || ''))))) reason = 'execution_unknown';
        else if (checkpoint?.job?.workId !== work.workId || !recoveryCheckpointAvailable(original, checkpoint,
          ref => readCheckpoint(work.workId, ref))) reason = 'checkpoint_unavailable';
        else if (checkpoint.outcome?.failed && previous?.retryable !== true) reason = 'paused';
        else if (checkpoint.outcome?.stopped || work.stopScope === 'reply') reason = 'paused';
      } catch { reason = 'checkpoint_unavailable'; }
    }
    return { workId: work.workId, workHash: recoveryHash(work), disposition: reason ? 'held' : 'resume', reason: reason || 'checkpoint_verified' };
  });
}

/** Atomic journal transition. All old work must be accounted for exactly once. */
export function admitHistoryResumption(previous, entry) {
  const fail = () => { throw new Error('coordination_resume_plan_changed'); };
  if (!previous.lastRecovery || !/^[a-f0-9]{64}$/.test(entry.sourceFingerprint || '') || entry.sourceFingerprint !== previous.lastRecovery.sourceFingerprint
    || entry.expectedRevision !== previous.revision || !Array.isArray(entry.decisions)) fail();
  for (const key of ['quarantinedSessionIds', 'quarantinedInputIds', 'quarantinedEventIds']) if (entry[key] !== undefined && !Array.isArray(entry[key])) fail();
  const ids = Object.values(previous.works).filter(work => !historyTerminal(work)
    && (previous.lastRecovery.executionBlocked !== false || historyWorkHeld(work))).map(work => work.workId);
  if (entry.decisions.length !== ids.length || new Set(entry.decisions.map(row => row.workId)).size !== ids.length) fail();
  const initialAdmission = previous.lastRecovery.executionBlocked !== false;
  const holding = new Set(entry.decisions.filter(row => row.disposition === 'held').map(row => row.workId));
  const works = { ...previous.works }, heldWorkIds = [], resumedWorkIds = [...(previous.lastRecovery.resumedWorkIds || [])],
    quarantinedSessionIds = new Set([...(previous.lastRecovery.quarantinedSessionIds || []), ...(entry.quarantinedSessionIds || [])]);
  const quarantinedOperationIds = [...new Set([...(previous.lastRecovery.quarantinedOperationIds || []),
    ...Object.values(previous.transitions || {}).filter(row => (initialAdmission || holding.has(row.workId))
      && !['completed', 'blocked'].includes(row.phase)).map(row => row.operationId)])];
  const quarantinedInputIds = [...new Set([...(previous.lastRecovery.quarantinedInputIds || []), ...(entry.quarantinedInputIds || [])])];
  const quarantinedEventIds = [...new Set([...(previous.lastRecovery.quarantinedEventIds || []), ...(entry.quarantinedEventIds || [])])];
  const quarantinedDeliveryIds = [...new Set([...(previous.lastRecovery.quarantinedDeliveryIds || []),
    ...Object.values(previous.deliveries || {}).filter(row => (initialAdmission || holding.has(row.message?.meta?.workId))
      && row.state === 'prepared').map(row => row.message.id)])];
  if ([...quarantinedInputIds, ...quarantinedEventIds].some(id => typeof id !== 'string' || !id || id.length > 200)) fail();
  if ([...quarantinedSessionIds].some(id => typeof id !== 'string' || !id || id.length > 200)) fail();
  for (const row of entry.decisions) {
    const work = works[row.workId];
    if (!ids.includes(row.workId) || recoveryHash(work) !== row.workHash || !['held', 'resume'].includes(row.disposition)) fail();
    if (row.disposition === 'resume' && (!work.checkpointRef || row.reason !== 'checkpoint_verified' || hasUnsettledDispatch(work))) fail();
    const historyRecovery = { sourceFingerprint: entry.sourceFingerprint, disposition: row.disposition, reason: row.reason,
      previousState: work.historyRecovery?.previousState ?? work.state, previousRecovery: work.historyRecovery?.previousRecovery ?? null, at: entry.at };
    if (row.disposition === 'held') {
      heldWorkIds.push(row.workId);
      for (const id of work.sessionIds || []) quarantinedSessionIds.add(id);
      works[row.workId] = { ...work, state: 'blocked_system', revision: (work.revision || 0) + 1,
        historyRecovery, recovery: { ...work.recovery, retryable: false, retryAt: undefined, reservationId: undefined,
          blockedCode: 'COORDINATION_RECONCILIATION_REQUIRED' } };
    } else {
      resumedWorkIds.push(row.workId);
      works[row.workId] = { ...work, state: 'runnable', revision: (work.revision || 0) + 1,
        historyRecovery, recovery: historyRecovery.previousRecovery ?? undefined };
    }
  }
  return { ...previous, works, lastRecovery: { ...previous.lastRecovery, executionBlocked: false,
    heldWorkIds, resumedWorkIds: [...new Set(resumedWorkIds)], quarantinedSessionIds: [...quarantinedSessionIds],
    quarantinedOperationIds, quarantinedInputIds, quarantinedEventIds, quarantinedDeliveryIds, admittedAt: entry.at } };
}

export function retainHistoricalWork(previous, entry) {
  const work = previous.works[entry.workId];
  if (!historyWorkHeld(work) || recoveryHash(work) !== entry.workHash || entry.expectedRevision !== previous.revision
    || entry.sourceFingerprint !== previous.lastRecovery?.sourceFingerprint) throw new Error('coordination_resume_plan_changed');
  return { ...previous, works: { ...previous.works, [entry.workId]: { ...work, state: 'cancelled', end: 'cancelled', stopScope: 'work',
    revision: (work.revision || 0) + 1, historyRecovery: { ...work.historyRecovery, disposition: 'retained', at: entry.at } } },
    lastRecovery: { ...previous.lastRecovery, heldWorkIds: previous.lastRecovery.heldWorkIds.filter(id => id !== entry.workId),
      retainedSessionIds: [...new Set([...(previous.lastRecovery.retainedSessionIds || []), ...(work.sessionIds || [])])] } };
}

export function retainHistoricalSession(previous, entry) {
  if (entry.expectedRevision !== previous.revision || entry.sourceFingerprint !== previous.lastRecovery?.sourceFingerprint
    || !previous.lastRecovery?.quarantinedSessionIds?.includes(entry.sessionId)) throw new Error('coordination_resume_plan_changed');
  return { ...previous, lastRecovery: { ...previous.lastRecovery,
    retainedSessionIds: [...new Set([...(previous.lastRecovery.retainedSessionIds || []), entry.sessionId])] } };
}
