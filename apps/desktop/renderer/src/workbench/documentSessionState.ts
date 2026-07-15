export type WorkbenchFileMode = 'preview' | 'source' | 'diff';

export interface DocumentTabSession {
  readonly id: string;
  readonly absPath: string;
  readonly workspaceRoot?: string;
  /** 原始相对路径（解析前），用于主进程跨已知 workspace 回退查找。 */
  readonly relPath?: string;
  readonly mode: WorkbenchFileMode;
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
  } = {},
): DocumentTabSession {
  return {
    id: options.id ?? createDocumentTabId(),
    absPath,
    ...(options.workspaceRoot ? { workspaceRoot: options.workspaceRoot } : {}),
    ...(options.relPath ? { relPath: options.relPath } : {}),
    mode: options.mode ?? 'preview',
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
  return {
    id: tab.id,
    absPath: tab.absPath,
    ...(typeof tab.workspaceRoot === 'string' && tab.workspaceRoot
      ? { workspaceRoot: tab.workspaceRoot }
      : {}),
    ...(typeof tab.relPath === 'string' && tab.relPath ? { relPath: tab.relPath } : {}),
    mode: isDocumentMode(tab.mode) ? tab.mode : 'preview',
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
      if (!tab || ids.has(tab.id) || paths.has(tab.absPath)) return false;
      ids.add(tab.id);
      paths.add(tab.absPath);
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
  const index = session.tabs.findIndex((candidate) => candidate.absPath === tab.absPath);
  if (index < 0) return { tabs: [...session.tabs, tab], activeTabId: tab.id };

  const current = session.tabs[index];
  const next = {
    ...current,
    ...(tab.workspaceRoot ? { workspaceRoot: tab.workspaceRoot } : {}),
    ...(tab.relPath ? { relPath: tab.relPath } : {}),
    ...(options.replaceMode ? { mode: tab.mode } : {}),
  };
  const changed =
    next.workspaceRoot !== current.workspaceRoot ||
    next.relPath !== current.relPath ||
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
