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
  const acknowledged = messages.filter(message => message.kind === 'user_input'
    && message.pending !== 'failed' && message.pending !== 'sending');
  const answered = new Set(acknowledged.map(message => message.answerTo).filter(Boolean));
  const lastInput = messages.indexOf(acknowledged.at(-1)!);
  return messages.map((message, index) => ({ ...message, cards: message.cards.filter(card => card.kind !== 'question'
    || !(answered.has(card.cardId) || index < lastInput && card.cardId.startsWith('card:question:reply:'))) }));
}
