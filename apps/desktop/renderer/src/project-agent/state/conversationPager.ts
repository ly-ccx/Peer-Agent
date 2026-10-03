import { CONVERSATION_PAGE_SIZE, normalizeBotMessage, type BotChatMessage } from './botConversationState.ts';

interface Page {
  readonly ok: boolean;
  readonly messages?: readonly Record<string, unknown>[];
  readonly nextCursor?: string | null;
  readonly familiarizeOffer?: unknown;
  readonly activity?: import('@peer-agent/protocol').ProjectAgentActivity | null;
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
  const serial = (job: () => Promise<void>) => {
    const next = tail.then(async () => { if (!stopped) await job(); });
    tail = next.catch(() => {});
    return next;
  };
  const page = async (before?: string) => {
    // Projected cards without a canonical timestamp cannot prove page overlap.
    const known = new Set(messages.filter(message => message.createdAt).map(message => message.id));
    let fetched: BotChatMessage[] = [];
    let next = before;
    let first: Page | null = null;
    const visited = new Set<string>();
    // A recent refresh must bridge a burst larger than one page before publishing.
    // Keep the old snapshot and older cursor if any intermediate read fails.
    while (true) {
      const result = await read({ latest: true, limit: CONVERSATION_PAGE_SIZE, ...(next ? { before: next } : {}) });
      if (stopped) return;
      if (!result?.ok) throw new Error('Conversation read failed');
      first ??= result;
      const incoming = (result.messages ?? []).flatMap(raw => {
        const message = normalizeBotMessage(raw);
        return message ? [message] : [];
      });
      fetched = [...incoming, ...fetched];
      if (before || !initialized || !known.size || incoming.some(message => known.has(message.id)) || !result.nextCursor) break;
      if (visited.has(result.nextCursor)) throw new Error('Conversation cursor did not advance');
      visited.add(result.nextCursor);
      next = result.nextCursor;
    }
    // Direction comes from the cursor, not timestamps (which can be identical).
    const freshIds = new Set(fetched.map(message => message.id));
    const byId = new Map([...messages, ...fetched].map(message => [message.id, message]));
    const order = before ? [...fetched, ...messages] : [...messages.filter(message => !freshIds.has(message.id)), ...fetched];
    messages = [...new Set(order.map(message => message.id))].map(id => byId.get(id)!);
    if (before || !initialized || !known.size) cursor = first!.nextCursor ?? null;
    initialized = true;
    publish({ messages, hasOlder: cursor !== null, ...(!before ? { familiarizeOffer: first!.familiarizeOffer, activity: first!.activity } : {}) });
  };
  return {
    refresh: () => serial(() => page()),
    older: () => serial(async () => { if (cursor) await page(cursor); }),
    locate: (id: string) => serial(async () => {
      while (!stopped && cursor && !messages.some(message => message.id === id)) {
        const before = cursor;
        await page(before);
        if (cursor === before) throw new Error('Conversation cursor did not advance');
      }
    }),
    stop: () => { stopped = true; },
  };
}
