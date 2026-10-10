import { createReplyDelivery } from './reply-delivery.mjs';
import { coordinationWorkId } from './work-coordination.mjs';
import { continuationDecision } from './continuation-policy.mjs';
import { workBudgetBinding, workBudgetCanResume } from './work-budget.mjs';
import { hasUnsettledDispatch, manualRecovery, recoveryCheckpointAvailable, recoveryForFailure, recoveryReservationDue } from './recovery-policy.mjs';

const ROUTINE = new Set(['session_started', 'progress', 'session_spawned', 'session_progress']);
export function createRunnerCoordination({ store, inbox, workspaceId, conversationId, readMessages, remember, onReplied, resolveRoster, now = () => new Date().toISOString() }) {
  const rows = () => { const roster = resolveRoster?.(); return Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []; };
  const delivery = createReplyDelivery({ store, readMessages, appendMessage: remember, accept: onReplied,
    validate: message => (message.meta?.sessionStates || []).every(source => {
      const current = rows().find(row => row.sessionId === source.sessionId);
      return current && source.sourceRevision && current.sourceRevision === source.sourceRevision
        && (current.status === source.status || source.status === 'result_ready' && current.status === 'accepted');
    }),
    onRecovered: message => {
      const work = store.read().works[message.meta?.workId];
      if (!work || !['runnable', 'retry_wait'].includes(work.state) || work.attemptId && work.attemptId !== message.turnId) return;
      const related = rows().filter(row => work.sessionIds?.includes(row.sessionId));
      const waiting = related.some(row => ['queued', 'starting', 'running', 'verifying'].includes(row.status));
      store.saveWork({ ...work, state: related.some(row => row.status === 'waiting_user') ? 'waiting_user' : waiting ? 'waiting_children' : 'delivered' });
      store.handled(work.pendingEventIds || []);
    },
    onInvalidated: message => {
      const work = store.read().works[message.meta?.workId];
      if (!work || ['paused', 'cancelled'].includes(work.state)) return;
      const current = rows().filter(row => message.meta?.sessionStates?.some(source => source.sessionId === row.sessionId));
      store.transfer(current.map(row => ({ eventId: `reply-refresh:${message.id}:${row.sourceRevision}:${row.status}`,
        kind: 'report_available', sessionId: row.sessionId, at: new Date().toISOString(), payload: { sourceRevision: row.sourceRevision, status: row.status } })));
      store.saveWork({ ...work, state: 'waiting_children' });
      if (readMessages().some(row => row.id === message.id)) remember({ id: `${message.id}:updated`, kind: 'agent_reply', role: 'assistant',
        content: '结果有更新，我再核对一下。', meta: { workId: work.workId } });
    },
  });
  function transfer() {
    store.recover();
    const batch = inbox.takeBatch(workspaceId);
    if (batch.events?.length) {
      store.transfer(batch.events);
      inbox.commitBatch(workspaceId, { throughSeq: batch.throughSeq, ok: true });
    }
    const pending = store.pendingEvents();
    const routine = pending.filter(event => ROUTINE.has(event.kind));
    if (routine.length) store.handled(routine.map(event => event.eventId));
    return pending.filter(event => !ROUTINE.has(event.kind));
  }
  function expireReservations() {
    for (const work of Object.values(store.read().works)) if (work.state === 'retry_wait' && work.recovery?.reservationId
      && (Date.parse(work.recovery.deadlineAt) <= Date.parse(now()) || hasUnsettledDispatch(work))) {
      const unknown = hasUnsettledDispatch(work);
      store.saveWork({ ...work, state: 'blocked_system', ...(unknown ? { end: 'fatal' } : {}),
        recovery: { ...work.recovery, ...(unknown ? { failureKind: 'execution_outcome_unknown', retryable: false } : {}), retryAt: undefined, reservationId: undefined },
        waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') });
    }
  }
  function readProtectedWork(work) {
    try { return work?.checkpointRef ? store.readCheckpoint(work.checkpointRef) : null; }
    catch { return null; }
  }
  function blockMissingCheckpoint(work) {
    store.saveWork({ ...work, state: 'blocked_system', end: 'fatal',
      recovery: { ...work.recovery, failureKind: 'fatal', retryable: false, autoAttempts: work.recovery?.autoAttempts || 0,
        failedTurnId: work.recovery?.failedTurnId || work.attemptId, retryAt: undefined, reservationId: undefined,
        blockedCode: 'RECOVERY_CHECKPOINT_UNAVAILABLE' },
      waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') });
  }
  return {
    admitLegacyTurn(turn, recovery) {
      const inputIds = (turn.userInputs || []).map(input => input.inputId);
      const events = recovery.events || [];
      const workId = coordinationWorkId(conversationId, inputIds.length ? inputIds : events.map(event => event.eventId));
      if (store.read().works[workId]) return;
      const missing = events.filter(event => !store.read().events[event.eventId]);
      if (missing.length) store.transfer(missing);
      const job = { kind: turn.turnKind === 'wake' ? 'wake' : 'user', workId, turnId: turn.id, userInputs: turn.userInputs || [],
        events, throughSeq: recovery.throughSeq, carried: [], continuation: true };
      const checkpointRef = store.checkpoint(workId, { job, outcome: { turnId: turn.id, rounds: turn.rounds || [] } });
      store.saveWork({ schemaVersion: 1, workspaceId, parentConversationId: conversationId, workId, state: 'paused',
        attemptId: turn.id, anchorInputIds: inputIds, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [],
        pendingEventIds: events.map(event => event.eventId), checkpointRef, stopScope: 'reply' });
    },
    admitRecoveredEvents(events) {
      const known = store.read().events;
      const missing = (events || []).filter(event => !known[event.eventId]);
      if (missing.length) store.transfer(missing);
    },
    transfer, deliver: delivery.deliver, prepareReplies: delivery.prepare, recover: delivery.recover, hasPendingDelivery: delivery.pending,
    pending() {
      const works = Object.values(store.read().works);
      // An owned batch continues through its durable job, never through a new
      // wake merely because failure has left its delivery unacknowledged.
      const owned = new Set(works.flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]));
      return store.pendingEvents().filter(event => !ROUTINE.has(event.kind) && !owned.has(event.eventId)
        && !works.some(work => work.sessionIds?.includes(event.sessionId) && work.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)));
    },
    ownsInput(inputId) { return Object.values(store.read().works).some(work => work.anchorInputIds?.includes(inputId)); },
    nextRetryAt() {
      expireReservations();
      const at = now();
      return Object.values(store.read().works).filter(work => work.state === 'retry_wait' && work.recovery?.reservationId
        && work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === work.recovery.reservationId)
        && Date.parse(work.recovery.deadlineAt) > Date.parse(at) && !hasUnsettledDispatch(work))
        .map(work => work.recovery.retryAt).filter(at => Number.isFinite(Date.parse(at))).sort()[0] || null;
    },
    recoverJob() {
      expireReservations();
      const work = Object.values(store.read().works).sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt))).find(row => row.state === 'runnable' && row.checkpointRef)
        || Object.values(store.read().works).find(row => row.checkpointRef && recoveryReservationDue(row, now()));
      if (!work) return null;
      const checkpoint = readProtectedWork(work);
      if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) { blockMissingCheckpoint(work); return null; }
      return { ...checkpoint.job, workId: work.workId, continuation: true,
        ...(work.state === 'retry_wait' ? { recoveryReservationId: work.recovery.reservationId, recoveryRevision: work.revision } : {}) };
    },
    retryJob(turnId) {
      const work = Object.values(store.read().works).find(work => work.parentConversationId === conversationId && work.checkpointRef
        && (work.recovery?.failedTurnId === turnId || work.attemptId === turnId));
      if (!work || ['delivered', 'cancelled', 'waiting_user'].includes(work.state)) return { ok: false, code: 'STALE_TURN' };
      const checkpoint = readProtectedWork(work);
      if (work.state === 'waiting_children' && !(work.stopScope === 'reply' && checkpoint?.outcome?.stopped === true)) return { ok: false, code: 'STALE_TURN' };
      if (hasUnsettledDispatch(work) || work.recovery?.failureKind === 'execution_outcome_unknown') return { ok: false, code: 'EXECUTION_OUTCOME_UNKNOWN' };
      if (work.state === 'budget_limited' && !workBudgetCanResume(work, workBudgetBinding(workspaceId)?.limits)) return { ok: false, code: 'WORK_BUDGET_EXHAUSTED' };
      if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) { blockMissingCheckpoint(work); return { ok: false, code: 'RECOVERY_CHECKPOINT_UNAVAILABLE' }; }
      if (checkpoint.job?.workId !== work.workId) return { ok: false, code: 'STALE_TURN' };
      return { ok: true, job: { ...checkpoint.job, workId: work.workId, continuation: true, interactive: true,
        recoveryRevision: work.revision, manualRecovery: true } };
    },
    recoveryFor(job, outcome) { return recoveryForFailure(store.read().works[job.workId], outcome, now()); },
    previousOutcome(job) { return readProtectedWork(store.read().works[job.workId])?.outcome; },
    blockReservation(job) {
      const work = store.read().works[job.workId];
      if (!work || work.state !== 'retry_wait') return;
      store.saveWork({ ...work, state: 'blocked_system', recovery: work.recovery ? { ...work.recovery, retryAt: undefined, reservationId: undefined } : undefined,
        waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') });
    },
    prepare(job) {
      if (!job.workId || !job.continuation) return true;
      const existing = store.read().works[job.workId];
      if (!existing || existing.parentConversationId !== conversationId) return false;
      if (job.recoveryRevision !== undefined && existing.revision !== job.recoveryRevision) return false;
      if (job.recoveryReservationId && (existing.recovery?.reservationId !== job.recoveryReservationId || !recoveryReservationDue(existing, now()))) return false;
      if (!job.manualRecovery && ['paused', 'cancelled', 'budget_limited', 'blocked_system'].includes(existing.state)) return false;
      return true;
    },
    start(job) {
      const inputs = (job.userInputs || []).map(input => input.inputId);
      const events = job.events || [];
      const missing = events.filter(event => !store.read().events[event.eventId]);
      if (missing.length) store.transfer(missing);
      const linked = Object.values(store.read().works).find(work => events.some(event => work.sessionIds?.includes(event.sessionId)));
      job.workId ||= (!inputs.length && linked?.workId) || coordinationWorkId(conversationId, inputs.length ? inputs : events.map(event => event.eventId));
      const existing = store.read().works[job.workId];
      const checkpointRef = existing?.checkpointRef || store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome: { rounds: [] } });
      const recovery = job.manualRecovery ? manualRecovery(existing?.recovery, now())
        : existing?.recovery ? { ...existing.recovery, retryAt: undefined, reservationId: undefined,
          autoAttempts: existing.recovery.autoAttempts + (job.recoveryReservationId ? 1 : 0) } : undefined;
      store.saveWork({ checkpointRef, schemaVersion: 1, workspaceId, parentConversationId: conversationId,
        anchorInputIds: inputs, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [], stopScope: 'reply',
        ...existing, workId: job.workId, attemptId: job.attemptId, pendingEventIds: events.map(event => event.eventId), state: 'runnable', recovery,
        waitFor: (existing?.waitFor || []).filter(wait => wait.kind !== 'retry_timer') });
    },
    finish(job, outcome, roster) {
      const previous = store.read().works[job.workId];
      const decision = continuationDecision({ previous, rounds: outcome.rounds, roster, yielded: outcome.yielded });
      const sources = (Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []).filter(row =>
        previous.sessionIds.includes(row.sessionId) || (job.events || []).some(event => event.sessionId === row.sessionId)
        || row.origin?.anchorMessageId && previous.anchorInputIds.some(id => `input-${id}` === row.origin.anchorMessageId));
      const sessionIds = [...new Set([...previous.sessionIds, ...sources.map(row => row.sessionId)])];
      const waiting = sources.filter(row => ['queued', 'starting', 'running', 'verifying'].includes(row.status));
      let state = decision.state;
      if (!outcome.yielded && waiting.length) state = 'waiting_children';
      const recovery = outcome.failed ? outcome.recovery || recoveryForFailure(previous, outcome, now()) : undefined;
      if (outcome.failed) state = recovery?.reservationId ? 'retry_wait' : 'blocked_system';
      if (outcome.stopped) state = waiting.length ? 'waiting_children' : 'paused';
      // A child question does not finish the parent reply that still needs to
      // bring that question into the main conversation. Keep a yielded parent
      // runnable until its public reply is committed.
      if (!outcome.failed && !outcome.yielded && sources.some(row => row.status === 'waiting_user')) state = 'waiting_user';
      if (outcome.budgetLimited) state = 'budget_limited';
      if (outcome.deliveryPending) state = 'retry_wait';
      const end = state === 'waiting_children' ? 'awaiting_children' : state === 'waiting_user' ? 'awaiting_user'
        : state === 'budget_limited' ? 'budget_limited' : outcome.reason === 'agent_no_progress' ? 'no_progress'
        : outcome.stopped ? 'user_stopped' : outcome.failed ? recovery?.retryable ? 'provider_retryable' : 'fatal'
        : state === 'retry_wait' ? 'provider_retryable' : decision.end;
      const { recoveryRevision, recoveryReservationId, manualRecovery: _manual, ...durableJob } = job;
      const checkpointRef = outcome.preserveCheckpoint ? previous.checkpointRef
        : store.checkpoint(job.workId, { job: { ...durableJob, continuation: true }, outcome });
      store.saveWork({ ...previous, ...decision, state, end, sessionIds, checkpointRef, recovery,
        waitFor: [...waiting.map(row => ({ kind: 'session', id: row.sessionId })),
          ...(state === 'retry_wait' && recovery?.reservationId ? [{ kind: 'retry_timer', id: recovery.reservationId }] : [])],
        consumedEventIds: [...new Set([...previous.consumedEventIds, ...(job.events || []).map(row => row.eventId)])].slice(-64) });
      if (!outcome.failed && !outcome.deliveryPending) store.handled((job.events || []).map(row => row.eventId));
      return { ...decision, state };
    },
    resume(job) {
      const work = store.read().works[job.workId];
      if (hasUnsettledDispatch(work)) throw new Error('execution_outcome_unknown');
      const checkpoint = readProtectedWork(work);
      if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) throw new Error('continuity_checkpoint_missing');
      const outcome = checkpoint?.outcome;
      return outcome && work.nativeCheckpointRef ? { ...outcome, providerCheckpoint: store.readCheckpoint(work.nativeCheckpointRef) } : outcome;
    },
  };
}
