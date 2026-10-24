/**
 * 档案抽屉的纯状态。打开、定位和布局不碰 IPC。
 * 设置写入由调用方只经已有 IPC 发出。
 */

import type { CoordinationSessionFacts, SessionVerificationDetail, VerificationProgress } from '@peer-agent/protocol';
import type { I18nRuntime } from '@peer-agent/i18n';

export const DRAWER_WIDTH = 380;
export const DRAWER_PUSH_MIN_WIDTH = 960;

/** 档案抽屉可拖拽宽度的上下限。
 *  下限保证设置/任务表单不被挤成两行；上限在 960 最小 push 窗口下仍给中间
 *  会话区留下可用宽度（960 - 520 = 440px），不把会话压没。 */
export const DRAWER_MIN_WIDTH = 320;
export const DRAWER_MAX_WIDTH = 520;

export function clampDrawerWidth(width: number): number {
  if (!Number.isFinite(width)) return DRAWER_WIDTH;
  return Math.min(DRAWER_MAX_WIDTH, Math.max(DRAWER_MIN_WIDTH, Math.round(width)));
}

export type DrawerTab = 'overview' | 'tasks' | 'objectives' | 'memory' | 'settings';
export type DrawerLayout = 'push' | 'cover';
export type TaskGroup = 'needsYou' | 'running' | 'queued' | 'paused' | 'done';

export interface DrawerMemory {
  readonly open: boolean;
  readonly tab: DrawerTab;
  readonly sessionId: string | null;
  readonly objectiveId?: string;
  /** 用户拖拽后的面板宽度。缺省表示从未拖过，回落到 CSS 的 --pa-drawer-width。 */
  readonly width?: number;
}

export interface DrawerStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

export interface DrawerSession {
  readonly sourceRevision?: string;
  readonly observationRevision?: string;
  readonly verification?: SessionVerificationDetail;
  readonly verificationProgress?: VerificationProgress;
  readonly coordination?: CoordinationSessionFacts;
  readonly sessionId: string;
  readonly title: string;
  readonly status: string;
  readonly statusLabel: string;
  /** 生命周期决策给出的可取消事实；缺省时 renderer 才退回状态表。 */
  readonly cancelable?: boolean;
  readonly spawnedAt: string;
  readonly conversationId: string;
  readonly anchorMessageId: string;
  readonly objectiveId?: string;
  readonly modelLabel: string;
  readonly summary: string;
  readonly evidenceRefs: readonly string[];
  readonly progress: string;
  readonly queuedBehind?: readonly { readonly sessionId: string; readonly title: string }[];
  readonly queueReason?: string;
  readonly supersededBy?: string;
}

export interface DrawerMemoryItem {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly trust?: string;
  readonly status?: string;
  readonly pinned?: boolean;
}

export interface MemoryRecord {
  readonly id: string;
  readonly kind: string;
  readonly text: string;
  readonly trust: string;
  readonly status: string;
  readonly pinned: boolean;
  readonly needsReverify?: boolean;
  readonly sourceRefs?: readonly string[];
}

export interface MemorySwitches {
  readonly memoryEnabled: boolean;
  readonly useMemory: boolean;
  readonly learnPreferences: boolean;
}

export interface MemoryFilter {
  readonly kind: string;
  readonly trust: string;
  readonly status: string;
}

const TABS = new Set<DrawerTab>(['overview', 'tasks', 'objectives', 'memory', 'settings']);
const NEEDS_YOU = new Set(['waiting_user', 'result_ready']);
const RUNNING = new Set(['starting', 'running', 'waiting_agent', 'stopping', 'awaiting_outcome', 'verifying']);
const QUEUED = new Set(['queued']);

export function closedDrawer(): DrawerMemory {
  return { open: false, tab: 'overview', sessionId: null };
}

export function drawerLayout(windowWidth: number): DrawerLayout {
  return windowWidth >= DRAWER_PUSH_MIN_WIDTH ? 'push' : 'cover';
}

/** 档案列表里的时间：当天只显示时分，同年带月日，跨年再带年份。不展示原始 ISO。 */
export function formatDrawerStamp(iso: string, now = Date.now()): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return '';
  const date = new Date(parsed);
  const today = new Date(now);
  const clock = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth()
    && date.getDate() === today.getDate();
  if (sameDay) return clock;
  const day = `${date.getMonth() + 1}/${date.getDate()}`;
  if (date.getFullYear() === today.getFullYear()) return `${day} ${clock}`;
  return `${date.getFullYear()}/${day} ${clock}`;
}

export function drawerStorageKey(workspaceId: string): string {
  return `peer.projectAgent.drawer.${workspaceId}`;
}

export function openDrawer(memory: DrawerMemory, tab?: DrawerTab): DrawerMemory {
  return { ...memory, open: true, tab: tab ?? memory.tab };
}

export function closeDrawer(memory: DrawerMemory): DrawerMemory {
  return { ...memory, open: false };
}

export function selectDrawerTab(memory: DrawerMemory, tab: DrawerTab): DrawerMemory {
  return { ...memory, open: true, tab };
}

