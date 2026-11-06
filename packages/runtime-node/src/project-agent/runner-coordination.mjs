import { createVerificationDispatchRecovery } from './verification-dispatch-recovery.mjs';
import { createDelegationDispatchRecovery } from './delegation-dispatch-recovery.mjs';
import { createRunnerReplyLifecycle } from './runner-reply-lifecycle.mjs';
import { delegationFollowUp, legacyDelegationFollowUp, reconcileDelegationFollowUp } from './delegation-follow-up.mjs';
import { coordinationWorkId } from './work-coordination.mjs';
import { repairOwnership, ownedSessions, repairProgressDecision } from './repair-ownership.mjs';
import { workBudgetBinding } from './work-budget.mjs';
import { hasUnsettledDispatch, manualRecovery, recoveryCheckpointAvailable, recoveryForFailure, recoveryReservationDue, replyCheckpointForModel } from './recovery-policy.mjs';
import { hostWakeWait } from './wake-wait.mjs';
import { replyRecoveryAdmission, recoverLegacyBudgetWorks } from './reply-recovery-admission.mjs';
import { reconcileContinuationCustody } from './continuation-custody.mjs';
import { reportedWaitFor, reportedWaitCurrent } from './reported-wait.mjs';
import { historyExecutionHeld } from './history-resumption.mjs';
import { reconcileRepairCustody } from './repair-custody.mjs';
import { createDecisionFrame } from './decision-frame.mjs';
import { intentDecisionAdmittedForTurn } from './intent-reply-bindings.mjs';
import { decideRuntimeDisposition, runtimeWorkControlHeld, runtimeWorkHeld } from './runtime-disposition.ts';
import { createEmptyResourceWaitPort, resourceWaitScope, readResourceWaitFacts } from './resource-wait.ts';
import { reconcileResourceWait } from './resource-wait-recovery.mjs';

