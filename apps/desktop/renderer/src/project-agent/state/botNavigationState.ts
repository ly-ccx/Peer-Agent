/**
 * 桌面端壳层导航与侧栏任务投影（ADR 134）。
 * 严守 ADR 110 / 124：活跃/历史边界唯一消费宿主 followUp.inCurrentList，
 * 隐藏 obligation_indexed，不在前端另建第二套状态过滤白名单。
 */
import type { BotListItem, BotListSession, FollowUpProjection } from '@peer-agent/protocol';
import type { DrawerSession } from './drawerState';

export type ShellView =
  | { readonly kind: 'bot'; readonly workspaceId: string }
  | { readonly kind: 'task'; readonly workspaceId: string; readonly sessionId: string };

export interface NavigationState {
  readonly stack: readonly ShellView[];
  readonly index: number;
  readonly sidebarCollapsed: boolean;
  readonly expandedBots: Readonly<Record<string, boolean>>;
  readonly expandedMoreBots: Readonly<Record<string, boolean>>;
}

export interface SidebarTaskEntry {
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly updatedAt: string;
  readonly followUp?: FollowUpProjection;
  readonly phaseLabel?: string;
  readonly anchorMessageId?: string;
  readonly planId?: string;
}

const MAX_STACK = 50;
const LEGACY_TERMINAL = new Set(['accepted', 'cancelled', 'failed', 'superseded', 'paused']);

export function initialNavigationState(workspaceId: string | null = null): NavigationState {
  if (!workspaceId) {
    return {
      stack: [],
      index: -1,
      sidebarCollapsed: false,
      expandedBots: {},
      expandedMoreBots: {},
    };
  }
  return {
    stack: [{ kind: 'bot', workspaceId }],
    index: 0,
    sidebarCollapsed: false,
    expandedBots: { [workspaceId]: true },
    expandedMoreBots: {},
  };
}

export function currentNavigationView(state: NavigationState): ShellView | null {
  if (state.index < 0 || state.index >= state.stack.length) return null;
  return state.stack[state.index] ?? null;
}

export function viewsEqual(a: ShellView | null, b: ShellView | null): boolean {
  if (!a || !b) return a === b;
  if (a.kind !== b.kind || a.workspaceId !== b.workspaceId) return false;
  return a.kind === 'bot' ? true : b.kind === 'task' && a.sessionId === b.sessionId;
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0;
}

export function canGoForward(state: NavigationState): boolean {
  return state.index >= 0 && state.index < state.stack.length - 1;
}

export function navigateTo(state: NavigationState, next: ShellView): NavigationState {
  const current = currentNavigationView(state);
  const expandedBots = { ...state.expandedBots, [next.workspaceId]: true };
  if (viewsEqual(current, next)) {
    return { ...state, expandedBots };
  }
  const head = state.index >= 0 ? state.stack.slice(0, state.index + 1) : [];
  const appended = [...head, next];
  const trimmed = appended.length > MAX_STACK ? appended.slice(appended.length - MAX_STACK) : appended;
  return {
    ...state,
    stack: trimmed,
    index: trimmed.length - 1,
    expandedBots,
  };
}

export function navigateBack(state: NavigationState): NavigationState {
  if (!canGoBack(state)) return state;
  const nextIndex = state.index - 1;
  const target = state.stack[nextIndex];
  return {
    ...state,
    index: nextIndex,
    expandedBots: target ? { ...state.expandedBots, [target.workspaceId]: true } : state.expandedBots,
  };
}

export function navigateForward(state: NavigationState): NavigationState {
  if (!canGoForward(state)) return state;
  const nextIndex = state.index + 1;
  const target = state.stack[nextIndex];
  return {
    ...state,
    index: nextIndex,
    expandedBots: target ? { ...state.expandedBots, [target.workspaceId]: true } : state.expandedBots,
  };
}

export function toggleBotExpanded(state: NavigationState, workspaceId: string): NavigationState {
  const currentlyExpanded = state.expandedBots[workspaceId] === true;
  return {
    ...state,
    expandedBots: { ...state.expandedBots, [workspaceId]: !currentlyExpanded },
  };
}

