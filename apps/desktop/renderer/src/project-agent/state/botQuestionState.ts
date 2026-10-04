import type { BotChatMessage } from './botConversationState';

/** Only conversational questions can bind a freeform composer answer. */
export function questionForInput(messages: readonly BotChatMessage[], quoteRefs: readonly string[]): string | undefined {
  const last = messages.filter(message => ['user_input', 'agent_reply'].includes(message.kind) && message.pending !== 'failed').at(-1);
  if (last?.kind !== 'agent_reply' || (quoteRefs.length && quoteRefs[0] !== last.id)) return;
  const id = `card:question:reply:${last.id}`;
  return last.cards.some(card => card.cardId === id && card.kind === 'question' && card.resolvedState !== 'resolved') ? id : undefined;
}

/** Hide the controls after a durable receipt; host card resolution remains authoritative. */
export function hideAcknowledgedQuestions(messages: readonly BotChatMessage[]): BotChatMessage[] {
  const answered = new Set(messages.filter(message => message.kind === 'user_input'
    && message.pending !== 'failed' && message.pending !== 'sending' && message.answerTo).map(message => message.answerTo));
  return messages.map(message => ({ ...message, cards: message.cards.filter(card => card.kind !== 'question' || !answered.has(card.cardId)) }));
}
