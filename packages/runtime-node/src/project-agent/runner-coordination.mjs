import { createReplyDelivery } from './reply-delivery.mjs';
import { coordinationWorkId } from './work-coordination.mjs';
import { continuationDecision } from './continuation-policy.mjs';

const ROUTINE = new Set(['session_started', 'progress', 'session_spawned', 'session_progress']);
export function createRunnerCoordination({ store, inbox, workspaceId, conversationId, readMessages, remember, onReplied, resolveRoster }) {
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
  return {
    admitRecoveredEvents(events) {
      const known = store.read().events;
      const missing = (events || []).filter(event => !known[event.eventId]);
      if (missing.length) store.transfer(missing);
    },
    transfer, deliver: delivery.deliver, prepareReplies: delivery.prepare, recover: delivery.recover, hasPendingDelivery: delivery.pending,
    pending() { return store.pendingEvents().filter(event => !ROUTINE.has(event.kind) && !Object.values(store.read().works).some(work => work.sessionIds?.includes(event.sessionId) && work.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state))); },
    recoverJob() {
      const work = Object.values(store.read().works).find(row => row.state === 'runnable' && row.checkpointRef);
      return work ? store.readCheckpoint(work.checkpointRef).job : null;
    },
    start(job) {
      const inputs = (job.userInputs || []).map(input => input.inputId);
      const events = job.events || [];
      const missing = events.filter(event => !store.read().events[event.eventId]);
      if (missing.length) store.transfer(missing);
      const linked = Object.values(store.read().works).find(work => events.some(event => work.sessionIds?.includes(event.sessionId)));
      job.workId ||= (!inputs.length && linked?.workId) || coordinationWorkId(conversationId, inputs.length ? inputs : events.map(event => event.eventId));
      const existing = store.read().works[job.workId];
      if (inputs.length && !job.continuation) for (const work of Object.values(store.read().works)) {
        if (work.workId !== job.workId && work.state === 'runnable') store.saveWork({ ...work, state: 'paused', stopScope: 'reply' });
      }
      const checkpointRef = existing?.checkpointRef || store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome: { rounds: [] } });
      store.saveWork({ checkpointRef, schemaVersion: 1, workspaceId, parentConversationId: conversationId,
        anchorInputIds: inputs, sessionIds: [], waitFor: [], consumedEventIds: [], pendingResultRefs: [], stopScope: 'reply',
        ...existing, workId: job.workId, attemptId: job.attemptId, pendingEventIds: events.map(event => event.eventId), state: 'runnable' });
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
      if (outcome.failed) state = outcome.reason === 'agent_no_progress' ? 'blocked_system' : 'retry_wait';
      if (outcome.stopped) state = waiting.length ? 'waiting_children' : 'paused';
      // A child question does not finish the parent reply that still needs to
      // bring that question into the main conversation. Keep a yielded parent
      // runnable until its public reply is committed.
      if (!outcome.yielded && sources.some(row => row.status === 'waiting_user')) state = 'waiting_user';
      if (outcome.budgetLimited) state = 'budget_limited';
      if (outcome.deliveryPending) state = 'retry_wait';
      const end = state === 'waiting_children' ? 'awaiting_children' : state === 'waiting_user' ? 'awaiting_user'
        : state === 'budget_limited' ? 'budget_limited' : state === 'blocked_system' ? 'no_progress'
        : outcome.stopped ? 'user_stopped' : outcome.failed ? /outcome_unknown/.test(outcome.reason || '') ? 'fatal' : 'provider_retryable'
        : state === 'retry_wait' ? 'provider_retryable' : decision.end;
      const checkpointRef = store.checkpoint(job.workId, { job: { ...job, continuation: true }, outcome });
      store.saveWork({ ...previous, ...decision, state, end, sessionIds, checkpointRef,
        waitFor: waiting.map(row => ({ kind: 'session', id: row.sessionId })),
        consumedEventIds: [...new Set([...previous.consumedEventIds, ...(job.events || []).map(row => row.eventId)])].slice(-64) });
      if (!outcome.failed && !outcome.deliveryPending) store.handled((job.events || []).map(row => row.eventId));
      return { ...decision, state };
    },
    resume(job) {
      const work = store.read().works[job.workId];
      const outcome = work?.checkpointRef ? store.readCheckpoint(work.checkpointRef).outcome : null;
      return outcome && work.nativeCheckpointRef ? { ...outcome, providerCheckpoint: store.readCheckpoint(work.nativeCheckpointRef) } : outcome;
    },
  };
}
