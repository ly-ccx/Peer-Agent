import type { BotChatCard, BotChatMessage } from './botConversationState';
import { replyWork, type BotWorkIndex } from './botWorkState.ts';

export interface TaskConversationContext {
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly messageId: string;
  readonly content: string;
  readonly createdAt: string;
  readonly question: BotChatCard | null;
}

export interface TaskConversationRequest {
  readonly id: number;
  readonly messageId?: string;
  readonly cardId?: string;
  readonly draft?: string;
  readonly taskTitle?: string;
}

/** Only host references associate work and replies. Prose and report goals are never progress facts. */
export function taskConversationContext(workspaceId: string, sessionId: string | null,
  messages: readonly BotChatMessage[], work: BotWorkIndex): TaskConversationContext | null {
  if (!sessionId) return null;
  const related = messages.filter(message => ['agent_reply', 'system_card'].includes(message.kind)
    && (replyWork(message, work).some(row => row.id === sessionId)
      || message.cards.some(card => card.refs?.sessionId === sessionId
        || card.actions?.some(action => action.payload?.sessionId === sessionId))));
  const questionForTask = (message: BotChatMessage, card: BotChatCard) => {
    if (!isOpenQuestion(card)) return false;
    const explicit = [card.refs?.sessionId, ...(card.actions ?? []).map(action => action.payload?.sessionId)]
      .filter((id): id is string => typeof id === 'string' && Boolean(id));
    if (explicit.length) return explicit.includes(sessionId);
    const sessions = replyWork(message, work).filter(row => row.session || row.id === sessionId);
    return sessions.length === 1 && sessions[0].id === sessionId;
  };
  const questionMessage = [...related].reverse().find(message => message.cards.some(card => questionForTask(message, card)));
  const message = questionMessage ?? related.at(-1);
  if (!message) return null;
  return { workspaceId, sessionId, messageId: message.id, content: message.content, createdAt: message.createdAt,
    question: questionMessage?.cards.find(card => questionForTask(questionMessage, card)) ?? null };
}

function isOpenQuestion(card: BotChatCard): boolean {
  return card.kind === 'question' && card.resolvedState !== 'resolved' && Boolean(card.actions?.length);
}