/** 拖拽落定宽度。只写合法值，避免把 NaN / 越界宽度带进持久化。 */
export function resizeDrawer(memory: DrawerMemory, width: number): DrawerMemory {
  if (!Number.isFinite(width)) return memory;
  return { ...memory, width: clampDrawerWidth(width) };
}

/** 点「来源」时打开档案，停在任务页并选中这条任务。 */
export function locateDrawerSession(memory: DrawerMemory, sessionId: string): DrawerMemory {
  const id = sessionId.trim();
  return { open: true, tab: 'tasks', sessionId: id || null };
}

export function readDrawerMemory(workspaceId: string, store: DrawerStore): DrawerMemory {
  const raw = store.get(drawerStorageKey(workspaceId));
  if (!raw) return closedDrawer();
  try {
    const parsed = JSON.parse(raw) as Partial<DrawerMemory>;
    const tab = TABS.has(parsed.tab as DrawerTab) ? parsed.tab as DrawerTab : 'overview';
    const rawWidth = (parsed as { width?: unknown }).width;
    const width = typeof rawWidth === 'number' && Number.isFinite(rawWidth)
      ? clampDrawerWidth(rawWidth)
      : undefined;
    return {
      open: false,
      tab,
      sessionId: null,
      ...(width === undefined ? {} : {width}),
    };
  } catch {
    return closedDrawer();
  }
}

export function writeDrawerMemory(workspaceId: string, memory: DrawerMemory, store: DrawerStore): void {
  // Opening and task/objective navigation belong to the current interaction.
  store.set(drawerStorageKey(workspaceId), JSON.stringify({
    tab: memory.tab,
    ...(memory.width === undefined ? {} : { width: memory.width }),
  }));
}

export function taskGroup(status: string): TaskGroup {
  if (NEEDS_YOU.has(status)) return 'needsYou';
  if (RUNNING.has(status)) return 'running';
  if (QUEUED.has(status)) return 'queued';
  if (status === 'paused' || status === 'superseded') return 'paused';
  return 'done';
}

export function groupDrawerSessions(sessions: readonly DrawerSession[]): Record<TaskGroup, DrawerSession[]> {
  const groups: Record<TaskGroup, DrawerSession[]> = {
    needsYou: [],
    running: [],
    queued: [],
    paused: [],
    done: [],
  };
  for (const session of sessions) groups[taskGroup(session.status)].push(session);
  return groups;
}

export function formatDrawerSessionStatus(session: DrawerSession, i18n: Pick<I18nRuntime, 't'>): string {
  if (['stopping','awaiting_outcome'].includes(session.status)) return i18n.t(`projectAgent.chat.sessionState.${session.status}` as 'projectAgent.chat.sessionState.stopping' | 'projectAgent.chat.sessionState.awaiting_outcome');
  if (session.coordination?.action === 'handoff' && session.coordination.phase === 'stopping') return i18n.t('projectAgent.task.coordination.handoff');
  if (session.queueReason === 'dependency_missing') return i18n.t('projectAgent.drawer.dependencyMissing');
  if (session.queueReason === 'disk_space') return i18n.t('projectAgent.drawer.diskSpace');
  if (session.queueReason === 'isolation_failed') return i18n.t('projectAgent.drawer.isolationFailed');
  return session.queuedBehind?.length
    ? i18n.t(session.queueReason === 'dependency_failed'
      ? 'projectAgent.drawer.dependencyFailed' : 'projectAgent.drawer.queuedBehind',
      { tasks: session.queuedBehind.map(item => item.title).join(', ') })
    : session.statusLabel || session.status;
}

export function readDrawerSession(raw: unknown): DrawerSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const sessionId = readString(record.sessionId);
  if (!sessionId) return null;
  const origin = record.origin && typeof record.origin === 'object'
    ? record.origin as Record<string, unknown>
    : {};
  const report = record.report && typeof record.report === 'object'
    ? record.report as Record<string, unknown>
    : {};
  const verification = readVerification(report.verification, sessionId);
  const progress = record.verificationProgress as VerificationProgress | undefined;
  const validProgress = progress && typeof progress.continuationId === 'string'
    && Number.isSafeInteger(progress.observationCount) && progress.observationCount >= 0
    && Number.isFinite(Date.parse(progress.startedAt)) && Number.isFinite(Date.parse(progress.lastProgressAt))
    && ['ready', 'requesting', 'tools', 'completed'].includes(progress.phase);
  return {
    sessionId,
    sourceRevision: readString(record.sourceRevision),
    observationRevision: readString(record.observationRevision),
    ...(verification ? { verification } : {}),
    ...(validProgress ? { verificationProgress: progress } : {}),
    ...(readCoordination(record.coordination) ? {coordination:readCoordination(record.coordination)} : {}),
    title: readString(record.title) || sessionId,
    status: readString(record.status),
    statusLabel: readString(record.statusLabel),
    ...(typeof record.cancelable === 'boolean' ? {cancelable:record.cancelable} : {}),
    spawnedAt: readString(record.spawnedAt),
    conversationId: readString(record.conversationId),
    anchorMessageId: readString(origin.anchorMessageId),
    ...(readString(origin.objectiveId) ? {objectiveId:readString(origin.objectiveId)} : {}),
    modelLabel: frozenModelLabel(origin.modelSelection),
    // This drawer field is the task instruction disclosure. Worker output now
    // has a distinct source; it must not be relabeled as task instructions.
    summary: readString(report.taskBrief) || (report.contentSource ? '' : readString(report.summary)),
    evidenceRefs: readStringList(report.evidenceRefs),
    progress: readString(record.statusLabel),
    queueReason: readString(record.queueReason),
    supersededBy: readString(record.supersededBy),
    queuedBehind: Array.isArray(record.queuedBehind) ? record.queuedBehind.flatMap(item => {
      if (!item || typeof item !== 'object') return [];
      const row = item as Record<string, unknown>;
      const id = readString(row.sessionId);
      return id ? [{ sessionId: id, title: readString(row.title) || id }] : [];
    }) : [],
  };
}

