import { historyExecutionHeld } from './history-resumption.mjs';

const intentBindingStopped = work => work?.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state);

/** A host-proven native continuation carries a judgment, never a new execution grant. */
export function intentDecisionAdmittedForTurn(state, work, turnId, continuation) {
  const intent = work?.intentCoordination, receipt = state.intentDecisions?.[intent?.decision.operationId];
  if (!receipt || receipt.workId !== work.workId || receipt.goalRevision !== intent.goalRevision
    || intent.goalRevision !== (state.mandates?.[work.workId]?.goalRevision || 0)) return false;
  return receipt.turnId === turnId || intent.lifecycle === 'active'
    && continuation?.workId === work.workId && continuation.decisionRef === receipt.operationId;
}

export const intentReviewCurrent = (review, state, workId, sessions) => Boolean(review?.passed && Array.isArray(review.sources) && review.goalRevision === state.mandates?.[workId]?.goalRevision
  && review.sources.every(source => sessions.some(row => row.sessionId === source.sessionId && row.sourceRevision === source.sourceRevision)));

/** One public reply may return several explicitly assessed goals; the host derives each binding. */
export function intentReplyBindings(state, message, workspaceId, parentConversationId, continuation) {
  if (typeof message.content !== 'string' || !message.content.trim()) return [];
  return Object.values(state.works || {}).filter(work => work.workspaceId === workspaceId && work.parentConversationId === parentConversationId
    && !intentBindingStopped(work) && !historyExecutionHeld(work) && work.intentCoordination?.lifecycle === 'active' && work.intentCoordination.decision.disposition.kind === 'return'
    && work.intentCoordination.decision.disposition.replyRef === `${state.intentDecisions?.[work.intentCoordination.decision.operationId]?.turnId}-reply-1`
    && work.intentCoordination.coverage.some(row => row.sources.some(source => message.sources?.includes(source.sessionId)
      && message.meta?.sessionStates?.some(item => item.sessionId === source.sessionId && item.sourceRevision === source.sourceRevision)))
    && intentDecisionAdmittedForTurn(state, work, message.turnId, continuation))
    .map(work => ({ workId: work.workId, goalRevision: work.intentCoordination.goalRevision,
      intentRevision: work.intentCoordination.revision, decisionRef: work.intentCoordination.decision.operationId,
      replyRef: work.intentCoordination.decision.disposition.replyRef }));
}

export function intentReplyScopes(state, message, workspaceId, parentConversationId, continuation) {
  return Object.values(state.works || {}).filter(work => work.workspaceId === workspaceId && work.parentConversationId === parentConversationId
    && work.intentCoordination && intentDecisionAdmittedForTurn(state, work, message.turnId, continuation))
    .map(work => ({ workId: work.workId, goalRevision: work.intentCoordination.goalRevision }));
}

function intentCurrentReplyBinding(message, work) {
  const intent = work.intentCoordination;
  return message.meta?.intentBindings?.some(binding => binding.workId === work.workId && binding.goalRevision === intent.goalRevision
    && binding.intentRevision === intent.revision && binding.decisionRef === intent.decision.operationId
    && (binding.replyRef || message.id) === intent.decision.disposition.replyRef);
}
function intentReplyCandidate(row, work) {
  if (row?.state !== 'delivered') return false;
  const intent = work.intentCoordination, message = row.message;
  if (typeof message.content !== 'string' || !message.content.trim()) return false;
  const currentBinding = intentCurrentReplyBinding(message, work);
  const sameGoal = !intent.decision.sourceInputIds.length && message.meta?.intentScopes?.some(scope => scope.workId === work.workId && scope.goalRevision === intent.goalRevision);
  return Boolean(currentBinding || sameGoal);
}
/** A newly asked question needs its own reply. A quiet wake can reuse already delivered, version-bound goal results. */
export function intentDeliveredReplyRefs(state, work) {
  const candidates = Object.values(state.deliveries || {}).filter(row => intentReplyCandidate(row, work));
  const sources = work.intentCoordination.review?.sources || work.intentCoordination.coverage.flatMap(row => row.sources);
  const direct = candidates.find(row => intentCurrentReplyBinding(row.message, work)
    && sources.some(source => row.message.meta?.sessionStates?.some(item => item.sessionId === source.sessionId
      && item.sourceRevision === source.sourceRevision && ['result_ready', 'accepted'].includes(item.status))));
  if (direct) return [direct.message.id];
  if (!sources.length) return [];
  const selected = sources.map(source => candidates.find(row => row.message.meta?.sessionStates?.some(item => item.sessionId === source.sessionId
    && item.sourceRevision === source.sourceRevision && ['result_ready', 'accepted'].includes(item.status))));
  return selected.every(Boolean) ? [...new Set(selected.map(row => row.message.id))] : [];
}
export function intentReplyRefsProveDelivery(state, work, refs) {
  if (!refs?.length || refs.some(id => !intentReplyCandidate(state.deliveries?.[id], work))) return false;
  const subset = { deliveries: Object.fromEntries(refs.map(id => [id, state.deliveries[id]])) };
  return intentDeliveredReplyRefs(subset, work).length > 0;
}

/** Digest files supply references only. The original validated reply and binding must exist in the journal. */
export function retainedIntentReplyBindings(state, message, workspaceId, parentConversationId) {
  const originals = (message.meta?.digestReplyIds || []).map(id => state.deliveries?.[id]).filter(row => row?.state === 'deferred'
    && typeof row.message.content === 'string' && message.content?.includes(row.message.content.trim()));
  const bindings = originals.flatMap(row => row.message.meta?.intentBindings || []).filter(binding => {
    const work = state.works?.[binding.workId], intent = work?.intentCoordination;
    return work?.workspaceId === workspaceId && work.parentConversationId === parentConversationId && !intentBindingStopped(work) && !historyExecutionHeld(work)
      && intent?.lifecycle === 'active' && intent.goalRevision === binding.goalRevision && intent.revision === binding.intentRevision
      && intent.decision.operationId === binding.decisionRef && intent.decision.disposition.replyRef === binding.replyRef
      && intent.coverage.every(row => row.sources.every(source => message.sources?.includes(source.sessionId)));
  });
  return [...new Map(bindings.map(row => [row.workId, row])).values()];
}
