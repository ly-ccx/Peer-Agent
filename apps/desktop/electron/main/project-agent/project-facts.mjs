import { createCardProjection, verdictRefFor } from '@peer-agent/runtime-node';

/** Project facts shared by reply validation and cards; model payloads never supply verdicts. */
export function createDesktopProjectFacts({ supervisor, approvalStore, profileStore, conversationStore, runtimeRoot }) {
  const projection = createCardProjection({ rootDir: runtimeRoot });
  function sessions(workspaceId) { return supervisor.sessionsForProject(workspaceId); }
  function delivery(workspaceId) {
    const rows = sessions(workspaceId);
    return {
      sessionIds: rows.map((row) => row.sessionId),
      verdicts: rows.flatMap((row) => {
        const decision = supervisor.acceptance(row.sessionId);
        return decision ? [{ sessionId: row.sessionId, ...decision.verdict,
          verdictRef: verdictRefFor(row.sessionId, decision.verdict.outcome) }] : [];
      }),
    };
  }
  function cards(workspaceId) {
    const profile = profileStore.read(workspaceId);
    const messages = conversationStore.getPersistedConversationHistory(profile?.agentConversationId)?.messages || [];
    const replies = messages.filter((message) => message.kind === 'agent_reply').map((message) => ({
      ...message,
      ...(message.question ? { question: { ...message.question,
        answered: messages.some((answer) => answer.answerTo === `card:question:reply:${message.id}`) } } : {}),
    }));
    const rows = sessions(workspaceId);
    const confirmations = rows.flatMap((row) => {
      const decision = supervisor.acceptance(row.sessionId);
      return decision && (decision.mode === 'confirm' || row.status === 'accepted')
        ? [{ sessionId: row.sessionId, summary: row.title, accepted: row.status === 'accepted' }] : [];
    });
    const questions = rows.flatMap((row) => {
      if (row.status !== 'waiting_user') return [];
      const history = conversationStore.getPersistedConversationHistory(row.conversationId)?.messages || [];
      return history.flatMap((message) => (message.segments || []).flatMap((segment) => {
        if (segment.tool !== 'request_user_input' || !segment.args) return [];
        const args = segment.args;
        return [{ sessionId: row.sessionId, questionId: segment.toolCallId || message.id,
          prompt: args.question || args.prompt,
          options: (args.options || []).map((option) => typeof option === 'string' ? option : option.label),
        }];
      })).slice(-1);
    });
    const unavailable = messages.filter((message) => message.card === 'agent_unavailable').map((message) => ({
      turnId: message.turnId, reason: message.content?.replace(/^代理暂时不可用：/, ''),
    }));
    return projection.project(workspaceId, { approvals: approvalStore.list({ workspaceId }),
      confirmations, questions, replies, readmeOffer: profile?.readmeOffer, unavailable });
  }
  return { delivery, cards, resolve: (workspaceId, cardId) => projection.resolve(workspaceId, cardId, { resolution: 'retried' }) };
}
