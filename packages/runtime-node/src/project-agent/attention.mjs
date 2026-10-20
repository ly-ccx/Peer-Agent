import { projectReplyQuestions } from './question-lifecycle.mjs';
import { projectCards } from './card-projection.mjs';

/** Count and detail share these identities. No task execution, authorization, or history writes. */
export function projectBotAttention({ profile, messages = [], sessions = [], approvals = [], confirmations = [], cards: projectedCards = [], now = Date.now() }) {
  const workspaceId = profile.workspaceId;
  const questionStates = projectReplyQuestions(messages, now);
  const replies = messages.filter(m => questionStates.get(m.id)?.state === 'open');
  const currentSessions = new Map(sessions.map(s => [s.sessionId, s]));
  const pendingApprovals = approvals.filter(a => ['open', 'stale'].includes(a.state)
    && a.kind !== 'image_read_grant' && !['accepted', 'cancelled', 'failed', 'superseded'].includes(currentSessions.get(a.sessionId)?.status) && (!a.deadlineAt || !(Date.parse(a.deadlineAt) <= now)));
  const pendingSessions = new Set(pendingApprovals.map(a => a.sessionId).filter(Boolean));
  const pendingConfirmations = confirmations.filter(c => c.accepted !== true && c.needsConfirm !== false
    && !pendingSessions.has(c.sessionId) && !['accepted', 'cancelled', 'failed', 'superseded'].includes(currentSessions.get(c.sessionId)?.status));
  for (const session of sessions) if (session.status === 'result_ready' && (session.resultConfirmationRequired ?? profile.acceptancePolicy === 'confirm')
    && !pendingSessions.has(session.sessionId) && !pendingConfirmations.some(c => c.sessionId === session.sessionId)) {
    pendingConfirmations.push({ sessionId: session.sessionId, summary: session.title });
  }
  const taskQuestions = projectedCards.filter(card => card.kind === 'question' && card.refs?.sessionId && !card.refs.replyMessageId
    && !['accepted', 'cancelled', 'failed', 'superseded'].includes(currentSessions.get(card.refs.sessionId)?.status));
  const cards = [...projectCards(workspaceId, { replies, approvals: pendingApprovals, confirmations: pendingConfirmations }), ...taskQuestions];
  const items = cards.filter(card => card.resolvedState !== 'resolved' && card.actions?.length).map(card => {
    const message = replies.find(m => m.id === card.refs?.replyMessageId);
    const approval = pendingApprovals.find(a => a.approvalId === card.refs?.approvalId);
    return { id: card.cardId, workspaceId, botName: profile.displayName,
      kind: card.kind === 'question' ? 'question' : card.kind === 'confirm_result' ? 'confirmation' : 'approval',
      title: String(message?.question?.prompt || message?.questionContext || message?.content || card.content).slice(0, 2000),
      ...(message?.createdAt || approval?.createdAt ? { createdAt: message?.createdAt || approval?.createdAt } : {}),
      ...(message?.question?.expiresAt || approval?.deadlineAt ? { expiresAt: message?.question?.expiresAt || approval?.deadlineAt } : {}),
      ...(message ? { messageId: message.id } : {}),
      ...(card.refs?.sessionId ? { sessionId: card.refs.sessionId } : {}), card };
  });
  for (const session of sessions) if (session.completionReviewRequired && !pendingSessions.has(session.sessionId)) {
    items.push({ id: `completion:${session.sessionId}`, workspaceId, botName: profile.displayName,
      kind: 'confirmation', title: session.title, sessionId: session.sessionId });
  }
  return [...new Map(items.map(item => [item.id, item])).values()];
}
