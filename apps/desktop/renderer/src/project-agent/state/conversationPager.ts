import { CONVERSATION_PAGE_SIZE, mergeConversationPage, normalizeBotMessage, type BotChatMessage } from './botConversationState.ts';

interface Page {
  readonly ok: boolean;
  readonly messages?: readonly Record<string, unknown>[];
  readonly nextCursor?: string | null;
  readonly familiarizeOffer?: unknown;
}

/** Recent reads and older reads share one cursor owner; stopping drops late results. */
export function createConversationPager({ read, publish }: {
  readonly read: (params: { latest: true; limit: number; before?: string }) => Promise<Page>;
  readonly publish: (snapshot: { messages: readonly BotChatMessage[]; hasOlder: boolean; familiarizeOffer?: unknown }) => void;
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
    const result = await read({ latest: true, limit: CONVERSATION_PAGE_SIZE, ...(before ? { before } : {}) });
    if (stopped) return;
    if (!result?.ok) throw new Error('Conversation read failed');
    const incoming = (result.messages ?? []).flatMap(raw => {
      const message = normalizeBotMessage(raw);
      return message ? [message] : [];
    });
    messages = mergeConversationPage(messages, incoming);
    if (before || !initialized) cursor = result.nextCursor ?? null;
    initialized = true;
    publish({ messages, hasOlder: cursor !== null, ...(!before ? { familiarizeOffer: result.familiarizeOffer } : {}) });
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
