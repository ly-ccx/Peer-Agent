import { createHash } from 'node:crypto';
import { agentDelivery } from './agent-delivery.mjs';
import { workBudgetBinding } from './work-budget.mjs';

const reject = code => { throw Object.assign(new Error(code), { code }); };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** Parent-first decisions; native permission and user-input requests are never answered here. */
export function createSupervisedCommunication({ publish, patchOrigin, resume, conversationStore, now, canManageWorkspace }) {
  function binding(plan) {
    const origin = plan.delegationOrigin;
    const journal = workBudgetBinding(origin.workspaceId)?.store;
    const facts = journal?.readLifecycleFacts();
    const mandate = facts?.mandates?.[origin.workId];
    return mandate && mandate.goalRevision === origin.coordinationBinding?.goalRevision ? { journal, mandate } : null;
  }
  function readMessage(plan, messageId) {
    return workBudgetBinding(plan.delegationOrigin.workspaceId)?.store.readSupervision('agentMessages', messageId);
  }
  function validateResume(plan, message) {
    const current = binding(plan);
    if (!current || current.mandate.goalRevision !== message.goalRevision
      || plan.delegationOrigin.coordinationBinding?.executionEpoch !== message.executionEpoch) return 'agent_execution_stale';
    const work = current.journal.readWork(current.mandate.workId);
    if (work?.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)) return 'work_execution_stopped';
    if (plan.delegationOrigin.phase !== 'running' || ['cancelled', 'completed', 'failed'].includes(plan.status)) return 'agent_execution_stopped';
    const receipt = agentDelivery.receipt(message.workspaceId, message.operationId);
    if (receipt?.effect === 'applied' || receipt?.effect === 'rejected') return 'agent_command_settled';
    if (receipt?.effect === 'unknown' || receipt?.admission === 'admitted') return 'agent_outcome_unknown';
    return null;
  }
  function mirror(message) {
    // A lost mirror is repaired from the canonical journal; it never controls delivery.
    try {
      const history = conversationStore.getPersistedConversationHistory(message.recipientConversationId);
      if (!history?.messages?.some(row => row.id === message.messageId)) conversationStore.appendMessage(message.recipientConversationId, {
        id: message.messageId, kind: 'agent_message', role: 'system', content: message.text, createdAt: message.at,
        agentMessage: message, supervisionRef: { workspaceId: message.workspaceId, messageId: message.messageId },
      });
    } catch { /* The durable inbox, not this presentation copy, owns recovery. */ }
  }
  function dispatch(message, plan) {
    const current = binding(plan);
    if (!current || current.mandate.goalRevision !== message.goalRevision || plan.delegationOrigin.coordinationBinding?.executionEpoch !== message.executionEpoch) {
      const previous = agentDelivery.receipt(message.workspaceId, message.operationId);
      agentDelivery.update(message, { admission: 'rejected', effect: previous?.effect === 'unknown' ? 'unknown' : 'rejected', error: 'agent_execution_stale' }); return;
    }
    mirror(message);
    if (message.direction === 'child_to_parent') {
      if (message.purpose === 'question') {
        const request = agentDelivery.request(message.workspaceId, message.messageId);
        if (request?.status === 'open' && !plan.delegationOrigin.agentWaitMessageId) patchOrigin(plan, { agentWaitMessageId: message.messageId });
      }
      if (message.deliveryIntent === 'ensure_turn') publish(message);
    } else if (message.deliveryIntent === 'ensure_turn') {
      const blocked = validateResume(plan, message);
      if (blocked) {
        if (blocked !== 'agent_command_settled' && blocked !== 'agent_outcome_unknown') agentDelivery.update(message, { admission: 'rejected', effect: 'rejected', error: blocked });
        return;
      }
      patchOrigin(plan, { agentResumePending: message.messageId }); resume(plan.planId);
    }
  }
  function send(input, context, plan) {
    const scoped = binding(plan);
    if (!scoped || !canManageWorkspace(plan.delegationOrigin.workspaceId)) reject('agent_coordination_binding_required');
    const origin = plan.delegationOrigin;
    if (context.role === 'work_session' && (!context.coordinationBinding || context.workId !== origin.workId)) reject('agent_execution_stale');
    if (context.coordinationBinding && (context.coordinationBinding.goalRevision !== scoped.mandate.goalRevision
      || context.coordinationBinding.executionEpoch !== origin.coordinationBinding?.executionEpoch)) reject('agent_execution_stale');
    if (input.expectedRevision !== undefined && input.expectedRevision !== scoped.mandate.goalRevision) reject('agent_execution_stale');
    if (input.expectedExecutionEpoch !== undefined && input.expectedExecutionEpoch !== origin.coordinationBinding?.executionEpoch) reject('agent_execution_stale');
    const direction = context.role === 'work_session' ? 'child_to_parent' : 'parent_to_child';
    const recipientConversationId = direction === 'child_to_parent' ? origin.parentConversationId : plan.conversationId;
    const messageId = `agent-msg:${digest([context.deliveryKey, context.conversationId, recipientConversationId, origin.sessionId])}`;
    const deliveryIntent = input.delivery ?? ((direction === 'child_to_parent' && input.purpose === 'question')
      || (direction === 'parent_to_child' && input.purpose === 'answer') ? 'ensure_turn' : 'mailbox_only');
    if (!['mailbox_only', 'ensure_turn'].includes(deliveryIntent)) reject('agent_delivery_invalid');
    if (direction === 'parent_to_child' && input.purpose !== 'answer' && deliveryIntent === 'ensure_turn'
      && input.expectedRevision === undefined) reject('agent_revision_required');
    const identity = { purpose: input.purpose, text: input.text.trim(), replyTo: input.replyTo ?? input.decisionAnswer?.requestId,
      deliveryIntent, decisionRequest: input.decisionRequest, decisionAnswer: input.decisionAnswer };
    const message = { ...identity, messageId, operationId: messageId, workspaceId: origin.workspaceId, workId: origin.workId,
      sessionId: origin.sessionId, senderConversationId: context.conversationId, recipientConversationId, direction,
      goalRevision: scoped.mandate.goalRevision, executionEpoch: origin.coordinationBinding?.executionEpoch, at: now(), payloadHash: digest(identity) };
    const previous = readMessage(plan, messageId);
    if (previous) {
      if (previous.payloadHash !== message.payloadHash) reject('agent_operation_conflict');
      dispatch(previous, plan);
      return { ok: true, messageId, sessionId: origin.sessionId, delivery: 'queued', replayed: true,
        receipt: agentDelivery.receipt(origin.workspaceId, messageId) };
    }
    if (['completed', 'failed', 'cancelled', 'paused', 'superseded'].includes(origin.phase)) reject('session_not_running');
    const work = scoped.journal.readWork(origin.workId);
    if (scoped.mandate.lifecycle !== 'active') reject('mandate_inactive');
    if (work?.stopScope === 'work' && ['paused', 'cancelled'].includes(work.state)) reject('work_execution_stopped');
    let request, answer;
    if (input.purpose === 'question' && direction === 'child_to_parent') {
      if (origin.agentWaitMessageId) reject('agent_question_pending');
      const spec = input.decisionRequest || {};
      const options = spec.options;
      request = { requestId: messageId, revision: 1, question: message.text, options, allowText: spec.allowText !== false,
        multiple: spec.multiple === true, responder: 'parent', status: 'open', goalRevision: message.goalRevision,
        sessionId: message.sessionId, parentConversationId: origin.parentConversationId, workId: origin.workId };
      if (request.allowText === false && !options?.length) reject('agent_answer_schema_invalid');
      message.decisionRequest = request;
    } else if (input.purpose === 'answer' && direction === 'parent_to_child') {
      const current = agentDelivery.request(origin.workspaceId, message.replyTo);
      if (!current || current.status !== 'open' || !['parent', 'user'].includes(current.responder) || current.sessionId !== origin.sessionId) reject('agent_request_stale');
      const sourceInput = current.responder === 'user' ? (context.messages || []).find(row =>
        context.currentInputAnchors?.includes(row.id) && row.kind === 'user_input' && row.role === 'user' && row.answerTo === current.userRequestRef) : null;
      if (current.responder === 'user' && !sourceInput) reject('current_user_answer_required');
      answer = { ...(sourceInput ? { sourceInputId: sourceInput.id, userRequestRef: current.userRequestRef } : {}), requestId: current.requestId, expectedRequestRevision: input.decisionAnswer?.expectedRequestRevision ?? current.revision,
        optionIds: input.decisionAnswer?.optionIds, text: input.decisionAnswer?.text ?? message.text };
      const choices = answer.optionIds || [];
      if (!Array.isArray(choices) || new Set(choices).size !== choices.length || !current.multiple && choices.length > 1
        || choices.some(id => !current.options?.some(option => option.optionId === id))
        || !choices.length && (!current.allowText || !answer.text?.trim())) reject('agent_answer_invalid');
      message.decisionAnswer = answer;
    } else if (input.decisionRequest || input.decisionAnswer) reject('agent_decision_direction_invalid');
    agentDelivery.commit(message, { request, answer });
    let coordinationPending = false;
    try { dispatch(message, plan); } catch { coordinationPending = true; }
    return { ok: true, messageId, sessionId: origin.sessionId, delivery: 'queued',
      ...(request ? { request, waitingForParent: true } : {}), coordinationPending, receipt: agentDelivery.receipt(origin.workspaceId, messageId) };
  }
  function recover(plan, { recoveringStarted = true } = {}) {
    const current = binding(plan);
    if (!current) return;
    const request = agentDelivery.openRequest(plan.delegationOrigin.workspaceId, plan.delegationOrigin.sessionId);
    if (request && (request.goalRevision !== current.mandate.goalRevision
      || ['cancelled', 'completed', 'failed', 'superseded'].includes(plan.delegationOrigin.phase))) {
      current.journal.append({ kind: 'agent_request_cancelled', requestId: request.requestId, expectedRevision: request.revision,
        reason: 'execution_replaced_or_ended' }, { returnState: false });
      if (plan.delegationOrigin.agentWaitMessageId === request.requestId) patchOrigin(plan, { agentWaitMessageId: null });
    }
    for (const message of agentDelivery.pending(plan.delegationOrigin.workspaceId, plan.delegationOrigin.sessionId)) {
      const receipt = agentDelivery.receipt(message.workspaceId, message.operationId);
      if (recoveringStarted && message.direction === 'parent_to_child' && receipt?.admission === 'admitted' && receipt.effect === 'pending') {
        agentDelivery.update(message, { effect: 'unknown', error: 'resume_requires_reconciliation' });
        continue;
      }
      dispatch(message, plan);
    }
  }
  return { binding, send, readMessage, validateResume, recover };
}
