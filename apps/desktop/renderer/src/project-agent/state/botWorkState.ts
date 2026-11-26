import { WORK_SESSION_STATUSES, type WorkSessionStatus } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotChatMessage } from './botConversationState';
import type { BotConversationViewRow } from './botReplyContinuity';
import { formatDrawerSessionStatus, type DrawerSession } from './drawerState.ts';

export interface BotWorkIndex {
  readonly byId: ReadonlyMap<string, DrawerSession>;
  readonly byAnchor: ReadonlyMap<string, readonly string[]>;
  readonly available: boolean;
}
export function indexBotWork(sessions: readonly DrawerSession[], available: boolean): BotWorkIndex {
  const byId = new Map(sessions.map(session => [session.sessionId, session]));
  const byAnchor = new Map<string, string[]>();
  for (const session of sessions) {
    if (!session.anchorMessageId) continue;
    const ids = byAnchor.get(session.anchorMessageId) ?? [];
    ids.push(session.sessionId); byAnchor.set(session.anchorMessageId, ids);
  }
  return { byId, byAnchor, available };
}
export interface BotWorkRow { readonly id: string; readonly session?: DrawerSession; readonly status: WorkSessionStatus | null }
/** Public task references retain the host state recorded with the reply, even after later task changes. */
export function replyTaskReferences(messages: readonly Pick<BotChatMessage, 'kind' | 'sources' | 'meta'>[], index: BotWorkIndex): BotWorkRow[] {
  const references = new Map<string, BotWorkRow>();
  for (const message of messages) {
    if (message.kind !== 'agent_reply') continue;
    for (const id of message.sources) {
      const state = message.meta?.sessionStates?.find(state => state.sessionId === id);
      const status = state && WORK_SESSION_STATUSES.some(status => status === state.status) ? state.status : null;
      references.set(id, { id, session: index.byId.get(id), status });
    }
  }
  return [...references.values()].slice(0, 100);
}

function spawnedSessionIdOfResult(result: unknown): string {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return '';
  const record = result as Readonly<Record<string, unknown>>;
  if (typeof record.sessionId === 'string' && record.sessionId.trim()) return record.sessionId.trim();
  const nested = record.output;
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const sid = (nested as Readonly<Record<string, unknown>>).sessionId;
    if (typeof sid === 'string' && sid.trim()) return sid.trim();
  }
  return '';
}

/**
 * Live task references for a continuous reply row:
 * - Delivered `agent_reply` rows keep their explicit host-authored `sources` (always preferring live `workIndex` status when displayed).
 * - In-flight / waiting rows (before an `agent_reply` commits, e.g. right after `spawn_session` or during `wait_for_sessions`)
 *   immediately project sessions spawned in this turn or anchored to the current user input so delegated work is never invisible in the thread.
 */
export function liveReplyTaskReferences(
  reply: {
    readonly messages: readonly Pick<BotChatMessage, 'kind' | 'sources' | 'meta' | 'rounds'>[];
    readonly replyTo: readonly string[];
    readonly message?: Pick<BotChatMessage, 'kind'>;
  },
  index: BotWorkIndex,
): BotWorkRow[] {
  const base = replyTaskReferences(reply.messages, index);
  if (reply.message?.kind === 'agent_reply') return base;
  const references = new Map<string, BotWorkRow>(base.map(row => [row.id, row]));
  const addLive = (id: string) => {
    if (!id || references.has(id)) return;
    const session = index.available ? index.byId.get(id) : undefined;
    const status = session && WORK_SESSION_STATUSES.some(known => known === session.status)
      ? session.status as WorkSessionStatus : null;
    references.set(id, { id, session, status });
  };
  for (const message of reply.messages) {
    if (message.kind !== 'agent_turn') continue;
    for (const round of message.rounds) {
      for (const call of round.toolCalls) {
        if (call.name !== 'spawn_session') continue;
        addLive(spawnedSessionIdOfResult(call.result));
      }
    }
  }
  if (index.available) {
    for (const anchorId of reply.replyTo) {
      for (const id of index.byAnchor.get(anchorId) ?? []) addLive(id);
    }
  }
  return [...references.values()].slice(0, 100);
}

