import type { TaskOverviewItem } from '@peer-agent/protocol';

export type InboxConversationTone = 'needs_you' | 'paused' | 'result_ready';

export type InboxConversationCard = {
  readonly key: string;
  readonly conversationId?: string;
  readonly title: string;
  readonly tone: InboxConversationTone;
  readonly actionLabel: string;
  readonly itemCount: number;
  readonly latestItem: TaskOverviewItem;
  readonly items: readonly TaskOverviewItem[];
};

const TONE_RANK: Record<InboxConversationTone, number> = {
  needs_you: 0,
  paused: 1,
  result_ready: 2,
};

function conversationKey(item: TaskOverviewItem): string {
  const conversationId = item.conversationId?.trim();
  if (conversationId) return `conversation:${conversationId}`;
  return `item:${item.taskId}`;
}

function toneOf(item: TaskOverviewItem): InboxConversationTone {
  if (item.actionRight === 'needs_you') return 'needs_you';
  if (item.actionRight === 'paused') return 'paused';
  return 'result_ready';
}

function latestTimestamp(item: TaskOverviewItem): number {
  const raw = item.lastActiveAt ?? item.completedAt ?? item.startedAt;
  if (!raw) return 0;
  const value = Date.parse(raw);
  return Number.isFinite(value) ? value : 0;
}

function pickTitle(items: readonly TaskOverviewItem[]): string {
  const named = items.find((item) => item.title.trim().length > 0);
  return named?.title.trim() || '未命名任务';
}

function pickActionLabel(tone: InboxConversationTone, items: readonly TaskOverviewItem[]): string {
  const match = items.find((item) => toneOf(item) === tone) ?? items[0];
  if (tone === 'needs_you') return match?.actionLabel || '去处理';
  if (tone === 'paused') return match?.actionLabel || '继续';
  return '打开任务';
}

export function groupInboxByConversation(
  items: readonly TaskOverviewItem[],
): InboxConversationCard[] {
  const buckets = new Map<string, TaskOverviewItem[]>();
  for (const item of items) {
    const key = conversationKey(item);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(item);
    else buckets.set(key, [item]);
  }

  const cards: InboxConversationCard[] = [];
  for (const [key, bucket] of buckets) {
    const sorted = [...bucket].sort((a, b) => latestTimestamp(b) - latestTimestamp(a));
    const tones = new Set(sorted.map(toneOf));
    const tone: InboxConversationTone = tones.has('needs_you')
      ? 'needs_you'
      : tones.has('paused')
        ? 'paused'
        : 'result_ready';
    const representative = sorted.find((item) => toneOf(item) === tone) ?? sorted[0]!;
    cards.push({
      key,
      conversationId: representative.conversationId,
      title: pickTitle(sorted),
      tone,
      actionLabel: pickActionLabel(tone, sorted),
      itemCount: sorted.length,
      latestItem: representative,
      items: sorted,
    });
  }

  return cards.sort((a, b) => {
    const toneDelta = TONE_RANK[a.tone] - TONE_RANK[b.tone];
    if (toneDelta !== 0) return toneDelta;
    return latestTimestamp(b.latestItem) - latestTimestamp(a.latestItem);
  });
}
