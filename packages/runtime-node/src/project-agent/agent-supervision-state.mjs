/** Canonical coordination facts; no execution, permission inference or independent task lifecycle. */
export const SUPERVISION_BUCKETS = ['agentMessages', 'agentRequests', 'agentCommands', 'workNotes', 'contextWindows'];
const receiptStates = { delivery: ['queued', 'observed'], admission: ['not_requested', 'pending', 'admitted', 'rejected'], effect: ['not_requested', 'pending', 'applied', 'unknown', 'rejected'] };
const validReceipt = value => Object.entries(receiptStates).every(([key, allowed]) => allowed.includes(value?.[key]));
const supervisionError = code => { throw Object.assign(new Error(code), { code }); };

export function reduceAgentSupervision(state, entry) {
  const next = { ...state };
  for (const bucket of SUPERVISION_BUCKETS) next[bucket] = { ...(state[bucket] || {}) };
  if (entry.kind === 'agent_message_committed') {
    const message = entry.message;
    if (!message?.messageId || !message.operationId || !message.recipientConversationId || !entry.receipt
      || entry.receipt.operationId !== message.operationId || !validReceipt(entry.receipt)
      || entry.receipt.messageId !== message.messageId || entry.receipt.goalRevision !== message.goalRevision
      || entry.receipt.sessionId !== message.sessionId || entry.receipt.delivery !== 'queued'
      || !Number.isSafeInteger(message.goalRevision) || message.goalRevision < 0 || !message.payloadHash) supervisionError('agent_message_invalid');
    const previous = next.agentMessages[message.messageId];
    if (previous) {
      if (previous.payloadHash !== message.payloadHash) supervisionError('agent_operation_conflict');
      return next;
    }
    if (entry.answer) {
      const request = next.agentRequests[entry.answer.requestId];
      if (!request || request.status !== 'open' || request.revision !== entry.answer.expectedRequestRevision
        || request.goalRevision !== message.goalRevision || request.sessionId !== message.sessionId
        || request.responder === 'user' && (!entry.answer.sourceInputId || entry.answer.userRequestRef !== request.userRequestRef)) supervisionError('agent_request_stale');
      next.agentRequests[request.requestId] = { ...request, status: 'answered', answerId: message.messageId, revision: request.revision + 1 };
    }
    if (entry.request) {
      if (entry.request.requestId !== message.messageId || entry.request.revision !== 1 || entry.request.status !== 'open'
        || entry.request.responder !== 'parent' || entry.request.sessionId !== message.sessionId
        || entry.request.goalRevision !== message.goalRevision) supervisionError('agent_request_invalid');
      if (next.agentRequests[entry.request.requestId]) supervisionError('agent_request_exists');
      if (Object.values(next.agentRequests).some(request => request.sessionId === entry.request.sessionId && request.status === 'open')) supervisionError('agent_request_already_open');
      next.agentRequests[entry.request.requestId] = structuredClone(entry.request);
    }
    next.agentMessages[message.messageId] = { ...structuredClone(message), sequence: entry.revision };
    next.agentCommands[message.operationId] = structuredClone(entry.receipt);
  } else if (entry.kind === 'agent_command_updated') {
    const current = next.agentCommands[entry.operationId];
    if (!current || current.goalRevision !== entry.goalRevision || current.executionEpoch !== entry.executionEpoch) supervisionError('agent_command_stale');
    const allowed = new Set(['delivery', 'admission', 'effect', 'error', 'observedAt', 'attemptRef']);
    if (Object.keys(entry.patch || {}).some(key => !allowed.has(key))) supervisionError('agent_command_patch_invalid');
    const patch = { ...entry.patch };
    if (!validReceipt({ ...current, ...patch })) supervisionError('agent_command_patch_invalid');
    if (patch.effect === 'applied' && ((patch.delivery || current.delivery) !== 'observed'
      || (patch.admission || current.admission) !== 'admitted' || !patch.attemptRef)) supervisionError('agent_effect_unproven');
    if (current.delivery === 'observed' && patch.delivery === 'queued') delete patch.delivery;
    if (current.effect === 'applied') {
      delete patch.effect; delete patch.admission; delete patch.error;
    }
    const updated = { ...current, ...patch };
    if (patch.error === null) delete updated.error;
    next.agentCommands[entry.operationId] = updated;
  } else if (entry.kind === 'agent_execution_completed') {
    if (typeof entry.attemptRef !== 'string' || !entry.attemptRef || !Array.isArray(entry.messageIds)
      || !entry.messageIds.length || entry.messageIds.length > 100) supervisionError('agent_execution_unproven');
    for (const id of entry.messageIds) {
      const message = next.agentMessages[id], receipt = message && next.agentCommands[message.operationId];
      if (!message || message.recipientConversationId !== entry.conversationId || receipt?.delivery !== 'observed'
        || receipt.admission === 'rejected' || !['pending','unknown','applied'].includes(receipt.effect)) supervisionError('agent_execution_unproven');
      if (receipt.effect !== 'applied') next.agentCommands[message.operationId] = {...receipt,admission:'admitted',effect:'applied',attemptRef:entry.attemptRef,completionRecorded:true,error:undefined};
    }
  } else if (entry.kind === 'agent_context_observed') {
    for (const id of entry.messageIds || []) {
      const message = next.agentMessages[id];
      if (!message || message.recipientConversationId !== entry.conversationId) supervisionError('agent_observation_out_of_scope');
      const receipt = next.agentCommands[message.operationId];
      next.agentCommands[message.operationId] = { ...receipt, delivery: 'observed', observedAt: entry.at };
    }
  } else if (entry.kind === 'agent_request_cancelled') {
    const request = next.agentRequests[entry.requestId];
    if (!request || request.status !== 'open' || request.revision !== entry.expectedRevision) supervisionError('agent_request_stale');
    next.agentRequests[request.requestId] = { ...request, status: 'cancelled', revision: request.revision + 1, reason: entry.reason };
  } else if (entry.kind === 'agent_request_escalated') {
    const request = next.agentRequests[entry.requestId];
    if (!request || request.status !== 'open' || request.revision !== entry.expectedRevision || !entry.userRequestRef
      || request.responder === 'user' && entry.previousUserRequestRef !== request.userRequestRef) supervisionError('agent_request_stale');
    next.agentRequests[request.requestId] = { ...request, responder: 'user', userRequestRef: entry.userRequestRef, revision: request.revision + 1 };
  } else if (entry.kind === 'work_note_written') {
    const current = next.workNotes[entry.note?.noteId];
    if (!entry.note?.noteId || !entry.note.workId || !entry.note.conversationId || !Number.isSafeInteger(entry.expectedRevision) || entry.expectedRevision < 0 || (current?.revision || 0) !== entry.expectedRevision
      || current && (current.workId !== entry.note.workId || current.conversationId !== entry.note.conversationId)) supervisionError('work_note_conflict');
    next.workNotes[entry.note.noteId] = { ...structuredClone(entry.note), revision: entry.expectedRevision + 1 };
  } else if (entry.kind === 'context_window_opened') {
    const window = entry.window;
    if (!window?.windowId || !window.workId || !window.conversationId || !window.budgetRef || window.state !== 'prepared') supervisionError('context_window_invalid');
    if (window.previousWindowId && !next.contextWindows[window.previousWindowId]) supervisionError('context_window_previous_missing');
    const previous = next.contextWindows[window.windowId];
    if (previous && JSON.stringify(previous) !== JSON.stringify(window)) supervisionError('context_window_conflict');
    next.contextWindows[window.windowId] = structuredClone(window);
  } else supervisionError('agent_supervision_event_unknown');
  return next;
}
