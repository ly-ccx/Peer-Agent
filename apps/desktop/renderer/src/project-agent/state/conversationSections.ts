import { normalizeBotMessage, type BotChatMessage } from './botConversationState.ts';

const isReplyAttemptCard = (card: Readonly<Record<string, unknown>>) => card.kind === 'agent_unavailable' || card.kind === 'agent_stopped';

/** A card snapshot enriches public messages without owning or replacing their history. */
export function mergeConversationCards(messages: readonly BotChatMessage[], cards: readonly Record<string, unknown>[]): BotChatMessage[] {
  const byId = new Map(cards.filter(card => typeof card.cardId === 'string').map(card => [card.cardId, card]));
  const attached = new Set<string>();
  const result = messages.map(message => {
    const linked = cards.filter(card => {
      const refs = card.refs as { replyMessageId?: string; turnId?: string } | undefined;
      return refs?.replyMessageId === message.id || isReplyAttemptCard(card) && message.kind === 'system_card'
        && Boolean(message.turnId) && refs?.turnId === message.turnId
        && (!message.cards.length || message.cards.some(existing => existing.kind === card.kind));
    });
    const combined = [...new Map([...message.cards.map(card => [card.cardId, byId.get(card.cardId) || card] as const),
      ...linked.map(card => [String(card.cardId), card] as const)]).values()];
    for (const card of combined) attached.add(String(card.cardId));
    if (JSON.stringify(combined) === JSON.stringify(message.cards)) return message;
    return normalizeBotMessage({ ...message, cards: combined }) || message;
  });
  for (const card of cards) {
    // Recovery belongs to its persisted attempt in the paged timeline. An open
    // historical failure is not a new failure of the latest successful reply.
    if (isReplyAttemptCard(card)) continue;
    if (attached.has(String(card.cardId)) || card.resolvedState === 'resolved' || (card.refs as { replyMessageId?: string } | undefined)?.replyMessageId) continue;
    const message = normalizeBotMessage({ id: card.cardId, kind: 'system_card', role: 'assistant', content: '', cards: [card] });
    if (message) result.push(message);
  }
  return result;
}

export function statusAfterRefreshFailure(current: 'loading' | 'ready' | 'error') {
  return current === 'ready' ? 'ready' : 'error';
}
