/**
 * Bot list projection. Sort is recent activity only.
 * needsYou changes the badge and the filter, not the order.
 */

import type { ProjectModelPolicy } from './model-routing.ts';
import type { PendingApprovalState, WorkSessionStatus } from './delegation.ts';

export interface DiagnosticText { readonly length: number; readonly sha256: string }
export interface ProjectAgentDiagnosticTiming {
  readonly startedAt: string; readonly finishedAt: string; readonly durationMs: number;
  readonly outcome: 'done' | 'error' | 'preempted';
}
export interface ProjectDiagnostics {
  readonly schemaVersion: 1; readonly generatedAt: string | null; readonly errors: readonly string[];
  readonly scheduler: {
    readonly stats: { readonly active: number | null; readonly waiting: number | null; readonly limit: number | null };
    readonly queue: readonly { readonly workspace: DiagnosticText | null; readonly plan: DiagnosticText | null; readonly priority: string; readonly enqueuedAt: string | null }[];
    readonly projects: readonly { readonly workspace: DiagnosticText | null; readonly slots: { readonly read: number | null; readonly write: number | null; readonly isolated: number | null };
      readonly queue: readonly { readonly session: DiagnosticText | null; readonly priority: string; readonly enqueuedAt: string | null; readonly reason: string | null }[] }[];
  } | null;
  readonly bots: readonly {
    readonly identity: DiagnosticText | null; readonly workspace: '.'; readonly errors: readonly string[];
    readonly lease: { readonly holder: DiagnosticText | null; readonly surface: string; readonly pid: number | null; readonly acquiredAt: string | null; readonly heartbeatAt: string | null } | null;
    readonly input: { readonly depth: number | null; readonly executionDepth: number | null; readonly cursor: DiagnosticText | null; readonly executedCursor: DiagnosticText | null } | null;
    readonly inbox: { readonly cursor: number | null; readonly events: readonly { readonly identity: DiagnosticText | null; readonly seq: number | null; readonly at: string | null; readonly kind: string }[] } | null;
    readonly approvals: readonly { readonly identity: DiagnosticText | null; readonly state: 'open' | 'stale'; readonly capability: DiagnosticText | null; readonly summary: DiagnosticText | null; readonly at: string | null }[];
    readonly objectives: readonly { readonly identity: DiagnosticText | null; readonly status: string; readonly autonomy: string;
      readonly watches: readonly { readonly identity: DiagnosticText | null; readonly kind: string; readonly source: string; readonly paths: readonly string[];
        readonly lastObservationAt: string | null; readonly nextRunAt: string | null; readonly pending: boolean; readonly unavailable: boolean }[] }[];
    readonly turns: readonly { readonly identity: DiagnosticText | null; readonly startedAt: string | null; readonly finishedAt: string | null; readonly durationMs: number | null; readonly outcome: string }[];
  }[];
}
export type ProjectDiagnosticsRequest = { readonly action: 'read' | 'export' };
export type ProjectDiagnosticsResult =
  | { readonly ok: true; readonly report: ProjectDiagnostics; readonly saved?: boolean; readonly cancelled?: boolean }
  | { readonly ok: false; readonly code: 'INVALID_INPUT' | 'DIAGNOSTICS_UNAVAILABLE' | 'DIAGNOSTICS_SAVE_FAILED' };

export interface ProjectRegistryEntry {
  readonly workspaceId: string;
  readonly path: string;
  readonly realPath: string;
  readonly createdAt: string;
  readonly previousPaths: readonly string[];
  readonly remoteAlias?: string;
}

export interface ProjectHostTakeoverRequest {
  readonly workspaceId: string;
}

export type ProjectHostTakeoverResult =
  | { readonly ok: true; readonly requested: boolean; readonly alreadyHost?: boolean }
  | { readonly ok: false; readonly code: 'PROJECT_AGENT_DISABLED' | 'NOT_FOUND' | 'HOST_UNAVAILABLE' | 'INVALID_INPUT' };

export type BotAvatar =
  | { readonly kind: 'generated'; readonly shape: string; readonly color: string; readonly variant?: number }
  | { readonly kind: 'image'; readonly ref: string };

