import { createHash } from 'node:crypto';
import { goalPlanWaitsOnUser } from '../goal-plan-store.mjs';

const STOPPED = new Set(['completed', 'failed', 'cancelled']);
const CLOSED_PHASES = new Set(['paused', 'superseded', 'completed', 'failed', 'cancelled']);
const PURPOSES = new Set(['update', 'question', 'answer']);
const fail = error => ({ ok: false, error });

/** Bounded factual context. Internal records must never enter ordinary chat history. */
export function agentMessagesForContext(messages, conversationId) {
  let remaining = 12_000;
  return (Array.isArray(messages) ? messages : []).filter(row => row?.kind === 'agent_message'
    && row.agentMessage?.recipientConversationId === conversationId).slice(-8).flatMap(row => {
    const message = row.agentMessage;
    if (!message || !PURPOSES.has(message.purpose) || typeof message.text !== 'string'
      || typeof message.messageId !== 'string' || !['parent_to_child', 'child_to_parent'].includes(message.direction)) return [];
    const text = message.text.slice(0, Math.min(4000, remaining));
    remaining -= text.length;
    return text ? [{ ...message, text }] : [];
  });
}

/**
 * A mailbox over existing Conversations. Identity, durable enqueue and Inbox repair
 * live here. A correlated parent answer resumes the existing plan at idle;
 * it never consumes a human answer or executes project capabilities directly.
 */
