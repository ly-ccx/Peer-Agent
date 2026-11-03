import { intentReviewCurrent } from './intent-reply-bindings.mjs';
const secret = /sk-[A-Za-z0-9]{8,}|api[_-]?key\s*[:=]|bearer\s+[A-Za-z0-9._-]{8,}/i;
export const publicDecisionText = (value, max = 400) => typeof value !== 'string' ? '' : secret.test(value) ? '[sensitive content omitted]' : value.slice(0, max);
const text = publicDecisionText;
const ids = values => (values || []).filter(value => typeof value === 'string').slice(0, 64).map(value => text(value, 200));
const scopeOf = (row, workspaceId, parentConversationId) => row?.workspaceId === workspaceId && row.origin?.parentConversationId === parentConversationId;

export function publicEventPayload(event, maxText = 300) {
  const payload = event.payload || {}, output = {};
  for (const key of ['reason', 'lastError', 'cause', 'error', 'errorCode', 'blockedCode', 'failureKind', 'status', 'sourceRevision', 'observationRevision']) {
    if (typeof payload[key] === 'string') output[key] = text(payload[key], maxText);
  }
  for (const key of ['sameCauseCount', 'stopAutoRetry', 'askUser']) if (['number', 'boolean'].includes(typeof payload[key])) output[key] = payload[key];
  if (Array.isArray(payload.leafIds)) output.leafIds = ids(payload.leafIds);
  if (payload.agentMessage) output.agentMessage = { messageId: text(payload.agentMessage.messageId, 200), requestId: text(payload.agentMessage.requestId, 200),
    purpose: text(payload.agentMessage.purpose, 30), text: text(payload.agentMessage.text, Math.min(maxText, 600)) };
  return output;
}

