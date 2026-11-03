import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { InteractiveOwner, InteractiveResultReference, ResourcePresentationApi, ResourceWindowNavigation } from '@peer-agent/protocol';
import { readLegacyResourcePreferences } from '../resourcePreferenceStorage';
import type { WorkbenchTabId } from '../workbenchTabState';
import { interactiveSessionRegistry } from './interactiveSessionRegistry';
import { createResourcePresentationSession, type ResourcePresentationSession, type ResourcePresentationSnapshot } from './resourcePresentationSession';

const unavailable: ResourcePresentationApi = { readLayout: async () => ({ ok: false, code: 'resource_layout_bridge_unavailable' }), writeLayout: async () => ({ ok: false, code: 'resource_layout_bridge_unavailable' }) };
const caches = new WeakMap<ResourcePresentationApi, Map<string, { session: ResourcePresentationSession; users: number }>>();
export const interactivePresentationSessions = (api: ResourcePresentationApi | undefined = window.peerAgent?.resourcePresentation) => api ? [...(caches.get(api)?.values() ?? [])].map(entry => entry.session) : [];
export const hasUnsafeInteractiveLayouts = () => interactivePresentationSessions().some(session => {
  const state = session.snapshot(); return state.protected && (state.dirty || state.phase === 'saving');
});
export const flushInteractiveLayouts = async () => (await Promise.all(interactivePresentationSessions().map(session => session.flush()))).every(Boolean);
const noState: ResourcePresentationSnapshot = { layout: { order: [], recent: [], interactive: { tabs: [], activeTabId: null } }, confirmed: null, remote: null, loaded: false, protected: false, dirty: false, phase: 'ready', error: null };
const noSubscribe = () => () => {}, noSnapshot = () => noState;
function entryFor(owner: InteractiveOwner, api: ResourcePresentationApi) {
  let cache = caches.get(api); if (!cache) { cache = new Map(); caches.set(api, cache); }
  const key = JSON.stringify([owner.workspaceId, owner.conversationId]);
  const existing = cache.get(key); if (existing) return existing;
  if (cache.size >= 64) {
    for (const [key, entry] of cache) {
      const snapshot = entry.session.snapshot();
      if (entry.users === 0 && !snapshot.dirty && snapshot.phase !== 'saving' && (snapshot.loaded || !snapshot.protected)) {
        entry.session.dispose(); cache.delete(key); break;
      }
    }
    if (cache.size >= 64) return null;
  }
  const legacy = readLegacyResourcePreferences(owner.conversationId);
  const entry = { session: createResourcePresentationSession({ owner, api, legacy: legacy.value, legacyValid: legacy.valid }), users: 0 };
  cache.set(key, entry); return entry;
}
export function useInteractiveResources(ports: {
  readonly owner: { readonly workspaceId: string; readonly conversationId: string | null } | null; readonly ready: boolean;
  readonly setTab: (tab: WorkbenchTabId) => void; readonly reveal: () => void;
}) {
  const latest = useRef(ports); latest.current = ports;
  const api = window.peerAgent?.resourcePresentation ?? unavailable;
  const key = JSON.stringify([ports.owner?.workspaceId, ports.owner?.conversationId]);
  const currentOwnerKey = useRef(key); currentOwnerKey.current = key;
  const entry = useMemo(() => ports.ready && ports.owner?.conversationId ? entryFor({ workspaceId: ports.owner.workspaceId, conversationId: ports.owner.conversationId }, api) : null, [key, api, ports.ready]);
  const session = entry?.session ?? null;
  const state = useSyncExternalStore(session?.subscribe ?? noSubscribe, session?.snapshot ?? noSnapshot, noSnapshot);
  const [notice, setNotice] = useState<{ key: string; code: string } | null>(null);
  const [adopting, setAdopting] = useState(false);
  const [readingGeneration, setReadingGeneration] = useState(0);
  const currentReadingGeneration = useRef(0);
  useEffect(() => {
    if (!entry) return; entry.users++; void entry.session.load();
    return () => { entry.users--; void entry.session.flush(); };
  }, [entry]);
  useEffect(() => {
    if (!session || !state.loaded || !state.protected || !state.dirty || state.phase !== 'ready') return;
    const timer = setTimeout(() => { void session.flush(); }, 400);
    return () => clearTimeout(timer);
  }, [session, state.layout, state.loaded, state.protected]);
  const openInteractive = useCallback((reference: InteractiveResultReference, title?: string) => {
    if (currentOwnerKey.current !== key) return false;
    if (!latest.current.ready || !session?.open(reference, title)) { setNotice({ key, code: session?.snapshot().error ?? 'resource_layout_limit' }); return false; }
    void interactiveSessionRegistry(window.peerAgent?.interactiveResults)?.open(reference).catch(() => {});
    setNotice(null); latest.current.setTab('interactive'); latest.current.reveal(); return true;
  }, [session, key]);
  const activateInteractive = useCallback((id: string) => {
    if (currentOwnerKey.current !== key) return false;
    const tab = session?.snapshot().layout.interactive.tabs.find(tab => tab.id === id);
    if (!tab || !session!.snapshot().layout.order.includes(`interactive:${id}`) || !latest.current.ready || !session!.activate(tab.reference)) return false;
    latest.current.setTab('interactive'); return true;
  }, [session, key]);
  const closeInteractive = useCallback(async (id: string) => {
    const tab = session?.snapshot().layout.interactive.tabs.find(tab => tab.id === id); if (!tab) return true;
    const registry = interactiveSessionRegistry(window.peerAgent?.interactiveResults);
    if (registry && !await registry.close(tab.reference)) { setNotice({ key, code: 'interactive_save_unconfirmed' }); return false; }
    if (!session!.close(tab.reference)) { void registry?.open(tab.reference); setNotice({ key, code: session!.snapshot().error ?? 'resource_layout_limit' }); return false; }
    setNotice(null); return true;
  }, [session, key]);
  const rememberInteractive = useCallback((reference: InteractiveResultReference, point: Pick<ResourceWindowNavigation, 'top' | 'left'>, generation: number) => {
    if (generation === currentReadingGeneration.current) session?.remember(reference, point);
  }, [session]);
  const rememberInteractiveTitle = useCallback((reference: InteractiveResultReference, title: string) => { session?.title(reference, title); }, [session]);
  const useSavedLayout = useCallback(async () => {
    if (adopting || currentOwnerKey.current !== key) return false;
    setAdopting(true);
    const registry = interactiveSessionRegistry(window.peerAgent?.interactiveResults);
    try {
      if (registry && (!await registry.flushAll() || registry.hasUnsafe())) { setNotice({ key, code: 'interactive_save_unconfirmed' }); return false; }
      const before = session?.snapshot().layout.interactive.tabs ?? [];
      const ok = await session?.useRemote() ?? false;
      if (ok) {
        setNotice(null);
        if (currentOwnerKey.current === key) setReadingGeneration(++currentReadingGeneration.current);
        const retained = session!.snapshot().layout.order;
        for (const tab of before) if (!retained.includes(`interactive:${tab.id}`)) await registry?.close(tab.reference);
      }
      return ok;
    } finally { setAdopting(false); }
  }, [session, key, adopting]);
  return { interactiveTabs: state.layout.interactive.tabs.filter(tab => state.layout.order.includes(`interactive:${tab.id}`)), activeInteractiveId: state.layout.interactive.activeTabId,
    interactiveLayout: session, interactiveLayoutState: state, interactiveNotice: notice?.key === key ? notice.code : state.error,
    interactiveLayoutTransitioning: adopting,
    interactiveReadingGeneration: readingGeneration,
    openInteractive, activateInteractive, closeInteractive, rememberInteractive, rememberInteractiveTitle, useSavedLayout };
}
