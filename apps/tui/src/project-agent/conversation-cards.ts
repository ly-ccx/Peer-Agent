/** Live card projections replace persisted snapshots without rewriting the transcript. */
export function projectConversationCards(messages: readonly any[], cards: readonly any[]) {
  const current = new Map(cards.map(card => [card.cardId, card]));
  const attached = new Set<string>();
  const projected = messages.map(message => {
    const rows = new Map<string, any>((message.cards ?? []).map((card: any) => [card.cardId, current.get(card.cardId) ?? card]));
    for (const card of cards) {
      if (card.refs?.replyMessageId === message.id
        || message.kind === 'system_card' && message.turnId && card.refs?.turnId === message.turnId && card.kind === message.card) {
        rows.set(card.cardId, card);
      }
    }
    if (!rows.size) return message;
    for (const id of rows.keys()) attached.add(id);
    return { ...message, cards: [...rows.values()] };
  });
  for (const card of cards) {
    if (card.resolvedState === 'resolved' || attached.has(card.cardId)) continue;
    projected.push({ id: card.cardId, role: 'assistant', kind: 'system_card', content: '', cards: [card] });
    attached.add(card.cardId);
  }
  return projected;
}
