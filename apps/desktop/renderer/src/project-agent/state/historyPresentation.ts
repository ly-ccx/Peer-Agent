export interface HistoryConversation {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

export type HistoryGroup = 'today' | 'yesterday' | 'week' | 'earlier' | 'other';
export const HISTORY_PAGE_SIZE = 40;
const DAY = 86_400_000;
const dayOf = (date: Date) => Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY;
const normalized = (value: string) => value.normalize('NFKC').toLocaleLowerCase().trim();

/** Search is limited to titles in the already loaded history; source records stay untouched. */
export function presentHistory(items: readonly HistoryConversation[], query: string, limit = HISTORY_PAGE_SIZE, now = Date.now()) {
  const terms = normalized(query).split(/\s+/).filter(Boolean);
  const today = dayOf(new Date(now));
  const matches = items.map((item, index) => ({ item, index, stamp: Date.parse(item.updatedAt) }))
    .filter(({ item }) => terms.every(term => normalized(item.title).includes(term)))
    .sort((a, b) => (Number.isFinite(b.stamp) ? b.stamp : -Infinity) - (Number.isFinite(a.stamp) ? a.stamp : -Infinity) || a.index - b.index);
  const visible = matches.slice(0, Math.max(0, Math.floor(limit)));
  const groups: { key: HistoryGroup; rows: HistoryConversation[] }[] = [];
  for (const { item, stamp } of visible) {
    const age = Number.isFinite(stamp) ? today - dayOf(new Date(stamp)) : NaN;
    const key: HistoryGroup = age === 0 ? 'today' : age === 1 ? 'yesterday' : age >= 2 && age < 7 ? 'week' : age >= 7 ? 'earlier' : 'other';
    let group = groups.find(group => group.key === key);
    if (!group) { group = { key, rows: [] }; groups.push(group); }
    group.rows.push(item);
  }
  return { groups, count: matches.length, shown: visible.length, hasMore: visible.length < matches.length };
}

export function historyTitle(item: HistoryConversation, fallback: string): string {
  const title = item.title.trim();
  return title && title !== item.id ? title : fallback;
}
