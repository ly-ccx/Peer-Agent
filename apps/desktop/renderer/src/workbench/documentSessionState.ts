import { deliveryBindingKey, normalizeDeliveryBinding } from './deliveryBindingState.ts';
import { resourceEditToken, normalizeResourceWindowNavigation, type BotDocumentReference, type EvidenceDeliveryBinding, type LocalDocumentObservation, type ResourceWindowNavigation } from '@peer-agent/protocol';
import { normalizeDocumentObservation } from './documentObservationState.ts';
import { documentRevisionKey, normalizeDocumentRevision } from './documentRevisionState.ts';
export type WorkbenchFileMode = 'preview' | 'source' | 'diff';
export interface DocumentReadPosition { readonly top: number; readonly left: number }
export type DocumentReadPositions = Readonly<Record<string, DocumentReadPosition>>;

export function normalizeDocumentReadPositions(raw: unknown): DocumentReadPositions {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return Object.fromEntries(Object.entries(raw).filter(([key, point]) => {
    if (!/^(sha256:[a-f0-9]{64}:(preview|source)|diff:(working|staged))$/.test(key) || !point || typeof point !== 'object') return false;
    const value = point as DocumentReadPosition;
    return [value.top, value.left].every(coordinate => typeof coordinate === 'number' && Number.isFinite(coordinate) && coordinate >= 0 && coordinate <= 10_000_000);
  }).slice(-12).map(([key, point]) => [key, { top: (point as DocumentReadPosition).top, left: (point as DocumentReadPosition).left }]));
}

export interface DocumentNavigation { readonly line: number; readonly requestId: string }
export interface DocumentComparison { readonly fromRef: string; readonly toRef?: string; readonly comparison?: 'working' | 'staged' }

export function normalizeDocumentComparison(raw: unknown): DocumentComparison | undefined {
  if (!raw || typeof raw !== 'object') return;
  const value = raw as Record<string, unknown>;
  if (value.comparison === 'working' || value.comparison === 'staged') return { fromRef: 'HEAD', comparison: value.comparison };
  if (value.comparison !== undefined) return;
  const sha = (ref: unknown): ref is string => typeof ref === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(ref);
  if (!sha(value.fromRef) || value.toRef !== undefined && !sha(value.toRef)) return;
  return { fromRef: value.fromRef, ...(value.toRef ? { toRef: value.toRef as string } : {}) };
}

export function documentComparisonLabel(value: DocumentComparison, isZh = false): string {
  return value.comparison === 'working' ? (isZh ? 'Diff · 暂存区 → 工作树' : 'Diff · Index → Working tree')
    : value.comparison === 'staged' ? (isZh ? 'Diff · HEAD → 暂存区' : 'Diff · HEAD → Index')
      : `Diff · ${value.fromRef.slice(0, 8)} → ${value.toRef?.slice(0, 8) ?? (isZh ? '工作树' : 'Working tree')}`;
}

function documentNavigation(line: unknown, requestId: string): DocumentNavigation | undefined {
  return typeof line === 'number' && Number.isSafeInteger(line) && line > 0 && line <= 1_000_000 ? { line, requestId } : undefined;
}

export interface DocumentTabSession {
  readonly id: string;
  readonly absPath: string;
  readonly workspaceRoot?: string;
  /** 原始相对路径（解析前），用于主进程跨已知 workspace 回退查找。 */
  readonly relPath?: string;
  readonly mode: WorkbenchFileMode;
  readonly reference?: BotDocumentReference;
  readonly navigation?: DocumentNavigation;
  readonly comparison?: DocumentComparison;
  readonly draftId?: string;
  readonly delivery?: EvidenceDeliveryBinding;
  readonly observation?: LocalDocumentObservation;
  readonly readingPositions?: DocumentReadPositions;
  readonly resourceReading?: ResourceWindowNavigation;
}

export interface DocumentSessionState {
  readonly tabs: readonly DocumentTabSession[];
  readonly activeTabId: string | null;
}

export type DocumentSessionMap = Record<string, DocumentSessionState>;

let fallbackId = 0;