export function toggleBotMoreTasks(state: NavigationState, workspaceId: string): NavigationState {
  return {
    ...state,
    expandedMoreBots: {
      ...state.expandedMoreBots,
      [workspaceId]: !state.expandedMoreBots[workspaceId],
    },
  };
}

export function toggleSidebarCollapsed(state: NavigationState, collapsed?: boolean): NavigationState {
  return {
    ...state,
    sidebarCollapsed: collapsed ?? !state.sidebarCollapsed,
  };
}

export function pruneDeletedWorkspace(state: NavigationState, deletedWorkspaceId: string): NavigationState {
  const remaining: ShellView[] = [];
  let nextIndex = state.index;
  state.stack.forEach((entry, idx) => {
    if (entry.workspaceId === deletedWorkspaceId) {
      if (idx <= state.index) nextIndex -= 1;
      return;
    }
    remaining.push(entry);
  });
  const clamped = remaining.length === 0 ? -1 : Math.max(0, Math.min(remaining.length - 1, nextIndex));
  const { [deletedWorkspaceId]: _e, ...expandedBots } = state.expandedBots;
  const { [deletedWorkspaceId]: _m, ...expandedMoreBots } = state.expandedMoreBots;
  return { ...state, stack: remaining, index: clamped, expandedBots, expandedMoreBots };
}

export function isSessionInCurrentList(status: string, followUp?: FollowUpProjection): boolean | null {
  if (followUp) {
    if (followUp.reason === 'obligation_indexed') return null;
    return followUp.inCurrentList;
  }
  return !LEGACY_TERMINAL.has(status);
}

export function sessionAttentionRank(status: string, followUp?: FollowUpProjection): number {
  if (followUp?.owner === 'user') return 0;
  if (followUp?.reason === 'verification_failed') return 1;
  switch (status) {
    case 'waiting_user': return 0;
    case 'failed': return 1;
    case 'result_ready': return 2;
    case 'verifying': return 3;
    case 'running':
    case 'starting': return 4;
    case 'waiting_agent':
    case 'stopping':
    case 'awaiting_outcome': return 5;
    case 'queued': return 6;
    default: return 7;
  }
}

function fromBotListSession(session: BotListSession): SidebarTaskEntry | null {
  if (!session.sessionId) return null;
  return {
    sessionId: session.sessionId,
    title: session.title || session.sessionId,
    status: session.status,
    updatedAt: session.updatedAt || '',
    followUp: session.followUp,
    phaseLabel: session.phaseLabel,
    anchorMessageId: session.anchorMessageId,
    planId: session.planId,
  };
}

function fromDrawerSession(session: DrawerSession): SidebarTaskEntry {
  return {
    sessionId: session.sessionId,
    title: session.title || session.sessionId,
    status: session.status,
    updatedAt: session.spawnedAt || '',
    followUp: session.followUp,
    phaseLabel: session.statusLabel,
    anchorMessageId: session.anchorMessageId || undefined,
    planId: session.planId,
  };
}

/**
 * 合并当前打开 Bot 的实时 work.sessions 与目录投影的 activeSessions，
 * 让展开中的非当前 Bot 零额外 IPC 即可显示活跃任务，而当前 Bot 实时反映最新事件。
 */
export function sidebarActiveSessionsOf(
  item: BotListItem,
  liveSessions?: readonly DrawerSession[] | null,
): { readonly items: readonly SidebarTaskEntry[]; readonly total: number } {
  if (liveSessions) {
    const active = liveSessions
      .filter(session => isSessionInCurrentList(session.status, session.followUp) === true)
      .map(fromDrawerSession)
      .sort((a, b) => {
        const rankDiff = sessionAttentionRank(a.status, a.followUp) - sessionAttentionRank(b.status, b.followUp);
        if (rankDiff !== 0) return rankDiff;
        return (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0);
      });
    return { items: active, total: active.length };
  }
  const fromCatalog = (item.activeSessions ?? [])
    .map(fromBotListSession)
    .filter((row): row is SidebarTaskEntry => row !== null && isSessionInCurrentList(row.status, row.followUp) === true);
  return {
    items: fromCatalog,
    total: Math.max(fromCatalog.length, item.activeSessionTotal ?? 0),
  };
}

