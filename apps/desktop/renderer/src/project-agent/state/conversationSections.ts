import { normalizeBotMessage, type BotChatMessage } from './botConversationState.ts';

/** A card snapshot enriches public messages without owning or replacing their history. */
export function mergeConversationCards(messages: readonly BotChatMessage[], cards: readonly Record<string, unknown>[]): BotChatMessage[] {
  const byId = new Map(cards.filter(card => typeof card.cardId === 'string').map(card => [card.cardId, card]));
  const attached = new Set<string>();
  const result = messages.map(message => {
    const linked = cards.filter(card => (card.refs as { replyMessageId?: string } | undefined)?.replyMessageId === message.id);
    const combined = [...new Map([...message.cards.map(card => [card.cardId, byId.get(card.cardId) || card] as const),
      ...linked.map(card => [String(card.cardId), card] as const)]).values()];
    for (const card of combined) attached.add(String(card.cardId));
    if (JSON.stringify(combined) === JSON.stringify(message.cards)) return message;
    return normalizeBotMessage({ ...message, cards: combined }) || message;
  });
  for (const card of cards) {
    if (attached.has(String(card.cardId)) || card.resolvedState === 'resolved' || (card.refs as { replyMessageId?: string } | undefined)?.replyMessageId) continue;
    const message = normalizeBotMessage({ id: card.cardId, kind: 'system_card', role: 'assistant', content: '', cards: [card] });
    if (message) result.push(message);
  }
  return result;
}

export function statusAfterRefreshFailure(current: 'loading' | 'ready' | 'error') {
  return current === 'ready' ? 'ready' : 'error';
}
