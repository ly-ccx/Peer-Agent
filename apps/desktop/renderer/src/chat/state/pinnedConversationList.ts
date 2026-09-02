export type PinnedConversationMeta = {
  readonly id: string;
  readonly title: string;
  readonly workspacePath?: string | null;
  readonly pinnedAt?: string | null;
  readonly pinnedOrder?: number | null;
  readonly updatedAt?: string;
  readonly messageCount?: number;
};

function isPinned(item: { pinnedAt?: string | null }): boolean {
  return Boolean(item.pinnedAt);
}

export function sortPinnedConversations<T extends {
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  updatedAt?: string;
}>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const order = Number(a.pinnedOrder ?? 0) - Number(b.pinnedOrder ?? 0);
    if (order !== 0) return order;
    return String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? ''));
  });
}

export function selectPinnedConversations<T extends {
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  updatedAt?: string;
}>(items: readonly T[]): T[] {
  return sortPinnedConversations(items.filter(isPinned));
}

export function mergePinnedSectionConversations<T extends {
  id: string;
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  updatedAt?: string;
}>(cachedPinned: readonly T[], currentConversations: readonly T[]): T[] {
  const byId = new Map<string, T>();
  for (const conv of cachedPinned) byId.set(conv.id, conv);
  // Current list is newer: keep still-pinned chats, and drop chats that are now unpinned
  // so a stale global pin cache cannot put them back into the pinned section.
  for (const conv of currentConversations) {
    if (isPinned(conv)) byId.set(conv.id, conv);
    else byId.delete(conv.id);
  }
  return selectPinnedConversations([...byId.values()]);
}

export function toPinnedConversationMeta(item: {
  id: string;
  title: string;
  workspacePath?: string | null;
  pinnedAt?: string | null;
  pinnedOrder?: number | null;
  updatedAt?: string;
  messageCount?: number;
}): PinnedConversationMeta {
  return {
    id: item.id,
    title: item.title,
    workspacePath: item.workspacePath ?? null,
    pinnedAt: item.pinnedAt ?? null,
    pinnedOrder: item.pinnedOrder ?? null,
    updatedAt: item.updatedAt ?? '',
    messageCount: Number(item.messageCount ?? 0),
  };
}