export function createDocumentTabId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  fallbackId += 1;
  return `document-tab-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function createDocumentTabSession(
  absPath: string,
  options: {
    readonly id?: string;
    readonly workspaceRoot?: string;
    readonly relPath?: string;
    readonly mode?: WorkbenchFileMode;
    readonly reference?: BotDocumentReference;
    readonly line?: number;
    readonly draftId?: string;
    readonly delivery?: EvidenceDeliveryBinding;
    readonly comparison?: DocumentComparison;
  } = {},
): DocumentTabSession {
  const id = options.id ?? createDocumentTabId();
  const navigation = documentNavigation(options.line, id);
  const comparison = normalizeDocumentComparison(options.comparison);
  return {
    id,
    absPath,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.relPath ? { relPath: options.relPath } : {}),
    mode: options.mode ?? 'preview',
    ...(options.reference ? { reference: options.reference } : {}),
    ...(options.draftId !== undefined ? { draftId: options.draftId, mode: 'source' as const } : {}),
    ...(options.delivery ? { delivery: options.delivery } : {}),
    ...(navigation ? { navigation } : {}),
    ...(comparison ? { comparison } : {}),
  };
}

export function createDocumentSessionState(): DocumentSessionState {
  return { tabs: [], activeTabId: null };
}

function isDocumentMode(value: unknown): value is WorkbenchFileMode {
  return value === 'preview' || value === 'source' || value === 'diff';
}

export function normalizeDocumentTask(value: unknown): BotDocumentReference['task'] | null {
  if (!value || typeof value !== 'object') return null;
  const task = value as Record<string, unknown>;
  const valid = (id: unknown): id is string => typeof id === 'string' && !!id.trim() && id.length <= 256 && !/[\u0000-\u001f]/.test(id);
  return valid(task.sessionId) && valid(task.planId) ? { sessionId: task.sessionId, planId: task.planId } : null;
}

function normalizeDocumentTab(raw: unknown): DocumentTabSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const tab = raw as Record<string, unknown>;
  if (typeof tab.id !== 'string' || !tab.id.trim()) return null;
  if (typeof tab.absPath !== 'string' || !tab.absPath.trim()) return null;
  const rawNavigation = tab.navigation && typeof tab.navigation === 'object' ? tab.navigation as Record<string, unknown> : undefined;
  // The same normalizer runs on live reducer updates and persisted restoration.
  // Replacing every intent ID with the tab ID loses repeated clicks on one file.
  const requestId = typeof rawNavigation?.requestId === 'string' && rawNavigation.requestId.trim()
    && rawNavigation.requestId.length <= 128 && !/[\u0000-\u001f]/.test(rawNavigation.requestId)
    ? rawNavigation.requestId : `restored:${tab.id}`;
  const navigation = documentNavigation(rawNavigation?.line, requestId);
  const comparison = normalizeDocumentComparison(tab.comparison);
  if (tab.comparison !== undefined && !comparison) return null;
  const resourceReading = tab.resourceReading === undefined ? undefined : normalizeResourceWindowNavigation(tab.resourceReading, 'comparison');
  if (tab.resourceReading !== undefined && (!comparison || !resourceReading)) return null;
  const draftId = tab.draftId;
  if (draftId !== undefined && (!resourceEditToken(draftId) || comparison || tab.delivery !== undefined
    || (tab.reference as BotDocumentReference | undefined)?.revision || (tab.reference as BotDocumentReference | undefined)?.relativeTo
    || (tab.reference as BotDocumentReference | undefined)?.kind === 'directory'
    || typeof (tab.reference as BotDocumentReference | undefined)?.workspaceId !== 'string'
    || (tab.reference as BotDocumentReference | undefined)?.path !== tab.absPath
    || !/^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(tab.absPath) || tab.mode === 'diff')) return null;
  const delivery = normalizeDeliveryBinding(tab.delivery);
  if (tab.delivery !== undefined && (!delivery || comparison || (tab.reference as BotDocumentReference | undefined)?.revision
    || (tab.reference as BotDocumentReference | undefined)?.kind === 'directory'
    || typeof (tab.reference as BotDocumentReference | undefined)?.workspaceId !== 'string'
    || typeof (tab.reference as BotDocumentReference | undefined)?.path !== 'string')) return null;
  const rawTask = (tab.reference as BotDocumentReference | undefined)?.task;
  const task = normalizeDocumentTask(rawTask);
  const rawRevision = (tab.reference as BotDocumentReference | undefined)?.revision;
  const revision = normalizeDocumentRevision(rawRevision);
  if (rawRevision !== undefined && (!revision || comparison || tab.mode === 'diff' || (tab.reference as BotDocumentReference).kind === 'directory'
    || typeof (tab.reference as BotDocumentReference).workspaceId !== 'string' || typeof (tab.reference as BotDocumentReference).path !== 'string')) return null;
  if (rawTask !== undefined && (!task || typeof (tab.reference as BotDocumentReference).workspaceId !== 'string'
    || typeof (tab.reference as BotDocumentReference).path !== 'string')) return null;
  return {
    id: tab.id,
    absPath: tab.absPath,
    ...(typeof tab.workspaceRoot === 'string' && tab.workspaceRoot
      ? { workspaceRoot: tab.workspaceRoot }
      : {}),
    ...(typeof tab.relPath === 'string' && tab.relPath ? { relPath: tab.relPath } : {}),
    mode: draftId ? 'source' : isDocumentMode(tab.mode) ? tab.mode : 'preview',
    ...(draftId ? { draftId: draftId as string } : {}),
    ...(navigation ? { navigation } : {}),
    ...(comparison ? { comparison } : {}),
    ...(resourceReading ? { resourceReading } : {}),
    ...(delivery ? { delivery } : {}),
    ...(normalizeDocumentObservation(tab.observation) ? { observation: normalizeDocumentObservation(tab.observation) } : {}),
    ...(tab.readingPositions ? { readingPositions: normalizeDocumentReadPositions(tab.readingPositions) } : {}),
    ...(tab.reference && typeof tab.reference === 'object'
      && typeof (tab.reference as BotDocumentReference).workspaceId === 'string'
      && typeof (tab.reference as BotDocumentReference).path === 'string'
      ? { reference: { workspaceId: (tab.reference as BotDocumentReference).workspaceId,
          path: (tab.reference as BotDocumentReference).path,
          ...(task ? { task } : {}),
          ...(revision ? { revision } : {}),
          ...((tab.reference as BotDocumentReference).kind === 'directory' ? { kind: 'directory' as const } : {}),
          ...(typeof (tab.reference as BotDocumentReference).relativeTo === 'string'
            ? { relativeTo: (tab.reference as BotDocumentReference).relativeTo } : {}) } } : {}),
  };
}

export function normalizeDocumentSessionState(raw: unknown): DocumentSessionState {
  if (!raw || typeof raw !== 'object') return createDocumentSessionState();
  const value = raw as Record<string, unknown>;
  const ids = new Set<string>();
  const paths = new Set<string>();
  const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
    .map(normalizeDocumentTab)
    .filter((tab): tab is DocumentTabSession => {
      if (!tab) return false;
      const key = JSON.stringify([tab.absPath, tab.reference?.workspaceId, tab.reference?.relativeTo, tab.reference?.task, documentRevisionKey(tab.reference?.revision), deliveryBindingKey(tab.delivery), tab.comparison, tab.draftId]);
      if (ids.has(tab.id) || paths.has(key)) return false;
      ids.add(tab.id);
      paths.add(key);
      return true;
    });
  if (tabs.length === 0) return createDocumentSessionState();
  const requestedActive = typeof value.activeTabId === 'string' ? value.activeTabId : '';
  const activeTabId = tabs.some((tab) => tab.id === requestedActive)
    ? requestedActive
    : tabs[0].id;
  return { tabs, activeTabId };
}

export function normalizeDocumentSessionMap(raw: unknown): DocumentSessionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const sessions: DocumentSessionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    sessions[key] = normalizeDocumentSessionState(value);
  }
  return sessions;
}

export function openDocumentTab(
  session: DocumentSessionState,
  tab: DocumentTabSession,
  options: { readonly replaceMode?: boolean } = {},
): DocumentSessionState {
  const index = session.tabs.findIndex((candidate) => candidate.absPath === tab.absPath
    && candidate.draftId === tab.draftId
    && candidate.reference?.workspaceId === tab.reference?.workspaceId
    && candidate.reference?.relativeTo === tab.reference?.relativeTo
    && JSON.stringify(candidate.reference?.task) === JSON.stringify(tab.reference?.task)
    && documentRevisionKey(candidate.reference?.revision) === documentRevisionKey(tab.reference?.revision)
    && deliveryBindingKey(candidate.delivery) === deliveryBindingKey(tab.delivery)
    && JSON.stringify(candidate.comparison) === JSON.stringify(tab.comparison));
  if (index < 0) return { tabs: [...session.tabs, tab], activeTabId: tab.id };

  const current = session.tabs[index];
  const next = {
    ...current,
    ...(tab.reference ? { reference: tab.reference } : {}),
    ...(tab.navigation ? { navigation: tab.navigation } : {}),
    ...(tab.workspaceRoot ? { workspaceRoot: tab.workspaceRoot } : {}),
    ...(tab.relPath ? { relPath: tab.relPath } : {}),
    ...(options.replaceMode ? { mode: tab.mode } : {}),
  };
  const changed =
    next.workspaceRoot !== current.workspaceRoot ||
    next.relPath !== current.relPath ||
    JSON.stringify(next.reference) !== JSON.stringify(current.reference) ||
    next.navigation !== current.navigation ||
    next.mode !== current.mode;
  if (!changed && session.activeTabId === current.id) return session;
  const tabs = changed
    ? session.tabs.map((candidate, candidateIndex) => (candidateIndex === index ? next : candidate))
    : session.tabs;
  return { tabs, activeTabId: current.id };
}

export function activateDocumentTab(
  session: DocumentSessionState,
  tabId: string,
): DocumentSessionState {
  if (session.activeTabId === tabId || !session.tabs.some((tab) => tab.id === tabId)) {
    return session;
  }
  return { ...session, activeTabId: tabId };
}

export function updateDocumentTabMode(
  session: DocumentSessionState,
  tabId: string,
  mode: WorkbenchFileMode,
): DocumentSessionState {
  let changed = false;
  const tabs = session.tabs.map((tab) => {
    if (tab.id !== tabId || tab.draftId || tab.mode === mode || mode === 'diff' && tab.reference?.revision) return tab;
    changed = true;
    return { ...tab, mode };
  });
  return changed ? { ...session, tabs } : session;
}

export function closeDocumentTab(
  session: DocumentSessionState,
  tabId: string,
): DocumentSessionState {
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return createDocumentSessionState();
  if (session.activeTabId !== tabId) return { ...session, tabs };
  const nextActive = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, activeTabId: nextActive.id };
}

/** Reading receipts and coordinates are presentation metadata, never saved file contents or grants. */
export function updateDocumentReading(session: DocumentSessionState, tabId: string,
  patch: { readonly observation?: LocalDocumentObservation; readonly position?: { readonly key: string; readonly point: DocumentReadPosition } }): DocumentSessionState {
  let changed = false;
  const tabs = session.tabs.map(tab => {
    if (tab.id !== tabId) return tab;
    const observation = normalizeDocumentObservation(patch.observation) ?? tab.observation;
    const readingPositions = patch.position ? normalizeDocumentReadPositions({
      ...Object.fromEntries(Object.entries(tab.readingPositions ?? {}).filter(([key]) => key !== patch.position!.key)),
      [patch.position.key]: patch.position.point,
    }) : tab.readingPositions;
    if (JSON.stringify(observation) === JSON.stringify(tab.observation) && JSON.stringify(readingPositions) === JSON.stringify(tab.readingPositions)) return tab;
    changed = true;
    return { ...tab, ...(observation ? { observation } : {}), ...(readingPositions ? { readingPositions } : {}) };
  });
  return changed ? { ...session, tabs } : session;
}

export function updateComparisonReading(session: DocumentSessionState, tabId: string, raw: ResourceWindowNavigation): DocumentSessionState {
  const value = normalizeResourceWindowNavigation(raw, 'comparison'); if (!value) return session;
  let changed = false;
  const tabs = session.tabs.map(tab => {
    if (tab.id !== tabId || !tab.comparison || JSON.stringify(tab.resourceReading) === JSON.stringify(value)) return tab;
    changed = true; return { ...tab, resourceReading: value };
  });
  return changed ? { ...session, tabs } : session;
}