export function readMemoryItems(raw: unknown): DrawerMemoryItem[] {
  return readMemoryRecords(raw)
    .filter((item) => item.status === 'active' && !item.needsReverify)
    .map((item) => ({
      id: item.id,
      kind: item.kind,
      text: item.text,
      trust: item.trust,
      status: item.status,
      pinned: item.pinned,
    }));
}

export function readMemoryRecords(raw: unknown): MemoryRecord[] {
  if (!Array.isArray(raw)) return [];
  const items: MemoryRecord[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    const id = readString(record.id);
    const text = readString(record.text);
    if (!id || !text) continue;
    items.push({
      id,
      kind: readString(record.kind) || 'fact',
      text,
      trust: readString(record.trust) || 'stated',
      status: readString(record.status) || 'active',
      pinned: record.pinned === true,
      needsReverify: record.needsReverify === true,
      sourceRefs: readStringList(record.sourceRefs),
    });
  }
  return items;
}

export function readMemorySwitches(raw: unknown): MemorySwitches {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    memoryEnabled: record.memoryEnabled !== false,
    useMemory: record.useMemory !== false,
    learnPreferences: record.learnPreferences !== false,
  };
}

export function filterMemoryRecords(items: readonly MemoryRecord[], filter: MemoryFilter): MemoryRecord[] {
  return items.filter((item) => {
    if (filter.kind && item.kind !== filter.kind) return false;
    if (filter.trust && item.trust !== filter.trust) return false;
    if (filter.status && item.status !== filter.status) return false;
    return true;
  });
}

export function conversationModelLabel(preview: unknown): string {
  if (!preview || typeof preview !== 'object') return '';
  const resolutions = (preview as { resolutions?: unknown }).resolutions;
  if (!Array.isArray(resolutions)) return '';
  for (const row of resolutions) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (record.role !== 'project_agent') continue;
    return readString(record.label);
  }
  return '';
}

export function briefFromMemories(items: readonly DrawerMemoryItem[]): string {
  const pinned = items.find((item) => item.kind === 'responsibility') ?? items[0];
  return pinned?.text ?? '';
}

function frozenModelLabel(selection: unknown): string {
  if (!selection || typeof selection !== 'object') return '';
  const worker = (selection as { worker?: unknown }).worker;
  if (!worker || typeof worker !== 'object') return '';
  const record = worker as Record<string, unknown>;
  return readString(record.modelId) || readString(record.modelProviderId);
}

function readStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim());
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readVerification(value: unknown, sessionId: string): SessionVerificationDetail | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row = value as SessionVerificationDetail;
  if (row.sessionId !== sessionId || !['passed', 'failed', 'partial', 'unverifiable'].includes(row.outcome)
    || !Array.isArray(row.checks) || !Array.isArray(row.reviewAttempts) || !Array.isArray(row.outputs)) return undefined;
  return { ...row, checks: row.checks.filter(check => check && typeof check.name === 'string'
    && ['passed', 'failed'].includes(check.result) && Array.isArray(check.evidenceRefs)),
    reviewAttempts: row.reviewAttempts.filter(attempt => attempt && typeof attempt.verifierRunId === 'string'
      && typeof attempt.failureReason === 'string' && Array.isArray(attempt.failedCriteria) && Array.isArray(attempt.missingEvidence)),
    outputs: row.outputs.filter(output => output && typeof output.evidenceRef === 'string' && typeof output.summary === 'string') };
}

function readCoordination(value: unknown): CoordinationSessionFacts | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const row=value as Record<string,unknown>;
  const action=['parallel','augment','revise','query','answer','cancel','replace','handoff'].find(item=>item===row.action);
  const phase=['recorded','stopping','awaiting_outcome','ready','started','completed','blocked'].find(item=>item===row.phase);
  if (!action || !phase || !readString(row.operationId) || !Number.isSafeInteger(row.goalRevision)) return undefined;
  return {operationId:readString(row.operationId), action:action as CoordinationSessionFacts['action'], phase:phase as CoordinationSessionFacts['phase'],
    goalRevision:row.goalRevision as number, reason:readString(row.reason), priorSessionId:readString(row.priorSessionId),
    replacementSessionId:readString(row.replacementSessionId), replacementTitle:readString(row.replacementTitle)};
}
