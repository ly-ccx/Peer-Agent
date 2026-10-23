import { CONVERSATION_PAGE_SIZE, normalizeBotMessage, type BotChatMessage } from './botConversationState.ts';
import { conversationValuesEqual } from './conversationValueEquality.ts';

type DecisionSnapshot = import('@peer-agent/protocol').BotDecisionSnapshot;
interface Page extends Partial<DecisionSnapshot> {
  readonly ok: boolean;
  readonly messages?: readonly Record<string, unknown>[];
  readonly nextCursor?: string | null;
  readonly familiarizeOffer?: unknown;
  readonly activity?: import('@peer-agent/protocol').ProjectAgentActivity | null;
}

export const CONVERSATION_REFRESH_PAGE_BUDGET = 4;
export class ConversationCatchUpRequired extends Error {
  constructor() { super('CONVERSATION_CATCH_UP_REQUIRED'); }
}

/** Recent reads and older reads share one cursor owner; stopping drops late results. */
export function createConversationPager({ read, publish }: {
  readonly read: (params: { latest: true; limit: number; before?: string }) => Promise<Page>;
  readonly publish: (snapshot: { messages: readonly BotChatMessage[]; hasOlder: boolean; familiarizeOffer?: unknown; activity?: import('@peer-agent/protocol').ProjectAgentActivity | null }) => void;
}) {
  let messages: BotChatMessage[] = [];
  let cursor: string | null = null;
  let initialized = false;
  let stopped = false;
  let tail = Promise.resolve();
  let bridge: { first: Page; fetched: BotChatMessage[]; next: string; visited: Set<string>; known: Set<string> } | null = null;
  const serial = <T>(job: () => Promise<T>) => {
    const next = tail.then(async () => { if (!stopped) return await job(); });
    tail = next.then(() => {}, () => {});
    return next;
  };
  const page = async (before?: string) => {
    // Resume bounded catch-up without publishing a false gap or restarting from the tail.
    const resumed = !before && bridge !== null;
    const work = !before ? bridge : null;
    const known = work?.known ?? new Set(messages.filter(message => message.createdAt).map(message => message.id));
    const previousById = new Map(messages.map(message => [message.id, message]));
    let fetched: BotChatMessage[] = work?.fetched ?? [];
    let next = work?.next ?? before;
    let first: Page | null = work?.first ?? null;
    const visited = work?.visited ?? new Set<string>();
    let reads = 0;
    try {
      while (true) {
        const result = await read({ latest: true, limit: CONVERSATION_PAGE_SIZE, ...(next ? { before: next } : {}) });
        reads++;
        if (stopped) return;
        if (!result?.ok) throw new Error('Conversation read failed');
        first ??= result;
        const incoming = (result.messages ?? []).flatMap(raw => {
          const message = normalizeBotMessage(raw), previous = message && previousById.get(message.id);
          return message ? [previous && conversationValuesEqual(previous, message) ? previous : message] : [];
        });
        fetched = [...incoming, ...fetched];
        if (before || !initialized || !known.size || incoming.some(message => known.has(message.id)) || !result.nextCursor) break;
        if (visited.has(result.nextCursor)) throw new Error('Conversation cursor did not advance');
        visited.add(result.nextCursor); next = result.nextCursor;
        if (reads >= CONVERSATION_REFRESH_PAGE_BUDGET) {
          bridge = { first, fetched, next, visited, known };
          throw new ConversationCatchUpRequired();
        }
      }
    } catch (error) {
      if (!(error instanceof ConversationCatchUpRequired)) bridge = null;
      throw error;
    }
    if (!before) bridge = null;
    // Direction comes from the cursor, not timestamps (which can be identical).
    const freshIds = new Set(fetched.map(message => message.id));
    // Unpersisted host cards are a snapshot, not paginated chat history.
    const retained = before ? messages : messages.filter(message => !(message.kind === 'system_card'
      && !message.createdAt && message.cards.some(card => card.cardId === message.id)));
    const byId = new Map([...retained, ...fetched].map(message => [message.id, message]));
    const order = before ? [...fetched, ...retained] : [...retained.filter(message => !freshIds.has(message.id)), ...fetched];
    let nextMessages = [...new Set(order.map(message => message.id))].map(id => byId.get(id)!);
    if (!resumed && first && 'activeReplyQuestionId' in first) {
      const active = first.activeReplyQuestionId;
      nextMessages = nextMessages.map(message => {
        if (!message.cards.some(card => card.cardId.startsWith('card:question:reply:') && card.resolvedState !== 'resolved'
          && card.cardId !== `card:question:reply:${active}`)) return message;
        return { ...message, cards: message.cards.map(card => card.cardId.startsWith('card:question:reply:')
          && card.cardId !== `card:question:reply:${active}` ? { ...card, resolvedState: 'resolved' as const, actions: [], resolution: { state: 'superseded' } } : card) };
      });
    }
    if (nextMessages.length !== messages.length || nextMessages.some((message, index) => message !== messages[index])) messages = nextMessages;
    if (before || !initialized || !known.size) cursor = first!.nextCursor ?? null;
    initialized = true;
    publish({ messages, hasOlder: cursor !== null, ...(!before && !resumed ? { familiarizeOffer: first!.familiarizeOffer, activity: first!.activity } : {}) });
  };
  return {
    refresh: () => serial(() => page()),
    older: () => serial(async () => { if (cursor) await page(cursor); }),
    locate: (id: string, maxPages = CONVERSATION_REFRESH_PAGE_BUDGET, isActive: () => boolean = () => true) => serial(async () => {
      let pages = 0;
      while (!stopped && isActive() && cursor && pages++ < maxPages && !messages.some(message => message.id === id)) {
        const before = cursor;
        await page(before);
        if (cursor === before) throw new Error('Conversation cursor did not advance');
      }
      return !stopped && isActive() && messages.some(message => message.id === id);
    }),
    stop: () => { stopped = true; bridge = null; },
  };
}
