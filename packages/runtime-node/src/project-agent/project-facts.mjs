import { createCardProjection, replyQuestionAnswered } from './card-projection.mjs';
import { verdictRefFor } from './acceptance.mjs';

/** Project facts shared by reply validation and cards; model payloads never supply verdicts. */
export function createDesktopProjectFacts({ supervisor, approvalStore, profileStore, conversationStore, runtimeRoot, memoryStore = null, objectiveProposals=()=>[] }) {
  const projection = createCardProjection({ rootDir: runtimeRoot });
  function sessions(workspaceId) { return supervisor.sessionsForProject(workspaceId); }
  function delivery(workspaceId) {
    const rows = sessions(workspaceId);
    const profile = profileStore.read(workspaceId);
    const messages = conversationStore.getPersistedConversationHistory(profile?.agentConversationId)?.messages || [];
    return {
      reportedMessages: messages.filter(message => message.kind === 'agent_reply'),
      sessionIds: rows.map((row) => row.sessionId),
      sessionStates: rows.map((row) => ({ sessionId: row.sessionId, status: row.status, sourceRevision: row.sourceRevision })),
      unreportedResults: rows.filter(row => row.status === 'result_ready'
        && !messages.some(message => message.kind === 'agent_reply' && message.sources?.includes(row.sessionId)
          && message.meta?.sessionStates?.some(state => state.sessionId === row.sessionId
            && state.sourceRevision === row.sourceRevision && ['result_ready', 'accepted'].includes(state.status))))
        .map(row => ({sessionId:row.sessionId,anchorMessageId:row.origin?.anchorMessageId})),
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
        answered: replyQuestionAnswered(messages, message) } } : {}),
    }));
    const rows = sessions(workspaceId);
    const confirmations = rows.flatMap((row) => {
      const decision = supervisor.acceptance(row.sessionId);
      return decision && (row.status === 'result_ready' && decision.mode === 'confirm' || row.status === 'accepted')
        ? [{ sessionId: row.sessionId, summary: row.title, accepted: row.status === 'accepted' }] : [];
    });
    const completionReviews = rows.flatMap(row => {
      const review = supervisor.completionReview?.(row.sessionId);
      return review ? [{ ...review, title: row.title }] : [];
    });
    const questions = rows.flatMap((row) => {
      if (row.status !== 'waiting_user') return [];
      if (['dependency_failed', 'dependency_missing'].includes(row.queueReason)) {
        const questionId = 'dependency';
        const answerTo = `card:question:${row.sessionId}:${questionId}`;
        return [{ sessionId: row.sessionId, questionId,
          prompt: `「${row.title}」的前置任务未成功签收。要取消还是重新安排？`,
          options: ['取消这个任务', '重新安排任务'],
          answered: messages.some(answer => answer.answerTo === answerTo),
        }];
      }
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
      superseded: messages.slice(messages.indexOf(message) + 1).some(later => later.role === 'assistant' && later.kind === 'agent_turn'),
    }));
    const stopped = messages.filter(message => message.card === 'agent_stopped').map(message => ({
      turnId: message.turnId, text: message.content,
      superseded: messages.slice(messages.indexOf(message) + 1).some(later => later.kind === 'agent_turn'),
    }));
    return projection.project(workspaceId, { approvals: approvalStore.list({ workspaceId }),
      objectiveProposals:objectiveProposals(workspaceId), confirmations, completionReviews, questions, replies, readmeOffer: profile?.readmeOffer, unavailable, stopped,
      memories: memoryStore?.list({ workspaceId }) || [],
      handoffs: rows.flatMap(row => { const facts = supervisor.deliveryFacts?.(row.sessionId); return facts ? [facts] : []; }) });
  }
  return { delivery, cards, resolve: (workspaceId, cardId) => projection.resolve(workspaceId, cardId, { resolution: 'retried' }) };
}
