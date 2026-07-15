export const BROWSER_HOME_URL = 'about:blank';
export const FALLBACK_WORKBENCH_SESSION_KEY = '__none';
/** @deprecated 使用 FALLBACK_WORKBENCH_SESSION_KEY。 */
export const FALLBACK_BROWSER_SESSION_KEY = FALLBACK_WORKBENCH_SESSION_KEY;

export interface BrowserTabSession {
  readonly id: string;
  readonly url: string;
  readonly title: string;
}

export interface BrowserSessionState {
  readonly tabs: readonly BrowserTabSession[];
  readonly activeTabId: string;
}

export type BrowserSessionMap = Record<string, BrowserSessionState>;

let fallbackId = 0;

export function workbenchSessionKey(conversationId: string | null): string {
  return conversationId ?? FALLBACK_WORKBENCH_SESSION_KEY;
}

/** @deprecated 新代码使用 workbenchSessionKey；保留别名兼容现有调用。 */
export const browserSessionKey = workbenchSessionKey;

export function createBrowserTabId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  fallbackId += 1;
  return `browser-tab-${Date.now().toString(36)}-${fallbackId.toString(36)}`;
}

export function createBrowserTabSession(
  id = createBrowserTabId(),
  url = BROWSER_HOME_URL,
  title = '',
): BrowserTabSession {
  return { id, url: url || BROWSER_HOME_URL, title };
}

export function createBrowserSessionState(tab = createBrowserTabSession()): BrowserSessionState {
  return { tabs: [tab], activeTabId: tab.id };
}

function normalizeBrowserTab(raw: unknown): BrowserTabSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const tab = raw as Record<string, unknown>;
  if (typeof tab.id !== 'string' || !tab.id.trim()) return null;
  return {
    id: tab.id,
    url: typeof tab.url === 'string' && tab.url ? tab.url : BROWSER_HOME_URL,
    title: typeof tab.title === 'string' ? tab.title : '',
  };
}

export function normalizeBrowserSessionState(raw: unknown): BrowserSessionState {
  if (!raw || typeof raw !== 'object') return createBrowserSessionState();
  const value = raw as Record<string, unknown>;
  const seen = new Set<string>();
  const tabs = (Array.isArray(value.tabs) ? value.tabs : [])
    .map(normalizeBrowserTab)
    .filter((tab): tab is BrowserTabSession => {
      if (!tab || seen.has(tab.id)) return false;
      seen.add(tab.id);
      return true;
    });
  if (tabs.length === 0) return createBrowserSessionState();
  const requestedActive = typeof value.activeTabId === 'string' ? value.activeTabId : '';
  const activeTabId = tabs.some((tab) => tab.id === requestedActive) ? requestedActive : tabs[0].id;
  return { tabs, activeTabId };
}

export function normalizeBrowserSessionMap(raw: unknown): BrowserSessionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const sessions: BrowserSessionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    sessions[key] = normalizeBrowserSessionState(value);
  }
  return sessions;
}

export function addBrowserTab(
  session: BrowserSessionState,
  tab = createBrowserTabSession(),
): BrowserSessionState {
  if (session.tabs.some((candidate) => candidate.id === tab.id)) return session;
  return { tabs: [...session.tabs, tab], activeTabId: tab.id };
}

export function activateBrowserTab(
  session: BrowserSessionState,
  tabId: string,
): BrowserSessionState {
  if (session.activeTabId === tabId || !session.tabs.some((tab) => tab.id === tabId)) {
    return session;
  }
  return { ...session, activeTabId: tabId };
}

export function updateBrowserTab(
  session: BrowserSessionState,
  tabId: string,
  patch: Partial<Pick<BrowserTabSession, 'url' | 'title'>>,
): BrowserSessionState {
  let changed = false;
  const tabs = session.tabs.map((tab) => {
    if (tab.id !== tabId) return tab;
    const next = {
      ...tab,
      ...(typeof patch.url === 'string' && patch.url ? { url: patch.url } : {}),
      ...(typeof patch.title === 'string' ? { title: patch.title } : {}),
    };
    if (next.url === tab.url && next.title === tab.title) return tab;
    changed = true;
    return next;
  });
  return changed ? { ...session, tabs } : session;
}

export function closeBrowserTab(
  session: BrowserSessionState,
  tabId: string,
  replacement = createBrowserTabSession(),
): BrowserSessionState {
  const index = session.tabs.findIndex((tab) => tab.id === tabId);
  if (index < 0) return session;
  const tabs = session.tabs.filter((tab) => tab.id !== tabId);
  if (tabs.length === 0) return createBrowserSessionState(replacement);
  if (session.activeTabId !== tabId) return { ...session, tabs };
  const nextActive = tabs[Math.min(index, tabs.length - 1)];
  return { tabs, activeTabId: nextActive.id };
}