/** Bounded factual projection. It carries retrieval identity, never executable authority or private reasoning. */
export function createDecisionFrame({ state, workspaceId, parentConversationId, workId, sessions = [], eventIds = [], currentInputIds = [], afterSessionId,
  originDecisionRef, turnId, maxSessions = 24, maxEvents = 16, maxBytes = 24000 }) {
  const work = state.works?.[workId];
  if (!work || work.workspaceId !== workspaceId || work.parentConversationId !== parentConversationId) return null;
  const mandate = state.mandates?.[workId], intent = work.intentCoordination, goalRevision = mandate?.goalRevision || 0;
  const origin = state.intentDecisions?.[originDecisionRef];
  const sameTurnOrigin = typeof turnId === 'string' && turnId.length > 0 && intent?.decisionTurnId === turnId && origin?.continuation === true && origin.workId === workId && origin.goalRevision === goalRevision;
  const events = eventIds.map(id => state.events?.[id]?.event).filter(event => event && (!event.workspaceId || event.workspaceId === workspaceId)
    && (!event.sessionId || mandate?.sessionIds.includes(event.sessionId) || work.sessionIds?.includes(event.sessionId)));
  const eventSessions = new Set(events.map(row => row.sessionId));
  const relatedIds = new Set([...(mandate?.sessionIds || []), ...(work.sessionIds || []), ...eventSessions]);
  const related = sessions.filter(row => scopeOf(row, workspaceId, parentConversationId) && relatedIds.has(row.sessionId))
    .sort((a, b) => Number(eventSessions.has(b.sessionId)) - Number(eventSessions.has(a.sessionId)) || a.sessionId.localeCompare(b.sessionId));
  const start = afterSessionId ? related.findIndex(row => row.sessionId === afterSessionId) + 1 : 0;
  const frame = { workId, workRevision: intent?.revision || 0, goalRevision,
    ...(typeof turnId === 'string' && turnId ? { currentReplyRef: `${turnId}-reply-1` } : {}),
    sourceInputIds: ids(currentInputIds).slice(0, 16), sourceEventIds: ids(eventIds).slice(0, 16),
    sourceDecisionRef: intent?.decision.disposition.kind === 'continue' ? intent.decision.operationId : sameTurnOrigin ? originDecisionRef : undefined,
    intent: intent ? { lifecycle: intent.lifecycle, outcome: text(intent.interpretation.outcome, 1000),
      constraints: intent.interpretation.constraints.slice(0, 8).map(row => text(row, 250)), nonGoals: intent.interpretation.nonGoals.slice(0, 8).map(row => text(row, 250)),
      openQuestions: intent.interpretation.openQuestions.slice(0, 8).map(row => text(row, 250)),
      openQuestionCount: intent.interpretation.openQuestions.length, remainingRequirementCount: intent.coverage.filter(row => row.status !== 'covered').length,
      inputDispositions: Object.values(intent.inputs || {}).slice(-16).map(row => ({ inputId: row.inputId, kind: row.kind, reason: text(row.reason, 160) })),
      requirements: intent.interpretation.requirements.map(row => ({ requirementId: row.requirementId, text: text(row.text, 250), sourceInputIds: ids(row.sourceInputIds).slice(0, 4),
        status: intent.coverage.find(item => item.requirementId === row.requirementId)?.status || 'uncertain' }))
        .sort((a, b) => Number(a.status === 'covered') - Number(b.status === 'covered')),
      disposition: intent.decision.disposition.kind, review: intent.review ? { reviewRef: intent.review.reviewRef, passed: intent.review.passed,
        current: intentReviewCurrent(intent.review, state, workId, related), goalRevision: intent.review.goalRevision } : null } : null,
    sessions: [], events: [], questions: [], operations: [], unknownEffects: [], controls: { state: work.state, stopScope: work.stopScope,
      pendingControl: Boolean(work.pendingControl), recovery: work.recovery ? { failureKind: work.recovery.failureKind, blockedCode: work.recovery.blockedCode, retryAt: work.recovery.retryAt } : null },
    progressObservation: work.progressObservation || null,
    availableActions: ['query', 'assess', 'parallel', 'augment', 'revise', 'answer', 'cancel', 'replace', 'handoff', 'resume'].map(action => {
      const stopped = ['paused', 'cancelled', 'coalesced', 'budget_limited'].includes(work.state) || intent && intent.lifecycle !== 'active';
      const hasSource = currentInputIds.length || events.length || intent?.lifecycle === 'active' && (intent.decision.disposition.kind === 'continue' || sameTurnOrigin) && mandate?.lifecycle === 'active';
      const allowed = action === 'query' || !stopped && Boolean(hasSource) && (action === 'assess' || Boolean(mandate?.allowedActions.includes(action)));
      return { action, allowed, ...(!allowed ? { reason: stopped ? 'work_execution_stopped' : 'current_user_or_mandate_required' } : {}) };
    }),
    omitted: { sessions: 0, events: 0, questions: 0, operations: 0, unknownEffects: 0, requirements: 0, inputDispositions: Math.max(0, Object.keys(intent?.inputs || {}).length - 16),
      sourceInputIds: Math.max(0, currentInputIds.length - 16), sourceEventIds: Math.max(0, eventIds.length - 16), text: false },
    retrieval: { tool: 'coordinate_work', action: 'query', workId, expectedRevision: goalRevision }, truncated: false };
  function append(key, rows, limit) {
    for (const row of rows.slice(0, limit)) {
      frame[key].push(row);
      if (Buffer.byteLength(JSON.stringify(frame)) > maxBytes - 1000) { frame[key].pop(); break; }
    }
    frame.omitted[key] = rows.length - frame[key].length;
  }
  while (Buffer.byteLength(JSON.stringify(frame)) > maxBytes - 4000 && frame.intent?.requirements.length) {
    frame.intent.requirements.pop(); frame.omitted.requirements++;
  }
  while (Buffer.byteLength(JSON.stringify(frame)) > maxBytes - 4000) {
    const arrays = [frame.intent?.constraints, frame.intent?.nonGoals, frame.intent?.openQuestions, frame.intent?.inputDispositions,
      frame.sourceInputIds, frame.sourceEventIds].filter(row => row?.length);
    if (!arrays.length) break;
    const largest = arrays.sort((a, b) => JSON.stringify(b).length - JSON.stringify(a).length)[0];
    largest.pop(); frame.omitted.text = true;
  }
  append('events', events.map(row => ({ eventId: row.eventId, kind: row.kind, sessionId: row.sessionId, at: row.at,
    summary: text(row.summary || row.text, 400), payload: publicEventPayload(row), retrieval: { tool: 'coordinate_work', action: 'query', workId, eventId: row.eventId } })), maxEvents);
  append('sessions', related.slice(start).map(row => ({ sessionId: row.sessionId, title: text(row.title, 200), status: row.status,
    sourceRevision: text(row.sourceRevision, 200), observationRevision: text(row.observationRevision, 200),
    followUp: row.followUp ? { owner: row.followUp.owner, reason: text(row.followUp.reason, 100), inCurrentList: row.followUp.inCurrentList === true } : null,
    blockedReason: text(row.blockedReason), humanGate: row.followUp?.owner === 'user' || row.resultConfirmationRequired === true,
    reportSummary: text(row.report?.summary, 500), retrieval: { tool: 'get_session', sessionId: row.sessionId } })), maxSessions);
  const questions = Object.values(state.agentRequests || {}).filter(row => row.status === 'open' && relatedIds.has(row.sessionId));
  append('questions', questions.map(row => ({ requestId: row.requestId, sessionId: row.sessionId, revision: row.revision,
    responder: row.responder, userRequestRef: row.userRequestRef, prompt: text(row.prompt || row.text, 500) })), 16);
  const transitions = Object.values(state.transitions || {}).filter(row => row.workId === workId);
  append('operations', transitions.slice().reverse().map(row => ({ operationId: row.operationId, action: row.action, phase: row.phase,
    executionAdmission: row.executionAdmission, executionEffect: row.executionEffect, error: text(row.error, 200), sessionId: row.replacementSessionId || row.oldSessionId })), 16);
  const unknown = Object.values(state.agentCommands || {}).filter(row => (row.workId === workId || relatedIds.has(row.sessionId)) && ['pending', 'unknown'].includes(row.effect));
  append('unknownEffects', unknown.map(row => ({ operationId: row.operationId, sessionId: row.sessionId, effect: row.effect,
    nextAction: 'reconcile_existing_receipt_before_dispatch' })), 16);
  if (frame.omitted.sessions && frame.sessions.length) frame.retrieval.afterSessionId = frame.sessions.at(-1).sessionId;
  const originalText = intent ? JSON.stringify(intent.interpretation) : '';
  frame.omitted.text ||= secret.test(originalText) || Boolean(intent && (intent.interpretation.outcome.length > 1000
    || ['constraints', 'nonGoals', 'openQuestions'].some(key => intent.interpretation[key].length > 8 || intent.interpretation[key].some(row => row.length > 250))
    || intent.interpretation.requirements.some(row => row.text.length > 250 || row.sourceInputIds.length > 4)));
  frame.truncated = Object.values(frame.omitted).some(Boolean);
  return frame;
}