export type BotAvatarReadResult =
  | { readonly ok: true; readonly dataUrl: string }
  | { readonly ok: false; readonly code: 'PROJECT_AGENT_DISABLED' | 'NOT_FOUND' | 'INVALID_IMAGE' };

export interface BotProfile {
  readonly workspaceId: string;
  readonly displayName: string;
  readonly avatar: BotAvatar;
  readonly managed?: boolean;
  readonly agentConversationId?: string;
  readonly proactivity?: 'inherit' | 'quiet' | 'low' | 'standard' | 'high' | 'muted';
  /** Absent means this bot uses memory. */
  readonly memoryEnabled?: boolean;
  readonly planApproval?: 'never' | 'writes' | 'always';
  readonly acceptancePolicy?: 'auto' | 'confirm';
  /** Policy acceptance keeps a separate merge confirmation unless explicitly enabled. */
  readonly autoHandoffOnPolicyAccept?: boolean;
  /** Archived deletion intent, retained until each cleanup step is persisted. */
  readonly deletionCleanup?: { readonly folder: string; readonly trashPending: boolean; readonly removePending: boolean } | null;
  readonly modelPolicy?: ProjectModelPolicy | null;
  readonly updatedAt?: string;
}

export interface BotRowState {
  readonly needsYou: number;
  readonly unread: number;
  readonly running: number;
  /** Ephemeral status of the runner hosted by this desktop process. */
  readonly agentStatus?: 'idle' | 'thinking' | 'waiting_provider' | 'error';
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

/** Bounded, redacted display preview; never an execution or Evidence object. */
export interface ProjectAgentToolPreview {
  readonly text: string;
  readonly truncated: boolean;
  readonly redacted: boolean;
}

export interface ProjectAgentToolActivity {
  readonly kind: 'tool';
  readonly id: string;
  readonly name: string;
  readonly status: 'preparing' | 'running' | 'done' | 'error' | 'stopped';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly input?: ProjectAgentToolPreview;
  readonly result?: ProjectAgentToolPreview;
  readonly receivedChars?: number;
}

/** Ephemeral user-turn presentation. No hidden reasoning or Evidence. */
export interface ProjectAgentActivity {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly turnId: string;
  readonly revision: number;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly modelSelection?: Pick<import('./model-routing.ts').RuntimeModelSelection, 'modelProviderId' | 'reasoningEffort'>;
  readonly replyTo: readonly string[];
  readonly phase: 'waiting' | 'thinking' | 'responding' | 'tool' | 'settling' | 'done' | 'error' | 'stopped' | 'disposed';
  readonly replyText: string;
  readonly segments: readonly (
    | { readonly kind: 'text'; readonly id: string; readonly text: string }
    | ProjectAgentToolActivity
  )[];
}

export interface ProjectAgentStopResponseRequest {
  readonly workspaceId: string;
  readonly turnId: string;
}
export type ProjectAgentStopResponseResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'PROJECT_AGENT_DISABLED' | 'NOT_FOUND' | 'HOST_OFFLINE' | 'STALE_TURN' | 'INVALID_INPUT' };

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
  /** silent replies stay in the conversation and do not raise the unread badge. */
  readonly countUnread?: boolean;
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
  '#6474e5',
  '#f36d63',
  '#f4ad45',
  '#61b68c',
  '#a884e5',
  '#e774ad',
  '#55bac7',
  '#a8a59f',
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

export function generateAvatar(workspaceId: string): Extract<BotAvatar, { kind: 'generated' }> {
  const hash = fnv1a(workspaceId);
  const shape = BOT_AVATAR_SHAPES[hash % BOT_AVATAR_SHAPES.length] ?? BOT_AVATAR_SHAPES[0];
  const color = BOT_AVATAR_COLORS[(hash >>> 16) % BOT_AVATAR_COLORS.length] ?? BOT_AVATAR_COLORS[0];
  const variant = (hash >>> 8) % 32;
  return { kind: 'generated', shape, color, variant };
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
  const unread = lastMessage
    && lastMessage.role === 'assistant'
    && lastMessage.countUnread !== false
    && (!input.readCursor || lastMessage.at > input.readCursor)
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
