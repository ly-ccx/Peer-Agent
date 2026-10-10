/** Host events become lightweight conversation activity, never assistant claims. */
export function createAgentEventPublisher({ inbox, conversationStore, findSession, onChanged = () => {} }) {
  return (workspaceId, events) => {
    const result = inbox.append(workspaceId, events);
    for (const event of events || []) {
      const plan = findSession(event.sessionId, event);
      const origin = plan?.delegationOrigin;
      if (!origin?.parentConversationId || origin.workspaceId !== workspaceId) continue;
      const state = activityState(event, plan);
      if (!state) continue;
      const id = ['queued', 'started', 'ended', 'cancelled'].includes(state)
        ? `agent-activity:${origin.sessionId}:${state}` : `agent-activity:${event.eventId}`;
      const history = conversationStore.getPersistedConversationHistory(origin.parentConversationId);
      if (!history || history.messages.some(row => row.id === id)) continue;
      const stored = conversationStore.appendMessage(origin.parentConversationId, {
        id, role: 'system', kind: 'agent_activity', content: '', createdAt: event.at || new Date().toISOString(),
        agentActivity: { eventId: event.eventId, sessionId: origin.sessionId, name: plan.title || 'Agent', state },
      });
      if (!stored) throw new Error('agent_activity_not_stored');
      onChanged(workspaceId);
    }
    return result;
  };
}

function activityState(event, plan) {
  if (event.kind === 'agent_message') return event.payload?.agentMessage?.purpose || null;
  if (event.kind === 'session_started') {
    if (event.payload?.status && !['running', 'starting', 'queued'].includes(event.payload.status)) return null;
    return plan.delegationOrigin.phase === 'running' ? 'started' : plan.delegationOrigin.phase === 'queued' ? 'queued' : null;
  }
  if (event.kind === 'session_running') return 'started';
  if (event.kind === 'report_available') return 'reported';
  if (event.kind === 'result_ready') return event.payload?.outcome === 'passed' ? 'verified' : 'reported';
  if (event.kind === 'session_verified') return plan.resultAcceptance?.acceptedAt ? 'ended' : null;
  if (event.kind === 'cancelled') return 'cancelled';
  if (event.kind === 'failed' || event.kind === 'interrupted') return 'blocked';
  if (event.kind === 'session_ended') return 'ended';
  return null;
}
