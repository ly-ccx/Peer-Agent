import { WORK_SESSION_STATUSES, type WorkSessionStatus } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';
import type { BotChatMessage } from './botConversationState';
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