const ROUTINE = new Set(['session_started', 'progress', 'session_spawned', 'session_progress']);
export function createRunnerCoordination({ store, inbox, workspaceId, conversationId, readMessages, remember, onReplied, onDeferred, onDeliveryChanged, resolveRoster, reconcileVerification = null, findEvidenceRecords = null, readResourceClaims, resourceWaits = null, now = () => new Date().toISOString() }) {
  const resourceWaitPort = resourceWaits || createEmptyResourceWaitPort();
  const delegationRecovery = createDelegationDispatchRecovery({ store, readMessages, findEvidenceRecords, readResourceClaims, now,
    activeAttempts: () => workBudgetBinding(workspaceId)?.activeAttempts });
  const dispatchRecovery = createVerificationDispatchRecovery({ store, readMessages, reconcileVerification, now,
    activeAttempts: () => workBudgetBinding(workspaceId)?.activeAttempts });
  const readSnapshot = () => typeof store.readSnapshot === 'function' ? store.readSnapshot() : store.read();
  const reconcileDispatches = () => {
    const inventory = readSnapshot();
    delegationRecovery.reconcileAll(inventory);
    dispatchRecovery.reconcileAll(inventory);
  };
  const readWork = id => typeof store.readWork === 'function' ? store.readWork(id) : readSnapshot().works[id];
  const rows = () => { const roster = resolveRoster?.(); return Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []; };
  const eventObserved = event => {
    const message = event?.kind === 'agent_message' && event.payload?.agentMessage;
    if (!message?.operationId) return true;
    return store.readSupervision?.('agentCommands', message.operationId)?.delivery === 'observed';
  };
  const delivery = createRunnerReplyLifecycle({ store, workspaceId, conversationId, readMessages, remember, onReplied, onDeferred, onDeliveryChanged, resolveRoster: rows, eventObserved, now });
  function start(job) {
    const inputs = (job.userInputs || []).map(input => input.inputId);
    let events = job.events || [];
    const missing = events.filter(event => !readSnapshot().events[event.eventId]);
    if (missing.length) store.transfer(missing);
    // A fresh batch must not replace an unfinished slice's protected checkpoint.
    const linked = Object.values(readSnapshot().works).find(work => work.parentConversationId === conversationId && !['runnable', 'retry_wait', 'coalesced', 'paused', 'cancelled'].includes(work.state)
      && events.some(event => work.sessionIds?.includes(event.sessionId)));
    job.workId ||= (!inputs.length && linked?.workId) || coordinationWorkId(conversationId, inputs.length ? inputs : events.map(event => event.eventId));
    delegationRecovery.reconcile(job.workId);
    dispatchRecovery.reconcile(job.workId);
    const existing = readWork(job.workId);
    const resumingStoppedReply = job.manualRecovery && existing?.end === 'user_stopped';
    if (resumingStoppedReply) {
      const snapshot = readSnapshot();
      const sessionIds = ownedSessionIds(existing, snapshot, rows());
      const otherEvents = new Set(Object.values(snapshot.works).filter(work => work.workId !== job.workId)
        .flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]));
      const available = store.pendingEvents().filter(event => sessionIds.has(event.sessionId) && !otherEvents.has(event.eventId));
      events = [...new Map([...events, ...available].map(event => [event.eventId, event])).values()];
      job.events = events;
    }
    if (existing?.recovery?.dispatchesReconciled) job.continuation = true;
    const checkpointRef = existing?.checkpointRef || store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome: { rounds: [] } });
    const recovery = job.manualRecovery ? manualRecovery(existing?.recovery, now())
      : existing?.recovery ? { ...existing.recovery, retryAt: undefined, reservationId: undefined,
        autoAttempts: existing.recovery.autoAttempts + (job.recoveryReservationId ? 1 : 0) } : undefined;
    store.saveWork({ checkpointRef, schemaVersion: 1, workspaceId, parentConversationId: conversationId,
      anchorInputIds: inputs, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [], stopScope: 'reply',
      ...existing, ...(resumingStoppedReply ? { end: 'yielded' } : {}), workId: job.workId, attemptId: job.attemptId, pendingEventIds: events.map(event => event.eventId), state: 'runnable', recovery,
      waitFor: (existing?.waitFor || []).filter(wait => wait.kind !== 'retry_timer') }, { returnState: false });
  }

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
    for (const work of Object.values(readSnapshot().works)) if (work.parentConversationId === conversationId && work.state === 'retry_wait' && work.recovery?.reservationId
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
  function adoptLegacyDelegations(state = readSnapshot()) {
    let changed = false;
    const candidates = Object.values(state.works).filter(work => !work.delegationFollowUp && work.state === 'blocked_system'
      && !runtimeWorkHeld(work) && !historyExecutionHeld(work) && work.parentConversationId === conversationId && work.checkpointRef);
    if (!candidates.length) return;
    const messages = readMessages();
    const failures = messages.filter(row => row.card === 'agent_unavailable' && /work_disposition_required$/.test(row.content || ''));
    for (const work of candidates) {
      if (!failures.some(row => row.meta?.workId === work.workId || row.turnId === work.attemptId || row.turnId === work.recovery?.failedTurnId)) continue;
      const pending = legacyDelegationFollowUp(work, readProtectedWork(work), messages);
      if (pending) { store.saveWork({ ...work, delegationFollowUp: pending }, { returnState: false }); changed = true; }
    }
    return changed;
  }
  function ownedSessionIds(work, snapshot, roster) {
    return new Set([...(work.sessionIds || []), ...(snapshot.mandates?.[work.workId]?.sessionIds || []),
      ...ownedSessions(work, { events: [] }, roster).map(row => row.sessionId)]);
  }
  function pendingFrom(snapshot) {
    const works = Object.values(snapshot.works);
    // An owned batch continues through its durable job, never a duplicate wake.
    const owned = new Set(works.flatMap(work => [...(work.pendingEventIds || []), ...(work.consumedEventIds || [])]));
    const pending = store.pendingEvents().filter(event => !ROUTINE.has(event.kind) && !owned.has(event.eventId));
    if (!pending.length) return [];
    const history = snapshot.lastRecovery;
    const foreign = new Set(Object.values(snapshot.mandates || {}).filter(row => row.parentConversationId !== conversationId).flatMap(row => row.sessionIds));
    const roster = rows();
    const heldSessions = new Set(works.filter(runtimeWorkHeld).flatMap(work => [...ownedSessionIds(work, snapshot, roster)]));
    for (const row of roster) if (row.origin?.parentConversationId && row.origin.parentConversationId !== conversationId) foreign.add(row.sessionId);
    return pending.filter(event => !foreign.has(event.sessionId)
      && !history?.quarantinedSessionIds?.includes(event.sessionId) && !history?.quarantinedEventIds?.includes(event.eventId)
      && !works.some(work => historyExecutionHeld(work) && work.sessionIds?.includes(event.sessionId))
      && !heldSessions.has(event.sessionId));
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
    reconcileDispatches();
    expireReservations();
    let snapshot, decisionSnapshot;
    const roster = () => snapshot ??= rows();
    const decision = () => decisionSnapshot ??= readSnapshot();
    const update = work => { store.saveWork(work, { returnState: false }); decisionSnapshot = undefined; };
    recoverLegacyBudgetWorks({ store, workspaceId, conversationId, rows: roster, now });
    if (store.coalesceWorks) reconcileContinuationCustody({ store, conversationId, sessions: roster });
    if (adoptLegacyDelegations(decision())) decisionSnapshot = undefined;
    for (const work of Object.values(decision().works)) {
      if (!work.delegationFollowUp || work.parentConversationId !== conversationId || hasUnsettledDispatch(work)
        || work.state !== 'blocked_system' || runtimeWorkHeld(work) || historyExecutionHeld(work)) continue;
      const pending = reconcileDelegationFollowUp(work.delegationFollowUp, decision(), work.workId);
      if (pending !== work.delegationFollowUp) {
        const sessionIds = [...new Set([...work.sessionIds, ...(decision().mandates?.[work.workId]?.sessionIds || [])])];
        const { handling, ...disposition } = decideRuntimeDisposition({ previous: { ...work, delegationFollowUp: pending },
          sessions: roster().filter(row => sessionIds.includes(row.sessionId)) });
        update({ ...work, delegationFollowUp: pending, sessionIds, ...disposition });
      }
    }
    for (const work of Object.values(decision().works)) {
      if (historyExecutionHeld(work)) continue;
      if (runtimeWorkHeld(work) || work.parentConversationId !== conversationId) continue;
      if (reconcileResourceWait({ work, state: decision(), sessions: roster, port: resourceWaitPort, store, now })) {
        decisionSnapshot = undefined; continue;
      }
      if (!work.reportedWait || !['waiting_children', 'waiting_user'].includes(work.state)) continue;
      if (!reportedWaitCurrent(work.reportedWait, roster())) update({ ...work, reportedWait: undefined, state: 'runnable', end: 'yielded' });
    }
    reconcileRepairCustody({store,conversationId,sessions:roster});
    decisionSnapshot = undefined;
    return {
      choose(userOnly) {
        const candidates = Object.values(decision().works).filter(work => work.parentConversationId === conversationId && !historyExecutionHeld(work) && !runtimeWorkHeld(work) && (!userOnly || work.anchorInputIds?.length)
          && !(work.delegationFollowUp && hasUnsettledDispatch(work))
          && !delivery.pending(decision(), work.workId)
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
        const semanticNext = work.intentCoordination?.lifecycle === 'active' && !checkpoint.outcome?.yielded && !work.recovery;
        const resourceEvents = (work.pendingEventIds || []).filter(id => !work.consumedEventIds?.includes(id) && !decision().events?.[id]?.handled)
          .map(id => decision().events?.[id]?.event).filter(event => event?.payload?.reason === 'resource_available');
        return { ...checkpoint.job, ...(semanticNext ? { kind: 'wake', userInputs: [], events: [],
          sourceDecisionRef: work.intentCoordination.decision.operationId } : {}), workId: work.workId, continuation: true,
          ...(resourceEvents.length ? { kind: 'wake', userInputs: [], events: resourceEvents, sourceDecisionRef: undefined } : {}),
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
    transfer, deliver: delivery.dispatch, deferReply: delivery.defer, deliveryCommitted: delivery.committed,
    bindReplies: delivery.bindReplies, prepareReplies: delivery.prepareReplies, prepareDigest: delivery.prepareDigest,
    reconcileDispatches,
    async recover() { reconcileDispatches(); return delivery.recover(); }, hasPendingDelivery: delivery.pending,
    turnFacts(job) {
      const state = readSnapshot();
      return createDecisionFrame({ state, workspaceId, parentConversationId: conversationId, workId: job.workId, sessions: rows(),
        originDecisionRef: job.sourceDecisionRef, turnId: job.attemptId,
        ...(state.works[job.workId] ? readResourceWaitFacts(resourceWaitPort, resourceWaitScope(state.works[job.workId], state),
          (state.works[job.workId].waitFor || []).filter(wait => wait.kind === 'resource')) : {}),
        eventIds: (job.events || []).map(row => row.eventId), currentInputIds: (job.userInputs || []).map(row => row.inputId) });
    },
    dispositionMissing(job) {
      const state = readSnapshot(), work = state.works[job.workId], intent = work?.intentCoordination;
      if (state.mandates?.[job.workId]?.intentSchemaVersion !== 1 && !intent) return false; // Legacy and lightweight discussion retain their contract.
      return !intent || !intentDecisionAdmittedForTurn(state, work, job.attemptId,
        job.resumedIntentDecisionRef ? { workId: job.workId, decisionRef: job.resumedIntentDecisionRef } : undefined);
    },
    requiresTaskReply(job) {
      const state = readSnapshot();
      return Boolean(state.mandates?.[job.workId]?.intentSchemaVersion === 1 || state.works[job.workId]?.intentCoordination
        || Object.values(state.works).some(work => work.intentCoordination?.decision.disposition.kind === 'return'
          && state.intentDecisions?.[work.intentCoordination.decision.operationId]?.turnId === job.attemptId));
    },
    pending() {
      if (store.coalesceWorks) reconcileContinuationCustody({ store, conversationId, sessions: rows });
      return pendingFrom(readSnapshot());
    },
    ownedInputIds() { const state = readSnapshot(); return [...new Set([...Object.values(state.works).filter(work => work.parentConversationId === conversationId).flatMap(work => work.anchorInputIds || []), ...(state.lastRecovery?.quarantinedInputIds || [])])]; },
    ownsInput(inputId) { return this.ownedInputIds().includes(inputId); },
    canPreemptRequest(workId) {
      const work = readWork(workId);
      return Boolean(work && !hasUnsettledDispatch(work)
        && Object.values(work.budget?.attempts || {}).every(attempt => !attempt.pendingTools?.length));
    },
    nextRetryAt() {
      expireReservations();
      const at = now();
      return Object.values(readSnapshot().works).filter(work => work.parentConversationId === conversationId && work.state === 'retry_wait' && work.recovery?.reservationId
        && work.waitFor?.some(wait => wait.kind === 'retry_timer' && wait.id === work.recovery.reservationId)
        && Date.parse(work.recovery.deadlineAt) > Date.parse(at) && !hasUnsettledDispatch(work))
        .map(work => work.recovery.retryAt).concat(delivery.nextRetryAt()).filter(at => Number.isFinite(Date.parse(at))).sort()[0] || null;
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
      reconcileDispatches();
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
    delegationFacts(workId) {
      const works = Object.values(readSnapshot().works).filter(work => work.parentConversationId === conversationId
        && work.delegationFollowUp?.blockers.length && !['cancelled', 'coalesced'].includes(work.state));
      const blockers = works.sort((a, b) => Number(a.workId === workId) - Number(b.workId === workId))
        .flatMap(work => work.delegationFollowUp.blockers.map(row => ({ ...row, workId: work.workId, workState: work.state })));
      return blockers.length ? { blockers } : undefined;
    },
    captureDelegation(job, outcome) {
      const work = readWork(job.workId);
      const pending = delegationFollowUp(work.delegationFollowUp, outcome.rounds, readMessages(), outcome.turnId);
      if (!pending && !work.delegationFollowUp) return;
      store.saveWork({ ...work, delegationFollowUp: pending,
        ...(pending?.blockers.some(row => !row.retryable) && !outcome.stopped
          && !runtimeWorkHeld(work) && !historyExecutionHeld(work) ? { state: 'blocked_system' } : {}),
        checkpointRef: store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome }) }, { returnState: false });
    },
    blockReservation(job) {
      // Keep fresh, already received input as runnable intent, without an execution attempt.
      // Otherwise cooldown rejection removes it from this process's queue permanently.
      if (!job.workId) {
        if (job.userInputs?.length) start(job);
        return;
      }
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
      if (runtimeWorkControlHeld(existing)) return false;
      if (runtimeWorkHeld(existing) && !job.manualRecovery) return false;
      if (job.recoveryRevision !== undefined && existing.revision !== job.recoveryRevision) return false;
      if (job.recoveryReservationId && (existing.recovery?.reservationId !== job.recoveryReservationId || !recoveryReservationDue(existing, now()))) return false;
      if (existing.state === 'coalesced' || !job.manualRecovery && ['paused', 'cancelled', 'budget_limited', 'blocked_system'].includes(existing.state)) return false;
      return true;
    },
    start,
    interruptedStops(messages) {
      const presented = new Set(messages.filter(row => row.card === 'agent_stopped').map(row => row.turnId));
      return Object.values(readSnapshot().works).flatMap(work => {
        if (work.parentConversationId !== conversationId || work.stopScope !== 'reply' || work.end !== 'user_stopped'
          || !['paused', 'waiting_children'].includes(work.state) || !work.attemptId || presented.has(work.attemptId)
          || historyExecutionHeld(work) || runtimeWorkControlHeld(work)) return [];
        const job = readProtectedWork(work)?.job;
        return job?.workId === work.workId ? [{ work, job }] : [];
      });
    },
    stopReply(workId, turnId) {
      const work = readWork(workId);
      if (work?.parentConversationId !== conversationId || work.attemptId !== turnId) return false;
      if (runtimeWorkControlHeld(work)) return true;
      store.saveWork({ ...work, state: 'paused', stopScope: 'reply', end: 'user_stopped' }, { returnState: false });
      return true;
    },
    stalls(job, outcome, roster) {
      if (outcome.silentWait) return false;
      if (reportedWaitFor({ job, outcome, state: readSnapshot(), messages: readMessages(), sessions: Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [] })) return false;
      const previous = readWork(job.workId);
      const sources = ownedSessions(previous, job, roster);
      const observed = delegationFollowUp(previous.delegationFollowUp, outcome.rounds, readMessages(), outcome.turnId);
      const pending = observed ? reconcileDelegationFollowUp(observed, readSnapshot(), job.workId) : undefined;
      return !runtimeWorkHeld(previous) && !historyExecutionHeld(previous)
        && (repairOwnership(sources).repairSessionIds.length > 0 || previous.intentCoordination?.lifecycle === 'active' || pending?.blockers.length)
        && repairProgressDecision({ ...previous, delegationFollowUp: pending }, outcome, roster, sources).end === 'no_progress';
    },
    finish(job, outcome, roster) {
      const previous = readWork(job.workId);
      const sources = ownedSessions(previous, job, roster);
      const observed = delegationFollowUp(previous.delegationFollowUp, outcome.rounds, readMessages(), outcome.turnId);
      const pending = observed ? reconcileDelegationFollowUp(observed, readSnapshot(), job.workId) : undefined;
      const sessionIds = [...new Set([...previous.sessionIds, ...sources.map(row => row.sessionId)])];
      const decision = repairProgressDecision({ ...previous, delegationFollowUp: pending }, outcome, roster, sources);
      const recovery = outcome.failed ? outcome.recovery || recoveryForFailure(previous, outcome, now()) : undefined;
      const reportedWait = reportedWaitFor({ job, outcome, state: readSnapshot(), messages: readMessages(), sessions: Array.isArray(roster) ? roster : roster?.items || roster?.sessions || [] });
      const observedEvents = (job.events || []).filter(eventObserved);
      const unseenEvents = (job.events || []).filter(event => !eventObserved(event));
      let semantic;
      if (!pending && previous.intentCoordination && !runtimeWorkHeld(previous) && !outcome.silentWait && decision.state !== 'blocked_system' && !outcome.failed && !outcome.stopped && !outcome.budgetLimited && !outcome.deliveryPending && !outcome.yielded) {
        semantic = delivery.resolveIntent(previous, Array.isArray(roster) ? roster : roster?.items || roster?.sessions || []);
      }
      const disposition = decideRuntimeDisposition({ previous: { ...previous, delegationFollowUp: pending }, sessions: sources, outcome, continuation: decision, semantic,
        reportedWait, recovery, unseenEvents: unseenEvents.length > 0, held: historyExecutionHeld(previous) });
      const { handling, ...patch } = disposition;
      const { state, end } = disposition;
      const { recoveryRevision, recoveryReservationId, manualRecovery: _manual, ...durableJob } = job;
      const checkpointRef = outcome.preserveCheckpoint ? previous.checkpointRef
        : store.checkpoint(job.workId, { job: { ...durableJob, continuation: true }, outcome });
      store.saveWork({ ...previous, ...decision, ...semantic, ...patch, state, end, sessionIds, checkpointRef, recovery, reportedWait, delegationFollowUp: pending,
        intentCoordination: readWork(job.workId).intentCoordination,
        waitFor: disposition.waitFor,
        consumedEventIds: [...new Set([...previous.consumedEventIds, ...observedEvents.map(row => row.eventId)])].slice(-64) }, { returnState: false });
      if (!outcome.failed && !outcome.yielded && !outcome.deliveryPending) store.handled(observedEvents.map(row => row.eventId));
      return { ...decision, state };
    },
    dispatchRecoveryFacts: dispatchRecovery.facts,
    resume(job, selection) {
      const work = readWork(job.workId);
      delete job.resumedIntentDecisionRef;
      if (hasUnsettledDispatch(work)) throw new Error('execution_outcome_unknown');
      const checkpoint = readProtectedWork(work);
      if (!recoveryCheckpointAvailable(work, checkpoint, store.readCheckpoint)) throw new Error('continuity_checkpoint_missing');
      const outcome = checkpoint?.outcome;
      if (work.delegationFollowUp?.blockers.length && !outcome?.yielded) return { ...outcome, providerCheckpoint: undefined };
      const resourceWake = job.events?.some(event => event.payload?.reason === 'resource_available' && work.pendingEventIds?.includes(event.eventId));
      if ((job.sourceDecisionRef || resourceWake) && !outcome?.yielded) return outcome ? { ...outcome, providerCheckpoint: undefined } : null;
      // A finished public update starts the next reasoning step with current
      // roster facts. Only an actual yield resumes a native Provider slice.
      const resumed = outcome && work.nativeCheckpointRef && (!work.repairSessionIds?.length || outcome.yielded)
        ? { ...outcome, providerCheckpoint: store.readCheckpoint(work.nativeCheckpointRef) } : outcome;
      const result = replyCheckpointForModel(resumed, selection), intent = work.intentCoordination;
      if (selection?.modelProviderId && selection.modelId && result?.providerCheckpoint && outcome?.yielded && !outcome.failed && !outcome.stopped && !outcome.preempted && !outcome.budgetLimited
        && intent?.lifecycle === 'active' && intent.goalRevision === readSnapshot().mandates?.[work.workId]?.goalRevision
        && (intent.decisionTurnId === outcome.turnId || checkpoint.job?.resumedIntentDecisionRef === intent.decision.operationId)) {
        job.resumedIntentDecisionRef = intent.decision.operationId;
      }
      return result;
    },
  };
}
