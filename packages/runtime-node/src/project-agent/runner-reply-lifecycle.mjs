import { createReplyDelivery } from './reply-delivery.mjs';
import { ownedSessions } from './repair-ownership.mjs';
import { decideRuntimeDisposition, runtimeWorkHeld } from './runtime-disposition.ts';
import { intentWorkDisposition } from './intent-lifecycle.mjs';
import { intentReplyBindings, retainedIntentReplyBindings, intentReplyScopes, intentReviewCurrent } from './intent-reply-bindings.mjs';
import { historyExecutionHeld } from './history-resumption.mjs';

/** Owns reply/goal bindings, post-settlement custody and deferred expression over the existing journal. */
export function createRunnerReplyLifecycle({ store, workspaceId, conversationId, readMessages, remember, onReplied, onDeferred, onDeliveryChanged, resolveRoster, eventObserved, now }) {
  const readSnapshot = () => store.readSnapshot?.() ?? store.read();
  const readWork = id => store.readWork?.(id) ?? readSnapshot().works[id];
  const rows = () => resolveRoster() || [];
  function resolveIntent(work, roster = rows()) {
    const state = readSnapshot(), mandate = state.mandates?.[work.workId];
    const related = roster.filter(row => mandate?.sessionIds.includes(row.sessionId));
    return intentWorkDisposition({ work, state, sessions: related, store, parentConversationId: conversationId,
      sourcesCurrent: (review, snapshot, id) => intentReviewCurrent(review, snapshot, id, related) });
  }
  const delivery = createReplyDelivery({ store, readMessages, appendMessage: remember, accept: onReplied, onDeferred, now, onChanged: onDeliveryChanged,
    admitMessage: (message, state) => {
      const owner = state.works[message.meta?.workId];
      if (owner) return (!owner.workspaceId || owner.workspaceId === workspaceId) && owner.parentConversationId === conversationId;
      const originals = (message.meta?.digestReplyIds || []).map(id => state.deliveries[id]?.message).filter(Boolean);
      const owners = [...(message.meta?.intentBindings || []).map(row => state.works[row.workId]), ...originals.map(row => state.works[row.meta?.workId])].filter(Boolean);
      return owners.length > 0 ? owners.every(row => (!row.workspaceId || row.workspaceId === workspaceId) && row.parentConversationId === conversationId)
        : message.conversationId === conversationId;
    },
    validate: message => (message.meta?.sessionStates || []).every(source => {
      const current = rows().find(row => row.sessionId === source.sessionId);
      return current && source.sourceRevision && current.sourceRevision === source.sourceRevision
        && (current.observationRevision === source.observationRevision || source.status === 'result_ready' && current.status === 'accepted')
        && (current.status === source.status || source.status === 'result_ready' && current.status === 'accepted');
    }),
    onRecovered: message => {
      for (const workId of new Set([message.meta?.workId, ...(message.meta?.intentBindings || []).map(row => row.workId)].filter(Boolean))) {
        const work = readWork(workId);
        const binding = message.meta?.intentBindings?.find(row => row.workId === workId
          && row.intentRevision === work?.intentCoordination?.revision && row.decisionRef === work.intentCoordination?.decision.operationId);
        const returningSameGoal = work?.intentCoordination?.lifecycle === 'active' && work.intentCoordination.decision.disposition.kind === 'return'
          && message.meta?.intentScopes?.some(scope => scope.workId === workId && scope.goalRevision === work.intentCoordination.goalRevision);
        if (!work || historyExecutionHeld(work) || runtimeWorkHeld(work) || ['paused', 'cancelled'].includes(work.state)
          || !binding && !returningSameGoal && (!['runnable', 'retry_wait'].includes(work.state) || work.attemptId && work.attemptId !== message.turnId)) continue;
        const related = ownedSessions(work, { events: [] }, rows());
        const sessionIds = [...new Set([...(work.sessionIds || []), ...related.map(row => row.sessionId)])];
        const events = (work.pendingEventIds || []).map(id => readSnapshot().events[id]?.event).filter(Boolean);
        const unseen = events.filter(event => !eventObserved(event));
        const semantic = resolveIntent(work);
        const { handling, ...disposition } = decideRuntimeDisposition({ previous: work, sessions: related, semantic, unseenEvents: unseen.length > 0 });
        store.saveWork({ ...work, sessionIds, ...semantic, ...disposition, intentCoordination: readWork(work.workId).intentCoordination }, { returnState: false });
        store.handled(events.filter(eventObserved).map(event => event.eventId));
      }
    },
    onInvalidated: message => {
      const current = rows().filter(row => (!row.origin?.parentConversationId || row.origin.parentConversationId === conversationId)
        && message.meta?.sessionStates?.some(source => source.sessionId === row.sessionId));
      store.transfer(current.map(row => ({ workspaceId, eventId: `reply-refresh:${message.id}:${row.sourceRevision}:${row.observationRevision || ''}:${row.status}`,
        kind: 'report_available', sessionId: row.sessionId, at: new Date().toISOString(), payload: { sourceRevision: row.sourceRevision, observationRevision: row.observationRevision, status: row.status } })));
      const workIds = [...new Set([message.meta?.workId, ...(message.meta?.intentBindings || []).map(row => row.workId)].filter(Boolean))];
      for (const id of workIds) {
        const work = readWork(id);
        if (!work || work.parentConversationId !== conversationId || historyExecutionHeld(work) || runtimeWorkHeld(work) || ['paused', 'cancelled'].includes(work.state)) continue;
        const binding = message.meta?.intentBindings?.find(row => row.workId === id);
        if (binding && (binding.intentRevision !== work.intentCoordination?.revision || binding.decisionRef !== work.intentCoordination.decision.operationId)) continue;
        store.saveWork({ ...work, state: 'waiting_children' }, { returnState: false });
      }
      if (readMessages().some(row => row.id === message.id)) remember({ id: `${message.id}:updated`, kind: 'agent_reply', role: 'assistant',
        content: '结果有更新，我再核对一下。', meta: { workId: workIds[0] } });
    },
  });
  function bindReplies(messages, job) {
    const continuation = job?.resumedIntentDecisionRef ? { workId: job.workId, decisionRef: job.resumedIntentDecisionRef } : undefined;
    for (const message of messages) message.meta = { ...message.meta, intentBindings: intentReplyBindings(readSnapshot(), message, workspaceId, conversationId, continuation), intentScopes: intentReplyScopes(readSnapshot(), message, workspaceId, conversationId, continuation) };
  }
  return { ...delivery, resolveIntent, bindReplies,
    prepareReplies(messages, job) { bindReplies(messages, job); return delivery.prepare(messages); },
    prepareDigest(message) {
      const state = readSnapshot();
      if ((message.meta?.digestReplyIds || []).some(id => {
        const owner = state.works[state.deliveries[id]?.message.meta?.workId];
        return owner && (owner.workspaceId !== workspaceId || owner.parentConversationId !== conversationId);
      })) return { held: true, reason: 'digest_scope_conflict' };
      const digestReplyIds = (message.meta?.digestReplyIds || []).filter(id => state.deliveries[id]?.state === 'deferred'
        && typeof state.deliveries[id].message.content === 'string' && message.content?.includes(state.deliveries[id].message.content.trim()));
      message.meta = { ...message.meta, digestReplyIds };
      if (digestReplyIds.length) {
        const originals = digestReplyIds.map(id => state.deliveries[id].message);
        message.sources = [...new Set(originals.flatMap(row => row.sources || []))];
        message.meta.sessionStates = [...new Map(originals.flatMap(row => row.meta?.sessionStates || []).map(row => [row.sessionId, row])).values()];
        message.meta.intentScopes = [...new Map(originals.flatMap(row => row.meta?.intentScopes || []).map(row => [`${row.workId}:${row.goalRevision}`, row])).values()];
      }
      message.meta.intentBindings = retainedIntentReplyBindings(state, message, workspaceId, conversationId);
      return delivery.prepareAggregate(message);
    },
  };
}
