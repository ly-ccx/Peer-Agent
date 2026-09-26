/**
 * Bot list projection. Sort is recent activity only.
 * needsYou changes the badge and the filter, not the order.
 */

import type { PendingApprovalState, WorkSessionStatus } from './delegation.ts';

export interface ProjectRegistryEntry {
  readonly workspaceId: string;
  readonly path: string;
  readonly realPath: string;
  readonly createdAt: string;
  readonly previousPaths: readonly string[];
  readonly remoteAlias?: string;
}

export type BotAvatar =
  | { readonly kind: 'generated'; readonly shape: string; readonly color: string }
  | { readonly kind: 'image'; readonly ref: string };

export interface BotProfile {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly avatar: BotAvatar;
  readonly managed?: boolean;
  readonly agentConversationId?: string;
  readonly updatedAt?: string;
}

export interface BotRowState {
  readonly needsYou: number;
  readonly unread: number;
  readonly running: number;
}

export interface BotListItem {
  readonly workspaceId: string;
  readonly profile: BotProfile;
  readonly preview: string;
  readonly lastActiveAt: string;
  readonly state: BotRowState;
}

export interface BotListFilter {
  readonly query?: string;
  readonly needsYouOnly?: boolean;
}

export interface BotListSession {
  readonly status: WorkSessionStatus;
  readonly updatedAt?: string;
}

export interface BotListApproval {
  readonly state: PendingApprovalState;
}

export interface BotListMessage {
  readonly role: 'user' | 'assistant';
  readonly text: string;
  readonly at: string;
}

export const BOT_AVATAR_SHAPES = [
  'circle',
  'square',
  'triangle',
  'diamond',
  'hex',
  'pill',
  'star',
  'arch',
] as const;

export const BOT_AVATAR_COLORS = [
  '#2563eb',
  '#dc2626',
  '#d97706',
  '#059669',
  '#7c3aed',
  '#db2777',
  '#0891b2',
  '#4b5563',
] as const;

const NEEDS_YOU_STATUSES = new Set<WorkSessionStatus>(['waiting_user', 'result_ready']);
const RUNNING_STATUSES = new Set<WorkSessionStatus>(['starting', 'running', 'verifying']);

function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function generateAvatar(workspaceId: string): BotAvatar {
  const hash = fnv1a(workspaceId);
  const shape = BOT_AVATAR_SHAPES[hash % BOT_AVATAR_SHAPES.length] ?? BOT_AVATAR_SHAPES[0];
  const color = BOT_AVATAR_COLORS[(hash >>> 16) % BOT_AVATAR_COLORS.length] ?? BOT_AVATAR_COLORS[0];
  return { kind: 'generated', shape, color };
}

function latestIso(values: readonly (string | undefined)[]): string {
  let best = '';
  for (const value of values) {
    if (!value) continue;
    if (!best || value > best) best = value;
  }
  return best;
}

export function projectBotListItem(input: {
  readonly profile: BotProfile;
  readonly lastMessage?: BotListMessage | null;
  readonly sessions?: readonly BotListSession[];
  readonly approvals?: readonly BotListApproval[];
  readonly readCursor?: string | null;
}): BotListItem {
  const sessions = input.sessions ?? [];
  const approvals = input.approvals ?? [];
  const openApprovals = approvals.filter((item) => item.state === 'open' || item.state === 'stale').length;
  const waitingSessions = sessions.filter((item) => NEEDS_YOU_STATUSES.has(item.status)).length;
  const running = sessions.filter((item) => RUNNING_STATUSES.has(item.status)).length;
  const lastMessage = input.lastMessage ?? null;
  const unread = lastMessage && lastMessage.role === 'assistant' && (!input.readCursor || lastMessage.at > input.readCursor)
    ? 1
    : 0;
  return {
    workspaceId: input.profile.workspaceId,
    profile: input.profile,
    preview: lastMessage?.text ?? '',
    lastActiveAt: latestIso([
      lastMessage?.at,
      input.profile.updatedAt,
      ...sessions.map((item) => item.updatedAt),
    ]),
    state: {
      needsYou: openApprovals + waitingSessions,
      unread,
      running,
    },
  };
}

function activityMs(item: BotListItem): number {
  const parsed = Date.parse(item.lastActiveAt);
  return Number.isFinite(parsed) ? parsed : 0;
}

export function sortBotList(items: readonly BotListItem[]): BotListItem[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const byTime = activityMs(right.item) - activityMs(left.item);
      if (byTime !== 0) return byTime;
      return left.index - right.index;
    })
    .map((entry) => entry.item);
}

export function filterBotList(items: readonly BotListItem[], filter: BotListFilter = {}): BotListItem[] {
  const query = filter.query?.trim().toLowerCase() ?? '';
  return items.filter((item) => {
    if (filter.needsYouOnly === true && item.state.needsYou <= 0) return false;
    if (!query) return true;
    const haystack = `${item.profile.displayName}\n${item.preview}`.toLowerCase();
    return haystack.includes(query);
  });
}
