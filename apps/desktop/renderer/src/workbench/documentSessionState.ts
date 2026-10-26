import type { BotDocumentReference } from '@peer-agent/protocol';
export type WorkbenchFileMode = 'preview' | 'source' | 'diff';

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
  return {
    id: tab.id,
    absPath: tab.absPath,
    ...(typeof tab.workspaceRoot === 'string' && tab.workspaceRoot
      ? { workspaceRoot: tab.workspaceRoot }
      : {}),
    ...(typeof tab.relPath === 'string' && tab.relPath ? { relPath: tab.relPath } : {}),
    mode: isDocumentMode(tab.mode) ? tab.mode : 'preview',
    ...(navigation ? { navigation } : {}),
    ...(comparison ? { comparison } : {}),
    ...(tab.reference && typeof tab.reference === 'object'
      && typeof (tab.reference as BotDocumentReference).workspaceId === 'string'
      && typeof (tab.reference as BotDocumentReference).path === 'string'
      ? { reference: { workspaceId: (tab.reference as BotDocumentReference).workspaceId,
          path: (tab.reference as BotDocumentReference).path,
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
      const key = JSON.stringify([tab.absPath, tab.reference?.workspaceId, tab.reference?.relativeTo, tab.comparison]);
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
    && candidate.reference?.workspaceId === tab.reference?.workspaceId
    && candidate.reference?.relativeTo === tab.reference?.relativeTo
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
    if (tab.id !== tabId || tab.mode === mode) return tab;
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
