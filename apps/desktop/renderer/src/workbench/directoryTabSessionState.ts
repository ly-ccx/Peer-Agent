import type { BotDocumentReference } from '@peer-agent/protocol';

/**
 * ADR 125：资源窗口内目录是一等资源标签。标签身份 = 目录引用（kind:'directory'）。
 * 只持久化引用元数据；展开态、筛选与滚动位置经 DirectorySession.readings 恢复。
 */
/** Directory resource reference carried by a tab; exactly the fields the navigator re-resolves. */
export type BotDirectoryReference = BotDocumentReference & { readonly kind: 'directory' };
export interface DirectoryTabSession {
  readonly id: string;
  readonly reference: BotDirectoryReference;
}
export interface DirectoryTabState {
  readonly tabs: readonly DirectoryTabSession[];
  readonly activeTabId: string | null;
}
export type DirectoryTabSessionMap = Record<string, DirectoryTabState>;

const MAX_TABS = 32;

export function createDirectoryTabId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `directory-tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function createDirectoryTabState(): DirectoryTabState {
  return { tabs: [], activeTabId: null };
}

function normalizeTask(raw: unknown): BotDocumentReference['task'] | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return undefined;
  const task = raw as Record<string, unknown>;
  const valid = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= 256 && !/[\u0000-\u001f]/.test(value);
  return valid(task.sessionId) && valid(task.planId) ? { sessionId: task.sessionId, planId: task.planId } : undefined;
}

/** Live reducer updates and persisted restoration share one normalizer; malformed input drops the tab. */
export function normalizeDirectoryTab(raw: unknown): DirectoryTabSession | null {
  if (!raw || typeof raw !== 'object') return null;
  const tab = raw as Record<string, unknown>;
  if (typeof tab.id !== 'string' || !tab.id.trim() || tab.id.length > 128) return null;
  const ref = tab.reference;
  if (!ref || typeof ref !== 'object') return null;
  const reference = ref as Record<string, unknown>;
  if (reference.kind !== 'directory' || typeof reference.workspaceId !== 'string' || !reference.workspaceId.trim()
    || typeof reference.path !== 'string' || !reference.path.trim() || reference.path.length > 4096
    || 'revision' in reference || 'expectedObservation' in reference || 'metadataOnly' in reference) return null;
  const task = normalizeTask(reference.task);
  if (reference.task !== undefined && !task) return null;
  const relativeTo = typeof reference.relativeTo === 'string' && reference.relativeTo ? reference.relativeTo : undefined;
  if (reference.relativeTo !== undefined && !relativeTo) return null;
  return {
    id: tab.id,
    reference: { kind: 'directory', workspaceId: reference.workspaceId, path: reference.path,
      ...(task ? { task } : {}), ...(relativeTo ? { relativeTo } : {}) },
  };
}

/** Identity follows the same fields the navigator dedupes on; navigation inside a tab rewrites the reference. */
export function directoryTabKey(tab: Pick<DirectoryTabSession, 'reference'>): string {
  return JSON.stringify([tab.reference.workspaceId, tab.reference.path, tab.reference.task?.sessionId,
    tab.reference.task?.planId, tab.reference.relativeTo]);
}

export function normalizeDirectoryTabState(raw: unknown): DirectoryTabState {
  if (!raw || typeof raw !== 'object') return createDirectoryTabState();
  const value = raw as Record<string, unknown>;
  const ids = new Set<string>();
  const keys = new Set<string>();
  const tabs: DirectoryTabSession[] = [];
  for (const item of (Array.isArray(value.tabs) ? value.tabs : []).slice(0, MAX_TABS)) {
    const tab = normalizeDirectoryTab(item);
    if (!tab || ids.has(tab.id)) continue;
    const key = directoryTabKey(tab);
    if (keys.has(key)) continue;
    ids.add(tab.id); keys.add(key); tabs.push(tab);
  }
  if (tabs.length === 0) return createDirectoryTabState();
  const requested = typeof value.activeTabId === 'string' ? value.activeTabId : '';
  return { tabs, activeTabId: tabs.some(tab => tab.id === requested) ? requested : tabs[0]!.id };
}

export function normalizeDirectoryTabSessionMap(raw: unknown): DirectoryTabSessionMap {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const sessions: DirectoryTabSessionMap = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key || key.length > 512 || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    sessions[key] = normalizeDirectoryTabState(value);
  }
  return sessions;
}

export function openDirectoryTabState(session: DirectoryTabState, tab: DirectoryTabSession): DirectoryTabState {
  const key = directoryTabKey(tab);
  const index = session.tabs.findIndex(candidate => directoryTabKey(candidate) === key);
  if (index < 0) {
    const tabs = [...session.tabs, tab].slice(-MAX_TABS);
    return { tabs, activeTabId: tab.id };
  }
  const current = session.tabs[index]!;
  const tabs = current.reference === tab.reference || JSON.stringify(current.reference) === JSON.stringify(tab.reference)
    ? session.tabs
    : session.tabs.map((candidate, candidateIndex) => (candidateIndex === index ? { ...candidate, reference: tab.reference } : candidate));
  return { tabs, activeTabId: current.id };
}

export function activateDirectoryTabState(session: DirectoryTabState, tabId: string): DirectoryTabState {
  if (session.activeTabId === tabId || !session.tabs.some(tab => tab.id === tabId)) return session;
  return { ...session, activeTabId: tabId };
}

export function closeDirectoryTabState(session: DirectoryTabState, tabId: string): DirectoryTabState {
  const index = session.tabs.findIndex(tab => tab.id === tabId);
  if (index < 0) return session;
  const tabs = session.tabs.filter(tab => tab.id !== tabId);
  if (tabs.length === 0) return createDirectoryTabState();
  if (session.activeTabId !== tabId) return { ...session, tabs };
  return { tabs, activeTabId: tabs[Math.min(index, tabs.length - 1)]!.id };
}

/** Tab-internal navigation (breadcrumbs, source switch) rewrites only the active tab's reference. */
export function updateDirectoryTabReference(session: DirectoryTabState, tabId: string, reference: BotDirectoryReference): DirectoryTabState {
  let changed = false;
  const tabs = session.tabs.map(tab => {
    if (tab.id !== tabId) return tab;
    const next = { ...tab, reference };
    if (JSON.stringify(next.reference) === JSON.stringify(tab.reference)) return tab;
    changed = true;
    return next;
  });
  return changed ? { ...session, tabs } : session;
}
