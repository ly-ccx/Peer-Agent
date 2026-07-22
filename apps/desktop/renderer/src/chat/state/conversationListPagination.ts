export interface ConversationListPage<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
  readonly hasMore: boolean;
}

export type ConversationListResponse<T> =
  | readonly T[]
  | {
      readonly items?: readonly T[];
      readonly nextCursor?: string | null;
      readonly hasMore?: boolean;
    };

/**
 * Keep the list and its pagination metadata in one normalized result.
 * A legacy array response cannot prove that another page exists, so it must not
 * make the sidebar offer a speculative "Load more" action.
 */
export function normalizeConversationListPage<T>(
  response: ConversationListResponse<T>,
): ConversationListPage<T> {
  if (Array.isArray(response)) {
    return {
      items: response,
      nextCursor: null,
      hasMore: false,
    };
  }

  const page = response as Exclude<ConversationListResponse<T>, readonly T[]>;
  const nextCursor = page.nextCursor ?? null;
  return {
    items: page.items ?? [],
    nextCursor,
    hasMore: page.hasMore === true && Boolean(nextCursor),
  };
}

export function shouldShowConversationLoadMore(params: {
  readonly conversationCount: number;
  readonly hasMore: boolean;
  readonly nextCursor?: string | null;
}): boolean {
  return params.conversationCount > 0
    && params.hasMore
    && Boolean(params.nextCursor);
}
