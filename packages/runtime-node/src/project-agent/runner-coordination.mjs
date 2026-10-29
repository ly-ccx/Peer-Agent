import { createVerificationDispatchRecovery } from './verification-dispatch-recovery.mjs';
import { createReplyDelivery } from './reply-delivery.mjs';
import { coordinationWorkId } from './work-coordination.mjs';
import { repairOwnership, stateAfterReply, ownedSessions, repairProgressDecision } from './repair-ownership.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { hasUnsettledDispatch, manualRecovery, recoveryCheckpointAvailable, recoveryForFailure, recoveryReservationDue, replyCheckpointForModel } from './recovery-policy.mjs';
import { hostWakeWait } from './wake-wait.mjs';
import { replyRecoveryAdmission, recoverLegacyBudgetWorks } from './reply-recovery-admission.mjs';
import { reconcileContinuationCustody } from './continuation-custody.mjs';
import { reportedWaitFor, reportedWaitCurrent } from './reported-wait.mjs';
import { historyExecutionHeld } from './history-resumption.mjs';
import { reconcileRepairCustody } from './repair-custody.mjs';

const ROUTINE = new Set(['session_started', 'progress', 'session_spawned', 'session_progress']);
export function createRunnerCoordination({ store, inbox, workspaceId, conversationId, readMessages, remember, onReplied, resolveRoster, reconcileVerification = null, now = () => new Date().toISOString() }) {
  const dispatchRecovery = createVerificationDispatchRecovery({ store, readMessages, reconcileVerification, now,
    activeAttempts: () => workBudgetBinding(workspaceId)?.activeAttempts });
  const readSnapshot = () => typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const readWork = id => typeof store.readWork === 'function' ? store.readWork(id) : readSnapshot().works[id];
  const rows = () => { const roster = resolveRoster?.(); return Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []; };
  const eventObserved = event => {
    const message = event?.kind === 'agent_message' && event.payload?.agentMessage;
    if (!message?.operationId) return true;
    return store.readSupervision?.('agentCommands', message.operationId)?.delivery === 'observed';
  };
  const delivery = createReplyDelivery({ store, readMessages, appendMessage: remember, accept: onReplied,
    validate: message => (message.meta?.sessionStates || []).every(source => {
      const current = rows().find(row => row.sessionId === source.sessionId);
      return current && source.sourceRevision && current.sourceRevision === source.sourceRevision
        && current.observationRevision === source.observationRevision
        && (current.status === source.status || source.status === 'result_ready' && current.status === 'accepted');
    }),
    onRecovered: message => {
      const work = readWork(message.meta?.workId);
      if (!work || !['runnable', 'retry_wait'].includes(work.state) || work.attemptId && work.attemptId !== message.turnId) return;
      const related = rows().filter(row => work.sessionIds?.includes(row.sessionId));
      const events = (work.pendingEventIds || []).map(id => readSnapshot().events[id]?.event).filter(Boolean);
      const unseen = events.filter(event => !eventObserved(event));
      store.saveWork({ ...work, state: unseen.length ? 'runnable' : stateAfterReply(related), repairSessionIds: repairOwnership(related).repairSessionIds }, { returnState: false });
      store.handled(events.filter(eventObserved).map(event => event.eventId));
    },
    onInvalidated: message => {
      const work = readWork(message.meta?.workId);
      if (!work || ['paused', 'cancelled'].includes(work.state)) return;
      const current = rows().filter(row => message.meta?.sessionStates?.some(source => source.sessionId === row.sessionId));
      store.transfer(current.map(row => ({ eventId: `reply-refresh:${message.id}:${row.sourceRevision}:${row.observationRevision || ''}:${row.status}`,
        kind: 'report_available', sessionId: row.sessionId, at: new Date().toISOString(), payload: { sourceRevision: row.sourceRevision, observationRevision: row.observationRevision, status: row.status } })));
      store.saveWork({ ...work, state: 'waiting_children' }, { returnState: false });
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
    // Child execution acknowledgements do not restart a failed parent reply or
    // erase its protected checkpoint. A result/exception remains a real wake.
    const works = Object.values(readSnapshot().works);
    let snapshot;
    const roster = () => snapshot ??= rows();
    const routine = pending.filter(event => ROUTINE.has(event.kind) || works.some(work => !historyExecutionHeld(work) && work.recovery
      && !hasUnsettledDispatch(work) && hostWakeWait({ kind: 'wake', events: [event] }, { ...work, recovery: undefined }, roster())));
    if (routine.length) store.handled(routine.map(event => event.eventId));
    return pending.filter(event => !routine.includes(event));
  }
  function expireReservations() {
    for (const work of Object.values(readSnapshot().works)) if (work.state === 'retry_wait' && work.recovery?.reservationId
      && (Date.parse(work.recovery.deadlineAt) <= Date.parse(now()) || hasUnsettledDispatch(work))) {
      const unknown = hasUnsettledDispatch(work);
      store.saveWork({ ...work, state: 'blocked_system', ...(unknown ? { end: 'fatal' } : {}),
        recovery: { ...work.recovery, ...(unknown ? { failureKind: 'execution_outcome_unknown', retryable: false } : {}), retryAt: undefined, reservationId: undefined },
        waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') }, { returnState: false });
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
      waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') }, { returnState: false });
  }
  function pendingFrom(snapshot) {
    const works = Object.values(snapshot.works);
    // An owned batch continues through its durable job, never a duplicate wake.
    const owned = new Set(works.flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]));
    const history = snapshot.lastRecovery;
    return store.pendingEvents().filter(event => !ROUTINE.has(event.kind) && !owned.has(event.eventId)
      && !history?.quarantinedSessionIds?.includes(event.sessionId) && !history?.quarantinedEventIds?.includes(event.eventId)
      && !works.some(work => historyExecutionHeld(work) && work.sessionIds?.includes(event.sessionId))
      && !works.some(work => work.sessionIds?.includes(event.sessionId) && work.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)));
  }
  // A synchronous selection shares preparation only until control returns to its
  // caller. All writes invalidate the decision; no snapshot crosses an await.
  function recoverySelection() {
    const inventory = readSnapshot();
    // These repair passes only transform existing work. An empty authoritative
    // inventory needs no repair; events and prepared deliveries keep their own
    // admission paths. This snapshot never survives a later selection call.
    if (!Object.keys(inventory.works).length) return {
      choose: () => null,
      pending: () => pendingFrom(inventory),
      deliveryPending: () => delivery.pending(inventory),
    };
    dispatchRecovery.reconcileAll();
    expireReservations();
    let snapshot, decisionSnapshot;
    const roster = () => snapshot ??= rows();
    const decision = () => decisionSnapshot ??= readSnapshot();
    const update = work => { store.saveWork(work, { returnState: false }); decisionSnapshot = undefined; };
    recoverLegacyBudgetWorks({ store, workspaceId, conversationId, rows: roster, now });
    if (store.coalesceWorks) reconcileContinuationCustody({ store, conversationId, sessions: roster });
    for (const work of Object.values(decision().works)) {
      if (historyExecutionHeld(work)) continue;
      if (!work.reportedWait || !['waiting_children', 'waiting_user'].includes(work.state)) continue;
      if (!reportedWaitCurrent(work.reportedWait, roster())) update({ ...work, reportedWait: undefined, state: 'runnable', end: 'yielded' });
    }
    reconcileRepairCustody({store,conversationId,sessions:roster()});
    decisionSnapshot = undefined;
    return {
      choose(userOnly) {
        const candidates = Object.values(decision().works).filter(work => !historyExecutionHeld(work) && (!userOnly || work.anchorInputIds?.length)
          && (work.state === 'runnable' && work.checkpointRef
            || work.checkpointRef && recoveryReservationDue(work, now())
            || work.state === 'blocked_system' && work.stopScope !== 'work' && work.recovery?.dispatchesReconciled
              && !work.recovery.blockedCode && !hasUnsettledDispatch(work)));
        const inputPriority = new Map(candidates.filter(work => work.anchorInputIds?.length).map(work => {
          let inputs;
          try { inputs = (store.readContinuationCheckpoint?.(work.checkpointRef) ?? readProtectedWork(work))?.job?.userInputs || []; }
          catch { inputs = []; }
          return [work.workId, Math.max(0, ...inputs.map(input => Date.parse(input.createdAt) || 0)) || Date.parse(work.updatedAt) || 0];
        }));
        const work = candidates.sort((a, b) => Number(Boolean(b.anchorInputIds?.length)) - Number(Boolean(a.anchorInputIds?.length))
          || (a.anchorInputIds?.length && b.anchorInputIds?.length ? inputPriority.get(b.workId) - inputPriority.get(a.workId) : 0)
          || String(a.updatedAt).localeCompare(String(b.updatedAt))).find(row => row.state === 'runnable' && row.checkpointRef)
          || candidates.find(row => row.checkpointRef && recoveryReservationDue(row, now()))
          || candidates.find(row => row.state === 'blocked_system' && row.stopScope !== 'work' && row.recovery?.dispatchesReconciled && !row.recovery.blockedCode && !hasUnsettledDispatch(row));
        if (!work) return null;
        const checkpoint = readProtectedWork(work);
        if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) {
          blockMissingCheckpoint(work); decisionSnapshot = undefined; return null;
        }
        if (work.state === 'blocked_system') update({ ...work, state: 'runnable' });
        return { ...checkpoint.job, workId: work.workId, continuation: true,
          ...(work.state === 'retry_wait' ? { recoveryReservationId: work.recovery.reservationId, recoveryRevision: work.revision } : {}) };
      },
      pending: () => pendingFrom(decision()),
      deliveryPending: () => delivery.pending(decision()),
    };
  }
  return {
    admitLegacyTurn(turn, recovery) {
      const inputIds = (turn.userInputs || []).map(input => input.inputId);
      const events = recovery.events || [];
      const workId = coordinationWorkId(conversationId, inputIds.length ? inputIds : events.map(event => event.eventId));
      if (readWork(workId)) return;
      const missing = events.filter(event => !readSnapshot().events[event.eventId]);
      if (missing.length) store.transfer(missing);
      const job = { kind: turn.turnKind === 'wake' ? 'wake' : 'user', workId, turnId: turn.id, userInputs: turn.userInputs || [],
        events, throughSeq: recovery.throughSeq, carried: [], continuation: true };
      const checkpointRef = store.checkpoint(workId, { job, outcome: { turnId: turn.id, rounds: turn.rounds || [] } });
      store.saveWork({ schemaVersion: 1, workspaceId, parentConversationId: conversationId, workId, state: 'paused',
        attemptId: turn.id, anchorInputIds: inputIds, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [],
        pendingEventIds: events.map(event => event.eventId), checkpointRef, stopScope: 'reply' }, { returnState: false });
    },
    admitRecoveredEvents(events) {
      const known = readSnapshot().events;
      const missing = (events || []).filter(event => !known[event.eventId]);
      if (missing.length) store.transfer(missing);
    },
    transfer, deliver: delivery.deliver, prepareReplies: delivery.prepare, async recover() { dispatchRecovery.reconcileAll(); return delivery.recover(); }, hasPendingDelivery: delivery.pending,
    pending() {
      if (store.coalesceWorks) reconcileContinuationCustody({ store, conversationId, sessions: rows });
      return pendingFrom(readSnapshot());
    },
    ownedInputIds() { const state = readSnapshot(); return [...new Set([...Object.values(state.works).flatMap(work => work.anchorInputIds || []), ...(state.lastRecovery?.quarantinedInputIds || [])])]; },
    ownsInput(inputId) { return this.ownedInputIds().includes(inputId); },
    canPreemptRequest(workId) {
      const work = readWork(workId);
      return Boolean(work && !hasUnsettledDispatch(work)
        && Object.values(work.budget?.attempts || {}).every(attempt => !attempt.pendingTools?.length));
    },
    nextRetryAt() {
      expireReservations();
      const at = now();
      return Object.values(readSnapshot().works).filter(work => work.state === 'retry_wait' && work.recovery?.reservationId
        && work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === work.recovery.reservationId)
        && Date.parse(work.recovery.deadlineAt) > Date.parse(at) && !hasUnsettledDispatch(work))
        .map(work => work.recovery.retryAt).filter(at => Number.isFinite(Date.parse(at))).sort()[0] || null;
    },
    recoverUserJob() { return this.recoverJob({ userOnly: true }); },
    recoverJob({ userOnly = false } = {}) { return recoverySelection().choose(userOnly); },
    hasContinuation() {
      const selection = recoverySelection();
      return Boolean(selection.choose(false) || selection.deliveryPending());
    },
    selectNext() {
      const selection = recoverySelection();
      const user = selection.choose(true);
      if (user) return { job: user };
      const events = selection.pending();
      return events.length ? { events } : { job: selection.choose(false) };
    },
    retryJob(turnId) {
      dispatchRecovery.reconcileAll();
      const work = Object.values(readSnapshot().works).find(work => work.parentConversationId === conversationId && work.checkpointRef
        && (work.recovery?.failedTurnId === turnId || work.attemptId === turnId));
      const checkpoint = readProtectedWork(work);
      const admission = replyRecoveryAdmission(work, checkpoint, { limits: workBudgetBinding(workspaceId)?.limits, readCheckpoint: store.readCheckpoint });
      if (!admission.ok) {
        if (work && admission.code === 'RECOVERY_CHECKPOINT_UNAVAILABLE') blockMissingCheckpoint(work);
        return { ok: false, code: admission.code };
      }
      return { ok: true, job: { ...checkpoint.job, workId: work.workId, continuation: true, interactive: true,
        recoveryRevision: work.revision, manualRecovery: true } };
    },
    recoveryFor(job, outcome) { return recoveryForFailure(readWork(job.workId), outcome, now()); },
    silentWaitFor(job, roster) {
      const work = readWork(job.workId);
      return hasUnsettledDispatch(work) ? null : hostWakeWait(job, work, Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []);
    },
    previousOutcome(job) { return readProtectedWork(readWork(job.workId))?.outcome; },
    blockReservation(job) {
      const work = readWork(job.workId);
      if (!work || work.state !== 'retry_wait') return;
      store.saveWork({ ...work, state: 'blocked_system', recovery: work.recovery ? { ...work.recovery, retryAt: undefined, reservationId: undefined } : undefined,
        waitFor: (work.waitFor || []).filter(wait => wait.kind !== 'retry_timer') }, { returnState: false });
    },
    prepare(job) {
      if (!job.workId || !job.continuation) return true;
      const existing = readWork(job.workId);
      if (!existing || existing.parentConversationId !== conversationId) return false;
      if (historyExecutionHeld(existing)) return false;
      if (job.recoveryRevision !== undefined && existing.revision !== job.recoveryRevision) return false;
      if (job.recoveryReservationId && (existing.recovery?.reservationId !== job.recoveryReservationId || !recoveryReservationDue(existing, now()))) return false;
      if (existing.state === 'coalesced' || !job.manualRecovery && ['paused', 'cancelled', 'budget_limited', 'blocked_system'].includes(existing.state)) return false;
      return true;
    },
    start(job) {
      const inputs = (job.userInputs || []).map(input => input.inputId);
      const events = job.events || [];
      const missing = events.filter(event => !readSnapshot().events[event.eventId]);
      if (missing.length) store.transfer(missing);
      // A fresh batch must not replace an unfinished slice's protected checkpoint.
      const linked = Object.values(readSnapshot().works).find(work => !['runnable', 'retry_wait', 'coalesced', 'paused', 'cancelled'].includes(work.state)
        && events.some(event => work.sessionIds?.includes(event.sessionId)));
      job.workId ||= (!inputs.length && linked?.workId) || coordinationWorkId(conversationId, inputs.length ? inputs : events.map(event => event.eventId));
      dispatchRecovery.reconcile(job.workId);
      const existing = readWork(job.workId);
      if (existing?.recovery?.dispatchesReconciled) job.continuation = true;
      const checkpointRef = existing?.checkpointRef || store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome: { rounds: [] } });
      const recovery = job.manualRecovery ? manualRecovery(existing?.recovery, now())
        : existing?.recovery ? { ...existing.recovery, retryAt: undefined, reservationId: undefined,
          autoAttempts: existing.recovery.autoAttempts + (job.recoveryReservationId ? 1 : 0) } : undefined;
      store.saveWork({ checkpointRef, schemaVersion: 1, workspaceId, parentConversationId: conversationId,
        anchorInputIds: inputs, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [], stopScope: 'reply',
        ...existing, workId: job.workId, attemptId: job.attemptId, pendingEventIds: events.map(event => event.eventId), state: 'runnable', recovery,
        waitFor: (existing?.waitFor || []).filter(wait => wait.kind !== 'retry_timer') }, { returnState: false });
    },
    stalls(job, outcome, roster) {
      if (reportedWaitFor({ job, outcome, state: readSnapshot(), messages: readMessages(), sessions: Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [] })) return false;
      const previous = readWork(job.workId);
      const sources = ownedSessions(previous, job, roster);
      return repairOwnership(sources).repairSessionIds.length > 0
        && repairProgressDecision(previous, outcome, roster, sources).end === 'no_progress';
    },
    finish(job, outcome, roster) {
      const previous = readWork(job.workId);
      const sources = ownedSessions(previous, job, roster);
      const sessionIds = [...new Set([...previous.sessionIds, ...sources.map(row => row.sessionId)])];
      const ownership = repairOwnership(sources);
      const decision = repairProgressDecision(previous, outcome, roster, sources);
      const waiting = ownership.waiting;
      let state = decision.state;
      if (!outcome.yielded && waiting.length && decision.state !== 'blocked_system') state = 'waiting_children';
      const recovery = outcome.failed ? outcome.recovery || recoveryForFailure(previous, outcome, now()) : undefined;
      if (outcome.failed) state = recovery?.reservationId ? 'retry_wait' : 'blocked_system';
      if (outcome.stopped) state = waiting.length ? 'waiting_children' : 'paused';
      // A child question does not finish the parent reply that still needs to
      // bring that question into the main conversation. Keep a yielded parent
      // runnable until its public reply is committed.
      if (!outcome.failed && !outcome.yielded && !outcome.stopped && decision.state !== 'blocked_system') state = stateAfterReply(sources);
      if (outcome.budgetLimited) state = 'budget_limited';
      if (outcome.deliveryPending) state = 'retry_wait';
      const reportedWait = reportedWaitFor({ job, outcome, state: readSnapshot(), messages: readMessages(), sessions: Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [] });
      if (reportedWait) state = reportedWait.waitingUser ? 'waiting_user' : 'waiting_children';
      const observedEvents = (job.events || []).filter(eventObserved);
      const unseenEvents = (job.events || []).filter(event => !eventObserved(event));
      if (unseenEvents.length && !outcome.failed && !outcome.stopped && !outcome.budgetLimited && !outcome.deliveryPending
        && !['blocked_system', 'waiting_user'].includes(state)) state = 'runnable';
      const end = state === 'runnable' ? 'yielded' : state === 'waiting_children' ? 'awaiting_children' : state === 'waiting_user' ? 'awaiting_user'
        : state === 'budget_limited' ? 'budget_limited' : outcome.reason === 'agent_no_progress' ? 'no_progress'
        : outcome.stopped ? 'user_stopped' : outcome.failed ? recovery?.retryable ? 'provider_retryable' : 'fatal'
        : state === 'retry_wait' ? 'provider_retryable' : decision.end;
      const { recoveryRevision, recoveryReservationId, manualRecovery: _manual, ...durableJob } = job;
      const checkpointRef = outcome.preserveCheckpoint ? previous.checkpointRef
        : store.checkpoint(job.workId, { job: { ...durableJob, continuation: true }, outcome });
      store.saveWork({ ...previous, ...decision, state, end, sessionIds, checkpointRef, recovery, reportedWait, repairSessionIds: ownership.repairSessionIds,
        waitFor: [...(reportedWait ? reportedWait.sessionStates : waiting).map(row => ({ kind: 'session', id: row.sessionId })),
          ...(state === 'retry_wait' && recovery?.reservationId ? [{ kind: 'retry_timer', id: recovery.reservationId }] : [])],
        consumedEventIds: [...new Set([...previous.consumedEventIds, ...observedEvents.map(row => row.eventId)])].slice(-64) }, { returnState: false });
      if (!outcome.failed && !outcome.yielded && !outcome.deliveryPending) store.handled(observedEvents.map(row => row.eventId));
      return { ...decision, state };
    },
    dispatchRecoveryFacts: dispatchRecovery.facts,
    resume(job, selection) {
      const work = readWork(job.workId);
      if (hasUnsettledDispatch(work)) throw new Error('execution_outcome_unknown');
      const checkpoint = readProtectedWork(work);
      if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) throw new Error('continuity_checkpoint_missing');
      const outcome = checkpoint?.outcome;
      // A finished public update starts the next reasoning step with current
      // roster facts. Only an actual yield resumes a native Provider slice.
      const resumed = outcome && work.nativeCheckpointRef && (!work.repairSessionIds?.length || outcome.yielded)
        ? { ...outcome, providerCheckpoint: store.readCheckpoint(work.nativeCheckpointRef) } : outcome;
      return replyCheckpointForModel(resumed, selection);
    },
  };
}