export function createAgentCommunication({ conversationStore, goalPlanStore, goalRunner, findSession, listSessions,
  canManageWorkspace = () => false, emitEvent, now = () => new Date().toISOString() }) {
  const resumes = new Map();
  const pendingWakes = new Set();
  function history(id) {
    const value = conversationStore.getPersistedConversationHistory(id);
    return value && Array.isArray(value.messages) ? value : null;
  }
  function publish(message) {
    if (message.direction !== 'child_to_parent') return;
    if (typeof emitEvent !== 'function') throw new Error('agent_inbox_unavailable');
    emitEvent({ eventId: `agent-message:${message.messageId}`, kind: 'agent_message',
      workspaceId: message.workspaceId, sessionId: message.sessionId, at: message.at,
      payload: { agentMessage: message } });
  }
  function patchOrigin(plan, patch) {
    const saved = goalPlanStore.revisePlan(plan.planId, { delegationOrigin: { ...plan.delegationOrigin, ...patch } },
      { reason: 'Agent communication coordination', changedBy: 'agent-communication' });
    if (!saved) throw new Error('agent_coordination_not_stored');
    return saved;
  }
  function coordinate(message, plan) {
    if (message.direction === 'child_to_parent' && message.purpose === 'question') {
      const answered = history(plan.conversationId)?.messages.some(row => row.kind === 'agent_message'
        && row.agentMessage?.replyTo === message.messageId && row.agentMessage.direction === 'parent_to_child'
        && row.agentMessage.purpose === 'answer');
      if (!answered && !STOPPED.has(plan.status) && plan.delegationOrigin.phase === 'running'
        && !plan.delegationOrigin.agentWaitMessageId) patchOrigin(plan, { agentWaitMessageId: message.messageId });
    }
    if (message.direction === 'parent_to_child' && message.purpose === 'answer'
      && message.replyTo === plan.delegationOrigin.agentWaitMessageId) {
      patchOrigin(plan, { agentResumePending: message.messageId });
      resume(plan.planId);
    }
  }
  function resume(planId) {
    if (resumes.has(planId)) { pendingWakes.add(planId); return; }
    // Release the Supervisor mutex before waiting for an active worker turn.
    const pending = Promise.resolve().then(async () => {
      await goalRunner?.waitForIdle?.(planId);
      const plan = goalPlanStore.getPlan(planId), origin = plan?.delegationOrigin;
      if (!origin?.agentResumePending || !canManageWorkspace(origin.workspaceId) || origin.phase !== 'running'
        || STOPPED.has(plan.status)
        || typeof goalRunner?.resume !== 'function') return;
      const answer = history(plan.conversationId)?.messages.find(row => row.id === origin.agentResumePending)?.agentMessage;
      if (!answer || answer.direction !== 'parent_to_child' || answer.purpose !== 'answer'
        || answer.senderConversationId !== origin.parentConversationId
        || origin.agentWaitMessageId && answer.replyTo !== origin.agentWaitMessageId) return;
      if (plan.runner?.status === 'waiting_user' || goalPlanWaitsOnUser(plan)) {
        patchOrigin(plan, { agentWaitMessageId: null, agentResumePending: null });
        return;
      }
      patchOrigin(plan, { agentWaitMessageId: null });
      try {
        const result = await goalRunner.resume(planId, { awaitIdle: false, intent: 'execute', phase: 'act', parentAgentAnswer: true });
        const fresh = goalPlanStore.getPlan(planId);
        // A human wait or cancellation that arrived at the safe boundary keeps ownership.
        if (!fresh || !canManageWorkspace(origin.workspaceId) || fresh.delegationOrigin?.phase !== 'running') return;
        if (fresh.delegationOrigin.agentResumePending !== answer.messageId) return;
        if (result?.resumeAdmission === 'admitted' || result?.resumeAdmission === 'human_wait') {
          patchOrigin(fresh, { agentResumePending: null,
            ...(!fresh.delegationOrigin.agentWaitMessageId || fresh.delegationOrigin.agentWaitMessageId === answer.replyTo
              ? { agentWaitMessageId: null } : {}),
          });
        } else if (!STOPPED.has(fresh.status) && (!fresh.delegationOrigin.agentWaitMessageId
          || fresh.delegationOrigin.agentWaitMessageId === answer.replyTo)) {
          // A state snapshot is not proof of admission. Keep the durable answer retryable.
          patchOrigin(fresh, { agentWaitMessageId: answer.replyTo });
        }
      } catch {
        const fresh = goalPlanStore.getPlan(planId);
        if (fresh && fresh.delegationOrigin?.phase === 'running' && !STOPPED.has(fresh.status)
          && fresh.delegationOrigin.agentResumePending === answer.messageId
          && (!fresh.delegationOrigin.agentWaitMessageId || fresh.delegationOrigin.agentWaitMessageId === answer.replyTo)) {
          patchOrigin(fresh, { agentWaitMessageId: answer.replyTo });
        }
      }
    }).finally(() => {
      resumes.delete(planId);
      if (pendingWakes.delete(planId)) resume(planId);
    });
    resumes.set(planId, pending);
    // Durable pending identity remains retryable; a failed wake is not a successful read.
    pending.catch(() => {});
  }
  function send(input, context) {
    const role = context?.role;
    if (!['project_agent', 'work_session'].includes(role)
      || role === 'work_session' && context.agentKind !== 'worker') return fail('agent_identity_required');
    const sessionId = role === 'work_session' ? context.sessionId : input.sessionId;
    if (!sessionId || input.sessionId && input.sessionId !== sessionId) return fail('agent_identity_mismatch');
    const plan = findSession(sessionId);
    const origin = plan?.delegationOrigin;
    if (!origin || origin.workspaceId !== context.workspaceId || !origin.parentConversationId
      || context.conversationId !== (role === 'work_session' ? plan.conversationId : origin.parentConversationId)
      || role === 'work_session' && context.planId !== plan.planId) return fail('agent_out_of_scope');
    if (canManageWorkspace(origin.workspaceId) !== true) return fail('not_host');
    if (!context.deliveryKey || !PURPOSES.has(input.purpose) || typeof input.text !== 'string'
      || !input.text.trim() || input.text.length > 4000) return fail('invalid_input');
    const direction = role === 'work_session' ? 'child_to_parent' : 'parent_to_child';
    const recipientConversationId = role === 'work_session' ? origin.parentConversationId : plan.conversationId;
    const receiver = history(recipientConversationId);
    if (!receiver || !history(context.conversationId)) return fail('agent_conversation_unavailable');
    const messageId = `agent-msg:${createHash('sha256').update(JSON.stringify([
      context.deliveryKey, context.conversationId, recipientConversationId, sessionId, input.purpose, input.text, input.replyTo ?? null,
    ])).digest('hex')}`;
    const previous = receiver.messages.find(row => row.id === messageId && row.kind === 'agent_message');
    // Replaying a durable enqueue repairs delivery even if the agent has since finished.
    if (previous) {
      coordinate(previous.agentMessage, plan);
      publish(previous.agentMessage);
      return { ok: true, messageId, sessionId, delivery: 'queued', replayed: true,
        ...(direction === 'child_to_parent' && findSession(sessionId).delegationOrigin.agentWaitMessageId === messageId ? { waitingForParent: true } : {}) };
    }
    if (STOPPED.has(plan.status) || CLOSED_PHASES.has(origin.phase)) return fail('session_not_running');
    if (role === 'work_session' && (origin.phase !== 'running' || plan.runner?.status === 'waiting_user' || goalPlanWaitsOnUser(plan))) return fail('agent_not_executing');
    if (role === 'work_session' && input.purpose === 'question' && origin.agentWaitMessageId) return fail('agent_question_pending');
    if (direction === 'parent_to_child' && input.purpose === 'answer' && origin.agentWaitMessageId
      && input.replyTo !== origin.agentWaitMessageId) return fail('agent_question_mismatch');
    const message = { messageId, workspaceId: origin.workspaceId, sessionId,
      senderConversationId: context.conversationId, recipientConversationId, direction,
      purpose: input.purpose, text: input.text.trim(), at: now(), ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
    const stored = conversationStore.appendMessage(recipientConversationId, {
      id: messageId, kind: 'agent_message', role: 'system', content: message.text,
      createdAt: message.at, agentMessage: message,
    });
    if (!stored) return fail('agent_message_not_stored');
    coordinate(message, plan);
    publish(message);
    return { ok: true, messageId, sessionId, delivery: 'queued',
      ...(direction === 'child_to_parent' && input.purpose === 'question' ? { waitingForParent: true } : {}) };
  }
  function recover() {
    const parents = new Set();
    let repaired = 0;
    for (const plan of listSessions()) {
      const origin = plan.delegationOrigin;
      if (origin?.agentResumePending && canManageWorkspace(origin.workspaceId)) resume(plan.planId);
      if (!origin || !canManageWorkspace(origin.workspaceId) || parents.has(origin.parentConversationId)) continue;
      parents.add(origin.parentConversationId);
      for (const row of history(origin.parentConversationId)?.messages || []) {
        const message = row.kind === 'agent_message' ? row.agentMessage : null;
        const owner = message && findSession(message.sessionId);
        if (!owner || message.direction !== 'child_to_parent' || owner.conversationId !== message.senderConversationId
          || owner.delegationOrigin.workspaceId !== message.workspaceId
          || owner.delegationOrigin.parentConversationId !== message.recipientConversationId) continue;
        publish(message); repaired += 1;
        if (message.purpose === 'question' && !STOPPED.has(owner.status) && owner.delegationOrigin.phase === 'running') {
          const answer = history(owner.conversationId)?.messages.find(row => row.kind === 'agent_message'
            && row.agentMessage?.replyTo === message.messageId && row.agentMessage.direction === 'parent_to_child'
            && row.agentMessage.purpose === 'answer')?.agentMessage;
          if (!answer && !owner.delegationOrigin.agentWaitMessageId) coordinate(message, owner);
          // Reconcile the write-before-coordination crash without reviving old answered questions.
          if (answer && owner.delegationOrigin.agentWaitMessageId === message.messageId) coordinate(answer, owner);
        }
      }
    }
    return { repaired };
  }
  return { send, recover, async waitForResumes() { while (resumes.size) await Promise.all([...resumes.values()]); } };
}
