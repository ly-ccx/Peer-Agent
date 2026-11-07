import type { BotChatMessage } from './botConversationState';

/** Only conversational questions can bind a freeform composer answer. */
export function questionForInput(messages: readonly BotChatMessage[], quoteRefs: readonly string[]): string | undefined {
  const last = messages.filter(message => ['user_input', 'agent_reply'].includes(message.kind) && message.pending !== 'failed').at(-1);
  if (last?.kind !== 'agent_reply' || (quoteRefs.length && quoteRefs[0] !== last.id)) return;
  const id = `card:question:reply:${last.id}`;
  return last.cards.some(card => card.cardId === id && card.kind === 'question' && card.resolvedState !== 'resolved') ? id : undefined;
}

/** Close controls after a durable receipt, retaining their identity for the exit transition. */
export function hideAcknowledgedQuestions(messages: readonly BotChatMessage[]): readonly BotChatMessage[] {
  const acknowledged = (message: BotChatMessage) => message.kind === 'user_input'
    && (message.pending === undefined || message.pending === 'received');
  const answered = new Set(messages.filter(acknowledged).map(message => message.answerTo).filter(Boolean));
  const lastAcknowledged = messages.filter(acknowledged).at(-1);
  const lastInput = lastAcknowledged ? messages.indexOf(lastAcknowledged) : -1;
  let changed = false;
  const next = messages.map((message, index) => {
    let cardsChanged = false;
    const cards = message.cards.map(card => {
      const resolve = card.kind === 'question'
        && card.resolvedState !== 'resolved'
        && (answered.has(card.cardId) || index < lastInput && card.cardId.startsWith('card:question:reply:'));
      if (!resolve) return card;
      cardsChanged = true;
      return { ...card, resolvedState: 'resolved' as const };
    });
    if (!cardsChanged) return message;
    changed = true;
    return { ...message, cards };
  });
  return changed ? next : messages;
}
