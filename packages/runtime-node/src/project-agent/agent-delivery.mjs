import { workBudgetBinding } from './work-budget.mjs';

const fail = code => { throw Object.assign(new Error(code), { code }); };

/** Durable delivery over the existing coordination journal, shared by every local host. */
export function createAgentDelivery({ storeFor = id => workBudgetBinding(id)?.store, now = () => new Date().toISOString() } = {}) {
  function store(workspaceId) {
    const value = storeFor(workspaceId);
    if (!value?.readSupervision || !value?.querySupervision) fail('agent_supervision_unavailable');
    return value;
  }
  function commit(message, { request, answer } = {}) {
    const journal = store(message.workspaceId);
    journal.enableSupervision();
    const old = journal.readSupervision('agentMessages', message.messageId);
    if (old) {
      if (old.payloadHash !== message.payloadHash) fail('agent_operation_conflict');
      return { message: old, receipt: journal.readSupervision('agentCommands', old.operationId), replayed: true };
    }
    const execute = message.deliveryIntent === 'ensure_turn';
    const receipt = { operationId: message.operationId, messageId: message.messageId, sessionId: message.sessionId,
      workspaceId: message.workspaceId, goalRevision: message.goalRevision, executionEpoch: message.executionEpoch,
      delivery: 'queued', admission: execute ? 'pending' : 'not_requested', effect: execute ? 'pending' : 'not_requested' };
    journal.append({ kind: 'agent_message_committed', operationId: message.operationId, message, receipt, request, answer }, { returnState: false });
    return { message: journal.readSupervision('agentMessages', message.messageId), receipt, replayed: false };
  }
  function update(message, patch) {
    const journal = store(message.workspaceId);
    journal.assertOwner();
    const current = journal.readSupervision('agentCommands', message.operationId);
    if (current && Object.entries(patch).every(([key, value]) => current[key] === value)) return current;
    journal.append({ kind: 'agent_command_updated', operationId: message.operationId,
      goalRevision: message.goalRevision, executionEpoch: message.executionEpoch, patch }, { returnState: false });
  }
  function read(workspaceId, conversationId, options = {}) {
    const journal = store(workspaceId);
    const rows = journal.querySupervision('agentMessages', 'recipientConversationId', conversationId, options);
    return (options.oldestFirst ? rows : rows.reverse()).map(message => {
      const request = message.purpose === 'question' && journal.readSupervision('agentRequests', message.messageId);
      return request ? { ...message, decisionRequest: request } : message;
    });
  }
  function receipt(workspaceId, operationId) { return store(workspaceId).readSupervision('agentCommands', operationId); }
  function request(workspaceId, requestId) { return store(workspaceId).readSupervision('agentRequests', requestId); }
  function openRequest(workspaceId, sessionId) {
    return store(workspaceId).querySupervision('agentRequests', 'sessionId', sessionId, { pendingOnly: true, limit: 1 })[0];
  }
  function observed(workspaceId, conversationId, messageIds, attemptRef) {
    const journal = store(workspaceId);
    const messages = messageIds.map(id => journal.readSupervision('agentMessages', id)).filter(Boolean);
    const fresh = messages.filter(message => journal.readSupervision('agentCommands', message.operationId)?.delivery !== 'observed');
    if (!fresh.length) return;
    journal.append({ kind: 'agent_context_observed', conversationId, messageIds: fresh.map(row => row.messageId), at: now() }, { returnState: false });
  }
  function executed(workspaceId, conversationId, messageIds, attemptRef) {
    const journal = store(workspaceId);
    for (const id of messageIds) {
      const message = journal.readSupervision('agentMessages', id);
      if (!message || message.recipientConversationId !== conversationId) continue;
      const current = receipt(workspaceId, message.operationId);
      if (current?.delivery === 'observed' && ['pending', 'unknown'].includes(current.effect) && current.admission !== 'rejected') {
        update(message, { admission: 'admitted', effect: 'applied', attemptRef, error: null });
      }
    }
  }
  function pending(workspaceId, sessionId) {
    const journal = store(workspaceId);
    return journal.querySupervision('agentCommands', 'sessionId', sessionId, { limit: 100, pendingOnly: true })
      .filter(row => row.admission === 'pending' || row.effect === 'pending' || row.effect === 'unknown')
      .map(row => journal.readSupervision('agentMessages', row.messageId)).filter(Boolean);
  }
  return { commit, update, read, receipt, request, openRequest, observed, executed, pending,
    available: workspaceId => Boolean(storeFor(workspaceId)?.readSupervision) };
}

export const agentDelivery = createAgentDelivery();

/** Host records the exact Source-admitted IDs; prompt caches are never the durable receipt. */
export function recordAgentContextAdmission(workspaceId, conversationId, context) {
  const ids = context?.sections?.find(section => section.id === 'agent-communication')?.source?.messageIds;
  if (!Array.isArray(ids) || !ids.length || !workspaceId || !conversationId || !agentDelivery.available(workspaceId)) return;
  agentDelivery.observed(workspaceId, conversationId, ids);
}

/** A completed model turn proves this bound attempt began; coordinator completion alone does not. */
export function recordCoordinatedExecution(plan, attemptRef) {
  const origin = plan?.delegationOrigin, operationId = origin?.takeover?.operationId;
  const journal = origin && workBudgetBinding(origin.workspaceId)?.store;
  if (!operationId || !journal) return;
  const transition = journal.readLifecycleFacts().transitions?.[operationId];
  if (!transition || transition.executionEpoch !== origin.coordinationBinding?.executionEpoch
    || transition.expectedGoalRevision !== origin.coordinationBinding?.goalRevision || transition.executionEffect === 'applied') return;
  journal.advanceTransition(operationId, transition.phase, { executionAdmission: 'admitted', executionEffect: 'applied', executionAttemptRef: attemptRef });
}