export function historyTotalOf(
  item: BotListItem | null | undefined,
  liveSessions?: readonly DrawerSession[] | null,
): number {
  const fromCatalog = item?.historySessionTotal ?? 0;
  if (!liveSessions) return fromCatalog;
  const fromLive = liveSessions.filter(session => isSessionInCurrentList(session.status, session.followUp) === false).length;
  return Math.max(fromCatalog, fromLive);
}

export interface TouchBarActiveSummary {
  readonly total: number;
  readonly leadTone: 'idle' | 'warn' | 'danger' | 'azure' | 'muted';
  readonly leadSpinning: boolean;
  readonly segments: readonly string[];
}

export function summarizeActiveSessions(
  sessions: readonly Pick<SidebarTaskEntry, 'status' | 'followUp'>[],
  isZh: boolean,
): TouchBarActiveSummary {
  const total = sessions.length;
  if (total === 0) {
    return { total: 0, leadTone: 'idle', leadSpinning: false, segments: [] };
  }
  let needsUser = 0;
  let verifyFailed = 0;
  let execFailed = 0;
  let verifying = 0;
  let running = 0;
  let queued = 0;
  for (const s of sessions) {
    if (s.followUp?.owner === 'user' || s.status === 'waiting_user') needsUser += 1;
    else if (s.status === 'result_ready' && s.followUp?.reason === 'verification_failed') verifyFailed += 1;
    else if (s.status === 'failed') execFailed += 1;
    else if (s.status === 'verifying' || (s.status === 'result_ready' && s.followUp?.owner === 'bot')) verifying += 1;
    else if (s.status === 'queued') queued += 1;
    else running += 1;
  }
  const segments: string[] = [];
  let leadTone: TouchBarActiveSummary['leadTone'] = 'muted';
  let leadSpinning = false;
  if (needsUser > 0) {
    segments.push(isZh ? `待你决定 ${needsUser}` : `Needs you ${needsUser}`);
    leadTone = 'warn';
  }
  if (verifyFailed > 0) {
    segments.push(isZh ? `核验未通过 ${verifyFailed}` : `Verify failed ${verifyFailed}`);
    if (leadTone === 'muted') leadTone = 'danger';
  }
  if (execFailed > 0) {
    segments.push(isZh ? `执行失败 ${execFailed}` : `Failed ${execFailed}`);
    if (leadTone === 'muted') leadTone = 'danger';
  }
  if (running > 0) {
    segments.push(isZh ? `执行中 ${running}` : `Running ${running}`);
    if (leadTone === 'muted') { leadTone = 'azure'; leadSpinning = true; }
  }
  if (verifying > 0) {
    segments.push(isZh ? `核验中 ${verifying}` : `Verifying ${verifying}`);
    if (leadTone === 'muted') { leadTone = 'azure'; leadSpinning = true; }
  }
  if (queued > 0 && segments.length < 2) {
    segments.push(isZh ? `排队中 ${queued}` : `Queued ${queued}`);
  }
  return { total, leadTone, leadSpinning, segments: segments.slice(0, 2) };
}

export type RecencyBucketKey = 'today' | 'week' | 'earlier';

export function recencyBucketOf(iso: string, now = Date.now()): RecencyBucketKey {
  const ts = Date.parse(iso);
  if (!Number.isFinite(ts)) return 'earlier';
  const target = new Date(ts);
  const current = new Date(now);
  const sameDay = target.getFullYear() === current.getFullYear()
    && target.getMonth() === current.getMonth()
    && target.getDate() === current.getDate();
  if (sameDay) return 'today';
  const diffDays = (now - ts) / (24 * 60 * 60 * 1000);
  if (diffDays >= 0 && diffDays < 7) return 'week';
  return 'earlier';
}