/** Keep each task in its first reply carrier in the loaded thread, including while that task resumes. */
export function threadTaskReferences(rows: readonly BotConversationViewRow[], index: BotWorkIndex): ReadonlyMap<BotConversationViewRow, readonly BotWorkRow[]> {
  const byRow = new Map<BotConversationViewRow, BotWorkRow[]>();
  const claimed = new Set<string>();
  for (const row of rows) {
    const candidates = row.type === 'reply' ? liveReplyTaskReferences(row, index)
      : row.type === 'message' && row.message.kind === 'agent_reply' ? replyTaskReferences([row.message], index) : [];
    const unclaimed = candidates.filter(task => !claimed.has(task.id));
    if (unclaimed.length === 0) continue;
    for (const task of unclaimed) claimed.add(task.id);
    byRow.set(row, unclaimed);
  }
  return byRow;
}

export function canCancelTask(status: string | null, cancelable?: boolean): boolean {
  // 生命周期决策给出的 cancelable 优先；缺字段时才退回状态表，避免出现第二套规则。
  if (typeof cancelable === 'boolean') return cancelable;
  return ['starting', 'queued', 'running', 'waiting_user', 'waiting_agent', 'verifying', 'paused'].includes(status ?? '');
}
/** A worker's report summary is not the current verification phase. */
export function workProgress(row: BotWorkRow, i18n: Pick<I18nRuntime, 't'>): string {
  if (!row.status || !row.session) return i18n.t('projectAgent.chat.work.unavailableHint');
  if (row.status === 'cancelled') return i18n.t('projectAgent.chat.sessionState.cancelled');
  if (['stopping','awaiting_outcome'].includes(row.status) || row.session.coordination?.phase === 'stopping') return formatDrawerSessionStatus(row.session,i18n);
  if (row.status === 'verifying') return i18n.t('projectAgent.chat.work.verifyingHint');
  return row.session.summary || (formatDrawerSessionStatus(row.session, i18n) !== row.status
    ? formatDrawerSessionStatus(row.session, i18n) : i18n.t(`projectAgent.chat.sessionState.${row.status}`));
}
const FOLLOW_UP = ['waiting_user', 'waiting_agent', 'result_ready', 'running', 'starting', 'stopping', 'awaiting_outcome', 'verifying', 'queued'] as const;
/** Attention first; the compact surface is bounded while its count stays factual. */
export function backgroundWork(index: BotWorkIndex): { count: number; rows: BotWorkRow[] } {
  if (!index.available) return { count: 0, rows: [] };
  const sessions = [...index.byId.values()].filter(session =>
    session.followUp ? session.followUp.inCurrentList : FOLLOW_UP.some(status => status === session.status));
  // 未列入兜底表的状态（如 failed / 事实缺失）仍可能按宿主判定进列表：排在已知状态之后，
  // 不能因 findIndex 返回 -1 反而顶到最前，破坏「attention first」。
  const rank = (status: string) => {
    const position = FOLLOW_UP.findIndex(value => value === status);
    return position < 0 ? FOLLOW_UP.length : position;
  };
  sessions.sort((a, b) => rank(a.status) - rank(b.status));
  return { count: sessions.length, rows: sessions.slice(0, 100).map(session => ({ id: session.sessionId, session, status: session.status as WorkSessionStatus })) };
}
/** Associate only structured references or the host's input anchor; never infer work from prose. */
export function replyWork(message: Pick<BotChatMessage, 'sources' | 'marks' | 'meta' | 'replyTo'>, index: BotWorkIndex): BotWorkRow[] {
  const ids = new Set([...message.sources, ...message.marks.flatMap(mark => mark.sessionId ? [mark.sessionId] : []),
    ...(message.meta.sessionStates ?? []).map(state => state.sessionId),
    ...message.replyTo.flatMap(id => index.byAnchor.get(id) ?? [])]);
  return [...ids].slice(0, 100).map(id => {
    const session = index.byId.get(id);
    return { id, session, status: index.available && session && WORK_SESSION_STATUSES.some(status => status === session.status) ? session.status as WorkSessionStatus : null };
  });
}
