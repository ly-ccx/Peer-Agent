import { useState } from 'react';
import type { BotChatCard } from '../state/botConversationState';

/** A host may remove an answered card before the presentation finishes closing it. */
export function useCardPresence(cards: readonly BotChatCard[]) {
  const [state, setState] = useState({ source: cards, visible: cards.filter(card => card.kind !== 'question' || card.resolvedState !== 'resolved') });
  let visible = state.visible;
  if (state.source !== cards) {
    visible = cards.filter(card => card.kind !== 'question' || card.resolvedState !== 'resolved'
      || state.visible.some(previous => previous.cardId === card.cardId));
    visible = [...visible, ...state.visible.filter(card => card.kind === 'question'
      && !cards.some(next => next.cardId === card.cardId)).map(card => ({ ...card, resolvedState: 'resolved' as const }))];
    setState({ source: cards, visible });
  }
  return { visible, close: (cardId: string) => setState(current => ({ ...current,
    visible: current.visible.filter(card => card.cardId !== cardId) })) };
}
